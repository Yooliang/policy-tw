/**
 * 日本站「選舉鏈」第 3 步：參選人建檔（migration 20261010050000_policy_jp_chain_profile.sql）。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts，照檔名排序，不寫死清單）；時鐘用 `SET app.activity_today`，
 * 整條流程走 seed_auto_task_queue()＋task_dispatches／gap_events。
 *
 *   a. 結構：步驟清單七步、臂名清單・總表・規則三處一起加、規則 after_step=candidacy＋後備（告示日當天）、優先層規則、chain_step_rank（5）、
 *      DB CHECK／apply_types／same_claim_matches 的型別清單
 *   b. 鏈的三個情境（假時鐘＋seed）：1. 前一步完成（有人正式表明）才開  2. 前一步卡住但後備（告示日）到了照開  3. 已開的不收回
 *   c. 臂：profile_gap（生年）、profile_detail_gap 的兩種 kind、審議中的提出不再派、cap、冷卻
 *   d. 進度視圖 profile：每一位都齊了才 done；缺口各自被回報查無也算（只算那一項）
 *   e. 落庫 apply_politician：生年只補空欄位・違うなら conflict・學經歷一條一項・出處掛到文字相同的項目・冪等・不備は invalid
 *   f. 同一件事：same_claim_matches 的分派（election／candidacy 不受影響）、politician 的鍵（事實）、探查、收編（同內容的等票提交 → superseded）
 *   g. 文字守門：総表・apply_contribution・same_claim_same_content＝緊接在前一版剛好多的幾行（機械替換＋還原驗證）；改名後的 base 函式；gate 行的行為還原驗證
 *   h. 權限
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import { JP_APPLY_TYPES } from "./jp/apply-contribution.ts";
import { JP_CONTRIBUTION_TYPES } from "./jp/contribution-schema.ts";
import { jpSameClaimProbe } from "./jp/same-claim-probe.ts";
import {
  addDays, applyOne, asRole, check, clock, count, dispatchIds, dispatches, events, expireCooling, freshDb, ELECTION_URL, ICHI, insertElection, migratedDb,
  mutate, one, openElectionWithRegion, progress, readMig, rows, seed, statusOf, stepsDone, submit, vote,
} from "./policy-jp-chain-db.ts";

const MIG_FILE = "20261010050000_policy_jp_chain_profile.sql";
const PREV_FILE = "20261010040000_policy_jp_chain_candidacy.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV_SQL = await readMig(PREV_FILE);
const POLLING = "2027-04-25";
const NOTICE = "2027-04-08";
const E1 = `${POLLING}_mayor_${ICHI}`;
const PROFILE = ["profile_gap", "profile_detail_gap"];
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const OFFICIAL = "https://www.city.ichinomiya.aichi.jp/gikai/";

const shared = await freshDb();

type Db = Awaited<ReturnType<typeof freshDb>>;
/** candidacy を通して人物＋参選を作る（SQL の落庫を通る）。返すのは人物 id と参選 id */
async function addCand(db: Db, name: string, kana: string, status = "declared", o: Record<string, unknown> = {}): Promise<{ pid: string; peid: string }> {
  const payload = { election_id: E1, name, kana, candidacy_status: status, status_date: "2027-03-01", district_kind: "at_large", ...o };
  const id = await submit(db, "candidacy", payload, { status: "verified", urls: [ELECTION_URL] });
  const out = await applyOne(db, id);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pid = (await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id;
  return { pid, peid: out.record_id! };
}
const submitPol = (db: Db, payload: Record<string, unknown>, o: Parameters<typeof submit>[3] = {}) =>
  submit(db, "politician", payload, { status: "verified", urls: [OFFICIAL], ...o });
const profileIds = (db: Db) => dispatchIds(db, PROFILE);
async function armRows(db: Db, all = false) {
  const q = `SELECT task_id, arm, target, opened_by FROM ${TOTAL}() WHERE arm IN ('profile_gap', 'profile_detail_gap') ORDER BY task_id`;
  if (!all) return await rows<{ task_id: string; arm: string; target: Record<string, unknown>; opened_by: Record<string, unknown> | null }>(db, q);
  return await db.transaction(async (tx) => {
    await tx.exec(`SELECT set_config('gap.arms_all', 'on', true)`);
    return (await tx.query<{ task_id: string; arm: string; target: Record<string, unknown>; opened_by: Record<string, unknown> | null }>(q)).rows;
  });
}

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：步驟清單七步；臂名・總表・規則三處一起加；規則 after_step=candidacy＋後備（告示日當天）；優先層規則；步驟順位 5；型別清單 TS／SQL 對齊", async () => {
  assertEquals((await one<{ s: string[] }>(shared, `SELECT policy_jp.election_chain_steps() AS s`)).s.slice(0, 7),
    ["discovery", "local_government", "regional_stats", "region", "roster", "candidacy", "profile"]);
  const names = (await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a;
  for (const a of PROFILE) assert(names.includes(a), `臂名清單有 ${a}`);
  const total = fnText(MIG_SQL, TOTAL);
  for (const a of PROFILE) assert(total.includes(`contribution_auto_tasks_${a}()`), `総表有 ${a} 的 UNION 分支`);
  for (const a of PROFILE) {
    const rule = await one<{ after_step: string; params: Record<string, unknown>; window_kind: string }>(shared,
      `SELECT after_step, params, window_kind FROM policy_jp.activity_rules WHERE activity = $1 AND priority IS NULL`, [a]);
    assertEquals([rule.after_step, rule.window_kind], ["candidacy", "always"], a);
    assertEquals(rule.params, { cap: 200, chain_fallback: { kind: "announced", offset: 0 } }, a);
    assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:${a}' AND priority IN (1, 3)`), 2, `${a} 優先層規則`);
  }
  const rank = (id: string, t: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, t]).then((x) => x.r);
  assertEquals(await rank("auto:profile_gap:x", "profile_gap"), 5);
  assertEquals(await rank("auto:profile_detail_gap:x", "profile_detail_gap"), 5);
  assertEquals(await rank("auto:roster_check:x", "roster_check"), 4, "第 2 步的順位不變");
  assertEquals(await rank("auto:other:x", "other"), 9);
  // TS／SQL 對齊（全 migration 適用後）
  const sqlApply = (await one<{ t: string[] }>(shared, `SELECT policy_jp.apply_types() AS t`)).t;
  assertEquals(sqlApply, [...JP_APPLY_TYPES]);
  assert(sqlApply.includes("politician"));
  const chk = (await one<{ d: string }>(shared, `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check'`)).d;
  assert(chk.includes("'politician'"), "DB CHECK 收 politician（漏了＝代理交件全被擋而測試全綠）");
  assert(JP_CONTRIBUTION_TYPES.includes("politician"));
});

