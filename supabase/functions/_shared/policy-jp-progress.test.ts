/**
 * 日本站派工臂對齊正見：政策の進捗 progress_stale／期限到了 deadline_due（migration 20261011200000_policy_jp_progress.sql、工作単 Yooliang/policy-ops#95、C 期第 4b 步）
 *   臂 progress_stale（task_type progress_stale）＋臂 deadline_due（task_type deadline_due）＋新しい交件型別 policy_progress（落庫 SQL apply_policy_progress）。
 *   規則は enabled・常時窓・after_step なし（理由は migration の檔頭）。冷却の遞増（正見 task_cooldown_settings）は移植しない＝標準の冷却。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts），時鐘用 `SET app.activity_today`。
 *
 *   a. 結構：臂名・総表・規則・優先層（専用規則なし）・步驟順位・主控台の段・交件型別（CHECK・apply_types・共識は動かさない）・権限
 *   b. progress_stale：対象（公約は当選済み・終わっていない）・target・文言・stale_days・cap・deadline_due との排他
 *   c. deadline_due：対象（期限が過ぎ、期限より後の経過なし）・target・並び順・cap
 *   d. 抑制：not_found の冷却／no_change の等票中／規則を止める
 *   e. 落庫 apply_policy_progress：applied／古い日付／unchanged／invalid／履歴・出典・派工列の收回
 *   f. TS：JP_TASK_ARMS・JP_TASK_ALSO（removal）・任務比對・discontinued の出典・併票の鍵・協議版號
 *   g. 還原驗證・冪等・前の版に足しただけ・権限
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, applyOne, asRole, check, clock, count, dispatches, dispatchIds, events, expireCooling, freshDb, ICHI, insertElection, migratedDb, mutate, one,
  readMig, rows, seed, submit,
} from "./policy-jp-chain-db.ts";
import { JP_TASK_ALSO, JP_TASK_ARMS, validateContributionRequest } from "./jp/contribution-schema.ts";
import { JP_APPLY_TYPES } from "./jp/apply-contribution.ts";
import { JP_PROTOCOL_VERSION } from "./jp/protocol.ts";
import { claimKey } from "./duplicate-claim.ts";

const MIG_FILE = "20261011200000_policy_jp_progress.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV = await readMig("20261011190000_policy_jp_term_policies.sql");
const PAST = "2023-04-23";
const E0 = `${PAST}_mayor_${ICHI}`; // 前回の選挙（公約の元）
const TODAY = "2027-01-10";
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const TYPES = ["progress_stale", "deadline_due"];
const KOUHOU = "https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf";
const NEWS = "https://news.example.com/ichinomiya/1";
const POL_DESC = "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。";

const shared = await freshDb();
type Db = Awaited<ReturnType<typeof freshDb>>;
type Row = { task_id: string; task_type: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[]; reward: number; region: string };

/** 前回の選挙の当選者（任期つき）を入れ、公約を直接入れる */
async function stage(db: Db) {
  await insertElection(db, ICHI, PAST);
  await clock(db, TODAY);
}
let nameSeq = 0;
async function addPerson(db: Db, o: { status?: string } = {}) {
  const n = ++nameSeq;
  const pid = crypto.randomUUID();
  const peid = `${pid}:${E0}:at_large`;
  await db.query(`INSERT INTO policy_jp.politicians (id, name, kana, review_status) VALUES ($1, $2, $3, 'published')`, [pid, `山田太郎${n}`, `やまだたろう${n}`]);
  await db.query(`INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, status_date, district_kind, review_status)
                  VALUES ($1, $2, $3, $4, $5, 'at_large', 'published')`, [peid, pid, E0, o.status ?? "elected", PAST]);
  const oid = `office:${peid}`;
  await db.query(`INSERT INTO policy_jp.politician_offices (id, politician_id, position, lg_code, term_no, start_date, scheduled_end_date, election_id, politician_election_id, review_status)
                  VALUES ($1, $2, 'mayor', $3, 1, $4, $5, $6, $7, 'published')`, [oid, pid, ICHI, addDays(PAST, 8), addDays(PAST, 1460), E0, peid]);
  return { pid, peid, oid };
}
type PolOpts = { origin?: string; status?: string; last?: string | null; review?: string; title?: string; person?: Awaited<ReturnType<typeof addPerson>> };
/** 政策を直接入れる（pledge は参選につなぐ、それ以外は任期 office_ids につなぐ） */
async function addPol(db: Db, o: PolOpts = {}) {
  const person = o.person ?? await addPerson(db);
  const origin = o.origin ?? "pledge";
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO policy_jp.policies (id, title, description, category, origin, source_locator, politician_election_id, lg_code, office_ids, status, last_updated, review_status)
     VALUES ($1, $2, $3, '子育て', $4, '選挙公報 2 頁', $5, $6, $7, $8, $9, $10)`,
    [id, o.title ?? "保育所の待機児童をなくす", POL_DESC, origin, origin === "pledge" ? person.peid : null, ICHI, origin === "pledge" ? [] : [person.oid],
     o.status ?? "not_started", o.last === undefined ? addDays(TODAY, -200) : o.last, o.review ?? "published"]);
  return { id, ...person };
}
async function addDeadline(db: Db, policyId: string, date: string | null, o: { stated?: boolean; review?: string } = {}) {
  const stated = o.stated ?? true;
  await db.query(`INSERT INTO policy_jp.policy_elements (id, policy_id, element, stated, text, deadline_date, source_locator, review_status)
                  VALUES ($1, $2, 'deadline', $3, $4, $5, '選挙公報 2 頁', $6)`,
    [`${policyId}:deadline`, policyId, stated, stated ? "2026 年度末まで" : null, date, o.review ?? "published"]);
}
const addLog = (db: Db, policyId: string, date: string, review = "published") =>
  db.query(`INSERT INTO policy_jp.tracking_logs (id, policy_id, date, event, description, review_status) VALUES ($1, $2, $3, '経過の更新：進行中', '工事が始まった', $4)`,
    [crypto.randomUUID(), policyId, date, review]);
const staleRows = (db: Db) => rows<Row>(db, `SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM policy_jp.contribution_auto_tasks_progress_stale() ORDER BY task_id`);
const dueRows = (db: Db) => rows<Row>(db, `SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM policy_jp.contribution_auto_tasks_deadline_due() ORDER BY task_id`);
const setParams = (db: Db, activity: string, patch: Record<string, unknown>) =>
  db.query(`UPDATE policy_jp.activity_rules SET params = params || $2::JSONB WHERE activity = $1 AND priority IS NULL`, [activity, JSON.stringify(patch)]);

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：臂名・総表・規則・優先層（専用規則なし）・步驟順位・主控台の段・交件型別・共識は動かさない", async () => {
  const names = (await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a;
  assert(names.includes("progress_stale") && names.includes("deadline_due"));
  const total = fnText(MIG_SQL, TOTAL);
  assert(total.includes("SELECT 'progress_stale' AS arm, t.* FROM policy_jp.contribution_auto_tasks_progress_stale() t"), "総表に progress_stale");
  assert(total.includes("SELECT 'deadline_due' AS arm, t.* FROM policy_jp.contribution_auto_tasks_deadline_due() t"), "総表に deadline_due");
  type R = { window_kind: string; min_status: string; after_step: string | null; enabled: boolean; params: Record<string, unknown> };
  const q = (a: string) => one<R>(shared, `SELECT window_kind, min_status, after_step, enabled, params FROM policy_jp.activity_rules WHERE activity = $1 AND priority IS NULL`, [a]);
  const s = await q("progress_stale");
  assertEquals([s.window_kind, s.after_step, s.enabled], ["always", null, true]);
  assertEquals(s.params, { cap: 100, stale_days: 90 });
  const d = await q("deadline_due");
  assertEquals([d.window_kind, d.after_step, d.enabled], ["always", null, true]);
  assertEquals(d.params, { cap: 100 });
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity IN ('priority:progress_stale', 'priority:deadline_due')`), 0, "優先層の専用規則を置かない");
  const rank = (id: string, ty: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, ty]).then((x) => x.r);
  assertEquals(await rank("auto:progress_stale:x", "progress_stale"), 9);
  assertEquals(await rank("auto:deadline_due:x", "deadline_due"), 9);
  assertEquals(await rank("auto:term_policy_missing:x", "term_policy_missing"), 8);
  assertEquals(await rank("auto:duplicate_policy:x:y", "duplicate_policy"), 8, "既存の順位は動かない");
  assertEquals(await rank("auto:policy_missing:x", "policy_missing"), 6);
  const st = await rows<{ arm: string; stage: number }>(shared, `SELECT arm, stage::INT AS stage FROM policy_jp.console_arm_stage_map WHERE arm IN ('progress_stale', 'deadline_due') ORDER BY arm`);
  assertEquals(st, [{ arm: "deadline_due", stage: 6 }, { arm: "progress_stale", stage: 6 }]);
  // 交件型別
  const types = (await one<{ t: string[] }>(shared, `SELECT policy_jp.apply_types() AS t`)).t;
  assertEquals([...types].sort(), [...JP_APPLY_TYPES, "no_change"].filter((x, i, a) => a.indexOf(x) === i).sort(), "SQL の apply_types と TS の JP_APPLY_TYPES が一致");
  assert(types.includes("policy_progress"));
  assertEquals(await count(shared, `SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%policy_progress%'`), 1);
  // 共識：網段 1 つ・目標 3・系統票の候選に入らない（この支は共識関数を定義しない）
  const n = await one<{ ips: boolean; agree: number; sys: string[] }>(shared,
    `SELECT policy_jp.contribution_needs_two_ips('policy_progress', '{}'::JSONB) AS ips, policy_jp.contribution_required_agree('policy_progress', '{}'::JSONB, ARRAY[]::TEXT[]) AS agree, policy_jp.system_one_precheck_types() AS sys`);
  assertEquals([n.ips, n.agree, n.sys.includes("policy_progress")], [false, 3, false]);
  for (const f of ["contribution_needs_two_ips", "contribution_required_agree", "system_one_precheck_types", "same_claim_matches", "task_unavailable", "refresh_dispatch_blocked"]) {
    assert(!MIG_SQL.includes(`FUNCTION policy_jp.${f}(`), `${f} を定義しない`);
  }
  const code = MIG_SQL.replace(/--[^\n]*/g, "");
  assert(!code.includes("public.") && !code.includes("ditrust"), "public／ditrust を触らない");
});

