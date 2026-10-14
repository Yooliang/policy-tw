// 呼叫 fetch-cec-data Edge Function，把 2022 各選舉別候選人資料抓下來存成 JSON。
// 只讀，不寫資料庫。
import { readFileSync, writeFileSync } from "node:fs";

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
      Authorization: `Bearer ${ANON_KEY}`,
      apikey: ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const REGIONS_22 = [
  "台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市",
  "宜蘭縣", "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣",
  "嘉義縣", "屏東縣", "台東縣", "花蓮縣", "澎湖縣", "基隆市",
  "新竹市", "嘉義市", "連江縣", "金門縣",
];
const DIRECT_CITIES = new Set(["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市"]);
const NON_DIRECT_CITIES = REGIONS_22.filter((r) => !DIRECT_CITIES.has(r));
// 直轄市山地原住民區所在城市（含把「台南市」訂正為「桃園市」——見 our_2022.csv 的 mislabel 備註）
const DISTRICT_REP_CITIES = ["新北市", "桃園市", "台中市", "高雄市"];

const THEMES = JSON.parse(readFileSync(new URL("./themes_2022.json", import.meta.url), "utf8"));

function themeIdsFor(electionType) {
  return (THEMES[electionType] || []).map((t) => t.themeId);
}

const jobs = [];

// 縣市長：全部 22 縣市；嘉義市另外用重行選舉場次
const countyMayorMain = THEMES.CountyMayor.find((t) => t.themeName === "111年縣市長選舉")?.themeId;
const countyMayorReelect = THEMES.CountyMayor.find((t) => t.themeName.includes("重行選舉"))?.themeId;
for (const region of REGIONS_22) {
  jobs.push({ electionType: "CountyMayor", themeId: countyMayorMain, region, ourType: "縣市長" });
}
if (countyMayorReelect) {
  jobs.push({ electionType: "CountyMayor", themeId: countyMayorReelect, region: "嘉義市", ourType: "縣市長" });
}

// 鄉鎮市長：非直轄市的 16 縣市（實際上有鄉鎮市長的只有 13 個縣，但直接對 16 個縣市都打一次，沒資料就跳過）
for (const region of NON_DIRECT_CITIES) {
  jobs.push({ electionType: "CityMayor", themeId: THEMES.CityMayor[0]?.themeId, region, ourType: "鄉鎮市長" });
}

// 縣市議員：直轄市用 CouncilMember，其他用 CountyCouncilMember；每個縣市把所有候選 themeId 都試一次
for (const region of DIRECT_CITIES) {
  for (const themeId of themeIdsFor("CouncilMember")) {
    jobs.push({ electionType: "CouncilMember", themeId, region, ourType: "縣市議員" });
  }
}
for (const region of NON_DIRECT_CITIES) {
  for (const themeId of themeIdsFor("CountyCouncilMember")) {
    jobs.push({ electionType: "CountyCouncilMember", themeId, region, ourType: "縣市議員" });
  }
}

// 直轄市山地原住民區民代表
for (const region of DISTRICT_REP_CITIES) {
  jobs.push({ electionType: "DistrictRepresentatives", themeId: THEMES.DistrictRepresentatives[0]?.themeId, region, ourType: "直轄市山地原住民區民代表" });
}

// 村里長：22 縣市
for (const region of REGIONS_22) {
  jobs.push({ electionType: "Village", themeId: THEMES.Village[0]?.themeId, region, ourType: "村里長" });
}

console.log(`共 ${jobs.length} 個請求`);

const allCandidates = [];
const log = [];

for (const [i, job] of jobs.entries()) {
  if (!job.themeId) {
    console.warn(`[skip] 缺 themeId:`, job);
    continue;
  }
  const data = await callFn({
    electionType: job.electionType,
    themeId: job.themeId,
    region: job.region,
    electionId: 2022,
  });
  const n = data?.candidates?.length ?? 0;
  console.log(`(${i + 1}/${jobs.length}) ${job.ourType} ${job.region} theme=${job.themeId.slice(0, 8)} -> ${n} 筆 ${data?.error ? "ERROR:" + data.error : ""}`);
  log.push({ ...job, count: n, error: data?.error, nodata: data?.nodata });
  if (data?.success && n > 0) {
    for (const c of data.candidates) {
      allCandidates.push({ ...c, ourType: job.ourType, requestedRegion: job.region });
    }
  }
  await sleep(600);
}

writeFileSync(new URL("./cec_candidates.json", import.meta.url), JSON.stringify(allCandidates, null, 0));
writeFileSync(new URL("./fetch_log.json", import.meta.url), JSON.stringify(log, null, 2));
console.log(`\n總共抓到 ${allCandidates.length} 筆候選人資料，已寫入 scripts_2022/cec_candidates.json`);
