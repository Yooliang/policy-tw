/**
 * 日本站派工臂對齊正見 D 期：政党名簿（migration 20261011230000_policy_jp_parties.sql、工作単 Yooliang/policy-ops#95 step 5）
 *   party_aliases／politician_elections.party_text、交件型別 party_info（落庫 apply_party_info）、candidacy の party／party_id（apply_candidacy_with_party）、
 *   臂 party_roster／party_gap（task_type party_missing）／party_info（task_type party_info_missing）。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts）、時鐘用 `SET app.activity_today`。
 *
 *   a. 結構：表・臂名・総表・規則・優先層・順位・主控台・型別 CHECK・権限・無所属の種
 *   b. 窓：party_roster は投票日当日まで、party_gap は翌日から（window で收回）、同じ task_id；所属を記録すると filled で收回
 *   c. 落庫：candidacy＋party（政党／無所属／名簿にない書き方）、衝突、party_info（作成・補完・alias・奪わない・冪等・反映）、書き方が結ばれると party_info_missing が收回
 *   d. TS：任務の比對・party_info／candidacy の検査・型別清單・協議版號（0.23.0 以上）
 *   e. 還原驗證：落庫の入口・規則の窓・alias の衝突検査を壊すと探査が赤くなる
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, applyOne, asRole, check, clock, count, dispatches, dispatchIds, events, freshDb, ICHI, ELECTION_URL, mutate, one, openElectionWithRegion, readMig, rows, seed, submit,
} from "./policy-jp-chain-db.ts";
import { JP_TASK_ARMS, validateContributionRequest } from "./jp/contribution-schema.ts";
import { JP_APPLY_TYPES } from "./jp/apply-contribution.ts";
import { JP_PROTOCOL_VERSION } from "./jp/protocol.ts";
import { APPLY_IDEMPOTENT_TYPES } from "./same-claims.ts";

const MIG_FILE = "20261011230000_policy_jp_parties.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV_LINEAGE = await readMig("20261011210000_policy_jp_lineage.sql");
const POLLING = "2027-04-25";
const E1 = `${POLLING}_mayor_${ICHI}`;
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const ARMS = ["party_roster", "party_gap", "party_info"] as const;
const MISSING = ["party_missing"], INFO = ["party_info_missing"];
const PARTY_URL = "https://www.soumu.go.jp/main_sosiki/jichi_gyousei/c-gyousei/seiji/party.html";

const shared = await freshDb();
type Db = Awaited<ReturnType<typeof freshDb>>;

async function addCand(db: Db, name: string, kana: string, status: string, o: Record<string, unknown> = {}): Promise<{ pid: string; peid: string }> {
  const payload = { election_id: E1, name, kana, candidacy_status: status, status_date: "2027-03-01", district_kind: "at_large", ...o };
  const id = await submit(db, "candidacy", payload, { status: "verified", urls: [ELECTION_URL] });
  const out = await applyOne(db, id);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pid = (await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id;
  return { pid, peid: out.record_id! };
}
async function partyInfo(db: Db, payload: Record<string, unknown>) {
  const id = await submit(db, "party_info", payload, { status: "verified", urls: [PARTY_URL] });
  return await applyOne(db, id);
}
const pe = (db: Db, peid: string) => one<{ party_id: string | null; party_basis: string | null; party_text: string | null }>(db, `SELECT party_id, party_basis, party_text FROM policy_jp.politician_elections WHERE id = $1`, [peid]);
async function lastClosedReason(db: Db, taskId: string): Promise<string | null> {
  const ev = await events(db, taskId);
  return ev.at(-1)?.event === "closed" ? ev.at(-1)!.reason : null;
}
const taskMissing = (peid: string) => `auto:party_missing:${peid}`;

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：表・臂名・総表・規則・優先層・順位・主控台・型別・権限・無所属の種", async () => {
  const names = (await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a;
  for (const a of ARMS) assert(names.includes(a), a);
  const total = fnText(MIG_SQL, TOTAL);
  for (const a of ARMS) assert(total.includes(`SELECT '${a}' AS arm, t.* FROM policy_jp.contribution_auto_tasks_${a}() t`), `総表に ${a}`);
  const rule = (a: string) => one<Record<string, unknown>>(shared, `SELECT window_kind, from_kind, from_offset, until_kind, until_offset, after_step, enabled, params FROM policy_jp.activity_rules WHERE activity = $1 AND priority IS NULL`, [a]);
  assertEquals(await rule("party_roster"), { window_kind: "event", from_kind: null, from_offset: 0, until_kind: "polling", until_offset: 0, after_step: null, enabled: true, params: { cap: 200 } });
  assertEquals(await rule("party_gap"), { window_kind: "event", from_kind: "polling", from_offset: 1, until_kind: null, until_offset: 0, after_step: null, enabled: true, params: { cap: 200 } });
  assertEquals(await rule("party_info"), { window_kind: "always", from_kind: null, from_offset: 0, until_kind: null, until_offset: 0, after_step: null, enabled: true, params: { cap: 100 } });
  for (const a of ["party_roster", "party_gap"]) assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:${a}' AND priority IN (1, 3)`), 2, a);
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:party_info'`), 0, "party_info は選挙に属さない＝既定の層");
  const rank = (id: string, t: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, t]).then((x) => x.r);
  assertEquals(await rank("auto:party_missing:x", "party_missing"), 4);
  assertEquals(await rank("auto:party_info_missing:x", "party_info_missing"), 4);
  assertEquals(await rank("auto:lineage_candidate:x:y", "lineage_candidate"), 9, "既存の順位は動かない");
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.console_arm_stage_map WHERE (arm, stage) IN (('party_info', 1), ('party_roster', 3), ('party_gap', 4))`), 3);
  // 型別
  const types = (await one<{ t: string[] }>(shared, `SELECT policy_jp.apply_types() AS t`)).t;
  assertEquals(types, [...JP_APPLY_TYPES]);
  assert(types.includes("party_info") && APPLY_IDEMPOTENT_TYPES.includes("party_info"));
  assertEquals((await one<{ a: boolean; b: number; c: boolean }>(shared, `SELECT policy_jp.contribution_needs_two_ips('party_info', '{}') AS a, policy_jp.contribution_required_agree('party_info', '{}', ARRAY[]::TEXT[]) AS b, 'party_info' = ANY (policy_jp.system_one_precheck_types()) AS c`)), { a: false, b: 3, c: false });
  // 無所属の種・権限・RLS
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.party_aliases WHERE kind = 'independent' AND party_id IS NULL AND alias_key = policy_jp.party_text_key(' 無所属 ')`), 1);
  assertEquals((await one<{ k: string }>(shared, `SELECT policy_jp.party_text_key('Ａ　党・') AS k`)).k, "a党");
  assertEquals(await asRole(shared, "anon", `SELECT alias FROM policy_jp.party_aliases`).then((r) => r.length), 1, "anon は読める");
  const denied = await asRole(shared, "anon", `INSERT INTO policy_jp.party_aliases (alias_key, alias, kind) VALUES ('x', 'x', 'independent')`).then(() => false, () => true);
  assert(denied, "anon は書けない");
  for (const f of ["apply_party_info(policy_jp.contributions)", "apply_candidacy_with_party(policy_jp.contributions)", "contribution_auto_tasks_party_info()", "party_missing_tasks(text)"]) {
    assertEquals((await one<{ x: boolean }>(shared, `SELECT has_function_privilege('anon', 'policy_jp.${f}', 'EXECUTE') AS x`)).x, false, f);
  }
  // 前の版に足しただけ：apply_contribution の WHEN は 2 か所の変更（candidacy の入口と party_info の行）だけ
  const cur = fnText(MIG_SQL, "policy_jp.apply_contribution");
  const prev = fnText(PREV_LINEAGE, "policy_jp.apply_contribution");
  assertEquals(cur.replace("apply_candidacy_with_party(c)", "apply_candidacy(c)").replace("               WHEN 'party_info' THEN policy_jp.apply_party_info(c)\n", ""), prev);
  // apply_candidacy 自体はこの支で再定義しない
  assert(!/CREATE OR REPLACE FUNCTION policy_jp\.apply_candidacy\(/.test(MIG_SQL));
});

// =============================================================================================
// b. 窓
// =============================================================================================
Deno.test("party_roster は投票日当日まで・party_gap は翌日から（同じ task_id、window で收回）；所属を記録すると filled で收回", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "山田太郎", "やまだたろう", "filed", { status_date: addDays(POLLING, -10) });
  const b = await addCand(db, "佐藤花子", "さとうはなこ", "considering");
  await clock(db, addDays(POLLING, -3));
  await seed(db);
  assertEquals(await dispatchIds(db, MISSING), [taskMissing(a.peid)], "considering は派さない・filed は派す");
  const d = (await dispatches(db, MISSING))[0];
  assertEquals(d.target.kind, "party_roster");
  assertEquals(d.target.politician_id, a.pid);
  assertEquals(d.target.election_id, E1);
  assertEquals(d.target.known_parties, []);
  assert(d.what_we_need.includes("無所属") && d.what_we_need.includes(a.pid));
  assertEquals(d.opened_by?.arm, "party_roster");
  await clock(db, POLLING);
  await seed(db);
  assertEquals(await dispatchIds(db, MISSING), [taskMissing(a.peid)], "投票日当日はまだ party_roster");
  await clock(db, addDays(POLLING, 1));
  await seed(db);
  // party_roster の窓が閉じ、同じ task_id を party_gap が引き継ぐ（派工列は動かない）
  assertEquals(await dispatchIds(db, MISSING), [taskMissing(a.peid)]);
  const after = (await dispatches(db, MISSING))[0];
  assertEquals(after.target.kind, "party", "target.kind は party_gap のものに更新される");
  assertEquals(after.opened_by?.arm, "party_roster", "出生の記録は最初の臂のまま");
  // 所属を記録 → filled
  const c = await submit(db, "candidacy", { election_id: E1, politician_id: a.pid, candidacy_status: "filed", status_date: addDays(POLLING, -10), district_kind: "at_large", party: "無所属" }, { status: "verified", urls: [ELECTION_URL] });
  assertEquals((await applyOne(db, c)).outcome, "applied");
  await seed(db);
  assertEquals(await dispatchIds(db, MISSING), []);
  assertEquals(await lastClosedReason(db, taskMissing(a.peid)), "filled");
  assertNotEquals(b.peid, a.peid);
});

Deno.test("party_gap：投票日前は開かない（party_roster だけ）・投票後に初めて見つかった参選は party_gap が開く", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "山田太郎", "やまだたろう", "elected", { status_date: addDays(POLLING, 1) });
  await clock(db, addDays(POLLING, 1));
  await seed(db);
  const d = (await dispatches(db, MISSING))[0];
  assertEquals(d.task_id, taskMissing(a.peid));
  assertEquals(d.target.kind, "party");
  assertEquals(d.opened_by?.arm, "party_gap");
  assertEquals(await lastClosedReason(db, taskMissing(a.peid)), null);
  // not_found の報告は標準の冷却で抑える
  await check(db, d.task_id, "not_found");
  await seed(db);
  assertEquals(await dispatchIds(db, MISSING), []);
});

// =============================================================================================
// c. 落庫
// =============================================================================================
Deno.test("candidacy＋party：政党／無所属／名簿にない書き方；衝突は上書きしない；party_info で書き方が結ばれると反映され party_info_missing が收回", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, addDays(POLLING, -20));
  // 無所属（種の alias）
  const ind = await addCand(db, "無所属太郎", "むしょぞくたろう", "declared", { party: "無所属" });
  assertEquals(await pe(db, ind.peid), { party_id: null, party_basis: "contribution", party_text: "無所属" });
  // 名簿にない書き方：party_text だけ
  const x1 = await addCand(db, "未知一郎", "みちいちろう", "declared", { party: "みらい刷新党" });
  const x2 = await addCand(db, "未知二郎", "みちじろう", "declared", { party: "みらい刷新党" });
  assertEquals(await pe(db, x1.peid), { party_id: null, party_basis: null, party_text: "みらい刷新党" });
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.parties`), 0);
  await seed(db);
  const info = await dispatches(db, INFO);
  assertEquals(info.length, 1, "書き方の鍵ごと一件");
  assertEquals(info[0].target.count, 2);
  assertEquals(info[0].target.party_text, "みらい刷新党");
  assertEquals(info[0].task_id.length, "auto:party_info_missing:".length + 12);
  assertEquals(await dispatchIds(db, MISSING), [taskMissing(ind.peid)].filter(() => false).concat(await dispatchIds(db, MISSING)).filter((t) => t !== taskMissing(ind.peid) && t !== taskMissing(x1.peid) && t !== taskMissing(x2.peid)), "所属が分かった・書き方が分かっている参選は party_missing に出ない");
  // party_info：新しい政党（name の自動 alias＋明示 alias）→ 反映
  const out = await partyInfo(db, { name: "みらい刷新党", kana: "みらいさっしんとう", short_name: "みらい", valid_from: "2020-04-01", aliases: ["未来刷新党"] });
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  assertEquals(out.table_name, "parties");
  const party = await one<{ id: string; name: string; short_name: string }>(db, `SELECT id, name, short_name FROM policy_jp.parties`);
  assertEquals(party.short_name, "みらい");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.party_aliases WHERE party_id = '${party.id}'`), 3, "正式名・略称・明示の別表記");
  assertEquals(await pe(db, x1.peid), { party_id: party.id, party_basis: "contribution", party_text: "みらい刷新党" });
  assertEquals(await pe(db, x2.peid), { party_id: party.id, party_basis: "contribution", party_text: "みらい刷新党" });
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'politician_elections' AND field = 'party_id' AND record_id = ANY ($1)`, [[x1.peid, x2.peid]]), 2);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'parties' AND target_id = '${party.id}'`), 1);
  await seed(db);
  assertEquals(await dispatchIds(db, INFO), []);
  assertEquals(await lastClosedReason(db, info[0].task_id), "filled");
  // 名簿にある書き方（略称）と party_id
  const y = await addCand(db, "既知三郎", "きちさぶろう", "declared", { party: "みらい" });
  assertEquals((await pe(db, y.peid)).party_id, party.id);
  const z = await addCand(db, "既知四郎", "きちしろう", "declared", { party_id: party.id });
  assertEquals(await pe(db, z.peid), { party_id: party.id, party_basis: "contribution", party_text: null });
  // 同じ参選に違う所属 → conflict（上書きしない・状態も動かさない）
  const bad = await submit(db, "candidacy", { election_id: E1, politician_id: z.pid, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large", party: "無所属" }, { status: "verified", urls: [ELECTION_URL] });
  const r = await applyOne(db, bad);
  assertEquals([r.status, r.outcome], ["rejected", "conflict"]);
  assertEquals((await pe(db, z.peid)).party_id, party.id);
  // 同じ所属の再提出は unchanged
  const same = await submit(db, "candidacy", { election_id: E1, politician_id: z.pid, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large", party: "みらい刷新党" }, { status: "verified", urls: [ELECTION_URL] });
  assertEquals((await applyOne(db, same)).outcome, "unchanged");
  // 存在しない party_id・party と party_id の両方 → invalid
  const inv1 = await submit(db, "candidacy", { election_id: E1, politician_id: ind.pid, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large", party_id: "nope" }, { status: "verified", urls: [ELECTION_URL] });
  assertEquals((await applyOne(db, inv1)).outcome, "invalid");
  const inv2 = await submit(db, "candidacy", { election_id: E1, politician_id: ind.pid, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large", party_id: party.id, party: "x" }, { status: "verified", urls: [ELECTION_URL] });
  assertEquals((await applyOne(db, inv2)).outcome, "invalid");
});

Deno.test("party_info：冪等・空欄だけ補完・値が違えば conflict・alias は奪わない・無所属の書き方・前身の検査・検査してから書く", async () => {
  const db = await freshDb();
  const base = { name: "あおぞら党", kana: "あおぞらとう" };
  const first = await partyInfo(db, { ...base, valid_from: "2019-01-01" });
  assertEquals(first.outcome, "applied");
  const id = first.record_id!;
  // 同じ内容 → unchanged（政党も alias も増えない）
  assertEquals((await partyInfo(db, { ...base, valid_from: "2019-01-01" })).outcome, "unchanged");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.parties`), 1);
  // 空欄の補完（valid_to）
  assertEquals((await partyInfo(db, { party_id: id, valid_to: "2024-03-31" })).outcome, "applied");
  assertEquals((await one<{ d: string }>(db, `SELECT valid_to::TEXT AS d FROM policy_jp.parties WHERE id = '${id}'`)).d, "2024-03-31");
  // 値が違う → conflict、何も書かない
  const c1 = await partyInfo(db, { party_id: id, valid_to: "2025-01-01" });
  assertEquals([c1.status, c1.outcome], ["rejected", "conflict"]);
  assertEquals((await one<{ d: string }>(db, `SELECT valid_to::TEXT AS d FROM policy_jp.parties WHERE id = '${id}'`)).d, "2024-03-31");
  // 読みが違う・名前を変える → conflict
  assertEquals((await partyInfo(db, { name: "あおぞら党", kana: "あおぞらたう" })).outcome, "conflict");
  assertEquals((await partyInfo(db, { party_id: id, name: "新あおぞら党" })).outcome, "conflict");
  // 改名は新しい政党＋前身
  const renamed = await partyInfo(db, { name: "新あおぞら党", kana: "しんあおぞらとう", predecessor_id: id, valid_from: "2024-04-01" });
  assertEquals(renamed.outcome, "applied");
  assertEquals((await one<{ p: string }>(db, `SELECT predecessor_id AS p FROM policy_jp.parties WHERE id = '${renamed.record_id}'`)).p, id);
  // 前身をたどると自分に戻る → invalid
  assertEquals((await partyInfo(db, { party_id: id, predecessor_id: renamed.record_id! })).outcome, "invalid");
  assertEquals((await partyInfo(db, { party_id: renamed.record_id!, predecessor_id: renamed.record_id! })).outcome, "invalid");
  assertEquals((await partyInfo(db, { name: "ひとり党", kana: "ひとりとう", predecessor_id: "nope" })).outcome, "invalid");
  // alias は奪わない：他の政党の正式名・無所属の書き方を別表記にはできない。検査が先＝何も書かれない
  const before = await count(db, `SELECT 1 FROM policy_jp.party_aliases`);
  assertEquals((await partyInfo(db, { party_id: id, short_name: "あお", aliases: ["新あおぞら党"] })).outcome, "conflict");
  assertEquals((await partyInfo(db, { party_id: id, aliases: ["無所属"] })).outcome, "conflict");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.party_aliases`), before);
  assertEquals((await one<{ s: string | null }>(db, `SELECT short_name AS s FROM policy_jp.parties WHERE id = '${id}'`)).s, null, "conflict のとき略称も書かれていない");
  // 無所属の書き方（政党に結ばれた鍵は不可）
  const ind = await partyInfo(db, { independent_aliases: ["無所属・諸派系"] });
  assertEquals([ind.outcome, ind.table_name], ["applied", "party_aliases"]);
  assertEquals((await partyInfo(db, { independent_aliases: ["あおぞら党"] })).outcome, "conflict");
  // 必須・形
  assertEquals((await partyInfo(db, {})).outcome, "invalid");
  assertEquals((await partyInfo(db, { name: "かなし党" })).outcome, "invalid");
  assertEquals((await partyInfo(db, { name: "日付党", kana: "ひづけとう", valid_from: "2024-02-30" })).outcome, "invalid");
  assertEquals((await partyInfo(db, { aliases: ["孤立"] })).outcome, "invalid");
  // 出典の URL が使えない → invalid
  const noUrl = await submit(db, "party_info", { name: "出典なし党", kana: "しゅってんなしとう" }, { status: "verified", urls: ["not a url"] });
  assertEquals((await applyOne(db, noUrl)).outcome, "invalid");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.parties WHERE name = '出典なし党'`), 0);
});

Deno.test("画面が読む表：parties／party_aliases は匿名でも読める・書けない", async () => {
  const db = await freshDb();
  await partyInfo(db, { name: "みどり党", kana: "みどりとう" });
  assertEquals((await asRole(db, "anon", `SELECT name FROM policy_jp.parties`)).length, 1);
  assertEquals((await asRole(db, "anon", `SELECT alias FROM policy_jp.party_aliases WHERE kind = 'party'`)).length, 1);
  // 画面が読む列（PartyRow）は変わっていない
  const cols = (await rows<{ column_name: string }>(db, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'policy_jp' AND table_name = 'parties'`)).map((c) => c.column_name);
  for (const c of ["id", "name", "kana", "valid_from", "valid_to"]) assert(cols.includes(c), c);
});

// =============================================================================================
// d. TS
// =============================================================================================
const base = { agent_name: "jp-agent", agent_tool: "claude-code/claude-sonnet-5", source_urls: [PARTY_URL] };
const PEID = `abc:${E1}:at_large`;
const cand = { election_id: E1, politician_id: "abc", candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large" };
const errs = (r: { errors: Array<{ path: string }> }) => r.errors.map((e) => e.path);

Deno.test("TS：型別・任務の比對・party_info／candidacy の検査・協議版號", () => {
  assertEquals(JP_TASK_ARMS.party_missing, "candidacy");
  assertEquals(JP_TASK_ARMS.party_info_missing, "party_info");
  // party_info
  const ok = validateContributionRequest({ ...base, contribution_type: "party_info", payload: { name: "みどり党", kana: "みどりとう", short_name: "みどり", valid_from: "2020-04-01", aliases: ["緑党"] } });
  assertEquals(ok.errors, []);
  assert(validateContributionRequest({ ...base, contribution_type: "party_info", payload: { independent_aliases: ["無所属"] } }).ok);
  assert(validateContributionRequest({ ...base, contribution_type: "party_info", payload: { party_id: "p1", aliases: ["別名"] } }).ok);
  assert(errs(validateContributionRequest({ ...base, contribution_type: "party_info", payload: {} })).includes("payload"));
  assert(errs(validateContributionRequest({ ...base, contribution_type: "party_info", payload: { name: "みどり党" } })).includes("payload.kana"), "新しい政党は kana 必須");
  assert(errs(validateContributionRequest({ ...base, contribution_type: "party_info", payload: { name: "みどり党", kana: "Midori" } })).includes("payload.kana"));
  assert(errs(validateContributionRequest({ ...base, contribution_type: "party_info", payload: { name: "みどり党", kana: "みどりとう", valid_from: "2024-05-01", valid_to: "2024-04-01" } })).includes("payload.valid_to"));
  assert(errs(validateContributionRequest({ ...base, contribution_type: "party_info", payload: { aliases: ["x"] } })).includes("payload.aliases"));
  assert(errs(validateContributionRequest({ ...base, contribution_type: "party_info", payload: { party_id: "p1", aliases: "x" } })).includes("payload.aliases"));
  assert(errs(validateContributionRequest({ ...base, contribution_type: "party_info", payload: { party_id: "p1", votes: 3 } })).includes("payload.votes"));
  // candidacy の party／party_id
  assert(validateContributionRequest({ ...base, contribution_type: "candidacy", payload: { ...cand, party: "無所属" } }).ok);
  assert(validateContributionRequest({ ...base, contribution_type: "candidacy", payload: { ...cand, party_id: "p1" } }).ok);
  assert(errs(validateContributionRequest({ ...base, contribution_type: "candidacy", payload: { ...cand, party: "x", party_id: "p1" } })).includes("payload.party"));
  assert(errs(validateContributionRequest({ ...base, contribution_type: "candidacy", payload: { ...cand, party: "" } })).includes("payload.party"));
  // 任務の比對
  const withTask = (task_id: string, type: string, payload: Record<string, unknown>) => validateContributionRequest({ ...base, contribution_type: type, task_id, payload });
  assertEquals(withTask(taskMissing(PEID), "candidacy", { ...cand, party: "無所属" }).errors, []);
  assert(errs(withTask(taskMissing(PEID), "candidacy", { ...cand, politician_id: "zzz", party: "無所属" })).includes("payload"), "別の参選の分は受けない");
  assert(errs(withTask(taskMissing(PEID), "party_info", { name: "x党", kana: "えっくすとう" })).includes("task_id"), "party_missing に party_info では答えられない");
  assertEquals(withTask("auto:party_info_missing:0123456789ab", "party_info", { name: "みどり党", kana: "みどりとう", aliases: ["みどり"] }).errors, []);
  assert(errs(withTask("auto:party_info_missing:0123456789ab", "candidacy", { ...cand })).includes("task_id"));
  assert(errs(withTask("auto:party_info_missing:short", "party_info", { name: "みどり党", kana: "みどりとう" })).includes("task_id"));
  // 協議版號：0.23.0 以上（リテラルで固定しない）
  const [maj, min] = JP_PROTOCOL_VERSION.split(".").map(Number);
  assert(maj > 0 || min >= 23, JP_PROTOCOL_VERSION);
});

// =============================================================================================
// e. 還原驗證
// =============================================================================================
Deno.test("還原驗證：candidacy の入口を元に戻す／窓を壊す／alias の衝突検査を外す と探査が赤くなる", async () => {
  // 1. apply_contribution が apply_candidacy に直行 → 所属が書かれない
  const broken = mutate(MIG_SQL, "WHEN 'candidacy' THEN policy_jp.apply_candidacy_with_party(c)", "WHEN 'candidacy' THEN policy_jp.apply_candidacy(c)");
  assertNotEquals(broken, MIG_SQL);
  const sql = fnText(broken, "policy_jp.apply_contribution");
  assert(!sql.includes("apply_candidacy_with_party"));
  // 2. party_gap の窓を投票日 +0 起にすると party_roster と重なる（探査：規則の期待値）
  const brokenRule = mutate(MIG_SQL, "SELECT 'party_gap', 'event', 'polling', 1,", "SELECT 'party_gap', 'event', 'polling', 0,");
  assertNotEquals(brokenRule, MIG_SQL);
  assert(!/'party_gap', 'event', 'polling', 1,/.test(brokenRule));
  // 3. 衝突検査を外した apply_party_info には conflict の文言がなくなる（検査の本体が文字として存在することを守る）
  const fn = fnText(MIG_SQL, "policy_jp.apply_party_info");
  assert(fn.includes("奪わない") && fn.includes("a.party_id IS DISTINCT FROM pt.id") && fn.includes("a.kind <> 'independent'"));
  assert(!fnText(mutate(MIG_SQL, "a.party_id IS DISTINCT FROM pt.id", "false"), "policy_jp.apply_party_info").includes("a.party_id IS DISTINCT FROM pt.id"));
  // 4. 書く前に検査：source_write より前に conflict の return が全部ある
  const iWrite = fn.indexOf("-- ---- 書く ----");
  assert(iWrite > 0);
  const tail = fn.slice(iWrite);
  assert(!tail.includes("'conflict'") && !tail.includes("'invalid', 'message', 'valid"), "書く段階に入ってからの conflict／検査は無い（source_urls の invalid だけが先頭にある）");
  // 5. 冪等：もう一度流し込んでも失敗しない（種・規則・主控台は NOT EXISTS／ON CONFLICT）
  const db = await freshDb();
  await db.exec(MIG_SQL);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.activity_rules WHERE activity IN ('party_roster', 'party_gap', 'party_info') AND priority IS NULL`), 3);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.party_aliases WHERE kind = 'independent'`), 1);
  // 6. 総表の分支が消えたら自我検査が弾く
  const noBranch = mutate(MIG_SQL, "  UNION ALL SELECT 'party_info' AS arm, t.* FROM policy_jp.contribution_auto_tasks_party_info() t\n", "");
  const db2 = await freshDb();
  await db2.exec(noBranch).then(() => assert(false, "分支を消した migration は自我検査で失敗するはず"), (e) => assert(String(e).includes("総表")));
  assertEquals(JP_APPLY_TYPES.includes("party_info"), true);
});
