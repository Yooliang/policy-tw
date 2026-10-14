// 比對「我們的 politician_elections（2022）」與「中選會候選人名單」，只找號次（cand_no）。
// 只讀，不寫任何資料庫；輸出 cand_no_2022.csv 與統計。
import { readFileSync, writeFileSync } from "node:fs";

// 中選會罕見字（超出常用字集）用 "@十六進位碼位@" 表示，例如 "@2C9F7@" 就是 U+2C9F7（𬧷）。
// 我們資料庫存的是實際的 Unicode 字，比對前要先解碼，不然「林𬧷昌」永遠對不到「林@2C9F7@昌」。
function decodeCecRareChars(s) {
  return String(s).replace(/@([0-9A-Fa-f]+)@/g, (_, hex) => {
    try {
      return String.fromCodePoint(parseInt(hex, 16));
    } catch {
      return _;
    }
  });
}

// 原住民族名常見的分隔點（中間點／全形句點／半形句點）在雙邊寫法不一定一致，比對時整個拿掉；
// 中選會姓名欄有時會附英文拼音（如「谷辣斯．尤達卡 Kolas Yotaka」)，我們資料庫沒有，一併拿掉。
function norm(s) {
  if (s === undefined || s === null) return "";
  return decodeCecRareChars(String(s))
    // 中選會的罕見字有些解出來是「CJK 相容表意文字」（如 U+2F97F），跟我們資料庫存的一般統一表意文字
    // （如「聰」U+8070）視覺相同但碼位不同，用 NFKC 正規化收斂成同一個碼位再比對。
    .normalize("NFKC")
    .replace(/臺/g, "台")
    // 中選會資料庫「黃」姓常整批寫成異體字「黄」（U+9EC4，非 NFKC 相容分解可解決的組合），
    // 這是該資料庫本身的系統性寫法、不是猜姓名，統一收斂成「黃」比對。
    .replace(/黄/g, "黃")
    .replace(/[·‧．.]/g, "")
    .replace(/[A-Za-z]+/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    // 欄位內容都不含逗號（姓名／地名），用簡單 split 即可
    const cols = line.split(",");
    const row = {};
    header.forEach((h, i) => (row[h] = cols[i] === "NULL" || cols[i] === "" ? null : cols[i]));
    return row;
  });
}

const ourRows = parseCsv(readFileSync(new URL("../our_2022.csv", import.meta.url), "utf8")).map((r) => ({
  pe_id: r.pe_id,
  politician_id: r.politician_id,
  election_type: r.election_type,
  region: r.region,
  sub_region: r.sub_region,
  village: r.village,
  name: r.name,
  birth_year: r.birth_year ? Number(r.birth_year) : null,
}));

const cecA = JSON.parse(readFileSync(new URL("./cec_candidates.json", import.meta.url), "utf8"));
const cecB = JSON.parse(readFileSync(new URL("./cec_mayor_direct.json", import.meta.url), "utf8"));
const allCec = [...cecA, ...cecB].map((c, i) => ({
  idx: i,
  ourType: c.ourType,
  region: c.region,
  requestedRegion: c.requestedRegion,
  subRegion: c.subRegion,
  village: c.village,
  name: c.name,
  birthYear: c.birthYear,
  candNo: c.candNo,
  used: false,
}));

// 直轄市山地原住民區民代表：我們資料庫這個選舉別把「桃園市復興區」誤存成「台南市」（見 our_2022.csv 查核），
// 比對時用實際城市（桃園市）去找中選會資料，輸出仍保留原本 region 欄位（不動資料庫）。
function matchRegionFor(row) {
  if (row.election_type === "直轄市山地原住民區民代表" && row.region === "台南市") return "桃園市";
  return row.region;
}

