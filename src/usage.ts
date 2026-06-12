import type { StoredAccount } from "./accounts.ts"
import { loadAccounts, saveAccounts, syncActiveFromAuth, writeAuthAnthropic } from "./accounts.ts"
import { CLIENT_ID, OAUTH_BETA, TOKEN_EXPIRY_BUFFER_MS, TOKEN_URL, USAGE_ENDPOINT } from "./constants.ts"

export type UsageWindow = { utilization: number; resets_at?: string }

export type UsageResponse = {
  five_hour?: UsageWindow
  seven_day?: UsageWindow
  seven_day_sonnet?: UsageWindow
  seven_day_opus?: UsageWindow
}

export type AccountUsage = {
  index: number
  label: string
  active: boolean
  usage?: UsageResponse
  error?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function needsRefresh(account: StoredAccount): boolean {
  return !account.access || !account.expires || account.expires < Date.now() + TOKEN_EXPIRY_BUFFER_MS
}

export async function refreshToken(refresh: string): Promise<{ access: string; refresh: string; expires: number }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }),
  })
  if (!res.ok) throw new Error(`token refresh failed (${res.status})`)
  const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

export async function fetchUsage(access: string): Promise<UsageResponse> {
  const res = await fetch(USAGE_ENDPOINT, {
    headers: { Authorization: `Bearer ${access}`, "anthropic-beta": OAUTH_BETA },
  })
  if (!res.ok) throw new Error(`usage request failed (${res.status})`)
  return (await res.json()) as UsageResponse
}

async function loadOne(
  account: StoredAccount,
  index: number,
  activeIndex: number,
): Promise<{ result: AccountUsage; updated?: StoredAccount }> {
  const base = { index, label: account.label, active: index === activeIndex }
  let access = account.access
  let updated: StoredAccount | undefined

  if (needsRefresh(account)) {
    try {
      const fresh = await refreshToken(account.refresh)
      access = fresh.access
      updated = { ...account, access: fresh.access, refresh: fresh.refresh, expires: fresh.expires }
    } catch (error) {
      return { result: { ...base, error: errorMessage(error) } }
    }
  }

  if (!access) return { result: { ...base, error: "missing access token" }, updated }

  try {
    return { result: { ...base, usage: await fetchUsage(access) }, updated }
  } catch (error) {
    return { result: { ...base, error: errorMessage(error) }, updated }
  }
}

export async function collectAllUsage(): Promise<{ activeIndex: number; results: AccountUsage[] }> {
  const file = await syncActiveFromAuth(await loadAccounts())

  const settled = await Promise.all(file.accounts.map((account, index) => loadOne(account, index, file.activeIndex)))

  let mutated = false
  settled.forEach((entry, index) => {
    if (entry.updated) {
      file.accounts[index] = entry.updated
      mutated = true
    }
  })
  if (mutated) await saveAccounts(file)

  return { activeIndex: file.activeIndex, results: settled.map((entry) => entry.result) }
}

export async function switchToAccount(index: number): Promise<StoredAccount> {
  const file = await loadAccounts()
  if (index < 0 || index >= file.accounts.length) throw new Error("invalid account index")

  let account = file.accounts[index]
  if (needsRefresh(account)) {
    const fresh = await refreshToken(account.refresh)
    account = { ...account, access: fresh.access, refresh: fresh.refresh, expires: fresh.expires }
    file.accounts[index] = account
  }

  file.activeIndex = index
  await saveAccounts(file)
  await writeAuthAnthropic(account)
  return account
}
