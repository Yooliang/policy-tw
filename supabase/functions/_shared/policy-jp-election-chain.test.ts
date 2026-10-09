/**
 * 日本站「選舉鏈」第 1 步（migration 20261009210600_policy_jp_election_chain.sql；policy-jp #57／#58／#59、主線條件）。
 *
 * 只要 --allow-read。PGlite 上套日本站整條 migration（schema → tables → 130000 → 130100 → 130200 → 150100 → 200000 → 210000 → 210100 → 210200 → 210300 → 210400 → 210500）
 * 再加這一支；資料庫裡沒有任何正見（public）物件。時鐘用 `SET app.activity_today`，整條流程走 seed_auto_task_queue()＋task_dispatches／gap_events。
 *
 *   a. 範圍：沒有開著的選舉＝兩支臂一列都不出（舊的全國掃描沒了，term_expirations 3,571 列也不派）；等團體的選舉交件開出「團體＋所屬都道府県」兩件；
 *      國政選舉不進鏈；死結整條解開（等團體的選舉 → 團體任務 → 機器核對落庫 → 選舉落庫 → 統計任務開）；投票日後 90 天關閉（含邊界、規則參數、停用不影響）；壞資料不拖垮視圖
 *   b. 三個主線情境（假時鐘＋seed）：1. 前一步完成才開  2. 前一步卡住但後備里程碑到了照開（含邊界、里程碑職位）  3. 前一步重新變成未完成時，已開的不收回
 *      另：chain_gate 記在派工列與 gap_events.detail、沒有 after_step 的規則（手動臂、election_discovery）沒有這個鍵、覆寫 force=open 繞過鏈、closed 照樣關
 *   c. election_chain_progress 的語意：步驟清單、每場選舉恰好四步、region＝local_government 而且 regional_stats、行政区／規則排除的種類＝統計 done、done_at、
 *      統計判準（published、min_year）；逃生門函式 activity_chain_escape 單獨測
 *   d. 文字守門：總表＝210100 的版本剛好多「選舉鏈」兩段＋幾處行內修改（機械替換比對＋還原驗證）；鏈那兩段不含日本專用的字（站別專用的只有 activity_chain_scope）
 *   e. 輸出契約：兩支臂的回傳型別跟 election_discovery 臂相同、也是正見臂的七欄
 *   f. CHECK：after_step 不在步驟清單、掛在優先層規則上、chain_fallback 沒有 after_step／里程碑種類不對／offset 不是整數 → 都擋
 *   g. 權限：新函式與兩個視圖 anon／authenticated 不能碰，service_role 可以
 *   h. 自我檢查（還原驗證）：少 chain_close_after_days、少後備里程碑、少 after_step、視圖或函式給了 anon、步驟清單改掉 → 重跑都會失敗；
 *      行為的還原驗證（拿掉 sticky，情境 3 就會紅）；整支重跑兩次冪等
 *   i. 文字守門：沒有 public./ditrust 引用；這支不寫 elections／local_governments／regional_stats；臂唯讀；函式都登記且釘 search_path
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText } from "./arms-pglite.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const CHAIN = [
  "20261008195000_policy_jp_schema.sql", "20261009000000_policy_jp_tables.sql", "20261009130000_policy_jp_dispatch.sql",
  "20261009130100_policy_jp_election_discovery.sql", "20261009130200_policy_jp_term_expirations_r08.sql", "20261009150100_policy_jp_rebalance_anchor.sql",
  "20261009200000_policy_jp_public_stats.sql", "20261009210000_policy_jp_apply.sql", "20261009210100_policy_jp_gap_arms.sql",
  "20261009210200_policy_jp_lg_registry.sql", "20261009210300_policy_jp_lg_registry_data.sql", "20261009210400_policy_jp_stat_registry.sql",
  "20261009210500_policy_jp_stat_registry_data.sql",
];
const CHAIN_SQL = await Promise.all(CHAIN.map(read));
const MIG_FILE = "20261009210600_policy_jp_election_chain.sql";
const MIG_SQL = await read(MIG_FILE);
const ARMS_SQL = CHAIN_SQL[8]; // 20261009210100：緊接在前的總表與兩支臂的版本
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const ARM_LG = "policy_jp.contribution_auto_tasks_local_government_missing";
const ARM_ST = "policy_jp.contribution_auto_tasks_regional_stats_missing";

const ROLES = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;
async function freshDb(o: { mig?: string | false } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  for (const sql of CHAIN_SQL) await db.exec(sql);
  if (o.mig !== false) await db.exec(o.mig ?? MIG_SQL);
  return db;
}
// 唯讀檢查共用一個庫；「還原驗證」共用一個還沒套 210600 的庫（失敗的 migration 整個回滾，不留痕跡）
const shared = await freshDb();
const pre = await freshDb({ mig: false });

const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rows = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const count = async (db: PGlite, sql: string, params: unknown[] = []) => (await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM (${sql}) q`, params)).n;
async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}
function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 70)}`);
  return sql.replace(from, () => to);
}
/** 在交易裡執行、最後一定回滾：成功＝這句被接受（不留痕跡）、丟例外＝被擋。 */
class Rollback extends Error {}
async function tryIn(db: PGlite, sql: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

const clock = (db: PGlite, day: string) => db.exec(`SET app.activity_today = '${day}'`);
const seed = (db: PGlite) => db.query(`SELECT policy_jp.seed_auto_task_queue()`);
const CHAIN_TYPES = `('local_government_missing', 'regional_stats_missing')`;

// ---------------------------------------------------------------------------------------------
// 固定的團體：團體碼表（lg_code_registry，總務省）裡真的有的，名稱・種類・所屬都道府県都從它取
// ---------------------------------------------------------------------------------------------
type Reg = { lg_code: string; pref_code: string; pref_name: string; name: string; kana: string; kind: string };
const REG: Reg[] = await rows<Reg>(shared, `SELECT lg_code, pref_code, pref_name, name, kana, kind FROM policy_jp.lg_code_registry ORDER BY lg_code`);
const reg = (code: string) => REG.find((r) => r.lg_code === code)!;
const payloadOf = (r: Reg) => ({ lg_code: r.lg_code, kind: r.kind, pref_code: r.pref_code, name: r.name, kana: r.kana });
const AICHI = "230006", ICHI = "232033", NAGANO = "200000", KOMORO = "202088", HOKKAIDO = "010006", HAKODATE = "012025", SAPPORO = "011002", CHIKUSA = "231011";
const ICHI_ELECTION = "2027-04-25_mayor_232033";
const SOUMU = "https://www.soumu.go.jp/denshijiti/code.html";
const ELECTION_URL = "https://www.city.ichinomiya.aichi.jp/senkyo/";
const ESTAT = "https://www.e-stat.go.jp/regional-statistics/ssdsview/municipality";

let seq = 0;
/** 交件（created_at／verified_at 照交件順序遞增，掃描照這個排） */
async function submit(db: PGlite, type: string, payload: Record<string, unknown>, o: { status?: string; task?: string | null; urls?: string[] } = {}): Promise<string> {
  const n = ++seq;
  const status = o.status ?? "pending";
  return (await one<{ id: string }>(db,
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash, status, verified_at, created_at)
     VALUES ($1, $2::JSONB, $3, $4, $5, $6, $7, $8, CASE WHEN $8 = 'verified' THEN TIMESTAMPTZ '2026-10-09 00:00:00+00' + make_interval(secs => $9) END,
             TIMESTAMPTZ '2026-10-09 00:00:00+00' + make_interval(secs => $9)) RETURNING id`,
    [type, JSON.stringify(payload), o.urls ?? [SOUMU], o.task ?? null, `author-${n}`, `author-ip-${n}`, `h-${n}`, status, n])).id;
}
const electionPayload = (lg: string, date: string, type = "mayor") => ({ lg_code: lg, election_type: type, election_reason: "regular", election_date: date, notice_date: date.slice(0, 8) + "18" });
/** 通過驗證、只在等團體落庫的選舉交件 */
const waitingElection = (db: PGlite, lg: string, date: string, type = "mayor") => submit(db, "election", electionPayload(lg, date, type), { status: "verified", urls: [ELECTION_URL] });
/** 通過驗證的交件都落庫（掃地機一輪只落「現在不被擋」的，被擋的等下一輪；到沒東西可落為止） */
async function applyAll(db: PGlite): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const r = (await one<{ r: { scanned: number } }>(db, `SELECT policy_jp.apply_verified_pending(100, 0) AS r`)).r;
    if (r.scanned === 0) return;
  }
}
/** 團體交件走完整條路：交件 → 總務省團體碼表機器核對 → 落庫（都道府県先，市區町村等它進來） */
async function landLgs(db: PGlite, codes: string[]): Promise<void> {
  for (const c of codes) await submit(db, "local_government", payloadOf(reg(c)), { task: `auto:local_government_missing:${c}` });
  await db.query(`SELECT policy_jp.lg_registry_verify_pending()`);
  await applyAll(db);
}
/** 團體直接進庫（測試要的是別的東西時用，省一輪核對）：都道府県先 */
async function insertLg(db: PGlite, code: string): Promise<void> {
  const r = reg(code);
  if (r.pref_code !== code) await insertLg(db, r.pref_code);
  await db.query(`INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ($1, $2, $3, $4, $5, $1) ON CONFLICT DO NOTHING`,
    [r.lg_code, r.kind, r.pref_code, r.name, r.kana]);
}
/** 已上線的選舉直接進庫（團體要先在庫裡）；回 id */
async function insertElection(db: PGlite, lg: string, date: string, o: { type?: string; status?: string } = {}): Promise<string> {
  const type = o.type ?? "mayor";
  const id = `${date}_${type}_${lg}`;
  await insertLg(db, lg);
  await db.query(
    `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code, review_status)
     VALUES ($1, $2, $3, $4, 'regular', policy_jp.election_level($4), $5, $6)`,
    [id, `${reg(lg).name}${type}選挙`, date, type, lg, o.status ?? "published"]);
  return id;
}
async function sourceId(db: PGlite): Promise<number> {
  return (await one<{ id: number }>(db, `INSERT INTO policy_jp.sources (url, origin, source_kind) VALUES ($1, 'test', 'statistics')
    ON CONFLICT (url) DO UPDATE SET origin = EXCLUDED.origin RETURNING id::INT AS id`, [ESTAT])).id;
}
const STAT_ROWS: Array<[string, number, number]> = [["population", 2020, 386678], ["area_km2", 2020, 113.82], ["aging_rate", 2020, 28.6], ["budget_expenditure", 2023, 99999]];
/** 統計直接進庫；skip＝不放的 stat_key */
async function fillStats(db: PGlite, lg: string, o: { skip?: string[]; status?: string } = {}): Promise<void> {
  const sid = await sourceId(db);
  for (const [k, y, v] of STAT_ROWS) {
    if (o.skip?.includes(k)) continue;
    await db.query(`INSERT INTO policy_jp.regional_stats (lg_code, stat_key, year, value, unit, source_id, review_status) VALUES ($1, $2, $3, $4, policy_jp.regional_stat_unit($2), $5, $6)`,
      [lg, k, y, v, sid, o.status ?? "published"]);
  }
}
/** 回報「查無」並進了冷卻（no_change 落庫＝task_checks 一列） */
const notFound = (db: PGlite, taskId: string) =>
  db.query(`INSERT INTO policy_jp.task_checks (task_id, outcome, agent_name) VALUES ($1, 'not_found', 'checker')`, [taskId]);
const expireCooling = (db: PGlite) =>
  db.exec(`UPDATE policy_jp.task_checks SET checked_at = now() - ((policy_jp.task_check_cooldown_days() + 1) || ' days')::INTERVAL`);

type Dispatch = { task_id: string; task_type: string; target: Record<string, unknown>; opened_by: Record<string, unknown>; what_we_need: string; priority: number; region: string };
const chainDispatches = (db: PGlite) => rows<Dispatch>(db,
  `SELECT task_id, task_type, target, opened_by, what_we_need, priority, region FROM policy_jp.task_dispatches WHERE task_type IN ${CHAIN_TYPES} ORDER BY task_id`);
const chainIds = async (db: PGlite) => (await chainDispatches(db)).map((d) => d.task_id);
type Ev = { event: string; reason: string | null; detail: { chain_gate?: { after_step: string; via: string }; opened_by?: Record<string, unknown> } & Record<string, unknown> };
const events = (db: PGlite, taskId: string) => rows<Ev>(db, `SELECT event, reason, detail FROM policy_jp.gap_events WHERE task_id = $1 ORDER BY id`, [taskId]);
type Arm = { task_id: string; arm: string; target: Record<string, unknown>; opened_by: Record<string, unknown> | null };
/** 總表輸出（chain 的兩支臂＋可選全部）；all＝gap.arms_all 開著（被擋的列也回，opened_by 是 NULL） */
async function armRows(db: PGlite, all = false): Promise<Arm[]> {
  if (!all) {
    return await rows<Arm>(db, `SELECT task_id, arm, target, opened_by FROM ${TOTAL}() WHERE arm IN ('local_government_missing', 'regional_stats_missing') ORDER BY task_id`);
  }
  return await db.transaction(async (tx) => {
    await tx.exec(`SELECT set_config('gap.arms_all', 'on', true)`);
    return (await tx.query<Arm>(`SELECT task_id, arm, target, opened_by FROM ${TOTAL}() WHERE arm IN ('local_government_missing', 'regional_stats_missing') ORDER BY task_id`)).rows;
  });
}
type Prog = { election_id: string; lg_code: string; step: string; done: boolean; done_at: string | null };
const progress = (db: PGlite, electionId?: string) => rows<Prog>(db,
  `SELECT election_id, lg_code, step, done, done_at FROM policy_jp.election_chain_progress ${electionId ? `WHERE election_id = '${electionId}'` : ""} ORDER BY election_id, step`);
const stepsDone = async (db: PGlite, electionId: string) => Object.fromEntries((await progress(db, electionId)).map((p) => [p.step, p.done]));

// =============================================================================================
// a. 範圍
// =============================================================================================
Deno.test("範圍：沒有開著的選舉＝兩支臂與兩個視圖一列都不出（舊的全國掃描沒了），seed 也不派；term_expirations 3,571 列都不再被掃", async () => {
  const db = await freshDb();
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.term_expirations`), 3571, "任期満了調査的 3,571 列還在（不是資料不見了）");
  for (const day of ["2026-10-09", "2027-03-01", "2027-06-01", "2028-01-01"]) {
    await clock(db, day);
    assertEquals(await count(db, `SELECT 1 FROM ${ARM_LG}()`), 0, `${day} local_government_missing`);
    assertEquals(await count(db, `SELECT 1 FROM ${ARM_ST}()`), 0, `${day} regional_stats_missing`);
    assertEquals(await count(db, `SELECT 1 FROM policy_jp.chain_open_elections`), 0);
    assertEquals(await count(db, `SELECT 1 FROM policy_jp.election_chain_progress`), 0);
  }
  await clock(db, "2027-03-01");
  await seed(db);
  assertEquals(await chainIds(db), []);
  // 同一天，election_discovery 臂照舊在跑（鏈只動兩支臂）
  assert(await count(db, `SELECT 1 FROM policy_jp.task_dispatches WHERE task_type = 'election_discovery'`) > 0);
  await db.close();
});

