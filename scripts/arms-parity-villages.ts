/**
 * 村里長不主動追進度＋查無公開進度冷卻遞增＋標籤（migration 20261009010000_village_chief_progress_cooling.sql，#470）
 * 對正式庫的「今天輸出逐件不變」比對與耗時（2026-10-08，docs/PLAN-task-activation.md 第 11 節）。
 *
 * 不進 CI（要連正式庫）；只讀：SQL 第一行 SET default_transaction_read_only = on，新定義以子查詢原樣執行（函式呼叫就地換成函式本體、
 * 還沒上線的設定表與規則欄位用 CTE 替身），不建立任何物件。
 *   parity：
 *     ① 總表：現行 contribution_auto_tasks_arms()（正式庫最新定義）vs migration 裡的新定義（activity_open 也用新本體、規則表換成帶新欄位的替身：
 *        raw:progress_stale、deadline_due、term_policies 三條 P1「永遠開」規則加排除村里長，另加三條「村里長、要流量」規則），旗標 gap.arms_all 關著與開著各比一次：雙向 EXCEPT ALL。
 *        被收回的（舊有新沒有）按臂與任務型別列出：進度追蹤兩支臂今天預期 0 件；term_policies（補該屆政見 term_policy_missing，維護者 10-08 追加先停）只准收回村里長的列，件數逐一列出；新有舊沒有必須是 0
 *     ② 冷卻：現行 refresh_dispatch_blocked 的冷卻集合（task_checks）vs 新天數函式（設定表初值 14／30／progress_stale、deadline_due）：
 *        不同的任務逐件列出，必須全是「進度追蹤類、有第二次起的 not_found」
 *     ③ 標籤：新函式 policy_no_public_progress 對全部政見跑一遍，列出標上的件數與任務
 *   time：總表整體 EXPLAIN (ANALYZE) 現行 vs 新定義；冷卻集合現行 vs 新；標籤對全部政見
 *
 * 用法：
 *   deno run --node-modules-dir=none --allow-read --allow-write --allow-run --allow-net --allow-env scripts/arms-parity-villages.ts parity [改壞的 migration 路徑]
 *   deno run --node-modules-dir=none --allow-read --allow-write --allow-run --allow-net --allow-env scripts/arms-parity-villages.ts time [次數]
 *   parity 的第二個參數：改壞的 migration 路徑——還原驗證用，對它必須是紅的（結束碼 1）；加 --also-term 做 ④
 */
import { fnText, readMig } from "../supabase/functions/_shared/arms-pglite.ts";

const MIG = "20261009010000_village_chief_progress_cooling.sql";
const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";
const AC = `${COLS}, arm, opened_by`;
const bodyOf = (s: string) => {
  const m = /AS (\$[a-z]*\$)/.exec(s)!;
  return s.slice(s.indexOf(m[0]) + m[0].length, s.lastIndexOf(m[1])).trim();
};

const args = Deno.args.filter((a) => !a.startsWith("--"));
const [mode, arg1] = args;
if (!["parity", "time"].includes(mode)) {
  console.error("用法：arms-parity-villages.ts parity [改壞的 migration 路徑] ｜ arms-parity-villages.ts time [次數]");
  Deno.exit(2);
}
const migSql = (mode === "parity" && arg1 ? Deno.readTextFileSync(arg1) : await readMig(MIG)).replace(/\r\n/g, "\n");

/** 把 SQL 函式的呼叫就地換成函式本體（唯讀快照不能建函式；正式庫還沒有這幾支）。params 是函式的參數名（按順序） */
function inlineCall(sql: string, name: string, body: string, params: string[]): string {
  const key = `${name}(`;
  let s = sql;
  while (s.includes(key)) {
    const i = s.indexOf(key);
    let j = i + key.length;
    let depth = 1;
    while (depth) {
      if (s[j] === "(") depth++;
      if (s[j] === ")") depth--;
      j++;
    }
    const args: string[] = [];
    let cur = "";
    let d = 0;
    for (const ch of s.slice(i + key.length, j - 1)) {
      if (ch === "(") d++;
      if (ch === ")") d--;
      if (ch === "," && d === 0) { args.push(cur.trim()); cur = ""; } else cur += ch;
    }
    args.push(cur.trim());
    let b = body;
    params.map((n, k) => [n, args[k]] as const).sort((x, y) => y[0].length - x[0].length).forEach(([n, a]) => { b = b.replaceAll(n, `(${a})`); });
    s = s.slice(0, i) + `(${b})` + s.slice(j);
  }
  return s;
}
const once = (s: string, from: string, to: string) => {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`要改的字串必須剛好出現一次（${n} 次）：${from.slice(0, 60)}`);
  return s.replace(from, () => to);
};