// =============================================================================================
// b. progress_stale
// =============================================================================================
Deno.test("progress_stale：当選済みの公約・未着手で 200 日止まっている → 1 件。target・文言（未着手の公約用）・hint・region", async () => {
  const db = await freshDb();
  await stage(db);
  const p = await addPol(db);
  const a = await staleRows(db);
  assertEquals(a.length, 1);
  const t = a[0];
  assertEquals([t.task_id, t.task_type, t.reward, t.region], [`auto:progress_stale:${p.id}`, "progress_stale", 1, "愛知県"]);
  assertEquals(t.target, {
    policy_id: p.id, policy_title: "保育所の待機児童をなくす", category: "子育て", status: "not_started", origin: "pledge",
    politician_id: p.pid, name: "山田太郎1", kana: "やまだたろう1", politician_election_id: p.peid, candidacy_status: "elected",
    election_id: E0, election_name: "一宮市mayor選挙", election_type: "mayor", election_date: PAST,
    lg_code: ICHI, lg_name: "一宮市", last_updated: addDays(TODAY, -200), last_log_date: null, stale_days: 90,
  });
  assert(t.what_we_need.includes("まだ「未着手」のままで") && t.what_we_need.includes("当選から時間が経つのに"), "未着手の公約の文言");
  assert(t.what_we_need.includes("contribution_type=removal") && t.what_we_need.includes("contribution_type=policy_progress"));
  assert(t.what_we_need.includes(`auto:progress_stale:${p.id}`) && t.what_we_need.includes(p.id));
  assert(t.hint_sources.length === 5 && t.hint_sources[0].includes("一宮市"));
  // 進行中の政策は別の文言
  const q = await addPol(db, { status: "in_progress", title: "道路の拡幅" });
  const b = (await staleRows(db)).find((r) => r.task_id === `auto:progress_stale:${q.id}`)!;
  assert(b.what_we_need.includes("いまの状態：進行中") && !b.what_we_need.includes("当選から時間が経つのに"));
  await db.close();
});

