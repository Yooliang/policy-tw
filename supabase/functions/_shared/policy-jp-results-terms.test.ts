/**
 * 日本站派工臂對齊正見 B 期：開票結果（当落・記録にない当選者）と新任期（migration 20261011090000_policy_jp_results_terms.sql、工作單 Yooliang/policy-ops#95）
 *   election_results／elected_missing（正見 election_results・elected_missing の日本版）＋ politician_offices の同期（正見 sync_politician_office_from_election の日本版）
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts），時鐘用 `SET app.activity_today`，整條流程走 seed_auto_task_queue()＋task_dispatches／gap_events。
 *
 *   a. 結構：臂名・總表・規則三處一起加；規則＝投票日 +1 起／止なし／after_step（candidacy・results）／後備／cap；優先層；步驟順位；主控台段；鏈の步驟に results
 *   b. 当落：投票日まで開かない・翌日開く（via=done）・elected／not_elected が落庫すると filled
 *   c. 記録にない当選者：全員の当落が決まるまで開かない（鏈 gate）・決まると開く／決まらなくても 7 日後に後備で開く；一題多份（candidacy の落庫で收回しない）；
 *      confirmed で閉じる；定数を満たせば出ない
 *   d. 任期：就任日が来るまで建てない（pending=not_started）・就任日に建つ（満了日の翌日＋4 年、出典は当選の出典）・満了で閉じる・当選取消で消える；
 *      辞職後の選挙は投票日から、補欠は議会の満了日まで、満了日の記録がない定期は建てない（term_unknown）；首長の後任就任で前任が閉じる；期数
 *   e. 文字守門：総表・臂名・順位・鏈の視圖＝緊接在前一版に登記した行だけ；臂は読み取りだけ
 *   f. 還原驗證：自我檢查が壊れた migration を弾く；冪等；權限
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, AICHI, applyOne, asRole, check, clock, count, dispatches, dispatchIds, events, freshDb, ICHI, ELECTION_URL, insertElection, insertLg,
  migratedDb, mutate, one, openElectionWithRegion, readMig, rows, seed, stepsDone, submit,
} from "./policy-jp-chain-db.ts";

const MIG_FILE = "20261011090000_policy_jp_results_terms.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV_A1 = await readMig("20261011070000_policy_jp_arms_candidacy_status.sql");
const PREV_POLICY = await readMig("20261010060000_policy_jp_chain_policy.sql");
const POLLING = "2027-04-25";
const NOTICE = "2027-04-08"; // insertElection の既定（投票日の 17 日前）
const E1 = `${POLLING}_mayor_${ICHI}`;
const EA = `${POLLING}_muni_assembly_${ICHI}`;
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const ARMS = ["election_results", "elected_missing"] as const;
const RESULT = ["election_result_missing"];
const RESULT_URL = "https://www.city.ichinomiya.aichi.jp/senkyo/kekka.html"; // 選管の開票結果（official）

const shared = await freshDb();
type Db = Awaited<ReturnType<typeof freshDb>>;

/** 参選を 1 件入れる（candidacy 交件を落庫＝本番と同じ経路）。peid と人物 id を返す */
async function addCand(db: Db, name: string, kana: string, status: string, o: Record<string, unknown> = {}, eid = E1): Promise<{ pid: string; peid: string }> {
  const payload = { election_id: eid, name, kana, candidacy_status: status, status_date: status === "filed" ? NOTICE : "2027-03-01", district_kind: "at_large", ...o };
  const id = await submit(db, "candidacy", payload, { status: "verified", urls: [ELECTION_URL] });
  const out = await applyOne(db, id);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pid = (await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id;
  return { pid, peid: out.record_id! };
}
/** 当落を落庫する（candidacy、同じ参選で状態だけ進める） */
async function decide(db: Db, c: { pid: string; peid: string }, status: "elected" | "not_elected", o: { task?: string; date?: string; eid?: string } = {}) {
  const eid = o.eid ?? c.peid.split(":")[1];
  const out = await applyOne(db, await submit(db, "candidacy", { politician_id: c.pid, election_id: eid, candidacy_status: status, status_date: o.date ?? POLLING, district_kind: "at_large" },
    { status: "verified", task: o.task ?? `auto:election_result_missing:${c.peid}`, urls: [RESULT_URL] }));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
}
const taskResult = (peid: string) => `auto:election_result_missing:${peid}`;
const taskElected = (eid: string) => `auto:election_result_missing:elected:${eid}`;
async function lastClosedReason(db: Db, taskId: string): Promise<string | null> {
  const ev = await events(db, taskId);
  return ev.at(-1)?.event === "closed" ? ev.at(-1)!.reason : null;
}
/** 総務省「任期満了に関する調」の 1 行（前任の満了日） */
async function termEnd(db: Db, lg: string, kind: "head" | "assembly", end: string): Promise<void> {
  await clearTerms(db, lg);
  const sid = (await one<{ id: number }>(db, `INSERT INTO policy_jp.sources (url, origin, source_kind) VALUES ('https://www.soumu.go.jp/main_content/ninki.xlsx', 'test', 'official')
    ON CONFLICT (url) DO UPDATE SET origin = EXCLUDED.origin RETURNING id::INT AS id`)).id;
  await db.query(`INSERT INTO policy_jp.term_expirations (lg_code, pref_name, lg_name, office_kind, election_type, term_end, as_of, source_id)
    VALUES ($1, '愛知県', '一宮市', $2, $3, $4, '2026-11-01', $5)`, [lg, kind, kind === "head" ? "mayor" : "muni_assembly", end, sid]);
}
/** 本物の調査（20261009130200 の令和8年分）の行を消す：一宮市は 2027 年の満了日が入っているので、テストの満了日だけにする（印を付けた行は残す） */
async function clearTerms(db: Db, lg: string): Promise<void> {
  await db.query(`DELETE FROM policy_jp.term_expirations WHERE lg_code = $1 AND as_of <> '2026-11-01'`, [lg]);
}
type Office = { id: string; politician_id: string; position: string; lg_code: string; term_no: number; start_date: string; scheduled_end_date: string; end_date: string | null; end_reason: string | null; end_basis: string | null; review_status: string };
const offices = (db: Db) => rows<Office>(db, `SELECT id, politician_id, position, lg_code, term_no, start_date::TEXT, scheduled_end_date::TEXT, end_date::TEXT, end_reason, end_basis, review_status
  FROM policy_jp.politician_offices ORDER BY start_date, id`);
const sync = (db: Db) => db.query(`SELECT policy_jp.politician_offices_sync()`);

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：臂名・総表・規則の三処一緒；規則＝投票日 +1 起／止なし／after_step／後備／cap；優先層；步驟順位；主控台の段；鏈の步驟に results", async () => {
  const names = (await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a;
  for (const a of ARMS) assert(names.includes(a), `臂名清單に ${a}`);
  const total = fnText(MIG_SQL, TOTAL);
  for (const a of ARMS) assert(total.includes(`SELECT '${a}' AS arm, t.* FROM policy_jp.contribution_auto_tasks_${a}() t`), `総表に ${a} の UNION 分支`);
  const rule = (a: string) => one<{ window_kind: string; from_kind: string; from_offset: number; until_kind: string | null; min_status: string; after_step: string; params: Record<string, unknown>; enabled: boolean }>(shared,
    `SELECT window_kind, from_kind, from_offset, until_kind, min_status, after_step, params, enabled FROM policy_jp.activity_rules WHERE activity = $1 AND priority IS NULL`, [a]);
  const r1 = await rule("election_results"), r2 = await rule("elected_missing");
  assertEquals([r1.window_kind, r1.from_kind, r1.from_offset, r1.until_kind, r1.after_step, r1.enabled], ["event", "polling", 1, null, "candidacy", true]);
  assertEquals(r1.params, { cap: 300, chain_fallback: { kind: "polling", offset: 1 } });
  assertEquals([r2.window_kind, r2.from_kind, r2.from_offset, r2.until_kind, r2.after_step, r2.enabled], ["event", "polling", 1, null, "results", true]);
  assertEquals(r2.params, { cap: 100, chain_fallback: { kind: "polling", offset: 7 } });
  for (const a of ARMS) assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:${a}' AND priority = 1 AND from_kind = 'polling' AND from_offset = 1`), 1, `${a} の優先層規則（前段）`);
  assertEquals((await one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank('auto:election_result_missing:x', 'election_result_missing') AS r`)).r, 7);
  assertEquals((await one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank('auto:policy_missing:x', 'policy_missing') AS r`)).r, 6, "既存の順位は動かない");
  const st = await rows<{ arm: string; stage: number; stage_source: string }>(shared, `SELECT arm, stage::INT AS stage, stage_source FROM policy_jp.console_arm_stages() WHERE arm = ANY ($1) ORDER BY arm`, [[...ARMS]]);
  assertEquals(st.map((x) => [x.arm, x.stage, x.stage_source]), [["elected_missing", 4, "rule"], ["election_results", 4, "rule"]], "投票日の翌日起算＝第 4 段（開票）");
  assertEquals((await one<{ s: string[] }>(shared, `SELECT policy_jp.election_chain_steps() AS s`)).s.at(-1), "results");
});

