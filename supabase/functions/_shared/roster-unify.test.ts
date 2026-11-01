/**
 * 名單清查收斂（2026-11-01，migration 20261101020000_roster_check_unify.sql，協議 1.109.0）的守門。
 *
 * 名冊類差異（缺政黨、缺鄉鎮、缺縣市或選區、當選名單有我們沒有、結果空白或不一致、參選紀錄掛錯人、縣市長縣市不符）
 * 併進既有的 roster_check：一個單位一張，target.items 逐項列出（種類、現值、官方值、官方來源網址），原臂在開關開著時停用（分支與函式留著，可回復）。
 *
 * A. 文字層：總表＝前一版（traffic_watch_arms）套三處機械替換、是最後一版；原臂函式一個字沒動。
 * B. PGlite（世界＝traffic_watch 那支之後，原臂是回放 stub，單位清查的新函式跑真的）：
 *    finding 產生與單位歸屬、派工判準（有任一 finding 才有 findings_only 任務）、原臂停用與回復、單位已有 roster_check 時掛 items、舊任務併入關閉、縣市長縣市不符。
 * C. 還原驗證：拿掉被守的東西，對應的斷言要紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyP2, buildArmsDb, DEFAULT_ELECTIONS, fnText, type GapRow, latestFn, migrationNames, mutate, P2_ER_MIG, P2_PG_MIG, P2_PR_MIG, readMig } from "./arms-pglite.ts";

const MIG = "20261101020000_roster_check_unify.sql";
const PREV_ARMS_MIG = "20261011120000_traffic_watch_arms.sql";
const TW_MIG = PREV_ARMS_MIG;
const VILLAGE_MIG = "20261009010000_village_chief_progress_cooling.sql";
const MAN_MIG = "20261008165000_manual_tasks_as_arm.sql";
const TRAFFIC_MIG = "20261008190000_page_traffic_boost.sql";
const QP_MIG = "20261008090000_queue_priority_tiers.sql";
const MIG_SQL = await readMig(MIG);
const VIEW_SQL = await readMig("20261007150000_sources_stage2b_drop_legacy.sql");
const ROSTER_MIG = await readMig("20261031160000_cec_roster_2026.sql");
const OLD_ARMS = ["party_gap", "party_roster", "township_gap", "region_gap", "elected_missing", "election_results", "owner_mismatch"] as const;

// ============================================================
// A. 文字層
// ============================================================
/** 總表三處替換（遷移檔與守門各寫一遍；前一版套同樣的替換必須等於遷移檔的新定義） */
export function mechanicalArms(prev: string): string {
  let s = mutate(prev, "       tagged AS (\n  SELECT 'raw:' || r.task_type AS arm",
    "       -- >>> 名單清查收斂：名冊類差異按單位彙總（開關關著就不算）；原臂在開關開著時停用，單位清查掛 items（見 20261101020000）\n" +
    "       fnd AS MATERIALIZED (SELECT * FROM roster_unit_findings() WHERE roster_unify_on()),\n       -- <<< 名單清查收斂\n       tagged0 AS (\n  SELECT 'raw:' || r.task_type AS arm");
  for (const fn of OLD_ARMS) {
    s = mutate(s, `  UNION ALL SELECT '${fn}' AS arm, t.* FROM contribution_auto_tasks_${fn}() t\n`,
      `  UNION ALL SELECT '${fn}' AS arm, t.* FROM contribution_auto_tasks_${fn}() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check\n`);
  }
  const o3 = "  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM contribution_auto_tasks_regional_stats_missing() t\n       ),\n";
  return mutate(s, o3, o3 + `       -- >>> 名單清查收斂：單位已經有 roster_check（raw、roster_villages、roster_cec_gap）就掛 items；沒有、但有差異的單位開一張（findings_only）
       tagged AS (
  SELECT t0.arm, t0.task_id, t0.task_type, t0.target || COALESCE(x.extra, '{}'::JSONB) AS target,
         CASE WHEN x.extra IS NULL THEN t0.what_we_need
              ELSE t0.what_we_need || ' ' || roster_unify_text((x.extra->>'items_count')::INTEGER, COALESCE(f.voted, t0.target->>'list_source' = 'cec', false)) END AS what_we_need,
         t0.hint_sources, t0.reward, t0.region
    FROM tagged0 t0
    LEFT JOIN fnd f ON t0.task_type = 'roster_check' AND f.task_id = t0.task_id
    CROSS JOIN LATERAL (SELECT CASE WHEN t0.task_type = 'roster_check' AND roster_unify_on() THEN roster_unify_attach(t0.target, f.items, f.items_count, f.kinds) END AS extra) x
  UNION ALL
  SELECT f.arm, f.task_id, 'roster_check', f.target, f.what_we_need, f.hint_sources, 2, f.county
    FROM fnd f
   WHERE NOT EXISTS (SELECT 1 FROM tagged0 t0 WHERE t0.task_id = f.task_id)
       ),
       -- <<< 名單清查收斂
`);
}

