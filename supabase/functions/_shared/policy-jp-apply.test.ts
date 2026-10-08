/**
 * 日本站落庫與兩支新缺口臂的行為與守門測試
 * （migration 20261009210000_policy_jp_apply.sql＋20261009210100_policy_jp_gap_arms.sql；policy-jp #41 ④、主線 #503）。
 *
 * 只要 --allow-read。PGlite 上套 #479 的空 schema、tables migration、130000（派工）、130100（election_discovery）、130200（總務省 3,571 列）、
 * 這兩支；資料庫裡沒有任何正見（public）物件。
 *
 *   a. 文字守門：election_discovery 臂＝130100 的版本剛好多一段排除條件、臂名清單與總表＝130100 的版本多兩個名字／兩行分支（機械替換比對＋還原驗證）；
 *      兩支 migration 定義的函式都登記（新加函式不登記就紅）；沒有 public. 引用
 *   b. TS／SQL 對齊：檢查碼與縣市碼（全部 1,900 多個真團體碼＋變造的）、出處等級、單位、kind／選舉種類列舉、重試規則、落庫型別、共識門檻
 *   c. regional_stats 表：CHECK、RLS、anon 只讀 published
 *   d. 兩支新臂：local_government_missing（都道府県先、cap、補上就收回）、regional_stats_missing（缺哪幾項、min_year、cap、行政區不派）
 *   e. 落庫：四種型別各走一整圈（缺口 → 交件 → 3 票 → apply → 正式表＋sources＋source_refs＋edit_history＋狀態 applied → 缺口收回）；
 *      冪等（一樣的當成功）、衝突（不覆蓋、退件）、內容不合格（退件）、失敗（apply_failed → 重試 → 3 次退件，整筆回滾）、排程掃地機、權限
 *   f. 等團體到了再落（#503 c）：外鍵指到的團體不在 → waiting（貢獻維持 verified，不繞過外鍵），團體進來後排程自動落
 *   g. #503 a：cap 套在可派的缺口上——前 50 件各交 no_change 並通過驗證，第 51～100 名遞補；冷卻到期原任務重開；修正前的行為重現；
 *      task_unavailable 與 refresh_dispatch_blocked 逐情境對照
 *   h. 排程與自我檢查（還原驗證）
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText } from "./arms-pglite.ts";
import { rejectFloor, requiredAgree, systemVoteEligible } from "./jp/consensus.ts";
import { isPrefectureCode, lgCodeValid, lgPrefCode } from "./jp/lg-code.ts";
import { jpSourceKind } from "./jp/source-kind.ts";
import { JP_ELECTION_REASONS, JP_ELECTION_TYPES, JP_LG_KINDS, JP_STAT_KEYS, JP_STAT_UNITS } from "./jp/contribution-schema.ts";
import { JP_APPLY_TYPES } from "./jp/apply-contribution.ts";
import { APPLY_MAX_RETRIES, APPLY_RETRY_DELAY_MINUTES } from "./consensus.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const SCHEMA_SQL = await read("20261008195000_policy_jp_schema.sql");
const TABLES_SQL = await read("20261009000000_policy_jp_tables.sql");
const MIG090 = await read("20261009130000_policy_jp_dispatch.sql");
const MIG091 = await read("20261009130100_policy_jp_election_discovery.sql");
const MIG092 = await read("20261009130200_policy_jp_term_expirations_r08.sql");
const APPLY_FILE = "20261009210000_policy_jp_apply.sql";
const ARMS_FILE = "20261009210100_policy_jp_gap_arms.sql";
const APPLY_SQL = await read(APPLY_FILE);
const ARMS_SQL = await read(ARMS_FILE);

const SOUMU_CODE = "https://www.soumu.go.jp/denshijiti/code.html";
const ESTAT = "https://www.e-stat.go.jp/regional-statistics/ssdsview/municipality";
const ICHI_ELECTION_URL = "https://www.city.ichinomiya.aichi.jp/senkyo/";

function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 70)}`);
  return sql.replace(from, () => to);
}

const ROLES = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;
async function freshDb(opts: { data?: boolean; upTo?: "base" | "apply" | "arms"; pre?: string; apply?: string; arms?: string } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  if (opts.pre) await db.exec(opts.pre);
  await db.exec(SCHEMA_SQL);
  await db.exec(TABLES_SQL);
  await db.exec(MIG090);
  await db.exec(MIG091);
  if (opts.data !== false) await db.exec(MIG092);
  if (opts.upTo === "base") return db;
  await db.exec(opts.apply ?? APPLY_SQL);
  if (opts.upTo === "apply") return db;
  await db.exec(opts.arms ?? ARMS_SQL);
  return db;
}

const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rows = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const count = async (db: PGlite, sql: string, params: unknown[] = []) => (await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM (${sql}) q`, params)).n;
async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}
const clock = (db: PGlite, day: string) => db.exec(`SET app.activity_today = '${day}'`);
const seed = (db: PGlite) => db.query(`SELECT policy_jp.seed_auto_task_queue()`);
const health = async (db: PGlite) =>
  (await db.query<{ check_name: string; subject: string }>(`SELECT check_name, subject FROM policy_jp.activity_health WHERE check_name NOT IN ('clock_overridden', 'queue_clock_overridden') ORDER BY 1, 2`)).rows;
const dispatched = async (db: PGlite, type: string): Promise<string[]> =>
  (await db.query<{ task_id: string }>(`SELECT task_id FROM policy_jp.task_dispatches WHERE task_id LIKE 'auto:${type}:%' ORDER BY task_id`)).rows.map((r) => r.task_id);

// ---------------------------------------------------------------------------------------------
// 固定的團體（代碼都是真的、檢查碼正確）
// ---------------------------------------------------------------------------------------------
type Lg = { lg_code: string; kind: string; pref_code: string; name: string; kana: string };
const AICHI: Lg = { lg_code: "230006", kind: "prefecture", pref_code: "230006", name: "愛知県", kana: "あいちけん" };
const NAGANO: Lg = { lg_code: "200000", kind: "prefecture", pref_code: "200000", name: "長野県", kana: "ながのけん" };
const ICHI: Lg = { lg_code: "232033", kind: "city", pref_code: "230006", name: "一宮市", kana: "いちのみやし" };
const KOMORO: Lg = { lg_code: "202088", kind: "city", pref_code: "200000", name: "小諸市", kana: "こもろし" };
const CHIKUSA: Lg = { lg_code: "231011", kind: "admin_ward", pref_code: "230006", name: "千種区", kana: "ちくさく" };

let seq = 0;
async function addContribution(db: PGlite, type: string, payload: Record<string, unknown>, urls: string[], o: { task?: string | null; agent?: string } = {}): Promise<string> {
  const n = ++seq;
  return (await one<{ id: string }>(db,
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash)
     VALUES ($1, $2::JSONB, $3, $4, $5, $6, $7) RETURNING id`,
    [type, JSON.stringify(payload), urls, o.task ?? null, o.agent ?? `author-${n}`, `author-ip-${n}`, `h-${n}`])).id;
}
/** 同意票（每張不同代號、不同網段）；no_change 要 2 張、其他三種資料型要 3 張才 verified */
async function vote(db: PGlite, id: string, n: number, verdict = "agree") {
  for (let i = 0; i < n; i++) {
    const k = ++seq;
    await db.query(`INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, agent_name, verifier_ip_hash) VALUES ($1, $2, $3, $4)`, [id, verdict, `voter-${k}`, `voter-ip-${k}`]);
  }
}
const status = async (db: PGlite, id: string) => (await one<{ status: string }>(db, `SELECT status FROM policy_jp.contributions WHERE id = $1`, [id])).status;
/** 交件＋3 票 → verified（不落庫） */
async function verified(db: PGlite, type: string, payload: Record<string, unknown>, urls: string[], o: { task?: string | null; votes?: number } = {}): Promise<string> {
  const id = await addContribution(db, type, payload, urls, o);
  await vote(db, id, o.votes ?? (type === "no_change" ? 2 : 3));
  assertEquals(await status(db, id), "verified");
  return id;
}
type ApplyOut = { status: string; outcome?: string; message?: string; reason?: string; table_name?: string; record_id?: string; retry_count?: number; contribution_status?: string };
const applyCall = async (db: PGlite, id: string, retry = false): Promise<ApplyOut> =>
  (await one<{ r: ApplyOut }>(db, `SELECT policy_jp.apply_contribution($1, $2) AS r`, [id, retry])).r;
const contribution = (db: PGlite, id: string) => one<Record<string, unknown>>(db, `SELECT * FROM policy_jp.contributions WHERE id = $1`, [id]);