// =============================================================================================
// b. 当落
// =============================================================================================
Deno.test("election_results：投票日まで開かない／翌日に開く（via=done）；elected／not_elected が落庫すると filled で收回；得票数は書かせない", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "山田太郎", "やまだたろう", "filed");
  const b = await addCand(db, "佐藤花子", "さとうはなこ", "filed");
  const c = await addCand(db, "鈴木一郎", "すずきいちろう", "declared");
  await clock(db, POLLING);
  await seed(db);
  assertEquals(await dispatchIds(db, RESULT), [], "投票日当日＝開かない（開票結果はまだ）");
  await clock(db, addDays(POLLING, 1));
  await seed(db);
  assertEquals(await dispatchIds(db, RESULT), [taskResult(a.peid), taskResult(b.peid), taskResult(c.peid)].sort());
  const d = (await dispatches(db, RESULT)).find((x) => x.task_id === taskResult(a.peid))!;
  assertEquals(d.opened_by?.chain_gate, { after_step: "candidacy", via: "done" });
  assertEquals([d.opened_by?.arm, d.opened_by?.milestone_kind, d.opened_by?.milestone_on_date, d.opened_by?.expected_open_on], ["election_results", "polling", POLLING, addDays(POLLING, 1)]);
  assertEquals([d.target.kind, d.target.politician_election_id, d.target.politician_id, d.target.candidacy_status, d.target.chain_step, d.target.chain_lg_code], ["result", a.peid, a.pid, "filed", "results", ICHI]);
  assertEquals(d.priority, 1, "投票日の翌日から前段");
  assert(d.what_we_need.includes("elected") && d.what_we_need.includes("not_elected") && d.what_we_need.includes("得票数") && d.what_we_need.includes("withdrawn_after_filing=true"), "当選／落選／辞退／得票数は書かない");
  const dc = (await dispatches(db, RESULT)).find((x) => x.task_id === taskResult(c.peid))!;
  assert(dc.what_we_need.includes("withdrawn_after_filing=false"), "届出していない人は届出前の取りやめ");
  await decide(db, a, "elected");
  await decide(db, b, "not_elected");
  await seed(db);
  assertEquals(await dispatchIds(db, RESULT), [taskResult(c.peid)]);
  assertEquals(await lastClosedReason(db, taskResult(a.peid)), "filled");
  assertEquals(await lastClosedReason(db, taskResult(b.peid)), "filled");
  // 投票日より前の日付の当選は落庫で差し戻し（既存の apply_candidacy の検査）
  const bad = await applyOne(db, await submit(db, "candidacy", { politician_id: c.pid, election_id: E1, candidacy_status: "elected", status_date: addDays(POLLING, -1), district_kind: "at_large" },
    { status: "verified", task: taskResult(c.peid), urls: [RESULT_URL] }));
  assertEquals(bad.status, "rejected");
  await db.close();
});

