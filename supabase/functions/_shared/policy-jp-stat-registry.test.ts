/**
 * 日本站地域統計（regional_stat）的機器核對（migration 20261009210400_policy_jp_stat_registry.sql＋210500 資料；照正見 cec-verify，審核者 estat-auto）。
 *
 * 只要 --allow-read。PGlite 上套日本站整條 migration（schema → tables → 130000 → 130100 → 130200 → 150100 → 200000 → 210000 → 210100
 * → 自治體的機器核對 210200／210300）再加這兩支。
 *   a. 參考表的資料：5,877 列＝1,959 團體×3 項（population／area_km2／aging_rate 各 1,959，跟 210500 自我檢查那行一致）、全是 2025 年・基準日 2025-10-01、
 *      單位＝regional_stat_unit、團體都在總務省團體碼表（沒對到的 6 個是北方領土）、值域（人口整數、面積 > 0 且最多兩位小數、高齢化率 0～100）、
 *      端點與抽樣對得上已知的值、加總一致（都道府県＝其下市區町村、政令市＝其行政區）；表的 CHECK／外鍵；產生器跟 migration 對得上
 *   b. 每一列照抄成交件，日本站的收件驗證（contribution-schema.ts）全收——機器核對得過的交件不會先在收件被擋
 *   c. 判斷 stat_registry_decide：一致／容許差內→apply（人口 0、面積 ±0.005、高齢化率 ±0.05，邊界含）、超出→reject（理由寫國勢調査的值）、
 *      單位或 as_of 不同→reject、別的年份／歳出／團體不在表裡→skip（decide 本身的判斷；掃描前已先濾掉）；全表逐列對自己 apply、全表擾動後 reject／apply 的筆數
 *   d. 掃描 stat_registry_verify_pending：一致→verified 並落庫進 regional_stats（reviewed_by=estat-auto、存代理交的值）、團體還沒進來維持 verified 等團體到了由
 *      落庫掃地機接手、退件寫理由、參考表查不到的（歳出・別的年份・團體不在表裡・年份不是整數）不掃不計數、判不了的（值不是數字）計入 skipped 且不動、
 *      別的型別不碰、p_ids 只看指定的、庫裡已有的照落庫規則（一樣＝成功、不同＝退件）、p_limit 的邊界；
 *      回歸：older 的查不到的 pending 堆過 p_limit 時，排程仍處理得到後面一致的（拿掉 EXISTS 濾網的還原驗證會失敗）
 *   e. TS／SQL 對齊：JP_MACHINE_VERIFIERS.regional_stat 的 rpc 名稱、參數名、reviewer 跟 SQL 一致；用 PGlite 當 supabase.rpc 跑 machineVerifyInline
 *   f. 權限：anon／authenticated 只能讀參考表、不能寫；三支函式只給 service_role
 *   g. 排程：有 pg_cron 就排（重跑只留一條、跟自治體核對與落庫掃地機錯開），沒有就略過
 *   h. 自我檢查（還原驗證）：沒開 RLS、給 anon／authenticated／PUBLIC 寫入、給 anon 執行、少收 PUBLIC 的 REVOKE，重跑都會失敗；
 *      資料 migration 少灌／靜默衝突／單位不對會失敗且不留半套，重跑冪等
 *   i. 文字守門：這兩支只在 policy_jp 動手，不碰 public／ditrust；參考表只拿來核對，沒有寫 regional_stats 的語句
 *   j. 整條（全量）：1,959 團體經團體碼表機器核對進 local_governments → 5,877 筆統計一次交件 → 核對全部落庫、值一致、留 estat-auto、統計缺口只剩歳出
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { lgCodeValid, lgPrefCode } from "./jp/lg-code.ts";
import { JP_STAT_KEYS, JP_STAT_UNITS, validateContributionRequest } from "./jp/contribution-schema.ts";
import { JP_MACHINE_REVIEWERS, JP_MACHINE_VERIFIABLE_TYPES, JP_MACHINE_VERIFIERS, machineVerifyInline } from "./jp/machine-verify.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const CHAIN = [
  "20261008195000_policy_jp_schema.sql", "20261009000000_policy_jp_tables.sql", "20261009130000_policy_jp_dispatch.sql",
  "20261009130100_policy_jp_election_discovery.sql", "20261009130200_policy_jp_term_expirations_r08.sql", "20261009150100_policy_jp_rebalance_anchor.sql",
  "20261009200000_policy_jp_public_stats.sql", "20261009210000_policy_jp_apply.sql", "20261009210100_policy_jp_gap_arms.sql",
  "20261009210200_policy_jp_lg_registry.sql", "20261009210300_policy_jp_lg_registry_data.sql",
];
const CHAIN_SQL = await Promise.all(CHAIN.map(read));
const REG_FILE = "20261009210400_policy_jp_stat_registry.sql";
const DATA_FILE = "20261009210500_policy_jp_stat_registry_data.sql";
const REG_SQL = await read(REG_FILE);
const DATA_SQL = await read(DATA_FILE);
const GEN_SCRIPT = (await Deno.readTextFile(new URL("../../../scripts/gen-jp-stat-registry.ts", import.meta.url))).replace(/\r\n/g, "\n");

const ROLES = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;
/** pg_cron 的最小替身（cron.job 表＋schedule／unschedule） */
const FAKE_CRON = `CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobid SERIAL PRIMARY KEY, jobname TEXT UNIQUE, schedule TEXT, command TEXT);
  CREATE FUNCTION cron.schedule(n TEXT, s TEXT, c TEXT) RETURNS BIGINT LANGUAGE sql AS $$ INSERT INTO cron.job (jobname, schedule, command) VALUES (n, s, c) ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid $$;
  CREATE FUNCTION cron.unschedule(n TEXT) RETURNS BOOLEAN LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = n RETURNING true $$;`;

async function freshDb(o: { cron?: boolean; reg?: string; data?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  if (o.cron) await db.exec(FAKE_CRON);
  for (const sql of CHAIN_SQL) await db.exec(sql);
  await db.exec(o.reg ?? REG_SQL);
  if (o.data !== false) await db.exec(DATA_SQL);
  return db;
}
// 只套一次就好的唯讀檢查共用一個庫
const shared = await freshDb();

const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rows = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
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

// ---- 參考資料（從共用庫讀一次）----
type Reg = { lg_code: string; pref_code: string; pref_name: string; name: string; kana: string; kind: string };
const REGS: Reg[] = await rows<Reg>(shared, `SELECT lg_code, pref_code, pref_name, name, kana, kind FROM policy_jp.lg_code_registry ORDER BY lg_code`);
type Stat = { lg_code: string; stat_key: string; year: number; value: number; unit: string; as_of: string };
const STATS: Stat[] = (await rows<Omit<Stat, "value"> & { value: string }>(shared,
  `SELECT lg_code, stat_key, year, value::text AS value, unit, to_char(as_of, 'YYYY-MM-DD') AS as_of FROM policy_jp.stat_registry ORDER BY lg_code, stat_key`))
  .map((s) => ({ ...s, value: Number(s.value) }));
const STAT_BY = new Map(STATS.map((s) => [`${s.lg_code}/${s.stat_key}`, s]));
const stat = (lg: string, key: string): Stat => STAT_BY.get(`${lg}/${key}`)!;

const SOUMU = "https://www.soumu.go.jp/denshijiti/code.html";
const ESTAT = "https://www.e-stat.go.jp/stat-search/files?page=1&layout=datalist&toukei=00200521";
const ZERO = { applied: 0, waiting: 0, rejected: 0, skipped: 0, other: 0 };
const out = (o: Partial<typeof ZERO>) => ({ ...ZERO, ...o });

/** 一筆 regional_stat 交件的 payload（預設 2025 年、基準日 2025-10-01、單位照 stat_key） */
const statPayload = (lg: string, key: string, value: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  lg_code: lg, stat_key: key, year: 2025, value, unit: JP_STAT_UNITS[key as keyof typeof JP_STAT_UNITS], as_of: "2025-10-01", ...extra,
});
/** 完全照國勢調査的值 */
const exact = (lg: string, key: string, extra: Record<string, unknown> = {}) => statPayload(lg, key, stat(lg, key).value, extra);
const lgPayloadOf = (r: Reg) => ({ lg_code: r.lg_code, kind: r.kind, pref_code: r.pref_code, name: r.name, kana: r.kana });

let seq = 0;
async function submit(db: PGlite, type: string, payload: Record<string, unknown>, urls?: string[]): Promise<string> {
  const n = ++seq;
  return (await one<{ id: string }>(db,
    // created_at 照交件順序遞增（掃描照 created_at 排；同一毫秒內連交時不要靠 uuid 的隨機順序）
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash, created_at)
     VALUES ($1, $2::JSONB, $3, $4, $5, $6, TIMESTAMPTZ '2026-10-09 00:00:00+00' + make_interval(secs => $7)) RETURNING id`,
    [type, JSON.stringify(payload), urls ?? [type === "local_government" ? SOUMU : ESTAT], `author-${n}`, `author-ip-${n}`, `h-${n}`, n])).id;
}
type C = { status: string; reviewed_by: string | null; review_notes: string | null; verified_at: string | null; applied_at: string | null };
const contribution = (db: PGlite, id: string) =>
  one<C>(db, `SELECT status, reviewed_by, review_notes, verified_at, applied_at FROM policy_jp.contributions WHERE id = $1`, [id]);
const runStat = async (db: PGlite) => (await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.stat_registry_verify_pending() AS r`)).r;
type Decision = { action: string; reason?: string; year?: number; as_of?: string; official?: Record<string, unknown> };
const decide = async (db: PGlite, p: Record<string, unknown>) =>
  (await one<{ d: Decision }>(db, `SELECT policy_jp.stat_registry_decide($1::JSONB) AS d`, [JSON.stringify(p)])).d;