async function insertLg(db: PGlite, lg: Lg) {
  await db.query(`INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [lg.lg_code, lg.kind, lg.pref_code, lg.name, lg.kana, lg.lg_code]);
}
/** 團體走完整條路進庫（交件→3 票→apply） */
async function applyLg(db: PGlite, lg: Lg, task: string | null = `auto:local_government_missing:${lg.lg_code}`): Promise<string> {
  const id = await verified(db, "local_government", lg, [SOUMU_CODE], { task });
  assertEquals((await applyCall(db, id)).status, "applied");
  return id;
}

// ---------------------------------------------------------------------------------------------
// 總務省 3,571 列（跟 policy-jp-election-discovery.test.ts 同一套解析）
// ---------------------------------------------------------------------------------------------
type Term = { lg: string; pref: string; name: string; kind: "head" | "assembly"; etype: string; end: string };
const ROW_RE = /^\s+\('(\d{6})', '([^']+)', '([^']+)', '(head|assembly)', '(\w+)', '(\d{4}-\d{2}-\d{2})', (NULL|'[^']*')\),?$/;
const TERMS: Term[] = MIG092.split("\n").flatMap((line) => {
  const m = ROW_RE.exec(line);
  return m ? [{ lg: m[1], pref: m[2], name: m[3], kind: m[4] as Term["kind"], etype: m[5], end: m[6] }] : [];
});
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const byTerm = (a: Term, b: Term) => (a.end < b.end ? -1 : a.end > b.end ? 1 : a.lg < b.lg ? -1 : a.lg > b.lg ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
const edTaskId = (t: Term) => `auto:election_discovery:${t.end}:${t.lg}:${t.kind}`;
/** election_discovery 的缺口（預設參數 scope_from 2027-01-01、lead 180、含不確定、cap 50），排除 exclude 內的任務；沒有任何選舉 */
function expectedEd(today: string, o: { cap?: number; exclude?: Set<string> } = {}): Term[] {
  return TERMS
    .filter((t) => addDays(t.end, -1) >= "2027-01-01" && addDays(t.end, -180) <= today && addDays(t.end, 60) >= today && !(o.exclude?.has(edTaskId(t)) ?? false))
    .sort(byTerm)
    .slice(0, o.cap ?? 50);
}
const ALL_LG = [...new Map(TERMS.map((t) => [t.lg, t])).values()].map((t) => ({ lg: t.lg, pref: t.pref, name: t.name })).sort((a, b) => (a.lg < b.lg ? -1 : 1));

// =============================================================================================
// a. 文字守門
// =============================================================================================
const fnLines = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

Deno.test("文字守門：election_discovery 臂＝130100 的版本剛好多一行排除條件（task_unavailable），其餘一字不改（機械替換比對＋還原驗證）", () => {
  const FN = "policy_jp.contribution_auto_tasks_election_discovery";
  const before = fnLines(fnText(MIG091, FN));
  const after = fnLines(fnText(ARMS_SQL, FN));
  const ANCHOR = "            AND e.election_date BETWEEN t.term_end - 120 AND t.term_end + 60)\n";
  const ADDED = "       AND NOT policy_jp.task_unavailable('auto:election_discovery:' || t.term_end || ':' || t.lg_code || ':' || t.office_kind)\n";
  const expected = mutate(before, ANCHOR, ANCHOR + ADDED);
  assertEquals(after, expected, "210100 的臂除了多那一行（和它上面的註解），其餘必須一字不改");
  const a = before.split("\n"), b = after.split("\n");
  assertEquals(b.length, a.length + 1);
  assertEquals(b.filter((l) => !a.includes(l)), [ADDED.trimEnd()]);
  assertEquals(a.filter((l) => !b.includes(l)), []);
  // 排除條件在 ORDER BY／LIMIT 之前（cap 才是可派的前 N 件）
  const body = fnText(ARMS_SQL, FN);
  assert(body.indexOf("task_unavailable") > 0 && body.indexOf("task_unavailable") < body.indexOf("ORDER BY t.term_end"), "排除條件要在 ORDER BY 之前");
  assert(body.indexOf("ORDER BY t.term_end") < body.indexOf("LIMIT (SELECT cap FROM p)"));
  // 還原驗證
  assertNotEquals(after.replace("AS $$", "AS $$ "), expected);
  assertNotEquals(after.replace(ADDED, ""), expected);
  assertNotEquals(after.replace("AND NOT policy_jp.task_unavailable(", "AND policy_jp.task_unavailable("), expected);
  assertNotEquals(after.replace("t.office_kind)\n     ORDER", "t.lg_code)\n     ORDER"), expected);
  assertNotEquals(mutate(before.replace("AS $$", "AS $$ "), ANCHOR, ANCHOR + ADDED), after, "130100 那邊改一個字元，期望值跟著變");
});

Deno.test("文字守門：activity_arm_names＝130100 的清單多兩個名字；總表＝130100 的版本多兩行 UNION 分支（還原驗證）", () => {
  const NAMES = "policy_jp.activity_arm_names";
  const nb = fnText(MIG091, NAMES), na = fnText(ARMS_SQL, NAMES);
  const nExpected = mutate(nb, "    'election_discovery'\n  ]::TEXT[]", "    'election_discovery',\n    'local_government_missing',\n    'regional_stats_missing'\n  ]::TEXT[]");
  assertEquals(na, nExpected);
  assertNotEquals(na.replace("'regional_stats_missing'", "'regional_stat_missing'"), nExpected);
  assertNotEquals(na.replace("'local_government_missing',", ""), nExpected);

  const ARMS = "policy_jp.contribution_auto_tasks_arms";
  const before = fnText(MIG091, ARMS), after = fnText(ARMS_SQL, ARMS);
  const LAST = "  UNION ALL SELECT 'election_discovery' AS arm, t.* FROM policy_jp.contribution_auto_tasks_election_discovery() t\n";
  const ADD1 = "  UNION ALL SELECT 'local_government_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_local_government_missing() t\n";
  const ADD2 = "  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_regional_stats_missing() t\n";
  const expected = mutate(before, LAST, LAST + ADD1 + ADD2);
  assertEquals(after, expected, "總表除了多這兩行分支，其餘必須一字不改");
  const a = before.split("\n"), b = after.split("\n");
  assertEquals(b.length, a.length + 2);
  assertEquals(b.filter((l) => !a.includes(l)), [ADD1.trimEnd(), ADD2.trimEnd()]);
  assertEquals(a.filter((l) => !b.includes(l)), []);
  assertNotEquals(after.replace(ADD2, ""), expected);
  assertNotEquals(after.replace("UNION ALL SELECT 'regional_stats_missing'", "UNION SELECT 'regional_stats_missing'"), expected);
  assertNotEquals(after.replace("'local_government_missing' AS arm", "'local_government_gap' AS arm"), expected);
  assertNotEquals(after.replace("AS $$", "AS $$ "), expected);
});

Deno.test("文字守門（走樣 #498 慣例）：兩支 migration 定義的函式都登記；都不是正見的複本；沒有 public. 引用；程式不產生選舉／團體資料", () => {
  const defined = (sql: string) => [...sql.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]).sort();
  // 日本站自己的（正見沒有對應物）：新增函式不登記就紅
  const APPLY_FNS = [
    "lg_pref_code", "local_government_slug", "regional_stat_unit", "apply_max_retries", "apply_retry_delay_minutes", "apply_types", "source_kind_for_url", "election_default_name",
    "source_write", "apply_blocker", "apply_local_government", "apply_regional_stat", "apply_election", "apply_no_change", "apply_contribution", "apply_verified_pending",
  ].sort();
  const ARMS_FNS = [
    "task_unavailable", "regional_stat_label", "contribution_auto_tasks_election_discovery", "contribution_auto_tasks_local_government_missing",
    "contribution_auto_tasks_regional_stats_missing", "activity_arm_names", "contribution_auto_tasks_arms",
  ].sort();
  assertEquals(defined(APPLY_SQL), APPLY_FNS);
  assertEquals(defined(ARMS_SQL), ARMS_FNS);
  // 130000 的複本函式一支都沒有被這兩支重新定義（走樣守門 policy-jp-dispatch-drift.test.ts 只比對 130000／130100 的本體；重新定義＝逃過比對）。非複本的三支除外
  const in130000 = defined(MIG090);
  const reDefined = [...defined(APPLY_SQL), ...defined(ARMS_SQL)].filter((n) => in130000.includes(n));
  assertEquals(reDefined.sort(), ["activity_arm_names", "contribution_auto_tasks_arms"], "只有非複本（臂名清單、總表）可以在後面的 migration 重新定義");

  for (const [name, sql] of [[APPLY_FILE, APPLY_SQL], [ARMS_FILE, ARMS_SQL]] as const) {
    const code = sql.replace(/--[^\n]*/g, "");
    // 自我檢查段會「提到」public. 字樣：只看自我檢查之前的部分
    const body = code.slice(0, code.indexOf("DO $$\nDECLARE bad TEXT;") > 0 ? code.lastIndexOf("DO $$\nDECLARE bad TEXT;") : code.length);
    assert(!/\bpublic\./.test(body), `${name} 不能引用 public.`);
    assert(!/search_path\s*=\s*public/i.test(code), `${name} 不能有 search_path = public`);
  }
  // 臂本體唯讀；整個臂 migration 不寫 elections／local_governments／regional_stats
  const armsCode = ARMS_SQL.replace(/--[^\n]*/g, "");
  assert(!/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+policy_jp\.(elections|local_governments|regional_stats|election_districts|election_milestones|task_checks|contributions)\b/i.test(armsCode));
  for (const arm of ["contribution_auto_tasks_local_government_missing", "contribution_auto_tasks_regional_stats_missing", "contribution_auto_tasks_election_discovery", "task_unavailable"]) {
    const t = fnText(ARMS_SQL, `policy_jp.${arm}`).replace(/--[^\n]*/g, "");
    assert(/LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp/.test(t), `${arm} 要是 LANGUAGE sql STABLE 並釘 search_path`);
    assert(!/\b(INSERT|UPDATE|DELETE)\b/.test(t), `${arm} 不能寫任何東西`);
  }
  // 落庫函式：plpgsql／sql 都釘 search_path；沒有 SECURITY DEFINER（只有 service_role 能執行，用呼叫者的權限寫，多一層防護）
  for (const fn of APPLY_FNS) {
    const t = fnText(APPLY_SQL, `policy_jp.${fn}`);
    assert(t.includes("SET search_path = policy_jp, pg_temp") || ["apply_max_retries", "apply_retry_delay_minutes", "apply_types"].includes(fn), `${fn} 沒釘 search_path`);
    assert(!/SECURITY DEFINER/.test(t), `${fn} 不該是 SECURITY DEFINER`);
  }
});

Deno.test("套用：兩支 migration 各套兩次都成功；臂名清單五個、每個都有規則、健康檢查是空的", async () => {
  const db = await freshDb();
  await db.exec(APPLY_SQL);
  await db.exec(ARMS_SQL);
  assertEquals((await one<{ x: string[] }>(db, `SELECT policy_jp.activity_arm_names() AS x`)).x,
    ["manual_visitor", "manual_open", "election_discovery", "local_government_missing", "regional_stats_missing"]);
  const rules = await rows<{ activity: string; window_kind: string; params: Record<string, unknown>; priority: number | null }>(
    db, `SELECT activity, window_kind, params, priority FROM policy_jp.activity_rules ORDER BY activity`);
  assertEquals(rules.map((r) => r.activity), ["election_discovery", "local_government_missing", "manual_open", "manual_visitor", "priority:manual_visitor", "regional_stats_missing"], "規則只種一條，重跑不重複");
  assertEquals(rules.find((r) => r.activity === "local_government_missing")!.params, { cap: 200 });
  assertEquals(rules.find((r) => r.activity === "regional_stats_missing")!.params,
    { cap: 200, min_year: { population: 2020, area_km2: 2020, aging_rate: 2020, budget_expenditure: 2023 }, exclude_kinds: ["admin_ward"] });
  assertEquals(rules.filter((r) => r.activity.endsWith("_missing")).map((r) => [r.window_kind, r.priority]), [["always", null], ["always", null]]);
  assertEquals(await health(db), []);
  // 約束只剩日本站命名的那一條，六種型別
  const cons = await rows<{ conname: string }>(db, `SELECT conname FROM pg_constraint WHERE conrelid = 'policy_jp.contributions'::regclass AND contype = 'c' AND conname LIKE '%type_check'`);
  assertEquals(cons.map((r) => r.conname), ["policy_jp_contributions_type_check"]);
  await db.close();
});

// =============================================================================================
// b. TS／SQL 對齊
// =============================================================================================
Deno.test("對齊：檢查碼與縣市碼——全部真團體碼（1,787 個）＋逐一變造的檢查碼＋亂格式，TS 與 SQL 結論相同", async () => {
  const db = await freshDb({ upTo: "apply", data: false });
  const real = ALL_LG.map((x) => x.lg);
  assert(real.length > 1700, `應該抓到 1,700 多個真團體碼（抓到 ${real.length}）`);
  const bent = real.map((c) => c.slice(0, 5) + String((Number(c[5]) + 1) % 10));
  const weird = ["", "12345", "1234567", "ABCDEF", "01000x", "０１０００６", " 010006"];
  const all = [...real, ...bent, ...weird];
  const got = await rows<{ c: string; v: boolean | null; p: string | null }>(db,
    `SELECT c, policy_jp.lg_code_valid(c) AS v, policy_jp.lg_pref_code(c) AS p FROM unnest($1::TEXT[]) AS c`, [all]);
  assertEquals(got.length, all.length);
  for (const r of got) {
    assertEquals(lgCodeValid(r.c), r.v === true, `lg_code_valid(${JSON.stringify(r.c)}) TS≠SQL`);
    assertEquals(lgPrefCode(r.c), r.p, `lg_pref_code(${JSON.stringify(r.c)}) TS≠SQL`);
  }
  assert(real.every((c) => lgCodeValid(c)), "真團體碼的檢查碼都對");
  assert(bent.every((c) => !lgCodeValid(c)), "變造過的檢查碼都不對");
  // 縣市碼本身是有效的團體碼，而且是都道府県（47 個）
  const prefs = new Set(real.filter(isPrefectureCode));
  assertEquals(prefs.size, 47);
  for (const c of real) {
    const p = lgPrefCode(c)!;
    assert(lgCodeValid(p) && isPrefectureCode(p), `${c} 的縣市碼 ${p}`);
    if (isPrefectureCode(c)) assertEquals(p, c, "都道府県的縣市碼是自己");
  }
  assertEquals(await count(db, `SELECT 1 FROM unnest($1::TEXT[]) AS c WHERE policy_jp.lg_code_valid(policy_jp.lg_pref_code(c)) IS NOT TRUE`, [real]), 0);
  await db.close();
});

Deno.test("對齊：出處等級（source_kind_for_url／jpSourceKind）、單位、kind 與選舉種類列舉、重試規則、落庫型別、共識門檻", async () => {
  const db = await freshDb({ upTo: "apply", data: false });
  const urls = [
    "https://www.soumu.go.jp/denshijiti/code.html", "https://www.e-stat.go.jp/regional-statistics/ssdsview/municipality", "https://dashboard.e-stat.go.jp/", "https://www.stat.go.jp/data/kokusei/2020/",
    "https://www.pref.aichi.lg.jp/soshiki/senkyo/", "https://www.city.ichinomiya.aichi.jp/senkyo/", "https://www.town.shinhidaka.hokkaido.jp/", "https://www.vill.yamanakako.lg.jp/",
    "https://www.pref.aichi.jp/", "https://city.nagoya.jp/", "https://www.metro.tokyo.lg.jp/", "https://www.city.shibuya.tokyo.jp/senkyo/", "https://www.kantei.go.jp/",
    "https://www.asahi.com/articles/x.html", "https://example.com/", "https://evil-stat.go.jp.example.com/", "https://x.example.jp/city.aichi.jp", "https://twitter.com/city_ichinomiya",
    "https://notgo.jp/", "https://stat.example.co.jp/", "http://WWW.SOUMU.GO.JP/a", "HTTPS://WWW.E-STAT.GO.JP/a", "ftp://www.soumu.go.jp/", "not a url", "",
    "https://user@www.soumu.go.jp/a", "https://www.soumu.go.jp:8443/a", "https://www.soumu.go.jp?x=1",
  ];
  for (const type of [null, "local_government", "regional_stat", "election"]) {
    const got = await rows<{ u: string; k: string }>(db, `SELECT u, policy_jp.source_kind_for_url(u, $2) AS k FROM unnest($1::TEXT[]) AS u`, [urls, type]);
    for (const r of got) assertEquals(jpSourceKind(r.u, type ?? undefined), r.k, `source_kind_for_url(${JSON.stringify(r.u)}, ${type}) TS≠SQL`);
  }
  // 抽樣確認結論本身（不只是兩邊一樣）
  assertEquals(jpSourceKind("https://www.soumu.go.jp/denshijiti/code.html", "local_government"), "official");
  assertEquals(jpSourceKind("https://www.soumu.go.jp/denshijiti/code.html", "regional_stat"), "statistics");
  assertEquals(jpSourceKind("https://www.e-stat.go.jp/x"), "statistics");
  assertEquals(jpSourceKind("https://www.city.ichinomiya.aichi.jp/senkyo/"), "official");
  assertEquals(jpSourceKind("https://www.asahi.com/a"), "other");
  assertEquals(jpSourceKind("https://evil-stat.go.jp.example.com/"), "other");

  // 單位與 stat_key
  for (const k of JP_STAT_KEYS) assertEquals((await one<{ u: string }>(db, `SELECT policy_jp.regional_stat_unit($1) AS u`, [k])).u, JP_STAT_UNITS[k]);
  assertEquals((await one<{ u: string | null }>(db, `SELECT policy_jp.regional_stat_unit('gdp') AS u`)).u, null);
  // 欄位上的 CHECK 自動命名為 <表>_<欄>_check
  const checkOf = async (table: string, col: string) => (await rows<{ d: string }>(db,
    `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'policy_jp.${table}'::regclass AND contype = 'c' AND conname = '${table}_${col}_check'`)).map((r) => r.d).join(" ");
  const quoted = (d: string) => [...d.matchAll(/'([a-z_0-9]+)'::text/g)].map((m) => m[1]);
  assertEquals(new Set(quoted(await checkOf("regional_stats", "stat_key"))), new Set(JP_STAT_KEYS), "regional_stats.stat_key 的 CHECK 與 TS 清單一致");
  assertEquals(new Set(quoted(await checkOf("local_governments", "kind"))), new Set(JP_LG_KINDS), "local_governments.kind 的 CHECK 與 TS 清單一致");
  assertEquals(new Set(quoted(await checkOf("elections", "election_type"))), new Set(JP_ELECTION_TYPES), "elections.election_type 的 CHECK 與 TS 清單一致");
  assertEquals(new Set(quoted(await checkOf("elections", "election_reason"))), new Set(JP_ELECTION_REASONS), "elections.election_reason 的 CHECK 與 TS 清單一致");

  // 重試規則、落庫型別
  assertEquals((await one<{ a: number; b: number }>(db, `SELECT policy_jp.apply_max_retries() AS a, policy_jp.apply_retry_delay_minutes() AS b`)), { a: APPLY_MAX_RETRIES, b: APPLY_RETRY_DELAY_MINUTES });
  assertEquals((await one<{ t: string[] }>(db, `SELECT policy_jp.apply_types() AS t`)).t, [...JP_APPLY_TYPES]);

  // 共識門檻：六種型別 SQL 與 TS 一致（三個新型別目標 3、退件 −3、不拿系統票、不要兩個網段）
  const sql = async (q: string) => Object.values(await one<Record<string, unknown>>(db, q))[0];
  for (const t of ["no_change", "task_suggestion", "correction", "election", "local_government", "regional_stat"]) {
    assertEquals(await sql(`SELECT policy_jp.contribution_required_agree('${t}', '{}', ARRAY[]::TEXT[]) AS x`), requiredAgree(t), `required_agree(${t})`);
    assertEquals(await sql(`SELECT policy_jp.contribution_reject_floor('${t}') AS x`), rejectFloor(t), `reject_floor(${t})`);
    assertEquals(await sql(`SELECT policy_jp.system_vote_eligible('${t}') AS x`), systemVoteEligible(t), `system_vote_eligible(${t})`);
  }
  for (const t of ["election", "local_government", "regional_stat"]) {
    assertEquals([requiredAgree(t), rejectFloor(t)], [3, 3]);
    assertEquals(await sql(`SELECT policy_jp.contribution_needs_two_ips('${t}', '{}') AS x`), false);
    assertEquals(systemVoteEligible(t), false);
  }
  await db.close();
});

Deno.test("slug：市區町村＝團體碼；47 都道府県＝固定的羅馬字（跟 policy-jp src/lib/prefectures.ts 同一份，列進來網址不變）", async () => {
  const db = await freshDb({ upTo: "apply", data: false });
  // policy-jp src/lib/prefectures.ts 的 NAMES 第三欄（JIS 01〜47 的順序）。畫面在資料庫還沒有那一列時用它當網址，
  // 列進來後改讀 local_governments.slug——兩邊不同，網址就會在落庫那一刻變掉。那邊改了這裡要一起改
  const PREF_SLUGS = [
    "hokkaido", "aomori", "iwate", "miyagi", "akita", "yamagata", "fukushima", "ibaraki", "tochigi", "gunma", "saitama",
    "chiba", "tokyo", "kanagawa", "niigata", "toyama", "ishikawa", "fukui", "yamanashi", "nagano", "gifu", "shizuoka",
    "aichi", "mie", "shiga", "kyoto", "osaka", "hyogo", "nara", "wakayama", "tottori", "shimane", "okayama", "hiroshima",
    "yamaguchi", "tokushima", "kagawa", "ehime", "kochi", "fukuoka", "saga", "nagasaki", "kumamoto", "oita", "miyazaki",
    "kagoshima", "okinawa",
  ];
  const got = await rows<{ slug: string }>(db,
    `SELECT policy_jp.local_government_slug(policy_jp.lg_pref_code(lpad(j::TEXT, 2, '0') || '0000')) AS slug FROM generate_series(1, 47) AS j ORDER BY j`);
  assertEquals(got.map((r) => r.slug), PREF_SLUGS);
  assertEquals(new Set(PREF_SLUGS).size, 47);
  for (const [code, want] of [["011002", "011002"], ["131016", "131016"], ["232033", "232033"], ["130001", "tokyo"], ["470007", "okinawa"], ["480006", "480006"], ["000000", "000000"]]) {
    assertEquals((await one<{ s: string }>(db, `SELECT policy_jp.local_government_slug($1) AS s`, [code])).s, want, `local_government_slug(${code})`);
  }
  await db.close();
});

// =============================================================================================
// c. regional_stats 表
// =============================================================================================
Deno.test("regional_stats：CHECK（單位對應、值的範圍、重複、年份）與 RLS（anon 只讀 published、不能寫）", async () => {
  const db = await freshDb({ upTo: "apply", data: false });
  await insertLg(db, AICHI); await insertLg(db, ICHI);
  const sid = (await one<{ id: number }>(db, `INSERT INTO policy_jp.sources (url, origin) VALUES ($1, 'test') RETURNING id::INT AS id`, [ESTAT])).id;
  const ins = (o: Partial<Record<string, unknown>> = {}) => {
    const r = { lg: "232033", key: "population", year: 2020, value: 386678, unit: "人", as_of: "2020-10-01", status: "published", ...o };
    return db.query(`INSERT INTO policy_jp.regional_stats (lg_code, stat_key, year, value, unit, as_of, source_id, review_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.lg, r.key, r.year, r.value, r.unit, r.as_of, sid, r.status]);
  };
  await ins();
  await ins({ key: "population", year: 2015, status: "pending", value: 380000 });
  await ins({ key: "area_km2", value: 113.82, unit: "km2" });
  await ins({ key: "budget_expenditure", year: 2023, value: 187654321, unit: "千円", as_of: null });
  await ins({ key: "aging_rate", value: 28.6, unit: "%" });
  await assertRejects(() => ins(), Error, "regional_stats_unique");
  await assertRejects(() => ins({ key: "gdp" }), Error, "stat_key");
  await assertRejects(() => ins({ lg: "232034", year: 2010 }), Error, "lg_code");              // 檢查碼不對
  await assertRejects(() => ins({ lg: "131130", year: 2010 }), Error, "foreign key");          // 團體不在表裡（外鍵）
  await assertRejects(() => ins({ key: "budget_expenditure", year: 2022, unit: "円", value: 1 }), Error, "regional_stats_unit_matches");
  await assertRejects(() => ins({ key: "aging_rate", year: 2010, value: 100.5, unit: "%" }), Error, "regional_stats_value_range");
  await assertRejects(() => ins({ key: "area_km2", year: 2010, value: 0, unit: "km2" }), Error, "regional_stats_value_range");
  await assertRejects(() => ins({ year: 2010, value: 1.5 }), Error, "regional_stats_value_range");  // 人口要整數
  await assertRejects(() => ins({ year: 2010, value: -1 }), Error, "regional_stats_value_range");
  await assertRejects(() => ins({ year: 1850 }), Error, "year");
  await assertRejects(() => ins({ year: 2011, as_of: "0000-01-01" }), Error);                   // PostgreSQL 不收 0000 年
  await assertRejects(() => ins({ year: 2011, as_of: "1900-01-01" }), Error, "as_of");
  await assertRejects(() => ins({ year: 2012, status: "live" }), Error, "review_status");
  assert((await one<{ r: boolean }>(db, `SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'policy_jp.regional_stats'::regclass`)).r);
  for (const role of ["anon", "authenticated"]) {
    const seen = await asRole<{ year: number; stat_key: string }>(db, role, `SELECT stat_key, year FROM policy_jp.regional_stats ORDER BY 1, 2`);
    assertEquals(seen.length, 4, `${role} 只看得到 published（pending 的 2015 看不到）`);
    assert(!seen.some((r) => r.year === 2015));
    await assertRejects(() => asRole(db, role, `DELETE FROM policy_jp.regional_stats`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `UPDATE policy_jp.regional_stats SET value = 1`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `INSERT INTO policy_jp.regional_stats (lg_code, stat_key, year, value, unit, source_id) VALUES ('232033','population',2000,1,'人',${sid})`), Error, "permission denied");
    // 團體表照舊公開讀
    assertEquals((await asRole<{ n: number }>(db, role, `SELECT count(*)::INT AS n FROM policy_jp.local_governments`))[0].n, 2);
    // 落庫相關的內部函式與視圖一律不給
    await assertRejects(() => asRole(db, role, `SELECT policy_jp.apply_contribution(gen_random_uuid())`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT policy_jp.apply_verified_pending()`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT * FROM policy_jp.apply_waiting`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT policy_jp.source_write(NULL, NULL, ARRAY['https://x.jp/'], 'election')`), Error, "permission denied");
  }
  assertEquals((await asRole<{ n: number }>(db, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.regional_stats`))[0].n, 5);
  // touch 觸發器
  await db.query(`UPDATE policy_jp.regional_stats SET created_at = now() - interval '1 day', updated_at = now() - interval '1 day' WHERE stat_key = 'aging_rate'`);
  await db.query(`UPDATE policy_jp.regional_stats SET value = 29.0 WHERE stat_key = 'aging_rate'`);
  assert((await one<{ ok: boolean }>(db, `SELECT updated_at > created_at + interval '1 hour' AS ok FROM policy_jp.regional_stats WHERE stat_key = 'aging_rate'`)).ok);
  await db.close();
});

