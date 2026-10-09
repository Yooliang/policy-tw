import { assert, assertEquals } from "jsr:@std/assert@1";
import { canonicalPayload, JP_CONTRIBUTION_TYPES, validateContributionRequest, validateVerifyRequest } from "./contribution-schema.ts";

const base = { agent_name: "jp-agent", agent_tool: "claude-code/claude-sonnet-5" };
const noChange = {
  contribution_type: "no_change",
  payload: { task_id: "auto:policy_missing:abc", outcome: "confirmed", checked_urls: ["https://www.pref.example.lg.jp/a"], finding: "公式サイトを確認し、登録内容と一致していた" },
};
const correction = {
  contribution_type: "correction",
  payload: { target_table: "policies", target_id: "p-1", changes: [{ field: "status", correct_value: "achieved" }], reason: "県の公式発表で達成が確認できる" },
  source_urls: ["https://www.pref.example.lg.jp/b"],
};
const suggestion = {
  contribution_type: "task_suggestion",
  payload: { title: "この公約の進捗を調べる必要あり", description: "最新の施政方針に記載があるため進捗確認の任務を立てたい。", task_type: "progress_stale" },
  source_urls: ["https://www.pref.example.lg.jp/c"],
};

const election = {
  contribution_type: "election",
  payload: { lg_code: "131130", election_type: "mayor", election_reason: "regular", election_date: "2027-01-24", notice_date: "2027-01-17", name: "渋谷区長選挙", resolved_claim: "new" },
  source_urls: ["https://www.city.shibuya.tokyo.jp/senkyo/"],
};
const localGovernment = {
  contribution_type: "local_government",
  payload: { lg_code: "232033", kind: "city", pref_code: "230006", name: "一宮市", kana: "いちのみやし", resolved_claim: "new" },
  source_urls: ["https://www.soumu.go.jp/denshijiti/code.html"],
};
const regionalStat = {
  contribution_type: "regional_stat",
  payload: { lg_code: "232033", stat_key: "population", year: 2020, value: 386_678, unit: "人", as_of: "2020-10-01", resolved_claim: "new" },
  source_urls: ["https://www.e-stat.go.jp/regional-statistics/ssdsview/municipality"],
};
const withElection = (patch: Record<string, unknown>, drop: string[] = []) => {
  const e = structuredClone(election);
  Object.assign(e.payload, patch);
  for (const k of drop) delete (e.payload as Record<string, unknown>)[k];
  return validateContributionRequest({ ...base, ...e });
};
const pathsOf = (v: ReturnType<typeof validateContributionRequest>) => v.errors.map((e) => e.path);

Deno.test("六種型別各一筆都過", () => {
  assertEquals([...JP_CONTRIBUTION_TYPES], ["no_change", "task_suggestion", "correction", "election", "local_government", "regional_stat"]);
  for (const it of [noChange, correction, suggestion, election, localGovernment, regionalStat]) {
    const v = validateContributionRequest({ ...base, ...structuredClone(it) });
    assertEquals(v.errors, [], JSON.stringify(v.errors));
    assert(v.ok);
  }
});

Deno.test("election：最小可過的 payload（notice_date、name 可省）；頂層 task_id 照收", () => {
  const v = withElection({}, ["notice_date", "name"]);
  assertEquals(v.errors, [], JSON.stringify(v.errors));
  const ichi = structuredClone(election);
  Object.assign(ichi.payload, { lg_code: "232033", name: "一宮市長選挙" });
  const withTask = validateContributionRequest({ ...base, ...ichi, task_id: "auto:election_discovery:2027-01-31:232033:head" });
  assert(withTask.ok, JSON.stringify(withTask.errors));
  assertEquals(withTask.items[0].task_id, "auto:election_discovery:2027-01-31:232033:head");
  // 沒有出處就擋（跟其他非 no_change 型別一樣：source_urls 至少一個）
  const noSrc = validateContributionRequest({ ...base, contribution_type: "election", payload: structuredClone(election.payload) });
  assert(pathsOf(noSrc).includes("source_urls"));
});

