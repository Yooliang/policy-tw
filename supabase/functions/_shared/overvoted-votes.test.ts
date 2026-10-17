/**
 * 驗證票「投太多輪」（維護者 2026-10-17；migration 20261017020100）。
 *
 *   - 基準＝最近 30 天建立、已結案（狀態不是 pending／disputed）、至少 1 票的交件的平均票數（現算，不寫死），存進 vote_baseline
 *   - 票數 > 基準 × overvoted_flag_multiplier（2）→ 標出（console_queue_state().overvoted），派工照常
 *   - 票數 > 基準 × overvoted_stop_multiplier（3）→ 驗證池不給（LIMIT 之前）；contribution_overvoted_escalate 把它轉 disputed 並開一件
 *     adjudicate 任務（既有的裁決機制），冪等：一份交件只有一件開著的裁決任務；adjudication 型別本身不適用
 *   - 兩個倍數在 queue_settings（新欄，一行 UPDATE 改）
 *   還原驗證（人工做過，見 PR 說明）：拿掉驗證池的 overvoted 條件、拿掉 escalate 的 NOT EXISTS、把基準的 30 天改成 3650 天、
 *   拿掉 apply_consensus 的 disputed 守衛，各自對應的測試會紅
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";

const MIG = "20261017020100_overvoted_votes.sql";
const SQL = await readMig(MIG);
const A = await readMig("20261017020000_unsure_penalty.sql");
const SCORE_SQL = await readMig("20260921000021_score_consensus.sql");
const REJECT_SQL = await readMig("20260923000007_reject_floor.sql");
const CONSOLE_PREV = await readMig("20261017010100_console_queue_state_merged.sql");

const ID = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FNS = ["contribution_vote_baseline_compute", "contribution_vote_baseline_refresh", "contribution_vote_baseline", "contribution_overvoted_flag_votes",
  "contribution_overvoted_stop_votes", "contribution_overvoted_escalate", "contribution_overvoted_tick"];

async function db(sql = SQL): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, payload jsonb DEFAULT '{}', source_urls text[], agent_name text DEFAULT 'a-zhen',
      status text DEFAULT 'pending', agree_count int DEFAULT 0, disagree_count int DEFAULT 0, unsure_count int DEFAULT 0, score int DEFAULT 0, target_score int,
      voter_ips int DEFAULT 0, verified_at timestamptz, review_notes text, batch_verified_by text, created_at timestamptz DEFAULT now(),
      contributor_ip_hash text, note text, task_id text);
    CREATE TABLE contribution_votes (id serial PRIMARY KEY, contribution_id uuid, verifier_ip_hash text, agent_name text, verdict text, judge_backed boolean DEFAULT false,
      weight smallint, note text, evidence_url text, created_at timestamptz DEFAULT now());
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, description text, task_type text, target jsonb, priority int, reward int,
      status text, source text, created_by text, hint_sources text[], closed_at timestamptz);
    CREATE TABLE queue_settings (id smallint PRIMARY KEY, overvoted_flag_multiplier numeric DEFAULT 2, overvoted_stop_multiplier numeric DEFAULT 3);
    INSERT INTO queue_settings VALUES (1, 2, 3);
    CREATE TABLE vote_baseline (id smallint PRIMARY KEY, baseline numeric, sample int, computed_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION contribution_effective_agree(uuid) RETURNS int LANGUAGE sql AS 'SELECT 3';
    CREATE FUNCTION contribution_needs_two_ips(text, jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT false';
    CREATE FUNCTION contribution_roster_matched(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
    ${fnText(SCORE_SQL, "contribution_vote_weight")}
    ${fnText(REJECT_SQL, "contribution_reject_floor")}
    ${fnText(A, "contribution_unsure_penalty")}
    ${FNS.map((n) => fnText(sql, n)).join("\n")}
    ${fnText(sql, "contribution_apply_consensus")}
  `);
  return d;
}

/** 種一份交件，票數直接寫在計數欄（agree／disagree／unsure）；daysAgo＝建立於幾天前 */
async function seed(d: PGlite, n: number, o: { status?: string; type?: string; a?: number; dis?: number; u?: number; daysAgo?: number } = {}) {
  await d.query(
    `INSERT INTO contributions (id, contribution_type, status, agree_count, disagree_count, unsure_count, created_at, payload, source_urls)
     VALUES ($1, $2, $3, $4, $5, $6, now() - $7 * interval '1 day', '{"name":"某人"}', ARRAY['https://example.test/a'])`,
    [ID(n), o.type ?? "policy", o.status ?? "applied", o.a ?? 0, o.dis ?? 0, o.u ?? 0, o.daysAgo ?? 1]);
}
const baseline = async (d: PGlite) => Number((await d.query<{ b: string }>(`SELECT contribution_vote_baseline_compute() AS b`)).rows[0].b.replace(/[()]/g, "").split(",")[0]);

