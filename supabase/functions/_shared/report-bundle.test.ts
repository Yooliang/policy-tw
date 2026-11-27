/**
 * report 讀取端單一 RPC（report_context_bundle）的守門測試（Edge Function 內部 REST 瘦身 第 1 期 PR-2）。
 *
 * PGlite 真的建表、執行真的 migration；真的載入 report 入口、用真的 Request 打進去，入口檔發出去的 PostgREST 請求
 * 翻成真的 SQL（report-pglite.ts 的 pgrstRouter），寫入也真的寫進 PGlite。
 * 「舊路徑」＝RPC 回不存在、handler 退回逐項查詢；「新路徑」＝單一 RPC。兩條路徑各用一份全新、相同的資料庫跑同一個請求，
 * 比對：回應的整份 JSON（逐 byte）、狀態碼、落庫結果（票、貢獻）。
 * 另外守：額度、不能驗自己、裁決的原貢獻、派工綁定、重複備註、改票、任務型別閘門、同 IP 排隊中等各條早退路徑；
 * RPC 失敗退回舊路徑；權限；一次請求打幾次 REST（verify 新 ≤ 6、contribute 早退路徑新 ≤ 3）。
 * 額度與去重「先數再寫、沒有原子保留」的語意不變：測試只驗讀到的數字與判斷，不碰寫入的先後。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { loadEntry, type RestCall } from "./entry-harness.ts";
import { ipHashOf, QUOTA_DEFAULTS } from "./contribute-handler.ts";
import { isContributePre, isVerifyPost, isVerifyPre } from "./report-bundle.ts";
import { makeReportDb, pgrstRouter } from "./report-pglite.ts";

const SALT = "test-salt";
const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789", CONTRIBUTION_IP_SALT: SALT } as Record<string, string>;
const N1 = "10.1.1.5";
const netHash = (ip: string) => ipHashOf(new Request("https://x/", { headers: { "x-forwarded-for": ip } }), SALT);
const ID = (n: number) => `a1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const POL = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";
const TASK_Q = "cccccccc-0000-4ccc-8ccc-000000000001"; // 公民提問（手動任務）
const TASK_M = "cccccccc-0000-4ccc-8ccc-000000000002"; // 多人任務
const TASK_P = "cccccccc-0000-4ccc-8ccc-000000000003"; // 補人物資料（單一答案型手動任務）

const BASE_SEED = `
INSERT INTO politicians VALUES ('${POL}', '王小明');
INSERT INTO contributions (id, contribution_type, payload, source_urls, agent_name, status, created_at, contributor_ip_hash, actor_id, agree_count, score) VALUES
 ('${ID(1)}', 'policy', '{"politician_id":"${POL}","title":"長者健保全免","category":"社會福利"}', '{https://www.cna.com.tw/a}', 'alice', 'pending', now() - interval '3 days', 'ip-alice', NULL, 0, 0),
 ('${ID(2)}', 'policy', '{"politician_id":"${POL}","title":"夜間托育","category":"社會福利"}', '{https://www.cna.com.tw/b}', 'alice', 'pending', now() - interval '3 days', 'ip-alice', NULL, 1, 1),
 ('${ID(3)}', 'adjudication', '{"contribution_id":"${ID(1)}","verdict":"uphold","reason":"公報確實寫 2024-04-02"}', '{https://db.cec.gov.tw/c}', 'dave', 'pending', now() - interval '2 days', 'ip-dave', NULL, 0, 0),
 ('${ID(4)}', 'policy', '{"politician_id":"${POL}","title":"已上線的政見"}', '{https://www.cna.com.tw/d}', 'alice', 'applied', now() - interval '5 days', 'ip-alice', NULL, 3, 3),
 ('${ID(5)}', 'policy', '{"politician_id":"${POL}","title":"DiTrust 交的政見","category":"社會福利"}', '{https://www.cna.com.tw/e}', 'erin', 'pending', now() - interval '2 days', 'ip-erin', 'ditrust:erin', 0, 0);
-- ID(2) 已有 bob 的一票（備註很長，拿來測「抄別人的備註」）、carol 在別筆有過一票（拿來測「跟自己上一票一字不差」）
INSERT INTO contribution_votes (contribution_id, verdict, note, agent_name, actor_id, verifier_ip_hash, created_at) VALUES
 ('${ID(2)}', 'agree', '逐段核對了這個網頁的第二段與第三段，數字都一致', 'bob', NULL, 'ip-bob', now() - interval '1 hour'),
 ('${ID(4)}', 'agree', '核對過了第四段的日期與金額', 'carol', NULL, 'ip-carol-old', now() - interval '1 day');
INSERT INTO contribution_tasks (id, task_type, status, target, created_at, source) VALUES
 ('${TASK_Q}', 'question', 'open', '{"question_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"}', now(), NULL),
 ('${TASK_M}', 'roster_check', 'open', '{"multi_person":true,"origin":"roster_group","people":[{"key":"某人:101","politician_election_id":101},{"key":"某人:102","politician_election_id":102}]}', now(), NULL),
 ('${TASK_P}', 'profile_gap', 'open', '{"politician_id":"${POL}"}', now(), NULL);
`;

async function freshDb(setup?: (db: PGlite) => Promise<void>): Promise<PGlite> {
  const db = await makeReportDb();
  await db.exec(BASE_SEED);
  if (setup) await setup(db);
  return db;
}

async function dispatch(db: PGlite, contributionId: string, agent: string, ip = N1): Promise<void> {
  await db.query(`INSERT INTO verify_dispatches (contribution_id, ip_hash, agent_name) VALUES ($1, $2, $3)`, [contributionId, await netHash(ip), agent]);
}

interface Outcome { status: number; text: string; calls: RestCall[]; votes: unknown[]; contributions: unknown[]; warns: string[] }

async function run(db: PGlite, mode: "new" | "legacy" | { bundleReply: unknown }, body: Record<string, unknown>, ip = N1): Promise<Outcome> {
  const opts = mode === "new" ? {} : mode === "legacy" ? { legacy: true } : { bundleReply: mode.bundleReply };
  const entry = await loadEntry("../report/index.ts", env, pgrstRouter(db, opts));
  const warns: string[] = [];
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
  console.log = () => {}; // 入口的 dispatch_binding 追查行，不印
  try {
    const res = await entry.call(new Request("https://x/report", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }));
    const text = await res.text();
    const votes = (await db.query(`SELECT contribution_id, verdict, note, agent_name, actor_id, verifier_ip_hash, via, evidence_url, resolved_politician_id FROM contribution_votes ORDER BY id`)).rows;
    const contributions = (await db.query(`SELECT id, status, agent_name, contribution_type, contributor_ip_hash FROM contributions ORDER BY id`)).rows;
    return { status: res.status, text, calls: entry.calls, votes, contributions, warns };
  } finally { console.log = origLog; console.warn = origWarn; entry.restore(); }
}

const verifyBody = (over: Record<string, unknown> = {}) => ({
  kind: "verify", contribution_id: ID(1), verdict: "agree", note: "核對了報導的第二段與第三段，人名與金額都一致", agent_name: "carol", ...over,
});

interface Case {
  name: string;
  body: Record<string, unknown>;
  setup?: (db: PGlite) => Promise<void>;
  ip?: string;
  /** 兩條路徑都一樣的預期狀態碼與（選填）回應裡一定要有的字 */
  status: number;
  has?: string;
  /** 回應裡不得出現的字（用來證明被擋的真的被擋、放行的真的走到下一關） */
  notHas?: string;
}

