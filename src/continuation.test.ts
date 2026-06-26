import { expect, test } from "bun:test"
import { chooseContinuation, classifyTurnParts, INPLACE_MAX_WAIT_MS, type PartLike } from "./continuation.ts"

test("正常:只有文本 part → readonly", () => {
  const parts: PartLike[] = [{ type: "text" }, { type: "text" }]
  expect(classifyTurnParts(parts)).toBe("readonly")
})

test("正常:已完成的只读工具(read/grep/glob/list/webfetch)→ readonly", () => {
  const parts: PartLike[] = [
    { type: "tool", tool: "read", state: { status: "completed" } },
    { type: "tool", tool: "grep", state: { status: "completed" } },
    { type: "tool", tool: "glob", state: { status: "completed" } },
    { type: "tool", tool: "list", state: { status: "completed" } },
    { type: "tool", tool: "webfetch", state: { status: "completed" } },
  ]
  expect(classifyTurnParts(parts)).toBe("readonly")
})

test("正常:白名单大小写不敏感(READ / WebFetch)→ readonly", () => {
  const parts: PartLike[] = [
    { type: "tool", tool: "READ", state: { status: "completed" } },
    { type: "tool", tool: "WebFetch", state: { status: "running" } },
  ]
  expect(classifyTurnParts(parts)).toBe("readonly")
})

test("改动:出现任何 patch part → mutated", () => {
  const parts: PartLike[] = [{ type: "text" }, { type: "patch" }]
  expect(classifyTurnParts(parts)).toBe("mutated")
})

test("改动:已完成的写类工具(bash/edit/write/task)→ mutated", () => {
  for (const tool of ["bash", "edit", "write", "task"]) {
    const parts: PartLike[] = [{ type: "tool", tool, state: { status: "completed" } }]
    expect(classifyTurnParts(parts)).toBe("mutated")
  }
})

test("改动:未知工具名 → mutated", () => {
  const parts: PartLike[] = [{ type: "tool", tool: "frobnicate", state: { status: "completed" } }]
  expect(classifyTurnParts(parts)).toBe("mutated")
})

test("改动:只读 + 写(read + edit)混合 → mutated", () => {
  const parts: PartLike[] = [
    { type: "tool", tool: "read", state: { status: "completed" } },
    { type: "tool", tool: "edit", state: { status: "completed" } },
  ]
  expect(classifyTurnParts(parts)).toBe("mutated")
})

test("改动:非白名单工具 running(进行中)→ mutated(保守)", () => {
  const parts: PartLike[] = [{ type: "tool", tool: "bash", state: { status: "running" } }]
  expect(classifyTurnParts(parts)).toBe("mutated")
})

test("守卫:非白名单工具仍 pending(尚未开跑)→ readonly(还没写文件,revert 安全)", () => {
  const parts: PartLike[] = [{ type: "tool", tool: "bash", state: { status: "pending" } }]
  expect(classifyTurnParts(parts)).toBe("readonly")
})

test("边界:空 parts → readonly", () => {
  expect(classifyTurnParts([])).toBe("readonly")
})

test("续接:有 fresh 账号且 next 很近 → inplace", () => {
  const now = 1_000_000
  expect(chooseContinuation(now + 1000, now, true)).toBe("inplace")
})

test("续接:有 fresh 账号但 next 很远 → reprompt", () => {
  const now = 1_000_000
  expect(chooseContinuation(now + 60_000, now, true)).toBe("reprompt")
})

test("续接:next 很近但无 fresh 账号 → reprompt", () => {
  const now = 1_000_000
  expect(chooseContinuation(now + 1000, now, false)).toBe("reprompt")
})

test("边界:恰好等于阈值(INPLACE_MAX_WAIT_MS)且有 fresh 账号 → inplace", () => {
  const now = 1_000_000
  expect(chooseContinuation(now + INPLACE_MAX_WAIT_MS, now, true)).toBe("inplace")
})

test("边界:刚超过阈值一毫秒 → reprompt", () => {
  const now = 1_000_000
  expect(chooseContinuation(now + INPLACE_MAX_WAIT_MS + 1, now, true)).toBe("reprompt")
})
