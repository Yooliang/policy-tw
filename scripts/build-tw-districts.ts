/**
 * 「選區快取」產生器：2026 登記名冊（cec_registrations）裡每個縣市的縣市議員選舉區、每個鄉鎮的
 * 鄉鎮市民代表／直轄市山地原住民區民代表選舉區，對到官方縣市碼／鄉鎮碼（與 data/tw-raster 同一套代碼）。
 * 手機版選舉頁的「選區晶片」讀這份小檔（單檔約 20 KB），不用等參選資料；快取沒有的單位才退回用參選資料推。
 * 開發時執行，不在 build 流程裡。
 *
 *   # 1) 從正式庫唯讀取名冊（SQL 第一行 SET default_transaction_read_only = on;，不寫任何金鑰）
 *   cat > districts.sql <<'SQL'
 *   SET default_transaction_read_only = on;
 *   SELECT DISTINCT r.election_type, r.region, r.sub_region, r.district
 *     FROM cec_registrations r
 *     JOIN cec_registration_sources s ON s.source_url = r.source_url AND s.superseded_by IS NULL
 *    WHERE r.election_id = 2026 AND r.district IS NOT NULL
 *      AND r.election_type IN ('縣市議員','鄉鎮市民代表','直轄市山地原住民區民代表')
 *    ORDER BY 1,2,3,4;
 *   SQL
 *   npx supabase db query --linked -f districts.sql > districts.json
 *   # 2) 產生（Node 22.6+ 加 --experimental-strip-types，或 deno run -A）
 *   node --experimental-strip-types scripts/build-tw-districts.ts districts.json
 *
 * 輸出 data/tw-districts/2026.json
 *   council: { <縣市碼>: ["第01選舉區", …] }                  標籤跟參選資料的 sub_region 同寫法
 *   rep:     { <鄉鎮碼>: ["<鄉鎮>第01選舉區", …] }             代表的標籤帶鄉鎮名（lib/district-grouping.ts 的正式寫法）
 * 縣市與鄉鎮名稱的對照取 scripts/fixtures/admin-names.tsv（臺／台視為同字）；對不上的列會印出並讓腳本失敗。
 */
import fs from "node:fs";

const input = process.argv[2];
if (!input) { console.error("用法：build-tw-districts.ts <districts.json>"); process.exit(2); }
const raw = fs.readFileSync(input, "utf8");
const rows = (JSON.parse(raw.slice(raw.indexOf("{"))) as { rows: Array<{ election_type: string; region: string; sub_region: string | null; district: string }> }).rows;

const norm = (s: string) => s.replace(/臺/g, "台");
const names = fs.readFileSync(new URL("./fixtures/admin-names.tsv", import.meta.url), "utf8").split(/\r?\n/).filter(Boolean).map((l) => l.split("\t") as [string, string]);
const counties = new Map(names.filter(([c]) => c.length === 5).map(([c, n]) => [norm(n), c]));
const towns = new Map(names.filter(([c]) => c.length === 8).map(([c, n]) => [c.slice(0, 5) + "|" + norm(n), c]));

const natural = (a: string, b: string) => a.localeCompare(b, "zh-Hant-TW", { numeric: true });
const council: Record<string, string[]> = {};
const rep: Record<string, string[]> = {};
const bad: string[] = [];
for (const r of rows) {
  const cc = counties.get(norm(r.region));
  if (!cc) { bad.push(`縣市對不上：${r.region}`); continue; }
  if (r.election_type === "縣市議員") { (council[cc] ??= []).push(r.district); continue; }
  const tc = r.sub_region ? towns.get(cc + "|" + norm(r.sub_region)) : undefined;
  if (!tc) { bad.push(`鄉鎮對不上：${r.region} ${r.sub_region}`); continue; }
  (rep[tc] ??= []).push(`${r.sub_region}${r.district}`);
}
if (bad.length) { console.error([...new Set(bad)].join("\n")); process.exit(1); }
const sorted = (o: Record<string, string[]>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, [...new Set(o[k])].sort(natural)]));
const out = { election: 2026, council: sorted(council), rep: sorted(rep) };
fs.mkdirSync("data/tw-districts", { recursive: true });
fs.writeFileSync("data/tw-districts/2026.json", JSON.stringify(out) + "\n");
const n = (o: Record<string, string[]>) => Object.values(o).reduce((s, v) => s + v.length, 0);
console.log(`縣市議員選區 ${n(out.council)}（${Object.keys(out.council).length} 縣市）、代表選區 ${n(out.rep)}（${Object.keys(out.rep).length} 鄉鎮）`);
