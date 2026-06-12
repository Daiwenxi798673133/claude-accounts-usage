import { appendFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { loadAccounts, readActiveId, type AccountsFile, type StoredAccount } from "./accounts.ts"
import { collectAllUsage, switchToAccount, type AccountUsage, type UsageResponse } from "./usage.ts"

const ENABLED = true
const DEFAULT_COOLDOWN_MS = 60 * 60_000
const USAGE_CACHE_TTL_MS = 10 * 60_000
const RECENT_SWITCH_GUARD_MS = 4_000
const IDLE_WAIT_TIMEOUT_MS = 4_000
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

function debugLog(tag: string, payload: unknown): void {
  let serialized: string
  try {
    serialized = JSON.stringify(payload)
  } catch {
    serialized = String(payload)
  }
  const line = `${new Date().toISOString()} [${tag}] ${serialized}\n`
  void appendFile(join(homedir(), ".config", "opencode", "claude-autoswitch.log"), line).catch(() => undefined)
}

export function installAutoSwitch(api: TuiPluginApi): AutoSwitchController {
  const cooldown = new Map<string, number>()
  const attempted = new Map<string, Set<string>>()
  const sessionLocks = new Map<string, Promise<unknown>>()
  const repromptInFlight = new Set<string>()
  const lastAction = new Map<string, number>()
  const seen = new Set<string>()
  let usageCache: { at: number; byId: Map<string, UsageResponse> } = { at: 0, byId: new Map() }
  let refreshing = false
  let lastSwitch: { id?: string; sessionID?: string; at: number } = { at: 0 }

  const stored = api.kv.get<Record<string, number>>(COOLDOWN_KV_KEY, {})
  if (stored) for (const [id, until] of Object.entries(stored)) cooldown.set(id, until)

  function persistCooldown(): void {
    const now = Date.now()
    const snapshot: Record<string, number> = {}
    for (const [id, until] of cooldown) if (until > now) snapshot[id] = until
    api.kv.set(COOLDOWN_KV_KEY, snapshot)
  }

  function markCooldown(id: string, untilMs?: number): void {
    cooldown.set(id, untilMs ?? Date.now() + DEFAULT_COOLDOWN_MS)
    persistCooldown()
  }

  function clearCooldown(id: string): void {
    if (cooldown.delete(id)) persistCooldown()
  }

  function isCooled(id: string, now: number): boolean {
    const until = cooldown.get(id)
    return typeof until === "number" && until > now
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
      (account) => account.id !== activeId && !tried.has(account.id) && !isCooled(account.id, now),
    )
    if (candidates.length === 0) return undefined

    const cacheFresh = usageCache.at > 0 && now - usageCache.at <= USAGE_CACHE_TTL_MS
    if (cacheFresh) {
      return [...candidates].sort((a, b) => score(usageCache.byId.get(a.id)) - score(usageCache.byId.get(b.id)))[0]
    }

    const order = file.accounts.map((account) => account.id)
    const start = activeId ? order.indexOf(activeId) : -1
    for (let offset = 1; offset <= order.length; offset++) {
      const id = order[(start + offset + order.length) % order.length]
      const match = candidates.find((account) => account.id === id)
      if (match) return match
    }
    return candidates[0]
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
    debugLog("standdown", { accounts: file.accounts.length, soonest })
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
        debugLog("switched", { from: labelOf(file, activeId), to: account.label })
        api.ui.toast({
          variant: "warning",
          message: `「${labelOf(file, activeId)}」额度已满，已切到「${account.label}」并自动重试`,
        })
        void refreshUsageInBackground()
        return true
      } catch {
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

  function findFailedAssistant(messages: ReturnType<TuiPluginApi["state"]["session"]["messages"]>): AssistantMsg | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === "assistant" && message.error) return message
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === "assistant") return message
    }
    return undefined
  }

  function findUserMessage(
    messages: ReturnType<TuiPluginApi["state"]["session"]["messages"]>,
    failed?: AssistantMsg,
  ): StateMessage | undefined {
    if (failed?.parentID) {
      const parent = messages.find((message) => message.id === failed.parentID && message.role === "user")
      if (parent) return parent
    }
    const failedIndex = failed ? messages.findIndex((message) => message.id === failed.id) : messages.length
    const from = (failedIndex < 0 ? messages.length : failedIndex) - 1
    for (let i = from; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i]
    }
    return undefined
  }

  async function waitIdle(sessionID: string): Promise<void> {
    const deadline = Date.now() + IDLE_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const status = api.state.session.status(sessionID)
      if (!status || status.type === "idle") return
      await sleep(IDLE_POLL_MS)
    }
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
      await waitIdle(sessionID)

      const messages = api.state.session.messages(sessionID)
      const failed = findFailedAssistant(messages)
      const userMessage = findUserMessage(messages, failed)
      if (!userMessage) return guidance()

      const parts = toInputParts(api.state.part(userMessage.id))
      if (parts.length === 0) return guidance()

      const reverted = await api.client.session.revert({ sessionID, messageID: userMessage.id })
      if (reverted.error) return guidance()

      const prompted = await api.client.session.promptAsync({ sessionID, parts })
      if (prompted.error) guidance()
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

  async function onRetried(event: { id: string; properties: { sessionID: string; error: RetryErrorLike } }): Promise<void> {
    const error = event.properties.error
    debugLog("retried", {
      sessionID: event.properties.sessionID,
      statusCode: error?.statusCode,
      message: error?.message,
      headerKeys: Object.keys(error?.responseHeaders ?? {}),
      body: (error?.responseBody ?? "").slice(0, 300),
    })
    if (!ENABLED || !dedup(event.id)) return
    const matched = isUsageLimit(error)
    const anthropic = isAnthropicSession(event.properties.sessionID)
    debugLog("retried-decision", { matched, anthropic })
    if (!matched || !anthropic) return
    await handleLimit(event.properties.sessionID, error, "retry")
  }

  async function onStatus(event: {
    id: string
    properties: { sessionID: string; status?: { type: string; message?: string; next?: number } }
  }): Promise<void> {
    const status = event.properties.status
    debugLog("status", {
      sessionID: event.properties.sessionID,
      type: status?.type,
      message: status?.type === "retry" ? status.message : undefined,
    })
    if (status?.type !== "retry" || !ENABLED || !dedup(event.id)) return
    const error: RetryErrorLike = { message: status.message }
    const matched = isUsageLimit(error)
    const anthropic = isAnthropicSession(event.properties.sessionID)
    debugLog("status-decision", { matched, anthropic })
    if (!matched || !anthropic) return
    await handleLimit(event.properties.sessionID, error, "retry")
  }

  async function onError(event: { id: string; properties: { sessionID?: string; error?: unknown } }): Promise<void> {
    const sessionID = event.properties.sessionID
    const error = toErrorData(event.properties.error)
    debugLog("error", {
      sessionID,
      raw: event.properties.error,
      statusCode: error?.statusCode,
      message: error?.message,
    })
    if (!ENABLED || !dedup(event.id) || !sessionID) return
    const matched = !!error && isUsageLimit(error)
    const anthropic = isAnthropicSession(sessionID)
    debugLog("error-decision", { matched, anthropic })
    if (!matched || !anthropic) return
    await handleLimit(sessionID, error, "error")
  }

  async function onIdle(sessionID: string): Promise<void> {
    const assistant = lastAssistant(sessionID)
    if (assistant && !assistant.error) {
      const activeId = await readActiveId()
      if (activeId) clearCooldown(activeId)
    }
  }

  debugLog("installed", { enabled: ENABLED })

  const offs = [
    api.event.on("session.status", (event) => {
      void onStatus(event)
    }),
    api.event.on("session.next.retried", (event) => {
      void onRetried(event)
    }),
    api.event.on("session.error", (event) => {
      void onError(event)
    }),
    api.event.on("session.next.prompted", (event) => {
      attempted.delete(event.properties.sessionID)
      lastAction.delete(event.properties.sessionID)
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
      persistCooldown()
    },
    setUsageCache,
  }
}