Deno.test("progress_stale：対象の線引き（終わった状態・当選していない人の公約・非公開・新しい更新／経過）と公約以外（任期の人物）", async () => {
  const db = await freshDb();
  await stage(db);
  const ok = await addPol(db, { title: "対象" });
  for (const status of ["achieved", "discontinued", "unfulfilled"]) await addPol(db, { status, title: `終わり-${status}` });
  await addPol(db, { person: await addPerson(db, { status: "not_elected" }), title: "落選者の公約" });
  await addPol(db, { person: await addPerson(db, { status: "declared" }), title: "当落未記録の公約" });
  await addPol(db, { review: "pending", title: "非公開" });
  await addPol(db, { last: addDays(TODAY, -30), title: "最近の更新" });
  const logged = await addPol(db, { title: "最近の経過あり" });
  await addLog(db, logged.id, addDays(TODAY, -10));
  const oldLog = await addPol(db, { title: "古い経過だけ" });
  await addLog(db, oldLog.id, addDays(TODAY, -150));
  await addLog(db, logged.id, addDays(TODAY, -5), "pending"); // 非公開の経過は数えない（logged は公開済みの経過があるので出ない）
  const addr = await addPol(db, { origin: "policy_address", title: "施政方針の項目", status: "in_progress" });
  const noDate = await addPol(db, { title: "更新日なし", last: null }); // created_at は実時計＝今日 2027-01-10 より先なので対象外
  void noDate;
  const ids = (await staleRows(db)).map((r) => r.task_id).sort();
  assertEquals(ids, [`auto:progress_stale:${ok.id}`, `auto:progress_stale:${oldLog.id}`, `auto:progress_stale:${addr.id}`].sort());
  const addrRow = (await staleRows(db)).find((r) => r.task_id === `auto:progress_stale:${addr.id}`)!;
  assertEquals([addrRow.target.origin, addrRow.target.politician_election_id, addrRow.target.election_id, addrRow.target.candidacy_status],
    ["policy_address", null, E0, null].map((x, i) => i === 2 ? E0 : x) as unknown[]);
  assertEquals(addrRow.target.last_log_date, null);
  const oldRow = (await staleRows(db)).find((r) => r.task_id === `auto:progress_stale:${oldLog.id}`)!;
  assertEquals(oldRow.target.last_log_date, addDays(TODAY, -150));
  await db.close();
});