// ── 新定義（從 migration 取，不另寫一份）────────────────────────────────
const COOL_PARAMS = ["p_task_id", "p_outcome", "p_checked_at", "p_id"];
const coolBody = bodyOf(fnText(migSql, "task_check_cooldown_days_for"));
const maxBody = bodyOf(fnText(migSql, "task_cooldown_max_days"));
const inlineCool = (sql: string) => inlineCall(inlineCall(sql, "task_cooldown_max_days", maxBody, []), "task_check_cooldown_days_for", coolBody, COOL_PARAMS);
const labelBody = inlineCool(bodyOf(fnText(migSql, "policy_no_public_progress")));
const openBody = bodyOf(fnText(migSql, "activity_open"));
const dflt = (re: RegExp) => Number(re.exec(migSql)?.[1] ?? NaN);
const FIRST = dflt(/not_found_first_days\s+INTEGER NOT NULL DEFAULT (\d+)/);
const REPEAT = dflt(/not_found_repeat_days INTEGER NOT NULL DEFAULT (\d+)/);
const TYPES = /task_types\s+TEXT\[\] NOT NULL DEFAULT ARRAY\[([^\]]+)\]/.exec(migSql)?.[1] ?? "";
if (!FIRST || !REPEAT || !TYPES) throw new Error("migration 裡找不到設定表的初值");
/** 設定表還沒上線：用 CTE 替身（初值照 migration 的 CREATE TABLE） */
const SETTINGS_CTE = `task_cooldown_settings AS (SELECT 1::smallint AS id, true AS enabled, ${FIRST} AS not_found_first_days, ${REPEAT} AS not_found_repeat_days, ARRAY[${TYPES}]::text[] AS task_types)`;

