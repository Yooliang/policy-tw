/**
 * 日本站派工臂對齊正見 A 期第一支：候補者の状態を確かめる四つの臂（migration 20261011070000_policy_jp_arms_candidacy_status.sql、工作單 Yooliang/policy-ops#95）
 *   candidate_status_stale／not_running／withdrawn_filing／candidacy_source_missing（正見 raw:candidate_status_stale・not_running・withdrawn_filing・raw:candidacy_source_missing の日本版）
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts），時鐘用 `SET app.activity_today`，整條流程走 seed_auto_task_queue()＋task_dispatches／gap_events。
 *
 *   a. 結構：臂名・總表・規則三處一起加；規則＝告示日 +0 起／投票日 +0 止／after_step=candidacy／後備／cap；優先層；步驟順位；主控台段
 *   b. 假時鐘情境：告示前は開かない・告示日に開く・投票日の翌日に window で收回・補完したら filled で收回（四支臂それぞれ）
 *   c. 鏈の gate：declared がいれば via=done、considering だけなら後備（告示日）で via=fallback
 *   d. 落庫（apply_candidacy の A 期の分岐）：withdrawn_after_filing の空欄埋め／違う値は conflict／同じ値は unchanged／状態・日付は触らない
 *   e. 対象の絞り込み：未公開の人物・参選・選挙は派さない、cap、投票日が過ぎた選挙は後ろ
 *   f. 文字守門：総表＝緊接在前一版＋UNION 4 行、臂名＝末尾に 4 つ、apply_candidacy＝前の版＋登記した 2 か所、臂は読み取りだけ
 *   g. 還原驗證：臂の鍵になる行・規則の窓・落庫の分岐を 1 つずつ壊すと対応する探査が赤くなる；自我檢查が壊れた migration を弾く；冪等；權限
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, applyOne, asRole, check, clock, count, dispatches, dispatchIds, events, expireCooling, freshDb, insertElection, ICHI, ELECTION_URL,
  migratedDb, mutate, one, openElectionWithRegion, readMig, rows, seed, submit,
} from "./policy-jp-chain-db.ts";

const MIG_FILE = "20261011070000_policy_jp_arms_candidacy_status.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV_POLICY = await readMig("20261010060000_policy_jp_chain_policy.sql");
const PREV_KANA = await readMig("20261010120000_policy_jp_kana_optional.sql");
const POLLING = "2027-04-25";
const NOTICE = "2027-04-08"; // insertElection の既定（投票日の 17 日前）
const E1 = `${POLLING}_mayor_${ICHI}`;
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const ARMS = ["candidate_status_stale", "not_running", "withdrawn_filing", "candidacy_source_missing"] as const;
const STALE = ["candidate_status_stale"], RECHECK = ["not_running_recheck"], SOURCE = ["candidacy_source_missing"];
const MEDIA = "https://www.chunichi.co.jp/article/20270301000001"; // 報道（source_kind=other）
const LIST_URL = "https://www.city.ichinomiya.aichi.jp/senkyo/todokede.html"; // 選管の公表ページ（*.jp の city. ＝ official）

const shared = await freshDb();
type Db = Awaited<ReturnType<typeof freshDb>>;

/** 参選を 1 件入れる（candidacy 交件を落庫＝本番と同じ経路）。peid と人物 id を返す */
async function addCand(db: Db, name: string, kana: string, status: string, o: Record<string, unknown> = {}, urls: string[] = [ELECTION_URL], eid = E1): Promise<{ pid: string; peid: string }> {
  const payload = { election_id: eid, name, kana, candidacy_status: status, status_date: "2027-03-01", district_kind: "at_large", ...o };
  const id = await submit(db, "candidacy", payload, { status: "verified", urls });
  const out = await applyOne(db, id);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pid = (await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id;
  return { pid, peid: out.record_id! };
}
const taskStale = (peid: string) => `auto:candidate_status_stale:${peid}`;
const taskNr = (peid: string) => `auto:not_running_recheck:${peid}`;
const taskFiling = (peid: string) => `auto:not_running_recheck:filing:${peid}`;
const taskSrc = (peid: string) => `auto:candidacy_source_missing:${peid}`;
const ids = (db: Db) => dispatchIds(db, ["candidate_status_stale", "not_running_recheck", "candidacy_source_missing"]);
async function lastClosedReason(db: Db, taskId: string): Promise<string | null> {
  const ev = await events(db, taskId);
  return ev.at(-1)?.event === "closed" ? ev.at(-1)!.reason : null;
}

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：臂名・総表・規則の三処一緒；規則＝告示日 +0 起／投票日 +0 止／after_step=candidacy／後備／cap；優先層；步驟順位；主控台の段", async () => {
  const names = (await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a;
  for (const a of ARMS) assert(names.includes(a), `臂名清單に ${a}`);
  assertEquals(names.length, 13);
  const total = fnText(MIG_SQL, TOTAL);
  for (const a of ARMS) assert(total.includes(`SELECT '${a}' AS arm, t.* FROM policy_jp.contribution_auto_tasks_${a}() t`), `総表に ${a} の UNION 分支`);
  for (const a of ARMS) {
    const r = await one<{ window_kind: string; from_kind: string; from_offset: number; until_kind: string; until_offset: number; min_status: string; after_step: string; params: Record<string, unknown>; enabled: boolean }>(shared,
      `SELECT window_kind, from_kind, from_offset, until_kind, until_offset, min_status, after_step, params, enabled FROM policy_jp.activity_rules WHERE activity = $1 AND priority IS NULL`, [a]);
    assertEquals([r.window_kind, r.from_kind, r.from_offset, r.until_kind, r.until_offset, r.min_status, r.after_step, r.enabled], ["event", "announced", 0, "polling", 0, "announced", "candidacy", true], a);
    assertEquals(r.params, { cap: 200, chain_fallback: { kind: "announced", offset: 0 } }, a);
    assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:${a}' AND priority IN (1, 3)`), 2, `${a} の優先層規則（前段・後段）`);
  }
  const rank = (id: string, t: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, t]).then((x) => x.r);
  assertEquals(await rank("auto:candidate_status_stale:x", "candidate_status_stale"), 4);
  assertEquals(await rank("auto:not_running_recheck:x", "not_running_recheck"), 4);
  assertEquals(await rank("auto:candidacy_source_missing:x", "candidacy_source_missing"), 4);
  assertEquals(await rank("auto:roster_check:x", "roster_check"), 4, "既存の順位は動かない");
  assertEquals(await rank("auto:policy_missing:x", "policy_missing"), 6);
  assertEquals(await rank("auto:something_new:x", "something_new"), 9);
  // 主控台：規則から第 3 段（告示日起算）、登記表にも第 3 段（規則を止めたときの後備）
  const st = await rows<{ arm: string; stage: number; stage_source: string }>(shared, `SELECT arm, stage::INT AS stage, stage_source FROM policy_jp.console_arm_stages() WHERE arm = ANY ($1)`, [[...ARMS]]);
  assertEquals(st.map((x) => [x.stage, x.stage_source]), ARMS.map(() => [3, "rule"]));
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.console_arm_stage_map WHERE arm = ANY ('{candidate_status_stale,not_running,withdrawn_filing,candidacy_source_missing}') AND stage = 3`), 4);
});

// =============================================================================================
// b. 假時鐘情境
// =============================================================================================
Deno.test("candidate_status_stale：告示前は開かない／告示日に開く（via=done）／投票日当日まで／翌日に window で收回；filed に進むと filled で收回", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "山田太郎", "やまだたろう", "declared");
  const b = await addCand(db, "佐藤花子", "さとうはなこ", "considering");
  await clock(db, addDays(NOTICE, -1));
  await seed(db);
  assertEquals(await ids(db), [], "告示前＝開かない（窓の日付は規則が決める）");
  await clock(db, NOTICE);
  await seed(db);
  assertEquals(await dispatchIds(db, STALE), [taskStale(a.peid), taskStale(b.peid)].sort(), "告示日＝考慮中と表明の両方");
  const d = (await dispatches(db, STALE)).find((x) => x.task_id === taskStale(a.peid))!;
  assertEquals(d.task_type, "candidate_status_stale");
  assertEquals(d.opened_by?.chain_gate, { after_step: "candidacy", via: "done" }, "declared が 1 人いる＝第 2 歩以降は完了");
  assertEquals([d.opened_by?.arm, d.opened_by?.milestone_kind, d.opened_by?.milestone_on_date, d.opened_by?.expected_open_on, d.opened_by?.open_until],
    ["candidate_status_stale", "announced", NOTICE, NOTICE, POLLING]);
  assertEquals([d.target.politician_election_id, d.target.politician_id, d.target.election_id, d.target.candidacy_status, d.target.district_kind, d.target.chain_lg_code, d.target.chain_step],
    [a.peid, a.pid, E1, "declared", "at_large", ICHI, "candidacy"]);
  assertEquals(d.priority, 1, "投票日前 60 日以内＝前段");
  assert(d.what_we_need.includes("filed") && d.what_we_need.includes("withdrawn_after_filing=false") && d.what_we_need.includes("no_change"), "届出した／していない／一覧が見つからない の三つの答え方");
  assert(d.what_we_need.includes(a.peid) === false && d.what_we_need.includes(a.pid), "politician_id を payload の例に出す");
  assertEquals(d.region, (await one<{ name: string }>(db, `SELECT name FROM policy_jp.local_governments WHERE lg_code = policy_jp.lg_pref_code('${ICHI}')`)).name);
  await clock(db, POLLING);
  await seed(db);
  assertEquals((await dispatchIds(db, STALE)).length, 2, "投票日当日まで開いている");
  // 補完（declared → filed）：落庫すると缺口が消え、次の seed で filled
  const out = await applyOne(db, await submit(db, "candidacy", { politician_id: a.pid, election_id: E1, candidacy_status: "filed", status_date: NOTICE, district_kind: "at_large" },
    { status: "verified", task: taskStale(a.peid), urls: [LIST_URL] }));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  await seed(db);
  assertEquals(await dispatchIds(db, STALE), [taskStale(b.peid)]);
  assertEquals(await lastClosedReason(db, taskStale(a.peid)), "filled");
  await clock(db, addDays(POLLING, 1));
  await seed(db);
  assertEquals(await dispatchIds(db, STALE), [], "投票日の翌日＝窓が閉じる");
  assertEquals(await lastClosedReason(db, taskStale(b.peid)), "window");
  await db.close();
});

Deno.test("鏈の gate：declared 以上が 1 人もいない（considering だけ）選挙は前一歩（candidacy）が未完了＝告示日の後備（announced +0）で via=fallback", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const b = await addCand(db, "佐藤花子", "さとうはなこ", "considering");
  await clock(db, addDays(NOTICE, -1));
  await seed(db);
  assertEquals(await ids(db), []);
  await clock(db, NOTICE);
  await seed(db);
  assertEquals(await dispatchIds(db, STALE), [taskStale(b.peid)]);
  assertEquals((await dispatches(db, STALE))[0].opened_by?.chain_gate, { after_step: "candidacy", via: "fallback" });
  await db.close();
});

Deno.test("not_running：届出前に取りやめ（withdrawn・false）だけ。告示前は開かない；no_change confirmed の照合で收回され、冷卻が過ぎても二度と派されない；withdrawn_after_filing の変更履歴があっても派されない", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "山田太郎", "やまだたろう", "withdrawn", { withdrawn_after_filing: false, status_date: "2027-03-20" });
  const t = await addCand(db, "高橋次郎", "たかはしじろう", "withdrawn", { withdrawn_after_filing: true, status_date: "2027-03-20" });
  const u = await addCand(db, "伊藤三郎", "いとうさぶろう", "withdrawn", { status_date: "2027-03-20" }); // 空＝withdrawn_filing の対象
  await clock(db, addDays(NOTICE, -1));
  await seed(db);
  assertEquals(await dispatchIds(db, RECHECK), [], "告示前＝開かない");
  await clock(db, NOTICE);
  await seed(db);
  assertEquals(await dispatchIds(db, RECHECK), [taskNr(a.peid), taskFiling(u.peid)].sort(), "false は not_running、空は withdrawn_filing、true はどちらにも派さない");
  const d = (await dispatches(db, RECHECK)).find((x) => x.task_id === taskNr(a.peid))!;
  assertEquals([d.task_type, d.target.kind, d.opened_by?.arm, d.priority], ["not_running_recheck", "not_running", "not_running", 1]);
  assert(d.what_we_need.includes("outcome=confirmed") && d.what_we_need.includes("task_suggestion") && d.what_we_need.includes("not_found"));
  assertEquals(t.peid.length > 0, true);
  // 照合（no_change confirmed）→ 收回
  await check(db, taskNr(a.peid), "confirmed");
  await seed(db);
  assertEquals(await dispatchIds(db, RECHECK), [taskFiling(u.peid)]);
  assertEquals(await lastClosedReason(db, taskNr(a.peid)), "filled");
  // 冷卻が過ぎても（照合済みなので）二度と派さない；unreachable／not_found は照合済みではない（冷卻後に再び派す）
  await expireCooling(db);
  await seed(db);
  assertEquals(await dispatchIds(db, RECHECK), [taskFiling(u.peid)], "confirmed は照合済み＝冷卻が過ぎても派さない");
  const w = await addCand(db, "渡辺四郎", "わたなべしろう", "withdrawn", { withdrawn_after_filing: false, status_date: "2027-03-21" });
  await seed(db);
  assert((await dispatchIds(db, RECHECK)).includes(taskNr(w.peid)));
  await check(db, taskNr(w.peid), "not_found");
  await seed(db);
  assert(!(await dispatchIds(db, RECHECK)).includes(taskNr(w.peid)), "冷卻中");
  await expireCooling(db);
  await seed(db);
  assert((await dispatchIds(db, RECHECK)).includes(taskNr(w.peid)), "not_found は照合済みではない＝冷卻後にまた派す");
  // withdrawn_after_filing の欄に変更履歴がある（一覧を見て埋めた）＝照合済み
  await db.query(`INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name) VALUES ('politician_elections', $1, 'withdrawn_after_filing', NULL, 'false'::JSONB, 'test')`, [w.peid]);
  await seed(db);
  assert(!(await dispatchIds(db, RECHECK)).includes(taskNr(w.peid)), "変更履歴あり＝派さない");
  await db.close();
});

Deno.test("withdrawn_filing：withdrawn で withdrawn_after_filing が空。candidacy（同じ withdrawn＋true/false）の落庫で空欄が埋まり收回；審議中の答えがある間は重ねて派さない", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const u = await addCand(db, "伊藤三郎", "いとうさぶろう", "withdrawn", { status_date: "2027-03-20" });
  await clock(db, NOTICE);
  await seed(db);
  assertEquals(await dispatchIds(db, RECHECK), [taskFiling(u.peid)]);
  const d = (await dispatches(db, RECHECK))[0];
  assertEquals([d.target.kind, d.opened_by?.arm, d.task_type], ["withdrawn_filing", "withdrawn_filing", "not_running_recheck"]);
  assert(d.what_we_need.includes("withdrawn_after_filing") && d.what_we_need.includes("candidacy_status=withdrawn"));
  // 審議中の答え（pending）がある間は派さない
  const pend = await submit(db, "candidacy", { politician_id: u.pid, election_id: E1, candidacy_status: "withdrawn", status_date: "2027-03-20", district_kind: "at_large", withdrawn_after_filing: true },
    { status: "pending", task: taskFiling(u.peid), urls: [LIST_URL] });
  await seed(db);
  assertEquals(await dispatchIds(db, RECHECK), [], "審議中の答えがある");
  await db.exec(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = '${pend}'`);
  await seed(db);
  assertEquals(await dispatchIds(db, RECHECK), [taskFiling(u.peid)], "退件されたらまた派す");
  // 落庫
  const id = await submit(db, "candidacy", { politician_id: u.pid, election_id: E1, candidacy_status: "withdrawn", status_date: "2027-03-20", district_kind: "at_large", withdrawn_after_filing: true },
    { status: "verified", task: taskFiling(u.peid), urls: [LIST_URL] });
  const out = await applyOne(db, id);
  assertEquals([out.status, out.outcome], ["applied", "applied"], JSON.stringify(out));
  const pe = await one<{ candidacy_status: string; withdrawn_after_filing: boolean; status_date: string }>(db,
    `SELECT candidacy_status, withdrawn_after_filing, to_char(status_date, 'YYYY-MM-DD') AS status_date FROM policy_jp.politician_elections WHERE id = $1`, [u.peid]);
  assertEquals(pe, { candidacy_status: "withdrawn", withdrawn_after_filing: true, status_date: "2027-03-20" }, "状態・日付は触らず、空欄だけ埋まる");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'politician_elections' AND record_id = '${u.peid}' AND field = 'withdrawn_after_filing' AND contribution_id = '${id}'`), 1);
  assertEquals((await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id, u.pid);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs r JOIN policy_jp.sources s ON s.id = r.source_id WHERE r.target_id = '${u.peid}' AND s.url = '${LIST_URL}'`) > 0, true, "選管の出典が付く");
  await seed(db);
  assertEquals(await dispatchIds(db, RECHECK), [], "補完した＝缺口が消える");
  assertEquals(await lastClosedReason(db, taskFiling(u.peid)), "filled");
  await db.close();
});

