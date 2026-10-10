/**
 * 日本站選舉鏈「最近的選舉先派」（migration 20261009300000_policy_jp_chain_priority.sql；維護者 10-09）。
 *
 * 只要 --allow-read。PGlite 上套日本站「全部」policy_jp migration（檔名帶 _policy_jp_，照時間戳順序），資料庫裡沒有任何正見（public）物件；
 * 時鐘用 `SET app.activity_today`，整條流程走 seed_auto_task_queue()（尾端呼叫 rebalance_queue）→ task_dispatches.priority／queue_at。
 *
 *   a. 層：投票日前 60 天內＝前段、61～180 天＝中段、181 天以上＝後段（三場選舉，倒著開出來，seed 後 queue_at 由近到遠、priority 1／2／3）；邊界天數（60／61／180／181）
 *   b. 同層內：步驟（選舉發現 < 團體 < 統計）先於日期先於先進先出——即使統計任務先開、日期更近；沒有 polling 里程碑的缺口（等團體落庫的選舉、選舉發現）依 target 日期定層
 *   c. cap 截斷：兩支臂的 ORDER BY 沒有「都道府県先」的鍵，cap=1 留下的是最近的選舉（還原驗證：把舊的 ORDER BY 放回去，留下的就是都道府県）；regional_stats 仍保留 lg_present DESC
 *   d. 還原驗證：把 rebalance_queue 的層內排序鍵換回 queue_at，b 的順序就變回先進先出（測試咬得到）
 *   e. 不動的：手動任務（無 auto: 前綴）步驟 0 排同層最前、層間 6:3:1 交錯照舊（驗證列 2:1 由 policy-jp-dispatch.test.ts 守）；規則只多四條 priority: 規則，manual_visitor 規則還在
 *   f. 步驟順位函式可擴充：沒登記的 auto 型別排在已登記的後面；日期函式／層函式的邊界
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { migrationNames } from "./arms-pglite.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const MIG_FILE = "20261009300000_policy_jp_chain_priority.sql";
const JP_FILES = (await migrationNames()).filter((n) => n.includes("_policy_jp_"));
const JP_SQL = Object.fromEntries(await Promise.all(JP_FILES.map(async (n) => [n, await read(n)] as const)));
assert(JP_FILES.includes(MIG_FILE), "掃得到這支 migration");
// 之後的 policy_jp migration 不得再改寫這支動到的函式（否則這裡測的就不是線上的版本）；改了要更新這支測試。
// 例外：chain_step_rank 是鏈上加步驟的擴充點（"多一行 WHEN"），第 2～4 步的 migration 各加一行；它們的順位由 policy-jp-chain-*.test.ts 守，
// 這裡只守既有的相對順序（選舉發現 < 團體 < 統計）與『沒登記的 auto 型別排最後』（下面 f）
for (const later of JP_FILES.filter((n) => n > MIG_FILE)) {
  for (const fn of ["rebalance_queue", "seed_auto_task_queue", "contribution_auto_tasks_regional_stats_missing", "contribution_auto_tasks_local_government_missing", "chain_date_tier", "chain_sort_date"]) {
    assert(!new RegExp("FUNCTION\\s+policy_jp\\." + fn + "\\s*\\(").test(JP_SQL[later]), `${later} 改寫了 policy_jp.${fn}，請更新 policy-jp-chain-priority.test.ts`);
  }
}

const ROLES = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;
/** 全部 policy_jp migration 套一遍；patch：換掉這支 migration 的內容（還原驗證用） */
async function freshDb(patch?: (sql: string) => string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  for (const n of JP_FILES) await db.exec(n === MIG_FILE && patch ? patch(JP_SQL[n]) : JP_SQL[n]);
  return db;
}
const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rows = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 70)}`);
  return sql.replace(from, () => to);
}
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const clock = (db: PGlite, day: string) => db.exec(`SET app.activity_today = '${day}'`);
const seed = (db: PGlite) => db.query(`SELECT policy_jp.seed_auto_task_queue()`);

// ---------------------------------------------------------------------------------------------
// 固定的團體：團體碼表（總務省）裡真的有的
// ---------------------------------------------------------------------------------------------
type Reg = { lg_code: string; pref_code: string; name: string; kana: string; kind: string };
const AICHI = "230006", ICHI = "232033", NAGANO = "200000", KOMORO = "202088", HAKODATE = "012025", SAPPORO = "011002", CHIKUSA = "231011";
const TODAY = "2027-03-01";
/** 團體直接進庫（都道府県先） */
async function insertLg(db: PGlite, code: string): Promise<void> {
  const r = await one<Reg>(db, `SELECT lg_code, pref_code, name, kana, kind FROM policy_jp.lg_code_registry WHERE lg_code = $1`, [code]);
  if (r.pref_code !== code) await insertLg(db, r.pref_code);
  await db.query(`INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ($1, $2, $3, $4, $5, $1) ON CONFLICT DO NOTHING`,
    [r.lg_code, r.kind, r.pref_code, r.name, r.kana]);
}
/** 已上線的選舉直接進庫；回 id */
async function insertElection(db: PGlite, lg: string, date: string, type = "mayor"): Promise<string> {
  const id = `${date}_${type}_${lg}`;
  await insertLg(db, lg);
  await db.query(
    `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code, review_status)
     VALUES ($1, $2, $3, $4, 'regular', policy_jp.election_level($4), $5, 'published')`,
    [id, `${id}選挙`, date, type, lg]);
  return id;
}
let seq = 0;
/** 通過驗證、只在等團體落庫的選舉交件（團體不在庫裡，開出團體任務） */
async function waitingElection(db: PGlite, lg: string, date: string): Promise<void> {
  const n = ++seq;
  await db.query(
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash, status, verified_at)
     VALUES ('election', $1::JSONB, ARRAY['https://www.city.example.jp/senkyo/'], $2, $3, $4, 'verified', now())`,
    [JSON.stringify({ lg_code: lg, election_type: "mayor", election_reason: "regular", election_date: date, notice_date: addDays(date, -17) }), `author-${n}`, `ip-${n}`, `h-${n}`]);
}
/** 團體只留指定的（與它們的都道府県）：總務省團體碼表的 1,965 團體是 migration 預先建好的，要「團體不在庫」的缺口就得先清掉。先刪市區町村、再刪都道府県（外鍵） */
async function keepOnly(db: PGlite, codes: string[]): Promise<void> {
  const keep = new Set(codes);
  for (const c of codes) keep.add((await one<{ p: string }>(db, `SELECT policy_jp.lg_pref_code($1) AS p`, [c])).p);
  await db.query(`DELETE FROM policy_jp.local_governments WHERE kind <> 'prefecture' AND lg_code <> ALL($1::TEXT[])`, [[...keep]]);
  await db.query(`DELETE FROM policy_jp.local_governments WHERE lg_code <> ALL($1::TEXT[])`, [[...keep]]);
}
/** 只留一列任期満了調査（其餘刪掉，免得 50 件的選舉發現把順序攪混），満了日改成指定的 */
async function onlyTerm(db: PGlite, lg: string, termEnd: string | null): Promise<void> {
  await db.query(`DELETE FROM policy_jp.term_expirations WHERE NOT (lg_code = $1 AND office_kind = 'head')`, [lg]);
  if (termEnd === null) await db.query(`DELETE FROM policy_jp.term_expirations`);
  else await db.query(`UPDATE policy_jp.term_expirations SET term_end = $2 WHERE lg_code = $1`, [lg, termEnd]);
}