const statRows = (db: PGlite) =>
  rows<{ lg_code: string; stat_key: string; year: number; value: string; unit: string; as_of: string | null; review_status: string }>(db,
    `SELECT lg_code, stat_key, year, value::text AS value, unit, to_char(as_of, 'YYYY-MM-DD') AS as_of, review_status FROM policy_jp.regional_stats ORDER BY lg_code, stat_key, year`);

/** 團體（含所屬都道府県）經自治體的機器核對進 local_governments（都道府県先交，所以一輪就落庫） */
async function seedLg(db: PGlite, codes: string[]): Promise<void> {
  const want = new Set<string>();
  for (const c of codes) {
    want.add(lgPrefCode(c)!);
    want.add(c);
  }
  const list = REGS.filter((r) => want.has(r.lg_code)).sort((a, b) => (a.kind === "prefecture" ? 0 : 1) - (b.kind === "prefecture" ? 0 : 1) || a.lg_code.localeCompare(b.lg_code));
  assertEquals(list.length, want.size, "要進的團體都在團體碼表裡");
  for (const r of list) await submit(db, "local_government", lgPayloadOf(r));
  const res = (await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.lg_registry_verify_pending() AS r`)).r;
  assertEquals(res.applied, list.length, "自治體核對一輪全數落庫");
}
/** 同儕驗證通過的替身：直接標 verified 再走真正的落庫函式（拿來造「庫裡已經有別的值」） */
async function landAsPeers(db: PGlite, payload: Record<string, unknown>): Promise<string> {
  const id = await submit(db, "regional_stat", payload);
  await db.query(`UPDATE policy_jp.contributions SET status = 'verified', verified_at = now() WHERE id = $1`, [id]);
  const r = (await one<{ r: { status: string } }>(db, `SELECT policy_jp.apply_contribution($1) AS r`, [id])).r;
  assertEquals(r.status, "applied");
  return id;
}

// =============================================================================================
// a. 參考表的資料
// =============================================================================================
Deno.test("參考表：5,877 列＝1,959 團體×3 項，各項 1,959，跟資料 migration 的標頭與自我檢查一致；全是 2025 年・基準日 2025-10-01・同一個出處", async () => {
  assertEquals(STATS.length, 5877);
  const codes = new Set(STATS.map((s) => s.lg_code));
  assertEquals(codes.size, 1959);
  const tally: Record<string, number> = {};
  for (const s of STATS) tally[s.stat_key] = (tally[s.stat_key] ?? 0) + 1;
  assertEquals(tally, { aging_rate: 1959, area_km2: 1959, population: 1959 });
  // 跟 210500 寫的一樣（標頭、自我檢查的預期字串）
  const kinds = Object.entries(tally).sort().map(([k, n]) => `${k} ${n}`).join("、");
  assertEquals(kinds, "aging_rate 1959、area_km2 1959、population 1959");
  assert(DATA_SQL.includes(`團體 1959 個，共 5877 列：${kinds}。`), "標頭的團體數與列數");
  assert(DATA_SQL.includes(`IS DISTINCT FROM '${kinds}'`), "自我檢查的預期分布");
  // 每個團體恰好三項，一項不多一項不少
  const perLg = new Map<string, string[]>();
  for (const s of STATS) perLg.set(s.lg_code, [...(perLg.get(s.lg_code) ?? []), s.stat_key]);
  for (const [c, keys] of perLg) assertEquals(keys.sort(), ["aging_rate", "area_km2", "population"], `${c} 的統計項目`);
  // 年份・基準日・出處
  for (const s of STATS) {
    assertEquals(s.year, 2025);
    assertEquals(s.as_of, "2025-10-01");
  }
  const src = await rows<{ id: number; url: string; source_kind: string; publisher: string; origin: string; n: number }>(shared,
    `SELECT s.id, s.url, s.source_kind, s.publisher, s.origin, (SELECT count(*)::INT FROM policy_jp.stat_registry r WHERE r.source_id = s.id) AS n
       FROM policy_jp.sources s WHERE s.id IN (SELECT source_id FROM policy_jp.stat_registry)`);
  assertEquals(src.length, 1, "整張表只有一個出處");
  assertEquals(src[0].n, 5877);
  assertEquals([src[0].source_kind, src[0].publisher, src[0].origin], ["statistics", "総務省統計局", "import:estat_census_2025"]);
  assert(src[0].url.startsWith("https://www.e-stat.go.jp/stat-search/file-download?statInfId="), src[0].url);
  assert(DATA_SQL.includes(`VALUES ('${src[0].url}'`), "出處網址就是資料 migration 寫進 sources 的那個");
});

Deno.test("參考表：團體都在總務省團體碼表（檢查碼對）；沒對到的剛好是 6 個北方領土の村；單位＝regional_stat_unit；值域", async () => {
  for (const c of new Set(STATS.map((s) => s.lg_code))) assert(lgCodeValid(c), `${c} 檢查碼`);
  assertEquals((await one<{ n: number }>(shared,
    `SELECT count(*)::INT AS n FROM policy_jp.stat_registry s WHERE NOT EXISTS (SELECT 1 FROM policy_jp.lg_code_registry r WHERE r.lg_code = s.lg_code)`)).n, 0);
  // 團體碼表有、國勢調査的表沒有的團體（國勢調査沒有人口可算）
  const missing = REGS.filter((r) => !STATS.some((s) => s.lg_code === r.lg_code));
  assertEquals(missing.map((r) => `${r.lg_code} ${r.name}`), ["016951 色丹村", "016969 泊村", "016977 留夜別村", "016985 留別村", "016993 紗那村", "017001 蘂取村"]);
  for (const r of missing) assertEquals([r.kind, r.pref_code], ["village", "010006"], `${r.name} 屬北海道`);
  // 單位：TS 與 SQL 兩邊都對
  assertEquals((await one<{ n: number }>(shared,
    `SELECT count(*)::INT AS n FROM policy_jp.stat_registry WHERE unit IS DISTINCT FROM policy_jp.regional_stat_unit(stat_key)`)).n, 0);
  for (const s of STATS) assertEquals(s.unit, JP_STAT_UNITS[s.stat_key as keyof typeof JP_STAT_UNITS], `${s.lg_code} ${s.stat_key}`);
  // 值域：跟 regional_stats 的 CHECK 同一套（人口整數 ≥ 0、面積 > 0、高齢化率 0～100）
  for (const s of STATS) {
    if (s.stat_key === "population") assert(Number.isInteger(s.value) && s.value >= 0, `${s.lg_code} 人口 ${s.value}`);
    if (s.stat_key === "area_km2") assert(s.value > 0, `${s.lg_code} 面積 ${s.value}`);
    if (s.stat_key === "aging_rate") assert(s.value >= 0 && s.value <= 100, `${s.lg_code} 高齢化率 ${s.value}`);
  }
  // 容許差的前提：人口是整數、面積最多小數兩位（面積的容許差 0.005 只在這個前提下才是「四捨五入算對」）
  const scales = await rows<{ stat_key: string; max_scale: number }>(shared,
    `SELECT stat_key, max(scale(value))::INT AS max_scale FROM policy_jp.stat_registry GROUP BY 1 ORDER BY 1`);
  const scaleOf = (k: string) => scales.find((s) => s.stat_key === k)!.max_scale;
  assertEquals(scaleOf("population"), 0, "人口是整數");
  assert(scaleOf("area_km2") <= 2, "面積最多小數兩位");
  assert(scaleOf("aging_rate") <= 5, "高齢化率最多小數五位");
});

Deno.test("參考表：端點與抽樣對得上已知的值（不只是格式）", () => {
  const golden: Array<[string, string, number]> = [
    ["010006", "population", 4980272], ["010006", "area_km2", 83422.27], ["010006", "aging_rate", 33.51657], // 北海道
    ["011002", "population", 1961996], ["011002", "area_km2", 1121.26], ["011002", "aging_rate", 29.25302], // 札幌市
    ["011011", "population", 255523], ["011011", "area_km2", 46.42], ["011011", "aging_rate", 25.84386], // 札幌市中央区
    ["230006", "population", 7448043], ["230006", "area_km2", 5173.26], ["230006", "aging_rate", 25.84453], // 愛知県
    ["232033", "population", 368788], ["232033", "area_km2", 113.82], ["232033", "aging_rate", 28.10937], // 一宮市
    ["473821", "population", 1515], ["473821", "area_km2", 28.9], ["473821", "aging_rate", 21.38614], // 与那国町
    ["130001", "population", 14236627], // 東京都：人口最多
    ["134023", "population", 168], // 青ヶ島村：人口最少
    ["163210", "area_km2", 3.47], // 舟橋村：面積最小
    ["103837", "aging_rate", 68.88889], // 南牧村：高齢化率最高
    ["271284", "aging_rate", 13.98181], // 大阪市中央区：高齢化率最低
  ];
  for (const [lg, key, v] of golden) assertEquals(stat(lg, key).value, v, `${lg} ${key}`);
  const by = (key: string) => STATS.filter((s) => s.stat_key === key);
  assertEquals(Math.max(...by("population").map((s) => s.value)), 14236627);
  assertEquals(Math.min(...by("population").map((s) => s.value)), 168);
  assertEquals(Math.max(...by("area_km2").map((s) => s.value)), 83422.27);
  assertEquals(Math.min(...by("area_km2").map((s) => s.value)), 3.47);
  assertEquals(Math.max(...by("aging_rate").map((s) => s.value)), 68.88889);
  assertEquals(Math.min(...by("aging_rate").map((s) => s.value)), 13.98181);
});

Deno.test("參考表：加總一致——47 都道府県的人口合計、都道府県＝其下市區町村、政令市＝其行政區（解析錯欄或漏列會在這裡露餡）", async () => {
  const db = shared;
  assertEquals((await one<{ pop: string }>(db,
    `SELECT sum(s.value)::BIGINT::TEXT AS pop FROM policy_jp.stat_registry s JOIN policy_jp.lg_code_registry r USING (lg_code) WHERE r.kind = 'prefecture' AND s.stat_key = 'population'`)).pop, "122972528");
  const prefArea = Number((await one<{ a: string }>(db,
    `SELECT sum(s.value)::TEXT AS a FROM policy_jp.stat_registry s JOIN policy_jp.lg_code_registry r USING (lg_code) WHERE r.kind = 'prefecture' AND s.stat_key = 'area_km2'`)).a);
  assert(prefArea > 377000 && prefArea < 379000, `47 都道府県の面積合計 ${prefArea}`);
  // 都道府県の人口＝その下の市區町村（行政區は政令市の内数なので除く）の人口合計。1 件でも違えば列にあがる
  assertEquals(await rows(db,
    `WITH m AS (SELECT r.pref_code, sum(s.value) AS tot FROM policy_jp.stat_registry s JOIN policy_jp.lg_code_registry r USING (lg_code)
                 WHERE s.stat_key = 'population' AND r.kind NOT IN ('prefecture', 'admin_ward') GROUP BY 1)
     SELECT p.lg_code FROM policy_jp.stat_registry p JOIN m ON m.pref_code = p.lg_code WHERE p.stat_key = 'population' AND p.value <> m.tot ORDER BY 1`), []);
  assertEquals((await one<{ n: number }>(db,
    `SELECT count(*)::INT AS n FROM policy_jp.stat_registry p JOIN policy_jp.lg_code_registry r USING (lg_code) WHERE r.kind = 'prefecture' AND p.stat_key = 'population'`)).n, 47);
  // 政令市の人口＝その行政區の人口合計（行政區は、同じ都道府県で自分より前の最後の政令市に属する）、面積も端数の範囲で一致
  const wards = `ward AS (
    SELECT w.lg_code AS wcode, (SELECT d.lg_code FROM policy_jp.lg_code_registry d
                                 WHERE d.kind = 'designated_city' AND d.pref_code = w.pref_code AND left(d.lg_code, 5) < left(w.lg_code, 5)
                                 ORDER BY d.lg_code DESC LIMIT 1) AS dcode
      FROM policy_jp.lg_code_registry w WHERE w.kind = 'admin_ward')`;
  assertEquals((await one<{ n: number }>(db, `WITH ${wards} SELECT count(DISTINCT dcode)::INT AS n FROM ward WHERE dcode IS NOT NULL`)).n, 20, "20 政令市すべてに行政區");
  assertEquals((await one<{ n: number }>(db, `WITH ${wards} SELECT count(*)::INT AS n FROM ward WHERE dcode IS NULL`)).n, 0);
  assertEquals(await rows(db,
    `WITH ${wards} SELECT d.lg_code FROM ward
       JOIN policy_jp.stat_registry w ON w.lg_code = ward.wcode AND w.stat_key = 'population'
       JOIN policy_jp.stat_registry d ON d.lg_code = ward.dcode AND d.stat_key = 'population'
      GROUP BY d.lg_code, d.value HAVING d.value <> sum(w.value) ORDER BY 1`), []);
  assertEquals(await rows(db,
    `WITH ${wards} SELECT d.lg_code FROM ward
       JOIN policy_jp.stat_registry w ON w.lg_code = ward.wcode AND w.stat_key = 'area_km2'
       JOIN policy_jp.stat_registry d ON d.lg_code = ward.dcode AND d.stat_key = 'area_km2'
      GROUP BY d.lg_code, d.value HAVING abs(d.value - sum(w.value)) > 0.05 ORDER BY 1`), []);
  // 高齢化率：都道府県の値＝その下の市區町村を人口で重み付けした平均（四捨五入の誤差の範囲）
  const drift = Number((await one<{ d: string }>(db,
    `WITH m AS (SELECT r.pref_code, sum(s.value * pp.value) / sum(pp.value) AS w
                  FROM policy_jp.stat_registry s
                  JOIN policy_jp.stat_registry pp ON pp.lg_code = s.lg_code AND pp.stat_key = 'population'
                  JOIN policy_jp.lg_code_registry r ON r.lg_code = s.lg_code
                 WHERE s.stat_key = 'aging_rate' AND r.kind NOT IN ('prefecture', 'admin_ward') GROUP BY 1)
     SELECT max(abs(p.value - m.w))::TEXT AS d FROM policy_jp.stat_registry p JOIN m ON m.pref_code = p.lg_code WHERE p.stat_key = 'aging_rate'`)).d);
  assert(drift < 0.01, `都道府県の高齢化率と市區町村の加重平均の差 ${drift}`);
});

Deno.test("參考表：表的 CHECK 與外鍵——檢查碼錯、歳出、單位不對、負數、年份離譜、出處不存在、主鍵重複都寫不進去", async () => {
  const db = shared;
  const ins = (lg: string, key: string, year: number, value: number, unit: string, src = "(SELECT min(source_id) FROM policy_jp.stat_registry)") =>
    db.query(`INSERT INTO policy_jp.stat_registry (lg_code, stat_key, year, value, unit, as_of, source_id) VALUES ('${lg}', '${key}', ${year}, ${value}, '${unit}', DATE '2025-10-01', ${src})`);
  await assertRejects(() => ins("010007", "population", 2020, 1, "人"), Error, "stat_registry_lg_code_check"); // 檢查碼錯
  await assertRejects(() => ins("10006", "population", 2020, 1, "人"), Error, "stat_registry_lg_code_check"); // 不是 6 碼
  await assertRejects(() => ins("010006", "budget_expenditure", 2020, 1, "千円"), Error, "stat_registry_stat_key_check"); // 歳出不在表裡
  await assertRejects(() => ins("010006", "population", 2020, 1, "km2"), Error, "stat_registry_unit_matches"); // 單位跟 stat_key 對不上
  await assertRejects(() => ins("010006", "population", 2020, -1, "人"), Error, "stat_registry_value_check");
  await assertRejects(() => ins("010006", "population", 1899, 1, "人"), Error, "stat_registry_year_check");
  await assertRejects(() => ins("010006", "population", 2020, 1, "人", "-1"), Error, "stat_registry_source_id_fkey"); // 出處不存在
  await assertRejects(() => ins("010006", "population", 2025, 1, "人"), Error, "stat_registry_pkey"); // 主鍵（團體・項目・年）重複
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.stat_registry`)).n, 5877, "擋下的都沒有留下");
  // 表允許的 stat_key＝TS 的清單扣掉歳出（歳出沒有整批比對的官方檔）
  const def = (await one<{ d: string }>(db,
    `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'policy_jp.stat_registry'::regclass AND conname = 'stat_registry_stat_key_check'`)).d;
  const quoted = new Set([...def.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]));
  assertEquals(quoted, new Set(JP_STAT_KEYS.filter((k) => k !== "budget_expenditure")));
  // 容許差：有容許差的 stat_key＝表允許的 stat_key；歳出沒有（NULL）
  const tol = await rows<{ k: string; t: string | null }>(db,
    `SELECT k, policy_jp.stat_registry_tolerance(k)::TEXT AS t FROM unnest(ARRAY['population', 'area_km2', 'aging_rate', 'budget_expenditure', 'gdp']) AS k`);
  assertEquals(tol.map((r) => [r.k, r.t]), [["population", "0"], ["area_km2", "0.005"], ["aging_rate", "0.05"], ["budget_expenditure", null], ["gdp", null]]);
});