Deno.test("範圍：等團體的選舉交件 → 團體與所屬都道府県兩件任務開出來（task_id、target 的選舉與鏈欄位）；統計那件還沒到時候；國政選舉不進鏈", async () => {
  const db = await freshDb();
  await clock(db, "2027-03-01");
  await waitingElection(db, ICHI, "2027-04-25");
  // 國政選舉：一場已上線（lg_code 空）、一場通過驗證的交件硬塞了團體碼——都不進鏈
  await db.query(`INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, review_status)
                  VALUES ('2027-10-24_national_lower_national', '衆議院議員総選挙', '2027-10-24', 'national_lower', 'regular', 'national', 'published')`);
  await waitingElection(db, KOMORO, "2027-05-30", "national_lower");

  const open = await rows<{ election_id: string; lg_code: string; election_type: string; basis: string; election_date: string; notice_date: string }>(
    db, `SELECT election_id, lg_code, election_type, basis, election_date::TEXT, notice_date::TEXT FROM policy_jp.chain_open_elections`);
  assertEquals(open, [{ election_id: ICHI_ELECTION, lg_code: ICHI, election_type: "mayor", basis: "verified_waiting", election_date: "2027-04-25", notice_date: "2027-04-18" }]);

  const lg = await rows<{ task_id: string; task_type: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[]; reward: number; region: string }>(
    db, `SELECT * FROM ${ARM_LG}() ORDER BY task_id`);
  assertEquals(lg.map((t) => t.task_id), [`auto:local_government_missing:${AICHI}`, `auto:local_government_missing:${ICHI}`]);
  const [pref, city] = lg;
  assertEquals(pref.target, {
    lg_code: AICHI, lg_name: "愛知県", pref_code: AICHI, pref_name: "愛知県", is_prefecture: true,
    election_id: ICHI_ELECTION, election_type: "mayor", election_date: "2027-04-25", chain_lg_code: ICHI, chain_step: "local_government",
  });
  assertEquals(city.target, {
    lg_code: ICHI, lg_name: "一宮市", pref_code: AICHI, pref_name: "愛知県", is_prefecture: false,
    election_id: ICHI_ELECTION, election_type: "mayor", election_date: "2027-04-25", chain_lg_code: ICHI, chain_step: "local_government",
  });
  for (const t of lg) {
    assertEquals([t.task_type, t.reward, t.region], ["local_government_missing", 1, "愛知県"]);
    assert(t.what_we_need.includes("2027-04-25") && t.what_we_need.includes(ICHI_ELECTION) && t.what_we_need.includes("contribution_type=local_government"));
    assertEquals(t.hint_sources.length, 3);
  }
  assert(pref.what_we_need.includes("kind=prefecture") && city.what_we_need.includes("kind は") && city.what_we_need.includes(`pref_code は ${AICHI}`));

  // 統計那一件：臂算得出來（團體還沒進庫也算），但 gate 擋著；arms_all 看得到、opened_by 是 NULL
  const st = await rows<{ task_id: string; target: Record<string, unknown> }>(db, `SELECT task_id, target FROM ${ARM_ST}()`);
  assertEquals(st.map((t) => t.task_id), [`auto:regional_stats_missing:${ICHI}`]);
  assertEquals([st[0].target.election_id, st[0].target.election_type, st[0].target.chain_lg_code, st[0].target.chain_step, st[0].target.lg_name, st[0].target.kind],
    [ICHI_ELECTION, "mayor", ICHI, "regional_stats", "一宮市", "core_city"]);
  assertEquals((await armRows(db)).map((a) => a.task_id), [`auto:local_government_missing:${AICHI}`, `auto:local_government_missing:${ICHI}`]);
  const all = await armRows(db, true);
  assertEquals(all.map((a) => [a.task_id, a.opened_by === null]), [
    [`auto:local_government_missing:${AICHI}`, false], [`auto:local_government_missing:${ICHI}`, false], [`auto:regional_stats_missing:${ICHI}`, true]]);

  await seed(db);
  assertEquals(await chainIds(db), [`auto:local_government_missing:${AICHI}`, `auto:local_government_missing:${ICHI}`]);
  await db.close();
});

