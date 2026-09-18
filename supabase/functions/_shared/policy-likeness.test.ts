import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkPolicyLikeness, policyLikenessNotice } from "./policy-likeness.ts";

Deno.test("疑似不是政見：指認的那兩筆會被標記", () => {
  const a = checkPolicyLikeness("母雞帶小雞 - 最強新北隊", "組建最強團隊，帶領新北市議員候選人一起打贏 2026 選戰，實現議會過半目標。");
  assert(a.suspect);
  assert(a.reasons.some((r) => r.includes("選戰")), a.reasons.join("|"));
  assert(checkPolicyLikeness("溫暖創新的新北", "打造一個溫暖而創新的新北市。").suspect);
  assert((policyLikenessNotice("母雞帶小雞 - 最強新北隊", "打贏選戰") ?? "").includes("疑似不是政見"));
});

Deno.test("真政見不標記：有動詞或有數字就過", () => {
  for (const [t, d] of [
    ["學童營養午餐全面免費", "全市公立國中小學童營養午餐由市府編列預算全額補助。"],
    ["敬老卡點數提升至1000點", "將敬老卡每月點數從 480 點提高到 1000 點。"],
    ["新生兒補助10萬元", "每名新生兒發放生育補助 10 萬元。"],
    ["捷運土城樹林線推進", "推動捷運土城樹林線，爭取中央核定並完成環評。"],
  ] as const) {
    const r = checkPolicyLikeness(t, d);
    assertEquals(r.suspect, false, `${t} 不該被標記：${r.reasons.join("|")}`);
    assertEquals(policyLikenessNotice(t, d), null);
  }
});

Deno.test("欄位缺漏或非字串不會炸，視為看不出要做什麼", () => {
  assert(checkPolicyLikeness(undefined, null).suspect);
  assert(checkPolicyLikeness("", "").suspect);
});