Deno.test("candidacy_source_missing：filed で official 等級の出典がない参選だけ。選管のページを足す candidacy（同じ filed）が unchanged で落庫して收回；declared／official 付きは派さない", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, NOTICE);
  const media = await addCand(db, "山田太郎", "やまだたろう", "filed", { status_date: NOTICE }, [MEDIA]);
  const official = await addCand(db, "佐藤花子", "さとうはなこ", "filed", { status_date: NOTICE }, [LIST_URL]);
  const decl = await addCand(db, "鈴木一郎", "すずきいちろう", "declared", {}, [MEDIA]);
  // 目前狀態の出典（politician_election_status）に official が付いているだけの参選も「出典あり」
  const statusOnly = await addCand(db, "田中二郎", "たなかじろう", "filed", { status_date: NOTICE }, [MEDIA]);
  await db.exec(`DELETE FROM policy_jp.source_refs WHERE target_id = '${statusOnly.peid}'`);
  const sid = (await one<{ id: number }>(db, `INSERT INTO policy_jp.sources (url, source_kind, origin) VALUES ($1, 'official', 'test') RETURNING id::INT AS id`, ["https://www.pref.aichi.lg.jp/senkyo/x.html"])).id;
  await db.query(`INSERT INTO policy_jp.source_refs (source_id, target_table, target_id, role, origin) VALUES ($1, 'politician_election_status', $2, 'primary', 'test')`, [sid, statusOnly.peid]);
  await seed(db);
  assertEquals(await dispatchIds(db, SOURCE), [taskSrc(media.peid)]);
  const d = (await dispatches(db, SOURCE))[0];
  assertEquals([d.task_type, d.opened_by?.arm, d.target.candidacy_status], ["candidacy_source_missing", "candidacy_source_missing", "filed"]);
  assertEquals(d.target.current_sources, [{ url: MEDIA, source_kind: "other" }], "いま付いている出典を見せる");
  assert(d.what_we_need.includes("選挙管理委員会") && d.what_we_need.includes("source_urls") && d.what_we_need.includes("not_found"));
  assert(!(await ids(db)).includes(taskSrc(decl.peid)) && !(await ids(db)).includes(taskSrc(official.peid)) && !(await ids(db)).includes(taskSrc(statusOnly.peid)));
  // 選管のページを足す（同じ filed の再提出＝unchanged、出典だけ足される）
  const out = await applyOne(db, await submit(db, "candidacy", { politician_id: media.pid, election_id: E1, candidacy_status: "filed", status_date: NOTICE, district_kind: "at_large" },
    { status: "verified", task: taskSrc(media.peid), urls: [LIST_URL] }));
  assertEquals([out.status, out.outcome], ["applied", "unchanged"], JSON.stringify(out));
  assertEquals(await dispatchIds(db, SOURCE), [], "落庫（applied）で派工列が即座に收回される（task_dispatches_drop_applied）");
  await seed(db);
  assertEquals(await dispatchIds(db, SOURCE), [], "official の出典が付いた＝缺口が消えたまま（seed が再び積まない）");
  assertEquals(await lastClosedReason(db, taskSrc(media.peid)), "filled");
  await db.close();
});