// =============================================================================================
// d. 兩支新臂
// =============================================================================================
Deno.test("local_government_missing：term_expirations 裡有、local_governments 沒有的團體；47 都道府県先、再依團體碼；cap 200；補上就收回、遞補", async () => {
  const db = await freshDb();
  await clock(db, "2026-10-09");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.local_governments`), 0);
  const expectedIds = (excl: Set<string> = new Set()) => {
    const pref = ALL_LG.filter((x) => isPrefectureCode(x.lg) && !excl.has(x.lg));
    const rest = ALL_LG.filter((x) => !isPrefectureCode(x.lg) && !excl.has(x.lg));
    return [...pref, ...rest].slice(0, 200).map((x) => `auto:local_government_missing:${x.lg}`);
  };
  assertEquals(ALL_LG.filter((x) => isPrefectureCode(x.lg)).length, 47, "資料裡 47 都道府県都在");
  await seed(db);
  const got = await dispatched(db, "local_government_missing");
  assertEquals(got.length, 200);
  assertEquals([...got].sort(), [...expectedIds()].sort(), "派出的 200 件＝47 都道府県＋團體碼最小的 153 個市区町村");

  const rowsOf = await rows<{ task_id: string; task_type: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[]; reward: number; region: string; priority: number; opened_by: Record<string, unknown> }>(
    db, `SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region, priority, opened_by FROM policy_jp.task_dispatches WHERE task_id LIKE 'auto:local_government_missing:%' ORDER BY task_id`);
  for (const r of rowsOf) {
    assertEquals(r.task_type, "local_government_missing");
    assertEquals([r.reward, r.priority, r.opened_by.arm], [1, 2, "local_government_missing"], "沒有選舉＝預設層");
    assert(r.what_we_need.includes("https://www.soumu.go.jp/denshijiti/code.html"));
    assert(r.what_we_need.includes("contribution_type=local_government") && r.what_we_need.includes("outcome=not_found"));
    assertEquals(r.region, r.target.pref_name);
    assertEquals(r.target.pref_code, lgPrefCode(r.target.lg_code as string));
    assertEquals(r.hint_sources.length, 3);
  }
  const hokkaido = rowsOf.find((r) => r.task_id.endsWith(":010006"))!;
  assertEquals([hokkaido.target.is_prefecture, hokkaido.target.lg_name, hokkaido.region], [true, "北海道", "北海道"]);
  assert(hokkaido.what_we_need.includes("kind=prefecture"));
  const sapporo = rowsOf.find((r) => r.task_id.endsWith(":011002"))!;
  assertEquals([sapporo.target.is_prefecture, sapporo.target.lg_name, sapporo.target.pref_code], [false, "札幌市", "010006"]);
  assert(sapporo.what_we_need.includes("designated_city") && sapporo.what_we_need.includes("pref_code は 010006"));
  // 都道府県が先：隊列（cap 內）のうち 47 件は prefecture
  assertEquals(rowsOf.filter((r) => r.target.is_prefecture === true).length, 47);
  // /next が読む派工列にも出る（auto: の列）
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks(NULL, NULL, 1000, '') WHERE task_type = 'local_government_missing'`), 200);

  // 團體進庫 → 下一輪 seed 收回（filled），第 201 名遞補
  const taken = new Set(["010006", "011002"]);
  await insertLg(db, { lg_code: "010006", kind: "prefecture", pref_code: "010006", name: "北海道", kana: "ほっかいどう" });
  await insertLg(db, { lg_code: "011002", kind: "designated_city", pref_code: "010006", name: "札幌市", kana: "さっぽろし" });
  await seed(db);
  const after = await dispatched(db, "local_government_missing");
  assertEquals(after.length, 200);
  assertEquals([...after].sort(), [...expectedIds(taken)].sort());
  assert(!after.includes("auto:local_government_missing:010006") && !after.includes("auto:local_government_missing:011002"));
  const closed = await rows<{ event: string; reason: string }>(db, `SELECT event, reason FROM policy_jp.gap_events WHERE task_id = 'auto:local_government_missing:010006' ORDER BY id`);
  assertEquals(closed.map((r) => [r.event, r.reason]), [["opened", null], ["closed", "filled"]]);

  // cap 改 10 → 10 件（最前面的 10 件＝都道府県）；停用 → 0 件
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{cap}', '10') WHERE activity = 'local_government_missing'`);
  await seed(db);
  assertEquals((await dispatched(db, "local_government_missing")).length, 10);
  assertEquals((await dispatched(db, "local_government_missing")), expectedIds(taken).slice(0, 10).sort());
  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = false WHERE activity = 'local_government_missing'`);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_local_government_missing()`), 0);
  await db.close();
});