// 新總表：activity_open 呼叫換成新本體；規則表換成帶新欄位的替身
let armsNew = bodyOf(fnText(migSql, "contribution_auto_tasks_arms"));
const openCall = "FROM activity_open(k.arm, k.eid, k.etype)";
{
  let b = openBody;
  for (const [n, a] of [["p_election_type", "k.etype"], ["p_election_id", "k.eid"], ["p_activity", "k.arm"], ["p_today", "activity_today()"]] as const) b = b.replaceAll(n, `(${a})`);
  armsNew = once(armsNew, openCall, `FROM (${b}) ao`);
}
// 規則替身：P1 的兩條「永遠開」(id 5、24；以活動名認) 加排除村里長；另加兩條「村里長、要流量」（複製同一活動的規則列、改職位）
// 規則替身的內容從 migration 的規則段解析（不在腳本裡另寫一份）：哪些活動加排除、排除哪些職位、哪些活動另種「要流量」的規則
const EXCL_ACT = /UPDATE activity_rules\s+SET except_election_types = ARRAY\[([^\]]*)\],[\s\S]*?WHERE activity IN \(([^)]*)\)/.exec(migSql);
const TRAFFIC_ACT = /FROM \(VALUES ([^\n]*)\) AS a\(activity\)/.exec(migSql);
if (!EXCL_ACT || !TRAFFIC_ACT) throw new Error("migration 的規則段解析不到");
const EXCL_TYPES = EXCL_ACT[1];
const TREATED = EXCL_ACT[2];
const TRAFFIC_LIST = [...TRAFFIC_ACT[1].matchAll(/\('([^']+)'\)/g)].map((m) => `'${m[1]}'`).join(", ");
const rulesCte = (extraExcl: string[]) => `activity_rules AS (
  SELECT r0.*, CASE WHEN r0.activity IN (${TREATED}${extraExcl.map((a) => `, '${a}'`).join("")}) AND r0.window_kind = 'always' AND r0.election_types IS NULL THEN ARRAY[${EXCL_TYPES}]::text[] END AS except_election_types, false AS requires_traffic
    FROM public.activity_rules r0
  UNION ALL
  SELECT (jsonb_populate_record(NULL::public.activity_rules, to_jsonb(r1) || jsonb_build_object('id', r1.id + 100000, 'election_types', jsonb_build_array('村里長')))).*, NULL::text[] AS except_election_types, true AS requires_traffic
    FROM public.activity_rules r1 WHERE r1.activity IN (${TRAFFIC_LIST}) AND r1.window_kind = 'always' AND r1.election_types IS NULL
)`;
const withShims = (sql: string, shims: string[]) => once(sql, "WITH raw AS", `WITH ${shims.join(",\n")},\n       raw AS`);
const armsNewSql = (extraExcl: string[] = []) => withShims(armsNew, [rulesCte(extraExcl)]);

/** 對照組：現行總表＋現行 activity_open 同樣就地展開、規則表同樣換成替身（沒有新欄位）——量「就地展開與替身」本身的成本，從新定義的成本裡扣掉 */
const armsBase = await (async () => {
  let a = bodyOf(fnText(await readMig("20261008165000_manual_tasks_as_arm.sql"), "contribution_auto_tasks_arms"));
  let b = bodyOf(fnText(await readMig("20261008001000_activity_windows_p0.sql"), "activity_open"));
  for (const [n, x] of [["p_election_type", "k.etype"], ["p_election_id", "k.eid"], ["p_activity", "k.arm"], ["p_today", "activity_today()"]] as const) b = b.replaceAll(n, `(${x})`);
  a = once(a, openCall, `FROM (${b}) ao`);
  return once(a, "WITH raw AS", "WITH activity_rules AS (SELECT * FROM public.activity_rules),\n       raw AS");
})();

// 冷卻集合：現行 vs 新（refresh_dispatch_blocked 裡的 cool CTE）
const coolOld = `SELECT DISTINCT tc.task_id FROM task_checks tc
  WHERE tc.checked_at > now() - (CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days')::INTERVAL`;
const rdb = bodyOf(fnText(migSql, "refresh_dispatch_blocked"));
const coolNewCte = rdb.slice(rdb.indexOf("  , cool AS (\n") + "  , cool AS (\n".length, rdb.indexOf("\n  )\n  UPDATE task_dispatches"));
const coolNew = inlineCool(coolNewCte);

async function query(sql: string): Promise<Array<Record<string, unknown>>> {
  const f = await Deno.makeTempFile({ suffix: ".sql" });
  await Deno.writeTextFile(f, "SET default_transaction_read_only = on;\n" + sql);
  const out = await new Deno.Command(Deno.build.os === "windows" ? "npx.cmd" : "npx", { args: ["supabase", "db", "query", "--linked", "-f", f, "-o", "json"], stdout: "piped", stderr: "piped" }).output();
  await Deno.remove(f);
  const txt = new TextDecoder().decode(out.stdout);
  if (!out.success || !txt.includes("{")) {
    console.error(new TextDecoder().decode(out.stderr).slice(0, 2000) || txt.slice(0, 2000));
    Deno.exit(2);
  }
  return JSON.parse(txt.slice(txt.indexOf("{"))).rows;
}
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "：" + detail : ""}`);
  if (!ok) fails.push(name);
};

if (mode === "parity") {
  // ① 總表（旗標關／開）
  let offCount = 0;
  for (const flag of ["off", "on"]) {
    const set = flag === "on" ? "SELECT set_config('gap.arms_all', 'on', true);\n" : "";
    const [r] = await query(`${set}WITH o AS MATERIALIZED (SELECT * FROM contribution_auto_tasks_arms()),
