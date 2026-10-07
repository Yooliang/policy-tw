/**
 * 名單時程搬成里程碑（migration 20261008140000_roster_milestones.sql）前後的「逐件不變」守門（2026-10-08，docs/PLAN-task-activation.md 派工時間窗 P2）。
 *
 * 這支 migration 改的只有兩個會影響派工輸出的東西：
 *   ① candidacy_list_published()（6 支臂用它算 candidate_status 的字眼）——新舊兩個本體在正式庫唯讀快照上逐格比：
 *      （選舉×職位×日期）全格，以及 politician_elections 每一列在「今天、關鍵日」算出來的 candidate_status（candidacy_protocol_status 套新舊函式）。
 *      新本體不建立任何物件：gen 讀 migration 裡的新函式本體，把參數換成欄位名，以子查詢放進唯讀 SELECT。
 *   ② roster_check_scope 的五個日期欄——migration 回填里程碑、再由觸發器從里程碑算回欄位，所以「里程碑推回來的值＝欄位現值」逐列比
 *      （已有的登記截止／名單公告里程碑要與欄位相同；另外三個日期照回填規則算出來的里程碑，推回去也要相同；直轄市長名單日同一場選舉各列必須一致）。
 *   負向對照：把新函式的比較改成 <（名單公告當天還說沒公告），比對必須紅。
 * 另外記下 activity_health 目前是不是空的（回填的前提）與正式庫總表的筆數與雜湊（對照用）。
 *
 * 用法（不進 CI：要正式庫唯讀快照）：
 *   deno run --node-modules-dir=none --allow-read --allow-write --allow-net --allow-env scripts/roster-milestones-parity.ts gen snapshot.sql
 *   npx supabase db query --linked -f snapshot.sql -o json > snapshot.json      （檔案第一行是 SET default_transaction_read_only = on）
 *   deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/roster-milestones-parity.ts check snapshot.json
 */
import { fnText, readMig } from "../supabase/functions/_shared/arms-pglite.ts";

const MIG = "20261008140000_roster_milestones.sql";
const [mode, path] = Deno.args;
if (!["gen", "check"].includes(mode) || !path) {
  console.error("用法：roster-milestones-parity.ts gen <out.sql> ｜ roster-milestones-parity.ts check <snapshot.json>");
  Deno.exit(2);
}

const fnBody = (fn: string) => {
  const m = /AS (\$[a-z]*\$)/.exec(fn)!;
  return fn.slice(fn.indexOf(m[0]) + m[0].length, fn.lastIndexOf(m[1])).trim();
};
/** 新函式本體：參數換成欄位名，成為可以放進 SELECT 的純量子查詢 */
const asScalar = (body: string, eid: string, t: string, d: string) =>
  "(" + body.replaceAll("p_election_id", eid).replaceAll("p_election_type", t).replaceAll("p_on", d) + ")";

