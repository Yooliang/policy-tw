/**
 * 拿掉 raw、mayor_policies 寫死的年份與職位（migration 20261011300000_campaign_election_arms.sql）上線前的「今天輸出逐件不變」比對（2026-10-13）。
 *
 * 兩支臂的舊本體（前一版 migration）與新本體（這支 migration），在正式庫的同一個唯讀查詢裡各跑一次，全欄 EXCEPT ALL 兩個方向都要是 0。
 * 新本體用到的三支新函式（campaign_election_id、election_year_text、regular_election_years_text）正式庫還沒有，就地換成函式本體；
 * mayor_policies 讀的規則參數（params.election_types、max_policies）正式庫也還沒有，換成這支 migration 要寫進去的值。
 * 不建立任何物件、不寫入。
 *
 * 用法（不進 CI：要連正式庫）：
 *   deno run --allow-read --allow-write scripts/arms-parity-campaign.ts gen parity.sql
 *   （之後的批次：… gen parity.sql 20261011310000_campaign_election_arms_2.sql region_gap township_gap roster_villages term_policies）
 *   npx supabase db query --linked -f parity.sql -o json      （檔案第一行是 SET default_transaction_read_only = on）
 * 結果每支臂一列：old_n、new_n（筆數）、only_old、only_new（EXCEPT ALL 兩個方向，都要 0）、old_md5＝new_md5（全欄排序後的雜湊）。
 */
import { fnText, latestFn, readMig } from "../supabase/functions/_shared/arms-pglite.ts";

const [mode, out, migArg, ...armArgs] = Deno.args;
if (mode !== "gen" || !out) {
  console.error("用法：arms-parity-campaign.ts gen <out.sql> [migration 檔名] [臂名…]（預設 20261011300000 的 raw、mayor_policies）");
  Deno.exit(2);
}
const MIG = migArg ?? "20261011300000_campaign_election_arms.sql";
const ARMS = armArgs.length ? armArgs : ["raw", "mayor_policies"];

/** CREATE OR REPLACE FUNCTION … AS $tag$ 本體 $tag$; 取本體 */
const body = (fn: string) => {
  const m = /AS (\$[a-z]*\$)/.exec(fn)!;
  const start = fn.indexOf(m[0]) + m[0].length;
  return fn.slice(start, fn.lastIndexOf(m[1])).trim();
};

const mig = await readMig(MIG);
const CAMPAIGN = `(SELECT e.id FROM elections e WHERE e.election_reason = 'regular' AND e.election_date IS NOT NULL
   ORDER BY (e.election_date >= activity_today()) DESC, CASE WHEN e.election_date >= activity_today() THEN e.election_date END ASC, e.election_date DESC, e.id LIMIT 1)`;
const YEARS = `(SELECT string_agg(y, '／' ORDER BY y) FROM (SELECT DISTINCT to_char(e.election_date, 'YYYY') AS y FROM elections e
   WHERE e.election_reason = 'regular' AND e.election_date IS NOT NULL AND e.election_date <= (SELECT c.election_date FROM elections c WHERE c.id = ${CAMPAIGN})) x)`;

/** 新函式就地展開（正式庫還沒有）；檢查每一個呼叫都換掉了 */
function inline(sql: string): string {
  let s = sql.replaceAll("campaign_election_id()", CAMPAIGN).replaceAll("regular_election_years_text()", YEARS);
  s = s.replace(/election_year_text\(([a-z_.]+)\)/g, (_m, x) => `(SELECT to_char(ey.election_date, 'YYYY') FROM elections ey WHERE ey.id = ${x})`);
  s = s.replaceAll(
    "(r.params->>'max_policies')",
    `((r.params || '{"election_types": ["縣市長"], "max_policies": 5}'::JSONB)->>'max_policies')`,
  ).replaceAll(
    "jsonb_array_elements_text(r.params->'election_types')",
    `jsonb_array_elements_text((r.params || '{"election_types": ["縣市長"], "max_policies": 5}'::JSONB)->'election_types')`,
  );
  for (const f of ["campaign_election_id(", "election_year_text(", "regular_election_years_text("]) {
    if (s.includes(f)) throw new Error(`沒有展開乾淨：${f}`);
  }
  return s;
}

const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";
const parts: string[] = [];
for (const arm of ARMS) {
  const name = `contribution_auto_tasks_${arm}`;
  const oldBody = body(await latestFn(name, MIG));
  const newBody = inline(body(fnText(mig, name)));
  parts.push(`SELECT '${arm}' AS arm,
  (SELECT count(*) FROM o_${arm}) AS old_n, (SELECT count(*) FROM n_${arm}) AS new_n,
  (SELECT count(*) FROM (SELECT ${COLS} FROM o_${arm} EXCEPT ALL SELECT ${COLS} FROM n_${arm}) x) AS only_old,
  (SELECT count(*) FROM (SELECT ${COLS} FROM n_${arm} EXCEPT ALL SELECT ${COLS} FROM o_${arm}) x) AS only_new,
  (SELECT md5(string_agg(md5(row(${COLS})::TEXT), ',' ORDER BY md5(row(${COLS})::TEXT))) FROM o_${arm}) AS old_md5,
  (SELECT md5(string_agg(md5(row(${COLS})::TEXT), ',' ORDER BY md5(row(${COLS})::TEXT))) FROM n_${arm}) AS new_md5`);
  parts.unshift(`o_${arm}(${COLS}) AS MATERIALIZED (\n${oldBody}\n),\nn_${arm}(${COLS}) AS MATERIALIZED (\n${newBody}\n)`);
}
const ctes = parts.filter((p) => p.startsWith("o_")).join(",\n");
const selects = parts.filter((p) => p.startsWith("SELECT")).join("\nUNION ALL\n");
await Deno.writeTextFile(out, `SET default_transaction_read_only = on;\nWITH ${ctes}\n${selects};\n`);
console.log(`寫好 ${out}`);