Deno.test("範圍：死結整條解開——等團體的選舉 → 團體任務 → 團體交件機器核對落庫 → 選舉落庫 → 統計任務開 → 統計補齊收回", async () => {
  const db = await freshDb();
  await clock(db, "2027-03-01");
  const el = await waitingElection(db, ICHI, "2027-04-25");
  await seed(db);
  assertEquals(await chainIds(db), [`auto:local_government_missing:${AICHI}`, `auto:local_government_missing:${ICHI}`], "團體任務先開，統計還沒");
  // 選舉在等團體：沒有 elections 列（外鍵），團體的任務又不能等選舉上線——這就是死結
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.elections`), 0);
  assertEquals((await one<{ x: string }>(db, `SELECT policy_jp.apply_blocker('election', payload) AS x FROM policy_jp.contributions WHERE id = $1`, [el])).x, `local_government_missing:${ICHI}`);

  // 代理領了團體任務、交件（市比都道府県先到）→ 總務省團體碼表機器核對：都道府県落庫、市等它
  await submit(db, "local_government", payloadOf(reg(ICHI)), { task: `auto:local_government_missing:${ICHI}` });
  await submit(db, "local_government", payloadOf(reg(AICHI)), { task: `auto:local_government_missing:${AICHI}` });
  assertEquals(await one(db, `SELECT policy_jp.lg_registry_verify_pending() AS r`), { r: { applied: 1, waiting: 1, rejected: 0, skipped: 0, other: 0 } });
  // 都道府県進來了，市還在等；選舉仍在等市：兩件團體任務都已經不是缺口，下一輪 seed 收回
  assertEquals(await rows(db, `SELECT lg_code FROM policy_jp.local_governments ORDER BY lg_code`), [{ lg_code: AICHI }]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.chain_open_elections`), 1, "市還沒進來，選舉還在等");
  // 落庫掃地機：市進來 → 下一輪選舉落庫
  await db.query(`SELECT policy_jp.apply_verified_pending(100, 0)`);
  assertEquals(await rows(db, `SELECT lg_code FROM policy_jp.local_governments ORDER BY lg_code`), [{ lg_code: AICHI }, { lg_code: ICHI }]);
  await db.query(`SELECT policy_jp.apply_verified_pending(100, 0)`);
  assertEquals(await rows(db, `SELECT id, review_status, lg_code FROM policy_jp.elections`), [{ id: ICHI_ELECTION, review_status: "published", lg_code: ICHI }]);
  assertEquals((await one<{ status: string }>(db, `SELECT status FROM policy_jp.contributions WHERE id = $1`, [el])).status, "applied");
  assertEquals(await rows(db, `SELECT election_id, basis FROM policy_jp.chain_open_elections`), [{ election_id: ICHI_ELECTION, basis: "published" }]);
  assertEquals(await stepsDone(db, ICHI_ELECTION), { discovery: true, local_government: true, regional_stats: false, region: false });

  // seed：團體任務收回（filled）、統計任務開（前一步 done）
  await seed(db);
  assertEquals(await chainIds(db), [`auto:regional_stats_missing:${ICHI}`]);
  assertEquals((await events(db, `auto:local_government_missing:${ICHI}`)).map((e) => [e.event, e.reason]), [["opened", null], ["closed", "filled"]]);
  const stat = (await chainDispatches(db))[0];
  assertEquals(stat.opened_by.chain_gate, { after_step: "local_government", via: "done" });
  assertEquals([stat.target.election_id, stat.target.chain_lg_code, stat.region], [ICHI_ELECTION, ICHI, "愛知県"]);
  assertEquals((stat.target.missing as Array<{ stat_key: string }>).map((m) => m.stat_key), ["aging_rate", "area_km2", "budget_expenditure", "population"]);

  // 代理交統計：國勢調査有的三項（人口・面積・高齢化率）機器核對落庫，歳出沒有可比對的檔、直接放進庫
  const regStats = await rows<{ stat_key: string; year: number; value: string; unit: string; as_of: string }>(
    db, `SELECT stat_key, year, value::TEXT, unit, as_of::TEXT FROM policy_jp.stat_registry WHERE lg_code = $1 ORDER BY stat_key`, [ICHI]);
  assertEquals(regStats.map((r) => r.stat_key), ["aging_rate", "area_km2", "population"]);
  for (const r of regStats) {
    await submit(db, "regional_stat", { lg_code: ICHI, stat_key: r.stat_key, year: r.year, value: Number(r.value), unit: r.unit, as_of: r.as_of },
      { task: `auto:regional_stats_missing:${ICHI}`, urls: [ESTAT] });
  }
  assertEquals((await one<{ r: { applied: number } }>(db, `SELECT policy_jp.stat_registry_verify_pending() AS r`)).r.applied, 3);
  assertEquals(await chainIds(db), [], "貢獻 applied 的當下收回派工列（既有的行為，不分缺口補齊了沒有）；下一輪 seed 再把還缺的開回來");
  await seed(db);
  const left = await chainDispatches(db);
  assertEquals(left.map((d) => d.task_id), [`auto:regional_stats_missing:${ICHI}`], "歳出がまだ：任務は残る");
  assertEquals((left[0].target.missing as Array<{ stat_key: string }>).map((m) => m.stat_key), ["budget_expenditure"]);
  assertEquals(await stepsDone(db, ICHI_ELECTION), { discovery: true, local_government: true, regional_stats: false, region: false });
  await fillStats(db, ICHI, { skip: ["population", "area_km2", "aging_rate"] });
  await seed(db);
  assertEquals(await chainIds(db), [], "鏈走完：兩支臂都沒有缺口");
  assertEquals(await stepsDone(db, ICHI_ELECTION), { discovery: true, local_government: true, regional_stats: true, region: true });
  assertEquals((await events(db, `auto:regional_stats_missing:${ICHI}`)).map((e) => [e.event, e.reason]),
    [["opened", null], ["closed", "filled"], ["reopened", null], ["closed", "filled"]], "開 → 第一筆統計落庫時收回 → 還缺歳出，重開 → 補齊收回");
  await db.close();
});