// =============================================================================================
// c. 記録にない当選者
// =============================================================================================
Deno.test("elected_missing：全員の当落が決まるまで開かない（after_step=results）→ 決まると開く（via=done）；candidacy の落庫では收回しない；confirmed で閉じる", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING, { type: "muni_assembly" });
  const o = { district_kind: "at_large" };
  const a = await addCand(db, "山田太郎", "やまだたろう", "filed", o, EA);
  const b = await addCand(db, "佐藤花子", "さとうはなこ", "filed", o, EA);
  await clock(db, addDays(POLLING, 1));
  await seed(db);
  assertEquals(await dispatchIds(db, RESULT), [taskResult(a.peid), taskResult(b.peid)].sort(), "記録にない当選者はまだ（鏈の前一歩が未完了・後備前）");
  assertEquals((await stepsDone(db, EA)).results, false);
  await decide(db, a, "elected", { eid: EA });
  await decide(db, b, "not_elected", { eid: EA });
  assertEquals((await stepsDone(db, EA)).results, true, "全員の当落が決まった");
  await seed(db);
  assertEquals(await dispatchIds(db, RESULT), [taskElected(EA)]);
  const d = (await dispatches(db, RESULT))[0];
  assertEquals(d.opened_by?.chain_gate, { after_step: "results", via: "done" });
  assertEquals([d.target.kind, d.target.election_id, d.target.seats, d.target.elected_count, d.target.chain_step], ["elected_missing", EA, null, 1, "results"]);
  assertEquals((d.target.elected as Array<{ politician_id: string }>).map((x) => x.politician_id), [a.pid], "記録にある当選者の一覧");
  assert(d.what_we_need.includes("no_change") && d.what_we_need.includes("confirmed") && d.what_we_need.includes("candidacy_status=elected"));
  // 記録にない当選者を 1 人足す（新しい人）：任務は一題多份なので收回しない
  const out = await applyOne(db, await submit(db, "candidacy", { election_id: EA, name: "高橋次郎", kana: "たかはしじろう", candidacy_status: "elected", status_date: POLLING, district_kind: "at_large" },
    { status: "verified", task: taskElected(EA), urls: [RESULT_URL] }));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  assertEquals(await dispatchIds(db, RESULT), [taskElected(EA)], "candidacy の落庫では收回しない（触發器の WHEN）");
  await seed(db);
  assertEquals((await dispatches(db, RESULT))[0].target.elected_count, 2);
  // 全員記録にあると確かめた（no_change confirmed）→ 照合済みで閉じる
  await check(db, taskElected(EA), "confirmed");
  await seed(db);
  assertEquals(await dispatchIds(db, RESULT), []);
  assertEquals(await lastClosedReason(db, taskElected(EA)), "filled");
  await db.close();
});

