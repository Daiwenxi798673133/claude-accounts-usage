export type PartLike = { type: string; tool?: string; state?: { status?: string } }

const READONLY_TOOLS: readonly string[] = ["read", "grep", "glob", "list", "webfetch"]

export const INPLACE_MAX_WAIT_MS = 5000

// Decide whether the failed turn may be auto-reverted: revert rolls back the turn's file writes
// too, so a turn that already wrote files (and whose redo can't reproduce them) must NOT be
// reverted — the data-loss bug. Only an allowlisted read-only tool is safe; any patch part or any
// non-allowlisted/unknown tool that has run (running or completed) makes the turn "mutated".
export function classifyTurnParts(parts: readonly PartLike[]): "readonly" | "mutated" {
  for (const part of parts) {
    if (part.type === "patch") return "mutated"
    if (part.type !== "tool") continue
    const name = (part.tool ?? "").toLowerCase()
    if (READONLY_TOOLS.includes(name)) continue
    // pending = hasn't run yet, so no files written and revert is still safe; anything else is mutated.
    if (part.state?.status !== "pending") return "mutated"
  }
  return "readonly"
}

// inplace (strategy B) only pays off with a fresh account and a near-term reset; T8 still routes
// everything through reprompt and T9 turns inplace on.
export function chooseContinuation(nextMs: number, now: number, hasFreshAccount: boolean): "inplace" | "reprompt" {
  if (hasFreshAccount && nextMs - now <= INPLACE_MAX_WAIT_MS) return "inplace"
  return "reprompt"
}