Deno.test("範圍：開著多久——投票日後 90 天（含）關閉，規則 params.chain_close_after_days 改了跟著變，停用 election_discovery 不影響；pending／rejected 的選舉不算；關了 seed 收回", async () => {
  const db = await freshDb();
  const e1 = await insertElection(db, ICHI, "2027-04-25");
  await insertElection(db, KOMORO, "2027-04-25", { status: "pending" });
  await insertElection(db, HAKODATE, "2027-04-25", { status: "rejected" });
  await insertElection(db, SAPPORO, "2027-04-25", { status: "not_found" });
  const open = (day: string) => clock(db, day).then(() => rows<{ election_id: string }>(db, `SELECT election_id FROM policy_jp.chain_open_elections ORDER BY election_id`)).then((r) => r.map((x) => x.election_id));
  assertEquals(await open("2027-01-01"), [e1], "投票日之前一律開著（published 的才算）");
  assertEquals(await open("2027-04-25"), [e1]);
  assertEquals(await open("2027-07-24"), [e1], "投票日 + 90 天＝這一天還開著");
  assertEquals(await open("2027-07-25"), [], "投票日 + 91 天關閉");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.election_chain_progress`), 0, "關了，進度也沒有列");

  // 規則改 30 天：同一天（5/26＝+31）就關
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{chain_close_after_days}', '30') WHERE activity = 'election_discovery'`);
  assertEquals(await open("2027-05-25"), [e1]);
  assertEquals(await open("2027-05-26"), []);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{chain_close_after_days}', '90') WHERE activity = 'election_discovery'`);
  // 停用「發現新選舉」不該讓已經開著的鏈跟著消失
  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = false WHERE activity = 'election_discovery'`);
  assertEquals(await open("2027-07-24"), [e1]);
  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = true WHERE activity = 'election_discovery'`);

  // seed：開著時統計任務在派工列；鏈關了（+91 天）下一輪收回，原因 filled（臂已經算不出來）
  await clock(db, "2027-07-24");
  await seed(db);
  assertEquals(await chainIds(db), [`auto:regional_stats_missing:${ICHI}`]);
  await clock(db, "2027-07-25");
  await seed(db);
  assertEquals(await chainIds(db), []);
  assertEquals((await events(db, `auto:regional_stats_missing:${ICHI}`)).map((e) => [e.event, e.reason]), [["opened", null], ["closed", "filled"]]);
  await db.close();
});

Deno.test("範圍：壞資料不拖垮視圖——壞日期・缺欄位・不認得的種類・非 verified 的交件都不進鏈；date_or_null 格式不對・沒有這一天＝NULL", async () => {
  const db = await freshDb();
  await clock(db, "2027-03-01");
  const bad = async (patch: Record<string, unknown>, o: { status?: string; type?: string } = {}) =>
    submit(db, o.type ?? "election", { ...electionPayload(ICHI, "2027-04-25"), ...patch }, { status: o.status ?? "verified", urls: [ELECTION_URL] });
  await bad({ election_date: "2027-02-30" });            // 格式對、沒有這一天
  await bad({ election_date: "2027-13-01" });
  await bad({ election_date: "2027/04/25" });
  await bad({ election_date: "二〇二七年四月二十五日" });
  await bad({ election_date: null });
  await bad({ election_date: 20270425 });                 // 數字
  await bad({ election_type: "bogus" });
  await bad({ election_type: null });
  await bad({ lg_code: null });
  await bad({ lg_code: "232034" });                       // 檢查碼不對：落庫時才會退件，不是在等團體
  await bad({}, { status: "pending" });                   // 還沒通過驗證
  await bad({}, { status: "applied" });
  await bad({}, { status: "rejected" });
  await bad({}, { type: "no_change" });                   // 別的型別
  assertEquals(await rows(db, `SELECT * FROM policy_jp.chain_open_elections`), [], "沒有一筆壞資料進鏈（視圖也沒有丟例外）");
  assertEquals(await rows(db, `SELECT * FROM policy_jp.election_chain_progress`), []);
  assertEquals(await count(db, `SELECT 1 FROM ${ARM_LG}()`), 0);
  await seed(db);
  assertEquals(await chainIds(db), []);
  // 壞資料裡夾一筆好的：好的照開
  await waitingElection(db, ICHI, "2027-04-25");
  assertEquals((await rows<{ election_id: string }>(db, `SELECT election_id FROM policy_jp.chain_open_elections`)).map((r) => r.election_id), [ICHI_ELECTION]);

  const dates = await rows<{ t: string | null; d: string | null }>(db, `SELECT t, policy_jp.date_or_null(t)::TEXT AS d FROM (VALUES
    ('2027-04-25'), ('2027-02-30'), ('2028-02-29'), ('2027-02-29'), ('2027-13-01'), ('2027-4-25'), ('2027/04/25'), ('0000-01-01'), (' 2027-04-25'), ('abc'), (''), (NULL)) v(t)`);
  assertEquals(dates.map((r) => r.d), ["2027-04-25", null, "2028-02-29", null, null, null, null, null, null, null, null, null]);
  await db.close();
});