Deno.test("elected_missing：当落が決まらない参選が残っても投票日の 7 日後に後備で開く（via=fallback）；定数を満たした選挙・首長の当選済みには出ない", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING, { type: "muni_assembly" });
  await addCand(db, "山田太郎", "やまだたろう", "filed", {}, EA);
  await clock(db, addDays(POLLING, 6));
  await seed(db);
  assert(!(await dispatchIds(db, RESULT)).includes(taskElected(EA)), "6 日後はまだ");
  await clock(db, addDays(POLLING, 7));
  await seed(db);
  const d = (await dispatches(db, RESULT)).find((x) => x.task_id === taskElected(EA))!;
  assertEquals(d.opened_by?.chain_gate, { after_step: "results", via: "fallback" });
  // 定数 1（seats=1）で当選者が 1 人いれば出ない
  await db.query(`UPDATE policy_jp.elections SET seats = 1 WHERE id = $1`, [EA]);
  const pe = await one<{ id: string; politician_id: string }>(db, `SELECT id, politician_id FROM policy_jp.politician_elections WHERE election_id = $1`, [EA]);
  await decide(db, { pid: pe.politician_id, peid: pe.id }, "elected", { eid: EA });
  await seed(db);
  assertEquals(await dispatchIds(db, RESULT), [], "定数を満たした");
  assertEquals(await lastClosedReason(db, taskElected(EA)), "filled");
  // 首長：当選者が 1 人いれば出ない（定数 1）
  await insertElection(db, ICHI, POLLING);
  const m = await addCand(db, "伊藤三郎", "いとうさぶろう", "filed");
  await decide(db, m, "elected");
  await seed(db);
  assertEquals(await dispatchIds(db, RESULT), []);
  await db.close();
});