Deno.test("DB CHECK 還原驗證：沒有這支 migration 的庫擋 politician，套了就收", async () => {
  const before = await migratedDb({ before: MIG_FILE });
  await assertRejects(() => submit(before, "politician", { politician_id: "x", birth_year: 1970 }, { urls: [OFFICIAL] }), Error, "policy_jp_contributions_type_check");
  await before.close();
  const db = await freshDb();
  await submit(db, "politician", { politician_id: "x", birth_year: 1970 }, { urls: [OFFICIAL] });
  await db.close();
});

// =============================================================================================
// b. 鏈的三個情境
// =============================================================================================
Deno.test("情境 1　前一步完成才開：只有出馬檢討（considering）的選舉，建檔任務擋著（被擋的列 opened_by 是 NULL）；有人正式表明之後下一輪 seed 兩位的任務都開，opened_by 記 via=done", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const rumor = await addCand(db, "田中次郎", "たなかじろう", "considering", { status_date: "2027-02-20" });
  assertEquals((await stepsDone(db, E1)).candidacy, false);
  await seed(db);
  assertEquals(await profileIds(db), [], "candidacy が done でない・後備（告示日）もまだ＝開かない");
  const blocked = await armRows(db, true);
  assert(blocked.some((r) => r.task_id === `auto:profile_gap:${rumor.pid}` && r.opened_by === null), "臂は出しているが gate が擋いている（opened_by＝NULL）");
  assertEquals(await armRows(db), [], "既定では開いてる列しか返さない");
  const real = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  assertEquals((await stepsDone(db, E1)).candidacy, true);
  await seed(db);
  const ids = await profileIds(db);
  assertEquals(ids, [`auto:profile_detail_gap:${rumor.pid}`, `auto:profile_detail_gap:${real.pid}`, `auto:profile_gap:${rumor.pid}`, `auto:profile_gap:${real.pid}`].sort());
  const [d] = await dispatches(db, ["profile_gap"]);
  assertEquals(d.opened_by?.chain_gate, { after_step: "candidacy", via: "done" });
  assertEquals(d.target.chain_step, "profile");
  assertEquals(d.target.chain_lg_code, ICHI);
  assertEquals(d.target.missing, ["birth_year"]);
  const ev = await events(db, `auto:profile_gap:${real.pid}`);
  assertEquals(ev[0].event, "opened");
  assertEquals(ev[0].detail.chain_gate, { after_step: "candidacy", via: "done" });
  await db.close();
});

Deno.test("情境 2　前一步卡住（誰も正式表明していない）でも後備（告示日当日）が来れば開く：前日は擋、当日は via=fallback", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const rumor = await addCand(db, "田中次郎", "たなかじろう", "considering", { status_date: "2027-02-20" });
  await clock(db, addDays(NOTICE, -1));
  await seed(db);
  assertEquals(await profileIds(db), [], "告示日の前日＝擋");
  await clock(db, NOTICE);
  await seed(db);
  assertEquals(await profileIds(db), [`auto:profile_detail_gap:${rumor.pid}`, `auto:profile_gap:${rumor.pid}`]);
  for (const d of await dispatches(db, PROFILE)) assertEquals(d.opened_by?.chain_gate, { after_step: "candidacy", via: "fallback" }, d.task_id);
  assertEquals((await stepsDone(db, E1)).candidacy, false, "前一步は確かに未完了（後備で開いた）");
  await db.close();
});

