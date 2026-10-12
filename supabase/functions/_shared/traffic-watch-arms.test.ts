/**
 * 有人看才追：「頁面有流量才開」從規則旗標（requires_traffic，#470）拆成三支流量臂 traffic:<型別>，職位層級由 traffic_watch_levels 開關
 * （migration 20261011120000_traffic_watch_arms.sql，維護者 2026-10-12）。
 *
 * A. 文字層：新總表＝前一版（20261009240100）套四處機械替換；臂名清單＝前一版多三個名字；這支是兩者的最後一版。
 * B. PGlite：環境照 village-progress-cooling.test.ts（#470 那支之後的世界），比「套這支之前／之後」的派工輸出——
 *    初值（只有村里長開）逐件相同，只有村里長那幾列換了臂名；層級開關是資料（關村里長＝回一般臂照一般規則開、開縣市長＝縣市長改看流量）。
 * C. 還原驗證：把關鍵處改壞，對應的守門要紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyP2, buildArmsDb, fnText, type GapRow, latestFn, migrationNames, mutate, P2_ER_MIG, P2_PG_MIG, P2_PR_MIG, readMig } from "./arms-pglite.ts";

const MIG = "20261011120000_traffic_watch_arms.sql";
const PREV_ARMS_MIG = "20261009240100_regional_stats_arm.sql";
const PREV_NAMES_MIG = "20261010170000_retire_single_election_result.sql";
const VILLAGE_MIG = "20261009010000_village_chief_progress_cooling.sql";
const MAN_MIG = "20261008165000_manual_tasks_as_arm.sql";
const TRAFFIC_MIG = "20261008190000_page_traffic_boost.sql";
const QP_MIG = "20261008090000_queue_priority_tiers.sql";
const MIG_SQL = await readMig(MIG);
const VIEW_SQL = await readMig("20261007150000_sources_stage2b_drop_legacy.sql");

// ============================================================
// A. 文字層
// ============================================================

/** 總表四處替換（遷移檔與守門各寫一遍；守門把前一版套同樣的替換，必須等於遷移檔的新定義） */
export function mechanicalArms(prev: string): string {
  let s = prev;
  s = mutate(s,
    "       needs_etype AS MATERIALIZED (SELECT DISTINCT r.activity FROM activity_rules r WHERE r.enabled AND (r.except_election_types IS NOT NULL OR r.election_types IS NOT NULL)),\n       -- <<< 村里長進度\n",
    "       needs_etype AS MATERIALIZED (SELECT DISTINCT r.activity FROM activity_rules r WHERE r.enabled AND (r.except_election_types IS NOT NULL OR r.election_types IS NOT NULL)\n" +
      "                                    -- >>> 有人看才追：來源臂一律補職位（要照職位決定歸不歸流量臂）\n" +
      "                                    UNION SELECT s.arm FROM unnest(traffic_watch_source_arms()) AS s(arm)\n" +
      "                                    -- <<< 有人看才追\n" +
      "                                   ),\n       -- <<< 村里長進度\n");
  s = mutate(s, "       keyed AS (\n  SELECT g.*, election_id_or_null", "       keyed0 AS (\n  SELECT g.*, election_id_or_null");
  s = mutate(s, "    FROM tagged g\n       ),\n       opened AS (",
    "    FROM tagged g\n       ),\n" +
      "       -- >>> 有人看才追：來源臂裡、職位在 traffic_watch_levels 開著的列，改歸流量臂 traffic:<型別>（task_id、內容一個字不變，只換臂名）；其餘照舊\n" +
      "       traffic_levels AS MATERIALIZED (SELECT l.election_type FROM traffic_watch_levels l WHERE l.enabled),\n" +
      "       keyed AS (\n" +
      "  SELECT CASE WHEN k.arm = ANY (traffic_watch_source_arms()) AND k.etype IN (SELECT t.election_type FROM traffic_levels t)\n" +
      "              THEN traffic_watch_arm(k.arm) ELSE k.arm END AS arm,\n" +
      "         k.task_id, k.task_type, k.target, k.what_we_need, k.hint_sources, k.reward, k.region, k.eid, k.etype\n" +
      "    FROM keyed0 k\n       ),\n" +
      "       -- <<< 有人看才追\n       opened AS (");
  s = mutate(s,
    ", o.open_until,\n         COALESCE((SELECT r.requires_traffic FROM activity_rules r WHERE r.id = o.rule_id), false) AS requires_traffic  -- 這條規則要不要「該列的人物頁或政見頁在 page_traffic_hot」才算開\n",
    ", o.open_until\n");
  s = mutate(s, "'traffic_gate', CASE WHEN o.requires_traffic THEN true END", "'traffic_gate', CASE WHEN g.arm LIKE 'traffic:%' THEN true END");
  s = mutate(s,
    "    -- >>> 流量開窗：窗口有開（o.source），而且規則要流量時，這一列的人物頁或政見頁要在 page_traffic_hot；沒開的列照舊（旗標 gap.arms_all 開著時留下，opened_by 是 NULL）\n    CROSS JOIN LATERAL (SELECT o.source IS NOT NULL AND (NOT o.requires_traffic OR EXISTS (",
    "    -- >>> 流量開窗：窗口有開（o.source），而且是流量臂（traffic:）時，這一列的人物頁或政見頁要在 page_traffic_hot；沒開的列照舊（旗標 gap.arms_all 開著時留下，opened_by 是 NULL）\n    CROSS JOIN LATERAL (SELECT o.source IS NOT NULL AND (g.arm NOT LIKE 'traffic:%' OR EXISTS (");
  return s;
}
const TRAFFIC_ARMS = ["traffic:progress_stale", "traffic:deadline_due", "traffic:term_policies"];

