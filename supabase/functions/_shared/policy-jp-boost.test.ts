/**
 * 日本站插隊 jp-boost 的測試（migration 20261010030000_policy_jp_boost.sql、_shared/jp/boost-filter.ts、jp-boost/index.ts）。
 *
 *   1. SQL（PGlite，套「全部」policy_jp migration，檔名帶 _policy_jp_、照檔名順序；資料庫裡沒有任何正見 public 物件）：
 *      a. 篩選：task_types／election_before（嚴格早於）／pref_codes／lg_codes／kinds 各自只命中該命中的列（自動缺口、手動任務、待驗證貢獻）
 *      b. 排序：命中的列 queue_at＝1980-01-01 減 n 分鐘，排在所有一般列前面（訪客優先 1970 照舊更前）；第 n 次比第 n-1 次更前面；LEAST 不把更前面的往後推
 *      c. 一次性：task_dispatched 把領走的列蓋回隊尾，task_boost_remaining 跟著減少
 *      d. 與日本版 rebalance_queue 共存：seed／rebalance 重排後插隊的列仍在最前面、沒被拉進層的交錯；領走後回到重排的對象
 *      e. task_boosts 記 label／filter／命中數、anon 讀得到、anon 寫不進去也不能呼叫 task_boost
 *      f. 還原驗證：拿掉 task_boost 的 `SET queue_at = LEAST(...)` → a／b 的斷言紅；把 rebalance_queue 的「只處理 >= 2000 年」放寬 → d 的斷言紅
 *      g. 骨架對照：policy_jp.task_boost／task_boost_remaining 去掉 policy_jp. 前綴與 search_path 後，等於正見現行定義（去註解），正見改了這裡紅
 *   2. 白名單驗證（TS）：未知的鍵、自由文字、檢查碼錯的團體碼、非都道府県碼進 pref_codes、不存在的日期、空 filter 都擋
 *   3. 走樣守門：jp-boost/index.ts 去掉 jp-only 區段後逐行等於 boost/index.ts（方法同 jp-history.test.ts）
 *   4. 入口：真的載入入口、底下是假的 PostgREST：每個請求都帶 policy_jp 標頭、壞條件 400、超過每小時上限 429 且不呼叫 task_boost
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, migrationNames } from "./arms-pglite.ts";
import { loadEntry, type RestCall } from "./jp/entry-harness.ts";
import { BOOST_FILTER_KEYS, BOOST_PER_IP_PER_HOUR, validateBoostFilter, validateBoostLabel } from "./jp/boost-filter.ts";
import { lgPrefCode } from "./jp/lg-code.ts";
import { cutJpBlocks, cutTwSpans } from "./jp-contributions-feed.test.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const MIG_FILE = "20261010030000_policy_jp_boost.sql";
const PRIO_FILE = "20261009300000_policy_jp_chain_priority.sql";
// 全部 policy_jp migration（不寫死短清單：之後新增的日本站 migration 也會被套進來，插隊要跟它們共存）
const JP_FILES = (await migrationNames()).filter((n) => n.includes("_policy_jp_"));
const JP_SQL = Object.fromEntries(await Promise.all(JP_FILES.map(async (n) => [n, await read(n)] as const)));
assert(JP_FILES.includes(MIG_FILE) && JP_FILES.includes(PRIO_FILE), "掃得到插隊與選舉鏈排序的 migration");
assert(JP_FILES.indexOf(MIG_FILE) > JP_FILES.indexOf(PRIO_FILE), "插隊在選舉鏈排序之後");

const ROLES = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;
/** 全部 policy_jp migration 套一遍；patch：換掉指定檔案的內容（還原驗證用） */
async function freshDb(patch?: Record<string, (sql: string) => string>): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  for (const n of JP_FILES) await db.exec(patch?.[n] ? patch[n](JP_SQL[n]) : JP_SQL[n]);
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
const boost = (db: PGlite, label: string, filter: Record<string, unknown>) =>
  one<{ r: { id: number; matched_tasks: number; matched_verifies: number; queue_at: string } }>(db, `SELECT policy_jp.task_boost($1, $2::JSONB, 'tester', 'iphash') AS r`, [label, JSON.stringify(filter)]).then((x) => x.r);
const matches = async (db: PGlite, filter: Record<string, unknown>) =>
  (await rows<{ task_id: string }>(db, `SELECT task_id FROM policy_jp.task_boost_matches($1::JSONB) ORDER BY 1`, [JSON.stringify(filter)])).map((r) => r.task_id).sort();
/** 插隊段（queue_at 早於 1990 年）的列，照 queue_at */
const front = (db: PGlite) => rows<{ task_id: string; queue_at: string }>(db, `SELECT task_id, queue_at FROM policy_jp.task_dispatches WHERE queue_at < TIMESTAMPTZ '1990-01-01' ORDER BY queue_at, task_id`);
const frontIds = async (db: PGlite) => (await front(db)).map((r) => r.task_id);
const at = async (db: PGlite, id: string) => (await one<{ q: string }>(db, `SELECT queue_at::TEXT AS q FROM policy_jp.task_dispatches WHERE task_id = $1`, [id])).q;
const atMs = async (db: PGlite, id: string) => (await one<{ ms: number }>(db, `SELECT (EXTRACT(EPOCH FROM queue_at) * 1000)::BIGINT AS ms FROM policy_jp.task_dispatches WHERE task_id = $1`, [id])).ms;
const sorted = <T>(a: T[]) => [...a].sort();

