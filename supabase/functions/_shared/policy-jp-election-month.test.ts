/**
 * 日本站派工：選舉月基準＋驗證票排序鍵（migration 20261122190000_policy_jp_verify_ticket_key_election_month.sql；維護者 2026-11-22 17:10 定案）。
 * 台灣版的對照測試：election-year-priority.test.ts（選舉年優先）、verify-ticket-key.test.ts（驗證票排序鍵）。
 *
 * 只要 --allow-read。PGlite 上套日本站「全部」policy_jp migration（沒有任何正見 public 物件），時鐘用 `SET app.activity_today`。
 *
 *   A. 數值抽查：2026-11 的未來選舉 base＝175,400 天、2027-02＝174,800 天（相鄰月差 200 天）；已投完的 M×200−300,000 天為負、較近的較大；未來一律大於已投完
 *   B. 沒掛選舉的件＝最近一場未來選舉的月；target 帶自己日期的（選舉發現／等團體落庫）用那個日期；查無選舉 id 同沒掛
 *   C. 疊進 priority_seconds 的兩處：手動任務進隊（insert_dispatch）、seed 的缺口；排序（queue_at）近的在前、已投完的在最後；投票日過了之後 seed 改用「已投完」公式
 *   D. 取代舊的選舉鏈排序：前段／後段規則停用（manual_visitor 等不是日期定層的規則還在）、seed 不再有「日期定層」
 *   E. 驗證票鍵：基準沿用母任務派出前位置、−14 天、＋步長（一般 7 天、no_change 14 天）× 領走次數、插隊不因領走歸零；新增型基準＝建立時間 − 選舉月基準
 *   F. 還原驗證：選舉月那一行拿掉、公式改成 INTEGER／加錯、步長拿掉，上面的斷言就紅
 */
import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { clock, freshDb, jpMigrationNames, mutate, one, readMig, rows, seed } from "./policy-jp-chain-db.ts";

const TODAY = "2026-11-22";
const KEY_FILE = "20261122190000_policy_jp_verify_ticket_key_election_month.sql";
const DAY = 86400;

type Lg = { lg_code: string };
let lgs: string[] | null = null;
/** 團體碼表（總務省）裡的市：每場選舉一個不同的團體 */
async function cityCodes(db: PGlite): Promise<string[]> {
  if (!lgs) lgs = (await rows<Lg>(db, `SELECT lg_code FROM policy_jp.lg_code_registry WHERE kind = 'city' ORDER BY lg_code LIMIT 12`)).map((r) => r.lg_code);
  return lgs;
}
async function insertLg(db: PGlite, code: string): Promise<void> {
  const r = await one<{ lg_code: string; pref_code: string; name: string; kana: string; kind: string }>(db,
    `SELECT lg_code, pref_code, name, kana, kind FROM policy_jp.lg_code_registry WHERE lg_code = $1`, [code]);
  if (r.pref_code !== code) await insertLg(db, r.pref_code);
  await db.query(`INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ($1, $2, $3, $4, $5, $1) ON CONFLICT DO NOTHING`,
    [r.lg_code, r.kind, r.pref_code, r.name, r.kana]);
}
async function insertElection(db: PGlite, nth: number, date: string): Promise<string> {
  const lg = (await cityCodes(db))[nth];
  const id = `${date}_mayor_${lg}`;
  await insertLg(db, lg);
  await db.query(
    `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code, review_status)
     VALUES ($1, $2, $3, 'mayor', 'regular', policy_jp.election_level('mayor'), $4, 'published')`, [id, `${id}選挙`, date, lg]);
  return id;
}
const days = async (db: PGlite, eid: string | null, target: Record<string, unknown> | null = null): Promise<number> =>
  Number((await one<{ s: string }>(db, `SELECT policy_jp.election_month_seconds($1, $2::JSONB)::TEXT AS s`, [eid, target === null ? null : JSON.stringify(target)])).s) / DAY;
const mkTask = async (db: PGlite, source: string, target: Record<string, unknown>): Promise<string> =>
  (await one<{ id: string }>(db, `INSERT INTO policy_jp.contribution_tasks (title, task_type, target, source) VALUES ($1, 'profile_note', $2::JSONB, $3) RETURNING id::TEXT AS id`,
    [`手動 ${source}`, JSON.stringify(target), source])).id;