const definers = async (needle: string) => {
  const out: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes(needle)) out.push(n);
  return out;
};

Deno.test("A1 總表＝前一版套三處機械替換，緊接在前一版之後、是最後一版", async () => {
  const prev = fnText(await readMig(PREV_ARMS_MIG), "contribution_auto_tasks_arms");
  assertEquals(fnText(MIG_SQL, "contribution_auto_tasks_arms"), mechanicalArms(prev));
  const d = await definers("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms(");
  assertEquals(d.slice(d.indexOf(MIG) - 1), [PREV_ARMS_MIG, MIG], "總表在這支前後又被別支重新定義：要以最新那版為底重做");
});

Deno.test("A2 原臂的函式一個都沒動（臂停用不刪程式）；seed、臂名清單沒重寫", () => {
  const code = MIG_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/CREATE OR REPLACE FUNCTION contribution_auto_tasks_(?!arms\()/.test(code), "這支只動總表，不重寫任何一支臂");
  assert(!code.includes("FUNCTION seed_auto_task_queue") && !code.includes("FUNCTION activity_arm_names"));
});

Deno.test("A3 協議版號與文件：skill-types 講了 target.items，protocol 不低於 1.109.0", async () => {
  const { PROTOCOL_VERSION } = await import("./protocol.ts");
  const [maj, min] = PROTOCOL_VERSION.split(".").map(Number);
  assert(maj > 1 || min >= 109);
  const md = await Deno.readTextFile(new URL("../../../public/skill-types.md", import.meta.url));
  assert(md.includes("target.items") && md.includes("findings_only"));
});

// ============================================================
// B. PGlite
// ============================================================
type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const RESTUB = ["raw", "election_results", "party_gap", "party_roster", "ballot_numbers", "regional_stats_missing"] as const;
// 2026 的投票日放遠一點：測試不能隨真實日期翻面（「已投票」只看 election_date < CURRENT_DATE）
const ELECTIONS = DEFAULT_ELECTIONS.map((e) => (e.id === 2026 ? { ...e, election_date: "2099-11-28" } : e));
const G = (id: string, type: string, target: Record<string, unknown> | null, region = "台北市"): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h"], reward: 1, region });