// =============================================================================================
// b. 三個主線情境
// =============================================================================================
Deno.test("情境 1　前一步完成才開：等團體的選舉，統計任務擋著；團體進庫（前一步 done）之後下一輪 seed 才開，opened_by 記 via=done", async () => {
  const db = await freshDb();
  await clock(db, "2027-03-01");
  await waitingElection(db, ICHI, "2027-04-25");
  await seed(db);
  const stats = `auto:regional_stats_missing:${ICHI}`;
  assertEquals(await chainIds(db), [`auto:local_government_missing:${AICHI}`, `auto:local_government_missing:${ICHI}`]);
  assertEquals(await events(db, stats), [], "擋著的時候連出生紀錄都沒有");
  assertEquals((await stepsDone(db, ICHI_ELECTION)).local_government, false);
  // 擋著的列在 arms_all 裡看得到、opened_by 是 NULL（seed 靠它分辨「窗口關了」與「缺口補上了」）
  assertEquals((await armRows(db, true)).find((a) => a.task_id === stats)?.opened_by, null);
  // 一輪、兩輪 seed，擋著就是擋著
  await seed(db);
  assertEquals(await chainIds(db), [`auto:local_government_missing:${AICHI}`, `auto:local_government_missing:${ICHI}`]);

  // 都道府県進庫、市還沒：前一步（兩個碼都要在）仍未完成
  await insertLg(db, AICHI);
  await seed(db);
  assertEquals((await stepsDone(db, ICHI_ELECTION)).local_government, false);
  assertEquals(await chainIds(db), [`auto:local_government_missing:${ICHI}`], "團體任務只剩市；統計還是擋著");

  // 市也進庫（交件走完整條路落庫）→ 前一步 done → 統計開
  await landLgs(db, [ICHI]);
  await seed(db);
  assertEquals(await chainIds(db), [stats]);
  const d = (await chainDispatches(db))[0];
  assertEquals(d.opened_by.chain_gate, { after_step: "local_government", via: "done" });
  assertEquals((await events(db, stats)).map((e) => [e.event, e.detail.chain_gate]), [["opened", { after_step: "local_government", via: "done" }]]);
  await db.close();
});

Deno.test("情境 2　前一步卡住但後備里程碑到了照開：after_step=region（統計沒補完 region 就不會 done）、後備投票日前 45 天；前一天擋、當天以 via=fallback 開", async () => {
  // 正式設定在第 1 步到不了這個情境（migration 的「已知的限制」），所以用 CHECK 允許的測試用規則：統計任務掛在 region 之後，region 要統計補完才 done
  const db = await freshDb();
  const obs = await fallbackScenario(db);
  assertEquals(obs.fallback, { kind: "polling", offset: -45 });
  assertEquals(obs.steps, { discovery: true, local_government: true, regional_stats: false, region: false });
  assertEquals(obs.dayBefore, { dispatched: [], arms: [], blockedInAll: true }, "前一步沒完成、後備里程碑還沒到（4/25 的前 46 天）：擋，arms_all 看得到、opened_by 是 NULL");
  assertEquals(obs.onTheDay, { dispatched: [`auto:regional_stats_missing:${ICHI}`], gate: { after_step: "region", via: "fallback" } }, "前 45 天：on_date + (-45) <= 今天 → 開");
  assertEquals(obs.ruleIdMatches, true);
  assertEquals(obs.event, [["opened", { after_step: "region", via: "fallback" }]]);
  assertEquals(obs.afterPolling, "fallback", "更晚的日子 gate 看到的仍是 fallback（里程碑還是到了）");
  await db.close();
});

/** 情境 2 的整套觀察（行為的還原驗證會拿一個被改壞的 migration 再跑一次） */
async function fallbackScenario(db: PGlite) {
  await insertElection(db, ICHI, "2027-04-25"); // 團體已在庫＝local_government 已完成；統計還缺
  await db.exec(`UPDATE policy_jp.activity_rules SET after_step = 'region' WHERE activity = 'regional_stats_missing'`);
  const fallback = (await one<{ f: unknown }>(db, `SELECT params->'chain_fallback' AS f FROM policy_jp.activity_rules WHERE activity = 'regional_stats_missing'`)).f;
  const stats = `auto:regional_stats_missing:${ICHI}`;
  await clock(db, "2027-03-10"); // 4/25 的前 46 天
  const steps = await stepsDone(db, ICHI_ELECTION);
  await seed(db);
  const dayBefore = {
    dispatched: await chainIds(db),
    arms: (await armRows(db)).map((a) => a.task_id),
    blockedInAll: (await armRows(db, true)).some((a) => a.task_id === stats && a.opened_by === null),
  };
  await clock(db, "2027-03-11"); // 前 45 天
  await seed(db);
  const d = (await chainDispatches(db))[0];
  const ruleId = (await one<{ id: number }>(db, `SELECT id::INT FROM policy_jp.activity_rules WHERE activity = 'regional_stats_missing'`)).id;
  const onTheDay = { dispatched: await chainIds(db), gate: d?.opened_by.chain_gate };
  const event = (await events(db, stats)).map((e) => [e.event, e.detail.chain_gate]);
  await clock(db, "2027-04-26");
  const afterPolling = ((await armRows(db)).find((a) => a.task_id === stats)?.opened_by as { chain_gate: { via: string } } | null)?.chain_gate.via;
  return { fallback, steps, dayBefore, onTheDay, ruleIdMatches: d?.opened_by.rule_id === ruleId, event, afterPolling };
}

Deno.test("情境 2 補：後備里程碑可以是別的種類（election_milestones）、職位要對得上整場或同一個職位；沒到、職位不同＝不開", async () => {
  const db = await freshDb();
  const eid = await insertElection(db, ICHI, "2027-04-25");
  await db.exec(`UPDATE policy_jp.activity_rules SET after_step = 'region', params = params || '{"chain_fallback":{"kind":"list_published","offset":3}}'::JSONB WHERE activity = 'regional_stats_missing'`);
  const stats = `auto:regional_stats_missing:${ICHI}`;
  const ms = (type: string | null, date: string) => db.query(
    `INSERT INTO policy_jp.election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES ($1, 'list_published', $2, $3, 'official', 'done')`, [eid, type, date]);
  await clock(db, "2027-04-20");
  await seed(db);
  assertEquals(await chainIds(db), [], "里程碑還沒有列");
  await ms("governor", "2027-04-10"); // 別的職位的名單公告
  await seed(db);
  assertEquals(await chainIds(db), [], "別的職位的里程碑不算");
  await ms("mayor", "2027-04-18"); // 同職位：+3 天＝4/21
  await seed(db);
  assertEquals(await chainIds(db), [], "4/20 還沒到 4/21");
  await clock(db, "2027-04-21");
  await seed(db);
  assertEquals(await chainIds(db), [stats]);
  assertEquals((await chainDispatches(db))[0].opened_by.chain_gate, { after_step: "region", via: "fallback" });
  await db.close();
});