let seq = 0;
const mkContribution = async (db: PGlite, type: string, taskId: string | null, payload: Record<string, unknown> = {}): Promise<string> => {
  const n = ++seq;
  return (await one<{ id: string }>(db,
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash)
     VALUES ($1, $2::JSONB, ARRAY['https://example.jp/a'], $3, $4, $5, $6) RETURNING id::TEXT AS id`,
    [type, JSON.stringify(payload), taskId, `agent-${n}`, `ip-${n}`, `hash-${n}`])).id;
};
const disp = (db: PGlite, taskId: string) => one<{ priority_seconds: string; queue_at: string; dispatch_base_at: string | null; dispatch_count: number; boost_seconds: string; last_dispatched_at: string }>(db,
  `SELECT priority_seconds::TEXT, queue_at::TEXT, dispatch_base_at::TEXT, dispatch_count, boost_seconds::TEXT, last_dispatched_at::TEXT FROM policy_jp.task_dispatches WHERE task_id = $1`, [taskId]);
const secs = async (db: PGlite, sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(db, sql, params)).n);
/** 兩個 timestamptz 相差幾秒（a − b） */
const diffSec = (db: PGlite, a: string, b: string) => secs(db, `SELECT extract(epoch FROM ($1::TIMESTAMPTZ - $2::TIMESTAMPTZ))::TEXT AS n`, [a, b]);

// =============================================================================================
// A. 數值抽查
// =============================================================================================
Deno.test("A 數值：2026-11 的未來選舉 175,400 天、2027-02 174,800 天、相鄰月差 200 天；已投完的 M×200−300,000 天（負的、較近的較大）、未來一律大於已投完", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  const nov = await insertElection(db, 0, "2026-11-29");
  const dec = await insertElection(db, 1, "2026-12-13");
  const feb = await insertElection(db, 2, "2027-02-21");
  const oct = await insertElection(db, 3, "2026-10-25"); // 已投完
  const apr = await insertElection(db, 4, "2026-04-12"); // 已投完、更早
  assertEquals(await days(db, nov), 175400);
  assertEquals(await days(db, dec), 175200);
  assertEquals(await days(db, feb), 174800);
  assertEquals((await days(db, nov)) - (await days(db, dec)), 200);
  // 已投完：M = 26×12+10 = 322 → 322×200 − 300,000 = −235,600；2026-04 → 316 → −236,800
  assertEquals(await days(db, oct), -235600);
  assertEquals(await days(db, apr), -236800);
  assert((await days(db, oct)) > (await days(db, apr)), "已投完的之間，較近的較大（較先派）");
  assert((await days(db, feb)) > (await days(db, oct)), "最遠的未來選舉也比最近的已投完大");
  // 當天投票的算未來（投票日 >= 今天）
  const today = await insertElection(db, 5, TODAY);
  assertEquals(await days(db, today), (1200 - (26 * 12 + 11)) * 200);
  // 秒數不是 INTEGER：175,400 天 ＝ 1.5×10^10 秒，欄位與排序鍵都放得下
  assertEquals(await secs(db, `SELECT policy_jp.election_month_seconds($1, NULL)::TEXT AS n`, [nov]), 175400 * DAY);
  assertEquals((await one<{ t: string }>(db, `SELECT data_type AS t FROM information_schema.columns WHERE table_schema = 'policy_jp' AND table_name = 'task_dispatches' AND column_name = 'priority_seconds'`)).t, "bigint");
});

Deno.test("B 沒掛選舉的件＝最近一場未來選舉的月；target 帶自己日期的用那個日期；查無選舉 id 同沒掛", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  await insertElection(db, 0, "2026-12-13"); // 最近的未來選舉：2026-12（M=324）
  await insertElection(db, 1, "2027-02-21");
  await insertElection(db, 2, "2026-10-25"); // 已投完的不算「最近的未來」
  assertEquals(await days(db, null), 175200);
  assertEquals(await days(db, "不存在的選舉"), 175200);
  assertEquals(await days(db, null, {}), 175200);
  assertEquals(await days(db, null, { election_date: "2027-02-21" }), 174800, "選舉發現／等團體落庫的缺口：用 target 自己的選舉日");
  assertEquals(await days(db, null, { vote_window_from: "2027-02-01" }), 174800);
  assertEquals(await days(db, null, { election_date: "2026-10-25" }), -235600, "target 的日期已經過了＝已投完");
  // 沒有任何未來選舉：當今天的月（不丟錯、不回 NULL）
  const db2 = await freshDb();
  await clock(db2, TODAY);
  assertEquals(await days(db2, null), 175400);
});

// =============================================================================================
// C. 疊進 priority_seconds（手動任務、seed）與排序
// =============================================================================================
Deno.test("C 手動任務進隊：priority_seconds＝規則秒數＋選舉月基準；近的選舉排前面、已投完的最後（差 200 天一階）；沒掛選舉的＝最近未來選舉的月", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  const nov = await insertElection(db, 0, "2026-11-29");
  const feb = await insertElection(db, 1, "2027-02-21");
  const oct = await insertElection(db, 2, "2026-10-25");
  const tNov = await mkTask(db, "suggested", { election_id: nov });
  const tFeb = await mkTask(db, "suggested", { election_id: feb });
  const tOct = await mkTask(db, "suggested", { election_id: oct });
  const tNone = await mkTask(db, "suggested", {});
  const rule = await secs(db, `SELECT COALESCE((SELECT x.seconds FROM policy_jp.activity_priority_seconds('manual_open', NULL, NULL) x LIMIT 1), 0)::TEXT AS n`);
  for (const [t, d] of [[tNov, 175400], [tFeb, 174800], [tOct, -235600], [tNone, 175400]] as Array<[string, number]>) {
    assertEquals(Number((await disp(db, t)).priority_seconds), rule + d * DAY, t);
  }
  // 排序：近的先；同時進隊，差距就是月基準的差（誤差 < 1 分鐘）
  const q = async (t: string) => (await disp(db, t)).queue_at;
  assertAlmostEquals(await diffSec(db, await q(tFeb), await q(tNov)), 600 * DAY, 60); // 2027-02 比 2026-11 晚 600 天（3 個月 × 200 天）
  assert((await diffSec(db, await q(tOct), await q(tFeb))) > 0, "已投完的排在所有未來選舉之後");
  assertAlmostEquals(await diffSec(db, await q(tNone), await q(tNov)), 0, 60);
});

Deno.test("C seed 的缺口：priority_seconds＝選舉月基準（規則停用後不再疊前段／後段）；投票日過了，下一輪 seed 改用已投完公式、排到最後", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  await db.query(`DELETE FROM policy_jp.term_expirations`);
  const near = await insertElection(db, 0, "2026-12-13");
  const far = await insertElection(db, 1, "2027-02-21");
  await seed(db);
  const gaps = () => rows<{ task_id: string; eid: string; ps: string; qa: string }>(db,
    `SELECT task_id, target->>'election_id' AS eid, priority_seconds::TEXT AS ps, queue_at::TEXT AS qa FROM policy_jp.task_dispatches
      WHERE task_id LIKE 'auto:%' AND target->>'election_id' IN ($1, $2) ORDER BY queue_at, task_id`, [near, far]);
  const g1 = await gaps();
  assert(g1.length >= 2, "兩場選舉都有缺口");
  for (const g of g1) assertEquals(Number(g.ps), (await days(db, g.eid)) * DAY, `${g.task_id} 的優先秒數＝選舉月基準（沒有前段／後段加減）`);
  assertEquals(g1[0].eid, near, "近的選舉在前");
  assertEquals(g1[g1.length - 1].eid, far);
  // 投票日過了：近的那場變已投完，排到遠的後面
  await clock(db, "2026-12-14");
  await seed(db);
  const g2 = await gaps();
  assertEquals(g2[0].eid, far, "已投完的選舉排在未來選舉之後");
  for (const g of g2.filter((x) => x.eid === near)) assertEquals(Number(g.ps), (await days(db, near)) * DAY);
  assertEquals(await days(db, near), (26 * 12 + 12) * 200 - 300000);
});

// =============================================================================================
// D. 取代舊的選舉鏈排序
// =============================================================================================
Deno.test("D 舊的選舉鏈排序被取代：priority:<臂> 的前段（polling −60）／後段（polling −181）規則全停用、備份留著；不是日期定層的規則照舊；seed 沒有日期定層", async () => {
  const db = await freshDb();
  const left = await rows<{ activity: string }>(db,
    `SELECT activity FROM policy_jp.activity_rules WHERE activity LIKE 'priority:%' AND enabled AND ((from_kind = 'polling' AND from_offset = -60) OR (until_kind = 'polling' AND until_offset = -181))`);
  assertEquals(left, []);
  const kept = (await rows<{ activity: string }>(db, `SELECT activity FROM policy_jp.activity_rules WHERE activity LIKE 'priority:%' AND enabled ORDER BY activity`)).map((r) => r.activity);
  assert(kept.includes("priority:manual_visitor"), "網站請求的規則還在");
  assert(kept.includes("priority:news_discovery") && kept.includes("priority:term_policies"), "不是日期定層的規則還在");
  // 備份表有規則改前的狀態（回滾用）
  const b = await one<{ n: string; off: string }>(db, `SELECT count(*)::TEXT AS n, count(*) FILTER (WHERE enabled)::TEXT AS off FROM policy_jp.priority_backup_20261122_rules`);
  assert(Number(b.n) > 30 && Number(b.off) === Number(b.n), "備份留的是改前的值（當時全部開著）");
  const sql = await readMig(KEY_FILE);
  const seedFn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION policy_jp.seed_auto_task_queue("));
  assert(!seedFn.includes("chain_date_tier") && !seedFn.includes("日本版：選舉發現的層"), "seed 不再用日期定層");
  assert(seedFn.includes("policy_jp.election_month_seconds("), "seed 疊選舉月基準");
});

// =============================================================================================
// E. 驗證票排序鍵
// =============================================================================================
Deno.test("E 驗證票：基準＝母任務派出前的位置；queue_at＝基準 − 14 天；每被領走一次 ＋7 天（no_change ＋14 天）；插隊不因領走歸零；任務列照舊歸零", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  const nov = await insertElection(db, 0, "2026-11-29");
  const parent = await mkTask(db, "suggested", { election_id: nov });
  const p0 = await disp(db, parent);
  // 母任務被領走：記下派出前的位置（含優先秒數＝選舉月基準）、插隊歸零、位置回隊尾
  await db.query(`UPDATE policy_jp.task_dispatches SET boost_seconds = 5000 WHERE task_id = $1`, [parent]);
  const before = await disp(db, parent);
  await db.query(`SELECT policy_jp.task_dispatched($1)`, [parent]);
  const p1 = await disp(db, parent);
  assertEquals(Number(p1.boost_seconds), 0, "任務列：派出就歸零");
  assertEquals(p1.dispatch_base_at, (await one<{ t: string }>(db, `SELECT policy_jp.task_queue_key($1::TIMESTAMPTZ, $2::BIGINT, NULL, $3::BIGINT)::TEXT AS t`, [p0.last_dispatched_at, p0.priority_seconds, "5000"])).t);
  assert(p1.dispatch_base_at !== null && p1.queue_at > before.queue_at, "派出後任務回隊尾");
  // 交件（一般型別）：票的基準＝母任務列的基準；queue_at＝基準 − 14 天
  const c1 = await mkContribution(db, "correction", parent);
  const c2 = await mkContribution(db, "no_change", parent);
  for (const [c, step] of [[c1, 7], [c2, 14]] as Array<[string, number]>) {
    const t = `verify:${c}`;
    const v0 = await disp(db, t);
    assertEquals(v0.dispatch_base_at, p1.dispatch_base_at, "票沿用母任務的基準");
    assertAlmostEquals(await diffSec(db, p1.dispatch_base_at!, v0.queue_at), 14 * DAY, 1);
    await db.query(`UPDATE policy_jp.task_dispatches SET boost_seconds = 777 WHERE task_id = $1`, [t]);
    await db.query(`SELECT policy_jp.task_dispatched($1)`, [t]);
    const v1 = await disp(db, t);
    assertEquals(v1.dispatch_count, 1);
    assertEquals(Number(v1.boost_seconds), 777, "驗證票的插隊不因領走歸零");
    assertEquals(v1.dispatch_base_at, p1.dispatch_base_at, "基準凍結在票上，不再看母任務");
    // queue_at ＝ 基準 − 14 天 − 777 ＋ 步長 × 1
    assertAlmostEquals(await diffSec(db, v1.queue_at, p1.dispatch_base_at!), -14 * DAY - 777 + step * DAY, 1, `${t} 步長 ${step} 天`);
  }
  // 母任務之後被領走，已存在的票不跟著動
  const frozen = (await disp(db, `verify:${c1}`)).queue_at;
  await db.query(`SELECT policy_jp.task_dispatched($1)`, [parent]);
  await db.query(`SELECT policy_jp.refresh_verify_ticket_keys()`);
  assertEquals((await disp(db, `verify:${c1}`)).queue_at, frozen);
});

Deno.test("E 新增型交件與沒有基準的票：基準＝建立時間 − 選舉月基準（交件 payload.election_id）；沒有選舉＝最近未來選舉的月；凍結基準的反運算＝原位置", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  const nov = await insertElection(db, 0, "2026-11-29");
  const feb = await insertElection(db, 1, "2027-02-21");
  const cNov = await mkContribution(db, "task_suggestion", null, { election_id: nov });
  const cFeb = await mkContribution(db, "task_suggestion", null, { election_id: feb });
  const cNone = await mkContribution(db, "task_suggestion", null, {});
  const created = async (c: string) => (await one<{ t: string }>(db, `SELECT created_at::TEXT AS t FROM policy_jp.contributions WHERE id = $1::UUID`, [c])).t;
  for (const [c, d] of [[cNov, 175400], [cFeb, 174800], [cNone, 175400]] as Array<[string, number]>) {
    const v = await disp(db, `verify:${c}`);
    assertAlmostEquals(await diffSec(db, await created(c), v.dispatch_base_at!), d * DAY, 1, "基準＝建立時間 − 選舉月基準");
    assertAlmostEquals(await diffSec(db, await created(c), v.queue_at), d * DAY + 14 * DAY, 1, "queue_at＝基準 − 14 天");
  }
  // 母任務沒有基準（沒經過 /next 派出就交件）：同樣退回建立時間
  const parent = await mkTask(db, "suggested", { election_id: feb });
  const c = await mkContribution(db, "correction", parent, { election_id: feb });
  assertAlmostEquals(await diffSec(db, await created(c), (await disp(db, `verify:${c}`)).dispatch_base_at!), 174800 * DAY, 1);
  // 凍結基準的反運算：key(freeze(q, n, b, s), n, b, s) ＝ q
  const r = await one<{ same: boolean }>(db,
    `SELECT policy_jp.verify_ticket_key(policy_jp.verify_ticket_freeze_base(t.q, 3, 123, 604800), 3, 123, 604800) = t.q AS same FROM (SELECT TIMESTAMPTZ '2026-10-30 12:00:00+00' AS q) t`);
  assert(r.same);
});

Deno.test("E 日本站不帶台灣後來的東西：沒有 verify_follows_task／verify_rank 欄；插隊對驗證票是加秒數（task_boost_remaining 看 boost_seconds，不看年份）", async () => {
  const db = await freshDb();
  const cols = (await rows<{ column_name: string }>(db, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'policy_jp' AND table_name = 'task_dispatches'`)).map((r) => r.column_name);
  for (const bad of ["verify_follows_task", "verify_rank", "verify_has_votes"]) assert(!cols.includes(bad), bad);
  assert(cols.includes("dispatch_base_at"));
  const fn = (await one<{ def: string }>(db, `SELECT pg_get_functiondef('policy_jp.task_boost_remaining(bigint)'::regprocedure) AS def`)).def;
  assert(!fn.includes("1990-01-01"), "選舉月基準讓很多列的 queue_at 早於 1990 年，不能用年份判斷插隊");
});

// =============================================================================================
// F. 還原驗證
// =============================================================================================
async function dbWith(patch: (sql: string) => string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
  for (const n of await jpMigrationNames()) {
    const sql = await readMig(n);
    await db.exec(n === KEY_FILE ? patch(sql) : sql);
  }
  return db;
}

Deno.test("F 還原驗證：手動任務進隊少加選舉月基準、未來／已投完公式互換，斷言就紅", async () => {
  const a = await dbWith((s) => mutate(s, "+ policy_jp.election_month_seconds(policy_jp.election_id_or_null(m.target->>'election_id'), m.target),  -- 選舉月基準", "+ 0,  -- 選舉月基準"));
  await clock(a, TODAY);
  const e1 = await insertElection(a, 0, "2026-11-29");
  const t1 = await mkTask(a, "suggested", { election_id: e1 });
  assertNotEquals(Number((await disp(a, t1)).priority_seconds), 175400 * DAY);
  const b = await dbWith((s) => mutate(s, "THEN (1200 - d.m)::BIGINT * 200", "THEN (1100 - d.m)::BIGINT * 200"));
  await clock(b, TODAY);
  const e2 = await insertElection(b, 0, "2026-11-29");
  assertNotEquals(await days(b, e2), 175400);
});