/** #470 那支之後的世界（照 village-progress-cooling.test.ts 的環境，只留總表要的） */
async function buildBase(branches: Record<string, GapRow[]>): Promise<Db> {
  const pre = `
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL, election_id integer, election_type text);
    CREATE TABLE policies (id uuid PRIMARY KEY, politician_id uuid NOT NULL);
    ${await latestFn("politician_name_is_placeholder")}
    ALTER TABLE elections ADD COLUMN bulletin_published_on date, ADD COLUMN bulletin_dir text;
    ALTER TABLE politicians ADD COLUMN region text, ADD COLUMN avatar_url text;
    ${await latestFn("roster_scope_milestone_date")}
    CREATE VIEW ballot_number_anomalies AS SELECT NULL::integer AS election_id, NULL::text AS election_type, NULL::text AS kind WHERE false;
    CREATE FUNCTION contribution_subject_politician(p jsonb) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::uuid $$;
    ${await latestFn("uuid_or_null")}
    ALTER TABLE contributions ADD COLUMN contributor_ip_hash text, ADD COLUMN agent_name text, ADD COLUMN payload jsonb;
    CREATE TABLE contribution_task_leases (task_id text, target_key text, leased_until timestamptz, agent_name text);
    ${await latestFn("task_target_key")}
    DROP FUNCTION queue_slot(text);
    ${await latestFn("queue_slot")}
    ${await latestFn("contribution_auto_tasks")}
    ${await latestFn("contribution_auto_task_counts")}
    ${await latestFn("task_dispatched")}
    CREATE TABLE contribution_tasks (
      id uuid PRIMARY KEY, title text NOT NULL, description text, task_type text NOT NULL, target jsonb NOT NULL DEFAULT '{}'::jsonb, region text,
      priority integer NOT NULL DEFAULT 1, reward integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'open', source text NOT NULL DEFAULT 'manual',
      suggested_by text, hint_sources text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE citizen_questions (id uuid PRIMARY KEY, stance_up integer NOT NULL DEFAULT 0, answer_count integer NOT NULL DEFAULT 0);
    CREATE OR REPLACE FUNCTION contribution_queue_at(t text, k text, c timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT queue_slot('verify') $$;
    ${await readMig(QP_MIG)}
    CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), agent_name text, note text, contribution_id uuid, outcome text);
    ${await latestFn("task_check_cooldown_days")}
    ${await latestFn("task_unreachable_cooldown_days")}
    ${await latestFn("refresh_dispatch_blocked", VILLAGE_MIG)}
    -- #470 的 migration 會重建 policies_with_logs：前一版視圖與它依賴的表（同 village-progress-cooling.test.ts）
    ALTER TABLE policies ADD COLUMN title text, ADD COLUMN description text, ADD COLUMN category text, ADD COLUMN status text, ADD COLUMN proposed_date date, ADD COLUMN last_updated date,
      ADD COLUMN progress integer, ADD COLUMN tags text[], ADD COLUMN ai_analysis text, ADD COLUMN support_count integer, ADD COLUMN election_id integer, ADD COLUMN ai_extracted boolean,
      ADD COLUMN ai_confidence numeric(3,2), ADD COLUMN removed_at timestamptz, ADD COLUMN removed_reason text, ADD COLUMN removed_by uuid, ADD COLUMN stance_support integer,
      ADD COLUMN stance_oppose integer, ADD COLUMN stance_priority integer, ADD COLUMN updated_at timestamptz, ADD COLUMN lineage_id uuid, ADD COLUMN origin text;
    CREATE TABLE tracking_logs (id bigserial PRIMARY KEY, date date, event text, description text, policy_id uuid, ai_extracted boolean);
    CREATE TABLE related_policies (policy_id uuid, related_policy_id uuid);
    CREATE TABLE policy_elements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), policy_id uuid, element text, stated boolean, text text, deadline_date date, source_locator text, source_url text, updated_at timestamptz);
    CREATE TABLE source_refs (target_table text, target_id text, source_id bigint, role text);
    ALTER TABLE sources ADD COLUMN title text, ADD COLUMN publisher text, ADD COLUMN source_kind text, ADD COLUMN archive_url text;
    CREATE TABLE lineages (id uuid PRIMARY KEY, title text, level text, region text, sub_region text, category text, summary text);
    CREATE FUNCTION source_brief_list(t text, i text) RETURNS json LANGUAGE sql STABLE AS $$ SELECT '[]'::json $$;
    ${VIEW_SQL.slice(VIEW_SQL.indexOf("CREATE VIEW policies_with_logs AS"), VIEW_SQL.indexOf("ALTER VIEW policies_with_logs"))};`;
  const db = await buildArmsDb({
    branches,
    elections: ELECTIONS,
    extraBranches: ["ballot_numbers", "regional_stats_missing"],
    afterP1Sql: pre,
    p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }, { name: MAN_MIG }], restub: RESTUB },
  });
  await applyP2(db, await readMig(TRAFFIC_MIG), RESTUB);
  await applyP2(db, await readMig(VILLAGE_MIG), RESTUB);
  // 規則 id 照正式庫（測試環境的序號跟正式庫不同；這支 migration 用 id＋活動名指定規則）
  await db.exec(`
    UPDATE activity_rules SET id = id + 1000;
    UPDATE activity_rules SET id = 5 WHERE activity = 'raw:progress_stale' AND except_election_types IS NOT NULL;
    UPDATE activity_rules SET id = 24 WHERE activity = 'deadline_due' AND except_election_types IS NOT NULL;
    UPDATE activity_rules SET id = 36 WHERE activity = 'term_policies' AND except_election_types IS NOT NULL;
    UPDATE activity_rules SET id = 45 WHERE activity = 'raw:progress_stale' AND requires_traffic;
    UPDATE activity_rules SET id = 46 WHERE activity = 'deadline_due' AND requires_traffic;
    UPDATE activity_rules SET id = 47 WHERE activity = 'term_policies' AND requires_traffic;`);
  const ids = await rows<{ id: number }>(db, `SELECT id FROM activity_rules WHERE id IN (5, 24, 36, 45, 46, 47)`);
  assertEquals(ids.length, 6, "#470 的六條規則對不上");
  // 主控台時期表（20261010110000 建的；這裡只要表）
  await db.exec(`CREATE TABLE console_arm_stage_map (arm text PRIMARY KEY, stage smallint NOT NULL, note text)`);
  return db;
}


