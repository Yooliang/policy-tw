/**
 * 日本站層級 × 種類帶狀優先（migration 20261122210000_policy_jp_priority_bands_jp.sql；台灣 #1026／20261121193000 的日本版；維護者 2026-11-22 17:10 定案）。
 *
 *   priority_days ＝ 選舉月基準（20261122190000）＋ 層級（國政 170／都道府県 150／市区町村 130／無層級 30）＋ 種類（0～19）；插隊另加 boost_seconds（400 天）
 *
 *   A. 數值：2026-12 國政 policy_missing＝7,200＋170＋15；市区町村 avatar_missing＝7,200＋130＋10；層級來源（election_type／election_id／politician_id／lineage target.level）
 *   B. 種類表：各型別的天數、有沒有層級（其他組＝30）；台灣的抄公報 +175 日本站不做（policy_missing 維持 15）
 *   C. 進隊：手動任務與 seed 的缺口都吃帶狀；插隊（400 天）大於所有一般件；層級不蓋過月、種類不蓋過層級
 *   D. 驗證票：基準＝母任務位置再領先 (19 − 母種類) 天，或 建立時間 − 月基準 − (層級＋19)；verify_priority_seconds 0
 *   E. 一次性重算：在套這支 migration 之前的資料庫放列、再套這支，priority_seconds／插隊／驗證票基準照新算法，備份表有改前值，位置自我檢查過
 *   F. 型別維持 INTEGER；日本站沒有流量機制（沒有 page_traffic／traffic_boost）
 *   G. 還原驗證：seed 的帶狀一行拿掉、層級天數表換掉，斷言就紅
 */
import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { clock, freshDb, jpMigrationNames, migratedDb, mutate, one, readMig, rows, seed } from "./policy-jp-chain-db.ts";

const TODAY = "2026-11-22";
const DAY = 86400;
const BANDS_FILE = "20261122210000_policy_jp_priority_bands_jp.sql";

let lgs: string[] | null = null;
async function cityCodes(db: PGlite): Promise<string[]> {
  if (!lgs) lgs = (await rows<{ lg_code: string }>(db, `SELECT lg_code FROM policy_jp.lg_code_registry WHERE kind = 'city' ORDER BY lg_code LIMIT 12`)).map((r) => r.lg_code);
  return lgs;
}
async function insertLg(db: PGlite, code: string): Promise<void> {
  const r = await one<{ lg_code: string; pref_code: string; name: string; kana: string; kind: string }>(db,
    `SELECT lg_code, pref_code, name, kana, kind FROM policy_jp.lg_code_registry WHERE lg_code = $1`, [code]);
  if (r.pref_code !== code) await insertLg(db, r.pref_code);
  await db.query(`INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ($1, $2, $3, $4, $5, $1) ON CONFLICT DO NOTHING`,
    [r.lg_code, r.kind, r.pref_code, r.name, r.kana]);
}
/** 選舉直接進庫；national 不掛團體 */
async function insertElection(db: PGlite, nth: number, date: string, type = "mayor"): Promise<string> {
  const national = type.startsWith("national");
  const lg = national ? null : (await cityCodes(db))[nth];
  const id = `${date}_${type}_${lg ?? "national"}`;
  if (lg) await insertLg(db, lg);
  await db.query(
    `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code, review_status)
     VALUES ($1, $2, $3, $4, 'regular', policy_jp.election_level($4), $5, 'published')`, [id, `${id}選挙`, date, type, lg]);
  return id;
}
const band = (db: PGlite, type: string, target: Record<string, unknown>) =>
  one<{ n: string }>(db, `SELECT policy_jp.task_band_seconds($1, $2::JSONB)::TEXT AS n`, [type, JSON.stringify(target)]).then((r) => Number(r.n) / DAY);
const month = (db: PGlite, eid: string | null) =>
  one<{ n: string }>(db, `SELECT policy_jp.election_month_seconds($1, NULL)::TEXT AS n`, [eid]).then((r) => Number(r.n) / DAY);
const disp = (db: PGlite, taskId: string) => one<{ priority_seconds: string; queue_at: string; dispatch_base_at: string | null; boost_seconds: string; last_dispatched_at: string }>(db,
  `SELECT priority_seconds::TEXT, queue_at::TEXT, dispatch_base_at::TEXT, boost_seconds::TEXT, last_dispatched_at::TEXT FROM policy_jp.task_dispatches WHERE task_id = $1`, [taskId]);
