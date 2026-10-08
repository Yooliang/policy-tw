/**
 * 代表的號次單位改用選舉區（#464，migration 20261009050000_rep_district_ballot_unit.sql）上線前的「今天輸出逐件不變」對照
 * （2026-10-09；做法同 scripts/arms-parity-ballot.ts：不建立任何物件，新定義以子查詢原樣放進同一個唯讀查詢，新舊輸出是同一個時間點的快照）。
 *
 * 產生一支 SQL（第一行 SET default_transaction_read_only = on），在正式庫唯讀執行，每個檢查一列：check_name、old_n、new_n、old_hash、new_hash、same：
 *   unit_records    每一筆參選紀錄算出的號次單位，新舊逐筆相同（代表而且 regions 指到「鄉鎮第NN選舉區」的除外，另列 diff 列數）
 *   unit_payloads   每一筆 candidacy 貢獻 payload 算出的號次單位，新舊逐筆相同（代表而且帶了選舉區的除外，另列 diff 列數）
 *   view_units      ballot_number_units 全欄雜湊（現行視圖 vs 新視圖本體）
 *   arm_ballot      contribution_auto_tasks_ballot_numbers() 全欄雜湊（現行函式 vs 新本體；今天窗口外，但臂本體直接呼叫是整批輸出）
 *   gap_old_rows    contribution_auto_tasks_region_gap()：新本體輸出裡「現行就有的 task_id」那一部分，全欄雜湊與現行相同
 *   gap_new_rows    新本體多出來的任務（只該有代表缺選舉區的）：筆數；另用不同寫法獨立算一次應有幾件
 *   gap_open        多出來的任務在 activity_open('region_gap', 2026, 鄉鎮市民代表) 是開著的（會被派出去）
 *
 * 用法（不進 CI：要正式庫）：
 *   deno run --allow-read --allow-write scripts/arms-parity-rep-district.ts gen out.sql [mutation]
 *   npx supabase db query --linked -f out.sql -o json
 * mutation（還原驗證用，故意改壞新定義一處，對應的檢查必須變成 same=false）：unit_cunli、arm_cunli、gap_name、view_cunli
 */
const MIG = new URL("../supabase/migrations/", import.meta.url);
const rd = async (n: string) => (await Deno.readTextFile(new URL(n, MIG))).replace(/\r\n/g, "\n");
const NEW = "20261009050000_rep_district_ballot_unit.sql";
const BALLOT = "20261008150000_ballot_numbers_arm.sql";

const [mode, out, mutation] = Deno.args;
if (mode !== "gen" || !out) {
  console.error("用法：arms-parity-rep-district.ts gen <out.sql> [mutation]");
  Deno.exit(2);
}

function fnBody(sql: string, name: string): string {
  const a = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  if (a < 0) throw new Error(`找不到函式 ${name}`);
  const s = sql.indexOf("$$", a) + 2;
  const e = sql.indexOf("$$;", s);
  return sql.slice(s, e).trim();
}
function viewBody(sql: string, name: string): string {
  const a = sql.indexOf(`CREATE OR REPLACE VIEW ${name} AS`);
  if (a < 0) throw new Error(`找不到視圖 ${name}`);
  const s = a + `CREATE OR REPLACE VIEW ${name} AS`.length;
  return sql.slice(s, sql.indexOf(";\nCOMMENT ON VIEW", a)).trim();
}
function mutate(s: string, from: string, to: string): string {
  if (s.split(from).length !== 2) throw new Error(`要改的字串必須剛好出現一次：${from.slice(0, 50)}`);
  return s.replace(from, () => to);
}

/** 把 ballot_number_unit(a1..a5) 的呼叫換成函式本體（SELECT 後面的 CASE 運算式，參數換成呼叫處的運算式） */
function inlineUnit(sql: string, unitFn: string): string {
  const body = unitFn.replace(/^SELECT\s+/, "");
  const params = ["p_election_type", "p_county", "p_district", "p_town", "p_village"];
  let outSql = "";
  let i = 0;
  const key = "ballot_number_unit(";
  for (;;) {
    const j = sql.indexOf(key, i);
    if (j < 0) { outSql += sql.slice(i); break; }
    outSql += sql.slice(i, j);
    let k = j + key.length, depth = 1, start = k;
    const args: string[] = [];
    for (; depth > 0; k++) {
      const c = sql[k];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) args.push(sql.slice(start, k).trim()); }
      else if (c === "," && depth === 1) { args.push(sql.slice(start, k).trim()); start = k + 1; }
      else if (c === "'") { k = sql.indexOf("'", k + 1); }
    }
    if (args.length !== 5) throw new Error(`ballot_number_unit 呼叫要 5 個參數：${args.length}`);
    let expr = body;
    params.forEach((p, n) => { expr = expr.replace(new RegExp(`\\b${p}\\b`, "g"), `(${args[n]})`); });
    outSql += `(${expr})`;
    i = k;
  }
  return outSql;
}

