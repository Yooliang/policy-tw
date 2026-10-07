/**
 * 派工臂總表（contribution_auto_tasks_arms）的 PGlite 測試環境——給 activity-arms.test.ts（CI）與 scripts/arms-parity.ts（正式庫快照）共用。
 *
 * 做法：28 個分支函式（contribution_auto_tasks_raw／deadline_due 與 26 支臂）換成 stub——「回放 _b_<名字> 這張表裡的列」；
 * 總表本身（前一版＝20261006141600 的現行定義）、roster_scope_covers、election_id_or_null、整個啟用時間窗（P0、P1 兩支 migration）都跑真的。
 * 所以測的是「總表的組合方式」有沒有改變結果；各臂內部（不在 P1 範圍）不重算，它們各有自己的測試。
 *
 * 不是測試檔（沒有 .test.ts），deno test 不會單獨跑它。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

export const MIGRATIONS = new URL("../../migrations/", import.meta.url);
export const P0_MIG = "20261008001000_activity_windows_p0.sql";
export const P1_MIG = "20261008060000_activity_windows_p1.sql";
export const P2_ER_MIG = "20261008070000_activity_windows_p2_election_results.sql";
export const P2_PG_MIG = "20261008120000_activity_windows_p2_party_gap.sql";
export const P2_PR_MIG = "20261008121000_activity_windows_p2_party_roster.sql";
export const BALLOT_MIG = "20261008150000_ballot_numbers_arm.sql";
export const BASE_ARMS_MIG ="20261006141600_reassign_candidacy.sql";
export const BASE_DROP_MIG = "20260924000001_dispatch_io.sql";

export const readMig = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");

export async function migrationNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  return names.sort();
}

/** 函式定義全文（從 CREATE OR REPLACE FUNCTION 到結尾的 $$;） */
export function fnText(sql: string, name: string): string {
  const head = `CREATE OR REPLACE FUNCTION ${name}(`;
  const a = sql.indexOf(head);
  assert(a >= 0, `找不到函式 ${name}`);
  const rest = sql.slice(a);
  const tag = /AS (\$[a-z]*\$)/.exec(rest);
  assert(tag, `${name} 沒有 $$ 本體`);
  const start = rest.indexOf(tag[0]) + tag[0].length;
  // 結尾標記後面可以換行再接分號（pg_get_functiondef 轉出來的 migration 是 "$function$\n;"）
  const re = new RegExp(tag[1].replaceAll("$", "\\$") + "\\s*;", "g");
  re.lastIndex = start;
  const end = re.exec(rest);
  assert(end, `${name} 找不到結尾標記`);
  return rest.slice(0, end.index + end[0].length);
}

/** migrations 裡某支函式最後一次的定義（照檔名排序，後蓋前）；limitBefore：只看這個檔名之前的 */
export async function latestFn(name: string, limitBefore?: string): Promise<string> {
  let def: string | null = null;
  for (const n of await migrationNames()) {
    if (limitBefore && n >= limitBefore) break;
    const sql = await read(n);
    if (sql.includes(`CREATE OR REPLACE FUNCTION ${name}(`)) def = fnText(sql, name);
  }
  assert(def, `找不到 ${name}`);
  return def;
}
const read = readMig;

