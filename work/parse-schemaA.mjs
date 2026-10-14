// Schema A parser: 選舉區 登記日期 姓名 推薦之政黨 備註 (備註 empty in observed combined rosters)
// Row: District Date Name+ Party+ ; boundary between Name and Party found by scanning from the
// right for the first token satisfying isPartyFinal (ends with 黨, or exactly 無, or in KNOWN_NO_SUFFIX).
import fs from "node:fs";

const KNOWN_NO_SUFFIX = new Set([
  "時代力量", "台灣基進", "臺灣基進", "台灣團結聯盟", "左翼聯盟",
  "小民參政歐巴桑聯盟", "永久和平自然法",
]);

// Full party name strings that can get word-wrapped (space inserted anywhere) by the PDF layout;
// re-glue them regardless of where the wrap point falls before tokenizing.
const WRAPPABLE_PARTY_NAMES = [
  "天宙和平統一家庭黨", "永久和平自然法", "小民參政歐巴桑聯盟",
  "時代力量", "台灣基進", "臺灣基進", "台灣團結聯盟", "左翼聯盟",
  "中國國民黨", "民主進步黨", "台灣民眾黨", "親民黨", "新黨",
  "社會民主黨", "綠黨", "勞動黨", "正神名黨", "台聯黨",
];

function isPartyFinal(tok) {
  return tok === "無" || tok.endsWith("黨") || KNOWN_NO_SUFFIX.has(tok);
}

function dewrapParties(t) {
  for (const name of WRAPPABLE_PARTY_NAMES) {
    const re = new RegExp(name.split("").join("\\s*"), "g");
    t = t.replace(re, name);
  }
  return t;
}

function cleanText(raw) {
  let t = dewrapParties(raw);
  // strip boilerplate titles/footers
  t = t.replace(/\[?115年(直轄市議員|縣市議員|市議員)選舉\]?候選人登記\S*/g, " ");
  t = t.replace(/查詢條件：\S*/g, " ");
  t = t.replace(/登記日期起：\S*/g, " ");
  t = t.replace(/登記日期止：\S*/g, " ");
  t = t.replace(/製表日期：\S*/g, " ");
  t = t.replace(/列印筆數：\d+/g, " ");
  t = t.replace(/製表機關：\S*/g, " ");
  t = t.replace(/第\s*\d+\s*頁，共\s*\d+\s*頁/g, " ");
  // glue split district tokens: "第1選舉 區" / "第10選 舉區" / "選舉\n區"
  t = t.replace(/選\s+舉/g, "選舉");
  t = t.replace(/舉\s+區/g, "舉區");
  t = t.replace(/第\s+(\d)/g, "第$1");
  // normalize whitespace
  t = t.replace(/\s+/g, " ").trim();
  // strip literal repeated header line
  t = t.split("選舉區 登記日期 姓名 推薦之政黨 備註").join(" ");
  return t;
}

export function parseSchemaA(rawText, sourcePdf) {
  const text = cleanText(rawText);
  const tokens = text.split(" ").filter(Boolean);
  const rows = [];
  const unresolved = [];
  let i = 0;
  let currentDistrict = null;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.endsWith("選舉區")) {
      currentDistrict = tok;
      i++;
      continue;
    }
    if (currentDistrict === null) { i++; continue; } // preamble noise before first district
    // expect a date token next
    if (!/^115\/\d{2}\/\d{2}$/.test(tok)) {
      // unexpected token where date was expected; skip defensively
      unresolved.push({ reason: "expected-date", token: tok, district: currentDistrict });
      i++;
      continue;
    }
    i++; // consume date
    // collect until next district token
    const body = [];
    while (i < tokens.length && !tokens[i].endsWith("選舉區")) {
      body.push(tokens[i]);
      i++;
    }
    // find rightmost party-final token
    let k = -1;
    for (let idx = body.length - 1; idx >= 0; idx--) {
      if (isPartyFinal(body[idx])) { k = idx; break; }
    }
    if (k === -1) {
      unresolved.push({ reason: "no-party-token", district: currentDistrict, body });
      continue;
    }
    const nameTokens = body.slice(0, k);
    const partyTokens = body.slice(k); // party may itself be a single wrapped token; extras before k stay in name (rare joke-name cases)
    if (nameTokens.length === 0) {
      unresolved.push({ reason: "empty-name", district: currentDistrict, body });
      continue;
    }
    rows.push({
      district: currentDistrict,
      name: nameTokens.join(""),
      party: partyTokens.join(""),
      source_pdf: sourcePdf,
    });
  }
  return { rows, unresolved };
}

if (process.argv[2]) {
  const file = process.argv[2];
  const raw = fs.readFileSync(file, "utf8");
  const { rows, unresolved } = parseSchemaA(raw, file);
  console.log(`rows=${rows.length} unresolved=${unresolved.length}`);
  const byDistrict = new Map();
  for (const r of rows) byDistrict.set(r.district, (byDistrict.get(r.district) || 0) + 1);
  console.log([...byDistrict.entries()].sort());
  if (unresolved.length) console.log("unresolved sample:", unresolved.slice(0, 20));
}
