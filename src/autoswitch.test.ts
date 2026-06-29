import { expect, test, mock } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

type AccountsState = { accounts: Array<Record<string, unknown>>; activeId?: string }
const defaultAccounts = (): AccountsState => ({
  accounts: [
    { id: "acc1", label: "A" },
    { id: "acc2", label: "B" },
  ],
  activeId: "acc1",
})
let accountsOverride: AccountsState | undefined
mock.module("./accounts.ts", () => ({
  loadAccounts: async () => accountsOverride ?? defaultAccounts(),
  readActiveId: async () => (accountsOverride ?? defaultAccounts()).activeId,
}))
const switchCalls: string[] = []
const accountLabel = (id: string) => (id === "acc2" ? "B" : id === "acc3" ? "C" : "A")
mock.module("./usage.ts", () => ({
  switchToAccount: async (id: string) => {
    switchCalls.push(id)
    return { id, label: accountLabel(id) }
  },
  collectAllUsage: async () => ({ results: [] }),
}))
mock.module("./dialogs.tsx", () => ({
  openRecoveryAlert: () => {},
}))

const { installAutoSwitch } = await import("./autoswitch.ts")

type Toast = { variant?: string; message: string }
type Handler = (event: { id: string; properties: Record<string, unknown> }) => void

function setup(failedParts: unknown[]) {
  const handlers = new Map<string, Handler>()
  const toasts: Toast[] = []
  const calls = { abort: 0, revert: [] as unknown[], promptAsync: [] as unknown[] }
  const messages = [
    { id: "u1", role: "user", parentID: undefined },
    { id: "a1", role: "assistant", parentID: "u1", providerID: "anthropic", modelID: "claude-x", agent: "build", error: undefined },
  ]
  const parts: Record<string, unknown[]> = {
    u1: [{ type: "text", text: "hello", synthetic: false, ignored: false }],
    a1: failedParts,
  }

  const api = {
    event: {
      on: (name: string, cb: Handler) => {
        handlers.set(name, cb)
        return () => handlers.delete(name)
      },
    },
    ui: { toast: (t: Toast) => toasts.push(t), dialog: { open: false } },
    client: {
      app: { log: () => Promise.resolve() },
      session: {
        abort: async () => {
          calls.abort++
          return {}
        },
        revert: async (a: unknown) => {
          calls.revert.push(a)
          return { error: undefined }
        },
        promptAsync: async (a: unknown) => {
          calls.promptAsync.push(a)
          return { error: undefined }
        },
      },
    },
    state: {
      session: {
        messages: () => messages,
        status: () => ({ type: "idle" }),
      },
      part: (id: string) => parts[id] ?? [],
    },
    kv: { get: () => ({}), set: () => {} },
  } as unknown as TuiPluginApi

  const controller = installAutoSwitch(api)
  return { handlers, toasts, calls, controller }
}

async function flush(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 1))
  }
}

const fireRetry = (handlers: Map<string, Handler>, id: string) =>
  handlers.get("session.status")?.({
    id,
    properties: { sessionID: "s1", status: { type: "retry", message: "rate limit reached" } },
  })

const fireIdle = (handlers: Map<string, Handler>, id: string) =>
  handlers.get("session.idle")?.({ id, properties: { sessionID: "s1" } })

test("无缝续接:有产出回合 → promptAsync(continue),从不 revert,不弹手动重发提示", async () => {
  const { handlers, toasts, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireRetry(handlers, "evt-output")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.revert.length).toBe(0)
  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(toasts.some((t) => t.message.includes("请手动重新发送") || t.message.includes("请手动重发"))).toBe(false)
  controller.dispose()
})

test("无缝续接:已改文件回合(patch) → 同样 promptAsync(continue),从不 revert,无拒绝提示", async () => {
  const { handlers, toasts, calls, controller } = setup([{ type: "patch" }])
  fireRetry(handlers, "evt-patch")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.revert.length).toBe(0)
  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(toasts.some((t) => t.message.includes("请手动重发") || t.message.includes("未自动回退"))).toBe(false)
  controller.dispose()
})

test("无产出回合(失败 assistant 无 parts) → promptAsync 收到原始 prompt parts(resend),从不 revert", async () => {
  const { handlers, calls, controller } = setup([])
  fireRetry(handlers, "evt-noout")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.revert.length).toBe(0)
  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(true)
  expect(arg.parts.some((p) => p.text === "continue")).toBe(false)
  controller.dispose()
})

