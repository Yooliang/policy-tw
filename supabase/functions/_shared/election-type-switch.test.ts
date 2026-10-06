import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { electionTypeSwitch, upsertParticipation } from "./candidate-import.ts";

// 2026-09-25 高嘉瑜：傳聞選台北市長（not_running），中選會名冊證實登記台北市議員。
// 落庫只改了狀態、沒改選舉別與職稱，網站顯示她「登記參選台北市長」。
Deno.test("選舉別不同、原本那列不是正式狀態：整列改成新的選舉別與職稱", () => {
  assertEquals(
    electionTypeSwitch({ election_type: "縣市長", candidacy_status: "withdrawn" }, { election_type: "縣市議員", position: "台北市議員候選人" }),
    { election_type: "縣市議員", position: "台北市議員候選人" },
  );
  assertEquals(electionTypeSwitch({ election_type: "縣市長", candidacy_status: null }, { election_type: "縣市議員" }), { election_type: "縣市議員" });
});

Deno.test("選舉別相同或沒帶：不動", () => {
  assertEquals(electionTypeSwitch({ election_type: "縣市議員", candidacy_status: "filed" }, { election_type: "縣市議員" }), {});
  assertEquals(electionTypeSwitch({ election_type: "縣市長", candidacy_status: null }, {}), {});
});

Deno.test("原本已是正式參選紀錄、又來另一種選舉別：擋下，不能靜靜蓋掉", () => {
  assertThrows(() => electionTypeSwitch({ election_type: "縣市議員", candidacy_status: "filed" }, { election_type: "縣市長" }), Error, "正式參選紀錄");
});

Deno.test("upsertParticipation 更新時真的把選舉別一起寫進去", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    from: (_t: string) => ({
      select: (_c: string) => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 34957, candidacy_status: "withdrawn", election_type: "縣市長" }, error: null }) }) }) }),
      update: (patch: Record<string, unknown>) => { updates.push(patch); return { eq: async () => ({ error: null }) }; },
    }),
  };
  await upsertParticipation(db as never, { politician_id: "p", election_id: 2026, election_type: "縣市議員", position: "台北市議員候選人", candidacy_status: "filed", source_note: "名冊" });
  assertEquals(updates[0]?.election_type, "縣市議員");
  assertEquals(updates[0]?.position, "台北市議員候選人");
  assertEquals(updates[0]?.candidacy_status, "filed");
  assertEquals("candidate_status" in updates[0], false, "落庫只寫新欄位，舊欄位由觸發器同步（#345 第二階段 A）");
});
