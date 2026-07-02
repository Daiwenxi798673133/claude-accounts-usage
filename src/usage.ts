import type { AnthropicOauth, AuthToken, StoredAccount } from "./accounts.ts"
import { loadAccounts, readAuthAnthropic, saveAccounts, upsertAccount, withAuthLock, writeAuthAnthropic } from "./accounts.ts"
import { ACTIVE_WAIT_POLL_MS, ACTIVE_WAIT_TIMEOUT_MS, CLIENT_ID, INACTIVE_REFRESH_THRESHOLD_MS, OAUTH_BETA, TOKEN_EXPIRY_BUFFER_MS, TOKEN_URL, USAGE_ENDPOINT } from "./constants.ts"
import { log, redactBody, redactHeaders } from "./logger.ts"
import { fetchProfile } from "./profile.ts"

const REFRESH_DELAY_MS = 500
const REFRESH_429_COOLDOWN_MS = 5 * 60_000

const inflightRefresh = new Map<string, Promise<{ access: string; refresh: string; expires: number }>>()
const refresh429Cooldown = new Map<string, number>()

export type UsageWindow = { utilization: number; resets_at?: string }

// Windows the account doesn't have come back as `null`, not omitted. There's no
// dedicated Sonnet weekly limit (Anthropic tracks overall `seven_day` + Opus-only
// `seven_day_opus`), so `seven_day_sonnet` is null for most accounts.
export type UsageResponse = {
  five_hour?: UsageWindow | null
  seven_day?: UsageWindow | null
  seven_day_sonnet?: UsageWindow | null
  seven_day_opus?: UsageWindow | null
}

export type AccountUsage = {
  id: string
  label: string
  active: boolean
  usage?: UsageResponse
  error?: string
  pending?: "waiting-refresh" | "refreshing"
  usageAsOf?: number
}

export type ActiveTokenOutcome = {
  access?: string
  state: "fresh" | "waited" | "self-refreshed" | "waiting-timeout" | "unavailable"
  authToken?: AuthToken
}

export type CollectOptions = {
  // REQUIRED (INV-1): omitting the predicate MUST be a compile error, never a
  // silent "assume idle" that would let the plugin self-refresh the active chain.
  // Unknown-state callers pass `() => true` (assume running → never self-refresh).
  isSessionRunning: () => boolean
  onPartial?: (results: AccountUsage[]) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isStale(token: { access?: string; expires?: number }, bufferMs = TOKEN_EXPIRY_BUFFER_MS): boolean {
  return !token.access || !token.expires || token.expires < Date.now() + bufferMs
}

function isRefresh429Cooldown(refresh: string): boolean {
  const until = refresh429Cooldown.get(refresh)
  if (!until) return false
  if (Date.now() >= until) {
    refresh429Cooldown.delete(refresh)
    return false
  }
  return true
}

function doRefreshToken(refresh: string): Promise<{ access: string; refresh: string; expires: number }> {
  // PRIVACY: never log the request body — it contains the refresh_token / grant_type.
  log.debug("usage:refresh-start")
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "User-Agent": "axios/1.13.6",
    },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      const headers: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        headers[key] = value
      })
      log.warn("usage:refresh-failed", { status: res.status, headerKeys: redactHeaders(headers), body: redactBody(body) })
      if (res.status === 429) {
        refresh429Cooldown.set(refresh, Date.now() + REFRESH_429_COOLDOWN_MS)
      }
      throw new Error(`token refresh failed (${res.status})`)
    }
    const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number }
    log.debug("usage:refresh-result", { status: res.status })
    return {
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
    }
  })
}

export function refreshToken(refresh: string): Promise<{ access: string; refresh: string; expires: number }> {
  const existing = inflightRefresh.get(refresh)
  if (existing) return existing
  const promise = doRefreshToken(refresh).finally(() => {
    inflightRefresh.delete(refresh)
  })
  inflightRefresh.set(refresh, promise)
  return promise
}

export async function fetchUsage(access: string): Promise<UsageResponse> {
  log.debug("usage:fetch-start")
  const res = await fetch(USAGE_ENDPOINT, {
    headers: { Authorization: `Bearer ${access}`, "anthropic-beta": OAUTH_BETA },
  })
  if (!res.ok) {
    log.warn("usage:fetch-fail", { status: res.status })
    throw new Error(`usage request failed (${res.status})`)
  }
  return (await res.json()) as UsageResponse
}

