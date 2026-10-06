/**
 * 職稱（現任公職）與參選狀況分開（2026-10-04 維護者：「職稱可能有多種，把他跟參選狀況分開來」）。
 * 守住三件事：落選者沒有職稱、現任跨屆只算最近一屆、該屆沒參選紀錄就不出參選標籤。
 */
import { assert, assertEquals, assertMatch, assertStrictEquals } from "jsr:@std/assert@1";
import {
  candidacyBadge, candidacyNote, candidacyStatusText, officeTitles, pastTermItems, RESULT_PENDING, withdrawalText,
} from "./politician-office.ts";
import * as peopleDirectory from "./people-directory.ts";
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

Deno.test("candidacyStatusText：一欄六值各一個說法；空值（傳聞，不收）不顯示", () => {
  assertEquals(candidacyStatusText("elected"), "當選");
  assertEquals(candidacyStatusText("not_elected"), "落選");
  assertEquals(candidacyStatusText("filed"), "已登記", "已登記與審定同一個值，不再另標「已審定」");
  assertEquals(candidacyStatusText("declared"), "表態參選", "#345 後續：表態參選只表示本人宣布、政黨提名");
  assertEquals(candidacyStatusText("considering"), "考慮參選");
  assertEquals(candidacyStatusText("withdrawn"), "不參選", "看不出有沒有登記過就只說不參選");
  assertEquals(candidacyStatusText("withdrawn", true), "登記後退選");
  assertEquals(candidacyStatusText("withdrawn", false), "表態不參選");
  assertEquals(candidacyStatusText(undefined), undefined);
  assertEquals(candidacyStatusText(null), undefined, "不收傳聞：空值什麼都不講");
});

Deno.test("candidacyBadge：這一屆的參選狀況，寫成「2026 台南市長・已登記」", () => {
  const badge = candidacyBadge([
    run({ electionId: 2024, electionType: "立法委員", region: "台南市", candidacyStatus: "elected" }),
    run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidacyStatus: "filed" }),
  ], 2026, false);
  assertEquals(badge?.label, "2026 台南市長・已登記");
  assertEquals(badge?.what, "2026 台南市長");
  assertEquals(badge?.running, true);
});

Deno.test("candidacyBadge：不參選也要講出來，但不算「有在選」", () => {
  const badge = candidacyBadge([
    run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidacyStatus: "withdrawn" }),
  ], 2026, false);
  assertEquals(badge?.label, "2026 台南市長・不參選");
  assertEquals(candidacyBadge([run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidacyStatus: "withdrawn", withdrawnAfterFiling: true })], 2026, false)?.label, "2026 台南市長・登記後退選");
  assertEquals(candidacyBadge([run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidacyStatus: "withdrawn", withdrawnAfterFiling: false })], 2026, false)?.label, "2026 台南市長・表態不參選");
  assertEquals(badge?.running, false);
  // 落選的也不算有在選（標題不能寫成「候選人」）
  assertEquals(
    candidacyBadge([run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidacyStatus: "not_elected" })], 2026, false)?.running,
    false,
  );
});

Deno.test("candidacyBadge：該屆沒有參選紀錄就不顯示", () => {
  const only2022 = [run({ electionId: 2022, electionType: "縣市議員", region: "桃園市", candidacyStatus: "declared" })];
  assertEquals(candidacyBadge(only2022, 2026, false), undefined);
  assertEquals(candidacyBadge(undefined, 2026, false), undefined);
  assertEquals(candidacyBadge(only2022, null, false), undefined);
  // 有紀錄但狀態是空的：寫不出狀況就不要掛一顆空標籤
  assertEquals(candidacyBadge([run({ electionId: 2026, electionType: "縣市長", region: "台南市" })], 2026, false), undefined);
});

Deno.test("2024 落選立委不會有職稱，但參選狀況照實說", () => {
  // 于美人：2024 台北市立委 not_elected、2026 沒有紀錄 → 職稱空的、參選狀況也不顯示
  assertEquals(officeTitles([]), []);
  assertEquals(
    candidacyBadge([run({ electionId: 2024, electionType: "立法委員", region: "台北市", candidacyStatus: "not_elected" })], 2024, true)?.label,
    "2024 台北市立委・落選",
  );
});

