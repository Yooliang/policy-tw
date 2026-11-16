/// <reference lib="deno.ns" />
/**
 * 人物頁 title／description（2026-11-16 流量體檢）。守：有 2026 參選的人標題帶「2026 選區職位候選人政見」，
 * 縣市長、議員（含選區）、村里長三種寫法，沒有參選時維持現行格式；h1 只含姓名（Hero 的 titleTag）。
 */
import { assertEquals, assert } from "jsr:@std/assert@1";
import { candidacyHeadWhat, personHeadDescription, personHeadTitle } from "./person-head.ts";

const base = { identity: "竹北市長", policyCount: 0, policyTitles: [] as string[], trackingText: "" };

Deno.test("縣市長：鄭朝方（現任竹北市長、2026 選新竹縣長）標題帶 2026 縣長與政見", () => {
  const headWhat = candidacyHeadWhat({ electionId: 2026, electionDate: "2026-11-28", electionType: "縣市長", region: "新竹縣" });
  assertEquals(headWhat, "2026 新竹縣長");
  assertEquals(personHeadTitle({ name: "鄭朝方", ballot: 1, headWhat, identity: "竹北市長" }), "鄭朝方（1 號）｜2026 新竹縣長候選人政見");
});

Deno.test("縣市議員：帶選區，選區的前導零去掉", () => {
  const headWhat = candidacyHeadWhat({ electionId: 2026, electionDate: "2026-11-28", electionType: "縣市議員", region: "新北市", subRegion: "第03選舉區" });
  assertEquals(headWhat, "2026 新北市議員（第3選舉區）");
  assertEquals(personHeadTitle({ name: "王小明", ballot: 3, headWhat, identity: "" }), "王小明（3 號）｜2026 新北市議員（第3選舉區）候選人政見");
});

Deno.test("村里長：沿用 participationLabel（跟村里長頁原本寫法同一套）", () => {
  const headWhat = candidacyHeadWhat({ electionId: 2026, electionDate: "2026-11-28", electionType: "村里長", subRegion: "琉球鄉", village: "本福村" });
  assertEquals(headWhat, "2026 琉球鄉本福村長");
  assertEquals(personHeadTitle({ name: "林大華", headWhat, identity: "" }), "林大華｜2026 琉球鄉本福村長候選人政見");
});

Deno.test("沒有 2026 參選（或已投完票）：維持現行格式，不加候選人政見", () => {
  assertEquals(candidacyHeadWhat(undefined), "");
  assertEquals(personHeadTitle({ name: "陳老師", headWhat: "", identity: "立法委員" }), "陳老師｜立法委員");
  assertEquals(personHeadTitle({ name: "陳老師", ballot: 2, headWhat: "", identity: "" }), "陳老師（2 號）");
});

Deno.test("description：有政見帶筆數與前兩條標題；沒政見用簡介；沒有也不留空；不超過 150 字", () => {
  const headWhat = "2026 新竹縣長";
  const withPolicies = personHeadDescription({
    ...base, name: "鄭朝方", ballot: 1, headWhat, party: "民主進步黨", policyCount: 5,
    policyTitles: ["幼兒托育一條龍", "竹科三期擴建", "第三條不應出現"],
  });
  assertEquals(withPolicies, "鄭朝方，2026 新竹縣長候選人（民主進步黨，1 號）。正見整理其 5 項政見與查核紀錄，包括幼兒托育一條龍、竹科三期擴建。");
  assert(!withPolicies.includes("第三條"));
  const bioOnly = personHeadDescription({ ...base, name: "王小明", headWhat, bio: "在地服務十年" });
  assertEquals(bioOnly, "王小明，2026 新竹縣長候選人。在地服務十年");
  assertEquals(personHeadDescription({ ...base, name: "王小明", headWhat }), "王小明，2026 新竹縣長候選人。正見提供其基本資料與參選紀錄。");
  const long = personHeadDescription({ ...base, name: "鄭朝方", headWhat, policyCount: 2, policyTitles: ["長".repeat(120), "長".repeat(120)] });
  assert(long.length <= 150);
  // 沒有參選：舊格式
  assertEquals(personHeadDescription({ ...base, name: "陳老師", headWhat: "", identity: "立法委員", party: "無黨籍", trackingText: "正見已收錄其政見 2 項。" }), "陳老師，無黨籍，立法委員。正見已收錄其政見 2 項。");
});

Deno.test("接線：人物頁的 head 走 person-head；Hero 標題框改 div，頁面內只有姓名那一個 h1", async () => {
  const page = await Deno.readTextFile(new URL("../pages/PoliticianProfile.vue", import.meta.url));
  assert(/personHeadTitle\(headInput\.value\)/.test(page));
  assert(/<Hero auto-height title-tag="div">/.test(page));
  assertEquals((page.match(/<h1\b/g) ?? []).length >= 1, true);
  // 人物頁 <template> 裡姓名 h1 只放姓名，號次徽章與「照片更新」按鈕都在 h1 之外
  const h1 = page.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)![1];
  assertEquals(h1.trim(), "{{ politician.name }}");
  const hero = await Deno.readTextFile(new URL("../components/Hero.vue", import.meta.url));
  assert(/<component :is="titleTag \?\? 'h1'"/.test(hero));
});