Deno.test("三つの任務型別の task_id と臂の対応：stale／source_missing は参選 id 1 件、not_running_recheck は照合と filing の 2 形；opened_by.arm で主控台の臂に数えられる", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, NOTICE);
  const s = await addCand(db, "山田太郎", "やまだたろう", "declared");
  const n = await addCand(db, "高橋次郎", "たかはしじろう", "withdrawn", { withdrawn_after_filing: false, status_date: "2027-03-20" });
  const f = await addCand(db, "伊藤三郎", "いとうさぶろう", "withdrawn", { status_date: "2027-03-20" });
  const m = await addCand(db, "渡辺四郎", "わたなべしろう", "filed", { status_date: NOTICE }, [MEDIA]);
  await seed(db);
  const got = await rows<{ task_id: string; arm: string }>(db, `SELECT task_id, arm FROM policy_jp.console_dispatch_rows() WHERE task_id LIKE 'auto:%' ORDER BY task_id`);
  const byArm = Object.fromEntries(got.map((x) => [x.task_id, x.arm]));
  assertEquals(byArm[taskStale(s.peid)], "candidate_status_stale");
  assertEquals(byArm[taskNr(n.peid)], "not_running");
  assertEquals(byArm[taskFiling(f.peid)], "withdrawn_filing");
  assertEquals(byArm[taskSrc(m.peid)], "candidacy_source_missing");
  await db.close();
});

