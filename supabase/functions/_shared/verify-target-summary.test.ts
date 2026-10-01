/**
 * 驗證項標明「這票通過後會改到誰」（維護者 2026-10-01 核准）。
 *
 * 起因：一筆 correction 的 reason 寫「確認陳瑩在台東名冊上」，target_id 卻是陳見賢那筆參選紀錄；
 * 驗證者核了陳瑩、投同意，陳見賢被改成已登記。驗證項只給 target_id，看不出改的是誰。
 * 現在 correction（politicians／politician_elections）的 current 最上層多一欄 target_summary，
 * 寫出人名、縣市、屆別、選舉類型與每一欄的現值 → 新值，並提醒先確認是不是同一個人。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fetchVerifyContext, shapeVerifyCurrent, TARGET_SUMMARY_HINT } from "./task-context.ts";

const PE_PAYLOAD = {
  target_table: "politician_elections",
  target_id: "4321",
  changes: [{ field: "candidate_status", current_value: "likely", correct_value: "registered" }],
  reason: "打開中選會登記彙總表，確認陳瑩在臺東縣候選人名單上",
};

Deno.test("參選紀錄的更正：target_summary 寫出被改的人名、縣市、屆別、選舉類型與現值 → 新值", () => {
  const out = shapeVerifyCurrent("correction", PE_PAYLOAD, {
    target: { id: 4321, politician_id: "p-chen", election_id: 2026, election_type: "縣市長", candidate_status: "likely" },
    target_politician: { name: "陳見賢", region: "臺東縣" },
  });
  const s = String(out.target_summary);
  assertStringIncludes(s, "這筆通過後會改：陳見賢（臺東縣，2026 縣市長）");
  assertStringIncludes(s, "candidate_status");
  assertStringIncludes(s, "likely → registered");
  assertStringIncludes(s, TARGET_SUMMARY_HINT);
  assertStringIncludes(TARGET_SUMMARY_HINT, "disagree");
  // 舊欄位照舊在
  assertEquals(out.target_table, "politician_elections");
  assertEquals(out.target_id, "4321");
});

Deno.test("人物的更正：寫出人名與縣市；多欄位逐欄列", () => {
  const out = shapeVerifyCurrent("correction", {
    target_table: "politicians", target_id: "p1",
    changes: [{ field: "birth_year", correct_value: 1970 }, { field: "party", correct_value: "民主進步黨" }],
    reason: "中選會資料",
  }, { target: { id: "p1", name: "王小明", region: "臺北市", birth_year: null, party: "無黨籍" } });
  const s = String(out.target_summary);
  assertStringIncludes(s, "王小明（臺北市）");
  assertStringIncludes(s, "birth_year（空白） → 1970");
  assertStringIncludes(s, "party 無黨籍 → 民主進步黨");
});

Deno.test("找不到對象或不是人物／參選紀錄：不附 target_summary", () => {
  assertEquals(shapeVerifyCurrent("correction", PE_PAYLOAD, { target: null }).target_summary, undefined);
  const pol = shapeVerifyCurrent("correction", { target_table: "policies", target_id: "x", changes: [{ field: "title", correct_value: "新" }] }, { target: { id: "x", title: "舊" } });
  assertEquals(pol.target_summary, undefined, "政見的更正不動");
  assertEquals(shapeVerifyCurrent("candidacy", { name: "某某" }, {}).target_summary, undefined, "其他型別不動");
});

Deno.test("fetchVerifyContext：參選紀錄的更正要 join 出人名", async () => {
  const calls: Array<{ table: string; select: string }> = [];
  // deno-lint-ignore no-explicit-any
  const fake: any = {
    from(table: string) {
      const chain = {
        select(cols: string) { calls.push({ table, select: cols }); return chain; },
        eq() { return chain; },
        maybeSingle: async () => ({
          data: table === "politician_elections"
            ? { id: 4321, election_id: 2026, election_type: "縣市長", candidate_status: "likely", politicians: { name: "陳見賢", region: "臺東縣" } }
            : null,
          error: null,
        }),
      };
      return chain;
    },
  };
  const data = await fetchVerifyContext(fake, "correction", PE_PAYLOAD);
  assert(calls.some((c) => c.table === "politician_elections" && c.select.includes("politicians(")), "要 join politicians 拿人名");
  assertEquals(data.target_politician?.name, "陳見賢");
  assertEquals((data.target as Record<string, unknown>).politicians, undefined, "join 出來的人物不要混在 target 欄位裡（db_current 比對用的是 target）");
  assertEquals((data.target as Record<string, unknown>).candidate_status, "likely");
});
