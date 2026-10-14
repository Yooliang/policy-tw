// 列出各選舉別 2022 年的 themeId（fetch-cec-data action=list）
import { readFileSync } from "node:fs";

function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const ANON_KEY = env.VITE_SUPABASE_ANON_KEY;
const BASE_URL = env.VITE_SUPABASE_URL;
if (!ANON_KEY || !BASE_URL) throw new Error("缺少 .env.local 的 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY");

const FN_URL = `${BASE_URL}/functions/v1/fetch-cec-data`;

async function callFn(body) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ANON_KEY}`,
      "apikey": ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data;
}

const electionTypes = ["CountyMayor", "CouncilMember", "CountyCouncilMember", "CityMayor", "DistrictRepresentatives", "Village"];

const results = {};
for (const et of electionTypes) {
  const data = await callFn({ action: "list", electionType: et });
  if (!data.success) {
    console.error(`[${et}] 失敗:`, data.error);
    continue;
  }
  const year2022 = (data.themes || []).filter((t) => t.year === 2022);
  results[et] = year2022;
  console.log(`\n=== ${et} (2022) ===`);
  for (const t of year2022) {
    console.log(`  themeId=${t.themeId}  themeName=${t.themeName}  areaName=${t.areaName}  voteDate=${t.voteDate}  dataLevel=${t.dataLevel}`);
  }
  await new Promise((r) => setTimeout(r, 600));
}

import { writeFileSync } from "node:fs";
writeFileSync(new URL("./themes_2022.json", import.meta.url), JSON.stringify(results, null, 2));
console.log("\n已寫入 scripts_2022/themes_2022.json");
