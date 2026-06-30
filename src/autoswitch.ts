import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { loadAccounts, readActiveId, type AccountsFile, type StoredAccount } from "./accounts.ts"
import { log, redactHeaders, redactBody } from "./logger.ts"
import { openRecoveryAlert } from "./dialogs.tsx"
import { latestTurn } from "./turn.ts"
import { decideRedo, type PartLike } from "./continuation.ts"
import { collectAllUsage, switchToAccount, type AccountUsage, type UsageResponse } from "./usage.ts"

const ENABLED = true
const DEFAULT_COOLDOWN_MS = 60 * 60_000
const USAGE_CACHE_TTL_MS = 10 * 60_000
const RECENT_SWITCH_GUARD_MS = 4_000
const IDLE_WAIT_TIMEOUT_MS = 8_000
const IDLE_POLL_MS = 150
const COOLDOWN_KV_KEY = "claude-accounts-usage.autoswitch.cooldown"

type StateParts = ReturnType<TuiPluginApi["state"]["part"]>
type StateMessage = ReturnType<TuiPluginApi["state"]["session"]["messages"]>[number]
type AssistantMsg = Extract<StateMessage, { role: "assistant" }>
type PromptParts = NonNullable<Parameters<TuiPluginApi["client"]["session"]["promptAsync"]>[0]["parts"]>

type RetryErrorLike = {
  statusCode?: number
  responseHeaders?: Record<string, string>
  responseBody?: string
  message?: string
}

export type AutoSwitchController = {
  dispose: () => void
  setUsageCache: (results: AccountUsage[]) => void
}

function lowerKeys(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (headers) for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value
  return out
}

function safeJson(body?: string): { error?: { type?: unknown; message?: unknown } } | undefined {
  if (!body) return undefined
  try {
    const value = JSON.parse(body)
    return typeof value === "object" && value !== null ? (value as { error?: { type?: unknown; message?: unknown } }) : undefined
  } catch {
    return undefined
  }
}

// Detects a Claude Pro/Max rate-limit / quota rejection so we can switch accounts.
// 529 overloads are excluded (switching won't help). Anthropic surfaces this through
// several shapes depending on path (unified headers, JSON body type, or just a message
// string like "This request would exceed your account's rate limit"), so we match on
// ANY of: 429 status, rate_limit_error type, or rate-limit message text — the message
// regex is the one maintenance point as Anthropic's wording may drift.
function isUsageLimit(error?: RetryErrorLike): boolean {
  if (!error) return false
  const body = error.responseBody ?? ""
  if (/overloaded_error/i.test(body)) return false
  const headers = lowerKeys(error.responseHeaders)
  const unifiedRejected = Object.entries(headers).some(
    ([key, value]) =>
      key.startsWith("anthropic-ratelimit-unified") && key.endsWith("status") && String(value).toLowerCase().includes("rejected"),
  )
  if (unifiedRejected) return true
  const parsed = safeJson(body)?.error
  const type = typeof parsed?.type === "string" ? parsed.type : ""
  const text = `${typeof parsed?.message === "string" ? parsed.message : ""} ${error.message ?? ""}`.toLowerCase()
  const rateLimitText = /rate limit|usage limit|limit reached|too many requests|out of (?:usage|quota)|5[- ]?hour|weekly limit|exceed/.test(text)
  return error.statusCode === 429 || type === "rate_limit_error" || rateLimitText
}

function parseResetMs(error: RetryErrorLike): number | undefined {
  const headers = lowerKeys(error.responseHeaders)
  const reset = Number(headers["anthropic-ratelimit-unified-reset"])
  if (Number.isFinite(reset) && reset > 0) return reset * 1000
  const retryAfter = Number(headers["retry-after"])
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Date.now() + retryAfter * 1000
  return undefined
}

function toErrorData(error: unknown): RetryErrorLike | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const candidate = error as { name?: unknown; data?: RetryErrorLike }
  if (candidate.name === "APIError" && candidate.data && typeof candidate.data === "object") return candidate.data
  return undefined
}

