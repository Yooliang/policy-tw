/**
 * 產生 election_bulletins（選舉公報對照表）的 migration 資料段（2026-10-06）。
 *
 * 用法（在 repo 根目錄）：
 *   1. 匯出中選會名單的選舉單位（唯讀）：
 *        npx supabase db query --linked -o csv -f <寫著下面這段的檔案> > units.csv
 *        SET default_transaction_read_only = on;
 *        SELECT election_id, election_type, region, coalesce(sub_region,'') sub_region, coalesce(village,'') village, count(*) n
 *          FROM cec_candidates
 *         WHERE (election_id = 2022 AND election_type <> '總統副總統') OR (election_id = 2024 AND election_type = '立法委員' AND region <> '全國')
 *         GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5;
 *   2. deno run --allow-net --allow-env --allow-read --allow-write scripts/build-election-bulletins.ts units.csv out.sql report.json
 *      （SUPABASE_URL、SUPABASE_ANON_KEY 有設就從 elections.bulletin_dir 讀公報資料夾，沒設用程式裡的後備）
 *      （抓 eebulletin.cec.gov.tw 與 bulletin.cec.gov.tw 的 ?action=sitemap 全站清單，逐一對；對不到的寫進 report.json）
 *
 * 對的規則在 supabase/functions/_shared/election-bulletin.ts（有測試）。這支只負責抓清單、輸出 SQL。
 */
import { buildBulletinIndex, BULLETIN_YEAR_DIR, bulletinRelPath, bulletinYearDirsFromElections, matchBulletin } from "../supabase/functions/_shared/election-bulletin.ts";

const [unitsFile, outSql, outReport] = Deno.args;
if (!unitsFile || !outSql || !outReport) {
  console.error("用法：deno run --allow-net --allow-read --allow-write scripts/build-election-bulletins.ts units.csv out.sql report.json");
  Deno.exit(1);
}

async function sitemapPdfs(base: string): Promise<string[]> {
  const res = await fetch(`${base}?action=sitemap`, { headers: { "user-agent": "Mozilla/5.0 (policy-tw bulletin index)" } });
  if (!res.ok) throw new Error(`${base} sitemap ${res.status}`);
  const html = await res.text();
  return [...html.matchAll(/<a href='([^']+\.pdf)'/g)].map((m) => m[1]);
}

// 公報站的民國年資料夾讀 elections.bulletin_dir（公開讀）；沒給 SUPABASE_URL／SUPABASE_ANON_KEY 就用程式裡的後備
async function loadYearDirs(): Promise<Readonly<Record<number, string>>> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) {
    console.error("沒有 SUPABASE_URL／SUPABASE_ANON_KEY：公報資料夾用程式裡的後備 BULLETIN_YEAR_DIR");
    return BULLETIN_YEAR_DIR;
  }
  const res = await fetch(`${url}/rest/v1/elections?select=id,bulletin_dir&order=id`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`elections ${res.status}`);
  return bulletinYearDirsFromElections(await res.json());
}
const yearDirs = await loadYearDirs();

const ee = await sitemapPdfs("https://eebulletin.cec.gov.tw/");
const central = (await sitemapPdfs("https://bulletin.cec.gov.tw/")).filter((p) => p.includes("/113年第11屆/02區域立法委員/"));
console.error(`eebulletin ${ee.length} 份、bulletin 區域立委 ${central.length} 份`);
const index = buildBulletinIndex([...ee, ...central]);

function parseCsvLine(l: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of l) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const lines = (await Deno.readTextFile(unitsFile)).split(/\r?\n/).filter((l) => /^\d{4},/.test(l));
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const values: string[] = [];
const misses: Array<Record<string, unknown>> = [];
for (const l of lines) {
  const [eid, election_type, region, sub_region, village, n] = parseCsvLine(l);
  const unit = { election_type, region, sub_region, village };
  const m = matchBulletin(unit, index, Number(eid), yearDirs);
  if (!m.ok) { misses.push({ election_id: Number(eid), ...unit, candidates: Number(n), reason: m.reason }); continue; }
  const paths = m.paths.map(bulletinRelPath);
  values.push(`(${eid},${q(election_type)},${q(region)},${q(sub_region)},${q(village)},ARRAY[${paths.map(q).join(",")}],${q(m.how)})`);
}
await Deno.writeTextFile(outSql, values.join(",\n") + "\n");
await Deno.writeTextFile(outReport, JSON.stringify(misses, null, 1));
console.error(`對到 ${values.length} 個單位、對不到 ${misses.length} 個單位（${misses.reduce((s, m) => s + (m.candidates as number), 0)} 位候選人）`);
