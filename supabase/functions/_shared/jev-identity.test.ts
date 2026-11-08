import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildMergeIdentityAsk, buildNewPersonAsk, gatherNewPersonCandidates, incomingOf, loadPersonFacts, mergeSystemVote, nameLikePatterns, newPersonRecords,
  newPersonVerdict, sameUnit, similarName, type IdentityDb, type IncomingPerson, type NewPersonCandidate, type PersonFacts,
} from "./jev-identity.ts";
import { askJev, validateRecord, QUESTIONS } from "./system-one.ts";
import { SYSTEM_VOTE_ELIGIBLE_TYPES } from "./consensus.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const P1 = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";

const fakeFetch = (answers: Record<string, unknown>) => (async () =>
  new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1000, output_tokens: 10 } }))) as unknown as typeof fetch;
const KEY = { provider: "typesafe" as const, key: "k" };

const zhang = (id: string, dist: string, no: number): PersonFacts => ({
  id, name: "張榮華", birth_year: null, party: "無黨籍", region: "宜蘭縣", current_position: null,
  elections: [{ election_id: 2026, election_type: "縣市議員", region: "宜蘭縣", district: dist, village: null, cand_no: no, status: "filed" }],
  roster: [{ election_type: "縣市議員", county: "宜蘭縣", town: "", district: dist, village_code: "", cand_no: no, party: "無黨籍", birth: null }],
});

Deno.test("合併核對：state 帶兩人的全部事實（參選紀錄的選區與號次、名冊列），選項在 criteria，不帶宣稱", () => {
  const { state, questions } = buildMergeIdentityAsk(zhang("a", "三星鄉第02選舉區", 2), zhang("b", "羅東鎮第03選舉區", 5));
  const a = state.a as PersonFacts;
  assertEquals(a.elections[0].district, "三星鄉第02選舉區");
  assertEquals(a.elections[0].cand_no, 2);
  assertEquals(a.roster.length, 1);
  assertEquals(Object.keys(questions), ["same_person"]);
  assertEquals(Object.keys(questions.same_person.criteria).sort(), ["diff", "same", "unclear"]);
  // 2026-11-07 兩個誤併案的硬規則要寫進題目
  assert(questions.same_person.instructions.includes("選區") && questions.same_person.instructions.includes("號次"));
  assertEquals("claim" in state, false, "不把代理的宣稱放進 state（錨定）");
});

Deno.test("合併系統票只擋不放：宣稱同一人而 Jev 說 diff → not_supported；Jev 同意或 unclear → cannot_tell（沒有 supported）", () => {
  assertEquals(mergeSystemVote("diff", 0.97, true), { choice: "not_supported", probability: 0.97 });
  assertEquals(mergeSystemVote("same", 0.99, true).choice, "cannot_tell");
  assertEquals(mergeSystemVote("unclear", 0.9, true).choice, "cannot_tell");
  // 宣稱「不是同一人」（配對決議）而 Jev 說 same → 一樣是擋
  assertEquals(mergeSystemVote("same", 0.96, false).choice, "not_supported");
  assertEquals(mergeSystemVote("diff", 0.99, false).choice, "cannot_tell");
});

Deno.test("合併核對端到端（Jev 以 stub 回 diff 0.97）：askJev → 系統票 not_supported，紀錄過 validateRecord", async () => {
  const { state, questions } = buildMergeIdentityAsk(zhang("a", "三星鄉第02選舉區", 2), zhang("b", "羅東鎮第03選舉區", 5));
  const res = await askJev(KEY, state, questions, fakeFetch({ same_person: { type: "choice", choice: "diff", probabilities: { diff: 0.97, same: 0.02, unclear: 0.01 } } }));
  const ans = res.answers.same_person;
  const vote = mergeSystemVote(ans.choice, ans.probabilities[ans.choice], true);
  assertEquals(vote.choice, "not_supported");
  assertEquals(validateRecord({
    subject_type: "contribution", subject_id: C1, question: "source_support", choice: vote.choice, probability: vote.probability,
    confidence: null, probabilities: null, model: res.model, state: { claim: {}, pair: state }, cost_usd: 0,
  }), null);
});

Deno.test("loadPersonFacts：讀基本資料、參選紀錄（含選區村里號次）、名冊對應列", async () => {
  const f = createFakeSupabase({
    politicians: [{ id: P1, name: "張榮華", party: "無黨籍", region: "宜蘭縣", birth_year: null, current_position: null }],
    politician_elections: [{ politician_id: P1, election_id: 2026, election_type: "縣市議員", cand_no: 2, candidacy_status: "filed", regions: { region: "宜蘭縣", sub_region: "三星鄉第02選舉區", village: null } }],
    cec_roster_2026: [{ name: "張榮華", county: "宜蘭縣", election_type: "縣市議員", town: "", district: "三星鄉第02選舉區", li_code: "", cand_no: 2, party: "無黨籍", birth: null }],
  });
  const facts = await loadPersonFacts(f.client, P1);
  assertEquals(facts?.elections[0], { election_id: 2026, election_type: "縣市議員", region: "宜蘭縣", district: "三星鄉第02選舉區", village: null, cand_no: 2, status: "filed" });
  assertEquals(facts?.roster.length, 1);
  assertEquals(await loadPersonFacts(f.client, "nope"), null);
});

