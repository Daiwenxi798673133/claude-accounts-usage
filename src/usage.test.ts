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
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const SRC = process.env.CAU_SRC
const OUT = process.env.CAU_OUT
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

const dataHome = mkdtempSync(join(tmpdir(), "cau-run-"))
process.env.XDG_DATA_HOME = dataHome
mkdirSync(join(dataHome, "opencode"), { recursive: true })
const authPath = join(dataHome, "opencode", "auth.json")

// accounts.ts derives ACCOUNTS_PATH from homedir() at module load. os.homedir()
// snapshots HOME at process START and ignores later process.env mutation, so the
// PARENT must pass HOME=<tmp> via the spawn env (done below); here we just use it.
const accountsDir = join(homedir(), ".config", "opencode")
mkdirSync(accountsDir, { recursive: true })
const accountsPath = join(accountsDir, "claude-accounts.json")
const writeAccounts = (obj) => writeFileSync(accountsPath, JSON.stringify(obj))
const readAccounts = () => JSON.parse(readFileSync(accountsPath, "utf8"))

const future = () => Date.now() + 3600000
const past = () => Date.now() - 1000
const bodyPast = () => new Date(Date.now() - 1000).toISOString()
const bodyFuture = () => new Date(Date.now() + 3600000).toISOString()
const oauth = (access, refresh, expires) => ({ type: "oauth", access, refresh, expires })
const writeAuth = (entry) => writeFileSync(authPath, JSON.stringify(entry ? { anthropic: entry } : {}))
const writeAuthRaw = (obj) => writeFileSync(authPath, JSON.stringify(obj))
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

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"
const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile"
let refreshMode = "ok"
let rotated = { access_token: "", refresh_token: "", expires_in: 3600 }
let usageBody = {}
let posts = 0
let usageFetches = 0
let profileFetches = 0
globalThis.fetch = (async (input) => {
  const url = String(input)
  if (url === TOKEN_URL) {
    posts++
    if (refreshMode === "throw-then-fresh") writeAuth(oauth("reread-access", "r-e2", future()))
    if (refreshMode === "429") return { ok: false, status: 429, text: async () => "", headers: { forEach: () => {} } }
    if (refreshMode !== "ok") return { ok: false, status: 500, text: async () => "", headers: { forEach: () => {} } }
    return { ok: true, status: 200, json: async () => rotated }
  }
  if (url === USAGE_ENDPOINT) {
    usageFetches++
    return { ok: true, status: 200, json: async () => usageBody }
  }
  if (url === PROFILE_ENDPOINT) {
    profileFetches++
    return { ok: true, status: 200, json: async () => ({ account: { uuid: "u1", email: "a@x.com" } }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
})

const { acquireActiveAccess, collectAllUsage, autoCapture } = await import(join(SRC, "usage.ts"))
const active = { id: "acc1", label: "A", refresh: "record-refresh" }
const reset = (mode) => { posts = 0; usageFetches = 0; profileFetches = 0; refreshMode = mode; rotated = { access_token: "", refresh_token: "", expires_in: 3600 }; usageBody = {} }
const activeRow = (res) => res.results.find((r) => r.active)
const cap = (row) => ({ error: row?.error, pending: row?.pending, hasUsage: Boolean(row?.usage), usageAsOf: row?.usageAsOf, fiveHour: row?.usage?.five_hour ?? null, sevenDay: row?.usage?.seven_day ?? null })
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

// ---- collectAllUsage scenarios (lastActiveUsage starts empty here) ----
const acctsActive = (rec) => ({ version: 1, activeId: "acc1", accounts: [rec] })

reset("ok"); writeAuth(undefined); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "acc-r", access: "acc-a", expires: future() }))
{ const res = await collectAllUsage({ isSessionRunning: () => false }); results.ch_missing = { ...cap(activeRow(res)), posts } }