type D = { task_id: string; task_type: string; priority: number; queue_at: string };
/** 鏈上與選舉發現的派工列，照派工順序（queue_at） */
const queueOrder = (db: PGlite) => rows<D>(db,
  `SELECT task_id, task_type, priority, queue_at FROM policy_jp.task_dispatches
    WHERE task_type IN ('election_discovery', 'local_government_missing', 'regional_stats_missing') ORDER BY queue_at, task_id`);
const ids = (ds: D[]) => ds.map((d) => d.task_id);

// =============================================================================================
// a. 層：前／中／後段，三場選舉倒著開出來，seed 後由近到遠
// =============================================================================================
/** 三場已上線的選舉（20、100、300 天後）；每場開一個統計缺口。倒著開：300 → 100 → 20，每開一場 seed 一次 */
async function threeElections(db: PGlite): Promise<{ near: string; mid: string; far: string }> {
  await clock(db, TODAY);
  await onlyTerm(db, ICHI, null); // 沒有選舉發現
  const far = await insertElection(db, KOMORO, addDays(TODAY, 300));
  await seed(db);
  const mid = await insertElection(db, HAKODATE, addDays(TODAY, 100));
  await seed(db);
  const near = await insertElection(db, ICHI, addDays(TODAY, 20));
  await seed(db);
  return { near, mid, far };
}

