/**
 * 產生轉載判準的真資料守門 fixture（policy-ops#39）：中央社原稿、它的 Yahoo 轉載、同題的別家報導，
 * 用正式的 fetchSource 抓正文、focusText 取主角名字附近的段落，存成 3-gram 雜湊（不存原文：新聞有著作權，雜湊還原不回文字）。
 *
 *   deno run --allow-net --allow-read --allow-write --node-modules-dir=auto scripts/gen-reprint-fixture.ts
 *
 * 輸出 supabase/functions/_shared/fixtures/reprint-cna.json；independent-sources.test.ts 讀它，不連網路。
 * 網址失效（新聞下架）時換一組重產生即可，測試只看三組雜湊的包含度。
 */
import { fetchSource, focusText } from "../supabase/functions/_shared/system-one.ts";
import { containment, gramHashes, REPRINT_EXCERPT } from "../supabase/functions/_shared/independent-sources.ts";

const NAMES = ["傅崐萁"];
const SOURCES = {
  cna: "https://www.cna.com.tw/news/aipl/202610090258.aspx",
  reprint: "https://tw.news.yahoo.com/%E5%82%85%E5%B4%90%E8%90%81-%E5%A4%9A%E6%95%B8%E6%B0%91%E6%84%8F%E6%8C%BA%E6%99%AE%E7%99%BC%E7%8F%BE%E9%87%91%E6%87%89%E5%8A%A0%E7%A2%BC-%E4%BB%8A%E5%B9%B4%E8%B6%85%E5%BE%B5%E4%BB%8A%E5%B9%B4%E7%99%BC-142636018.html",
  other: "https://tw.news.yahoo.com/%E5%82%85%E5%B4%90%E8%90%81%E5%8A%A0%E7%A2%BC%E8%A1%9D%E6%99%AE%E7%99%BC3%E8%90%AC%E5%85%83-%E7%8E%8B%E9%B4%BB%E8%96%87%E6%8F%90%E7%89%B9%E5%88%A5%E6%A2%9D%E4%BE%8B%E7%95%B6%E8%A7%A3%E6%96%B9-071019614.html",
};

const out: Record<string, unknown> = { generated_at: new Date().toISOString().slice(0, 10), names: NAMES, excerpt: REPRINT_EXCERPT, sources: SOURCES };
const sets: Record<string, Set<number>> = {};
for (const [k, url] of Object.entries(SOURCES)) {
  const r = await fetchSource(url);
  if (r.kind !== "html" || !r.text) throw new Error(`${k} 抓不到：${r.note}`);
  sets[k] = gramHashes(focusText(r.text, NAMES, REPRINT_EXCERPT));
  out[k] = [...sets[k]].sort((a, b) => a - b);
}
console.log(`cna/reprint ${containment(sets.cna, sets.reprint).toFixed(3)}  cna/other ${containment(sets.cna, sets.other).toFixed(3)}  reprint/other ${containment(sets.reprint, sets.other).toFixed(3)}`);
await Deno.writeTextFile(new URL("../supabase/functions/_shared/fixtures/reprint-cna.json", import.meta.url), JSON.stringify(out) + "\n");
