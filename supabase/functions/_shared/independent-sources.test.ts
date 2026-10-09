/**
 * 多個獨立來源降低目標分數（維護者 2026-10-09；工作單 Yooliang/policy-ops#39）的守門。
 *   a. 轉載判準用真資料：中央社原稿 vs Yahoo 轉載＝同一篇；同題的別家報導＝不同篇（fixtures/reprint-cna.json，scripts/gen-reprint-fixture.ts 產生，只存 3-gram 雜湊）
 *      還原驗證：舊的 Jaccard 判準抓不到這對轉載
 *   b. 挑獨立來源：同媒體子網域算一個、轉載算一個、沒正文的不算、照順序留先出現的
 *   c. 各來源判定與核得過的數量；任一來源矛盾的處理在 system-one（這裡只驗彙整）
 *   d. 目標分數：1 個 −1、2 個 −2、4 個仍 −2（上限）、最低 1；not_supported +1、名冊吻合 1 不變；沒有任何驗證票不會通過
 *   e. SQL 與 TS 一致：contribution_effective_agree 依 contribution_system_vote_sources 降分、上限 2、讀的鍵＝system-one 寫的鍵
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { aggregatePerSource, containment, MAX_CHECKED_SOURCES, MAX_SOURCE_DISCOUNT, perSourceQuestionKey, pickIndependentSources, REPRINT_CONTAINMENT, sameArticle, sourceDiscount } from "./independent-sources.ts";
import { consensusStatus, effectiveRequiredAgree, tally } from "./consensus.ts";

const fixture = JSON.parse(await Deno.readTextFile(new URL("./fixtures/reprint-cna.json", import.meta.url))) as { cna: number[]; reprint: number[]; other: number[] };
const set = (a: number[]) => new Set(a);

Deno.test("a. 真資料：中央社原稿 vs Yahoo 轉載＝同一篇；同題的別家報導＝不同篇", () => {
  const cna = set(fixture.cna), reprint = set(fixture.reprint), other = set(fixture.other);
  assert(cna.size > 300 && reprint.size > 300 && other.size > 300, "fixture 要有足夠的段落");
  assert(containment(cna, reprint) >= REPRINT_CONTAINMENT, `轉載要抓到（${containment(cna, reprint).toFixed(3)}）`);
  assert(containment(cna, other) < REPRINT_CONTAINMENT, `別家報導不能當轉載（${containment(cna, other).toFixed(3)}）`);
  assert(containment(reprint, other) < REPRINT_CONTAINMENT, `同一網站的不同報導也不是轉載（${containment(reprint, other).toFixed(3)}）`);
  // 還原驗證：舊判準（Jaccard ≥ 0.5）在同一份段落上抓不到這對轉載
  const jaccard = (a: Set<number>, b: Set<number>) => { let x = 0; for (const g of a) if (b.has(g)) x++; return x / (a.size + b.size - x); };
  assert(jaccard(cna, reprint) < 0.5, `前提：Jaccard 在真資料上不到 0.5（${jaccard(cna, reprint).toFixed(3)}），所以改用包含度`);
});

const body = "國民黨團總召傅崐萁今天表示，最新網路聲量分析，多數民意認同普發現金應該加碼，他率先提出普發現金新台幣2萬元，就是要替人民發聲、替民生爭取；還稅於民是基本的公平正義，今年超徵，就應該今年還給人民。".repeat(3);
const chrome = (site: string) => `${site} 首頁 新聞 財經 娛樂 運動 影音 登入 `.repeat(20);
const NAMES = ["傅崐萁"];

Deno.test("b. 挑獨立來源：同媒體子網域、轉載、沒正文都不算；先出現的留下", () => {
  const pages = [
    { url: "https://www.cna.com.tw/news/aipl/1.aspx", text: chrome("中央社") + body },
    { url: "https://tw.news.yahoo.com/x-1.html", text: chrome("Yahoo") + "（中央社記者台北9日電）" + body + chrome("相關新聞") }, // 轉載
    { url: "https://news.ltn.com.tw/news/politics/1", text: chrome("自由") + "傅崐萁今日在立法院受訪時，主張普發現金應提高到兩萬元，並批評行政院預算編列保守。".repeat(4) },
    { url: "https://ec.ltn.com.tw/article/1", text: "傅崐萁另一篇經濟版報導，談普發與財政。".repeat(10) }, // 同媒體子網域
    { url: "https://udn.com/news/story/1", text: "" }, // 沒正文
  ];
  const r = pickIndependentSources(pages, NAMES);
  assertEquals(r.independent.map((x) => x.site), ["cna.com.tw", "ltn.com.tw"]);
  assertEquals(r.dropped.map((d) => [d.url.split("/")[2], d.reason]), [["tw.news.yahoo.com", "reprint"], ["ec.ltn.com.tw", "same_site"], ["udn.com", "no_text"]]);
  assert(sameArticle(pages[0].text, pages[1].text, NAMES));
  assert(!sameArticle(pages[0].text, pages[2].text, NAMES));
  assertEquals(MAX_CHECKED_SOURCES, 4);
});

const ok = (p = 0.99) => ({ choice: "confirmed", probabilities: { confirmed: p, contradicted: 0.005, absent: 0.005 } });
const bad = (p = 0.99) => ({ choice: "contradicted", probabilities: { confirmed: 0.005, contradicted: p, absent: 0.005 } });
const absent = () => ({ choice: "absent", probabilities: { confirmed: 0.01, contradicted: 0.01, absent: 0.98 } });

Deno.test("c. 各來源的判定與核得過的獨立來源數", () => {
  const claim = { title: "普發現金加碼到 2 萬元" };
  const sources = [{ url: "https://a.test/1", host: "a.test" }, { url: "https://b.test/1", host: "b.test" }, { url: "https://c.test/1", host: "c.test" }];
  const answers = { [perSourceQuestionKey(0, "title")]: ok(), [perSourceQuestionKey(1, "title")]: ok(0.97), [perSourceQuestionKey(2, "title")]: absent() };
  const r = aggregatePerSource("policy", claim, answers, sources);
  assertEquals(r.per_source.map((x) => x.choice), ["supported", "supported", "cannot_tell"]);
  assertEquals(r.supported_sources, 2);
  const weak = aggregatePerSource("policy", claim, { [perSourceQuestionKey(0, "title")]: ok(), [perSourceQuestionKey(1, "title")]: ok(0.9) }, sources.slice(0, 2));
  assertEquals(weak.supported_sources, 1, "機率不到門檻的不算");
  const contra = aggregatePerSource("policy", claim, { [perSourceQuestionKey(0, "title")]: ok(), [perSourceQuestionKey(1, "title")]: bad() }, sources.slice(0, 2));
  assertEquals(contra.per_source[1].choice, "not_supported", "矛盾的來源要看得出來（system-one 據此把系統票改成 not_supported）");
});

Deno.test("d. 目標分數：1 個 −1、2 個以上 −2（上限）、最低 1；其他規則不變；沒有驗證票不會通過", () => {
  assertEquals(effectiveRequiredAgree(3, "supported"), 2, "沒記來源數＝1 個（舊系統票）");
  assertEquals(effectiveRequiredAgree(3, "supported", false, 1), 2);
  assertEquals(effectiveRequiredAgree(3, "supported", false, 2), 1);
  assertEquals(effectiveRequiredAgree(3, "supported", false, 4), 1, "4 個都核得過仍是 1（上限 −2）");
  assertEquals(effectiveRequiredAgree(2, "supported", false, 2), 1, "最低 1");
  assertEquals(effectiveRequiredAgree(3, "supported", false, 0), 2, "0 當 1（系統票 supported 本身就是一個）");
  assertEquals(effectiveRequiredAgree(3, "not_supported", false, 2), 4, "not_supported 照舊 +1");
  assertEquals(effectiveRequiredAgree(3, null, false, 2), 3, "棄權不動");
  assertEquals(effectiveRequiredAgree(3, "supported", true, 2), 1, "名冊吻合照舊 1");
  assertEquals([sourceDiscount(undefined), sourceDiscount(1), sourceDiscount(2), sourceDiscount(9)], [1, 1, 2, MAX_SOURCE_DISCOUNT]);
  // 目標 1 也一定要一張別台機器的同意票：系統票不算分數
  const target = effectiveRequiredAgree(3, "supported", false, 4);
  assertEquals(consensusStatus(tally([]), "pending", target), "pending", "沒有任何驗證票不會上線");
  assertEquals(consensusStatus(tally([{ verdict: "agree" }]), "pending", target), "verified");
});

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
async function latestDefining(marker: string): Promise<string> {
  const files = [...Deno.readDirSync(MIGRATIONS)].map((e) => e.name).filter((n) => n.endsWith(".sql") && !n.includes("_policy_jp_")).sort();
  let found = "";
  for (const f of files) {
    const sql = (await Deno.readTextFile(new URL(f, MIGRATIONS))).replace(/\r\n/g, "\n");
    if (sql.includes(marker)) found = sql;
  }
  if (!found) throw new Error(`找不到 ${marker}`);
  return found;
}

Deno.test("e. SQL 與 TS 一致：依核得過的獨立來源數降分、上限 2、讀的鍵就是 system-one 寫的鍵", async () => {
  const eff = await latestDefining("FUNCTION contribution_effective_agree");
  assert(eff.includes("WHEN v_sys = 'supported' THEN GREATEST(1, v_need - COALESCE(contribution_system_vote_sources(p_contribution_id), 1))"));
  const src = await latestDefining("FUNCTION contribution_system_vote_sources");
  assert(src.includes(`LEAST(${MAX_SOURCE_DISCOUNT}, GREATEST(1,`), "上限跟 TS 的 MAX_SOURCE_DISCOUNT 一致、最少 1");
  assert(src.includes("j.state->'supported_sources'") && src.includes("j.state->>'supported_sources'"), "讀 state.supported_sources");
  // 合格條件跟 contribution_system_vote 同一套（最新一張有效系統票）
  for (const s of ["j.question = 'source_support'", "j.probability >= system_one_min_probability()", "system_vote_eligible(c.contribution_type)", "ORDER BY j.asked_at DESC"]) assert(src.includes(s), s);
  const precheck = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  assert(precheck.includes("askState.supported_sources ="), "system-one 寫的鍵要跟 SQL 讀的一樣");
  assert(precheck.includes("pickIndependentSources(usable, names)"), "precheck 要挑獨立來源");
  assert(precheck.includes('contra.length > 0 ? "not_supported"'), "任一獨立來源明確矛盾仍是 not_supported");
});

Deno.test("f. /next 的 current.system_vote.sources：舊系統票沒有就不出現；supported 時帶核得過的獨立來源數", async () => {
  const { systemVoteSources } = await import("./independent-sources.ts");
  assertEquals(systemVoteSources({ claim: {} }, "supported"), {}, "舊系統票");
  const st = { sources: { checked: ["https://a.test/1", "https://b.test/1"], independent: ["https://a.test/1", "https://b.test/1"], dropped: [], per_source: [] }, supported_sources: 2 };
  const out = systemVoteSources(st, "supported").sources as Record<string, unknown>;
  assertEquals(out.supported_independent, 2);
  assertEquals((out.independent as unknown[]).length, 2);
  assert(!("supported_independent" in (systemVoteSources(st, "not_supported").sources as Record<string, unknown>)), "不是 supported 不報降幾分");
});