Deno.test("層：投票日 20／100／300 天後的三場選舉（倒著開出來），seed＋重排後 queue_at 由近到遠，層是前段／中段／後段", async () => {
  const db = await freshDb();
  const { near, mid, far } = await threeElections(db);
  const q = await queueOrder(db);
  assertEquals(ids(q), [`auto:regional_stats_missing:${ICHI}`, `auto:regional_stats_missing:${HAKODATE}`, `auto:regional_stats_missing:${KOMORO}`]);
  assertEquals(q.map((d) => d.priority), [1, 2, 3], "前段／中段／後段");
  // 層的來源是規則（priority:regional_stats_missing），不是寫死：opened_by 記規則 id，中段（預設層）沒有規則
  const ob = await rows<{ task_id: string; rid: string | null }>(db,
    `SELECT task_id, opened_by->>'priority_rule_id' AS rid FROM policy_jp.task_dispatches WHERE task_type = 'regional_stats_missing' ORDER BY task_id`);
  const by = Object.fromEntries(ob.map((o) => [o.task_id.split(":").pop()!, o.rid]));
  assert(by[ICHI] !== null && by[KOMORO] !== null && by[HAKODATE] === null, JSON.stringify(by));
  assertEquals((await queueOrder(db)).length, 3);
  // 選舉 id 帶在 target，用來排序
  const t = await rows<{ e: string }>(db, `SELECT target->>'election_id' AS e FROM policy_jp.task_dispatches WHERE task_type = 'regional_stats_missing' ORDER BY queue_at`);
  assertEquals(t.map((x) => x.e), [near, mid, far]);
  await db.close();
});

Deno.test("層的邊界：投票日前 60 天＝前段、61 天＝中段、180 天＝中段、181 天＝後段；投票後（鏈還開著）仍是前段", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  await onlyTerm(db, ICHI, null);
  const cases: Array<[string, number, number]> = [[KOMORO, 60, 1], [HAKODATE, 61, 2], [SAPPORO, 180, 2], ["202037", 181, 3], [ICHI, -10, 1]];
  for (const [lg, days] of cases) await insertElection(db, lg, addDays(TODAY, days));
  await seed(db);
  const got = await rows<{ lg: string; priority: number }>(db,
    `SELECT target->>'lg_code' AS lg, priority FROM policy_jp.task_dispatches WHERE task_type = 'regional_stats_missing'`);
  const m = Object.fromEntries(got.map((g) => [g.lg, g.priority]));
  for (const [lg, days, tier] of cases) assertEquals(m[lg], tier, `${lg}（${days} 天後）`);
  // 日期 → 層函式與規則同一組數字
  const f = (d: number) => one<{ t: number }>(db, `SELECT policy_jp.chain_date_tier($1::DATE, $2::DATE) AS t`, [addDays(TODAY, d), TODAY]).then((r) => r.t);
  assertEquals([await f(-5), await f(60), await f(61), await f(180), await f(181)], [1, 1, 2, 2, 3]);
  assertEquals((await one<{ t: number }>(db, `SELECT policy_jp.chain_date_tier(NULL, $1::DATE) AS t`, [TODAY])).t, 2, "沒有日期＝預設層");
  await db.close();
});

