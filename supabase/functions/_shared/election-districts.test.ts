/**
 * 選舉區與應選名額表（election_districts）的守門測試（migration 20261005003442；#344 第一階段，2026-10-05）。
 *
 * 這裡沒有資料庫。SQL 本身在 PGlite（WASM Postgres）上灌 10-05 線上唯讀資料（內政部行政區、選舉區對照表、
 * 中選會名單）實跑驗過，並跟中選會 2022／2024 名單逐區互驗（見 PR 說明）；這支守住「改壞了不會報錯」的事：
 *   1. 第一階段只加不刪
 *   2. 職位清單跟 TS 的 ELECTION_TYPES 同一份；「以整個行政區為一區」的職位＝選舉頁分層設定裡的首長
 *   3. 立委席次加起來是憲法定的 113（區域 73＋原住民 6＋不分區 34），各縣市名稱跟 cec-sync 同一份
 *   4. 選舉區寫法跟交件落庫（electoral-district.ts）認得的寫法一致，不然之後拿參選紀錄對不上選舉區
 *   5. 回填核對的預期值跟上面的資料段算得出來的一致（改了資料段沒改核對，正式庫 db push 會整支退回）
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { ELECTION_TYPES } from "./contribution-schema.ts";
import { ALL_REGIONS } from "./cec-city-codes.ts";
import { LEGISLATOR_AT_LARGE_SEATS, legislatorDistrictKey, normalizeDistrict } from "./electoral-district.ts";
import { POSITIONS } from "../../../lib/election-levels.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const FILE = "20261005003442_election_districts.sql";
// Windows 取出的工作樹是 CRLF（autocrlf），下面比對用的字串都寫 \n，讀進來先統一
const sql = (await Deno.readTextFile(new URL(FILE, MIGRATIONS))).replace(/\r\n/g, "\n");
const code = sql.replace(/--[^\n]*/g, "");

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  assert(j >= 0, `找不到「${end}」`);
  return text.slice(i, j);
}
const quoted = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** 區域立委各縣市區數（VALUES 資料段） */
const legislatorCounties = [...between(code, "FROM (VALUES\n  ('台北市'", ") AS c(region, districts)").matchAll(/\('([^']+)', (\d+)\)/g)]
  .map((m) => ({ region: m[1], districts: Number(m[2]) }));
/** 立委全國一區的三種 */
const atLargeSeats = [...between(code, "('indigenous_plain'", ") AS x(kind").matchAll(/\('([a-z_]+)', '([^']+)', (\d+),/g)]
  .map((m) => ({ kind: m[1], subRegion: m[2], seats: Number(m[3]) }));

Deno.test("只加不刪：沒有刪表、刪欄、改名、改型別；DROP POLICY 只用來重建同名的", () => {
  assert(!/\bDROP\s+(TABLE|COLUMN|FUNCTION|VIEW)\b/i.test(code));
  assert(!/\bRENAME\b/i.test(code));
  assert(!/\bALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE\b/i.test(code));
  for (const [, name] of code.matchAll(/DROP POLICY IF EXISTS "([^"]+)" ON election_districts/g)) {
    assert(code.includes(`CREATE POLICY "${name}" ON election_districts`), `policy ${name} 刪了沒重建`);
  }
});

Deno.test("職位清單跟 contribution-schema.ts 的 ELECTION_TYPES 同一份", () => {
  const check = between(code, "election_type  TEXT NOT NULL CHECK (election_type IN (", "))");
  assertEquals(new Set(quoted(check)), new Set(ELECTION_TYPES));
});

Deno.test("以整個行政區為一區（at_large）的職位＝選舉頁分層設定裡的首長", () => {
  const check = between(code, "CONSTRAINT election_districts_kind_matches_type CHECK (", "= (district_kind = 'at_large')");
  const heads = POSITIONS.filter((p) => p.role === "head").map((p) => p.type);
  assertEquals(new Set(quoted(check)), new Set(heads));
});

Deno.test("立委席次：區域 73 區各一席＋平地原住民 3＋山地原住民 3＋不分區 34＝113", () => {
  const districts = legislatorCounties.reduce((s, c) => s + c.districts, 0);
  assertEquals(districts, 73);
  assertEquals(atLargeSeats.map((x) => x.seats).reduce((a, b) => a + b, 0), 40);
  assertEquals(districts + 40, 113);
  assertEquals(new Set(legislatorCounties.map((c) => c.region)), new Set(ALL_REGIONS), "各縣市名稱要跟 cec-sync 的 ALL_REGIONS 同一份（22 縣市都要有區）");
});

Deno.test("立委選舉區寫法：交件落庫（legislatorDistrictKey）找得到我們寫的「台中市第01選區」", () => {
  // migration 裡產生區名的式子：c.region || '第' || lpad(n::TEXT, 2, '0') || '選區'
  const m = code.match(/c\.region \|\| '([^']*)' \|\| lpad\(n::TEXT, (\d+), '0'\) \|\| '([^']*)'/);
  assert(m, "找不到區名產生式");
  const [, prefix, width, suffix] = m;
  for (const { region, districts } of legislatorCounties) {
    for (let n = 1; n <= districts; n++) {
      const ours = `${region}${prefix}${String(n).padStart(Number(width), "0")}${suffix}`;
      const key = legislatorDistrictKey(region, `第${n}選區`);
      assert(key && key.region === region && key.sub_regions.includes(ours), `${ours} 對不上 legislatorDistrictKey：${JSON.stringify(key)}`);
    }
  }
  assertEquals(new Set(atLargeSeats.map((x) => x.subRegion)), new Set(LEGISLATOR_AT_LARGE_SEATS));
  for (const x of atLargeSeats) assertEquals(legislatorDistrictKey("全國", x.subRegion)?.sub_regions, [x.subRegion]);
});

Deno.test("縣市議員選舉區寫法：只收交件統一成的「第NN選舉區」", () => {
  const re = new RegExp(code.match(/eda\.electoral_district ~ '([^']+)'/)![1]);
  for (const raw of ["第1選區", "第一選舉區", "第12選舉區"]) assertMatch(normalizeDistrict(raw)!.district, re);
  assert(!re.test("中山大同區"));
});

Deno.test("回填核對的預期值跟資料段算得出來的一致", () => {
  const expected = between(code, "v_expected CONSTANT TEXT :=", ";").replace(/'\s*'/g, "");
  const legislator = `2024|立法委員|${legislatorCounties.reduce((s, c) => s + c.districts, 0) + atLargeSeats.length}|${
    legislatorCounties.reduce((s, c) => s + c.districts, 0) + atLargeSeats.reduce((s, x) => s + x.seats, 0)
  }`;
  assertEquals(legislator, "2024|立法委員|76|113");
  assert(expected.includes(legislator), `核對值裡的立委那一段要是 ${legislator}`);
  // 首長類一區一席：區數＝名額
  for (const m of expected.matchAll(/(\d{4})\|(縣市長|鄉鎮市長|直轄市山地原住民區長|總統副總統)\|(\d+)\|(\d+)/g)) {
    assertEquals(m[3], m[4], `${m[1]} ${m[2]} 一區一席，區數要等於名額`);
  }
  // 議員名額這一支不回填
  for (const m of expected.matchAll(/\d{4}\|縣市議員\|\d+\|(\d+)/g)) assertEquals(m[1], "0");
  // 六個山地原住民區
  const codes = quoted(between(code, "AND a.code IN (", ")"));
  assertEquals(codes.length, 6);
  assert(expected.includes("2022|直轄市山地原住民區長|6|6") && expected.includes("2026|直轄市山地原住民區長|6|6"));
});

Deno.test("名額不准用推的：表上的說明與欄位守門都在", () => {
  assertMatch(sql, /不要用候選人數或當選人數推/);
  assertMatch(code, /CONSTRAINT election_districts_seats_basis CHECK \(\(seats IS NULL\) = \(seats_basis IS NULL\)\)/);
  assertMatch(code, /CONSTRAINT election_districts_at_large_one_seat CHECK/);
});
