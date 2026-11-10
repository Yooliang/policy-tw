// 強模型待辦（20261109230000，協議 1.126.0）守門：
//  A 純函式（鑰匙比對、更正差異、簡報）；B 交件驗證；C SQL 行為（PGlite：一般派工排除、sweep 冪等與回填、清單）；
//  D 接線（/next lane=strong 驗鑰匙、/report 與 /contribute 傳鑰匙、applyAdjudication 單一裁決、授權不看模型名）。
// 還原驗證：拿掉 contribution_queue_tasks 的 requires_tier 條件、或 /next 的鑰匙檢查、或 handler 的 strongKeyVerified 判斷，對應項會紅。
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { latestFn, readMig } from "./arms-pglite.ts";
import { applyPayloadCorrection, buildStrongBrief, correctionProblems, isStrongTarget, STRONG_INSTRUCTIONS, STRONG_KEY_HEADER, STRONG_REVIEWER, strongKeyOk } from "./strong-lane.ts";
import { validateContributionRequest } from "./contribution-schema.ts";

const MIG = "20261109230000_strong_lane.sql";
const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const KEY = "k".repeat(24);

Deno.test("A1 鑰匙比對：正確才過；沒設、太短、空、錯、長度不同都不過", () => {
  assert(strongKeyOk(KEY, KEY));
  assert(!strongKeyOk(KEY + "x", KEY));
  assert(!strongKeyOk(KEY.slice(1), KEY));
  assert(!strongKeyOk("", KEY));
  assert(!strongKeyOk(null, KEY));
  assert(!strongKeyOk(KEY, undefined));
  assert(!strongKeyOk("short", "short"), "鑰匙太短當沒設");
});

Deno.test("A2 isStrongTarget 只認 requires_tier=strong", () => {
  assert(isStrongTarget({ requires_tier: "strong" }));
  assert(!isStrongTarget({ requires_tier: "weak" }));
  assert(!isStrongTarget({}));
  assert(!isStrongTarget(null));
});

Deno.test("A3 更正差異：改值、刪欄位（null）、不動禁止欄位、相同值不算", () => {
  const orig = { title: "a", election_id: 2024, task_id: "t", gone: 1 };
  const { payload, diff } = applyPayloadCorrection(orig, { election_id: 2026, gone: null, task_id: "x", title: "a" });
  assertEquals(payload, { title: "a", election_id: 2026, task_id: "t" });
  assertEquals(diff.map((d) => d.field).sort(), ["election_id", "gone"]);
  assertEquals(correctionProblems(undefined) !== null, true);
  assertEquals(correctionProblems({}) !== null, true);
  assertEquals(correctionProblems({ task_id: "x" }) !== null, true);
  assertEquals(correctionProblems({ election_id: 2026 }), null);
});

Deno.test("A4 簡報：含原貢獻、全部票與理由、查證指示（動態網頁／election_id）、三種 verdict", () => {
  const b = buildStrongBrief(
    { id: "t1", title: "T", description: "d", target: {}, hint_sources: ["https://a.example/x"] },
    { id: "c1", contribution_type: "policy", payload: { title: "p" }, source_urls: ["https://b.example/y"], agent_name: "ag", status: "pending" },
    [{ verdict: "disagree", agent_name: "v1", note: "選舉屆別錯", evidence_url: "https://c.example/z" }],
  ) as Record<string, unknown>;
  const txt = JSON.stringify(b);
  for (const needle of ["選舉屆別錯", "https://c.example/z", "https://b.example/y", "twreporter", "election_id", "uphold_with_correction", "x-strong-lane-key"]) assertStringIncludes(txt, needle);
  assertEquals((b.votes as unknown[]).length, 1);
});

Deno.test("B uphold_with_correction：要帶 corrected_fields；其他 verdict 不能帶", () => {
  const mk = (payload: Record<string, unknown>) => validateContributionRequest({
    agent_name: "tester-ag", contribution_type: "adjudication",
    payload: { contribution_id: "00000000-0000-4000-8000-000000000001", reason: "查了原始來源與選舉屆別與人物身份，結論如上所述，沒有問題", checked_urls: ["https://a.example/x"], ...payload },
  });
  assert(mk({ verdict: "uphold" }).ok);
  assert(mk({ verdict: "reject" }).ok);
  assert(!mk({ verdict: "uphold_with_correction" }).ok, "沒帶 corrected_fields");
  assert(mk({ verdict: "uphold_with_correction", corrected_fields: { election_id: 2026 } }).ok);
  assert(!mk({ verdict: "uphold", corrected_fields: { a: 1 } }).ok, "uphold 不能帶 corrected_fields");
});

