import { readFile, writeFile, mkdir, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { log } from "./logger.ts"

export type StoredAccount = {
  id: string
  label: string
  refresh: string
  access?: string
  expires?: number
}

export type AccountsFile = {
  version: number
  activeId?: string
  accounts: StoredAccount[]
}

export type AnthropicOauth = {
  type: "oauth"
  access?: string
  refresh?: string
  expires?: number
}

export type AuthToken = {
  refresh: string
  access?: string
  expires?: number
}

const ACCOUNTS_PATH = join(homedir(), ".config", "opencode", "claude-accounts.json")

function authJsonCandidates(): string[] {
  const list: string[] = []
  if (process.env.XDG_DATA_HOME) list.push(join(process.env.XDG_DATA_HOME, "opencode", "auth.json"))
  list.push(join(homedir(), ".local", "share", "opencode", "auth.json"))
  list.push(join(homedir(), "Library", "Application Support", "opencode", "auth.json"))
  return list
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return undefined
  }
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await rename(tmp, path)
}

async function resolveAuthJsonPath(): Promise<string> {
  const candidates = authJsonCandidates()
  for (const candidate of candidates) {
    if (await readJson(candidate)) return candidate
  }
  return candidates[0]
}

// Serializes auth.json / claude-accounts.json read-modify-writes. NOT reentrant:
// never nest withAuthLock inside another withAuthLock or it deadlocks.
let authLock: Promise<unknown> = Promise.resolve()

export function withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = authLock.then(fn, fn)
  authLock = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function readActiveId(): Promise<string | undefined> {
  return (await loadAccounts()).activeId
}

export async function loadAccounts(): Promise<AccountsFile> {
  const data = await readJson<Partial<AccountsFile>>(ACCOUNTS_PATH)
  return {
    version: data?.version ?? 1,
    activeId: data?.activeId,
    accounts: Array.isArray(data?.accounts)
      ? (data!.accounts as StoredAccount[]).filter((account) => typeof account.id === "string" && account.id.length > 0)
      : [],
  }
}

export async function saveAccounts(file: AccountsFile): Promise<void> {
  await atomicWriteJson(ACCOUNTS_PATH, file)
}

export async function readAuthAnthropic(): Promise<AnthropicOauth | undefined> {
  const auth = await readJson<Record<string, unknown>>(await resolveAuthJsonPath())
  const entry = auth?.["anthropic"]
  if (entry && typeof entry === "object" && (entry as AnthropicOauth).type === "oauth") {
    return entry as AnthropicOauth
  }
  return undefined
}

export async function writeAuthAnthropic(token: AuthToken): Promise<void> {
  const path = await resolveAuthJsonPath()
  const auth = (await readJson<Record<string, unknown>>(path)) ?? {}
  auth["anthropic"] = {
    type: "oauth",
    access: token.access ?? "",
    refresh: token.refresh,
    expires: token.expires ?? 0,
  }
  await atomicWriteJson(path, auth)
  log.info("accounts:write-auth", { hasAccess: Boolean(token.access), expires: token.expires ?? 0 })
}

export async function upsertAccount(id: string, label: string, token: AuthToken): Promise<AccountsFile> {
  const file = await loadAccounts()
  const index = file.accounts.findIndex((account) => account.id === id)
  const inserted = index < 0
  if (index >= 0) {
    file.accounts[index] = {
      ...file.accounts[index],
      refresh: token.refresh,
      access: token.access,
      expires: token.expires,
    }
  } else {
    file.accounts.push({ id, label, refresh: token.refresh, access: token.access, expires: token.expires })
  }
  file.activeId = id
  await saveAccounts(file)
  log.info("accounts:upsert", { id, label, inserted })
  return file
}

export async function setActiveId(id: string): Promise<void> {
  const file = await loadAccounts()
  if (!file.accounts.some((account) => account.id === id)) {
    log.warn("accounts:set-active-unknown", { id })
    return
  }
  const from = file.activeId
  file.activeId = id
  await saveAccounts(file)
  log.info("accounts:set-active", { from, to: id })
}

// Removes an account from claude-accounts.json only. Deliberately does NOT touch
// auth.json: ex-machina owns that file, and the active account would just be
// re-captured by autoCapture anyway — callers must block deleting the active one.
export async function removeAccount(id: string): Promise<StoredAccount | undefined> {
  return withAuthLock(async () => {
    const file = await loadAccounts()
    const index = file.accounts.findIndex((account) => account.id === id)
    if (index < 0) return undefined
    const [removed] = file.accounts.splice(index, 1)
    if (file.activeId === id) file.activeId = undefined
    await saveAccounts(file)
    log.info("accounts:remove", { id, label: removed.label })
    return removed
  })
}