Deno.test("progress_stale：stale_days と cap が効く（古い順）；deadline_due の対象は出さない；規則を止めると何も返さない", async () => {
  const db = await freshDb();
  await stage(db);
  const a = await addPol(db, { last: addDays(TODAY, -100), title: "A" });
  const b = await addPol(db, { last: addDays(TODAY, -300), title: "B" });
  const c = await addPol(db, { last: addDays(TODAY, -200), title: "C" });
  assertEquals((await staleRows(db)).length, 3);
  await setParams(db, "progress_stale", { cap: 2 });
  assertEquals((await staleRows(db)).map((r) => r.task_id), [`auto:progress_stale:${b.id}`, `auto:progress_stale:${c.id}`].sort(), "古い順に 2 件");
  await setParams(db, "progress_stale", { cap: 100, stale_days: 150 });
  assertEquals((await staleRows(db)).map((r) => r.task_id), [`auto:progress_stale:${b.id}`, `auto:progress_stale:${c.id}`].sort(), "100 日止まりは出ない");
  await setParams(db, "progress_stale", { stale_days: 90 });
  // C に期限が過ぎた deadline を足すと progress_stale からは消えて deadline_due に出る
  await addDeadline(db, c.id, addDays(TODAY, -20));
  assertEquals((await staleRows(db)).map((r) => r.task_id), [`auto:progress_stale:${a.id}`, `auto:progress_stale:${b.id}`].sort());
  assertEquals((await dueRows(db)).map((r) => r.task_id), [`auto:deadline_due:${c.id}`]);
  // 総表は規則の enabled を見る
  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = false WHERE activity = 'progress_stale' AND priority IS NULL`);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_arms() WHERE arm = 'progress_stale'`), 0);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_arms() WHERE arm = 'deadline_due'`), 1, "deadline_due は別の規則");
  await db.close();
});

// =============================================================================================
// c. deadline_due
// =============================================================================================
Deno.test("deadline_due：期限が過ぎ、期限より後の経過がない → 1 件。target・文言・並び順（期限が早い順）・cap・対象外", async () => {
  const db = await freshDb();
  await stage(db);
  const a = await addPol(db, { title: "A", last: addDays(TODAY, -5) }); // 最近更新されていても、期限が過ぎていれば対象
  await addDeadline(db, a.id, "2026-12-31");
  const b = await addPol(db, { title: "B" });
  await addDeadline(db, b.id, "2026-06-30");
  const rowsDue = await dueRows(db);
  assertEquals(rowsDue.map((r) => r.task_id).sort(), [`auto:deadline_due:${a.id}`, `auto:deadline_due:${b.id}`].sort());
  const t = rowsDue.find((r) => r.task_id === `auto:deadline_due:${b.id}`)!;
  const nm = await one<{ name: string; kana: string }>(db, `SELECT name, kana FROM policy_jp.politicians WHERE id = $1`, [b.pid]);
  assertEquals([t.task_type, t.reward, t.region], ["deadline_due", 1, "愛知県"]);
  assertEquals(t.target, {
    policy_id: b.id, policy_title: "B", category: "子育て", status: "not_started", origin: "pledge",
    politician_id: b.pid, name: nm.name, kana: nm.kana, politician_election_id: b.peid, candidacy_status: "elected",
    election_id: E0, election_name: "一宮市mayor選挙", election_type: "mayor", election_date: PAST,
    lg_code: ICHI, lg_name: "一宮市", last_updated: addDays(TODAY, -200), last_log_date: null,
    deadline_date: "2026-06-30", deadline_text: "2026 年度末まで", deadline_source_url: null, deadline_source_locator: "選挙公報 2 頁",
  });
  assert(t.what_we_need.includes("2026-06-30") && t.what_we_need.includes("2026 年度末まで") && t.what_we_need.includes(`auto:deadline_due:${b.id}`));
  // 期限が早い順に cap 件
  await setParams(db, "deadline_due", { cap: 1 });
  assertEquals((await dueRows(db)).map((r) => r.task_id), [`auto:deadline_due:${b.id}`]);
  await setParams(db, "deadline_due", { cap: 100 });
  // 対象外：期限が未来／期限より後の経過あり（期限当日は『後』ではない）／未説明／日付なし／非公開の要素／終わった状態
  const f = await addPol(db, { title: "未来" }); await addDeadline(db, f.id, addDays(TODAY, 30));
  const l = await addPol(db, { title: "経過あり" }); await addDeadline(db, l.id, "2026-06-30"); await addLog(db, l.id, "2026-07-01");
  const l2 = await addPol(db, { title: "期限当日の経過" }); await addDeadline(db, l2.id, "2026-06-30"); await addLog(db, l2.id, "2026-06-30");
  const u = await addPol(db, { title: "未説明" }); await addDeadline(db, u.id, null, { stated: false });
  const nd = await addPol(db, { title: "日付なし" }); await addDeadline(db, nd.id, null);
  const pr = await addPol(db, { title: "非公開の要素" }); await addDeadline(db, pr.id, "2026-06-30", { review: "pending" });
  const ach = await addPol(db, { title: "達成済み", status: "achieved" }); await addDeadline(db, ach.id, "2026-06-30");
  const got = (await dueRows(db)).map((r) => r.task_id).sort();
  assertEquals(got, [`auto:deadline_due:${a.id}`, `auto:deadline_due:${b.id}`, `auto:deadline_due:${l2.id}`].sort());
  await db.close();
});

// =============================================================================================
// d. 抑制
// =============================================================================================
Deno.test("抑制：not_found は冷却で戻る（標準の冷却）・no_change の等票中は派さない（両方の臂）", async () => {
  const db = await freshDb();
  await stage(db);
  const p = await addPol(db, { title: "A" });
  const d = await addPol(db, { title: "B" });
  await addDeadline(db, d.id, "2026-06-30");
  const t0 = `auto:progress_stale:${p.id}`, t1 = `auto:deadline_due:${d.id}`;
  assertEquals([(await staleRows(db)).map((r) => r.task_id), (await dueRows(db)).map((r) => r.task_id)], [[t0], [t1]]);
  await check(db, t0, "not_found");
  await check(db, t1, "not_found");
  assertEquals([(await staleRows(db)).length, (await dueRows(db)).length], [0, 0], "not_found は冷却中");
  await expireCooling(db);
  assertEquals([(await staleRows(db)).length, (await dueRows(db)).length], [1, 1], "冷却が過ぎれば戻る（遞増なし：2 回目も同じ標準の冷却）");
  await check(db, t0, "not_found");
  await expireCooling(db);
  assertEquals((await staleRows(db)).length, 1, "2 回目の not_found も標準の冷却で戻る");
  const nc = await submit(db, "no_change", { task_id: t0, outcome: "not_found", checked_urls: [KOUHOU], finding: "施政方針も予算書も探したが新しい動きは見つからなかった" }, { status: "pending", task: t0 });
  assertEquals((await staleRows(db)).length, 0, "no_change 等票中");
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [nc]);
  assertEquals((await staleRows(db)).length, 1);
  await db.close();
});

Deno.test("派工列：seed で progress_stale／deadline_due が入り、層は既定の中段・鎖の gate なし；進捗が落庫されると次の seed で収回（filled）", async () => {
  const db = await freshDb();
  await stage(db);
  const p = await addPol(db, { title: "A" });
  const d = await addPol(db, { title: "B", last: addDays(TODAY, -5) });
  await addDeadline(db, d.id, "2026-06-30");
  await seed(db);
  const disp = await dispatches(db, TYPES);
  assertEquals(disp.map((r) => r.task_id), [`auto:deadline_due:${d.id}`, `auto:progress_stale:${p.id}`]);
  for (const r of disp) {
    assertEquals(r.priority, 2, "専用の優先層規則なし＝既定の中段");
    assertEquals(r.opened_by?.chain_gate, undefined, "鎖の gate なし");
  }
  assertEquals(disp.map((r) => r.opened_by?.arm), ["deadline_due", "progress_stale"]);
  // 落庫（in_progress・今日の日付）→ 古さも期限もなくなる → 次の seed で収回
  const tid = `auto:progress_stale:${p.id}`;
  const c = await submit(db, "policy_progress", { policy_id: p.id, status: "in_progress", date: addDays(TODAY, -3), note: "令和 8 年度当初予算に事業費が計上され、設計が始まった" },
    { status: "verified", urls: [KOUHOU], task: tid });
  assertEquals((await applyOne(db, c)).outcome, "applied");
  const c2 = await submit(db, "policy_progress", { policy_id: d.id, status: "achieved", date: addDays(TODAY, -2), note: "令和 8 年 12 月に開所し、定員が 300 人増えた" },
    { status: "verified", urls: [KOUHOU], task: `auto:deadline_due:${d.id}` });
  assertEquals((await applyOne(db, c2)).outcome, "applied");
  await seed(db);
  assertEquals(await dispatchIds(db, TYPES), []);
  assertEquals((await events(db, tid)).map((e) => e.event), ["opened", "closed"]);
  await db.close();
});

// =============================================================================================
// e. 落庫 apply_policy_progress
// =============================================================================================
const progress = (db: Db, policyId: string, patch: Record<string, unknown> = {}, urls = [KOUHOU]) =>
  submit(db, "policy_progress", { policy_id: policyId, status: "in_progress", date: addDays(TODAY, -3), note: "令和 8 年度当初予算に事業費が計上され、設計が始まった", ...patch }, { status: "verified", urls });

Deno.test("落庫：applied（status と last_updated を更新・tracking_logs 1 行・出典・edit_history 2 本・contributions に applied_policy_id）", async () => {
  const db = await freshDb();
  await stage(db);
  const p = await addPol(db);
  const id = await progress(db, p.id);
  const out = await applyOne(db, id);
  assertEquals([out.status, out.outcome, out.table_name], ["applied", "applied", "tracking_logs"], JSON.stringify(out));
  const pol = await one<{ status: string; last_updated: string }>(db, `SELECT status, to_char(last_updated, 'YYYY-MM-DD') AS last_updated FROM policy_jp.policies WHERE id = $1`, [p.id]);
  assertEquals(pol, { status: "in_progress", last_updated: addDays(TODAY, -3) });
  const log = await one<{ id: string; event: string; description: string; review_status: string }>(db,
    `SELECT id, event, description, review_status FROM policy_jp.tracking_logs WHERE policy_id = $1`, [p.id]);
  assertEquals([log.event, log.review_status], ["経過の更新：進行中", "published"]);
  assertEquals(log.id, out.record_id);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs sr WHERE sr.target_table = 'tracking_logs' AND sr.target_id = '${log.id}'`), 1, "出典が tracking_logs につく");
  const hist = await rows<{ table_name: string; agent_name: string }>(db, `SELECT table_name, agent_name FROM policy_jp.edit_history WHERE contribution_id = $1 ORDER BY id`, [id]);
  assertEquals(hist.map((h) => h.table_name), ["policies", "tracking_logs"]);
  assert(hist.every((h) => h.agent_name === "auto-apply"));
  const c = await one<{ status: string; applied_policy_id: string; applied_politician_id: string }>(db, `SELECT status, applied_policy_id, applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id]);
  assertEquals([c.status, c.applied_policy_id, c.applied_politician_id], ["applied", p.id, p.pid]);
  await db.close();
});

Deno.test("落庫：同じ経過をもう一度 → unchanged／現況より古い日付 → 時間軸にだけ記録し状態は変えない／同じ日の別の status は更新", async () => {
  const db = await freshDb();
  await stage(db);
  const p = await addPol(db);
  assertEquals((await applyOne(db, await progress(db, p.id))).outcome, "applied");
  const dup = await applyOne(db, await progress(db, p.id));
  assertEquals(dup.outcome, "unchanged", JSON.stringify(dup));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.tracking_logs WHERE policy_id = '${p.id}'`), 1, "同じ経過は増えない");
  // 古い日付：現況（last_updated = TODAY-3）より前の出来事
  const old = await applyOne(db, await progress(db, p.id, { status: "partial", date: addDays(TODAY, -40), note: "前年度の事業で一部が先に完了していた" }));
  assertEquals(old.outcome, "applied", JSON.stringify(old));
  assert(old.message!.includes("現在の状態は変えていない"), old.message);
  const pol = await one<{ status: string; last_updated: string }>(db, `SELECT status, to_char(last_updated, 'YYYY-MM-DD') AS last_updated FROM policy_jp.policies WHERE id = $1`, [p.id]);
  assertEquals(pol, { status: "in_progress", last_updated: addDays(TODAY, -3) });
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.tracking_logs WHERE policy_id = '${p.id}'`), 2);
  // 同じ日付の別 status は状態を更新（古くない）
  const same = await applyOne(db, await progress(db, p.id, { status: "achieved", date: addDays(TODAY, -3), note: "同じ日の報告で完了と書かれていた" }));
  assertEquals(same.outcome, "applied");
  assertEquals((await one<{ status: string }>(db, `SELECT status FROM policy_jp.policies WHERE id = $1`, [p.id])).status, "achieved");
  await db.close();
});

Deno.test("落庫：invalid（status 不正・note 短い・date 不正／未来・unfulfilled は公約だけ・discontinued は公的な出典・非公開／存在しない政策）は何も書かない", async () => {
  const db = await freshDb();
  await stage(db);
  const p = await addPol(db);
  const addr = await addPol(db, { origin: "policy_address", title: "施政方針の項目" });
  const hid = await addPol(db, { review: "pending", title: "非公開" });
  const cases: Array<[string, string, Record<string, unknown>, string[] | undefined]> = [
    ["status 不正", p.id, { status: "done" }, undefined],
    ["note が短い", p.id, { note: "進んだ" }, undefined],
    ["date が未来", p.id, { date: addDays(TODAY, 1) }, undefined],
    ["date が実在しない", p.id, { date: "2026-02-30" }, undefined],
    ["date の形が違う", p.id, { date: "2026/12/01" }, undefined],
    ["公約でない政策の unfulfilled", addr.id, { status: "unfulfilled" }, undefined],
    ["discontinued に公的な出典がない", p.id, { status: "discontinued" }, [NEWS]],
    ["非公開の政策", hid.id, {}, undefined],
    ["存在しない政策", crypto.randomUUID(), {}, undefined],
  ];
  for (const [why, pid, patch, urls] of cases) {
    const out = await applyOne(db, await progress(db, pid, patch, urls));
    assertEquals(out.outcome, "invalid", `${why}: ${JSON.stringify(out)}`);
  }
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.tracking_logs`), 0);
  assertEquals((await one<{ status: string }>(db, `SELECT status FROM policy_jp.policies WHERE id = $1`, [p.id])).status, "not_started");
  // 通る側：公約の unfulfilled・公的な出典つきの discontinued
  assertEquals((await applyOne(db, await progress(db, p.id, { status: "unfulfilled", note: "任期の終わりまでに着手されなかった（会議録で確認）" }))).outcome, "applied");
  assertEquals((await applyOne(db, await progress(db, addr.id, { status: "discontinued", note: "議会が事業の中止を決議した（令和 8 年 12 月議会）" }))).outcome, "applied");
  await db.close();
});