const B = await rd(BALLOT);
let N = await rd(NEW);
if (mutation === "unit_cunli") N = mutate(N, "replace(btrim(p_county), '臺', '台') || '|' || replace(btrim(p_town), '臺', '台') || '|' || replace(btrim(p_village), '臺', '台')", "replace(btrim(p_county), '臺', '台') || '|' || btrim(p_town) || '|' || replace(btrim(p_village), '臺', '台')");
if (mutation === "arm_cunli") N = mutate(N, "WHEN pe.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長') THEN r.sub_region END AS unit_town", "WHEN pe.election_type IN ('鄉鎮市長', '直轄市山地原住民區長') THEN r.sub_region END AS unit_town");
if (mutation === "gap_name") N = mutate(N, "           AND c.name_key = COALESCE(cec_name_key(p.name), NULLIF(cec_name_norm(p.name), ''))\n", "");
if (mutation === "view_cunli") N = mutate(N, "                ELSE r.sub_region END AS town,", "                ELSE NULL END AS town,");

const oldUnit = fnBody(B, "ballot_number_unit");
const newUnit = fnBody(N, "ballot_number_unit");
const oldViewRaw = viewBody(B, "ballot_number_units");
const newViewRaw = viewBody(N, "ballot_number_units");
const newViewBody = inlineUnit(newViewRaw, newUnit);
const newArmRaw = fnBody(N, "contribution_auto_tasks_ballot_numbers");
if (!newArmRaw.startsWith("WITH g_all AS (")) throw new Error("新臂本體不是以 WITH g_all 開頭");
// 新臂讀視圖 ballot_number_units：用同名的 CTE 蓋掉正式庫現行的視圖（CTE 在同一個查詢裡優先於資料表／視圖）
// 函式本體的輸出欄位沒有名字（RETURNS TABLE 才有），內嵌時要補上，雜湊的 JSON 鍵才跟現行函式一樣
const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";
const named = (body: string) => `SELECT * FROM (${body}) x(${COLS})`;
const newArm = named(`WITH ballot_number_units AS (${newViewBody}),\n${newArmRaw.slice("WITH ".length)}`);
const newGap = named(fnBody(N, "contribution_auto_tasks_region_gap"));

const REC_ARGS = `pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village`;
const PAY_ARGS = `c.payload->>'election_type', c.payload->>'region', c.payload->>'electoral_district', c.payload->>'sub_region', c.payload->>'village'`;
const unitCall = (fn: string, args: string) => inlineUnit(`ballot_number_unit(${args})`, fn);
const REPS = `('鄉鎮市民代表', '直轄市山地原住民區民代表')`;
const hash = (src: string, order: string) => `SELECT count(*)::int AS n, md5(COALESCE(string_agg(to_jsonb(t)::text, '' ORDER BY ${order}), '')) AS h FROM (${src}) t`;