// Identify whatever account ex-machina currently holds in auth.json by its profile
// uuid (stable across token rotation) and upsert it: the same account is updated in
// place, a genuinely new login is added — so no manual /account-add is needed.
export async function autoCapture(): Promise<void> {
  await withAuthLock(async () => {
    const auth = await readAuthAnthropic()
    if (!auth?.refresh) return

    // auth.json is the SINGLE source of truth for the active chain (INV-2): NEVER
    // refresh it here — a refresh would consume ex-machina's refresh token and cause
    // the permanent invalid_grant lockout. Capture only when the stored token is still
    // valid, and store it AS-IS (no rotation, no writeAuthAnthropic).
    // Known limitation: a brand-new account whose stored token is already expired is
    // captured only after its NEXT successful use (which refreshens auth.json); this
    // round is skipped rather than risk racing/breaking ex-machina's refresh.
    if (!isActiveFresh(auth)) return

    const profile = await fetchProfile(auth.access)
    await upsertAccount(profile.uuid, profile.email, { refresh: auth.refresh, access: auth.access, expires: auth.expires })
  })
}

async function ensureFresh(account: StoredAccount, bufferMs?: number): Promise<{ access?: string; updated?: StoredAccount }> {
  if (!isStale(account, bufferMs)) return { access: account.access }
  if (isRefresh429Cooldown(account.refresh)) {
    log.warn("usage:refresh-skip-429", { label: account.label })
    return { access: account.access }
  }
  log.debug("usage:ensure-fresh", { label: account.label })
  const fresh = await refreshToken(account.refresh)
  return { access: fresh.access, updated: { ...account, ...fresh } }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// INV-5: the active account is FRESH only when auth.json's own access token is not
// yet expired — a HARD check with NO TOKEN_EXPIRY_BUFFER_MS, matching ex-machina, so
// we never wait for / trigger a refresh ex-machina itself would not produce.
function isActiveFresh(auth: AnthropicOauth | undefined): auth is AnthropicOauth & { access: string; expires: number } {
  return Boolean(auth?.access && auth.expires && auth.expires >= Date.now())
}

function toAuthToken(auth: AnthropicOauth | undefined): AuthToken | undefined {
  if (!auth?.refresh) return undefined
  return { refresh: auth.refresh, access: auth.access, expires: auth.expires }
}

async function waitForExMachinaRefresh(initial: AnthropicOauth | undefined): Promise<ActiveTokenOutcome> {
  let last = initial
  const deadline = Date.now() + ACTIVE_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(ACTIVE_WAIT_POLL_MS)
    last = await readAuthAnthropic()
    if (isActiveFresh(last)) {
      return { access: last.access, state: "waited", authToken: { refresh: last.refresh!, access: last.access, expires: last.expires } }
    }
  }
  return { state: "waiting-timeout", authToken: toAuthToken(last) }
}

async function selfRefresh(initial: AnthropicOauth | undefined, isSessionRunning: () => boolean): Promise<ActiveTokenOutcome> {
  let auth = initial
  try {
    auth = await readAuthAnthropic()
    if (isActiveFresh(auth)) {
      return { access: auth.access, state: "self-refreshed", authToken: { refresh: auth.refresh!, access: auth.access, expires: auth.expires } }
    }
    if (!auth?.refresh) return { state: "unavailable", authToken: toAuthToken(auth) }
    if (isRefresh429Cooldown(auth.refresh)) return { state: "unavailable", authToken: toAuthToken(auth) }
    if (isSessionRunning()) return { state: "waiting-timeout", authToken: toAuthToken(auth) }
    const fresh = await refreshToken(auth.refresh)
    await writeAuthAnthropic(fresh)
    return { access: fresh.access, state: "self-refreshed", authToken: fresh }
  } catch (error) {
    // H2: the plugin never surfaces its own refresh error — re-read auth.json and
    // use whatever token is there (ex-machina may have written a fresh one).
    log.warn("usage:active-self-refresh-fail", { error: errorMessage(error) })
    const auth2 = await readAuthAnthropic()
    if (isActiveFresh(auth2)) {
      return { access: auth2.access, state: "self-refreshed", authToken: { refresh: auth2.refresh!, access: auth2.access, expires: auth2.expires } }
    }
    return { state: "unavailable", authToken: toAuthToken(auth2) ?? toAuthToken(auth) }
  }
}

