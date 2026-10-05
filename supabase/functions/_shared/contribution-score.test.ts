import { assert, assertEquals } from "jsr:@std/assert@1";
import { requiredAgree } from "./consensus.ts";
import { contributionScore, SCORE_COLUMNS } from "./contribution-score.ts";

// 貢獻看板與查核履歷給讀者看同一個東西：這筆現在幾分、要幾分通過。
// 取法只能有一份（contribution-score.ts），不然規則一改，兩個畫面會各說各話。

const row = { contribution_type: "policy", payload: { title: "x" }, source_urls: ["https://www.cna.com.tw/a"] };

Deno.test("目標分數優先用 effective_agree（系統票已折進去），其次 effective_required，最後才退回門檻矩陣", () => {
  assertEquals(contributionScore({ ...row, score: 1, effective_agree: 4 }), { score: 1, target_score: 4 });
  assertEquals(contributionScore({ ...row, score: 1, effective_required: 2 }), { score: 1, target_score: 2 });
  assertEquals(contributionScore({ ...row, score: 1 }).target_score, requiredAgree("policy", row.payload, row.source_urls));
});

Deno.test("分數可為負、沒有分數當 0", () => {
  assertEquals(contributionScore({ ...row, score: -3, effective_agree: 3 }).score, -3);
  assertEquals(contributionScore({ ...row, score: null, effective_agree: 3 }).score, 0);
  assertEquals(contributionScore({ ...row, effective_agree: 3 }).score, 0);
});

Deno.test("SCORE_COLUMNS 就是 score 與 effective_agree（PostgREST 計算欄位不撈，目標分數會悄悄退回矩陣）", () => {
  assertEquals(SCORE_COLUMNS.split(",").map((s) => s.trim()), ["score", "effective_agree"]);
});

// 守門：兩個端點都得走 contributionScore，不能自己再算一次。
// 標記字串 contributionScore( 與 SCORE_COLUMNS 各在兩支原始碼裡必須出現、effectiveOrRequired( 必須不出現（在這份共用檔之外）。
Deno.test("contributions-feed 與 history 都走同一支 contributionScore／SCORE_COLUMNS，沒有第二套計分", async () => {
  const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
  const sources: Record<string, string> = {
    "contributions-feed/index.ts": await read("../contributions-feed/index.ts"),
    "_shared/history.ts": await read("./history.ts"),
  };
  for (const [name, src] of Object.entries(sources)) {
    assert(src.includes("contributionScore("), `${name} 要呼叫 contributionScore`);
    assert(src.includes("SCORE_COLUMNS"), `${name} 的 select 要帶 SCORE_COLUMNS`);
    assert(!src.includes("effectiveOrRequired("), `${name} 不得自己呼叫 effectiveOrRequired（目標分數的取法只在 contribution-score.ts）`);
    assert(!src.includes("requiredAgree("), `${name} 不得自己呼叫 requiredAgree（目標分數的取法只在 contribution-score.ts）`);
  }
});