const VERIFY_CASES: Case[] = [
  { name: "被派到、同意票照常收（落庫的票與回應逐 byte 相同）", body: verifyBody(), setup: (db) => dispatch(db, ID(1), "carol"), status: 201, has: "vote_id" },
  { name: "沒被派（沒有派工綁定）→ 409 not_dispatched", body: verifyBody(), status: 409, has: "not_dispatched" },
  { name: "派工綁定的是別的代號 → 409 not_dispatched", body: verifyBody(), setup: (db) => dispatch(db, ID(1), "someone-else"), status: 409, has: "not_dispatched" },
  { name: "派工紀錄超過 7 天 → 不認", body: verifyBody(), setup: async (db) => { await dispatch(db, ID(1), "carol"); await db.exec(`UPDATE verify_dispatches SET dispatched_at = now() - interval '8 days'`); }, status: 409, has: "not_dispatched" },
  { name: "找不到這筆 → 404", body: verifyBody({ contribution_id: "99999999-9999-4999-8999-999999999999" }), status: 404, has: "not_found" },
  { name: "已上線的不再收 → 409 closed", body: verifyBody({ contribution_id: ID(4) }), setup: (db) => dispatch(db, ID(4), "carol"), status: 409, has: "closed" },
  { name: "不能驗自己 → 403 self_vote", body: verifyBody({ agent_name: "alice" }), setup: (db) => dispatch(db, ID(1), "alice"), status: 403, has: "self_vote" },
  { name: "裁決的驗證：原貢獻的提交者不能投 → 403 self_vote", body: verifyBody({ contribution_id: ID(3), agent_name: "alice" }), setup: (db) => dispatch(db, ID(3), "alice"), status: 403, has: "裁決" },
  { name: "裁決的驗證：別人可以投", body: verifyBody({ contribution_id: ID(3) }), setup: (db) => dispatch(db, ID(3), "carol"), status: 201, has: "vote_id" },
  {
    name: "額度用完 → 429 rate_limited",
    body: verifyBody(), setup: async (db) => {
      await dispatch(db, ID(1), "carol");
      await db.query(`INSERT INTO contribution_votes (contribution_id, verdict, agent_name, verifier_ip_hash, created_at) SELECT $1, 'agree', 'x' || g, $2, now() FROM generate_series(1, $3) g`,
        [ID(2), await netHash(N1), QUOTA_DEFAULTS.per_ip_verify]);
    },
    status: 429, has: "rate_limited",
  },
  { name: "同一個投票人已投過 → 409 already_voted", body: verifyBody({ contribution_id: ID(2), agent_name: "bob" }), setup: (db) => dispatch(db, ID(2), "bob", "10.9.9.9"), ip: "10.9.9.9", status: 409, has: "already_voted" },
  {
    name: "改票（revise:true）：覆寫自己那一張，回應帶 revised",
    body: verifyBody({ contribution_id: ID(2), agent_name: "bob", revise: true, verdict: "disagree", evidence_url: "https://other.example.org/x", note: "公報寫的是另一個數字" }),
    setup: async (db) => { await dispatch(db, ID(2), "bob", "10.9.9.9"); await db.query(`UPDATE contribution_votes SET verifier_ip_hash = $1 WHERE agent_name = 'bob'`, [await netHash("10.9.9.9")]); },
    ip: "10.9.9.9", status: 201, has: "revised",
  },
  { name: "改票但不是自己來源投的 → 403 not_your_vote", body: verifyBody({ contribution_id: ID(2), agent_name: "bob", revise: true }), setup: (db) => dispatch(db, ID(2), "bob", "10.9.9.9"), ip: "10.9.9.9", status: 403, has: "not_your_vote" },
  { name: "備註跟自己上一票一字不差 → 400 note_repeated", body: verifyBody({ note: "核對過了第四段的日期與金額" }), setup: (db) => dispatch(db, ID(1), "carol"), status: 400, has: "note_repeated" },
  { name: "備註抄別人那一張、又沒附來源 → 400 note_copied", body: verifyBody({ contribution_id: ID(2), note: "逐段核對了這個網頁的第二段與第三段，數字都一致" }), setup: (db) => dispatch(db, ID(2), "carol"), status: 400, has: "note_copied" },
  { name: "不同意票（反對、附來源）：不查自己上一票也照樣一致", body: verifyBody({ verdict: "disagree", evidence_url: "https://other.example.org/y", note: "來源寫的是另一個數字" }), setup: (db) => dispatch(db, ID(1), "carol"), status: 201, has: "vote_id" },
  { name: "投 unsure（盲反對改記）", body: verifyBody({ verdict: "disagree", evidence_url: "https://www.cna.com.tw/a", note: "網頁打不開，確認不了" }), setup: (db) => dispatch(db, ID(1), "carol"), status: 201, has: "unsure" },
];