Deno.test("情境 3　前一步重新變成未完成時，已開的下一步不收回：查無冷卻讓前一步 done → 統計開 → 冷卻到期前一步又變未完成 → 統計照開（sticky）、gap_events 沒有 closed；沒開過的同樣狀態照擋", async () => {
  const db = await freshDb();
  const obs = await stickyScenario(db);
  assertEquals(obs.idsWhileCooling, [`auto:regional_stats_missing:${ICHI}`], "冷卻中的團體任務不派（task_unavailable），統計任務開了");
  assertEquals(obs.openedVia, { after_step: "local_government", via: "done" }, "冷卻中＝前一步 done");
  assertEquals(obs.doneAfterExpiry, false, "冷卻到期，前一步又變成未完成");
  assertEquals(obs.statsStillDispatched, true, "已開的統計任務還在派工列");
  assertEquals(obs.statsViaAfterExpiry, { after_step: "local_government", via: "sticky" });
  assertEquals(obs.statsEvents, [["opened", null]], "gap_events 沒有 closed");
  assertEquals(obs.otherStatsBlocked, true, "沒開過的同樣狀態（別的團體）還是擋著：arms_all 看得到、opened_by 是 NULL");
  assertEquals(obs.lgEvents, [["opened", null]], "團體任務冷卻到期後重新開出來（前一步沒完成，團體任務本來就該開）");
  await db.close();
});

/**
 * 情境 3 的整套觀察（行為的還原驗證會拿一個被改壞的 migration 再跑一次）。
 * 兩場等團體的選舉（一宮市、函館市）：一宮市的團體任務回報查無並進冷卻 → 前一步 done → 統計任務開；
 * 函館市也一樣讓前一步 done，但在它的統計任務開出來之前，冷卻就全部到期——所以一宮市的統計開過（sticky）、函館市的從沒開過（擋）。
 */
async function stickyScenario(db: PGlite) {
  await clock(db, "2027-03-01");
  await waitingElection(db, ICHI, "2027-04-25");
  const stats = `auto:regional_stats_missing:${ICHI}`;
  for (const code of [AICHI, ICHI]) await notFound(db, `auto:local_government_missing:${code}`);
  await seed(db);
  const idsWhileCooling = await chainIds(db);
  const openedVia = (await chainDispatches(db)).find((d) => d.task_id === stats)?.opened_by.chain_gate;

  const hakodate = "2027-04-11_mayor_012025";
  await waitingElection(db, HAKODATE, "2027-04-11");
  for (const code of [HOKKAIDO, HAKODATE]) await notFound(db, `auto:local_government_missing:${code}`);
  assertEquals((await stepsDone(db, hakodate)).local_government, true, "函館市的前一步也是 done（還沒 seed，統計任務還沒開過）");
  await expireCooling(db);
  const doneAfterExpiry = (await stepsDone(db, ICHI_ELECTION)).local_government;
  assertEquals((await stepsDone(db, hakodate)).local_government, false);

  await seed(db);
  const arms = await armRows(db);
  const armsAll = await armRows(db, true);
  const hakodateStats = `auto:regional_stats_missing:${HAKODATE}`;
  return {
    idsWhileCooling, openedVia, doneAfterExpiry,
    statsStillDispatched: (await chainIds(db)).includes(stats),
    statsViaAfterExpiry: (arms.find((a) => a.task_id === stats)?.opened_by as { chain_gate?: unknown } | null | undefined)?.chain_gate,
    statsEvents: (await events(db, stats)).map((e) => [e.event, e.reason]),
    otherStatsBlocked: !arms.some((a) => a.task_id === hakodateStats) && armsAll.some((a) => a.task_id === hakodateStats && a.opened_by === null),
    lgEvents: (await events(db, `auto:local_government_missing:${ICHI}`)).map((e) => [e.event, e.reason]),
  };
}

