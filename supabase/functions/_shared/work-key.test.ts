/**
 * 工作卡鍵 work_key（migration 20261111100000_work_key.sql；docs/PLAN-dispatch-work-unit.md 第 0 期 0.1）。
 *
 *   A. PGlite 跑真的 task_work_key：每一支派工臂（activity_arm_names() 全部 43 個活動名）至少一個 task_id 樣本 → 期望的 work_key；
 *      policy_missing 與 term_policy_missing 同人同屆同鍵；指紋臂換指紋同鍵；網站請求缺政見＝自動缺口；verify 票＝母任務的鍵；寫入時觸發器填欄位
 *   B. 文字層：階梯（視圖 task_ladder_closed、task_check_cooldown_days_for）按 work_key、refresh_dispatch_blocked 的 cool_until 按 work_key、
 *      contribution_queue_tasks 的認領中多比 work_key（其餘與前一版一字不差）、簽名不變、不刪欄位
 *   C. TS：filterLeasedTasks 認 work_key（同一張卡不同任務代號別人認領中也不派；自己的不擋；過期的不擋；沒帶鍵照舊）
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { filterLeasedTasks } from "./dispatch.ts";
import { fnText, latestFn, migrationNames, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261111100000_work_key.sql";
const MIG = await readMig(MIG_NAME);

const P1 = "0000b296-7ae8-4184-b704-c69d44cb696a";
const P2 = "ffd273b3-1d4c-45d5-bf61-b5b418f87233";
const POL = "01c8a200-2fb6-4ff0-afdd-175e9a4643a9";
const LIN = "034d1292-42b7-4818-8b5d-a08c91d4d081";
const MANUAL_REQ = "11111111-1111-4111-8111-111111111111";
const MANUAL_REQ_TERM = "22222222-2222-4222-8222-222222222222";
const MANUAL_PROFILE = "33333333-3333-4333-8333-333333333333";
const MANUAL_PROGRESS = "44444444-4444-4444-8444-444444444444";
const MANUAL_OTHER = "55555555-5555-4555-8555-555555555555";
const MANUAL_GONE = "66666666-6666-4666-8666-666666666666";
const CONTRIB = "77777777-7777-4777-8777-777777777777";
const CONTRIB_ORPHAN = "88888888-8888-4888-8888-888888888888";
const CONTRIB_PAYLOAD = "99999999-9999-4999-8999-999999999999";

async function buildDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date, election_reason text);
    INSERT INTO elections VALUES (2022, '2022-11-26', 'regular'), (2024, '2024-01-13', 'regular'), (2026, '2026-11-28', 'regular');
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-11-11' $$;
    ${await latestFn("uuid_or_null")}
    ${await latestFn("election_id_or_null")}
    ${await latestFn("campaign_election_id")}
    ${await latestFn("task_rekey_arms")}
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, task_type text, target jsonb);
    CREATE TABLE contributions (id uuid PRIMARY KEY, task_id text, payload jsonb);
    ${fnText(MIG, "task_work_key_fp_arms")}
    ${fnText(MIG, "task_work_key")}
    ${fnText(MIG, "work_key_fill")}
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, target jsonb, work_key text);
    CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text NOT NULL, work_key text);
    CREATE TABLE contribution_task_leases (task_id text PRIMARY KEY, target_key text, work_key text);
    CREATE TRIGGER trg_task_dispatches_work_key BEFORE INSERT OR UPDATE OF task_id, target ON task_dispatches FOR EACH ROW EXECUTE FUNCTION work_key_fill();
    CREATE TRIGGER trg_task_checks_work_key BEFORE INSERT ON task_checks FOR EACH ROW EXECUTE FUNCTION work_key_fill();
    CREATE TRIGGER trg_task_leases_work_key BEFORE INSERT OR UPDATE OF task_id ON contribution_task_leases FOR EACH ROW EXECUTE FUNCTION work_key_fill();
    INSERT INTO contribution_tasks VALUES
      ('${MANUAL_REQ}', 'policy_missing', '{"politician_id":"${P1}","region":"新北市"}'),
      ('${MANUAL_REQ_TERM}', 'term_policy_missing', '{"politician_id":"${P1}","election_id":2024}'),
      ('${MANUAL_PROFILE}', 'profile_gap', '{"politician_id":"${P2}"}'),
      ('${MANUAL_PROGRESS}', 'progress_stale', '{"politician_id":"${P1}","policy_id":"${POL}"}'),
      ('${MANUAL_OTHER}', 'question', '{"question_id":"${POL}"}');
    INSERT INTO contributions VALUES
      ('${CONTRIB}', 'auto:policy_missing:${P1}', '{}'),
      ('${CONTRIB_PAYLOAD}', NULL, '{"task_id":"auto:profile_gap:${P2}"}'),
      ('${CONTRIB_ORPHAN}', NULL, '{}');
  `);
  return db;
}

const db = await buildDb();
const key = async (taskId: string, target: unknown = null): Promise<string | null> => {
  const r = await db.query<{ k: string | null }>("SELECT task_work_key($1, $2::jsonb) AS k", [taskId, target === null ? null : JSON.stringify(target)]);
  return r.rows[0].k;
};

// ============================================================
// A. 每支臂的樣本（task_id 長相取自正式庫 2026-11-11 的 task_dispatches／task_checks／gap_events）
// ============================================================
// [活動名（activity_arm_names）, task_id, 期望的 work_key]
const SAMPLES: Array<[string, string, string]> = [
  ["raw:policy_missing", `auto:policy_missing:${P1}`, `politician:${P1}:policies:2026`],
  ["mayor_policies", `auto:policy_missing:${P2}`, `politician:${P2}:policies:2026`],
  ["term_policies", `auto:term_policy_missing:${P1}:2024`, `politician:${P1}:policies:2024`],
  ["traffic:term_policies", `auto:term_policy_missing:${P1}:2022`, `politician:${P1}:policies:2022`],
  ["raw:profile_gap", `auto:profile_gap:${P1}`, `politician:${P1}:profile`],
  ["career_sources", `auto:profile_detail_gap:sources:${P1}`, `politician:${P1}:profile`],
  ["raw:policy_validity", `auto:policy_validity:${POL}`, `policy:${POL}:policy_validity`],
  ["raw:progress_stale", `auto:progress_stale:${POL}`, `policy:${POL}:progress_stale`],
  ["traffic:progress_stale", `auto:progress_stale:${POL}`, `policy:${POL}:progress_stale`],
  ["deadline_due", `auto:deadline_due:${POL}`, `policy:${POL}:deadline_due`],
  ["traffic:deadline_due", `auto:deadline_due:${POL}`, `policy:${POL}:deadline_due`],
  ["policy_elements", `auto:policy_elements_missing:${POL}`, `policy:${POL}:policy_elements_missing`],
  ["raw:policy_election_missing", `auto:policy_election_missing:${POL}`, `policy:${POL}:policy_election_missing`],
  ["mismatch", `auto:policy_election_mismatch:${POL}`, `policy:${POL}:policy_election_mismatch`],
  ["legacy", `auto:legacy_audit:${POL}`, `policy:${POL}:legacy_audit`],
  ["policy_dup", `auto:duplicate_policy:${P1}:85957eb3`, `auto:duplicate_policy:${P1}`],
  ["lineage_candidates", "auto:lineage_candidate:667876092780:0c7f7765", "auto:lineage_candidate:667876092780"],
  ["lineage_links", `auto:lineage_link_candidate:${LIN}:28b9acd3`, `auto:lineage_link_candidate:${LIN}`],
  ["handover_missing", `auto:handover_missing:${LIN}:1a2b3c4d`, `auto:handover_missing:${LIN}`],
  ["lineage_roles", `auto:lineage_roles_missing:${LIN}`, `auto:lineage_roles_missing:${LIN}`],
  ["lineage_status", `auto:lineage_status_stale:${LIN}:2026-11-01`, `auto:lineage_status_stale:${LIN}`],
  ["dup", `auto:duplicate_politician:${P1}|${P2}`, `auto:duplicate_politician:${P1}|${P2}`],
  ["placeholder_politicians", `auto:placeholder_politician:${P1}`, `auto:placeholder_politician:${P1}`],
  ["raw:candidacy_source_missing", "auto:candidacy_source_missing:9164", "auto:candidacy_source_missing:9164"],
  ["township_gap", "auto:candidacy_source_missing:165", "auto:candidacy_source_missing:165"],
  ["region_gap", "auto:candidacy_source_missing:166", "auto:candidacy_source_missing:166"],
  ["party_gap", "auto:candidacy_source_missing:party:10048", "auto:candidacy_source_missing:party:10048"],
  ["party_roster", "auto:candidacy_source_missing:party:9991", "auto:candidacy_source_missing:party:9991"],
  ["raw:candidate_status_stale", "auto:candidate_status_stale:9816", "auto:candidate_status_stale:9816"],
  ["not_running", "auto:not_running_recheck:117", "auto:not_running_recheck:117"],
  ["withdrawn_filing", "auto:not_running_recheck:filing:9925", "auto:not_running_recheck:filing:9925"],
  ["elected_missing", "auto:election_result_missing:cec:4ad215cf6c4ef28b25278bd1a13bc7bf:164506", "auto:election_result_missing:cec:4ad215cf6c4ef28b25278bd1a13bc7bf:164506"],
  ["election_results（人）", "auto:election_result_missing:106", "auto:election_result_missing:106"],
  ["owner_mismatch", "auto:candidacy_owner_mismatch:9904", "auto:candidacy_owner_mismatch:9904"],
  ["ballot_numbers（縣市）", "auto:candidacy_source_missing:cand_no:2026:村里長:台中市", "unit:2026:村里長:台中市:cand_no"],
  ["ballot_numbers（鄉鎮）", "auto:candidacy_source_missing:cand_no:2026:鄉鎮市長:雲林縣:麥寮鄉", "unit:2026:鄉鎮市長:雲林縣:麥寮鄉:cand_no"],
  ["ballot_numbers（分段）", "auto:candidacy_source_missing:cand_no:2026:村里長:南投縣:南投市:p1", "unit:2026:村里長:南投縣:南投市:cand_no:p1"],
  ["ballot_numbers（議員分段）", "auto:candidacy_source_missing:cand_no:2026:縣市議員:南投縣:p1", "unit:2026:縣市議員:南投縣:cand_no:p1"],
  ["ballot_numbers（重查）", "auto:candidacy_source_missing:cand_no_recheck:2026:村里長:南投縣:仁愛鄉", "unit:2026:村里長:南投縣:仁愛鄉:cand_no_recheck"],
  ["election_results（單位）", "auto:election_results_missing:2022:縣市議員:南投縣", "unit:2022:縣市議員:南投縣:election_results"],
  ["election_results（鄉鎮）", "auto:election_results_missing:2022:村里長:南投縣:中寮鄉", "unit:2022:村里長:南投縣:中寮鄉:election_results"],
  ["election_results（分段）", "auto:election_results_missing:2022:村里長:屏東縣:屏東市:p1", "unit:2022:村里長:屏東縣:屏東市:election_results:p1"],
  ["raw:roster_check", "auto:roster_check:2022:南投縣:縣市議員", "unit:2022:縣市議員:南投縣:roster_check"],
  ["roster_villages", "auto:roster_check:2026:南投縣南投市:村里長", "unit:2026:村里長:南投縣南投市:roster_check"],
  ["roster_cec_gap", "auto:roster_check:4:嘉義市:縣市長", "unit:4:縣市長:嘉義市:roster_check"],
  ["district_seats", "auto:district_seats_missing:2022:南投縣:縣市議員", "unit:2022:縣市議員:南投縣:district_seats"],
  ["party_info", "auto:party_info_missing:dissolved:290", "auto:party_info_missing:dissolved:290"],
  ["regional_stats_missing", "auto:regional_stat_missing:09007", "auto:regional_stat_missing:09007"],
  ["issue_too_broad", "auto:issue_too_broad:2026:新北市:交通", "auto:issue_too_broad:2026:新北市:交通"],
  ["manual_visitor（網站請求缺政見）", MANUAL_REQ, `politician:${P1}:policies:2026`],
  ["manual_visitor（term 型別，指定屆）", MANUAL_REQ_TERM, `politician:${P1}:policies:2024`],
  ["manual_visitor（網站請求補基本資料）", MANUAL_PROFILE, `politician:${P2}:profile`],
  ["manual_open（政見型）", MANUAL_PROGRESS, `policy:${POL}:progress_stale`],
  ["manual_open（其他型別）", MANUAL_OTHER, `task:${MANUAL_OTHER}`],
  ["manual（任務已不在）", MANUAL_GONE, `task:${MANUAL_GONE}`],
];

Deno.test("A1 每支派工臂至少一個 task_id 樣本 → 期望的 work_key", async () => {
  for (const [arm, taskId, expected] of SAMPLES) {
    assertEquals(await key(taskId), expected, `${arm}：${taskId}`);
  }
});

Deno.test("A2 樣本涵蓋 activity_arm_names() 的每一個活動名（migration 檔頭對應表的名字都在樣本裡出現）", async () => {
  // activity_arm_names() 的最新清單（20261105200000 起 43 個）；樣本的活動名取括號前的部分
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION activity_arm_names(")) defining.push(n);
  const listSql = fnText(await readMig(defining[defining.length - 1]), "activity_arm_names");
  const names = [...listSql.matchAll(/'([a-z_:]+)'/g)].map((m) => m[1]).filter((s) => s !== "text");
  assert(names.length >= 40, `activity_arm_names() 讀到 ${names.length} 個`);
  const covered = new Set(SAMPLES.map(([arm]) => arm.replace(/（.*$/, "")));
  const aliases: Record<string, string> = { "raw:roster_check": "raw:roster_check" };
  const missing = names.filter((n) => !covered.has(aliases[n] ?? n) && !n.startsWith("manual_"));
  // 沒有獨立樣本的活動名只有「名單清查收斂」那幾支已在樣本裡以 election_results／roster_* 出現；其餘不得缺
  assertEquals(missing.filter((n) => !["election_results", "manual_visitor", "manual_open"].includes(n)), [], `沒有樣本的臂：${missing.join(",")}`);
  assert(covered.has("manual_visitor") && covered.has("manual_open"));
});

Deno.test("A3 policy_missing 與 term_policy_missing 同人同屆同一張卡；不同屆、不同人不同卡", async () => {
  const a = await key(`auto:policy_missing:${P1}`);
  assertEquals(a, await key(`auto:term_policy_missing:${P1}:2026`));
  assert(a !== await key(`auto:term_policy_missing:${P1}:2024`));
  assert(a !== await key(`auto:policy_missing:${P2}`));
  assert(a !== await key(`auto:profile_gap:${P1}`), "缺政見與補基本資料是兩張卡");
});

Deno.test("A4 指紋臂換指紋同鍵（換號）；不同格不同鍵", async () => {
  for (const [arm, body] of [["duplicate_policy", P1], ["lineage_candidate", "667876092780"], ["lineage_link_candidate", LIN], ["handover_missing", LIN]]) {
    const k1 = await key(`auto:${arm}:${body}:0c7f7765`);
    assertEquals(k1, await key(`auto:${arm}:${body}:ffffffff`), arm);
    assertEquals(k1, `auto:${arm}:${body}`);
    assert(k1 !== await key(`auto:${arm}:other-block:0c7f7765`), arm);
  }
  // 長指紋（32 碼）也去掉；不是十六進位的末段不是指紋
  assertEquals(await key(`auto:lineage_candidate:abc:${"a".repeat(32)}`), "auto:lineage_candidate:abc");
  assertEquals(await key("auto:duplicate_policy:x:y"), "auto:duplicate_policy:x:y");
  // 脈絡現況的末段是截至日：換日期同鍵
  assertEquals(await key(`auto:lineage_status_stale:${LIN}:none`), await key(`auto:lineage_status_stale:${LIN}:2026-11-09`));
});

Deno.test("A5 網站請求缺政見＝自動缺口（網站請求併入缺口的前提）；指定其他屆就是那一屆的卡", async () => {
  assertEquals(await key(MANUAL_REQ), await key(`auto:policy_missing:${P1}`));
  assertEquals(await key(MANUAL_REQ), await key(`auto:term_policy_missing:${P1}:2026`));
  assertEquals(await key(MANUAL_REQ_TERM), await key(`auto:term_policy_missing:${P1}:2024`));
  assertEquals(await key(MANUAL_PROFILE), await key(`auto:profile_gap:${P2}`));
  // 任務已不在 contribution_tasks 時用傳進來的 target 也只有「型別」缺失而取不到：退回 task:<uuid>，不會誤併
  assertEquals(await key(MANUAL_GONE, { politician_id: P1 }), `task:${MANUAL_GONE}`);
});

Deno.test("A6 單位型：分段不合併、換型別不合併、鄉鎮分開", async () => {
  const base = "auto:candidacy_source_missing:cand_no:2026:村里長:南投縣:南投市";
  const k = await key(base);
  assert(k !== await key(`${base}:p1`) && await key(`${base}:p1`) !== await key(`${base}:p2`));
  assert(k !== await key("auto:candidacy_source_missing:cand_no_recheck:2026:村里長:南投縣:南投市"));
  assert(k !== await key("auto:candidacy_source_missing:cand_no:2026:村里長:南投縣:仁愛鄉"));
  assert(k !== await key("auto:election_results_missing:2026:村里長:南投縣:南投市"));
});

Deno.test("A7 verify:<貢獻 id> ＝ 母任務的 work_key；母任務在 payload；找不到母任務回 NULL；壞 id 回 NULL", async () => {
  assertEquals(await key(`verify:${CONTRIB}`), `politician:${P1}:policies:2026`);
  assertEquals(await key(`verify:${CONTRIB_PAYLOAD}`), `politician:${P2}:profile`);
  assertEquals(await key(`verify:${CONTRIB_ORPHAN}`), null);
  assertEquals(await key("verify:not-a-uuid"), null);
  assertEquals(await key(`verify:00000000-0000-4000-8000-000000000000`), null);
  assertEquals(await key(null as unknown as string), null);
});

Deno.test("A8 觸發器：task_dispatches／task_checks／contribution_task_leases 寫入時填 work_key；換號後同鍵", async () => {
  await db.exec(`
    INSERT INTO task_dispatches (task_id, target) VALUES ('auto:duplicate_policy:${P1}:aaaaaaaa', '{}'), ('verify:${CONTRIB}', NULL), ('${MANUAL_REQ}', '{}');
    INSERT INTO task_checks (task_id) VALUES ('auto:policy_missing:${P1}'), ('auto:term_policy_missing:${P1}:2026'), ('auto:weird:thing'), ('${MANUAL_GONE}');
    INSERT INTO contribution_task_leases (task_id, target_key) VALUES ('auto:policy_missing:${P1}', 'politician:${P1}');
  `);
  const d = Object.fromEntries((await db.query<{ task_id: string; work_key: string | null }>("SELECT task_id, work_key FROM task_dispatches")).rows.map((r) => [r.task_id, r.work_key]));
  assertEquals(d[`auto:duplicate_policy:${P1}:aaaaaaaa`], `auto:duplicate_policy:${P1}`);
  assertEquals(d[`verify:${CONTRIB}`], `politician:${P1}:policies:2026`);
  assertEquals(d[MANUAL_REQ], `politician:${P1}:policies:2026`);
  // 換號：同一格新指紋的新列 work_key 跟舊列相同，task_checks 按這個鍵累計就自然延續
  await db.exec(`INSERT INTO task_dispatches (task_id, target) VALUES ('auto:duplicate_policy:${P1}:bbbbbbbb', '{}')`);
  const same = await db.query<{ n: number }>(`SELECT count(DISTINCT work_key)::int AS n FROM task_dispatches WHERE task_id LIKE 'auto:duplicate_policy:%'`);
  assertEquals(same.rows[0].n, 1);
  const c = (await db.query<{ task_id: string; work_key: string }>("SELECT task_id, work_key FROM task_checks ORDER BY id")).rows;
  assertEquals(c[0].work_key, c[1].work_key, "缺政見與當屆 term 缺政見的查核同一張卡");
  assertEquals(c[2].work_key, "auto:weird:thing");
  assertEquals(c[3].work_key, `task:${MANUAL_GONE}`);
  const l = await db.query<{ work_key: string }>("SELECT work_key FROM contribution_task_leases");
  assertEquals(l.rows[0].work_key, c[0].work_key);
  // 呼叫端自己帶鍵的 task_checks 不被覆蓋
  await db.exec("INSERT INTO task_checks (task_id, work_key) VALUES ('auto:profile_gap:" + P1 + "', 'custom:key')");
  assertEquals((await db.query<{ work_key: string }>("SELECT work_key FROM task_checks ORDER BY id DESC LIMIT 1")).rows[0].work_key, "custom:key");
});

// ============================================================
// B. 文字層
// ============================================================
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

Deno.test("B1 階梯：task_ladder_closed 的 PARTITION BY work_key（找不到退回 task_id）、冷卻次序按 work_key 累計；欄位與簽名不變", async () => {
  const view = code(MIG.slice(MIG.indexOf("CREATE OR REPLACE VIEW task_ladder_closed"), MIG.indexOf("COMMENT ON VIEW task_ladder_closed")));
  assertEquals(view.split("PARTITION BY COALESCE(tc.work_key, tc.task_id)").length - 1, 2);
  assert(!view.includes("PARTITION BY tc.task_id"));
  // 視圖輸出欄位與 20261109150000 一致
  const prevView = (await readMig("20261109150000_confirmed_no_verify_check_ladder.sql"));
  assert(/SELECT task_id, max\(checks\) AS checks, min\(checked_at\) AS closed_at, max\(checked_at\) AS last_checked_at,\n\s+CASE WHEN task_id LIKE 'auto:%' THEN split_part\(task_id, ':', 2\) ELSE 'manual' END AS task_kind/.test(prevView));
  assert(/SELECT m\.task_id, c\.checks, c\.closed_at, c\.last_checked_at,\n\s+CASE WHEN m\.task_id LIKE 'auto:%' THEN split_part\(m\.task_id, ':', 2\) ELSE 'manual' END AS task_kind/.test(view));
  const fn = fnText(MIG, "task_check_cooldown_days_for");
  assert(fn.includes("(p_task_id TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ, p_id BIGINT)"));
  assertEquals(fn.split("x.work_key = one.wk").length - 1, 2);
  assert(!/x\.task_id = p_task_id/.test(fn));
  // 例外判斷仍按 task_id 前綴；其餘分支與 20261109150000 一致
  const prevFn = fnText(prevView, "task_check_cooldown_days_for");
  assertEquals(
    fn.replaceAll("x.work_key = one.wk", "x.task_id = p_task_id").replace(/FROM \(SELECT COALESCE[^\n]*\n/, "FROM (SELECT 1) AS one\n"),
    prevFn.replace(/\n\s*FROM \(SELECT 1\) AS one LEFT JOIN task_cooldown_settings s ON s\.id = 1/, "\n    FROM (SELECT 1) AS one\n    LEFT JOIN task_cooldown_settings s ON s.id = 1")
      .replace(/COMMENT ON[\s\S]*$/, "").trimEnd().replace(/\n    FROM \(SELECT 1\) AS one\n    LEFT JOIN task_cooldown_settings s ON s\.id = 1/, "\n    FROM (SELECT 1) AS one\n    LEFT JOIN task_cooldown_settings s ON s.id = 1"),
  );
});

Deno.test("B2 refresh_dispatch_blocked：cool 按 work_key 取最晚；其餘與正式庫現行（20261109210000 之後）一致、簽名不變", async () => {
  const neu = fnText(MIG, "refresh_dispatch_blocked");
  assert(neu.includes("SELECT tc.work_key, max(tc.checked_at"));
  assert(neu.includes("GROUP BY tc.work_key"));
  assert(neu.includes("LEFT JOIN cool c ON c.work_key = COALESCE(d.work_key, 'task:' || d.task_id)"));
  assert(!neu.includes("GROUP BY tc.task_id"));
  // 前一版：migration 裡 refresh_dispatch_blocked 的最後一次定義（本檔之前）
  const prev = await latestFn("refresh_dispatch_blocked", MIG_NAME);
  const norm = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  const back = neu
    .replace("SELECT tc.work_key, max(tc.checked_at", "SELECT tc.task_id, max(tc.checked_at")
    .replace("GROUP BY tc.work_key", "GROUP BY tc.task_id")
    .replace("LEFT JOIN cool c ON c.work_key = COALESCE(d.work_key, 'task:' || d.task_id)", "LEFT JOIN cool c ON c.task_id = d.task_id");
  assertEquals(norm(back), norm(prev));
  assert(!MIG.includes("DROP FUNCTION"), "不改簽名、不刪函式");
});

Deno.test("B3 contribution_queue_tasks：認領中多比 work_key，原本的條件全在（基底是正式庫現行定義，含後來用替換補上的強模型與多人任務條件）；簽名不變", async () => {
  const neu = fnText(MIG, "contribution_queue_tasks");
  assert(neu.includes("OR (d.work_key IS NOT NULL AND l.work_key = d.work_key)"));
  assert(neu.includes("l.target_key = task_target_key(d.task_id, d.target)"), "原本的 target_key 比對保留（只多擋、不少擋）");
  // 前一版（migration 裡的字面定義）的簽名與回傳欄位
  const prev = await latestFn("contribution_queue_tasks", MIG_NAME);
  const sig = (s: string) => s.slice(0, s.search(/LANGUAGE sql/)).replace(/--[^\n]*/g, "").replace(/public\./g, "").replace(/\s+/g, "").toLowerCase();
  assert(sig(neu).includes("p_typetextdefaultnull") || sig(neu).includes("p_typedefaultnull"));
  assertEquals(sig(neu).includes("returnstable(task_idtext,task_typetext,targetjsonb,what_we_needtext,hint_sourcestext[],rewardinteger,queue_attimestamptz)"), true);
  assertEquals(sig(prev).includes("returnstable(task_idtext,task_typetext,targetjsonb,what_we_needtext,hint_sourcestext[],rewardinteger,queue_attimestamptz)"), true);
  // 每一段「合格」標記、強模型待辦排除、多人任務、排序都還在
  for (const keep of ["-- >>> 合格：認領中", "-- >>> 合格：同機器交過", "-- >>> 合格：查無回報在等票", "-- >>> 合格：在途未額滿", "-- >>> 合格：提問未滿額",
    "-- >>> 合格：提問這台答過", "-- >>> 合格：裁決任務", "d.target->>'requires_tier' IS DISTINCT FROM 'strong'", "task_target_multi_person(d.target)",
    "ORDER BY d.queue_at ASC"]) {
    assert(neu.includes(keep), `少了：${keep}`);
  }
});