Deno.test("基準：近 30 天、已結案（不是 pending／disputed）、至少 1 票的交件平均票數；其他都不算", async () => {
  const d = await db();
  await seed(d, 1, { a: 2 });                                  // 2 票，applied
  await seed(d, 2, { status: "rejected", a: 1, dis: 2 });      // 3 票，rejected
  await seed(d, 3, { status: "pending", a: 9 });               // 等票：不算
  await seed(d, 4, { status: "disputed", a: 9 });              // 爭議：不算
  await seed(d, 5, { a: 8, daysAgo: 40 });                     // 30 天以前：不算
  await seed(d, 6, { a: 0 });                                  // 沒有票：不算
  assertEquals(await baseline(d), 2.5);
  const r = (await d.query<{ baseline: string; sample: number }>(`SELECT baseline, sample FROM contribution_vote_baseline_compute()`)).rows[0];
  assertEquals([Number(r.baseline), r.sample], [2.5, 2]);
  await d.close();
});

Deno.test("基準快取：refresh 寫進 vote_baseline；contribution_vote_baseline() 讀快取、沒有快取才現算；兩條票數線＝基準×倍數，倍數改了就跟著變", async () => {
  const d = await db();
  await seed(d, 1, { a: 2 }); await seed(d, 2, { a: 3 });
  assertEquals(Number((await d.query<{ b: string }>(`SELECT contribution_vote_baseline() AS b`)).rows[0].b), 2.5, "沒有快取時現算");
  await d.query(`SELECT contribution_vote_baseline_refresh()`);
  assertEquals((await d.query(`SELECT * FROM vote_baseline`)).rows.length, 1);
  await seed(d, 3, { a: 20 }); // 快取刷新之前新增的已結案交件不影響讀到的基準
  assertEquals(Number((await d.query<{ b: string }>(`SELECT contribution_vote_baseline() AS b`)).rows[0].b), 2.5);
  const lines = async () => (await d.query<{ f: string; s: string }>(`SELECT contribution_overvoted_flag_votes() AS f, contribution_overvoted_stop_votes() AS s`)).rows.map((r) => [Number(r.f), Number(r.s)])[0];
  assertEquals(await lines(), [5, 7.5]);
  await d.query(`UPDATE queue_settings SET overvoted_flag_multiplier = 1.5, overvoted_stop_multiplier = 4`);
  assertEquals(await lines(), [3.75, 10]);
  // 沒有任何已結案交件：不標、不停（天文數字）
  await d.exec(`DELETE FROM vote_baseline; DELETE FROM contributions`);
  assertEquals((await lines())[0] >= 1_000_000, true);
  await d.close();
});

