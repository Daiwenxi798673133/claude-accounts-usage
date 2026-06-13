import type { AuthToken, StoredAccount } from "./accounts.ts"
import { loadAccounts, readAuthAnthropic, saveAccounts, upsertAccount, withAuthLock, writeAuthAnthropic } from "./accounts.ts"
import { CLIENT_ID, OAUTH_BETA, TOKEN_EXPIRY_BUFFER_MS, TOKEN_URL, USAGE_ENDPOINT } from "./constants.ts"
import { debugLog } from "./debug.ts"
import { fetchProfile } from "./profile.ts"

const REFRESH_DELAY_MS = 500
const KEEPER_INTERVAL_MS = 10 * 60_000
const KEEPER_REFRESH_THRESHOLD_MS = 30 * 60_000
const REFRESH_429_COOLDOWN_MS = 5 * 60_000

const inflightRefresh = new Map<string, Promise<{ access: string; refresh: string; expires: number }>>()
const refresh429Cooldown = new Map<string, number>()
let keepAliveTimer: ReturnType<typeof setInterval> | undefined

export type UsageWindow = { utilization: number; resets_at?: string }

export type UsageResponse = {
  five_hour?: UsageWindow
  seven_day?: UsageWindow
  seven_day_sonnet?: UsageWindow
  seven_day_opus?: UsageWindow
}

export type AccountUsage = {
  id: string
  label: string
  active: boolean
  usage?: UsageResponse
  error?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isStale(token: { access?: string; expires?: number }): boolean {
  return !token.access || !token.expires || token.expires < Date.now() + TOKEN_EXPIRY_BUFFER_MS
}

function isNearExpiry(token: { access?: string; expires?: number }): boolean {
  return !token.access || !token.expires || token.expires < Date.now() + KEEPER_REFRESH_THRESHOLD_MS
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
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      const headers: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        headers[key] = value
      })
      debugLog("refresh-failed", { status: res.status, headers, body: body.slice(0, 800) }, true)
      if (res.status === 429) {
        refresh429Cooldown.set(refresh, Date.now() + REFRESH_429_COOLDOWN_MS)
      }
      throw new Error(`token refresh failed (${res.status})`)
    }
    const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number }
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
  const res = await fetch(USAGE_ENDPOINT, {
    headers: { Authorization: `Bearer ${access}`, "anthropic-beta": OAUTH_BETA },
  })
  if (!res.ok) throw new Error(`usage request failed (${res.status})`)
  return (await res.json()) as UsageResponse
}

// Identify whatever account ex-machina currently holds in auth.json by its profile
// uuid (stable across token rotation) and upsert it: the same account is updated in
// place, a genuinely new login is added — so no manual /account-add is needed.
export async function autoCapture(): Promise<void> {
  await withAuthLock(async () => {
    const auth = await readAuthAnthropic()
    if (!auth?.refresh) return

    let token: AuthToken = { refresh: auth.refresh, access: auth.access, expires: auth.expires }
    if (isStale(token)) {
      token = await refreshToken(token.refresh)
      await writeAuthAnthropic(token)
    }

    const profile = await fetchProfile(token.access!)
    await upsertAccount(profile.uuid, profile.email, token)
  })
}

async function ensureFresh(account: StoredAccount): Promise<{ access?: string; updated?: StoredAccount }> {
  if (!isStale(account)) return { access: account.access }
  if (isRefresh429Cooldown(account.refresh)) {
    debugLog("refresh-skip-429-cooldown", { label: account.label }, true)
    return { access: account.access }
  }
  const fresh = await refreshToken(account.refresh)
  return { access: fresh.access, updated: { ...account, ...fresh } }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function collectAllUsage(): Promise<{ activeId?: string; results: AccountUsage[] }> {
  const file = await loadAccounts()

  const settled: { result: AccountUsage; updated?: StoredAccount }[] = []
  let needsRefresh = false

  for (const account of file.accounts) {
    const base = { id: account.id, label: account.label, active: account.id === file.activeId }
    try {
      const { access, updated } = await ensureFresh(account)
      if (updated) needsRefresh = true
      if (!access) {
        settled.push({ result: { ...base, error: "missing access token" }, updated })
        continue
      }
      const usage = await fetchUsage(access)
      settled.push({ result: { ...base, usage }, updated })
    } catch (error) {
      settled.push({ result: { ...base, error: errorMessage(error) } })
    }
    if (needsRefresh && file.accounts.indexOf(account) < file.accounts.length - 1) {
      await sleep(REFRESH_DELAY_MS)
    }
  }

  const updated = settled.flatMap((entry) => (entry.updated ? [entry.updated] : []))
  if (updated.length > 0) {
    await withAuthLock(async () => {
      const current = await loadAccounts()
      for (const account of updated) {
        const index = current.accounts.findIndex((existing) => existing.id === account.id)
        if (index >= 0) current.accounts[index] = { ...current.accounts[index], ...account }
      }
      await saveAccounts(current)
    })
  }

  return { activeId: file.activeId, results: settled.map((entry) => entry.result) }
}

export async function switchToAccount(id: string): Promise<StoredAccount> {
  return withAuthLock(async () => {
    const file = await loadAccounts()
    const index = file.accounts.findIndex((account) => account.id === id)
    if (index < 0) throw new Error("account not found")

    let account = file.accounts[index]
    if (isStale(account)) {
      if (isRefresh429Cooldown(account.refresh)) {
        debugLog("switch-skip-429-cooldown", { label: account.label }, true)
      } else {
        const fresh = await refreshToken(account.refresh)
        account = { ...account, ...fresh }
        file.accounts[index] = account
      }
    }

    file.activeId = id
    await saveAccounts(file)
    await writeAuthAnthropic({ refresh: account.refresh, access: account.access, expires: account.expires })
    return account
  })
}

async function keepAliveTick(): Promise<void> {
  try {
    const file = await loadAccounts()
    const activeId = file.activeId
    const stale = file.accounts.filter(
      (account) => account.id !== activeId && (isNearExpiry(account) || isRefresh429Cooldown(account.refresh)),
    )
    if (stale.length === 0) return

    debugLog("keeper-tick", { count: stale.length, labels: stale.map((a) => a.label) }, true)
    for (const account of stale) {
      if (isRefresh429Cooldown(account.refresh)) continue
      try {
        const fresh = await refreshToken(account.refresh)
        await withAuthLock(async () => {
          const current = await loadAccounts()
          const index = current.accounts.findIndex((a) => a.id === account.id)
          if (index >= 0) current.accounts[index] = { ...current.accounts[index], ...fresh }
          await saveAccounts(current)
        })
        debugLog("keeper-refreshed", { label: account.label }, true)
      } catch (error) {
        debugLog("keeper-failed", { label: account.label, error: errorMessage(error) }, true)
      }
      await sleep(REFRESH_DELAY_MS)
    }
  } catch (error) {
    debugLog("keeper-error", { error: errorMessage(error) }, true)
  }
}

export function startTokenKeeper(): void {
  if (keepAliveTimer) return
  keepAliveTimer = setInterval(() => {
    void keepAliveTick()
  }, KEEPER_INTERVAL_MS)
  debugLog("keeper-started", { interval: KEEPER_INTERVAL_MS }, true)
}

export function stopTokenKeeper(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = undefined
  }
}
