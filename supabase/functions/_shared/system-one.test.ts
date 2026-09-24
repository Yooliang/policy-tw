import { assertEquals } from "jsr:@std/assert@1";
import { textSimilarity, SAME_CONTENT_THRESHOLD, buildPairAsk, nameHit, normalizeName, aggregateExtract, buildExtractAsk, parseExtractTask, aggregateFieldVerdicts, articleBodyFromJsonLd, combineSources, hasUsableText, flattenCorrection, askJev, buildPolicyAsk, buildSourceSupportAsk, claimOf, fetchSource, focusText, htmlToText, JEV_MODEL, toRecords, validateRecord } from "./system-one.ts";

const target = { id: "aaaaaaaa-0000-0000-0000-000000000001", title: "新生兒補助10萬元", description: "承諾當選新北市長後，每位新生兒提供10萬元補助。", election_id: null };
const sibDated = { id: "bbbbbbbb-0000-0000-0000-000000000002", title: "學童營養午餐全面免費", description: "x", election_id: 2024 };
const sibUndated = { id: "cccccccc-0000-0000-0000-000000000003", title: "六大福利政見", description: null, election_id: null };
const elections = [
  { election_id: 2024, election_type: "立法委員", candidate_status: "confirmed", election_result: "elected" },
  { election_id: 2026, election_type: "縣市長", candidate_status: "registered", election_result: null },
];

// 藍圖 §2-1：事實放 state、選項放 criteria；§2-3：已知答案要放進 state 當參考
Deno.test("三題齊全時：兄弟政見進 others、已標屆別的進 already_labelled、criteria 各有兜底選項", () => {
  const { state, questions } = buildPolicyAsk(target, [sibDated, sibUndated], elections);
  assertEquals(Object.keys(questions).sort(), ["duplicate_of", "election", "is_policy"]);
  assertEquals(Object.keys(state.others as object), ["bbbbbbbb", "cccccccc"]);
  // 只有標了屆別的才算參考；沒標的放進去等於拿空白當答案
  assertEquals(state.already_labelled, [{ title: "學童營養午餐全面免費", election_id: 2024 }]);
  assertEquals(questions.duplicate_of.criteria.none !== undefined, true);
  assertEquals(questions.election.criteria.unknown !== undefined, true);
  assertEquals(Object.keys(questions.election.criteria).sort(), ["2024", "2026", "unknown"]);
});

Deno.test("沒有兄弟政見就不問排重、沒有參選紀錄就不問屆別：只剩一個選項的題目沒有意義", () => {
  const alone = buildPolicyAsk(target, [], []);
  assertEquals(Object.keys(alone.questions), ["is_policy"]);
  assertEquals("others" in alone.state, false);
  assertEquals("elections" in alone.state, false);
  // 自己不會出現在 others 裡
  const self = buildPolicyAsk(target, [target], elections);
  assertEquals("duplicate_of" in self.questions, false);
});

Deno.test("兄弟政見全沒標屆別時不放 already_labelled（放空陣列會讓模型以為參考資料是空的）", () => {
  const { state } = buildPolicyAsk(target, [sibUndated], elections);
  assertEquals("already_labelled" in state, false);
});

Deno.test("toRecords：每題一列、機率取被選中那個選項、成本平均分攤、model 用回應裡的帶日期版本", () => {
  const res = {
    model: "typesafe/jev-1.13-20260917",
    answers: {
      is_policy: { type: "choice", choice: "policy", probabilities: { policy: 0.97, not_policy: 0.03 }, confidence: 0.9 },
      election: { type: "choice", choice: "2026", probabilities: { "2026": 0.91, "2024": 0.05, unknown: 0.04 }, confidence: 0.8 },
    },
    usage: { input_tokens: 10, output_tokens: 2, cost: 0.00003 },
  };
  const rows = toRecords("policy", target.id, { target: {} }, res);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].probability, 0.97);
  assertEquals(rows[1].choice, "2026");
  assertEquals(rows[1].probability, 0.91);
  assertEquals(rows[0].cost_usd, 0.000015);
  assertEquals(rows.every((r) => r.model === "typesafe/jev-1.13-20260917"), true);
  assertEquals(rows.every((r) => validateRecord(r) === null), true);
});