// =============================================================================================
// f. TS
// =============================================================================================
const PID = "5f0c8d6e-1111-4222-8333-444444444444";
const req = (type: string, payload: Record<string, unknown>, taskId?: string, urls = [KOUHOU]) => validateContributionRequest({
  agent_name: "jp-agent", agent_tool: "claude-code/claude-sonnet-5", contribution_type: type, payload, source_urls: urls, ...(taskId ? { task_id: taskId } : {}),
});
const goodProgress = { policy_id: PID, status: "in_progress", date: "2026-06-01", note: "令和 8 年度当初予算に事業費が計上され、設計が始まった" };

Deno.test("TS：progress_stale／deadline_due は policy_progress で答える（progress_stale は removal でも）；policy_id の一致・status・日付・note・progress 不可", () => {
  assertEquals(JP_TASK_ARMS.progress_stale, "policy_progress");
  assertEquals(JP_TASK_ARMS.deadline_due, "policy_progress");
  assertEquals(JP_TASK_ALSO.progress_stale, ["removal"]);
  assert(req("policy_progress", goodProgress, `auto:progress_stale:${PID}`).ok);
  assert(req("policy_progress", goodProgress, `auto:deadline_due:${PID}`).ok);
  assert(req("policy_progress", goodProgress).ok, "任務なしでも出せる");
  // 別の政策の任務に答える
  const other = req("policy_progress", { ...goodProgress, policy_id: "5f0c8d6e-9999-4222-8333-444444444444" }, `auto:progress_stale:${PID}`);
  assertEquals(other.errors.map((e) => e.path), ["payload.policy_id"]);
  // removal は progress_stale だけ、target_id が任務の政策と一致
  const rem = (id: string, task: string) => req("removal", { target_table: "policies", target_id: id, reason: "施政方針のスローガンで、経過を追える政策ではないため" }, task);
  assert(rem(PID, `auto:progress_stale:${PID}`).ok, JSON.stringify(rem(PID, `auto:progress_stale:${PID}`).errors));
  assertEquals(rem("5f0c8d6e-9999-4222-8333-444444444444", `auto:progress_stale:${PID}`).errors.map((e) => e.path), ["payload.target_id"]);
  assert(rem(PID, `auto:deadline_due:${PID}`).errors.some((e) => e.path === "task_id"), "deadline_due は removal では答えない");
  // 他の型別
  const wrong = req("policy", { politician_election_id: `${PID}:${E0}:at_large`, title: "x", description: "y", category: "z", source_locator: "w", resolved_claim: "new" }, `auto:progress_stale:${PID}`);
  assert(wrong.errors.some((e) => e.path === "task_id" && e.message.includes("policy_progress")), JSON.stringify(wrong.errors));
  // 項目の検査
  assert(req("policy_progress", { ...goodProgress, status: "done" }).errors.some((e) => e.path === "payload.status"));
  assert(req("policy_progress", { ...goodProgress, note: "進んだ" }).errors.some((e) => e.path === "payload.note"));
  assert(req("policy_progress", { ...goodProgress, date: "2999-01-01" }).errors.some((e) => e.path === "payload.date"));
  assert(req("policy_progress", { ...goodProgress, date: "2026-02-30" }).errors.some((e) => e.path === "payload.date"));
  assert(req("policy_progress", { ...goodProgress, progress: 50 }).errors.some((e) => e.path === "payload.progress"), "％は日本版では使わない");
  assert(req("policy_progress", { ...goodProgress, policy_id: "" }).errors.some((e) => e.path === "payload.policy_id"));
  assert(req("policy_progress", goodProgress, undefined, []).errors.some((e) => e.path === "source_urls"));
  // no_change で not_found を返せる
  const nc = req("no_change", { task_id: `auto:progress_stale:${PID}`, outcome: "not_found", checked_urls: [KOUHOU], finding: "施政方針も予算書も探したが新しい動きは見つからなかった" }, `auto:progress_stale:${PID}`);
  assert(nc.ok, JSON.stringify(nc.errors));
});

