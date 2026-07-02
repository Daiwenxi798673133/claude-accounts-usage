import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// WHY A SUBPROCESS: autoswitch.test.ts runs earlier in the same `bun test` process and
// registers process-global mock.module("./usage.ts", ...) (a stub lacking
// acquireActiveAccess) AND mock.module("./accounts.ts", ...) (a PARTIAL stub lacking
// withAuthLock). Bun's mock.module is process-global, is cached the moment autoswitch
// imports its graph, and cannot be evicted/undone for a later file — so importing the
// real usage.ts here is impossible in-process (verified: plain import yields the stub;
// ./usage.ts?real link-fails on the leaked partial accounts). We therefore run the real
// acquireActiveAccess scenarios in a FRESH child `bun test` process (no leak), where
// mock.module works cleanly and usage.ts links the REAL accounts.ts. The child drives
// real accounts.ts via a temp-dir auth.json seam and stubs fetch (counting TOKEN_URL
// POSTs), writes a results JSON, and the parent tests below assert on it.
const runnerSource = `
import { test, mock } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SRC = process.env.CAU_SRC
const OUT = process.env.CAU_OUT
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

const dataHome = mkdtempSync(join(tmpdir(), "cau-run-"))
process.env.XDG_DATA_HOME = dataHome
mkdirSync(join(dataHome, "opencode"), { recursive: true })
const authPath = join(dataHome, "opencode", "auth.json")

const future = () => Date.now() + 3600000
const past = () => Date.now() - 1000
const oauth = (access, refresh, expires) => ({ type: "oauth", access, refresh, expires })
const writeAuth = (entry) => writeFileSync(authPath, JSON.stringify(entry ? { anthropic: entry } : {}))
const readAuth = () => JSON.parse(readFileSync(authPath, "utf8")).anthropic

mock.module(join(SRC, "constants.ts"), () => ({
  CLIENT_ID: "test-client-id",
  TOKEN_URL,
  USAGE_ENDPOINT: "https://api.anthropic.com/api/oauth/usage",
  PROFILE_ENDPOINT: "https://api.anthropic.com/api/oauth/profile",
  OAUTH_BETA: "oauth-2025-04-20",
  TOKEN_EXPIRY_BUFFER_MS: 60000,
  INACTIVE_REFRESH_THRESHOLD_MS: 1800000,
  ACTIVE_WAIT_TIMEOUT_MS: 80,
  ACTIVE_WAIT_POLL_MS: 5,
}))

let refreshMode = "ok"
let rotated = { access_token: "", refresh_token: "", expires_in: 3600 }
let posts = 0
globalThis.fetch = (async (input) => {
  const url = String(input)
  if (url === TOKEN_URL) {
    posts++
    if (refreshMode === "throw-then-fresh") writeAuth(oauth("reread-access", "r-e2", future()))
    if (refreshMode !== "ok") return { ok: false, status: 500, text: async () => "", headers: { forEach: () => {} } }
    return { ok: true, status: 200, json: async () => rotated }
  }
  return { ok: true, status: 200, json: async () => ({}) }
})

const { acquireActiveAccess } = await import(join(SRC, "usage.ts"))
const active = { id: "acc1", label: "A", refresh: "record-refresh" }
const reset = (mode) => { posts = 0; refreshMode = mode; rotated = { access_token: "", refresh_token: "", expires_in: 3600 } }
const results = {}

reset("ok"); writeAuth(oauth("fresh-access", "r-a", future()))
{ const o = await acquireActiveAccess(active, () => true); results.a = { state: o.state, access: o.access, refresh: o.authToken?.refresh, tokenAccess: o.authToken?.access, posts } }

reset("ok"); writeAuth(oauth("stale-access", "r-b", past()))
setTimeout(() => writeAuth(oauth("waited-access", "r-b", future())), 12)
{ const o = await acquireActiveAccess(active, () => true); results.b = { state: o.state, access: o.access, posts } }

reset("ok"); writeAuth(oauth("stale-access", "r-c", past()))
{ const o = await acquireActiveAccess(active, () => true); results.c = { state: o.state, refresh: o.authToken?.refresh, posts } }

reset("ok"); rotated = { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }; writeAuth(oauth("stale-access", "r-d", past()))
{ const o = await acquireActiveAccess(active, () => false); const w = readAuth(); results.d = { state: o.state, access: o.access, posts, wRefresh: w?.refresh, wAccess: w?.access } }

reset("throw-then-fresh"); writeAuth(oauth("stale-access", "r-e", past()))
{ const o = await acquireActiveAccess(active, () => false); results.e = { state: o.state, access: o.access, refresh: o.authToken?.refresh } }

reset("throw"); writeAuth(oauth("stale-access", "r-f", past()))
{ const o = await acquireActiveAccess(active, () => false); results.f = { state: o.state, access: o.access, refresh: o.authToken?.refresh } }

reset("ok"); writeAuth(undefined)
{ const o = await acquireActiveAccess(active, () => false); results.g = { state: o.state, posts } }

writeFileSync(OUT, JSON.stringify(results))
test("acquireActiveAccess scenarios executed", () => {})
`

