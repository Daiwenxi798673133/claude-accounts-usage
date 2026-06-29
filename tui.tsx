import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { loadAccounts, removeAccount, setAccountExcluded } from "./src/accounts.ts"
import { autoCapture, collectAllUsage, switchToAccount } from "./src/usage.ts"
import { installAutoSwitch } from "./src/autoswitch.ts"
import { initLogger, log } from "./src/logger.ts"
import { openUsageDialog, type UsageState } from "./src/dialogs.tsx"
import { aggregate, loadRows, type RawRow, type TimeRange } from "./src/stats.ts"
import { openStatsDialog, type StatsState } from "./src/stats-dialog.tsx"

const ID = "claude-accounts-usage"

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const tui: TuiPlugin = async (api) => {
  initLogger(api.client)
  const [state, setState] = createSignal<UsageState>({ loading: false, results: [] })
  const [statsState, setStatsState] = createSignal<StatsState>({ loading: false })

  const autoSwitch = installAutoSwitch(api)
  api.lifecycle.onDispose(autoSwitch.dispose)

  let statsRows: RawRow[] | undefined
  let statsSeq = 0
  const reloadStats = async (range: TimeRange) => {
    if (statsRows) {
      try {
        setStatsState({ loading: false, data: aggregate(statsRows, range) })
      } catch (error) {
        log.warn("tui:stats-aggregate-fail", { error: message(error) })
        setStatsState({ loading: false, error: message(error) })
      }
      return
    }
    const seq = ++statsSeq
    setStatsState({ loading: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      const rows = loadRows()
      statsRows = rows
      if (seq === statsSeq) setStatsState({ loading: false, data: aggregate(rows, range) })
    } catch (error) {
      log.warn("tui:stats-load-fail", { error: message(error) })
      if (seq === statsSeq) setStatsState({ loading: false, error: message(error) })
    }
  }

  const refreshUsage = async () => {
    try {
      await autoCapture()
      const { results } = await collectAllUsage()
      autoSwitch.setUsageCache(results)
      setState({ loading: false, results, updatedAt: Date.now() })
    } catch (error) {
      log.warn("tui:refresh-usage-fail", { error: message(error) })
      setState((prev) => ({ loading: false, results: prev.results, error: message(error) }))
    }
  }

  void autoCapture().catch((e) => log.debug("tui:autocapture-fail", { error: message(e) }))

  const command = api.command
  if (!command) {
    log.error("tui:no-command-api")
    api.ui.toast({ variant: "error", message: "当前 OpenCode 不支持命令注册 API,请更新 OpenCode" })
    return
  }

  command.register(() => [
    {
      title: "Claude: 查看账号用量并切换",
      value: `${ID}.usage`,
      category: "Claude",
      slash: { name: "usage" },
      onSelect: async () => {
        await autoCapture().catch((e) => log.debug("tui:autocapture-fail", { error: message(e) }))
        const file = await loadAccounts()
        log.info("tui:usage-open", { accounts: file.accounts.length })
        if (file.accounts.length === 0) {
          api.ui.toast({ variant: "warning", message: "没有账号。请先用 ex-machina 登录 Claude" })
          return
        }
        setState((prev) => ({ ...prev, loading: true, error: undefined }))
        openUsageDialog(
          api,
          file.accounts,
          file.activeId,
          state,
          async (id) => {
            try {
              const account = await switchToAccount(id)
              log.info("tui:switch-ok", { id })
              api.ui.toast({ variant: "success", message: `已切换到 ${account.label},下次对话生效` })
            } catch (error) {
              log.warn("tui:switch-fail", { id, error: message(error) })
              api.ui.toast({ variant: "error", message: `切换失败: ${message(error)}` })
            }
          },
          async (id) => {
            try {
              const removed = await removeAccount(id)
              log.info("tui:remove-ok", { id })
              if (removed) api.ui.toast({ variant: "success", message: `已删除账号 ${removed.label}` })
              void refreshUsage()
            } catch (error) {
              log.warn("tui:remove-fail", { id, error: message(error) })
              api.ui.toast({ variant: "error", message: `删除失败: ${message(error)}` })
            }
          },
          async (id, next) => {
            try {
              await setAccountExcluded(id, next)
              api.ui.toast({ variant: "success", message: next ? "已标记,不参与自动切号" : "已取消标记" })
              void refreshUsage()
            } catch (error) {
              api.ui.toast({ variant: "error", message: `标记失败: ${message(error)}` })
            }
          },
        )
        void refreshUsage()
      },
    },
    {
      title: "Claude: 查看 OpenCode 用量统计",
      value: `${ID}.stats`,
      category: "Claude",
      slash: { name: "stats" },
      onSelect: async () => {
        log.info("tui:stats-open")
        statsRows = undefined
        setStatsState({ loading: true })
        openStatsDialog(api, statsState, (range) => void reloadStats(range))
        await reloadStats("all")
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }

export default plugin