// =============================================================================================
// b. 同層內：步驟 → 日期 → 先進先出（統計先開、日期更近，仍排在團體與選舉發現後面）
// =============================================================================================
/** 同一層（中段）放進三種任務，開出來的順序刻意相反：統計（100 天後）→ 團體（等團體落庫的選舉，120 天後）→ 選舉發現（満了日 140 天後，投票窗口起日 110 天後） */
async function sameTierScenario(db: PGlite): Promise<void> {
  await clock(db, TODAY);
  await onlyTerm(db, ICHI, addDays(TODAY, 900)); // 先把選舉發現擺在範圍外（満了日 900 天後）
  // 團體缺口要有團體不在庫的環境：總務省團體碼表的 1,965 團體是 migration 預先建好的，把用不到的清掉（這時沒有任何列指向它們）
  await db.query(`DELETE FROM policy_jp.local_governments`);
  // 統計缺口：已上線的選舉（小諸市，100 天後），團體在庫
  await insertElection(db, KOMORO, addDays(TODAY, 100));
  await seed(db);
  // 再開團體：等團體落庫的選舉（函館市，120 天後）→ 函館市與北海道兩件
  await waitingElection(db, HAKODATE, addDays(TODAY, 120));
  await seed(db);
  // 最後開選舉發現
  await db.query(`UPDATE policy_jp.term_expirations SET term_end = $1`, [addDays(TODAY, 140)]);
  await seed(db);
}

Deno.test("同層內：選舉發現 → 團體（都道府県與市） → 統計，即使統計先開、日期更近；各步驟內由近到遠", async () => {
  const db = await freshDb();
  await sameTierScenario(db);
  const q = await queueOrder(db);
  assertEquals(q.map((d) => d.task_type), ["election_discovery", "local_government_missing", "local_government_missing", "regional_stats_missing"]);
  assertEquals(new Set(q.map((d) => d.priority)), new Set([2]), "三種都在中段（沒有 polling 里程碑的靠 target 日期定層：110／120 天後＝中段）");
  assertEquals(q[0].task_id, `auto:election_discovery:${addDays(TODAY, 140)}:${ICHI}:head`);
  assertEquals(q[3].task_id, `auto:regional_stats_missing:${KOMORO}`);
  // 團體兩件同日，先進先出（先開的先）；是北海道與函館市
  assertEquals(new Set([q[1].task_id, q[2].task_id]), new Set([`auto:local_government_missing:010006`, `auto:local_government_missing:${HAKODATE}`]));
  await db.close();
});

Deno.test("同層同步驟：日期近的先（等團體落庫的選舉 30 天後、200 天後，後者先開）；沒有 polling 里程碑的缺口依 target 日期定層（前段／後段）", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  await onlyTerm(db, ICHI, null);
  await db.query(`DELETE FROM policy_jp.local_governments WHERE lg_code NOT IN ('200000')`);
  await waitingElection(db, HAKODATE, addDays(TODAY, 200)); // 北海道・函館市
  await seed(db);
  await waitingElection(db, SAPPORO, addDays(TODAY, 30)); // 北海道（同上，掛在投票日最早的那場）・札幌市
  await seed(db);
  const q = await queueOrder(db);
  const lgs = q.map((d) => d.task_id.split(":").pop());
  // 北海道（010006）掛在投票日最早的那場（30 天後＝前段）→ 札幌市（前段）→ 函館市（200 天後＝後段）
  assertEquals(lgs, ["010006", SAPPORO, HAKODATE]);
  assertEquals(q.map((d) => d.priority), [1, 1, 3]);
  await db.close();
});