const definers = async (needle: string) => {
  const out: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes(needle)) out.push(n);
  return out;
};

Deno.test("A1 總表＝前一版套四處機械替換，緊接在前一版之後、是最後一版", async () => {
  const prev = fnText(await readMig(PREV_ARMS_MIG), "contribution_auto_tasks_arms");
  assertEquals(fnText(MIG_SQL, "contribution_auto_tasks_arms"), mechanicalArms(prev));
  const d = await definers("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms(");
  assertEquals(d.slice(d.indexOf(MIG) - 1), [PREV_ARMS_MIG, MIG], "總表在這支前後又被別支重新定義：要以最新那版為底重做");
});

Deno.test("A2 臂名清單＝前一版最後多三個流量臂名，是最後一版", async () => {
  const prev = fnText(await readMig(PREV_NAMES_MIG), "activity_arm_names");
  const want = mutate(prev, "    'regional_stats_missing'\n  ]", "    'regional_stats_missing',\n" + TRAFFIC_ARMS.map((a) => `    '${a}'`).join(",\n") + "\n  ]");
  assertEquals(fnText(MIG_SQL, "activity_arm_names"), want);
  const d = await definers("CREATE OR REPLACE FUNCTION activity_arm_names(");
  assertEquals(d.slice(d.indexOf(MIG) - 1), [PREV_NAMES_MIG, MIG]);
});

Deno.test("A3 總表不再讀 requires_traffic；流量條件只看臂名", () => {
  const fn = fnText(MIG_SQL, "contribution_auto_tasks_arms");
  assert(!fn.includes("requires_traffic"));
  assertEquals(fn.split("LIKE 'traffic:%'").length - 1, 2);
});

// ============================================================
// B. PGlite
// ============================================================
type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;

const PM = "aaaaaaaa-0000-4000-8000-000000000001"; // 縣市長（2022）
const PV1 = "bbbbbbbb-0000-4000-8000-000000000001"; // 村里長（2022）
const PV2 = "bbbbbbbb-0000-4000-8000-000000000002"; // 村里長（2022）
const PV3 = "bbbbbbbb-0000-4000-8000-000000000003"; // 村里長，政見沒標屆別（職位查不到）
const PN = "cccccccc-0000-4000-8000-000000000001"; // 那一屆沒有參選紀錄
const POL_M = "11111111-0000-4000-8000-000000000001";
const POL_M2 = "11111111-0000-4000-8000-000000000002";
const POL_V1A = "22222222-0000-4000-8000-000000000001";
const POL_V1C = "22222222-0000-4000-8000-000000000003";
const POL_V2 = "22222222-0000-4000-8000-000000000004";
const POL_V3 = "22222222-0000-4000-8000-000000000005";
const POL_N = "33333333-0000-4000-8000-000000000001";

const G = (id: string, type: string, target: Record<string, unknown> | null): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h"], reward: 1, region: "台北市" });
const prog = (policy: string, politician: string, election: number | null) =>
  G(`progress_stale:${policy}`, "progress_stale", { policy_id: policy, policy_title: "t", politician_id: politician, name: "n", region: "r", election_id: election });
const due = (policy: string, politician: string, election: number | null) =>
  G(`deadline_due:${policy}`, "deadline_due", { policy_id: policy, policy_title: "t", politician_id: politician, name: "n", region: "r", election_id: election });

