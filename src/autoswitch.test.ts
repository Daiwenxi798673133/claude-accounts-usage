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
const dialogCalls = { exhausted: [] as unknown[][], recovery: [] as unknown[][] }
mock.module("./dialogs.tsx", () => ({
  openRecoveryAlert: (...a: unknown[]) => {
    dialogCalls.recovery.push(a)
  },
  openExhaustedAlert: (...a: unknown[]) => {
    dialogCalls.exhausted.push(a)
  },
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

const fireError = (
  handlers: Map<string, Handler>,
  headers: Record<string, string>,
  sessionID = "s1",
  id = `err-${Math.random()}`,
) =>
  handlers.get("session.error")?.({
    id,
    properties: { sessionID, error: { name: "APIError", data: { statusCode: 429, responseHeaders: headers } } },
  })

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

function setupMultiStepParts(a1Parts: unknown[], a2Parts: unknown[]) {
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
    a1: a1Parts,
    a2: a2Parts,
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

function setupMultiStep(lastAssistantParts: unknown[]) {
  return setupMultiStepParts([{ type: "tool", tool: "read", state: { status: "completed" } }], lastAssistantParts)
}

test("A1 回归锁:多步末步空占位 [u1,a1(tool),a2(空)] 撞限 → 聚合整轮判 continue,不含原始 prompt(hello),从不 revert", async () => {
  const { handlers, calls, controller } = setupMultiStep([])
  fireRetry(handlers, "evt-A1-empty-tail")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

test("A2:多步 [u1,a1(reasoning),a2(空)] → continue,从不 revert", async () => {
  const { handlers, calls, controller } = setupMultiStepParts([{ type: "reasoning" }], [])
  fireRetry(handlers, "evt-A2-reasoning")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

test("A3:多步 [u1,a1(patch),a2(空)] → continue,从不 revert", async () => {
  const { handlers, calls, controller } = setupMultiStepParts([{ type: "patch" }], [])
  fireRetry(handlers, "evt-A3-patch")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

test("A4:多步 [u1,a1(非空text),a2(空)] → continue,从不 revert", async () => {
  const { handlers, calls, controller } = setupMultiStepParts([{ type: "text", text: "已经分析了一半" }], [])
  fireRetry(handlers, "evt-A4-text")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

test("A6:多步全程空 [u1,a1(空),a2(空)] → resend 原始 prompt(hello),从不 revert", async () => {
  const { handlers, calls, controller } = setupMultiStepParts([], [])
  fireRetry(handlers, "evt-A6-allempty")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(true)
  expect(arg.parts.some((p) => p.text === "continue")).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

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

test("C1:仅剩 excluded → standdown 弹 openExhaustedAlert 一次,零 promptAsync,零 switch", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-C1")
    await flush(() => dialogCalls.exhausted.length > 0)

    expect(dialogCalls.exhausted.length).toBe(1)
    expect(calls.promptAsync.length).toBe(0)
    expect(switchCalls.length).toBe(0)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("C3:standdown 弹窗携带最近恢复倒计时(soonestMs 为正数)", async () => {
  dialogCalls.exhausted.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-C3")
    await flush(() => dialogCalls.exhausted.length > 0)

    const args = dialogCalls.exhausted[0] as unknown[]
    expect(typeof args[1]).toBe("number")
    expect(args[1] as number).toBeGreaterThan(0)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("C4【headline】恢复计时到点 + 有停摆 → switchToAccount(恢复号) + promptAsync(continue)", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireError(handlers, {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String((Date.now() + 60) / 1000),
    })
    await flush(() => calls.promptAsync.length > 0)

    expect(switchCalls).toContain("acc1")
    expect(calls.promptAsync.length).toBe(1)
    const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
    expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("C5:恢复 + 无停摆 → openRecoveryAlert,恢复不触发额外 switch/promptAsync", async () => {
  switchCalls.length = 0
  dialogCalls.recovery.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireError(handlers, {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": String((Date.now() + 80) / 1000),
  })
  await flush(() => switchCalls.length > 0)
  const switchAfterSwitch = switchCalls.length
  const promptAfterSwitch = calls.promptAsync.length

  await flush(() => dialogCalls.recovery.length > 0)
  expect(dialogCalls.recovery.length).toBe(1)
  expect(switchCalls.length).toBe(switchAfterSwitch)
  expect(calls.promptAsync.length).toBe(promptAfterSwitch)
  controller.dispose()
})

test("C6:防二次续接 — 先停摆,fireIdle 成功移出停摆,恢复时不再 promptAsync", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  dialogCalls.recovery.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireError(handlers, {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String((Date.now() + 150) / 1000),
    })
    await flush(() => dialogCalls.exhausted.length > 0)

    accountsOverride.activeId = "acc2"
    fireIdle(handlers, "evt-C6-idle")
    await flush(() => dialogCalls.recovery.length > 0)

    expect(dialogCalls.recovery.length).toBe(1)
    expect(calls.promptAsync.length).toBe(0)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})
