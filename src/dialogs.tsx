/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { StoredAccount } from "./accounts.ts"
import type { AccountUsage, UsageResponse, UsageWindow } from "./usage.ts"

export type UsageState = {
  loading: boolean
  results: AccountUsage[]
  updatedAt?: number
  error?: string
}

function bar(util: number, width = 18): string {
  const pct = Math.max(0, Math.min(100, util))
  const fill = Math.round((pct / 100) * width)
  return `[${"#".repeat(fill)}${"-".repeat(width - fill)}]`
}

function percent(util: number): string {
  return `${Math.round(util)}%`
}

function tone(api: TuiPluginApi, util: number) {
  const theme = api.theme.current
  if (util >= 85) return theme.error
  if (util >= 60) return theme.warning
  return theme.success
}

function resetIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return "now"
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function WindowRow(props: { api: TuiPluginApi; name: string; win?: UsageWindow | null }) {
  const theme = () => props.api.theme.current
  return (
    <Show when={props.win}>
      {(win) => (
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>{props.name.padEnd(6)}</text>
          <text fg={tone(props.api, win().utilization)}>
            {bar(win().utilization)} {percent(win().utilization)}
          </text>
          <Show when={win().resets_at}>
            <text fg={theme().textMuted}>重置 {resetIn(win().resets_at!)}</text>
          </Show>
        </box>
      )}
    </Show>
  )
}

function ModelWindowRow(props: { api: TuiPluginApi; usage: () => UsageResponse }) {
  const opus = () => props.usage().seven_day_opus
  return <WindowRow api={props.api} name={opus() ? "Opus" : "Sonnet"} win={opus() ?? props.usage().seven_day_sonnet} />
}

function AccountRow(props: {
  api: TuiPluginApi
  account: StoredAccount
  activeId?: string
  usage?: AccountUsage
  selected: boolean
  loading: boolean
  pendingDelete: boolean
}) {
  const theme = () => props.api.theme.current
  const isActive = () => props.account.id === props.activeId
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={props.selected ? theme().primary : theme().textMuted}>{props.selected ? "▶" : " "}</text>
        <text fg={props.selected ? theme().primary : theme().text}>
          {isActive() ? "●" : "○"} {props.account.label}
          {isActive() ? " (当前)" : ""}
        </text>
        <Show when={props.account.excluded}>
          <text fg={theme().textMuted}>不自动切</text>
        </Show>
        <Show when={props.pendingDelete}>
          <text fg={theme().error}>确认删除? 再按 d · 其他键取消</text>
        </Show>
      </box>
      <box flexDirection="column" paddingLeft={4}>
        <Show when={props.usage?.error}>
          <text fg={theme().error}>{props.usage!.error}</text>
        </Show>
        <Show when={props.usage?.usage}>
          {(usage) => (
            <box flexDirection="column">
              <WindowRow api={props.api} name="5h" win={usage().five_hour} />
              <WindowRow api={props.api} name="7d" win={usage().seven_day} />
              <ModelWindowRow api={props.api} usage={usage} />
            </box>
          )}
        </Show>
        <Show when={props.loading && !props.usage?.usage && !props.usage?.error}>
          <text fg={theme().textMuted}>加载中…</text>
        </Show>
      </box>
    </box>
  )
}

