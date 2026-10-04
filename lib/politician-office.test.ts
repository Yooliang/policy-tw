/**
 * 職稱（現任公職）與參選狀況分開（2026-10-04 維護者：「職稱可能有多種，把他跟參選狀況分開來」）。
 * 守住三件事：落選者沒有職稱、現任跨屆只算最近一屆、該屆沒參選紀錄就不出參選標籤。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { candidacyBadge, candidacyStatusText, officeTitles } from "./politician-office.ts";
import type { PoliticianElectionData, PoliticianOffice } from "../types.ts";

const office = (o: Partial<PoliticianOffice> & { electionId: number }): PoliticianOffice => ({ ...o });
const run = (e: Partial<PoliticianElectionData> & { electionId: number }): PoliticianElectionData =>
  ({ position: "", region: "", ...e });

Deno.test("officeTitles：由選舉別＋地區組字，位階高的在前", () => {
  assertEquals(
    officeTitles([office({ electionId: 2024, electionType: "立法委員", region: "台南市" })]),
    ["台南市立委"],
  );
  assertEquals(
    officeTitles([office({ electionId: 2022, electionType: "縣市議員", region: "桃園市" })]),
    ["桃園市議員"],
  );
  assertEquals(
    officeTitles([office({ electionId: 2022, electionType: "村里長", region: "高雄市", subRegion: "前鎮區", village: "瑞北里" })]),
    ["前鎮區瑞北里長"],
  );
  // 同一屆真的有兩個席次（制度上不會，資料上可能）：位階高的先出
  assertEquals(
    officeTitles([
      office({ electionId: 2022, electionType: "縣市議員", region: "台北市" }),
      office({ electionId: 2022, electionType: "縣市長", region: "台北市" }),
    ]),
    ["台北市長", "台北市議員"],
  );
});

Deno.test("officeTitles：沒有現任職稱就是空陣列（不拿別的欄位頂替）", () => {
  assertEquals(officeTitles(undefined), []);
  assertEquals(officeTitles([]), []);
  // 選舉別不認得、又沒有 position 可用：組不出字就不要出一個空字串的標籤
  assertEquals(officeTitles([office({ electionId: 2022, electionType: "某種新職位" })]), []);
});

Deno.test("officeTitles：跨屆都當選時只算最近一屆（不得同時擔任兩個民選公職）", () => {
  // 王世堅：2022 選上台北市議員、2024 選上立委——就任立委時議員已經辭了，不能兩個都標
  assertEquals(
    officeTitles([
      office({ electionId: 2022, electionType: "縣市議員", region: "台北市" }),
      office({ electionId: 2024, electionType: "立法委員", region: "台北市" }),
    ]),
    ["台北市立委"],
  );
});

Deno.test("candidacyStatusText：投完票的結果優先於登記階段的狀態", () => {
  assertEquals(candidacyStatusText("confirmed", "elected"), "當選");
  assertEquals(candidacyStatusText("confirmed", "not_elected"), "落選");
  assertEquals(candidacyStatusText("registered", undefined), "已登記");
  assertEquals(candidacyStatusText("qualified", undefined), "已審定");
  assertEquals(candidacyStatusText("confirmed", undefined), "確認參選");
  assertEquals(candidacyStatusText("not_running", undefined), "未參選");
  assertEquals(candidacyStatusText(undefined, undefined), undefined);
});

Deno.test("candidacyBadge：這一屆的參選狀況，寫成「2026 台南市長・已登記」", () => {
  const badge = candidacyBadge([
    run({ electionId: 2024, electionType: "立法委員", region: "台南市", candidateStatus: "confirmed", electionResult: "elected" }),
    run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidateStatus: "registered" }),
  ], 2026);
  assertEquals(badge?.label, "2026 台南市長・已登記");
  assertEquals(badge?.what, "2026 台南市長");
  assertEquals(badge?.running, true);
});

Deno.test("candidacyBadge：未參選也要講出來，但不算「有在選」", () => {
  const badge = candidacyBadge([
    run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidateStatus: "not_running" }),
  ], 2026);
  assertEquals(badge?.label, "2026 台南市長・未參選");
  assertEquals(badge?.running, false);
  // 落選的也不算有在選（標題不能寫成「候選人」）
  assertEquals(
    candidacyBadge([run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidateStatus: "confirmed", electionResult: "not_elected" })], 2026)?.running,
    false,
  );
});

Deno.test("candidacyBadge：該屆沒有參選紀錄就不顯示", () => {
  const only2022 = [run({ electionId: 2022, electionType: "縣市議員", region: "桃園市", candidateStatus: "confirmed" })];
  assertEquals(candidacyBadge(only2022, 2026), undefined);
  assertEquals(candidacyBadge(undefined, 2026), undefined);
  assertEquals(candidacyBadge(only2022, null), undefined);
  // 有紀錄但狀態是空的：寫不出狀況就不要掛一顆空標籤
  assertEquals(candidacyBadge([run({ electionId: 2026, electionType: "縣市長", region: "台南市" })], 2026), undefined);
});

Deno.test("2024 落選立委不會有職稱，但參選狀況照實說", () => {
  // 于美人：2024 台北市立委 not_elected、2026 沒有紀錄 → 職稱空的、參選狀況也不顯示
  assertEquals(officeTitles([]), []);
  assertEquals(
    candidacyBadge([run({ electionId: 2024, electionType: "立法委員", region: "台北市", candidateStatus: "confirmed", electionResult: "not_elected" })], 2024)?.label,
    "2024 台北市立委・落選",
  );
});
