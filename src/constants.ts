// Shared Anthropic OAuth client_id used by the official Claude Pro/Max flow
// (same value as @ex-machina/opencode-anthropic-auth), so refresh tokens stored
// by that plugin are accepted by the refresh endpoint below.
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

export const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"

export const OAUTH_BETA = "oauth-2025-04-20"

// Refresh slightly before real expiry so neither ex-machina nor the usage call
// receives an already-stale access token.
export const TOKEN_EXPIRY_BUFFER_MS = 60_000