for (const c of VERIFY_CASES) {
  Deno.test(`verify 新舊路徑逐 byte 相同：${c.name}`, async () => {
    const legacy = await run(await freshDb(c.setup), "legacy", c.body, c.ip);
    const viaRpc = await run(await freshDb(c.setup), "new", c.body, c.ip);
    assertEquals(viaRpc.status, c.status, viaRpc.text);
    assertEquals(viaRpc.text, legacy.text);
    assertEquals(viaRpc.votes, legacy.votes, "落庫的票相同");
    assertEquals(viaRpc.contributions, legacy.contributions);
    if (c.has) assert(viaRpc.text.includes(c.has), `回應要含「${c.has}」：${viaRpc.text.slice(0, 200)}`);
    assert(viaRpc.calls.some((x) => x.target === "rpc/report_context_bundle"), "新路徑有走單一 RPC");
    assert(legacy.calls.some((x) => x.target === "contributions" || x.target === "contribution_votes"), "舊路徑照原本的逐項查詢");
    assert(!/contributor_ip_hash|ip-alice/.test(viaRpc.text), "回應不帶任何 ip_hash");
  });
}

Deno.test("verify 計數守門：典型成功路徑新路徑的 REST 次數 ≤ 6，且比舊路徑少 4 次以上；早退路徑只打 1～2 次", async () => {
  const ok = VERIFY_CASES[0];
  const a = await run(await freshDb(ok.setup), "new", ok.body);
  const b = await run(await freshDb(ok.setup), "legacy", ok.body);
  const names = (r: Outcome) => r.calls.map((x) => (x.method === "HEAD" ? "HEAD " : "") + x.target).join(",");
  console.log(`[REST 次數] report verify（同意票成功）：舊路徑 ${b.calls.length} 次（${names(b)}）\n  新路徑 ${a.calls.length} 次（${names(a)}）`);
  assert(a.calls.length <= 6, `新路徑 ${a.calls.length} 次：${names(a)}`);
  assert(b.calls.length - a.calls.length >= 4, `舊 ${b.calls.length}、新 ${a.calls.length}，沒有少到 4 次`);
  for (const target of ["rpc/report_context_bundle"]) assertEquals(a.calls.filter((x) => x.target === target).length, 2, "投票前一次、投票後一次");
  const e = VERIFY_CASES[1]; // 沒被派：早退
  const early = await run(await freshDb(e.setup), "new", e.body);
  assert(early.calls.length <= 2, `早退路徑 ${early.calls.length} 次：${names(early)}`);
  const sameNote = VERIFY_CASES.find((x) => x.name.includes("note_repeated"))!;
  const rep = await run(await freshDb(sameNote.setup), "new", sameNote.body);
  assertEquals(rep.calls.filter((x) => x.target === "contribution_votes" && x.method === "GET").length, 0, "自己上一票的備註跟著 RPC 一起回，不再另查");
});

