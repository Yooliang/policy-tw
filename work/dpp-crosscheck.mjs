import fs from "node:fs";
import { parseSchemaA } from "./parse-schemaA.mjs";

function toTaiwan(s) { return String(s ?? "").replace(/臺/g, "台"); }
const CJK_VARIANTS = { "勲": "勳", "黄": "黃", "叁": "參", "叄": "參", "凖": "準", "顔": "顏", "国": "國" };
function canonChars(s) { return String(s).replace(/[\s\S]/g, (ch) => CJK_VARIANTS[ch] ?? ch); }
function normName(s) {
  return canonChars(toTaiwan(String(s ?? "")))
    .normalize("NFKC").toLowerCase()
    .replace(/[\s·‧・･.]+/g, "").trim();
}
function normDistrict(rawDistrict) {
  const t = toTaiwan(rawDistrict);
  const m = /^(.+?)第(\d+)選舉區$/.exec(t);
  if (!m) return null;
  return { region: m[1], district: `第${String(Number.parseInt(m[2], 10)).padStart(2, "0")}選舉區` };
}

const metroRaw = fs.readFileSync("work/pdfs/ccd7e51a.unpdf.txt", "utf8");
const { rows } = parseSchemaA(metroRaw, "ccd7e51a");
const rosterIndex = new Map(); // region -> name -> [{district, party}]
for (const r of rows) {
  const nd = normDistrict(r.district);
  if (!nd) continue;
  const key = normName(r.name);
  if (!rosterIndex.has(nd.region)) rosterIndex.set(nd.region, new Map());
  const m = rosterIndex.get(nd.region);
  if (!m.has(key)) m.set(key, []);
  m.get(key).push({ district: nd.district, party: r.party });
}

const dpp = JSON.parse(fs.readFileSync("work/dpp-candidates.json", "utf8"));
let agree = 0, disagreeDistrict = [], notInRoster = [], ambiguousInRoster = [];
for (const d of dpp) {
  const region = toTaiwan(d.city);
  const key = normName(d.name);
  const hits = rosterIndex.get(region)?.get(key) ?? [];
  if (hits.length === 0) { notInRoster.push(d); continue; }
  if (hits.length > 1) { ambiguousInRoster.push({ ...d, hits }); continue; }
  if (hits[0].district === d.district) agree++;
  else disagreeDistrict.push({ ...d, rosterDistrict: hits[0].district });
}
console.log("DPP candidates:", dpp.length);
console.log("agree with roster district:", agree);
console.log("disagree:", disagreeDistrict.length, JSON.stringify(disagreeDistrict, null, 1));
console.log("not in roster (name not found under that city):", notInRoster.length, JSON.stringify(notInRoster, null, 1));
console.log("ambiguous in roster:", ambiguousInRoster.length, JSON.stringify(ambiguousInRoster, null, 1));

fs.writeFileSync("work/dpp-crosscheck.json", JSON.stringify({
  total: dpp.length, agree, disagreeDistrict, notInRoster, ambiguousInRoster,
}, null, 2), "utf8");