Deno.test("validateRecord：alias 版本、空 state、機率超界都要擋", () => {
  const ok = { subject_type: "policy", subject_id: "x", question: "is_policy", choice: "policy", probability: 0.9, confidence: null, probabilities: null, model: "typesafe/jev-1.13-20260917", state: { a: 1 }, cost_usd: null } as const;
  assertEquals(validateRecord(ok), null);
  assertEquals(validateRecord({ ...ok, model: JEV_MODEL })?.includes("alias"), true);
  assertEquals(validateRecord({ ...ok, state: {} })?.includes("state"), true);
  assertEquals(validateRecord({ ...ok, probability: 1.2 })?.includes("probability"), true);
  assertEquals(validateRecord({ ...ok, question: "vibes" as never })?.includes("question"), true);
});

Deno.test("askJev：釘住 typesafe/jev-1.13、打 decisions 端點；非 2xx 要丟錯", async () => {
  let sent: { url: string; body: Record<string, unknown> } | null = null;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent = { url: String(url), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers: {}, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } }), { status: 200 });
  }) as typeof fetch;
  await askJev("k", { a: 1 }, {}, fakeFetch);
  assertEquals(sent!.url.endsWith("/api/alpha/decisions"), true);
  assertEquals(sent!.body.model, "typesafe/jev-1.13");
  let threw = false;
  try {
    await askJev("k", { a: 1 }, {}, (async () => new Response("nope", { status: 500 })) as typeof fetch);
  } catch (e) {
    threw = String(e).includes("500");
  }
  assertEquals(threw, true);
});

// ---- 系統來源票 ----

Deno.test("htmlToText：去 script／style／nav、去標籤、還原實體、壓空白", () => {
  const html = `<html><head><style>.a{}</style><script>var x=1;</script></head><body><nav>選單</nav><h1>李四川&nbsp;政見</h1><p>承諾&quot;當選後&quot;推動 &#25429;</p></body></html>`;
  const t = htmlToText(html);
  assertEquals(t.includes("var x"), false);
  assertEquals(t.includes("選單"), false);
  assertEquals(t.includes('李四川 政見'), true);
  assertEquals(t.includes('承諾"當選後"推動 捕'), true);
});

Deno.test("focusText：名字附近優先、不重複、超過上限截斷；沒命中取開頭", () => {
  const filler = "無關文字。".repeat(300);
  const text = filler + "李四川表示將推動捷運三鶯線延伸。" + filler + "李四川另提六大福利。" + filler;
  const f = focusText(text, ["李四川"], 3000);
  assertEquals(f.includes("捷運三鶯線"), true);
  assertEquals(f.length <= 3000, true);
  assertEquals(focusText("abc", [null, "x"], 10), "abc", "沒命中就取開頭");
  assertEquals(focusText("", ["李"]), "");
});

Deno.test("claimOf 只留判斷用欄位；buildSourceSupportAsk 的 criteria 有三個選項且事實在 state", () => {
  const claim = claimOf("candidacy", { name: "王小明", party: "民主進步黨", contributor_ip_hash: "x", agent_tool: "y", election_id: 2026, birth_year: 1962, source_note: null });
  assertEquals(Object.keys(claim).sort(), ["election_id", "name", "party"], "參選紀錄不核出生年，空值不帶");
  assertEquals(Object.keys(claimOf("politician", { name: "王小明", birth_year: 1962, election_id: 2026 })).sort(), ["birth_year", "name"], "人物資料才核出生年");
  const { state, questions } = buildSourceSupportAsk(claim, "https://a.b/c", "頁面文字");
  assertEquals(Object.keys(questions).sort(), ["field:election_id", "field:name", "field:party"], "每個 claim 欄位一題");
  assertEquals(Object.keys(questions["field:name"].criteria).sort(), ["absent", "confirmed", "contradicted"]);
  assertEquals((state.page as { url: string }).url, "https://a.b/c");
  assertEquals((state.claim as { name: string }).name, "王小明");
});

