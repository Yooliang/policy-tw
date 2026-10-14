// 補抓直轄市長（Mayor / C1）：CountyMayor(C2) 對 6 都回 0 筆，因為六都市長屬於另一個科目代碼。
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
const FN_URL = `${BASE_URL}/functions/v1/fetch-cec-data`;

async function callFn(body) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const listData = await callFn({ action: "list", electionType: "Mayor" });
const themes2022 = (listData.themes || []).filter((t) => t.year === 2022);
console.log("Mayor 2022 themes:", themes2022);

const DIRECT_CITIES = ["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市"];
const themeId = themes2022[0]?.themeId;
if (!themeId) throw new Error("找不到 2022 直轄市長 themeId");

const results = [];
for (const region of DIRECT_CITIES) {
  const data = await callFn({ electionType: "Mayor", themeId, region, electionId: 2022 });
  const n = data?.candidates?.length ?? 0;
  console.log(`${region} -> ${n} 筆 ${data?.error ? "ERROR:" + data.error : ""}`);
  if (data?.success) {
    for (const c of data.candidates) results.push({ ...c, ourType: "縣市長", requestedRegion: region });
  }
  await sleep(600);
}
writeFileSync(new URL("./cec_mayor_direct.json", import.meta.url), JSON.stringify(results, null, 0));
console.log(`寫入 ${results.length} 筆到 scripts_2022/cec_mayor_direct.json`);