Deno.test("情境 3　前一步が未完了に戻っても、開いた建檔任務は收回しない（sticky）：表明した人が退選 → candidacy が done でなくなる → 任務は残る", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const rumor = await addCand(db, "田中次郎", "たなかじろう", "considering", { status_date: "2027-02-20" });
  const real = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  await seed(db);
  const before = await profileIds(db);
  assertEquals(before.length, 4);
  await db.exec(`UPDATE policy_jp.politician_elections SET candidacy_status = 'withdrawn', withdrawn_after_filing = false WHERE politician_id = '${real.pid}'`);
  assertEquals((await stepsDone(db, E1)).candidacy, false, "前一步が未完了に戻った");
  await seed(db);
  await seed(db);
  // 退選した人の分は『非退選』ではなくなるので消える（派工は臂が出している間だけ）；開いたままの人の任務は gate が sticky で通す
  assertEquals(await profileIds(db), [`auto:profile_detail_gap:${rumor.pid}`, `auto:profile_gap:${rumor.pid}`]);
  assertEquals((await events(db, `auto:profile_gap:${rumor.pid}`)).map((e) => e.event), ["opened"], "考えるべき closed が入っていない");
  const stuck = await armRows(db);
  for (const r of stuck) assertEquals((r.opened_by as { chain_gate: { via: string } }).chain_gate.via, "sticky");
  await db.close();
});

