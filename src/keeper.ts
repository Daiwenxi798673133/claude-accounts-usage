import { watch, type FSWatcher } from "node:fs"
import { dirname } from "node:path"
import { getAuthJsonPath, loadAccounts, readAuthAnthropic } from "./accounts.ts"
import { KEEPALIVE_TICK_MS, WATCH_DEBOUNCE_MS } from "./constants.ts"
import { log } from "./logger.ts"
import { acquireInactiveAccess, autoCapture, keepActiveFresh } from "./usage.ts"

const KEEPER_REFRESH_DELAY_MS = 500
// Prompt heal sweep shortly after load (not truly 0ms — let OpenCode finish booting):
// refreshes every stale account up front so the first /usage is already fresh, and a
// user upgrading with stale on-disk tokens sees "需重新登录" only for genuinely dead chains.
const KEEPER_INITIAL_DELAY_MS = 2_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let lastSeenAuthRefresh: string | undefined

// Re-capture the active chain tip whenever ex-machina rewrites auth.json (rotation or a
// brand-new login), so the tip is never lost across an out-of-band switch (`opencode
// auth login`, restart). autoCapture identifies the account by profile uuid, so
// rotation-vs-new-login needs no guessing and a foreign token can never be attributed
// to the wrong account.
export async function onAuthJsonChanged(): Promise<void> {
  try {
    const auth = await readAuthAnthropic()
    if (!auth?.refresh || auth.refresh === lastSeenAuthRefresh) return
    if (!auth.expires || auth.expires < Date.now()) return
    await autoCapture()
    lastSeenAuthRefresh = auth.refresh
    log.debug("keeper:auth-change-captured")
  } catch (error) {
    log.warn("keeper:capture-fail", { error: errorMessage(error) })
  }
}

// Background keep-alive pass: refresh every INACTIVE account that is nearing expiry so
// /usage opens with instantly-usable tokens and idle chains never lapse. All safety
// guards (active skip per INV-2, needsReauth skip, staleness threshold, 429 cooldown,
// locking, revoked flagging) live inside acquireInactiveAccess.
export async function keeperTick(isSessionRunning: () => boolean): Promise<void> {
  try {
    await keepActiveFresh(isSessionRunning)
  } catch (error) {
    log.warn("keeper:active-fail", { error: errorMessage(error) })
  }
  let accounts
  try {
    accounts = (await loadAccounts()).accounts
  } catch (error) {
    log.warn("keeper:tick-fail", { error: errorMessage(error) })
    return
  }
  for (const account of accounts) {
    try {
      const { refreshed } = await acquireInactiveAccess(account.id)
      if (refreshed) {
        log.info("keeper:refreshed", { label: account.label })
        await new Promise((resolve) => setTimeout(resolve, KEEPER_REFRESH_DELAY_MS))
      }
    } catch (error) {
      log.warn("keeper:refresh-fail", { label: account.label, error: errorMessage(error) })
    }
  }
}

export function installTokenKeeper(isSessionRunning: () => boolean): { dispose: () => void } {
  let watcher: FSWatcher | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const interval = setInterval(() => void keeperTick(isSessionRunning), KEEPALIVE_TICK_MS)
  const initial = setTimeout(() => void keeperTick(isSessionRunning), KEEPER_INITIAL_DELAY_MS)
  interval.unref?.()
  initial.unref?.()
  void (async () => {
    try {
      const authPath = await getAuthJsonPath()
      if (disposed) return
      watcher = watch(dirname(authPath), (_event, filename) => {
        if (disposed) return
        if (filename && !String(filename).startsWith("auth.json")) return
        clearTimeout(debounce)
        debounce = setTimeout(() => void onAuthJsonChanged(), WATCH_DEBOUNCE_MS)
      })
      // An unhandled 'error' event on an EventEmitter crashes the host process — degrade
      // to interval-only keep-alive instead.
      watcher.on("error", (error) => log.warn("keeper:watch-error", { error: errorMessage(error) }))
      log.info("keeper:installed")
    } catch (error) {
      log.warn("keeper:watch-fail", { error: errorMessage(error) })
    }
  })()
  return {
    dispose() {
      disposed = true
      clearInterval(interval)
      clearTimeout(initial)
      clearTimeout(debounce)
      try {
        watcher?.close()
      } catch {}
    },
  }
}
