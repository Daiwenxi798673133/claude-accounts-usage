import type { AuthToken, StoredAccount } from "./accounts.ts"
import { loadAccounts, readAuthAnthropic, saveAccounts, upsertAccount, withAuthLock, writeAuthAnthropic } from "./accounts.ts"
import { CLIENT_ID, OAUTH_BETA, TOKEN_EXPIRY_BUFFER_MS, TOKEN_URL, USAGE_ENDPOINT } from "./constants.ts"
import { fetchProfile } from "./profile.ts"

export type UsageWindow = { utilization: number; resets_at?: string }

export type UsageResponse = {
  five_hour?: UsageWindow
  seven_day?: UsageWindow
  seven_day_sonnet?: UsageWindow
  seven_day_opus?: UsageWindow
}

export type AccountUsage = {
  id: string
  label: string
  active: boolean
  usage?: UsageResponse
  error?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isStale(token: { access?: string; expires?: number }): boolean {
  return !token.access || !token.expires || token.expires < Date.now() + TOKEN_EXPIRY_BUFFER_MS
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

// Identify whatever account ex-machina currently holds in auth.json by its profile
// uuid (stable across token rotation) and upsert it: the same account is updated in
// place, a genuinely new login is added — so no manual /account-add is needed.
export async function autoCapture(): Promise<void> {
  await withAuthLock(async () => {
    const auth = await readAuthAnthropic()
    if (!auth?.refresh) return

    let token: AuthToken = { refresh: auth.refresh, access: auth.access, expires: auth.expires }
    if (isStale(token)) {
      token = await refreshToken(token.refresh)
      await writeAuthAnthropic(token)
    }

    const profile = await fetchProfile(token.access!)
    await upsertAccount(profile.uuid, profile.email, token)
  })
}

async function ensureFresh(account: StoredAccount): Promise<{ access?: string; updated?: StoredAccount }> {
  if (!isStale(account)) return { access: account.access }
  const fresh = await refreshToken(account.refresh)
  return { access: fresh.access, updated: { ...account, ...fresh } }
}

export async function collectAllUsage(): Promise<{ activeId?: string; results: AccountUsage[] }> {
  const file = await loadAccounts()

  const settled = await Promise.all(
    file.accounts.map(async (account): Promise<{ result: AccountUsage; updated?: StoredAccount }> => {
      const base = { id: account.id, label: account.label, active: account.id === file.activeId }
      try {
        const { access, updated } = await ensureFresh(account)
        if (!access) return { result: { ...base, error: "missing access token" }, updated }
        return { result: { ...base, usage: await fetchUsage(access) }, updated }
      } catch (error) {
        return { result: { ...base, error: errorMessage(error) } }
      }
    }),
  )

  const updated = settled.flatMap((entry) => (entry.updated ? [entry.updated] : []))
  if (updated.length > 0) {
    await withAuthLock(async () => {
      const current = await loadAccounts()
      for (const account of updated) {
        const index = current.accounts.findIndex((existing) => existing.id === account.id)
        if (index >= 0) current.accounts[index] = { ...current.accounts[index], ...account }
      }
      await saveAccounts(current)
    })
  }

  return { activeId: file.activeId, results: settled.map((entry) => entry.result) }
}

export async function switchToAccount(id: string): Promise<StoredAccount> {
  return withAuthLock(async () => {
    const file = await loadAccounts()
    const index = file.accounts.findIndex((account) => account.id === id)
    if (index < 0) throw new Error("account not found")

    let account = file.accounts[index]
    if (isStale(account)) {
      const fresh = await refreshToken(account.refresh)
      account = { ...account, ...fresh }
      file.accounts[index] = account
    }

    file.activeId = id
    await saveAccounts(file)
    await writeAuthAnthropic({ refresh: account.refresh, access: account.access, expires: account.expires })
    return account
  })
}