n(${AC}) AS MATERIALIZED (${armsNewSql()})
SELECT (SELECT count(*) FROM o) AS n_old, (SELECT count(*) FROM n) AS n_new,
  (SELECT count(*) FROM (SELECT * FROM o EXCEPT ALL SELECT * FROM n) a) AS old_only,
  (SELECT count(*) FROM (SELECT * FROM n EXCEPT ALL SELECT * FROM o) b) AS new_only,
  (SELECT md5(string_agg(t::text, '|' ORDER BY t.task_id COLLATE "C", t.arm)) FROM o t) AS h_old,
  (SELECT md5(string_agg(t::text, '|' ORDER BY t.task_id COLLATE "C", t.arm)) FROM n t) AS h_new;`);
    // 旗標關著：被收回的就是村里長的 term_policy_missing（下面逐一核對件數）；旗標開著：同樣的列留在輸出裡（opened_by 變 NULL），所以只有 opened_by 不同
    check(`① 總表（gap.arms_all ${flag}）：現行 vs 新定義，新有舊沒有必須是 0`, Number(r.new_only) === (flag === "on" ? Number(r.old_only) : 0) && (flag === "on" ? r.n_old === r.n_new : Number(r.n_new) <= Number(r.n_old)),
      `${r.n_old} 件 → ${r.n_new} 件，被收回（舊有新沒有）${r.old_only}、多出（新有舊沒有）${r.new_only}，全欄雜湊 ${r.h_old === r.h_new ? "相同 " + r.h_new : "不同"}`);
    if (flag === "off") offCount = Number(r.n_old);
    else check("① 旗標開著時總表比旗標關著多回傳被規則濾掉的列（兩種模式都真的比過）", Number(r.n_old) > offCount, `${offCount} → ${r.n_old}`);
  }
  // 被收回的件數與類型（舊有新沒有；旗標關著＝實際派得出去的）
  const recalled = await query(`WITH o AS MATERIALIZED (SELECT * FROM contribution_auto_tasks_arms()),
n(${AC}) AS MATERIALIZED (${armsNewSql()})
SELECT t.arm, t.task_type, count(*) AS n FROM (SELECT task_id, task_type, arm FROM o EXCEPT SELECT task_id, task_type, arm FROM n) t GROUP BY 1, 2 ORDER BY 1, 2;`);
  check("① 進度追蹤兩支臂（progress_stale、deadline_due）被收回的任務", recalled.filter((r) => r.arm !== "term_policies").length === 0, recalled.filter((r) => r.arm !== "term_policies").length === 0 ? "0 件" : recalled.map((r) => `${r.arm}／${r.task_type} ${r.n} 件`).join("、"));
  // term_policies：收回的每一件都必須是村里長（target.election_type），而且村里長的列全部收回（沒有流量達標的頁面時）
  const [tv] = await query(`WITH o AS MATERIALIZED (SELECT * FROM contribution_auto_tasks_arms()),
n(${AC}) AS MATERIALIZED (${armsNewSql()})
SELECT (SELECT count(*) FROM o WHERE arm = 'term_policies') AS term_old,
       (SELECT count(*) FROM o WHERE arm = 'term_policies' AND target->>'election_type' = '村里長') AS term_village_old,
       (SELECT count(*) FROM n WHERE arm = 'term_policies') AS term_new,
       (SELECT count(*) FROM n WHERE arm = 'term_policies' AND target->>'election_type' = '村里長') AS term_village_new,
       (SELECT count(*) FROM (SELECT task_id FROM o WHERE arm = 'term_policies' EXCEPT SELECT task_id FROM n WHERE arm = 'term_policies') x
         JOIN o ON o.task_id = x.task_id AND o.arm = 'term_policies' WHERE o.target->>'election_type' IS DISTINCT FROM '村里長') AS recalled_non_village,
       (SELECT count(*) FROM page_traffic_hot) AS hot_pages;`);
  const termRecalled = Number(tv.term_village_old) - Number(tv.term_village_new);
  check("① term_policies：村里長的列全部收回（流量達標的頁面除外），沒有非村里長被收回", Number(tv.recalled_non_village) === 0 && Number(tv.term_new) === Number(tv.term_old) - termRecalled && (Number(tv.term_village_new) === 0 || Number(tv.hot_pages) > 0),
    `term_policy_missing 現行 ${tv.term_old} 件（村里長 ${tv.term_village_old}）→ 新 ${tv.term_new} 件（村里長 ${tv.term_village_new}），收回村里長 ${termRecalled} 件；page_traffic_hot 目前 ${tv.hot_pages} 頁`);
  // 進度追蹤兩支臂各職位現況（新定義的職位補查）
  const dist = await query(`WITH n(${AC}) AS MATERIALIZED (${armsNewSql()}),
 p AS (SELECT n.arm, n.task_type, (SELECT string_agg(DISTINCT pe.election_type, ',') FROM politician_elections pe
         WHERE pe.politician_id::text = n.target->>'politician_id' AND pe.election_id::text = n.target->>'election_id') AS etypes FROM n WHERE n.arm IN ('raw:progress_stale', 'deadline_due'))