Deno.test("verify：RPC 失敗就退回舊路徑（函式不存在、形狀不對、回 null、缺欄位），輸出與落庫相同並 console.warn", async () => {
  const c = VERIFY_CASES[0];
  const legacy = await run(await freshDb(c.setup), "legacy", c.body);
  const replies: Array<[string, unknown]> = [["形狀不對（空陣列）", []], ["缺欄位", { used: 0 }], ["回 null", null], ["函式不存在", undefined]];
  for (const [name, reply] of replies) {
    const r = await run(await freshDb(c.setup), { bundleReply: reply }, c.body);
    assertEquals(r.text, legacy.text, name);
    assertEquals(r.votes, legacy.votes, name);
    assert(r.warns.some((w) => w.includes("report_context_bundle")), `${name}：有 warn`);
    assert(r.calls.length >= 9, `${name}：確實走了舊路徑（${r.calls.length} 次）`);
  }
});

// ---- contribute 的讀取端（額度、任務型別閘門、同 IP 排隊中）----

const noChange = (taskId: string, over: Record<string, unknown> = {}) => ({
  kind: "contribute", contribution_type: "no_change", agent_name: "dave", agent_tool: "pi/deepseek-v4-flash", task_id: taskId,
  payload: { task_id: taskId, outcome: "confirmed", checked_urls: ["https://www.cna.com.tw/a"], finding: "逐項核對了網頁，內容與資料庫一致，沒有異動" },
  source_urls: ["https://www.cna.com.tw/a"], ...over,
});

