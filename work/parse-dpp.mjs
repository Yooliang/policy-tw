import fs from "node:fs";

const CITY_NAME = { "63000": "台北市", "65000": "新北市", "68000": "桃園市", "66000": "台中市", "67000": "台南市", "64000": "高雄市" };

function parseDpp(html, cityCode) {
  const re = /councilor_name">([^<]+)<\/div>[\s\S]*?councilor_city_label">([^<]+)<\/div>\s*第(\d+)選區/g;
  const rows = [];
  let m;
  while ((m = re.exec(html))) {
    rows.push({ name: m[1].trim(), city: m[2].trim(), district: `第${m[3].padStart(2, "0")}選舉區` });
  }
  return rows;
}

const all = [];
for (const code of Object.keys(CITY_NAME)) {
  const html = fs.readFileSync(`work/dpp/${code}.html`, "utf8");
  const rows = parseDpp(html, code);
  console.log(CITY_NAME[code], rows.length);
  all.push(...rows);
}
fs.writeFileSync("work/dpp-candidates.json", JSON.stringify(all, null, 2), "utf8");
console.log("total:", all.length);