Deno.test("election：lg_code 地方選舉必填且 6 碼數字", () => {
  assert(pathsOf(withElection({}, ["lg_code"])).includes("payload.lg_code"));
  for (const bad of ["13113", "1311300", "13113a", "", 131130]) assert(pathsOf(withElection({ lg_code: bad })).includes("payload.lg_code"), `lg_code=${bad}`);
  // 縣級也是 6 碼（北海道 010006）
  assert(withElection({ lg_code: "010006", election_type: "governor" }).ok);
});

Deno.test("election：國政選舉不帶 lg_code（帶了擋、不帶過；null 當沒帶）", () => {
  for (const t of ["national_lower", "national_upper"]) {
    assert(pathsOf(withElection({ election_type: t })).includes("payload.lg_code"), `${t} 帶了 lg_code 要擋`);
    assert(withElection({ election_type: t }, ["lg_code"]).ok, `${t} 不帶 lg_code 要過`);
    assert(withElection({ election_type: t, lg_code: null }).ok, `${t} lg_code=null 要過`);
  }
});

Deno.test("election：election_type／election_reason 只收 policy_jp.elections 的列舉", () => {
  for (const t of ["governor", "mayor", "ward_mayor", "town_mayor", "national_lower", "national_upper", "pref_assembly", "muni_assembly"]) {
    assert(withElection({ election_type: t }, t.startsWith("national") ? ["lg_code"] : []).ok, `election_type=${t}`);
  }
  assert(pathsOf(withElection({ election_type: "village_head" })).includes("payload.election_type"));
  assert(pathsOf(withElection({}, ["election_type"])).includes("payload.election_type"));
  for (const r of ["regular", "resignation", "death", "recall", "dissolution", "rerun"]) assert(withElection({ election_reason: r }).ok, `election_reason=${r}`);
  assert(pathsOf(withElection({ election_reason: "term_end" })).includes("payload.election_reason"));
  assert(pathsOf(withElection({}, ["election_reason"])).includes("payload.election_reason"));
  // election_type 填錯時只報 election_type，不連帶報 lg_code
  assertEquals(pathsOf(withElection({ election_type: "nope" }, ["lg_code"])), ["payload.election_type"]);
});

Deno.test("election：補欠（by_election）・増員（increase）只限議員選舉（同 DB CHECK elections_by_election_assembly）", () => {
  for (const r of ["by_election", "increase"]) {
    for (const t of ["mayor", "governor", "ward_mayor", "town_mayor"]) assert(pathsOf(withElection({ election_type: t, election_reason: r })).includes("payload.election_reason"), `${t}＋${r} 要擋`);
    for (const t of ["pref_assembly", "muni_assembly"]) assert(withElection({ election_type: t, election_reason: r }).ok, `${t}＋${r} 要過`);
    for (const t of ["national_lower", "national_upper"]) assert(withElection({ election_type: t, election_reason: r }, ["lg_code"]).ok, `${t}＋${r} 要過`);
  }
});

Deno.test("election：election_date 必填、要是真的有這一天；notice_date 選填、不晚於投票日", () => {
  assert(pathsOf(withElection({}, ["election_date"])).includes("payload.election_date"));
  for (const bad of ["2027/01/24", "2027-1-24", "令和9年1月24日", "2027-02-30", "2027-13-01", "2027-00-10", "", 20270124, null]) {
    assert(pathsOf(withElection({ election_date: bad })).includes("payload.election_date"), `election_date=${String(bad)}`);
  }
  assert(withElection({ election_date: "2028-02-29", notice_date: "2028-02-20" }).ok, "閏日是真的有這一天");
  assert(pathsOf(withElection({ election_date: "2027-02-29" })).includes("payload.election_date"), "2027 不是閏年");
  assert(withElection({ notice_date: "2027-01-24" }).ok, "告示日＝投票日可以（只擋晚於）");
  assert(pathsOf(withElection({ notice_date: "2027-01-25" })).includes("payload.notice_date"));
  assert(pathsOf(withElection({ notice_date: "2027-02-30" })).includes("payload.notice_date"));
  assert(pathsOf(withElection({ notice_date: "" })).includes("payload.notice_date"));
  // 投票日本身不合格時，不拿它去比告示日（只報投票日的錯）
  assertEquals(pathsOf(withElection({ election_date: "2027-02-30", notice_date: "2027-03-01" })), ["payload.election_date"]);
});