const CONTRIBUTE_CASES: Case[] = [
  { name: "額度用完 → 429（先數再寫，語意不變）", body: noChange(TASK_P), setup: async (db) => {
    await db.query(`INSERT INTO contributions (id, contribution_type, payload, agent_name, status, created_at, contributor_ip_hash)
      SELECT md5(g::text)::uuid, 'no_change', '{}'::jsonb, 'x', 'applied', now(), $1 FROM generate_series(1, $2::int) g`, [await netHash(N1), QUOTA_DEFAULTS.per_ip_submit]);
  }, status: 429, has: "rate_limited" },
  { name: "提問任務只收 question_answer → 400 question_needs_answer", body: noChange(TASK_Q), status: 400, has: "question_needs_answer" },
  { name: "多人任務沒帶 person_key → 400 person_key_required", body: noChange(TASK_M), status: 400, has: "person_key_required" },
  { name: "多人任務帶了不在名單上的 person_key → 400 person_key_unknown", body: noChange(TASK_M, { payload: { task_id: TASK_M, person_key: "不存在:1", outcome: "confirmed", checked_urls: ["https://www.cna.com.tw/a"], finding: "逐項核對了網頁，內容與資料庫一致，沒有異動" } }), status: 400, has: "person_key_unknown" },
  { name: "多人任務帶對 person_key 與 politician_election_id → 讀取端放行（之後走原本的流程）", body: noChange(TASK_M, { payload: { task_id: TASK_M, person_key: "某人:101", politician_election_id: 101, outcome: "confirmed", checked_urls: ["https://www.cna.com.tw/a"], finding: "逐項核對了網頁，內容與資料庫一致，沒有異動" } }), status: -1 },
  {
    name: "單一答案型任務：同 IP 已有一份在排隊 → 擋第二份",
    body: noChange(TASK_P),
    setup: async (db) => { await db.query(`INSERT INTO contributions (id, contribution_type, payload, agent_name, status, created_at, contributor_ip_hash, task_id) VALUES ('b1000000-0000-4000-8000-000000000001', 'no_change', '{}', 'x', 'pending', now(), $1, $2)`, [await netHash(N1), TASK_P]); },
    status: -1, notHas: "internal_error",
  },
  {
    name: "單一答案型任務：同 IP 的那份已經退件 → 不算在排隊（放行到下一關）",
    body: noChange(TASK_P),
    setup: async (db) => { await db.query(`INSERT INTO contributions (id, contribution_type, payload, agent_name, status, created_at, contributor_ip_hash, task_id) VALUES ('b1000000-0000-4000-8000-000000000002', 'no_change', '{}', 'x', 'rejected', now(), $1, $2)`, [await netHash(N1), TASK_P]); },
    status: -1, has: "internal_error",
  },
  { name: "自動缺口的單一答案型任務（auto:profile_gap）：同 IP 排隊中", body: noChange(`auto:profile_gap:${POL}`), setup: async (db) => { await db.query(`INSERT INTO contributions (id, contribution_type, payload, agent_name, status, created_at, contributor_ip_hash, task_id) VALUES ('b1000000-0000-4000-8000-000000000003', 'no_change', '{}', 'x', 'verified', now(), $1, $2)`, [await netHash(N1), `auto:profile_gap:${POL}`]); }, status: -1, notHas: "internal_error" },
  {
    name: "一般 policy 交件一路走到寫入（額度數字、任務型別、排隊中都從 RPC 讀；落庫的貢獻逐欄相同）",
    body: { kind: "contribute", contribution_type: "policy", agent_name: "dave", agent_tool: "pi/deepseek-v4-flash", source_urls: ["https://www.cna.com.tw/a", "https://www.ly.gov.tw/Pages/Detail.aspx?nodeid=33"],
      payload: { politician_id: POL, title: "長者交通補助加碼", category: "社會福利", description: "每月補助乘車金額由三百元提高到六百元，預計明年一月起實施" } },
    status: 201, has: '"success":true',
  },
  { name: "別的 IP 排隊中的不算", body: noChange(TASK_P), setup: async (db) => { await db.query(`INSERT INTO contributions (id, contribution_type, payload, agent_name, status, created_at, contributor_ip_hash, task_id) VALUES ('b1000000-0000-4000-8000-000000000004', 'no_change', '{}', 'x', 'pending', now(), 'ip-other', $1)`, [TASK_P]); }, status: -1, has: "internal_error" },
];