function score(usage?: UsageResponse): number {
  if (!usage) return Number.POSITIVE_INFINITY
  return Math.max(
    usage.five_hour?.utilization ?? 0,
    usage.seven_day?.utilization ?? 0,
    usage.seven_day_sonnet?.utilization ?? 0,
    usage.seven_day_opus?.utilization ?? 0,
  )
}

function fmtDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function installAutoSwitch(api: TuiPluginApi): AutoSwitchController {
  const cooldown = new Map<string, number>()
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingRecovered = new Map<string, string>()
  let recoveryRetryTimer: ReturnType<typeof setTimeout> | undefined
  const attempted = new Map<string, Set<string>>()
  const sessionLocks = new Map<string, Promise<unknown>>()
  const repromptInFlight = new Set<string>()
  const lastAction = new Map<string, number>()
  const lastHandledAssistantId = new Map<string, string>()
  const seen = new Set<string>()
  let usageCache: { at: number; byId: Map<string, UsageResponse> } = { at: 0, byId: new Map() }
  let refreshing = false
  let lastSwitch: { id?: string; sessionID?: string; at: number } = { at: 0 }
  // One-shot smoke hook (read once; UNSET ⇒ never armed ⇒ zero overhead). When truthy, the next
  // idle turn injects one synthetic usage-limit to exercise the real switch→continue/resend path.
  let forceLimitOnce = Boolean(process.env.CLAUDE_AUTOSWITCH_FORCE_LIMIT_ONCE)

  function persistCooldown(): void {
    const now = Date.now()
    const snapshot: Record<string, number> = {}
    for (const [id, until] of cooldown) if (until > now) snapshot[id] = until
    api.kv.set(COOLDOWN_KV_KEY, snapshot)
  }

  function scheduleRecovery(id: string, until: number): void {
    const existing = recoveryTimers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      recoveryTimers.delete(id)
      void announceRecovery(id)
    }, Math.max(0, until - Date.now()))
    recoveryTimers.set(id, timer)
  }

  // Estimated recovery only: the cooldown deadline comes from the rate-limit
  // response (or a default), so an elapsed timer means the quota *should* be
  // back — we don't re-hit the API to verify before announcing.
  async function announceRecovery(id: string): Promise<void> {
    const file = await loadAccounts()
    const account = file.accounts.find((item) => item.id === id)
    cooldown.delete(id)
    persistCooldown()
    if (!account) return
    pendingRecovered.set(id, account.label)
    flushRecovered()
  }

  function flushRecovered(): void {
    if (pendingRecovered.size === 0) return
    if (api.ui.dialog.open) {
      if (!recoveryRetryTimer) {
        recoveryRetryTimer = setTimeout(() => {
          recoveryRetryTimer = undefined
          flushRecovered()
        }, 3_000)
      }
      return
    }
    const labels = [...pendingRecovered.values()]
    pendingRecovered.clear()
    openRecoveryAlert(api, labels)
    void refreshUsageInBackground()
  }

  function markCooldown(id: string, untilMs?: number): void {
    const until = untilMs ?? Date.now() + DEFAULT_COOLDOWN_MS
    cooldown.set(id, until)
    persistCooldown()
    scheduleRecovery(id, until)
    log.info("autoswitch:cooldown-enter", { id, until })
  }

  function clearCooldown(id: string): void {
    const timer = recoveryTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      recoveryTimers.delete(id)
    }
    pendingRecovered.delete(id)
    if (cooldown.delete(id)) {
      persistCooldown()
      log.info("autoswitch:cooldown-clear", { id })
    }
  }

  function isCooled(id: string, now: number): boolean {
    const until = cooldown.get(id)
    return typeof until === "number" && until > now
  }

  const stored = api.kv.get<Record<string, number>>(COOLDOWN_KV_KEY, {})
  if (stored) {
    const now = Date.now()
    for (const [id, until] of Object.entries(stored)) {
      if (until <= now) continue
      cooldown.set(id, until)
      scheduleRecovery(id, until)
    }
  }

  function setUsageCache(results: AccountUsage[]): void {
    const byId = new Map<string, UsageResponse>()
    for (const result of results) if (result.usage) byId.set(result.id, result.usage)
    usageCache = { at: Date.now(), byId }
  }

  async function refreshUsageInBackground(): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      const { results } = await collectAllUsage()
      setUsageCache(results)
    } catch {
      // best-effort cache warming; selection falls back to round-robin
      log.debug("autoswitch:usage-refresh-fail")
    } finally {
      refreshing = false
    }
  }

  function dedup(id: string): boolean {
    if (seen.has(id)) return false
    seen.add(id)
    if (seen.size > 1000) {
      seen.clear()
      seen.add(id)
    }
    return true
  }

  function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = sessionLocks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    sessionLocks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  function labelOf(file: AccountsFile, id?: string): string {
    return file.accounts.find((account) => account.id === id)?.label ?? "当前账号"
  }

  function lastAssistant(sessionID: string): AssistantMsg | undefined {
    const messages = api.state.session.messages(sessionID)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === "assistant") return message
    }
    return undefined
  }

  function isAnthropicSession(sessionID: string): boolean {
    const assistant = lastAssistant(sessionID)
    return !assistant || assistant.providerID === "anthropic"
  }

  function pickNext(file: AccountsFile, tried: Set<string>, activeId?: string): StoredAccount | undefined {
    const now = Date.now()
    const candidates = file.accounts.filter(
      (account) => account.id !== activeId && !tried.has(account.id) && !isCooled(account.id, now) && !account.excluded,
    )
    if (candidates.length === 0) {
      log.debug("autoswitch:pick", { candidates: 0, cacheFresh: false, picked: undefined })
      return undefined
    }

    const cacheFresh = usageCache.at > 0 && now - usageCache.at <= USAGE_CACHE_TTL_MS
    let picked: StoredAccount | undefined = candidates[0]
    if (cacheFresh) {
      picked = [...candidates].sort((a, b) => score(usageCache.byId.get(a.id)) - score(usageCache.byId.get(b.id)))[0]
    } else {
      const order = file.accounts.map((account) => account.id)
      const start = activeId ? order.indexOf(activeId) : -1
      for (let offset = 1; offset <= order.length; offset++) {
        const id = order[(start + offset + order.length) % order.length]
        const match = candidates.find((account) => account.id === id)
        if (match) {
          picked = match
          break
        }
      }
    }
    log.debug("autoswitch:pick", { candidates: candidates.length, cacheFresh, picked: picked?.id })
    return picked
  }

  function standDown(file: AccountsFile): void {
    const now = Date.now()
    const times = file.accounts
      .map((account) => cooldown.get(account.id))
      .filter((until): until is number => typeof until === "number" && until > now)
    const soonest = times.length > 0 ? Math.min(...times) : undefined
    const message = soonest
      ? `所有账号都已达额度上限，约 ${fmtDuration(soonest - now)} 后恢复`
      : "所有账号都已达额度上限"
    log.warn("autoswitch:standdown", { accounts: file.accounts.length, soonest })
    api.ui.toast({ variant: "error", message })
  }

  async function doSwitch(sessionID: string, error: RetryErrorLike, activeId?: string): Promise<boolean> {
    if (activeId) markCooldown(activeId, parseResetMs(error))

    const file = await loadAccounts()
    const tried = attempted.get(sessionID) ?? new Set<string>()
    attempted.set(sessionID, tried)
    if (file.accounts.length <= 1) {
      standDown(file)
      return false
    }

    for (let i = 0; i < file.accounts.length; i++) {
      const next = pickNext(file, tried, activeId)
      if (!next) break
      try {
        const account = await switchToAccount(next.id)
        tried.add(next.id)
        lastSwitch = { id: account.id, sessionID, at: Date.now() }
        log.info("autoswitch:switched", { from: labelOf(file, activeId), to: account.label })
        api.ui.toast({
          variant: "warning",
          message: `「${labelOf(file, activeId)}」额度已满，已切到「${account.label}」并自动重试`,
        })
        void refreshUsageInBackground()
        return true
      } catch (error) {
        log.warn("autoswitch:switch-candidate-fail", { id: next.id, error: String(error) })
        tried.add(next.id)
        markCooldown(next.id, undefined)
      }
    }

    standDown(file)
    return false
  }

  function toInputParts(parts: StateParts): PromptParts {
    const out: PromptParts = []
    for (const part of parts) {
      if (part.type === "text") {
        if (part.synthetic || part.ignored) continue
        if (part.text && part.text.trim().length > 0) out.push({ type: "text", text: part.text })
      } else if (part.type === "file") {
        out.push({ type: "file", mime: part.mime, filename: part.filename, url: part.url, source: part.source })
      }
    }
    return out
  }

  async function waitIdle(sessionID: string): Promise<boolean> {
    const deadline = Date.now() + IDLE_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const status = api.state.session.status(sessionID)
      if (!status || status.type === "idle") return true
      await sleep(IDLE_POLL_MS)
    }
    log.debug("autoswitch:wait-idle-timeout", { sessionID })
    return false
  }

  async function repromptFailedTurn(sessionID: string, abortFirst: boolean): Promise<void> {
    if (repromptInFlight.has(sessionID)) return
    repromptInFlight.add(sessionID)
    const guidance = () => api.ui.toast({ variant: "info", message: "已切换账号，请手动重新发送上一条消息" })
    try {
      if (abortFirst) {
        try {
          await api.client.session.abort({ sessionID })
        } catch {
          // ignore: stream may already be settling
        }
      }
      if (!(await waitIdle(sessionID))) return guidance()

      const messages = api.state.session.messages(sessionID)
      const turn = latestTurn(messages)
      if (!turn) return guidance()
      const { user, failed, assistants } = turn

      if (lastHandledAssistantId.get(sessionID) === failed.id) return

      // Fold parts across all assistant steps, not just the last: a rate-limit hit at a step
      // boundary leaves an empty placeholder tail, so judging `failed.id` alone resends instead
      // of continuing the productive earlier steps.
      const failedParts: PartLike[] = assistants.flatMap((m) =>
        api.state.part(m.id).map((part) => ({
          type: part.type,
          tool: part.type === "tool" ? part.tool : undefined,
          text: part.type === "text" ? part.text : undefined,
          state: part.type === "tool" ? { status: part.state?.status } : undefined,
        })),
      )

      let parts: PromptParts
      if (decideRedo(failedParts) === "continue") {
        parts = [{ type: "text", text: "continue" }]
        log.debug("autoswitch:continue", { sessionID })
      } else {
        parts = toInputParts(api.state.part(user.id))
        if (parts.length === 0) return guidance()
        log.debug("autoswitch:resend", { sessionID })
      }

      lastHandledAssistantId.set(sessionID, failed.id)
      // Replay the failed turn's model + agent so the redo runs under the same config;
      // promptAsync has no `mode` param, so session mode cannot be carried over (known limit).
      const arg: Parameters<TuiPluginApi["client"]["session"]["promptAsync"]>[0] = { sessionID, parts }
      if (failed.role === "assistant") {
        arg.model = { providerID: failed.providerID, modelID: failed.modelID }
        if (failed.agent) arg.agent = failed.agent
      }
      const prompted = await api.client.session.promptAsync(arg)
      if (prompted.error) {
        lastHandledAssistantId.delete(sessionID)
        guidance()
      }
    } catch {
      guidance()
    } finally {
      repromptInFlight.delete(sessionID)
    }
  }

  async function handleLimit(sessionID: string, error: RetryErrorLike, mode: "retry" | "error"): Promise<void> {
    await runExclusive(sessionID, async () => {
      const now = Date.now()
      // Coalesce the burst of retry/error events a single failed turn emits: once we have
      // acted for this session, ignore further limit events until that action settles.
      if (now - (lastAction.get(sessionID) ?? 0) < RECENT_SWITCH_GUARD_MS) return

      const activeId = await readActiveId()
      // Cross-session race: another session just switched to this fresh account, so the
      // failure predates the switch. Reuse the fresh account instead of cooling it again.
      const reuseFresh =
        !!activeId && lastSwitch.id === activeId && lastSwitch.sessionID !== sessionID && now - lastSwitch.at < RECENT_SWITCH_GUARD_MS
      const usable = reuseFresh ? true : await doSwitch(sessionID, error, activeId)
      if (!usable) return

      lastAction.set(sessionID, Date.now())
      await repromptFailedTurn(sessionID, mode === "retry")
    })
  }

  async function onStatus(event: {
    id: string
    properties: { sessionID: string; status?: { type: string; message?: string; next?: number } }
  }): Promise<void> {
    const status = event.properties.status
    log.debug("autoswitch:status", {
      sessionID: event.properties.sessionID,
      type: status?.type,
      message: status?.type === "retry" ? status.message : undefined,
    })
    if (status?.type !== "retry" || !ENABLED || !dedup(event.id)) return
    const error: RetryErrorLike = { message: status.message }
    const matched = isUsageLimit(error)
    const anthropic = isAnthropicSession(event.properties.sessionID)
    log.debug("autoswitch:status-decision", { matched, anthropic })
    if (!matched || !anthropic) return
    await handleLimit(event.properties.sessionID, error, "retry")
  }

  async function onError(event: { id: string; properties: { sessionID?: string; error?: unknown } }): Promise<void> {
    const sessionID = event.properties.sessionID
    const error = toErrorData(event.properties.error)
    log.debug("autoswitch:error", {
      sessionID,
      statusCode: error?.statusCode,
      message: error?.message,
      headerKeys: redactHeaders(error?.responseHeaders),
      body: redactBody(error?.responseBody),
    })
    if (!ENABLED || !dedup(event.id) || !sessionID) return
    const matched = !!error && isUsageLimit(error)
    const anthropic = isAnthropicSession(sessionID)
    log.debug("autoswitch:error-decision", { matched, anthropic })
    if (!matched || !anthropic) return
    await handleLimit(sessionID, error, "error")
  }

  async function onIdle(sessionID: string): Promise<void> {
    const assistant = lastAssistant(sessionID)
    if (assistant && !assistant.error) {
      const activeId = await readActiveId()
      if (activeId) clearCooldown(activeId)
      // A successful turn resets the per-session switch state so a later limit can switch again;
      // this relocates the reset the dead session.next.prompted handler used to do.
      attempted.delete(sessionID)
      lastAction.delete(sessionID)
    }
    if (forceLimitOnce) {
      forceLimitOnce = false
      log.info("autoswitch:force-limit-injected", { sessionID })
      const error: RetryErrorLike = { statusCode: 429, message: "forced rate limit (test): rate limit reached" }
      await handleLimit(sessionID, error, "error")
    }
  }

  log.info("autoswitch:installed", { enabled: ENABLED })

  // session.next.* is not delivered to the current OpenCode SDK; detection relies on
  // session.status(retry) + session.error.
  const offs = [
    api.event.on("session.status", (event) => {
      void onStatus(event)
    }),
    api.event.on("session.error", (event) => {
      void onError(event)
    }),
    api.event.on("session.idle", (event) => {
      void onIdle(event.properties.sessionID)
    }),
  ]

  return {
    dispose: () => {
      for (const off of offs) {
        try {
          off()
        } catch {
          // ignore unsubscribe failures during teardown
        }
      }
      for (const timer of recoveryTimers.values()) clearTimeout(timer)
      recoveryTimers.clear()
      if (recoveryRetryTimer) clearTimeout(recoveryRetryTimer)
      persistCooldown()
    },
    setUsageCache,
  }
}