// =============================================================================================
// d. 新任期
// =============================================================================================
Deno.test("任期：就任日（前任の満了日の翌日）が来るまで建てない → 就任日に建つ（4 年、出典は当選の出典、期数 1）→ 満了の翌日に閉じる（term_expired／law）", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await termEnd(db, ICHI, "head", "2027-05-08");
  const a = await addCand(db, "山田太郎", "やまだたろう", "filed");
  await clock(db, addDays(POLLING, 1));
  await decide(db, a, "elected");
  assertEquals(await offices(db), [], "就任日まで建てない（現職は end_date が空かどうかだけで決まるため）");
  assertEquals(await rows(db, `SELECT politician_election_id, reason, start_date::TEXT AS s, scheduled_end_date::TEXT AS e, term_rule FROM policy_jp.politician_offices_pending`),
    [{ politician_election_id: a.peid, reason: "not_started", s: "2027-05-09", e: "2031-05-08", term_rule: "regular_after_predecessor" }]);
  await clock(db, "2027-05-08");
  await sync(db);
  assertEquals(await offices(db), []);
  await clock(db, "2027-05-09");
  await sync(db);
  const [o] = await offices(db);
  assertEquals([o.id, o.politician_id, o.position, o.lg_code, o.term_no, o.start_date, o.scheduled_end_date, o.end_date, o.review_status],
    [`office:${a.peid}`, a.pid, "mayor", ICHI, 1, "2027-05-09", "2031-05-08", null, "published"]);
  const urls = (await rows<{ url: string }>(db, `SELECT s.url FROM policy_jp.source_refs r JOIN policy_jp.sources s ON s.id = r.source_id WHERE r.target_table = 'politician_offices' AND r.target_id = $1`, [o.id])).map((x) => x.url);
  assert(urls.includes(RESULT_URL), `当選の出典が任期にも付く：${urls}`);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politician_offices_pending`), 0);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'politician_offices' AND agent_name = 'office-sync'`), 1);
  await sync(db);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'politician_offices'`), 1, "二回目は何も書かない（冪等）");
  await clock(db, "2031-05-08");
  await sync(db);
  assertEquals((await offices(db))[0].end_date, null, "満了日当日はまだ現職");
  await clock(db, "2031-05-09");
  await sync(db);
  const [c] = await offices(db);
  assertEquals([c.end_date, c.end_reason, c.end_basis], ["2031-05-08", "term_expired", "law"]);
  await db.close();
});

Deno.test("任期：就任日を過ぎてから当落が入ると、その場で（觸發器で）建つ；当選が取り消されると消える（履歴に全列）", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await termEnd(db, ICHI, "head", "2027-04-30"); // 満了日が投票日の後 → 翌日（5/1）就任
  const a = await addCand(db, "山田太郎", "やまだたろう", "filed");
  await clock(db, "2027-05-02");
  await decide(db, a, "elected");
  const [o] = await offices(db);
  assertEquals([o.start_date, o.scheduled_end_date], ["2027-05-01", "2031-04-30"]);
  const srcs = (await rows<{ url: string }>(db, `SELECT s.url FROM policy_jp.source_refs r JOIN policy_jp.sources s ON s.id = r.source_id WHERE r.target_table = 'politician_offices' AND r.target_id = $1`, [o.id])).map((x) => x.url);
  assert(srcs.includes(RESULT_URL), `觸發器で建った任期にも当選の出典がその場で付く（遅延觸發器）：${srcs}`);
  // 誤りの訂正（人の手で当選を落選に直した）→ 任期は最初からなかった
  await db.query(`UPDATE policy_jp.politician_elections SET candidacy_status = 'not_elected' WHERE id = $1`, [a.peid]);
  assertEquals(await offices(db), []);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'politician_offices'`), 0, "任期の出典も消える（孤児にしない）");
  const h = await rows<{ old_value: { id: string } | null; new_value: unknown }>(db, `SELECT old_value, new_value FROM policy_jp.edit_history WHERE table_name = 'politician_offices' ORDER BY id`);
  assertEquals(h.length, 2);
  assertEquals([h[1].old_value?.id, h[1].new_value], [o.id, null]);
  // 交接が指している自動の任期は、当選が取り消されても消さない（同期全体を止めない）→ pending の orphaned
  await db.query(`UPDATE policy_jp.politician_elections SET candidacy_status = 'elected' WHERE id = $1`, [a.peid]);
  const b = await addCand(db, "佐藤花子", "さとうはなこ", "filed");
  await decide(db, b, "elected");
  const [oa, ob] = (await offices(db)).map((x) => x.id);
  await db.query(`INSERT INTO policy_jp.lineages (id, title, level, lg_code, review_status) VALUES ('ln-1', 'テスト', 'local', $1, 'published')`, [ICHI]);
  await db.query(`INSERT INTO policy_jp.handovers (id, lineage_id, from_office_id, to_office_id, handover_type, review_status) VALUES ('h-1', 'ln-1', $1, $2, 'keep', 'published')`, [oa, ob]);
  await db.query(`UPDATE policy_jp.politician_elections SET candidacy_status = 'not_elected' WHERE id = $1`, [a.peid]);
  assertEquals((await offices(db)).map((x) => x.id).sort(), [oa, ob].sort(), "参照されている任期は残す（同期は止まらない）");
  assertEquals((await rows<{ reason: string }>(db, `SELECT reason FROM policy_jp.politician_offices_pending`)).map((x) => x.reason), ["orphaned"]);
  await db.close();
});