Deno.test("產生器與資料 migration 對得上：年份・基準日・檔案編號・輸出檔名・不收歳出", () => {
  assert(GEN_SCRIPT.includes(`const OUT = args.get("--out") ?? "supabase/migrations/${DATA_FILE}"`), "產生器預設輸出就是這支 migration");
  assert(GEN_SCRIPT.includes('const AS_OF = "2025-10-01"') && GEN_SCRIPT.includes("const YEAR = 2025"));
  const id = /const STAT_INF_ID = "(\d+)"/.exec(GEN_SCRIPT)![1];
  assert(DATA_SQL.includes(`file-download?statInfId=${id}&fileKind=0`), "migration 的出處網址就是產生器的檔案編號");
  assert(DATA_SQL.includes("由 scripts/gen-jp-stat-registry.ts 產生，不要手改"));
  assert(DATA_SQL.includes("DATE '2025-10-01'") && DATA_SQL.includes(", 2025, v.value"), "year、as_of 寫在 INSERT 裡");
  assert(/SHA-256 [0-9a-f]{64}/.test(DATA_SQL), "標頭留來源檔的 SHA-256");
  assert(!DATA_SQL.includes("budget_expenditure") && !GEN_SCRIPT.includes('stat_key: "budget_expenditure"'), "歳出不在參考表");
});

// =============================================================================================
// b. 收件驗證
// =============================================================================================
Deno.test("參考表：每一列照抄成 regional_stat 交件，日本站的收件驗證全收（機器核對得過的不會先在收件被擋）", () => {
  const rejected: string[] = [];
  for (const s of STATS) {
    const v = validateContributionRequest({
      agent_name: "tester", contribution_type: "regional_stat",
      payload: { lg_code: s.lg_code, stat_key: s.stat_key, year: s.year, value: s.value, unit: s.unit, as_of: s.as_of },
      source_urls: [ESTAT],
    });
    if (!v.ok) rejected.push(`${s.lg_code} ${s.stat_key}：${v.errors.map((e) => e.message).join(" / ")}`);
  }
  assertEquals(rejected, []);
  // 驗證器不是空轉：單位寫錯、人口帶小數會被擋
  const bad = (p: Record<string, unknown>) => validateContributionRequest({ agent_name: "tester", contribution_type: "regional_stat", payload: p, source_urls: [ESTAT] }).ok;
  assertEquals(bad(statPayload("232033", "population", 368788)), true);
  assertEquals(bad(statPayload("232033", "population", 368788, { unit: "千円" })), false);
  assertEquals(bad(statPayload("232033", "population", 368788.5)), false);
});