if (mode === "gen") {
  const body = fnBody(fnText(await readMig(MIG), "candidacy_list_published"));
  const newV = asScalar(body, "c.eid", "c.t", "g.d");
  const badLt = asScalar(body.replace("m.on_date <= p_on", "m.on_date < p_on"), "c.eid", "c.t", "g.d");
  if (badLt === newV) throw new Error("負向對照沒改到東西，migration 的函式本體變了，這支要跟著改");
  // 每一列參選紀錄在某天的 candidate_status：新舊函式各算一次
  const peDiff = (day: string) =>
    `(SELECT count(*)::int FROM politician_elections pe WHERE candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, DATE '${day}'))
        IS DISTINCT FROM candidacy_protocol_status(pe.candidacy_status, ${asScalar(body, "pe.election_id", "pe.election_type", `DATE '${day}'`)}))`;
  const keyDays = ["2026-09-04", "2026-10-08", "2026-10-16", "2026-10-23", "2026-11-12", "2026-11-16", "2026-11-17", "2026-11-28", "2026-11-29"];
  const sql = `SET default_transaction_read_only = on;
-- 名單時程搬成里程碑（20261008140000）改前改後的唯讀對照（scripts/roster-milestones-parity.ts gen 產生）
WITH cases AS (
  SELECT DISTINCT pe.election_id AS eid, pe.election_type AS t FROM politician_elections pe
  UNION SELECT s.election_id, s.election_type FROM roster_check_scope s
  UNION SELECT e.id, NULL FROM elections e
  UNION SELECT e.id, x.t FROM elections e CROSS JOIN (VALUES ('縣市長'), ('縣市議員'), ('鄉鎮市長'), ('直轄市山地原住民區長'), ('鄉鎮市民代表'), ('直轄市山地原住民區民代表'), ('村里長'), ('總統副總統'), ('立法委員')) x(t)
), days AS (
  SELECT d::date AS d FROM generate_series(DATE '2026-08-01', DATE '2026-12-31', '1 day') d
  UNION SELECT d::date FROM generate_series(DATE '2022-11-24', DATE '2022-11-28', '1 day') d
  UNION SELECT d::date FROM generate_series(DATE '2022-12-16', DATE '2022-12-20', '1 day') d
  UNION SELECT d::date FROM generate_series(DATE '2024-01-11', DATE '2024-01-15', '1 day') d
  UNION SELECT d::date FROM generate_series(DATE '2022-01-01', DATE '2030-12-31', '7 days') d
), grid AS (
  SELECT c.eid, c.t, g.d,
         candidacy_list_published(c.eid, c.t, g.d) AS old_v,
         ${newV} AS new_v,
         ${badLt} AS bad_lt
    FROM cases c CROSS JOIN days g
)
SELECT json_build_object(
  'taken_at', now(),
  'grid_cases', (SELECT count(*) FROM grid),
  'grid_true', (SELECT count(*) FROM grid WHERE old_v),
  'grid_mismatch', (SELECT count(*) FROM grid WHERE old_v IS DISTINCT FROM new_v),
  'bad_lt_mismatch', (SELECT count(*) FROM grid WHERE old_v IS DISTINCT FROM bad_lt),
  'distinct_pairs', (SELECT count(*) FROM (SELECT DISTINCT eid, t FROM cases) x),
  'pe_rows', (SELECT count(*) FROM politician_elections),
  'pe_status_diff', json_build_object(${keyDays.map((d) => `'${d}', ${peDiff(d)}`).join(", ")}),
  'scope_rows', (SELECT count(*) FROM roster_check_scope),
  'scope_vs_existing_milestones', json_build_object(
    'registration_close_missing_or_different', (SELECT count(*) FROM roster_check_scope s WHERE NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = s.election_id AND m.kind = 'registration_close' AND m.election_type = s.election_type AND m.on_date = s.registration_closed_on)),
    'list_published_missing_or_different', (SELECT count(*) FROM roster_check_scope s WHERE NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = s.election_id AND m.kind = 'list_published' AND m.election_type = s.election_type AND m.on_date = s.list_announced_on)),
    'milestone_rows_in_the_way', (SELECT count(*) FROM election_milestones m WHERE m.kind IN ('draw', 'qualification_review') OR m.election_type = '直轄市長'),
    'whole_election_rows_of_scope_kinds', (SELECT count(*) FROM election_milestones m WHERE m.election_type IS NULL AND m.kind IN ('registration_close', 'list_published', 'draw', 'qualification_review'))),
  'mayor_list_inconsistent_elections', (SELECT count(*) FROM (SELECT s.election_id FROM roster_check_scope s GROUP BY s.election_id
      HAVING count(DISTINCT s.municipal_mayor_list_on) > 1 OR (count(*) FILTER (WHERE s.municipal_mayor_list_on IS NULL) > 0 AND count(s.municipal_mayor_list_on) > 0)) x),
  'to_backfill', json_build_object(
    'draw', (SELECT count(*) FROM roster_check_scope WHERE ballot_draw_on IS NOT NULL),
    'qualification_review', (SELECT count(*) FROM roster_check_scope WHERE qualification_review_by IS NOT NULL),
    'mayor_list', (SELECT count(DISTINCT election_id) FROM roster_check_scope WHERE municipal_mayor_list_on IS NOT NULL)),
  'scope_dates', (SELECT json_agg(json_build_object('t', election_type, 'reg', registration_closed_on, 'list', list_announced_on, 'review', qualification_review_by, 'draw', ballot_draw_on, 'mayor', municipal_mayor_list_on) ORDER BY election_type) FROM roster_check_scope),
  'activity_health_rows', (SELECT count(*) FROM activity_health),
  'callers_of_candidacy_list_published', (SELECT json_agg(DISTINCT p.proname ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname <> 'candidacy_list_published' AND pg_get_functiondef(p.oid) LIKE '%candidacy_list_published%'),
  'arms_today', (SELECT json_build_object('n', count(*), 'hash', md5(string_agg((to_jsonb(t) - 'arm' - 'opened_by')::text, '' ORDER BY t.task_id COLLATE "C"))) FROM contribution_auto_tasks_arms() t)
) AS j;
`;
  Deno.writeTextFileSync(path, sql);
  console.log(`已寫出 ${path}（${sql.length} 字元）`);
  Deno.exit(0);
}