// 2026-10-06 主線裁定：人物頁跟人物一覽、政黨頁講法統一——投完票的只講結果，結果還沒補上寫「結果待補」。
// 斷言一律寫字面的「結果待補」，不拿 RESULT_PENDING 跟它自己比：常數被改成「表態參選」這裡要紅。
Deno.test("candidacyNote：投完票的只講結果，結果還沒補上寫「結果待補」", () => {
  assertEquals(RESULT_PENDING, "結果待補");
  // 2022 早期匯入、停在 confirmed 的那一萬多筆：不講「表態參選」，也不留白
  assertEquals(candidacyNote({ candidacyStatus: "filed" }, true), "結果待補");
  for (const s of ["declared", "considering"] as const) {
    assertEquals(candidacyNote({ candidacyStatus: s }, true), "結果待補", s);
  }
  assertEquals(candidacyNote({}, true), "結果待補", "狀態空的也一樣：投完票了，缺的是結果");
  // 有結果就講結果
  assertEquals(candidacyNote({ candidacyStatus: "elected" }, true), "當選");
  assertEquals(candidacyNote({ candidacyStatus: "not_elected" }, true), "落選");
  // 不參選照 withdrawalText 的三種說法，不會被寫成「結果待補」
  assertEquals(candidacyNote({ candidacyStatus: "withdrawn", withdrawnAfterFiling: true }, true), "登記後退選");
  assertEquals(candidacyNote({ candidacyStatus: "withdrawn", withdrawnAfterFiling: false }, true), "表態不參選");
  assertEquals(candidacyNote({ candidacyStatus: "withdrawn" }, true), "不參選");
});

Deno.test("candidacyNote：還沒投票的照登記階段（跟 candidacyStatusText 同一套），不寫「結果待補」", () => {
  assertEquals(candidacyNote({ candidacyStatus: "declared" }, false), "表態參選");
  assertEquals(candidacyNote({ candidacyStatus: "filed" }, false), "已登記");
  assertEquals(candidacyNote({ candidacyStatus: "considering" }, false), "考慮參選");
  assertEquals(candidacyNote({ candidacyStatus: "withdrawn", withdrawnAfterFiling: true }, false), "登記後退選");
  assertEquals(candidacyNote({ candidacyStatus: "withdrawn" }, false), "不參選");
  assertEquals(candidacyNote({}, false), "", "看不出狀態（傳聞、不收）就不寫");
});

Deno.test("candidacyBadge：投票前講登記階段，投完票只講結果、沒結果寫「結果待補」", () => {
  const confirmed = [run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidacyStatus: "declared" })];
  // 今天（2026-10-06）2026 還沒投票：畫面照舊
  assertEquals(candidacyBadge(confirmed, 2026, false)?.label, "2026 台南市長・表態參選");
  // 投完票、結果還沒補上
  const after = candidacyBadge(confirmed, 2026, true);
  assertEquals(after?.label, "2026 台南市長・結果待補");
  assertEquals(after?.status, "結果待補");
  assertEquals(after?.running, true, "結果待補的人這一屆確實在選，標題照樣寫「…候選人」");
  const registered = [run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidacyStatus: "filed" })];
  assertEquals(candidacyBadge(registered, 2026, false)?.label, "2026 台南市長・已登記");
  assertEquals(candidacyBadge(registered, 2026, true)?.label, "2026 台南市長・結果待補");
  // 結果補上之後
  const won = candidacyBadge([run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidacyStatus: "elected" })], 2026, true);
  assertEquals(won?.label, "2026 台南市長・當選");
  const lost = candidacyBadge([run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidacyStatus: "not_elected" })], 2026, true);
  assertEquals(lost?.label, "2026 台南市長・落選");
  assertEquals(lost?.running, false, "落選的不算有在選");
  // 不參選投票前後都一樣，也不算有在選
  const quit = [run({ electionId: 2026, electionType: "縣市長", region: "台南市", candidacyStatus: "withdrawn", withdrawnAfterFiling: true })];
  assertEquals(candidacyBadge(quit, 2026, false)?.label, "2026 台南市長・登記後退選");
  assertEquals(candidacyBadge(quit, 2026, true)?.label, "2026 台南市長・登記後退選");
  assertEquals(candidacyBadge(quit, 2026, true)?.running, false);
});