// =============================================================================================
// c. 判斷
// =============================================================================================
Deno.test("判斷：完全一致→apply（as_of 沒填或跟表一樣都可以）；as_of 不同→reject；回傳年份與基準日", async () => {
  const db = shared; // 判斷只看參考表，不看團體在不在 local_governments
  for (const k of ["population", "area_km2", "aging_rate"]) {
    assertEquals(await decide(db, exact("230006", k)), { action: "apply", year: 2025, as_of: "2025-10-01" }, k);
    assertEquals((await decide(db, exact("230006", k, { as_of: undefined }))).action, "apply", `${k} 沒填 as_of`);
  }
  const d = await decide(db, exact("230006", "population", { as_of: "2020-10-01" }));
  assertEquals(d.action, "reject");
  assertEquals(d.reason, "as_of 國勢調査的基準日是 2025-10-01、交件是 2020-10-01");
  assertEquals(d.official, { lg_code: "230006", stat_key: "population", year: 2025, value: 7448043, unit: "人", as_of: "2025-10-01" });
  assertEquals((await decide(db, exact("230006", "population", { as_of: "2025-10-1" }))).action, "reject", "日期寫法不同也退（收件驗證本來就擋）");
});

Deno.test("判斷：人口一個字都不能差（±1 就退）；面積 ±0.005、高齢化率 ±0.05 內算對（邊界含）、再多一點就退；理由寫國勢調査的值", async () => {
  const db = shared;
  const act = async (key: string, v: number) => (await decide(db, statPayload("230006", key, v))).action;
  // 人口：7448043
  assertEquals(await act("population", 7448043), "apply");
  assertEquals(await act("population", 7448044), "reject");
  assertEquals(await act("population", 7448042), "reject");
  const pop = await decide(db, statPayload("230006", "population", 7448044));
  assertEquals(pop.reason, "value 國勢調査是 7448043 人、交件是 7448044");
  assertEquals((pop.official as { value: number }).value, 7448043);
  // 面積：5173.26（表是小數兩位，容許差 0.005＝一捨五入算對）
  for (const v of [5173.26, 5173.265, 5173.255, 5173.26001]) assertEquals(await act("area_km2", v), "apply", `面積 ${v}`);
  for (const v of [5173.2651, 5173.2549, 5173.27, 5173.25, 5173.3, 5174]) assertEquals(await act("area_km2", v), "reject", `面積 ${v}`);
  assertEquals((await decide(db, statPayload("230006", "area_km2", 5173.3))).reason, "value 國勢調査是 5173.26 km2、交件是 5173.3");
  // 高齢化率：25.84453（容許差 0.05；代理多半交小數一位的 25.8）
  for (const v of [25.84453, 25.8, 25.84, 25.89453, 25.79453, 25.85]) assertEquals(await act("aging_rate", v), "apply", `高齢化率 ${v}`);
  for (const v of [25.89454, 25.79452, 25.9, 25.7, 26, 2.58, 0.2584]) assertEquals(await act("aging_rate", v), "reject", `高齢化率 ${v}`);
  assertEquals((await decide(db, statPayload("230006", "aging_rate", 26))).reason, "value 國勢調査是 25.84453 %、交件是 26");
});

Deno.test("判斷：單位不同→reject（空白也算）；多欄都錯→理由全寫（unit・value・as_of 依序，用「；」連）", async () => {
  const db = shared;
  const u1 = await decide(db, exact("230006", "population", { unit: "km2" }));
  assertEquals([u1.action, u1.reason], ["reject", "unit 要是「人」、交件是「km2」"]);
  const u2 = await decide(db, exact("230006", "area_km2", { unit: undefined }));
  assertEquals([u2.action, u2.reason], ["reject", "unit 要是「km2」、交件是「(空白)」"]);
  assertEquals((await decide(db, exact("230006", "aging_rate", { unit: "％" }))).action, "reject", "全形％不是 %");
  const all = await decide(db, statPayload("230006", "population", 1, { unit: "千人", as_of: "2020-10-01" }));
  assertEquals(all.action, "reject");
  const parts = all.reason!.split("；");
  assertEquals(parts.length, 3);
  assert(parts[0].startsWith("unit ") && parts[1].startsWith("value ") && parts[2].startsWith("as_of "), all.reason);
  assert(parts[1].includes("7448043"), "理由寫國勢調査的值");
});

Deno.test("判斷：別的年份・歳出・不認得的項目・團體不在表裡（含北方領土）・欄位缺或型別不對→skip，留給同儕", async () => {
  const db = shared;
  const sk = async (p: Record<string, unknown>) => (await decide(db, p));
  const y2020 = await sk(statPayload("230006", "population", 7542415, { year: 2020, as_of: "2020-10-01" }));
  assertEquals(y2020.action, "skip");
  assert(y2020.reason!.includes("230006") && y2020.reason!.includes("population") && y2020.reason!.includes("2020") && y2020.reason!.includes("留給同儕驗證"), y2020.reason);
  assertEquals((await sk(statPayload("230006", "population", 7448043, { year: 2024 }))).action, "skip");
  assertEquals((await sk(statPayload("230006", "population", 7448043, { year: 2026 }))).action, "skip");
  // 歳出：沒有可以整批比對的官方檔
  const budget = await sk(statPayload("230006", "budget_expenditure", 123456789, { year: 2023, as_of: undefined }));
  assertEquals(budget.action, "skip");
  assert(budget.reason!.includes("budget_expenditure"), budget.reason);
  assertEquals((await sk(statPayload("230006", "budget_expenditure", 123456789, { year: 2025 }))).action, "skip", "年份對得上也一樣，歳出不在表裡");
  assertEquals((await sk(statPayload("230006", "gdp", 1, { unit: "円" }))).action, "skip");
  // 團體：檢查碼正確但碼表沒有／北方領土（團體碼表有、國勢調査沒有）／沒給
  assert(lgCodeValid("999997"));
  assertEquals((await sk(statPayload("999997", "population", 100))).action, "skip");
  assertEquals((await sk(statPayload("016951", "population", 0))).action, "skip");
  assertEquals((await sk(statPayload("016951", "area_km2", 250))).action, "skip");
  assertEquals((await sk({ stat_key: "population", year: 2025, value: 1, unit: "人" })).action, "skip");
  // payload 整個是 NULL（SQL）或 JSON null：也只是 skip，不丟例外
  assertEquals((await one<{ d: Decision }>(db, `SELECT policy_jp.stat_registry_decide(NULL) AS d`)).d.action, "skip");
  assertEquals((await db.query<{ d: Decision }>(`SELECT policy_jp.stat_registry_decide('null'::JSONB) AS d`)).rows[0].d.action, "skip");
  // year、value 不是數字：收件驗證會擋，這裡不判
  for (const p of [
    statPayload("230006", "population", "7448043"), statPayload("230006", "population", null), statPayload("230006", "population", 7448043, { year: "2025" }),
    statPayload("230006", "population", 7448043, { year: undefined }), statPayload("230006", "population", undefined),
  ]) {
    const r = await sk(p);
    assertEquals([r.action, r.reason], ["skip", "year、value 不是數字（交件驗證會擋，這裡不判）"]);
  }
});

Deno.test("判斷：全表逐列對自己 apply；全表擾動（人口 ±1、面積 ±0.0051、高齢化率 ±0.0501→reject；面積 ±0.005、高齢化率 ±0.05→apply）", async () => {
  const db = shared;
  const sweep = async (key: string | null, delta: string) =>
    await rows<{ action: string; n: number }>(db,
      `SELECT policy_jp.stat_registry_decide(jsonb_build_object('lg_code', lg_code, 'stat_key', stat_key, 'year', year, 'value', value + $2::NUMERIC, 'unit', unit,
                'as_of', to_char(as_of, 'YYYY-MM-DD')))->>'action' AS action, count(*)::INT AS n
         FROM policy_jp.stat_registry WHERE ($1::TEXT IS NULL OR stat_key = $1) GROUP BY 1 ORDER BY 1`, [key, delta]);
  assertEquals(await sweep(null, "0"), [{ action: "apply", n: 5877 }], "每一列對自己都 apply");
  for (const d of ["1", "-1"]) assertEquals(await sweep("population", d), [{ action: "reject", n: 1959 }], `人口 ${d}`);
  for (const d of ["0.005", "-0.005"]) assertEquals(await sweep("area_km2", d), [{ action: "apply", n: 1959 }], `面積 ${d}`);
  for (const d of ["0.0051", "-0.0051", "0.01", "-0.01"]) assertEquals(await sweep("area_km2", d), [{ action: "reject", n: 1959 }], `面積 ${d}`);
  for (const d of ["0.05", "-0.05", "0.01"]) assertEquals(await sweep("aging_rate", d), [{ action: "apply", n: 1959 }], `高齢化率 ${d}`);
  for (const d of ["0.0501", "-0.0501", "0.06", "-0.06", "1"]) assertEquals(await sweep("aging_rate", d), [{ action: "reject", n: 1959 }], `高齢化率 ${d}`);
  // 判斷是唯讀的（STABLE）：跑了這麼多次，沒有任何貢獻、統計被動過
  assertEquals((await one<{ n: number }>(db, `SELECT (SELECT count(*) FROM policy_jp.contributions)::INT + (SELECT count(*) FROM policy_jp.regional_stats)::INT AS n`)).n, 0);
});

