import { appendFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG_PATH = join(homedir(), ".config", "opencode", "claude-autoswitch.log")

export function debugLog(tag: string, payload: unknown, force = false): void {
  if (!force && !process.env.CLAUDE_AUTOSWITCH_DEBUG) return
  let serialized: string
  try {
    serialized = JSON.stringify(payload)
  } catch {
    serialized = String(payload)
  }
  const line = `${new Date().toISOString()} [${tag}] ${serialized}\n`
  void appendFile(LOG_PATH, line).catch(() => undefined)
}