const TERM_V = `term_policy_missing:${PV1}:2022`;
const TERM_M = `term_policy_missing:${PM}:2022`;
const FIXTURE = {
  raw: [
    prog(POL_M, PM, 2022), prog(POL_V1A, PV1, 2022), prog(POL_V2, PV2, 2022), prog(POL_V3, PV3, null), prog(POL_N, PN, 2022),
    G(`policy_missing:${PV1}`, "policy_missing", { politician_id: PV1, name: "n", election_id: 2026, election_type: "村里長" }),
  ],
  deadline_due: [due(POL_M2, PM, 2022), due(POL_V1C, PV1, 2022)],
  term_policies: [
    G(TERM_V, "term_policy_missing", { politician_id: PV1, name: "n", election_id: 2022, election_type: "村里長" }),
    G(TERM_M, "term_policy_missing", { politician_id: PM, name: "n", election_id: 2022, election_type: "縣市長" }),
  ],
};
const VILLAGE = [`progress_stale:${POL_V1A}`, `progress_stale:${POL_V2}`, `deadline_due:${POL_V1C}`, TERM_V];
const MAYOR = [`progress_stale:${POL_M}`, `deadline_due:${POL_M2}`, TERM_M];
const RESTUB = ["raw", "election_results", "party_gap", "party_roster", "ballot_numbers", "regional_stats_missing"] as const;

/** #470 那支之後的世界（照 village-progress-cooling.test.ts 的環境，只留總表要的） */
async function buildDb(): Promise<Db> {
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
    branches: FIXTURE,
    extraBranches: ["ballot_numbers", "regional_stats_missing"],
    afterP1Sql: pre,
    p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }, { name: MAN_MIG }], restub: RESTUB },
  });
  await applyP2(db, await readMig(TRAFFIC_MIG), RESTUB);
  await db.exec(`
    INSERT INTO politicians VALUES ('${PM}', '縣', NULL), ('${PV1}', '里一', NULL), ('${PV2}', '里二', NULL), ('${PV3}', '里三', NULL), ('${PN}', '無', NULL);
    INSERT INTO politician_elections (id, politician_id, election_id, election_type) VALUES (1, '${PM}', 2022, '縣市長'), (2, '${PV1}', 2022, '村里長'), (3, '${PV2}', 2022, '村里長'), (4, '${PV3}', 2022, '村里長');`);
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

const openArms = async (db: Db) =>
  new Map((await rows<{ task_id: string; arm: string }>(db, `SELECT task_id, arm FROM contribution_auto_tasks_arms()`)).map((r) => [r.task_id.replace(/^auto:/, ""), r.arm]));
const traffic = (db: Db, rs: Array<{ kind: string; target_id: string; users: number }>) =>
  db.query(`SELECT replace_page_traffic($1::jsonb, $2)`, [JSON.stringify(rs.map((r) => ({ views: r.users, ...r }))), 7]);
const SCENARIOS: Record<string, Array<{ kind: string; target_id: string; users: number }>> = {
  none: [],
  hot_person: [{ kind: "politician", target_id: PV1, users: 5 }],
  hot_policy: [{ kind: "policy", target_id: POL_V2, users: 9 }],
  below_threshold: [{ kind: "politician", target_id: PV1, users: 4 }],
  hot_mayor: [{ kind: "politician", target_id: PM, users: 5 }],
};
async function snapshot(db: Db): Promise<Record<string, Map<string, string>>> {
  const out: Record<string, Map<string, string>> = {};
  for (const [k, rs] of Object.entries(SCENARIOS)) {
    await db.exec("BEGIN");
    try {
      await traffic(db, rs);
      out[k] = await openArms(db);
    } finally {
      await db.exec("ROLLBACK");
    }
  }
  return out;
}

async function inTx<T>(db: Db, f: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try {
    return await f();
  } finally {
    await db.exec("ROLLBACK");
  }
}
const sameKeys = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a.keys()].every((k) => b.has(k));