Deno.test("election：name 選填，給了要 1～100 字", () => {
  assert(withElection({ name: "渋" }).ok);
  assert(withElection({ name: "あ".repeat(100) }).ok);
  assert(pathsOf(withElection({ name: "あ".repeat(101) })).includes("payload.name"));
  assert(pathsOf(withElection({ name: "   " })).includes("payload.name"));
  assert(pathsOf(withElection({ name: 123 })).includes("payload.name"));
});

Deno.test("election：多個欄位同時錯，一次全報（讓 AI 一次修完）；去重鍵與鍵順序無關", () => {
  const v = withElection({ lg_code: "x", election_type: "mayor", election_reason: "death", election_date: "2027-99-99", notice_date: "2027-01-01", name: "" });
  assertEquals(pathsOf(v).sort(), ["payload.election_date", "payload.lg_code", "payload.name"]);
  const a = canonicalPayload({ contribution_type: "election", payload: { lg_code: "131130", election_date: "2027-01-24" }, source_urls: [] });
  const b = canonicalPayload({ contribution_type: "election", payload: { election_date: "2027-01-24", lg_code: "131130" }, source_urls: [] });
  assertEquals(a, b);
});

Deno.test("其他型別（正見的 candidacy 等）不收", () => {
  const v = validateContributionRequest({ ...base, contribution_type: "candidacy", payload: {}, source_urls: ["https://a.example/x"] });
  assertEquals(v.ok, false);
  assertEquals(v.errors[0].path, "contribution_type");
});

Deno.test("no_change：task_id 不能自己組、outcome 必填、沒給 source_urls 用 checked_urls", () => {
  const bad = structuredClone(noChange);
  bad.payload.task_id = "李玫-2026";
  (bad.payload as Record<string, unknown>).outcome = "maybe";
  const v = validateContributionRequest({ ...base, ...bad });
  const paths = v.errors.map((e) => e.path);
  assert(paths.includes("payload.task_id") && paths.includes("payload.outcome"));
  // 頂層 task_id 會被補進 payload
  const top = structuredClone(noChange);
  delete (top.payload as Record<string, unknown>).task_id;
  const ok = validateContributionRequest({ ...base, ...top, task_id: "auto:policy_missing:abc" });
  assert(ok.ok, JSON.stringify(ok.errors));
});

Deno.test("correction：target_table 白名單、reason ≥10 字、欄位重複擋、舊格式 field＋correct_value 也收", () => {
  const badTable = structuredClone(correction);
  (badTable.payload as Record<string, unknown>).target_table = "cec_candidates";
  assert(validateContributionRequest({ ...base, ...badTable }).errors.some((e) => e.path === "payload.target_table"));
  const dup = structuredClone(correction);
  (dup.payload as Record<string, unknown>).changes = [{ field: "status", correct_value: "a" }, { field: "status", correct_value: "b" }];
  assert(validateContributionRequest({ ...base, ...dup }).errors.some((e) => e.message.includes("重複")));
  const short = structuredClone(correction);
  (short.payload as Record<string, unknown>).reason = "短い";
  assert(validateContributionRequest({ ...base, ...short }).errors.some((e) => e.path === "payload.reason"));
  const old = { ...base, contribution_type: "correction", payload: { target_table: "policies", target_id: "p-1", field: "status", correct_value: "achieved", reason: "公式発表で確認できる内容" }, source_urls: ["https://a.example/x"] };
  assert(validateContributionRequest(old).ok);
});

Deno.test("一次最多 20 筆；亂碼擋下", () => {
  const many = Array.from({ length: 21 }, () => ({ ...structuredClone(correction) }));
  assert(validateContributionRequest({ ...base, contributions: many }).errors.some((e) => e.path === "contributions"));
  const enc = validateContributionRequest({ ...base, ...structuredClone(correction), note: "壊れた�文字" });
  assertEquals(enc.errors[0].code, "encoding_invalid");
});

