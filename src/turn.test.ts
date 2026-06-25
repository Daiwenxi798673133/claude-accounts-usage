import { expect, test } from "bun:test"
import { latestTurn, type TurnMessage } from "./turn.ts"

test("正常:命中最新一轮的 user + 失败 assistant", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
    { id: "u2", role: "user" },
    { id: "a2", role: "assistant", parentID: "u2" },
  ]
  const turn = latestTurn(msgs)
  expect(turn?.user.id).toBe("u2")
  expect(turn?.failed.id).toBe("a2")
})

test("回归:历史存在被 abort 的旧轮(按 error 会误选 a1)→ 仍只命中最新轮,绝不回退到 u1", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
    { id: "u2", role: "user" },
    { id: "a2", role: "assistant", parentID: "u2" },
  ]
  const turn = latestTurn(msgs)
  expect(turn?.user.id).toBe("u2")
  expect(turn?.failed.id).toBe("a2")
})

test("守卫:最新 user 尚无 assistant 响应 → undefined(不 revert)", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
    { id: "u2", role: "user" },
  ]
  expect(latestTurn(msgs)).toBeUndefined()
})

test("守卫:失败 assistant 之后仍有更新轮 → undefined", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
    { id: "a2", role: "assistant", parentID: "u1" },
  ]
  expect(latestTurn(msgs)).toBeUndefined()
})

test("边界:空消息 → undefined", () => {
  const msgs: TurnMessage[] = []
  expect(latestTurn(msgs)).toBeUndefined()
})
