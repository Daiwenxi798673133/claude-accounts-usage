import { OAUTH_BETA, PROFILE_ENDPOINT } from "./constants.ts"

export type Profile = {
  uuid: string
  email: string
  displayName: string
}

export async function fetchProfile(access: string): Promise<Profile> {
  const res = await fetch(PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${access}`, "anthropic-beta": OAUTH_BETA },
  })
  if (!res.ok) throw new Error(`profile request failed (${res.status})`)

  const json = (await res.json()) as {
    account?: { uuid?: string; email?: string; display_name?: string; full_name?: string }
  }
  const account = json.account
  if (!account?.uuid) throw new Error("profile response missing account uuid")

  return {
    uuid: account.uuid,
    email: account.email ?? account.uuid,
    displayName: account.display_name ?? account.full_name ?? account.email ?? account.uuid,
  }
}