Deno.test("regional_stats_missing：缺哪幾項（min_year、published 才算）、都道府県先、行政區不派、cap、補齊就收回", async () => {
  const db = await freshDb({ data: false });
  for (const lg of [AICHI, NAGANO, ICHI, KOMORO, CHIKUSA]) await insertLg(db, lg);
  const sid = (await one<{ id: number }>(db, `INSERT INTO policy_jp.sources (url, origin, source_kind) VALUES ($1, 'test', 'statistics') RETURNING id::INT AS id`, [ESTAT])).id;
  const stat = (lg: string, key: string, year: number, value: number, status = "published") =>
    db.query(`INSERT INTO policy_jp.regional_stats (lg_code, stat_key, year, value, unit, source_id, review_status) VALUES ($1, $2, $3, $4, policy_jp.regional_stat_unit($2), $5, $6)`, [lg, key, year, value, sid, status]);
  const tasks = async () => rows<{ task_id: string; target: { missing: Array<{ stat_key: string; min_year: number; unit: string }>; kind: string; lg_name: string }; what_we_need: string; region: string; reward: number; hint_sources: string[] }>(
    db, `SELECT task_id, target, what_we_need, region, reward, hint_sources FROM policy_jp.contribution_auto_tasks_regional_stats_missing() ORDER BY task_id`);

  // 全部缺：4 團體（行政區千種区不派）；各缺 4 項
  const t0 = await tasks();
  assertEquals(t0.map((t) => t.task_id), ["auto:regional_stats_missing:200000", "auto:regional_stats_missing:202088", "auto:regional_stats_missing:230006", "auto:regional_stats_missing:232033"]);
  for (const t of t0) {
    assertEquals(t.target.missing.map((m) => m.stat_key), ["aging_rate", "area_km2", "budget_expenditure", "population"]);
    assertEquals(t.target.missing.map((m) => [m.min_year, m.unit]), [[2020, "%"], [2020, "km2"], [2023, "千円"], [2020, "人"]]);
    assertEquals(t.reward, 2);
    assert(t.what_we_need.includes("contribution_type=regional_stat") && t.what_we_need.includes("stat_key=population") && t.what_we_need.includes("unit=千円"));
    assert(t.what_we_need.includes("人口（国勢調査）＝2020 年以降") && t.what_we_need.includes("歳出決算総額") && t.what_we_need.includes("2023 年以降"));
    assertEquals(t.hint_sources.length, 4);
  }
  assertEquals(t0[2].region, "愛知県");
  assertEquals(t0[3].target.lg_name, "一宮市");

  // 一部だけある：population 2020 published → 3 項；2015（min_year 未満）・pending は数えない；歳出 2022 は 2023 未満で数えない
  await stat("232033", "population", 2020, 386678);
  await stat("232033", "area_km2", 2015, 113.8);                // 古い
  await stat("232033", "aging_rate", 2020, 28.6, "pending");    // 未公開
  await stat("232033", "budget_expenditure", 2022, 1000);       // 2023 未満
  const t1 = (await tasks()).find((t) => t.task_id.endsWith(":232033"))!;
  assertEquals(t1.target.missing.map((m) => m.stat_key), ["aging_rate", "area_km2", "budget_expenditure"]);
  // 新しい年が入れば古い年は不要（年度は min_year 以上ならよい）
  await stat("232033", "area_km2", 2023, 113.9);
  await stat("232033", "budget_expenditure", 2023, 1200);
  await db.query(`UPDATE policy_jp.regional_stats SET review_status = 'published' WHERE stat_key = 'aging_rate'`);
  assertEquals((await tasks()).some((t) => t.task_id.endsWith(":232033")), false, "4 項そろった団体の任務は消える");
  // min_year を上げると再び必要になる（規則 1 行）
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{min_year,population}', '2025') WHERE activity = 'regional_stats_missing'`);
  assertEquals((await tasks()).find((t) => t.task_id.endsWith(":232033"))!.target.missing.map((m) => [m.stat_key, m.min_year]), [["population", 2025]]);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{min_year,population}', '2020') WHERE activity = 'regional_stats_missing'`);

  // 行政区を対象に戻す（exclude_kinds を空に）と千種区も出る；都道府県が先
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{exclude_kinds}', '[]') WHERE activity = 'regional_stats_missing'`);
  assertEquals((await tasks()).map((t) => t.task_id.slice(-6)), ["200000", "202088", "230006", "231011"]);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{exclude_kinds}', '["admin_ward"]') WHERE activity = 'regional_stats_missing'`);

  // cap：2 件なら都道府県 2 つ（団体コード順では長野 200000、愛知 230006）
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{cap}', '2') WHERE activity = 'regional_stats_missing'`);
  assertEquals((await tasks()).map((t) => t.task_id.slice(-6)), ["200000", "230006"]);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{cap}', '200') WHERE activity = 'regional_stats_missing'`);

  // seed：派工列に出て、/next が読める。補齊（愛知県の 4 項）で収回
  await seed(db);
  assertEquals((await dispatched(db, "regional_stats_missing")).length, 3);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_queue_tasks(NULL, NULL, 1000, '') WHERE task_type = 'regional_stats_missing'`), 3);
  for (const [k, y, v] of [["population", 2020, 7542415], ["area_km2", 2020, 5173.2], ["aging_rate", 2020, 25.4], ["budget_expenditure", 2023, 99999999]] as const) await stat("230006", k, y, v);
  await seed(db);
  assertEquals(await dispatched(db, "regional_stats_missing"), ["auto:regional_stats_missing:200000", "auto:regional_stats_missing:202088"]);
  assertEquals(await health(db), []);
  await db.close();
});

// =============================================================================================
// e. 落庫
// =============================================================================================
Deno.test("落庫 local_government：缺口 → 交件 → 3 票 → apply → local_governments＋sources＋source_refs＋edit_history＋applied → 缺口收回（立即＋seed）", async () => {
  const db = await freshDb();
  await clock(db, "2026-10-09");
  await seed(db);
  const TASK = "auto:local_government_missing:230006";
  assert((await dispatched(db, "local_government_missing")).includes(TASK));

  const id = await verified(db, "local_government", AICHI, [SOUMU_CODE, "https://www.pref.aichi.lg.jp/", "https://ja.wikipedia.org/wiki/愛知県"], { task: TASK });
  // verified 之前不動正式表
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.local_governments`), 0);
  const out = await applyCall(db, id);
  assertEquals(out, { status: "applied", outcome: "applied", message: "新增團體 愛知県（230006）", table_name: "local_governments", record_id: "230006" });
  assertEquals(await one(db, `SELECT lg_code, kind, pref_code, name, kana, slug, assembly_seats, valid_to FROM policy_jp.local_governments`),
    { lg_code: "230006", kind: "prefecture", pref_code: "230006", name: "愛知県", kana: "あいちけん", slug: "aichi", assembly_seats: null, valid_to: null });

  // 出處：三個網址都登記；第一個官方（總務省）是主要，其餘佐證；等級依網域
  const refs = await rows<{ url: string; source_kind: string; role: string; origin: string; fetched_at: string | null; doc_kind: string | null }>(db,
    `SELECT s.url, s.source_kind, r.role, r.origin, s.fetched_at, s.doc_kind FROM policy_jp.source_refs r JOIN policy_jp.sources s ON s.id = r.source_id
      WHERE r.target_table = 'local_governments' AND r.target_id = '230006' AND s.url NOT LIKE '%soumu.go.jp/main_content%' ORDER BY s.url`);
  assertEquals(refs.map((r) => [r.url, r.source_kind, r.role]), [
    ["https://ja.wikipedia.org/wiki/愛知県", "other", "supporting"], ["https://www.pref.aichi.lg.jp/", "official", "supporting"], [SOUMU_CODE, "official", "primary"],
  ]);
  assert(refs.every((r) => r.origin === "contribution" && r.fetched_at === null && r.doc_kind === null), "擷取時間不編造；團體的出處不是公告類");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs_orphans`), 0);

  // 審計與狀態
  const hist = await rows<{ table_name: string; record_id: string; field: string; old_value: unknown; contribution_id: string; agent_name: string; new_value: Record<string, unknown> }>(
    db, `SELECT table_name, record_id, field, old_value, contribution_id, agent_name, new_value FROM policy_jp.edit_history WHERE contribution_id IS NOT NULL`);
  assertEquals(hist.length, 1);
  assertEquals([hist[0].table_name, hist[0].record_id, hist[0].field, hist[0].old_value, hist[0].contribution_id, hist[0].agent_name], ["local_governments", "230006", "*", null, id, "auto-apply"]);
  assertEquals(hist[0].new_value.name, "愛知県");
  const c = await contribution(db, id);
  assertEquals([c.status, c.reviewed_by, c.last_error, c.next_retry_at], ["applied", "auto-apply", null, null]);
  assert(c.applied_at !== null && String(c.review_notes).startsWith("[auto] 新增團體"));

  // 派工列：applied 的當下觸發器就收回（不等 seed）
  assert(!(await dispatched(db, "local_government_missing")).includes(TASK), "contributions_drop_dispatch 立刻收回");
  await seed(db);
  assert(!(await dispatched(db, "local_government_missing")).includes(TASK));
  assertEquals((await dispatched(db, "local_government_missing")).length, 200, "cap 由後面的遞補");
  // 再 apply 一次＝skipped（冪等，不重複寫）
  assertEquals((await applyCall(db, id)).status, "skipped");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE contribution_id = $1`, [id]), 1);
  await db.close();
});