// =============================================================================================
// d. 還原驗證：層內排序鍵換回 queue_at，順序就變回先進先出
// =============================================================================================
Deno.test("還原驗證：rebalance_queue 的層內排序鍵換回 queue_at，同層的順序變成先進先出（統計、團體、選舉發現）", async () => {
  const db = await freshDb((sql) => mutate(sql, "ORDER BY w.srank, w.sdate NULLS LAST, w.queue_at, w.task_id) AS k FROM w", "ORDER BY w.queue_at, w.task_id) AS k FROM w"));
  await sameTierScenario(db);
  const q = await queueOrder(db);
  assertEquals(q.map((d) => d.task_type), ["regional_stats_missing", "local_government_missing", "local_government_missing", "election_discovery"], "先開的先派");
  await db.close();
});

Deno.test("還原驗證：只拿掉步驟鍵、留日期鍵，三場選舉一樣由近到遠但同層的步驟順序就沒了（日期 100 天的統計排在 120 天的團體前面）", async () => {
  const db = await freshDb((sql) => mutate(sql, "ORDER BY w.srank, w.sdate NULLS LAST, w.queue_at, w.task_id) AS k FROM w", "ORDER BY w.sdate NULLS LAST, w.queue_at, w.task_id) AS k FROM w"));
  await sameTierScenario(db);
  const q = await queueOrder(db);
  assertEquals(q.map((d) => d.task_type), ["regional_stats_missing", "election_discovery", "local_government_missing", "local_government_missing"], "100 → 110 → 120 天");
  await db.close();
});

Deno.test("還原驗證：選舉發現／等團體的選舉不定層（拿掉 seed 的日期定層一段），就都落預設層（中段）；有這一段：満了日 60 天後的選舉發現＝前段、300 天後才投票的等團體選舉＝後段", async () => {
  const run = async (db: PGlite) => {
    await clock(db, TODAY);
    await onlyTerm(db, ICHI, addDays(TODAY, 60)); // 投票窗口起日＝満了日 −30 → 30 天後：前段
    await keepOnly(db, []);
    await waitingElection(db, HAKODATE, addDays(TODAY, 300)); // 300 天後：後段
    await seed(db);
    return Object.fromEntries((await queueOrder(db)).map((d) => [d.task_type === "election_discovery" ? "discovery" : d.task_id.split(":").pop(), d.priority]));
  };
  const db = await freshDb();
  assertEquals(await run(db), { discovery: 1, "010006": 3, [HAKODATE]: 3 });
  await db.close();
  const db2 = await freshDb((sql) => {
    const a = sql.indexOf("  -- >>> 日本版：選舉發現的層\n");
    const b = sql.indexOf("  -- <<< 日本版：選舉發現的層\n") + "  -- <<< 日本版：選舉發現的層\n".length;
    assert(a > 0 && b > a);
    return sql.slice(0, a) + sql.slice(b);
  });
  assertEquals(await run(db2), { discovery: 2, "010006": 2, [HAKODATE]: 2 }, "沒有定層＝預設層");
  await db2.close();
});

// =============================================================================================
// c. cap 截斷：不再「都道府県先」，留下最近的選舉
// =============================================================================================
const OLD_ORDER_STATS = "ORDER BY c.lg_present DESC, COALESCE(c.kind = 'prefecture', false) DESC, c.election_date, c.lg_code";
const NEW_ORDER_STATS = "ORDER BY c.lg_present DESC, c.election_date, c.lg_code";
const OLD_ORDER_LG = "ORDER BY (substr(c.code, 3, 3) = '000') DESC, c.election_date, c.code";
const NEW_ORDER_LG = "ORDER BY c.election_date, c.code";

async function capScenario(db: PGlite): Promise<void> {
  await clock(db, TODAY);
  await onlyTerm(db, ICHI, null);
  // 長野県知事選（都道府県，300 天後）與愛知県一宮市長選（20 天後）；統計缺口 cap=1 只能留一件
  await insertElection(db, NAGANO, addDays(TODAY, 300), "governor");
  await insertElection(db, ICHI, addDays(TODAY, 20));
  await db.query(`UPDATE policy_jp.activity_rules SET params = params || '{"cap":1}'::JSONB WHERE activity IN ('regional_stats_missing', 'local_government_missing') AND priority IS NULL`);
}
const armIds = async (db: PGlite, arm: string) => (await rows<{ task_id: string }>(db, `SELECT task_id FROM policy_jp.contribution_auto_tasks_${arm}() ORDER BY task_id`)).map((r) => r.task_id);

