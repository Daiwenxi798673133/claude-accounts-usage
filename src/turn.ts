export type TurnMessage = { id: string; role: string; parentID?: string }

// Latest turn = last user message + the LAST assistant after it. Multi-step turns (one user →
// several assistant messages from tool steps) MUST resolve to the final assistant, not bail.
// No revert anymore (abort + continue/resend only), so the old "no newer turn" guard is dropped.
export function latestTurn<T extends TurnMessage>(messages: readonly T[]): { user: T; failed: T } | undefined {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return undefined
  const user = messages[lastUserIdx]
  for (let i = messages.length - 1; i > lastUserIdx; i--) {
    if (messages[i].role === "assistant") return { user, failed: messages[i] }
  }
  return undefined
}
