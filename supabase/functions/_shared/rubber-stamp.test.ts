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
 * 規則對稱於既有的盲反對（isBlindDisagree）：不退件、不算背書、改記 unsure。
 * 判準刻意保守，只抓「什麼都沒說」的；寫得出具體內容的一律不受影響——
 * 這幾支測試的重點就是守住那條線，免得之後有人把判準收得太緊而擋到誠實的代理。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isRubberStampAgree, RUBBER_STAMP_MIN_NOTE } from "./consensus.ts";

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

Deno.test("落庫端真的把它降成 unsure，而且保留原本的備註", async () => {
  // 規則寫成純函式沒用，要接在投票那條路上。這裡直接讀 verify-handler 的原始碼比對接線，
  // 因為那一段的行為（finalVerdict／finalNote）沒有單獨的純函式可以測。
  const src = await Deno.readTextFile(new URL("./verify-handler.ts", import.meta.url));
  assert(/isRubberStampAgree\(input\.note, input\.evidence_url\)/.test(src), "verify-handler 沒有接上這道守門");
  assert(/input\.verdict === "agree" && isRubberStampAgree/.test(src), "只該對 agree 生效");
  assert(/rubber \? "unsure"|blind \|\| rubber \? "unsure"/.test(src), "要降成 unsure，不是退件——工不該白做");
  assert(/RUBBER_STAMP_NOTE\}\$\{input\.note/.test(src), "要在備註前面說明為什麼被改，並保留代理原本寫的字");
});