// =============================================================================================
// d. 掃描
// =============================================================================================
Deno.test("掃描：一致的直接落庫（reviewed_by=estat-auto、留核對紀錄、存的是代理交的值）；統計缺口只剩歳出", async () => {
  const db = await freshDb();
  await seedLg(db, ["232033"]); // 愛知県＋一宮市
  const pop = await submit(db, "regional_stat", exact("232033", "population"));
  const area = await submit(db, "regional_stat", exact("232033", "area_km2"));
  const aging = await submit(db, "regional_stat", statPayload("232033", "aging_rate", 28.1)); // 小數一位四捨五入，在容許差內
  // 缺口：愛知県、一宮市都還缺四項（以團體的公開統計為準）
  const gap = () => rows<{ lg_code: string; keys: string[] }>(db,
    `SELECT t.target->>'lg_code' AS lg_code, ARRAY(SELECT m->>'stat_key' FROM jsonb_array_elements(t.target->'missing') m ORDER BY 1) AS keys
       FROM policy_jp.contribution_auto_tasks_regional_stats_missing() t ORDER BY 1`);
  assertEquals(await gap(), [
    { lg_code: "230006", keys: ["aging_rate", "area_km2", "budget_expenditure", "population"] },
    { lg_code: "232033", keys: ["aging_rate", "area_km2", "budget_expenditure", "population"] },
  ]);
  assertEquals(await runStat(db), out({ applied: 3 }));
  for (const [id, key, shown] of [[pop, "population", "368788 人"], [area, "area_km2", "113.82 km2"], [aging, "aging_rate", "28.1 %"]] as const) {
    const c = await contribution(db, id);
    assertEquals([c.status, c.reviewed_by], ["applied", "estat-auto"], key);
    assert(c.verified_at && c.applied_at, "verified_at、applied_at 要記");
    assert(c.review_notes!.startsWith("[estat-auto] 國勢調査（2025 年、基準日 2025-10-01）自動核對通過：值在容許差內"), c.review_notes!);
    assert(c.review_notes!.includes(`／[auto] 新增統計 232033/${key}/2025 ＝ ${shown}`), c.review_notes!);
  }
  // 正式列：值是代理交的（aging_rate 是 28.1，不是參考表的 28.10937）；參考表只拿來核對
  assertEquals(await statRows(db), [
    { lg_code: "232033", stat_key: "aging_rate", year: 2025, value: "28.1", unit: "%", as_of: "2025-10-01", review_status: "published" },
    { lg_code: "232033", stat_key: "area_km2", year: 2025, value: "113.82", unit: "km2", as_of: "2025-10-01", review_status: "published" },
    { lg_code: "232033", stat_key: "population", year: 2025, value: "368788", unit: "人", as_of: "2025-10-01", review_status: "published" },
  ]);
  assertEquals((await rows<{ url: string }>(db, `SELECT DISTINCT s.url FROM policy_jp.regional_stats r JOIN policy_jp.sources s ON s.id = r.source_id`)).map((r) => r.url), [ESTAT], "出處是代理交的網址");
  const hist = await rows<{ table_name: string; agent_name: string; cid: string }>(db,
    `SELECT table_name, agent_name, contribution_id::TEXT AS cid FROM policy_jp.edit_history WHERE table_name = 'regional_stats' ORDER BY record_id`);
  assertEquals(hist.map((h) => h.cid).sort(), [pop, area, aging].sort(), "異動紀錄追得回交件");
  assertEquals(new Set(hist.map((h) => h.agent_name)), new Set(["auto-apply"]));
  // 缺口：人口・面積・高齢化率已有 2020 年以後的公開值，一宮市只剩歳出
  assertEquals(await gap(), [
    { lg_code: "230006", keys: ["aging_rate", "area_km2", "budget_expenditure", "population"] },
    { lg_code: "232033", keys: ["budget_expenditure"] },
  ]);
  // 再掃一次：沒有 pending 了，什麼都不做
  assertEquals(await runStat(db), ZERO);
  await db.close();
});

Deno.test("掃描：團體還沒進來的維持 verified 等著（estat-auto、看得到在等誰），團體到了落庫掃地機接手；退件不用等團體", async () => {
  const db = await freshDb();
  const ok = await submit(db, "regional_stat", exact("232033", "population"));
  const bad = await submit(db, "regional_stat", statPayload("232033", "area_km2", 200));
  assertEquals(await runStat(db), out({ waiting: 1, rejected: 1 }));
  const w = await contribution(db, ok);
  assertEquals([w.status, w.reviewed_by], ["verified", "estat-auto"]);
  assert(w.verified_at, "verified_at 要記");
  assert(w.review_notes!.startsWith("[estat-auto] 國勢調査") && !w.applied_at);
  assertEquals((await contribution(db, bad)).status, "rejected", "退件跟團體在不在庫裡無關");
  assertEquals(await statRows(db), []);
  assertEquals(await rows(db, `SELECT id, waiting_for FROM policy_jp.apply_waiting`), [{ id: ok, waiting_for: "local_government_missing:232033" }]);
  // 團體還沒進來，落庫掃地機不碰它（也不佔額度）
  assertEquals(await one(db, `SELECT policy_jp.apply_verified_pending(20, 0) AS r`), { r: { scanned: 0, applied: 0, rejected: 0, apply_failed: 0 } });
  // 團體進來（自治體的機器核對）→ 掃地機把它落庫
  await seedLg(db, ["232033"]);
  assertEquals(await one(db, `SELECT policy_jp.apply_verified_pending(20, 0) AS r`), { r: { scanned: 1, applied: 1, rejected: 0, apply_failed: 0 } });
  const a = await contribution(db, ok);
  assertEquals(a.status, "applied");
  // 現況（同自治體核對的做法）：掃地機落庫時把 reviewed_by／review_notes 蓋成 auto-apply，estat-auto 的核對紀錄只留在行內落庫那一條路
  assertEquals(a.reviewed_by, "auto-apply");
  assertEquals(await statRows(db), [{ lg_code: "232033", stat_key: "population", year: 2025, value: "368788", unit: "人", as_of: "2025-10-01", review_status: "published" }]);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.apply_waiting`)).n, 0);
  await db.close();
});

Deno.test("掃描：不一致的退件（理由寫國勢調査的值）、查不到的不掃不計數、判不了的計入 skipped 不動、別的型別不碰", async () => {
  const db = await freshDb();
  await seedLg(db, ["232033"]);
  const wrongPop = await submit(db, "regional_stat", statPayload("232033", "population", 368789));
  const wrongArea = await submit(db, "regional_stat", statPayload("232033", "area_km2", 113.9));
  const wrongUnit = await submit(db, "regional_stat", exact("232033", "aging_rate", { unit: "％" }));
  const wrongDate = await submit(db, "regional_stat", exact("232033", "aging_rate", { as_of: "2020-10-01" }));
  const good = await submit(db, "regional_stat", exact("232033", "aging_rate"));
  // 參考表查不到的（別的年份、歳出、碼表沒有的團體、北方領土、年份不是整數）：掃描 SQL 先濾掉，不掃、不計數，一直停在 pending 等同儕
  const unknown = [
    await submit(db, "regional_stat", statPayload("232033", "population", 380000, { year: 2020, as_of: "2020-10-01" })),
    await submit(db, "regional_stat", statPayload("232033", "budget_expenditure", 98765432, { year: 2023, as_of: undefined })),
    await submit(db, "regional_stat", statPayload("999997", "population", 100)),
    await submit(db, "regional_stat", statPayload("016951", "population", 0)),
    await submit(db, "regional_stat", exact("232033", "population", { year: 2025.4 })),
  ];
  // 查得到、但 decide 判不了的（value 不是數字：收件驗證會擋，直接寫庫才有）：掃到、計入 skipped、不動
  const undecidable = [await submit(db, "regional_stat", statPayload("232033", "population", "368788"))];
  // 別的型別：即使 payload 長得像統計也不碰
  const others = [
    await submit(db, "local_government", lgPayloadOf(REGS.find((r) => r.lg_code === "230006")!)),
    await submit(db, "election", { lg_code: "232033", election_type: "mayor", election_reason: "regular", election_date: "2027-04-25" }),
    await submit(db, "no_change", exact("232033", "population")),
  ];
  assertEquals(await runStat(db), out({ applied: 1, rejected: 4, skipped: 1 }));
  assertEquals((await contribution(db, good)).status, "applied");
  for (const [id, expect] of [[wrongPop, "368788"], [wrongArea, "113.82"], [wrongUnit, "unit 要是「%」"], [wrongDate, "2025-10-01"]] as const) {
    const c = await contribution(db, id);
    assertEquals([c.status, c.reviewed_by], ["rejected", "estat-auto"]);
    assert(c.reviewed_by && c.verified_at === null, "退件不記 verified_at");
    assert(c.review_notes!.startsWith("[estat-auto] 國勢調査（e-Stat）自動核對不通過：") && c.review_notes!.endsWith("。照國勢調査的值改正後重新交件"), c.review_notes!);
    assert(c.review_notes!.includes(expect), `${expect} ⊂ ${c.review_notes}`);
  }
  for (const id of [...unknown, ...undecidable, ...others]) {
    const c = await contribution(db, id);
    assertEquals([c.status, c.reviewed_by, c.review_notes, c.verified_at], ["pending", null, null, null], "查不到的、判不了的、別的型別都原封不動");
  }
  assertEquals((await statRows(db)).length, 1, "正式列只有 good 那一筆");
  await db.close();
});

Deno.test("掃描：庫裡已經有的照落庫規則——一樣的成功（不重複建）、不一樣的退件（不覆蓋）；容許差內但跟庫裡不同也算不同", async () => {
  const db = await freshDb();
  await seedLg(db, ["232033"]);
  await landAsPeers(db, statPayload("232033", "population", 368000)); // 同儕以前通過的舊值
  await landAsPeers(db, exact("232033", "area_km2")); // 同儕通過的值，跟國勢調査一樣
  const conflict = await submit(db, "regional_stat", exact("232033", "population")); // 國勢調査的值 vs 庫裡的 368000
  const same = await submit(db, "regional_stat", exact("232033", "area_km2")); // 跟庫裡一樣
  const near = await submit(db, "regional_stat", statPayload("232033", "area_km2", 113.822)); // 在容許差內、但跟庫裡的 113.82 不同
  assertEquals(await runStat(db), out({ applied: 1, other: 2 }));
  const c = await contribution(db, conflict);
  assertEquals([c.status, c.reviewed_by], ["rejected", "estat-auto"]);
  assert(c.review_notes!.includes("自動核對通過") && c.review_notes!.includes("庫裡已有 232033 2025 年的 population ＝ 368000 人，與提交的 368788 人 不同，不覆蓋"), c.review_notes!);
  const s = await contribution(db, same);
  assertEquals([s.status, s.reviewed_by], ["applied", "estat-auto"]);
  assert(s.review_notes!.includes("232033/area_km2/2025 已在庫裡，數值一致"), s.review_notes!);
  const n = await contribution(db, near);
  assertEquals(n.status, "rejected");
  assert(n.review_notes!.includes("113.82 km2，與提交的 113.822 km2 不同，不覆蓋"), n.review_notes!);
  assertEquals((await statRows(db)).map((r) => [r.stat_key, r.value]), [["area_km2", "113.82"], ["population", "368000"]], "庫裡的值都沒被動");
  await db.close();
});

Deno.test("交件當下核對（p_ids）：只看指定的那幾筆，其他 pending 的留給排程；空陣列什麼都不做；指到別的型別或已處理過的不動", async () => {
  const db = await freshDb();
  await seedLg(db, ["232033"]);
  const a = await submit(db, "regional_stat", exact("232033", "population"));
  const b = await submit(db, "regional_stat", exact("232033", "area_km2"));
  const lg = await submit(db, "local_government", lgPayloadOf(REGS.find((r) => r.lg_code === "233021")!));
  const budget = await submit(db, "regional_stat", statPayload("232033", "budget_expenditure", 98765432, { year: 2023, as_of: undefined }));
  const withIds = async (ids: string[] | null) =>
    (await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.stat_registry_verify_pending(10, $1::UUID[]) AS r`, [ids])).r;
  assertEquals(await withIds([]), ZERO);
  assertEquals(await withIds([lg]), ZERO, "指到 local_government 的 id：這支不碰");
  assertEquals((await contribution(db, lg)).status, "pending");
  assertEquals(await withIds([budget]), ZERO, "指到參考表查不到的（歳出）：不掃、不計數，連 p_ids 也一樣");
  assertEquals((await contribution(db, budget)).status, "pending");
  assertEquals(await withIds([b]), out({ applied: 1 }));
  assertEquals((await contribution(db, a)).status, "pending");
  assertEquals((await contribution(db, b)).status, "applied");
  assertEquals(await withIds([b]), ZERO, "已經處理過的不再碰");
  assertEquals(await withIds(null), out({ applied: 1 }), "NULL＝全部 pending（排程）");
  assertEquals((await contribution(db, a)).status, "applied");
  assertEquals((await contribution(db, lg)).status, "pending");
  assertEquals((await contribution(db, budget)).status, "pending");
  await db.close();
});