Deno.test("落庫 local_government：冪等（一樣的當成功）、衝突（不覆蓋、退件）、內容不合格（退件）、市区町村等都道府県（waiting → 進來後排程自動落）", async () => {
  const db = await freshDb({ data: false });
  // 都道府県還沒進來：一宮市 verified 但 waiting，貢獻維持 verified，不寫任何東西
  const ichi = await verified(db, "local_government", ICHI, [SOUMU_CODE], { task: "auto:local_government_missing:232033" });
  const w = await applyCall(db, ichi);
  assertEquals([w.status, w.reason], ["waiting", "prefecture_missing:230006"]);
  assertEquals(await status(db, ichi), "verified");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.local_governments`), 0);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.sources`), 0);
  assertEquals((await rows(db, `SELECT contribution_type, status, waiting_for FROM policy_jp.apply_waiting`)), [{ contribution_type: "local_government", status: "verified", waiting_for: "prefecture_missing:230006" }]);
  // 排程不挑被擋住的列
  assertEquals((await one(db, `SELECT policy_jp.apply_verified_pending(20, 0) AS r`) as { r: unknown }).r, { scanned: 0, applied: 0, rejected: 0, apply_failed: 0 });
  assertEquals(await status(db, ichi), "verified");

  // 都道府県が入る → 排程が一宮市を拾う（寬限 0 分）
  await applyLg(db, AICHI);
  const sweep = (await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending(20, 0) AS r`)).r;
  assertEquals(sweep, { scanned: 1, applied: 1, rejected: 0, apply_failed: 0 });
  assertEquals(await status(db, ichi), "applied");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.apply_waiting`), 0);
  assertEquals((await one<{ pref_code: string; slug: string }>(db, `SELECT pref_code, slug FROM policy_jp.local_governments WHERE lg_code = '232033'`)), { pref_code: "230006", slug: "232033" });

  // 冪等：同じ内容が別の代理から来て verified → applied（unchanged）、行は増えない・edit_history も増えない
  const again = await verified(db, "local_government", ICHI, [SOUMU_CODE, "https://www.city.ichinomiya.aichi.jp/"]);
  const u = await applyCall(db, again);
  assertEquals([u.status, u.outcome], ["applied", "unchanged"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.local_governments WHERE lg_code = '232033'`), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'local_governments' AND record_id = '232033'`), 1);
  // 追加の出典は佐證として掛かる（主要は 1 つのまま）
  assertEquals((await rows<{ role: string }>(db, `SELECT r.role FROM policy_jp.source_refs r WHERE target_table = 'local_governments' AND target_id = '232033' ORDER BY role`)).map((r) => r.role), ["primary", "supporting"]);

  // 衝突：読みが違う → 上書きしない、退件
  const diff = await verified(db, "local_government", { ...ICHI, kana: "いちのみやちょう" }, [SOUMU_CODE]);
  const x = await applyCall(db, diff);
  assertEquals([x.status, x.outcome], ["rejected", "conflict"]);
  assert(String(x.message).includes("不覆蓋"));
  assertEquals((await one<{ kana: string }>(db, `SELECT kana FROM policy_jp.local_governments WHERE lg_code = '232033'`)).kana, "いちのみやし");
  const dc = await contribution(db, diff);
  assertEquals(dc.status, "rejected");
  assert(String(dc.review_notes).includes("缺口會回到任務佇列"));

  // 内容不合格（TS の検証をすり抜けた壊れた payload を想定）：退件、リトライしない
  const bad: Array<[string, Record<string, unknown>]> = [
    ["檢查碼", { ...NAGANO, lg_code: "200001", pref_code: "200000" }],
    ["pref_code 不一致", { ...KOMORO, pref_code: "230006" }],
    ["kind 不認得", { ...KOMORO, kind: "county" }],
    ["prefecture 卻不是縣碼", { ...KOMORO, kind: "prefecture" }],
    ["縣碼卻不是 prefecture", { ...NAGANO, kind: "city" }],
    ["空 kana", { ...KOMORO, kana: " " }],
  ];
  await applyLg(db, NAGANO);
  for (const [why, payload] of bad) {
    const id = await verified(db, "local_government", payload, [SOUMU_CODE]);
    const r = await applyCall(db, id);
    assertEquals([r.status, r.outcome], ["rejected", "invalid"], `${why}：${r.message}`);
    assertEquals((await one<{ retry_count: number }>(db, `SELECT retry_count FROM policy_jp.contributions WHERE id = $1`, [id])).retry_count, 0, `${why}：不重試`);
  }
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.local_governments`), 3, "愛知県・一宮市・長野県");
  await db.close();
});

Deno.test("落庫 regional_stat：寫 published 的列（source_id＝主要出處）、冪等、衝突退件、單位／範圍不合格退件、團體不在就等", async () => {
  const db = await freshDb({ data: false });
  const POP = { lg_code: "232033", stat_key: "population", year: 2020, value: 386678, unit: "人", as_of: "2020-10-01" };
  const pop = await verified(db, "regional_stat", POP, ["https://www.asahi.com/a", ESTAT, "https://www.city.ichinomiya.aichi.jp/toukei/"]);
  const w = await applyCall(db, pop);
  assertEquals([w.status, w.reason], ["waiting", "local_government_missing:232033"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.regional_stats`), 0);
  await applyLg(db, AICHI); await applyLg(db, ICHI);
  const r = await applyCall(db, pop);
  assertEquals([r.status, r.outcome, r.record_id], ["applied", "applied", "232033/population/2020"]);
  const row = await one<{ value: string; unit: string; as_of: string; review_status: string; url: string; source_kind: string }>(db,
    `SELECT s.value::TEXT AS value, s.unit, s.as_of::TEXT AS as_of, s.review_status, src.url, src.source_kind FROM policy_jp.regional_stats s JOIN policy_jp.sources src ON src.id = s.source_id`);
  assertEquals(row, { value: "386678", unit: "人", as_of: "2020-10-01", review_status: "published", url: ESTAT, source_kind: "statistics" });
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.sources WHERE url IN ('https://www.asahi.com/a', 'https://www.city.ichinomiya.aichi.jp/toukei/')`), 2, "同じ交件の他のURLも sources に登記される");
  assertEquals((await one<{ table_name: string; agent_name: string }>(db, `SELECT table_name, agent_name FROM policy_jp.edit_history WHERE table_name = 'regional_stats'`)), { table_name: "regional_stats", agent_name: "auto-apply" });
  // 公開読み
  assertEquals((await asRole<{ n: number }>(db, "anon", `SELECT count(*)::INT AS n FROM policy_jp.regional_stats`))[0].n, 1);

  // 冪等・衝突
  const same = await verified(db, "regional_stat", { ...POP, as_of: undefined }, [ESTAT]);
  assertEquals((await applyCall(db, same)).outcome, "unchanged");
  const conflict = await verified(db, "regional_stat", { ...POP, value: 386000 }, [ESTAT]);
  const c = await applyCall(db, conflict);
  assertEquals([c.status, c.outcome], ["rejected", "conflict"]);
  assertEquals((await one<{ v: string }>(db, `SELECT value::TEXT AS v FROM policy_jp.regional_stats`)).v, "386678");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.regional_stats`), 1);

  // 不合格
  const bad: Array<[string, Record<string, unknown>]> = [
    ["單位錯", { ...POP, year: 2015, unit: "千人" }],
    ["歳出用円", { ...POP, stat_key: "budget_expenditure", year: 2023, unit: "円", value: 100 }],
    ["高齢化率 >100", { ...POP, stat_key: "aging_rate", unit: "%", value: 101 }],
    ["人口有小數", { ...POP, year: 2010, value: 10.5 }],
    ["面積 0", { ...POP, stat_key: "area_km2", unit: "km2", value: 0 }],
    ["stat_key 不認得", { ...POP, stat_key: "gdp" }],
    ["年份不是整數", { ...POP, year: 2020.5 }],
    ["value 是字串", { ...POP, year: 2005, value: "386678" }],
    ["as_of 0000", { ...POP, year: 2005, as_of: "0000-01-01" }],
    ["as_of 超出", { ...POP, year: 2005, as_of: "1900-01-01" }],
    ["檢查碼", { ...POP, lg_code: "232034", year: 2005 }],
  ];
  for (const [why, payload] of bad) {
    const id = await verified(db, "regional_stat", payload, [ESTAT]);
    const out = await applyCall(db, id);
    assertEquals([out.status, out.outcome], ["rejected", "invalid"], `${why}：${out.message}`);
  }
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.regional_stats`), 1);
  await db.close();
});

Deno.test("落庫 election：等團體到了再落（waiting，不繞過外鍵）→ 團體進來後排程自動落；id／層級／預設名稱／出處（election_notice）；缺口收回", async () => {
  const db = await freshDb();
  await clock(db, "2026-10-09");
  await seed(db);
  const ED = "auto:election_discovery:2027-01-31:232033:head";
  assert((await dispatched(db, "election_discovery")).includes(ED));

  const PAYLOAD = { lg_code: "232033", election_type: "mayor", election_reason: "regular", election_date: "2027-01-24", notice_date: "2027-01-17" };
  const id = await verified(db, "election", PAYLOAD, [ICHI_ELECTION_URL, "https://www.pref.aichi.lg.jp/senkyo/"], { task: ED });
  // 一宮市がまだ local_governments にない：waiting。貢獻維持 verified、elections 不動、外鍵沒有被繞過
  const w = await applyCall(db, id);
  assertEquals([w.status, w.reason], ["waiting", "local_government_missing:232033"]);
  assertEquals(await status(db, id), "verified");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.elections`), 0);
  assertEquals((await rows(db, `SELECT waiting_for FROM policy_jp.apply_waiting`)), [{ waiting_for: "local_government_missing:232033" }]);
  // 答案は出ている（通過済み・落庫待ち）：任務は派工から外れる（別の代理が調べ直さない）。cap の枠は後ろの任務が埋める
  await seed(db);
  const during = await dispatched(db, "election_discovery");
  assert(!during.includes(ED), "通過済み・落庫待ちの任務は出さない");
  assertEquals(during.length, 50);
  assertEquals(await one(db, `SELECT policy_jp.task_unavailable('${ED}') AS u`), { u: true });
  // 排程：團體まだ → 何もしない
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending(20, 0) AS r`)).r.scanned, 0);

  // 團體が入る（交件→3 票→apply）
  await applyLg(db, AICHI); await applyLg(db, ICHI);
  const sweep = (await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending(20, 0) AS r`)).r;
  assertEquals(sweep, { scanned: 1, applied: 1, rejected: 0, apply_failed: 0 });
  assertEquals(await status(db, id), "applied");
  const e = await one<Record<string, unknown>>(db, `SELECT id, name, election_date::TEXT AS election_date, notice_date::TEXT AS notice_date, election_type, election_reason, level, lg_code, review_status, seats, turnout FROM policy_jp.elections`);
  assertEquals([e.id, e.name, e.election_date, e.notice_date, e.election_type, e.election_reason, e.level, e.lg_code, e.review_status, e.seats, e.turnout],
    ["2027-01-24_mayor_232033", "一宮市長選挙", "2027-01-24", "2027-01-17", "mayor", "regular", "local", "232033", "published", null, null].map((v) => v));
  // 出處：選管（city.*.jp）が主要・doc_kind=election_notice（存檔待ち）、県の公式が佐證
  const refs = await rows<{ url: string; role: string; source_kind: string; doc_kind: string | null }>(db,
    `SELECT s.url, r.role, s.source_kind, s.doc_kind FROM policy_jp.source_refs r JOIN policy_jp.sources s ON s.id = r.source_id WHERE r.target_table = 'elections' ORDER BY s.url`);
  assertEquals(refs, [
    { url: ICHI_ELECTION_URL, role: "primary", source_kind: "official", doc_kind: "election_notice" },
    { url: "https://www.pref.aichi.lg.jp/senkyo/", role: "supporting", source_kind: "official", doc_kind: "election_notice" },
  ]);
  assertEquals((await rows<{ url: string }>(db, `SELECT url FROM policy_jp.source_archive_missing ORDER BY url`)).map((r) => r.url), [ICHI_ELECTION_URL, "https://www.pref.aichi.lg.jp/senkyo/"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs_orphans`), 0);
  // 公開（published）で anon が読める
  assertEquals((await asRole<{ id: string }>(db, "anon", `SELECT id FROM policy_jp.elections`)).map((r) => r.id), ["2027-01-24_mayor_232033"]);
  // 缺口：選挙ができたので一宮市長の任務は永遠に出ない
  await seed(db);
  assert(!(await dispatched(db, "election_discovery")).includes(ED));
  assertEquals(await one(db, `SELECT policy_jp.task_unavailable('${ED}') AS u`), { u: false }, "もう「待ち」ではない（選挙は elections にある）");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_election_discovery() WHERE task_id = '${ED}'`), 0);
  await db.close();
});