const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000001`;
// 人物 → 參選紀錄（id 同號）：101 王一（2026 議員，缺政黨）、102 李二（2026 議員，缺選區）、103 張三（2022 縣市長，缺政黨）、
// 104 趙四（2022 縣市長，疑似掛錯人）、105／106 結果空白（2022 縣市長）、107 里長（2022 村里長，中山區，缺政黨）
const FIXTURE: Record<string, GapRow[]> = {
  raw: [G("roster_check:2026:台北市:縣市議員", "roster_check", { election_id: 2026, region: "台北市", election_type: "縣市議員" })],
  roster_cec_gap: [G("roster_check:2022:台北市:縣市長", "roster_check",
    { election_id: 2022, region: "台北市", county: "台北市", election_type: "縣市長", list_source: "cec", missing: [{ name: "缺甲", sub_region: null, elected: true, cand_no: 3 }] })],
  party_roster: [G("candidacy_source_missing:party:101", "candidacy_source_missing", { kind: "party_roster", politician_election_id: 101, election_id: 2026, election_type: "縣市議員", rosters: ["https://web.cec.gov.tw/api/file/x.pdf"] })],
  region_gap: [G("candidacy_source_missing:102", "candidacy_source_missing", { election_id: 2026, election_type: "縣市議員", missing: ["electoral_district"], cec_districts: ["第01選舉區"] })],
  party_gap: [
    G("candidacy_source_missing:party:103", "candidacy_source_missing", { kind: "party", politician_election_id: 103, election_id: 2022, election_type: "縣市長", cec: { party: "無黨籍", cand_no: 2, election_result: "elected" } }),
    G("candidacy_source_missing:party:107", "candidacy_source_missing", { kind: "party", politician_election_id: 107, election_id: 2022, election_type: "村里長", cec: { party: "中國國民黨", cand_no: 5, election_result: "not_elected" } }),
  ],
  owner_mismatch: [G("candidacy_owner_mismatch:104", "candidacy_owner_mismatch", { politician_election_id: 104, election_id: 2022, election_type: "縣市長", signals: [{ kind: "birth_year" }], same_name: [], cec_same_name: [] })],
  elected_missing: [G("election_result_missing:cec:2022:99", "election_result_missing", { name: "陳四", region: "台北市", election_id: 2022, election_type: "縣市長", cec_cand_id: 99, cec_theme_id: "t", same_name_politicians: 0, record_missing: true })],
  election_results: [G("election_results_missing:2022:縣市長:台北市", "election_results_missing",
    { election_id: 2022, election_type: "縣市長", region: "台北市", politician_election_ids: [105, 106] })],
};

async function buildDb(o: { mig?: (s: string) => string; branches?: Record<string, GapRow[]> } = {}): Promise<Db> {
  const db = await buildBase(o.branches ?? FIXTURE);
  await applyP2(db, await readMig(TW_MIG), RESTUB);
  await db.exec(`
    ALTER TABLE politicians ADD COLUMN IF NOT EXISTS party text, ADD COLUMN IF NOT EXISTS sub_region text, ADD COLUMN IF NOT EXISTS birth_year integer;
    ALTER TABLE politician_elections ADD COLUMN IF NOT EXISTS region_id integer, ADD COLUMN IF NOT EXISTS candidacy_status text, ADD COLUMN IF NOT EXISTS cand_no integer;
    CREATE TABLE regions (id serial PRIMARY KEY, region text, sub_region text, village text);
    ${await latestFn("cec_name_norm")}
    ${await latestFn("cec_name_key")}
    ${await latestFn("roster_name_fold")}
    ${await latestFn("roster_name_key")}
    ${ROSTER_MIG.slice(ROSTER_MIG.indexOf("-- ▼▼ SECTION: tables ▼▼"), ROSTER_MIG.indexOf("-- ▲▲ SECTION: tables ▲▲")).replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "")}
    CREATE TABLE _cm (politician_election_id integer, politician_id uuid, name text, election_id integer, election_type text, county text, town text, village text, district text,
      current_result text, cec_hits integer, cec_elected boolean, cec_cand_id integer, cec_theme_id text, cec_sub_region text, cec_village text, cec_birth_year integer);
    CREATE FUNCTION election_result_cec_matches(p_ids integer[]) RETURNS SETOF _cm LANGUAGE sql STABLE AS $$ SELECT * FROM _cm WHERE politician_election_id = ANY (p_ids) $$;
    INSERT INTO regions (id, region, sub_region, village) VALUES (1, '台北市', '第01選舉區', NULL), (2, '台北市', NULL, NULL), (3, '台北市', '中山區', NULL), (4, '台南市', NULL, NULL), (5, '雲林縣', NULL, NULL);
    INSERT INTO politicians (id, name, party, region, sub_region, birth_year) VALUES
      ('${U(101)}', '王一', NULL, '台北市', NULL, 1970), ('${U(102)}', '李二', NULL, '台北市', NULL, 1971), ('${U(103)}', '張三', '無', '台北市', NULL, 1960),
      ('${U(104)}', '趙四', NULL, '台北市', NULL, 1961), ('${U(105)}', '孫五', NULL, '台北市', NULL, 1962), ('${U(106)}', '周六', NULL, '台北市', NULL, 1963),
      ('${U(107)}', '吳里', NULL, '台北市', '中山區', 1964);
    INSERT INTO politician_elections (id, politician_id, election_id, election_type, region_id, candidacy_status) VALUES
      (101, '${U(101)}', 2026, '縣市議員', 1, 'filed'), (102, '${U(102)}', 2026, '縣市議員', 2, 'filed'),
      (103, '${U(103)}', 2022, '縣市長', 2, 'elected'), (104, '${U(104)}', 2022, '縣市長', 2, 'not_elected'),
      (105, '${U(105)}', 2022, '縣市長', 2, 'filed'), (106, '${U(106)}', 2022, '縣市長', 2, 'filed'), (107, '${U(107)}', 2022, '村里長', 3, 'elected');
    INSERT INTO _cm VALUES
      (105, '${U(105)}', '孫五', 2022, '縣市長', '台北市', NULL, NULL, NULL, NULL, 1, true, 5, 't', NULL, NULL, 1962),
      (106, '${U(106)}', '周六', 2022, '縣市長', '台北市', NULL, NULL, NULL, NULL, 1, false, 6, 't', NULL, NULL, 1963);`);
  await applyP2(db, (o.mig ?? ((s) => s))(MIG_SQL), RESTUB);
  return db;
}

type Row = { task_id: string; arm: string; task_type: string; target: Record<string, unknown>; what_we_need: string };
const armRows = async (db: Db) => await rows<Row>(db, `SELECT task_id, arm, task_type, target, what_we_need FROM contribution_auto_tasks_arms() ORDER BY task_id`);
const OLD_IDS = [
  "auto:candidacy_source_missing:party:101", "auto:candidacy_source_missing:102", "auto:candidacy_source_missing:party:103", "auto:candidacy_source_missing:party:107",
  "auto:candidacy_owner_mismatch:104", "auto:election_result_missing:cec:2022:99", "auto:election_results_missing:2022:縣市長:台北市",
];
const kindsOf = (t: Row | undefined) => ((t?.target.items ?? []) as Array<{ kind: string }>).map((i) => i.kind).sort();
const T26 = "auto:roster_check:2026:台北市:縣市議員";
const T22 = "auto:roster_check:2022:台北市:縣市長";
const TV = "auto:roster_check:2022:台北市中山區:村里長";
const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({ name: "B1 finding 產生與單位歸屬：每個單位一張，items 帶種類、現值、官方值、官方網址、舊任務編號", ...opts, fn: async () => {
  const db = await buildDb();
  const f = await rows<{ kind: string; unit: string; name: string; origin: string }>(db,
    `SELECT kind, election_id || '|' || county || town || '|' || election_type AS unit, name, origin_task_id AS origin FROM roster_diff_findings() ORDER BY 2, 1, 3`);
  const by = (u: string) => f.filter((x) => x.unit === u).map((x) => `${x.kind}:${x.name}`).sort();
  assertEquals(by("2026|台北市|縣市議員"), ["政黨:王一", "縣市:李二"]);
  assertEquals(by("2022|台北市|縣市長"), ["政黨:張三", "掛錯人:趙四", "缺人:陳四", "結果:周六", "結果:孫五"].sort());
  assertEquals(by("2022|台北市中山區|村里長"), ["政黨:吳里"]);
  const rs = await armRows(db);
  const t26 = rs.find((r) => r.task_id === T26), t22 = rs.find((r) => r.task_id === T22);
  assertEquals(kindsOf(t26), ["政黨", "縣市"]);
  // 已投票屆：原本 target.missing 的缺人也併成 items
  assertEquals(kindsOf(t22), ["政黨", "掛錯人", "缺人", "缺人", "結果", "結果"].sort());
  const item = (t22!.target.items as Array<Record<string, unknown>>).find((i) => i.name === "張三")!;
  assertEquals(item.source_url, "https://db.cec.gov.tw/ElecTable/Election");
  assertEquals((item.official as Record<string, unknown>).party, "無黨籍");
  assertEquals(item.origin_task_id, "auto:candidacy_source_missing:party:103");
  assertEquals(t22!.target.items_count, 6);
  assert(t22!.what_we_need.includes("逐項核對"));
  await db.close();
} });

Deno.test({ name: "B2 派工判準：單位有任一 finding 就有任務（沒有 roster_check 的單位另開 findings_only）；finding 清掉任務就消失", ...opts, fn: async () => {
  const db = await buildDb();
  const tv = (await armRows(db)).find((r) => r.task_id === TV);
  assert(tv, "只有政黨差異的村里長單位也要有一張清查任務");
  assertEquals([tv.arm, tv.task_type, tv.target.findings_only, tv.target.county, tv.target.township, tv.target.region], ["roster_cec_gap", "roster_check", true, "台北市", "中山區", "台北市中山區"]);
  assertEquals(kindsOf(tv), ["政黨"]);
  await db.exec(`DELETE FROM _b_party_gap WHERE task_id LIKE '%:party:107'`);
  assert(!(await armRows(db)).some((r) => r.task_id === TV), "finding 清掉後 findings_only 任務要消失");
  await db.close();
} });

Deno.test({ name: "B3 原臂停用與回復：開關開著原臂不產生任務；關掉原臂回來、單位清查不掛 items、不開 findings_only", ...opts, fn: async () => {
  const db = await buildDb();
  const on = (await armRows(db)).map((r) => r.task_id);
  for (const id of OLD_IDS) assert(!on.includes(id), `開關開著 ${id} 不該還在派工總表`);
  await db.exec(`UPDATE roster_unify_settings SET enabled = false WHERE id = 1`);
  const off = await armRows(db);
  for (const id of OLD_IDS) assert(off.some((r) => r.task_id === id), `開關關掉 ${id} 要回來`);
  assert(off.filter((r) => r.task_type === "roster_check").every((r) => !("items" in r.target)) && !off.some((r) => r.task_id === TV), "關掉後單位清查不掛 items、不開 findings_only");
  await db.close();
} });

Deno.test({ name: "B4 舊任務併入關閉：派工列收回、gap_events 記 rule_change 與併入哪一張；不相干的號次任務不動；重跑冪等", ...opts, fn: async () => {
  // 世界建好時 migration 末尾那一次 roster_unify_close_merged() 已經跑過（派工列是空的）；這裡重新放進舊任務再收一次
  const db = await buildDb();
  const keep = ["auto:candidacy_source_missing:cand_no:2026:縣市長:台北市", "auto:candidacy_source_missing:a1b2c3d4-0000-4000-8000-000000000009"];
  for (const id of [...OLD_IDS, ...keep]) await db.query(`INSERT INTO task_dispatches (task_id, task_type) VALUES ($1, 'x')`, [id]);
  const n = (await rows<{ n: number }>(db, `SELECT roster_unify_close_merged() AS n`))[0].n;
  assertEquals(n, OLD_IDS.length);
  const left = (await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id = ANY ($1) ORDER BY 1`, [[...OLD_IDS, ...keep]])).map((r) => r.task_id);
  assertEquals(left, [...keep].sort());
  const ev = await rows<{ task_id: string; reason: string; via: string; merged: string }>(db,
    `SELECT DISTINCT ON (task_id) task_id, reason, detail->>'via' AS via, detail->>'merged_into' AS merged FROM gap_events WHERE event = 'closed' AND detail->>'via' = 'roster_unify' ORDER BY task_id, id DESC`);
  assertEquals(ev.length, OLD_IDS.length);
  for (const e of ev) {
    assertEquals([e.reason, e.via], ["rule_change", "roster_unify"]);
    assertEquals(e.merged, e.task_id.endsWith(":party:101") ? T26 : e.task_id.endsWith("102") ? T26 : e.task_id.endsWith(":party:107") ? TV : T22, e.task_id);
  }
  assertEquals((await rows<{ n: number }>(db, `SELECT roster_unify_close_merged() AS n`))[0].n, 0);
  await db.exec(`UPDATE roster_unify_settings SET enabled = false WHERE id = 1`);
  await db.query(`INSERT INTO task_dispatches (task_id, task_type) VALUES ($1, 'x')`, [OLD_IDS[0]]);
  assertEquals((await rows<{ n: number }>(db, `SELECT roster_unify_close_merged() AS n`))[0].n, 0, "開關關著不收回");
  await db.close();
} });