Deno.test("chain_gate 的紀錄：派工列的 opened_by 與 gap_events.detail 都帶 {after_step, via}；沒有 after_step 的規則（手動臂、election_discovery）沒有這個鍵", async () => {
  const db = await freshDb();
  await clock(db, "2027-03-01");
  await waitingElection(db, ICHI, "2027-04-25");
  // 兩種手動任務（網站請求＝manual_visitor、其餘＝manual_open）
  await db.query(`INSERT INTO policy_jp.contribution_tasks (title, task_type, description, source) VALUES ('手動のテスト', 'custom', '説明', 'manual')`);
  await db.query(`INSERT INTO policy_jp.contribution_tasks (title, task_type, source) VALUES ('サイト請求', 'custom', 'web_request')`);
  await seed(db);

  // 鏈上的列：dispatch 與 gap_events 一致
  for (const code of [AICHI, ICHI]) {
    const id = `auto:local_government_missing:${code}`;
    const d = (await chainDispatches(db)).find((x) => x.task_id === id)!;
    assertEquals(d.opened_by.chain_gate, { after_step: "discovery", via: "done" });
    assertEquals(d.opened_by.basis, "rule");
    assertEquals(d.opened_by.election_id, ICHI_ELECTION);
    assertEquals(d.priority, 2, "鏈沒有動優先層：沒有優先層規則＝預設層");
    const ev = await events(db, id);
    assertEquals(ev.length, 1);
    assertEquals(ev[0].detail.chain_gate, { after_step: "discovery", via: "done" });
    assertEquals(ev[0].detail.election_id, ICHI_ELECTION);
  }
  // 沒有 after_step 的規則：總表輸出與派工列都沒有 chain_gate 這個鍵（不是 null，是沒有）
  const others = await rows<{ arm: string; task_id: string; opened_by: Record<string, unknown> }>(
    db, `SELECT arm, task_id, opened_by FROM ${TOTAL}() WHERE arm NOT IN ('local_government_missing', 'regional_stats_missing') ORDER BY arm, task_id`);
  assertEquals([...new Set(others.map((o) => o.arm))], ["election_discovery", "manual_open", "manual_visitor"]);
  assert(others.length >= 3);
  for (const o of others) {
    assertEquals("chain_gate" in o.opened_by, false, `${o.arm} 不在鏈上`);
    assertEquals(o.opened_by.basis, "rule");
  }
  const dispatched = await rows<{ task_id: string; opened_by: Record<string, unknown> }>(
    db, `SELECT task_id, opened_by FROM policy_jp.task_dispatches WHERE task_type IN ('election_discovery', 'custom')`);
  assert(dispatched.length >= 3);
  for (const d of dispatched) assertEquals("chain_gate" in d.opened_by, false, d.task_id);
  const evOthers = await rows<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.gap_events WHERE task_type IN ('election_discovery', 'custom') AND detail ? 'chain_gate'`);
  assertEquals(evOthers[0].n, 0);
  // 規則上沒有 after_step 的只有這三條不在鏈上（規則表裡 after_step 非空的就是兩條）
  assertEquals(await rows(db, `SELECT activity, after_step FROM policy_jp.activity_rules WHERE after_step IS NOT NULL ORDER BY activity`),
    [{ activity: "local_government_missing", after_step: "discovery" }, { activity: "regional_stats_missing", after_step: "local_government" }]);
  await db.close();
});

Deno.test("覆寫（activity_overrides）：force=open 繞過鏈（rule_id 空＝after_step 空，統計任務不等前一步）、opened_by 沒有 chain_gate；force=closed 照樣關", async () => {
  const db = await freshDb();
  await clock(db, "2027-03-01");
  await waitingElection(db, ICHI, "2027-04-25");
  const stats = `auto:regional_stats_missing:${ICHI}`;
  await seed(db);
  assertEquals(await chainIds(db), [`auto:local_government_missing:${AICHI}`, `auto:local_government_missing:${ICHI}`], "沒有覆寫：統計擋著");

  await db.exec(`INSERT INTO policy_jp.activity_overrides (activity, "force", reason) VALUES ('regional_stats_missing', 'open', '維護者：先放統計')`);
  const open = (await armRows(db)).find((a) => a.task_id === stats)!;
  assertEquals(open.opened_by?.basis, "override");
  assert(open.opened_by?.override_id);
  assertEquals("rule_id" in (open.opened_by ?? {}), false);
  assertEquals("chain_gate" in (open.opened_by ?? {}), false, "覆寫開的列不過 gate");
  await seed(db);
  assertEquals(await chainIds(db), [`auto:local_government_missing:${AICHI}`, `auto:local_government_missing:${ICHI}`, stats]);
  assertEquals((await events(db, stats)).map((e) => [e.event, "chain_gate" in e.detail]), [["opened", false]]);

  // force=closed：鏈的規則再怎麼說「done」也關著
  await db.exec(`INSERT INTO policy_jp.activity_overrides (activity, "force", reason) VALUES ('local_government_missing', 'closed', '維護者：先停團體任務')`);
  assertEquals((await armRows(db)).map((a) => a.task_id), [stats]);
  assertEquals((await armRows(db, true)).filter((a) => a.opened_by === null).map((a) => a.task_id), [`auto:local_government_missing:${AICHI}`, `auto:local_government_missing:${ICHI}`]);
  await seed(db);
  assertEquals(await chainIds(db), [stats]);
  assertEquals((await events(db, `auto:local_government_missing:${ICHI}`)).map((e) => [e.event, e.reason]), [["opened", null], ["closed", "window"]]);
  await db.close();
});

// =============================================================================================
// c. 進度視圖與逃生門
// =============================================================================================
Deno.test("進度視圖：步驟清單恰好四步、每場開著的選舉每步一列；region＝local_government 而且 regional_stats；行政区＝統計 done；done_at 只有 done 才有值", async () => {
  const db = await freshDb();
  await clock(db, "2027-03-01");
  assertEquals((await one<{ s: string[] }>(db, `SELECT policy_jp.election_chain_steps() AS s`)).s, ["discovery", "local_government", "regional_stats", "region"]);

  const A = await insertElection(db, ICHI, "2027-04-25");                 // 團體在庫、統計缺
  const B = await insertElection(db, KOMORO, "2027-04-25");                // 團體在庫、統計齊
  await fillStats(db, KOMORO);
  await waitingElection(db, HAKODATE, "2027-04-11");                       // 團體不在庫、統計缺
  const C = "2027-04-11_mayor_012025";
  await waitingElection(db, SAPPORO, "2027-04-11");                        // 團體不在庫、統計回報查無（冷卻中）
  const D = "2027-04-11_mayor_011002";
  await notFound(db, `auto:regional_stats_missing:${SAPPORO}`);
  const E = await insertElection(db, CHIKUSA, "2027-04-25");               // 行政区：不收統計
  const F = await insertElection(db, NAGANO, "2027-04-11", { type: "governor" }); // 都道府県的選舉：兩個碼相同
  const T = true, Fa = false;
  const expected: Record<string, Record<string, boolean>> = {
    [A]: { discovery: T, local_government: T, regional_stats: Fa, region: Fa },
    [B]: { discovery: T, local_government: T, regional_stats: T, region: T },
    [C]: { discovery: T, local_government: Fa, regional_stats: Fa, region: Fa },
    [D]: { discovery: T, local_government: Fa, regional_stats: T, region: Fa }, // 統計 done 而前一步沒 done：region 不 done（AND）
    [E]: { discovery: T, local_government: T, regional_stats: T, region: T },
    [F]: { discovery: T, local_government: T, regional_stats: Fa, region: Fa },
  };
  const all = await progress(db);
  assertEquals(all.length, 6 * 4);
  for (const [eid, want] of Object.entries(expected)) {
    const mine = all.filter((p) => p.election_id === eid);
    assertEquals(mine.map((p) => p.step).sort(), ["discovery", "local_government", "region", "regional_stats"], `${eid} 恰好四步`);
    assertEquals(Object.fromEntries(mine.map((p) => [p.step, p.done])), want, eid);
    assertEquals(new Set(mine.map((p) => p.lg_code)).size, 1);
  }
  for (const p of all) assertEquals(p.done_at !== null, p.done, `${p.election_id} ${p.step}：done_at 只有 done 才有值`);
  assertEquals(all.find((p) => p.election_id === F && p.step === "discovery")!.lg_code, NAGANO);

  // 冷卻到期：D 的統計又變成未完成（查無只是暫時當作做完）
  await expireCooling(db);
  assertEquals((await stepsDone(db, D)).regional_stats, false);
  // 團體進庫（都道府県先）→ 選舉交件落庫、以 published 回來；前一步 done
  await landLgs(db, [HOKKAIDO, SAPPORO]);
  assertEquals(await rows(db, `SELECT election_id, basis FROM policy_jp.chain_open_elections WHERE election_id = $1`, [D]), [{ election_id: D, basis: "published" }]);
  assertEquals(await stepsDone(db, D), { discovery: true, local_government: true, regional_stats: false, region: false });
  await db.close();
});

Deno.test("統計判準（臂與進度視圖共用 chain_regional_stats_missing）：published 才算、年份不得早於 min_year、四項都要；排除的種類・停用的規則＝NULL；臂有沒有這個團體 ＝ 統計步驟 done 與否", async () => {
  const db = await freshDb();
  await clock(db, "2027-03-01");
  await insertElection(db, ICHI, "2027-04-25");
  const sid = await sourceId(db);
  const put = (key: string, year: number, value: number, status = "published") =>
    db.query(`INSERT INTO policy_jp.regional_stats (lg_code, stat_key, year, value, unit, source_id, review_status) VALUES ($1, $2, $3, $4, policy_jp.regional_stat_unit($2), $5, $6)`, [ICHI, key, year, value, sid, status]);
  const missing = async () => (await one<{ m: Array<{ stat_key: string; min_year: number; unit: string }> | null }>(db, `SELECT policy_jp.chain_regional_stats_missing($1) AS m`, [ICHI])).m;
  const check = async (done: boolean, why: string) => {
    assertEquals((await stepsDone(db, ICHI_ELECTION)).regional_stats, done, `進度 ${why}`);
    assertEquals(await count(db, `SELECT 1 FROM ${ARM_ST}()`), done ? 0 : 1, `臂 ${why}`);
    assertEquals((await missing()) === null, done, `函式 ${why}`);
  };
  await check(false, "什麼都沒有");
  assertEquals(await missing(), [
    { stat_key: "aging_rate", min_year: 2020, unit: "%" }, { stat_key: "area_km2", min_year: 2020, unit: "km2" },
    { stat_key: "budget_expenditure", min_year: 2023, unit: "千円" }, { stat_key: "population", min_year: 2020, unit: "人" }]);
  await put("population", 2020, 386678);
  await put("area_km2", 2019, 113.8);                  // min_year 未満
  await put("aging_rate", 2020, 28.6, "pending");      // 還沒上線
  await put("budget_expenditure", 2022, 1000);         // 歳出的 min_year 是 2023
  await check(false, "只有人口");
  assertEquals((await missing())!.map((m) => m.stat_key), ["aging_rate", "area_km2", "budget_expenditure"]);
  await put("area_km2", 2023, 113.9);
  await db.exec(`UPDATE policy_jp.regional_stats SET review_status = 'published' WHERE stat_key = 'aging_rate'`);
  await put("budget_expenditure", 2023, 1200, "rejected");
  await check(false, "歳出只有 rejected");
  await db.exec(`UPDATE policy_jp.regional_stats SET review_status = 'published' WHERE stat_key = 'budget_expenditure' AND year = 2023`);
  await check(true, "四項都齊");
  const done = (await progress(db, ICHI_ELECTION)).find((p) => p.step === "regional_stats")!;
  assertEquals(done.done, true);
  assert(done.done_at);

  // min_year 調高（規則一行）→ 又缺
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{min_year,population}', '2025') WHERE activity = 'regional_stats_missing'`);
  await check(false, "population min_year 2025");
  assertEquals((await missing())!.map((m) => [m.stat_key, m.min_year]), [["population", 2025]]);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{min_year,population}', '2020') WHERE activity = 'regional_stats_missing'`);
  await check(true, "min_year 還原");

  // 種類排除（規則一行）：core_city 排除 → 即使什麼都沒有也 done
  await db.exec(`DELETE FROM policy_jp.regional_stats`);
  await check(false, "統計清空");
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{exclude_kinds}', '["admin_ward", "core_city"]') WHERE activity = 'regional_stats_missing'`);
  await check(true, "core_city 被排除");
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{exclude_kinds}', '["admin_ward"]') WHERE activity = 'regional_stats_missing'`);
  // 規則停用：函式回 NULL（沒有規則就沒有要求）
  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = false WHERE activity = 'regional_stats_missing'`);
  assertEquals(await missing(), null);
  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = true WHERE activity = 'regional_stats_missing'`);
  // 團體還沒進庫（等團體的選舉）：種類從總務省團體碼表取——行政区排除、市區町村不排除
  assertEquals((await one<{ m: unknown }>(db, `SELECT policy_jp.chain_regional_stats_missing($1) AS m`, [CHIKUSA])).m, null, "行政区（團體碼表的種類）");
  assertEquals((await one<{ m: unknown[] }>(db, `SELECT policy_jp.chain_regional_stats_missing($1) AS m`, [KOMORO])).m.length, 4);
  await db.close();
});