// ---------------- C. SQL ----------------
/** migration 對線上定義做的機械式替換，在檔案裡的最後一版文字上重做一遍（跟 DO 區塊的 v_old／v_new 同一組字串） */
async function patchedQueueFn(): Promise<string> {
  const sql = await readMig(MIG);
  const m = /v_old CONSTANT TEXT := \$s\$(.*?)\$s\$;\s*v_new CONSTANT TEXT := \$s\$(.*?)\$s\$;/s.exec(sql);
  assert(m, "找不到 DO 區塊的 v_old／v_new");
  const fn = await latestFn("contribution_queue_tasks");
  assertEquals(fn.split(m[1]).length - 1, 1, "現行定義裡 v_old 要剛好一次");
  return fn.replace(m[1], m[2]);
}

async function queueDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb, what_we_need text, hint_sources text[], reward integer, region text,
      queue_at timestamptz NOT NULL, blocked boolean NOT NULL DEFAULT false, cooling boolean NOT NULL DEFAULT false, opened_at timestamptz NOT NULL DEFAULT now(), last_dispatched_at timestamptz);
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text, payload jsonb NOT NULL DEFAULT '{}'::jsonb, contributor_ip_hash text, agent_name text);
    CREATE TABLE contribution_task_leases (task_id text, target_key text, leased_until timestamptz, agent_name text);
    CREATE TABLE citizen_questions (id uuid PRIMARY KEY, answer_count integer NOT NULL DEFAULT 0);
    CREATE TABLE question_answers (question_id uuid, agent_name text);
    CREATE TABLE contribution_votes (contribution_id uuid, verifier_ip_hash text);`);
  for (const fn of ["task_target_key", "uuid_or_null", "question_answer_cap"]) await db.exec(await latestFn(fn));
  await db.exec(await patchedQueueFn());
  return db;
}

Deno.test("C1 一般派工排除強模型任務（不分誰來領、有無 ip），其餘裁決任務照給", async () => {
  const db = await queueDb();
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target, queue_at) VALUES
    ('00000000-0000-4000-8000-000000000a01', 'adjudicate', '{"contribution_id":"00000000-0000-4000-8000-0000000000c1","requires_tier":"strong"}', now()),
    ('00000000-0000-4000-8000-000000000a02', 'adjudicate', '{"contribution_id":"00000000-0000-4000-8000-0000000000c2"}', now())`);
  for (const [ip, agent] of [[null, null], ["ip-me", "me"], ["ip-me", "claude2:claude-opus-4"]] as const) {
    const r = await db.query<{ task_id: string }>(`SELECT task_id FROM contribution_queue_tasks(NULL, NULL, 100, '', $1, $2)`, [ip, agent]);
    assertEquals(r.rows.map((x) => x.task_id), ["00000000-0000-4000-8000-000000000a02"], `ip=${ip} agent=${agent}`);
  }
});

