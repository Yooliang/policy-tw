/**
 * 日本站選舉鏈第 2～4 步的交件型別驗證（candidacy・politician・policy）：欄位規則、400 的案例、任務比對、得票數欄位。
 * 純函式測試（不碰資料庫）。SQL 那一半（落庫、DB CHECK）在 policy-jp-chain-*.test.ts。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { JP_CONTRIBUTION_TYPES, JP_TASK_ARMS, JP_VOTE_FIELDS, jpTrim, validateContributionRequest } from "./contribution-schema.ts";

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
  // kana は告示前は選填（告示日以降は必須だが、それは庫を見る入口 contribute-handler と SQL 落庫が守る：policy-ops#60）
  assert(candidacy({}, ["kana"]).ok, "schema の段階では kana なしも通る");
  assertEquals(paths(candidacy({}, ["election_id"])), ["payload.election_id"]);
  assertEquals(paths(candidacy({}, ["candidacy_status"])), ["payload.candidacy_status"]);
  assertEquals(paths(candidacy({}, ["status_date"])), ["payload.status_date"]);
  assertEquals(paths(candidacy({}, ["district_kind"])), ["payload.district_kind"]);
  // politician_id がなければ name が要る（kana は告示前なら省略できる）
  assertEquals(paths(candidacy({}, ["name", "kana"])), ["payload.name"]);
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
  // kana は空欄を埋める用に受け付ける（ひらがなだけ）。名前は今も直せない
  assertEquals(paths(politician({ kana: "ベツ" })), ["payload.kana"]);
  assertEquals(paths(politician({ kana: "" })), ["payload.kana"]);
  assert(politician({ kana: "べつ" }).ok);
  assert(politician({ kana: "べつ" }, ["birth_year", "education", "career"]).ok, "kana だけでも事実が一つある");
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

Deno.test("policy：字數は前後の空白（全角空白も）を落としてコードポイントで数える；proposed_date が投票日（参選 id の選挙 id の頭）より後なら TS でも 400", () => {
  assertEquals(paths(policy({ title: "　　短い　　" })), ["payload.title"], "空白を除くと 2 字");
  assert(policy({ title: "　四文字題名　" }).ok);
  assertEquals(paths(policy({ description: "　" + "あ".repeat(9) + "　" })), ["payload.description"]);
  assert(policy({ description: "　" + "あ".repeat(10) + "　" }).ok);
  assertEquals(paths(policy({ category: "　" })), ["payload.category"]);
  assertEquals(jpTrim("　 \t題名\n　"), "題名");
  const past = "5f0c8d6e-1111-4222-8333-444444444444:2025-01-12_mayor_232033:at_large";
  assert(policy({ politician_election_id: past, proposed_date: "2025-01-01" }).ok);
  assert(policy({ politician_election_id: past, proposed_date: "2025-01-12" }).ok, "投票日当日は通る");
  const late = policy({ politician_election_id: past, proposed_date: "2025-02-01" });
  assertEquals(paths(late), ["payload.proposed_date"]);
  assert(late.errors[0].message.includes("2025-01-12"));
});

// =============================================================================================
// A 期（policy-ops#95）：候補者の状態を確かめる三つの任務型別（candidate_status_stale／not_running_recheck／candidacy_source_missing）
// =============================================================================================
const PE1 = `${PID}:${E1}:at_large`;
const stateCand = (patch: Record<string, unknown> = {}, task?: string, drop: string[] = []) => {
  const payload: Record<string, unknown> = { politician_id: PID, election_id: E1, candidacy_status: "filed", status_date: "2027-04-08", district_kind: "at_large", ...patch };
  for (const k of drop) delete payload[k];
  return validateContributionRequest({ ...base, contribution_type: "candidacy", payload, source_urls: OFFICIAL, ...(task ? { task_id: task } : {}) });
};

Deno.test("A 期の任務比對：三つの任務型別は candidacy を受ける（JP_TASK_ARMS）。参選 id（人物 id:選挙 id:district_kind）が payload の三つ組と一致しなければ 400", () => {
  assertEquals(JP_TASK_ARMS.candidate_status_stale, "candidacy");
  assertEquals(JP_TASK_ARMS.not_running_recheck, "candidacy");
  assertEquals(JP_TASK_ARMS.candidacy_source_missing, "candidacy");
  for (const task of [`auto:candidate_status_stale:${PE1}`, `auto:candidacy_source_missing:${PE1}`, `auto:not_running_recheck:filing:${PE1}`]) {
    const v = stateCand({}, task);
    assert(v.ok, `${task}: ${JSON.stringify(v.errors)}`);
    assertEquals(v.items[0].task_id, task);
  }
  // 別の人・別の選挙・別の district_kind を、この任務のものとして出す
  for (const patch of [{ politician_id: "someone-else" }, { election_id: "2027-04-25_mayor_231011" }, { district_kind: "proportional", district_name: "ブロック" }]) {
    const v = stateCand(patch, `auto:candidate_status_stale:${PE1}`);
    assertEquals(paths(v), ["payload"], JSON.stringify(patch));
    assert(v.errors[0].message.includes("一致"));
  }
  // politician_id がない（name＋kana の新しい人）は、この任務の参選とは言えない
  const noPid = validateContributionRequest({ ...base, contribution_type: "candidacy", task_id: `auto:candidacy_source_missing:${PE1}`,
    payload: { name: "山田太郎", kana: "やまだたろう", election_id: E1, candidacy_status: "filed", status_date: "2027-04-08", district_kind: "at_large" }, source_urls: OFFICIAL });
  assertEquals(paths(noPid), ["payload"]);
  // task_id の形が壊れている
  assertEquals(paths(stateCand({}, "auto:candidate_status_stale:not-a-pe-id")), ["task_id"]);
  assertEquals(paths(stateCand({}, `auto:not_running_recheck:filing:${E1}`)), ["task_id"]);
});

Deno.test("A 期の任務比對：not_running_recheck の『照合』（filing が付かない）は candidacy では答えられない（no_change／task_suggestion）；filing 付きは candidacy。他の型別の提出は 400", () => {
  const nr = stateCand({ candidacy_status: "withdrawn", withdrawn_after_filing: false, status_date: "2027-03-20" }, `auto:not_running_recheck:${PE1}`);
  assertEquals(paths(nr), ["task_id"]);
  assert(nr.errors[0].message.includes("no_change"));
  // no_change／task_suggestion は比對を受けない
  const nc = validateContributionRequest({ ...base, contribution_type: "no_change", task_id: `auto:not_running_recheck:${PE1}`,
    payload: { task_id: `auto:not_running_recheck:${PE1}`, outcome: "confirmed", checked_urls: OFFICIAL, finding: "一覧に載っていないことを確認した" } });
  assert(nc.ok, JSON.stringify(nc.errors));
  const sug = validateContributionRequest({ ...base, contribution_type: "task_suggestion", task_id: `auto:not_running_recheck:${PE1}`,
    payload: { title: "届出済みの取りやめ記録の訂正提案", description: "選管の立候補者一覧に載っている（掲載ページ参照）。記録は取りやめだが実際は届出済み", target_politician_id: PID }, source_urls: OFFICIAL });
  assert(sug.ok, JSON.stringify(sug.errors));
  // filing 付き：withdrawn＋withdrawn_after_filing
  assert(stateCand({ candidacy_status: "withdrawn", withdrawn_after_filing: true, status_date: "2027-03-20" }, `auto:not_running_recheck:filing:${PE1}`).ok);
  // 型違い
  const pol = validateContributionRequest({ ...base, contribution_type: "politician", task_id: `auto:candidate_status_stale:${PE1}`, payload: { politician_id: PID, birth_year: 1970, resolved_claim: "new" }, source_urls: OFFICIAL });
  assertEquals(paths(pol), ["task_id"]);
  assert(pol.errors[0].message.includes("candidacy"));
});

Deno.test("claimKey（A 期）：withdrawn_after_filing の答えが違えば別の宣稱（true と false を同意票にしない）；書かない提出の鍵は従来どおり", async () => {
  const { claimKey } = await import("../duplicate-claim.ts");
  const wd = (o: Record<string, unknown> = {}) => claimKey("candidacy", { politician_id: "p-1", election_id: E1, candidacy_status: "withdrawn", ...o });
  assert(wd({ withdrawn_after_filing: true }) !== wd({ withdrawn_after_filing: false }), "届出後と届出前は別");
  assertEquals(wd({ withdrawn_after_filing: true }), wd({ withdrawn_after_filing: true, status_date: "2027-03-30", name: "別の書き方" }));
  assert(wd() !== wd({ withdrawn_after_filing: false }));
  assertEquals(wd(), "candidacy|politician_id:p-1|" + E1.toLowerCase() + "||withdrawn|", "書かない提出（と正見の payload）の鍵は変わらない");
});

// =============================================================================================
// #589 審查の後続（policy-tw 主線）
// =============================================================================================
Deno.test("candidacy_source_missing：official 等級の網址がない candidacy は 400（報道だけだと unchanged で落庫→次の seed でまた開く無限再派工）", () => {
  const task = `auto:candidacy_source_missing:${PE1}`;
  const submit = (source_urls: string[], task_id: string | null = task) => validateContributionRequest({ ...base, contribution_type: "candidacy", ...(task_id ? { task_id } : {}),
    payload: { politician_id: PID, election_id: E1, candidacy_status: "filed", status_date: "2027-04-08", district_kind: "at_large" }, source_urls });
  const news = submit(["https://www.asahi.com/articles/xxx.html"]);
  assertEquals(paths(news), ["source_urls"]);
  assert(news.errors[0].message.includes("no_change"));
  // 統計（e-stat）は official ではない：SQL candidacy_has_official_source は source_kind＝official だけを数える
  assertEquals(paths(submit(["https://www.e-stat.go.jp/x"])), ["source_urls"]);
  // official が一つでもあれば通る（報道との併記も可）
  for (const u of ["https://www.city.ichinomiya.aichi.jp/senkyo/", "https://www.pref.aichi.jp/senkyo/", "https://www.soumu.go.jp/senkyo/", "https://www.city.toyota.lg.jp/x"]) {
    const v = submit(["https://www.asahi.com/articles/xxx.html", u]);
    assert(v.ok, `${u}: ${JSON.stringify(v.errors)}`);
  }
  // ほかの任務・任務なしの candidacy には出典の等級を求めない（従来どおり）
  assert(submit(["https://www.asahi.com/articles/xxx.html"], `auto:candidate_status_stale:${PE1}`).ok);
  assert(submit(["https://www.asahi.com/articles/xxx.html"], null).ok);
});

Deno.test("claimKey：withdrawn_after_filing を null と明寫した提出と書かない提出は同じ宣稱（票が割れない）", async () => {
  const { claimKey } = await import("../duplicate-claim.ts");
  const wd = (o: Record<string, unknown> = {}) => claimKey("candidacy", { politician_id: "p-1", election_id: E1, candidacy_status: "withdrawn", ...o });
  assertEquals(wd({ withdrawn_after_filing: null }), wd());
  assert(wd({ withdrawn_after_filing: null }) !== wd({ withdrawn_after_filing: false }), "null と false は別");
  assert(wd({ withdrawn_after_filing: null }) !== wd({ withdrawn_after_filing: true }));
});

// =============================================================================================
// B 期（policy-ops#95）：開票結果の任務型別 election_result_missing（当落＝参選 id／記録にない当選者＝elected:<選挙 id>）
// =============================================================================================
Deno.test("B 期の任務比對：当落（auto:election_result_missing:<参選 id>）は、その参選の elected／not_elected／withdrawn だけ。別の参選・filed は 400", () => {
  assertEquals(JP_TASK_ARMS.election_result_missing, "candidacy");
  const task = `auto:election_result_missing:${PE1}`;
  for (const st of ["elected", "not_elected"]) {
    const v = stateCand({ candidacy_status: st, status_date: "2027-04-25" }, task);
    assert(v.ok, `${st}: ${JSON.stringify(v.errors)}`);
  }
  assert(stateCand({ candidacy_status: "withdrawn", withdrawn_after_filing: true, status_date: "2027-04-20" }, task).ok);
  assertEquals(paths(stateCand({ candidacy_status: "filed" }, task)), ["payload.candidacy_status"], "当落の任務で filed は出せない");
  assertEquals(paths(stateCand({ candidacy_status: "elected", status_date: "2027-04-25", politician_id: "someone-else" }, task)), ["payload"]);
  assertEquals(paths(stateCand({ candidacy_status: "elected", status_date: "2027-04-25" }, "auto:election_result_missing:not-a-pe-id")), ["task_id"]);
});

Deno.test("B 期の任務比對：記録にない当選者（auto:election_result_missing:elected:<選挙 id>）は、その選挙の elected だけ（新しい人も可）。別の選挙・落選は 400；no_change は比對を受けない", () => {
  const task = `auto:election_result_missing:elected:${E1}`;
  const newPerson = (patch: Record<string, unknown> = {}) => validateContributionRequest({ ...base, contribution_type: "candidacy", task_id: task,
    payload: { name: "高橋次郎", kana: "たかはしじろう", election_id: E1, candidacy_status: "elected", status_date: "2027-04-25", district_kind: "at_large", ...patch }, source_urls: OFFICIAL });
  assert(newPerson().ok, JSON.stringify(newPerson().errors));
  assert(stateCand({ candidacy_status: "elected", status_date: "2027-04-25" }, task).ok, "既にいる人を politician_id で指してもよい");
  assertEquals(paths(newPerson({ candidacy_status: "not_elected" })), ["payload.candidacy_status"]);
  assertEquals(paths(newPerson({ election_id: "2027-04-25_mayor_231011" })), ["payload.election_id"]);
  assertEquals(paths(validateContributionRequest({ ...base, contribution_type: "candidacy", task_id: "auto:election_result_missing:elected:bad",
    payload: { name: "高橋次郎", kana: "たかはしじろう", election_id: E1, candidacy_status: "elected", status_date: "2027-04-25", district_kind: "at_large" }, source_urls: OFFICIAL })), ["task_id"]);
  const nc = validateContributionRequest({ ...base, contribution_type: "no_change", task_id: task,
    payload: { task_id: task, outcome: "confirmed", checked_urls: OFFICIAL, finding: "開票結果の当選者は全員記録にあることを確認した" } });
  assert(nc.ok, JSON.stringify(nc.errors));
});

// ---- 政見三要素（policy_elements、policy-ops#95、規則は預設關）：欄位規則は正見の policy_elements と同じ、日本站の口吻 ----
const PEPID = "5f0c8d6e-aaaa-4222-8333-444444444444";
const elOk = (element: string, o: Record<string, unknown> = {}) => ({ element, stated: true, text: "原文の事実", source_locator: "選挙公報 3 頁", ...o });
function pel(elements: unknown, patch: Record<string, unknown> = {}, drop: string[] = [], top: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = { policy_id: PEPID, elements, resolved_claim: "new", ...patch };
  for (const k of drop) delete payload[k];
  return validateContributionRequest({ ...base, contribution_type: "policy_elements", payload, source_urls: ["https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf"], ...top });
}
const pelPaths = (v: ReturnType<typeof pel>) => v.errors.map((e) => e.path);

Deno.test("policy_elements：最小の交件が通る／policy_id・elements・resolved_claim は必須／要素は 1～3 個で重複不可", () => {
  assert(pel([elOk("target")]).ok);
  assert(pel([elOk("target"), elOk("deadline"), { element: "funding", stated: false, source_locator: "公報 3 頁を通読" }]).ok);
  assertEquals(pelPaths(pel([elOk("target")], {}, ["policy_id"])), ["payload.policy_id"]);
  assertEquals(pelPaths(pel([elOk("target")], { policy_id: "has space" })), ["payload.policy_id"]);
  assertEquals(pelPaths(pel([elOk("target")], {}, ["resolved_claim"])), ["payload.resolved_claim"]);
  assertEquals(pelPaths(pel([])), ["payload.elements"]);
  assertEquals(pelPaths(pel("x")), ["payload.elements"]);
  assertEquals(pelPaths(pel([elOk("target"), elOk("deadline"), elOk("funding"), elOk("target")])), ["payload.elements"]);
  assertEquals(pelPaths(pel([elOk("target"), elOk("target")])), ["payload.elements[1].element"]);
  assertEquals(pelPaths(pel([elOk("budget")])), ["payload.elements[0].element"]);
  assertEquals(pelPaths(pel(["x"])), ["payload.elements[0]"]);
  assertEquals(pelPaths(pel([elOk("target")], {}, [], { source_urls: [] })), ["source_urls"]);
});

Deno.test("policy_elements：stated と text（stated=true は text 必須で 120 字まで、stated=false は text を付けない＝未説明を text に書かない）、source_locator 必須", () => {
  assertEquals(pelPaths(pel([{ element: "target", source_locator: "x" }])), ["payload.elements[0].stated"]);
  assertEquals(pelPaths(pel([elOk("target", { text: undefined })])), ["payload.elements[0].text"]);
  assertEquals(pelPaths(pel([elOk("target", { text: "　　" })])), ["payload.elements[0].text"]);
  assert(pel([elOk("target", { text: "𠮷".repeat(120) })]).ok, "120 コードポイントまで");
  assertEquals(pelPaths(pel([elOk("target", { text: "あ".repeat(121) })])), ["payload.elements[0].text"]);
  assertEquals(pelPaths(pel([elOk("funding", { stated: false, text: "未説明" })])), ["payload.elements[0].text"]);
  assert(pel([elOk("funding", { stated: false, text: undefined })]).ok);
  assertEquals(pelPaths(pel([elOk("target", { source_locator: undefined })])), ["payload.elements[0].source_locator"]);
  assertEquals(pelPaths(pel([elOk("target", { source_locator: "あ".repeat(201) })])), ["payload.elements[0].source_locator"]);
  assertEquals(pelPaths(pel([elOk("target", { text: 5 })])), ["payload.elements[0].text"]);
  assert(pel([elOk("target", { source_url: "https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf" })]).ok);
  assertEquals(pelPaths(pel([elOk("target", { source_url: "ftp://x" })])), ["payload.elements[0].source_url"]);
});

Deno.test("policy_elements：deadline_date は deadline かつ stated=true のときだけ、実在する 1990～2100 年の日付（会計年度は 4/1～3/31＝『2028 年度まで』は 2029-03-31）", () => {
  assert(pel([elOk("deadline", { text: "2028 年度まで", deadline_date: "2029-03-31" })]).ok);
  assert(pel([elOk("deadline", { deadline_date: "" })]).ok, "空文字は付けないのと同じ");
  assertEquals(pelPaths(pel([elOk("target", { deadline_date: "2029-03-31" })])), ["payload.elements[0].deadline_date"]);
  assertEquals(pelPaths(pel([elOk("funding", { deadline_date: "2029-03-31" })])), ["payload.elements[0].deadline_date"]);
  assertEquals(pelPaths(pel([{ element: "deadline", stated: false, source_locator: "x", deadline_date: "2029-03-31" }])), ["payload.elements[0].deadline_date"]);
  for (const bad of ["2029-02-30", "2029/03/31", "令和11年3月31日", "1989-12-31", "2101-01-01"]) {
    const v = pel([elOk("deadline", { deadline_date: bad })]);
    assertEquals(pelPaths(v), ["payload.elements[0].deadline_date"], bad);
    assert(v.errors[0].message.includes("2029-03-31"), "会計年度の説明が出る");
  }
});

Deno.test("policy_elements：任務比對（policy_elements_missing）— policy_id が task_id の政見と一致、他の型別で答えると 400；JP_TASK_ARMS の登録", () => {
  assertEquals(JP_TASK_ARMS.policy_elements_missing, "policy_elements");
  assertEquals(pelPaths(pel([elOk("target")], {}, [], { task_id: `auto:policy_elements_missing:${PEPID}` })), []);
  const other = pel([elOk("target")], { policy_id: "other-policy" }, [], { task_id: `auto:policy_elements_missing:${PEPID}` });
  assertEquals(pelPaths(other), ["payload.policy_id"]);
  const wrongType = validateContributionRequest({
    ...base, contribution_type: "policy",
    payload: { politician_election_id: "pe-1", title: "保育所の待機児童をなくす", description: "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。", category: "子育て", source_locator: "公報 2 頁", resolved_claim: "new" },
    source_urls: ["https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf"], task_id: `auto:policy_elements_missing:${PEPID}`,
  });
  assertEquals(wrongType.errors.map((e) => e.path), ["task_id"]);
  assert(wrongType.errors[0].message.includes("policy_elements"));
  // 他の任務の task_id では policy_elements を受けない
  const wrongArm = pel([elOk("target")], {}, [], { task_id: `auto:policy_missing:pe-1` });
  assertEquals(pelPaths(wrongArm), ["task_id"]);
  assert(JP_CONTRIBUTION_TYPES.includes("policy_elements"));
});

// ---- 議員定数（district_seats、policy-ops#95）：欄位規則は SQL district_seats_normalize と同じ ----
const DSEID = "2027-04-25_muni_assembly_232033";
const dsOk = (o: Record<string, unknown> = {}) => ({ district_kind: "district", district_name: "千種区", seats: 5, ...o });
function dst(districts: unknown, patch: Record<string, unknown> = {}, drop: string[] = [], top: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = { election_id: DSEID, seats_total: 8, seats_basis: "law", districts, resolved_claim: "new", ...patch };
  for (const k of drop) delete payload[k];
  return validateContributionRequest({ ...base, contribution_type: "district_seats", payload, source_urls: ["https://www.city.ichinomiya.aichi.jp/reiki/teisuu.html"], ...top });
}
const dstPaths = (v: ReturnType<typeof dst>) => v.errors.map((e) => e.path);

Deno.test("district_seats：最小の交件が通る（at_large 1 件／district 複数）／election_id・seats_total・seats_basis・districts・resolved_claim は必須", () => {
  assert(dst([{ district_kind: "at_large", seats: 8 }]).ok);
  assert(dst([dsOk(), dsOk({ district_name: "東区", seats: 3, district_lg_code: "231011" })]).ok);
  assertEquals(dstPaths(dst([dsOk({ seats: 8 })], {}, ["election_id"])), ["payload.election_id"]);
  assertEquals(dstPaths(dst([dsOk({ seats: 8 })], {}, ["seats_total"])), ["payload.seats_total"]);
  assertEquals(dstPaths(dst([dsOk({ seats: 8 })], { seats_basis: "decree" })), ["payload.seats_basis"]);
  assertEquals(dstPaths(dst([dsOk({ seats: 8 })], {}, ["seats_basis"])), ["payload.seats_basis"]);
  assertEquals(dstPaths(dst([dsOk({ seats: 8 })], {}, ["resolved_claim"])), ["payload.resolved_claim"]);
  assertEquals(dstPaths(dst([])), ["payload.districts"]);
  assertEquals(dstPaths(dst("x")), ["payload.districts"]);
  assertEquals(dstPaths(dst(Array.from({ length: 101 }, (_, i) => dsOk({ district_name: `第${i}`, seats: 1 })), { seats_total: 101 })), ["payload.districts"]);
});

Deno.test("district_seats：定数の範囲（1～200 の整数）／種類の混在・at_large 複数・重複・合計不一致は不可", () => {
  for (const bad of [0, -1, 201, 1.5, "8"]) assertEquals(dstPaths(dst([dsOk({ seats: 8 })], { seats_total: bad })), ["payload.seats_total"], String(bad));
  assertEquals(dstPaths(dst([dsOk({ seats: 0 }), dsOk({ district_name: "東区", seats: 8 })])), ["payload.districts[0].seats"]);
  assertEquals(dstPaths(dst([{ district_kind: "at_large", seats: 3 }, dsOk({ seats: 5 })])), ["payload.districts"], "混在");
  assertEquals(dstPaths(dst([{ district_kind: "at_large", seats: 4 }, { district_kind: "at_large", seats: 4 }])), ["payload.districts[1].district_name", "payload.districts"], "at_large は 1 件だけ（重複としても報告される）");
  assertEquals(dstPaths(dst([dsOk({ seats: 4 }), dsOk({ seats: 4 })])), ["payload.districts[1].district_name"], "重複");
  assertEquals(dstPaths(dst([dsOk({ seats: 5 }), dsOk({ district_name: "東区", seats: 4 })])), ["payload.seats_total"], "合計 9 ≠ 8");
});

Deno.test("district_seats：district_name（district は必須、at_large は付けない）／district_lg_code（district のときだけ・6 桁・検査コード）", () => {
  assertEquals(dstPaths(dst([dsOk({ district_name: undefined, seats: 8 })])), ["payload.districts[0].district_name"]);
  assertEquals(dstPaths(dst([{ district_kind: "at_large", district_name: "全域", seats: 8 }])), ["payload.districts[0].district_name"]);
  assertEquals(dstPaths(dst([dsOk({ district_kind: "ward", seats: 8 })])), ["payload.districts[0].district_kind"]);
  assertEquals(dstPaths(dst([{ district_kind: "at_large", district_lg_code: "232033", seats: 8 }])), ["payload.districts[0].district_lg_code"]);
  assertEquals(dstPaths(dst([dsOk({ seats: 8, district_lg_code: "23" })])), ["payload.districts[0].district_lg_code"]);
  assertEquals(dstPaths(dst([dsOk({ seats: 8, district_lg_code: "231012" })])), ["payload.districts[0].district_lg_code"], "検査コードが違う");
  assert(dst([dsOk({ seats: 8, district_lg_code: "231011" })]).ok);
});

Deno.test("district_seats：任務比對（district_seats_missing）— election_id が task_id の選挙と一致、他の型別で答えると 400；JP_TASK_ARMS の登録", () => {
  assertEquals(JP_TASK_ARMS.district_seats_missing, "district_seats");
  const task = `auto:district_seats_missing:${DSEID}`;
  assertEquals(dstPaths(dst([{ district_kind: "at_large", seats: 8 }], {}, [], { task_id: task })), []);
  assertEquals(dstPaths(dst([{ district_kind: "at_large", seats: 8 }], { election_id: "2027-04-25_muni_assembly_231011" }, [], { task_id: task })), ["payload.election_id"]);
  assertEquals(dstPaths(dst([{ district_kind: "at_large", seats: 8 }], {}, [], { task_id: "auto:district_seats_missing:bad id" })), ["task_id"]);
  const wrongType = pel([elOk("target")], {}, [], { task_id: task });
  assertEquals(pelPaths(wrongType), ["task_id"]);
  assert(wrongType.errors[0].message.includes("district_seats"));
  assertEquals(dstPaths(dst([{ district_kind: "at_large", seats: 8 }], {}, [], { task_id: `auto:policy_elements_missing:${PEPID}` })), ["task_id"]);
});

// ---- 重複政見の軟移除（removal、policy-ops#95）：duplicate_policy の答え ----
const DUPPE = `taro:${DSEID}:at_large`;
const DUPFP = "0123456789abcdef0123456789abcdef";
function rmv(patch: Record<string, unknown> = {}, drop: string[] = [], top: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = {
    target_table: "policies", target_id: "pol-0001", keep_id: "pol-0002", reason: "pol-0002 と同じ約束の言い換え。具体的な pol-0002 を残す", ...patch,
  };
  for (const k of drop) delete payload[k];
  return validateContributionRequest({ ...base, contribution_type: "removal", payload, source_urls: ["https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf"], ...top });
}
const rmvPaths = (v: ReturnType<typeof rmv>) => v.errors.map((e) => e.path);

Deno.test("removal：最小の交件が通る（keep_id は任意）／target_table は policies だけ／target_id・reason は必須（reason ≥20 字）／keep_id は別の政見", () => {
  assert(rmv().ok);
  assert(rmv({}, ["keep_id"]).ok);
  assertEquals(rmvPaths(rmv({ target_table: "politicians" })), ["payload.target_table"]);
  assertEquals(rmvPaths(rmv({}, ["target_table"])), ["payload.target_table"]);
  assertEquals(rmvPaths(rmv({}, ["target_id"])), ["payload.target_id"]);
  assertEquals(rmvPaths(rmv({ target_id: "a b" })), ["payload.target_id"]);
  assertEquals(rmvPaths(rmv({}, ["reason"])), ["payload.reason"]);
  assertEquals(rmvPaths(rmv({ reason: "短すぎる理由です" })), ["payload.reason"]);
  assertEquals(rmvPaths(rmv({ keep_id: "pol-0001" })), ["payload.keep_id"]);
  assertEquals(rmvPaths(rmv({ keep_id: 5 })), ["payload.keep_id"]);
  // same_claim 登記表の型別ではないので resolved_claim は要らない（claimKey 併票）
  assert(!("resolved_claim" in rmv().items[0].payload));
});

Deno.test("removal：任務比對（duplicate_policy）— task_id の形（<参選紀錄 id>:<指紋 32 字>）、他の臂の task_id では 400；JP_TASK_ARMS の登録", () => {
  assertEquals(JP_TASK_ARMS.duplicate_policy, "removal");
  const task = `auto:duplicate_policy:${DUPPE}:${DUPFP}`;
  assertEquals(rmvPaths(rmv({}, [], { task_id: task })), []);
  assertEquals(rmv({}, [], { task_id: task }).items[0].task_id, task);
  assertEquals(rmvPaths(rmv({}, [], { task_id: `auto:duplicate_policy:${DUPPE}:abc` })), ["task_id"], "指紋が短い");
  assertEquals(rmvPaths(rmv({}, [], { task_id: `auto:duplicate_policy:${DUPPE}` })), ["task_id"], "指紋がない");
  assertEquals(rmvPaths(rmv({}, [], { task_id: `auto:duplicate_policy:bad:${DUPFP}` })), ["task_id"], "参選紀錄 id の形ではない");
  const wrong = rmv({}, [], { task_id: `auto:policy_missing:${DUPPE}` });
  assertEquals(rmvPaths(wrong), ["task_id"]);
  assert(wrong.errors[0].message.includes("policy_missing") && wrong.errors[0].message.includes("policy"));
  // duplicate_policy の task_id で別の型別（district_seats）を出すと 400（no_change は DATA_TYPES の外なので素通し＝重複なしの答え）
  const wrongType = dst([{ district_kind: "at_large", seats: 8 }], {}, [], { task_id: `auto:duplicate_policy:${DUPPE}:${DUPFP}` });
  assertEquals(dstPaths(wrongType), ["task_id"]);
  assert(wrongType.errors[0].message.includes("removal"));
  assert(JP_CONTRIBUTION_TYPES.includes("removal"));
});