reset("ok"); writeAuthRaw({ openai: { type: "oauth", access: "x", refresh: "y", expires: future() } }); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "acc-r", access: "acc-a", expires: future() }))
{ const res = await collectAllUsage({ isSessionRunning: () => false }); results.ch_openai = { ...cap(activeRow(res)), posts } }

reset("ok"); usageBody = { five_hour: { utilization: 42, resets_at: bodyFuture() } }; writeAuth(oauth("auth-access-a", "auth-refresh-a", future())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-refresh", access: "drift-access", expires: past() }))
{ const res = await collectAllUsage({ isSessionRunning: () => true }); const acc = readAccounts().accounts[0]; results.ca = { ...cap(activeRow(res)), posts, accRefresh: acc.refresh, accAccess: acc.access } }

reset("ok"); usageBody = { five_hour: { utilization: 11, resets_at: bodyFuture() } }; writeAuth(oauth("auth-access-e", "auth-refresh-e", future())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "stale-drift-e", access: "stale-drift-e-a", expires: past() }))
{ const res = await collectAllUsage({ isSessionRunning: () => true }); const acc = readAccounts().accounts[0]; results.ce = { posts, accRefresh: acc.refresh, accAccess: acc.access } }

reset("ok"); rotated = { access_token: "inact-new-access", refresh_token: "inact-new-refresh", expires_in: 3600 }; usageBody = { five_hour: { utilization: 10, resets_at: bodyFuture() } }; writeAuth(oauth("auth-access-d", "auth-refresh-d", future())); writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "drift-d", access: "drift-d-a", expires: past() }, { id: "acc2", label: "B", refresh: "inact-old-refresh", access: "inact-old-access", expires: past() }] })
{ const res = await collectAllUsage({ isSessionRunning: () => true }); const accs = readAccounts().accounts; const authNow = readAuth(); results.cd = { posts, activeHasUsage: Boolean(activeRow(res).usage), acc2Refresh: accs.find((a) => a.id === "acc2").refresh, authRefresh: authNow.refresh } }