Deno.test("驗證請求：disagree 要 evidence_url 與 note", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  assertEquals(validateVerifyRequest({ contribution_id: id, verdict: "disagree", agent_name: "jp-agent" }).ok, false);
  assert(validateVerifyRequest({ contribution_id: id, verdict: "disagree", agent_name: "jp-agent", evidence_url: "https://a.example/x", note: "來源內容矛盾" }).ok);
  assert(validateVerifyRequest({ contribution_id: id, verdict: "agree", agent_name: "jp-agent", note: "確認了第三段" }).ok);
});

Deno.test("canonicalPayload 與鍵順序無關", () => {
  const a = canonicalPayload({ contribution_type: "no_change", payload: { a: 1, b: { c: 2, d: 3 } }, source_urls: [] });
  const b = canonicalPayload({ contribution_type: "no_change", payload: { b: { d: 3, c: 2 }, a: 1 }, source_urls: [] });
  assertEquals(a, b);
});

Deno.test("task_suggestion 的 target_politician_id／target_policy_id：日本站的 id 是 TEXT，不要求 uuid（P-日本 審查 #498）", () => {
  const ok = structuredClone(suggestion);
  Object.assign(ok.payload, { target_politician_id: "pol-131130-0001", target_policy_id: "policy-2027-001" });
  assertEquals(validateContributionRequest({ ...base, ...ok }).ok, true, "TEXT id 要照收");
  for (const bad of ["", 123, "x".repeat(65)]) {
    const s = structuredClone(suggestion);
    Object.assign(s.payload, { target_politician_id: bad, target_policy_id: bad });
    const v = validateContributionRequest({ ...base, ...s });
    assertEquals(v.ok, false, `不合格的 id（${JSON.stringify(bad)}）要擋`);
    assert(pathsOf(v).includes("payload.target_politician_id") && pathsOf(v).includes("payload.target_policy_id"));
  }
});


// =========================================================================================
// local_government／regional_stat（落庫那一批 PR）與 #503 b（election 的檢查碼・日期範圍・task_id 比對）
// =========================================================================================
const withLg = (patch: Record<string, unknown>, drop: string[] = [], urls?: string[], task?: string) => {
  const e = structuredClone(localGovernment) as { contribution_type: string; payload: Record<string, unknown>; source_urls: string[] };
  Object.assign(e.payload, patch);
  for (const k of drop) delete e.payload[k];
  return validateContributionRequest({ ...base, ...e, ...(urls ? { source_urls: urls } : {}), ...(task ? { task_id: task } : {}) });
};
const withStat = (patch: Record<string, unknown>, drop: string[] = [], urls?: string[], task?: string) => {
  const e = structuredClone(regionalStat) as { contribution_type: string; payload: Record<string, unknown>; source_urls: string[] };
  Object.assign(e.payload, patch);
  for (const k of drop) delete e.payload[k];
  return validateContributionRequest({ ...base, ...e, ...(urls ? { source_urls: urls } : {}), ...(task ? { task_id: task } : {}) });
};

Deno.test("local_government：最小可過的 payload；種類都收；slug 不用交", () => {
  assert(withLg({}).ok, JSON.stringify(withLg({}).errors));
  const prefecture = { lg_code: "230006", kind: "prefecture", pref_code: "230006", name: "愛知県", kana: "あいちけん" };
  assert(withLg(prefecture).ok, JSON.stringify(withLg(prefecture).errors));
  const cases: Array<[string, Record<string, unknown>]> = [
    ["designated_city", { lg_code: "231002", kind: "designated_city", name: "名古屋市", kana: "なごやし" }],
    ["core_city", { lg_code: "232033", kind: "core_city", name: "一宮市" }],
    ["special_ward", { lg_code: "131130", kind: "special_ward", pref_code: "130001", name: "渋谷区", kana: "しぶやく" }],
    ["admin_ward", { lg_code: "231011", kind: "admin_ward", name: "千種区", kana: "ちくさく" }],
    ["town", { lg_code: "233021", kind: "town", name: "東郷町", kana: "とうごうちょう" }],
    ["village", { lg_code: "235610", kind: "village", name: "豊根村", kana: "とよねむら" }],
  ];
  for (const [k, patch] of cases) {
    const v = withLg(patch);
    // 檢查碼自己算不準的，交給 lgCodeValid：只有檢查碼正確的才會 ok，這裡只看「種類」這一條不報錯
    assert(!pathsOf(v).includes("payload.kind"), `${k}：${JSON.stringify(v.errors)}`);
  }
  assert(withLg({ slug: "ichinomiya" }).ok, "多給的欄位照收（落庫端自己決定 slug）");
});

