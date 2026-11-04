/**
 * 政黨分流圖資料層（policy-ops#193，migration 20261104100000_party_flow_data.sql）的守門：
 *   1. 性別換算：cand_sex 1＝男、2＝女，其他與空值回 null；cec-sync 與 fetch-cec-data 共用同一份（不抄第二份）。
 *   2. 名冊 JSON 的 gender 照存、不轉換；缺值為 null。
 *   3. cec_roster_replace_unit 只多寫 gender：簽名不變，其餘一字不動（對「緊接在前的那一版」做機械替換後逐字相同）。
 *   4. party_flow_rows：STABLE、SECURITY INVOKER、固定 search_path、只授權 anon／authenticated；輸出沒有姓名等個資欄；
 *      2022 連重行選舉（id＝4）；2026 讀名冊、其他屆讀 cec_candidates；party_flow_counts 沒被這支 migration 動到。
 *   5. migration 時間戳比 party_flow（20261104090000）新。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { genderFromCandSex } from "./cec-static-fetch.ts";
import { parseRosterJson } from "./cec-roster-mirror.ts";
import { toCecCandidateRow } from "./cec-sync.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url)).replace(/\r\n/g, "\n");
const NEW_SQL = read("../../migrations/20261104100000_party_flow_data.sql");
const OLD_SQL = read("../../migrations/20261031160000_cec_roster_2026.sql");

function fnText(sql: string, name: string): string {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(i >= 0, `找不到 ${name}`);
  const j = sql.indexOf("\n$$;", i);
  return sql.slice(i, j + 4);
}

Deno.test("genderFromCandSex：1 男、2 女，其他與空值 null", () => {
  assertEquals(genderFromCandSex("1"), "男");
  assertEquals(genderFromCandSex("2"), "女");
  assertEquals(genderFromCandSex(" 2 "), "女");
  for (const v of ["", "0", "3", "M", "男", undefined, null]) assertEquals(genderFromCandSex(v as never), null, `值 ${String(v)}`);
});

Deno.test("cec-sync 與 fetch-cec-data 共用 genderFromCandSex，不留第二份換算", () => {
  const fetchSrc = read("../fetch-cec-data/index.ts");
  assert(fetchSrc.includes("genderFromCandSex(merged.cand_sex)"), "fetch-cec-data 用共用函式");
  assert(!/cand_sex\s*===/.test(fetchSrc), "fetch-cec-data 不再自己比 cand_sex");
  const syncSrc = read("./cec-sync.ts");
  assert(syncSrc.includes("genderFromCandSex(merged.cand_sex)"));
  assert(!/cand_sex\s*===/.test(syncSrc));
  const row = toCecCandidateRow({ cand_name: "甲", cand_sex: "1" }, undefined, { electionId: 2022, ourType: "縣市長", cecType: "Mayor", themeId: "t" });
  assertEquals(row?.gender, "男");
  const none = toCecCandidateRow({ cand_name: "乙", cand_sex: "9" }, undefined, { electionId: 2022, ourType: "縣市長", cecType: "Mayor", themeId: "t" });
  assertEquals(none?.gender, null, "其他值不硬分");
});

Deno.test("名冊 JSON 的 gender 原始值照存、缺值為 null", () => {
  const rows = parseRosterJson("C1", { C1: [{ name: "甲", gender: "男" }, { name: "乙", gender: "女" }, { name: "丙" }, { name: "丁", gender: "" }, { name: "戊", gender: "其他" }] });
  assertEquals(rows.map((r) => r.gender), ["男", "女", null, null, "其他"]);
  const t = parseRosterJson("T", { T: [{ areaCode: "01", areaName: "第01選舉區", cands: [{ name: "甲", gender: "女" }] }] });
  assertEquals(t[0].gender, "女");
});

Deno.test("cec_roster_replace_unit：簽名不變，只多寫 gender，其餘與前一版逐字相同", () => {
  const oldFn = fnText(OLD_SQL, "cec_roster_replace_unit");
  const newFn = fnText(NEW_SQL, "cec_roster_replace_unit");
  const patched = oldFn
    .replace("name_key, cand_no, party, birth, home, unit_key,", "name_key, cand_no, party, birth, home, gender, unit_key,")
    .replace("x.party, x.birth, x.home,", "x.party, x.birth, x.home, x.gender,")
    .replace("birth TEXT, home TEXT, district TEXT", "birth TEXT, home TEXT, gender TEXT, district TEXT");
  assert(patched !== oldFn, "替換有生效");
  assertEquals(newFn, patched);
  assert(newFn.startsWith("CREATE OR REPLACE FUNCTION cec_roster_replace_unit(p_url TEXT, p_http INTEGER, p_rows JSONB DEFAULT NULL, p_error TEXT DEFAULT NULL) RETURNS TEXT"));
  // 授權沿用前一版（CREATE OR REPLACE 不動權限），這支 migration 不另外放寬
  assert(!/GRANT[^;]*cec_roster_replace_unit/.test(NEW_SQL));
});

Deno.test("party_flow_rows：只讀、發信人權限、固定 search_path、只授權 anon／authenticated、沒有個資欄", () => {
  const fn = fnText(NEW_SQL, "party_flow_rows");
  assert(/RETURNS jsonb\s+LANGUAGE sql STABLE SECURITY INVOKER\s+SET search_path = public/.test(fn));
  assert(NEW_SQL.includes("GRANT EXECUTE ON FUNCTION party_flow_rows(integer) TO anon, authenticated;"));
  // 輸出鍵只有聚合：p c t e a g r n
  const keys = [...fn.matchAll(/jsonb_build_object\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]));
  assertEquals(keys, ["p", "c", "t", "e", "a", "g", "r", "n"]);
  // 沒有把姓名、生日、住址放進任何輸出
  const out = fn.slice(fn.indexOf("jsonb_agg"));
  for (const bad of ["name", "birth", "home", "cand_no", "name_key"]) assert(!new RegExp(`\\b${bad}\\b`).test(out), `輸出段不得出現 ${bad}`);
  assert(fn.includes("FROM cec_roster_2026 r") && fn.includes("p_election_id = 2026"));
  assert(fn.includes("FROM cec_candidates c") && fn.includes("p_election_id <> 2026"));
  assert(fn.includes("WHEN p_election_id = 2022 THEN ARRAY[2022, 4]"), "2022 連重行選舉");
  assert(fn.includes("least(70") || fn.includes("LEAST(70"), "70 歲以上併一組");
});

Deno.test("party_flow_counts 沒被這支 migration 動到；時間戳在 party_flow 之後", () => {
  assert(!/FUNCTION party_flow_counts/.test(NEW_SQL.replace(/--[^\n]*/g, "")), "只在註解提到");
  const names = [...Deno.readDirSync(new URL("../../migrations/", import.meta.url))].map((e) => e.name).sort();
  assert(names.indexOf("20261104100000_party_flow_data.sql") > names.indexOf("20261104090000_party_flow.sql"));
});