Deno.test({ name: "B 派工輸出逐件不變、只換臂名；層級開關是資料；seed 寫流量臂", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const db = await buildDb();
  const before = await snapshot(db);
  // 前提：#470 的世界裡，村里長沒流量關著、有流量開著
  assert(!before.none.has(VILLAGE[0]) && before.hot_person.has(VILLAGE[0]) && before.hot_policy.has(`progress_stale:${POL_V2}`));
  await applyP2(db, MIG_SQL, RESTUB);
  const after = await snapshot(db);

  for (const k of Object.keys(SCENARIOS)) {
    assert(sameKeys(before[k], after[k]), `情境 ${k}：開著的任務變了（之前 ${[...before[k].keys()].sort()}；之後 ${[...after[k].keys()].sort()}）`);
    for (const [id, arm] of after[k]) {
      if (VILLAGE.includes(id)) assert(arm.startsWith("traffic:"), `${id} 應該歸流量臂，實際 ${arm}`);
      else assertEquals(arm, before[k].get(id), `${id} 的臂名不該變`);
    }
  }
  assertEquals(after.hot_person.get(`progress_stale:${POL_V1A}`), "traffic:progress_stale");
  assertEquals(after.hot_person.get(`deadline_due:${POL_V1C}`), "traffic:deadline_due");
  assertEquals(after.hot_person.get(TERM_V), "traffic:term_policies");
  // 職位查不到的（沒標屆別、那一屆沒有參選紀錄）照舊留在一般臂、開著
  assertEquals(after.none.get(`progress_stale:${POL_V3}`), "raw:progress_stale");
  assertEquals(after.none.get(`progress_stale:${POL_N}`), "raw:progress_stale");

  // 關掉村里長：村里長的列回一般臂，照一般規則開（不看流量）
  await inTx(db, async () => {
    await db.exec(`UPDATE traffic_watch_levels SET enabled = false WHERE election_type = '村里長'`);
    const a = await openArms(db);
    for (const id of VILLAGE) assert(a.has(id) && !a.get(id)!.startsWith("traffic:"), `關掉村里長後 ${id} 應該回一般臂開著，實際 ${a.get(id)}`);
  });
  // 打開縣市長：縣市長的列改看流量
  await inTx(db, async () => {
    await db.exec(`UPDATE traffic_watch_levels SET enabled = true WHERE election_type = '縣市長'`);
    const a = await openArms(db);
    for (const id of MAYOR) assert(!a.has(id), `打開縣市長後 ${id} 沒流量應該關著`);
    await traffic(db, SCENARIOS.hot_mayor);
    const b = await openArms(db);
    for (const id of MAYOR) assert(b.get(id)?.startsWith("traffic:"), `縣市長有流量後 ${id} 應該在流量臂開著，實際 ${b.get(id)}`);
  });
  // 層級開關有審計
  await inTx(db, async () => {
    await db.exec(`UPDATE traffic_watch_levels SET enabled = true WHERE election_type = '鄉鎮市長'`);
    const n = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM edit_history WHERE table_name = 'traffic_watch_levels' AND agent_name = 'activity-audit'`);
    assert(n[0].n >= 10, "九列種子＋一次修改都要進 edit_history");
  });
  // seed：沒流量時收回；有流量重新出生，opened_by 帶流量臂名與 traffic_gate；流量退了下一輪照 window 收回
  // （已經在派工列裡的列，seed 不改寫 opened_by，所以先跑一輪沒流量的，對應正式庫現況：村里長的這幾列今天都不在派工列）
  await inTx(db, async () => {
    await db.exec(`SELECT seed_auto_task_queue()`);
    await traffic(db, SCENARIOS.hot_person);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const d = await rows<{ arm: string; gate: boolean; rule: number }>(db,
      `SELECT opened_by->>'arm' AS arm, (opened_by->>'traffic_gate')::boolean AS gate, (opened_by->>'rule_id')::int AS rule FROM task_dispatches WHERE task_id = $1`, [`auto:progress_stale:${POL_V1A}`]);
    assertEquals(d[0], { arm: "traffic:progress_stale", gate: true, rule: 45 });
    await traffic(db, []);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const r = await rows<{ reason: string }>(db, `SELECT reason FROM gap_events WHERE task_id = $1 AND event = 'closed' ORDER BY id DESC LIMIT 1`, [`auto:progress_stale:${POL_V1A}`]);
    assertEquals(r[0]?.reason, "window");
  });
  await db.close();
} });

// ============================================================
// C. 還原驗證：migration 自己的檢查要擋住改壞的版本
// ============================================================
const BREAKS: Array<{ why: string; from: string; to: string }> = [
  { why: "rule 45 漏改名", from: "UPDATE activity_rules SET activity = 'traffic:progress_stale'", to: "UPDATE activity_rules SET activity = 'raw:progress_stale'" },
  { why: "流量臂規則留著 requires_traffic", from: "SET activity = 'traffic:deadline_due', election_types = NULL, requires_traffic = false", to: "SET activity = 'traffic:deadline_due', election_types = NULL, requires_traffic = true" },
  { why: "一般那三條沒拿掉排除職位", from: "UPDATE activity_rules SET except_election_types = NULL,", to: "UPDATE activity_rules SET except_election_types = except_election_types," },
  { why: "臂名清單漏一個流量臂", from: "    'traffic:term_policies'\n  ]", to: "    'term_policies'\n  ]" },
  { why: "主控台時期漏一列", from: "  ('traffic:deadline_due', 6, '有人看才追：到期檢查'),\n", to: "" },
  { why: "層級初值多開一個職位", from: "SELECT t, t = '村里長',", to: "SELECT t, t IN ('村里長', '縣市長')," },
];
for (const b of BREAKS) {
  Deno.test({ name: `C 還原驗證：${b.why} → migration 要失敗`, sanitizeResources: false, sanitizeOps: false, fn: async () => {
    const db = await buildDb();
    let failed = false;
    try {
      await applyP2(db, mutate(MIG_SQL, b.from, b.to), RESTUB);
    } catch {
      failed = true;
    }
    await db.close();
    assert(failed, `改壞了（${b.why}）migration 還是跑得過`);
  } });
}