Deno.test("local_government：lg_code 檢查碼、pref_code 對應、kind 列舉、都道府県自己填自己", () => {
  for (const bad of ["232034", "23203", "2320333", "23203a", "", 232033, null]) assert(pathsOf(withLg({ lg_code: bad })).includes("payload.lg_code"), `lg_code=${String(bad)}`);
  assert(pathsOf(withLg({}, ["lg_code"])).includes("payload.lg_code"));
  // pref_code：必填、檢查碼對、要是 lg_code 的縣市碼
  assert(pathsOf(withLg({}, ["pref_code"])).includes("payload.pref_code"));
  assert(pathsOf(withLg({ pref_code: "230007" })).includes("payload.pref_code"), "檢查碼不對");
  const wrongPref = withLg({ pref_code: "200000" });
  assertEquals(pathsOf(wrongPref), ["payload.pref_code"]);
  assert(wrongPref.errors[0].message.includes("230006"), "告訴代理正確的縣市碼是什麼");
  // kind
  assert(pathsOf(withLg({ kind: "county" })).includes("payload.kind"));
  assert(pathsOf(withLg({}, ["kind"])).includes("payload.kind"));
  // kind=prefecture 卻不是縣碼；縣碼卻填 city
  assert(pathsOf(withLg({ kind: "prefecture", name: "一宮県" })).includes("payload.kind"));
  assert(pathsOf(withLg({ lg_code: "230006", pref_code: "230006", kind: "city", name: "愛知市" })).includes("payload.kind"));
  assert(withLg({ lg_code: "230006", pref_code: "230006", kind: "prefecture", name: "愛知県", kana: "あいちけん" }).ok);
});

Deno.test("local_government：name 結尾要跟 kind 對得上、kana 要全ひらがな、長度", () => {
  assert(pathsOf(withLg({ name: "一宮" })).includes("payload.name"), "city 要以市結尾");
  assert(pathsOf(withLg({ name: "一宮町" })).includes("payload.name"));
  assert(pathsOf(withLg({ name: "" })).includes("payload.name"));
  assert(pathsOf(withLg({ name: "あ".repeat(41) + "市" })).includes("payload.name"));
  assert(withLg({ lg_code: "230006", pref_code: "230006", kind: "prefecture", name: "北海道", kana: "ほっかいどう" }).ok);
  for (const [kind, name] of [["town", "東郷町"], ["village", "豊根村"], ["special_ward", "渋谷区"], ["admin_ward", "千種区"], ["designated_city", "名古屋市"], ["core_city", "豊橋市"]] as const) {
    const v = withLg({ kind, name });
    assert(!pathsOf(v).includes("payload.name"), `${kind}:${name}`);
  }
  assert(pathsOf(withLg({ kind: "village", name: "豊根町" })).includes("payload.name"));
  for (const bad of ["イチノミヤシ", "ｲﾁﾉﾐﾔｼ", "いちのみや し", "ichinomiya", "一宮市", "いちのみや（市）", ""]) assert(pathsOf(withLg({ kana: bad })).includes("payload.kana"), `kana=${bad}`);
  assert(!pathsOf(withLg({ kana: "とうきょうと" })).includes("payload.kana"));
  assert(!pathsOf(withLg({ kana: "らーめんし" })).includes("payload.kana"), "長音符はひらがな扱い");
  assert(pathsOf(withLg({}, ["kana"])).includes("payload.kana"));
});

