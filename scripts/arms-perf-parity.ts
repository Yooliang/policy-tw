/**
 * 派工總表效能整理（migration 20261008180000_arms_perf.sql）對正式庫的「逐件不變」比對與耗時（2026-10-08，docs/PLAN-task-activation.md 第 11 節）。
 *
 * 不進 CI（要連正式庫）；只讀：SQL 第一行 SET default_transaction_read_only = on，新本體以子查詢原樣執行，不建立任何物件。
 *   parity：
 *     ① 每支臂：正式庫現行函式 vs migration 裡的新本體，同一個查詢快照內雙向 EXCEPT ALL（少 0 件、多 0 件）＋全欄雜湊
 *     ② 總表：現行 contribution_auto_tasks_arms()（最新定義，不是 stub）把這四支臂的呼叫換成新本體後，跟現行總表逐件比；
 *        旗標 gap.arms_all 關著（預設）與開著（seed 用，多回傳被規則濾掉的列）各比一次
 *     ③ 補充（目前資料裡 same_name 全是空的、等票數多半是 0，所以另外挑有資料的人逐筆比）：
 *        同名人物 150 位的 same_name、有政見提交的人物 200 位的等票數、全部 1.6 萬位人物的 is_2026_mayor_candidate 與 EXISTS
 *   time：每支臂「現行函式 vs 新本體」各自在 MATERIALIZED CTE 裡跑、加總全部輸出欄位（只量 count(*) 時，沒被用到的欄位會被修剪掉，量出來偏低），
 *         以及總表整體 EXPLAIN (ANALYZE) 的 Execution Time（現行 vs 新本體內嵌）
 *
 * 用法：
 *   deno run --node-modules-dir=none --allow-read --allow-write --allow-run --allow-net --allow-env scripts/arms-perf-parity.ts parity [改壞的 migration 路徑]
 *   deno run --node-modules-dir=none --allow-read --allow-write --allow-run --allow-net --allow-env scripts/arms-perf-parity.ts time [次數]
 *   parity 的第二個參數：改壞的 migration 路徑——還原驗證用，對它必須是紅的（結束碼 1）
 */
import { fnText, latestFn, readMig } from "../supabase/functions/_shared/arms-pglite.ts";

const MIG = "20261008180000_arms_perf.sql";
const ARMS = ["mayor_policies", "roster_cec_gap", "owner_mismatch", "policy_elements"] as const;
const fn = (a: string) => `contribution_auto_tasks_${a}`;
const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";
const AC = `${COLS}, arm, opened_by`;
const bodyOf = (s: string) => {
  const m = /AS (\$[a-z]*\$)/.exec(s)!;
  return s.slice(s.indexOf(m[0]) + m[0].length, s.lastIndexOf(m[1]));
};