// ---------------------------------------------------------------------------------------------
// 固定的團體（總務省團體碼表裡真的有的）與情境
// ---------------------------------------------------------------------------------------------
const AICHI = "230006", ICHI = "232033", NAGANO = "200000", KOMORO = "202088", HAKODATE = "012025";
const HOKKAIDO = lgPrefCode(HAKODATE)!;
const TODAY = "2027-03-01";
type Reg = { lg_code: string; pref_code: string; name: string; kana: string; kind: string };
async function insertLg(db: PGlite, code: string): Promise<void> {
  const r = await one<Reg>(db, `SELECT lg_code, pref_code, name, kana, kind FROM policy_jp.lg_code_registry WHERE lg_code = $1`, [code]);
  if (r.pref_code !== code) await insertLg(db, r.pref_code);
  await db.query(`INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ($1, $2, $3, $4, $5, $1) ON CONFLICT DO NOTHING`,
    [r.lg_code, r.kind, r.pref_code, r.name, r.kana]);
}
async function insertElection(db: PGlite, lg: string, date: string, type = "mayor"): Promise<string> {
  const id = `${date}_${type}_${lg}`;
  await insertLg(db, lg);
  await db.query(
    `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code, review_status)
     VALUES ($1, $2, $3, $4, 'regular', policy_jp.election_level($4), $5, 'published')`,
    [id, `${id}選挙`, date, type, lg]);
  return id;
}
async function onlyTerm(db: PGlite, lg: string, termEnd: string): Promise<void> {
  await db.query(`DELETE FROM policy_jp.term_expirations WHERE NOT (lg_code = $1 AND office_kind = 'head')`, [lg]);
  await db.query(`UPDATE policy_jp.term_expirations SET term_end = $2 WHERE lg_code = $1`, [lg, termEnd]);
}

interface Scene {
  db: PGlite;
  DISC: string; ST_CHI: string; ST_KOMORO: string; ST_HAK: string; VERIFY: string; MANUAL: string; MANUAL_FRONT: string; VISITOR: string;
  normalTasks: string[];
}
/**
 * 情境（今天 2027-03-01）：
 *   選舉發現：愛知県一宮市長（満了日 +140 → 投票窗口起日 +110）；統計缺口：千種区（愛知，+50）、小諸市（長野，+100）、函館市（北海道，+300）；
 *   待驗證貢獻：愛知県一宮市的 election（payload.election_date +100）；
 *   手動任務：小諸市（source=suggested，排隊尾）、維護者建的（source=manual，queue_at 1980-01-01）、網站請求（訪客優先，1970）
 */
