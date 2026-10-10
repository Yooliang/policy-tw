/**
 * 日本站「選舉鏈」第 2 步：參選人有誰（migration 20261010040000_policy_jp_chain_candidacy.sql）。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts，照檔名排序，不寫死清單）；時鐘用 `SET app.activity_today`，
 * 整條流程走 seed_auto_task_queue()＋task_dispatches／gap_events。
 *
 *   a. 結構：步驟清單六步、臂名清單三處一起加（總表 UNION・臂名・規則）、規則的 after_step＋後備里程碑、優先層規則、chain_step_rank
 *   b. 鏈的三個情境（假時鐘＋seed）：1. 前一步完成才開  2. 前一步卡住但後備里程碑（告示日前 30 天）到了照開  3. 前一步重新變成未完成時，已開的不收回
 *      另：窗口（投票日當天止）、優先層、完成合図（no_change confirmed／not_found 冷卻）、冷卻過了再開
 *   c. 進度視圖：roster（名簿確認）、candidacy（已有參選紀錄）
 *   d. 告示日里程碑：elections.notice_date 併進 election_milestones_all（表裡有整場 announced 時以表為準）
 *   e. DB CHECK：contributions.contribution_type 收 candidacy（還原驗證：沒有這支 migration 的庫會擋）
 *   f. 落庫 apply_candidacy：新人建檔・同一人比對・狀態轉移・日期規則・選挙区規則・得票數退件・出處・履歷・冪等
 *   g. 共識：candidacy 目標 3、退件 −3、要有 2 個以上不同來源網段（Jev 把目標降到 2 時照樣要兩個網段）
 *   h. 文字守門：總表＝緊接在前一版剛好多一行 UNION（機械替換＋還原驗證）；臂唯讀；沒有 public./ditrust 引用；函式釘 search_path
 *   i. 權限：新函式 anon／authenticated 不能碰
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import { JP_APPLY_TYPES } from "./jp/apply-contribution.ts";
import { JP_CONTRIBUTION_TYPES } from "./jp/contribution-schema.ts";
import {
  addDays, applyOne, asRole, check, clock, count, dispatches, dispatchIds, events, expireCooling, fillStats, freshDb, insertElection, insertLg, ICHI, ELECTION_URL,
  migratedDb, mutate, one, openElectionWithRegion, progress, readMig, rows, seed, statusOf, stepsDone, submit, tryIn, vote, sourceId, CHIKUSA, AICHI,
} from "./policy-jp-chain-db.ts";

const MIG_FILE = "20261010040000_policy_jp_chain_candidacy.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV_CHAIN_SQL = await readMig("20261009250400_policy_jp_election_chain.sql");
const ROSTER = ["roster_check"];
const POLLING = "2027-04-25";
const NOTICE = "2027-04-08"; // insertElection の既定（投票日の 17 日前）
const E1 = `${POLLING}_mayor_${ICHI}`;
const TASK = `auto:roster_check:${E1}`;
const TOTAL = "policy_jp.contribution_auto_tasks_arms";

const shared = await freshDb();

const candPayload = (o: Record<string, unknown> = {}) => ({
  election_id: E1, name: "山田太郎", kana: "やまだたろう", candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large", ...o,
});
const submitCand = (db: Parameters<typeof submit>[0], o: Record<string, unknown> = {}, opts: Parameters<typeof submit>[3] = {}) =>
  submit(db, "candidacy", candPayload(o), { status: "verified", urls: [ELECTION_URL], ...opts });

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：步驟清單六步；臂名清單・總表・規則三處一起加；規則有 after_step 與後備里程碑；優先層規則；步驟順位", async () => {
  assertEquals((await one<{ s: string[] }>(shared, `SELECT policy_jp.election_chain_steps() AS s`)).s,
    ["discovery", "local_government", "regional_stats", "region", "roster", "candidacy"]);
  assert((await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a.includes("roster_check"), "臂名清單");
  const total = fnText(await readMig(MIG_FILE), TOTAL);
  assert(total.includes("contribution_auto_tasks_roster_check()"), "總表有 roster_check 的 UNION 分支");
  const rule = await one<{ after_step: string; params: Record<string, unknown>; until_kind: string; until_offset: number; window_kind: string }>(shared,
    `SELECT after_step, params, until_kind, until_offset, window_kind FROM policy_jp.activity_rules WHERE activity = 'roster_check' AND priority IS NULL`);
  assertEquals(rule.after_step, "region");
  assertEquals(rule.params, { cap: 200, chain_fallback: { kind: "announced", offset: -30 } });
  assertEquals([rule.window_kind, rule.until_kind, rule.until_offset], ["event", "polling", 0]);
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:roster_check' AND priority IN (1, 3)`), 2);
  const rank = (id: string, t: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, t]).then((x) => x.r);
  assertEquals(await rank("auto:roster_check:x", "roster_check"), 4);
  assertEquals(await rank("auto:regional_stats_missing:x", "regional_stats_missing"), 3);
  assertEquals(await rank("auto:something_new:x", "something_new"), 9, "沒登記的 auto 型別仍排最後");
  assertEquals(await rank("11111111-2222-4333-8444-555555555555", "roster_check"), 0, "手動任務仍是 0");
  // TS／SQL 對齊（全 migration 適用後）：落庫型別清單、DB CHECK 收的型別＝TS 的型別清單
  assertEquals((await one<{ t: string[] }>(shared, `SELECT policy_jp.apply_types() AS t`)).t, [...JP_APPLY_TYPES]);
  const chk = (await one<{ d: string }>(shared, `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check'`)).d;
  assertEquals(new Set([...chk.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])), new Set(JP_CONTRIBUTION_TYPES), "DB CHECK＝TS 的型別清單（漏了＝代理交件全被擋而測試全綠）");
});

// =============================================================================================
// b. 鏈的三個情境
// =============================================================================================
Deno.test("情境 1　前一步完成才開：地區資料（統計）沒補完，名簿任務擋著；補完之後下一輪 seed 才開，opened_by 記 via=done", async () => {
  const db = await freshDb();
  await insertElection(db, ICHI, POLLING);
  await clock(db, "2027-02-01");
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [], "地區資料沒完成、後備（2027-03-09）還沒到＝不開");
  assertEquals((await stepsDone(db, E1)).region, false);
  await fillStats(db, ICHI);
  assertEquals((await stepsDone(db, E1)).region, true);
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK]);
  const [d] = await dispatches(db, ROSTER);
  assertEquals(d.opened_by?.chain_gate, { after_step: "region", via: "done" });
  assertEquals(d.target.chain_step, "roster");
  assertEquals(d.target.chain_lg_code, ICHI);
  const ev = await events(db, TASK);
  assertEquals(ev.map((e) => e.event), ["opened"]);
  assertEquals(ev[0].detail.chain_gate, { after_step: "region", via: "done" });
  await db.close();
});

Deno.test("情境 2　前一步卡住但後備里程碑（告示日前 30 天）到了照開：前一天擋、當天以 via=fallback 開", async () => {
  const db = await freshDb();
  await insertElection(db, ICHI, POLLING); // 統計不補＝region 永遠不 done
  const fallbackDay = addDays(NOTICE, -30); // 2027-03-09
  await clock(db, addDays(fallbackDay, -1));
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [], "後備前一天＝擋著");
  await clock(db, fallbackDay);
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK], "後備當天＝開");
  assertEquals((await dispatches(db, ROSTER))[0].opened_by?.chain_gate, { after_step: "region", via: "fallback" });
  assertEquals((await stepsDone(db, E1)).region, false, "前一步確實還沒完成（是後備開的，不是前一步完成）");
  await db.close();
});

Deno.test("情境 2 補：告示日不明（notice_date 空）＝沒有告示日里程碑，後備不會到；整場 announced 里程碑列（表）可補上，且以表為準", async () => {
  const db = await freshDb();
  const eid = await insertElection(db, ICHI, POLLING, { notice: null });
  await clock(db, "2027-04-20");
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [], "沒有告示日＝後備不到");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.election_milestones_all WHERE election_id = '${eid}' AND kind = 'announced'`), 0);
  // 維護者在里程碑表補上告示日（整場）
  await db.query(`INSERT INTO policy_jp.election_milestones (election_id, kind, on_date, basis, status) VALUES ($1, 'announced', DATE '2027-04-08', 'official', 'announced')`, [eid]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.election_milestones_all WHERE election_id = '${eid}' AND kind = 'announced' AND origin = 'table'`), 1);
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [`auto:roster_check:${eid}`]);
  assertEquals((await dispatches(db, ROSTER))[0].opened_by?.chain_gate, { after_step: "region", via: "fallback" });
  await db.close();
});

Deno.test("情境 3　前一步重新變成未完成時，已開的下一步不收回（sticky）：統計補完 → 名簿任務開 → 統計被拿掉（region 又未完成）→ 任務照開", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-02-01");
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK]);
  await db.exec(`DELETE FROM policy_jp.regional_stats WHERE lg_code = '${ICHI}'`);
  assertEquals((await stepsDone(db, E1)).region, false, "前一步又變成未完成");
  await seed(db);
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK], "已開的不收回");
  assertEquals((await events(db, TASK)).map((e) => e.event), ["opened"], "沒有 closed 事件");
  await db.close();
});

Deno.test("窗口：投票日當天還派、翌日收回（記 window）；新建的鏈在投票日後不再開名簿任務", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, POLLING);
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK], "投票日當天仍開");
  await clock(db, addDays(POLLING, 1));
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [], "翌日收回");
  const ev = await events(db, TASK);
  assertEquals(ev.at(-1)?.event, "closed");
  assertEquals(ev.at(-1)?.reason, "window");
  await db.close();
});

Deno.test("優先層：投票日前 60 天內＝前段（1）、61～180 天＝預設層、181 天以上＝後段（3）；步驟順位排在統計之後", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const prio = async (day: string) => {
    await clock(db, day);
    await seed(db);
    return (await dispatches(db, ROSTER))[0]?.priority;
  };
  assertEquals(await prio(addDays(POLLING, -59)), 1);
  const mid = await prio(addDays(POLLING, -120));
  assertEquals(mid, (await one<{ id: number }>(db, `SELECT id::INT FROM policy_jp.task_priority_tiers WHERE is_default`)).id);
  assertEquals(await prio(addDays(POLLING, -200)), 3);
  await db.close();
});

Deno.test("完成合図：no_change の confirmed／not_found が冷卻中＝roster 完成・任務を收回；unreachable は完成ではない；冷卻が過ぎれば未完成に戻りもう一度開く", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-20");
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK]);
  assertEquals((await stepsDone(db, E1)).roster, false);

  await check(db, TASK, "unreachable");
  assertEquals((await stepsDone(db, E1)).roster, false, "unreachable は『名簿を確かめた』ではない");
  await db.exec(`DELETE FROM policy_jp.task_checks`);

  await check(db, TASK, "confirmed");
  assertEquals((await stepsDone(db, E1)).roster, true);
  assertNotEquals((await progress(db, E1)).find((p) => p.step === "roster")!.done_at, null);
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [], "冷卻中は派さない（task_unavailable）");
  assertEquals((await events(db, TASK)).at(-1)?.event, "closed");

  await expireCooling(db);
  assertEquals((await stepsDone(db, E1)).roster, false, "冷卻が過ぎたら未完成に戻る（新しい届出を拾う）");
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK], "もう一度開く");
  assertEquals((await events(db, TASK)).map((e) => e.event), ["opened", "closed", "reopened"]);

  await db.exec(`DELETE FROM policy_jp.task_checks`);
  await check(db, TASK, "not_found");
  assertEquals((await stepsDone(db, E1)).roster, true, "名簿がまだ公表されていない（not_found）も完成");
  await db.close();
});

Deno.test("臂の中身：告示前は表明まで・告示後は届出（phase・説明文）、登録済みの人の一覧、cap、得票数は収めない旨", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-20");
  await seed(db);
  const pre = (await dispatches(db, ROSTER))[0];
  assertEquals(pre.target.phase, "pre_notice");
  assertEquals(pre.target.notice_date, NOTICE);
  assertEquals(pre.target.ours_count, 0);
  assertEquals(pre.target.lg_code, ICHI);
  assert(pre.what_we_need.includes("告示前の段階") && pre.what_we_need.includes("declared") && pre.what_we_need.includes("contribution_type=candidacy"));
  assert(pre.what_we_need.includes("得票数・得票率は記録しません"));
  assertEquals(pre.region, "愛知県");

  const c1 = await submitCand(db);
  await applyOne(db, c1);
  await clock(db, addDays(NOTICE, 1));
  await db.exec(`DELETE FROM policy_jp.task_dispatches WHERE task_type = 'roster_check'`);
  await seed(db);
  const post = (await dispatches(db, ROSTER))[0];
  assertEquals(post.target.phase, "post_notice");
  assertEquals(post.target.ours_count, 1);
  assert(post.what_we_need.includes("告示後の段階") && post.what_we_need.includes("filed"));
  const ours = post.target.ours as Array<{ name: string; kana: string; candidacy_status: string }>;
  assertEquals(ours.map((o) => [o.name, o.kana, o.candidacy_status]), [["山田太郎", "やまだたろう", "declared"]]);

  // cap：params.cap を 0 にすると臂は 1 件も出さない（無音で消える事故は規則の自己検査で防ぐが、値としての意味は cap 件まで）
  await db.exec(`UPDATE policy_jp.activity_rules SET params = params || '{"cap":0}'::JSONB WHERE activity = 'roster_check' AND priority IS NULL`);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_roster_check()`), 0);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = params - 'cap' WHERE activity = 'roster_check' AND priority IS NULL`);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_roster_check()`), 0, "cap がない規則＝臂は出さない");
  await db.close();
});

Deno.test("臂の対象：上線済みの選舉だけ（pending の選舉・等團體落庫の選舉交件・國政は出さない）", async () => {
  const db = await freshDb();
  await insertElection(db, ICHI, POLLING, { status: "pending" });
  await clock(db, "2027-03-20");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_roster_check()`), 0, "pending の選挙は chain_open_elections に入らない");
  const e2 = await insertElection(db, CHIKUSA, "2027-04-25"); // 名古屋市千種区（区長）
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_roster_check()`), 1);
  assertEquals((await rows<{ task_id: string }>(db, `SELECT task_id FROM policy_jp.contribution_auto_tasks_roster_check()`))[0].task_id, `auto:roster_check:${e2}`);
  await db.close();
});

// =============================================================================================
// c. 進度視圖
// =============================================================================================
Deno.test("進度視圖：candidacy＝已上線の declared 以上の参選紀錄が 1 件以上（considering・退選は数えない）；roster と候補者は独立；done_at は done のときだけ", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-20");
  const steps = (await progress(db, E1)).map((p) => p.step);
  assertEquals(steps, ["candidacy", "discovery", "local_government", "region", "regional_stats", "roster"]);
  assertEquals((await stepsDone(db, E1)).candidacy, false);
  const c1 = await submitCand(db, { candidacy_status: "withdrawn" , withdrawn_after_filing: false });
  await applyOne(db, c1);
  assertEquals((await stepsDone(db, E1)).candidacy, false, "退選だけでは『参選人がいる』ではない");
  const c1b = await submitCand(db, { name: "田中次郎", kana: "たなかじろう", candidacy_status: "considering", status_date: "2027-02-20" });
  await applyOne(db, c1b);
  assertEquals((await stepsDone(db, E1)).candidacy, false, "出馬検討（considering）だけでは啟動しない");
  const c2 = await submitCand(db, { name: "佐藤花子", kana: "さとうはなこ" });
  await applyOne(db, c2);
  assertEquals((await stepsDone(db, E1)).candidacy, true);
  const rowsAll = await progress(db, E1);
  for (const r of rowsAll) assertEquals(r.done_at !== null, r.done, `${r.step} の done_at は done のときだけ`);
  await db.close();
});

// =============================================================================================
// e. DB CHECK
// =============================================================================================
Deno.test("DB CHECK：contributions.contribution_type は candidacy を收める（還原驗證：この migration の前の庫は擋ぐ）。知らない型別は擋ぐ", async () => {
  const insert = (db: Awaited<ReturnType<typeof freshDb>>, type: string) =>
    submit(db, type, candPayload(), { urls: [ELECTION_URL] });
  const before = await migratedDb({ before: MIG_FILE });
  await assertRejects(() => insert(before, "candidacy"), Error, "policy_jp_contributions_type_check");
  await before.close();
  const db = await freshDb();
  await insert(db, "candidacy");
  await assertRejects(() => insert(db, "bogus_type"), Error, "policy_jp_contributions_type_check");
  await db.close();
});

// =============================================================================================
// d. 告示日里程碑
// =============================================================================================
Deno.test("告示日：elections.notice_date が整場の announced 里程碑として併進（status は今日との前後）、notice_date が空なら列なし、表に整場の announced があれば表が勝つ", async () => {
  const db = await freshDb();
  const a = await insertElection(db, ICHI, POLLING);
  const b = await insertElection(db, CHIKUSA, POLLING, { notice: null });
  await clock(db, "2027-03-20");
  const m = (id: string) => rows<{ kind: string; on_date: string; status: string; origin: string; election_type: string | null }>(db,
    `SELECT kind, on_date::TEXT, status, origin, election_type FROM policy_jp.election_milestones_all WHERE election_id = $1 AND kind = 'announced'`, [id]);
  assertEquals(await m(a), [{ kind: "announced", on_date: NOTICE, status: "announced", origin: "elections", election_type: null }]);
  assertEquals(await m(b), []);
  await clock(db, "2027-04-09");
  assertEquals((await m(a))[0].status, "done");
  await db.query(`INSERT INTO policy_jp.election_milestones (election_id, kind, on_date, basis, status) VALUES ($1, 'announced', DATE '2027-04-10', 'override', 'announced')`, [a]);
  assertEquals((await m(a)).map((r) => [r.origin, r.on_date]), [["table", "2027-04-10"]]);
  await db.close();
});

// =============================================================================================
// f. 落庫 apply_candidacy
// =============================================================================================
async function ready() {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  return db;
}

Deno.test("落庫：新しい人は politicians＋politician_elections を作り、出処（参選・目前狀態・人物）と履歴を残し、applied_politician_id を付ける。task_id の派工列は收回しない（一題多份）", async () => {
  const db = await ready();
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK]);
  const c = await submitCand(db, { birth_year: 1970 }, { task: TASK });
  const out = await applyOne(db, c);
  assertEquals([out.status, out.outcome, out.table_name], ["applied", "applied", "politician_elections"]);
  const p = await one<{ id: string; name: string; kana: string; birth_year: number; review_status: string }>(db, `SELECT id, name, kana, birth_year, review_status FROM policy_jp.politicians`);
  assertEquals([p.name, p.kana, p.birth_year, p.review_status], ["山田太郎", "やまだたろう", 1970, "published"]);
  const pe = await one<Record<string, unknown>>(db, `SELECT * FROM policy_jp.politician_elections`);
  assertEquals(pe.id, `${p.id}:${E1}:at_large`);
  assertEquals([pe.candidacy_status, pe.status_date instanceof Date ? (pe.status_date as Date).toISOString().slice(0, 10) : pe.status_date, pe.district_kind, pe.district_name, pe.review_status],
    ["declared", "2027-03-01", "at_large", null, "published"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'politician_elections' AND target_id = '${pe.id}' AND role = 'primary'`), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'politician_election_status' AND target_id = '${pe.id}' AND role = 'primary'`), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'politicians' AND target_id = '${p.id}'`), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE contribution_id = '${c}' AND table_name IN ('politicians', 'politician_elections') AND field = '*'`), 2);
  assertEquals((await one<{ applied_politician_id: string; status: string }>(db, `SELECT applied_politician_id, status FROM policy_jp.contributions WHERE id = '${c}'`)),
    { applied_politician_id: p.id, status: "applied" });
  // roster_check は一人ずつ candidacy で出す一題多份：最初の 1 筆が落庫しても派工列は收回しない（收回は no_change の落庫か、seed の缺口判斷）
  assertEquals(await dispatchIds(db, ROSTER), [TASK], "candidacy が applied でも名簿の任務は残る");
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK]);
  assertEquals((await events(db, TASK)).map((e) => e.event), ["opened"], "closed が入っていない");
  // 完成の合図（no_change の落庫）で收回される
  const nc = await submit(db, "no_change", { task_id: TASK, outcome: "confirmed", checked_urls: [ELECTION_URL], finding: "名簿を確認し、全員が登録済みだった" }, { status: "verified", task: TASK, urls: [ELECTION_URL] });
  assertEquals((await applyOne(db, nc)).status, "applied");
  assertEquals(await dispatchIds(db, ROSTER), [], "no_change confirmed で收回");
  await db.close();
});

async function dropProbe(db: Awaited<ReturnType<typeof freshDb>>) {
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  await seed(db);
  await applyOne(db, await submitCand(db, {}, { task: TASK }));
  return (await dispatchIds(db, ROSTER)).length;
}

Deno.test("還原驗證：觸發器の WHEN から『candidacy×auto:roster_check』の除外を外すと、最初の candidacy で任務が收回される（修正前の挙動）", async () => {
  const ok = await freshDb();
  assertEquals(await dropProbe(ok), 1);
  await ok.close();
  const db = await migratedDb({ before: MIG_FILE });
  await db.exec(mutate(MIG_SQL, "AND NOT (NEW.contribution_type = 'candidacy' AND NEW.task_id LIKE 'auto:roster_check:%'))", ")"));
  assertEquals(await dropProbe(db), 0, "除外がなければ收回される");
  await db.close();
});

Deno.test("落庫：filed の告示日は里程碑の announced を読む（elections.notice_date ではなく、里程碑表の上書きが効く）", async () => {
  const db = await ready(); // 告示日 2027-04-08
  const filed = (date: string) => submitCand(db, { candidacy_status: "filed", status_date: date });
  assertEquals((await applyOne(db, await filed("2027-04-05"))).outcome, "invalid", "告示日前の届出");
  await db.query(`INSERT INTO policy_jp.election_milestones (election_id, kind, on_date, basis, status) VALUES ($1, 'announced', DATE '2027-04-01', 'override', 'announced')`, [E1]);
  const ok = await applyOne(db, await filed("2027-04-05"));
  assertEquals([ok.status, ok.outcome], ["applied", "applied"], "里程碑表で告示日が 04-01 に上書きされていれば 04-05 の届出は通る");
  const early = await applyOne(db, await submitCand(db, { name: "佐藤花子", kana: "さとうはなこ", candidacy_status: "filed", status_date: "2027-03-30" }));
  assertEquals(early.outcome, "invalid");
  assert(early.message!.includes("2027-04-01"), early.message);
  await db.close();
});

Deno.test("落庫：状態が変わると『目前狀態の出處』は新しい出處が主要になり、古い主要は佐證に降りる（同じ出處を使い回しても主要は 1 つ）", async () => {
  const db = await ready();
  const A = "https://www.city.ichinomiya.aichi.jp/hyomei/", B = "https://www.city.ichinomiya.aichi.jp/senkyo/todokede/";
  await applyOne(db, await submitCand(db, {}, { urls: [A] }));
  const peid = (await one<{ id: string }>(db, `SELECT id FROM policy_jp.politician_elections`)).id;
  const refs = () => rows<{ url: string; role: string }>(db, `SELECT s.url, r.role FROM policy_jp.source_refs r JOIN policy_jp.sources s ON s.id = r.source_id WHERE r.target_table = 'politician_election_status' AND r.target_id = $1 ORDER BY s.url`, [peid]);
  assertEquals(await refs(), [{ url: A, role: "primary" }]);
  const out = await applyOne(db, await submitCand(db, { candidacy_status: "filed", status_date: "2027-04-10" }, { urls: [B] }));
  assertEquals(out.outcome, "applied");
  assertEquals(await refs(), [{ url: A, role: "supporting" }, { url: B, role: "primary" }]);
  // 前の出處を使い回して次の状態へ：主要はその出處に戻り、主要は常に 1 つ
  await clock(db, "2027-04-25");
  const out2 = await applyOne(db, await submitCand(db, { candidacy_status: "elected", status_date: "2027-04-25" }, { urls: [A] }));
  assertEquals(out2.outcome, "applied");
  assertEquals(await refs(), [{ url: A, role: "primary" }, { url: B, role: "supporting" }]);
  await db.close();
});

Deno.test("落庫：birth_year は SQL でも 1900～2100 の整数だけ（範囲外・小数・文字は invalid 退件で、CHECK 例外の重試には入らない）", async () => {
  const db = await ready();
  for (const by of [1899, 2101, 1970.5, "1970"]) {
    const id = await submitCand(db, { birth_year: by });
    const out = await applyOne(db, id);
    assertEquals([out.status, out.outcome], ["rejected", "invalid"], String(by));
    assert(out.message!.includes("birth_year"));
    assertEquals((await one<{ retry_count: number }>(db, `SELECT retry_count FROM policy_jp.contributions WHERE id = $1`, [id])).retry_count, 0, "apply_failed の重試に入っていない");
  }
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politicians`), 0);
  assertEquals((await applyOne(db, await submitCand(db, { birth_year: 1900 }))).outcome, "applied", "境界 1900 は通る");
  await db.close();
});

Deno.test("落庫：同じ内容は unchanged（二重に作らない）、政治人物の同一人判定（kana＋団体＋生年）、曖昧は退件、別の団体の同名は別人", async () => {
  const db = await ready();
  const c1 = await submitCand(db, { birth_year: 1970 });
  await applyOne(db, c1);
  const again = await applyOne(db, await submitCand(db, { birth_year: 1970 }));
  assertEquals([again.status, again.outcome], ["applied", "unchanged"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politicians`), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politician_elections`), 1);

  // 同名同読み・同じ団体 → 同一人（生年が空の側は衝突しない）。status 更新は別行
  const upd = await applyOne(db, await submitCand(db, { candidacy_status: "filed", status_date: addDays(NOTICE, 1) }));
  assertEquals([upd.status, upd.outcome], ["applied", "applied"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politicians`), 1);
  // 生年が違えば別人
  const other = await applyOne(db, await submitCand(db, { birth_year: 1985, district_kind: "district", district_name: "北区" }));
  assertEquals(other.status, "applied");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politicians`), 2, "生年 1970 と 1985 は別人");
  // 生年を書かない提出は、同名・同団体の 2 人に当たって特定できない → 退件
  const amb = await applyOne(db, await submitCand(db, { name: "山田太郎", kana: "やまだたろう", district_kind: "district", district_name: "南区" }));
  assertEquals(amb.status, "rejected");
  assert(amb.message!.includes("特定できない"), amb.message);
  // 別の団体（愛知県）で同名・同読みの人は別人として作られる
  await insertLg(db, CHIKUSA);
  const e2 = await insertElection(db, CHIKUSA, "2027-05-30");
  const cross = await applyOne(db, await submitCand(db, { election_id: e2, status_date: "2027-04-01" }));
  assertEquals(cross.status, "applied");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politicians`), 3);
  await db.close();
});

Deno.test("落庫：politician_id 指定（既存の人にだけ参選を足す）、存在しない id は退件", async () => {
  const db = await ready();
  await applyOne(db, await submitCand(db));
  const pid = (await one<{ id: string }>(db, `SELECT id FROM policy_jp.politicians`)).id;
  const e2 = await insertElection(db, CHIKUSA, "2027-05-30");
  const ok = await applyOne(db, await submit(db, "candidacy", { politician_id: pid, election_id: e2, candidacy_status: "declared", status_date: "2027-04-01", district_kind: "at_large" }, { status: "verified", urls: [ELECTION_URL] }));
  assertEquals(ok.status, "applied");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politicians`), 1, "同じ人に 2 つ目の参選");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politician_elections WHERE politician_id = '${pid}'`), 2);
  const bad = await applyOne(db, await submit(db, "candidacy", { politician_id: "no-such-id", election_id: E1, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large" }, { status: "verified", urls: [ELECTION_URL] }));
  assertEquals([bad.status, bad.outcome], ["rejected", "invalid"]);
  await db.close();
});

Deno.test("落庫：状態の転移は後ろへだけ（considering → declared → filed → withdrawn／elected／not_elected）。後戻り・終点の付け替え・日付の巻き戻しは conflict で退件、庫は変わらない", async () => {
  const db = await ready();
  const st = async () => (await one<{ candidacy_status: string }>(db, `SELECT candidacy_status FROM policy_jp.politician_elections`)).candidacy_status;
  await applyOne(db, await submitCand(db, { candidacy_status: "considering", status_date: "2027-02-20" }));
  assertEquals(await st(), "considering");
  const r1 = await applyOne(db, await submitCand(db, { candidacy_status: "declared", status_date: "2027-03-01" }));
  assertEquals([r1.status, r1.outcome], ["applied", "applied"]);
  assertEquals(await st(), "declared");
  // 後戻り（filed の後に declared）
  const r2 = await applyOne(db, await submitCand(db, { candidacy_status: "filed", status_date: NOTICE }));
  assertEquals(await st(), "filed");
  assertEquals(r2.status, "applied");
  const back = await applyOne(db, await submitCand(db, { candidacy_status: "declared", status_date: "2027-04-09" }));
  assertEquals([back.status, back.outcome], ["rejected", "conflict"]);
  assertEquals(await st(), "filed");
  // 日付の巻き戻し（同じ filed へ進めない：declared → withdrawn で日付が古い）
  const older = await applyOne(db, await submitCand(db, { candidacy_status: "withdrawn", status_date: "2027-03-02", withdrawn_after_filing: true }));
  assertEquals([older.status, older.outcome], ["rejected", "conflict"]);
  // 当選は投票日以降でなければ invalid
  const early = await applyOne(db, await submitCand(db, { candidacy_status: "elected", status_date: "2027-04-24" }));
  assertEquals([early.status, early.outcome], ["rejected", "invalid"]);
  const won = await applyOne(db, await submitCand(db, { candidacy_status: "elected", status_date: POLLING }));
  assertEquals([won.status, won.outcome], ["applied", "applied"]);
  assertEquals(await st(), "elected");
  // 終点の付け替え
  const flip = await applyOne(db, await submitCand(db, { candidacy_status: "not_elected", status_date: "2027-04-26" }));
  assertEquals([flip.status, flip.outcome], ["rejected", "conflict"]);
  assertEquals(await st(), "elected");
  // 履歴：状態が変わるたびに old/new が残る
  const hist = await rows<{ old_value: string; new_value: string }>(db, `SELECT old_value #>> '{}' AS old_value, new_value #>> '{}' AS new_value FROM policy_jp.edit_history WHERE table_name = 'politician_elections' AND field = 'candidacy_status' ORDER BY id`);
  assertEquals(hist.map((h) => [h.old_value, h.new_value]), [["considering", "declared"], ["declared", "filed"], ["filed", "elected"]]);
  await db.close();
});

Deno.test("落庫：日付の規則（filed は告示日以降・投票日以前、considering／declared は投票日以前、withdrawn_after_filing は withdrawn のみ）、選挙区の規則、選挙が未登録／未公開なら invalid", async () => {
  const db = await ready();
  const rej = async (o: Record<string, unknown>, msg: string, p: Record<string, unknown> = {}) => {
    const out = await applyOne(db, await submit(db, "candidacy", candPayload(o), { status: "verified", urls: [ELECTION_URL], ...p }));
    assertEquals([out.status, out.outcome], ["rejected", "invalid"], msg);
    assert(out.message && out.message.length > 5, msg);
    return out.message!;
  };
  assert((await rej({ candidacy_status: "filed", status_date: "2027-04-07" }, "告示前の届出")).includes("告示日"));
  await rej({ candidacy_status: "filed", status_date: "2027-04-26" }, "投票日後の届出");
  await rej({ candidacy_status: "declared", status_date: "2027-04-26" }, "投票日後の表明");
  await rej({ withdrawn_after_filing: true }, "declared に withdrawn_after_filing");
  await rej({ district_kind: "at_large", district_name: "北区" }, "at_large に district_name");
  await rej({ district_kind: "district" }, "district に district_name なし");
  await rej({ district_kind: "district", district_name: "北区", list_rank: 3 }, "district に list_rank");
  await rej({ district_kind: "district", district_name: "北区", district_lg_code: "999999" }, "存在しない district_lg_code");
  await rej({ candidacy_status: "bogus" }, "知らない状態");
  await rej({ status_date: "2027-13-40" }, "存在しない日付");
  await rej({ election_id: "2027-05-30_mayor_232033" }, "選挙が未登録");
  await rej({ name: "", kana: "" }, "政治人物の特定に必要な name／kana がない");
  const pend = await insertElection(db, CHIKUSA, "2027-06-06", { status: "pending" });
  await rej({ election_id: pend, status_date: "2027-05-01" }, "未公開の選挙");
  await db.close();
});

Deno.test("落庫：比例代表（list_rank）・小選挙区（district_lg_code）・退選（withdrawn_after_filing）は表の列に入る。得票數の欄位名が payload にあれば退件、庫に票數の欄位は存在しない", async () => {
  const db = await ready();
  const out = await applyOne(db, await submitCand(db, { district_kind: "proportional", district_name: "東海ブロック", list_rank: 2 }));
  assertEquals(out.status, "applied");
  const out2 = await applyOne(db, await submitCand(db, { name: "鈴木一郎", kana: "すずきいちろう", district_kind: "district", district_name: "北区", district_lg_code: AICHI }));
  assertEquals(out2.status, "applied");
  const pe = await rows<{ district_kind: string; list_rank: number | null; district_lg_code: string | null }>(db, `SELECT district_kind, list_rank, district_lg_code FROM policy_jp.politician_elections ORDER BY district_kind`);
  assertEquals(pe, [{ district_kind: "district", list_rank: null, district_lg_code: AICHI }, { district_kind: "proportional", list_rank: 2, district_lg_code: null }]);
  const w = await applyOne(db, await submitCand(db, { candidacy_status: "withdrawn", status_date: "2027-03-02", withdrawn_after_filing: false, district_kind: "proportional", district_name: "東海ブロック" }));
  assertEquals(w.status, "applied");
  assertEquals((await one<{ withdrawn_after_filing: boolean }>(db, `SELECT withdrawn_after_filing FROM policy_jp.politician_elections WHERE district_kind = 'proportional'`)).withdrawn_after_filing, false);
  for (const key of ["votes", "vote_count", "votes_received", "vote_percentage", "vote_rate", "vote_share", "turnout"]) {
    const bad = await applyOne(db, await submitCand(db, { name: "高橋次郎", kana: "たかはしじろう", [key]: 12345 }));
    assertEquals([bad.status, bad.outcome], ["rejected", "invalid"], key);
    assert(bad.message!.includes("得票"), key);
  }
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politicians WHERE name = '高橋次郎'`), 0, "得票數の入った提出は人物も作らない");
  // 庫に票數・得票率の欄位がない（politician_elections／politicians）
  assertEquals(await count(db, `SELECT 1 FROM information_schema.columns WHERE table_schema = 'policy_jp' AND table_name IN ('politician_elections', 'politicians') AND column_name ~* '(vote|votes|得票|percent|rate)'`), 0);
  await db.close();
});

Deno.test("落庫：applying の失敗は apply_contribution のルールに従う（出処 URL なし＝invalid 退件）。candidacy は apply_blocker で待たない", async () => {
  const db = await ready();
  const c = await submit(db, "candidacy", candPayload(), { status: "verified", urls: ["not a url"] });
  const out = await applyOne(db, c);
  assertEquals([out.status, out.outcome], ["rejected", "invalid"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politicians`), 0);
  assertEquals((await one<{ b: string | null }>(db, `SELECT policy_jp.apply_blocker('candidacy', '{"election_id":"x"}'::JSONB) AS b`)).b, null);
  await db.close();
});

// =============================================================================================
// g. 共識
// =============================================================================================
Deno.test("共識：candidacy は目標 3・退件 −3；Jev の系統票で目標が 2 に下がっても『2 つ以上の接続元』は外れない", async () => {
  const db = await ready();
  assertEquals((await one<{ n: number; r: number; t: boolean }>(db,
    `SELECT policy_jp.contribution_required_agree('candidacy', '{}'::JSONB, ARRAY[]::TEXT[]) AS n, policy_jp.contribution_reject_floor('candidacy') AS r,
            policy_jp.contribution_needs_two_ips('candidacy', '{}'::JSONB) AS t`)), { n: 3, r: 3, t: true });
  // 3 つの別々の接続元で同意 → verified
  const c1 = await submitCand(db, {}, { status: "pending" });
  assertEquals(await vote(db, c1, "net-a"), "pending");
  assertEquals(await vote(db, c1, "net-b"), "pending");
  assertEquals(await vote(db, c1, "net-c"), "verified");
  // 系統票 supported で目標 2：反証つきの重い票（+2）1 つ（1 接続元）では score 2 ≥ 2 でも 2 接続元に満たず pending のまま
  const c2 = await submitCand(db, { name: "佐藤花子", kana: "さとうはなこ" }, { status: "pending" });
  await db.query(`INSERT INTO policy_jp.jev_decisions (subject_type, subject_id, question, choice, probability, model, state) VALUES ('contribution', $1, 'source_support', 'supported', 0.99, 'test-jev', '{}'::JSONB)`, [c2]);
  assertEquals((await one<{ n: number }>(db, `SELECT policy_jp.contribution_effective_agree($1::UUID) AS n`, [c2])).n, 2);
  assertEquals(await vote(db, c2, "net-a", { judge: true }), "pending", "1 つの接続元だけでは通らない");
  assertEquals(await vote(db, c2, "net-b"), "verified", "2 つ目の接続元が入って通る");
  // 退件：-3
  const c3 = await submitCand(db, { name: "高橋次郎", kana: "たかはしじろう" }, { status: "pending" });
  await vote(db, c3, "net-a", { verdict: "disagree" });
  await vote(db, c3, "net-b", { verdict: "disagree" });
  assertEquals(await vote(db, c3, "net-c", { verdict: "disagree" }), "rejected");
  await db.close();
});

// =============================================================================================
// h. 文字守門
// =============================================================================================
Deno.test("文字守門：総表＝緊接在前一版（20261009250400）の総表に UNION を 1 行足しただけ（機械置換比較＋還原驗證）；臂名清單は末尾に 1 つだけ増えた", () => {
  const prev = fnText(PREV_CHAIN_SQL, TOTAL);
  const now = fnText(MIG_SQL, TOTAL);
  const added = "  UNION ALL SELECT 'roster_check' AS arm, t.* FROM policy_jp.contribution_auto_tasks_roster_check() t\n";
  assertEquals(mutate(now, added, ""), prev, "総表は UNION の 1 行以外、一字も違わない");
  assertNotEquals(now, prev);
  // 還原驗證：本体のどこかを 1 字変えれば比較は赤くなる
  const tampered = mutate(now, "'chain_gate', CASE WHEN o.after_step IS NOT NULL", "'chain_gatex', CASE WHEN o.after_step IS NOT NULL");
  assertNotEquals(mutate(tampered, added, ""), prev);
  // 臂名の増分：前の版（20261009210100）の 5 つに roster_check を足しただけ
  const names = (sql: string) => [...fnText(sql, "policy_jp.activity_arm_names").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  return Promise.all([readMig("20261009210100_policy_jp_gap_arms.sql")]).then(([arms]) => {
    assertEquals(names(MIG_SQL), [...names(arms), "roster_check"]);
  });
});

async function gateProbe(db: Awaited<ReturnType<typeof freshDb>>) {
  await insertElection(db, ICHI, POLLING);
  await clock(db, "2027-02-01");
  await seed(db);
  const blocked = (await dispatchIds(db, ROSTER)).length === 0;
  await fillStats(db, ICHI);
  await seed(db);
  const openedByDone = (await dispatchIds(db, ROSTER)).includes(TASK);
  const e2 = await insertElection(db, "232025", POLLING); // 統計なし（行政区ではない市）＝region が done にならない
  await clock(db, addDays(NOTICE, -30));
  await seed(db);
  const openedByFallback = (await dispatchIds(db, ROSTER)).includes(`auto:roster_check:${e2}`);
  return { blocked, openedByDone, openedByFallback };
}

Deno.test("行為の還原驗證（gate の鍵になる行）：『前一步 done』の判定・gate 全体・後備を 1 つずつ壊すと、対応する情境が赤くなる（本物は 3 つとも通る）", async () => {
  const run = async (patch: (sql: string) => string) => {
    const db = await migratedDb({ before: MIG_FILE });
    await db.exec(patch(MIG_SQL));
    const r = await gateProbe(db);
    await db.close();
    return r;
  };
  assertEquals(await run((s) => s), { blocked: true, openedByDone: true, openedByFallback: true });
  const noDone = await run((s) => mutate(s, "AND c.step = o.after_step) THEN 'done'", "AND c.step = o.after_step AND false) THEN 'done'"));
  assertEquals([noDone.openedByDone], [false], "『前一步 done』を壊すと、補完しても開かない");
  const noGate = await run((s) => mutate(s, "WHEN o.after_step IS NULL THEN 'none'", "WHEN true THEN 'none'"));
  assertEquals([noGate.blocked], [false], "gate を外すと、前の一歩が終わっていなくても開いてしまう");
  const noFallback = await run((s) => mutate(s, "ELSE policy_jp.activity_chain_escape(o.chain_fallback, g.eid, g.etype, g.task_id) END AS via", "ELSE NULL END AS via"));
  assertEquals([noFallback.openedByFallback], [false], "逃生門を外すと、後備の日が来ても開かない");
});

Deno.test("文字守門：臂は読み取りだけ（INSERT／UPDATE／DELETE なし）、public.／ditrust を引かない、新しい関数は search_path を釘付け、権限は service_role だけ", () => {
  const arm = fnText(MIG_SQL, "policy_jp.contribution_auto_tasks_roster_check");
  assert(!/\b(INSERT|UPDATE|DELETE)\b/.test(arm), "臂は唯讀");
  assert(!/public\./.test(MIG_SQL.replace(/--[^\n]*/g, "")), "public. を引かない");
  assert(!/ditrust/.test(MIG_SQL.replace(/--[^\n]*/g, "")), "ditrust を引かない");
  for (const fn of ["policy_jp.chain_task_checked", "policy_jp.candidacy_match_politicians", "policy_jp.candidacy_status_rank", "policy_jp.apply_candidacy",
    "policy_jp.contribution_auto_tasks_roster_check", "policy_jp.apply_contribution"]) {
    assert(fnText(MIG_SQL, fn).includes("SET search_path = policy_jp, pg_temp"), `${fn} は search_path を釘付けにする`);
  }
});

