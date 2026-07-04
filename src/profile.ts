import { NETWORK_TIMEOUT_MS, OAUTH_BETA, PROFILE_ENDPOINT } from "./constants.ts"
import { log } from "./logger.ts"

export type Profile = {
  uuid: string
  email: string
  displayName: string
}

export async function fetchProfile(access: string): Promise<Profile> {
  log.debug("profile:fetch-start")
  const res = await fetch(PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${access}`, "anthropic-beta": OAUTH_BETA },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
  if (!res.ok) {
    log.warn("profile:fetch-fail", { status: res.status })
    throw new Error(`profile request failed (${res.status})`)
  }

  const json = (await res.json()) as {
    account?: { uuid?: string; email?: string; display_name?: string; full_name?: string }
  }
  const account = json.account
  if (!account?.uuid) {
    log.warn("profile:no-uuid")
    throw new Error("profile response missing account uuid")
  }

  const profile = {
    uuid: account.uuid,
    email: account.email ?? account.uuid,
    displayName: account.display_name ?? account.full_name ?? account.email ?? account.uuid,
  }
  log.info("profile:fetch-ok", { uuid: profile.uuid, email: profile.email })
  return profile
}