Deno.test("C1b migration 的 DO 區塊真的對線上定義動手：替換後排除；重跑不再動（冪等）", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb, what_we_need text, hint_sources text[], reward integer, region text,
      queue_at timestamptz NOT NULL, blocked boolean NOT NULL DEFAULT false, cooling boolean NOT NULL DEFAULT false, opened_at timestamptz NOT NULL DEFAULT now(), last_dispatched_at timestamptz);
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text, payload jsonb NOT NULL DEFAULT '{}'::jsonb, contributor_ip_hash text, agent_name text);
    CREATE TABLE contribution_task_leases (task_id text, target_key text, leased_until timestamptz, agent_name text);
    CREATE TABLE citizen_questions (id uuid PRIMARY KEY, answer_count integer NOT NULL DEFAULT 0);
    CREATE TABLE question_answers (question_id uuid, agent_name text);
    CREATE TABLE contribution_votes (contribution_id uuid, verifier_ip_hash text);`);
  for (const fn of ["task_target_key", "uuid_or_null", "question_answer_cap"]) await db.exec(await latestFn(fn));
  await db.exec(await latestFn("contribution_queue_tasks"));
  const sql = await readMig(MIG);
  const i = sql.indexOf("DO $do$");
  const j = sql.indexOf("$do$;", i + 5) + 5;
  const block = sql.slice(i, j);
  await db.exec(block);
  await db.exec(block); // 重跑
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target, queue_at) VALUES
    ('00000000-0000-4000-8000-000000000b01', 'adjudicate', '{"contribution_id":"00000000-0000-4000-8000-0000000000c1","requires_tier":"strong"}', now()),
    ('00000000-0000-4000-8000-000000000b02', 'adjudicate', '{"contribution_id":"00000000-0000-4000-8000-0000000000c2"}', now())`);
  const r = await db.query<{ task_id: string }>(`SELECT task_id FROM contribution_queue_tasks(NULL, NULL, 100, '', NULL, NULL)`);
  assertEquals(r.rows.map((x) => x.task_id), ["00000000-0000-4000-8000-000000000b02"]);
  const def = (await db.query<{ d: string }>(`SELECT pg_get_functiondef('contribution_queue_tasks(text,text,integer,text,text,text)'::regprocedure) AS d`)).rows[0].d;
  assertEquals(def.split("requires_tier").length - 1, 2, "註解一次＋條件一次，重跑沒有重複替換");
});

Deno.test("C2 migration 的替換：剛好一處、冪等保險、保留其他 >>> 合格 標記；之後的 migration 不得拿舊文字重建這支函式", async () => {
  const sql = await readMig(MIG);
  assertStringIncludes(sql, "pg_get_functiondef('contribution_queue_tasks(text,text,integer,text,text,text)'::REGPROCEDURE)");
  assertStringIncludes(sql, "strpos(v_def, 'requires_tier') > 0 THEN RETURN");
  assertStringIncludes(sql, "IS DISTINCT FROM 'strong'");
  assert(!sql.includes("CREATE OR REPLACE FUNCTION contribution_queue_tasks("), "不重建：線上定義已被 20261107030000 改過");
  const fn = await patchedQueueFn();
  for (const m of ["合格：認領中", "合格：同機器交過", "合格：裁決任務", "合格：任務停放"]) assertStringIncludes(fn, `>>> ${m}`);
});

