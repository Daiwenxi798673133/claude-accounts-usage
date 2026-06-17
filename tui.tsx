import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { loadAccounts } from "./src/accounts.ts"
import { autoCapture, collectAllUsage, switchToAccount } from "./src/usage.ts"
import { installAutoSwitch } from "./src/autoswitch.ts"
import { openSwitchDialog, openUsageDialog, type UsageState } from "./src/dialogs.tsx"

const ID = "claude-accounts-usage"

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const tui: TuiPlugin = async (api) => {
  const [state, setState] = createSignal<UsageState>({ loading: false, results: [] })

  const autoSwitch = installAutoSwitch(api)
  api.lifecycle.onDispose(autoSwitch.dispose)

  const refreshUsage = async () => {
    try {
      await autoCapture()
      const { results } = await collectAllUsage()
      autoSwitch.setUsageCache(results)
      setState({ loading: false, results, updatedAt: Date.now() })
    } catch (error) {
      setState((prev) => ({ loading: false, results: prev.results, error: message(error) }))
    }
  }

  void autoCapture().catch(() => undefined)

  const command = api.command
  if (!command) {
    api.ui.toast({ variant: "error", message: "当前 OpenCode 不支持命令注册 API,请更新 OpenCode" })
    return
  }

  command.register(() => [
    {
      title: "Claude: 查看账号用量",
      value: `${ID}.usage`,
      category: "Claude",
      slash: { name: "usage" },
      onSelect: () => {
        setState((prev) => ({ ...prev, loading: true, error: undefined }))
        openUsageDialog(api, state)
        void refreshUsage()
      },
    },
    {
      title: "Claude: 切换账号",
      value: `${ID}.switch`,
      category: "Claude",
      slash: { name: "switch" },
      onSelect: async () => {
        await autoCapture().catch(() => undefined)
        const file = await loadAccounts()
        if (file.accounts.length === 0) {
          api.ui.toast({ variant: "warning", message: "没有账号。请先用 ex-machina 登录 Claude" })
          return
        }
        setState((prev) => ({ ...prev, loading: true, error: undefined }))
        openSwitchDialog(api, file.accounts, file.activeId, state, async (id) => {
          try {
            const account = await switchToAccount(id)
            api.ui.toast({ variant: "success", message: `已切换到 ${account.label},下次对话生效` })
          } catch (error) {
            api.ui.toast({ variant: "error", message: `切换失败: ${message(error)}` })
          }
        })
        void refreshUsage()
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }

export default plugin
