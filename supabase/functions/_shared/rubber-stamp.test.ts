/**
 * 橡皮圖章同意票：agree 但沒說核對了什麼、也沒附第二來源 → 改記 unsure。
 *
 * 現場（2026-09-21，ballyhoo-4d 的還債代理）：前 6 票品質很好，其中一筆抓到「原貢獻附的
 * CNA 網址實際內容是演唱會娛樂新聞」；接著最後 5 票全變成 agree ＋ note「驗證通過」＋
 * 無 evidence_url，一模一樣，其中 4 票是決定性的那一票，直接把資料推上線。
 *
 * 這是第四種迴避實際查證的形狀，前三種（自設預算提前收工、填假網址、拖延不投）都能靠
 * 把指令寫死壓制，這一種壓不住——它一開始照做，是後來才衰退的。所以要靠系統擋，不是靠指令。
 *
 * 處置：退回 400 讓它把核對內容補上再送。不是降級成 unsure——實地核過那批票指向的來源，
 * 資料其實是對的（盲投但剛好正確，因為提交者本來就做對了），降級會永久吃掉一張票。
 * 判準刻意保守，只抓「什麼都沒說」的；寫得出具體內容的一律不受影響——
 * 這幾支測試的重點就是守住那條線，免得之後有人把判準收得太緊而擋到誠實的代理。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isRepeatedNote, isRubberStampAgree, RUBBER_STAMP_MIN_NOTE } from "./consensus.ts";

Deno.test("擋得住：套語、空白、太短，而且沒有第二來源", () => {
  for (const note of ["驗證通過", "驗證通過。", "確認無誤", "資料正確", "沒問題", "LGTM", "ok", "同意", "已核對", "", null, undefined, "   "]) {
    assert(isRubberStampAgree(note, null), `「${note}」該被判為橡皮圖章`);
  }
});

Deno.test("擋不到：有說出核對了什麼的同意票", () => {
  for (const note of [
    "中選會候選人查詢第 3 列，姓名、政黨、選區三欄都跟 payload 對得上",
    "打開自由時報那篇，內文第 4 段確實有這句承諾，日期也是 7/23",
    "出生年 1968 在議會官網簡介查得到，與提交值相符",
    "已核對中選會登記名單，該選區共 5 人，包含此人",
  ]) {
    assertEquals(isRubberStampAgree(note, null), false, `「${note}」是有內容的同意票，不該被擋`);
  }
});

Deno.test("附了第二來源就不算橡皮圖章，備註再短也一樣", () => {
  // 協議要的是「找第二個獨立來源」；附得出來就是做了事，不必再要求他寫作文
  assertEquals(isRubberStampAgree("驗證通過", "https://db.cec.gov.tw/candidate/12345"), false);
  assertEquals(isRubberStampAgree(null, "https://www.cec.gov.tw/roster"), false);
  // 但 evidence_url 要是真的網址，不能拿一句話充數
  assert(isRubberStampAgree("驗證通過", "沒有網址"));
});

Deno.test("判準的邊界：剛好到下限就放行", () => {
  const short = "字".repeat(RUBBER_STAMP_MIN_NOTE - 1);
  const ok = "字".repeat(RUBBER_STAMP_MIN_NOTE);
  assert(isRubberStampAgree(short, null));
  assertEquals(isRubberStampAgree(ok, null), false);
  // 標點不算字數：拿標點灌長度沒有用
  assert(isRubberStampAgree("，。、！？；：（）「」『』,.!?;:()".repeat(3), null));
});

Deno.test("跟自己上一票一字不差＝罐頭", () => {
  // 事故實況：29 票的 note 全是同一句「查證通過」，代理自承那 29 票完全沒打開任何網頁；
  // 而它真的查過的前 6 票，每一票的 note 都不一樣。
  assert(isRepeatedNote("查證通過", "查證通過"));
  assert(isRepeatedNote("查證通過。", "查證通過"), "標點不算差異");
  assert(isRepeatedNote("  查證通過  ", "查證通過"), "空白不算差異");
  // 換句話說就算不同——這條規則只抓整句照抄，不做語意判斷
  assertEquals(isRepeatedNote("中選會名單第 3 列有他", "中選會名單第 5 列有他"), false);
  assertEquals(isRepeatedNote("查證通過", "來源第 2 段寫明此事"), false);
  // 第一票沒有前一票可比
  assertEquals(isRepeatedNote("查證通過", null), false);
  assertEquals(isRepeatedNote(null, "查證通過"), false);
});

Deno.test("落庫端退回 400 讓它補寫，不是降級也不是照收", async () => {
  // 規則寫成純函式沒用，要接在投票那條路上。這裡直接讀 verify-handler 的原始碼比對接線，
  // 因為那一段的行為（finalVerdict／finalNote）沒有單獨的純函式可以測。
  // 為什麼是 400 而不是降級成 unsure：實地核過那批票指向的來源，資料是對的
  // （盲投但剛好正確，因為提交者本來就做對了）。降級會永久吃掉一張票——同一個 IP
  // 不能重投——對真的查過只是懶得寫的代理是懲罰。退回讓它補寫，工不白做、痕跡留得下。
  const src = await Deno.readTextFile(new URL("./verify-handler.ts", import.meta.url));
  assert(/isRubberStampAgree\(input\.note, input\.evidence_url\)/.test(src), "verify-handler 沒有接上這道守門");
  assert(/input\.verdict === "agree" && isRubberStampAgree/.test(src), "只該對 agree 生效");
  assert(/note_too_thin/.test(src) && /status: 400/.test(src), "要退回 400 讓它補寫");
  assert(/note_repeated/.test(src), "第二層（跟自己上一票一字不差）也要接上");
  assert(/isRepeatedNote\(input\.note/.test(src), "重複備註的判斷要用共用的純函式，才測得到");
  assert(/不算你被拒/.test(src), "退回訊息要講明這次不計入被拒次數，否則代理會為了不被拒而亂寫");
});
