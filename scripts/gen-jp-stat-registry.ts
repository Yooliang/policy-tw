/**
 * e-Stat「令和7年国勢調査 都道府県・市区町村別の主な結果」→ policy_jp.stat_registry 的資料 migration（機器核對 regional_stat 用，不顯示）。
 *
 *   deno run -A --no-config --node-modules-dir=none scripts/gen-jp-stat-registry.ts [--out supabase/migrations/20261009250300_policy_jp_stat_registry_data.sql]
 *
 * 只收三項（國勢調査有的）：population＝総人口（人）、area_km2＝面積（参考，km2）、aging_rate＝65歳以上人口の構成比（%，不詳補完値）。
 * 歳出（決算カード）沒有可以整批比對的官方檔，不在這裡（regional_stat 的 budget_expenditure 照舊走同儕驗證）。
 * 表上的地域碼是 5 碼（JIS＋市区町村），補上檢查碼成 6 碼團體碼；只留 lg_code_registry（總務省團體碼表）裡有的團體
 * （「00000 全国」「13100 特別区部」這類合計列不是團體）。基準日 2025-10-01。
 * 腳本會讀 20261009250100_policy_jp_lg_registry_data.sql 的團體碼清單，比對範圍跟自治體的核對同一份。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as XLSX from "npm:xlsx@0.18.5";

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) args.set(Deno.args[i], Deno.args[i + 1]);
const OUT = args.get("--out") ?? "supabase/migrations/20261009250300_policy_jp_stat_registry_data.sql";
const LG_DATA = "supabase/migrations/20261009250100_policy_jp_lg_registry_data.sql";

const STAT_INF_ID = "000040507382"; // 令和7年 都道府県・市区町村別の主な結果（e-Stat 公開 2026-09-29）
const FILE_URL = `https://www.e-stat.go.jp/stat-search/file-download?statInfId=${STAT_INF_ID}&fileKind=0`;
const LIST_URL = "https://www.e-stat.go.jp/stat-search/files?page=1&layout=datalist&toukei=00200521&tstat=000001049104&cycle=0&tclass1=000001049105&tclass2val=0";
const AS_OF = "2025-10-01";
const YEAR = 2025;
const UA = "Mozilla/5.0 (compatible; PolicyTracker/1.0; +https://policy-jp.web.app)";

const checkDigit = (first5: string) => {
  const w = [6, 5, 4, 3, 2];
  let s = 0;
  for (let i = 0; i < 5; i++) s += Number(first5[i]) * w[i];
  return (11 - (s % 11)) % 10;
};

const lgCodes = new Set([...(await Deno.readTextFile(LG_DATA)).matchAll(/^\s+\('(\d{6})', /gm)].map((m) => m[1]));
assertEquals(lgCodes.size, 1965, "團體碼表要 1,965 個");

const res = await fetch(FILE_URL, { headers: { "User-Agent": UA } });
if (!res.ok) throw new Error(`${FILE_URL}: HTTP ${res.status}`);
assert((res.headers.get("content-disposition") ?? "").includes("major_results_2025.xlsx"), `檔名不是 major_results_2025.xlsx：${res.headers.get("content-disposition")}`);
const buf = new Uint8Array(await res.arrayBuffer());
const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
const wb = XLSX.read(buf, { type: "array" });
const ws = wb.Sheets[wb.SheetNames[0]];
assert(wb.SheetNames[0].includes("2025"), `第一張表不是 2025 年：${wb.SheetNames[0]}`);
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
assert(String(rows[0][0]).includes("令和７年国勢調査"), `標題不對：${rows[0][0]}`);

// 欄位：第 7 列（index 6）是項目名、第 9 列（index 8）是單位；照名稱找欄，不寫死位置
const head = rows[6].map((c) => String(c ?? "").replace(/\s/g, ""));
const unitRow = rows[8].map((c) => String(c ?? "").replace(/\s/g, ""));
const colTotal = head.indexOf("総数");
const colArea = head.findIndex((h) => h.startsWith("面積"));
// 65歳以上 出現好幾次：人數（人）與構成比（%）；取第一個單位是 % 的
const colAging = head.findIndex((h, i) => h === "65歳以上" && unitRow[i] === "（％）");
assert(colTotal === 4 && unitRow[colTotal] === "（人）", `総数欄 ${colTotal} ${unitRow[colTotal]}`);
assert(colArea > 0 && unitRow[colArea] === "（km2）", `面積欄 ${colArea} ${unitRow[colArea]}`);
assert(colAging > 0, "找不到 65歳以上 構成比欄");

type Stat = { lg_code: string; stat_key: string; value: string; unit: string };
const out: Stat[] = [];
const seen = new Set<string>();
for (const r of rows.slice(9)) {
  const area = String(r[1] ?? "");
  const m = /^(\d{5})_(.+)$/.exec(area);
  if (!m) continue;
  const code = m[1] + checkDigit(m[1]);
  if (!lgCodes.has(code)) continue; // 全国・特別区部などの合計列
  assert(!seen.has(code), `${code} 重複`);
  seen.add(code);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const pop = num(r[colTotal]);
  const km2 = num(r[colArea]);
  const aging = num(r[colAging]);
  if (pop !== null) { assert(Number.isInteger(pop) && pop >= 0, `${code} 人口 ${pop}`); out.push({ lg_code: code, stat_key: "population", value: String(pop), unit: "人" }); }
  if (km2 !== null && km2 > 0) out.push({ lg_code: code, stat_key: "area_km2", value: String(km2), unit: "km2" });
  if (aging !== null) { assert(aging >= 0 && aging <= 100, `${code} 高齢化率 ${aging}`); out.push({ lg_code: code, stat_key: "aging_rate", value: String(aging), unit: "%" }); }
}
const tally: Record<string, number> = {};
for (const s of out) tally[s.stat_key] = (tally[s.stat_key] ?? 0) + 1;
console.error(`團體 ${seen.size}、統計 ${out.length}：`, tally);
assert(seen.size > 1900, `對到的團體只有 ${seen.size}`);

const kinds = Object.entries(tally).sort().map(([k, n]) => `${k} ${n}`).join("、");
const values = out.sort((a, b) => (a.lg_code + a.stat_key < b.lg_code + b.stat_key ? -1 : 1))
  .map((s) => `    ('${s.lg_code}', '${s.stat_key}', ${s.value}, '${s.unit}')`).join(",\n");
const sql = `-- e-Stat「令和7年国勢調査 都道府県・市区町村別の主な結果」→ policy_jp.stat_registry（機器核對 regional_stat 用，不顯示）
-- ============================================================
-- 由 scripts/gen-jp-stat-registry.ts 產生，不要手改；之後的年份（或修正版）改腳本的 STAT_INF_ID 重產一支新的 migration。
-- 前提：20261009250200_policy_jp_stat_registry.sql（stat_registry 表）、20261009250100（團體碼表；只收表裡有的團體）。
--
-- 出處：${FILE_URL}
--       （一覧 ${LIST_URL}；檔名 major_results_2025.xlsx；SHA-256 ${sha}）
-- year ${YEAR}、as_of ${AS_OF}。團體 ${seen.size} 個，共 ${out.length} 列：${kinds}。
-- population＝総人口、area_km2＝面積（参考）、aging_rate＝65歳以上人口の構成比（不詳補完値）。歳出不在這裡（沒有可整批比對的官方檔）。

INSERT INTO policy_jp.sources (url, title, publisher, source_kind, origin)
VALUES ('${FILE_URL}', '令和7年国勢調査 都道府県・市区町村別の主な結果', '総務省統計局', 'statistics', 'import:estat_census_2025')
ON CONFLICT (url) DO NOTHING;

INSERT INTO policy_jp.stat_registry (lg_code, stat_key, year, value, unit, as_of, source_id)
SELECT v.lg_code, v.stat_key, ${YEAR}, v.value, v.unit, DATE '${AS_OF}', s.id
  FROM (VALUES
${values}
  ) AS v(lg_code, stat_key, value, unit)
  JOIN policy_jp.sources s ON s.url = '${FILE_URL}'
ON CONFLICT (lg_code, stat_key, year) DO NOTHING;

-- 自我檢查：筆數與分布跟產生時一樣
DO $$
DECLARE got TEXT;
BEGIN
  SELECT string_agg(stat_key || ' ' || n, '、' ORDER BY stat_key) INTO got
    FROM (SELECT stat_key, count(*) AS n FROM policy_jp.stat_registry WHERE year = ${YEAR} GROUP BY stat_key) t;
  IF got IS DISTINCT FROM '${kinds}' THEN
    RAISE EXCEPTION 'stat_registry 的分布不對：%（預期 ${kinds}）', got;
  END IF;
END
$$;
`;
await Deno.writeTextFile(OUT, sql);
console.error(`寫入 ${OUT}`);