// =============================================================================================
// d. 落庫（apply_candidacy の A 期の分岐）
// =============================================================================================
Deno.test("落庫：withdrawn_after_filing は空欄だけ埋める。庫に値があって違う＝conflict（退件・庫は変わらない）／同じ＝unchanged／withdrawn 以外の同じ状態の再提出は従来どおり unchanged", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const u = await addCand(db, "伊藤三郎", "いとうさぶろう", "withdrawn", { status_date: "2027-03-20" });
  const send = (wd: boolean | undefined, o: Record<string, unknown> = {}) => submit(db, "candidacy",
    { politician_id: u.pid, election_id: E1, candidacy_status: "withdrawn", status_date: "2027-03-20", district_kind: "at_large", ...(wd === undefined ? {} : { withdrawn_after_filing: wd }), ...o },
    { status: "verified", urls: [LIST_URL] });
  const wdOf = async () => (await one<{ w: boolean | null }>(db, `SELECT withdrawn_after_filing AS w FROM policy_jp.politician_elections WHERE id = $1`, [u.peid])).w;
  assertEquals((await applyOne(db, await send(undefined))).outcome, "unchanged", "値を書かない再提出は従来どおり unchanged（空のまま）");
  assertEquals(await wdOf(), null);
  assertEquals((await applyOne(db, await send(false))).outcome, "applied");
  assertEquals(await wdOf(), false);
  const same = await applyOne(db, await send(false));
  assertEquals([same.status, same.outcome], ["applied", "unchanged"], "同じ値");
  const diff = await applyOne(db, await send(true));
  assertEquals([diff.status, diff.outcome], ["rejected", "conflict"], JSON.stringify(diff));
  assertEquals(await wdOf(), false, "違う値で上書きしない");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'politician_elections' AND record_id = '${u.peid}' AND field = 'withdrawn_after_filing'`), 1);
  // 値を書かない再提出（空のまま）が false を消さない
  assertEquals((await applyOne(db, await send(undefined))).outcome, "unchanged");
  assertEquals(await wdOf(), false);
  await db.close();
});

// =============================================================================================
// e. 対象の絞り込み・cap・並び
// =============================================================================================
Deno.test("対象：未公開の参選・人物・選挙は派さない；開いていない（鏈が閉じた）選挙は派さない；cap は可派の前 N 件（投票日の近い選挙が先、過ぎた選挙は後ろ）", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "山田太郎", "やまだたろう", "declared");
  const b = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  const c = await addCand(db, "鈴木一郎", "すずきいちろう", "declared");
  await clock(db, NOTICE);
  await seed(db);
  assertEquals((await dispatchIds(db, STALE)).length, 3);
  await db.exec(`UPDATE policy_jp.politician_elections SET review_status = 'pending' WHERE id = '${a.peid}'`);
  await db.exec(`UPDATE policy_jp.politicians SET review_status = 'pending' WHERE id = '${b.pid}'`);
  await seed(db);
  assertEquals(await dispatchIds(db, STALE), [taskStale(c.peid)], "参選が未公開・人物が未公開は派さない");
  await db.exec(`UPDATE policy_jp.politician_elections SET review_status = 'published' WHERE id = '${a.peid}'`);
  await db.exec(`UPDATE policy_jp.politicians SET review_status = 'published' WHERE id = '${b.pid}'`);
  await db.exec(`UPDATE policy_jp.elections SET review_status = 'pending' WHERE id = '${E1}'`);
  await seed(db);
  assertEquals(await dispatchIds(db, STALE), [], "選挙が未公開＝鏈が開いていない");
  await db.exec(`UPDATE policy_jp.elections SET review_status = 'published' WHERE id = '${E1}'`);
  // cap＝1：近い選挙（E1）が先、投票日が過ぎた選挙は後ろ
  const past = "2027-04-05"; // 今日（04-08）より前に投票が済んだ選挙
  const e0 = await openElectionWithRegion(db, "232025", past, { notice: "2027-03-20" });
  const old = await addCand(db, "古い人", "ふるいひと", "declared", {}, [ELECTION_URL], e0);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = params || '{"cap":1}'::JSONB WHERE activity = 'candidate_status_stale' AND priority IS NULL`);
  const rowsCap = await rows<{ task_id: string }>(db, `SELECT task_id FROM policy_jp.contribution_auto_tasks_candidate_status_stale()`);
  assertEquals(rowsCap.length, 1);
  assert(rowsCap[0].task_id.startsWith("auto:candidate_status_stale:") && rowsCap[0].task_id.includes(E1), "投票日が過ぎた選挙より、これから投票の選挙が先");
  await db.exec(`UPDATE policy_jp.activity_rules SET params = params || '{"cap":200}'::JSONB WHERE activity = 'candidate_status_stale' AND priority IS NULL`);
  assertEquals((await rows(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_candidate_status_stale()`)).length, 4, "cap 200 なら全員（窓の判定は総表側）");
  await seed(db);
  assert(!(await dispatchIds(db, STALE)).includes(taskStale(old.peid)), "投票日が過ぎた選挙の任務は窓（until polling）で開かない");
  await db.close();
});

Deno.test("cap と窓の両立：窓が閉じている選挙の参選が cap の枠を食って、窓が開いている選挙を締め出さない", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const e0 = await openElectionWithRegion(db, "232025", "2027-04-05", { notice: "2027-03-20" });
  const a = await addCand(db, "山田太郎", "やまだたろう", "declared");
  for (let i = 0; i < 3; i++) await addCand(db, `古い${i}`, `ふるい${i === 0 ? "あ" : i === 1 ? "い" : "う"}`, "declared", {}, [ELECTION_URL], e0);
  await clock(db, NOTICE);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = params || '{"cap":2}'::JSONB WHERE activity = 'candidate_status_stale' AND priority IS NULL`);
  await seed(db);
  assert((await dispatchIds(db, STALE)).includes(taskStale(a.peid)), "これから投票の選挙の参選が、投票が済んだ選挙の 3 件に押し出されない");
  await db.close();
});