async function scene(patch?: Record<string, (sql: string) => string>): Promise<Scene> {
  const db = await freshDb(patch);
  await clock(db, TODAY);
  await onlyTerm(db, ICHI, addDays(TODAY, 140));
  await insertElection(db, KOMORO, addDays(TODAY, 100));
  await insertElection(db, HAKODATE, addDays(TODAY, 300));
  // 愛知県のもう一つの市（一宮市以外、団体コード表の先頭）
  const CHIKUSA = (await one<{ lg_code: string }>(db, `SELECT lg_code FROM policy_jp.lg_code_registry WHERE pref_code = $1 AND kind = 'city' AND lg_code <> $2 ORDER BY lg_code LIMIT 1`, [AICHI, ICHI])).lg_code;
  await insertElection(db, CHIKUSA, addDays(TODAY, 50));
  await db.query(
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash, status)
     VALUES ('election', $1::JSONB, ARRAY['https://www.city.example.jp/senkyo/'], 'author-1', 'ip-1', 'h-1', 'pending')`,
    [JSON.stringify({ lg_code: ICHI, election_type: "mayor", election_reason: "regular", election_date: addDays(TODAY, 100) })]);
  const mk = async (source: string, taskType: string, target: Record<string, unknown>) =>
    (await one<{ id: string }>(db, `INSERT INTO policy_jp.contribution_tasks (title, task_type, target, source) VALUES ($1, $2, $3::JSONB, $4) RETURNING id::TEXT AS id`,
      [`手動 ${source}`, taskType, JSON.stringify(target), source])).id;
  const MANUAL = await mk("suggested", "profile_note", { lg_code: KOMORO, election_date: addDays(TODAY, 100) });
  const MANUAL_FRONT = await mk("manual", "profile_note", { lg_code: CHIKUSA });
  const VISITOR = await mk("web_request", "profile_note", { lg_code: ICHI });
  await seed(db);
  const verify = (await one<{ task_id: string }>(db, `SELECT task_id FROM policy_jp.task_dispatches WHERE task_id LIKE 'verify:%'`)).task_id;
  const s: Scene = {
    db, DISC: `auto:election_discovery:${addDays(TODAY, 140)}:${ICHI}:head`,
    ST_CHI: `auto:regional_stats_missing:${CHIKUSA}`, ST_KOMORO: `auto:regional_stats_missing:${KOMORO}`, ST_HAK: `auto:regional_stats_missing:${HAKODATE}`,
    VERIFY: verify, MANUAL, MANUAL_FRONT, VISITOR, normalTasks: [],
  };
  s.normalTasks = [s.DISC, s.ST_CHI, s.ST_KOMORO, s.ST_HAK, s.MANUAL];
  return s;
}

// =============================================================================================
// a. 篩選：各詞彙只命中該命中的列
// =============================================================================================
Deno.test("情境本身：自動缺口、手動任務、待驗證貢獻都在佇列裡；沒人插隊前插隊段只有維護者建的與訪客優先", async () => {
  const s = await scene();
  const all = (await rows<{ task_id: string }>(s.db, `SELECT task_id FROM policy_jp.task_dispatches`)).map((r) => r.task_id);
  for (const id of [...s.normalTasks, s.VERIFY, s.MANUAL_FRONT, s.VISITOR]) assert(all.includes(id), `佇列裡要有 ${id}`);
  assertEquals(sorted(await frontIds(s.db)), sorted([s.MANUAL_FRONT, s.VISITOR]), "插隊前，早於 1990 的只有維護者建的（1980）與訪客優先（1970）");
  await s.db.close();
});

Deno.test("篩選 task_types／kinds：選舉發現只命中選舉發現；kinds=verify 只命中驗證；kinds=task 不含驗證", async () => {
  const s = await scene();
  assertEquals(await matches(s.db, { task_types: ["election_discovery"] }), [s.DISC]);
  assertEquals(await matches(s.db, { kinds: ["verify"] }), [s.VERIFY]);
  assertEquals(await matches(s.db, { task_types: ["election"] }), [s.VERIFY], "驗證項目用 contribution_type 比");
  const tasksOnly = await matches(s.db, { kinds: ["task"] });
  assert(!tasksOnly.includes(s.VERIFY) && tasksOnly.includes(s.DISC) && tasksOnly.includes(s.MANUAL) && tasksOnly.includes(s.ST_HAK));
  assertEquals(await matches(s.db, { task_types: ["no_such_type"] }), []);
  await s.db.close();
});

Deno.test("篩選 election_before：選舉日（target.election_date，沒有就 vote_window_from；驗證讀 payload.election_date）嚴格早於；沒有日期的不命中", async () => {
  const s = await scene();
  // +101：愛知県の市(+50)、小諸(+100)、驗證(+100)、小諸的手動任務(+100) 命中；選舉發現的窗口起日 +110、函館 +300 不命中；沒有日期的手動任務不命中
  assertEquals(await matches(s.db, { election_before: addDays(TODAY, 101) }), sorted([s.ST_CHI, s.ST_KOMORO, s.VERIFY, s.MANUAL]));
  // 嚴格小於：剛好 +100 的不算
  assertEquals(await matches(s.db, { election_before: addDays(TODAY, 100) }), [s.ST_CHI]);
  // vote_window_from（選舉發現）：+110 → +111 才命中
  assertEquals((await matches(s.db, { election_before: addDays(TODAY, 110) })).includes(s.DISC), false);
  assertEquals((await matches(s.db, { election_before: addDays(TODAY, 111) })).includes(s.DISC), true);
  // 壞日期不命中任何東西，也不會讓整個查詢炸掉
  assertEquals(await matches(s.db, { election_before: "2027-02-30" }), []);
  assertEquals(await matches(s.db, { election_before: "not-a-date" }), []);
  await s.db.close();
});

Deno.test("篩選 pref_codes／lg_codes：愛知県＝選舉發現、第二個愛知県の市、一宮市的驗證；長野県＝小諸市；北海道＝函館市；lg_codes 看團體本身", async () => {
  const s = await scene();
  assertEquals(await matches(s.db, { pref_codes: [AICHI] }), sorted([s.DISC, s.ST_CHI, s.VERIFY, s.MANUAL_FRONT, s.VISITOR]));
  assertEquals(await matches(s.db, { pref_codes: [NAGANO] }), sorted([s.ST_KOMORO, s.MANUAL]));
  assertEquals(await matches(s.db, { pref_codes: [HOKKAIDO] }), [s.ST_HAK]);
  assertEquals(await matches(s.db, { pref_codes: [NAGANO, HOKKAIDO] }), sorted([s.ST_KOMORO, s.MANUAL, s.ST_HAK]));
  assertEquals(await matches(s.db, { lg_codes: [KOMORO] }), sorted([s.ST_KOMORO, s.MANUAL]));
  assertEquals(await matches(s.db, { lg_codes: [ICHI] }), sorted([s.DISC, s.VERIFY, s.VISITOR]));
  assertEquals(await matches(s.db, { lg_codes: ["999999"] }), []);
  // 條件之間是 AND
  assertEquals(await matches(s.db, { pref_codes: [AICHI], kinds: ["task"], task_types: ["regional_stats_missing"] }), [s.ST_CHI]);
  assertEquals(await matches(s.db, { pref_codes: [AICHI], election_before: addDays(TODAY, 60) }), [s.ST_CHI]);
  await s.db.close();
});

// =============================================================================================
// b. 排序：1980 減 n 分鐘，命中的在最前面；第 n 次比第 n-1 次更前面
// =============================================================================================
Deno.test("插隊：只有命中的列移到 1980 年段（第 1 次＝1979-12-31 23:59），排在所有一般列前面；一般列不動", async () => {
  const s = await scene();
  const before = Object.fromEntries(await Promise.all(s.normalTasks.map(async (id) => [id, await at(s.db, id)] as const)));
  const r = await boost(s.db, "愛知県 選挙発見", { pref_codes: [AICHI], task_types: ["election_discovery"] });
  assertEquals(r.id, 1);
  assertEquals([r.matched_tasks, r.matched_verifies], [1, 0]);
  assertEquals(new Date(r.queue_at).toISOString(), "1979-12-31T23:59:00.000Z");
  assertEquals(await frontIds(s.db), [s.VISITOR, s.DISC, s.MANUAL_FRONT], "訪客優先（1970）照舊最前；命中的在維護者建的（1980-01-01）前面");
  assertEquals((await at(s.db, s.DISC)).startsWith("1979-12-31 23:59"), true);
  for (const id of s.normalTasks.filter((x) => x !== s.DISC)) assertEquals(await at(s.db, id), before[id], `${id} 沒命中，不能動`);
  // 派工函式真的先給它：contribution_queue_tasks 的第一筆（訪客優先之後）
  const q = await rows<{ task_id: string }>(s.db, `SELECT task_id FROM policy_jp.contribution_queue_tasks(NULL, NULL, 5, '', NULL, NULL)`);
  assertEquals(q.slice(0, 3).map((x) => x.task_id), [s.VISITOR, s.DISC, s.MANUAL_FRONT]);
  await s.db.close();
});

Deno.test("驗證項目被插隊：verify: 列也進 1980 年段，在其他驗證列前面", async () => {
  const s = await scene();
  const r = await boost(s.db, "只推驗證", { kinds: ["verify"] });
  assertEquals([r.matched_tasks, r.matched_verifies], [0, 1]);
  assertEquals((await frontIds(s.db)).includes(s.VERIFY), true);
  assertEquals(await atMs(s.db, s.VERIFY) < Date.parse("1980-01-01T00:00:00Z"), true);
  await s.db.close();
});

Deno.test("第 n 次插隊：1980 減 n 分鐘，新的排最前；兩次都命中的列取比較前面的（LEAST，不被舊的往後推）；手動任務的 last_dispatched_at 清成 NULL", async () => {
  const s = await scene();
  await s.db.query(`UPDATE policy_jp.contribution_tasks SET last_dispatched_at = now() WHERE id = $1::UUID`, [s.MANUAL]);
  const a = await boost(s.db, "全部有日期的", { election_before: addDays(TODAY, 400) }); // 第 1 次：命中千種、小諸、函館、驗證、小諸的手動任務
  const b = await boost(s.db, "小諸市", { lg_codes: [KOMORO] }); //                         第 2 次：小諸的統計與手動任務，被第 1 次也命中過
  assertEquals([a.id, b.id], [1, 2]);
  assertEquals(sorted(await matches(s.db, { election_before: addDays(TODAY, 400) })), sorted([s.DISC, s.ST_CHI, s.ST_KOMORO, s.ST_HAK, s.VERIFY, s.MANUAL]));
  const t1 = Date.parse("1980-01-01T00:00:00Z") - 60_000, t2 = Date.parse("1980-01-01T00:00:00Z") - 120_000;
  assertEquals(await atMs(s.db, s.ST_CHI), t1);
  assertEquals(await atMs(s.db, s.ST_HAK), t1);
  assertEquals(await atMs(s.db, s.VERIFY), t1);
  assertEquals(await atMs(s.db, s.ST_KOMORO), t2, "第 2 次也命中的，取比較前面的（新的在前）");
  assertEquals(await atMs(s.db, s.MANUAL), t2);
  const order = await frontIds(s.db);
  assertEquals(order.indexOf(s.ST_KOMORO) < order.indexOf(s.ST_CHI), true, "新的插隊排在舊的前面");
  assertEquals(order.indexOf(s.ST_CHI) < order.indexOf(s.MANUAL_FRONT), true, "兩次插隊都在維護者建的（1980-01-01）前面");
  assertEquals((await one<{ n: string | null }>(s.db, `SELECT last_dispatched_at::TEXT AS n FROM policy_jp.contribution_tasks WHERE id = $1::UUID`, [s.MANUAL])).n, null);
  // 已經更前面的不被往後推：先插第 2 次寬的、再插第 3 次只命中同一批，不會比原本更後
  const c = await boost(s.db, "再來一次", { lg_codes: [KOMORO] });
  assertEquals(c.id, 3);
  assertEquals(await atMs(s.db, s.ST_KOMORO), Date.parse("1980-01-01T00:00:00Z") - 180_000);
  await s.db.close();
});

// =============================================================================================
// c. 一次性：領走後回到隊尾
// =============================================================================================
Deno.test("一次性：task_dispatched 把領走的列蓋回隊尾（>= 2000 年、排在其他任務列之後），沒領走的還在前面；task_boost_remaining 跟著減少", async () => {
  const s = await scene();
  const r = await boost(s.db, "愛知県", { pref_codes: [AICHI] });
  assertEquals([r.matched_tasks, r.matched_verifies], [4, 1], "選舉發現、第二個愛知県の市、維護者建的與訪客任務（這兩件本來就在前面）＋一宮市的驗證");
  const rem0 = (await one<{ r: { tasks: number; verifies: number } }>(s.db, `SELECT policy_jp.task_boost_remaining($1) AS r`, [r.id])).r;
  assertEquals(rem0, { tasks: 4, verifies: 1 });
  await s.db.query(`SELECT policy_jp.task_dispatched($1)`, [s.DISC]);
  await s.db.query(`SELECT policy_jp.task_dispatched($1)`, [s.VERIFY]);
  const rem1 = (await one<{ r: { tasks: number; verifies: number } }>(s.db, `SELECT policy_jp.task_boost_remaining($1) AS r`, [r.id])).r;
  assertEquals(rem1, { tasks: 3, verifies: 0 });
  assertEquals((await frontIds(s.db)).includes(s.DISC), false);
  assertEquals(await atMs(s.db, s.DISC) >= Date.parse("2000-01-01T00:00:00Z"), true);
  const maxOther = (await one<{ ms: number }>(s.db,
    `SELECT (EXTRACT(EPOCH FROM max(queue_at)) * 1000)::BIGINT AS ms FROM policy_jp.task_dispatches WHERE task_id NOT LIKE 'verify:%' AND task_id <> $1`, [s.DISC])).ms;
  assertEquals(await atMs(s.db, s.DISC) > maxOther, true, "回到任務行列的隊尾");
  assertEquals((await frontIds(s.db)).includes(s.ST_CHI), true, "沒領走的還在插隊段");
  await s.db.close();
});

// =============================================================================================
// d. 與日本版 rebalance_queue／seed 共存
// =============================================================================================
/** 插隊 → 多輪 seed＋rebalance → 插隊段不變；領走一筆 → 再重排 → 領走的回到重排的對象（>= 2000）、其他仍在最前 */
async function surviveCheck(patch?: Record<string, (sql: string) => string>): Promise<{ stable: boolean; frontBefore: string[]; frontAfter: string[]; restored: boolean }> {
  const s = await scene(patch);
  await boost(s.db, "愛知県", { pref_codes: [AICHI], kinds: ["task"] });
  await boost(s.db, "長野県", { pref_codes: [NAGANO], kinds: ["task"] });
  const frontBefore = await frontIds(s.db);
  const snapshot = Object.fromEntries(await Promise.all(frontBefore.map(async (id) => [id, await at(s.db, id)] as const)));
  await seed(s.db);
  await s.db.query(`SELECT policy_jp.rebalance_queue()`);
  await seed(s.db);
  const frontAfter = await frontIds(s.db);
  let stable = frontAfter.join() === frontBefore.join();
  for (const id of frontBefore) if ((await at(s.db, id)) !== snapshot[id]) stable = false;
  // 領走一筆 → 重排 → 回到重排的對象
  await s.db.query(`SELECT policy_jp.task_dispatched($1)`, [s.ST_KOMORO]);
  await s.db.query(`SELECT policy_jp.rebalance_queue()`);
  const restored = (await atMs(s.db, s.ST_KOMORO)) >= Date.parse("2000-01-01T00:00:00Z") && !(await frontIds(s.db)).includes(s.ST_KOMORO)
    && (await frontIds(s.db)).includes(s.ST_CHI);
  await s.db.close();
  return { stable, frontBefore, frontAfter, restored };
}

Deno.test("與 rebalance_queue／seed 共存：重排後插隊的列位置不變、仍在最前面，沒被拉進層的交錯；領走後才回到重排的對象", async () => {
  const r = await surviveCheck();
  assert(r.frontBefore.length >= 4, `插隊段至少有 4 列：${r.frontBefore.join(",")}`);
  assertEquals(r.frontAfter, r.frontBefore);
  assert(r.stable, "插隊的列 queue_at 一個字都沒變");
  assert(r.restored, "領走後回到重排的對象，沒領走的仍在最前面");
});

Deno.test("還原驗證（重排）：把 rebalance_queue 的「只處理 >= 2000 年」放寬，插隊的列被拉進層的交錯，斷言就紅", async () => {
  const bad = await surviveCheck({
    [PRIO_FILE]: (sql) => mutate(sql, "WHERE g.queue_at >= TIMESTAMPTZ '2000-01-01';", "WHERE true;"),
  });
  assert(!bad.stable || bad.frontAfter.join() !== bad.frontBefore.join(), "放寬後插隊的列應該被重排動到（測試咬得到）");
});

// =============================================================================================
// e. task_boosts：記錄、anon 可讀、anon 不能寫也不能插隊
// =============================================================================================
Deno.test("task_boosts 記 label／filter／命中數／agent／ip_hash；anon 讀得到、寫不進去、不能呼叫 task_boost；RLS 開著", async () => {
  const s = await scene();
  const r = await boost(s.db, "愛知県 選挙発見", { pref_codes: [AICHI], task_types: ["election_discovery"] });
  const rec = await one<{ label: string; filter: Record<string, unknown>; agent_name: string; ip_hash: string; matched_tasks: number; matched_verifies: number }>(s.db,
    `SELECT label, filter, agent_name, ip_hash, matched_tasks, matched_verifies FROM policy_jp.task_boosts WHERE id = $1`, [r.id]);
  assertEquals(rec, { label: "愛知県 選挙発見", filter: { pref_codes: [AICHI], task_types: ["election_discovery"] }, agent_name: "tester", ip_hash: "iphash", matched_tasks: 1, matched_verifies: 0 });
  assertEquals((await one<{ rls: boolean }>(s.db, `SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'policy_jp.task_boosts'::regclass`)).rls, true);
  await s.db.exec(`SET ROLE anon`);
  try {
    assertEquals((await rows<{ id: number }>(s.db, `SELECT id FROM policy_jp.task_boosts`)).length, 1, "anon 讀得到插隊紀錄");
    let denied = 0;
    for (const sql of [
      `INSERT INTO policy_jp.task_boosts (label, filter) VALUES ('x', '{}'::JSONB)`,
      `UPDATE policy_jp.task_boosts SET label = 'x'`,
      `DELETE FROM policy_jp.task_boosts`,
      `SELECT policy_jp.task_boost('x', '{"kinds":["task"]}'::JSONB)`,
      `SELECT policy_jp.task_boost_matches('{"kinds":["task"]}'::JSONB)`,
      `SELECT policy_jp.task_boost_remaining(1)`,
    ]) {
      try { await s.db.query(sql); } catch (e) { if (/permission denied/i.test(String(e))) denied++; else throw e; }
    }
    assertEquals(denied, 6, "anon 的寫入與三支函式都是 permission denied");
  } finally { await s.db.exec(`RESET ROLE`); }
  // 權限本身：service_role 能執行三支函式、anon／authenticated 不能（不真的以 service_role 跑：PGlite 的暫存表是超級使用者的，換角色會撞 pg_temp 權限，與插隊無關）
  for (const fn of ["task_boost(TEXT, JSONB, TEXT, TEXT)", "task_boost_matches(JSONB)", "task_boost_remaining(BIGINT)"]) {
    const p = await one<{ sr: boolean; anon: boolean; auth: boolean }>(s.db,
      `SELECT has_function_privilege('service_role', 'policy_jp.${fn}', 'EXECUTE') AS sr, has_function_privilege('anon', 'policy_jp.${fn}', 'EXECUTE') AS anon, has_function_privilege('authenticated', 'policy_jp.${fn}', 'EXECUTE') AS auth`);
    assertEquals(p, { sr: true, anon: false, auth: false }, fn);
  }
  await s.db.close();
});

// =============================================================================================
// f. 還原驗證：拿掉真正把 queue_at 往前搬的那一行
// =============================================================================================
Deno.test("還原驗證（插隊）：拿掉 task_boost 的 `SET queue_at = LEAST(d.queue_at, v_at)`，命中的列不會動、前面幾個測試的斷言就紅", async () => {
  const key = "UPDATE policy_jp.task_dispatches d SET queue_at = LEAST(d.queue_at, v_at)";
  const bad = await scene({ [MIG_FILE]: (sql) => mutate(sql, key, "UPDATE policy_jp.task_dispatches d SET queue_at = d.queue_at") });
  const r = await boost(bad.db, "愛知県 選挙発見", { pref_codes: [AICHI], task_types: ["election_discovery"] });
  assertEquals(r.matched_tasks, 1, "命中數照舊（篩選沒壞）");
  assertNotEquals(await frontIds(bad.db), [bad.VISITOR, bad.DISC, bad.MANUAL_FRONT], "命中的列沒有進插隊段 → 「排在最前面」的斷言會紅");
  assertEquals((await frontIds(bad.db)).includes(bad.DISC), false);
  await bad.db.close();
  // 標記字串在原檔剛好出現一次（mutate 已檢查）；正常版本則進得去
  const good = await scene();
  await boost(good.db, "愛知県 選挙発見", { pref_codes: [AICHI], task_types: ["election_discovery"] });
  assertEquals((await frontIds(good.db)).includes(good.DISC), true);
  await good.db.close();
});

// =============================================================================================
// g. 骨架對照：task_boost／task_boost_remaining 是正見現行定義的機械式替換
// =============================================================================================
/** 去註解與空行、去 policy_jp. 前綴與 search_path 子句、壓縮空白 */
function skeleton(def: string): string[] {
  return def.replace(/ SET search_path = policy_jp, pg_temp/g, "").replaceAll("policy_jp.", "")
    .split("\n").map((l) => l.replace(/--.*$/, "").trim().replace(/\s+/g, " ")).filter((l) => l !== "");
}
async function twVsJp(name: string): Promise<{ tw: string[]; jp: string[] }> {
  return { tw: skeleton(await latestFn(name)), jp: skeleton(fnText(JP_SQL[MIG_FILE], `policy_jp.${name}`)) };
}

Deno.test("骨架對照：policy_jp.task_boost／task_boost_remaining ＝ 正見現行定義（去註解、去 policy_jp. 前綴與 search_path）；正見改了這裡紅", async () => {
  for (const name of ["task_boost", "task_boost_remaining"]) {
    const { tw, jp } = await twVsJp(name);
    assert(tw.length > 5);
    assertEquals(jp, tw, `${name}：日本站跟正見的現行定義不一致，要決定日本版跟不跟`);
  }
  // 偵測器咬得到：正見改一個字就不等
  const { tw, jp } = await twVsJp("task_boost");
  assertNotEquals(jp, tw.map((l) => l.replace("INTERVAL '1 minute'", "INTERVAL '2 minute'")));
});

// =============================================================================================
// 2. 白名單驗證（TS）
// =============================================================================================
Deno.test("白名單：日本站詞彙過；台灣的詞彙（regions／election_id／missing_avatar／politician_ids）、自由文字、空物件都擋", () => {
  const ok = validateBoostFilter({ pref_codes: [AICHI, NAGANO], lg_codes: [ICHI], task_types: ["election_discovery"], kinds: ["task"], election_before: "2027-07-01" });
  assertEquals(ok.ok, true);
  if (ok.ok) assertEquals(ok.filter, { pref_codes: [AICHI, NAGANO], lg_codes: [ICHI], task_types: ["election_discovery"], kinds: ["task"], election_before: "2027-07-01" });
  assertEquals([...BOOST_FILTER_KEYS], ["pref_codes", "lg_codes", "task_types", "kinds", "election_before"]);
  for (const bad of [{ regions: ["愛知県"] }, { election_id: 2026 }, { missing_avatar: true }, { politician_ids: [] }, { sql: "1=1" }, {}, "pref_codes", [], null]) {
    assertEquals(validateBoostFilter(bad).ok, false, JSON.stringify(bad));
  }
  assertEquals(validateBoostFilter({ election_before: "2027-02-30" }).ok, false, "不存在的日期");
  assertEquals(validateBoostFilter({ election_before: "2027/03/01" }).ok, false);
  assertEquals(validateBoostFilter({ election_before: "1900-01-01" }).ok, false, "年份範圍");
  assertEquals(validateBoostFilter({ election_before: 20270301 }).ok, false);
  assertEquals(validateBoostFilter({ pref_codes: [ICHI] }).ok, false, "市區町村碼不是都道府県碼");
  assertEquals(validateBoostFilter({ pref_codes: ["230007"] }).ok, false, "檢查碼錯");
  assertEquals(validateBoostFilter({ lg_codes: ["23203"] }).ok, false, "不是 6 碼");
  assertEquals(validateBoostFilter({ lg_codes: ["232033; DROP TABLE x"] }).ok, false);
  assertEquals(validateBoostFilter({ lg_codes: [] }).ok, false);
  assertEquals(validateBoostFilter({ pref_codes: Array(48).fill(AICHI) }).ok, false, "pref_codes 最多 47");
  assertEquals(validateBoostFilter({ task_types: ["Election Discovery"] }).ok, false, "型名只收小寫英數與底線");
  assertEquals(validateBoostFilter({ task_types: ["a'; --"] }).ok, false);
  assertEquals(validateBoostFilter({ task_types: [] }).ok, false);
  assertEquals(validateBoostFilter({ kinds: ["task", "everything"] }).ok, false);
  assertEquals(validateBoostFilter({ kinds: ["task", "verify", "task"] }).ok, false);
  assertEquals(validateBoostLabel("").ok, false);
  assertEquals(validateBoostLabel("x".repeat(61)).ok, false);
  const l = validateBoostLabel("  愛知県  ");
  assertEquals(l.ok && l.label, "愛知県");
});

Deno.test("白名單：同一批的重複碼會去重；SQL 端不認識的鍵不會讓 task_boost_matches 炸（驗證在 TS 端）", async () => {
  const r = validateBoostFilter({ lg_codes: [ICHI, ICHI], task_types: ["election_discovery", "election_discovery"] });
  assert(r.ok);
  if (r.ok) assertEquals(r.filter, { lg_codes: [ICHI], task_types: ["election_discovery"] });
  const s = await scene();
  assertEquals((await matches(s.db, { regions: ["x"], kinds: ["verify"] })), [s.VERIFY], "SQL 對未知鍵視而不見（台灣的同款行為）；擋在 TS 的白名單");
  await s.db.close();
});

// =============================================================================================
// 3. 走樣守門：jp-boost/index.ts ＝ boost/index.ts（去掉 jp-only 區段）
// =============================================================================================
const readSrc = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const TW_SPANS = [
  { from: 'import "jsr:@supabase/functions-js/edge-runtime.d.ts";', to: "*/", why: "檔頭與 import" },
  { from: 'post: "POST /boost', to: 'post: "POST /boost', why: "說明" },
  { from: '{ label: "六都 2026 全部"', to: '{ label: "只推驗證"', why: "範例" },
  { from: "docs: `${PROTOCOL_URL}#8", to: "docs: `${PROTOCOL_URL}#8", why: "手引きの場所" },
  { from: "const supabase = createClient(", to: "const supabase = createClient(", why: "client 固定 schema policy_jp" },
  { from: '? "沒有任何項目符合條件', to: '? "沒有任何項目符合條件', why: "沒有命中時的提示" },
  { from: 'console.error("boost error:"', to: 'console.error("boost error:"', why: "日誌名稱" },
];
const norm = (lines: string[]) => lines.map((l) => l.trim()).filter((l) => l !== "");
export function boostDrift(tw: string, jp: string): string[] {
  const j = cutJpBlocks(jp);
  if (j.unbalanced) return ["jp-only:begin／end 沒有成對"];
  if (j.blocks !== TW_SPANS.length) return [`日本站有 ${j.blocks} 個 jp-only 區段，但守門登記了 ${TW_SPANS.length} 個正見區段：新增或減少區段要同步改 TW_SPANS`];
  const a = norm(cutTwSpans(tw, TW_SPANS));
  const b = norm(j.rest);
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { out.push(`第 ${i + 1} 行（去掉專屬區段後）不同\n  正見：${a[i] ?? "（沒有）"}\n  日本：${b[i] ?? "（沒有）"}`); if (out.length >= 3) break; }
  }
  return out;
}
const TW_FILE = "../boost/index.ts";
const JP_FILE = "../jp-boost/index.ts";

