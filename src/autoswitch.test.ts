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
const collectOptsLog: Array<{ isSessionRunning?: () => boolean } | undefined> = []
mock.module("./usage.ts", () => ({
  switchToAccount: async (id: string) => {
    switchCalls.push(id)
    return { id, label: accountLabel(id) }
  },
  collectAllUsage: async (opts?: { isSessionRunning?: () => boolean }) => {
    collectOptsLog.push(opts)
    return { results: [] }
  },
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

const fireRetry = (handlers: Map<string, Handler>, id: string, sessionID = "s1", message = "rate limit reached") =>
  handlers.get("session.status")?.({
    id,
    properties: { sessionID, status: { type: "retry", message } },
  })

const fireIdle = (handlers: Map<string, Handler>, id: string, sessionID = "s1") =>
  handlers.get("session.idle")?.({ id, properties: { sessionID } })

const fireStatus = (handlers: Map<string, Handler>, type: string, sessionID = "s1", id = `st-${Math.random()}`) =>
  handlers.get("session.status")?.({ id, properties: { sessionID, status: { type } } })

// `data` injects the exact statusCode + responseBody Anthropic returns; defaults (429, no body) keep prior callers intact.
const fireError = (
  handlers: Map<string, Handler>,
  headers: Record<string, string>,
  sessionID = "s1",
  id = `err-${Math.random()}`,
  data: { statusCode?: number; responseBody?: string } = {},
) =>
  handlers.get("session.error")?.({
    id,
    properties: {
      sessionID,
      error: {
        name: "APIError",
        data: { statusCode: data.statusCode ?? 429, responseHeaders: headers, responseBody: data.responseBody },
      },
    },
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

type SessionSpec = { userParts?: unknown[]; assistantSteps: unknown[][] }
const defaultUserParts = (): unknown[] => [{ type: "text", text: "hello", synthetic: false, ignored: false }]

// Per-session message/part registry so one controller can host several sessionIDs at once (C7),
// arbitrarily many assistant steps per turn (A-real-incident), and post-resume appended steps (C8).
function setupSessions(specs: Record<string, SessionSpec>) {
  const handlers = new Map<string, Handler>()
  const toasts: Toast[] = []
  const calls = { abort: 0, revert: [] as unknown[], promptAsync: [] as unknown[] }
  const sessionMessages = new Map<string, Array<Record<string, unknown>>>()
  const parts: Record<string, unknown[]> = {}
  const stepCount: Record<string, number> = {}

  const pushAssistant = (sessionID: string, stepParts: unknown[]): string => {
    const n = (stepCount[sessionID] = (stepCount[sessionID] ?? 0) + 1)
    const id = `${sessionID}-a${n}`
    parts[id] = stepParts
    sessionMessages
      .get(sessionID)
      ?.push({ id, role: "assistant", parentID: `${sessionID}-u`, providerID: "anthropic", modelID: "claude-x", agent: "build", error: undefined })
    return id
  }

  for (const [sessionID, spec] of Object.entries(specs)) {
    const userId = `${sessionID}-u`
    parts[userId] = spec.userParts ?? defaultUserParts()
    sessionMessages.set(sessionID, [{ id: userId, role: "user", parentID: undefined }])
    for (const stepParts of spec.assistantSteps) pushAssistant(sessionID, stepParts)
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
        messages: (sessionID: string) => sessionMessages.get(sessionID) ?? [],
        status: () => ({ type: "idle" }),
      },
      part: (id: string) => parts[id] ?? [],
    },
    kv: { get: () => ({}), set: () => {} },
  } as unknown as TuiPluginApi

  const controller = installAutoSwitch(api)
  return { handlers, toasts, calls, controller, pushAssistant }
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

test("needsReauth 号不参与自动切号:撞限切到健康号(acc3),跳过 needsReauth 的 acc2", async () => {
  switchCalls.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", needsReauth: true },
      { id: "acc3", label: "C" },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-skip-reauth")
    await flush(() => switchCalls.length > 0)

    expect(switchCalls).toContain("acc3")
    expect(switchCalls).not.toContain("acc2")
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("仅剩 needsReauth 号:撞限 → standDown(不切到 needsReauth 号、零 switch)", async () => {
  switchCalls.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", needsReauth: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, toasts, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-all-reauth")
    await flush(() => toasts.some((t) => t.variant === "error"))

    expect(switchCalls.length).toBe(0)
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
    // A known reset (cached future resets_at) is required for a countdown; without it the honest
    // behavior is soonestMs === undefined (locked separately by the only-pending standDown test).
    controller.setUsageCache([
      { id: "acc1", label: "A", active: true, usage: { five_hour: { utilization: 100, resets_at: new Date(Date.now() + 60_000).toISOString() } } },
    ])
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

test("B1-real-429-body:响应体 rate_limit_error(流式 SSE error,status 200)→ 经 fireError 实测触发切号到 acc2", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireError(handlers, {}, "s1", undefined, {
    statusCode: 200,
    responseBody: '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
  })
  await flush(() => switchCalls.length > 0)

  expect(switchCalls).toContain("acc2")
  await flush(() => calls.promptAsync.length > 0)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  controller.dispose()
})

test("B2-real-unified-header:头 anthropic-ratelimit-unified-status=rejected(无 429、无 body)→ 触发切号到 acc2", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireError(handlers, { "anthropic-ratelimit-unified-status": "rejected" }, "s1", undefined, { statusCode: 200 })
  await flush(() => switchCalls.length > 0)

  expect(switchCalls).toContain("acc2")
  controller.dispose()
})

test("B3-real-message-text:纯消息文案(retry 路径,无头无体)→ 触发切号到 acc2", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireRetry(handlers, "evt-B3", "s1", "This request would exceed your account's rate limit. Please try again later.")
  await flush(() => switchCalls.length > 0)

  expect(switchCalls).toContain("acc2")
  await flush(() => calls.promptAsync.length > 0)
  expect(calls.abort).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  controller.dispose()
})

test("B4-real-429-status:仅 429 statusCode(无头无体)→ 触发切号到 acc2", async () => {
  switchCalls.length = 0
  const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireError(handlers, {}, "s1", undefined, { statusCode: 429 })
  await flush(() => switchCalls.length > 0)

  expect(switchCalls).toContain("acc2")
  controller.dispose()
})

test("B5-real-529-overloaded:overloaded_error 响应体(529 类)→ 不切号、零 promptAsync、零 standdown", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireError(handlers, {}, "s1", undefined, {
    statusCode: 529,
    responseBody: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  })
  await flush(() => false)

  expect(switchCalls.length).toBe(0)
  expect(calls.promptAsync.length).toBe(0)
  expect(dialogCalls.exhausted.length).toBe(0)
  controller.dispose()
})

test("A-real-incident-shape:忠实复刻 ses_0e8b04 07:38(长 prompt + reasoning/tool/text/patch 多步 + 末步空占位)撞限 → 聚合判 continue,不含原始 prompt,从不 revert", async () => {
  const longPrompt =
    "请看这个飞书文档链接 https://example.feishu.cn/docx/abcd1234efgh5678 帮我把里面的需求整理成结构化清单,并落地到 src 下对应模块,注意保留既有的限流自动切号逻辑不要破坏。"
  const { handlers, calls, controller } = setupSessions({
    s1: {
      userParts: [{ type: "text", text: longPrompt, synthetic: false, ignored: false }],
      assistantSteps: [
        [{ type: "reasoning" }],
        [{ type: "tool", tool: "read", state: { status: "completed" } }],
        [{ type: "text", text: "我已经读完文档,接下来开始编辑对应模块" }],
        [{ type: "tool", tool: "edit", state: { status: "completed" } }, { type: "patch" }],
        [],
      ],
    },
  })
  fireRetry(handlers, "evt-A-incident", "s1")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(arg.parts.some((p) => p.type === "text" && p.text === longPrompt)).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

test("C7:两个 session 都停摆 + 单号恢复 → 逐个续接(对两个 session 各 promptAsync(continue) 一次)", async () => {
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
    const { handlers, calls, controller } = setupSessions({
      sA: { assistantSteps: [[{ type: "tool", tool: "read", state: { status: "completed" } }]] },
      sB: { assistantSteps: [[{ type: "tool", tool: "edit", state: { status: "completed" } }]] },
    })
    const reset = String((Date.now() + 200) / 1000)
    fireError(handlers, { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": reset }, "sA")
    fireError(handlers, { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": reset }, "sB")
    await flush(() => dialogCalls.exhausted.length >= 2)

    await flush(() => calls.promptAsync.length >= 2)
    expect(calls.promptAsync.length).toBe(2)
    const sessions = (calls.promptAsync as { sessionID: string; parts: { type: string; text?: string }[] }[]).map((a) => a.sessionID)
    expect(sessions).toContain("sA")
    expect(sessions).toContain("sB")
    for (const a of calls.promptAsync as { parts: { type: string; text?: string }[] }[]) {
      expect(a.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
    }
    expect(switchCalls).toContain("acc1")
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("C8:恢复-续接后同 session 再撞限(全员 excluded/cooled)→ 重新停摆 → 二次恢复再次续接(自愈)", async () => {
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
    const { handlers, calls, controller, pushAssistant } = setupSessions({
      sX: { assistantSteps: [[{ type: "tool", tool: "read", state: { status: "completed" } }]] },
    })
    fireError(handlers, { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String((Date.now() + 120) / 1000) }, "sX")
    await flush(() => dialogCalls.exhausted.length >= 1)
    await flush(() => calls.promptAsync.length >= 1)
    expect((calls.promptAsync[0] as { parts: { text?: string }[] }).parts.some((p) => p.text === "continue")).toBe(true)

    pushAssistant("sX", [{ type: "tool", tool: "edit", state: { status: "completed" } }])
    fireError(handlers, { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String((Date.now() + 120) / 1000) }, "sX")
    await flush(() => dialogCalls.exhausted.length >= 2)
    expect(dialogCalls.exhausted.length).toBe(2)

    await flush(() => calls.promptAsync.length >= 2)
    expect(calls.promptAsync.length).toBe(2)
    expect((calls.promptAsync[1] as { parts: { text?: string }[] }).parts.some((p) => p.text === "continue")).toBe(true)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

const usageEntry = (id: string, usage: Record<string, unknown>) => ({ id, label: id.toUpperCase(), active: true, usage })
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString()

test("I28-a:未知冷却(无头无缓存)→ 切到备号、待定账号被排除、不安排恢复、无 Infinity/NaN", async () => {
  switchCalls.length = 0
  dialogCalls.recovery.length = 0
  dialogCalls.exhausted.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  controller.setUsageCache([])
  fireRetry(handlers, "evt-I28-a")
  await flush(() => switchCalls.length > 0)
  expect(switchCalls).toContain("acc2")
  await flush(() => calls.promptAsync.length > 0)
  await new Promise((r) => setTimeout(r, 30))
  expect(dialogCalls.recovery.length).toBe(0)
  for (const args of dialogCalls.exhausted) {
    const v = args[1] as number | undefined
    expect(v === undefined || (typeof v === "number" && Number.isFinite(v))).toBe(true)
  }
  controller.dispose()
})

test("I28-b:仅剩待定冷却账号 → standDown soonestMs===undefined、无 Infinity", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }], activeId: "acc1" }
  try {
    const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([])
    fireRetry(handlers, "evt-I28-b")
    await flush(() => dialogCalls.exhausted.length > 0)
    expect((dialogCalls.exhausted[0] as unknown[])[1]).toBe(undefined)
    expect(switchCalls.length).toBe(0)
    expect(calls.promptAsync.length).toBe(0)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-i:onIdle 成功回合清除待定冷却 → 账号重新可选", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([])
    fireRetry(handlers, "evt-I28-i-cool")
    await flush(() => dialogCalls.exhausted.length > 0)
    expect(switchCalls.length).toBe(0)

    fireIdle(handlers, "evt-I28-i-idle")
    await new Promise((r) => setTimeout(r, 10))

    accountsOverride.activeId = "acc2"
    fireRetry(handlers, "evt-I28-i-reuse", "s2")
    await flush(() => switchCalls.length > 0)
    expect(switchCalls).toContain("acc1")
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-c:status 路径用缓存 resets_at → 恢复在真实 reset 触发(非 ~1ms 假恢复)", async () => {
  switchCalls.length = 0
  dialogCalls.recovery.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  controller.setUsageCache([usageEntry("acc1", { five_hour: { utilization: 100, resets_at: isoIn(200) } })])
  fireRetry(handlers, "evt-I28-c")
  await flush(() => calls.promptAsync.length > 0)
  expect(switchCalls).toContain("acc2")
  expect(dialogCalls.recovery.length).toBe(0)
  await flush(() => dialogCalls.recovery.length > 0)
  expect(dialogCalls.recovery.length).toBe(1)
  controller.dispose()
})

test("I28-d:响应头 reset 优先于缓存 resets_at", async () => {
  switchCalls.length = 0
  dialogCalls.recovery.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  controller.setUsageCache([usageEntry("acc1", { five_hour: { utilization: 100, resets_at: isoIn(5_000) } })])
  fireError(handlers, {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": String((Date.now() + 150) / 1000),
  })
  await flush(() => calls.promptAsync.length > 0)
  expect(switchCalls).toContain("acc2")
  expect(dialogCalls.recovery.length).toBe(0)
  await flush(() => dialogCalls.recovery.length > 0)
  expect(dialogCalls.recovery.length).toBe(1)
  controller.dispose()
})

test("I28-e1:过期缓存 resets_at 被忽略 → 未知(待定)、无恢复", async () => {
  switchCalls.length = 0
  dialogCalls.recovery.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([usageEntry("acc1", { five_hour: { utilization: 100, resets_at: isoIn(-1_000) } })])
    fireRetry(handlers, "evt-I28-e1")
    await flush(() => dialogCalls.exhausted.length > 0)
    expect((dialogCalls.exhausted[0] as unknown[])[1]).toBe(undefined)
    await new Promise((r) => setTimeout(r, 30))
    expect(dialogCalls.recovery.length).toBe(0)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-f:多窗口顶格 → 取最晚 resets_at", async () => {
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([
      usageEntry("acc1", {
        five_hour: { utilization: 100, resets_at: isoIn(100) },
        seven_day: { utilization: 100, resets_at: isoIn(300) },
      }),
    ])
    fireRetry(handlers, "evt-I28-f")
    await flush(() => dialogCalls.exhausted.length > 0)
    const v = (dialogCalls.exhausted[0] as unknown[])[1]
    expect(typeof v).toBe("number")
    expect(v as number).toBeGreaterThan(250)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-g:待定冷却经 setUsageCache 回填真实 reset → 升级为精确恢复", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  dialogCalls.recovery.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([])
    fireRetry(handlers, "evt-I28-g")
    await flush(() => dialogCalls.exhausted.length > 0)
    expect(switchCalls.length).toBe(0)
    expect(dialogCalls.recovery.length).toBe(0)

    controller.setUsageCache([usageEntry("acc1", { five_hour: { utilization: 100, resets_at: isoIn(150) } })])
    await flush(() => switchCalls.length > 0)
    expect(switchCalls).toContain("acc1")
    await flush(() => calls.promptAsync.length > 0)
    const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
    expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-h:待定冷却经 setUsageCache 发现已恢复(低用量)→ 清除、无恢复、重新可选", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  dialogCalls.recovery.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([])
    fireRetry(handlers, "evt-I28-h")
    await flush(() => dialogCalls.exhausted.length > 0)

    controller.setUsageCache([usageEntry("acc1", { five_hour: { utilization: 20, resets_at: isoIn(5_000) } })])
    await new Promise((r) => setTimeout(r, 30))
    expect(switchCalls.length).toBe(0)
    expect(dialogCalls.recovery.length).toBe(0)

    accountsOverride.activeId = "acc2"
    fireRetry(handlers, "evt-I28-h-reuse", "s2")
    await flush(() => switchCalls.length > 0)
    expect(switchCalls).toContain("acc1")
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-e2:待定冷却 + 全 null 窗口用量 → 清除(无 Infinity/NaN 定时器、无恢复)", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  dialogCalls.recovery.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([])
    fireRetry(handlers, "evt-I28-e2")
    await flush(() => dialogCalls.exhausted.length > 0)

    controller.setUsageCache([usageEntry("acc1", { five_hour: null, seven_day: null, seven_day_sonnet: null, seven_day_opus: null })])
    await new Promise((r) => setTimeout(r, 30))
    expect(switchCalls.length).toBe(0)
    expect(dialogCalls.recovery.length).toBe(0)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("T5-a:session.status busy → isSessionRunning true;idle → false;retry 保持 running(true)", async () => {
  const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireStatus(handlers, "busy", "s1")
  expect(controller.isSessionRunning()).toBe(true)
  fireStatus(handlers, "idle", "s1")
  expect(controller.isSessionRunning()).toBe(false)
  fireStatus(handlers, "retry", "s1")
  expect(controller.isSessionRunning()).toBe(true)
  controller.dispose()
})

test("T5-b:refreshUsageInBackground 把真实 isSessionRunning 谓词传给 collectAllUsage", async () => {
  collectOptsLog.length = 0
  switchCalls.length = 0
  const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireRetry(handlers, "evt-T5-b")
  await flush(() => collectOptsLog.length > 0)
  expect(typeof collectOptsLog[0]?.isSessionRunning).toBe("function")
  controller.dispose()
})

// doSwitch→switchToAccount 的接线继承 T4 的出账号反向同步;此处只断言接线本身切到下一个账号。
// 真正的"出账号 token 反向同步"由 usage.test.ts(T4)断言。
test("T5-c:doSwitch 撞限 → switchToAccount(下一个账号 acc2),接线继承 T4 反向同步", async () => {
  switchCalls.length = 0
  const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireRetry(handlers, "evt-T5-c")
  await flush(() => switchCalls.length > 0)
  expect(switchCalls).toContain("acc2")
  controller.dispose()
})

test("T5-d:INV-1 冷启动 — 无任何已观测会话 → isSessionRunning true(未知⇒running,绝不 false)", async () => {
  const { controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  expect(controller.isSessionRunning()).toBe(true)
  controller.dispose()
})