Deno.test("cap 截斷（統計）：cap=1 時留下最近的選舉（一宮市 20 天後），不是都道府県（長野県 300 天後）", async () => {
  const db = await freshDb();
  await capScenario(db);
  assertEquals(await armIds(db, "regional_stats_missing"), [`auto:regional_stats_missing:${ICHI}`]);
  await db.close();
});

Deno.test("還原驗證（統計）：把舊的 ORDER BY（都道府県先）放回去，cap=1 留下的就變成長野県", async () => {
  const db = await freshDb((sql) => mutate(sql, NEW_ORDER_STATS, OLD_ORDER_STATS));
  await capScenario(db);
  assertEquals(await armIds(db, "regional_stats_missing"), [`auto:regional_stats_missing:${NAGANO}`]);
  await db.close();
});

Deno.test("cap 截斷（統計）：lg_present DESC 還在——團體不在庫的列排在後面，不佔 cap 名額", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  await onlyTerm(db, ICHI, null);
  await insertElection(db, KOMORO, addDays(TODAY, 100)); // 團體在庫
  await waitingElection(db, HAKODATE, addDays(TODAY, 10)); // 更近，但團體不在庫（函館市在 migration 預先建好的團體裡，先刪掉）
  await keepOnly(db, [KOMORO]);
  await db.query(`UPDATE policy_jp.activity_rules SET params = params || '{"cap":1}'::JSONB WHERE activity = 'regional_stats_missing' AND priority IS NULL`);
  assertEquals(await armIds(db, "regional_stats_missing"), [`auto:regional_stats_missing:${KOMORO}`], "團體在庫的先留");
  await db.close();
  // 還原驗證：拿掉 lg_present DESC，近的（但被 gate 擋的）就佔走名額
  const db2 = await freshDb((sql) => mutate(sql, NEW_ORDER_STATS, "ORDER BY c.election_date, c.lg_code"));
  await clock(db2, TODAY);
  await onlyTerm(db2, ICHI, null);
  await insertElection(db2, KOMORO, addDays(TODAY, 100));
  await waitingElection(db2, HAKODATE, addDays(TODAY, 10));
  await keepOnly(db2, [KOMORO]);
  await db2.query(`UPDATE policy_jp.activity_rules SET params = params || '{"cap":1}'::JSONB WHERE activity = 'regional_stats_missing' AND priority IS NULL`);
  assertEquals(await armIds(db2, "regional_stats_missing"), [`auto:regional_stats_missing:${HAKODATE}`]);
  await db2.close();
});