/** 精確改一處：改不到或改到兩處都算失敗（標記字串必須唯一，不然「還原驗證」可能什麼都沒改） */
export function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 60)}`);
  return sql.replace(from, () => to);
}

/** 總表的 28 個分支（函式名去掉 contribution_auto_tasks_ 前綴），順序＝前一版 UNION 的順序，raw 在最前面、deadline_due 在 policy_elements 後面 */
export const ARM_BRANCHES = [
  "raw", "dup", "legacy", "mismatch", "policy_dup", "not_running", "mayor_policies", "term_policies", "roster_villages", "township_gap", "region_gap",
  "elected_missing", "roster_cec_gap", "district_seats", "policy_elements", "deadline_due", "lineage_candidates", "handover_missing", "lineage_roles",
  "lineage_links", "career_sources", "withdrawn_filing", "party_gap", "party_roster", "party_info", "placeholder_politicians", "election_results", "owner_mismatch",
] as const;
export const BRANCH_COLS = "task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text";
export const GAP_COLS = ["task_id", "task_type", "target", "what_we_need", "hint_sources", "reward", "region"] as const;

export type GapRow = {
  task_id: string; task_type: string; target: Record<string, unknown> | null; what_we_need: string; hint_sources: string[]; reward: number; region: string | null;
};
export type Election = { id: number; election_key: string; election_date: string; election_reason: string; election_types: string[]; notice_date?: string | null };
export type Scope = Record<string, unknown> & { election_id: number; election_type: string; registration_closed_on: string; list_announced_on: string };

const arr = (xs: string[]) => `ARRAY[${xs.map((x) => `'${x.replaceAll("'", "''")}'`).join(", ")}]`;

/** migration 前的資料庫：與 activity-windows.test.ts（P0）的 BASE_SCHEMA 同一套 stub，加上真的總表、總表的相依函式、28 個分支的 stub */
/** extra：28 個之外的分支名（新臂，例：補號次的 ballot_numbers）——也建一張回放表與 stub 函式，等它的 migration 以 CREATE OR REPLACE 換成真本體、跑完再換回來 */
export async function baseSchemaSql(extra: readonly string[] = []): Promise<string> {
  const officeFns = await read("20261004000005_politician_offices.sql");
  const oldArms = fnText(await read(BASE_ARMS_MIG), "contribution_auto_tasks_arms");
  const legacyArms = oldArms.replace("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()", "CREATE OR REPLACE FUNCTION legacy_arms()");
  assert(legacyArms !== oldArms);
  const oldDrop = fnText(await read(BASE_DROP_MIG), "task_dispatches_drop_applied");
  const stubs = [...ARM_BRANCHES, ...extra].map((n) =>
    `CREATE TABLE _b_${n} (${BRANCH_COLS});
CREATE FUNCTION contribution_auto_tasks_${n === "raw" ? "raw" : n}() RETURNS TABLE(${BRANCH_COLS}) LANGUAGE sql STABLE AS $$ SELECT * FROM _b_${n} $$;`
  ).join("\n");
  return `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
CREATE TABLE elections (id integer PRIMARY KEY, election_key text, election_date date, election_reason text, election_types text[], notice_date date);
CREATE TABLE sources (id bigserial PRIMARY KEY, url text);
CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text NOT NULL, record_id text NOT NULL, field text NOT NULL, old_value jsonb, new_value jsonb,
  contribution_id uuid, agent_name text, applied_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz, reverted_by text);
CREATE TABLE roster_check_scope (election_id integer NOT NULL, election_type text NOT NULL, recheck_days integer NOT NULL DEFAULT 7, enabled boolean NOT NULL DEFAULT true,
  list_announced_on date NOT NULL, registration_closed_on date NOT NULL, regions text[], qualification_review_by date, ballot_draw_on date, municipal_mayor_list_on date,
  PRIMARY KEY (election_id, election_type));
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz NOT NULL DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 1,
  queue_at timestamptz NOT NULL DEFAULT now(), task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text, refreshed_at timestamptz,
  blocked boolean NOT NULL DEFAULT false, cooling boolean NOT NULL DEFAULT false, verify_target integer);
