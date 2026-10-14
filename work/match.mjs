// 2026 縣市議員參選紀錄 -> 選區 比對（唯讀，只產出 CSV/報告，不寫 DB）
import fs from "node:fs";
import { parseSchemaA } from "./parse-schemaA.mjs";

// ---------- 小工具 ----------
function toTaiwan(s) { return String(s ?? "").replace(/臺/g, "台"); }
// 罕見異體字：中選會名冊 vs 我們資料庫，兩邊選字不一定一致（NFKC 不會處理這類「非相容變體」）
const CJK_VARIANTS = { "勲": "勳", "黄": "黃", "叁": "參", "叄": "參", "凖": "準", "顔": "顏", "国": "國", "姗": "姍" };
function canonChars(s) {
  return String(s).replace(/[\s\S]/g, (ch) => CJK_VARIANTS[ch] ?? ch);
}
function normName(s) {
  return canonChars(toTaiwan(String(s ?? "")))
    .normalize("NFKC")
    .toLowerCase()
    // 名字中的間隔點（原住民羅馬拼音常見）：全形/半形/日文中點都當分隔符移除，跟空白一起清掉
    .replace(/[\s·‧・･.]+/g, "")
    .trim();
}
// 同一政黨的全稱／簡稱寫法（名冊 vs 我們資料庫，兩邊寫法不一定一致）
const PARTY_ALIAS = {
  "民眾黨": "台灣民眾黨",
  "台灣基進黨": "台灣基進",
  "綠黨": "台灣綠黨",
  "國民黨": "中國國民黨",
  "民進黨": "民主進步黨",
};
function normPartyKey(p) {
  const v = toTaiwan(String(p ?? "")).normalize("NFKC").replace(/\s+/g, "");
  if (["", "無", "無黨籍", "無黨籍及未經政黨推薦", "無黨"].includes(v)) return "無";
  return PARTY_ALIAS[v] ?? v;
}

// 「南投縣第1選舉區」→ {region:"南投縣", district:"第01選舉區"}
function normDistrict(rawDistrict) {
  const t = toTaiwan(rawDistrict);
  const m = /^(.+?)第(\d+)選舉區$/.exec(t);
  if (!m) return null;
  const region = m[1];
  const num = Number.parseInt(m[2], 10);
  const district = `第${String(num).padStart(2, "0")}選舉區`;
  return { region, district };
}

// 原住民保留議席常數（照抄 supabase/functions/_shared/electoral-district.ts 的
// COUNCIL_ABORIGINAL_DISTRICTS，2026-09-28 版本，只讀比對用，不改原檔）
const COUNCIL_ABORIGINAL_DISTRICTS = {
  台北市: ["第07選舉區", "第08選舉區"],
  新北市: ["第12選舉區", "第13選舉區"],
  桃園市: ["第13選舉區", "第14選舉區"],
  台中市: ["第15選舉區", "第16選舉區"],
  台南市: ["第12選舉區", "第13選舉區"],
  高雄市: ["第12選舉區", "第13選舉區", "第14選舉區", "第15選舉區"],
  南投縣: ["第06選舉區", "第07選舉區", "第08選舉區"],
  彰化縣: ["第09選舉區", "第10選舉區"],
  雲林縣: ["第07選舉區", "第08選舉區"],
  基隆市: ["第08選舉區", "第09選舉區"],
  新竹市: ["第06選舉區", "第07選舉區"],
  宜蘭縣: ["第11選舉區", "第12選舉區", "第13選舉區"],
};

// ---------- 讀檔 ----------
function parseCsv(path) {
  const text = fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}
// 簡易 CSV 欄位切分（supabase db query -o csv 輸出不含內嵌逗號的欄位，這裡的資料沒有雙引號跳脫需求）
function splitCsvLine(line) {
  return line.split(",");
}

const candidates = parseCsv("work/candidates_2026.csv");
const areas = parseCsv("work/areas_2026.csv"); // region,electoral_district,township
const regionsStd = parseCsv("work/regions_std.csv"); // id,region,sub_region

const areaSet = new Set(areas.map((a) => `${toTaiwan(a.region)}|${a.electoral_district}`));
const areaRegionsPresent = new Set(areas.map((a) => toTaiwan(a.region)));
const regionIdMap = new Map(regionsStd.map((r) => [`${toTaiwan(r.region)}|${r.sub_region}`, r.id]));

// ---------- 解析名冊 PDF（兩份全國彙總表：六都 + 其餘 16 縣市） ----------
const metroRaw = fs.readFileSync("work/pdfs/ccd7e51a.unpdf.txt", "utf8");
const otherRaw = fs.readFileSync("work/pdfs/729644ff.unpdf.txt", "utf8");
const metroParsed = parseSchemaA(metroRaw, "https://web.cec.gov.tw/api/file/ccd7e51a-5fd0-4ea0-a81b-a120cd550c9c.pdf (115年直轄市議員選舉候選人登記彙總表)");
const otherParsed = parseSchemaA(otherRaw, "https://web.cec.gov.tw/api/file/729644ff-cb01-42bb-a052-c9b3c55a1289.pdf (115年縣市議員選舉候選人登記彙總表)");