// 分組工具：把陣列依 key function 分組，回 Map<key, items[]>
function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const k = keyFn(item);
    if (k === null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function birthCompatible(row, cand) {
  if (!row.birth_year || !cand.birthYear) return true; // 缺資料就不擋
  return row.birth_year === cand.birthYear;
}

const results = []; // {pe_id, cand_no, name, election_type, region, match_basis}
const matchedPeIds = new Set();

// 依 election_type 分開跑
const byType = groupBy(ourRows, (r) => r.election_type);

for (const [electionType, rowsOfType] of byType) {
  let unmatchedRows = rowsOfType.slice();
  const candPool = allCec.filter((c) => c.ourType === electionType);

  const tiersFor = (et) => {
    if (et === "縣市長") {
      return [
        { name: "name+region", rowKey: (r) => `${matchRegionFor(r)}|${norm(r.name)}`, candKey: (c) => `${c.requestedRegion}|${norm(c.name)}` },
      ];
    }
    if (et === "鄉鎮市長") {
      return [
        { name: "name+district", rowKey: (r) => (r.sub_region ? `${matchRegionFor(r)}|${norm(r.sub_region)}|${norm(r.name)}` : null), candKey: (c) => `${c.requestedRegion}|${norm(c.subRegion)}|${norm(c.name)}` },
        { name: "name+birth", rowKey: (r) => (r.birth_year ? `${matchRegionFor(r)}|${norm(r.name)}|${r.birth_year}` : null), candKey: (c) => (c.birthYear ? `${c.requestedRegion}|${norm(c.name)}|${c.birthYear}` : null) },
        { name: "name+region", rowKey: (r) => `${matchRegionFor(r)}|${norm(r.name)}`, candKey: (c) => `${c.requestedRegion}|${norm(c.name)}` },
      ];
    }
    if (et === "縣市議員" || et === "直轄市山地原住民區民代表") {
      return [
        { name: "name+district", rowKey: (r) => (r.sub_region ? `${matchRegionFor(r)}|${norm(r.sub_region)}|${norm(r.name)}` : null), candKey: (c) => `${c.requestedRegion}|${norm(c.subRegion)}|${norm(c.name)}` },
        { name: "name+birth", rowKey: (r) => (r.birth_year ? `${matchRegionFor(r)}|${norm(r.name)}|${r.birth_year}` : null), candKey: (c) => (c.birthYear ? `${c.requestedRegion}|${norm(c.name)}|${c.birthYear}` : null) },
        { name: "name+region", rowKey: (r) => `${matchRegionFor(r)}|${norm(r.name)}`, candKey: (c) => `${c.requestedRegion}|${norm(c.name)}` },
      ];
    }
    if (et === "村里長") {
      return [
        { name: "name+district+village", rowKey: (r) => (r.sub_region && r.village ? `${matchRegionFor(r)}|${norm(r.sub_region)}|${norm(r.village)}|${norm(r.name)}` : null), candKey: (c) => (c.subRegion && c.village ? `${c.requestedRegion}|${norm(c.subRegion)}|${norm(c.village)}|${norm(c.name)}` : null) },
        { name: "name+village", rowKey: (r) => (r.village ? `${matchRegionFor(r)}|${norm(r.village)}|${norm(r.name)}` : null), candKey: (c) => (c.village ? `${c.requestedRegion}|${norm(c.village)}|${norm(c.name)}` : null) },
        { name: "name+district", rowKey: (r) => (r.sub_region ? `${matchRegionFor(r)}|${norm(r.sub_region)}|${norm(r.name)}` : null), candKey: (c) => `${c.requestedRegion}|${norm(c.subRegion)}|${norm(c.name)}` },
        { name: "name+birth", rowKey: (r) => (r.birth_year ? `${matchRegionFor(r)}|${norm(r.name)}|${r.birth_year}` : null), candKey: (c) => (c.birthYear ? `${c.requestedRegion}|${norm(c.name)}|${c.birthYear}` : null) },
        { name: "name+region", rowKey: (r) => `${matchRegionFor(r)}|${norm(r.name)}`, candKey: (c) => `${c.requestedRegion}|${norm(c.name)}` },
      ];
    }
    // 其他未預期的 election_type：只用 name+region
    return [{ name: "name+region", rowKey: (r) => `${matchRegionFor(r)}|${norm(r.name)}`, candKey: (c) => `${c.requestedRegion}|${norm(c.name)}` }];
  };

  for (const tier of tiersFor(electionType)) {
    if (unmatchedRows.length === 0) break;
    const availableCands = candPool.filter((c) => !c.used);
    const rowGroups = groupBy(unmatchedRows, tier.rowKey);
    const candGroups = groupBy(availableCands, tier.candKey);

    const stillUnmatched = [];
    for (const row of unmatchedRows) {
      const k = tier.rowKey(row);
      if (k === null) { stillUnmatched.push(row); continue; }
      const rGroup = rowGroups.get(k);
      const cGroup = candGroups.get(k);
      if (rGroup.length === 1 && cGroup && cGroup.length === 1) {
        const cand = cGroup[0];
        if (birthCompatible(row, cand)) {
          cand.used = true;
          matchedPeIds.add(row.pe_id);
          results.push({
            pe_id: row.pe_id,
            cand_no: cand.candNo,
            name: row.name,
            election_type: row.election_type,
            region: row.region,
            match_basis: tier.name,
          });
          continue;
        }
      }
      stillUnmatched.push(row);
    }
    unmatchedRows = stillUnmatched;
  }

  // 最後這批仍然對不到的：分類原因
  for (const row of unmatchedRows) {
    const mRegion = matchRegionFor(row);
    const sameNameCands = candPool.filter((c) => c.requestedRegion === mRegion && norm(c.name) === norm(row.name));
    const sameNameRows = rowsOfType.filter((r2) => matchRegionFor(r2) === mRegion && norm(r2.name) === norm(row.name));
    let reason;
    if (sameNameCands.length === 0) reason = "中選會查無同名同區候選人";
    else if (sameNameRows.length > 1 && sameNameCands.length > 1) reason = "雙邊同名同區都有多筆，無法唯一對應";
    else if (sameNameRows.length > 1) reason = "我方同名同區有多筆（可能不同選區/村里混在一起)";
    else if (sameNameCands.length > 1) reason = "中選會同名同區有多筆候選人（可能不同選區/村里)";
    else reason = "出生年或其他欄位不符，保守判定為不同人";
    row._reason = reason;
    row._candCount = sameNameCands.length;
    row._rowCount = sameNameRows.length;
  }

  byType.set(electionType, { unmatchedRows, rowsOfType });
}

// 統計輸出
const summary = {};
for (const [electionType, info] of byType) {
  const total = info.rowsOfType.length;
  const matched = info.rowsOfType.filter((r) => matchedPeIds.has(r.pe_id)).length;
  const unmatched = info.unmatchedRows;
  const noCand = unmatched.filter((r) => r._reason === "中選會查無同名同區候選人");
  const ambiguous = unmatched.filter((r) => r._reason !== "中選會查無同名同區候選人");
  summary[electionType] = {
    total,
    matched,
    unmatchedNoCandidate: noCand.length,
    ambiguousMultiMatch: ambiguous.length,
    noCandExamples: noCand.slice(0, 5).map((r) => ({ name: r.name, region: r.region, sub_region: r.sub_region, village: r.village })),
    ambiguousExamples: ambiguous.slice(0, 5).map((r) => ({ name: r.name, region: r.region, sub_region: r.sub_region, village: r.village, reason: r._reason, candCount: r._candCount, rowCount: r._rowCount })),
  };
}

writeFileSync(new URL("./match_summary.json", import.meta.url), JSON.stringify(summary, null, 2));

// 輸出 CSV
const csvLines = ["politician_election_id,cand_no,name,election_type,region,match_basis"];
for (const r of results) {
  const esc = (v) => (v === null || v === undefined ? "" : String(v).includes(",") ? `"${v}"` : v);
  csvLines.push([r.pe_id, r.cand_no, esc(r.name), esc(r.election_type), esc(r.region), r.match_basis].join(","));
}
writeFileSync(new URL("../cand_no_2022.csv", import.meta.url), csvLines.join("\n") + "\n");

console.log(`總列數 ${ourRows.length}，成功比對 ${results.length} 筆`);
console.log(JSON.stringify(summary, null, 2));