type Outcome = { state: string; access?: string; refresh?: string; tokenAccess?: string; posts?: number; wRefresh?: string; wAccess?: string }
type Results = { a: Outcome; b: Outcome; c: Outcome; d: Outcome; e: Outcome; f: Outcome; g: Outcome }

const runnerDir = mkdtempSync(join(tmpdir(), "cau-parent-"))
const runnerPath = join(runnerDir, "runner.test.ts")
const outPath = join(runnerDir, "results.json")
writeFileSync(runnerPath, runnerSource)

const proc = Bun.spawnSync(["bun", "test", runnerPath], {
  env: { ...process.env, CAU_SRC: import.meta.dir, CAU_OUT: outPath },
  stdout: "pipe",
  stderr: "pipe",
})
if (proc.exitCode !== 0) {
  throw new Error(`acquireActiveAccess runner failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}\n${proc.stdout.toString()}`)
}
const r = JSON.parse(readFileSync(outPath, "utf8")) as Results

test("acquireActiveAccess (a) fresh auth → state fresh, 0 POSTs to TOKEN_URL", () => {
  expect(r.a.state).toBe("fresh")
  expect(r.a.access).toBe("fresh-access")
  expect(r.a.refresh).toBe("r-a")
  expect(r.a.tokenAccess).toBe("fresh-access")
  expect(r.a.posts).toBe(0)
})

test("acquireActiveAccess (b) expired + running, freshens during poll → waited, 0 POSTs", () => {
  expect(r.b.state).toBe("waited")
  expect(r.b.access).toBe("waited-access")
  expect(r.b.posts).toBe(0)
})

test("acquireActiveAccess (c) expired + running never freshens → waiting-timeout (bounded), 0 POSTs", () => {
  expect(r.c.state).toBe("waiting-timeout")
  expect(r.c.refresh).toBe("r-c")
  expect(r.c.posts).toBe(0)
})

test("acquireActiveAccess (d) expired + idle → exactly 1 POST + writes rotated token, self-refreshed", () => {
  expect(r.d.state).toBe("self-refreshed")
  expect(r.d.access).toBe("rotated-access")
  expect(r.d.posts).toBe(1)
  expect(r.d.wRefresh).toBe("rotated-refresh")
  expect(r.d.wAccess).toBe("rotated-access")
})

test("acquireActiveAccess (e) expired + idle, refresh throws + re-read fresh → self-refreshed uses re-read token (H2)", () => {
  expect(r.e.state).toBe("self-refreshed")
  expect(r.e.access).toBe("reread-access")
  expect(r.e.refresh).toBe("r-e2")
})

test("acquireActiveAccess (f) expired + idle, refresh throws + re-read still stale → unavailable", () => {
  expect(r.f.state).toBe("unavailable")
  expect(r.f.access).toBeUndefined()
  expect(r.f.refresh).toBe("r-f")
})

test("acquireActiveAccess (g) auth.json missing + idle → unavailable, no crash, 0 POSTs", () => {
  expect(r.g.state).toBe("unavailable")
  expect(r.g.posts).toBe(0)
})
