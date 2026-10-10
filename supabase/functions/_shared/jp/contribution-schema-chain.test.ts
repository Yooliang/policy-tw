/**
 * 日本站選舉鏈第 2～4 步的交件型別驗證（candidacy・politician・policy）：欄位規則、400 的案例、任務比對、得票數欄位。
 * 純函式測試（不碰資料庫）。SQL 那一半（落庫、DB CHECK）在 policy-jp-chain-*.test.ts。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { JP_CONTRIBUTION_TYPES, JP_TASK_ARMS, JP_VOTE_FIELDS, validateContributionRequest } from "./contribution-schema.ts";

const base = { agent_name: "jp-agent", agent_tool: "claude-code/claude-sonnet-5" };
const E1 = "2027-04-25_mayor_232033";
const OFFICIAL = ["https://www.city.ichinomiya.aichi.jp/senkyo/"];
const candidacy = (patch: Record<string, unknown> = {}, drop: string[] = [], top: Record<string, unknown> = {}) => {
  const payload: Record<string, unknown> = {
    name: "山田太郎", kana: "やまだたろう", election_id: E1, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large", ...patch,
  };
  for (const k of drop) delete payload[k];
  return validateContributionRequest({ ...base, contribution_type: "candidacy", payload, source_urls: OFFICIAL, ...top });
};
const paths = (v: ReturnType<typeof validateContributionRequest>) => v.errors.map((e) => e.path).sort();

Deno.test("candidacy：最小可過的 payload（新的人＝name＋kana）；已在庫的人＝politician_id（name／kana 可省）；頂層 task_id 照收", () => {
  const v = candidacy();
  assertEquals(v.errors, [], JSON.stringify(v.errors));
  assert(v.ok);
  assertEquals(v.items[0].contribution_type, "candidacy");
  const known = candidacy({ politician_id: "5f0c8d6e-1111-4222-8333-444444444444" }, ["name", "kana"]);
  assert(known.ok, JSON.stringify(known.errors));
  const withTask = candidacy({}, [], { task_id: `auto:roster_check:${E1}` });
  assert(withTask.ok, JSON.stringify(withTask.errors));
  assertEquals(withTask.items[0].task_id, `auto:roster_check:${E1}`);
  // 全部の任意欄位を付けても過る
  const full = candidacy({ birth_year: 1970, district_kind: "proportional", district_name: "東海ブロック", list_rank: 3 });
  assert(full.ok, JSON.stringify(full.errors));
  const dist = candidacy({ district_kind: "district", district_name: "北区", district_lg_code: "230006" });
  assert(dist.ok, JSON.stringify(dist.errors));
  const wd = candidacy({ candidacy_status: "withdrawn", withdrawn_after_filing: true });
  assert(wd.ok, JSON.stringify(wd.errors));
});

Deno.test("candidacy：必須欄位が欠けると 400（人物・選挙・状態・日付・選挙区）", () => {
  assertEquals(paths(candidacy({}, ["name"])), ["payload.name"]);
  assertEquals(paths(candidacy({}, ["kana"])), ["payload.kana"]);
  assertEquals(paths(candidacy({}, ["election_id"])), ["payload.election_id"]);
  assertEquals(paths(candidacy({}, ["candidacy_status"])), ["payload.candidacy_status"]);
  assertEquals(paths(candidacy({}, ["status_date"])), ["payload.status_date"]);
  assertEquals(paths(candidacy({}, ["district_kind"])), ["payload.district_kind"]);
  // politician_id がなければ name と kana の両方が要る
  assertEquals(paths(candidacy({}, ["name", "kana"])), ["payload.kana", "payload.name"]);
});

Deno.test("candidacy：欄位の形が違うと 400（election_id・状態・日付・kana・生年・politician_id）", () => {
  assertEquals(paths(candidacy({ election_id: "2027-04-25-mayor-232033" })), ["payload.election_id"]);
  assertEquals(paths(candidacy({ election_id: 12345 })), ["payload.election_id"]);
  assertEquals(paths(candidacy({ candidacy_status: "rumored" })), ["payload.candidacy_status"]);
  assertEquals(paths(candidacy({ candidacy_status: "likely" })), ["payload.candidacy_status"]);
  assertEquals(paths(candidacy({ status_date: "2027-13-01" })), ["payload.status_date"]);
  assertEquals(paths(candidacy({ status_date: "2027/03/01" })), ["payload.status_date"]);
  assertEquals(paths(candidacy({ status_date: "1900-01-01" })), ["payload.status_date"]);
  assertEquals(paths(candidacy({ kana: "ヤマダタロウ" })), ["payload.kana"]);
  assertEquals(paths(candidacy({ kana: "yamada" })), ["payload.kana"]);
  assertEquals(paths(candidacy({ birth_year: "1970" })), ["payload.birth_year"]);
  assertEquals(paths(candidacy({ birth_year: 1899 })), ["payload.birth_year"]);
  assertEquals(paths(candidacy({ birth_year: 2999 })), ["payload.birth_year"]);
  assertEquals(paths(candidacy({ politician_id: "" }, ["name", "kana"])), ["payload.politician_id"]);
  assertEquals(paths(candidacy({ name: "x".repeat(41) })), ["payload.name"]);
});

Deno.test("candidacy：選挙区の整合（at_large は district_name を付けない／それ以外は要る／list_rank は比例だけ／district_lg_code は小選挙区だけ・検査碼が合う／withdrawn_after_filing は withdrawn だけ）", () => {
  assertEquals(paths(candidacy({ district_kind: "at_large", district_name: "北区" })), ["payload.district_name"]);
  assertEquals(paths(candidacy({ district_kind: "district" })), ["payload.district_name"]);
  assertEquals(paths(candidacy({ district_kind: "proportional" })), ["payload.district_name"]);
  assertEquals(paths(candidacy({ district_kind: "all" })), ["payload.district_kind"]);
  assertEquals(paths(candidacy({ list_rank: 1 })), ["payload.list_rank"]);
  assertEquals(paths(candidacy({ district_kind: "proportional", district_name: "東海ブロック", list_rank: 0 })), ["payload.list_rank"]);
  assertEquals(paths(candidacy({ district_kind: "proportional", district_name: "東海ブロック", list_rank: 1.5 })), ["payload.list_rank"]);
  assertEquals(paths(candidacy({ district_lg_code: "230006" })), ["payload.district_lg_code"]);
  assertEquals(paths(candidacy({ district_kind: "district", district_name: "北区", district_lg_code: "230007" })), ["payload.district_lg_code"]);
  assertEquals(paths(candidacy({ withdrawn_after_filing: true })), ["payload.withdrawn_after_filing"]);
  assertEquals(paths(candidacy({ candidacy_status: "withdrawn", withdrawn_after_filing: "yes" })), ["payload.withdrawn_after_filing"]);
});

Deno.test("candidacy：得票數・得票率の欄位名が出たら 400（一つずつ、全部のキー）。値は見ない", () => {
  for (const k of JP_VOTE_FIELDS) {
    const v = candidacy({ [k]: 1234 });
    assertEquals(paths(v), [`payload.${k}`], k);
    assert(v.errors[0].message.includes("得票"), k);
    assert(!v.ok);
  }
  assertEquals(paths(candidacy({ votes: null })), ["payload.votes"], "値が null でも欄位名が出たら 400");
});

Deno.test("candidacy：出典は必須（source_urls なし＝400）、self-citation 以外の形式エラーは共通の規則", () => {
  const v = validateContributionRequest({ ...base, contribution_type: "candidacy", payload: { name: "山田太郎", kana: "やまだたろう", election_id: E1, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large" } });
  assertEquals(paths(v), ["source_urls"]);
  const arr = validateContributionRequest({ ...base, contribution_type: "candidacy", payload: {}, source_urls: [] });
  assert(paths(arr).includes("source_urls"));
});

Deno.test("任務比對：roster_check の task_id には candidacy だけ。election_id が任務の選挙と違えば 400、task_id の形が違えば 400。no_change／手動任務は比対しない", () => {
  assertEquals(JP_TASK_ARMS.roster_check, "candidacy");
  assertEquals(paths(candidacy({}, [], { task_id: `auto:roster_check:${E1}` })), []);
  // 別の選挙の candidacy を、この任務のものとして出す
  const other = candidacy({ election_id: "2027-04-25_mayor_231011" }, [], { task_id: `auto:roster_check:${E1}` });
  assertEquals(paths(other), ["payload.election_id"]);
  assert(other.errors[0].message.includes("一致"));
  // 任務の型と合わない提出
  const wrongType = validateContributionRequest({
    ...base, contribution_type: "election", task_id: `auto:roster_check:${E1}`,
    payload: { lg_code: "232033", election_type: "mayor", election_reason: "regular", election_date: "2027-04-25", resolved_claim: "new" }, source_urls: OFFICIAL,
  });
  assertEquals(paths(wrongType), ["task_id"]);
  assert(wrongType.errors[0].message.includes("candidacy"));
  // task_id の形が壊れている
  assertEquals(paths(candidacy({}, [], { task_id: "auto:roster_check:not-an-election-id" })), ["task_id"]);
  // no_change は任務型の比対を受けない（完成合図として出せる）
  const nc = validateContributionRequest({
    ...base, contribution_type: "no_change", task_id: `auto:roster_check:${E1}`,
    payload: { task_id: `auto:roster_check:${E1}`, outcome: "confirmed", checked_urls: OFFICIAL, finding: "名簿を確認し、全員が登録済みだった" },
  });
  assert(nc.ok, JSON.stringify(nc.errors));
  // 手動任務（uuid）は比対しない
  assertEquals(paths(candidacy({}, [], { task_id: "11111111-2222-4333-8444-555555555555" })), []);
});

Deno.test("型別の一覧：candidacy は claimKey 併票の型別で、同一件事の resolved_claim は要らない", () => {
  assert((JP_CONTRIBUTION_TYPES as readonly string[]).includes("candidacy"));
  // resolved_claim を付けても付けなくても過る（candidacy は same_claim 登記表に入っていない）
  assert(candidacy({ resolved_claim: "new" }).ok);
  assert(candidacy().ok);
});

Deno.test("claimKey（重複提交＝同意票）：日本站の candidacy は candidacy_status で区別、同じ人・同じ選挙・同じ状態だけが同一宣稱；正見の候補者鍵は変わらない", async () => {
  const { claimKey } = await import("../duplicate-claim.ts");
  const jp = (o: Record<string, unknown> = {}) => claimKey("candidacy", { politician_id: "p-1", election_id: E1, candidacy_status: "declared", ...o });
  assertEquals(jp(), jp({ name: "別の書き方", status_date: "2027-03-09" }), "名前・日付の違いは鍵に入らない");
  assert(jp() !== jp({ candidacy_status: "filed" }), "状態が違えば別の宣稱（declared と filed を同じにしない）");
  assert(jp() !== jp({ election_id: "2027-04-25_mayor_231011" }), "選挙が違えば別");
  assert(jp() !== null);
  // politician_id がない（新しい人）は鍵が取れない＝併票しない
  assertEquals(claimKey("candidacy", { name: "山田太郎", election_id: E1, candidacy_status: "declared" }), null);
  // 正見の payload（candidate_status）の鍵は従来どおり：`candidacy|politician_id:<id>|<選挙>|<種類>|<状態>|<結果>`
  assertEquals(claimKey("candidacy", { politician_id: "abc", election_id: 2026, election_type: "縣市長", candidate_status: "registered", election_result: "elected" }),
    "candidacy|politician_id:abc|2026|縣市長|registered|elected");
});

// ---------------------------------------------------------------------------------------------
// politician（選舉鏈第 3 步）
// ---------------------------------------------------------------------------------------------
const PID = "5f0c8d6e-1111-4222-8333-444444444444";
const politician = (patch: Record<string, unknown> = {}, drop: string[] = [], top: Record<string, unknown> = {}) => {
  const payload: Record<string, unknown> = { politician_id: PID, birth_year: 1970, education: ["○○大学法学部卒業"], career: ["○○市議会議員"], resolved_claim: "new", ...patch };
  for (const k of drop) delete payload[k];
  return validateContributionRequest({ ...base, contribution_type: "politician", payload, source_urls: ["https://www.city.ichinomiya.aichi.jp/gikai/"], ...top });
};

Deno.test("politician：最小可過（事実が 1 つ＋politician_id＋resolved_claim）；3 つの事実を全部付けても過る", () => {
  assert(politician({}, ["education", "career"]).ok);
  assert(politician({}, ["birth_year", "career"]).ok);
  assert(politician({}, ["birth_year", "education"]).ok);
  assert(politician().ok);
});

Deno.test("politician：400 のケース（politician_id・事実なし・生年・配列の形・name／kana・resolved_claim）", () => {
  assertEquals(paths(politician({}, ["politician_id"])), ["payload.politician_id"]);
  assertEquals(paths(politician({}, ["birth_year", "education", "career"])), ["payload.birth_year"], "事実が 1 つもない");
  assertEquals(paths(politician({ birth_year: 1899 })), ["payload.birth_year"]);
  assertEquals(paths(politician({ birth_year: "1970" })), ["payload.birth_year"]);
  assertEquals(paths(politician({ birth_year: 3000 })), ["payload.birth_year"]);
  assertEquals(paths(politician({ education: [] })), ["payload.education"]);
  assertEquals(paths(politician({ education: "○○大学" })), ["payload.education"]);
  assertEquals(paths(politician({ career: [""] })), ["payload.career"]);
  assertEquals(paths(politician({ career: ["x".repeat(201)] })), ["payload.career"]);
  assertEquals(paths(politician({ career: Array.from({ length: 31 }, (_, i) => `経歴${i}`) })), ["payload.career"]);
  assertEquals(paths(politician({ name: "別名" })), ["payload.name"]);
  assertEquals(paths(politician({ kana: "べつ" })), ["payload.kana"]);
  assertEquals(paths(politician({}, ["resolved_claim"])), ["payload.resolved_claim"]);
  assertEquals(paths(politician({ resolved_claim: "differs:abc" })), ["note"], "differs は note 必須");
  assert(politician({ resolved_claim: "differs:abc" }, [], { note: "出典の生年が違う（県のページは 1971 年）" }).ok);
});

Deno.test("politician：任務比對（profile_gap／profile_detail_gap／sources 版）の politician_id が違えば 400、型が違えば 400", () => {
  for (const tid of [`auto:profile_gap:${PID}`, `auto:profile_detail_gap:${PID}`, `auto:profile_detail_gap:sources:${PID}`]) {
    assertEquals(paths(politician({}, [], { task_id: tid })), [], tid);
    assertEquals(paths(politician({ politician_id: "other" }, [], { task_id: tid })), ["payload.politician_id"], tid);
  }
  assertEquals(JP_TASK_ARMS.profile_gap, "politician");
  assertEquals(JP_TASK_ARMS.profile_detail_gap, "politician");
  const wrong = candidacy({}, [], { task_id: `auto:profile_gap:${PID}` });
  assertEquals(paths(wrong), ["task_id"]);
  assert(wrong.errors[0].message.includes("politician"));
});

// ---------------------------------------------------------------------------------------------
// policy（選舉鏈第 4 步）
// ---------------------------------------------------------------------------------------------
const PEID = "5f0c8d6e-1111-4222-8333-444444444444:2027-04-25_mayor_232033:at_large";
const policy = (patch: Record<string, unknown> = {}, drop: string[] = [], top: Record<string, unknown> = {}) => {
  const payload: Record<string, unknown> = {
    politician_election_id: PEID, title: "保育所の待機児童をなくす", description: "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。",
    category: "子育て", source_locator: "選挙公報 2 頁「子育て」", resolved_claim: "new", ...patch,
  };
  for (const k of drop) delete payload[k];
  return validateContributionRequest({ ...base, contribution_type: "policy", payload, source_urls: ["https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf"], ...top });
};

Deno.test("policy：最小可過（必須 5 欄位＋resolved_claim）；proposed_date は任意", () => {
  assert(policy().ok, JSON.stringify(policy().errors));
  assert(policy({ proposed_date: "2026-09-01" }).ok);
  assert(policy({ description: "あ".repeat(120) }).ok, "120 字ちょうど");
  assert(policy({ description: "あ".repeat(10) }).ok, "10 字ちょうど");
});

Deno.test("policy：400 のケース（必須欄位・字數の境界・日付・origin／status・resolved_claim）", () => {
  assertEquals(paths(policy({}, ["politician_election_id"])), ["payload.politician_election_id"]);
  assertEquals(paths(policy({}, ["title"])), ["payload.title"]);
  assertEquals(paths(policy({ title: "短い" })), ["payload.title"]);
  assertEquals(paths(policy({ title: "あ".repeat(101) })), ["payload.title"]);
  assertEquals(paths(policy({}, ["description"])), ["payload.description"]);
  assertEquals(paths(policy({ description: "あ".repeat(9) })), ["payload.description"]);
  assertEquals(paths(policy({ description: "あ".repeat(121) })), ["payload.description"]);
  assertEquals(paths(policy({ description: 12345 })), ["payload.description"]);
  assertEquals(paths(policy({}, ["category"])), ["payload.category"]);
  assertEquals(paths(policy({ category: "あ".repeat(31) })), ["payload.category"]);
  assertEquals(paths(policy({}, ["source_locator"])), ["payload.source_locator"]);
  assertEquals(paths(policy({ proposed_date: "2027-13-01" })), ["payload.proposed_date"]);
  assertEquals(paths(policy({ proposed_date: "2999-01-01" })), ["payload.proposed_date"]);
  assertEquals(paths(policy({ origin: "budget" })), ["payload.origin"]);
  assertEquals(paths(policy({ status: "achieved" })), ["payload.status"]);
  assertEquals(paths(policy({}, ["resolved_claim"])), ["payload.resolved_claim"]);
  assertEquals(paths(policy({ resolved_claim: "differs:abc" })), ["note"]);
  assert(policy({ resolved_claim: "differs:abc" }, [], { note: "要約が違う（公報では 3 年ではなく 4 年）" }).ok);
});

Deno.test("policy：surrogate pair も 1 字と数える（SQL の char_length と同じ）；任務比對（policy_missing）", () => {
  assert(policy({ description: "𠮷".repeat(120) }).ok, "120 コードポイント");
  assertEquals(paths(policy({ description: "𠮷".repeat(121) })), ["payload.description"]);
  assertEquals(JP_TASK_ARMS.policy_missing, "policy");
  assertEquals(paths(policy({}, [], { task_id: `auto:policy_missing:${PEID}` })), []);
  const other = policy({ politician_election_id: "someone:else:at_large" }, [], { task_id: `auto:policy_missing:${PEID}` });
  assertEquals(paths(other), ["payload.politician_election_id"]);
  const wrong = politician({}, [], { task_id: `auto:policy_missing:${PEID}` });
  assertEquals(paths(wrong), ["task_id"]);
  assert(wrong.errors[0].message.includes("policy"));
});