// ── check ─────────────────────────────────────────────────────────
const raw = JSON.parse(Deno.readTextFileSync(path).replace(/^﻿/, ""));
const rec = raw.rows ? raw.rows[0].j : raw;
const snap = typeof rec === "string" ? JSON.parse(rec) : rec;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "：" + detail : ""}`);
  if (!ok) fails.push(name);
}
console.log(`快照 ${snap.taken_at}：正式庫總表 ${snap.arms_today.n} 件 ${snap.arms_today.hash}；清查範圍 ${snap.scope_rows} 列、參選紀錄 ${snap.pe_rows} 列`);
check("① candidacy_list_published 新舊逐格相同", snap.grid_mismatch === 0, `${snap.grid_cases} 格（${snap.distinct_pairs} 組選舉×職位 × 各日期），其中名單已公告／已投票的 ${snap.grid_true} 格，不一致 ${snap.grid_mismatch}`);
check("① 格子裡確實有 true 也有 false（不是空對空）", snap.grid_true > 0 && snap.grid_true < snap.grid_cases);
const diffs = Object.entries(snap.pe_status_diff as Record<string, number>);
check("① 每一列參選紀錄的 candidate_status（今天與關鍵日）新舊相同", diffs.every(([, n]) => n === 0), diffs.map(([d, n]) => `${d}=${n}`).join(" "));
check("② 登記截止／名單公告的既有里程碑與欄位逐列相同（每個清查範圍列都有、日期相同）",
  snap.scope_vs_existing_milestones.registration_close_missing_or_different === 0 && snap.scope_vs_existing_milestones.list_published_missing_or_different === 0,
  JSON.stringify(snap.scope_vs_existing_milestones));
check("② 沒有擋路的既有里程碑（draw、qualification_review、直轄市長，回填前是空的）", snap.scope_vs_existing_milestones.milestone_rows_in_the_way === 0);
check("② 沒有整場（election_type 空）的名單時程里程碑（否則衍生值可能與欄位不同）", snap.scope_vs_existing_milestones.whole_election_rows_of_scope_kinds === 0);
check("② 直轄市長名單日在同一場選舉的各列一致（可以搬成一列整場里程碑）", snap.mayor_list_inconsistent_elections === 0);
const dates = snap.scope_dates as Array<Record<string, string | null>>;
check("② 回填會新增 draw／qualification_review 各一列、直轄市長名單一列", snap.to_backfill.draw === snap.scope_rows && snap.to_backfill.qualification_review === snap.scope_rows && snap.to_backfill.mayor_list === 1, JSON.stringify(snap.to_backfill));
check("② 五個日期欄現值：登記截止 2026-09-04、名單公告 2026-11-17、資格審查 2026-10-16、抽號次 2026-10-23、直轄市長名單 2026-11-12（七列相同）",
  dates.length === snap.scope_rows && dates.every((r) => r.reg === "2026-09-04" && r.list === "2026-11-17" && r.review === "2026-10-16" && r.draw === "2026-10-23" && r.mayor === "2026-11-12"));
check("③ activity_health 目前是空的（回填的前提）", snap.activity_health_rows === 0);
check("③ 呼叫 candidacy_list_published 的只有那 6 支臂", JSON.stringify(snap.callers_of_candidacy_list_published) === JSON.stringify(["contribution_auto_tasks_party_gap", "contribution_auto_tasks_party_roster", "contribution_auto_tasks_raw", "contribution_auto_tasks_region_gap", "contribution_auto_tasks_township_gap", "contribution_auto_tasks_withdrawn_filing"]),
  JSON.stringify(snap.callers_of_candidacy_list_published));
check("④ 負向對照：名單公告當天還說沒公告（<）→ 比對會紅", snap.bad_lt_mismatch > 0, `${snap.bad_lt_mismatch} 格不一致`);

console.log(fails.length === 0 ? "\n全部通過" : `\n失敗 ${fails.length} 項：${fails.join("、")}`);
if (fails.length) Deno.exit(1);