Deno.test("落庫 election：預設名稱、國政（lg_code 空）、補欠／増員／再選舉、冪等（補告示日、升 published）、衝突與 rejected 既有列退件、日期範圍", async () => {
  const db = await freshDb({ data: false });
  for (const lg of [AICHI, ICHI, NAGANO, KOMORO]) await insertLg(db, lg);
  const el = (o: Record<string, unknown>) => ({ lg_code: "232033", election_type: "mayor", election_reason: "regular", election_date: "2027-01-24", ...o });
  const applyEl = async (payload: Record<string, unknown>, urls = [ICHI_ELECTION_URL]) => {
    const id = await verified(db, "election", payload, urls);
    return { id, out: await applyCall(db, id) };
  };
  const nameOf = async (id: string) => (await one<{ name: string }>(db, `SELECT name FROM policy_jp.elections WHERE id = $1`, [id])).name;

  // 預設名稱（payload.name 沒給）
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [el({}), "2027-01-24_mayor_232033", "一宮市長選挙"],
    [el({ lg_code: "230006", election_type: "governor" }), "2027-01-24_governor_230006", "愛知県知事選挙"],
    [el({ election_type: "muni_assembly" }), "2027-01-24_muni_assembly_232033", "一宮市議会議員選挙"],
    [el({ lg_code: "230006", election_type: "pref_assembly", election_date: "2027-04-11" }), "2027-04-11_pref_assembly_230006", "愛知県議会議員選挙"],
    [el({ election_type: "muni_assembly", election_reason: "by_election", election_date: "2027-03-14" }), "2027-03-14_muni_assembly_232033", "一宮市議会議員補欠選挙"],
    [el({ election_type: "muni_assembly", election_reason: "increase", election_date: "2027-05-09" }), "2027-05-09_muni_assembly_232033", "一宮市議会議員増員選挙"],
    [el({ election_reason: "rerun", election_date: "2027-06-06" }), "2027-06-06_mayor_232033", "一宮市長再選挙"],
    [el({ election_reason: "death", election_date: "2027-07-04" }), "2027-07-04_mayor_232033", "一宮市長選挙"],
    [{ election_type: "national_lower", election_reason: "dissolution", election_date: "2028-01-23" }, "2028-01-23_national_lower_national", "衆議院議員総選挙"],
    [{ election_type: "national_upper", election_reason: "regular", election_date: "2028-07-23" }, "2028-07-23_national_upper_national", "参議院議員通常選挙"],
    [{ election_type: "national_upper", election_reason: "by_election", election_date: "2028-10-22" }, "2028-10-22_national_upper_national", "参議院議員補欠選挙"],
  ];
  for (const [payload, id, name] of cases) {
    const { out } = await applyEl(payload);
    assertEquals([out.status, out.record_id], ["applied", id], JSON.stringify(out));
    assertEquals(await nameOf(id), name);
  }
  const lvl = await rows<{ id: string; level: string; lg_code: string | null }>(db, `SELECT id, level, lg_code FROM policy_jp.elections ORDER BY id`);
  assertEquals(lvl.find((r) => r.id.includes("national_lower"))!, { id: "2028-01-23_national_lower_national", level: "national", lg_code: null });
  assertEquals(lvl.find((r) => r.id === "2027-01-24_governor_230006")!.level, "regional");
  // 給了 name 就用它
  assertEquals(await nameOf((await applyEl(el({ election_date: "2027-08-01", name: "一宮市長選挙（出直し）" }))).out.record_id!), "一宮市長選挙（出直し）");

  // 冪等：同じ選挙が別の代理から → unchanged；告示日が空なら補う；pending の列は published に上げる
  const dup = await applyEl(el({ notice_date: "2027-01-17" }), [ICHI_ELECTION_URL, "https://www.city.ichinomiya.aichi.jp/senkyo/2/"]);
  assertEquals([dup.out.status, dup.out.outcome], ["applied", "unchanged"]);
  assertEquals((await one<{ n: string }>(db, `SELECT notice_date::TEXT AS n FROM policy_jp.elections WHERE id = '2027-01-24_mayor_232033'`)).n, "2027-01-17", "告示日が空だった列に補われる");
  await db.query(`UPDATE policy_jp.elections SET review_status = 'pending' WHERE id = '2027-07-04_mayor_232033'`);
  assertEquals((await applyEl(el({ election_reason: "death", election_date: "2027-07-04" }))).out.outcome, "unchanged");
  assertEquals((await one<{ s: string }>(db, `SELECT review_status AS s FROM policy_jp.elections WHERE id = '2027-07-04_mayor_232033'`)).s, "published", "共識が通ったので pending → published");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'elections' AND record_id = '2027-01-24_mayor_232033'`), 2, "新規＋告示日補完");

  // 衝突：同じ id で事由が違う／告示日が違う／既存が rejected → 退件
  for (const [why, payload] of [
    ["事由", el({ election_reason: "resignation" })],
    ["告示日", el({ notice_date: "2027-01-16" })],
  ] as const) {
    const { out } = await applyEl(payload);
    assertEquals([out.status, out.outcome], ["rejected", "conflict"], why);
  }
  await db.query(`UPDATE policy_jp.elections SET review_status = 'rejected' WHERE id = '2027-06-06_mayor_232033'`);
  assertEquals((await applyEl(el({ election_reason: "rerun", election_date: "2027-06-06" }))).out.outcome, "conflict", "人が退けた列を共識で黙って蘇らせない");

  // 內容不合格
  const bad: Array<[string, Record<string, unknown>]> = [
    ["國政帶 lg_code", { ...el({}), election_type: "national_lower" }],
    ["地方沒有 lg_code", { election_type: "mayor", election_reason: "regular", election_date: "2027-01-24" }],
    ["檢查碼", el({ lg_code: "232034" })],
    ["補欠首長", el({ election_reason: "by_election", election_date: "2027-09-01" })],
    ["日期 0000", el({ election_date: "0000-01-01" })],
    ["日期 1946", el({ election_date: "1946-12-31" })],
    ["日期 2101", el({ election_date: "2101-01-01" })],
    ["日期不存在", el({ election_date: "2027-02-30" })],
    ["告示日晚於投票日", el({ election_date: "2027-09-02", notice_date: "2027-09-03" })],
    ["告示日 0000", el({ election_date: "2027-09-02", notice_date: "0000-01-01" })],
    ["事由不認得", el({ election_reason: "term_end", election_date: "2027-09-03" })],
    ["種類不認得", el({ election_type: "village_head", election_date: "2027-09-04" })],
  ];
  for (const [why, payload] of bad) {
    const { out, id } = await applyEl(payload);
    assertEquals([out.status, out.outcome], ["rejected", "invalid"], `${why}：${out.message}`);
    assertEquals((await one<{ retry_count: number }>(db, `SELECT retry_count FROM policy_jp.contributions WHERE id = $1`, [id])).retry_count, 0, `${why}：不重試`);
  }
  // 日期の境界（1947-01-01 と 2100-12-31 は通る）
  assertEquals((await applyEl(el({ election_date: "1947-04-05" }))).out.status, "applied");
  assertEquals((await applyEl(el({ election_date: "2100-12-31" }))).out.status, "applied");
  await db.close();
});

Deno.test("落庫 no_change：記一筆 task_checks（冷卻）、不動正式資料；task_suggestion／correction 不落庫（維持 verified，排程不碰）", async () => {
  const db = await freshDb({ data: false });
  const TASK = "auto:election_discovery:2027-01-31:232033:head";
  const NC = { task_id: TASK, outcome: "not_found", checked_urls: ["https://www.pref.aichi.lg.jp/senkyo/"], finding: "愛知県選管のページに一宮市長選挙の告示はまだない" };
  const nc = await verified(db, "no_change", NC, NC.checked_urls, { task: TASK });
  const out = await applyCall(db, nc);
  assertEquals([out.status, out.table_name, out.record_id], ["applied", "task_checks", TASK]);
  const tc = await one<Record<string, unknown>>(db, `SELECT task_id, agent_name, note, contribution_id, outcome FROM policy_jp.task_checks`);
  assertEquals([tc.task_id, tc.outcome, tc.contribution_id, tc.note], [TASK, "not_found", nc, NC.finding]);
  assertEquals((await contribution(db, nc)).status, "applied");
  for (const t of ["elections", "local_governments", "regional_stats", "politicians"]) assertEquals(await count(db, `SELECT 1 FROM policy_jp.${t}`), 0);
  // payload.task_id が無くても列の task_id で記録
  const nc2 = await verified(db, "no_change", { outcome: "unreachable", checked_urls: ["https://x.jp/"], finding: "ページが開けなかった" }, ["https://x.jp/"], { task: "auto:foo:1" });
  assertEquals((await applyCall(db, nc2)).status, "applied");
  assertEquals((await one<{ outcome: string }>(db, `SELECT outcome FROM policy_jp.task_checks WHERE task_id = 'auto:foo:1'`)).outcome, "unreachable");
  // 壊れた no_change は退件
  const badNc = await verified(db, "no_change", { task_id: "auto:foo:2", outcome: "maybe", checked_urls: ["https://x.jp/"], finding: "x" }, ["https://x.jp/"]);
  assertEquals((await applyCall(db, badNc)).outcome, "invalid");

  // task_suggestion／correction：unsupported、狀態不變、排程不碰
  const ts = await verified(db, "task_suggestion", { title: "この公約の進捗を調べる必要あり", description: "最新の施政方針に記載があるため。" }, ["https://x.jp/"]);
  const co = await verified(db, "correction", { target_table: "policies", target_id: "p-1", changes: [{ field: "status", correct_value: "achieved" }], reason: "公式発表で確認" }, ["https://x.jp/"]);
  for (const id of [ts, co]) {
    assertEquals((await applyCall(db, id)).status, "unsupported");
    assertEquals(await status(db, id), "verified");
  }
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending(20, 0) AS r`)).r.scanned, 0);
  // 存在しない id／pending のもの
  assertEquals((await applyCall(db, "00000000-0000-4000-8000-000000000000")).status, "not_found");
  const pending = await addContribution(db, "local_government", AICHI, [SOUMU_CODE]);
  const sk = await applyCall(db, pending);
  assertEquals([sk.status, sk.contribution_status], ["skipped", "pending"]);
  await db.close();
});

