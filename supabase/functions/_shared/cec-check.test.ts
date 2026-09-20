import { assertEquals } from "jsr:@std/assert@1";
import { cecCandidacyPage, cecRecordsText } from "./cec-check.ts";

// 2026-09-20 裁決：系統不解析 PDF／Excel；參選紀錄的系統票問中選會結構化資料
Deno.test("cecRecordsText：一筆一行、欄位名寫清楚，沒有的欄位不印", () => {
  const t = cecRecordsText([{ theme_id: null, cand_id: 1, name: "張嘉哲", election_name: "111年鄉鎮市長選舉", vote_date: "2022-11-26", election_id: 2022, birth_year: 1981, party: "中國國民黨", election_result: "elected", area: "南投縣南投市", votes_received: null, vote_percentage: null }]);
  assertEquals(t, "姓名：張嘉哲；選舉：111年鄉鎮市長選舉；投票日：2022-11-26（屆別 2022）；選區：南投縣南投市；政黨：中國國民黨；出生年：1981；結果：當選；來源：中選會候選人資料庫");
});

Deno.test("cecCandidacyPage：只留指定屆別；查無、API 掛了回 null", async () => {
  const body = { cand_data_list: [
    { cand_name: "張嘉哲", theme_name: "111年鄉鎮市長選舉", vote_date: "2022-11-26", party_name: "中國國民黨", is_victor: "*", area_name: "南投縣南投市", cand_birthyear: 1981 },
    { cand_name: "張嘉哲", theme_name: "107年縣市議員選舉", vote_date: "2018-11-24", party_name: "中國國民黨", is_victor: "*", area_name: "南投縣第02選舉區", cand_birthyear: 1981 },
  ] };
  const ok = (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const r = await cecCandidacyPage("張嘉哲", 2022, ok);
  assertEquals(r?.count, 1);
  assertEquals(r?.text.includes("2022-11-26"), true);
  assertEquals(r?.text.includes("2018"), false);
  assertEquals(await cecCandidacyPage("張嘉哲", 2026, ok), null, "中選會還沒有 2026");
  const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  assertEquals(await cecCandidacyPage("張嘉哲", 2022, down), null);
  assertEquals(await cecCandidacyPage("王", 2022, ok), null);
});
