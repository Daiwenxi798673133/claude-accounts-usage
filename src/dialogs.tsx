/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { StoredAccount } from "./accounts.ts"
import type { AccountUsage, UsageWindow } from "./usage.ts"

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

function WindowRow(props: { api: TuiPluginApi; name: string; win?: UsageWindow }) {
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

function AccountBlock(props: { api: TuiPluginApi; item: AccountUsage }) {
  const theme = () => props.api.theme.current
  return (
    <box flexDirection="column">
      <text fg={theme().text}>
        {props.item.active ? "●" : "○"} {props.item.label}
        {props.item.active ? " (当前)" : ""}
      </text>
      <Show when={props.item.error}>
        <text fg={theme().error}>  {props.item.error}</text>
      </Show>
      <Show when={props.item.usage}>
        {(usage) => (
          <box flexDirection="column" paddingLeft={2}>
            <WindowRow api={props.api} name="5h" win={usage().five_hour} />
            <WindowRow api={props.api} name="7d" win={usage().seven_day} />
            <WindowRow api={props.api} name="Sonnet" win={usage().seven_day_sonnet} />
          </box>
        )}
      </Show>
    </box>
  )
}

function UsageDialog(props: { api: TuiPluginApi; state: () => UsageState }) {
  const api = props.api
  const theme = () => api.theme.current
  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>Claude 账号用量</b>
        </text>
        <text fg={theme().textMuted}>esc 关闭</text>
      </box>
      <Show when={props.state().loading && props.state().results.length === 0}>
        <text fg={theme().textMuted}>加载中…</text>
      </Show>
      <Show when={props.state().error}>
        <text fg={theme().error}>{props.state().error}</text>
      </Show>
      <For each={props.state().results}>{(item) => <AccountBlock api={api} item={item} />}</For>
      <Show when={props.state().updatedAt}>
        <text fg={theme().textMuted}>更新于 {clockTime(props.state().updatedAt!)}</text>
      </Show>
    </box>
  )
}

export function openUsageDialog(api: TuiPluginApi, state: () => UsageState): void {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => <UsageDialog api={api} state={state} />)
}

function SwitchAccountRow(props: {
  api: TuiPluginApi
  account: StoredAccount
  activeId?: string
  usage?: AccountUsage
  selected: boolean
  loading: boolean
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
              <WindowRow api={props.api} name="Sonnet" win={usage().seven_day_sonnet} />
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

function SwitchDialog(props: {
  api: TuiPluginApi
  accounts: StoredAccount[]
  activeId?: string
  state: () => UsageState
  onSwitch: (id: string) => void
}) {
  const api = props.api
  const theme = () => api.theme.current
  const accounts = props.accounts
  const start = accounts.findIndex((account) => account.id === props.activeId)
  const [index, setIndex] = createSignal(start < 0 ? 0 : start)

  const usageById = createMemo(() => {
    const map = new Map<string, AccountUsage>()
    for (const result of props.state().results) map.set(result.id, result)
    return map
  })

  function move(delta: number): void {
    setIndex((i) => Math.max(0, Math.min(accounts.length - 1, i + delta)))
  }

  function confirm(): void {
    const account = accounts[index()]
    if (!account) return
    api.ui.dialog.clear()
    props.onSwitch(account.id)
  }

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
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
    }
  })

  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>切换 Claude 账号</b>
        </text>
        <text fg={theme().textMuted}>↑↓ 选择 · enter 切换 · esc 关闭</text>
      </box>
      <For each={accounts}>
        {(account, i) => (
          <SwitchAccountRow
            api={api}
            account={account}
            activeId={props.activeId}
            usage={usageById().get(account.id)}
            selected={i() === index()}
            loading={props.state().loading}
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

export function openSwitchDialog(
  api: TuiPluginApi,
  accounts: StoredAccount[],
  activeId: string | undefined,
  state: () => UsageState,
  onSwitch: (id: string) => void | Promise<void>,
): void {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <SwitchDialog api={api} accounts={accounts} activeId={activeId} state={state} onSwitch={(id) => void onSwitch(id)} />
  ))
}
