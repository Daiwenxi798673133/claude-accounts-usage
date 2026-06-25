export type TurnMessage = { id: string; role: string; parentID?: string }

// Target by POSITION (latest user turn, asserted no newer turn after it), never by message.error:
// a rate limit sets no error while stale aborted turns keep one, so error-scan could pick an older
// turn and revert past it — the data-loss bug. undefined means leave the session untouched.
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
  const failed = messages.find((message) => message.role === "assistant" && message.parentID === user.id)
  if (!failed) return undefined
  const failedIdx = messages.findIndex((message) => message.id === failed.id)
  const hasNewer = messages.slice(failedIdx + 1).some((message) => message.role === "user" || message.role === "assistant")
  if (hasNewer) return undefined
  return { user, failed }
}
