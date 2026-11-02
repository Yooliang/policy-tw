/**
 * 日本站跟上正見：不確定第 2 張起每張 −1、投太多輪（2 倍標出、3 倍停派）、爭點驗證、單邊額度用完（policy-ops#178 A、#128）。
 * migration 20261102220000_policy_jp_unsure_overvoted.sql；jp-next／jp-report 的行為。
 *
 *   1. SQL（PGlite，套全部 policy_jp migration）：不確定罰則（0／0／−1／−2…）、weight 欄不被動、罰則把交件推向退件線、
 *      投太多輪的基準（近 30 天已結案平均）與兩條票數線、驗證池停派、爭點驗證兩支函式、權限、套兩次都成功、不移植轉裁決
 *   2. jp-next（真的載入入口）：提交額度用完只派驗證票、驗證額度用完只派任務、兩邊用完 none；爭點驗證附 item.dispute 與 how_to
 *   3. jp-report 驗證：爭點驗證（回報當下超過線）擋 unsure 與盲反對（400 dispute_no_unsure），沒超過線照收
 *
 * 還原驗證（人工做過，見 PR 說明）：①migration 的 `v_score := v_score - policy_jp.contribution_unsure_penalty(v_unsure);` 拿掉 → 罰則兩條紅；
 * ②驗證池的投太多輪條件拿掉 → 停派那條紅；③jp-next 的 `verifyFull` 判斷拿掉 → 額度兩條紅；④verify-handler 的 dispute 區塊拿掉 → jp-report 那條紅。
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { freshDb, one, readMig, rows } from "./policy-jp-chain-db.ts";
import { loadEntry, type RestCall } from "./jp/entry-harness.ts";

const MIG = "20261102220000_policy_jp_unsure_overvoted.sql";
const MIG_SQL = await readMig(MIG);

type Db = Awaited<ReturnType<typeof freshDb>>;
let seq = 0;
async function addContribution(db: Db, status = "pending", counts?: [number, number, number]): Promise<string> {
  seq++;
  const r = await one<{ id: string }>(db,
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash, status, agree_count, disagree_count, unsure_count)
     VALUES ('correction', '{"target_table":"policies","target_id":"p-1"}'::jsonb, ARRAY['https://example.test/a'], 'submitter', 'h-sub', $1, $2, $3, $4, $5) RETURNING id`,
    [`ph-${seq}`, status, counts?.[0] ?? 0, counts?.[1] ?? 0, counts?.[2] ?? 0]);
  return r.id;
}
async function vote(db: Db, id: string, verdict: string, n: number) {
  await db.query(
    `INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, agent_name, verifier_ip_hash, note) VALUES ($1, $2, $3, $4, 'テスト')`,
    [id, verdict, `voter-${verdict}-${n}`, `h-${verdict}-${n}`]);
}
const state = (db: Db, id: string) =>
  one<{ score: number; status: string; unsure_count: number; review_notes: string | null }>(db, `SELECT score, status, unsure_count, review_notes FROM policy_jp.contributions WHERE id = $1`, [id]);

Deno.test("SQL 罰則：第 1 張不確定 0 分、第 2 張起每張 −1；weight 欄一律 0 不動；agree 照加", async () => {
  const db = await freshDb();
  assertEquals((await one<{ p: number[] }>(db, `SELECT array_agg(policy_jp.contribution_unsure_penalty(n) ORDER BY n) AS p FROM unnest(ARRAY[0,1,2,3,4,9]) n`)).p, [0, 0, 1, 2, 3, 8]);
  const id = await addContribution(db);
  const seen: number[] = [];
  for (let i = 1; i <= 2; i++) { await vote(db, id, "unsure", i); seen.push((await state(db, id)).score); }
  assertEquals(seen, [0, -1], "第 1 張 0 分、第 2 張起 −1");
  await vote(db, id, "agree", 1);
  assertEquals((await state(db, id)).score, 0, "agree +1，扣 1 張不確定的罰則 −1");
  const w = await rows<{ verdict: string; weight: number }>(db, `SELECT verdict, weight FROM policy_jp.contribution_votes WHERE contribution_id = $1`, [id]);
  for (const r of w.filter((x) => x.verdict === "unsure")) assertEquals(r.weight, 0, "unsure 票自己的 weight 仍是 0，罰則只扣在合計");
  assertEquals((await state(db, id)).status, "pending");
});

Deno.test("SQL 罰則：連續的「確認不了」自己把交件推到退件線（4 張不確定＝−3 退件，備註說明含不確定張數）", async () => {
  const db = await freshDb();
  const id = await addContribution(db);
  for (let i = 1; i <= 4; i++) await vote(db, id, "unsure", i);
  const s = await state(db, id);
  assertEquals(s.score, -3);
  assertEquals(s.status, "rejected");
  assertStringIncludes(s.review_notes ?? "", "含不確定 4 張，第 2 張起每張 −1");
  // 對照：3 張不確定（−2）還在等
  const id2 = await addContribution(db);
  for (let i = 1; i <= 3; i++) await vote(db, id2, "unsure", i);
  assertEquals((await state(db, id2)).status, "pending");
});

Deno.test("SQL 投太多輪：基準＝近 30 天已結案平均票數；> 2 倍是爭點驗證線、> 3 倍驗證池停派（> 而不是 ≥）", async () => {
  const db = await freshDb();
  // 沒有已結案交件：基準 NULL，線是天文數字（不標不停）
  await db.query(`SELECT policy_jp.contribution_vote_baseline_refresh()`);
  assertEquals(Number((await one<{ f: string }>(db, `SELECT policy_jp.contribution_overvoted_flag_votes() AS f`)).f), 1000000);
  // 三件已結案、各 2 票（一件很舊的不算）
  for (let i = 0; i < 3; i++) await addContribution(db, "rejected", [0, 2, 0]);
  const old = await addContribution(db, "rejected", [0, 40, 0]);
  await db.query(`UPDATE policy_jp.contributions SET created_at = now() - interval '60 days' WHERE id = $1`, [old]);
  await db.query(`SELECT policy_jp.contribution_vote_baseline_refresh()`);
  assertEquals(Number((await one<{ b: string }>(db, `SELECT policy_jp.contribution_vote_baseline() AS b`)).b), 2);
  assertEquals(Number((await one<{ f: string }>(db, `SELECT policy_jp.contribution_overvoted_flag_votes() AS f`)).f), 4);
  assertEquals(Number((await one<{ f: string }>(db, `SELECT policy_jp.contribution_overvoted_stop_votes() AS f`)).f), 6);

  const id = await addContribution(db, "pending", [0, 0, 0]);
  const pool = async () => (await rows<{ id: string }>(db, `SELECT id FROM policy_jp.contribution_verify_pool('h-other', NULL, 50)`)).map((r) => r.id);
  await db.query(`UPDATE policy_jp.contributions SET unsure_count = 6 WHERE id = $1`, [id]);
  assert((await pool()).includes(id), "6 票＝剛好 3 倍，不停派");
  await db.query(`UPDATE policy_jp.contributions SET unsure_count = 7 WHERE id = $1`, [id]);
  assert(!(await pool()).includes(id), "7 票 > 3 倍，驗證池不給");
  // 倍數是 queue_settings 的欄：改成 4 倍，7 票又派得出去；停派倍數不得小於標出倍數
  await db.query(`UPDATE policy_jp.queue_settings SET overvoted_stop_multiplier = 4 WHERE id = 1`);
  assert((await pool()).includes(id));
  await assertRejects(() => db.query(`UPDATE policy_jp.queue_settings SET overvoted_stop_multiplier = 1 WHERE id = 1`), Error, "queue_settings_overvoted_order");
});

Deno.test("SQL 爭點驗證：超過標出線才回票數與前面每一票（照時間）；沒超過、已結案回 NULL；權限只給 service_role", async () => {
  const db = await freshDb();
  for (let i = 0; i < 3; i++) await addContribution(db, "rejected", [0, 2, 0]);
  await db.query(`SELECT policy_jp.contribution_vote_baseline_refresh()`);
  const id = await addContribution(db);
  for (let i = 1; i <= 4; i++) await vote(db, id, i % 2 ? "agree" : "disagree", i);
  const n = (sql: string) => one<{ v: unknown }>(db, sql, [id]);
  assertEquals((await n(`SELECT policy_jp.contribution_dispute_votes($1) AS v`)).v, null, "4 票 = 2 倍，不 >");
  assertEquals((await n(`SELECT policy_jp.contribution_dispute_context($1) AS v`)).v, null);
  await vote(db, id, "unsure", 5);
  assertEquals((await n(`SELECT policy_jp.contribution_dispute_votes($1) AS v`)).v, 5);
  const ctx = (await n(`SELECT policy_jp.contribution_dispute_context($1) AS v`)).v as { votes: number; baseline: number; flag: number; shown: number; prior: Array<{ verdict: string; note: string }> };
  assertEquals([ctx.votes, ctx.baseline, ctx.flag, ctx.shown], [5, 2, 4, 5]);
  assertEquals(ctx.prior.map((p) => p.verdict).sort(), ["agree", "agree", "disagree", "disagree", "unsure"]);
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [id]);
  assertEquals((await n(`SELECT policy_jp.contribution_dispute_votes($1) AS v`)).v, null, "已結案不是爭點驗證");
  // 權限
  for (const role of ["anon", "authenticated"]) {
    await assertRejects(() => db.transaction(async (tx) => { await tx.exec(`SET LOCAL ROLE ${role}`); await tx.query(`SELECT policy_jp.contribution_dispute_votes($1)`, [id]); }), Error, "permission denied");
  }
  await db.transaction(async (tx) => { await tx.exec(`SET LOCAL ROLE service_role`); await tx.query(`SELECT policy_jp.contribution_dispute_votes($1)`, [id]); });
});

Deno.test("SQL 套用：套兩次都成功、不碰 public、不移植轉裁決、沒有 pg_cron 的環境略過排程", async () => {
  const db = await freshDb();
  await db.exec(MIG_SQL);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`)).n, 0);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM pg_proc WHERE proname IN ('contribution_overvoted_escalate', 'contribution_overvoted_tick')`)).n, 0);
  assertStringIncludes(MIG_SQL, "policy-jp-vote-baseline-hourly");
  assertStringIncludes(MIG_SQL, "to_regnamespace('cron') IS NOT NULL");
});

// ---- jp-next／jp-report 入口 ----
const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789", CONTRIBUTION_IP_SALT: "test-salt" };
const CID = "11111111-2222-4333-8444-555555555555";
const TASK = "auto:policy_missing:abc123";
const FULL = 100000;
const taskRow = { task_id: TASK, task_type: "policy_missing", target: {}, what_we_need: "補政策", hint_sources: [], reward: 1, queue_at: "2026-09-01T00:00:00Z" };
const candidate = {
  id: CID, contribution_type: "correction", payload: { target_table: "policies", target_id: "p-1" }, source_urls: ["https://example.test/a"], note: null, task_id: null,
  agent_name: "someone", contributor_ip_hash: "someone-else", status: "pending", agree_count: 0, disagree_count: 0, unsure_count: 0,
  created_at: "2026-10-01T00:00:00Z", queue_at: "2026-10-01T00:00:00Z", score: 0, target_score: 3, effective_required: 3,
};
const DISPUTE = { votes: 6, baseline: 2, flag: 4, shown: 1, prior: [{ verdict: "agree", agent: "a1", note: "資料在網頁原始碼裡", evidence_url: null, at: "2026-10-02T00:00:00Z" }] };

interface Scenario { submitUsed: number; verifyUsed: number; pool: boolean; queue: boolean; dispute?: unknown }
async function runNext(s: Scenario): Promise<{ body: Record<string, unknown>; calls: RestCall[] }> {
  const router = (c: RestCall): unknown => {
    if (c.method === "HEAD" && c.target === "contributions") return { __count: s.submitUsed };
    if (c.method === "HEAD" && c.target === "contribution_votes") return { __count: s.verifyUsed };
    if (c.target === "rpc/contribution_verify_pool") return s.pool ? [candidate] : [];
    if (c.target === "rpc/contribution_queue_tasks") return s.queue ? [taskRow] : [];
    if (c.target === "rpc/contribution_effective_agree") return 3;
    if (c.target === "rpc/contribution_dispute_context") return s.dispute ?? null;
    if (c.target === "contributions" && c.url.searchParams.get("id") === `eq.${CID}`) return [candidate];
    return undefined;
  };
  const entry = await loadEntry("../../jp-next/index.ts", env, router);
  try {
    const res = await entry.call(new Request("https://x/jp-next?agent_name=dave&agent_tool=claude-code/claude-sonnet-5", { headers: { "x-forwarded-for": "10.1.1.5" } }));
    assertEquals(res.status, 200);
    return { body: await res.json(), calls: entry.calls };
  } finally {
    entry.restore();
  }
}
const base: Scenario = { submitUsed: 0, verifyUsed: 0, pool: true, queue: true };
const leased = (calls: RestCall[]) => calls.filter((c) => c.target === "contribution_task_leases" && c.method !== "GET");

Deno.test("jp-next 額度：都還有照舊；提交用完只派驗證票（任務排前面也不派）", async () => {
  assertEquals((await runNext(base)).body.kind, "task");
  assertEquals((await runNext({ ...base, queue: false })).body.kind, "verify");
  const r = await runNext({ ...base, submitUsed: FULL });
  assertEquals(r.body.kind, "verify");
  assertEquals((r.body.item as { contribution_id: string }).contribution_id, CID);
  assertEquals(leased(r.calls).length, 0, "不該認領任務");
  assertEquals((r.body.quota as { submit: { remaining: number } }).submit.remaining, 0);
});

Deno.test("jp-next 額度：提交用完又沒有合格驗證票 → none（驗證還可以做），不派任務", async () => {
  const r = await runNext({ ...base, submitUsed: FULL, pool: false });
  assertEquals(r.body.kind, "none");
  assertStringIncludes(String(r.body.reason), "驗證還可以做");
  assertEquals(r.body.item, undefined);
  assertEquals(leased(r.calls).length, 0);
});

Deno.test("jp-next 額度：兩邊都用完 → none 等到重置；驗證用完只派任務、沒有任務就 none（不退回驗證票）", async () => {
  const both = await runNext({ ...base, submitUsed: FULL, verifyUsed: FULL });
  assertEquals(both.body.kind, "none");
  assertStringIncludes(String(both.body.reason), "提交與驗證都滿了");
  assert((both.body.retry_after_min as number) >= 5);
  assertEquals(leased(both.calls).length, 0);
  const v = await runNext({ ...base, verifyUsed: FULL });
  assertEquals(v.body.kind, "task");
  assertEquals((v.body.item as { task_id: string }).task_id, TASK);
  assertEquals((await runNext({ ...base, verifyUsed: FULL, queue: false })).body.kind, "none");
});

Deno.test("jp-next 爭點驗證：超過線的驗證票附 item.dispute 與針對爭點的指示、不收 unsure；沒超過線不附", async () => {
  const r = await runNext({ ...base, queue: false, dispute: DISPUTE });
  assertEquals(r.body.kind, "verify");
  const item = r.body.item as { dispute?: { votes: number; prior: unknown[]; instruction: string } };
  assertEquals(item.dispute?.votes, 6);
  assertEquals(item.dispute?.prior.length, 1);
  assertStringIncludes(item.dispute?.instruction ?? "", "爭點");
  assertStringIncludes(String(r.body.how_to), "agree|disagree（這一輪不收 unsure）");
  const plain = await runNext({ ...base, queue: false });
  assertEquals((plain.body.item as { dispute?: unknown }).dispute, undefined);
  assertStringIncludes(String(plain.body.how_to), "agree|disagree|unsure");
});

// ---- jp-report 驗證：爭點驗證擋 unsure ----
async function reportVerify(verdict: string, note: string, disputeVotes: number | null, evidence?: string) {
  const votes: Record<string, unknown>[] = [];
  const router = (c: RestCall): unknown => {
    if (c.target === "rpc/contribution_dispute_votes") return disputeVotes;
    if (c.target === "verify_dispatches" && c.method === "GET") return [{ contribution_id: CID }]; // 這一筆是派給這台機器的
    if (c.target === "contributions" && c.method === "GET") return [{ ...candidate, contributor_ip_hash: "someone-else" }];
    if (c.target === "contribution_votes" && c.method === "POST") { votes.push(c.body as Record<string, unknown>); return [{ id: "v1" }]; }
    return undefined;
  };
  const entry = await loadEntry("../../jp-report/index.ts", env, router);
  try {
    const res = await entry.call(new Request("https://x/jp-report", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.1.1.5" },
      body: JSON.stringify({ kind: "verify", contribution_id: CID, verdict, note, ...(evidence ? { evidence_url: evidence } : {}), agent_name: "dave", agent_tool: "claude-code/claude-sonnet-5" }),
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown>, votes, calls: entry.calls };
  } finally {
    entry.restore();
  }
}

Deno.test("jp-report 爭點驗證：超過線時 unsure 與盲反對回 400 dispute_no_unsure 且不寫票；agree 不受影響", async () => {
  const u = await reportVerify("unsure", "試過兩個網址都打不開", 6);
  assertEquals(u.status, 400);
  assertEquals(u.body.error, "dispute_no_unsure");
  assertEquals(u.body.votes, 6);
  assertEquals(u.votes.length, 0);
  assertStringIncludes(String(u.body.message), "不是罰則");
  const blind = await reportVerify("disagree", "打不開，確認不了", 6, "https://example.test/a");
  assertEquals(blind.body.error, "dispute_no_unsure");
  assertStringIncludes(String(blind.body.message), "等同不確定");
  // 沒超過線（函式回 NULL）：unsure 照收，不會被這一關擋
  const ok = await reportVerify("unsure", "試過兩個網址都打不開", null);
  assert(ok.body.error !== "dispute_no_unsure");
  // agree 根本不查
  const agree = await reportVerify("agree", "網頁原始碼第 3 段的欄位都對得上", 6);
  assert(agree.body.error !== "dispute_no_unsure");
  assert(!agree.calls.some((c) => c.target === "rpc/contribution_dispute_votes"));
});