Deno.test("cap 截斷（團體）：cap=1 時留下最近的選舉的團體，不是都道府県；還原驗證：舊的 ORDER BY 放回去就變成都道府県", async () => {
  const prep = async (db: PGlite) => {
    await clock(db, TODAY);
    await onlyTerm(db, ICHI, null);
    await db.query(`DELETE FROM policy_jp.local_governments`);
    await waitingElection(db, HAKODATE, addDays(TODAY, 300)); // 北海道・函館市（遠）
    await waitingElection(db, CHIKUSA, addDays(TODAY, 20)); // 愛知県・名古屋市・千種区（近）
    await db.query(`UPDATE policy_jp.activity_rules SET params = params || '{"cap":1}'::JSONB WHERE activity = 'local_government_missing' AND priority IS NULL`);
  };
  const db = await freshDb();
  await prep(db);
  // 掛在投票日最早那場的團體：千種区、愛知県（20 天後）／函館市、北海道（300 天後）；cap=1 → 近的兩個之一（日期同，碼小的先＝愛知県 230006）
  assertEquals(await armIds(db, "local_government_missing"), [`auto:local_government_missing:${AICHI}`]);
  await db.close();
  const db2 = await freshDb((sql) => mutate(sql, NEW_ORDER_LG, OLD_ORDER_LG));
  await prep(db2);
  // 舊：都道府県先，兩個都道府県（010006、230006）之間才比日期 → 還是愛知県；改用遠的都道府県在前的情境才分得出來
  assertEquals(await armIds(db2, "local_government_missing"), [`auto:local_government_missing:${AICHI}`]);
  await db2.close();
  // 能分出來的情境：近的是市區（沒有都道府県在近的那場裡），遠的是都道府県選舉
  const prep2 = async (db: PGlite) => {
    await clock(db, TODAY);
    await onlyTerm(db, ICHI, null);
    await db.query(`DELETE FROM policy_jp.local_governments WHERE lg_code NOT IN ('230006', '010006')`);
    await waitingElection(db, "010006", addDays(TODAY, 300)); // 北海道知事選（遠）：缺的只有北海道（已刪就缺）
    await db.query(`DELETE FROM policy_jp.local_governments WHERE lg_code = '010006'`);
    await waitingElection(db, ICHI, addDays(TODAY, 20)); // 一宮市長選（近）：愛知県在庫，缺一宮市
    await db.query(`UPDATE policy_jp.activity_rules SET params = params || '{"cap":1}'::JSONB WHERE activity = 'local_government_missing' AND priority IS NULL`);
  };
  const db3 = await freshDb();
  await prep2(db3);
  assertEquals(await armIds(db3, "local_government_missing"), [`auto:local_government_missing:${ICHI}`], "近的一宮市先（新）");
  await db3.close();
  const db4 = await freshDb((sql) => mutate(sql, NEW_ORDER_LG, OLD_ORDER_LG));
  await prep2(db4);
  assertEquals(await armIds(db4, "local_government_missing"), [`auto:local_government_missing:010006`], "舊：都道府県先，近的一宮市被擠掉");
  await db4.close();
});

// =============================================================================================
// e. 不動的：手動任務、驗證列、規則
// =============================================================================================
Deno.test("手動任務（無 auto: 前綴）步驟順位 0，排在同層鏈上任務前面；層間仍是 6:3:1；原有的 manual_visitor 規則與前段規則都在", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  await onlyTerm(db, ICHI, null);
  await insertElection(db, KOMORO, addDays(TODAY, 100)); // 中段的統計缺口
  await seed(db);
  // 一個維護者建的手動任務（預設層＝中段），queue_at 在 2000 年之後（參與重排）
  await db.query(`INSERT INTO policy_jp.contribution_tasks (title, task_type, description, source, status) VALUES ('手動任務', 'task_suggestion', '手動任務', 'manual', 'open')`);
  await seed(db);
  const all = await rows<{ task_id: string; task_type: string; priority: number | null; queue_at: string }>(db,
    `SELECT task_id, task_type, priority, queue_at FROM policy_jp.task_dispatches WHERE task_id NOT LIKE 'verify:%' ORDER BY queue_at, task_id`);
  const manual = all.find((d) => !d.task_id.startsWith("auto:"));
  const chain = all.find((d) => d.task_type === "regional_stats_missing");
  assert(manual && chain, JSON.stringify(all));
  assertEquals(manual.priority, 2);
  assertEquals(chain.priority, 2);
  assert(manual.queue_at < chain.queue_at, "手動任務排在同層鏈上任務前面（插隊段在 2000 年前不參與重排，也在前；2000 年後的步驟順位 0 在前）");
  const rules = await rows<{ activity: string; priority: number }>(db, `SELECT activity, priority FROM policy_jp.activity_rules WHERE priority IS NOT NULL ORDER BY activity, priority`);
  // 第 2 步以降の migration が鏈上の臂ごとに priority: 規則を足す（policy-jp-chain-*.test.ts が守る）：ここは最初の 3 本の臂の分だけ見る
  const FIRST = ["priority:local_government_missing", "priority:manual_visitor", "priority:regional_stats_missing"];
  assertEquals(rules.filter((r) => FIRST.includes(r.activity)).map((r) => `${r.activity}:${r.priority}`), [
    "priority:local_government_missing:1", "priority:local_government_missing:3",
    "priority:manual_visitor:1",
    "priority:regional_stats_missing:1", "priority:regional_stats_missing:3",
  ]);
  const w = await rows<{ id: number; weight: number }>(db, `SELECT id, weight FROM policy_jp.task_priority_tiers ORDER BY id`);
  assertEquals(w.map((x) => x.weight), [6, 3, 1], "層權重不變");
  await db.close();
});