for (const c of CONTRIBUTE_CASES) {
  Deno.test(`contribute 新舊路徑逐 byte 相同：${c.name}`, async () => {
    const legacy = await run(await freshDb(c.setup), "legacy", c.body, c.ip);
    const viaRpc = await run(await freshDb(c.setup), "new", c.body, c.ip);
    if (c.status >= 0) assertEquals(viaRpc.status, c.status, viaRpc.text);
    assertEquals(viaRpc.status, legacy.status);
    assertEquals(viaRpc.text, legacy.text);
    assertEquals(viaRpc.contributions, legacy.contributions, "落庫的貢獻相同");
    if (c.has) assert(viaRpc.text.includes(c.has), `回應要含「${c.has}」：${viaRpc.text.slice(0, 200)}`);
    if (c.notHas) assert(!viaRpc.text.includes(c.notHas), `回應不該含「${c.notHas}」：${viaRpc.text.slice(0, 200)}`);
    assert(viaRpc.calls.some((x) => x.target === "rpc/report_context_bundle"), "新路徑有走單一 RPC");
  });
}

Deno.test("contribute 計數守門：交件前的讀取（額度、任務型別、多人任務、排隊中）新路徑只打 1 次", async () => {
  const c = CONTRIBUTE_CASES.find((x) => x.name.includes("多人任務沒帶"))!;
  const a = await run(await freshDb(c.setup), "new", c.body);
  const b = await run(await freshDb(c.setup), "legacy", c.body);
  const names = (r: Outcome) => r.calls.map((x) => (x.method === "HEAD" ? "HEAD " : "") + x.target).join(",");
  console.log(`[REST 次數] report contribute（多人任務早退）：舊路徑 ${b.calls.length} 次（${names(b)}）\n  新路徑 ${a.calls.length} 次（${names(a)}）`);
  assert(a.calls.length <= 3, `新路徑 ${a.calls.length} 次：${names(a)}`);
  assert(b.calls.length - a.calls.length >= 2, `舊 ${b.calls.length}、新 ${a.calls.length}`);
  const pass = CONTRIBUTE_CASES.find((x) => x.name.includes("別的 IP 排隊中"))!;
  const p1 = await run(await freshDb(pass.setup), "new", pass.body);
  const p2 = await run(await freshDb(pass.setup), "legacy", pass.body);
  const reads = (r: Outcome) => r.calls.filter((x) => (x.method === "GET" || x.method === "HEAD") && ["contributions", "contribution_tasks"].includes(x.target)).length;
  console.log(`[REST 次數] report contribute（放行到去重前）：額度／任務／排隊中的讀取 舊 ${reads(p2)} 次，新 ${reads(p1)} 次`);
  assert(reads(p1) < reads(p2));
});