Deno.test("TS：discontinued は公的な出典（*.lg.jp・*.go.jp・自治体の公式）が要る（SQL の落庫と同じ判定）；unfulfilled の公約判定は落庫側", () => {
  const dis = { ...goodProgress, status: "discontinued", note: "議会が事業の中止を決議した（令和 8 年 12 月議会）" };
  assert(req("policy_progress", dis, undefined, [KOUHOU]).ok);
  assert(req("policy_progress", dis, undefined, ["https://www.pref.aichi.lg.jp/x"]).ok);
  const bad = req("policy_progress", dis, undefined, [NEWS]);
  assert(bad.errors.some((e) => e.path === "source_urls" && e.message.includes("公的")), JSON.stringify(bad.errors));
  assert(req("policy_progress", { ...goodProgress, status: "achieved" }, undefined, [NEWS]).ok, "他の status は報道でもよい");
});

Deno.test("TS：併票の鍵（claimKey）— policy_progress は policy_id＋status＋日付；登記表の型別ではない", () => {
  const a = claimKey("policy_progress", goodProgress as never);
  const b = claimKey("policy_progress", { ...goodProgress, note: "別の言い回しの説明文でも同じ出来事" } as never);
  const c = claimKey("policy_progress", { ...goodProgress, status: "achieved" } as never);
  assert(a !== null && a === b, "note が違っても同じ件");
  assert(a !== c, "status が違えば別の件");
});