Deno.test("層間 6:3:1 交錯不變：前段三件、中段三件、後段一件，第 k 筆的虛擬完成時間 k／權重（驗證列 2:1 由 policy-jp-dispatch.test.ts 守）", async () => {
  const db = await freshDb();
  await clock(db, TODAY);
  await onlyTerm(db, ICHI, null);
  const lgs = [KOMORO, HAKODATE, SAPPORO, "202037", ICHI, "202011", "202029"]; // 7 個市
  const days = [10, 20, 30, 90, 100, 110, 250];
  for (let i = 0; i < lgs.length; i++) await insertElection(db, lgs[i], addDays(TODAY, days[i]));
  await seed(db);
  const q = await queueOrder(db);
  assertEquals(q.map((d) => d.priority).sort(), [1, 1, 1, 2, 2, 2, 3]);
  // 加權交錯：第 k 筆的虛擬完成時間 k／權重 → 前段 1/6、2/6、3/6；中段 1/3、2/3、1；後段 1
  // 排序：前1(.167) 前2(.333) 中1(.333，同時間層號小的先) 前3(.5) 中2(.667) 中3(1) 後1(1)
  assertEquals(q.map((d) => d.priority), [1, 1, 2, 1, 2, 2, 3]);
  // 層內由近到遠
  assertEquals(ids(q.filter((d) => d.priority === 1)).map((t) => t.split(":").pop()), [KOMORO, HAKODATE, SAPPORO]);
  await db.close();
});

// =============================================================================================
// f. 小函式
// =============================================================================================
Deno.test("步驟順位可擴充：手動 0 < 選舉發現 1 < 團體 2 < 統計 3 < 沒登記的 auto 型別 9；排序日期取 election_date → vote_window_from → term_end，非 auto: 為 NULL", async () => {
  const db = await freshDb();
  const rank = async (id: string, type: string) => (await one<{ r: number }>(db, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, type])).r;
  assertEquals(await rank("uuid-1", "task_suggestion"), 0);
  assertEquals(await rank("verify:abc", "x"), 0);
  assertEquals(await rank("auto:election_discovery:x", "election_discovery"), 1);
  assertEquals(await rank("auto:local_government_missing:1", "local_government_missing"), 2);
  assertEquals(await rank("auto:regional_stats_missing:1", "regional_stats_missing"), 3);
  assertEquals(await rank("auto:future_step:1", "future_step"), 9);
  const date = async (id: string, target: unknown) => (await one<{ d: string | null }>(db, `SELECT policy_jp.chain_sort_date($1, $2::JSONB)::TEXT AS d`, [id, JSON.stringify(target)])).d;
  assertEquals(await date("auto:a", { election_date: "2027-04-25", vote_window_from: "2027-01-01" }), "2027-04-25");
  assertEquals(await date("auto:a", { vote_window_from: "2027-01-01", term_end: "2027-02-01" }), "2027-01-01");
  assertEquals(await date("auto:a", { term_end: "2027-02-01" }), "2027-02-01");
  assertEquals(await date("auto:a", { election_date: "壞資料" }), null);
  assertEquals(await date("uuid-1", { election_date: "2027-04-25" }), null);
  assertNotEquals(await rank("auto:future_step:1", "future_step"), await rank("auto:regional_stats_missing:1", "regional_stats_missing"));
  await db.close();
});