Deno.test("掃描：p_limit 的邊界——0 當 1、照交件順序（舊的先）；NULL 用預設；一輪最多 5,000", async () => {
  const db = await freshDb();
  await seedLg(db, ["232033"]);
  const ids = [
    await submit(db, "regional_stat", exact("232033", "population")),
    await submit(db, "regional_stat", exact("232033", "area_km2")),
    await submit(db, "regional_stat", exact("232033", "aging_rate")),
  ];
  const lim = async (n: number | null) => (await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.stat_registry_verify_pending($1::INTEGER) AS r`, [n])).r;
  assertEquals(await lim(0), out({ applied: 1 }));
  assertEquals((await contribution(db, ids[0])).status, "applied", "最舊的先");
  assertEquals((await contribution(db, ids[1])).status, "pending");
  assertEquals(await lim(1), out({ applied: 1 }));
  assertEquals(await lim(null), out({ applied: 1 }));
  assertEquals((await statRows(db)).length, 3);
  await db.close();
  // 上限 5,000 寫在函式本體裡（全量測試在最後一支：5,877 筆分兩輪）
  const body = (await one<{ d: string }>(shared, `SELECT pg_get_functiondef('policy_jp.stat_registry_verify_pending(integer, uuid[])'::regprocedure) AS d`)).d;
  assert(body.includes("LEAST(COALESCE(p_limit, 2000), 5000)"));
});

Deno.test("掃描：年份不是整數（直接寫庫才有可能，收件驗證會擋）——參考表查不到，不掃不計數，維持 pending、不進正式表", async () => {
  const db = await freshDb();
  await seedLg(db, ["232033"]);
  const id = await submit(db, "regional_stat", exact("232033", "population", { year: 2025.4 }));
  assertEquals(await runStat(db), ZERO);
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.stat_registry_verify_pending(10, $1::UUID[]) AS r`, [[id]])).r, ZERO);
  const c = await contribution(db, id);
  assertEquals([c.status, c.reviewed_by, c.review_notes, c.verified_at], ["pending", null, null, null]);
  assertEquals(await statRows(db), []);
  await db.close();
});

/** 查不到的 pending 堆在前面、最後來一筆對得上的：交件當下（p_ids）與排程（預設 p_limit、沒有 p_ids）各會處理到幾筆 */
async function starvationScenario(db: PGlite) {
  await seedLg(db, ["232033"]);
  // 參考表查不到的 pending（歳出、別的年份、北方領土）會一直留著等同儕，而日本站同儕很少：先堆 2,100 筆比較舊的
  await db.exec(`INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash, created_at)
    SELECT 'regional_stat',
           CASE g % 3
             WHEN 0 THEN jsonb_build_object('lg_code', '232033', 'stat_key', 'budget_expenditure', 'year', 2023, 'value', 1000 + g, 'unit', '千円')
             WHEN 1 THEN jsonb_build_object('lg_code', '232033', 'stat_key', 'population', 'year', 2020, 'value', 300000 + g, 'unit', '人', 'as_of', '2020-10-01')
             ELSE jsonb_build_object('lg_code', '016951', 'stat_key', 'population', 'year', 2025, 'value', g, 'unit', '人') END,
           ARRAY['${ESTAT}'], 'backlog-agent', 'backlog-ip-' || g, 'backlog-' || g, TIMESTAMPTZ '2026-09-01 00:00:00+00' + make_interval(secs => g)
      FROM generate_series(1, 2100) g`);
  const fresh = await submit(db, "regional_stat", exact("232033", "population"));
  const viaIds = (await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.stat_registry_verify_pending(10, $1::UUID[]) AS r`, [[fresh]])).r;
  const fresh2 = await submit(db, "regional_stat", exact("232033", "area_km2"));
  const sweep = await runStat(db);
  const left = (await one<{ n: number }>(db,
    `SELECT count(*)::INT AS n FROM policy_jp.contributions WHERE contribution_type = 'regional_stat' AND status = 'pending' AND agent_name = 'backlog-agent'`)).n;
  return { viaIds, sweep, left, fresh2: (await contribution(db, fresh2)).status };
}

Deno.test("掃描（回歸）：older 的查不到的 pending（別的年份・歳出・北方領土）堆過 p_limit，後面一致的仍被排程處理；舊的不計數、原封不動", async () => {
  const db = await freshDb();
  const r = await starvationScenario(db);
  assertEquals(r.viaIds, out({ applied: 1 }), "交件當下（p_ids）本來就不受堆積影響");
  assertEquals(r.sweep, out({ applied: 1 }), "排程（預設 p_limit 2000）不被 2,100 筆查不到的佔滿名額，也不把它們算進 skipped");
  assertEquals(r.fresh2, "applied");
  assertEquals(r.left, 2100, "查不到的 2,100 筆都還在 pending 等同儕");
  await db.close();
});

Deno.test("掃描（還原驗證）：拿掉掃描 SQL 的「只掃參考表查得到的」濾網，同一個情境排程就餓死（applied 0、skipped 2000）", async () => {
  const filter = /\n[ \t]+AND EXISTS \(SELECT 1 FROM policy_jp\.stat_registry r\n[ \t]+WHERE r\.lg_code = payload->>'lg_code'[^\n]*\)\n/g;
  assertEquals((REG_SQL.match(filter) ?? []).length, 1, "濾網在 migration 裡剛好出現一次");
  const noFilter = REG_SQL.replace(filter, "\n");
  assertNotEquals(noFilter, REG_SQL);
  const db = await freshDb({ reg: noFilter });
  const r = await starvationScenario(db);
  assertEquals(r.viaIds, out({ applied: 1 }), "p_ids 的路沒有濾網也沒事");
  assertEquals(r.sweep, out({ skipped: 2000 }), "沒有濾網：前 2,000 筆全是查不到的，後面一致的輪不到");
  assertEquals(r.fresh2, "pending");
  assertEquals(r.left, 2100);
  await db.close();
});

// =============================================================================================
// e. TS／SQL 對齊
// =============================================================================================
Deno.test("機器核對的審核者與型別：TS 清單跟 SQL 寫的一致（regional_stat → stat_registry_verify_pending／estat-auto）", async () => {
  const v = JP_MACHINE_VERIFIERS.regional_stat;
  assertEquals(v, { rpc: "stat_registry_verify_pending", reviewer: "estat-auto" });
  assertEquals([...JP_MACHINE_REVIEWERS], ["soumu-auto", "estat-auto"]);
  assertEquals([...JP_MACHINE_VERIFIABLE_TYPES], ["local_government", "regional_stat"]);
  // migration 文字
  assert(REG_SQL.includes(`CREATE OR REPLACE FUNCTION policy_jp.${v.rpc}(`));
  assert(REG_SQL.includes("contribution_type = 'regional_stat'"));
  assert(REG_SQL.includes(`'SELECT policy_jp.${v.rpc}();'`), "排程叫的就是 TS 這支");
  const n = REG_SQL.split(`reviewed_by = '${v.reviewer}'`).length - 1;
  assert(n >= 3, `reviewed_by = '${v.reviewer}' 在退件、通過、落庫後補回各一處（${n}）`);
  // 線上的函式本體與參數名（machine-verify.ts 用具名參數 p_limit、p_ids 呼叫 rpc）
  const f = await one<{ def: string; args: string[] }>(shared,
    `SELECT pg_get_functiondef(p.oid) AS def, p.proargnames AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'policy_jp' AND p.proname = $1`, [v.rpc]);
  assertEquals(f.args, ["p_limit", "p_ids"]);
  assert(f.def.includes(`'${v.reviewer}'`) && f.def.includes("'regional_stat'") && f.def.includes("policy_jp.apply_contribution(c.id, false)"));
  // 自治體那支用的審核者不同，兩邊不會互相蓋
  assertNotEquals(JP_MACHINE_VERIFIERS.local_government.reviewer, v.reviewer);
});

Deno.test("交件當下核對：machineVerifyInline 用 PGlite 當 supabase.rpc，regional_stat 與 local_government 一起交，各走各的 SQL 函式", async () => {
  const db = await freshDb();
  const stub = {
    rpc: async (name: string, args: { p_limit: number; p_ids: string[] }) => {
      assert(/^[a-z_]+$/.test(name), name);
      try {
        const r = await one<{ r: unknown }>(db, `SELECT policy_jp.${name}(p_limit => $1::INTEGER, p_ids => $2::UUID[]) AS r`, [args.p_limit, args.p_ids]);
        return { data: r.r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
  // 都道府県與市先交、統計後交（同一輪：自治體核對在前、統計在後，統計找得到團體）
  const aichi = await submit(db, "local_government", lgPayloadOf(REGS.find((r) => r.lg_code === "230006")!));
  const ichi = await submit(db, "local_government", lgPayloadOf(REGS.find((r) => r.lg_code === "232033")!));
  const good = await submit(db, "regional_stat", exact("232033", "population"));
  const bad = await submit(db, "regional_stat", statPayload("232033", "area_km2", 999));
  const skip = await submit(db, "regional_stat", statPayload("232033", "budget_expenditure", 5555555, { year: 2023, as_of: undefined }));
  const election = await submit(db, "election", { lg_code: "232033", election_type: "mayor", election_reason: "regular", election_date: "2027-04-25" });
  const o = await machineVerifyInline(stub, [
    { id: aichi, contribution_type: "local_government" }, { id: ichi, contribution_type: "local_government" },
    { id: good, contribution_type: "regional_stat" }, { id: bad, contribution_type: "regional_stat" }, { id: skip, contribution_type: "regional_stat" },
    { id: election, contribution_type: "election" },
  ]);
  assertEquals(o, out({ applied: 3, rejected: 1 }), "歳出參考表查不到：不掃、不計數、維持 pending");
  assertEquals((await contribution(db, good)).reviewed_by, "estat-auto");
  assertEquals((await contribution(db, aichi)).reviewed_by, "soumu-auto");
  assertEquals((await contribution(db, bad)).status, "rejected");
  for (const id of [skip, election]) assertEquals((await contribution(db, id)).status, "pending");
  // 沒有會被機器核對的型別：一次 rpc 都不叫，回 null
  assertEquals(await machineVerifyInline(stub, [{ id: election, contribution_type: "election" }]), null);
  await db.close();
});

// =============================================================================================
// f. 權限
// =============================================================================================
Deno.test("權限：anon／authenticated 只能讀參考表、不能寫；三支函式只給 service_role", async () => {
  const db = shared;
  for (const role of ["anon", "authenticated"]) {
    assertEquals((await asRole<{ n: number }>(db, role, `SELECT count(*)::INT AS n FROM policy_jp.stat_registry`))[0].n, 5877, `${role} 讀得到全部`);
    assertEquals((await asRole<{ n: number }>(db, role, `SELECT count(*)::INT AS n FROM policy_jp.stat_registry WHERE lg_code = '230006'`))[0].n, 3);
    await assertRejects(() => asRole(db, role, `INSERT INTO policy_jp.stat_registry (lg_code, stat_key, year, value, unit, as_of, source_id) SELECT lg_code, stat_key, 2020, value, unit, as_of, source_id FROM policy_jp.stat_registry LIMIT 1`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `UPDATE policy_jp.stat_registry SET value = 1`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `DELETE FROM policy_jp.stat_registry`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT policy_jp.stat_registry_verify_pending()`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT policy_jp.stat_registry_decide('{}'::JSONB)`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT policy_jp.stat_registry_tolerance('population')`), Error, "permission denied");
  }
  // 表權限與 RLS 政策：只有一條公開讀
  assertEquals(await rows(db,
    `SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'policy_jp' AND table_name = 'stat_registry' AND grantee IN ('anon', 'authenticated', 'PUBLIC') ORDER BY 1, 2`),
    [{ grantee: "anon", privilege_type: "SELECT" }, { grantee: "authenticated", privilege_type: "SELECT" }]);
  assertEquals(await rows(db, `SELECT policyname, cmd, roles::TEXT AS roles FROM pg_policies WHERE schemaname = 'policy_jp' AND tablename = 'stat_registry'`),
    [{ policyname: "Public read", cmd: "SELECT", roles: "{anon,authenticated}" }]);
  // 函式的權限表：沒有 PUBLIC（grantee 0）、只有 service_role
  assertEquals(await rows(db,
    `SELECT p.proname, array_agg(DISTINCT a.grantee::regrole::TEXT ORDER BY a.grantee::regrole::TEXT) AS grantees
       FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE p.pronamespace = 'policy_jp'::regnamespace AND p.proname LIKE 'stat_registry%' AND a.grantee <> p.proowner GROUP BY 1 ORDER BY 1`),
    [{ proname: "stat_registry_decide", grantees: ["service_role"] }, { proname: "stat_registry_tolerance", grantees: ["service_role"] },
      { proname: "stat_registry_verify_pending", grantees: ["service_role"] }]);
  // service_role 呼叫得動
  assertEquals((await asRole<{ r: Record<string, number> }>(db, "service_role", `SELECT policy_jp.stat_registry_verify_pending() AS r`))[0].r.applied, 0);
  assertEquals((await asRole<{ d: Decision }>(db, "service_role", `SELECT policy_jp.stat_registry_decide('{}'::JSONB) AS d`))[0].d.action, "skip");
});