reset("ok"); rotated = { access_token: "rot-b-access", refresh_token: "rot-b-refresh", expires_in: 3600 }; usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }; writeAuth(oauth("stale-b", "auth-refresh-b", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-b", access: "drift-b-a", expires: past() }))
{ const res = await collectAllUsage({ isSessionRunning: () => false }); const acc = readAccounts().accounts[0]; const authNow = readAuth(); results.cb = { posts, hasUsage: Boolean(activeRow(res).usage), accRefresh: acc.refresh, authRefresh: authNow.refresh, authAccess: authNow.access } }

reset("ok"); usageBody = { five_hour: { utilization: 7, resets_at: bodyFuture() } }; writeAuth(oauth("stale-f", "auth-refresh-f", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-f", access: "drift-f-a", expires: past() }))
setTimeout(() => writeAuth(oauth("exmachina-f-access", "exmachina-f-refresh", future())), 12)
{ const res = await collectAllUsage({ isSessionRunning: () => true }); const acc = readAccounts().accounts[0]; results.cf = { posts, hasUsage: Boolean(activeRow(res).usage), accRefresh: acc.refresh } }

reset("ok"); writeAuth(oauth("stale-g", "auth-refresh-g", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-g", access: "drift-g-a", expires: past() }))
{ const res = await collectAllUsage({ isSessionRunning: () => true }); results.cg = { ...cap(activeRow(res)), posts } }

reset("ok"); writeAuth(oauth("stale-c", "auth-refresh-c", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-c", access: "drift-c-a", expires: past() }))
{ let partialPending; const res = await collectAllUsage({ isSessionRunning: () => true, onPartial: (rows) => { partialPending = rows.find((r) => r.active)?.pending } }); const a = activeRow(res); results.cc = { partialPending, posts, finalResolved: Boolean(a.usage) || Boolean(a.error) } }

reset("ok"); usageBody = { five_hour: { utilization: 3, resets_at: bodyFuture() } }; writeAuth(oauth("noactive-access", "noactive-refresh", future())); writeAccounts({ version: 1, accounts: [{ id: "acc1", label: "A", refresh: "acc1-r", access: "acc1-a", expires: future() }] })
{ const res = await collectAllUsage({ isSessionRunning: () => false }); const a = res.results.find((r) => r.active); results.h_noactive = { activeId: res.activeId ?? null, activeLabel: a?.label, activeHasUsage: Boolean(a?.usage), posts } }

reset("429"); writeAuth(oauth("stale-j", "cooldown-refresh-j", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-j", access: "drift-j-a", expires: past() }))
await collectAllUsage({ isSessionRunning: () => false })
reset("ok"); writeAuth(oauth("stale-j2", "cooldown-refresh-j", past()))
{ const res = await collectAllUsage({ isSessionRunning: () => false }); results.cj = { ...cap(activeRow(res)), posts } }

reset("ok"); rotated = { access_token: "conc-access", refresh_token: "conc-refresh", expires_in: 3600 }; usageBody = { five_hour: { utilization: 1, resets_at: bodyFuture() } }; writeAuth(oauth("stale-i", "conc-refresh-old", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-i", access: "drift-i-a", expires: past() }))
{ await Promise.all([collectAllUsage({ isSessionRunning: () => false }), collectAllUsage({ isSessionRunning: () => false })]); results.ci = { posts } }

reset("ok"); usageBody = { five_hour: { utilization: 90, resets_at: bodyPast() }, seven_day: { utilization: 30, resets_at: bodyFuture() } }; writeAuth(oauth("fresh-k", "auth-refresh-k", future())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-k", access: "drift-k-a", expires: past() }))
await collectAllUsage({ isSessionRunning: () => false })
reset("ok"); writeAuth(oauth("stale-k", "auth-refresh-k2", past()))
{ const res = await collectAllUsage({ isSessionRunning: () => true }); const a = activeRow(res); results.ck = { fiveHour: a.usage?.five_hour ?? null, sevenDay: a.usage?.seven_day ?? null, usageAsOf: a.usageAsOf ?? null, posts } }

// ---- autoCapture scenarios (T3): capture only with a valid token, NEVER refresh ----
reset("ok"); writeAuth(oauth("cap-access", "cap-refresh", future())); writeAccounts({ version: 1, accounts: [] })
{ await autoCapture(); const accts = readAccounts(); const acc = accts.accounts.find((a) => a.id === "u1"); results.cap_fresh = { posts, profileFetches, activeId: accts.activeId, accId: acc?.id, accLabel: acc?.label, accRefresh: acc?.refresh, accAccess: acc?.access } }

reset("ok"); writeAuth(oauth("expired-cap-access", "expired-cap-refresh", past())); writeAccounts({ version: 1, activeId: "pre", accounts: [{ id: "pre", label: "PRE", refresh: "pre-r", access: "pre-a", expires: future() }] })
{ const before = JSON.stringify(readAccounts()); const authBefore = JSON.stringify(readAuth()); await autoCapture(); results.cap_expired = { posts, profileFetches, accountsUnchanged: before === JSON.stringify(readAccounts()), authUnchanged: authBefore === JSON.stringify(readAuth()) } }

reset("ok"); writeAuth(undefined); writeAccounts({ version: 1, accounts: [] })
{ let threw = false; try { await autoCapture() } catch { threw = true } results.cap_noauth = { threw, posts, profileFetches, accountCount: readAccounts().accounts.length } }

writeFileSync(OUT, JSON.stringify(results))
test("acquireActiveAccess scenarios executed", () => {})
`

type Outcome = { state: string; access?: string; refresh?: string; tokenAccess?: string; posts?: number; wRefresh?: string; wAccess?: string }
type Window = { utilization: number; resets_at?: string } | null
type CollectRow = {
  error?: string
  pending?: string
  hasUsage?: boolean
  usageAsOf?: number | null
  fiveHour?: Window
  sevenDay?: Window
  posts?: number
  accRefresh?: string
  accAccess?: string
  authRefresh?: string
  authAccess?: string
  acc2Refresh?: string
  activeHasUsage?: boolean
  activeId?: string | null
  activeLabel?: string
  partialPending?: string
  finalResolved?: boolean
}
type CaptureRow = {
  posts?: number
  profileFetches?: number
  activeId?: string
  accId?: string
  accLabel?: string
  accRefresh?: string
  accAccess?: string
  accountsUnchanged?: boolean
  authUnchanged?: boolean
  threw?: boolean
  accountCount?: number
}
type Results = {
  a: Outcome; b: Outcome; c: Outcome; d: Outcome; e: Outcome; f: Outcome; g: Outcome
  ch_missing: CollectRow; ch_openai: CollectRow; ca: CollectRow; ce: CollectRow; cd: CollectRow
  cb: CollectRow; cf: CollectRow; cg: CollectRow; cc: CollectRow; h_noactive: CollectRow
  cj: CollectRow; ci: CollectRow; ck: CollectRow
  cap_fresh: CaptureRow; cap_expired: CaptureRow; cap_noauth: CaptureRow
}

const runnerDir = mkdtempSync(join(tmpdir(), "cau-parent-"))
const runnerPath = join(runnerDir, "runner.test.ts")
const outPath = join(runnerDir, "results.json")
writeFileSync(runnerPath, runnerSource)

const childHome = mkdtempSync(join(tmpdir(), "cau-home-"))
const proc = Bun.spawnSync(["bun", "test", runnerPath], {
  env: { ...process.env, CAU_SRC: import.meta.dir, CAU_OUT: outPath, HOME: childHome },
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

test("collectAllUsage (a) active FRESH → 0 POSTs, real-time usage + accounts.json reverse-synced to auth token", () => {
  expect(r.ca.posts).toBe(0)
  expect(r.ca.hasUsage).toBe(true)
  expect(r.ca.accRefresh).toBe("auth-refresh-a")
  expect(r.ca.accAccess).toBe("auth-access-a")
})

test("collectAllUsage (b) active EXPIRED + idle → exactly 1 POST + auth.json written + accounts.json reverse-synced to rotated", () => {
  expect(r.cb.posts).toBe(1)
  expect(r.cb.hasUsage).toBe(true)
  expect(r.cb.authRefresh).toBe("rot-b-refresh")
  expect(r.cb.authAccess).toBe("rot-b-access")
  expect(r.cb.accRefresh).toBe("rot-b-refresh")
})

test("collectAllUsage (c) active EXPIRED + running → onPartial fires pending=waiting-refresh, 0 POSTs, then resolves", () => {
  expect(r.cc.partialPending).toBe("waiting-refresh")
  expect(r.cc.posts).toBe(0)
  expect(r.cc.finalResolved).toBe(true)
})

test("collectAllUsage (d) inactive stale account refreshes as before — 1 POST, its record updated, auth.json untouched", () => {
  expect(r.cd.posts).toBe(1)
  expect(r.cd.activeHasUsage).toBe(true)
  expect(r.cd.acc2Refresh).toBe("inact-new-refresh")
  expect(r.cd.authRefresh).toBe("auth-refresh-d")
})

test("collectAllUsage (e) drift proof — FRESH branch, accounts.json active record after run equals auth.json token, 0 POSTs", () => {
  expect(r.ce.posts).toBe(0)
  expect(r.ce.accRefresh).toBe("auth-refresh-e")
  expect(r.ce.accAccess).toBe("auth-access-e")
})

test("collectAllUsage (f) RUNNING poll success — token flips fresh mid-poll → fetch uses ex-machina token, 0 POSTs", () => {
  expect(r.cf.posts).toBe(0)
  expect(r.cf.hasUsage).toBe(true)
  expect(r.cf.accRefresh).toBe("exmachina-f-refresh")
})

test("collectAllUsage (g) RUNNING timeout → cached row + usageAsOf, 0 POSTs", () => {
  expect(r.cg.posts).toBe(0)
  expect(r.cg.hasUsage).toBe(true)
  expect(typeof r.cg.usageAsOf).toBe("number")
})

test("collectAllUsage (h) activeId undefined + auth FRESH → synthesized active row, 0 POSTs for auth-held account", () => {
  expect(r.h_noactive.activeId).toBe(null)
  expect(r.h_noactive.activeLabel).toBe("当前账号")
  expect(r.h_noactive.activeHasUsage).toBe(true)
  expect(r.h_noactive.posts).toBe(0)
})

test("collectAllUsage (h) auth.json missing → active row '未登录', 0 POSTs", () => {
  expect(r.ch_missing.error).toBe("未登录")
  expect(r.ch_missing.posts).toBe(0)
})

test("collectAllUsage (h) openai-only auth.json → no anthropic token → '未登录', 0 POSTs", () => {
  expect(r.ch_openai.error).toBe("未登录")
  expect(r.ch_openai.posts).toBe(0)
})

test("collectAllUsage (i) concurrent modal + background overlap → exactly ONE TOKEN_URL POST", () => {
  expect(r.ci.posts).toBe(1)
})

test("collectAllUsage (j) IDLE + refresh429Cooldown active → skip refresh, cached shown, 0 POSTs", () => {
  expect(r.cj.posts).toBe(0)
  expect(r.cj.hasUsage).toBe(true)
})

test("collectAllUsage (k) cached window past its resets_at is pruned (not rendered as current)", () => {
  expect(r.ck.fiveHour).toBe(null)
  expect(r.ck.sevenDay).not.toBe(null)
  expect(typeof r.ck.usageAsOf).toBe("number")
  expect(r.ck.posts).toBe(0)
})

test("autoCapture (a) auth FRESH → fetchProfile + upsertAccount store token AS-IS, 0 POSTs to TOKEN_URL", () => {
  expect(r.cap_fresh.posts).toBe(0)
  expect(r.cap_fresh.profileFetches).toBe(1)
  expect(r.cap_fresh.accId).toBe("u1")
  expect(r.cap_fresh.accLabel).toBe("a@x.com")
  expect(r.cap_fresh.accRefresh).toBe("cap-refresh")
  expect(r.cap_fresh.accAccess).toBe("cap-access")
  expect(r.cap_fresh.activeId).toBe("u1")
})

test("autoCapture (b) auth EXPIRED → 0 POSTs, no profile fetch, no upsert, auth.json untouched (no writeAuthAnthropic)", () => {
  expect(r.cap_expired.posts).toBe(0)
  expect(r.cap_expired.profileFetches).toBe(0)
  expect(r.cap_expired.accountsUnchanged).toBe(true)
  expect(r.cap_expired.authUnchanged).toBe(true)
})

test("autoCapture (malformed) auth.json missing → early return, no crash, nothing written", () => {
  expect(r.cap_noauth.threw).toBe(false)
  expect(r.cap_noauth.posts).toBe(0)
  expect(r.cap_noauth.profileFetches).toBe(0)
  expect(r.cap_noauth.accountCount).toBe(0)
})

test("autoCapture (c) body calls only lock-free fns — no refreshToken, no writeAuthAnthropic, single withAuthLock (no nesting)", () => {
  const src = readFileSync(join(import.meta.dir, "usage.ts"), "utf8")
  const start = src.indexOf("export async function autoCapture")
  const raw = src.slice(start, src.indexOf("\nasync function ensureFresh", start))
  const code = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
  expect(code).not.toContain("refreshToken")
  expect(code).not.toContain("writeAuthAnthropic")
  expect((code.match(/withAuthLock/g) ?? []).length).toBe(1)
})