Deno.test("任期の法定計算：定期で満了日が投票日より前＝投票日から／辞職の後＝投票日から 4 年／補欠＝議会の満了日まで／満了日の記録がない定期・再選挙は建てない（term_unknown）", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clearTerms(db, ICHI);
  const term = (eid: string) => one<{ s: string; e: string; r: string } | undefined>(db, `SELECT start_date::TEXT AS s, scheduled_end_date::TEXT AS e, term_rule AS r FROM policy_jp.office_term_for($1)`, [eid]);
  assertEquals(await term(E1), undefined, "満了日の記録がない定期は算出しない");
  await termEnd(db, ICHI, "head", "2027-04-20");
  assertEquals(await term(E1), { s: POLLING, e: "2031-04-24", r: "regular_from_polling" }, "満了日が投票日より前＝投票日から 4 年");
  await db.query(`UPDATE policy_jp.elections SET election_reason = 'resignation' WHERE id = $1`, [E1]);
  assertEquals(await term(E1), { s: POLLING, e: "2031-04-24", r: "from_polling" });
  await db.query(`UPDATE policy_jp.elections SET election_reason = 'rerun' WHERE id = $1`, [E1]);
  assertEquals(await term(E1), undefined, "再選挙は算出しない");
  // 補欠（議会）：投票日から議会の満了日まで
  const BY = `${POLLING}_muni_assembly_${ICHI}`;
  await insertElection(db, ICHI, POLLING, { type: "muni_assembly" });
  await db.query(`UPDATE policy_jp.elections SET election_reason = 'by_election' WHERE id = $1`, [BY]);
  assertEquals(await term(BY), undefined, "議会の満了日の記録がない");
  await termEnd(db, ICHI, "assembly", "2029-02-22");
  assertEquals(await term(BY), { s: POLLING, e: "2029-02-22", r: "remaining_term" });
  // 当選しても算出できない選挙は pending の term_unknown に出る
  await db.query(`UPDATE policy_jp.elections SET election_reason = 'rerun' WHERE id = $1`, [E1]);
  const a = await addCand(db, "山田太郎", "やまだたろう", "filed");
  await clock(db, addDays(POLLING, 1));
  await decide(db, a, "elected");
  assertEquals(await rows(db, `SELECT politician_election_id, reason FROM policy_jp.politician_offices_pending`), [{ politician_election_id: a.peid, reason: "term_unknown" }]);
  await db.close();
});