CREATE TABLE contributions (id uuid PRIMARY KEY, status text, contribution_type text, task_id text, created_at timestamptz);
${oldDrop}
CREATE TRIGGER contributions_drop_dispatch AFTER UPDATE OF status ON contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied') EXECUTE FUNCTION task_dispatches_drop_applied();
-- seed_auto_task_queue 呼叫的、與缺口無關的東西：空殼（各自有自己的測試）
CREATE FUNCTION queue_slot(p text) RETURNS timestamptz LANGUAGE sql AS $$ SELECT timestamptz '2026-10-08 00:00:00+00' $$;
CREATE FUNCTION refresh_dispatch_blocked() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION refresh_verify_targets() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION rebalance_queue() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION contribution_queue_at(t text, k text, c timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT timestamptz '2026-10-08 00:00:00+00' $$;
${fnText(officeFns, "office_term_start")}
${fnText(officeFns, "office_term_end")}
${await latestFn("election_term_start")}
${await latestFn("election_term_end")}
-- 總表用到的兩支小函式：真的（election_id_or_null 在 20261007030000；roster_scope_covers 讀 roster_check_scope）
${await latestFn("election_id_or_null")}
${await latestFn("roster_scope_covers")}
-- 28 個分支：回放 _b_<名字>
${stubs}
-- 前一版的總表（P1 之前正式庫上的那一支，7 欄）；legacy_arms 是同一份本體的改名複本，P1 把 contribution_auto_tasks_arms 換掉之後還拿得到「改前」的輸出
${oldArms}
${legacyArms}
`;
}

export type EnvOptions = {
  elections?: Election[];
  scope?: Scope[];
  /** 分支名 → 該分支要回放的列 */
  branches?: Partial<Record<string, GapRow[] | string>>;
  /** 28 個之外的新臂分支名（見 baseSchemaSql 的 extra） */
  extraBranches?: readonly string[];
  /** 要不要套 P1（預設要）；false＝只到 P0，總表還是前一版的 7 欄 */
  applyP1?: boolean;
  /** 改壞 P1 migration 文字（還原驗證用） */
  mutateP1?: (sql: string) => string;
  /**
   * P1 之後再套的 P2 migration（一支臂一個 PR）。這些 migration 會 CREATE OR REPLACE 真的臂本體（引用 PGlite 沒有的表），
   * 所以跑的時候關掉 check_function_bodies，跑完把 restub 列的分支換回「回放 _b_<名字>」的 stub——臂內部不在 PGlite 重算
   * （各臂有自己的文字守門與正式庫快照比對），這裡測的是規則與總表。
   */
  p2?: { migs: { name: string; mutate?: (sql: string) => string }[]; restub: readonly string[] };
  /** P1 之後、P2 migration 之前要先跑的 SQL（例：優先層 #443、測試名人物隔離 #448 需要的表、函式與欄位；它們本身各有自己的測試，這裡只讓後面的 migration 跑得動） */
  afterP1Sql?: string;
  /** migration 當下的假「今天」，預設 2026-10-08（P0 回填里程碑 status 用） */
  migrationToday?: string;
};

export const ALL_POSITIONS = ["縣市長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區長", "鄉鎮市民代表", "直轄市山地原住民區民代表", "村里長"];
export const DEFAULT_ELECTIONS: Election[] = [
  { id: 4, election_key: "2022-12-18_rerun_10020", election_date: "2022-12-18", election_reason: "rerun", election_types: ["縣市長"] },
  { id: 2022, election_key: "2022-11-26_local", election_date: "2022-11-26", election_reason: "regular", election_types: ALL_POSITIONS },
  { id: 2024, election_key: "2024-01-13_national", election_date: "2024-01-13", election_reason: "regular", election_types: ["總統副總統", "立法委員"] },
  { id: 2026, election_key: "2026-11-28_local", election_date: "2026-11-28", election_reason: "regular", election_types: ALL_POSITIONS },
];
export const DEFAULT_SCOPE: Scope[] = ALL_POSITIONS.map((t) => ({ election_id: 2026, election_type: t, registration_closed_on: "2026-09-04", list_announced_on: "2026-11-17" }));

export async function buildArmsDb(o: EnvOptions = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(await baseSchemaSql(o.extraBranches ?? []));
  for (const e of o.elections ?? DEFAULT_ELECTIONS) {
    await db.exec(`INSERT INTO elections (id, election_key, election_date, election_reason, election_types, notice_date) VALUES (${e.id}, '${e.election_key}', '${e.election_date}', '${e.election_reason}', ${arr(e.election_types)}, ${e.notice_date ? `'${e.notice_date}'` : "NULL"})`);
  }
  const scope = o.scope ?? DEFAULT_SCOPE;
  if (scope.length) {
    const cols = Object.keys(scope[0]).join(", "); // 沒給的欄位走預設值（jsonb_populate_recordset 缺的鍵會變 NULL，不吃預設）
    await db.query(`INSERT INTO roster_check_scope (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::roster_check_scope, $1::jsonb)`, [JSON.stringify(scope)]);
  }
  for (const [name, rows] of Object.entries(o.branches ?? {})) {
    // 字串＝原樣的 JSON 文字（正式庫快照用：不經過 JS 解析，jsonb 裡的 0.80 不會變 0.8）；陣列＝測試自己造的列
    const text = typeof rows === "string" ? rows : rows && rows.length ? JSON.stringify(rows) : null;
    if (text && text !== "[]") await db.query(`INSERT INTO _b_${name} SELECT * FROM jsonb_populate_recordset(NULL::_b_${name}, $1::jsonb)`, [text]);
  }
  await db.exec(`SET app.activity_today = '${o.migrationToday ?? "2026-10-08"}'`);
  await db.exec(await read(P0_MIG));
  if (o.applyP1 !== false) await db.exec((o.mutateP1 ?? ((s) => s))(await read(P1_MIG)));
  if (o.afterP1Sql) await db.exec(o.afterP1Sql);
  for (const m of o.p2?.migs ?? []) await applyP2(db, (m.mutate ?? ((s) => s))(await read(m.name)), o.p2!.restub);
  await db.exec("RESET app.activity_today");
  return db;
}

/** 套一支 P2 migration：關掉 check_function_bodies 跑（它會重定義真的臂本體），跑完把 restub 的分支換回回放 stub */
export async function applyP2(db: PGlite, sql: string, restub: readonly string[]): Promise<void> {
  await db.exec("SET check_function_bodies = off");
  try {
    await db.exec(sql);
  } finally {
    await db.exec("RESET check_function_bodies");
  }
  for (const n of restub) {
    await db.exec(`CREATE OR REPLACE FUNCTION contribution_auto_tasks_${n}() RETURNS TABLE(${BRANCH_COLS}) LANGUAGE sql STABLE AS $$ SELECT * FROM _b_${n} $$`);
  }
}

/** 7 個資料欄的全欄指紋與筆數（總表新版多的 arm、opened_by 不算——比的是「派工輸出」） */
export async function armsFingerprint(db: PGlite, fn: string): Promise<{ n: number; h: string | null }> {
  const r = await db.query<{ n: number; h: string | null }>(
    `SELECT count(*)::int AS n, md5(string_agg((to_jsonb(t) - 'arm' - 'opened_by')::text, '' ORDER BY t.task_id COLLATE "C")) AS h FROM ${fn}() t`,
  );
  return r.rows[0];
}

/** 兩支總表函式的輸出逐件比（7 欄全比）：a 有 b 沒有、b 有 a 沒有各幾件 */
export async function armsDiff(db: PGlite, a: string, b: string): Promise<{ aOnly: number; bOnly: number; aN: number; bN: number }> {
  await db.exec(`DROP TABLE IF EXISTS _pa; DROP TABLE IF EXISTS _pb;
    CREATE TEMP TABLE _pa AS SELECT to_jsonb(x) - 'arm' - 'opened_by' AS j FROM ${a}() x;
    CREATE TEMP TABLE _pb AS SELECT to_jsonb(y) - 'arm' - 'opened_by' AS j FROM ${b}() y;`);
  const q = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n;
  return {
    aOnly: await q("SELECT count(*)::int AS n FROM (SELECT j FROM _pa EXCEPT SELECT j FROM _pb) d"),
    bOnly: await q("SELECT count(*)::int AS n FROM (SELECT j FROM _pb EXCEPT SELECT j FROM _pa) d"),
    aN: await q("SELECT count(*)::int AS n FROM _pa"),
    bN: await q("SELECT count(*)::int AS n FROM _pb"),
  };
}