const [mode, arg1] = Deno.args;
if (!["parity", "time"].includes(mode)) {
  console.error("用法：arms-perf-parity.ts parity [改壞的 migration 路徑] ｜ arms-perf-parity.ts time [次數]");
  Deno.exit(2);
}
const migSql = (mode === "parity" && arg1 ? Deno.readTextFileSync(arg1) : await readMig(MIG)).replace(/\r\n/g, "\n");
const NEW = Object.fromEntries(ARMS.map((a) => [a, bodyOf(fnText(migSql, fn(a)))])) as Record<(typeof ARMS)[number], string>;
// 現行總表（repo 裡最後一版；測試守門保證它就是正式庫上的那一版）
const armsBody = bodyOf(await latestFn("contribution_auto_tasks_arms"));
let armsNew = armsBody;
for (const a of ARMS) {
  const call = `FROM ${fn(a)}() t`;
  if (armsNew.split(call).length !== 2) throw new Error(`總表裡找不到唯一一處 ${call}`);
  armsNew = armsNew.replace(call, () => `FROM (${NEW[a]}) t(${COLS})`);
}

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
  // ① 每支臂
  const ctes: string[] = [];
  const sels: string[] = [];
  for (const a of ARMS) {
    ctes.push(`o_${a}(${COLS}) AS MATERIALIZED (SELECT * FROM ${fn(a)}())`, `n_${a}(${COLS}) AS MATERIALIZED (${NEW[a]})`);
    sels.push(`SELECT '${a}' AS arm, (SELECT count(*) FROM o_${a}) AS n_old, (SELECT count(*) FROM n_${a}) AS n_new,
      (SELECT count(*) FROM (SELECT * FROM o_${a} EXCEPT ALL SELECT * FROM n_${a}) x) AS old_only,
      (SELECT count(*) FROM (SELECT * FROM n_${a} EXCEPT ALL SELECT * FROM o_${a}) y) AS new_only,
      (SELECT md5(string_agg(t::text, '|' ORDER BY t.task_id COLLATE "C")) FROM o_${a} t) AS h_old,
      (SELECT md5(string_agg(t::text, '|' ORDER BY t.task_id COLLATE "C")) FROM n_${a} t) AS h_new`);
  }
  for (const r of await query(`WITH ${ctes.join(",\n")}\n${sels.join("\nUNION ALL\n")};`)) {
    check(`① ${r.arm}：現行函式 vs 新本體`, r.old_only === 0 && r.new_only === 0 && r.n_old === r.n_new && r.h_old === r.h_new, `${r.n_old} 件 → ${r.n_new} 件，舊有新沒有 ${r.old_only}、新有舊沒有 ${r.new_only}，雜湊 ${r.h_old === r.h_new ? "相同" : "不同"}`);
  }
  // ② 總表（旗標關／開）
  let offCount = 0;
  for (const flag of ["off", "on"]) {
    const set = flag === "on" ? "SELECT set_config('gap.arms_all', 'on', true);\n" : "";
    const [r] = await query(`${set}WITH o AS MATERIALIZED (SELECT * FROM contribution_auto_tasks_arms()),
n(${AC}) AS MATERIALIZED (${armsNew})
SELECT (SELECT count(*) FROM o) AS n_old, (SELECT count(*) FROM n) AS n_new,
  (SELECT count(*) FROM (SELECT * FROM o EXCEPT ALL SELECT * FROM n) a) AS old_only,
  (SELECT count(*) FROM (SELECT * FROM n EXCEPT ALL SELECT * FROM o) b) AS new_only,
  (SELECT md5(string_agg(t::text, '|' ORDER BY t.task_id COLLATE "C", t.arm)) FROM o t) AS h_old,
  (SELECT md5(string_agg(t::text, '|' ORDER BY t.task_id COLLATE "C", t.arm)) FROM n t) AS h_new;`);
    check(`② 總表（gap.arms_all ${flag}）：現行 vs 四支臂換新本體`, r.old_only === 0 && r.new_only === 0 && r.n_old === r.n_new && r.h_old === r.h_new, `${r.n_old} 件 → ${r.n_new} 件，雜湊 ${r.h_old === r.h_new ? "相同" : "不同"}`);
    // 旗標開著時一定要真的多回傳被濾掉的列，不然這一項等於重複了旗標關的那一項
    if (flag === "off") offCount = Number(r.n_old);
    else check("② 旗標開著時總表比旗標關著多回傳被規則濾掉的列（兩種模式都真的比過）", Number(r.n_old) > offCount, `${offCount} → ${r.n_old}`);
  }
  // ③ 補充
  const sup = await query(`WITH twin AS (
  SELECT p.id, p.name FROM politicians p
   WHERE p.merged_into IS NULL
     AND cec_name_key(p.name) IN (SELECT cec_name_key(q.name) FROM politicians q WHERE q.merged_into IS NULL AND cec_name_key(q.name) IS NOT NULL GROUP BY 1 HAVING count(*) > 1)
   ORDER BY p.id LIMIT 150
), pk AS MATERIALIZED (
  SELECT q.id, q.name, q.birth_year, q.party, q.region, cec_name_key(q.name) AS nk FROM politicians q WHERE q.merged_into IS NULL
), sn AS (
  SELECT p.id,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('politician_id', q.id, 'name', q.name, 'birth_year', q.birth_year, 'party', q.party, 'region', q.region))
               FROM (SELECT q.* FROM politicians q WHERE q.merged_into IS NULL AND q.id <> p.id AND cec_name_key(q.name) = cec_name_key(p.name)
                      ORDER BY q.birth_year NULLS LAST LIMIT 10) q), '[]'::jsonb) AS o,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('politician_id', q.id, 'name', q.name, 'birth_year', q.birth_year, 'party', q.party, 'region', q.region))
               FROM (SELECT q.* FROM pk q WHERE q.id <> p.id AND q.nk = (SELECT cec_name_key(p.name))
                      ORDER BY q.birth_year NULLS LAST LIMIT 10) q), '[]'::jsonb) AS n
    FROM twin p
)
SELECT 'same_name' AS check_name, count(*) AS n_rows, count(*) FILTER (WHERE jsonb_array_length(o) > 0) AS n_nonempty, count(*) FILTER (WHERE o IS DISTINCT FROM n) AS diffs FROM sn
UNION ALL
SELECT 'queued', count(*), count(*) FILTER (WHERE o > 0), count(*) FILTER (WHERE o IS DISTINCT FROM n) FROM (
  SELECT (SELECT COUNT(*) FROM contributions c WHERE c.contribution_type = 'policy' AND c.status IN ('pending', 'verified')
            AND c.payload->>'politician_id' = p.id::TEXT AND COALESCE(NULLIF(c.payload->>'election_id', ''), '2026') = '2026') AS o,
         COALESCE((SELECT qb.n FROM (
            SELECT c.payload->>'politician_id' AS pid, COUNT(*) AS n FROM contributions c
             WHERE c.contribution_type = 'policy' AND c.status IN ('pending', 'verified') AND c.payload->>'politician_id' IS NOT NULL
               AND COALESCE(NULLIF(c.payload->>'election_id', ''), '2026') = '2026' GROUP BY 1) qb WHERE qb.pid = p.id::TEXT), 0) AS n
    FROM politicians p
   WHERE p.id::TEXT IN (SELECT c.payload->>'politician_id' FROM contributions c WHERE c.contribution_type = 'policy')
   LIMIT 200) z
UNION ALL
SELECT 'mayor_exists', count(*), count(*) FILTER (WHERE o), count(*) FILTER (WHERE o IS DISTINCT FROM n) FROM (
  SELECT is_2026_mayor_candidate(p.id) AS o,
         EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.politician_id = p.id AND pe.election_id = 2026 AND pe.election_type = '縣市長' AND pe.candidacy_status IN ('declared', 'filed')) AS n
    FROM politicians p) z2;`);
  for (const r of sup) check(`③ ${r.check_name}：逐筆比 ${r.n_rows} 筆（其中有內容的 ${r.n_nonempty} 筆）`, Number(r.diffs) === 0 && Number(r.n_nonempty) > 0, `差異 ${r.diffs}`);
  console.log(fails.length ? `\n${fails.length} 項不過` : "\n全部通過");
  Deno.exit(fails.length ? 1 : 0);
}