Deno.test("任期の卸任と期数：首長に別の人が就任すると前任が前日に閉じる（other／inferred）；同じ人が別の公職に就くと took_other_office；期数は記録上の回数", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  // 前任（手で入れた任期：office: で始まらない id は同期の管理外）
  const prev = await addCand(db, "前市長", "まえしちょう", "declared");
  await db.query(`INSERT INTO policy_jp.politician_offices (id, politician_id, position, lg_code, term_no, start_date, scheduled_end_date, review_status)
    VALUES ('manual-1', $1, 'mayor', $2, 2, '2025-01-01', '2028-12-31', 'published')`, [prev.pid, ICHI]);
  await db.query(`UPDATE policy_jp.elections SET election_reason = 'resignation' WHERE id = $1`, [E1]);
  const a = await addCand(db, "山田太郎", "やまだたろう", "filed");
  await clock(db, addDays(POLLING, 1));
  await decide(db, a, "elected");
  const os = await offices(db);
  assertEquals(os.map((x) => [x.id, x.end_date, x.end_reason, x.end_basis]), [["manual-1", addDays(POLLING, -1), "other", "inferred"], [`office:${a.peid}`, null, null, null]]);
  assertEquals((await offices(db)).find((x) => x.id === "manual-1")!.term_no, 2, "手で入れた任期の期数は触らない");
  // 同じ人が後で別の公職（県議）に就任 → 市長の任期はその前日に took_other_office
  const PA = `2028-04-09_pref_assembly_${AICHI}`;
  await insertLg(db, AICHI);
  await db.query(`INSERT INTO policy_jp.elections (id, name, election_date, notice_date, election_type, election_reason, level, lg_code, review_status)
    VALUES ($1, '愛知県議会議員補欠選挙', '2028-04-09', '2028-04-01', 'pref_assembly', 'dissolution', 'regional', $2, 'published')`, [PA, AICHI]);
  await clock(db, "2028-04-10");
  const out = await applyOne(db, await submit(db, "candidacy", { politician_id: a.pid, election_id: PA, candidacy_status: "elected", status_date: "2028-04-09", district_kind: "district", district_name: "一宮市選挙区" },
    { status: "verified", urls: [RESULT_URL] }));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  const mine = (await offices(db)).filter((x) => x.politician_id === a.pid);
  assertEquals(mine.map((x) => [x.position, x.start_date, x.end_date, x.end_reason, x.end_basis, x.term_no]),
    [["mayor", POLLING, "2028-04-08", "took_other_office", "inferred", 1], ["pref_assembly_member", "2028-04-09", null, null, null, 1]]);
  await db.close();
});

// =============================================================================================
// e. 文字守門
// =============================================================================================
Deno.test("文字守門：総表＝緊接在前一版（20261011070000）に UNION 2 行だけ；臂名は末尾に 2 つ；chain_step_rank は WHEN 1 行；鏈の視圖＝20261010060000 に results の一段と UNION 1 行", () => {
  const prev = fnText(PREV_A1, TOTAL);
  const now = fnText(MIG_SQL, TOTAL);
  const added = ARMS.map((a) => `  UNION ALL SELECT '${a}' AS arm, t.* FROM policy_jp.contribution_auto_tasks_${a}() t\n`).join("");
  assertEquals(mutate(now, added, ""), prev, "総表は UNION 2 行以外、一字も違わない");
  const tampered = mutate(now, "'chain_gate', CASE WHEN o.after_step IS NOT NULL", "'chain_gatex', CASE WHEN o.after_step IS NOT NULL");
  assertNotEquals(mutate(tampered, added, ""), prev, "還原驗證：本体を 1 字変えれば赤くなる");
  const names = (sql: string) => [...fnText(sql, "policy_jp.activity_arm_names").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(names(MIG_SQL), [...names(PREV_A1), ...ARMS]);
  assertEquals(mutate(fnText(MIG_SQL, "policy_jp.chain_step_rank"), "                  WHEN 'election_result_missing' THEN 7\n", ""), fnText(PREV_A1, "policy_jp.chain_step_rank"));
  const view = (sql: string) => { const i = sql.indexOf("CREATE OR REPLACE VIEW policy_jp.election_chain_progress"); return sql.slice(i, sql.indexOf("\nCOMMENT ON VIEW policy_jp.election_chain_progress", i)); };
  const segment = view(MIG_SQL).match(/  \),\n  -- 第 5 步 results：[\s\S]*?\n  \)\n/)![0];
  const stripped = mutate(mutate(view(MIG_SQL), segment, "  )\n"), "\n  UNION ALL\n  SELECT r.election_id, r.lg_code, 'results'::TEXT, r.done, CASE WHEN r.done THEN r.last_at END FROM rs r", "");
  assertEquals(stripped, view(PREV_POLICY), "鏈の視圖は results の一段と UNION 1 行以外、一字も違わない");
  const steps = (sql: string) => fnText(sql, "policy_jp.election_chain_steps");
  assertEquals(mutate(steps(MIG_SQL), ", 'policy', 'results']", ", 'policy']"), steps(PREV_POLICY));
});