Deno.test("local_government／regional_stat：source_urls に公的な出典（総務省・e-Stat・*.go.jp・*.lg.jp・団体の公式サイト）が最低 1 つ要る", () => {
  assert(pathsOf(withLg({}, [], ["https://ja.wikipedia.org/wiki/一宮市"])).includes("source_urls"), "wikipedia だけは通さない");
  assert(pathsOf(withLg({}, [], ["https://www.asahi.com/a", "https://twitter.com/city_ichinomiya"])).includes("source_urls"));
  for (const url of ["https://www.soumu.go.jp/denshijiti/code.html", "https://www.city.ichinomiya.aichi.jp/", "https://www.pref.aichi.lg.jp/", "https://www.town.togo.aichi.jp/", "https://www.vill.toyone.aichi.jp/"]) {
    assert(withLg({}, [], [url]).ok, url);
    assert(withLg({}, [], ["https://ja.wikipedia.org/wiki/一宮市", url]).ok, `ほかの出典と一緒でも ${url} があれば通る`);
  }
  assert(pathsOf(withStat({}, [], ["https://ja.wikipedia.org/wiki/一宮市"])).includes("source_urls"));
  assert(pathsOf(withStat({}, [], ["https://www.asahi.com/a"])).includes("source_urls"));
  for (const url of ["https://www.e-stat.go.jp/regional-statistics/ssdsview/municipality", "https://www.stat.go.jp/data/kokusei/2020/", "https://www.soumu.go.jp/iken/kessan_jokyo_2.html", "https://www.city.ichinomiya.aichi.jp/toukei/"]) {
    assert(withStat({}, [], [url]).ok, url);
  }
  // 公的な出典が 1 つもなくても、ほかの型別（election など）はこの規則の対象外（election は従来どおり任意の出典）
  assert(validateContributionRequest({ ...base, ...structuredClone(election), source_urls: ["https://www.asahi.com/a"] }).ok);
});

Deno.test("regional_stat：4 種の stat_key と固定の単位；値の範囲；year／as_of", () => {
  for (const [key, unit, value] of [["population", "人", 386678], ["area_km2", "km2", 113.82], ["budget_expenditure", "千円", 187654321], ["aging_rate", "%", 28.6]] as const) {
    assert(withStat({ stat_key: key, unit, value }).ok, key);
    for (const wrong of ["円", "千人", "㎢", "％", "percent", ""]) if (wrong !== unit) assert(pathsOf(withStat({ stat_key: key, unit: wrong, value })).includes("payload.unit"), `${key} の単位 ${wrong}`);
  }
  assert(pathsOf(withStat({ stat_key: "gdp" })).includes("payload.stat_key"));
  assert(pathsOf(withStat({}, ["stat_key"])).includes("payload.stat_key"));
  // 値
  assert(pathsOf(withStat({ value: "386678" })).includes("payload.value"), "文字列は不可");
  assert(pathsOf(withStat({ value: Number.NaN })).includes("payload.value"));
  assert(pathsOf(withStat({ value: -1 })).includes("payload.value"));
  assert(pathsOf(withStat({ value: 10.5 })).includes("payload.value"), "人口は整數");
  assert(pathsOf(withStat({ stat_key: "budget_expenditure", unit: "千円", value: 1.5 })).includes("payload.value"));
  assert(pathsOf(withStat({ stat_key: "aging_rate", unit: "%", value: 100.1 })).includes("payload.value"));
  assert(withStat({ stat_key: "aging_rate", unit: "%", value: 0 }).ok && withStat({ stat_key: "aging_rate", unit: "%", value: 100 }).ok);
  assert(pathsOf(withStat({ stat_key: "area_km2", unit: "km2", value: 0 })).includes("payload.value"));
  assert(pathsOf(withStat({}, ["value"])).includes("payload.value"));
  // year
  for (const bad of [2020.5, "2020", 1899, 2101, null]) assert(pathsOf(withStat({ year: bad })).includes("payload.year"), `year=${String(bad)}`);
  assert(withStat({ year: 1900 }).ok && withStat({ year: 2100 }).ok);
  // as_of（任意）
  assert(withStat({}, ["as_of"]).ok);
  for (const bad of ["2020-02-30", "2020/10/01", "0000-01-01", "1946-12-31", "2101-01-01", "", 20201001]) assert(pathsOf(withStat({ as_of: bad })).includes("payload.as_of"), `as_of=${String(bad)}`);
  // lg_code
  assert(pathsOf(withStat({ lg_code: "232034" })).includes("payload.lg_code"));
  // 一次報完
  assertEquals(pathsOf(withStat({ lg_code: "x", stat_key: "population", unit: "千人", value: -3, year: 1000, as_of: "x" })).sort(),
    ["payload.as_of", "payload.lg_code", "payload.unit", "payload.value", "payload.year"]);
});