Deno.test({ name: "B5 縣市長縣市不符：官方名冊有他而我們記的縣市沒有 → 在官方縣市的單位清查列出（附 proposed_region_id）；落庫端據此不另開任務", ...opts, fn: async () => {
  const db = await buildDb();
  await db.exec(`
    INSERT INTO politicians (id, name, region) VALUES ('${U(201)}', '吳炳輝', '台南市');
    INSERT INTO politician_elections (id, politician_id, election_id, election_type, region_id, candidacy_status) VALUES (201, '${U(201)}', 2026, '縣市長', 4, 'filed');
    INSERT INTO cec_roster_units (url, kind, election_type, county, county_code, status, fetched_at) VALUES
      ('u/yl', 'C1', '縣市長', '雲林縣', '10009', 'ok', now()), ('u/tn', 'C1', '縣市長', '臺南市', '67000', 'ok', now());
    INSERT INTO cec_roster_2026 (election_type, county_code, county, name, name_key, cand_no, unit_key, unit_url) VALUES
      ('縣市長', '10009', '雲林縣', '吳炳輝', NULL, 1, '雲林縣', 'u/yl'), ('縣市長', '67000', '臺南市', '別人', NULL, 2, '台南市', 'u/tn');`);
  const m = await rows<{ official_county: string; proposed_region_id: number; current_region_id: number }>(db, `SELECT official_county, proposed_region_id, current_region_id FROM roster_region_mismatch_findings()`);
  assertEquals(m, [{ official_county: "雲林縣", proposed_region_id: 5, current_region_id: 4 }]);
  const t = (await armRows(db)).find((r) => r.task_id === "auto:roster_check:2026:雲林縣:縣市長");
  assert(t, "官方縣市的單位要有清查任務");
  assertEquals(kindsOf(t), ["縣市"]);
  // deno-lint-ignore no-explicit-any
  assertEquals(((t.target.items as Array<Record<string, any>>)[0]).official.proposed_region_id, 5);
  assertEquals((await rows<{ b: boolean }>(db, `SELECT roster_unify_lists_region_mismatch(201, 5) AS b`))[0].b, true);
  assertEquals((await rows<{ b: boolean }>(db, `SELECT roster_unify_lists_region_mismatch(201, 99) AS b`))[0].b, false);
  // 我們記的縣市名冊過期：不算不符
  await db.exec(`UPDATE cec_roster_units SET fetched_at = now() - interval '9 days' WHERE url = 'u/tn'`);
  assertEquals((await rows(db, `SELECT 1 FROM roster_region_mismatch_findings()`)).length, 0);
  await db.close();
} });

