import { readFile, writeFile, mkdir, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

export type StoredAccount = {
  label: string
  refresh: string
  access?: string
  expires?: number
}

export type AccountsFile = {
  version: number
  activeIndex: number
  accounts: StoredAccount[]
}

export type AnthropicOauth = {
  type: "oauth"
  access?: string
  refresh?: string
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

export async function loadAccounts(): Promise<AccountsFile> {
  const data = await readJson<Partial<AccountsFile>>(ACCOUNTS_PATH)
  return {
    version: data?.version ?? 1,
    activeIndex: typeof data?.activeIndex === "number" ? data.activeIndex : -1,
    accounts: Array.isArray(data?.accounts) ? (data!.accounts as StoredAccount[]) : [],
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

export async function writeAuthAnthropic(account: StoredAccount): Promise<void> {
  const path = await resolveAuthJsonPath()
  const auth = (await readJson<Record<string, unknown>>(path)) ?? {}
  auth["anthropic"] = {
    type: "oauth",
    access: account.access ?? "",
    refresh: account.refresh,
    expires: account.expires ?? 0,
  }
  await atomicWriteJson(path, auth)
}

export async function addAccountFromCurrentAuth(label?: string): Promise<StoredAccount | undefined> {
  const current = await readAuthAnthropic()
  if (!current?.refresh) return undefined

  const file = await loadAccounts()
  const account: StoredAccount = {
    label: label ?? `Account ${file.accounts.length + 1}`,
    refresh: current.refresh,
    access: current.access,
    expires: current.expires,
  }

  const existing = file.accounts.findIndex((a) => a.refresh === current.refresh)
  if (existing >= 0) {
    account.label = file.accounts[existing].label
    file.accounts[existing] = account
    file.activeIndex = existing
  } else {
    file.accounts.push(account)
    file.activeIndex = file.accounts.length - 1
  }

  await saveAccounts(file)
  return account
}

// auth.json only ever holds the account we last switched to (ex-machina refreshes
// that same identity in place), so its current token belongs to accounts[activeIndex].
// Copying it back reclaims any rotated refresh token ex-machina wrote after a refresh.
export async function syncActiveFromAuth(file: AccountsFile): Promise<AccountsFile> {
  if (file.activeIndex < 0 || file.activeIndex >= file.accounts.length) return file
  const current = await readAuthAnthropic()
  if (!current?.refresh) return file

  const active = file.accounts[file.activeIndex]
  if (current.refresh !== active.refresh || current.access !== active.access || current.expires !== active.expires) {
    active.refresh = current.refresh
    active.access = current.access
    active.expires = current.expires
    await saveAccounts(file)
  }
  return file
}

export async function setActiveIndex(index: number): Promise<void> {
  const file = await loadAccounts()
  if (index < 0 || index >= file.accounts.length) return
  file.activeIndex = index
  await saveAccounts(file)
}