Deno.test("協議版號：JP_PROTOCOL_VERSION は 0.20.0 以上（この支で 0.19.0 → 0.20.0）", () => {
  const n = (v: string) => v.split(".").map(Number).reduce((a, x) => a * 1000 + x, 0);
  assert(n(JP_PROTOCOL_VERSION) >= n("0.20.0"), JP_PROTOCOL_VERSION);
});

// =============================================================================================
// g. 還原驗證・冪等・前の版に足しただけ・権限
// =============================================================================================
Deno.test("自我檢查（還原驗證）：規則・cap／stale_days・優先層の専用規則・総表の分支・臂名・順位・主控台の段・CHECK・apply_types・WHEN・共識・anon が欠ける／違うと、migration が失敗する", async () => {
  const pre = await migratedDb({ before: MIG_FILE });
  const bad = async (from: string, to: string, why: string) => {
    await assertRejects(() => pre.exec(mutate(MIG_SQL, from, to)), Error, undefined, why);
  };
  await bad(`SELECT 'progress_stale', 'always', 'announced',`, `SELECT 'progress_stale', 'month', 'announced',`, "progress_stale が常時窓でない");
  await bad(`'{"cap":100,"stale_days":90}'::JSONB,`, `'{"cap":100}'::JSONB,`, "stale_days がない");
  await bad(`SELECT 'deadline_due', 'always', 'announced',\n       '{"cap":100}'::JSONB,`, `SELECT 'deadline_due', 'always', 'announced',\n       '{}'::JSONB,`, "deadline_due に cap がない");
  await bad(`  UNION ALL SELECT 'progress_stale' AS arm, t.* FROM policy_jp.contribution_auto_tasks_progress_stale() t\n`, "", "総表に progress_stale が無い");
  await bad(`  UNION ALL SELECT 'deadline_due' AS arm, t.* FROM policy_jp.contribution_auto_tasks_deadline_due() t\n`, "", "総表に deadline_due が無い");
  await bad(`'term_policies',\n    'progress_stale'`, `'term_policies',\n    'progress_stale_x'`, "臂名が違う");
  await bad(`  ('deadline_due', 6, '達成期限`, `  ('deadline_due', 5, '達成期限`, "主控台の段が違う");
  await bad(`'removal', 'policy_progress'));`, `'removal'));`, "CHECK に policy_progress がない");
  await bad(`'removal', 'policy_progress', 'no_change']`, `'removal', 'no_change']`, "apply_types に policy_progress がない");
  await bad(`               WHEN 'policy_progress' THEN policy_jp.apply_policy_progress(c)\n`, "", "apply_contribution に WHEN がない");
  await bad(`  TO service_role;\n\n-- ------------------------------------------------------------\n-- 9.`, `  TO service_role, anon;\n\n-- ------------------------------------------------------------\n-- 9.`, "anon に渡す");
  await pre.exec(MIG_SQL);
  await pre.close();
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則・主控台登記が増えない（規則は開いたまま）", async () => {
  const db = await freshDb();
  const n = () => Promise.all([count(db, `SELECT 1 FROM policy_jp.activity_rules`), count(db, `SELECT 1 FROM policy_jp.console_arm_stage_map`)]);
  const before = await n();
  await db.exec(MIG_SQL);
  assertEquals(await n(), before);
  assertEquals(await rows<{ a: string; e: boolean }>(db, `SELECT activity AS a, enabled AS e FROM policy_jp.activity_rules WHERE activity IN ('progress_stale', 'deadline_due') AND priority IS NULL ORDER BY 1`),
    [{ a: "deadline_due", e: true }, { a: "progress_stale", e: true }]);
  await db.close();
});

