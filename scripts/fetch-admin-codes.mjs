#!/usr/bin/env node
/**
 * 內政部官方行政區代碼（縣市／鄉鎮市區／村里）→ admin_divisions 的資料段（#348）。
 *
 *   node scripts/fetch-admin-codes.mjs --json 清單.json                 # 抓官方清單，存成 JSON
 *   node scripts/fetch-admin-codes.mjs --from 清單.json --sql 資料段.sql  # 從存好的清單產 migration 的資料段
 *   node scripts/fetch-admin-codes.mjs --sql 資料段.sql                  # 兩步一起做
 *
 * 來源：內政部國土測繪中心「行政區域及村里」API（免金鑰）
 *   縣市      https://api.nlsc.gov.tw/other/ListCounty                         countycode01＝5 碼（63000 臺北市）
 *   鄉鎮市區  https://api.nlsc.gov.tw/other/ListTown1/<縣市字母>                towncode＝8 碼（63000010 松山區）
 *   村里      https://api.nlsc.gov.tw/other/ListVillage/<縣市字母>/<鄉鎮字母碼>  villageId＝11 碼（63000010002 莊敬里）
 * 三層代碼跟內政部戶政司的「行政區域代碼」同一套：縣市 5 碼＋鄉鎮市區 3 碼＋村里 3 碼。
 *
 * 兩件要知道的事：
 * - 村里清單裡夾著沒有名字、代碼結尾是字母的列（09007010S01 這種，離島與港區的編碼），不是村里，丟掉。
 * - 名稱照官方原字寫（「臺」不改「台」）；不在常用字集裡的字，國土測繪中心用方括號標出來
 *   （「磚[磘]里」「石[曹]里」），也照原樣存。比對時的正規化在 SQL 那一邊（admin_match_key）。
 *
 * 行政區很少變（村里偶爾調整），所以不排程：要更新就重跑這支、另寫一支 migration 補差異。
 */
import { readFileSync, writeFileSync } from "node:fs";

const BASE = "https://api.nlsc.gov.tw/other";
const UA = "Mozilla/5.0 (compatible; policy-tw-admin-codes/1.0; +https://xn--2lw665d.tw)";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function get(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BASE}/${path}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt >= 4) throw new Error(`${path}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** 抓 <tag>…</tag> 一組組的欄位（API 回的是很規矩的 XML，不需要完整的解析器） */
function items(xml, itemTag, fields) {
  const rows = [];
  for (const m of xml.matchAll(new RegExp(`<${itemTag}>([\\s\\S]*?)</${itemTag}>`, "g"))) {
    const row = {};
    for (const f of fields) {
      const v = m[1].match(new RegExp(`<${f}>([^<]*)</${f}>`));
      row[f] = v ? v[1].trim() : null;
    }
    rows.push(row);
  }
  return rows;
}

async function fetchAll() {
  const counties = items(await get("ListCounty"), "countyItem", ["countycode", "countyname", "countycode01"]);
  if (counties.length !== 22) throw new Error(`縣市應有 22 個，拿到 ${counties.length}`);
  const rows = [];
  for (const c of counties) {
    rows.push({ code: c.countycode01, level: "county", county: c.countyname, town: null, village: null });
    const towns = items(await get(`ListTown1/${c.countycode}`), "townItem", ["towncode", "towncode01", "townname"]);
    if (towns.length === 0) throw new Error(`${c.countyname} 沒有鄉鎮市區`);
    for (const t of towns) {
      if (!t.towncode?.startsWith(c.countycode01)) throw new Error(`${c.countyname} ${t.townname} 代碼 ${t.towncode} 不在縣市底下`);
      rows.push({ code: t.towncode, level: "town", county: c.countyname, town: t.townname, village: null });
      const villages = items(await get(`ListVillage/${c.countycode}/${t.towncode01}`), "village", ["villageId", "villageName"]);
      for (const v of villages) {
        if (!/^\d{11}$/.test(v.villageId ?? "")) continue; // 離島、港區的編碼，不是村里
        if (!v.villageId.startsWith(t.towncode)) throw new Error(`${t.townname} ${v.villageName} 代碼 ${v.villageId} 不在鄉鎮底下`);
        if (!v.villageName) throw new Error(`${v.villageId} 沒有名稱`);
        rows.push({ code: v.villageId, level: "village", county: c.countyname, town: t.townname, village: v.villageName });
      }
      await new Promise((r) => setTimeout(r, 150)); // 別打太快
    }
    process.stderr.write(`${c.countyname}：${towns.length} 個鄉鎮市區\n`);
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));
  const count = (lv) => rows.filter((r) => r.level === lv).length;
  return {
    source: "內政部國土測繪中心 行政區域及村里 API（https://api.nlsc.gov.tw/other/）",
    fetched_on: new Date().toISOString().slice(0, 10),
    counts: { county: count("county"), town: count("town"), village: count("village") },
    rows,
  };
}

const q = (s) => (s === null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);

/** migration 的資料段：縣市、鄉鎮市區各一段 VALUES；村里只寫代碼與名稱，縣市與鄉鎮名從上一層帶 */
function toSql(doc) {
  const { rows, counts, fetched_on, source } = doc;
  const head = rows.filter((r) => r.level !== "village");
  const villages = rows.filter((r) => r.level === "village");
  return [
    `-- ↓↓↓ 資料段：scripts/fetch-admin-codes.mjs 產生，不要手改（${source}，擷取日 ${fetched_on}）`,
    `-- 縣市 ${counts.county}、鄉鎮市區 ${counts.town}、村里 ${counts.village}`,
    "INSERT INTO admin_divisions (code, level, parent_code, county, town, village, fetched_on) VALUES",
    head.map((r) => `(${q(r.code)},${q(r.level)},${r.level === "town" ? q(r.code.slice(0, 5)) : "NULL"},${q(r.county)},${q(r.town)},NULL,${q(fetched_on)})`).join(",\n"),
    "ON CONFLICT (code) DO NOTHING;",
    "",
    "INSERT INTO admin_divisions (code, level, parent_code, county, town, village, fetched_on)",
    `SELECT v.code, 'village', t.code, t.county, t.town, v.name, ${q(fetched_on)}::date`,
    "  FROM (VALUES",
    villages.map((r) => `(${q(r.code)},${q(r.village)})`).join(",\n"),
    "  ) AS v(code, name)",
    "  JOIN admin_divisions t ON t.code = left(v.code, 8) AND t.level = 'town'",
    "ON CONFLICT (code) DO NOTHING;",
    "-- ↑↑↑ 資料段結束",
    "",
  ].join("\n");
}

const from = opt("--from");
const doc = from ? JSON.parse(readFileSync(from, "utf8")) : await fetchAll();
const jsonOut = opt("--json");
const sqlOut = opt("--sql");
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(doc, null, 0).replace(/\},\{/g, "},\n{") + "\n");
if (sqlOut) writeFileSync(sqlOut, toSql(doc));
if (!jsonOut && !sqlOut) process.stdout.write(toSql(doc));
process.stderr.write(`縣市 ${doc.counts.county}、鄉鎮市區 ${doc.counts.town}、村里 ${doc.counts.village}\n`);