// =============================================================================================
// g. 排程
// =============================================================================================
Deno.test("排程：有 pg_cron 就排（重跑只留一條、不傷參考表、跟自治體核對與落庫掃地機錯開），沒有就略過", async () => {
  const db = await freshDb({ cron: true });
  const job = (name: string) => rows<{ jobname: string; schedule: string; command: string }>(db, `SELECT jobname, schedule, command FROM cron.job WHERE jobname = $1`, [name]);
  const expected = [{ jobname: "policy-jp-stat-registry-verify", schedule: "3,13,23,33,43,53 * * * *", command: "SELECT policy_jp.stat_registry_verify_pending();" }];
  assertEquals(await job("policy-jp-stat-registry-verify"), expected);
  const before = (await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM cron.job`)).n;
  await db.exec(REG_SQL);
  await db.exec(REG_SQL);
  assertEquals(await job("policy-jp-stat-registry-verify"), expected, "重跑只留一條");
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM cron.job`)).n, before, "別的排程一條沒動");
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.stat_registry`)).n, 5877, "重跑不動參考表");
  // 跟同一批的排程錯開分鐘（自治體核對 :02、落庫掃地機 :05）
  const minutes = async (name: string) => new Set((await job(name))[0].schedule.split(" ")[0].split(","));
  const mine = await minutes("policy-jp-stat-registry-verify");
  for (const other of ["policy-jp-lg-registry-verify", "policy-jp-apply-verified"]) {
    for (const m of await minutes(other)) assert(!mine.has(m), `${other} 的第 ${m} 分跟統計核對撞了`);
  }
  await db.close();
  // 沒有 pg_cron：略過，其餘照常
  const noCron = await freshDb({ data: false });
  assertEquals((await one<{ x: string | null }>(noCron, `SELECT to_regnamespace('cron')::TEXT AS x`)).x, null);
  assertEquals((await one<{ x: string | null }>(noCron, `SELECT to_regprocedure('policy_jp.stat_registry_verify_pending(integer, uuid[])')::TEXT AS x`)).x !== null, true);
  await noCron.close();
});

// =============================================================================================
// h. 自我檢查（還原驗證）
// =============================================================================================
// 失敗的 migration 在 db.exec 裡是一個隱含交易（simple query）：中途丟例外整包回滾，所以同一個底庫可以重複拿來試
const baseDb = await freshDb({ reg: "-- (沒套統計核對)", data: false }); // 只有前置 migration（含自治體核對）
const regOnlyDb = await freshDb({ data: false }); // 套了 210400、沒灌資料

Deno.test("自我檢查（還原驗證）：沒開 RLS、給 anon／authenticated／PUBLIC 寫入、給 anon 執行、少收 PUBLIC 的 REVOKE，重跑都會失敗", async () => {
  const db = baseDb;
  const fails = (sql: string, msg: string) => assertRejects(() => db.exec(sql), Error, msg);
  const noRls = mutate(REG_SQL, "ALTER TABLE policy_jp.stat_registry ENABLE ROW LEVEL SECURITY;", "");
  await fails(noRls, "沒開 RLS");
  const anonWrite = mutate(REG_SQL, "GRANT SELECT ON policy_jp.stat_registry TO anon, authenticated;", "GRANT SELECT, INSERT ON policy_jp.stat_registry TO anon, authenticated;");
  await fails(anonWrite, "只能讀");
  const authUpdate = mutate(REG_SQL, "GRANT ALL ON policy_jp.stat_registry TO service_role;",
    "GRANT ALL ON policy_jp.stat_registry TO service_role;\nGRANT UPDATE ON policy_jp.stat_registry TO authenticated;");
  await fails(authUpdate, "authenticated:UPDATE");
  const publicWrite = mutate(REG_SQL, "GRANT ALL ON policy_jp.stat_registry TO service_role;",
    "GRANT ALL ON policy_jp.stat_registry TO service_role;\nGRANT DELETE ON policy_jp.stat_registry TO PUBLIC;");
  await fails(publicWrite, "PUBLIC:DELETE");
  const allThree = "policy_jp.stat_registry_tolerance(TEXT), policy_jp.stat_registry_decide(JSONB), policy_jp.stat_registry_verify_pending(INTEGER, UUID[])";
  const grant = `GRANT EXECUTE ON FUNCTION ${allThree} TO service_role;`;
  // 三支各自給 anon：自我檢查只守 verify_pending 與 decide（tolerance 是純函式，另在權限測試守）
  await fails(mutate(REG_SQL, grant, `${grant}\nGRANT EXECUTE ON FUNCTION policy_jp.stat_registry_verify_pending(INTEGER, UUID[]) TO anon;`), "不該給 anon 執行");
  await fails(mutate(REG_SQL, grant, `${grant}\nGRANT EXECUTE ON FUNCTION policy_jp.stat_registry_decide(JSONB) TO anon;`), "不該給 anon 執行");
  // 少收 PUBLIC 的 REVOKE：函式預設對 PUBLIC 可執行，anon 也就執行得動
  await fails(mutate(REG_SQL, "FROM PUBLIC, anon, authenticated;", "FROM anon, authenticated;"), "不該給 anon 執行");
  // 失敗都沒有留下東西（整包回滾），原版照常套得上去
  assertEquals((await one<{ x: string | null }>(db, `SELECT to_regclass('policy_jp.stat_registry')::TEXT AS x`)).x, null);
  await db.exec(REG_SQL);
  assertEquals((await one<{ x: string | null }>(db, `SELECT to_regclass('policy_jp.stat_registry')::TEXT AS x`)).x, "policy_jp.stat_registry");
});

Deno.test("自我檢查（還原驗證）：資料 migration 少灌一列、靜默衝突掉一列、單位不對、預期分布被改，都會失敗且不留半套；重跑冪等", async () => {
  const db = regOnlyDb;
  const count = async () => (await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.stat_registry`)).n;
  const line = DATA_SQL.split("\n").find((l) => l.startsWith("    ('010006', 'aging_rate'"))!;
  assertEquals(line, "    ('010006', 'aging_rate', 33.51657, '%'),");
  // 少一列 → 分布不對（訊息帶實際分布）
  await assertRejects(() => db.exec(mutate(DATA_SQL, `${line}\n`, "")), Error, "stat_registry 的分布不對：aging_rate 1958、area_km2 1959、population 1959");
  // 同一組（團體・項目・年）出現兩次：ON CONFLICT DO NOTHING 不會報錯，只有分布檢查抓得到
  await assertRejects(() => db.exec(mutate(DATA_SQL, line, "    ('010006', 'population', 33, '人'),")), Error, "分布不對");
  // 單位跟項目對不上：表的 CHECK 擋
  await assertRejects(() => db.exec(mutate(DATA_SQL, line, "    ('010006', 'area_km2', 33.51657, '%'),")), Error, "stat_registry_unit_matches");
  // 預期分布被改
  await assertRejects(() => db.exec(mutate(DATA_SQL, "IS DISTINCT FROM 'aging_rate 1959、area_km2 1959、population 1959'", "IS DISTINCT FROM 'aging_rate 1959、area_km2 1959、population 1958'")), Error, "分布不對");
  assertEquals(await count(), 0, "失敗的都整包回滾，沒有留下半套資料（出處也沒有）");
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.sources WHERE origin = 'import:estat_census_2025'`)).n, 0);
  // 原版：套一次、再套一次（ON CONFLICT DO NOTHING，自我檢查照樣過）
  await db.exec(DATA_SQL);
  await db.exec(DATA_SQL);
  assertEquals(await count(), 5877);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.sources WHERE origin = 'import:estat_census_2025'`)).n, 1, "出處只有一列（ON CONFLICT (url)）");
  // 重跑 210400：表不重建、資料還在
  await db.exec(REG_SQL);
  assertEquals(await count(), 5877);
});