Deno.test("緊接在前一版：総表・臂名・順位・apply_contribution は前の版に『足しただけ』（残りは一字も変えない）", () => {
  const strip = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  assertEquals(
    strip(fnText(MIG_SQL, TOTAL))
      .replace(" UNION ALL SELECT 'progress_stale' AS arm, t.* FROM policy_jp.contribution_auto_tasks_progress_stale() t", "")
      .replace(" UNION ALL SELECT 'deadline_due' AS arm, t.* FROM policy_jp.contribution_auto_tasks_deadline_due() t", ""),
    strip(fnText(PREV, TOTAL)));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.chain_step_rank")).replace(" WHEN 'progress_stale' THEN 9", "").replace(" WHEN 'deadline_due' THEN 9", ""),
    strip(fnText(PREV, "policy_jp.chain_step_rank")).replace(/COMMENT.*$/, ""));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.activity_arm_names")).replace(", 'progress_stale', 'deadline_due'", ""), strip(fnText(PREV, "policy_jp.activity_arm_names")));
});

Deno.test("権限：新しい関数は anon／authenticated が呼べない（service_role は呼べる）", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const f of ["contribution_auto_tasks_progress_stale()", "contribution_auto_tasks_deadline_due()", "progress_subjects()", "deadline_due_subjects()"]) {
      await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.${f}`), Error, "permission denied");
    }
  }
  for (const f of ["contribution_auto_tasks_progress_stale()", "contribution_auto_tasks_deadline_due()", "progress_subjects()", "deadline_due_subjects()"]) {
    assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.${f}`))[0].n, 0);
  }
});
