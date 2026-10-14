// Cross-check helper: count candidate rows per electoral district by counting district-token
// occurrences in each roster txt (row-major formats repeat the district string once per row).
import fs from "node:fs";

function glue(raw) {
  let t = raw;
  t = t.replace(/選\s+舉/g, "選舉");
  t = t.replace(/舉\s+區/g, "舉區");
  t = t.replace(/第\s+(\d)/g, "第$1");
  t = t.replace(/\s+/g, " ");
  return t;
}

export function countDistricts(raw) {
  const t = glue(raw);
  const matches = t.match(/[一-鿿]{2,3}[縣市]第\d+選舉區/g) || [];
  const counts = new Map();
  for (const m of matches) counts.set(m, (counts.get(m) || 0) + 1);
  return counts;
}

if (process.argv[2]) {
  const raw = fs.readFileSync(process.argv[2], "utf8");
  const counts = countDistricts(raw);
  let total = 0;
  for (const v of counts.values()) total += v;
  console.log(`file=${process.argv[2]} totalRows=${total} districts=${counts.size}`);
  console.log([...counts.entries()].sort());
}