SELECT arm, coalesce(etypes, '(職位未知)') AS etypes, count(*) AS n FROM p GROUP BY 1, 2 ORDER BY 1, 2;`);
  console.log("  進度追蹤兩支臂現在派得出去的（職位來自該屆參選紀錄）：" + dist.map((r) => `${r.arm}／${r.etypes} ${r.n}`).join("、"));
  // 村里長的列是否真的存在於舊輸出：這個數字是 0 才解釋得了「0 件被收回」
  const [vill] = await query(`WITH o AS MATERIALIZED (SELECT * FROM contribution_auto_tasks_arms())
SELECT count(*) FILTER (WHERE o.arm IN ('raw:progress_stale', 'deadline_due')) AS prog_rows,
       count(*) FILTER (WHERE o.arm IN ('raw:progress_stale', 'deadline_due') AND EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.politician_id::text = o.target->>'politician_id' AND pe.election_type = '村里長')) AS prog_village_people,
       (SELECT count(*) FROM policies pl WHERE pl.removed_at IS NULL AND EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.politician_id = pl.politician_id AND pe.election_type = '村里長')) AS village_people_policies
  FROM o;`);
  console.log(`  現行總表的進度追蹤 ${vill.prog_rows} 件，其中屬於「有村里長參選紀錄的人」的 ${vill.prog_village_people} 件；有村里長參選紀錄的人名下共有 ${vill.village_people_policies} 條政見`);

  // ② 冷卻
  const diff = await query(`WITH ${SETTINGS_CTE},
 o AS (${coolOld}),
 n AS (${coolNew}),
 d AS (SELECT task_id, 'old_only' AS side FROM (SELECT * FROM o EXCEPT SELECT * FROM n) a UNION ALL SELECT task_id, 'new_only' FROM (SELECT * FROM n EXCEPT SELECT * FROM o) b)
SELECT d.task_id, d.side, (SELECT count(*) FROM task_checks x WHERE x.task_id = d.task_id AND x.outcome = 'not_found') AS nf,
       (SELECT max(x.checked_at)::text FROM task_checks x WHERE x.task_id = d.task_id) AS last_check,
       (SELECT count(*) FROM o) AS n_old, (SELECT count(*) FROM n) AS n_new FROM d ORDER BY 1;`);
  const [cnt] = await query(`WITH ${SETTINGS_CTE}, o AS (${coolOld}), n AS (${coolNew}) SELECT (SELECT count(*) FROM o) AS n_old, (SELECT count(*) FROM n) AS n_new;`);
  check("② 冷卻集合：只有「進度追蹤類、有第二次起 not_found」的任務不同，而且只會變長", diff.every((r) => /^auto:(progress_stale|deadline_due):/.test(String(r.task_id)) && r.side === "new_only" && Number(r.nf) >= 2),
    `${cnt.n_old} 件 → ${cnt.n_new} 件，不同 ${diff.length} 件${diff.length ? "：" + diff.map((r) => `${String(r.task_id).replace(/^auto:/, "").slice(0, 40)}（not_found ${r.nf} 次，最近一次 ${String(r.last_check).slice(0, 10)}）`).join("、") : ""}`);

  // ②b 同一批查核紀錄，往後看 0～45 天每一天的冷卻集合：新舊的差異只能出在「進度追蹤類、有第二次起 not_found」的任務，而且只會變長（今天看不出差別，因為那兩件第二次查無都還在 14 天內）
  const atK = (c: string) => c.replaceAll("now()", "(now() + make_interval(days => d.k))");
  const future = await query(`WITH ${SETTINGS_CTE}, days AS (SELECT generate_series(0, 45) AS k),
 o AS (SELECT d.k, x.task_id FROM days d CROSS JOIN LATERAL (${atK(coolOld)}) x),
 n AS (SELECT d.k, x.task_id FROM days d CROSS JOIN LATERAL (${atK(coolNew)}) x),
 d2 AS (SELECT k, task_id, 'old_only' AS side FROM (SELECT * FROM o EXCEPT SELECT * FROM n) a UNION ALL SELECT k, task_id, 'new_only' FROM (SELECT * FROM n EXCEPT SELECT * FROM o) b)