// =============================================================================================
// i. 文字守門
// =============================================================================================
Deno.test("文字守門：這兩支只在 policy_jp 動手，不碰 public／ditrust；參考表只拿來核對，沒有寫 regional_stats 或 local_governments 的語句", () => {
  const writes = (sql: string) => new Set([...sql.matchAll(/\b(?:INSERT\s+INTO|UPDATE(?!\s+SKIP\b)|DELETE\s+FROM)\s+([\w.]+)/gi)].map((m) => m[1]));
  for (const [name, sql] of [[REG_FILE, REG_SQL], [DATA_FILE, DATA_SQL]] as const) {
    const code = sql.replace(/--[^\n]*/g, "");
    assert(!/\bpublic\./.test(code), `${name} 提到 public.`);
    assert(!/ditrust/i.test(code), `${name} 提到 ditrust`);
    for (const t of ["regional_stats", "local_governments", "elections", "edit_history"]) {
      assert(!new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+policy_jp\\.${t}\\b`, "i").test(code), `${name} 直接寫 ${t}`);
    }
    // 建的東西都在 policy_jp
    for (const m of code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|FUNCTION|VIEW|INDEX)(?:\s+IF\s+NOT\s+EXISTS)?\s+([\w.]+)/gi)) {
      assert(m[1].startsWith("policy_jp."), `${name} 建了 ${m[1]}（不在 policy_jp）`);
    }
  }
  // 寫入的對象：核對只動 contributions（狀態）；資料只灌 sources、stat_registry
  assertEquals(writes(REG_SQL.replace(/--[^\n]*/g, "")), new Set(["policy_jp.contributions"]));
  assertEquals(writes(DATA_SQL.replace(/--[^\n]*/g, "")), new Set(["policy_jp.sources", "policy_jp.stat_registry"]));
  // 落庫只經 apply_contribution（跟同儕驗證同一條路）；每支函式都固定 search_path
  assert(REG_SQL.includes("policy_jp.apply_contribution(c.id, false)"));
  const code = REG_SQL.replace(/--[^\n]*/g, "");
  assertEquals((code.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 3);
  assertEquals((code.match(/SET search_path = policy_jp, pg_temp/g) ?? []).length, 3);
});

// =============================================================================================
// j. 整條（全量）
// =============================================================================================
Deno.test("整條：1,959 團體經團體碼表機器核對進 local_governments → 5,877 筆統計一次交件 → 兩輪核對全部落庫、值一致、留 estat-auto、統計缺口只剩歳出", async () => {
  const db = await freshDb();
  // 團體：碼表裡有統計的 1,959 個（都道府県先、再依團體碼），一次交件
  await db.exec(`INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash, created_at)
    SELECT 'local_government', jsonb_build_object('lg_code', r.lg_code, 'kind', r.kind, 'pref_code', r.pref_code, 'name', r.name, 'kana', r.kana),
           ARRAY['${SOUMU}'], 'seed-agent', 'seed-ip', 'seed-lg-' || r.lg_code,
           TIMESTAMPTZ '2026-10-09 00:00:00+00' + make_interval(secs => row_number() OVER (ORDER BY (r.kind <> 'prefecture'), r.lg_code))
      FROM policy_jp.lg_code_registry r WHERE EXISTS (SELECT 1 FROM policy_jp.stat_registry s WHERE s.lg_code = r.lg_code)`);
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.lg_registry_verify_pending(5000) AS r`)).r, out({ applied: 1959 }));
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.local_governments`)).n, 1959);
  // 統計缺口（落庫前）：每件都缺四項（admin_ward 不派）
  const gapKeys = () => rows<{ n: number; keys: string }>(db,
    `SELECT count(*)::INT AS n, (SELECT string_agg(m->>'stat_key', ',' ORDER BY m->>'stat_key') FROM jsonb_array_elements(t.target->'missing') m) AS keys
       FROM policy_jp.contribution_auto_tasks_regional_stats_missing() t GROUP BY 2`);
  assertEquals(await gapKeys(), [{ n: 200, keys: "aging_rate,area_km2,budget_expenditure,population" }]);
  // 統計：參考表每一列照抄成交件（國勢調査的值原樣），一次交完
  await db.exec(`INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash, created_at)
    SELECT 'regional_stat', jsonb_build_object('lg_code', s.lg_code, 'stat_key', s.stat_key, 'year', s.year, 'value', s.value, 'unit', s.unit, 'as_of', to_char(s.as_of, 'YYYY-MM-DD')),
           ARRAY['${ESTAT}'], 'seed-agent', 'seed-ip', 'seed-stat-' || s.lg_code || s.stat_key,
           TIMESTAMPTZ '2026-10-10 00:00:00+00' + make_interval(secs => row_number() OVER (ORDER BY s.lg_code, s.stat_key))
      FROM policy_jp.stat_registry s`);
  // 一輪最多 5,000 筆：兩輪掃完
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.stat_registry_verify_pending(5000) AS r`)).r, out({ applied: 5000 }));
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.stat_registry_verify_pending(5000) AS r`)).r, out({ applied: 877 }));
  assertEquals(await runStat(db), ZERO);
  // 全部 applied、審核者 estat-auto、沒有卡著等團體的
  assertEquals(await rows(db, `SELECT status, reviewed_by, count(*)::INT AS n FROM policy_jp.contributions WHERE contribution_type = 'regional_stat' GROUP BY 1, 2`),
    [{ status: "applied", reviewed_by: "estat-auto", n: 5877 }]);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.apply_waiting`)).n, 0);
  // 正式列跟參考表逐列一致（值、單位、基準日、公開狀態）
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.regional_stats`)).n, 5877);
  assertEquals((await one<{ n: number }>(db,
    `SELECT count(*)::INT AS n FROM policy_jp.stat_registry s
       LEFT JOIN policy_jp.regional_stats r ON r.lg_code = s.lg_code AND r.stat_key = s.stat_key AND r.year = s.year
      WHERE r.id IS NULL OR r.value <> s.value OR r.unit <> s.unit OR r.as_of IS DISTINCT FROM s.as_of OR r.review_status <> 'published'`)).n, 0);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.edit_history WHERE table_name = 'regional_stats'`)).n, 5877);
  // 統計缺口（落庫後）：人口・面積・高齢化率都收完，每件只剩歳出
  assertEquals(await gapKeys(), [{ n: 200, keys: "budget_expenditure" }]);
  // 公開讀（anon）：看得到全部 published 的統計
  assertEquals((await asRole<{ n: number }>(db, "anon", `SELECT count(*)::INT AS n FROM policy_jp.regional_stats`))[0].n, 5877);
  await db.close();
});
