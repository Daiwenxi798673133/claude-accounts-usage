import { expect, test, mock } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

mock.module("./accounts.ts", () => ({
  loadAccounts: async () => ({
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B" },
    ],
    activeId: "acc1",
  }),
  readActiveId: async () => "acc1",
}))
const switchCalls: string[] = []
mock.module("./usage.ts", () => ({
  switchToAccount: async (id: string) => {
    switchCalls.push(id)
    return { id, label: id === "acc2" ? "B" : "A" }
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

test("无缝续接:只读回合 → revert + promptAsync,不弹手动重发提示", async () => {
  const { handlers, toasts, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireRetry(handlers, "evt-readonly")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.revert.length).toBe(1)
  expect(calls.promptAsync.length).toBe(1)
  expect(toasts.some((t) => t.message.includes("请手动重新发送") || t.message.includes("请手动重发"))).toBe(false)
  controller.dispose()
})

test("拒绝回退:改动回合(patch) → 不 revert,弹警告提示", async () => {
  const { handlers, toasts, calls, controller } = setup([{ type: "patch" }])
  fireRetry(handlers, "evt-mutated")
  await flush(() => toasts.some((t) => t.message.includes("未自动回退")))

  expect(calls.revert.length).toBe(0)
  expect(toasts.some((t) => t.variant === "warning" && t.message.includes("未自动回退"))).toBe(true)
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

test("force-limit 钩子:env 设 → idle 一次性注入 → revert+promptAsync,二次 idle 不再触发", async () => {
  process.env.CLAUDE_AUTOSWITCH_FORCE_LIMIT_ONCE = "1"
  switchCalls.length = 0
  try {
    const { handlers, toasts, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireIdle(handlers, "idle-arm")
    await flush(() => calls.promptAsync.length > 0)

    expect(switchCalls).toEqual(["acc2"])
    expect(calls.revert.length).toBe(1)
    expect(calls.promptAsync.length).toBe(1)
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
