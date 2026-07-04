// Shared Anthropic OAuth client_id used by the official Claude Pro/Max flow
// (same value as @ex-machina/opencode-anthropic-auth), so refresh tokens stored
// by that plugin are accepted by the refresh endpoint below.
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"

export const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile"

export const OAUTH_BETA = "oauth-2025-04-20"

// Refresh slightly before real expiry so neither ex-machina nor the usage call
// receives an already-stale access token.
export const TOKEN_EXPIRY_BUFFER_MS = 60_000

// Proactively refresh accounts whose access token expires within this window: INACTIVE
// accounts on every /usage + keeper tick, and the ACTIVE chain only while idle (no
// anthropic session running) — ex-machina refreshes only at request time, so an idle
// refresh cannot race it.
export const INACTIVE_REFRESH_THRESHOLD_MS = 30 * 60_000

// Active account is expired + an anthropic session is running: instead of racing
// ex-machina to refresh, poll auth.json every ACTIVE_WAIT_POLL_MS until ex-machina
// writes a fresh token, giving up after ACTIVE_WAIT_TIMEOUT_MS (then show cached).
// Mirrors autoswitch IDLE_WAIT_TIMEOUT_MS/IDLE_POLL_MS.
export const ACTIVE_WAIT_TIMEOUT_MS = 8_000
export const ACTIVE_WAIT_POLL_MS = 200

// Hard ceiling on any Anthropic network call. Several of these (token refresh, profile
// capture) run while holding the auth lock, so an un-bounded hang would starve every
// account switch / usage collect queued behind it — the timeout bounds that blast radius.
export const NETWORK_TIMEOUT_MS = 15_000

// Token keeper: background keep-alive pass over INACTIVE accounts every tick (refresh
// only those inside INACTIVE_REFRESH_THRESHOLD_MS of expiry), plus an auth.json watcher
// that re-captures the active chain tip on every ex-machina rotation so the tip is never
// lost across an out-of-band switch (`opencode auth login`, restart).
export const KEEPALIVE_TICK_MS = 5 * 60_000
export const WATCH_DEBOUNCE_MS = 500
