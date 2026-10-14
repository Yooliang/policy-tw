const themeIds = [
  "72976331a1ea6b85cfb1ed3380ae5f35",
  "c8f4dc82f282bed4ebcdf0f52552cf58",
  "4ad215cf6c4ef28b25278bd1a13bc7bf",
];

for (const t of themeIds) {
  const url = `https://db.cec.gov.tw/static/elections/data/candidates/ELC/T2/T1/${t}/A/10_007_00_000_0000.json`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  console.log(`=== ${t} status=${res.status} ===`);
  if (res.ok) {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      const rows = Array.isArray(j) ? j : Object.values(j).flat();
      console.log("rows:", rows.length);
      console.log(rows.slice(0, 2));
    } catch (e) {
      console.log("parse error", e.message, text.slice(0, 200));
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}