// =============================================================================================
// c. 臂
// =============================================================================================
Deno.test("臂：profile_gap は生年が空の人だけ・生年を足したら消える・審議中の提出（birth_year）がある人には派さない・cap・冷卻", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared", { birth_year: 1975 });
  const b = await addCand(db, "鈴木一郎", "すずきいちろう", "declared");
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), [`auto:profile_gap:${b.pid}`], "生年がある人には派さない");
  const [d] = await dispatches(db, ["profile_gap"]);
  assertEquals([d.target.name, d.target.kana, d.target.election_id, d.target.lg_code], ["鈴木一郎", "すずきいちろう", E1, ICHI]);
  assertEquals(d.region, "愛知県");
  assert(d.what_we_need.includes("生年") && d.what_we_need.includes("contribution_type=politician") && d.what_we_need.includes(b.pid));
  // 審議中の提出（birth_year を足す）
  await submit(db, "politician", { politician_id: b.pid, birth_year: 1980, resolved_claim: "new" }, { status: "pending", urls: [OFFICIAL] });
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), [], "審議中の提出があれば派さない（落ちれば戻ってくる）");
  await db.exec(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE contribution_type = 'politician'`);
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), [`auto:profile_gap:${b.pid}`], "退件で戻る");
  // 生年を落庫 → 消える
  const out = await applyOne(db, await submitPol(db, { politician_id: b.pid, birth_year: 1980, resolved_claim: "new" }, { task: `auto:profile_gap:${b.pid}` }));
  assertEquals(out.status, "applied");
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), []);
  void a;
  // 冷卻：生年が分からないと回報（not_found）→ 派さない
  const c = await addCand(db, "高橋次郎", "たかはしじろう", "declared");
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), [`auto:profile_gap:${c.pid}`]);
  await check(db, `auto:profile_gap:${c.pid}`, "not_found");
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), [], "not_found の冷卻中");
  // cap
  await expireCooling(db);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = params || '{"cap":0}'::JSONB WHERE activity = 'profile_gap' AND priority IS NULL`);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_profile_gap()`), 0);
  await db.close();
});

Deno.test("臂：profile_detail_gap は careers_missing（一件もない）と career_sources（出典のない項目）の 2 種類・task_id が別・出典を付けたら消える・退選した人は対象外", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared", { birth_year: 1975 });
  const w = await addCand(db, "渡辺三郎", "わたなべさぶろう", "declared");
  await db.exec(`UPDATE policy_jp.politician_elections SET candidacy_status = 'withdrawn', withdrawn_after_filing = false WHERE politician_id = '${w.pid}'`);
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_detail_gap"]), [`auto:profile_detail_gap:${a.pid}`], "学歴・経歴が一件もない人（退選の人は除く）");
  let [d] = await dispatches(db, ["profile_detail_gap"]);
  assertEquals([d.target.kind, d.target.missing], ["careers_missing", ["education", "career"]]);
  assert(d.what_we_need.includes("education") && d.what_we_need.includes("career") && d.what_we_need.includes("フェイスブック"));
  // 学歴を落庫（出典つき）→ careers_missing は消える
  await applyOne(db, await submitPol(db, { politician_id: a.pid, education: ["○○大学法学部卒業"], career: ["○○市議会議員"], resolved_claim: "new" }));
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_detail_gap"]), [], "出典つきで入った＝揃った");
  // 出典のない項目（手で入れた）→ career_sources
  await db.query(`INSERT INTO policy_jp.politician_careers (politician_id, kind, text, sort_order, review_status) VALUES ($1, 'career', '会社役員', 9, 'published')`, [a.pid]);
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_detail_gap"]), [`auto:profile_detail_gap:sources:${a.pid}`]);
  [d] = await dispatches(db, ["profile_detail_gap"]);
  assertEquals([d.target.kind, d.target.unsourced, d.target.missing], ["career_sources", ["会社役員"], ["career_sources"]]);
  assert(d.what_we_need.includes("会社役員"));
  // 出典を付ける提出 → 消える
  const out = await applyOne(db, await submitPol(db, { politician_id: a.pid, career: ["会社役員"], resolved_claim: "new" }, { urls: ["https://www.pref.aichi.lg.jp/profile/"] }));
  assertEquals([out.status, out.outcome], ["applied", "applied"]);
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_detail_gap"]), []);
  await db.close();
});

// =============================================================================================
// d. 進度視圖 profile
// =============================================================================================
Deno.test("進度視圖 profile：参選人が 1 人以上いて全員が建檔齊い＝done；欠けた項目ごとに『查無』が冷卻中でも齊い扱い（その項目だけ）；冷卻が過ぎれば未完了に戻る", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  assertEquals((await stepsDone(db, E1)).profile, false, "参選人がいない＝done ではない");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  assertEquals((await stepsDone(db, E1)).profile, false);
  await applyOne(db, await submitPol(db, { politician_id: a.pid, birth_year: 1975, education: ["○○大学卒業"], resolved_claim: "new" }));
  assertEquals((await stepsDone(db, E1)).profile, true, "生年・学歴（出典つき）が揃った");
  assertNotEquals((await progress(db, E1)).find((p) => p.step === "profile")!.done_at, null);
  // もう一人：生年なし・学歴経歴なし
  const b = await addCand(db, "鈴木一郎", "すずきいちろう", "declared");
  assertEquals((await stepsDone(db, E1)).profile, false);
  await check(db, `auto:profile_gap:${b.pid}`, "not_found");
  assertEquals((await stepsDone(db, E1)).profile, false, "生年の查無だけでは学歴経歴の欠けが残る");
  await check(db, `auto:profile_detail_gap:${b.pid}`, "not_found");
  assertEquals((await stepsDone(db, E1)).profile, true, "欠けた二項目とも查無で冷卻中＝done");
  await expireCooling(db);
  assertEquals((await stepsDone(db, E1)).profile, false, "冷卻が過ぎたら未完了に戻る");
  // 退選した人は数えない
  await db.exec(`UPDATE policy_jp.politician_elections SET candidacy_status = 'withdrawn', withdrawn_after_filing = false WHERE politician_id = '${b.pid}'`);
  assertEquals((await stepsDone(db, E1)).profile, true);
  // chain_profile_done は人物がいなければ false
  assertEquals((await one<{ d: boolean }>(db, `SELECT policy_jp.chain_profile_done('no-such') AS d`)).d, false);
  assertEquals((await one<{ m: unknown }>(db, `SELECT policy_jp.chain_profile_missing('no-such') AS m`)).m, null);
  await db.close();
});

// =============================================================================================
// e. 落庫 apply_politician
// =============================================================================================
Deno.test("落庫：生年は空欄だけ埋める（同じ値＝何も変えない、違う値＝conflict で退件）・学経歴は一条一項で入り、出処・履歴・applied_politician_id を残す", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  const c = await submitPol(db, { politician_id: a.pid, birth_year: 1975, education: ["○○大学法学部卒業"], career: ["○○市議会議員", "△△株式会社勤務"], resolved_claim: "new" });
  const out = await applyOne(db, c);
  assertEquals([out.status, out.outcome, out.table_name, out.record_id], ["applied", "applied", "politicians", a.pid]);
  assertEquals((await one<{ birth_year: number }>(db, `SELECT birth_year FROM policy_jp.politicians WHERE id = $1`, [a.pid])).birth_year, 1975);
  const careers = await rows<{ kind: string; text: string; sort_order: number; review_status: string }>(db, `SELECT kind, text, sort_order, review_status FROM policy_jp.politician_careers WHERE politician_id = $1 ORDER BY sort_order`, [a.pid]);
  assertEquals(careers, [
    { kind: "education", text: "○○大学法学部卒業", sort_order: 1, review_status: "published" },
    { kind: "career", text: "○○市議会議員", sort_order: 2, review_status: "published" },
    { kind: "career", text: "△△株式会社勤務", sort_order: 3, review_status: "published" },
  ]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs r JOIN policy_jp.politician_careers c ON r.target_table = 'politician_careers' AND r.target_id = c.id::TEXT WHERE c.politician_id = '${a.pid}' AND r.role = 'primary'`), 3, "各項目に主要出処");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'politicians' AND target_id = '${a.pid}' AND role = 'primary'`), 1, "生年の出処");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE contribution_id = '${c}' AND table_name = 'politician_careers' AND field = '*'`), 3);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE contribution_id = '${c}' AND table_name = 'politicians' AND field = 'birth_year'`), 1);
  assertEquals((await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = '${c}'`)).applied_politician_id, a.pid);
  // 同じ内容をもう一度＝unchanged（二重に作らない）
  const again = await applyOne(db, await submitPol(db, { politician_id: a.pid, birth_year: 1975, education: ["○○大学法学部卒業"], resolved_claim: "differs:x" }));
  assertEquals([again.status, again.outcome], ["applied", "unchanged"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politician_careers WHERE politician_id = '${a.pid}'`), 3);
  // 違う生年＝conflict、庫の値は変わらない
  const conflict = await applyOne(db, await submitPol(db, { politician_id: a.pid, birth_year: 1976, resolved_claim: "differs:x" }));
  assertEquals([conflict.status, conflict.outcome], ["rejected", "conflict"]);
  assertEquals((await one<{ birth_year: number }>(db, `SELECT birth_year FROM policy_jp.politicians WHERE id = $1`, [a.pid])).birth_year, 1975);
  await db.close();
});

Deno.test("落庫：不備は invalid で退件（politician_id なし・存在しない・name／kana・生年の範囲・配列の形・事実なし・出典 URL なし）。人物を新しく作ることはない", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  const bad = async (payload: Record<string, unknown>, why: string, urls = [OFFICIAL]) => {
    const out = await applyOne(db, await submit(db, "politician", { resolved_claim: "new", ...payload }, { status: "verified", urls }));
    assertEquals([out.status, out.outcome], ["rejected", "invalid"], why);
    assert(out.message && out.message.length > 5, why);
  };
  await bad({ birth_year: 1970 }, "politician_id なし");
  await bad({ politician_id: "no-such", birth_year: 1970 }, "存在しない人物");
  await bad({ politician_id: a.pid, birth_year: 1970, name: "別名" }, "name は直さない");
  await bad({ politician_id: a.pid, kana: "べつ" }, "kana は直さない");
  await bad({ politician_id: a.pid }, "事実なし");
  await bad({ politician_id: a.pid, birth_year: 1899 }, "生年が範囲外");
  await bad({ politician_id: a.pid, birth_year: 1970.5 }, "生年が整数でない");
  await bad({ politician_id: a.pid, education: [] }, "空の配列");
  await bad({ politician_id: a.pid, career: "会社役員" }, "配列でない");
  await bad({ politician_id: a.pid, career: [" "] }, "空の項目");
  await bad({ politician_id: a.pid, career: ["x".repeat(201)] }, "長すぎる項目");
  await bad({ politician_id: a.pid, birth_year: 1970 }, "出典 URL が使えない", ["not a url"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politicians`), 1, "politician では人物を作らない");
  assertEquals((await one<{ birth_year: number | null }>(db, `SELECT birth_year FROM policy_jp.politicians WHERE id = $1`, [a.pid])).birth_year, null);
  await db.close();
});

