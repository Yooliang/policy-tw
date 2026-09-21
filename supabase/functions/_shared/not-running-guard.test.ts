/**
 * 「他沒有登記」是否定的斷言，要有出處才寫得進去。
 *
 * 2026-09-21 實測線上 2026 這一屆：
 *   registered   281 筆帶網址、3 筆沒有
 *   not_running  102 筆，**全部沒有網址**；其中 76 筆的 source_note 還寫著
 *                「可能再次挑戰」「可能被徵召」這種推測語氣——推測被寫成了結論
 *   這 102 筆 verified 全 false（沒有一筆被驗證過），影響 26 人、94 筆政見
 *
 * 代價不對稱是這條規則的根據：標成 not_running 會讓人不進選舉頁、不算已收錄人員、
 * 全站搜尋不算正在參選，四種任務也不再派；標錯 registered 只是多列一個人，名單清查會抓到。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { guardNotRunning } from "./candidate-import.ts";

Deno.test("沒有出處網址的 not_running 降成 rumored，並寫明為什麼", () => {
  const out = guardNotRunning("not_running", "AI搜尋匯入: 曾任立法委員，可能再次挑戰");
  assertEquals(out.candidate_status, "rumored", "「可能再次挑戰」是推測，不是「他沒登記」這個結論");
  assertEquals(out.downgraded, true);
  assert(String(out.source_note).includes("未附出處網址"), "降級要留下理由，否則後面的人看不出發生過什麼");
  assert(String(out.source_note).includes("AI搜尋匯入"), "原本的註記要保留");
});

Deno.test("完全沒有註記的 not_running 一樣降級", () => {
  const out = guardNotRunning("not_running", null);
  assertEquals(out.candidate_status, "rumored");
  assert(String(out.source_note).includes("未附出處網址"));
});

Deno.test("帶了出處網址的 not_running 照寫（代理查過名單的那條路）", () => {
  // 代理交 candidacy 時 schema 強制要 source_urls，落庫時 source_note 會帶上網址
  const note = "貢獻者：a-zhen（https://www.cec.gov.tw/candidate/list）";
  const out = guardNotRunning("not_running", note);
  assertEquals(out.candidate_status, "not_running");
  assertEquals(out.downgraded, false);
  assertEquals(out.source_note, note, "沒降級就不要動註記");
});

Deno.test("其他狀態一律不碰", () => {
  for (const status of ["registered", "confirmed", "rumored", "withdrawn", null, undefined]) {
    const out = guardNotRunning(status, "沒有網址的註記");
    assertEquals(out.candidate_status, status, `${status} 不該被這道守門改動`);
    assertEquals(out.downgraded, false);
    assertEquals(out.source_note, "沒有網址的註記");
  }
});

Deno.test("這道守門要真的接在唯一的寫入點上", async () => {
  // 規則寫成純函式沒有用，要接在 upsertParticipation 上——所有參選紀錄都從那裡寫進去
  // （匯入、AI 管線、代理的 candidacy 貢獻都是）。
  const src = await Deno.readTextFile(new URL("./candidate-import.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function upsertParticipation"));
  const guardAt = fn.indexOf("guardNotRunning(");
  const insertAt = fn.indexOf(".insert(");
  const updateAt = fn.indexOf(".update(");
  assert(guardAt > 0, "upsertParticipation 沒有呼叫 guardNotRunning");
  assert(guardAt < insertAt && guardAt < updateAt, "守門要在寫入之前跑");
});
