/**
 * 名冊 × 我們現有的人：每一類、每一個單位缺多少人（正式庫唯讀快照，不進 CI）。
 *
 *   # 1. 取快照（唯讀）：檔案第一行 SET default_transaction_read_only = on;
 *   #    SELECT p.id::text AS pid, p.name, p.region AS p_region, p.sub_region AS p_sub, pe.election_type, pe.candidacy_status,
 *   #           rg.region AS r_region, rg.sub_region AS r_sub, rg.village AS r_village
 *   #      FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
 *   #      LEFT JOIN regions rg ON rg.id = pe.region_id WHERE pe.election_id = 2026 ORDER BY pe.id;
 *   npx supabase db query --linked -f ours.sql > ours.json
 *   # 2. 在 PGlite 上灌真的 migration（資料表、19,695 列、roster_registration_gap）＋ 這份快照，逐單位跑缺口函式
 *   deno run -A scripts/cec-registrations-snapshot.ts ours.json
 *
 * 輸出：各選舉別的 名冊人數／我們已有／缺／姓名空白，單位數，以及「若一個單位一批、一批最多 20 位」會分成幾批
 * （協議每次交件最多 20 筆）。用途：估名單清查任務附上缺的名單之後，代理要補多少、分幾次補。
 * 交叉檢查：另用 JS（不呼叫 SQL）獨立算每一類的總數，兩邊要一樣。
 */
import { buildRegistrationsDb, loadOurs, type OursRow } from "../supabase/functions/_shared/cec-registrations-pglite.ts";

const path = Deno.args[0];
if (!path) { console.error("用法：deno run -A scripts/cec-registrations-snapshot.ts <ours.json>"); Deno.exit(2); }
const raw = await Deno.readTextFile(path);
const ours = (JSON.parse(raw.slice(raw.indexOf("{"))) as { rows: OursRow[] }).rows;

const db = await buildRegistrationsDb();
await loadOurs(db, ours);

type Unit = { election_type: string; region: string; sub_region: string | null };
const TOWN_LEVEL = new Set(["村里長", "鄉鎮市民代表", "直轄市山地原住民區民代表"]);
const units = (await db.query<Unit>(
  `SELECT DISTINCT r.election_type, r.region, CASE WHEN r.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN r.sub_region END AS sub_region
     FROM cec_registrations r JOIN cec_registration_sources s USING (source_url) WHERE s.superseded_by IS NULL ORDER BY 1, 2, 3`,
)).rows;

type Gap = { registered: number; matched: number; missing_count: number; unnamed_count: number };
const byType = new Map<string, { registered: number; matched: number; missing: number; unnamed: number; units: number; unitsWithGap: number; batches20: number; maxUnit: number }>();
// 各單位的缺口人數，算不同批次上限下要分成幾批
const gaps: number[] = [];
for (const u of units) {
  const g = (await db.query<{ g: Gap }>("SELECT roster_registration_gap(2026, $1, $2, $3, 500) AS g", [u.election_type, u.region, u.sub_region])).rows[0].g;
  const t = byType.get(u.election_type) ?? { registered: 0, matched: 0, missing: 0, unnamed: 0, units: 0, unitsWithGap: 0, batches20: 0, maxUnit: 0 };
  t.registered += g.registered; t.matched += g.matched; t.missing += g.missing_count; t.unnamed += g.unnamed_count; t.units++;
  if (g.missing_count > 0) { gaps.push(g.missing_count); t.unitsWithGap++; t.batches20 += Math.ceil(g.missing_count / 20); t.maxUnit = Math.max(t.maxUnit, g.missing_count); }
  byType.set(u.election_type, t);
}
void TOWN_LEVEL;

// 獨立的 JS 總數（不呼叫 SQL 的缺口函式）：名冊 × 我們，縣市層級比對（村里長另比鄉鎮）
const regs = (await db.query<{ election_type: string; region: string; sub_region: string | null; name_key: string | null }>(
  "SELECT r.election_type, r.region, r.sub_region, r.name_key FROM cec_registrations r JOIN cec_registration_sources s USING (source_url) WHERE s.superseded_by IS NULL",
)).rows;
const norm0 = (s: string) => s.normalize("NFKC").replace(/臺/g, "台").replace(/黄/g, "黃").replace(/[\s·．.・‧•]/g, "");
const key = (s: string) => norm0(s).replace(/[A-Za-z]+$/, "") || norm0(s) || null;
const norm = (s: string | null) => (s ?? "").replace(/臺/g, "台");
const oursBy = new Map<string, Array<string | null>>();
for (const o of ours) {
  const county = norm(o.r_region ?? o.p_region);
  const sub = o.r_region ? o.r_sub : o.p_sub;
  const town = sub ? norm(sub.replace(/(第[0-9]+)?選舉區$/, "")) || null : null;
  const k = `${o.election_type}|${county}|${key(o.name)}`;
  oursBy.set(k, [...(oursBy.get(k) ?? []), town]);
}
const jsMissing = new Map<string, number>();
for (const r of regs) {
  if (r.name_key === null) continue;
  const hit = (oursBy.get(`${r.election_type}|${r.region}|${r.name_key}`) ?? []).some((t) => t === null || r.sub_region === null || t === norm(r.sub_region));
  if (!hit) jsMissing.set(r.election_type, (jsMissing.get(r.election_type) ?? 0) + 1);
}

console.log(`我們 2026 的參選紀錄 ${ours.length} 筆（含退選、可能參選）`);
console.log("選舉別\t名冊\t我們已有\t缺\t姓名空白\t單位數\t有缺的單位\t最大單位缺\t分批(一批≤20)\tJS 獨立重算缺");
let tot = { registered: 0, matched: 0, missing: 0, unnamed: 0, units: 0, unitsWithGap: 0, batches20: 0 };
let ok = true;
for (const [type, t] of [...byType.entries()].sort()) {
  const js = jsMissing.get(type) ?? 0;
  if (js !== t.missing) ok = false;
  console.log([type, t.registered, t.matched, t.missing, t.unnamed, t.units, t.unitsWithGap, t.maxUnit, t.batches20, js].join("\t"));
  tot = { registered: tot.registered + t.registered, matched: tot.matched + t.matched, missing: tot.missing + t.missing, unnamed: tot.unnamed + t.unnamed,
    units: tot.units + t.units, unitsWithGap: tot.unitsWithGap + t.unitsWithGap, batches20: tot.batches20 + t.batches20 };
}
console.log(["合計", tot.registered, tot.matched, tot.missing, tot.unnamed, tot.units, tot.unitsWithGap, "", tot.batches20, [...jsMissing.values()].reduce((a, b) => a + b, 0)].join("\t"));
console.log("一個單位一批、一批最多 N 筆 → 批數：" + [20, 50, 100, 120].map((n) => `N=${n}：${gaps.reduce((a, g) => a + Math.ceil(g / n), 0)}`).join("　"));
if (!ok) { console.error("SQL 與 JS 獨立重算不一致"); Deno.exit(1); }