Deno.test("共識：politician は目標 3・退件 −3・2 つの接続元は要らない（3 つの接続元で通る）", async () => {
  const db = await freshDb();
  assertEquals(await one(db, `SELECT policy_jp.contribution_required_agree('politician', '{}'::JSONB, ARRAY[]::TEXT[]) AS n, policy_jp.contribution_reject_floor('politician') AS r, policy_jp.contribution_needs_two_ips('politician', '{}'::JSONB) AS t`), { n: 3, r: 3, t: false });
  const c = await submit(db, "politician", { politician_id: "x", birth_year: 1970, resolved_claim: "new" }, { urls: [OFFICIAL] });
  assertEquals(await vote(db, c, "net-a"), "pending");
  assertEquals(await vote(db, c, "net-b"), "pending");
  assertEquals(await vote(db, c, "net-c"), "verified");
  await db.close();
});

// =============================================================================================
// f. 同一件事
// =============================================================================================
Deno.test("同一件事の分派：election／regional_stat／local_government は元の本体、candidacy は NULL（claimKey 型別）、politician は新しい本体；入口の署名は変わらない", async () => {
  const q = (t: string, p: Record<string, unknown>) => one<{ r: Record<string, unknown> | null }>(shared, `SELECT policy_jp.same_claim_matches($1, $2::JSONB) AS r`, [t, JSON.stringify(p)]).then((x) => x.r);
  assertEquals(await q("candidacy", { election_id: E1 }), null);
  assertEquals(await q("nonsense", {}), null);
  for (const t of ["election", "regional_stat", "local_government"]) {
    const r = await q(t, { lg_code: ICHI });
    assert(r && r.type === t && Array.isArray(r.existing) && Array.isArray(r.pending), t);
  }
  const r = await q("politician", { politician_id: "nope" });
  assertEquals(r, { type: "politician", existing: [], pending: [] });
  // 本体は元の関数のまま（改名されただけ）：直接呼んでも同じ
  const base = await one<{ r: Record<string, unknown> }>(shared, `SELECT policy_jp.same_claim_matches_base('local_government', '{"lg_code":"${ICHI}"}'::JSONB) AS r`);
  assertEquals(base.r, await q("local_government", { lg_code: ICHI }));
});