// Resolve a usable access token for the ACTIVE account from auth.json ONLY (INV-2),
// via the three-branch policy: FRESH → use it; EXPIRED+running → wait for ex-machina
// (ZERO refresh POSTs); EXPIRED+idle → self-refresh once under a single lock and write
// back. `isSessionRunning` is a REQUIRED param (INV-1): unknown-state callers pass
// `() => true` so we default to waiting rather than racing ex-machina.
export async function acquireActiveAccess(active: StoredAccount, isSessionRunning: () => boolean): Promise<ActiveTokenOutcome> {
  const auth = await readAuthAnthropic()
  if (isActiveFresh(auth)) {
    return { access: auth.access, state: "fresh", authToken: { refresh: auth.refresh!, access: auth.access, expires: auth.expires } }
  }
  if (isSessionRunning()) return waitForExMachinaRefresh(auth)
  return withAuthLock(() => selfRefresh(auth, isSessionRunning))
}

// Last-good active usage, kept module-level so a deferred/unavailable active row can
// still render recent data (INV-8). Updated on EVERY successful active fetchUsage.
let lastActiveUsage: { usage: UsageResponse; at: number } | undefined

// A cached window whose reset moment has already passed is no longer "current" — drop
// it (null) rather than render a stale bar as if it were live (INV-8, G11).
function pruneUsage(usage: UsageResponse): UsageResponse {
  const now = Date.now()
  const keep = (window: UsageWindow | null | undefined): UsageWindow | null =>
    window && window.resets_at && Date.parse(window.resets_at) < now ? null : (window ?? null)
  return {
    five_hour: keep(usage.five_hour),
    seven_day: keep(usage.seven_day),
    seven_day_sonnet: keep(usage.seven_day_sonnet),
    seven_day_opus: keep(usage.seven_day_opus),
  }
}

function cachedActiveRow(base: { id: string; label: string; active: boolean }, fallbackError: string): AccountUsage {
  if (lastActiveUsage) return { ...base, usage: pruneUsage(lastActiveUsage.usage), usageAsOf: lastActiveUsage.at }
  return { ...base, error: fallbackError }
}