Deno.test("election（#503 b）：lg_code 驗檢查碼（與 SQL lg_code_valid 同公式）", () => {
  assert(withElection({ lg_code: "131130" }).ok);
  const bad = withElection({ lg_code: "131131" });
  assertEquals(pathsOf(bad), ["payload.lg_code"]);
  assert(bad.errors[0].message.includes("檢查碼"));
  // 形狀不對（5／7 碼）仍是原本那條訊息，不重複報
  assertEquals(pathsOf(withElection({ lg_code: "13113" })), ["payload.lg_code"]);
  assert(withElection({ lg_code: "010006", election_type: "governor" }).ok);
  assert(pathsOf(withElection({ lg_code: "010007", election_type: "governor" })).includes("payload.lg_code"));
});

Deno.test("election（#503 b）：日期要有合理年份範圍 1947～2100（PostgreSQL 不收 0000 年）", () => {
  for (const ok of ["1947-01-01", "1947-04-05", "2100-12-31", "2027-01-24"]) assert(withElection({ election_date: ok, notice_date: undefined }, ["notice_date"]).ok, `election_date=${ok}`);
  for (const bad of ["0000-01-01", "0001-01-01", "1946-12-31", "1900-05-05", "2101-01-01", "9999-12-31"]) {
    assert(pathsOf(withElection({ election_date: bad }, ["notice_date"])).includes("payload.election_date"), `election_date=${bad}`);
  }
  for (const bad of ["0000-01-01", "1946-12-31", "2101-01-01"]) assert(pathsOf(withElection({ election_date: "2027-01-24", notice_date: bad })).includes("payload.notice_date"), `notice_date=${bad}`);
  assert(withElection({ election_date: "1947-04-05", notice_date: "1947-03-20" }).ok);
});