async function escalateDb(): Promise<PGlite> {
  const d = await db();
  // 基準 2.5 → 標出線 5、停派線 7.5
  await seed(d, 1, { a: 2 }); await seed(d, 2, { a: 3 });
  await d.query(`SELECT contribution_vote_baseline_refresh()`);
  await seed(d, 10, { status: "pending", a: 3, dis: 1, u: 3 });   // 7 票：標出、沒到停派
  await seed(d, 11, { status: "pending", a: 3, dis: 1, u: 4 });   // 8 票：停派
  await seed(d, 12, { status: "pending", u: 12 });                // 12 票：停派
  await seed(d, 13, { status: "pending", type: "adjudication", a: 12 }); // 裁決本身：不適用
  await seed(d, 14, { status: "pending", a: 2 });                 // 2 票：正常
  await d.query(`INSERT INTO contribution_votes (contribution_id, verifier_ip_hash, agent_name, verdict, note, evidence_url) VALUES
    ($1, 'ip1', 'qa-1', 'unsure', '來源打不開', NULL), ($1, 'ip2', 'qa-2', 'agree', '逐欄核過', 'https://example.test/e')`, [ID(11)]);
  return d;
}
const tasks = async (d: PGlite) => (await d.query<{ id: string; target: any; status: string; source: string; task_type: string; created_by: string; description: string; hint_sources: string[] }>(
  `SELECT id, target, status, source, task_type, created_by, description, hint_sources FROM contribution_tasks ORDER BY target->>'contribution_id'`)).rows;
const statusOf = async (d: PGlite, n: number) => (await d.query<{ status: string }>(`SELECT status FROM contributions WHERE id = $1`, [ID(n)])).rows[0].status;

Deno.test("轉裁決：超過停派線（>，不是 ≥）的等票交件改 disputed 並各開一件 adjudicate（auto_dispute）；標出但沒到停派的、裁決本身、正常的都不動", async () => {
  const d = await escalateDb();
  assertEquals((await d.query<{ n: number }>(`SELECT contribution_overvoted_escalate() AS n`)).rows[0].n, 2);
  assertEquals([await statusOf(d, 10), await statusOf(d, 11), await statusOf(d, 12), await statusOf(d, 13), await statusOf(d, 14)],
    ["pending", "disputed", "disputed", "pending", "pending"]);
  const t = await tasks(d);
  assertEquals(t.map((r) => r.target.contribution_id), [ID(11), ID(12)]);
  for (const r of t) assertEquals([r.task_type, r.source, r.status, r.created_by, r.target.reason], ["adjudicate", "auto_dispute", "open", "auto-overvoted", "投太多輪"]);
  // 任務描述帶全部理由與回報格式；提示來源含交件來源與投票附的證據
  assertStringIncludes(t[0].description, "來源打不開");
  assertStringIncludes(t[0].description, "逐欄核過");
  assertStringIncludes(t[0].description, "adjudication");
  assertEquals(t[0].hint_sources.sort(), ["https://example.test/a", "https://example.test/e"]);
  const notes = (await d.query<{ review_notes: string }>(`SELECT review_notes FROM contributions WHERE id = $1`, [ID(11)])).rows[0].review_notes;
  assertStringIncludes(notes, "超過平均 3 倍");
  await d.close();
});

Deno.test("轉裁決冪等：再跑一次不重開任務；已經有開著的裁決任務的不再開第二件", async () => {
  const d = await escalateDb();
  await d.query(`SELECT contribution_overvoted_escalate()`);
  assertEquals((await d.query<{ n: number }>(`SELECT contribution_overvoted_escalate() AS n`)).rows[0].n, 0);
  assertEquals((await tasks(d)).length, 2);
  // 交件被改回 pending（例如維護者手動），任務還開著：再轉 disputed 但不重開
  await d.query(`UPDATE contributions SET status = 'pending' WHERE id = $1`, [ID(11)]);
  await d.query(`SELECT contribution_overvoted_escalate()`);
  assertEquals(await statusOf(d, 11), "disputed");
  assertEquals((await tasks(d)).length, 2, "一份交件只有一件開著的裁決任務");
  // tick＝先重算基準再轉
  await seed(d, 20, { status: "pending", u: 15 });
  assertEquals((await d.query<{ n: number }>(`SELECT contribution_overvoted_tick() AS n`)).rows[0].n, 1);
  await d.close();
});