const parseFailures = [...metroParsed.unresolved, ...otherParsed.unresolved];
const rosterRowsRaw = [...metroParsed.rows, ...otherParsed.rows];

// ---------- 名冊索引：region -> normName -> [{district, party, rawName, source_pdf}] ----------
const rosterIndex = new Map();
for (const r of rosterRowsRaw) {
  const nd = normDistrict(r.district);
  if (!nd) { parseFailures.push({ reason: "district-not-parseable", raw: r }); continue; }
  const region = nd.region;
  const key = normName(r.name);
  if (!rosterIndex.has(region)) rosterIndex.set(region, new Map());
  const byName = rosterIndex.get(region);
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push({ district: nd.district, party: r.party, rawName: r.name, source_pdf: r.source_pdf });
}

// ---------- 逐一比對候選人 ----------
const matched = [];
const notFound = [];
const ambiguous = [];
const prefixMatched = []; // 原住民「漢名+羅馬拼音」合併登記：DB 只存漢名，名冊漢名+拼音黏在一起
const districtNotInRegistry = [];
const hsinchuCountyAccepted = []; // 新竹縣：照收但標記（無名冊可核）
const missingRegionRow = new Set(); // (region, district) 組合 -> regions 沒有現成列

for (const c of candidates) {
  const region = toTaiwan(c.region);
  const nameKey = normName(c.name);
  const byName = rosterIndex.get(region);
  const hits = byName ? (byName.get(nameKey) ?? []) : [];

  if (hits.length === 0) {
    notFound.push(c);
    continue;
  }
  if (hits.length > 1) {
    ambiguous.push({ c, hits });
    continue;
  }

  const hit = hits[0];
  const partyMatch = normPartyKey(c.party) === normPartyKey(hit.party) ? "yes" : "no";

  // 選舉區是否在名冊 / 原住民保留議席
  const inRegistry = areaSet.has(`${region}|${hit.district}`);
  const isAboriginal = (COUNCIL_ABORIGINAL_DISTRICTS[region] ?? []).includes(hit.district);
  const isHsinchuCounty = region === "新竹縣";

  if (!inRegistry && !isAboriginal && !isHsinchuCounty) {
    districtNotInRegistry.push({ c, hit });
    continue;
  }
  if (isHsinchuCounty && !inRegistry && !isAboriginal) {
    hsinchuCountyAccepted.push({ c, hit });
    // 仍然照收，繼續往下寫入 matched（見下方 push），但先記錄標記名單
  }

  const regionRowId = regionIdMap.get(`${region}|${hit.district}`) ?? "";
  if (regionRowId === "") missingRegionRow.add(`${region}|${hit.district}`);
  const isHsinchuFlag = isHsinchuCounty && !inRegistry && !isAboriginal;

  matched.push({
    politician_election_id: c.politician_election_id,
    politician_id: c.politician_id,
    name: c.name,
    region,
    electoral_district: hit.district,
    party_match: partyMatch,
    region_row_id: regionRowId,
    source_pdf: isHsinchuFlag
      ? `${hit.source_pdf} [新竹縣：2026 選區無官方逐里公告可核，選區依候選人登記冊反推，見 docs/DISTRICT-REGISTRY-2026.md]`
      : hit.source_pdf,
    hsinchu_no_registry: isHsinchuFlag,
  });
}

// ---------- 二次比對：原住民「漢名+羅馬拼音」合併登記（名冊漢名與拼音之間不一定有可辨識分隔符，
// DB 只存漢名部分），對還沒配到的候選人嘗試「名冊姓名開頭 = DB 姓名」的唯一前綴比對，仍然要求
// 該縣市裡唯一，配到多筆就不猜、留在 notFound。 ----------
const stillNotFound = [];
for (const c of notFound) {
  const region = toTaiwan(c.region);
  const nameKey = normName(c.name);
  const byName = rosterIndex.get(region);
  if (!byName || nameKey.length < 2) { stillNotFound.push(c); continue; }
  const prefixHits = [];
  for (const [key, entries] of byName.entries()) {
    // 名冊姓名 = 漢名+羅馬拼音黏在一起，DB 有時只存漢名（開頭比對），有時只存拼音部分（中間比對），
    // 只要求整個縣市裡唯一，多筆就不猜。
    if (key.length > nameKey.length && nameKey.length >= 2 && key.includes(nameKey)) {
      for (const e of entries) prefixHits.push(e);
    }
  }
  if (prefixHits.length !== 1) { stillNotFound.push(c); continue; }
  const hit = prefixHits[0];
  const partyMatch = normPartyKey(c.party) === normPartyKey(hit.party) ? "yes" : "no";
  const inRegistry = areaSet.has(`${region}|${hit.district}`);
  const isAboriginal = (COUNCIL_ABORIGINAL_DISTRICTS[region] ?? []).includes(hit.district);
  const isHsinchuCounty = region === "新竹縣";
  if (!inRegistry && !isAboriginal && !isHsinchuCounty) {
    districtNotInRegistry.push({ c, hit });
    continue;
  }
  const regionRowId = regionIdMap.get(`${region}|${hit.district}`) ?? "";
  if (regionRowId === "") missingRegionRow.add(`${region}|${hit.district}`);
  prefixMatched.push({ c, hit, rosterFullName: hit.rawName });
  matched.push({
    politician_election_id: c.politician_election_id,
    politician_id: c.politician_id,
    name: c.name,
    region,
    electoral_district: hit.district,
    party_match: partyMatch,
    region_row_id: regionRowId,
    source_pdf: `${hit.source_pdf} [前綴比對：名冊姓名「${hit.rawName}」]`,
    hsinchu_no_registry: isHsinchuCounty && !inRegistry && !isAboriginal,
  });
}