Deno.test("落庫失敗：apply_failed（整筆回滾）→ 10 分鐘後重試 → 連續 3 次退件；除掉原因後重試成功、重試欄位清掉；排程只挑到期的", async () => {
  const db = await freshDb({ data: false });
  const boom = `CREATE FUNCTION policy_jp.test_boom() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom: 資料庫暫時壞了'; END $$;
    CREATE TRIGGER test_boom BEFORE INSERT ON policy_jp.local_governments FOR EACH ROW EXECUTE FUNCTION policy_jp.test_boom();`;
  await db.exec(boom);
  const id = await verified(db, "local_government", AICHI, [SOUMU_CODE, "https://www.pref.aichi.lg.jp/"], { task: "auto:local_government_missing:230006" });
  const f1 = await applyCall(db, id);
  assertEquals([f1.status, f1.retry_count], ["apply_failed", 1]);
  assert(String(f1.message).includes("boom"));
  let c = await contribution(db, id);
  assertEquals([c.status, c.retry_count], ["apply_failed", 1]);
  assert(String(c.last_error).includes("boom") && String(c.review_notes).includes("第 1 次"));
  assert((await one<{ ok: boolean }>(db, `SELECT next_retry_at BETWEEN now() + interval '9 minutes' AND now() + interval '11 minutes' AS ok FROM policy_jp.contributions WHERE id = $1`, [id])).ok, "10 分鐘後重試");
  // 整筆回滾：出處、引用、審計都沒有留下
  for (const t of ["local_governments", "source_refs"]) assertEquals(await count(db, `SELECT 1 FROM policy_jp.${t}`), 0, `${t} 不該留下半截資料`);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.sources WHERE url IN ('${SOUMU_CODE}', 'https://www.pref.aichi.lg.jp/')`), 0);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE contribution_id IS NOT NULL`), 0);
  // 還沒到期：retry 模式不動；一般模式（狀態不是 verified）也不動
  assertEquals((await applyCall(db, id, true)).status, "skipped");
  assertEquals((await applyCall(db, id, false)).status, "skipped");
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending(20, 0) AS r`)).r.scanned, 0, "沒到期的 apply_failed 排程不挑");
  // 到期 → 排程挑到、再失敗（第 2 次）
  await db.query(`UPDATE policy_jp.contributions SET next_retry_at = now() - interval '1 minute' WHERE id = $1`, [id]);
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending(20, 0) AS r`)).r, { scanned: 1, applied: 0, rejected: 0, apply_failed: 1 });
  assertEquals((await contribution(db, id)).retry_count, 2);
  // 第 3 次失敗 → 退件（不硬建），缺口之後會重派
  await db.query(`UPDATE policy_jp.contributions SET next_retry_at = now() - interval '1 minute' WHERE id = $1`, [id]);
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending(20, 0) AS r`)).r, { scanned: 1, applied: 0, rejected: 1, apply_failed: 0 });
  c = await contribution(db, id);
  assertEquals([c.status, c.retry_count, c.next_retry_at], ["rejected", 3, null]);
  assert(String(c.review_notes).includes("連續 3 次失敗") && String(c.review_notes).includes("缺口會回到任務佇列"));
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending(20, 0) AS r`)).r.scanned, 0);

  // 原因除去後：第 1 次失敗、第 2 次成功
  const id2 = await verified(db, "local_government", AICHI, [SOUMU_CODE]);
  assertEquals((await applyCall(db, id2)).status, "apply_failed");
  await db.exec(`DROP TRIGGER test_boom ON policy_jp.local_governments`);
  await db.query(`UPDATE policy_jp.contributions SET next_retry_at = now() - interval '1 minute' WHERE id = $1`, [id2]);
  const ok = await applyCall(db, id2, true);
  assertEquals([ok.status, ok.outcome], ["applied", "applied"]);
  c = await contribution(db, id2);
  assertEquals([c.status, c.last_error, c.next_retry_at, c.retry_count], ["applied", null, null, 1]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.local_governments`), 1);
  await db.close();
});

Deno.test("排程掃地機：寬限內的 verified 不碰、過了寬限才落；每次最多 p_limit 筆（最早通過的先）；權限只給 service_role", async () => {
  const db = await freshDb({ data: false });
  await applyLg(db, AICHI);
  await applyLg(db, NAGANO);
  const a = await verified(db, "local_government", ICHI, [SOUMU_CODE]);
  const b = await verified(db, "local_government", KOMORO, [SOUMU_CODE]);
  // 寬限 5 分鐘（預設）：剛通過的不碰（行內落庫與排程不搶）
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending() AS r`)).r.scanned, 0);
  await db.query(`UPDATE policy_jp.contributions SET verified_at = now() - interval '6 minutes' WHERE id = $1`, [a]);
  await db.query(`UPDATE policy_jp.contributions SET verified_at = now() - interval '7 minutes' WHERE id = $1`, [b]);
  // limit 1：最早通過的（b）先
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending(1) AS r`)).r, { scanned: 1, applied: 1, rejected: 0, apply_failed: 0 });
  assertEquals([await status(db, a), await status(db, b)], ["verified", "applied"]);
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending() AS r`)).r.applied, 1);
  assertEquals(await status(db, a), "applied");
  // service_role 可以執行，其他角色不行
  const idc = await verified(db, "no_change", { task_id: "auto:x:1", outcome: "confirmed", checked_urls: ["https://x.jp/"], finding: "確認した" }, ["https://x.jp/"]);
  const viaRole = await asRole<{ r: ApplyOut }>(db, "service_role", `SELECT policy_jp.apply_contribution('${idc}') AS r`);
  assertEquals(viaRole[0].r.status, "applied");
  assertEquals((await asRole<{ n: number }>(db, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.apply_waiting`))[0].n, 0);
  await db.close();
});

// =============================================================================================
// g. #503 a：cap 套在可派的缺口上
// =============================================================================================
const noChangeFor = async (db: PGlite, t: Term, votes: number) => {
  const task = edTaskId(t);
  const payload = { task_id: task, outcome: "not_found", checked_urls: ["https://www.pref.example.lg.jp/senkyo/"], finding: `${t.pref}${t.name}の選管ページに告示はまだ載っていない` };
  const id = await addContribution(db, "no_change", payload, payload.checked_urls, { task });
  if (votes > 0) await vote(db, id, votes);
  return id;
};

Deno.test("#503 修正前的行為重現：前 50 件冷卻中卻佔著名額，派工列仍是同一批 50 件、/next 讀到 0 件；套上 210000／210100 後第 51～100 名遞補", async () => {
  const db = await freshDb({ upTo: "base" });
  await clock(db, "2026-10-09");
  await seed(db);
  const first50 = expectedEd("2026-10-09");
  assertEquals(first50.length, 50);
  assertEquals(await dispatched(db, "election_discovery"), first50.map(edTaskId).sort());
  // 前 50 件都被查過（task_checks 在冷卻期內）——這是 no_change 落庫以後會發生的事
  for (const t of first50) await db.query(`INSERT INTO policy_jp.task_checks (task_id, agent_name, outcome) VALUES ($1, 'checker', 'not_found')`, [edTaskId(t)]);
  await seed(db);
  assertEquals(await dispatched(db, "election_discovery"), first50.map(edTaskId).sort(), "修正前：冷卻中的 50 件仍佔著 cap，第 51 名以後開不出來");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.task_dispatches WHERE task_id LIKE 'auto:election_discovery:%' AND cooling`), 50);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_queue_tasks(NULL, NULL, 1000, '') WHERE task_type = 'election_discovery'`), 0, "/next 能領的任務是 0 件");

  // 套上修正（同一個資料庫、已經有冷卻資料）
  await db.exec(APPLY_SQL);
  await db.exec(ARMS_SQL);
  await seed(db);
  const next50 = expectedEd("2026-10-09", { exclude: new Set(first50.map(edTaskId)) });
  assertEquals(await dispatched(db, "election_discovery"), next50.map(edTaskId).sort(), "修正後：cap 套在可派的缺口上，第 51～100 名遞補");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_queue_tasks(NULL, NULL, 1000, '') WHERE task_type = 'election_discovery'`), 50);
  await db.close();
});

