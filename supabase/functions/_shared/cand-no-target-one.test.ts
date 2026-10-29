/**
 * 號次交件（candidacy 且 payload 帶正整數 cand_no）目標分數 3 → 1（維護者 2026-10-29）的守門測試。
 * 一張同意即 verified；號次重複系統票 not_supported 仍 +1（要 2 張）；一張反對擋得住；
 * 兩台機器規則照舊；非 cand_no 的 candidacy 與 past_result 仍是 3；SQL 與 TS 逐案一致。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { AGREE_THRESHOLDS, effectiveRequiredAgree, hasCandNo, needsTwoIps, rejectFloor, requiredAgree, riskLevel, scoreStatus } from "./consensus.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const MIG = "20261029020000_cand_no_target_one.sql";
const SRC = ["https://db.cec.gov.tw/ElecTable/Election/ElecTickets"];
const UUID = "0b8d3a52-1111-4222-8333-444455556666";
const CAND_NO = { name: "王小明", election_id: 1, election_type: "city_councilor", cand_no: 7 };

async function latestFn(): Promise<{ name: string; fn: string }> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  let hit = { name: "", fn: "" };
  for (const n of names) {
    const t = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
    const at = t.lastIndexOf("CREATE OR REPLACE FUNCTION contribution_required_agree(");
    if (at >= 0) {
      const body = t.slice(at);
      hit = { name: n, fn: body.slice(0, body.indexOf("$$;", body.indexOf("$$") + 2)) };
    }
  }
  return hit;
}

function status(score: number, target: number, distinctIps: number) {
  return scoreStatus({ score, target, distinctIps, contributionType: "candidacy", payload: CAND_NO, current: "pending" });
}

Deno.test("cand_no 的 candidacy：獨立風險等級、目標 1（不看來源）；一般 candidacy 與 past_result 不變", () => {
  assertEquals(riskLevel("candidacy", CAND_NO), "cand_no");
  assertEquals(AGREE_THRESHOLDS.cand_no, { official: 1, media: 1, social: 1, other: 1 });
  for (const src of [SRC, ["https://example.com/x"], []]) assertEquals(requiredAgree("candidacy", CAND_NO, src), 1);
  // 非 cand_no 的 candidacy 仍是 3
  assertEquals(requiredAgree("candidacy", { name: "王小明" }, SRC), 3);
  assertEquals(requiredAgree("candidacy", {}, SRC), 3);
  for (const bad of [0, -1, 1.5, "abc", "", null, "0", "7x", 1000000]) {
    assertEquals(requiredAgree("candidacy", { name: "x", cand_no: bad }, SRC), 3, `cand_no=${JSON.stringify(bad)} 不算號次`);
  }
  // 補已投票結果（帶 election_result＋politician_id）優先，仍 3
  assertEquals(requiredAgree("candidacy", { ...CAND_NO, election_result: "elected", politician_id: UUID }, SRC), 3);
  // 其他型別帶 cand_no 不受影響
  assertEquals(requiredAgree("policy", { cand_no: 7 }, SRC), 3);
  assertEquals(requiredAgree("correction", { field: "candidate_status", cand_no: 7 }, SRC), 3);
});

Deno.test("一張同意即 verified；沒有票維持 pending；兩台機器規則照舊", () => {
  const target = requiredAgree("candidacy", CAND_NO, SRC);
  assertEquals(status(1, target, 2), "verified");
  assertEquals(status(2, target, 2), "verified");
  assertEquals(status(0, target, 0), "pending");
  assert(needsTwoIps("candidacy", CAND_NO), "candidacy 仍要至少兩台不同機器，不放寬");
  assertEquals(status(1, target, 1), "pending", "只有一台機器不通過");
});

Deno.test("號次重複系統票 not_supported：目標 +1＝2，一張不夠、兩張才過；supported 不會低於 1", () => {
  const base = requiredAgree("candidacy", CAND_NO, SRC);
  const dup = effectiveRequiredAgree(base, "not_supported");
  assertEquals(dup, 2);
  assertEquals(status(1, dup, 2), "pending");
  assertEquals(status(2, dup, 2), "verified");
  assertEquals(effectiveRequiredAgree(base, "supported"), 1, "最低 1");
  assertEquals(effectiveRequiredAgree(base, null), 1);
});

Deno.test("有反對票：同意 +1 配反對 −1 不到 1；反對不能被繞過；退件門檻仍 3", () => {
  const target = requiredAgree("candidacy", CAND_NO, SRC);
  assertEquals(status(0, target, 2), "pending");
  assertEquals(status(-1, target, 2), "pending");
  assertEquals(rejectFloor("candidacy"), 3);
  assertEquals(status(-3, target, 2), "rejected");
});

Deno.test("hasCandNo 邊界", () => {
  for (const ok of [1, 7, 999999, "7", "007"]) assert(hasCandNo({ cand_no: ok }), String(ok));
  for (const no of [0, -3, 1.5, 1000000, "0", "", "7x", " 7", null, undefined, {}, [], true]) assert(!hasCandNo({ cand_no: no }), JSON.stringify(no));
  assert(!hasCandNo(null) && !hasCandNo("x") && !hasCandNo({}));
});

Deno.test("SQL 與 TS 逐案一致：最新 contribution_required_agree 是這支 migration；矩陣列、判斷順序、號次 regex 與 hasCandNo 同結論", async () => {
  const { name, fn } = await latestFn();
  assertEquals(name, MIG, "之後若有人再改這支函式，請改看新的那支並保留 cand_no 規則");
  assertStringIncludes(fn, "WHEN v_risk = 'cand_no' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 1 WHEN 'social' THEN 1 ELSE 1 END");
  assertStringIncludes(fn, "WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 3");
  assertStringIncludes(fn, "WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 3");
  // 順序：past_result → cand_no → candidacy 一般級
  const iPast = fn.indexOf("THEN 'past_result'"), iNo = fn.indexOf("THEN 'cand_no'"), iHigh = fn.indexOf("WHEN p_type = 'candidacy' OR");
  assert(iPast > 0 && iPast < iNo && iNo < iHigh, "cand_no 要在 past_result 之後、candidacy 一般級之前");
  const m = fn.match(/WHEN p_type = 'candidacy' AND p_payload->>'cand_no' ~ '([^']+)' THEN 'cand_no'/);
  assert(m, "SQL 的 cand_no 判斷式");
  const re = new RegExp(m![1]);
  // 逐案：jsonb ->> 取出的文字（數字原樣、字串去引號）套 SQL regex，要跟 TS 的 hasCandNo 同結論
  const cases: unknown[] = [1, 7, 12, 999999, 1000000, 0, -3, "7", "007", "0", "", "7x", " 7", "abc"];
  for (const v of cases) assertEquals(re.test(String(v)), hasCandNo({ cand_no: v }), `cand_no=${JSON.stringify(v)}`);
  // 兩邊的風險等級逐案相同（SQL 側用同一條 regex 與判斷順序重演）
  const sqlRisk = (p: Record<string, unknown>) => {
    if (["elected", "not_elected"].includes(String(p.election_result)) && /^[0-9a-f-]{36}$/i.test(String(p.politician_id))) return "past_result";
    if (p.cand_no !== undefined && re.test(String(p.cand_no))) return "cand_no";
    return "high";
  };
  const payloads: Record<string, unknown>[] = [CAND_NO, { name: "x" }, { cand_no: 0 }, { cand_no: "5" }, { ...CAND_NO, election_result: "elected", politician_id: UUID }];
  for (const p of payloads) assertEquals(riskLevel("candidacy", p), sqlRisk(p));
});

Deno.test("migration 不碰資料：只有函式定義，沒有 UPDATE／INSERT／DELETE", async () => {
  const sql = (await Deno.readTextFile(new URL(MIG, MIGRATIONS))).replace(/\r\n/g, "\n").replace(/--.*$/gm, "");
  assert(!/\b(UPDATE\s+\w+|INSERT\s+INTO|DELETE\s+FROM)\b/i.test(sql));
});