const sql = `SET default_transaction_read_only = on;
WITH
rec AS (
  SELECT pe.id, pe.election_type, r.sub_region,
         ${unitCall(oldUnit, REC_ARGS)} AS o,
         ${unitCall(newUnit, REC_ARGS)} AS n
    FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id LEFT JOIN regions r ON r.id = pe.region_id),
pay AS (
  SELECT c.id, c.payload->>'election_type' AS election_type, c.payload->>'electoral_district' AS ed,
         ${unitCall(oldUnit, PAY_ARGS)} AS o,
         ${unitCall(newUnit, PAY_ARGS)} AS n
    FROM contributions c WHERE c.contribution_type = 'candidacy'),
vo AS (${hash("SELECT * FROM ballot_number_units", "t.election_id, t.election_type, t.unit COLLATE \"C\"")}),
vn AS (${hash(newViewBody, "t.election_id, t.election_type, t.unit COLLATE \"C\"")}),
ao AS (${hash("SELECT * FROM contribution_auto_tasks_ballot_numbers()", "t.task_id COLLATE \"C\"")}),
an AS (${hash(newArm, "t.task_id COLLATE \"C\"")}),
go_ AS (SELECT * FROM contribution_auto_tasks_region_gap()),
gn AS (${newGap}),
gxo AS (${hash("SELECT * FROM go_", "t.task_id COLLATE \"C\"")}),
gxn AS (${hash("SELECT * FROM gn WHERE task_id IN (SELECT task_id FROM go_)", "t.task_id COLLATE \"C\"")}),
gnew AS (SELECT * FROM gn WHERE task_id NOT IN (SELECT task_id FROM go_)),
-- 獨立算一次應該多幾件：2026 的代表、已登記（不是 considering／withdrawn）、指到鄉鎮那一列（不是選舉區那一列）、名冊現行版上同縣市同鄉鎮同姓名有一列寫了選舉區
indep AS (
  SELECT count(DISTINCT pe.id)::int AS n
    FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
    JOIN regions r ON r.id = pe.region_id AND r.village IS NULL AND r.sub_region IS NOT NULL AND r.sub_region NOT LIKE '%選舉區'
    JOIN cec_registrations c ON c.election_id = pe.election_id AND c.election_type = pe.election_type AND c.district IS NOT NULL
         AND c.region = replace(r.region, '臺', '台') AND replace(c.sub_region, '臺', '台') = replace(r.sub_region, '臺', '台') AND c.name = p.name
    JOIN cec_registration_sources s ON s.source_url = c.source_url AND s.superseded_by IS NULL
   WHERE pe.election_type IN ${REPS} AND COALESCE(pe.candidacy_status, '') NOT IN ('considering', 'withdrawn')),
opened AS (SELECT count(*)::int AS n FROM activity_open('region_gap', 2026, '鄉鎮市民代表'))
SELECT 'unit_records' AS check_name, (SELECT count(*) FROM rec)::int AS old_n, (SELECT count(*) FROM rec)::int AS new_n,
       (SELECT count(*) FILTER (WHERE o IS DISTINCT FROM n AND NOT (election_type IN ${REPS} AND sub_region ~ '選舉區$'))::int FROM rec)::text AS old_hash,
       (SELECT count(*) FILTER (WHERE o IS DISTINCT FROM n AND election_type IN ${REPS} AND sub_region ~ '選舉區$')::int FROM rec)::text AS new_hash,
       ((SELECT count(*) FILTER (WHERE o IS DISTINCT FROM n AND NOT (election_type IN ${REPS} AND sub_region ~ '選舉區$')) FROM rec) = 0) AS same,
       '其餘選舉別與沒記選舉區的代表：不一致 0 筆（old_hash 欄）；代表而且指到「鄉鎮第NN選舉區」的列算出新單位（new_hash 欄，2022 區民代表）' AS note
UNION ALL
SELECT 'unit_payloads', (SELECT count(*) FROM pay)::int, (SELECT count(*) FROM pay)::int,
       (SELECT count(*) FILTER (WHERE o IS DISTINCT FROM n AND NOT (election_type IN ${REPS} AND ed IS NOT NULL))::int FROM pay)::text,
       (SELECT count(*) FILTER (WHERE o IS DISTINCT FROM n AND election_type IN ${REPS} AND ed IS NOT NULL)::int FROM pay)::text,
       ((SELECT count(*) FILTER (WHERE o IS DISTINCT FROM n AND NOT (election_type IN ${REPS} AND ed IS NOT NULL)) FROM pay) = 0), 'candidacy 貢獻 payload 同上'
UNION ALL SELECT 'view_units', vo.n, vn.n, vo.h, vn.h, (vo.n = vn.n AND vo.h = vn.h), '視圖輸出（還沒投票的選舉）' FROM vo, vn
UNION ALL SELECT 'arm_ballot', ao.n, an.n, ao.h, an.h, (ao.n = an.n AND ao.h = an.h), '補號次臂本體整批輸出（含重查）' FROM ao, an
UNION ALL SELECT 'gap_old_rows', gxo.n, gxn.n, gxo.h, gxn.h, (gxo.n = gxn.n AND gxo.h = gxn.h), '補選區臂：現行就有的任務逐件相同' FROM gxo, gxn
UNION ALL SELECT 'gap_new_rows', (SELECT count(*) FROM go_)::int, (SELECT count(*) FROM gn)::int, (SELECT n FROM indep)::text, (SELECT count(*) FROM gnew)::text,
       ((SELECT count(*) FROM gnew) = (SELECT n FROM indep) AND (SELECT count(*) FROM gnew WHERE task_type = 'candidacy_source_missing' AND target->>'election_type' IN ${REPS} AND target->'missing' = '["electoral_district"]'::jsonb AND (target->>'cec_matches')::int = 1 AND jsonb_array_length(target->'cec_districts') = 1) = (SELECT count(*) FROM gnew)),
       '多出來的只有代表缺選舉區（每件名冊上只有一位同名、一個選舉區）：new_hash 欄＝新臂多出的件數，old_hash 欄＝獨立寫法算出的應有件數'
UNION ALL SELECT 'gap_open', (SELECT n FROM opened), (SELECT n FROM opened), '', '', ((SELECT n FROM opened) = 1), '多出來的任務所在的窗口（region_gap × 2026 × 鄉鎮市民代表）是開著的，會被派出去';
`;
await Deno.writeTextFile(out, sql);
console.log(`寫出 ${out}（${sql.length} 字元）${mutation ? `；故意改壞：${mutation}` : ""}`);