Deno.test("轉進裁決的交件重算時留在 disputed（不被改回 pending）；分數跌到退件門檻照樣退件並關掉裁決任務", async () => {
  const d = await escalateDb();
  await d.query(`SELECT contribution_overvoted_escalate()`);
  await d.query(`SELECT contribution_apply_consensus($1)`, [ID(11)]);
  assertEquals(await statusOf(d, 11), "disputed");
  // 其他來源的 disputed（沒有 auto-overvoted 的裁決任務）行為不變：重算改回 pending
  await seed(d, 30, { status: "disputed", a: 1 });
  await d.query(`SELECT contribution_apply_consensus($1)`, [ID(30)]);
  assertEquals(await statusOf(d, 30), "pending");
  // 投票把分數壓到退件門檻 → rejected，任務關閉
  for (let i = 1; i <= 4; i++) await d.query(`INSERT INTO contribution_votes (contribution_id, verifier_ip_hash, verdict, weight) VALUES ($1, $2, 'disagree', -1)`, [ID(12), `d${i}`]);
  await d.query(`SELECT contribution_apply_consensus($1)`, [ID(12)]);
  assertEquals(await statusOf(d, 12), "rejected");
  assertEquals((await tasks(d)).find((r) => r.target.contribution_id === ID(12))!.status, "closed");
  assertEquals((await tasks(d)).find((r) => r.target.contribution_id === ID(11))!.status, "open");
  await d.close();
});

// ── 驗證池：超過停派線的不給（LIMIT 之前） ──
function poolOf(sql: string): string {
  const a = sql.indexOf("CREATE OR REPLACE FUNCTION contribution_verify_pool");
  assert(a >= 0, "找不到驗證池定義");
  return sql.slice(a, sql.indexOf("\n$$;", a)) + "\n$$;";
}
async function poolDb(sql = SQL): Promise<PGlite> {
  const d = await escalateDb();
  await d.exec(`
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz, queue_at timestamptz, dispatch_count int DEFAULT 0, verify_target int);
    CREATE TABLE verify_dispatches (contribution_id uuid, ip_hash text, dispatched_at timestamptz);
  `);
  await d.exec(poolOf(sql));
  // 派工列：1～2 號是已結案；10～14 號的驗證列依序排
  let i = 0;
  for (const n of [10, 11, 12, 13, 14]) await d.query(`INSERT INTO task_dispatches (task_id, queue_at) VALUES ($1, '2026-09-01'::timestamptz + $2 * interval '1 minute')`, [`verify:${ID(n)}`, ++i]);
  return d;
}
const poolIds = async (d: PGlite) => (await d.query<{ id: string }>(`SELECT id FROM contribution_verify_pool('net-x', NULL, 30, NULL, NULL, NULL)`)).rows.map((r) => r.id);

Deno.test("驗證池：停派線以內與裁決型別照派，超過的不給；基準或倍數變了立刻跟著變（不用等轉裁決）", async () => {
  const d = await poolDb();
  assertEquals(await poolIds(d), [ID(10), ID(13), ID(14)], "11（8 票）、12（12 票）超過 7.5 票不給；裁決型別 13 不適用");
  await d.query(`UPDATE queue_settings SET overvoted_stop_multiplier = 5`); // 線＝12.5：全派
  assertEquals(await poolIds(d), [ID(10), ID(11), ID(12), ID(13), ID(14)]);
  await d.query(`UPDATE queue_settings SET overvoted_stop_multiplier = 2`); // 線＝5：10（7 票）也停
  assertEquals(await poolIds(d), [ID(13), ID(14)]);
  await d.close();
});