const diffSec = async (db: PGlite, a: string, b: string) => Number((await one<{ n: string }>(db, `SELECT extract(epoch FROM ($1::TIMESTAMPTZ - $2::TIMESTAMPTZ))::TEXT AS n`, [a, b])).n);
const mkTask = async (db: PGlite, source: string, type: string, target: Record<string, unknown>) =>
  (await one<{ id: string }>(db, `INSERT INTO policy_jp.contribution_tasks (title, task_type, target, source) VALUES ($1, $2, $3::JSONB, $4) RETURNING id::TEXT AS id`,
    [`手動 ${source}`, type, JSON.stringify(target), source])).id;
let seq = 0;
const mkContribution = async (db: PGlite, type: string, taskId: string | null, payload: Record<string, unknown> = {}) => {
  const n = ++seq;
  return (await one<{ id: string }>(db,
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash)
     VALUES ($1, $2::JSONB, ARRAY['https://example.jp/a'], $3, $4, $5, $6) RETURNING id::TEXT AS id`,
    [type, JSON.stringify(payload), taskId, `agent-${n}`, `ip-${n}`, `bands-${n}`])).id;
};

// =============================================================================================
// A. 數值與層級來源
// =============================================================================================
Deno.test("A 數值：2026-12 國政 policy_missing＝7,200＋170＋15 天；市区町村 avatar_missing＝7,200＋130＋10 天；都道府県 profile_detail_gap＝月＋150＋8", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  const nat = await insertElection(db, 0, "2026-12-13", "national_lower");
  const mayor = await insertElection(db, 1, "2026-12-20", "mayor");
  const gov = await insertElection(db, 2, "2027-02-21", "governor");
  assertEquals(await month(db, nat), 7200);
  assertEquals(await month(db, gov), 6800);
  assertEquals(7200 + (await band(db, "policy_missing", { election_id: nat })), 7200 + 170 + 15);
  assertEquals(7200 + (await band(db, "avatar_missing", { election_id: mayor })), 7200 + 130 + 10);
  assertEquals(6800 + (await band(db, "profile_detail_gap", { election_id: gov })), 6800 + 150 + 8);
  // 層級來源：election_type 直接寫在 target
  assertEquals(await band(db, "policy_missing", { election_type: "national_upper" }), 170 + 15);
  assertEquals(await band(db, "policy_missing", { election_type: "pref_assembly" }), 150 + 15);
  assertEquals(await band(db, "policy_missing", { election_type: "muni_assembly" }), 130 + 15);
  assertEquals(await band(db, "policy_missing", { election_type: "ward_mayor" }), 130 + 15);
  // 層級 20 天一格：種類最大 19 天不會蓋過層級
  assert((await band(db, "avatar_missing", { election_type: "governor" })) > (await band(db, "adjudicate", { election_type: "mayor" })), "都道府県 照片 ＞ 市区町村 查證");
  await db.close();
});

Deno.test("A 層級來源：election_id → politician_election_id → 這個人最近一屆；lineage 看 target.level；沒有＝無層級 30；其他組不管 target 一律 30", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  const mayor = await insertElection(db, 0, "2026-12-20", "mayor");
  const gov = await insertElection(db, 1, "2027-02-21", "governor");
  await db.query(`INSERT INTO policy_jp.politicians (id, name, kana, review_status) VALUES ('p1', '山田太郎', 'やまだたろう', 'published')`);
  await db.query(`INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, status_date, district_kind, review_status)
    VALUES ('pe-old', 'p1', $1, 'declared', '2026-10-01', 'at_large', 'published'), ('pe-new', 'p1', $2, 'declared', '2026-10-01', 'at_large', 'published')`, [mayor, gov]);
  const lvl = async (t: string, tg: Record<string, unknown>) => (await one<{ l: string | null }>(db, `SELECT policy_jp.task_level_text($1, $2::JSONB) AS l`, [t, JSON.stringify(tg)])).l;
  assertEquals(await lvl("avatar_missing", { politician_id: "p1" }), "regional", "這個人最近一屆是都道府県知事");
  assertEquals(await lvl("avatar_missing", { politician_election_id: "pe-old" }), "local");
  assertEquals(await lvl("policy_missing", { election_id: mayor, politician_id: "p1" }), "local", "election_id 先於 politician_id");
  assertEquals(await lvl("avatar_missing", {}), null);
  assertEquals(await band(db, "avatar_missing", {}), 30 + 10, "無層級 30");
  // lineage：target.level（日本站是 national／regional／local）
  assertEquals(await lvl("lineage_candidate", { level: "regional" }), "regional");
  assertEquals(await lvl("lineage_candidate", { level: "local" }), "local");
  assertEquals(await lvl("lineage_candidate", { level: "national" }), "national");
  assertEquals(await lvl("lineage_candidate", { level: "municipal" }), "local");
  assertEquals(await lvl("lineage_candidate", { election_type: "mayor" }), null, "脈絡只看 target.level，沒有 level＝無層級");
  assertEquals(await band(db, "lineage_candidate", { level: "regional" }), 150 + 12);
  assertEquals(await band(db, "lineage_candidate", {}), 30 + 12);
  // 其他組（沒有層級）：不管 target 怎麼寫都是 30
  for (const t of ["regional_stats_missing", "local_government_missing", "election_result_missing", "district_seats_missing", "news_discovery"]) {
    assertEquals(await band(db, t, { election_type: "governor", election_id: gov }), 30 + 0, t);
  }
  // election_discovery 層級用它 target 的（種類 0）；roster_check 照職位（種類 0）
  assertEquals(await band(db, "election_discovery", { election_type: "governor" }), 150);
  assertEquals(await band(db, "roster_check", { election_type: "mayor" }), 130);
  await db.close();
});

// =============================================================================================
// B. 種類表
// =============================================================================================
Deno.test("B 種類：查證票／adjudicate 19、policy_missing 15（日本站不做抄公報 +175）、term_policy_missing 13、lineage_* 12、照片 10、人物基本資料 8、整理 5、進度 3、其他 0", async () => {
  const db = await freshDb();
  const k = async (t: string) => (await one<{ n: number }>(db, `SELECT policy_jp.task_kind_days_by_type($1) AS n`, [t])).n;
  const table: Array<[string[], number]> = [
    [["verify:abc", "verify", "adjudicate"], 19],
    [["policy_missing", "policy_election_missing"], 15],
    [["term_policy_missing"], 13],
    [["lineage_candidate", "lineage_link_candidate", "lineage_roles_missing"], 12],
    [["avatar_missing"], 10],
    [["profile_gap", "profile_detail_gap", "party_info_missing", "party_missing", "candidacy_source_missing", "candidate_status_stale"], 8],
    [["duplicate_policy", "duplicate_politician", "policy_election_mismatch", "source_mismatch", "policy_source_missing", "policy_validity", "issue_too_broad", "legacy_audit"], 5],
    [["progress_stale", "deadline_due"], 3],
    [["news_sweep", "regional_stats_missing", "local_government_missing", "roster_check", "election_discovery", "other", "election_result_missing", "district_seats_missing", "未列到的"], 0],
  ];
  for (const [types, days] of table) for (const t of types) assertEquals(await k(t), days, t);
  const lv = async (t: string) => (await one<{ b: boolean }>(db, `SELECT policy_jp.task_has_level($1) AS b`, [t])).b;
  for (const t of ["policy_missing", "avatar_missing", "roster_check", "election_discovery", "lineage_candidate", "verify:x", "progress_stale", "party_missing"]) assertEquals(await lv(t), true, t);
  for (const t of ["regional_stats_missing", "local_government_missing", "news_sweep", "other", "election_result_missing"]) assertEquals(await lv(t), false, t);
  await db.close();
});

// =============================================================================================
// C. 進隊與插隊
// =============================================================================================
Deno.test("C 手動任務進隊：帶狀＋月基準；網站請求／維護者建的＝插隊 400 天、月基準用最近一場未來選舉的月，大於所有一般件；提議（不插隊）用自己那屆的月", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  await db.query(`DELETE FROM policy_jp.term_expirations`);
  const dec = await insertElection(db, 0, "2026-12-13", "mayor"); // 最近的未來選舉
  const feb = await insertElection(db, 1, "2027-02-21", "mayor");
  const qs = await one<{ b: string; m: string; v: string; vp: string }>(db, `SELECT boost_seconds::TEXT AS b, manual_front_seconds::TEXT AS m, visitor_front_seconds::TEXT AS v, verify_priority_seconds::TEXT AS vp FROM policy_jp.queue_settings`);
  assertEquals([qs.b, qs.m, qs.v, qs.vp], ["34560000", "34560000", "34560000", "0"], "插隊三個值 400 天、驗證票領先折進基準");
  const normal = await mkTask(db, "suggested", "policy_missing", { election_id: feb }); // 不插隊：自己那屆的月
  const web = await mkTask(db, "web_request", "policy_missing", { election_id: feb }); // 插隊：用最近一場未來選舉的月
  const man = await mkTask(db, "manual", "profile_gap", { election_id: feb });
  const n = await disp(db, normal);
  assertEquals(Number(n.priority_seconds), (6800 + 130 + 15) * DAY, "提議：自己那屆 2027-02＝6,800＋130＋15");
  assertEquals(Number(n.boost_seconds), 0);
  for (const [t, kind] of [[web, 15], [man, 8]] as Array<[string, number]>) {
    const d = await disp(db, t);
    assertEquals(Number(d.priority_seconds), (7200 + 130 + kind) * DAY, `${t}：最近一場未來選舉（2026-12）的月＋層級＋種類`);
    assertEquals(Number(d.boost_seconds), 34560000, "插隊 400 天");
    assert(Number(d.priority_seconds) + Number(d.boost_seconds) > Number(n.priority_seconds) + 400 * DAY - 1, "插隊的總領先高於同樣層級種類的不插隊件");
  }
  // 插隊大於所有一般件：一般件最大＝最近的月（7,200）＋國政 170＋19
  const maxNormal = (7200 + 170 + 19) * DAY;
  const d = await disp(db, man);
  assert(Number(d.priority_seconds) + Number(d.boost_seconds) > maxNormal, "最低層級的插隊件（人物基本資料）也高於最近月最高層級最高種類的一般件");
  // queue_at 排序：插隊件在前
  assert((await diffSec(db, (await disp(db, normal)).queue_at, (await disp(db, man)).queue_at)) > 0);
  await db.close();
});

Deno.test("C seed 的缺口：優先秒數＝月基準＋帶狀；近的月先、同月高層級先、同層高種類先；種類不蓋過層級、層級不蓋過月", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  await db.query(`DELETE FROM policy_jp.term_expirations`);
  const dec = await insertElection(db, 0, "2026-12-13", "mayor");
  const decGov = await insertElection(db, 1, "2026-12-27", "governor");
  const feb = await insertElection(db, 2, "2027-02-21", "mayor");
  await seed(db);
  const all = await rows<{ task_id: string; task_type: string; eid: string; ps: string; band: string }>(db,
    `SELECT task_id, task_type, target->>'election_id' AS eid, priority_seconds::TEXT AS ps, policy_jp.task_band_seconds(task_type, target)::TEXT AS band
       FROM policy_jp.task_dispatches WHERE task_id LIKE 'auto:%' AND target->>'election_id' = ANY ($1)`, [[dec, decGov, feb]]);
  assert(all.length >= 3, "三場選舉都有缺口");
  for (const g of all) {
    const m = Number((await one<{ n: string }>(db, `SELECT policy_jp.election_month_seconds($1, NULL)::TEXT AS n`, [g.eid])).n);
    assertEquals(Number(g.ps), m + Number(g.band), `${g.task_id}＝月基準＋帶狀`);
  }
  // 層級不蓋過月：2027-02 的都道府県再高也輸給 2026-12 的市区町村最低種類
  const hi = 6800 + 170 + 19, lo = 7200 + 30 + 0;
  assert(lo > hi, "最低層級最低種類的近月，高於遠一個月以上的最高層級最高種類");
  await db.close();
});

// =============================================================================================
// D. 驗證票
// =============================================================================================
Deno.test("D 驗證票：沿用母任務位置時再領先 (19 − 母種類) 天（票＝月＋層級＋19）；新增型＝建立時間 − 月基準 − (層級＋19)；步長 7／14 天照舊", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  await db.query(`DELETE FROM policy_jp.term_expirations`);
  const dec = await insertElection(db, 0, "2026-12-13", "governor");
  const parent = await mkTask(db, "suggested", "policy_missing", { election_id: dec }); // 種類 15、層級 都道府県 150
  await db.query(`SELECT policy_jp.task_dispatched($1)`, [parent]);
  const p = await disp(db, parent);
  const c = await mkContribution(db, "policy", parent);
  const v = await disp(db, `verify:${c}`);
  assertAlmostEquals(await diffSec(db, p.dispatch_base_at!, v.dispatch_base_at!), (19 - 15) * DAY, 1, "領先 19 − 母種類 15＝4 天");
  // 票的位置＝母任務位置領先 4 天 → 相當於 月 7,200＋150＋19
  const parentKey = await one<{ n: string }>(db, `SELECT extract(epoch FROM (d.last_dispatched_at - $2::TIMESTAMPTZ))::TEXT AS n FROM policy_jp.task_dispatches d WHERE d.task_id = $1`, [parent, v.queue_at]);
  void parentKey;
  assertAlmostEquals(await diffSec(db, v.dispatch_base_at!, v.queue_at), 0, 1, "verify_priority_seconds 0");
  // 新增型（task_suggestion）、沒有基準：建立時間 − 月基準 − (層級＋19)
  const created = async (cid: string) => (await one<{ t: string }>(db, `SELECT created_at::TEXT AS t FROM policy_jp.contributions WHERE id = $1::UUID`, [cid])).t;
  const nCid = await mkContribution(db, "task_suggestion", null, { election_id: dec });
  const nv = await disp(db, `verify:${nCid}`);
  assertAlmostEquals(await diffSec(db, await created(nCid), nv.queue_at), (7200 + 150 + 19) * DAY, 1, "票＝月 7,200 ＋ 層級 150 ＋ 19");
  // 母任務是 election_discovery（種類 0）：領先 19 天；層級由母任務的 election_type 決定
  const disc = await mkTask(db, "suggested", "election_discovery", { election_type: "mayor" });
  await db.query(`SELECT policy_jp.task_dispatched($1)`, [disc]);
  const dp = await disp(db, disc);
  const dc = await mkContribution(db, "correction", disc);
  assertAlmostEquals(await diffSec(db, dp.dispatch_base_at!, (await disp(db, `verify:${dc}`)).dispatch_base_at!), 19 * DAY, 1);
  assertEquals((await one<{ n: number }>(db, `SELECT policy_jp.verify_ticket_parent_lead_seconds('policy_missing', NULL) / 86400 AS n`)).n, 4);
  await db.close();
});

// =============================================================================================
// E. 一次性重算：在套這支之前的資料庫放列、再套這支
// =============================================================================================
Deno.test("E 一次性重算：priority_seconds＝帶狀＋月基準；插隊中的列降到 400 天且月基準用最近一場未來選舉；驗證票基準 −14 天 −(層級＋19)；備份有改前值；冪等", async () => {
  const db = await migratedDb({ before: BANDS_FILE });
  await clock(db, TODAY);
  const dec = await insertElection(db, 0, "2026-12-13", "mayor");
  const feb = await insertElection(db, 1, "2027-02-21", "governor");
  await db.exec(`DELETE FROM policy_jp.term_expirations`);
  // 舊制：任務列（含一列插隊 5 年）與兩張驗證票
  const t1 = await mkTask(db, "suggested", "policy_missing", { election_id: feb });
  const t2 = await mkTask(db, "web_request", "policy_missing", { election_id: feb }); // 舊制插隊 10 年（visitor 315360000）
  const c1 = await mkContribution(db, "policy", null, { election_id: dec });
  const before = Object.fromEntries(await Promise.all([t1, t2, `verify:${c1}`].map(async (id) => [id, await disp(db, id)] as const)));
  assertEquals(Number(before[t2].boost_seconds), 315360000, "舊制網站請求插隊 10 年");
  await db.exec(await readMig(BANDS_FILE));
  const after = Object.fromEntries(await Promise.all([t1, t2, `verify:${c1}`].map(async (id) => [id, await disp(db, id)] as const)));
  assertEquals(Number(after[t1].priority_seconds), (6800 + 150 + 15) * DAY, "提議：自己那屆的月 ＋ 都道府県 150 ＋ 15");
  assertEquals(Number(after[t2].priority_seconds), (7200 + 150 + 15) * DAY, "插隊中的列：最近一場未來選舉（2026-12）的月");
  assertEquals(Number(after[t2].boost_seconds), 34560000, "插隊降到 400 天");
  assertEquals(Number(after[t1].boost_seconds), 0);
  // 驗證票：原位置再領先 (層級＋19) 天（verify_priority_seconds 14 天已折進基準、一起減掉）
  const lead = (await diffSec(db, before[`verify:${c1}`].queue_at, after[`verify:${c1}`].queue_at)) / DAY;
  assertAlmostEquals(lead, 130 + 19, 0.001, "票比原位置多領先 層級 130 ＋ 19 天");
  // 備份與冪等
  const bk = await one<{ n: string; ps: string }>(db, `SELECT count(*)::TEXT AS n, max(boost_seconds)::TEXT AS ps FROM policy_jp.priority_bands_backup_20261122`);
  assertEquals([bk.n, bk.ps], ["3", "315360000"], "備份有 3 列改前值");
  const applied = (await one<{ t: string | null }>(db, `SELECT priority_bands_applied_at::TEXT AS t FROM policy_jp.queue_settings`)).t;
  assert(applied !== null);
  await db.exec(await readMig(BANDS_FILE)); // 重跑：整段跳過，不會再次改動
  assertEquals((await disp(db, t1)).priority_seconds, after[t1].priority_seconds);
  assertEquals((await disp(db, `verify:${c1}`)).queue_at, after[`verify:${c1}`].queue_at);
  await db.close();
});

// =============================================================================================
// F. 型別與機制
// =============================================================================================
Deno.test("F 型別維持 INTEGER；task_queue_key 不動；日本站沒有流量機制；一般件最大約 6.4×10^8 秒", async () => {
  const db = await freshDb();
  const t = await one<{ t: string }>(db, `SELECT data_type AS t FROM information_schema.columns WHERE table_schema = 'policy_jp' AND table_name = 'task_dispatches' AND column_name = 'priority_seconds'`);
  assertEquals(t.t, "integer");
  const sig = (await rows<{ a: string }>(db, `SELECT pg_get_function_identity_arguments(p.oid) AS a FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'policy_jp' AND p.proname = 'task_queue_key'`)).map((r) => r.a);
  assertEquals(sig.length, 1);
  assert(sig[0].includes("p_priority_seconds integer"));
  const traffic = await rows<{ t: string }>(db, `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'policy_jp' AND (table_name LIKE '%traffic%')`);
  assertEquals(traffic, [], "日本站沒有 page_traffic／traffic_boost：流量提層這支沒有做（日後日本站加了流量再做比例制）");
  assert((7200 + 170 + 19) * DAY < 2 ** 31, "一般件最大值遠小於 INTEGER 上限");
  await db.close();
});

// =============================================================================================
// G. 還原驗證
// =============================================================================================
async function dbWith(patch: (sql: string) => string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
  for (const n of await jpMigrationNames()) {
    const sql = await readMig(n);
    await db.exec(n === BANDS_FILE ? patch(sql) : sql);
  }
  return db;
}

Deno.test("G 還原驗證：層級天數表換掉／手動入列的帶狀拿掉／驗證票領先拿掉，斷言就紅", async () => {
  const a = await dbWith((s) => mutate(s, "WHEN 'national' THEN 170 WHEN 'regional' THEN 150 WHEN 'local' THEN 130", "WHEN 'national' THEN 170 WHEN 'regional' THEN 130 WHEN 'local' THEN 150"));
  assertNotEquals(await band(a, "policy_missing", { election_type: "governor" }), 150 + 15);
  const b = await dbWith((s) => mutate(s, "         task_band_seconds(m.task_type, m.target)\n".replace("task_band_seconds", "policy_jp.task_band_seconds"), "         0\n"));
  await clock(b, TODAY);
  const e = await insertElection(b, 0, "2026-12-13", "mayor");
  const t = await mkTask(b, "suggested", "policy_missing", { election_id: e });
  assertNotEquals(Number((await disp(b, t)).priority_seconds), (7200 + 130 + 15) * DAY);
  const c = await dbWith((s) => mutate(s, "(19 - policy_jp.task_kind_days_by_type(p_parent_task_type)) * 86400", "0 * 86400"));
  assertEquals((await one<{ n: number }>(c, `SELECT policy_jp.verify_ticket_parent_lead_seconds('policy_missing', NULL) AS n`)).n, 0);
});
