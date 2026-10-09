/**
 * 多個獨立來源降低目標分數（維護者 2026-10-09；工作單 Yooliang/policy-ops#39）的守門。
 *   a. 轉載判準用真資料（兩組）：中央社原稿 vs Yahoo 轉載＝同一篇；同題的別家報導（含引用同一段原話的）＝不同篇
 *      （fixtures/reprint-cna.json，scripts/gen-reprint-fixture.ts 產生，只存 n-gram 雜湊）；fixture 的段落長度與字串長度＝現行常數
 *      還原驗證：舊的整頁 Jaccard 抓不到轉載；3 字一組時反例與門檻的距離變小
 *   b. 挑獨立來源：同媒體子網域與同集團算一個、本人官網與社群合併算一個、轉載算一個、沒正文不算、沒有主角名字比不出轉載就不算額外的
 *   c. 系統票彙整（行為）：任一來源矛盾 → not_supported；核得過的獨立來源要那一頁有主角名字；題數上限
 *   d. 目標分數：1 個 −1、2 個以上 −2（上限）、最低 1；not_supported +1、名冊吻合 1 不變；沒有任何驗證票不會通過
 *   e. SQL 與 TS 一致：contribution_effective_agree 依 contribution_system_vote_sources 降分、上限 2、讀的鍵＝system-one 寫的鍵
 *   f. /next 的 current.system_vote.sources
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  coveredBy, MAX_CHECKED_SOURCES, MAX_PER_SOURCE_QUESTIONS, MAX_SOURCE_DISCOUNT, perSourceCount, perSourceQuestionKey, perSourceQuestions,
  pickIndependentSources, REPRINT_CONTAINMENT, REPRINT_EXCERPT, REPRINT_GRAM, reprintScore, sameArticle, SELF_OR_OTHER_GROUP, sourceDiscount,
  sourceGroupOf, systemVoteFromAnswers, systemVoteSources,
} from "./independent-sources.ts";
import { consensusStatus, effectiveRequiredAgree, tally } from "./consensus.ts";

type Sig = { excerpt: number[]; full: number[] };
const fixture = JSON.parse(await Deno.readTextFile(new URL("./fixtures/reprint-cna.json", import.meta.url))) as {
  excerpt: number; gram: number; cases: Record<string, { name: string; cna: Sig; reprint: Sig; other: Sig }>;
};
const sig = (s: Sig) => ({ excerpt: new Set(s.excerpt), full: new Set(s.full) });

Deno.test("a. 真資料（兩組）：中央社原稿 vs Yahoo 轉載＝同一篇；同題別家報導、同站不同報導＝不同篇", () => {
  assertEquals([fixture.excerpt, fixture.gram], [REPRINT_EXCERPT, REPRINT_GRAM], "fixture 要用現行的段落長度與字串長度產生（改了常數要重產生）");
  assertEquals(Object.keys(fixture.cases).sort(), ["fu", "tsai"]);
  for (const [k, c] of Object.entries(fixture.cases)) {
    const cna = sig(c.cna), reprint = sig(c.reprint), other = sig(c.other);
    assert(cna.excerpt.size > 300 && reprint.full.size > 300 && other.full.size > 300, `${k}：fixture 要有足夠的內容`);
    const r = reprintScore(cna, reprint), o = reprintScore(cna, other), ro = reprintScore(reprint, other);
    assert(r >= REPRINT_CONTAINMENT + 0.1, `${k} 轉載要抓到，而且離門檻至少 0.1（${r.toFixed(3)}）`);
    assert(o <= REPRINT_CONTAINMENT - 0.1, `${k} 別家報導不能當轉載，而且離門檻至少 0.1（${o.toFixed(3)}）`);
    assert(ro <= REPRINT_CONTAINMENT - 0.1, `${k} 同站兩篇不同報導也不是轉載（${ro.toFixed(3)}）`);
    // 還原驗證：舊判準（整頁 Jaccard ≥ 0.5）抓不到這對轉載
    const jaccard = (a: Set<number>, b: Set<number>) => { let x = 0; for (const g of a) if (b.has(g)) x++; return x / (a.size + b.size - x); };
    assert(k !== "fu" || jaccard(cna.full, reprint.full) < 0.5, `前提：整頁 Jaccard 在傅崐萁那組不到 0.5（${jaccard(cna.full, reprint.full).toFixed(3)}）`);
  }
  assertEquals(coveredBy(new Set(), new Set([1])), 0);
});

const body = "國民黨團總召傅崐萁今天表示，最新網路聲量分析，多數民意認同普發現金應該加碼，他率先提出普發現金新台幣2萬元，就是要替人民發聲、替民生爭取；還稅於民是基本的公平正義，今年超徵，就應該今年還給人民。".repeat(3);
const chrome = (site: string) => `${site} 首頁 新聞 財經 娛樂 運動 影音 登入 `.repeat(20);
const NAMES = ["傅崐萁"];
const other = (who: string) => `${who}報導：傅崐萁今日在立法院受訪時，主張普發現金應提高到兩萬元，並批評行政院預算編列保守，${who}記者追問財源。`.repeat(4);

Deno.test("b. 來源分組：媒體集團併一、社群與其他網站（含本人官網）併一、官方照網站分", () => {
  assertEquals(sourceGroupOf("https://news.ltn.com.tw/news/1"), sourceGroupOf("https://ec.ltn.com.tw/article/1"));
  assertEquals(sourceGroupOf("https://tw.news.yahoo.com/x.html"), sourceGroupOf("https://tw.stock.yahoo.com.tw/x.html"));
  assertEquals(sourceGroupOf("https://focustaiwan.tw/politics/1"), sourceGroupOf("https://www.cna.com.tw/news/aipl/1.aspx"));
  for (const u of ["https://www.facebook.com/fu.official/posts/1", "https://www.instagram.com/p/1", "https://www.threads.net/@x/post/1", "https://fu-kun-chi.tw/news/1"]) {
    assertEquals(sourceGroupOf(u), SELF_OR_OTHER_GROUP, u);
  }
  assert(sourceGroupOf("https://www.tncc.gov.tw/1") !== sourceGroupOf("https://www.kcc.gov.tw/1"), "各縣市議會是不同網站");
});

Deno.test("b. 挑獨立來源：同站、轉載、本人官網＋本人臉書、沒正文都不算；先出現的留下", () => {
  const pages = [
    { url: "https://www.cna.com.tw/news/aipl/1.aspx", text: chrome("中央社") + body },
    { url: "https://tw.news.yahoo.com/x-1.html", text: chrome("Yahoo") + "（中央社記者台北9日電）" + body + chrome("相關新聞") }, // 轉載
    { url: "https://news.ltn.com.tw/news/politics/1", text: chrome("自由") + other("自由時報") },
    { url: "https://ec.ltn.com.tw/article/1", text: other("自由財經") }, // 同媒體子網域
    { url: "https://fu-kun-chi.tw/news/1", text: "傅崐萁服務處新聞稿：立委傅崐萁提案修正特別條例，普發金額由一萬元調高為兩萬元，並說明財源來自今年度稅收超徵。".repeat(4) },
    { url: "https://www.facebook.com/fu.official/posts/1", text: "傅崐萁臉書貼文：感謝大家支持普發兩萬元，我們會在院會繼續爭取，今天也到花蓮市場聽鄉親的意見。".repeat(4) }, // 跟本人官網同一組
    { url: "https://udn.com/news/story/1", text: "" }, // 沒正文
  ];
  const r = pickIndependentSources(pages, NAMES);
  assertEquals(r.independent.map((x) => x.url.split("/")[2]), ["www.cna.com.tw", "news.ltn.com.tw", "fu-kun-chi.tw"]);
  assertEquals(r.dropped.map((d) => [d.url.split("/")[2], d.reason]),
    [["tw.news.yahoo.com", "reprint"], ["ec.ltn.com.tw", "same_site"], ["www.facebook.com", "same_site"], ["udn.com", "no_text"]]);
  assertEquals(sameArticle(pages[0].text, pages[1].text, NAMES), true);
  assertEquals(sameArticle(pages[0].text, pages[2].text, NAMES), false);
});

Deno.test("b. 沒有主角名字可對段落：比不出轉載，只有第一個來源算（主線審查第 3 點）", () => {
  const pages = [
    { url: "https://www.cna.com.tw/news/aipl/1.aspx", text: chrome("中央社") + body },
    { url: "https://news.ltn.com.tw/news/politics/1", text: chrome("自由") + other("自由時報") },
  ];
  assertEquals(sameArticle(pages[0].text, pages[1].text, []), null);
  const r = pickIndependentSources(pages, [null, "", "x"]);
  assertEquals(r.independent.length, 1);
  assertEquals(r.dropped.map((d) => d.reason), ["unverifiable"]);
  // 還原驗證：給了名字就分得出來、兩個都算
  assertEquals(pickIndependentSources(pages, NAMES).independent.length, 2);
});

const ok = (p = 0.99) => ({ choice: "confirmed", probabilities: { confirmed: p, contradicted: 0.005, absent: 0.005 } });
const bad = (p = 0.99) => ({ choice: "contradicted", probabilities: { confirmed: 0.005, contradicted: p, absent: 0.005 } });
const absent = () => ({ choice: "absent", probabilities: { confirmed: 0.01, contradicted: 0.01, absent: 0.98 } });
const claim = { title: "普發現金加碼到 2 萬元" };
const src = (host: string, text = `傅崐萁說${host}`) => ({ url: `https://${host}/1`, host, text });

Deno.test("c. 系統票彙整：兩個獨立來源都核得過 → supported、2 個；機率不到門檻、沒有主角名字的不算", () => {
  const two = systemVoteFromAnswers({ contributionType: "policy", claim, names: NAMES, asked: [src("a.test"), src("b.test")],
    answers: { "field:title": ok(), [perSourceQuestionKey(0, "title")]: ok(), [perSourceQuestionKey(1, "title")]: ok(0.97) } });
  assertEquals([two.choice, two.supported_sources], ["supported", 2]);
  const weak = systemVoteFromAnswers({ contributionType: "policy", claim, names: NAMES, asked: [src("a.test"), src("b.test")],
    answers: { "field:title": ok(), [perSourceQuestionKey(0, "title")]: ok(), [perSourceQuestionKey(1, "title")]: ok(0.9) } });
  assertEquals(weak.supported_sources, 1, "機率不到門檻");
  const noName = systemVoteFromAnswers({ contributionType: "policy", claim, names: NAMES, asked: [src("a.test"), src("b.test", "別人的新聞，沒有主角")],
    answers: { "field:title": ok(), [perSourceQuestionKey(0, "title")]: ok(), [perSourceQuestionKey(1, "title")]: ok() } });
  assertEquals([noName.supported_sources, noName.per_source[1].name_hit], [1, false], "Jev 說 confirmed 但那一頁沒有主角名字：不算（決定性檢查）");
  const single = systemVoteFromAnswers({ contributionType: "policy", claim, names: NAMES, asked: [], answers: { "field:title": ok() } });
  assertEquals([single.choice, single.supported_sources, single.per_source.length], ["supported", 1, 0], "沒有逐來源題：1 個");
});

Deno.test("c. 系統票彙整：任一獨立來源明確矛盾 → not_supported（反證不會被多附的來源蓋掉）；併起來那段棄權時不記來源數", () => {
  const contra = systemVoteFromAnswers({ contributionType: "policy", claim, names: NAMES, asked: [src("a.test"), src("b.test")],
    answers: { "field:title": ok(), [perSourceQuestionKey(0, "title")]: ok(), [perSourceQuestionKey(1, "title")]: bad(0.97) } });
  assertEquals([contra.choice, contra.probability, contra.supported_sources], ["not_supported", 0.97, null]);
  const weakContra = systemVoteFromAnswers({ contributionType: "policy", claim, names: NAMES, asked: [src("a.test"), src("b.test")],
    answers: { "field:title": ok(), [perSourceQuestionKey(0, "title")]: ok(), [perSourceQuestionKey(1, "title")]: bad(0.8) } });
  assertEquals(weakContra.choice, "supported", "沒過門檻的矛盾不翻票");
  const unsure = systemVoteFromAnswers({ contributionType: "policy", claim, names: NAMES, asked: [src("a.test"), src("b.test")],
    answers: { "field:title": absent(), [perSourceQuestionKey(0, "title")]: ok(), [perSourceQuestionKey(1, "title")]: ok() } });
  assertEquals([unsure.choice, unsure.supported_sources], ["cannot_tell", null], "系統票照舊由併起來那段決定");
});

Deno.test("c. 逐來源題數上限：欄位多的 correction 少問幾個來源，問不到 2 個就不問", () => {
  assertEquals(perSourceCount(1, 4), 4);
  assertEquals(perSourceCount(6, 4), 4);
  assertEquals(perSourceCount(8, 4), 3);
  assertEquals(perSourceCount(12, 4), 2);
  assertEquals(perSourceCount(13, 4), 0, "24 題只夠 1 個來源＝不問");
  assertEquals(perSourceCount(3, 1), 0);
  const qs = perSourceQuestions({ "field:a": { type: "choice", instructions: "x", criteria: {} } as never, dim: { type: "choice", instructions: "y", criteria: {} } as never }, [{ host: "a.test" }, { host: "b.test" }]);
  assertEquals(Object.keys(qs).sort(), ["src0:field:a", "src1:field:a"], "只複製欄位題，不複製預算題");
  assert(Object.keys(qs).length <= MAX_PER_SOURCE_QUESTIONS);
  assert(String((qs["src1:field:a"] as { instructions: string }).instructions).includes("【來源 b.test】"));
});

Deno.test("d. 目標分數：1 個 −1、2 個以上 −2（上限）、最低 1；其他規則不變；沒有驗證票不會通過", () => {
  assertEquals(effectiveRequiredAgree(3, "supported"), 2, "沒記來源數＝1 個（舊系統票）");
  assertEquals(effectiveRequiredAgree(3, "supported", false, 2), 1);
  assertEquals(effectiveRequiredAgree(3, "supported", false, 4), 1, "4 個都核得過仍是 1（上限 −2）");
  assertEquals(effectiveRequiredAgree(2, "supported", false, 2), 1, "最低 1");
  assertEquals(effectiveRequiredAgree(3, "supported", false, 0), 2, "0 當 1");
  assertEquals(effectiveRequiredAgree(3, "not_supported", false, 2), 4, "not_supported 照舊 +1");
  assertEquals(effectiveRequiredAgree(3, null, false, 2), 3);
  assertEquals(effectiveRequiredAgree(3, "supported", true, 2), 1, "名冊吻合照舊 1");
  assertEquals([sourceDiscount(undefined), sourceDiscount(1), sourceDiscount(2), sourceDiscount(9)], [1, 1, 2, MAX_SOURCE_DISCOUNT]);
  const target = effectiveRequiredAgree(3, "supported", false, 4);
  assertEquals(consensusStatus(tally([]), "pending", target), "pending", "沒有任何驗證票不會上線");
  assertEquals(consensusStatus(tally([{ verdict: "agree" }]), "pending", target), "verified");
  assertEquals(MAX_CHECKED_SOURCES, 4);
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
  const s = await latestDefining("FUNCTION contribution_system_vote_sources");
  assert(s.includes(`LEAST(${MAX_SOURCE_DISCOUNT}, GREATEST(1,`), "上限跟 TS 的 MAX_SOURCE_DISCOUNT 一致、最少 1");
  assert(s.includes("j.state->'supported_sources'") && s.includes("j.state->>'supported_sources'"), "讀 state.supported_sources");
  for (const x of ["j.question = 'source_support'", "j.probability >= system_one_min_probability()", "system_vote_eligible(c.contribution_type)", "ORDER BY j.asked_at DESC"]) assert(s.includes(x), x);
  const precheck = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  assert(precheck.includes("askState.supported_sources = vote.supported_sources"), "system-one 寫的鍵要跟 SQL 讀的一樣，值來自 systemVoteFromAnswers");
  assert(precheck.includes("pickIndependentSources(usable, personNames)"), "precheck 要挑獨立來源（只用人名）");
  assert(precheck.includes("asked: askedPages, names: personNames })"), "逐來源名字檢查只用人名");
  const pn = /const personNames = \[([^\]]*)\]/.exec(precheck);
  assert(pn && !pn[1].includes("payload.title"), "人名清單不能含政見標題（主線複審第 3 點）");
  assert(precheck.includes("systemVoteFromAnswers({"), "precheck 的判定走 systemVoteFromAnswers（行為測試在 c）");
  assert(precheck.includes("perSourceCount(Object.keys(questions).length"), "逐來源題數有上限");
});

Deno.test("f. /next 的 current.system_vote.sources：舊系統票沒有就不出現；supported 時帶核得過的獨立來源數", () => {
  assertEquals(systemVoteSources({ claim: {} }, "supported"), {}, "舊系統票");
  const st = { sources: { checked: ["https://a.test/1", "https://b.test/1"], independent: ["https://a.test/1", "https://b.test/1"], dropped: [], per_source: [] }, supported_sources: 2 };
  const out = systemVoteSources(st, "supported").sources as Record<string, unknown>;
  assertEquals(out.supported_independent, 2);
  assert(!("supported_independent" in (systemVoteSources(st, "not_supported").sources as Record<string, unknown>)), "不是 supported 不報降幾分");
});

Deno.test("g. 主線複審：矛盾也要那一頁有主角名字才翻票", () => {
  const r = systemVoteFromAnswers({ contributionType: "policy", claim, names: NAMES, asked: [src("a.test"), src("b.test", "別人的新聞，沒有主角")],
    answers: { "field:title": ok(), [perSourceQuestionKey(0, "title")]: ok(), [perSourceQuestionKey(1, "title")]: bad(0.99) } });
  assertEquals([r.choice, r.supported_sources], ["supported", 1], "沒寫到主角的頁被判矛盾，不翻票、也不算核得過");
  // 還原驗證：寫到主角的頁判矛盾照樣翻
  const r2 = systemVoteFromAnswers({ contributionType: "policy", claim, names: NAMES, asked: [src("a.test"), src("b.test")],
    answers: { "field:title": ok(), [perSourceQuestionKey(0, "title")]: ok(), [perSourceQuestionKey(1, "title")]: bad(0.99) } });
  assertEquals(r2.choice, "not_supported");
});

Deno.test("g. 主線複審：媒體集團（中時、東森）併一；LINE TODAY 算新聞、LINE 其他服務不算；媒體底下的使用者自寫區不算", () => {
  const cht = sourceGroupOf("https://www.chinatimes.com/realtimenews/1");
  assertEquals([sourceGroupOf("https://www.ctee.com.tw/news/1"), sourceGroupOf("https://www.ctwant.com/article/1")], [cht, cht]);
  assertEquals(sourceGroupOf("https://news.ebc.net.tw/news/1"), sourceGroupOf("https://www.ettoday.net/news/1"));
  assertEquals(sourceGroupOf("https://today.line.me/tw/v2/article/1"), "today.line.me");
  assertEquals(sourceGroupOf("https://page.line.me/abc"), SELF_OR_OTHER_GROUP, "LINE 官方帳號");
  assertEquals(sourceGroupOf("https://linevoom.line.me/post/1"), SELF_OR_OTHER_GROUP, "LINE VOOM");
  assertEquals(sourceGroupOf("https://blog.udn.com/x/1"), SELF_OR_OTHER_GROUP, "udn 部落格");
  assertEquals(sourceGroupOf("https://talk.ltn.com.tw/article/1"), SELF_OR_OTHER_GROUP, "自由評論網");
  assert(sourceGroupOf("https://udn.com/news/story/1") !== SELF_OR_OTHER_GROUP, "udn 新聞照算媒體");
});