Deno.test("自我檢查（還原驗證）：規則の after_step・chain_fallback・cap が欠ける／CHECK から candidacy を落とす／apply_types から落とす／anon に渡すと、migration が失敗する", async () => {
  const pre = await migratedDb({ before: MIG_FILE });
  const bad = async (from: string, to: string, why: string) => {
    const sql = mutate(MIG_SQL, from, to);
    await assertRejects(() => pre.exec(sql), Error, undefined, why);
  };
  await bad(`'{"cap":200,"chain_fallback":{"kind":"announced","offset":-30}}'::JSONB`, `'{"cap":200}'::JSONB`, "後備なし");
  await bad(`'roster_check', 'event', 'polling', 0, 'announced', 'region',`, `'roster_check', 'event', 'polling', 0, 'announced', NULL,`, "after_step なし");
  await bad(`'regional_stat', 'candidacy'));`, `'regional_stat'));`, "CHECK から candidacy");
  await bad(`ARRAY['local_government', 'regional_stat', 'election', 'candidacy', 'no_change']`, `ARRAY['local_government', 'regional_stat', 'election', 'no_change']`, "apply_types から candidacy");
  await bad(`  policy_jp.candidacy_status_rank(TEXT), policy_jp.apply_candidacy(policy_jp.contributions), policy_jp.contribution_auto_tasks_roster_check()
  TO service_role;`, `  policy_jp.candidacy_status_rank(TEXT), policy_jp.apply_candidacy(policy_jp.contributions), policy_jp.contribution_auto_tasks_roster_check()
  TO service_role, anon;`, "anon に渡す");
  // 元の SQL なら通る（上の失敗が『他の理由』ではない証拠）
  await pre.exec(MIG_SQL);
  await pre.close();
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則・優先層規則が増えない", async () => {
  const db = await freshDb();
  const before = await count(db, `SELECT 1 FROM policy_jp.activity_rules`);
  await db.exec(MIG_SQL);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.activity_rules`), before);
  await db.close();
});

// =============================================================================================
// i. 権限
// =============================================================================================
Deno.test("権限：新しい関数は anon／authenticated が呼べない（service_role は呼べる）", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.contribution_auto_tasks_roster_check()`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.chain_task_checked('x')`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.election_chain_progress`), Error, "permission denied");
  }
  assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_roster_check()`))[0].n, 0);
  await tryIn(shared, `SELECT 1`);
  assert(await sourceId(shared) > 0);
  assertEquals(await statusOf(shared, await submit(shared, "no_change", { task_id: TASK, outcome: "confirmed", checked_urls: [ELECTION_URL], finding: "名簿を確認した" })), "pending");
});