Deno.test("fetchSource：帶瀏覽器 UA；PDF／試算表回 pdf 不解析（2026-09-20 裁決）；非 2xx 回 error", async () => {
  let ua = "";
  const okHtml = (async (_u: string | URL | Request, init?: RequestInit) => {
    ua = String((init?.headers as Record<string, string>)["User-Agent"]);
    return new Response("<p>hi</p>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const r1 = await fetchSource("https://x/y", okHtml);
  assertEquals(r1.kind, "html"); assertEquals(r1.text, "hi"); assertEquals(ua.includes("Mozilla"), true);
  const pdf = (async () => new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } })) as typeof fetch;
  assertEquals((await fetchSource("https://x/f", pdf)).kind, "pdf");
  const bad = (async () => new Response("nope", { status: 403 })) as typeof fetch;
  const r3 = await fetchSource("https://x/z", bad);
  assertEquals(r3.kind, "error"); assertEquals(r3.note, "http 403 | archive:0"); // 2026-09-22：抓不到也找快照，note 留 archive 長度
});

// 2026-09-19 第一批 precheck：三筆自由時報全 cannot_tell，正文其實在 JSON-LD 的 articleBody 裡、被當 script 丟掉
Deno.test("htmlToText：JSON-LD 的 articleBody 要被撈出來放在最前面，script 照樣不進正文", () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"NewsArticle","headline":"台北市58名議員候選人登記","articleBody":"九合一大選年底登場，台北市至今已有58名議員候選人登記。"}</script><script>var tracker=1;</script></head><body><p>相關新聞</p></body></html>`;
  assertEquals(articleBodyFromJsonLd(html).startsWith("台北市58名議員候選人登記"), true);
  const t = htmlToText(html);
  assertEquals(t.startsWith("台北市58名議員候選人登記\n九合一大選"), true);
  assertEquals(t.includes("var tracker"), false);
  assertEquals(t.includes("相關新聞"), true);
  // 壞掉的 JSON 不能讓整頁抽字失敗
  assertEquals(htmlToText(`<script type="application/ld+json">{bad</script><p>ok</p>`), "ok");
});

// 2026-09-19 使用者：「每一欄一個可信度，拆細會不會比較好」
Deno.test("aggregateFieldVerdicts：核心欄位全 confirmed → supported、信心取最弱；任一欄高信心 contradicted → not_supported；其餘棄權", () => {
  const claim = { name: "鍾小平", party: "中國國民黨", region: "台北市", election_id: 2026, election_type: "縣市議員", candidate_status: "registered" };
  const ans = (m: Record<string, [string, number]>) => Object.fromEntries(Object.entries(m).map(([k, [c, p]]) => [`field:${k}`, { type: "choice", choice: c, probabilities: { [c]: p } }]));
  const good = aggregateFieldVerdicts("candidacy", claim, ans({ name: ["confirmed", 1], party: ["absent", 0.9], region: ["confirmed", 0.99], election_id: ["confirmed", 0.97], election_type: ["confirmed", 0.98], candidate_status: ["confirmed", 0.96] }));
  assertEquals(good.choice, "supported");
  assertEquals(good.probability, 0.96, "最弱的核心欄位決定信心；政黨 absent 不影響（非核心）");
  const bad = aggregateFieldVerdicts("candidacy", claim, ans({ name: ["confirmed", 1], party: ["contradicted", 0.97], region: ["confirmed", 0.99], election_id: ["confirmed", 0.97], election_type: ["confirmed", 0.98], candidate_status: ["confirmed", 0.96] }));
  assertEquals(bad.choice, "not_supported", "非核心欄位寫了不同的值一樣算反對");
  assertEquals(bad.probability, 0.97);
  const weakContra = aggregateFieldVerdicts("candidacy", claim, ans({ name: ["confirmed", 1], party: ["contradicted", 0.6], region: ["confirmed", 0.99], election_id: ["confirmed", 0.97], election_type: ["confirmed", 0.98], candidate_status: ["confirmed", 0.96] }));
  assertEquals(weakContra.choice, "supported", "低信心的 contradicted 不擋，核心全 confirmed 仍算支持");
  const missing = aggregateFieldVerdicts("candidacy", claim, ans({ name: ["confirmed", 1], region: ["absent", 0.9], election_id: ["confirmed", 0.97], election_type: ["confirmed", 0.98], candidate_status: ["confirmed", 0.96] }));
  assertEquals(missing.choice, "cannot_tell", "核心欄位 absent → 棄權");
  assertEquals(missing.probability, 0);
  assertEquals(Object.keys(missing.fields).length, 5, "細節全部留下來給代理看");
});

// 2026-09-19 第一批：更正的 claim 把 target_table 當欄位問，頁面證明不了那種東西
Deno.test("更正的 claim：攤成「欄位＝新值」＋ subject_name；核心欄位就是那些新值", () => {
  const payload = { target_table: "policies", target_id: "x", reason: "公報寫的是 2026", subject_name: "某政見",
    changes: [{ field: "election_id", current_value: null, correct_value: 2026 }, { field: "proposed_date", current_value: "2024-01-01", correct_value: "2026-02-04" }] };
  const claim = claimOf("correction", payload);
  assertEquals(claim, { subject_name: "某政見", election_id: 2026, proposed_date: "2026-02-04" });
  assertEquals(flattenCorrection({ field: "birth_year", correct_value: 1962 }), { birth_year: 1962 }, "舊格式也收");
  const ans: Record<string, { type: string; choice: string; probabilities: Record<string, number> }> = {
    "field:subject_name": { type: "choice", choice: "confirmed", probabilities: { confirmed: 0.99 } },
    "field:election_id": { type: "choice", choice: "confirmed", probabilities: { confirmed: 0.97 } },
    "field:proposed_date": { type: "choice", choice: "absent", probabilities: { absent: 0.8 } } };
  assertEquals(aggregateFieldVerdicts("correction", claim, ans).choice, "cannot_tell", "有一個新值沒被證明就不算支持");
  ans["field:proposed_date"] = { type: "choice", choice: "confirmed", probabilities: { confirmed: 0.96 } };
  const ok = aggregateFieldVerdicts("correction", claim, ans);
  assertEquals(ok.choice, "supported"); assertEquals(ok.probability, 0.96);
});

// 2026-09-19：第一個來源常是中選會附件索引頁，名單在 PDF 或後面的來源裡
Deno.test("combineSources：含人名的來源排前面、每段標來源網域、空的略過、總長受限", () => {
  const idx = { url: "https://web.cec.gov.tw/central/cms/1", text: "115年地方公職人員選舉候選人登記名冊 附件下載 " + "x".repeat(600) };
  const pdf = { url: "https://web.cec.gov.tw/api/file/a.pdf", text: "115年直轄市議員選舉候選人登記情形一覽表 臺南市第9選舉區 周麗津 臺南市第9選舉區 王大明" };
  const empty = { url: "https://x/y", text: "" };
  const out = combineSources([idx, pdf, empty], ["周麗津"]);
  assertEquals(out.startsWith("【來源 web.cec.gov.tw】\n115年直轄市議員"), true, "有名字的那份在最前面");
  assertEquals(out.includes("附件下載"), true, "沒名字的也附在後面");
  assertEquals(out.includes("https://x/y"), false);
  assertEquals(combineSources([], ["a"]), "");
  assertEquals(combineSources([{ url: "u", text: "y".repeat(10000) }], ["a"], 2200, 3000).length <= 3000, true);
});


// 2026-09-19：連江縣選委會縣市長登記彙總表（xls）抽出來只有 171 字，被 200 字門檻擋成「抓不到正文」
Deno.test("hasUsableText：短文本只要點到主角名字就算有正文；空殼頁不算", () => {
  const csv = "登記日期,登記之選舉區,姓名,性別,推薦之政黨\n115/08/31,連江縣,王忠銘,男,中國國民黨\n115/09/02,連江縣,曹爾元,男,無";
  assertEquals(hasUsableText(csv, ["王忠銘"]), true);
  assertEquals(hasUsableText(csv, ["陳亭妃"]), false);
  assertEquals(hasUsableText("王忠銘", ["王忠銘"]), false);
  assertEquals(hasUsableText("x".repeat(200), ["陳亭妃"]), true);
  assertEquals(hasUsableText("", [null, undefined]), false);
});

// 2026-09-19 使用者：「它應該是收到任務之後，分析關鍵字自己找來源」——有限域的欄位讓 Jev 從代理找到的頁面裡選值
Deno.test("parseExtractTask：只認兩種 auto 任務", () => {
  assertEquals(parseExtractTask("auto:election_result_missing:13167"), { task_type: "election_result_missing", pe_id: 13167 });
  assertEquals(parseExtractTask("auto:candidate_status_stale:42"), { task_type: "candidate_status_stale", pe_id: 42 });
  assertEquals(parseExtractTask("auto:policy_missing:abc"), null);
  assertEquals(parseExtractTask("auto:election_result_missing:not-a-number"), null);
});

Deno.test("buildExtractAsk：先問同一個人，再問那一欄；criteria 是有限域", () => {
  const { questions, field, state } = buildExtractAsk("election_result_missing", { name: "張嘉哲", region: "南投縣", election_id: 2022, election_type: "鄉鎮市長", party: "中國國民黨" }, "https://x/y", "…張嘉哲當選南投市長…");
  assertEquals(field, "election_result");
  assertEquals(Object.keys(questions), ["same_person", "election_result"]);
  assertEquals(Object.keys(questions.election_result.criteria), ["elected", "not_elected", "absent"]);
  assertEquals(questions.same_person.instructions.includes("張嘉哲（南投縣 2022 鄉鎮市長，中國國民黨）"), true);
  assertEquals((state.page as { url: string }).url, "https://x/y");
  const st = buildExtractAsk("candidate_status_stale", { name: "王小明", election_id: 2026 }, "https://x", "…");
  assertEquals(Object.keys(st.questions.candidate_status.criteria), ["registered", "not_running", "absent"]);
});

Deno.test("aggregateExtract：同一個人且值過門檻才算數；absent 回 null；人不對就不算", () => {
  const ok = aggregateExtract("election_result_missing", {
    same_person: { choice: "same_person", probabilities: { same_person: 0.99, different_person: 0.01, unclear: 0 } },
    election_result: { choice: "elected", probabilities: { elected: 0.97, not_elected: 0.02, absent: 0.01 } },
  });
  assertEquals(ok, { field: "election_result", person: { choice: "same_person", probability: 0.99 }, value: "elected", probability: 0.97, counts: true });
  const weak = aggregateExtract("election_result_missing", {
    same_person: { choice: "same_person", probabilities: { same_person: 0.99 } },
    election_result: { choice: "elected", probabilities: { elected: 0.90 } },
  });
  assertEquals(weak.value, "elected"); assertEquals(weak.counts, false); assertEquals(weak.probability, 0.9);
  const wrongPerson = aggregateExtract("election_result_missing", {
    same_person: { choice: "different_person", probabilities: { different_person: 0.98 } },
    election_result: { choice: "elected", probabilities: { elected: 0.99 } },
  });
  assertEquals(wrongPerson.counts, false);
  const absent = aggregateExtract("candidate_status_stale", {
    same_person: { choice: "same_person", probabilities: { same_person: 0.99 } },
    candidate_status: { choice: "absent", probabilities: { absent: 0.99 } },
  });
  assertEquals(absent.value, null); assertEquals(absent.counts, false);
  assertEquals(aggregateExtract("candidate_status_stale", {}).counts, false);
});

// 2026-09-19：卡伊．馬賴——中選會 PDF 寫「卡伊‧馬賴」、payload 寫「卡伊．馬賴」，而且那次文本根本沒有她那一列
Deno.test("nameHit／normalizeName：間隔號、臺台、空白不算不同；主角不在文本就 false", () => {
  assertEquals(normalizeName("卡伊．馬賴"), normalizeName("卡伊‧馬賴"));
  assertEquals(normalizeName("臺北市 王小明"), "台北市王小明");
  assertEquals(nameHit("新竹市第7選舉區 115/09/03 卡伊‧馬賴 民主進步黨", ["卡伊．馬賴"]), true);
  assertEquals(nameHit("115年縣市議員選舉候選人登記彙總表（索引頁，名單見附件）", ["卡伊．馬賴"]), false);
  assertEquals(nameHit("一段文字", [null, undefined, "王"]), false, "單字名不比");
});

Deno.test("buildPairAsk：一題 same／diff／unclear，state 帶兩筆", () => {
  const { state, questions } = buildPairAsk({ id: "a", name: "吳品叡", region: "嘉義縣", birth_year: 1986, party: "無黨籍" }, { id: "b", name: "吳品叡", region: "嘉義縣", birth_year: 1986, party: "無黨籍及未經政黨推薦" });
  assertEquals(Object.keys(questions), ["same_person"]);
  assertEquals(Object.keys(questions.same_person.criteria), ["same", "diff", "unclear"]);
  assertEquals((state.a as { name: string }).name, "吳品叡");
});


Deno.test("aggregateFieldVerdicts：回 core_fields 與 contradicted_core（非核心欄矛盾不構成反對）", () => {
  const claim = { name: "卡伊．馬賴", region: "新竹市", party: "民主進步黨", election_id: 2026, election_type: "縣市議員", candidate_status: "registered" };
  type A = Record<string, { choice: string; probabilities: Record<string, number> }>;
  const ans: A = {
    "field:name": { choice: "confirmed", probabilities: { confirmed: 1 } }, "field:region": { choice: "contradicted", probabilities: { contradicted: 1 } },
    "field:party": { choice: "confirmed", probabilities: { confirmed: 1 } }, "field:election_id": { choice: "confirmed", probabilities: { confirmed: 0.99 } },
    "field:election_type": { choice: "confirmed", probabilities: { confirmed: 0.98 } }, "field:candidate_status": { choice: "confirmed", probabilities: { confirmed: 0.96 } },
  };
  const plain = aggregateFieldVerdicts("candidacy", claim, ans as never);
  assertEquals(plain.choice, "not_supported"); assertEquals(plain.contradicted_core, true, "region 是核心欄");
  const partyOnly = aggregateFieldVerdicts("candidacy", claim, { ...ans, "field:region": { choice: "confirmed", probabilities: { confirmed: 1 } }, "field:party": { choice: "contradicted", probabilities: { contradicted: 0.99 } } } as never);
  assertEquals(partyOnly.choice, "not_supported"); assertEquals(partyOnly.contradicted_core, false, "政黨不是核心欄：not_supported 但不構成反對");
});

Deno.test("textSimilarity：轉載幾乎一樣 → 高；不同稿 → 低", () => {
  const a = "國民黨立法院黨團總召傅崐萁今天提案修正國籍法，增訂大陸地區人民取得台灣戶籍者參選公職依兩岸人民關係條例規定，不適用國籍法放棄國籍的規定。";
  const b = "【轉載】" + a + "（中央社）";
  const c = "屏東縣長周春米今天出席社區共餐活動，宣布長輩加菜計畫將擴大到全縣三十三鄉鎮，並補助每人每餐二十元。";
  assertEquals(textSimilarity(a, b) >= SAME_CONTENT_THRESHOLD, true);
  assertEquals(textSimilarity(a, c) < SAME_CONTENT_THRESHOLD, true);
  assertEquals(textSimilarity("", a), 0);
});

// 2026-09-25：no_change 沒有 name／title，原本落到預設欄位、target 是空的，Jev 答票數預算時什麼都沒看到
Deno.test("claimOf：no_change 送出宣告、查了哪裡、看到什麼", () => {
  const claim = claimOf("no_change", { task_id: "auto:policy_missing:x", outcome: "not_found", checked_urls: ["https://www.cna.com.tw/"], finding: "查了中央社首頁，沒有找到", agent_tool: "y" });
  assertEquals(Object.keys(claim).sort(), ["checked_urls", "finding", "outcome", "task_id"]);
});