Deno.test("走樣守門：jp-boost 去掉日本專屬區段後，跟 boost 逐行相同", async () => {
  assertEquals(boostDrift(await readSrc(TW_FILE), await readSrc(JP_FILE)), [], "正見的 boost 改了，日本站的 jp-boost 要跟著改（或把差異標成 jp-only 並登記 TW_SPANS）");
});

Deno.test("走樣守門：偵測器本身——正見改一行、日本站私自改一行、區段不成對、區段數不符都抓得到；日本站走 jpClient 與日本站的白名單", async () => {
  const tw = await readSrc(TW_FILE);
  const jp = await readSrc(JP_FILE);
  assert(boostDrift(tw.replace("BOOST_PER_IP_PER_HOUR) {", "BOOST_PER_IP_PER_HOUR + 1) {"), jp).length > 0, "正見改限流");
  assert(boostDrift(tw, jp.replace("(count ?? 0) >= BOOST_PER_IP_PER_HOUR", "(count ?? 0) > BOOST_PER_IP_PER_HOUR")).length > 0, "日本站在區段外私自改限流");
  assert(boostDrift(tw, jp.replace("// jp-only:end", "")).length > 0, "區段不成對");
  assert(boostDrift(tw, jp.replace("const corsHeaders", "// jp-only:begin x\n// jp-only:end\nconst corsHeaders")).length > 0, "多一個區段");
  assertEquals(boostDrift(tw, jp), []);
  assert(jp.includes("jpClient(") && !jp.includes("createClient("), "client 要走 jpClient（schema policy_jp）");
  assert(jp.includes("../_shared/jp/boost-filter.ts") && !jp.includes('"../_shared/boost-filter.ts"'), "白名單用日本站的");
  assert(jp.includes("../_shared/jp/contribute-handler.ts"), "IP 雜湊用日本站的 ipHashOf");
  // 限流常數與正見一致
  assertEquals(BOOST_PER_IP_PER_HOUR, 6);
  const twFilter = await readSrc("./boost-filter.ts");
  assert(twFilter.includes(`export const BOOST_PER_IP_PER_HOUR = ${BOOST_PER_IP_PER_HOUR};`), "每小時上限跟正見一樣");
});