Deno.test("文字守門：臂は読み取りだけ（INSERT／UPDATE／DELETE なし）、public.／ditrust を引かない、新しい関数は search_path を釘付け、臂の中で日付を比べない（窓は規則）", () => {
  for (const a of ARMS) {
    const f = fnText(MIG_SQL, `policy_jp.contribution_auto_tasks_${a}`);
    assert(!/\b(INSERT|UPDATE|DELETE)\b/.test(f), `${a} は読み取りだけ`);
    assert(!/activity_today\(\)|CURRENT_DATE|now\(\)/.test(f), `${a} は日付を比べない`);
  }
  const code = MIG_SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  assert(!/\bpublic\./.test(code) && !/ditrust/.test(code), "public・ditrust に触れない");
  for (const m of MIG_SQL.matchAll(/CREATE OR REPLACE FUNCTION (policy_jp\.[a-z_]+)\(/g)) {
    if (m[1] === TOTAL) continue; // 総表は前の版と同じ（search_path なしのまま）
    assert(fnText(MIG_SQL, m[1]).includes("SET search_path = policy_jp, pg_temp"), `${m[1]} の search_path`);
  }
});

// =============================================================================================
// f. 還原驗證・冪等・權限
// =============================================================================================
Deno.test("自我檢查（還原驗證）：規則の窓・after_step・後備が欠ける／総表の分支・臂名・順位・段・鏈の步驟・觸發器が欠ける／anon に渡すと、migration が失敗する；元の SQL は通る", async () => {
  const pre = await migratedDb({ before: MIG_FILE });
  const bad = async (from: string, to: string, why: string) => {
    await assertRejects(() => pre.exec(mutate(MIG_SQL, from, to)), Error, undefined, why);
  };
  await bad(`'{"cap":100,"chain_fallback":{"kind":"polling","offset":7}}'`, `'{"cap":100}'`, "後備なし");
  await bad(`SELECT a.activity, 'event', 'polling', 1, NULL, 0,`, `SELECT a.activity, 'event', 'polling', 0, NULL, 0,`, "窓の起点がずれる（投票日当日）");
  await bad(`    ('elected_missing', 'results', `, `    ('elected_missing', 'candidacy', `, "after_step が results でない");
  await bad(`  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_elected_missing() t\n`, "", "総表の分支が欠ける");
  await bad(`    'election_results',\n    'elected_missing'\n  ]`, `    'election_results'\n  ]`, "臂名が欠ける");
  await bad(`                  WHEN 'election_result_missing' THEN 7\n`, "", "順位が欠ける");
  await bad(`  ('elected_missing', 4, '記録にない当選者（全員の当落が決まってから）')\n`, `  ('elected_missing', 3, 'x')\n`, "主控台の段が違う");
  await bad(`, 'policy', 'results']::TEXT[]`, `, 'policy']::TEXT[]`, "鏈の步驟に results がない");
  await bad(`                     AND NOT (NEW.contribution_type = 'candidacy' AND NEW.task_id LIKE 'auto:election\\_result\\_missing:elected:%'))`, `)`, "一題多份の除外がない");
  await bad(`DROP TRIGGER IF EXISTS politician_elections_office_sync ON policy_jp.politician_elections;
CREATE CONSTRAINT TRIGGER politician_elections_office_sync`, `DROP TRIGGER IF EXISTS politician_elections_office_sync ON policy_jp.politician_elections;
CREATE CONSTRAINT TRIGGER politician_elections_office_sync_x`, "任期の觸發器の名前が違う");
  await bad(`  policy_jp.politician_offices_sync(DATE, TEXT)
  TO service_role;`, `  policy_jp.politician_offices_sync(DATE, TEXT)
  TO service_role, anon;`, "anon に渡す");
  await pre.exec(MIG_SQL);
  await pre.close();
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則・主控台登記・任期が増えない", async () => {
  const db = await freshDb();
  const n = () => Promise.all([count(db, `SELECT 1 FROM policy_jp.activity_rules`), count(db, `SELECT 1 FROM policy_jp.console_arm_stage_map`), count(db, `SELECT 1 FROM policy_jp.politician_offices`)]);
  const before = await n();
  await db.exec(MIG_SQL);
  assertEquals(await n(), before);
  await db.close();
});

Deno.test("権限：新しい関数・視圖は anon／authenticated が呼べない（service_role は呼べる）", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const a of ARMS) await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.contribution_auto_tasks_${a}()`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.politician_offices_sync()`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.office_term_for('x')`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.politician_offices_pending`), Error, "permission denied");
  }
  for (const a of ARMS) assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_${a}()`))[0].n, 0);
  assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.politician_offices_pending`))[0].n, 0);
});