// ---------- notFound 候選人：是否同名者其實登記在「別的縣市」（可能是資料庫縣市欄位錯誤的線索） ----------
const globalNameIndex = new Map(); // normName -> [{region, district, party}]
for (const [region, byName] of rosterIndex.entries()) {
  for (const [key, entries] of byName.entries()) {
    for (const e of entries) {
      if (!globalNameIndex.has(key)) globalNameIndex.set(key, []);
      globalNameIndex.get(key).push({ region, district: e.district, party: e.party });
    }
  }
}
const crossRegionHints = [];
for (const c of stillNotFound) {
  const nameKey = normName(c.name);
  const hits = (globalNameIndex.get(nameKey) ?? []).filter((h) => h.region !== toTaiwan(c.region));
  if (hits.length > 0) crossRegionHints.push({ id: c.politician_election_id, name: c.name, dbRegion: toTaiwan(c.region), foundIn: hits });
}

// ---------- 輸出 CSV ----------
function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvHeader = "politician_election_id,politician_id,name,region,electoral_district,party_match,region_row_id,source_pdf";
const csvLines = [csvHeader];
for (const m of matched) {
  csvLines.push([
    m.politician_election_id, m.politician_id, m.name, m.region, m.electoral_district,
    m.party_match, m.region_row_id, m.source_pdf,
  ].map(csvEscape).join(","));
}
fs.writeFileSync("district_backfill_2026.csv", csvLines.join("\n") + "\n", "utf8");

// ---------- 輸出比對結果（供撰寫報告用的中繼 JSON） ----------
fs.writeFileSync("work/match-result.json", JSON.stringify({
  totals: {
    candidates: candidates.length,
    matched: matched.length,
    directMatched: matched.length - prefixMatched.length,
    prefixMatched: prefixMatched.length,
    notFound: stillNotFound.length,
    ambiguous: ambiguous.length,
    districtNotInRegistry: districtNotInRegistry.length,
    hsinchuCountyAccepted: hsinchuCountyAccepted.length,
    partyMismatch: matched.filter((m) => m.party_match === "no").length,
    rosterRowsTotal: rosterRowsRaw.length,
  },
  parseFailures,
  notFound: stillNotFound.map((c) => ({ id: c.politician_election_id, name: c.name, region: toTaiwan(c.region), party: c.party, existing_sub_region: c.sub_region })),
  crossRegionHints,
  prefixMatched: prefixMatched.map(({ c, hit, rosterFullName }) => ({ id: c.politician_election_id, dbName: c.name, region: toTaiwan(c.region), rosterFullName, district: hit.district })),
  ambiguous: ambiguous.map(({ c, hits }) => ({ id: c.politician_election_id, name: c.name, region: toTaiwan(c.region), party: c.party, hits })),
  districtNotInRegistry: districtNotInRegistry.map(({ c, hit }) => ({ id: c.politician_election_id, name: c.name, region: toTaiwan(c.region), district: hit.district })),
  hsinchuCountyAccepted: hsinchuCountyAccepted.map(({ c, hit }) => ({ id: c.politician_election_id, name: c.name, district: hit.district })),
  missingRegionRow: [...missingRegionRow].sort(),
  partyMismatchDetail: matched.filter((m) => m.party_match === "no").map((m) => ({ id: m.politician_election_id, name: m.name, region: m.region, district: m.electoral_district })),
}, null, 2), "utf8");

console.log("candidates:", candidates.length);
console.log("matched:", matched.length, "(direct:", matched.length - prefixMatched.length, ", prefix-fallback:", prefixMatched.length, ")");
console.log("notFound:", stillNotFound.length);
console.log("ambiguous:", ambiguous.length);
console.log("districtNotInRegistry:", districtNotInRegistry.length);
console.log("hsinchuCountyAccepted(no registry, still kept):", hsinchuCountyAccepted.length);
console.log("partyMismatch among matched:", matched.filter((m) => m.party_match === "no").length);
console.log("parseFailures:", parseFailures.length);
console.log("missingRegionRow combos:", missingRegionRow.size);
console.log("crossRegionHints:", crossRegionHints.length);