SELECT task_id, side, min(k) AS first_day, max(k) AS last_day, count(*) AS days, (SELECT count(*) FROM o) AS o_rows, (SELECT count(*) FROM n) AS n_rows FROM d2 GROUP BY task_id, side ORDER BY 1;`);
  check("②b 往後 0～45 天：冷卻集合的差異只有「進度追蹤類、有第二次起 not_found」的任務，而且只會變長", future.every((r) => /^auto:(progress_stale|deadline_due):/.test(String(r.task_id)) && r.side === "new_only"),
    future.length ? future.map((r) => `${String(r.task_id).replace(/^auto:/, "").slice(0, 40)} 第 ${r.first_day}～${r.last_day} 天多冷卻 ${r.days} 天`).join("、") : "沒有差異");

  // ③ 標籤
  const lab = await query(`WITH ${SETTINGS_CTE}, l AS (SELECT p.id, ${labelBody.replace(/p_policy_id/g, "p.id").replace(/^SELECT /, "(SELECT ").replace(/\s*$/, ")")} AS v FROM policies p)
SELECT count(*) AS n_policies, count(*) FILTER (WHERE v) AS n_label FROM l;`);
  console.log(`  標籤：全部 ${lab[0].n_policies} 條政見，標上「查無公開進度」的 ${lab[0].n_label} 條（缺口還在派工列、而且有一筆還在冷卻內的 not_found）`);

  console.log(fails.length ? `\n${fails.length} 項不過` : "\n全部通過");
  Deno.exit(fails.length ? 1 : 0);
}

// time
const runs = Number(arg1 ?? 3);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const exec = (rows: Array<Record<string, unknown>>) => parseFloat(String(rows.map((r) => r["QUERY PLAN"]).find((l) => String(l).startsWith("Execution Time"))).match(/([\d.]+) ms/)![1]);
const tot = (c: string) => `SELECT count(*), sum(length(task_id)+length(target::text)+length(what_we_need)+length(coalesce(opened_by::text,''))) FROM ${c}`;
const t = { armsB: [] as number[], armsO: [] as number[], armsN: [] as number[], coolO: [] as number[], coolN: [] as number[], label: [] as number[] };
for (let i = 0; i < runs; i++) {
  t.armsO.push(exec(await query(`EXPLAIN (ANALYZE) ${tot("contribution_auto_tasks_arms()")};`)));
  t.armsB.push(exec(await query(`EXPLAIN (ANALYZE) ${tot(`(${armsBase}) z(${AC})`)};`)));
  t.armsN.push(exec(await query(`EXPLAIN (ANALYZE) ${tot(`(${armsNewSql()}) z(${AC})`)};`)));
  t.coolO.push(exec(await query(`EXPLAIN (ANALYZE) SELECT count(*) FROM (${coolOld}) x;`)));
  t.coolN.push(exec(await query(`EXPLAIN (ANALYZE) WITH ${SETTINGS_CTE} SELECT count(*) FROM (${coolNew}) x;`)));
  t.label.push(exec(await query(`EXPLAIN (ANALYZE) WITH ${SETTINGS_CTE} SELECT count(*) FILTER (WHERE v) FROM (SELECT ${labelBody.replace(/p_policy_id/g, "p.id").replace(/^SELECT /, "(SELECT ").replace(/\s*$/, ")")} AS v FROM policies p) l;`)));
}
console.log(`總表整體（毫秒，${runs} 次中位數）\t現行 ${median(t.armsO).toFixed(0)}\t現行（同樣就地展開＋規則表替身）${median(t.armsB).toFixed(0)}\t新定義（就地展開＋替身）${median(t.armsN).toFixed(0)}`);
console.log(`冷卻集合（refresh_dispatch_blocked 的 cool）\t現行 ${median(t.coolO).toFixed(1)}\t新 ${median(t.coolN).toFixed(1)}`);
console.log(`標籤（全部政見各算一次）\t${median(t.label).toFixed(1)}`);