Deno.test("逃生門 activity_chain_escape：後備里程碑到了＝fallback、開過＝sticky、都不是＝NULL；fallback 優先；里程碑的職位要對得上；closed 事件不算開過", async () => {
  const db = await freshDb();
  const eid = await insertElection(db, ICHI, "2027-04-25");
  const esc = async (fb: unknown, today: string, o: { type?: string | null; task?: string; election?: string } = {}) =>
    (await one<{ x: string | null }>(db, `SELECT policy_jp.activity_chain_escape($1::JSONB, $2, $3, $4, $5::DATE) AS x`,
      [fb === null ? null : JSON.stringify(fb), o.election ?? eid, o.type === undefined ? "mayor" : o.type, o.task ?? "auto:t:1", today])).x;
  const polling = (offset: number) => ({ kind: "polling", offset });
  // 投票日 4/25 的前 45 天＝3/11
  assertEquals(await esc(polling(-45), "2027-03-10"), null);
  assertEquals(await esc(polling(-45), "2027-03-11"), "fallback");
  assertEquals(await esc(polling(-45), "2027-12-31"), "fallback");
  assertEquals(await esc(polling(10), "2027-05-04"), null);
  assertEquals(await esc(polling(10), "2027-05-05"), "fallback");
  assertEquals(await esc(polling(0), "2027-04-25"), "fallback");
  // 職位：整場的里程碑（polling）、職位不限；沒有職位（NULL）時只認整場的
  assertEquals(await esc(polling(-45), "2027-03-11", { type: null }), "fallback");
  // 沒有這個選舉／沒有後備／後備不是物件
  assertEquals(await esc(polling(-45), "2027-12-31", { election: "2027-04-25_mayor_999997" }), null);
  assertEquals(await esc(null, "2027-12-31"), null);
  assertEquals(await esc("polling", "2027-12-31"), null);
  assertEquals(await esc([], "2027-12-31"), null);
  assertEquals(await esc({}, "2027-12-31"), null);
  // 別種里程碑：沒有那一列＝NULL；別的職位的列不算；同職位或整場的算
  const ms = (kind: string, type: string | null, date: string) => db.query(
    `INSERT INTO policy_jp.election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES ($1, $2, $3, $4, 'official', 'done')`, [eid, kind, type, date]);
  const lp = { kind: "list_published", offset: 0 };
  assertEquals(await esc(lp, "2027-12-31"), null);
  await ms("list_published", "governor", "2027-04-10");
  assertEquals(await esc(lp, "2027-12-31"), null, "別的職位的名單公告不算");
  assertEquals(await esc(lp, "2027-12-31", { type: "governor" }), "fallback");
  assertEquals(await esc(lp, "2027-12-31", { type: null }), null);
  await ms("registration_close", null, "2027-04-12");  // 整場
  assertEquals(await esc({ kind: "registration_close", offset: 0 }, "2027-04-11", { type: "mayor" }), null);
  assertEquals(await esc({ kind: "registration_close", offset: 0 }, "2027-04-12", { type: "mayor" }), "fallback");
  assertEquals(await esc({ kind: "registration_close", offset: 0 }, "2027-04-12", { type: null }), "fallback");
  // sticky：這個任務以前開過（opened／reopened）；closed 不算
  const ev = (task: string, event: string) => db.query(`INSERT INTO policy_jp.gap_events (task_id, task_type, event) VALUES ($1, 'x', $2)`, [task, event]);
  await ev("auto:t:1", "opened");
  await ev("auto:t:2", "closed");
  await ev("auto:t:3", "reopened");
  assertEquals(await esc(null, "2027-12-31", { task: "auto:t:1" }), "sticky");
  assertEquals(await esc(null, "2027-12-31", { task: "auto:t:2" }), null, "只有 closed 的紀錄＝沒開過（不會出現，但函式不該把它當開過）");
  assertEquals(await esc(null, "2027-12-31", { task: "auto:t:3" }), "sticky");
  assertEquals(await esc(null, "2027-12-31", { task: "auto:t:4" }), null);
  assertEquals(await esc(polling(-45), "2027-03-10", { task: "auto:t:1" }), "sticky", "後備沒到、開過");
  assertEquals(await esc(polling(-45), "2027-03-11", { task: "auto:t:1" }), "fallback", "兩個都成立：fallback 優先（記錄的是『為什麼現在開著』）");
  // 範圍鍵：臂寫 chain_lg_code，沒寫就用 lg_code，空字串當沒有
  const scope = async (t: unknown) => (await one<{ s: string | null }>(db, `SELECT policy_jp.activity_chain_scope($1::JSONB) AS s`, [JSON.stringify(t)])).s;
  assertEquals(await scope({ chain_lg_code: ICHI, lg_code: AICHI }), ICHI);
  assertEquals(await scope({ lg_code: AICHI }), AICHI);
  assertEquals(await scope({ chain_lg_code: "", lg_code: AICHI }), AICHI);
  assertEquals(await scope({ title: "x" }), null);
  assertEquals(await scope({ chain_lg_code: "", lg_code: "" }), null);
  await db.close();
});