Deno.test("B4 只加欄位與改函式本體：不刪欄位／表、不改簽名；三張表都有 work_key 欄、觸發器與索引", () => {
  const c = code(MIG);
  assert(!/DROP\s+(TABLE|COLUMN)|ALTER TABLE [a-z_]+ DROP COLUMN/i.test(c));
  for (const t of ["task_dispatches", "task_checks", "contribution_task_leases"]) {
    assert(new RegExp(`ALTER TABLE ${t}\\s+ADD COLUMN IF NOT EXISTS work_key TEXT`).test(c), t);
  }
  assert(c.includes("CREATE TRIGGER trg_task_dispatches_work_key BEFORE INSERT OR UPDATE OF task_id, target ON task_dispatches"));
  assert(c.includes("CREATE TRIGGER trg_task_checks_work_key BEFORE INSERT ON task_checks"));
  assert(c.includes("CREATE TRIGGER trg_task_leases_work_key BEFORE INSERT OR UPDATE OF task_id ON contribution_task_leases"));
  // 回填：task_dispatches 的 queue_at 觸發器暫停、做完自我檢查
  assert(c.includes("DISABLE TRIGGER trg_task_dispatches_queue_key") && c.includes("ENABLE TRIGGER trg_task_dispatches_queue_key"));
  assert(c.includes("RAISE EXCEPTION 'work_key 回填動到了"));
});

