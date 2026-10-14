const themeIds = [
  "72976331a1ea6b85cfb1ed3380ae5f35",
  "c8f4dc82f282bed4ebcdf0f52552cf58",
  "4ad215cf6c4ef28b25278bd1a13bc7bf",
];
// 花蓮縣 prv=10 city=015; 台東縣 prv=10 city=014
const scopes = ["10_015_00_000_0000", "10_014_00_000_0000"];

for (const scope of scopes) {
  for (const t of themeIds) {
    const url = `https://db.cec.gov.tw/static/elections/data/candidates/ELC/T2/T1/${t}/A/${scope}.json`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    console.log(`scope=${scope} theme=${t} status=${res.status}`);
    if (res.ok) {
      const j = await res.json();
      const rows = Array.isArray(j) ? j : Object.values(j).flat();
      console.log("  rows:", rows.length, "areaNames:", [...new Set(rows.map(r=>r.area_name))]);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}