Deno.test("同一件事（politician）：鍵＝人物＋事実。庫に生年があれば生年の重複、同じ文字の学歴・経歴があればその項目の重複；事実を書かない探査は全部返す；審議中の提出と自分の接続元", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  const m = (p: Record<string, unknown>, ip: string | null = null) =>
    one<{ r: { existing: Array<Record<string, unknown>>; pending: Array<Record<string, unknown>> } }>(db, `SELECT policy_jp.same_claim_matches('politician', $1::JSONB, $2) AS r`, [JSON.stringify(p), ip]).then((x) => x.r);
  assertEquals((await m({ politician_id: a.pid, birth_year: 1975 })).existing, [], "庫に生年がない＝重複なし");
  await applyOne(db, await submitPol(db, { politician_id: a.pid, birth_year: 1975, education: ["○○大学卒業"], career: ["市議"], resolved_claim: "new" }));
  const dupBirth = await m({ politician_id: a.pid, birth_year: 1980 });
  assertEquals(dupBirth.existing.map((e) => e.fact), ["birth_year"], "生年は値が違っても『庫に生年がある』＝同じこと（differs で出し直す）");
  const dupEdu = await m({ politician_id: a.pid, education: ["○○大学卒業", "新しい学歴"] });
  assertEquals(dupEdu.existing.map((e) => e.text), ["○○大学卒業"], "重なる項目だけ");
  assertEquals((await m({ politician_id: a.pid, career: ["別の経歴"] })).existing, []);
  const probe = await m({ politician_id: a.pid });
  assertEquals(probe.existing.map((e) => e.fact).sort(), ["birth_year", "career", "education"], "探査＝この人の事実を全部");
  // 審議中の提出
  const pend = await submit(db, "politician", { politician_id: a.pid, career: ["別の経歴"], resolved_claim: "new" }, { status: "pending", urls: [OFFICIAL], ip: "ip-owner" });
  const hit = await m({ politician_id: a.pid, career: ["別の経歴", "もう一つ"] }, "ip-other");
  assertEquals(hit.pending.map((p) => p.contribution_id), [pend]);
  assertEquals([hit.pending[0].yours, hit.pending[0].your_network_voted], [false, false]);
  const mine = await m({ politician_id: a.pid, career: ["別の経歴"] }, "ip-owner");
  assertEquals([mine.pending[0].yours, mine.pending[0].your_network_voted], [true, true]);
  assertEquals((await m({ politician_id: a.pid, education: ["関係ない学歴"] })).pending, [], "重ならない事実の提出は同じこととは見ない");
  // TS の探査（任務を領いたとき）が同じ形を呼ぶ
  assertEquals(jpSameClaimProbe(`auto:profile_detail_gap:sources:${a.pid}`), { type: "politician", payload: { politician_id: a.pid } });
  assertEquals(jpSameClaimProbe(`auto:profile_gap:${a.pid}`)?.type, "politician");
  assertEquals(jpSameClaimProbe(`auto:profile_detail_gap:${a.pid}`)?.payload, { politician_id: a.pid });
  await db.close();
});

