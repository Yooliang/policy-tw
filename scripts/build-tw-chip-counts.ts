/**
 * 「晶片人數快取」產生器：2026 登記名冊（cec_registrations）每個縣市／鄉鎮、每種選舉類型的登記人數，
 * 以及每個鄉鎮「名冊裡沒有任何村里長登記者」的村里名單。選舉頁手機版晶片列一出來就照這份快取決定灰／亮
 * （人數 0 或沒出現＝灰），參選人資料讀完後再用即時資料校正（lib/chip-options.ts 的 resolvePopulated）。
 * 開發時執行，不在 build 流程裡（跟 build-tw-districts.ts 同一套：正式庫唯讀取名冊 → 小檔進版控）。
 *
 *   cat > chip-counts.sql <<'SQL'
 *   SET default_transaction_read_only = on;
 *   SELECT r.election_type, r.region, r.sub_region, r.village, count(*) AS n
 *     FROM cec_registrations r
 *     JOIN cec_registration_sources s ON s.source_url = r.source_url AND s.superseded_by IS NULL
 *    WHERE r.election_id = 2026
 *    GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;
 *   SQL
 *   npx supabase db query --linked -f chip-counts.sql > chip-counts.json
 *   node --experimental-strip-types scripts/build-tw-chip-counts.ts chip-counts.json
 *
 * 輸出 data/tw-chip-counts/2026.json（只有數字與零人村里名，用官方縣市碼／鄉鎮碼當 key）
 *   county:  { <縣市碼>: { <選舉類型>: 人數 } }
 *   town:    { <鄉鎮碼>: { <選舉類型>: 人數 } }          村里長的人數也在這裡（整個鄉鎮合計）
 *   village: { <鄉鎮碼>: ["沒有登記者的村里名", …] }      名稱照 data/tw-raster/villages 的寫法；每個鄉鎮都有 key（空陣列＝每個村里都有人）
 */
import fs from "node:fs";

const input = process.argv[2];
if (!input) { console.error("用法：build-tw-chip-counts.ts <chip-counts.json>"); process.exit(2); }
const raw = fs.readFileSync(input, "utf8");
const rows = (JSON.parse(raw.slice(raw.indexOf("{"))) as { rows: Array<{ election_type: string; region: string; sub_region: string | null; village: string | null; n: number }> }).rows;

const norm = (s: string) => s.replace(/臺/g, "台");
const names = fs.readFileSync(new URL("./fixtures/admin-names.tsv", import.meta.url), "utf8").split(/\r?\n/).filter(Boolean).map((l) => l.split("\t") as [string, string]);
const counties = new Map(names.filter(([c]) => c.length === 5).map(([c, n]) => [norm(n), c]));
const towns = new Map(names.filter(([c]) => c.length === 8).map(([c, n]) => [c.slice(0, 5) + "|" + norm(n), c]));

const county: Record<string, Record<string, number>> = {};
const town: Record<string, Record<string, number>> = {};
const registeredVillages: Record<string, Set<string>> = {};
const bad: string[] = [];
for (const r of rows) {
  const cc = counties.get(norm(r.region));
  if (!cc) { bad.push(`縣市對不上：${r.region}`); continue; }
  const n = Number(r.n);
  if (r.election_type === "縣市長" || r.election_type === "縣市議員") {
    (county[cc] ??= {})[r.election_type] = ((county[cc] ??= {})[r.election_type] ?? 0) + n;
    continue;
  }
  const tc = r.sub_region ? towns.get(cc + "|" + norm(r.sub_region)) : undefined;
  if (!tc) { bad.push(`鄉鎮對不上：${r.region} ${r.sub_region}`); continue; }
  const t = (town[tc] ??= {});
  t[r.election_type] = (t[r.election_type] ?? 0) + n;
  if (r.election_type === "村里長" && r.village) (registeredVillages[tc] ??= new Set()).add(norm(r.village));
}
if (bad.length) { console.error([...new Set(bad)].join("\n")); process.exit(1); }

// 村里：點陣檔的村里清單減掉名冊有人的，剩下的就是灰的
const village: Record<string, string[]> = {};
let unmatched = 0;
for (const f of fs.readdirSync(new URL("../data/tw-raster/villages/", import.meta.url)).sort()) {
  const code = f.replace(/\.json$/, "");
  const names2: string[] = JSON.parse(fs.readFileSync(new URL(`../data/tw-raster/villages/${f}`, import.meta.url), "utf8")).names;
  const reg = registeredVillages[code];
  if (!reg) { village[code] = []; continue; } // 名冊沒有這個鄉鎮的村里長：不下判斷（維持不灰，交給即時資料）
  // 罕用字：點陣檔寫成 [磘]（括號包住），名冊有時是原字（磘）、有時是擴充區字（𥕢）——兩種寫法都試
  const unwrap = (n: string) => norm(n).replace(/\[(.)\]/g, "$1");
  const fuzzy = (n: string) => norm(n).replace(/\[.\]/g, "?").replace(/[\u{10000}-\u{10ffff}]/gu, "?");
  const regFuzzy = new Set([...reg].map(fuzzy));
  village[code] = names2.filter((n) => !reg.has(unwrap(n)) && !regFuzzy.has(fuzzy(n)));
  const rasterUnwrap = new Set(names2.map(unwrap));
  const rasterFuzzy = new Set(names2.map(fuzzy));
  for (const v of reg) if (!rasterUnwrap.has(v) && !rasterFuzzy.has(fuzzy(v))) unmatched++;
}
const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const out = { election: 2026, county: sorted(county), town: sorted(town), village: sorted(village) };
fs.mkdirSync("data/tw-chip-counts", { recursive: true });
fs.writeFileSync("data/tw-chip-counts/2026.json", JSON.stringify(out) + "\n");
console.log(`縣市 ${Object.keys(out.county).length}、鄉鎮 ${Object.keys(out.town).length}、有灰村里的鄉鎮 ${Object.values(out.village).filter((v) => v.length).length}；名冊村里對不上點陣檔 ${unmatched}`);