// =============================================================================================
// 4. 入口行為
// =============================================================================================
const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789", CONTRIBUTION_IP_SALT: "salt" } as Record<string, string>;
type Row = Record<string, unknown>;
const profileOf = (c: RestCall) => c.headers["accept-profile"] ?? c.headers["content-profile"];

function router(c: RestCall): unknown {
  if (c.target === "rpc/task_boost") return { id: 7, label: (c.body as Row).p_label, matched_tasks: 2, matched_verifies: 1, queue_at: "1979-12-31T23:53:00Z" };
  if (c.target === "rpc/task_boost_remaining") return { tasks: 1, verifies: 0 };
  if (c.target === "task_boosts" && c.method === "GET") {
    return Array.from({ length: 7 }, (_, i) => ({ id: 7 - i, label: `b${7 - i}`, filter: { kinds: ["task"] }, agent_name: null, matched_tasks: 1, matched_verifies: 0, created_at: "2027-03-01T00:00:00Z" }));
  }
  return undefined;
}
async function call(method: string, body?: unknown, opts: { count?: number } = {}): Promise<{ status: number; json: Row; calls: RestCall[] }> {
  const entry = await loadEntry("../../jp-boost/index.ts", env, router);
  try {
    if (opts.count !== undefined) {
      // 假 PostgREST 的 HEAD 一律回 content-range */0；要演「這個網段這小時已經插了 N 次」，在它前面包一層
      const inner = globalThis.fetch;
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        if (req.method === "HEAD" && req.url.includes("/task_boosts")) {
          entry.calls.push({ method: "HEAD", target: "task_boosts", url: new URL(req.url), body: null, headers: Object.fromEntries(req.headers.entries()) });
          return Promise.resolve(new Response(null, { headers: { "content-type": "application/json", "content-range": `*/${opts.count}` } }));
        }
        return inner(req);
      }) as typeof fetch;
    }
    const res = await entry.call(new Request("https://x/jp-boost", {
      method, headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    return { status: res.status, json: JSON.parse(await res.text()) as Row, calls: entry.calls };
  } finally { entry.restore(); }
}

Deno.test("jp-boost 入口：POST 合法條件 → 200、呼叫 policy_jp.task_boost（帶 label／filter／agent／ip 雜湊）、每個請求都帶 policy_jp 標頭", async () => {
  const r = await call("POST", { label: "愛知県 選挙発見", filter: { pref_codes: [AICHI], task_types: ["election_discovery"] }, agent_name: "  claude-test " });
  assertEquals(r.status, 200, JSON.stringify(r.json));
  assertEquals(r.json.success, true);
  assertEquals((r.json.boost as Row).matched_tasks, 2);
  assert(typeof r.json.protocol_version === "string");
  const rpc = r.calls.find((c) => c.target === "rpc/task_boost")!;
  assert(rpc, "有呼叫 task_boost");
  const b = rpc.body as Row;
  assertEquals([b.p_label, b.p_filter, b.p_agent], ["愛知県 選挙発見", { pref_codes: [AICHI], task_types: ["election_discovery"] }, "claude-test"]);
  assert(typeof b.p_ip_hash === "string" && (b.p_ip_hash as string).length >= 32 && !(b.p_ip_hash as string).includes("203.0.113"), "雜湊，不是原始 IP");
  assert(r.calls.length >= 2);
  for (const c of r.calls) assertEquals(profileOf(c), "policy_jp", `${c.method} ${c.target} 要帶 policy_jp 標頭`);
});

Deno.test("jp-boost 入口：壞條件一律 400 且不呼叫 task_boost（未知鍵、台灣詞彙、檢查碼錯、壞日期、空 filter、缺 label、非 JSON）", async () => {
  const cases: unknown[] = [
    { label: "x", filter: { sql: "1=1" } }, { label: "x", filter: { regions: ["愛知県"] } }, { label: "x", filter: { lg_codes: ["232034"] } },
    { label: "x", filter: { election_before: "2027-02-30" } }, { label: "x", filter: {} }, { filter: { kinds: ["task"] } }, { label: "", filter: { kinds: ["task"] } },
    { label: "x" }, "not-an-object",
  ];
  for (const body of cases) {
    const r = await call("POST", body);
    assertEquals(r.status, 400, JSON.stringify(body));
    assertEquals(r.json.success, false);
    assert(!r.calls.some((c) => c.target === "rpc/task_boost"), "壞條件不能走到 SQL");
    for (const c of r.calls) assertEquals(profileOf(c), "policy_jp");
  }
});

Deno.test("jp-boost 入口：同一個網段一小時內超過上限 → 429，不呼叫 task_boost；剛好差一次還放行", async () => {
  const limited = await call("POST", { label: "x", filter: { kinds: ["task"] } }, { count: BOOST_PER_IP_PER_HOUR });
  assertEquals(limited.status, 429);
  assertEquals(limited.json.error, "rate_limited");
  assert(!limited.calls.some((c) => c.target === "rpc/task_boost"));
  const head = limited.calls.find((c) => c.method === "HEAD")!;
  assertEquals(profileOf(head), "policy_jp");
  assert(head.url.searchParams.has("ip_hash") && head.url.searchParams.has("created_at"), "限流查的是這個 ip 雜湊、近一小時");
  const allowed = await call("POST", { label: "x", filter: { kinds: ["task"] } }, { count: BOOST_PER_IP_PER_HOUR - 1 });
  assertEquals(allowed.status, 200);
});

Deno.test("jp-boost 入口：GET 回最近的插隊（前 5 筆帶剩餘量、其餘 null）與用法；其他方法 405；全程 policy_jp", async () => {
  const g = await call("GET");
  assertEquals(g.status, 200);
  const boosts = g.json.boosts as Row[];
  assertEquals(boosts.length, 7);
  assertEquals(boosts.slice(0, 5).every((b) => (b.remaining as Row).tasks === 1), true);
  assertEquals(boosts.slice(5).every((b) => b.remaining === null), true);
  assertEquals((g.json.usage as Row).filter_keys, [...BOOST_FILTER_KEYS]);
  for (const c of g.calls) assertEquals(profileOf(c), "policy_jp");
  assertEquals(g.calls.filter((c) => c.target === "rpc/task_boost_remaining").length, 5);
  assertEquals((await call("DELETE")).status, 405);
});