async function sweepDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, payload jsonb NOT NULL DEFAULT '{}'::jsonb, source_urls text[], agent_name text, review_notes text,
      agree_count int NOT NULL DEFAULT 0, disagree_count int NOT NULL DEFAULT 0, unsure_count int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE contribution_votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_id uuid, verdict text, evidence_url text, note text, agent_name text, agent_tool text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, description text, task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb, priority int, reward int, status text NOT NULL DEFAULT 'open',
      source text, created_by text, hint_sources text[], created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz);
    CREATE TABLE strong_lane_settings (id smallint PRIMARY KEY, enabled boolean NOT NULL DEFAULT true, stale_dispute_days int NOT NULL DEFAULT 3, note text);
    INSERT INTO strong_lane_settings (id) VALUES (1);
    CREATE FUNCTION contribution_overvoted_flag_votes() RETURNS numeric LANGUAGE sql AS $$ SELECT 4::numeric $$;
    CREATE FUNCTION contribution_overvoted_stop_votes() RETURNS numeric LANGUAGE sql AS $$ SELECT 6::numeric $$;`);
  const sql = await readMig(MIG);
  const i = sql.indexOf("CREATE OR REPLACE FUNCTION strong_lane_sweep()");
  const j = sql.indexOf("COMMENT ON FUNCTION strong_lane_sweep");
  assert(i > 0 && j > i);
  await db.exec(sql.slice(i, j));
  return db;
}
const add = (db: PGlite, status: string, votes: number, ageDays = 0, type = "policy") => db.query<{ id: string }>(
  `INSERT INTO contributions (contribution_type, status, payload, agent_name, agree_count, disagree_count, created_at) VALUES ($1, $2, '{"title":"x"}', 'author', 0, $3, now() - ($4 || ' days')::interval) RETURNING id`,
  [type, status, votes, String(ageDays)]);

Deno.test("C3 sweep：停派／disputed 超標出線／disputed 過期才開；冪等；取代一般裁決任務；不碰 adjudication 與少票的 pending", async () => {
  const db = await sweepDb();
  const over = (await add(db, "pending", 7)).rows[0].id; // > 停派線 6
  const disp = (await add(db, "disputed", 5)).rows[0].id; // disputed 且 > 標出線 4
  const stale = (await add(db, "disputed", 1, 5)).rows[0].id; // disputed 5 天、沒有任務
  const fresh = (await add(db, "disputed", 1, 1)).rows[0].id; // disputed 才 1 天：不開
  const few = (await add(db, "pending", 3)).rows[0].id; // 少票 pending：不開
  const adj = (await add(db, "pending", 9, 0, "adjudication")).rows[0].id; // 裁決本身：不開
  await db.query(`INSERT INTO contribution_votes (contribution_id, verdict, note, agent_name, agent_tool) VALUES ($1, 'disagree', '選舉屆別錯', 'v1', 'sonnet')`, [over]);
  // 原有一般裁決任務（優先 0、auto-overvoted）→ 被取代
  await db.query(`INSERT INTO contribution_tasks (title, task_type, target, priority, status, source, created_by) VALUES ('old', 'adjudicate', $1::jsonb, 0, 'open', 'auto_dispute', 'auto-overvoted')`, [JSON.stringify({ contribution_id: over })]);
  assertEquals(((await db.query<{ n: number }>(`SELECT strong_lane_sweep() AS n`)).rows[0].n), 3);
  const t = await db.query<{ cid: string; status: string; tier: string | null; created_by: string; description: string }>(
    `SELECT target->>'contribution_id' AS cid, status, target->>'requires_tier' AS tier, created_by, description FROM contribution_tasks ORDER BY created_at, title`);
  const open = t.rows.filter((r) => r.status === "open" && r.tier === "strong");
  assertEquals(open.map((r) => r.cid).sort(), [over, disp, stale].sort());
  assertEquals(t.rows.filter((r) => r.status === "closed").length, 1, "原有一般裁決任務關掉");
  const mine = open.find((r) => r.cid === over)!;
  assertEquals(mine.created_by, "auto-strong");
  for (const needle of ["選舉屆別錯", "sonnet", "twreporter", "election_id", "uphold_with_correction"]) assertStringIncludes(mine.description, needle);
  assert(![fresh, few, adj].some((id) => t.rows.some((r) => r.cid === id)));
  // 冪等：再跑 0 件；強模型任務關掉後也不重開
  assertEquals(((await db.query<{ n: number }>(`SELECT strong_lane_sweep() AS n`)).rows[0].n), 0);
  await db.exec(`UPDATE contribution_tasks SET status = 'closed' WHERE target->>'requires_tier' = 'strong'`);
  assertEquals(((await db.query<{ n: number }>(`SELECT strong_lane_sweep() AS n`)).rows[0].n), 0);
  // 開關
  await db.exec(`UPDATE strong_lane_settings SET enabled = false`);
  await add(db, "pending", 9);
  assertEquals(((await db.query<{ n: number }>(`SELECT strong_lane_sweep() AS n`)).rows[0].n), 0);
});

Deno.test("C4 migration 結構：回填呼叫、排程、清單公開、設定表有 stale_dispute_days 預設 3、沒有模型名授權設定", async () => {
  const sql = await readMig(MIG);
  assertStringIncludes(sql, "SELECT strong_lane_sweep();");
  assertStringIncludes(sql, "cron.schedule('strong-lane-sweep-10min'");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION strong_lane_list() TO anon, authenticated, service_role");
  assertStringIncludes(sql, "stale_dispute_days  INTEGER NOT NULL DEFAULT 3");
  assert(!/strong_model_patterns/.test(sql), "模型名不授權：不能有 strong_model_patterns");
  const later: string[] = [];
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) if (e.name > MIG && e.name.endsWith(".sql")) later.push(e.name);
  for (const f of later) {
    const s = await readMig(f);
    assert(!/FUNCTION contribution_queue_tasks\(/.test(s) || s.includes("requires_tier"), `${f} 重新定義 contribution_queue_tasks 卻拿掉強模型排除`);
  }
});

// ---------------- D. 接線 ----------------
Deno.test("D1 /next lane=strong：入口只轉給 serveStrongLane；本體先驗鑰匙（403）、不看 agent_tool", async () => {
  const src = await read("../next/index.ts");
  assertStringIncludes(src, 'url.searchParams.get("lane") === "strong"');
  assertStringIncludes(src, "serveStrongLane(");
  const block = await read("./strong-lane-claim.ts");
  assertStringIncludes(block, "strongKeyFromRequest(req");
  assert(block.indexOf("strongKeyFromRequest") < block.indexOf("strong_lane_list"), "鑰匙檢查要在任何讀取之前");
  assert(block.indexOf("strongKeyFromRequest") < block.indexOf('from("contribution_tasks")'));
  assertStringIncludes(block, "403");
  assert(!/agentTool\.(match|includes|toLowerCase)|patterns/.test(block), "不得用 agent_tool 授權");
  assertStringIncludes(block, "strong_lane_claim"); // 稽核 log
  assertStringIncludes(block, "claimed_tool");
});

Deno.test("D2 /report、/contribute 把標頭驗過的結果傳給 handleContribute；handler 沒驗過不走單一裁決", async () => {
  for (const f of ["../report/index.ts", "../contribute/index.ts"]) assertStringIncludes(await read(f), "strongKeyFromRequest(req");
  const h = await read("./contribute-handler.ts");
  assertStringIncludes(h, "strongKeyVerified = false");
  const i = h.indexOf("強模型單一裁決（1.126.0）");
  const blk = h.slice(i, h.indexOf("// 同一批裡內容完全相同", i));
  assert(blk.indexOf("if (!strongKeyVerified)") > 0 && blk.indexOf("if (!strongKeyVerified)") < blk.indexOf("bypassNotes.set"));
  assertStringIncludes(blk, "strong_lane_key_required");
  assertStringIncludes(blk, "self_adjudication");
  assertStringIncludes(blk, "no_strong_task");
  assert(!/agent_tool.*(opus|patterns)/i.test(blk.replace(/自報模型/g, "")), "不得用模型名授權");
  assertStringIncludes(h, "reviewed_by: reviewedBy");
  assertEquals(STRONG_KEY_HEADER, "x-strong-lane-key");
});

Deno.test("D3 applyAdjudication：單一裁決認 reviewed_by＝strong-adjudication；三種 verdict；記裁決者與自報模型", async () => {
  const a = await read("./apply-contribution.ts");
  const i = a.indexOf("async function applyAdjudication");
  const fn = a.slice(i, a.indexOf("export async function closeTaskIfFulfilled", i));
  assertStringIncludes(fn, `=== ${"STRONG_REVIEWER"}`);
  assertStringIncludes(fn, `["pending", "disputed", "apply_failed"]`);
  assertStringIncludes(fn, "uphold_with_correction");
  assertStringIncludes(fn, "自報模型");
  assertStringIncludes(fn, "applyPayloadCorrection");
  assertStringIncludes(fn, "closeAdjudicationTasks");
  assertEquals(STRONG_REVIEWER, "strong-adjudication");
});

Deno.test("D4 協議文件不外露鑰匙細節、指示在認領簡報、版號一致", async () => {
  const skill = await read("../../../public/skill.md");
  for (const needle of ["x-strong-lane-key", "strong-lane-key", "STRONG_LANE_KEY"]) assertEquals(skill.includes(needle), false, needle);
  assertStringIncludes(skill, "requires_tier");
  for (const needle of ["uphold_with_correction", "corrected_fields", "單一裁決即定案", "checked_urls"]) assertStringIncludes(STRONG_INSTRUCTIONS, needle);
  const proto = await read("./protocol.ts");
  const v = /PROTOCOL_VERSION = "(\d+\.\d+\.\d+)"/.exec(proto)![1];
  assertStringIncludes(skill, `**版本**：${v}`);
});