test("force-limit 钩子:env 未设 → 正常回合 idle 不触发任何切号/注入", async () => {
  delete process.env.CLAUDE_AUTOSWITCH_FORCE_LIMIT_ONCE
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireIdle(handlers, "idle-noop")
  await flush(() => false)

  expect(switchCalls.length).toBe(0)
  expect(calls.revert.length).toBe(0)
  expect(calls.promptAsync.length).toBe(0)
  controller.dispose()
})

test("force-limit 钩子:env 设 → idle 一次性注入 → continue/resend(从不 revert),二次 idle 不再触发", async () => {
  process.env.CLAUDE_AUTOSWITCH_FORCE_LIMIT_ONCE = "1"
  switchCalls.length = 0
  try {
    const { handlers, toasts, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireIdle(handlers, "idle-arm")
    await flush(() => calls.promptAsync.length > 0)

    expect(switchCalls).toEqual(["acc2"])
    expect(calls.revert.length).toBe(0)
    expect(calls.promptAsync.length).toBe(1)
    const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
    expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
    expect(toasts.some((t) => t.message.includes("请手动重新发送") || t.message.includes("请手动重发"))).toBe(false)

    const promptedOnce = calls.promptAsync.length
    fireIdle(handlers, "idle-rearm")
    await flush(() => false)
    expect(calls.promptAsync.length).toBe(promptedOnce)
    controller.dispose()
  } finally {
    delete process.env.CLAUDE_AUTOSWITCH_FORCE_LIMIT_ONCE
  }
})

function setupMultiStep(lastAssistantParts: unknown[]) {
  const handlers = new Map<string, Handler>()
  const toasts: Toast[] = []
  const calls = { abort: 0, revert: [] as unknown[], promptAsync: [] as unknown[] }
  const messages = [
    { id: "u1", role: "user", parentID: undefined },
    { id: "a1", role: "assistant", parentID: "u1", providerID: "anthropic", modelID: "claude-x", agent: "build", error: undefined },
    { id: "a2", role: "assistant", parentID: "u1", providerID: "anthropic", modelID: "claude-x", agent: "build", error: undefined },
  ]
  const parts: Record<string, unknown[]> = {
    u1: [{ type: "text", text: "hello", synthetic: false, ignored: false }],
    a1: [{ type: "tool", tool: "read", state: { status: "completed" } }],
    a2: lastAssistantParts,
  }

  const api = {
    event: {
      on: (name: string, cb: Handler) => {
        handlers.set(name, cb)
        return () => handlers.delete(name)
      },
    },
    ui: { toast: (t: Toast) => toasts.push(t), dialog: { open: false } },
    client: {
      app: { log: () => Promise.resolve() },
      session: {
        abort: async () => {
          calls.abort++
          return {}
        },
        revert: async (a: unknown) => {
          calls.revert.push(a)
          return { error: undefined }
        },
        promptAsync: async (a: unknown) => {
          calls.promptAsync.push(a)
          return { error: undefined }
        },
      },
    },
    state: {
      session: {
        messages: () => messages,
        status: () => ({ type: "idle" }),
      },
      part: (id: string) => parts[id] ?? [],
    },
    kv: { get: () => ({}), set: () => {} },
  } as unknown as TuiPluginApi

  const controller = installAutoSwitch(api)
  return { handlers, toasts, calls, controller }
}

test("多步回合(一 user 多 assistant)撞限 → 命中最后一条 assistant → promptAsync(continue),从不 revert,无手动重发提示", async () => {
  const { handlers, toasts, calls, controller } = setupMultiStep([{ type: "tool", tool: "edit", state: { status: "completed" } }])
  fireRetry(handlers, "evt-multistep")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(calls.revert.length).toBe(0)
  expect(toasts.some((t) => t.message.includes("请手动重新发送") || t.message.includes("请手动重发"))).toBe(false)
  controller.dispose()
})

test("标记号不参与自动切号:撞限切到未标记号(acc3),跳过 excluded 的 acc2", async () => {
  switchCalls.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
      { id: "acc3", label: "C" },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-skip-excluded")
    await flush(() => switchCalls.length > 0)

    expect(switchCalls).toContain("acc3")
    expect(switchCalls).not.toContain("acc2")
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("仅剩标记号:撞限 → standDown(不切到标记号、零 promptAsync、出现额度上限 toast)", async () => {
  switchCalls.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, toasts, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-all-excluded")
    await flush(() => toasts.some((t) => t.variant === "error"))

    expect(switchCalls.length).toBe(0)
    expect(calls.promptAsync.length).toBe(0)
    expect(toasts.some((t) => t.variant === "error" && t.message.includes("额度上限"))).toBe(true)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})