function AccountsPanel(props: {
  api: TuiPluginApi
  accounts: StoredAccount[]
  activeId?: string
  state: () => UsageState
  onSwitch: (id: string) => void
  onDelete: (id: string) => void
  onToggleExclude: (id: string, next: boolean) => void
}) {
  const api = props.api
  const theme = () => api.theme.current
  const [accounts, setAccounts] = createSignal(props.accounts)
  const start = props.accounts.findIndex((account) => account.id === props.activeId)
  const [index, setIndex] = createSignal(start < 0 ? 0 : start)
  const [pendingDelete, setPendingDelete] = createSignal(false)

  const usageById = createMemo(() => {
    const map = new Map<string, AccountUsage>()
    for (const result of props.state().results) map.set(result.id, result)
    return map
  })

  function move(delta: number): void {
    setPendingDelete(false)
    setIndex((i) => Math.max(0, Math.min(accounts().length - 1, i + delta)))
  }

  function confirm(): void {
    const account = accounts()[index()]
    if (!account) return
    api.ui.dialog.clear()
    props.onSwitch(account.id)
  }

  function requestDelete(): void {
    const account = accounts()[index()]
    if (!account) return
    if (account.id === props.activeId) {
      api.ui.toast({ variant: "warning", message: "无法删除当前账号(会被自动重新收录)" })
      return
    }
    setPendingDelete(true)
  }

  function performDelete(): void {
    const account = accounts()[index()]
    setPendingDelete(false)
    if (!account || account.id === props.activeId) return
    props.onDelete(account.id)
    const next = accounts().filter((item) => item.id !== account.id)
    if (next.length === 0) {
      api.ui.dialog.clear()
      return
    }
    setAccounts(next)
    setIndex((i) => Math.min(i, next.length - 1))
  }

  useKeyboard((evt) => {
    if (evt.name === "d") {
      evt.preventDefault()
      evt.stopPropagation()
      if (pendingDelete()) performDelete()
      else requestDelete()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      setPendingDelete(false)
      confirm()
      return
    }
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      evt.stopPropagation()
      move(-1)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      evt.stopPropagation()
      move(1)
      return
    }
    if (evt.name === "m") {
      evt.preventDefault()
      evt.stopPropagation()
      setPendingDelete(false)
      const account = accounts()[index()]
      if (!account) return
      const next = !account.excluded
      props.onToggleExclude(account.id, next)
      setAccounts((list) => list.map((item) => (item.id === account.id ? { ...item, excluded: next } : item)))
      return
    }
    setPendingDelete(false)
  })

  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>Claude 账号用量</b>
        </text>
        <text fg={theme().textMuted}>↑↓ 选择 · enter 切换 · m 标记不自动切 · d 删除 · esc 关闭</text>
      </box>
      <For each={accounts()}>
        {(account, i) => (
          <AccountRow
            api={api}
            account={account}
            activeId={props.activeId}
            usage={usageById().get(account.id)}
            selected={i() === index()}
            loading={props.state().loading}
            pendingDelete={pendingDelete() && i() === index()}
          />
        )}
      </For>
      <Show when={props.state().error}>
        <text fg={theme().error}>{props.state().error}</text>
      </Show>
      <Show when={props.state().updatedAt}>
        <text fg={theme().textMuted}>更新于 {clockTime(props.state().updatedAt!)}</text>
      </Show>
    </box>
  )
}

export function openRecoveryAlert(api: TuiPluginApi, labels: string[]): void {
  if (labels.length === 0) return
  const message =
    labels.length === 1
      ? `账号「${labels[0]}」额度应已恢复，可在 /usage 切回使用`
      : `${labels.length} 个账号额度应已恢复：${labels.join("、")}`
  const Alert = api.ui.DialogAlert
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => <Alert title="额度恢复" message={message} onConfirm={() => api.ui.dialog.clear()} />)
}

export function openUsageDialog(
  api: TuiPluginApi,
  accounts: StoredAccount[],
  activeId: string | undefined,
  state: () => UsageState,
  onSwitch: (id: string) => void | Promise<void>,
  onDelete: (id: string) => void | Promise<void>,
  onToggleExclude: (id: string, next: boolean) => void | Promise<void>,
): void {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <AccountsPanel
      api={api}
      accounts={accounts}
      activeId={activeId}
      state={state}
      onSwitch={(id) => void onSwitch(id)}
      onDelete={(id) => void onDelete(id)}
      onToggleExclude={(id, next) => void onToggleExclude(id, next)}
    />
  ))
}