const inc = (o: Partial<IncomingPerson> = {}): IncomingPerson => ({
  name: "陳麗娟", election_id: 2026, election_type: "縣市議員", region: "宜蘭縣", sub_region: null, electoral_district: "冬山鄉第04選舉區", village: null,
  party: null, birth_year: null, cand_no: null, current_position: null, ...o,
});
const cand = (o: Partial<NewPersonCandidate>): NewPersonCandidate => ({
  key: "p_aaaaaaaa", kind: "politician", id: "aaaaaaaa-0000-4000-8000-000000000000", politician_id: "aaaaaaaa-0000-4000-8000-000000000000", name: "陳麗娟", party: null, birth_year: null,
  election_id: 2026, election_type: "縣市議員", region: "宜蘭縣", district: "冬山鄉第04選舉區", village: null, cand_no: null, status: null, ...o,
});

Deno.test("incomingOf：只有 candidacy／politician、沒指 politician_id、不是補資料任務、有姓名才算會建新人物", () => {
  const p = { name: "陳麗娟", election_id: 2026, election_type: "縣市議員", region: "宜蘭縣", electoral_district: "冬山鄉第04選舉區" };
  assertEquals(incomingOf({ contribution_type: "candidacy", payload: p })?.name, "陳麗娟");
  assertEquals(incomingOf({ contribution_type: "candidacy", payload: { ...p, politician_id: P1 } }), null);
  assertEquals(incomingOf({ contribution_type: "candidacy", payload: { ...p, resolved_politician_id: "new" } }), null);
  assertEquals(incomingOf({ contribution_type: "politician", payload: p, task_id: `auto:profile_gap:${P1}` }), null);
  assertEquals(incomingOf({ contribution_type: "policy", payload: p }), null);
  assertEquals(incomingOf({ contribution_type: "candidacy", payload: { election_id: 2026 } }), null);
});

Deno.test("similarName／sameUnit：同名、差一字（三字以上）算近名；兩邊都有寫的單位欄位才比", () => {
  assert(similarName("陳麗娟", "陳麗娟"));
  assert(similarName("陳麗娟", "陳麗涓"));
  assert(!similarName("陳麗", "陳麗"+"X") );
  assert(!similarName("陳麗娟", "王國華"));
  assert(similarName("卡伊．馬賴", "卡伊‧馬賴"));
  assert(sameUnit(inc(), { region: "宜蘭縣", district: "冬山鄉第04選舉區", village: null }));
  assert(!sameUnit(inc(), { region: "宜蘭縣", district: "羅東鎮第03選舉區", village: null }), "不同選舉區不是同單位");
  assert(!sameUnit(inc(), { region: "屏東縣", district: "冬山鄉第04選舉區", village: null }));
  assert(sameUnit(inc(), { region: "宜蘭縣", district: null, village: null }), "對方沒寫選區＝未知，放行交給 Jev 看事實");
  assert(sameUnit(inc({ electoral_district: "第04選舉區", sub_region: "冬山鄉" }), { region: "臺宜蘭縣".slice(1), district: "冬山鄉第04選舉區", village: null }));
});

Deno.test("gatherNewPersonCandidates：同名同單位的既有人物與等票交件進候選，自己、不同選舉區、不同屆、不同名的都濾掉", async () => {
  const db: IdentityDb = {
    personElections: async () => [
      cand({}),
      cand({ key: "p_bbbbbbbb", id: "bbbbbbbb-0000-4000-8000-000000000000", district: "羅東鎮第03選舉區" }),
      cand({ key: "p_cccccccc", id: "cccccccc-0000-4000-8000-000000000000", election_id: 2022 }),
      cand({ key: "p_dddddddd", id: "dddddddd-0000-4000-8000-000000000000", name: "王國華" }),
    ],
    pendingSubmissions: async () => [
      cand({ key: "s_22222222", kind: "submission", id: C2, politician_id: null, submission_status: "pending" }),
      cand({ key: "s_11111111", kind: "submission", id: C1, politician_id: null }),   // 自己
    ],
  };
  const got = await gatherNewPersonCandidates(db, inc(), C1);
  assertEquals(got.map((c) => c.key), ["p_aaaaaaaa", "s_22222222"]);
});