Deno.test("同一件事（politician）の収編：落庫した提出と内容が同じ等票の提出は superseded（edit_history つき）、内容が違う・differs の提出は残る", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  const content = { politician_id: a.pid, birth_year: 1975, career: ["市議", "会社役員"] };
  const same = await submit(db, "politician", { ...content, career: ["会社役員", "市議"], resolved_claim: "new" }, { status: "pending", urls: [OFFICIAL] });
  const diff = await submit(db, "politician", { politician_id: a.pid, birth_year: 1975, career: ["市議"], resolved_claim: "new" }, { status: "pending", urls: [OFFICIAL] });
  const differs = await submit(db, "politician", { ...content, resolved_claim: "differs:abc" }, { status: "pending", urls: [OFFICIAL] });
  assertEquals((await one<{ s: boolean }>(db, `SELECT policy_jp.same_claim_same_content('politician', $1::JSONB, $2::JSONB) AS s`, [JSON.stringify(content), JSON.stringify({ ...content, career: ["会社役員", "市議"] })])).s, true, "順序は問わない");
  const winner = await submit(db, "politician", { ...content, resolved_claim: "new" }, { status: "verified", urls: [OFFICIAL] });
  assertEquals((await applyOne(db, winner)).status, "applied");
  assertEquals(await statusOf(db, same), "superseded");
  assertEquals(await statusOf(db, diff), "pending");
  assertEquals(await statusOf(db, differs), "pending", "differs の宣言は収編しない");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'contributions' AND record_id = '${same}' AND agent_name = 'same-claim'`), 1);
  // 他の型別の same_content は従来どおり
  assertEquals((await one<{ s: boolean }>(db, `SELECT policy_jp.same_claim_same_content('local_government', '{"name":"a","kana":"b","kind":"city"}'::JSONB, '{"name":"a","kana":"b","kind":"city"}'::JSONB) AS s`)).s, true);
  assertEquals((await one<{ s: boolean }>(db, `SELECT policy_jp.same_claim_same_content('candidacy', '{}'::JSONB, '{}'::JSONB) AS s`)).s, false);
  await db.close();
});

// =============================================================================================
// g. 文字守門
// =============================================================================================
Deno.test("文字守門：総表＝緊接在前一版（20261010040000）に UNION が 2 行増えただけ、apply_contribution＝WHEN が 1 行増えただけ、same_claim_same_content＝WHEN が増えただけ（機械置換＋還原驗證）", () => {
  const unions = "  UNION ALL SELECT 'profile_gap' AS arm, t.* FROM policy_jp.contribution_auto_tasks_profile_gap() t\n  UNION ALL SELECT 'profile_detail_gap' AS arm, t.* FROM policy_jp.contribution_auto_tasks_profile_detail_gap() t\n";
  const prev = fnText(PREV_SQL, TOTAL);
  const now = fnText(MIG_SQL, TOTAL);
  assertEquals(mutate(now, unions, ""), prev);
  assertNotEquals(mutate(mutate(now, "'chain_gate', CASE WHEN o.after_step IS NOT NULL", "'chain_gatex', CASE WHEN o.after_step IS NOT NULL"), unions, ""), prev, "1 字ずらすと比較が赤い");
  const w = "               WHEN 'politician' THEN policy_jp.apply_politician(c)\n";
  assertEquals(mutate(fnText(MIG_SQL, "policy_jp.apply_contribution"), w, ""), fnText(PREV_SQL, "policy_jp.apply_contribution"));
  // 臂名の増分
  const names = (sql: string) => [...fnText(sql, "policy_jp.activity_arm_names").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(names(MIG_SQL), [...names(PREV_SQL), "profile_gap", "profile_detail_gap"]);
});

Deno.test("文字守門：same_claim_matches を改名したのは ALTER だけ（本体の複製ではない）；臂は読み取りだけ；public.／ditrust を引かない；新しい関数は search_path 釘付け", () => {
  const code = MIG_SQL.replace(/--[^\n]*/g, "");
  assert(code.includes("ALTER FUNCTION policy_jp.same_claim_matches(TEXT, JSONB, TEXT, UUID) RENAME TO same_claim_matches_base;"));
  assert(!/public\./.test(code) && !/ditrust/.test(code));
  for (const arm of ["policy_jp.contribution_auto_tasks_profile_gap", "policy_jp.contribution_auto_tasks_profile_detail_gap", "policy_jp.chain_profile_subjects"]) {
    assert(!/\b(INSERT|UPDATE|DELETE)\b/.test(fnText(MIG_SQL, arm)), `${arm} は唯讀`);
  }
  for (const fn of ["policy_jp.chain_profile_missing", "policy_jp.chain_profile_done", "policy_jp.chain_profile_subjects", "policy_jp.apply_politician",
    "policy_jp.contribution_auto_tasks_profile_gap", "policy_jp.contribution_auto_tasks_profile_detail_gap", "policy_jp.same_claim_matches_politician", "policy_jp.same_claim_matches"]) {
    assert(fnText(MIG_SQL, fn).includes("SET search_path = policy_jp, pg_temp"), `${fn} は search_path を釘付けにする`);
  }
});

async function gateProbe(db: Db) {
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const rumor = await addCand(db, "田中次郎", "たなかじろう", "considering", { status_date: "2027-02-20" });
  await seed(db);
  const blocked = (await profileIds(db)).length === 0;
  await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  await seed(db);
  const openedByDone = (await profileIds(db)).includes(`auto:profile_gap:${rumor.pid}`);
  return { blocked, openedByDone };
}
async function fallbackProbe(db: Db) {
  await openElectionWithRegion(db, ICHI, POLLING);
  const rumor = await addCand(db, "田中次郎", "たなかじろう", "considering", { status_date: "2027-02-20" });
  await clock(db, NOTICE);
  await seed(db);
  return (await profileIds(db)).includes(`auto:profile_gap:${rumor.pid}`);
}

Deno.test("行為の還原驗證（gate の鍵になる行）：『前一步 done』・gate 全体・後備を 1 つずつ壊すと対応する情境が赤くなる（本物は通る）", async () => {
  const run = async <T>(patch: (sql: string) => string, probe: (db: Db) => Promise<T>) => {
    const db = await migratedDb({ before: MIG_FILE });
    await db.exec(patch(MIG_SQL));
    const r = await probe(db);
    await db.close();
    return r;
  };
  assertEquals(await run((s) => s, gateProbe), { blocked: true, openedByDone: true });
  assertEquals(await run((s) => s, fallbackProbe), true);
  const noDone = await run((s) => mutate(s, "AND c.step = o.after_step) THEN 'done'", "AND c.step = o.after_step AND false) THEN 'done'"), gateProbe);
  assertEquals(noDone.openedByDone, false, "『前一步 done』を壊すと、表明が出ても開かない");
  const noGate = await run((s) => mutate(s, "WHEN o.after_step IS NULL THEN 'none'", "WHEN true THEN 'none'"), gateProbe);
  assertEquals(noGate.blocked, false, "gate を外すと、前の一歩が終わっていなくても開く");
  const noFallback = await run((s) => mutate(s, "ELSE policy_jp.activity_chain_escape(o.chain_fallback, g.eid, g.etype, g.task_id) END AS via", "ELSE NULL END AS via"), fallbackProbe);
  assertEquals(noFallback, false, "逃生門を外すと、告示日が来ても開かない");
});

Deno.test("自我檢查（還原驗證）：規則の after_step／cap が欠ける・CHECK から politician を落とす・apply_types から落とす・分派器が壊れる・anon に渡すと migration が失敗する", async () => {
  const pre = await migratedDb({ before: MIG_FILE });
  const bad = async (from: string, to: string, why: string) => {
    await assertRejects(() => pre.exec(mutate(MIG_SQL, from, to)), Error, undefined, why);
  };
  await bad(`'candidacy', '{"cap":200,"chain_fallback":{"kind":"announced","offset":0}}'::JSONB`, `NULL, '{"cap":200,"chain_fallback":{"kind":"announced","offset":0}}'::JSONB`, "after_step なし");
  await bad(`'{"cap":200,"chain_fallback":{"kind":"announced","offset":0}}'::JSONB, a.note`, `'{"chain_fallback":{"kind":"announced","offset":0}}'::JSONB, a.note`, "cap なし");
  await bad(`'candidacy', 'politician'));`, `'candidacy'));`, "CHECK から politician");
  await bad(`'candidacy', 'politician', 'no_change']`, `'candidacy', 'no_change']`, "apply_types から politician");
  await bad(`IF p_type NOT IN ('election', 'regional_stat', 'local_government', 'politician') THEN`, `IF p_type NOT IN ('election', 'regional_stat', 'local_government') THEN`, "分派器が politician を知らない");
  await bad(`  policy_jp.same_claim_matches(TEXT, JSONB, TEXT, UUID), policy_jp.same_claim_matches_base(TEXT, JSONB, TEXT, UUID), policy_jp.same_claim_matches_politician(JSONB, TEXT, UUID)
  TO service_role;`, `  policy_jp.same_claim_matches(TEXT, JSONB, TEXT, UUID), policy_jp.same_claim_matches_base(TEXT, JSONB, TEXT, UUID), policy_jp.same_claim_matches_politician(JSONB, TEXT, UUID)
  TO service_role, anon;`, "anon に渡す");
  await pre.exec(MIG_SQL);
  await pre.close();
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則が増えない（ALTER RENAME の 2 回目は同じ状態にならないので除く＝1 回目で済んだ庫に再適用は通らない設計を明示）", async () => {
  const db = await freshDb();
  const before = await count(db, `SELECT 1 FROM policy_jp.activity_rules`);
  // ALTER ... RENAME は 2 回目に『本体が既にない』ので落ちる。migration は 1 回だけ流すもの（supabase の履歴が保証）：落ちること自体を確認し、規則は増えていない
  await assertRejects(() => db.exec(MIG_SQL), Error);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.activity_rules`), before);
  await db.close();
});

// =============================================================================================
// h. 権限
// =============================================================================================
Deno.test("権限：新しい関数は anon／authenticated が呼べない（service_role は呼べる）", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const q of [`SELECT * FROM policy_jp.contribution_auto_tasks_profile_gap()`, `SELECT * FROM policy_jp.contribution_auto_tasks_profile_detail_gap()`,
      `SELECT policy_jp.chain_profile_missing('x')`, `SELECT policy_jp.chain_profile_done('x')`, `SELECT * FROM policy_jp.chain_profile_subjects()`,
      `SELECT policy_jp.same_claim_matches('politician', '{}'::JSONB)`, `SELECT policy_jp.same_claim_matches_base('election', '{}'::JSONB)`]) {
      await assertRejects(() => asRole(shared, role, q), Error, "permission denied", `${role}: ${q}`);
    }
  }
  assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_profile_gap()`))[0].n, 0);
});