// =============================================================================================
// f. 文字守門
// =============================================================================================
Deno.test("文字守門：総表＝緊接在前一版（20261010060000）に UNION 4 行だけ足した；臂名は末尾に 4 つ；chain_step_rank は WHEN 3 行（機械置換＋還原驗證）", () => {
  const prev = fnText(PREV_POLICY, TOTAL);
  const now = fnText(MIG_SQL, TOTAL);
  const added = ARMS.map((a) => `  UNION ALL SELECT '${a}' AS arm, t.* FROM policy_jp.contribution_auto_tasks_${a}() t\n`).join("");
  assertEquals(mutate(now, added, ""), prev, "総表は UNION 4 行以外、一字も違わない");
  const tampered = mutate(now, "'chain_gate', CASE WHEN o.after_step IS NOT NULL", "'chain_gatex', CASE WHEN o.after_step IS NOT NULL");
  assertNotEquals(mutate(tampered, added, ""), prev, "還原驗證：本体を 1 字変えれば赤くなる");
  const names = (sql: string) => [...fnText(sql, "policy_jp.activity_arm_names").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(names(MIG_SQL), [...names(PREV_POLICY), ...ARMS]);
  const rankPrev = fnText(PREV_POLICY, "policy_jp.chain_step_rank");
  const rankNow = fnText(MIG_SQL, "policy_jp.chain_step_rank");
  const w3 = "                  WHEN 'candidate_status_stale' THEN 4\n                  WHEN 'not_running_recheck' THEN 4\n                  WHEN 'candidacy_source_missing' THEN 4\n";
  assertEquals(mutate(rankNow, w3, ""), rankPrev);
});

Deno.test("文字守門：apply_candidacy＝20261010120000 の版に登記した 2 か所（>>> A 期 … <<< A 期）を足しただけ。ほかの分岐は一字も変えない", () => {
  const prev = fnText(PREV_KANA, "policy_jp.apply_candidacy");
  const now = fnText(MIG_SQL, "policy_jp.apply_candidacy");
  const blocks = [...now.matchAll(/      -- >>> A 期[\s\S]*?      -- <<< A 期\n/g)];
  assertEquals(blocks.length, 2, "A 期の分岐はちょうど 2 か所");
  let stripped = now;
  for (const b of blocks) stripped = stripped.replace(b[0], "");
  assertEquals(stripped, prev);
  assertNotEquals(now, prev);
  // 還原驗證：登記外の 1 字の変更は赤くなる
  assertNotEquals(stripped.replace("v_status IN ('elected', 'not_elected') AND v_date < e.election_date", "v_status IN ('elected') AND v_date < e.election_date"), prev);
});

Deno.test("文字守門：臂は読み取りだけ（INSERT／UPDATE／DELETE なし）、public.／ditrust を引かない、新しい関数は search_path を釘付け、日付を臂の中で比べない（窓は規則）", () => {
  const sql = MIG_SQL.replace(/--[^\n]*/g, "");
  assert(!/public\./.test(sql), "public. を引かない");
  assert(!/ditrust/.test(sql), "ditrust を引かない");
  for (const a of ARMS) {
    const arm = fnText(MIG_SQL, `policy_jp.contribution_auto_tasks_${a}`);
    assert(!/\b(INSERT|UPDATE|DELETE)\b/.test(arm), `${a} は唯讀`);
    assert(arm.includes("SET search_path = policy_jp, pg_temp"), `${a} は search_path を釘付けにする`);
    // 窓の日付（告示日・投票日との比較）は規則に書く。臂の中の election_date は並び順（過ぎた選挙を後ろへ）にだけ使う
    assert(!/>=\s*s\.notice_date|<=\s*s\.election_date|s\.election_date\s*>=|s\.notice_date\s*<=/.test(arm), `${a} の WHERE に告示日・投票日の比較を書かない`);
  }
  for (const fn of ["chain_candidacy_records", "candidacy_has_official_source", "apply_candidacy"]) {
    assert(fnText(MIG_SQL, `policy_jp.${fn}`).includes("SET search_path = policy_jp, pg_temp"), `${fn} の search_path`);
  }
});

// =============================================================================================
// g. 還原驗證・自我檢查・冪等・權限
// =============================================================================================
/** 鍵になる探査：四つの性質を 1 回で測る */
async function probe(db: Db) {
  await openElectionWithRegion(db, ICHI, POLLING);
  const filedOfficial = await addCand(db, "佐藤花子", "さとうはなこ", "filed", { status_date: NOTICE }, [LIST_URL]).catch(() => null);
  const decl = await addCand(db, "山田太郎", "やまだたろう", "declared");
  const wdFalse = await addCand(db, "高橋次郎", "たかはしじろう", "withdrawn", { withdrawn_after_filing: false, status_date: "2027-03-20" });
  const wdNull = await addCand(db, "伊藤三郎", "いとうさぶろう", "withdrawn", { status_date: "2027-03-20" });
  const filedMedia = await addCand(db, "渡辺四郎", "わたなべしろう", "filed", { status_date: NOTICE }, [MEDIA]).catch(() => null);
  await clock(db, addDays(NOTICE, -1));
  await seed(db);
  const closedBeforeNotice = (await ids(db)).length === 0 && (await dispatchIds(db, RECHECK)).length === 0;
  await clock(db, NOTICE);
  await seed(db);
  const open = await ids(db);
  const staleOnlyUnfiled = open.includes(taskStale(decl.peid)) && !(filedOfficial && open.includes(taskStale(filedOfficial.peid))) && !(filedMedia && open.includes(taskStale(filedMedia.peid)));
  await check(db, taskNr(wdFalse.peid), "confirmed");
  await expireCooling(db);
  await seed(db);
  const confirmedStaysGone = !(await dispatchIds(db, RECHECK)).includes(taskNr(wdFalse.peid)) && (await dispatchIds(db, RECHECK)).includes(taskFiling(wdNull.peid));
  const srcOpen = await dispatchIds(db, SOURCE);
  const sourceOnlyUnofficial = filedMedia != null && srcOpen.includes(taskSrc(filedMedia.peid)) && !(filedOfficial && srcOpen.includes(taskSrc(filedOfficial.peid)));
  const out = await applyOne(db, await submit(db, "candidacy", { politician_id: wdNull.pid, election_id: E1, candidacy_status: "withdrawn", status_date: "2027-03-20", district_kind: "at_large", withdrawn_after_filing: true },
    { status: "verified", urls: [LIST_URL] }));
  const wd = (await one<{ w: boolean | null }>(db, `SELECT withdrawn_after_filing AS w FROM policy_jp.politician_elections WHERE id = $1`, [wdNull.peid])).w;
  const fills = out.outcome === "applied" && wd === true;
  return { closedBeforeNotice, staleOnlyUnfiled, confirmedStaysGone, sourceOnlyUnofficial, fills };
}
Deno.test("行為の還原驗證（臂の鍵になる行・規則の窓・落庫の分岐）：本物は五つの性質がすべて通り、1 行ずつ壊すと対応する性質だけが赤くなる", async () => {
  const run = async (patch: (sql: string) => string, post = "") => {
    const db = await migratedDb({ before: MIG_FILE });
    await db.exec(patch(MIG_SQL));
    if (post) await db.exec(post);
    const r = await probe(db);
    await db.close();
    return r;
  };
  const good = { closedBeforeNotice: true, staleOnlyUnfiled: true, confirmedStaysGone: true, sourceOnlyUnofficial: true, fills: true };
  assertEquals(await run((s) => s), good, "本物");
  assertEquals((await run((s) => s, `UPDATE policy_jp.activity_rules SET from_kind = NULL, from_offset = 0 WHERE activity = 'candidate_status_stale' AND priority IS NULL`)).closedBeforeNotice, false,
    "規則から『告示日起』を拿掉すると、告示前から開いてしまう");
  assertEquals((await run((s) => mutate(s, "AND s.candidacy_status IN ('considering', 'declared')", "AND true"))).staleOnlyUnfiled, false, "stale の対象を絞る行を外すと、届出済みにも派す");
  assertEquals((await run((s) => mutate(s, "AND tc.outcome = 'confirmed')", "AND tc.outcome = 'zzz')"))).confirmedStaysGone, false, "照合済みの除外を外すと、冷卻が過ぎてまた派す");
  assertEquals((await run((s) => mutate(s, "AND NOT policy_jp.candidacy_has_official_source(s.politician_election_id)", "AND policy_jp.candidacy_has_official_source(s.politician_election_id)"))).sourceOnlyUnofficial, false,
    "official の出典の判定を反転すると、出典が付いている参選に派してしまう");
  assertEquals((await run((s) => mutate(s, "UPDATE policy_jp.politician_elections SET withdrawn_after_filing = v_wd WHERE id = pe.id;", "NULL;"))).fills, false, "落庫の分岐を壊すと、空欄が埋まらない");
});

Deno.test("自我檢查（還原驗證）：規則の窓・after_step・後備・cap が欠ける／総表の分支・臂名・順位・段の登記が欠ける／anon に渡すと、migration が失敗する；元の SQL は通る", async () => {
  const pre = await migratedDb({ before: MIG_FILE });
  const bad = async (from: string, to: string, why: string) => {
    await assertRejects(() => pre.exec(mutate(MIG_SQL, from, to)), Error, undefined, why);
  };
  await bad(`'{"cap":200,"chain_fallback":{"kind":"announced","offset":0}}'::JSONB`, `'{"cap":200}'::JSONB`, "後備なし");
  await bad(`SELECT a.activity, 'event', 'announced', 0, 'polling', 0, 'announced', 'candidacy',`, `SELECT a.activity, 'event', 'announced', 0, 'polling', 0, 'announced', NULL,`, "after_step なし");
  await bad(`SELECT a.activity, 'event', 'announced', 0, 'polling', 0,`, `SELECT a.activity, 'event', 'announced', -1, 'polling', 0,`, "窓の起点がずれる");
  await bad(`SELECT a.activity, 'event', 'announced', 0, 'polling', 0,`, `SELECT a.activity, 'event', 'announced', 0, 'polling', 1,`, "窓の終点がずれる");
  await bad(`  UNION ALL SELECT 'not_running' AS arm, t.* FROM policy_jp.contribution_auto_tasks_not_running() t\n`, "", "総表の分支が欠ける");
  await bad(`    'withdrawn_filing',\n    'candidacy_source_missing'\n  ]`, `    'withdrawn_filing'\n  ]`, "臂名が欠ける");
  await bad(`                  WHEN 'not_running_recheck' THEN 4\n`, "", "順位が欠ける");
  await bad(`  ('withdrawn_filing', 3, '退選の届出前後（告示後）'),\n`, "", "主控台の段が欠ける");
  await bad(`  policy_jp.contribution_auto_tasks_withdrawn_filing(), policy_jp.contribution_auto_tasks_candidacy_source_missing()
  TO service_role;`, `  policy_jp.contribution_auto_tasks_withdrawn_filing(), policy_jp.contribution_auto_tasks_candidacy_source_missing()
  TO service_role, anon;`, "anon に渡す");
  await pre.exec(MIG_SQL);
  await pre.close();
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則・優先層規則・主控台登記が増えない", async () => {
  const db = await freshDb();
  const before = [await count(db, `SELECT 1 FROM policy_jp.activity_rules`), await count(db, `SELECT 1 FROM policy_jp.console_arm_stage_map`)];
  await db.exec(MIG_SQL);
  assertEquals([await count(db, `SELECT 1 FROM policy_jp.activity_rules`), await count(db, `SELECT 1 FROM policy_jp.console_arm_stage_map`)], before);
  await db.close();
});

Deno.test("権限：新しい関数は anon／authenticated が呼べない（service_role は呼べる）", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const a of ARMS) await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.contribution_auto_tasks_${a}()`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.chain_candidacy_records()`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.candidacy_has_official_source('x')`), Error, "permission denied");
  }
  for (const a of ARMS) assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_${a}()`))[0].n, 0);
  assertEquals(await one<{ n: number }>(shared, `SELECT 1 AS n`), { n: 1 });
});