Deno.test("#503 整條：前 50 件各交 no_change 並通過驗證（等票中→通過→落庫→冷卻），每個階段第 51 名都遞補；冷卻到期原任務重開（gap_events：opened→closed→reopened）", async () => {
  const db = await freshDb();
  await clock(db, "2026-10-09");
  await seed(db);
  const first50 = expectedEd("2026-10-09");
  const ids50 = first50.map(edTaskId);
  assertEquals(await dispatched(db, "election_discovery"), [...ids50].sort());
  const exclude = (n: number) => new Set(ids50.slice(0, n));
  const want = (n: number) => expectedEd("2026-10-09", { exclude: exclude(n) }).map(edTaskId).sort();

  // 階段 A：前 10 件各有一筆 no_change 等票中（0 票）→ 擋住（nochange 分支）→ 第 51～60 名遞補
  const ncIds: string[] = [];
  for (const t of first50.slice(0, 10)) ncIds.push(await noChangeFor(db, t, 0));
  await seed(db);
  assertEquals(await dispatched(db, "election_discovery"), want(10), "A：等票中的 no_change 擋住任務，名額讓給後面的");
  for (const id of ncIds) assertEquals(await status(db, id), "pending");

  // 階段 B：前 50 件都通過驗證（2 票）但還沒落庫 → 仍擋住
  for (const id of ncIds) await vote(db, id, 2);
  for (const t of first50.slice(10)) ncIds.push(await noChangeFor(db, t, 2));
  for (const id of ncIds) assertEquals(await status(db, id), "verified");
  await seed(db);
  assertEquals(await dispatched(db, "election_discovery"), want(50), "B：通過驗證、還沒落庫的 no_change 擋住任務（第 51～100 名在隊列）");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_queue_tasks(NULL, NULL, 1000, '') WHERE task_type = 'election_discovery'`), 50);

  // 階段 C：落庫（task_checks）→ applied → 進入冷卻 → 仍然是第 51～100 名
  const sweep = (await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.apply_verified_pending(100, 0) AS r`)).r;
  assertEquals(sweep, { scanned: 50, applied: 50, rejected: 0, apply_failed: 0 });
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.task_checks WHERE task_id LIKE 'auto:election_discovery:%' AND outcome = 'not_found'`), 50);
  await seed(db);
  assertEquals(await dispatched(db, "election_discovery"), want(50), "C：落庫後冷卻 14 天，名額仍給後面的");

  // 階段 D：冷卻到期（task_checks 往前推 15 天）→ 原任務重開，擠掉第 51～100 名（term_end 較早的先）
  await db.exec(`UPDATE policy_jp.task_checks SET checked_at = checked_at - interval '15 days'`);
  await seed(db);
  assertEquals(await dispatched(db, "election_discovery"), [...ids50].sort(), "D：冷卻過了，原任務重開");
  const ev = await rows<{ event: string; reason: string | null }>(db, `SELECT event, reason FROM policy_jp.gap_events WHERE task_id = $1 ORDER BY id`, [ids50[0]]);
  assertEquals(ev.map((e) => e.event), ["opened", "closed", "reopened"]);
  assertEquals(ev[1].reason, "filled");
  assertEquals(await health(db), []);
  await db.close();
});

Deno.test("#503 task_unavailable 與 refresh_dispatch_blocked 逐情境對照（前三項同一個定義）；第四項（資料型交件通過等落庫）是日本站加的", async () => {
  const db = await freshDb({ data: false });
  let n = 0;
  const task = () => `auto:election_discovery:2027-01-31:0000${++n}:head`;
  const mkTask = async (setup: (id: string) => Promise<unknown>) => {
    const id = task();
    await db.query(`INSERT INTO policy_jp.task_dispatches (task_id, task_type, target) VALUES ($1, 'election_discovery', '{}')`, [id]);
    await setup(id);
    return id;
  };
  const addNc = async (id: string, st: string) => {
    await db.query(`INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash, status)
      VALUES ('no_change', $2::JSONB, ARRAY['https://x.jp/'], $1, 'a-' || $3::TEXT, 'ip-' || $3::TEXT, 'h-' || $3::TEXT, $4)`, [id, JSON.stringify({ task_id: id, outcome: "not_found" }), ++seq, st]);
  };
  const addEl = (id: string, st: string) => db.query(`INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash, status)
      VALUES ('election', '{}', ARRAY['https://x.jp/'], $1, 'a-' || $2::TEXT, 'ip-' || $2::TEXT, 'h-' || $2::TEXT, $3)`, [id, ++seq, st]);
  const check = (id: string, outcome: string, ago: string) => db.query(`INSERT INTO policy_jp.task_checks (task_id, outcome, checked_at) VALUES ($1, $2, now() - $3::INTERVAL)`, [id, outcome, ago]);

  const scenarios: Array<[string, boolean, (id: string) => Promise<unknown>]> = [
    ["什麼都沒有", false, async () => {}],
    ["no_change 等票中", true, (id) => addNc(id, "pending")],
    ["no_change 已通過（verified）", true, (id) => addNc(id, "verified")],
    ["no_change 被退件", false, (id) => addNc(id, "rejected")],
    ["no_change 已撤回", false, (id) => addNc(id, "withdrawn")],
    ["no_change 已落庫但沒有查核紀錄（不應發生）", false, (id) => addNc(id, "applied")],
    ["查核 not_found 1 天前（冷卻 14 天）", true, (id) => check(id, "not_found", "1 day")],
    ["查核 confirmed 13 天前", true, (id) => check(id, "confirmed", "13 days")],
    ["查核 not_found 15 天前", false, (id) => check(id, "not_found", "15 days")],
    ["查核 unreachable 1 天前（冷卻 2 天）", true, (id) => check(id, "unreachable", "1 day")],
    ["查核 unreachable 3 天前", false, (id) => check(id, "unreachable", "3 days")],
    ["在途 4 筆", false, async (id) => { for (const s of ["pending", "pending", "pending", "disputed"]) await addEl(id, s); }],
    ["在途 5 筆（飽和）", true, async (id) => { for (const s of ["pending", "pending", "pending", "disputed", "disputed"]) await addEl(id, s); }],
    ["4 筆在途＋1 筆被退件", false, async (id) => { for (const s of ["pending", "pending", "pending", "pending", "rejected"]) await addEl(id, s); }],
  ];
  for (const [why, expected, setup] of scenarios) {
    const id = await mkTask(setup);
    await db.query(`SELECT policy_jp.refresh_dispatch_blocked()`);
    const r = await one<{ blocked: boolean; cooling: boolean }>(db, `SELECT blocked, cooling FROM policy_jp.task_dispatches WHERE task_id = $1`, [id]);
    const unavailable = (await one<{ u: boolean }>(db, `SELECT policy_jp.task_unavailable($1) AS u`, [id])).u;
    assertEquals(r.blocked || r.cooling, expected, `${why}：refresh_dispatch_blocked 的結論`);
    assertEquals(unavailable, r.blocked || r.cooling, `${why}：task_unavailable 要跟 refresh_dispatch_blocked 一致`);
  }
  // 第四項：資料型交件通過、等落庫——refresh 不擋（任務會被派出去），task_unavailable 擋（答案已經有了）
  const waiting = await mkTask((id) => addEl(id, "verified"));
  await db.query(`SELECT policy_jp.refresh_dispatch_blocked()`);
  const rr = await one<{ blocked: boolean; cooling: boolean }>(db, `SELECT blocked, cooling FROM policy_jp.task_dispatches WHERE task_id = $1`, [waiting]);
  assertEquals([rr.blocked, rr.cooling, (await one<{ u: boolean }>(db, `SELECT policy_jp.task_unavailable($1) AS u`, [waiting])).u], [false, false, true]);
  // 型別が task_suggestion／correction の verified（落庫されない）は第四項に入らない：永遠に隠れてはいけない
  const stuck = await mkTask(async (id) => {
    await db.query(`INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash, status)
      VALUES ('correction', '{}', ARRAY['https://x.jp/'], $1, 'a-c', 'ip-c', 'h-c', 'verified')`, [id]);
  });
  assertEquals((await one<{ u: boolean }>(db, `SELECT policy_jp.task_unavailable($1) AS u`, [stuck])).u, false);
  await db.close();
});

// =============================================================================================
// h. 排程與自我檢查
// =============================================================================================
Deno.test("排程：有 pg_cron 就排（先 unschedule 再 schedule，只留一條）、沒有就略過", async () => {
  const cron = `CREATE SCHEMA cron; CREATE TABLE cron.job (jobname TEXT, schedule TEXT, command TEXT);
    CREATE FUNCTION cron.schedule(a TEXT, b TEXT, c TEXT) RETURNS BIGINT LANGUAGE sql AS $$ INSERT INTO cron.job VALUES (a, b, c) RETURNING 1::BIGINT $$;
    CREATE FUNCTION cron.unschedule(a TEXT) RETURNS BOOLEAN LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = a RETURNING true $$;`;
  const withCron = await freshDb({ pre: cron, data: false });
  await withCron.exec(APPLY_SQL); // 重跑
  const jobs = await rows<{ jobname: string; schedule: string; command: string }>(withCron, `SELECT * FROM cron.job WHERE jobname = 'policy-jp-apply-verified'`);
  assertEquals(jobs, [{ jobname: "policy-jp-apply-verified", schedule: "5,15,25,35,45,55 * * * *", command: "SELECT policy_jp.apply_verified_pending();" }]);
  assert(!jobs[0].schedule.startsWith("*/10"), "避開 seed 的 */10 整點");
  await withCron.close();
  const noCron = await freshDb({ data: false }); // 沒有 cron schema 也成功（freshDb 已套）
  assertEquals(await count(noCron, `SELECT 1 FROM pg_namespace WHERE nspname = 'cron'`), 0);
  await noCron.close();
});

Deno.test("自我檢查（還原驗證）：沒開 RLS、anon 有寫入權限、函式給 anon、規則缺 cap／min_year／寫錯 stat_key，重跑 migration 都會失敗", async () => {
  const base = async (): Promise<PGlite> => {
    const db = new PGlite();
    await db.exec(ROLES);
    await db.exec(SCHEMA_SQL); await db.exec(TABLES_SQL); await db.exec(MIG090); await db.exec(MIG091);
    return db;
  };
  let db = await base();
  await assertRejects(() => db.exec(mutate(APPLY_SQL, "ALTER TABLE policy_jp.regional_stats ENABLE ROW LEVEL SECURITY;\n", "")), Error, "沒開 RLS");
  await db.close();
  db = await base();
  await assertRejects(() => db.exec(mutate(APPLY_SQL, "GRANT SELECT ON policy_jp.regional_stats TO anon, authenticated;", "GRANT ALL ON policy_jp.regional_stats TO anon, authenticated;")), Error, "權限不對");
  await db.close();
  db = await base();
  await assertRejects(() => db.exec(mutate(APPLY_SQL, "  TO service_role;\n-- CHECK 約束裡呼叫的函式", "  TO service_role, anon;\n-- CHECK 約束裡呼叫的函式")), Error, "不該能執行這些函式");
  await db.close();
  db = await base();
  await assertRejects(() => db.exec(mutate(APPLY_SQL, "GRANT ALL ON policy_jp.apply_waiting TO service_role;", "GRANT SELECT ON policy_jp.apply_waiting TO service_role, anon;")), Error, "權限不對");
  await db.close();
  // 函式本體提到 public.
  db = await base();
  await assertRejects(() => db.exec(mutate(APPLY_SQL, "RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls 沒有可用的 http(s) 網址');\n  END IF;\n  INSERT INTO policy_jp.local_governments",
    "RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls 沒有可用的 http(s) 網址 public.x');\n  END IF;\n  INSERT INTO policy_jp.local_governments")), Error, "提到 public.");
  await db.close();

  // 臂 migration：規則缺 cap／min_year、stat_key 寫錯
  db = await base(); await db.exec(APPLY_SQL);
  await assertRejects(() => db.exec(mutate(ARMS_SQL, `'{"cap":200}'::JSONB`, `'{"caps":200}'::JSONB`)), Error, "local_government_missing 的規則缺 cap");
  await db.close();
  db = await base(); await db.exec(APPLY_SQL);
  await assertRejects(() => db.exec(mutate(ARMS_SQL, `"min_year":{"population":2020,`, `"min_years":{"population":2020,`)), Error, "缺 cap／min_year");
  await db.close();
  db = await base(); await db.exec(APPLY_SQL);
  await assertRejects(() => db.exec(mutate(ARMS_SQL, `"min_year":{"population":2020,`, `"min_year":{"populaton":2020,`)), Error, "不認得的 stat_key");
  await db.close();
  db = await base(); await db.exec(APPLY_SQL);
  await assertRejects(() => db.exec(mutate(ARMS_SQL,
    "REVOKE EXECUTE ON FUNCTION policy_jp.task_unavailable(TEXT), policy_jp.regional_stat_label(TEXT),",
    "GRANT EXECUTE ON FUNCTION policy_jp.task_unavailable(TEXT) TO anon;\nREVOKE EXECUTE ON FUNCTION policy_jp.regional_stat_label(TEXT),")), Error, "不該給 anon 執行");
  await db.close();

  // 規則被刪：臂整支不吐東西；健康檢查 arm_without_rule 抓得到；重跑 migration 把規則種回來
  db = await freshDb();
  await clock(db, "2026-10-09");
  await db.exec(`DELETE FROM policy_jp.activity_rules WHERE activity IN ('local_government_missing', 'regional_stats_missing')`);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_local_government_missing()`), 0);
  assertEquals((await health(db)).map((r) => r.subject), ["local_government_missing", "regional_stats_missing"]);
  await db.exec(ARMS_SQL);
  assertEquals(await health(db), []);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_local_government_missing()`), 200);
  await db.close();
});