/** lib／pages／components／composables 底下的程式（不含測試） */
function sourceFiles(dir: URL): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isDirectory) {
      out.push(...sourceFiles(new URL(`${entry.name}/`, dir)));
    } else if (/\.(ts|vue)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      const url = new URL(entry.name, dir);
      out.push({ name: decodeURIComponent(url.pathname), text: Deno.readTextFileSync(url) });
    }
  }
  return out;
}

Deno.test("規則只有一份：人物一覽轉出去的就是這裡的 candidacyNote，別的檔案沒有另抄一份", () => {
  assertStrictEquals(peopleDirectory.candidacyNote, candidacyNote);
  assertStrictEquals(peopleDirectory.RESULT_PENDING, RESULT_PENDING);
  const root = new URL("../", import.meta.url);
  const files = ["lib/", "pages/", "components/", "composables/"].flatMap((d) => sourceFiles(new URL(d, root)));
  assert(files.some((f) => f.name.endsWith("/pages/PoliticianProfile.vue")), "掃描沒掃到人物頁");
  for (const f of files) {
    if (f.name.endsWith("/lib/politician-office.ts")) continue;
    assertEquals(f.text.match(/(function|const|let)\s+candidacyNote\b/), null, `${f.name} 自己定義了 candidacyNote`);
    assertEquals(f.text.match(/['"`]結果待補['"`]/), null, `${f.name} 把「結果待補」寫成字面字串——要用 lib/politician-office.ts 的 candidacyNote`);
  }
});

Deno.test("人物頁真的用這份規則：參選紀錄已投票的那一支呼叫 candidacyNote，上方標籤有傳「投完票了沒」", () => {
  const page = Deno.readTextFileSync(new URL("../pages/PoliticianProfile.vue", import.meta.url));
  const start = page.indexOf("function getCandidateStatusLabel(");
  const end = page.indexOf("function getCandidateStatusColor(");
  assert(start >= 0 && end > start, "PoliticianProfile.vue 找不到 getCandidateStatusLabel");
  // 之前已投票的那一支自己寫 switch、其他一律回 null，2022 那一萬多筆停在登記階段的右邊什麼都沒寫
  assertMatch(page.slice(start, end), /candidacyNote\(rec, isPast\)/);
  // 上方的參選狀況標籤：第三個參數是「這一屆投完票了沒」，跟參選紀錄同一個判斷
  assertMatch(page, /candidacyBadge\(politician\.value\?\.elections, [^,]+, [^)]*isElectionPast\(/);
});

// #345 後續（協調者 10-06）：退選分三種說法；轉任的卸任日是推定的要標出來
Deno.test("withdrawalText：登記過→登記後退選、沒登記過→表態不參選、看不出來→不參選", () => {
  assertEquals(withdrawalText(true), "登記後退選");
  assertEquals(withdrawalText(false), "表態不參選");
  assertEquals(withdrawalText(undefined), "不參選");
  assertEquals(withdrawalText(null), "不參選");
});

Deno.test("pastTermItems：只列卸任的、最近卸任的在前；推定的卸任日標出來，有出處的附網址", () => {
  const items = pastTermItems([
    { id: 1, electionId: 2022, electionType: "縣市議員", region: "台北市", startDate: "2022-12-25", endDate: "2024-01-31", endReason: "took_other_office", endBasis: "inferred" },
    { id: 2, electionId: 2024, electionType: "立法委員", region: "台北市", startDate: "2024-02-01" },
    { id: 3, electionId: 2018, electionType: "村里長", region: "台北市", subRegion: "中正區", village: "建國里", startDate: "2018-12-25", endDate: "2022-12-24", endReason: "term_expired", endBasis: "law" },
    { id: 4, electionId: 2022, electionType: "鄉鎮市長", region: "南投縣", subRegion: "南投市", startDate: "2022-12-25", endDate: "2025-03-01", endReason: "resigned", endBasis: "source", sourceUrl: "https://x.gov.tw/a" },
  ]);
  assertEquals(items.map((i) => i.key), [4, 1, 3], "在任的（沒有卸任日）不列");
  assertEquals(items[1], { key: 1, title: "台北市議員", period: "2022-12-25～2024-01-31", reason: "轉任", inferred: true, sourceUrl: undefined });
  assertEquals(items[2].inferred, false, "依法屆滿不是推定");
  assertEquals(items[2].title, "中正區建國里長");
  assertEquals(items[0].sourceUrl, "https://x.gov.tw/a");
  assertEquals(pastTermItems(undefined), []);
});