Deno.test("contribute：RPC 失敗就退回舊路徑，輸出與落庫相同並 console.warn", async () => {
  const c = CONTRIBUTE_CASES.find((x) => x.name.includes("question_needs_answer"))!;
  const legacy = await run(await freshDb(c.setup), "legacy", c.body);
  for (const [name, reply] of [["形狀不對", []], ["回 null", null], ["缺欄位", { used: 1 }]] as Array<[string, unknown]>) {
    const r = await run(await freshDb(c.setup), { bundleReply: reply }, c.body);
    assertEquals(r.text, legacy.text, name);
    assert(r.warns.some((w) => w.includes("report_context_bundle")), `${name}：有 warn`);
  }
});

// ---- RPC 本身：形狀、邊界、權限 ----

Deno.test("report_context_bundle：三種 kind 的回傳形狀、不支援的 kind 與壞參數直接報錯", async () => {
  const db = await freshDb(async (d) => { await dispatch(d, ID(1), "carol"); });
  const q = async (kind: string, params: unknown) => (await db.query<{ r: unknown }>(`SELECT report_context_bundle($1, $2::jsonb) AS r`, [kind, JSON.stringify(params)])).rows[0].r;
  const ws = new Date(Date.now() - 2 * 3600_000).toISOString();
  const pre = await q("verify_pre", { contribution_id: ID(2), quota_column: "verifier_ip_hash", quota_value: "ip-bob", window_start: ws, binding: null, prev: { column: "agent_name", value: "carol" } });
  assert(isVerifyPre(pre));
  assertEquals(pre.used, 1);
  assertEquals((pre.contribution as { agent_name: string }).agent_name, "alice");
  assertEquals(pre.existing.length, 1);
  assertEquals(pre.dispatched, []);
  assertEquals(pre.prev, { note: "核對過了第四段的日期與金額" });
  const bound = await q("verify_pre", { contribution_id: ID(1), quota_column: "actor_id", quota_value: "ditrust:x", window_start: ws, binding: { ip_hash: await netHash(N1), since: new Date(Date.now() - 7 * 86400_000).toISOString() }, prev: null });
  assert(isVerifyPre(bound));
  assertEquals(bound.dispatched.length, 1);
  assertEquals(bound.prev, null);
  const adj = await q("verify_pre", { contribution_id: ID(3), quota_column: "actor_id", quota_value: "x", window_start: ws, binding: null, prev: null });
  assert(isVerifyPre(adj));
  assertEquals((adj.original as { agent_name: string }).agent_name, "alice", "裁決帶出原貢獻的提交者");
  const none = await q("verify_pre", { contribution_id: "99999999-9999-4999-8999-999999999999", quota_column: "actor_id", quota_value: "x", window_start: ws, binding: null, prev: null });
  assert(isVerifyPre(none));
  assertEquals(none.contribution, null);
  const post = await q("verify_post", { contribution_id: ID(2) });
  assert(isVerifyPost(post));
  assertEquals(post.effective, 4, "目標分數（測試替身：3＋同意票數）");
  assertEquals((post.after as { status: string }).status, "pending");
  assertEquals(await q("verify_post", { contribution_id: "99999999-9999-4999-8999-999999999999" }), { after: null, effective: 3 }, "查無這筆：after 是 null");
  const cpre = await q("contribute_pre", { quota_column: "contributor_ip_hash", quota_value: "ip-alice", window_start: new Date(Date.now() - 10 * 86400_000).toISOString(), task_ids: [TASK_Q, TASK_M, "not-a-uuid"], inflight_task_ids: ["auto:x:1"], ip_hash: "ip-alice" });
  assert(isContributePre(cpre));
  assertEquals(cpre.used, 3, "ip-alice 的三筆");
  assertEquals(cpre.tasks.map((t) => [t.task_type, t.multi_person]).sort(), [["question", false], ["roster_check", true]]);
  assertEquals(cpre.tasks.find((t) => t.id === TASK_Q)!.target, null, "不是多人任務就不帶 target");
  const errOf = async (kind: string, params: unknown) => { try { await q(kind, params); return ""; } catch (e) { return String(e); } };
  assert((await errOf("nope", {})).includes("unsupported kind"));
  assert((await errOf("verify_pre", { contribution_id: ID(1), quota_column: "evil; drop", quota_value: "x", window_start: ws })).includes("bad quota_column"));
  assert((await errOf("contribute_pre", { quota_column: "contribution_id", quota_value: "x", window_start: ws })).includes("bad quota_column"));
});