// ============================================================
// C. 還原驗證（拿掉被守的東西，B 的斷言要不成立）
// ============================================================
Deno.test({ name: "C1 還原驗證：原臂沒加閘 → 開關開著原臂仍產生任務（B3 會紅）", ...opts, fn: async () => {
  const db = await buildDb({ mig: (s) => mutate(s, "contribution_auto_tasks_party_gap() t WHERE NOT roster_unify_on()", "contribution_auto_tasks_party_gap() t") });
  assert((await armRows(db)).some((r) => r.task_id === "auto:candidacy_source_missing:party:103"));
  await db.close();
} });

Deno.test({ name: "C2 還原驗證：沒有 roster_check 的單位不開任務 → findings_only 任務不見（B2 會紅）", ...opts, fn: async () => {
  const db = await buildDb({ mig: (s) => mutate(s, "WHERE NOT EXISTS (SELECT 1 FROM tagged0 t0 WHERE t0.task_id = f.task_id)", "WHERE false") });
  assert(!(await armRows(db)).some((r) => r.task_id === TV));
  await db.close();
} });

Deno.test({ name: "C3 還原驗證：收回不分舊臂編號 → 沒掛在 items 的號次任務仍因對不到 origin 而留下，但白名單條件拿掉後 B4 的筆數斷言不變——所以另驗正規式存在", ...opts, fn: async () => {
  assert(MIG_SQL.includes("WHERE d.task_id ~ '^auto:(candidacy_source_missing:(party:)?[0-9]+|election_results?_missing:.+|candidacy_owner_mismatch:[0-9]+)$'"));
  const db = await buildDb();
  // 號次任務編號帶 cand_no 字樣，正規式對不上
  const r = await rows<{ ok: boolean }>(db, `SELECT 'auto:candidacy_source_missing:cand_no:2026:縣市長:台北市' ~ '^auto:(candidacy_source_missing:(party:)?[0-9]+|election_results?_missing:.+|candidacy_owner_mismatch:[0-9]+)$' AS ok`);
  assertEquals(r[0].ok, false);
  await db.close();
} });

Deno.test({ name: "C4 還原驗證：總表沒把 items 掛上既有的 roster_check → B1 的斷言不成立", ...opts, fn: async () => {
  const db = await buildDb({ mig: (s) => mutate(s, "LEFT JOIN fnd f ON t0.task_type = 'roster_check' AND f.task_id = t0.task_id", "LEFT JOIN fnd f ON false") });
  const t = (await armRows(db)).find((r) => r.task_id === T26);
  assert(!t!.target.items, "改壞後既有的 roster_check 沒有 items");
  await db.close();
} });