// time
const runs = Number(arg1 ?? 3);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const agg = (c: string) => `(SELECT count(*) AS c, sum(length(task_id)+length(task_type)+length(target::text)+length(what_we_need)+coalesce(array_length(hint_sources,1),0)+reward+length(coalesce(region,''))) AS s FROM ${c})`;
const exec = (rows: Array<Record<string, unknown>>) => parseFloat(String(rows.map((r) => r["QUERY PLAN"]).find((l) => String(l).startsWith("Execution Time"))).match(/([\d.]+) ms/)![1]);
const cteTimes = (rows: Array<Record<string, unknown>>) => {
  const t: Record<string, number> = {};
  let cur = "";
  for (const r of rows) {
    const l = String(r["QUERY PLAN"]);
    const m = l.match(/^ {2}CTE (\w+)$/);
    if (m) cur = m[1];
    const a = l.match(/^ {4}->  Aggregate .*actual time=[\d.]+\.\.([\d.]+)/);
    if (a && cur) { t[cur] = parseFloat(a[1]); cur = ""; }
  }
  return t;
};
const oldCtes = ARMS.map((a) => `o_${a} AS MATERIALIZED ${agg(`${fn(a)}()`)}`);
const newCtes = ARMS.map((a) => `n_${a}(${COLS}) AS MATERIALIZED (${NEW[a]}), na_${a} AS MATERIALIZED ${agg(`n_${a}`)}`);
const perArm: Record<string, { o: number[]; n: number[] }> = Object.fromEntries(ARMS.map((a) => [a, { o: [], n: [] }]));
const total = { o: [] as number[], n: [] as number[] };
for (let i = 0; i < runs; i++) {
  const o = cteTimes(await query(`EXPLAIN (ANALYZE) WITH ${oldCtes.join(", ")} SELECT ${ARMS.map((a) => `(SELECT s FROM o_${a})`).join(" + ")};`));
  const n = cteTimes(await query(`EXPLAIN (ANALYZE) WITH ${newCtes.join(", ")} SELECT ${ARMS.map((a) => `(SELECT s FROM na_${a})`).join(" + ")};`));
  for (const a of ARMS) { perArm[a].o.push(o[`o_${a}`]); perArm[a].n.push(n[`na_${a}`]); }
  total.o.push(exec(await query("EXPLAIN (ANALYZE) SELECT count(*), sum(length(task_id)+length(target::text)+length(what_we_need)+length(coalesce(opened_by::text,''))) FROM contribution_auto_tasks_arms();")));
  total.n.push(exec(await query(`EXPLAIN (ANALYZE) SELECT count(*), sum(length(task_id)+length(target::text)+length(what_we_need)+length(coalesce(opened_by::text,''))) FROM (${armsNew}) z(${AC});`)));
}
console.log("臂\t現行（毫秒，中位數）\t新本體");
for (const a of ARMS) console.log(`${a}\t${median(perArm[a].o).toFixed(0)}\t${median(perArm[a].n).toFixed(0)}`);
console.log(`總表整體\t${median(total.o).toFixed(0)}\t${median(total.n).toFixed(0)}（${runs} 次取中位數）`);