export async function collectAllUsage(opts: CollectOptions): Promise<{ activeId?: string; results: AccountUsage[] }> {
  const { isSessionRunning, onPartial } = opts
  const file = await loadAccounts()
  const auth = await readAuthAnthropic()

  const activeRecord = file.activeId ? file.accounts.find((account) => account.id === file.activeId) : undefined
  const hasActive = Boolean(activeRecord) || Boolean(auth)
  const activeBase = {
    id: activeRecord?.id ?? file.activeId ?? "active",
    label: activeRecord?.label ?? "当前账号",
    active: true,
  }

  // INACTIVE accounts (everything that is NOT the auth-held/active one): existing
  // behavior verbatim — proactive 30-min refresh, writes accounts.json only (INV-3).
  const inactiveAccounts = file.accounts.filter((account) => account !== activeRecord)
  const inactiveResults = new Map<string, AccountUsage>()
  const updated: StoredAccount[] = []
  let needsRefresh = false
  for (let index = 0; index < inactiveAccounts.length; index++) {
    const account = inactiveAccounts[index]
    const base = { id: account.id, label: account.label, active: false }
    try {
      const { access, updated: fresh } = await ensureFresh(account, INACTIVE_REFRESH_THRESHOLD_MS)
      if (fresh) {
        needsRefresh = true
        updated.push(fresh)
      }
      if (!access) {
        inactiveResults.set(account.id, { ...base, error: "missing access token" })
      } else {
        const usage = await fetchUsage(access)
        inactiveResults.set(account.id, { ...base, usage })
      }
    } catch (error) {
      log.warn("usage:collect-account-fail", { label: account.label, error: errorMessage(error) })
      inactiveResults.set(account.id, { ...base, error: errorMessage(error) })
    }
    if (needsRefresh && index < inactiveAccounts.length - 1) {
      await sleep(REFRESH_DELAY_MS)
    }
  }

  // ACTIVE account: auth.json is the SINGLE source of truth (INV-2/4/5). FRESH → fetch
  // now (real-time); EXPIRED → defer to the resolve phase; no anthropic token → cached
  // or "未登录". The auth-held chain NEVER enters ensureFresh.
  let activeAuth: AuthToken | undefined = toAuthToken(auth)
  let activeFast: AccountUsage | undefined
  let activeDeferred = false
  if (hasActive) {
    if (!auth) {
      activeFast = cachedActiveRow(activeBase, "未登录")
    } else if (isActiveFresh(auth)) {
      try {
        const usage = await fetchUsage(auth.access)
        lastActiveUsage = { usage, at: Date.now() }
        activeFast = { ...activeBase, usage }
      } catch (error) {
        log.warn("usage:collect-active-fail", { error: errorMessage(error) })
        activeFast = { ...activeBase, error: errorMessage(error) }
      }
    } else {
      activeFast = { ...activeBase, pending: isSessionRunning() ? "waiting-refresh" : "refreshing" }
      activeDeferred = true
    }
  }

  const fastResults: AccountUsage[] = []
  if (activeRecord) {
    for (const account of file.accounts) {
      fastResults.push(account === activeRecord ? activeFast! : inactiveResults.get(account.id)!)
    }
  } else {
    if (activeFast) fastResults.push(activeFast)
    for (const account of file.accounts) fastResults.push(inactiveResults.get(account.id)!)
  }
  onPartial?.(fastResults)

  let activeResolved = activeFast
  if (activeDeferred) {
    const activeStored: StoredAccount = activeRecord ?? { id: activeBase.id, label: activeBase.label, refresh: auth?.refresh ?? "" }
    const outcome = await acquireActiveAccess(activeStored, isSessionRunning)
    if (outcome.access) {
      try {
        const usage = await fetchUsage(outcome.access)
        lastActiveUsage = { usage, at: Date.now() }
        activeResolved = { ...activeBase, usage }
      } catch (error) {
        log.warn("usage:collect-active-fail", { error: errorMessage(error) })
        activeResolved = cachedActiveRow(activeBase, errorMessage(error))
      }
    } else {
      activeResolved = cachedActiveRow(activeBase, "额度暂不可用(等待 token 刷新)")
    }
    activeAuth = outcome.authToken ?? activeAuth
  }

  const results = fastResults.map((row) => (row === activeFast ? activeResolved! : row))

  // REVERSE-SYNC (auth.json → accounts.json only) + persist inactive updates, under a
  // SEPARATE lock from acquireActiveAccess's (INV-6, never nested). The active record's
  // token is overwritten from activeAuth — a value that always originated in auth.json.
  const doActiveSync = Boolean(activeRecord && activeAuth?.refresh)
  if (updated.length > 0 || doActiveSync) {
    await withAuthLock(async () => {
      const current = await loadAccounts()
      for (const account of updated) {
        const index = current.accounts.findIndex((existing) => existing.id === account.id)
        if (index >= 0) current.accounts[index] = { ...current.accounts[index], ...account }
      }
      if (doActiveSync && activeRecord && activeAuth) {
        const index = current.accounts.findIndex((existing) => existing.id === activeRecord.id)
        if (index >= 0) {
          current.accounts[index] = {
            ...current.accounts[index],
            refresh: activeAuth.refresh,
            access: activeAuth.access,
            expires: activeAuth.expires,
          }
        }
      }
      await saveAccounts(current)
    })
  }

  return { activeId: file.activeId, results }
}

export async function switchToAccount(id: string): Promise<StoredAccount> {
  return withAuthLock(async () => {
    const file = await loadAccounts()
    const index = file.accounts.findIndex((account) => account.id === id)
    if (index < 0) throw new Error("account not found")

    let account = file.accounts[index]
    if (isStale(account)) {
      if (isRefresh429Cooldown(account.refresh)) {
        log.warn("usage:switch-skip-429", { label: account.label })
      } else {
        const fresh = await refreshToken(account.refresh)
        account = { ...account, ...fresh }
        file.accounts[index] = account
      }
    }

    file.activeId = id
    await saveAccounts(file)
    await writeAuthAnthropic({ refresh: account.refresh, access: account.access, expires: account.expires })
    log.info("usage:switch-commit", { id, label: account.label })
    return account
  })
}