Deno.test("新人物題：事實在 state、候選編號與 none／unclear 在 criteria；沒候選就不會被呼叫（呼叫端先過濾）", () => {
  const { state, questions } = buildNewPersonAsk(inc(), [cand({}), cand({ key: "s_22222222", kind: "submission", id: C2, politician_id: null })]);
  assertEquals(Object.keys((state.candidates as object)).sort(), ["p_aaaaaaaa", "s_22222222"]);
  assertEquals((state.incoming as IncomingPerson).name, "陳麗娟");
  assertEquals(Object.keys(questions.new_person.criteria).sort(), ["none", "p_aaaaaaaa", "s_22222222", "unclear"]);
  assert(QUESTIONS.includes("new_person" as never));
});

const answer = (choice: string, p: number) => ({ type: "choice", choice, probabilities: { [choice]: p, other: 1 - p } });

Deno.test("判定：指到既有人物 ≥0.95 → 擋（source_support/not_supported，state.identity_hold 有理由與建議的人物 id）", async () => {
  const cands = [cand({})];
  const { state, questions } = buildNewPersonAsk(inc(), cands);
  const res = await askJev(KEY, state, questions, fakeFetch({ new_person: answer("p_aaaaaaaa", 0.98) }));
  const out = newPersonRecords({ contributionId: C1, model: res.model, state, answer: res.answers.new_person, candidates: cands, costUsd: res.usage.cost });
  assertEquals(out.verdict.kind, "existing");
  assertEquals(out.audit.length, 1);
  assertEquals(out.audit[0].question, "new_person");
  assertEquals(out.holds.length, 1);
  assertEquals(out.holds[0].question, "source_support");
  assertEquals(out.holds[0].choice, "not_supported");
  assertEquals(out.holds[0].probability, 0.98);
  const hold = (out.holds[0].state as { identity_hold: { suggested_politician_id: string; reason: string } }).identity_hold;
  assertEquals(hold.suggested_politician_id, cands[0].id);
  assert(hold.reason.includes("陳麗娟"));
  for (const r of [...out.audit, ...out.holds]) assertEquals(validateRecord(r), null);
});

Deno.test("判定：指到等票中的另一筆交件 ≥0.95 → 兩邊都擋；0.95 以下、none、unclear 都不擋", () => {
  const cands = [cand({ key: "s_22222222", kind: "submission", id: C2, politician_id: null })];
  const { state } = buildNewPersonAsk(inc(), cands);
  const model = "typesafe/jev-1.13.0";
  const dup = newPersonRecords({ contributionId: C1, model, state, answer: answer("s_22222222", 0.96), candidates: cands, costUsd: 0 });
  assertEquals(dup.verdict.kind, "submission");
  assertEquals(dup.holds.map((h) => h.subject_id), [C1, C2]);
  const low = newPersonRecords({ contributionId: C1, model, state, answer: answer("s_22222222", 0.9), candidates: cands, costUsd: 0 });
  assertEquals(low.holds.length, 0);
  assertEquals(low.audit[0].choice, "s_22222222", "低信心仍留審計列");
  assertEquals(newPersonVerdict(answer("none", 0.99), cands).hold, false);
  assertEquals(newPersonVerdict(answer("unclear", 0.99), cands).hold, false);
  assertEquals(newPersonVerdict(undefined, cands).kind, "unclear");
});

Deno.test("nameLikePatterns：差一字的 like 樣式；有逗號括號的名字不拼（免得弄壞 or 語法）", () => {
  assertEquals(nameLikePatterns("陳麗娟"), ["陳麗娟", "_麗娟", "陳_娟", "陳麗_"]);
  assertEquals(nameLikePatterns("王華"), ["王華"]);
  assertEquals(nameLikePatterns("a,b"), []);
});

Deno.test("接線：migration 擴 CHECK／合格型別／候選函式／排程；TS 合格型別含 merge_politician；precheck 與 identity_check 都走同一組函式", async () => {
  const mig = await Deno.readTextFile(new URL("../../migrations/20261108010000_jev_identity_checks.sql", import.meta.url));
  assert(mig.includes("'new_person'") && mig.includes("'merge_politician'"));
  assert(mig.includes("system-one?action=identity_check"));
  assert((SYSTEM_VOTE_ELIGIBLE_TYPES as readonly string[]).includes("merge_politician"));
  const idx = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  assert(idx.includes("newPersonAskFor(supabase, c)"), "precheck 同一次呼叫合併新人物題");
  assert(idx.includes('action === "identity_check"'));
  assert(idx.includes("mergeSystemVote(choice, probability, claimsSame)"), "合併只擋不放");
  assert(idx.includes("loadPersonFacts"), "合併核對用完整事實");
  // 合併不得再寫 supported
  assert(!/mapped = choice === "unclear"/.test(idx));
});
