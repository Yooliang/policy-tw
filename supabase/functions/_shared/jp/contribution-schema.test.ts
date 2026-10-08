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
  payload: { lg_code: "131130", election_type: "mayor", election_reason: "regular", election_date: "2027-01-24", notice_date: "2027-01-17", name: "渋谷区長選挙" },
  source_urls: ["https://www.city.shibuya.tokyo.jp/senkyo/"],
};
const withElection = (patch: Record<string, unknown>, drop: string[] = []) => {
  const e = structuredClone(election);
  Object.assign(e.payload, patch);
  for (const k of drop) delete (e.payload as Record<string, unknown>)[k];
  return validateContributionRequest({ ...base, ...e });
};
const pathsOf = (v: ReturnType<typeof validateContributionRequest>) => v.errors.map((e) => e.path);

Deno.test("四種型別各一筆都過", () => {
  assertEquals([...JP_CONTRIBUTION_TYPES], ["no_change", "task_suggestion", "correction", "election"]);
  for (const it of [noChange, correction, suggestion, election]) {
    const v = validateContributionRequest({ ...base, ...structuredClone(it) });
    assertEquals(v.errors, [], JSON.stringify(v.errors));
    assert(v.ok);
  }
});

Deno.test("election：最小可過的 payload（notice_date、name 可省）；頂層 task_id 照收", () => {
  const v = withElection({}, ["notice_date", "name"]);
  assertEquals(v.errors, [], JSON.stringify(v.errors));
  const withTask = validateContributionRequest({ ...base, ...structuredClone(election), task_id: "auto:election_discovery:2027-01-31:232033:head" });
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