Deno.test("hasExistingPick：吃 RPC 帶回的票（verdict、resolved_politician_id）與自己去查的結果相同，含排除自己那張與只看前 200 張", async () => {
  const { hasExistingPick } = await import("./identity-pick-gate.ts");
  const db = await freshDb(async (d) => {
    await d.exec(`INSERT INTO contribution_votes (contribution_id, verdict, agent_name, resolved_politician_id, created_at) VALUES
      ('${ID(2)}', 'agree', 'pick1', '${POL}', now()), ('${ID(2)}', 'disagree', 'pick2', '${POL}', now()), ('${ID(5)}', 'agree', 'nopick', NULL, now())`);
  });
  const ws = new Date(Date.now() - 2 * 3600_000).toISOString();
  const existingOf = async (cid: string) => ((await db.query<{ r: { existing: Array<Record<string, unknown>> } }>(
    `SELECT report_context_bundle('verify_pre', $1::jsonb) AS r`, [JSON.stringify({ contribution_id: cid, quota_column: "actor_id", quota_value: "x", window_start: ws, binding: null, prev: null })])).rows[0].r.existing);
  const fake = (cid: string) => ({
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: db_rows(cid) }) }) }) }),
  });
  const rowsCache = new Map<string, Array<Record<string, unknown>>>();
  for (const cid of [ID(2), ID(5), ID(1)]) rowsCache.set(cid, (await db.query<Record<string, unknown>>(`SELECT id, verdict, resolved_politician_id FROM contribution_votes WHERE contribution_id = $1`, [cid])).rows);
  const db_rows = (cid: string) => rowsCache.get(cid)!;
  for (const cid of [ID(2), ID(5), ID(1)]) {
    const rows = await existingOf(cid);
    assertEquals(await hasExistingPick(fake(cid), cid, null, rows), await hasExistingPick(fake(cid), cid, null), `有人指認？${cid}`);
    for (const r of rows) assertEquals(await hasExistingPick(fake(cid), cid, String(r.id), rows), await hasExistingPick(fake(cid), cid, String(r.id)), "排除自己那張");
  }
  assertEquals(await hasExistingPick(fake(ID(2)), ID(2), null, await existingOf(ID(2))), true);
  assertEquals(await hasExistingPick(fake(ID(5)), ID(5), null, await existingOf(ID(5))), false);
  const many = Array.from({ length: 250 }, (_, i) => ({ id: i, verdict: i === 230 ? "agree" : "agree", resolved_politician_id: i === 230 ? POL : null }));
  assertEquals(await hasExistingPick({}, ID(1), null, many), false, "指認在第 231 張：跟原查詢的 limit(200) 一樣看不到");
});

Deno.test("RPC 權限（report_context_bundle）已在 feed-bundle.test.ts 逐支驗過；這裡再守：只回 service_role 要讀的欄位，不多帶任何其他人的 ip_hash", async () => {
  const db = await freshDb();
  const r = (await db.query<{ r: Record<string, unknown> }>(`SELECT report_context_bundle('verify_pre', $1::jsonb) AS r`,
    [JSON.stringify({ contribution_id: ID(2), quota_column: "actor_id", quota_value: "x", window_start: new Date(Date.now() - 3600_000).toISOString(), binding: null, prev: null })])).rows[0].r;
  // verify-handler 現在就在讀 contributor_ip_hash／verifier_ip_hash（比對本人用）；回應給代理的 JSON 不含，見上面逐 byte 比對的 `!/ip_hash/` 檢查
  assertEquals(Object.keys(r).sort(), ["contribution", "dispatched", "existing", "original", "prev", "used"]);
  assertEquals(Object.keys(r.contribution as object).sort(), [
    "actor_id", "agent_name", "agree_count", "bundle_id", "bundle_released_at", "contribution_type", "contributor_ip_hash", "disagree_count", "id",
    "payload", "score", "source_urls", "status", "task_id", "unsure_count",
  ]);
});