Deno.test("election（#503 b）：帶 task_id 時 payload 的 lg_code（與職位）要跟 task_id 一致，不一致回 400（validation_failed）", () => {
  const ED = "auto:election_discovery:2027-01-31:232033:head";
  const ichi = (patch: Record<string, unknown> = {}, task: string | null = ED) => {
    const e = structuredClone(election) as { contribution_type: string; payload: Record<string, unknown>; source_urls: string[] };
    Object.assign(e.payload, { lg_code: "232033", name: "一宮市長選挙" }, patch);
    return validateContributionRequest({ ...base, ...e, ...(task ? { task_id: task } : {}) });
  };
  assert(ichi().ok, JSON.stringify(ichi().errors));
  // 別的團體
  const other = ichi({ lg_code: "131130" });
  assertEquals(pathsOf(other), ["payload.lg_code"]);
  assert(other.errors[0].message.includes("232033") && other.errors[0].message.includes("131130"));
  // 國政選舉（沒有 lg_code）塞進地方任務
  assert(pathsOf(ichi({ election_type: "national_lower", lg_code: undefined })).includes("payload.lg_code"));
  // 長的任務不收議會；議會的任務不收長
  assert(pathsOf(ichi({ election_type: "muni_assembly" })).includes("payload.election_type"));
  for (const t of ["governor", "mayor", "ward_mayor", "town_mayor"]) assert(ichi({ election_type: t }).ok, `head 任務收 ${t}`);
  const EA = "auto:election_discovery:2027-01-31:232033:assembly";
  assert(ichi({ election_type: "muni_assembly" }, EA).ok);
  assert(ichi({ election_type: "pref_assembly" }, EA).ok);
  assert(pathsOf(ichi({ election_type: "mayor" }, EA)).includes("payload.election_type"));
  // 補欠・再選舉也要是同一個團體
  assert(pathsOf(ichi({ election_type: "muni_assembly", election_reason: "by_election", lg_code: "230006" }, EA)).includes("payload.lg_code"));
  // 沒有 task_id／手動任務 uuid／別的臂的任務：不比對
  assert(ichi({ lg_code: "131130" }, null).ok);
  assert(ichi({ lg_code: "131130" }, "11111111-2222-4333-8444-555555555555").ok);
  // task_id 格式不對（不是 jp-next 給的）
  assert(pathsOf(ichi({}, "auto:election_discovery:232033")).includes("task_id"));
  assert(pathsOf(ichi({}, "auto:election_discovery:2027-01-31:232033:body")).includes("task_id"));
  // 拿別的臂的任務來交 election
  const wrongArm = ichi({}, "auto:local_government_missing:232033");
  assertEquals(pathsOf(wrongArm), ["task_id"]);
  assert(wrongArm.errors[0].message.includes("local_government"));
  // lg_code 欄位前面已經報過錯就不重複（只有一條 payload.lg_code）
  assertEquals(pathsOf(ichi({ lg_code: "23203" })).filter((p) => p === "payload.lg_code").length, 1);
});

Deno.test("local_government／regional_stat：帶 task_id 時團體要跟任務一致；型別要對得上任務；no_change 不受影響", () => {
  const LG = "auto:local_government_missing:232033";
  assert(withLg({}, [], undefined, LG).ok);
  const wrongLg = withLg({ lg_code: "230006", kind: "prefecture", pref_code: "230006", name: "愛知県", kana: "あいちけん" }, [], undefined, LG);
  assertEquals(pathsOf(wrongLg), ["payload.lg_code"]);
  assert(withLg({}, [], undefined, "auto:local_government_missing:230006").errors.some((e) => e.path === "payload.lg_code"));
  const ST = "auto:regional_stats_missing:232033";
  assert(withStat({}, [], undefined, ST).ok);
  assertEquals(pathsOf(withStat({ lg_code: "230006" }, [], undefined, ST)), ["payload.lg_code"]);
  // 型別對不上任務
  assertEquals(pathsOf(withLg({}, [], undefined, ST)), ["task_id"]);
  assertEquals(pathsOf(withStat({}, [], undefined, LG)), ["task_id"]);
  assertEquals(pathsOf(withStat({}, [], undefined, "auto:election_discovery:2027-01-31:232033:head")), ["task_id"]);
  // 任務格式不對
  assert(pathsOf(withLg({}, [], undefined, "auto:local_government_missing:abc")).includes("task_id"));
  // no_change／task_suggestion／correction 不管這條（查無可以對任何任務交）
  const nc = structuredClone(noChange);
  nc.payload.task_id = ST;
  assert(validateContributionRequest({ ...base, ...nc }).ok);
  assert(validateContributionRequest({ ...base, ...structuredClone(correction), task_id: ST }).ok);
});

Deno.test("六種型別：去重鍵與鍵順序無關；一次 20 筆含新型別", () => {
  const a = canonicalPayload({ contribution_type: "regional_stat", payload: { lg_code: "232033", stat_key: "population", year: 2020 }, source_urls: [] });
  const b = canonicalPayload({ contribution_type: "regional_stat", payload: { year: 2020, stat_key: "population", lg_code: "232033" }, source_urls: [] });
  assertEquals(a, b);
  const batch = Array.from({ length: 20 }, (_, i) => ({ ...structuredClone(regionalStat), payload: { ...structuredClone(regionalStat.payload), year: 2000 + i } }));
  const ok = validateContributionRequest({ ...base, contributions: batch });
  assert(ok.ok, JSON.stringify(ok.errors));
  assertEquals(ok.items.length, 20);
});
