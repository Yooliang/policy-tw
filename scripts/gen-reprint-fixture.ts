/**
 * 產生轉載判準的真資料守門 fixture（policy-ops#39）：兩則中央社原稿、各自的 Yahoo 轉載、同題的別家報導，
 * 用正式的 fetchSource 抓正文，存「主角名字附近段落」與「全文」的 n-gram 雜湊（不存原文：新聞有著作權，雜湊還原不回文字）。
 *
 *   deno run --allow-net --allow-read --allow-write --node-modules-dir=auto scripts/gen-reprint-fixture.ts
 *
 * 輸出 supabase/functions/_shared/fixtures/reprint-cna.json；independent-sources.test.ts 讀它，不連網路。
 * 網址失效（新聞下架）時換一組重產生即可；改了 REPRINT_EXCERPT／REPRINT_GRAM 也要重產生（測試會檢查兩個常數跟 fixture 一致）。
 */
import { fetchSource, focusText } from "../supabase/functions/_shared/system-one.ts";
import { gramHashes, REPRINT_EXCERPT, REPRINT_GRAM, reprintScore } from "../supabase/functions/_shared/independent-sources.ts";

const CASES = {
  // 傅崐萁：Yahoo 轉載頁的正文前段重複一次、夾廣告（段落對齊最差的一組）
  fu: {
    name: "傅崐萁",
    cna: "https://www.cna.com.tw/news/aipl/202610090258.aspx",
    reprint: "https://tw.news.yahoo.com/%E5%82%85%E5%B4%90%E8%90%81-%E5%A4%9A%E6%95%B8%E6%B0%91%E6%84%8F%E6%8C%BA%E6%99%AE%E7%99%BC%E7%8F%BE%E9%87%91%E6%87%89%E5%8A%A0%E7%A2%BC-%E4%BB%8A%E5%B9%B4%E8%B6%85%E5%BE%B5%E4%BB%8A%E5%B9%B4%E7%99%BC-142636018.html",
    other: "https://tw.news.yahoo.com/%E5%82%85%E5%B4%90%E8%90%81%E5%8A%A0%E7%A2%BC%E8%A1%9D%E6%99%AE%E7%99%BC3%E8%90%AC%E5%85%83-%E7%8E%8B%E9%B4%BB%E8%96%87%E6%8F%90%E7%89%B9%E5%88%A5%E6%A2%9D%E4%BE%8B%E7%95%B6%E8%A7%A3%E6%96%B9-071019614.html",
  },
  // 蔡英文：別家報導引用同一場演說的原話（最難分的反例）
  tsai: {
    name: "蔡英文",
    cna: "https://www.cna.com.tw/news/aipl/202610090236.aspx",
    reprint: "https://tw.news.yahoo.com/%E8%94%A1%E8%8B%B1%E6%96%87%E8%AB%87%E5%85%A9%E5%B2%B8-%E9%81%BF%E5%85%8D%E4%B8%8D%E5%BF%85%E8%A6%81%E6%8C%91%E9%87%81-%E5%85%8B%E5%88%B6%E4%B8%8D%E6%87%89%E8%A2%AB%E8%AA%A4%E8%A7%A3%E7%82%BA%E8%BB%9F%E5%BC%B1-124544475.html",
    other: "https://tw.news.yahoo.com/%E8%94%A1%E8%8B%B1%E6%96%87%E7%BE%8E%E5%9C%8B%E6%BC%94%E8%AC%9B%E8%AB%87%E5%85%A9%E5%B2%B8-%E5%BC%B7%E8%AA%BF-%E9%81%BF%E5%85%8D%E4%B8%8D%E5%BF%85%E8%A6%81%E6%8C%91%E9%87%81-%E5%85%8B%E5%88%B6%E4%B8%8D%E6%98%AF%E8%BB%9F%E5%BC%B1-071741602.html",
  },
};

const out: Record<string, unknown> = { generated_at: new Date().toISOString().slice(0, 10), excerpt: REPRINT_EXCERPT, gram: REPRINT_GRAM, cases: {} };
for (const [key, c] of Object.entries(CASES)) {
  const sig: Record<string, { excerpt: number[]; full: number[] }> = {};
  const sets: Record<string, { excerpt: Set<number>; full: Set<number> }> = {};
  for (const role of ["cna", "reprint", "other"] as const) {
    const r = await fetchSource(c[role]);
    if (r.kind !== "html" || !r.text) throw new Error(`${key}.${role} 抓不到：${r.note}`);
    sets[role] = { excerpt: gramHashes(focusText(r.text, [c.name], REPRINT_EXCERPT)), full: gramHashes(r.text) };
    sig[role] = { excerpt: [...sets[role].excerpt].sort((a, b) => a - b), full: [...sets[role].full].sort((a, b) => a - b) };
  }
  (out.cases as Record<string, unknown>)[key] = { name: c.name, urls: { cna: c.cna, reprint: c.reprint, other: c.other }, ...sig };
  console.log(`${key}: reprint ${reprintScore(sets.cna, sets.reprint).toFixed(3)}  other ${reprintScore(sets.cna, sets.other).toFixed(3)}  reprint/other ${reprintScore(sets.reprint, sets.other).toFixed(3)}`);
}
await Deno.writeTextFile(new URL("../supabase/functions/_shared/fixtures/reprint-cna.json", import.meta.url), JSON.stringify(out) + "\n");