Deno.test("B5 檔頭對應表列出 activity_arm_names() 的每一個活動名", () => {
  const head = MIG.slice(0, MIG.indexOf("ALTER TABLE task_dispatches"));
  for (const name of ["raw:policy_missing", "mayor_policies", "term_policies", "career_sources", "raw:policy_validity", "deadline_due", "policy_elements", "mismatch", "legacy",
    "policy_dup", "lineage_candidates", "lineage_links", "handover_missing", "lineage_roles", "lineage_status", "dup", "placeholder_politicians", "party_gap", "party_roster",
    "not_running", "withdrawn_filing", "elected_missing", "owner_mismatch", "ballot_numbers", "district_seats", "party_info", "regional_stats_missing", "issue_too_broad",
    "manual_visitor", "raw:roster_check", "roster_villages", "roster_cec_gap", "township_gap", "region_gap", "traffic:term_policies", "traffic:progress_stale", "traffic:deadline_due",
    "raw:profile_gap", "raw:progress_stale", "raw:candidacy_source_missing", "raw:candidate_status_stale", "raw:policy_election_missing", "election_results"]) {
    assert(head.includes(name), `檔頭對應表缺 ${name}`);
  }
});

// ============================================================
// C. TS：租約認 work_key
// ============================================================
Deno.test("C1 filterLeasedTasks：別人認領同一張卡（不同任務代號）就排掉；自己的、過期的、沒帶鍵的照舊", () => {
  const now = new Date("2026-11-11T10:00:00Z");
  const future = "2026-11-11T10:20:00Z";
  const past = "2026-11-11T09:00:00Z";
  const tasks = [
    { task_id: "auto:term_policy_missing:p:2026", target: { politician_id: "p2" }, work_key: "politician:p:policies:2026" },
    { task_id: "auto:profile_gap:p", target: { politician_id: "p3" }, work_key: "politician:p:profile" },
    { task_id: "t3", target: {}, work_key: null },
  ];
  const leases = [{ task_id: "auto:policy_missing:p", target_key: "politician:p", work_key: "politician:p:policies:2026", agent_name: "other", leased_until: future }];
  assertEquals(filterLeasedTasks(tasks, leases, "me", now).map((t) => t.task_id), ["auto:profile_gap:p", "t3"]);
  assertEquals(filterLeasedTasks(tasks, leases, "OTHER", now).length, 3, "自己的認領不擋");
  assertEquals(filterLeasedTasks(tasks, [{ ...leases[0], leased_until: past }], "me", now).length, 3, "過期不擋");
  assertEquals(filterLeasedTasks(tasks, [{ ...leases[0], work_key: null }], "me", now).length, 3, "租約沒帶鍵：只比 target_key");
  // target_key 比對照舊
  assertEquals(filterLeasedTasks([{ task_id: "x", target: { politician_id: "p" } }], leases, "me", now).length, 0);
});