Deno.test("驗證池：條件在 LIMIT 之前——p_limit 小也不會被停派的列佔掉名額", async () => {
  const d = await poolDb();
  assertEquals((await d.query<{ id: string }>(`SELECT id FROM contribution_verify_pool('net-x', NULL, 2, NULL, NULL, NULL)`)).rows.map((r) => r.id), [ID(10), ID(13)]);
  await d.close();
});

Deno.test("還原驗證（程式化）：拿掉驗證池的 overvoted 條件，停派的列就又被派出去", async () => {
  const broken = mutate(SQL, "         OR c.agree_count + c.disagree_count + c.unsure_count <= (SELECT contribution_overvoted_stop_votes()))\n", "         OR true)\n");
  const d = await poolDb(broken);
  assertEquals((await poolIds(d)).includes(ID(12)), true, "被拿掉之後 12 號又出現——測試能抓到");
  await d.close();
});

Deno.test("驗證池：只比 20261011160000 的現行定義多這一個條件，其餘一字不動", () => {
  const prev = poolOf(readPrev());
  const now = poolOf(SQL);
  const added = `    -- 投太多輪（20261017020100）：票數超過 平均 × overvoted_stop_multiplier 的不再派（交件會被 contribution_overvoted_escalate 轉裁決）；
    -- 裁決（adjudication）本身不適用。條件在 LIMIT 之前；(SELECT …) 讓規劃器只算一次
    AND (c.contribution_type = 'adjudication'
         OR c.agree_count + c.disagree_count + c.unsure_count <= (SELECT contribution_overvoted_stop_votes()))
`;
  const stripped = now.replace(added, "").replace(/\n  '2026-10-17：票數超過[^\n]*\n/, "\n");
  assertEquals(stripped.split("\n$$;")[0], prev.split("\n$$;")[0].replace("\n$$;", ""));
});
function readPrev(): string {
  return Deno.readTextFileSync(new URL("../../migrations/20261011160000_verify_pool_voted_agent_front_no_change.sql", import.meta.url)).replace(/\r\n/g, "\n");
}

// ── 主控台隊列頁 ──
Deno.test("主控台：console_queue_state 只多 overvoted 一個鍵；驗證票的「可派」排除超過停派線的；SQL 其餘跟前一版比對", () => {
  assertStringIncludes(SQL, "'overvoted', (SELECT jsonb_build_object(");
  assertStringIncludes(SQL, "AND (v.contribution_type = 'adjudication' OR v.agree_count + v.disagree_count + v.unsure_count <= (SELECT stop FROM ov))) AS ok");
  // 前一版的每個頂層鍵都還在
  for (const k of ["'by_type'", "'verify'", "'head'", "'first_ready_pos'", "'parked_total'", "'parked'", "'dispatched_24h'", "'age_buckets'", "'generated_at'"]) {
    assert(fnText(SQL, "console_queue_state").includes(k), `少了 ${k}`);
    assert(fnText(CONSOLE_PREV, "console_queue_state").includes(k));
  }
  assertStringIncludes(SQL, "REVOKE ALL ON FUNCTION console_queue_state() FROM PUBLIC;");
});

Deno.test("主控台：overvoted 區塊的內容（基準、兩條線、票數、各票結論與理由、停派標記）", async () => {
  const d = await escalateDb();
  await d.exec(`
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, task_type text, target jsonb, queue_at timestamptz, dispatch_count int DEFAULT 0,
      last_dispatched_at timestamptz, blocked boolean DEFAULT false, cooling boolean DEFAULT false, verify_target int);
    CREATE TABLE citizen_questions (id uuid PRIMARY KEY, answer_count int);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text);
    CREATE TABLE policies (id uuid PRIMARY KEY, title text);
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    ${await latestFn("uuid_or_null")}
    CREATE FUNCTION contribution_subject_politician(p jsonb) RETURNS uuid LANGUAGE sql AS $f$ SELECT NULL::uuid $f$;
    CREATE FUNCTION question_answer_cap() RETURNS int LANGUAGE sql AS $f$ SELECT 3 $f$;
    ${fnText(SQL, "console_queue_state")}
  `);
  await d.query(`SELECT contribution_overvoted_escalate()`); // 11、12 轉 disputed
  const j = (await d.query<{ j: any }>(`SELECT console_queue_state() AS j`)).rows[0].j;
  const o = j.overvoted;
  assertEquals([o.baseline, o.flag_multiplier, o.stop_multiplier, o.flag_votes, o.stop_votes, o.total], [2.5, 2, 3, 5, 7.5, 3]);
  assertEquals(o.items.map((x: any) => [x.contribution_id, x.votes, x.status, x.stopped]), [
    [ID(12), 12, "disputed", true], [ID(11), 8, "disputed", true], [ID(10), 7, "pending", false],
  ]);
  const it = o.items.find((x: any) => x.contribution_id === ID(11));
  assertEquals(it.subject, "某人");
  assertEquals(it.verdicts, [{ verdict: "unsure", agent: "qa-1", reason: "來源打不開" }, { verdict: "agree", agent: "qa-2", reason: "逐欄核過" }]);
  // 隊頭的驗證票：沒有 task_dispatches 列，所以空；其餘鍵仍在
  assertEquals(j.verify.total, 0);
  await d.close();
});

// ── 設定與排程的文字守門 ──
Deno.test("設定：兩個倍數在 queue_settings（預設 2、3，停派線不得低於標出線）；基準不寫死；排程每 10 分鐘", () => {
  assertStringIncludes(SQL, "ADD COLUMN IF NOT EXISTS overvoted_flag_multiplier NUMERIC(6,2) NOT NULL DEFAULT 2");
  assertStringIncludes(SQL, "ADD COLUMN IF NOT EXISTS overvoted_stop_multiplier NUMERIC(6,2) NOT NULL DEFAULT 3");
  assertStringIncludes(SQL, "CHECK (overvoted_stop_multiplier >= overvoted_flag_multiplier)");
  assertStringIncludes(SQL, "c.created_at > now() - INTERVAL '30 days'");
  assertStringIncludes(SQL, "c.status NOT IN ('pending', 'disputed')");
  assert(!/2\.45/.test(fnText(SQL, "contribution_vote_baseline_compute")), "基準不得寫死");
  assertStringIncludes(SQL, "SELECT cron.schedule('overvoted-tick-10min', '3,13,23,33,43,53 * * * *', $$SELECT contribution_overvoted_tick();$$);");
  assertStringIncludes(SQL, "REVOKE ALL ON FUNCTION contribution_overvoted_tick() FROM PUBLIC, anon, authenticated;");
  // 任務型別沿用既有裁決機制，沒有新型別
  assertStringIncludes(fnText(SQL, "contribution_overvoted_escalate"), "'adjudicate',");
  assertStringIncludes(fnText(SQL, "contribution_overvoted_escalate"), "'auto_dispute'");
  assert(!/contribution_tasks_task_type_check|contributions_contribution_type_check/.test(SQL), "不新增任務型別／貢獻型別（四處清單不用動）");
});

Deno.test("計分一致：投太多輪 migration 裡的 apply_consensus ＝ 20261017020000 的版本加兩處（disputed 守衛、退件關裁決任務）", () => {
  const a = fnText(A, "contribution_apply_consensus");
  const b = fnText(SQL, "contribution_apply_consensus");
  assert(b.includes("v_score := v_score - contribution_unsure_penalty(v_unsure);"), "不確定的罰則不能在這支被丟掉");
  const guard = b.indexOf("ELSIF v_status = 'disputed' AND EXISTS (");
  const close = b.indexOf("IF v_new = 'rejected' AND v_status = 'disputed' THEN");
  assert(guard > 0 && close > guard);
  assertEquals(a.length < b.length, true);
});
