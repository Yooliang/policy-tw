/**
 * 日本站派工臂對齊正見：政見三要素 policy_elements（migration 20261011140000_policy_jp_policy_elements.sql、工作單 Yooliang/policy-ops#95）
 *   臂 policy_elements（task_type policy_elements_missing）＋交件型別 policy_elements＋落庫 apply_policy_elements＋同一件事登記。規則は預設關（enabled=false）。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts），時鐘用 `SET app.activity_today`，整條流程走 seed_auto_task_queue()＋task_dispatches／gap_events。
 *
 *   a. 結構：臂名・総表・規則の三處一緒；規則＝預設關／always／after_step=candidacy／後備／cap／params.elements；優先層；步驟順位 8；主控台の段；型別清單（CHECK・apply_types）
 *   b. 預設關：臂は行を返す（読み取りだけ）が、seed しても派工列は 0；UPDATE enabled=true で開く（via=done）
 *   c. 臂：params.elements で絞る・すでに公開済みの要素は出さない・交件待ちの政見は派さない・取りやめの参選は出さない・投票後は当選者で未達成の政見だけ
 *   d. 落庫：要素の書き込み・stated=false は「未説明」・同じ値は unchanged・違う値は conflict（全体を退件）・deadline_date は deadline だけ・非公開の行は置き換え・出典と履歴
 *   e. 任務の收回：3 要素が揃うと filled／一部だけなら残りの要素で戻る
 *   f. 同一件事：same_claim_matches の分派・探査モード・収編の内容比較
 *   g. 還原驗證・冪等・權限
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, applyOne, asRole, clock, count, dispatches, dispatchIds, events, freshDb, ELECTION_URL, ICHI, migratedDb, mutate, one,
  openElectionWithRegion, readMig, rows, seed, submit,
} from "./policy-jp-chain-db.ts";

const MIG_FILE = "20261011140000_policy_jp_policy_elements.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV_RESULTS = await readMig("20261011090000_policy_jp_results_terms.sql");
const POLLING = "2027-04-25";
const E1 = `${POLLING}_mayor_${ICHI}`;
const PE_TYPES = ["policy_elements_missing"];
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const KOUHOU = "https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf";
const TODAY = addDays(POLLING, -10); // 告示日（投票日の 17 日前）の後、投票日の前：前段（投票日前 60 日以内）

const shared = await freshDb();
type Db = Awaited<ReturnType<typeof freshDb>>;

async function addCand(db: Db, name: string, kana: string, status = "declared"): Promise<{ pid: string; peid: string }> {
  const payload = { election_id: E1, name, kana, candidacy_status: status, status_date: "2027-03-01", district_kind: "at_large" };
  const id = await submit(db, "candidacy", payload, { status: "verified", urls: [ELECTION_URL] });
  const out = await applyOne(db, id);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pid = (await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id;
  return { pid, peid: out.record_id! };
}
/** 公約を 1 件落庫する（policy 交件＝本番と同じ経路）。政見 id を返す */
async function addPolicy(db: Db, peid: string, title = "保育所の待機児童をなくす"): Promise<string> {
  const out = await applyOne(db, await submit(db, "policy", {
    politician_election_id: peid, title, description: "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。",
    category: "子育て", source_locator: "選挙公報 2 頁「子育て」", resolved_claim: "new",
  }, { status: "verified", urls: [KOUHOU] }));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  return out.record_id!;
}
/** ふだんの舞台：選挙・候補者・公約 1 件。規則は開けない（呼び出し側が決める） */
async function stage(db: Db) {
  await openElectionWithRegion(db, ICHI, POLLING);
  const c = await addCand(db, "山田太郎", "やまだたろう");
  const policyId = await addPolicy(db, c.peid);
  await clock(db, TODAY);
  return { ...c, policyId };
}
const openRule = (db: Db, params?: string) => db.exec(`UPDATE policy_jp.activity_rules SET enabled = true${params ? `, params = params || '${params}'::JSONB` : ""} WHERE activity = 'policy_elements' AND priority IS NULL`);
const taskId = (policyId: string) => `auto:policy_elements_missing:${policyId}`;
const el = (element: string, stated: boolean, text: string | null, o: Record<string, unknown> = {}) => ({
  element, stated, ...(text !== null ? { text } : {}), source_locator: "選挙公報 3 頁「子育て」", ...o,
});
const submitEl = (db: Db, policyId: string, elements: unknown[], o: Parameters<typeof submit>[3] = {}) =>
  submit(db, "policy_elements", { policy_id: policyId, elements, resolved_claim: "new" }, { status: "verified", urls: [KOUHOU], ...o });
type ElRow = { element: string; stated: boolean; text: string | null; deadline_date: string | null; review_status: string };
const elRows = (db: Db, policyId: string) => rows<ElRow>(db, `SELECT element, stated, text, deadline_date::TEXT, review_status FROM policy_jp.policy_elements WHERE policy_id = $1 ORDER BY element`, [policyId]);
const armRows = (db: Db) => rows<{ task_id: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[] }>(db,
  `SELECT task_id, target, what_we_need, hint_sources FROM policy_jp.contribution_auto_tasks_policy_elements() ORDER BY task_id`);

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：臂名・総表・規則の三處一緒；規則＝預設關／always／after_step=candidacy／後備／cap／params.elements；優先層；步驟順位 8；主控台の段；型別清單（CHECK・apply_types）", async () => {
  assert((await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a.includes("policy_elements"));
  assert(fnText(MIG_SQL, TOTAL).includes("SELECT 'policy_elements' AS arm, t.* FROM policy_jp.contribution_auto_tasks_policy_elements() t"), "総表に UNION 分支");
  const r = await one<{ window_kind: string; min_status: string; after_step: string; enabled: boolean; params: Record<string, unknown> }>(shared,
    `SELECT window_kind, min_status, after_step, enabled, params FROM policy_jp.activity_rules WHERE activity = 'policy_elements' AND priority IS NULL`);
  assertEquals([r.window_kind, r.min_status, r.after_step, r.enabled], ["always", "announced", "candidacy", false], "預設關");
  assertEquals(r.params, { cap: 200, elements: ["target", "deadline", "funding"], chain_fallback: { kind: "announced", offset: 1 } });
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:policy_elements' AND priority IN (1, 3)`), 2);
  const rank = (id: string, t: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, t]).then((x) => x.r);
  assertEquals(await rank(taskId("x"), "policy_elements_missing"), 8);
  assertEquals(await rank("auto:policy_missing:x", "policy_missing"), 6, "既存の順位は動かない");
  assertEquals(await rank("auto:election_result_missing:x", "election_result_missing"), 7, "既存の順位は動かない");
  assertEquals(await rank("auto:something_new:x", "something_new"), 9, "未登録は 9 のまま");
  const st = await one<{ stage: number }>(shared, `SELECT stage::INT AS stage FROM policy_jp.console_arm_stage_map WHERE arm = 'policy_elements'`);
  assertEquals(st.stage, 3);
  assert((await one<{ a: string[] }>(shared, `SELECT policy_jp.apply_types() AS a`)).a.includes("policy_elements"));
  assertEquals(await count(shared, `SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%policy_elements%'`), 1);
});

// =============================================================================================
// b. 預設關
// =============================================================================================
Deno.test("預設關：臂は行を返すが（読み取りだけ）、seed しても派工列は 0；enabled=true にすると開く（via=done）、優先層は前段", async () => {
  const db = await freshDb();
  const s = await stage(db);
  const arm = await armRows(db);
  assertEquals(arm.map((x) => x.task_id), [taskId(s.policyId)], "規則が閉じていても臂は行を返す");
  assertEquals(arm[0].target.missing, ["target", "deadline", "funding"]);
  await seed(db);
  assertEquals(await dispatchIds(db, PE_TYPES), [], "窓が閉じている＝派工列にならない");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.task_dispatches WHERE task_id = $1`, [taskId(s.policyId)]), 0);
  await openRule(db);
  await seed(db);
  assertEquals(await dispatchIds(db, PE_TYPES), [taskId(s.policyId)]);
  const d = (await dispatches(db, PE_TYPES))[0];
  assertEquals(d.opened_by?.chain_gate, { after_step: "candidacy", via: "done" });
  assertEquals([d.opened_by?.arm, d.priority, d.region], ["policy_elements", 1, "愛知県"]);
  assertEquals([d.target.policy_id, d.target.politician_election_id, d.target.election_id, d.target.election_type, d.target.lg_code, d.target.chain_lg_code, d.target.chain_step],
    [s.policyId, s.peid, E1, "mayor", ICHI, ICHI, "policy"]);
  await db.close();
});

// =============================================================================================
// c. 臂
// =============================================================================================
Deno.test("臂：params.elements で絞る／公開済みの要素は出さない／交件待ちの政見は派さない／取りやめの参選は出さない；文言は日本語で中選會・READr を含まない", async () => {
  const db = await freshDb();
  const s = await stage(db);
  await openRule(db, '{"elements":["target","funding"]}');
  assertEquals((await armRows(db))[0].target.missing, ["target", "funding"], "deadline は規則に載っていないので出さない");
  const w = (await armRows(db))[0];
  assert(w.what_we_need.includes("会計年度") && w.what_we_need.includes("2029-03-31") && w.what_we_need.includes("stated=false") && w.what_we_need.includes("policy_elements") && w.what_we_need.includes(s.policyId));
  assert(!/中選會|READr|cec\.gov/i.test(w.what_we_need + w.hint_sources.join("")), "台湾の語を含まない");
  assert(w.hint_sources.some((h) => h.includes("選挙公報")) && w.hint_sources.some((h) => h.startsWith(KOUHOU)), "公報・現在の出典の案内");
  // 公開済みの target があれば残りは funding だけ
  await db.query(`INSERT INTO policy_jp.policy_elements (id, policy_id, element, stated, text, source_locator, review_status) VALUES ('e-t', $1, 'target', true, '300 人増やす', '公報 2 頁', 'published')`, [s.policyId]);
  assertEquals((await armRows(db))[0].target.missing, ["funding"]);
  // 非公開の行は「まだ無い」と同じ扱い
  await db.query(`UPDATE policy_jp.policy_elements SET review_status = 'pending' WHERE id = 'e-t'`);
  assertEquals((await armRows(db))[0].target.missing, ["target", "funding"]);
  // 3 つとも載せた上で全部公開済み＝出ない
  await db.query(`UPDATE policy_jp.policy_elements SET review_status = 'published' WHERE id = 'e-t'`);
  await db.query(`INSERT INTO policy_jp.policy_elements (id, policy_id, element, stated, source_locator, review_status) VALUES ('e-f', $1, 'funding', false, '公報 2 頁', 'published')`, [s.policyId]);
  assertEquals((await armRows(db)).length, 0);
  // election_ids：別の選挙だけを指定すると出ない
  await db.query(`DELETE FROM policy_jp.policy_elements`);
  await openRule(db, `{"election_ids":["2099-01-01_mayor_${ICHI}"]}`);
  assertEquals((await armRows(db)).length, 0);
  await openRule(db, `{"election_ids":["${E1}"]}`);
  assertEquals((await armRows(db)).length, 1);
  // 交件待ち（pending）の政見は派さない；退件で戻る
  const c = await submitEl(db, s.policyId, [el("target", true, "300 人増やす")], { status: "pending" });
  assertEquals((await armRows(db)).length, 0, "交件待ち");
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [c]);
  assertEquals((await armRows(db)).length, 1, "退件で戻る");
  // 取りやめた人の政見は出ない
  await db.query(`UPDATE policy_jp.politician_elections SET candidacy_status = 'withdrawn' WHERE id = $1`, [s.peid]);
  assertEquals((await armRows(db)).length, 0);
  await db.close();
});

Deno.test("臂：投票後は当選者の公約だけ（落選者は出ない）、達成・不履行・中止になった公約は出ない", async () => {
  const db = await freshDb();
  const s = await stage(db);
  const lose = await addCand(db, "佐藤花子", "さとうはなこ");
  const losePolicy = await addPolicy(db, lose.peid, "公共交通を増やす");
  await clock(db, addDays(POLLING, 1));
  await db.query(`UPDATE policy_jp.politician_elections SET candidacy_status = 'elected', status_date = $2 WHERE id = $1`, [s.peid, POLLING]);
  await db.query(`UPDATE policy_jp.politician_elections SET candidacy_status = 'not_elected', status_date = $2 WHERE id = $1`, [lose.peid, POLLING]);
  assertEquals((await armRows(db)).map((x) => x.task_id), [taskId(s.policyId)], "当選者の公約だけ");
  assert(!(await armRows(db)).some((x) => x.task_id === taskId(losePolicy)));
  for (const st of ["achieved", "unfulfilled", "discontinued"]) {
    await db.query(`UPDATE policy_jp.policies SET status = $2 WHERE id = $1`, [s.policyId, st]);
    assertEquals((await armRows(db)).length, 0, st);
  }
  await db.query(`UPDATE policy_jp.policies SET status = 'in_progress' WHERE id = $1`, [s.policyId]);
  assertEquals((await armRows(db)).length, 1, "進行中なら出る");
  await db.close();
});

// =============================================================================================
// d. 落庫
// =============================================================================================
Deno.test("落庫：3 要素を書く（stated=false は未説明・text なし、期限は deadline_date）；出典は source_refs、履歴は edit_history、applied_policy_id が付く", async () => {
  const db = await freshDb();
  const s = await stage(db);
  const id = await submitEl(db, s.policyId, [
    el("target", true, "待機児童を 0 にする"),
    el("deadline", true, "2028 年度まで", { deadline_date: "2029-03-31" }),
    el("funding", false, null, { source_locator: "選挙公報 3 頁を通読（財源の記載なし）" }),
  ]);
  const out = await applyOne(db, id);
  assertEquals([out.status, out.outcome, out.table_name, out.record_id], ["applied", "applied", "policy_elements", s.policyId], JSON.stringify(out));
  assertEquals(await elRows(db, s.policyId), [
    { element: "deadline", stated: true, text: "2028 年度まで", deadline_date: "2029-03-31", review_status: "published" },
    { element: "funding", stated: false, text: null, deadline_date: null, review_status: "published" },
    { element: "target", stated: true, text: "待機児童を 0 にする", deadline_date: null, review_status: "published" },
  ]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs r JOIN policy_jp.policy_elements x ON x.id = r.target_id WHERE r.target_table = 'policy_elements' AND x.policy_id = $1`, [s.policyId]), 3, "要素ごとに出典");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'policy_elements' AND contribution_id = $1 AND agent_name = 'auto-apply'`, [id]), 3);
  const c = await one<{ applied_policy_id: string; applied_politician_id: string; status: string }>(db, `SELECT applied_policy_id, applied_politician_id, status FROM policy_jp.contributions WHERE id = $1`, [id]);
  assertEquals([c.applied_policy_id, c.applied_politician_id, c.status], [s.policyId, s.pid, "applied"]);
  // 公開読み取り（anon）は公開済みの要素だけ読める
  assertEquals((await asRole<{ n: number }>(db, "anon", `SELECT count(*)::INT AS n FROM policy_jp.policy_elements WHERE policy_id = '${s.policyId}'`))[0].n, 3);
  await db.close();
});

Deno.test("落庫：同じ値は unchanged（出典だけ足す）／違う値は conflict で全体を退件（半分だけ書かない）／要素ごとの source_url が主要出典", async () => {
  const db = await freshDb();
  const s = await stage(db);
  await applyOne(db, await submitEl(db, s.policyId, [el("target", true, "待機児童を 0 にする")]));
  // 同じ値（空白・全角の違いは無視しない：text は原文のとおり。同一なら unchanged）
  const same = await submitEl(db, s.policyId, [el("target", true, "待機児童を 0 にする")], { urls: ["https://www.pref.aichi.lg.jp/senkyo/kouhou.html"] });
  const o1 = await applyOne(db, same);
  assertEquals([o1.status, o1.outcome], ["applied", "unchanged"], JSON.stringify(o1));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'policy_elements' AND target_id IN (SELECT id FROM policy_jp.policy_elements WHERE policy_id = $1)`, [s.policyId]), 2, "出典が足される");
  // 違う値 + 新しい要素：全体が conflict で、新しい要素も書かれない
  const diff = await submitEl(db, s.policyId, [el("target", true, "待機児童を半分にする"), el("funding", true, "市債を発行する")]);
  const o2 = await applyOne(db, diff);
  assertEquals([o2.status, o2.outcome], ["rejected", "conflict"], JSON.stringify(o2));
  assertEquals((await elRows(db, s.policyId)).map((r) => r.element), ["target"], "funding は書かれない");
  assertEquals((await elRows(db, s.policyId))[0].text, "待機児童を 0 にする", "上書きしない");
  assertEquals((await one<{ status: string }>(db, `SELECT status FROM policy_jp.contributions WHERE id = $1`, [diff])).status, "rejected");
  // stated の違い（未説明 vs あり）も conflict
  const o3 = await applyOne(db, await submitEl(db, s.policyId, [el("target", false, null)]));
  assertEquals(o3.outcome, "conflict");
  // 要素ごとの source_url が先頭（主要出典）になる
  const first = "https://www.city.ichinomiya.aichi.jp/senkyo/ichinomiya-pledge.html";
  const o4 = await applyOne(db, await submitEl(db, s.policyId, [el("funding", true, "市債を発行する", { source_url: first })], { urls: [KOUHOU, first] }));
  assertEquals(o4.outcome, "applied", JSON.stringify(o4));
  const prim = await one<{ url: string }>(db, `SELECT s.url FROM policy_jp.source_refs r JOIN policy_jp.sources s ON s.id = r.source_id JOIN policy_jp.policy_elements x ON x.id = r.target_id
    WHERE r.target_table = 'policy_elements' AND x.policy_id = $1 AND x.element = 'funding' AND r.role = 'primary'`, [s.policyId]);
  assertEquals(prim.url, first);
  await db.close();
});

Deno.test("落庫：非公開の行（pending）は置き換えて公開する；不備は invalid で退件（deadline_date は deadline だけ・stated=false に text・重複・範囲外の日付・存在しない政見・出典なし）", async () => {
  const db = await freshDb();
  const s = await stage(db);
  await db.query(`INSERT INTO policy_jp.policy_elements (id, policy_id, element, stated, text, source_locator, review_status) VALUES ('e-old', $1, 'target', true, '古い下書き', '公報', 'pending')`, [s.policyId]);
  const o = await applyOne(db, await submitEl(db, s.policyId, [el("target", true, "待機児童を 0 にする")]));
  assertEquals(o.outcome, "applied", JSON.stringify(o));
  assertEquals(await elRows(db, s.policyId), [{ element: "target", stated: true, text: "待機児童を 0 にする", deadline_date: null, review_status: "published" }]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.policy_elements WHERE policy_id = $1`, [s.policyId]), 1, "UNIQUE：行は増えない");
  const bad = async (elements: unknown[], needle: string, o2: { policy?: string; urls?: string[] } = {}) => {
    const r = await applyOne(db, await submitEl(db, o2.policy ?? s.policyId, elements, { urls: o2.urls }));
    assertEquals([r.status, r.outcome], ["rejected", "invalid"], `${needle}：${JSON.stringify(r)}`);
    assert((r.message ?? "").includes(needle), `${needle} ← ${r.message}`);
  };
  await bad([el("funding", true, "市債", { deadline_date: "2029-03-31" })], "deadline_date");
  await bad([el("deadline", false, null, { deadline_date: "2029-03-31" })], "deadline_date");
  await bad([el("deadline", true, "来年度", { deadline_date: "2029-02-30" })], "deadline_date");
  await bad([el("deadline", true, "来年度", { deadline_date: "2200-03-31" })], "deadline_date");
  await bad([el("funding", false, "未説明")], "text を付けない");
  await bad([el("funding", true, null)], "text が必須");
  await bad([el("funding", true, "あ".repeat(121))], "text が必須");
  await bad([{ element: "funding", stated: true, text: "市債" }], "source_locator");
  await bad([{ element: "other", stated: true, text: "x", source_locator: "y" }], "element は");
  await bad([{ element: "funding", text: "x", source_locator: "y" }], "stated は必須");
  await bad([el("funding", true, "a"), el("funding", true, "b")], "重複");
  await bad([], "elements は 1～3 個");
  await bad([el("funding", true, "市債")], "登録されていないか", { policy: "no-such-policy" });
  await bad([el("funding", true, "市債")], "使える http(s)", { urls: ["ftp://example.com/x"] });
  assertEquals((await elRows(db, s.policyId)).length, 1, "不備の交件は何も書かない");
  await db.close();
});

// =============================================================================================
// e. 任務の收回
// =============================================================================================
Deno.test("收回：一部だけ落庫なら残りの要素で戻る（target.missing が縮む）／3 要素が揃うと filled で閉じる", async () => {
  const db = await freshDb();
  const s = await stage(db);
  await openRule(db);
  await seed(db);
  assertEquals(await dispatchIds(db, PE_TYPES), [taskId(s.policyId)]);
  await applyOne(db, await submitEl(db, s.policyId, [el("target", true, "待機児童を 0 にする")], { task: taskId(s.policyId) }));
  assertEquals(await dispatchIds(db, PE_TYPES), [], "落庫で派工列は收回される");
  await seed(db);
  const d = (await dispatches(db, PE_TYPES))[0];
  assertEquals(d?.task_id, taskId(s.policyId), "残りの要素で戻る");
  assertEquals(d.target.missing, ["deadline", "funding"]);
  assert(d.what_we_need.includes("達成期限、財源"), "文言も残りの要素だけ");
  await applyOne(db, await submitEl(db, s.policyId, [el("deadline", true, "2028 年度まで", { deadline_date: "2029-03-31" }), el("funding", false, null)], { task: taskId(s.policyId) }));
  await seed(db);
  assertEquals(await dispatchIds(db, PE_TYPES), []);
  const ev = await events(db, taskId(s.policyId));
  assertEquals(ev.at(-1)?.event, "closed");
  assertEquals(ev.at(-1)?.reason, "filled");
  await db.close();
});

// =============================================================================================
// f. 同一件事
// =============================================================================================
Deno.test("同一件事：same_claim_matches が policy_elements を分派する（在庫・審議中・探査モード）、要素の集合と内容が同じなら収編の「同じ内容」", async () => {
  const db = await freshDb();
  const s = await stage(db);
  await applyOne(db, await submitEl(db, s.policyId, [el("target", true, "待機児童を 0 にする")]));
  const pend = await submitEl(db, s.policyId, [el("funding", true, "市債を発行する")], { status: "pending" });
  const m = async (payload: unknown) => (await one<{ m: { type: string; existing: Array<Record<string, unknown>>; pending: Array<Record<string, unknown>> } }>(db,
    `SELECT policy_jp.same_claim_matches('policy_elements', $1::JSONB) AS m`, [JSON.stringify(payload)])).m;
  // 探査（要素なし）：在庫の target と審議中の funding の両方
  const probe = await m({ policy_id: s.policyId });
  assertEquals(probe.type, "policy_elements");
  assertEquals(probe.existing.map((x) => x.element), ["target"]);
  assertEquals(probe.pending.map((x) => x.contribution_id), [pend]);
  // 要素を指定：重なる要素だけ
  assertEquals((await m({ policy_id: s.policyId, elements: [{ element: "funding" }] })).existing.length, 0);
  assertEquals((await m({ policy_id: s.policyId, elements: [{ element: "funding" }] })).pending.length, 1);
  assertEquals((await m({ policy_id: s.policyId, elements: [{ element: "target" }] })).existing.length, 1);
  assertEquals((await m({ policy_id: s.policyId, elements: [{ element: "deadline" }] })).pending.length, 0);
  // 別の政見には出ない
  assertEquals((await m({ policy_id: "other" })).existing.length, 0);
  // 内容比較
  const same = (a: unknown, b: unknown) => one<{ r: boolean }>(db, `SELECT policy_jp.same_claim_same_content('policy_elements', $1::JSONB, $2::JSONB) AS r`, [JSON.stringify(a), JSON.stringify(b)]).then((x) => x.r);
  const A = { policy_id: "p", elements: [el("target", true, "待機児童を 0 にする"), el("funding", false, null)] };
  assertEquals(await same(A, { policy_id: "p", elements: [el("funding", false, null), el("target", true, "待機児童を　０　にする")] }), true, "順序・空白・全半角を無視");
  assertEquals(await same(A, { policy_id: "p", elements: [el("target", true, "待機児童を 0 にする")] }), false, "要素の集合が違う");
  assertEquals(await same(A, { policy_id: "p", elements: [el("target", true, "待機児童を半分にする"), el("funding", false, null)] }), false, "値が違う");
  assertEquals(await same(A, { policy_id: "p", elements: "x" }), false, "形が違う");
  // 登録のない型別はこれまでどおり NULL
  assertEquals((await one<{ m: unknown }>(db, `SELECT policy_jp.same_claim_matches('no_change', '{}'::JSONB) AS m`)).m, null);
  // 収編：同じ内容の審議中が、落庫した方に収編される
  const dup = await submitEl(db, s.policyId, [el("funding", true, "市債を発行する")], { status: "pending" });
  await applyOne(db, await submit(db, "policy_elements", { policy_id: s.policyId, elements: [el("funding", true, "市債を発行する")], resolved_claim: "new" }, { status: "verified", urls: [KOUHOU] }));
  assertEquals((await one<{ status: string }>(db, `SELECT status FROM policy_jp.contributions WHERE id = $1`, [dup])).status, "superseded");
  await db.close();
});

// =============================================================================================
// g. 還原驗證・冪等・權限
// =============================================================================================
Deno.test("自我檢查（還原驗證）：規則が開いている／after_step が違う／後備なし／elements に知らない要素／総表の分支・臂名・順位・型別清單・分派器・觸發器の型別・anon が欠ける／あると、migration が失敗する；元の SQL は通る", async () => {
  const pre = await migratedDb({ before: MIG_FILE });
  const bad = async (from: string, to: string, why: string) => {
    await assertRejects(() => pre.exec(mutate(MIG_SQL, from, to)), Error, undefined, why);
  };
  await bad(`'announced', 'candidacy', false,`, `'announced', 'candidacy', true,`, "規則が開いている");
  await bad(`'announced', 'candidacy', false,`, `'announced', 'profile', false,`, "after_step が違う");
  await bad(`"funding"],"chain_fallback":{"kind":"announced","offset":1}}'::JSONB`, `"funding"]}'::JSONB`, "後備なし");
  await bad(`'{"cap":200,"elements":["target","deadline","funding"]`, `'{"cap":200,"elements":["target","deadline","budget"]`, "知らない要素");
  await bad(`  UNION ALL SELECT 'policy_elements' AS arm, t.* FROM policy_jp.contribution_auto_tasks_policy_elements() t\n`, "", "総表の分支が欠ける");
  await bad(`    'elected_missing',\n    'policy_elements'\n  ]`, `    'elected_missing'\n  ]`, "臂名が欠ける");
  await bad(`                  WHEN 'policy_elements_missing' THEN 8\n`, "", "順位が欠ける");
  await bad(`'policy', 'policy_elements', 'no_change']::TEXT[]`, `'policy', 'no_change']::TEXT[]`, "apply_types に無い");
  await bad(`               WHEN 'policy_elements' THEN policy_jp.apply_policy_elements(c)\n`, "", "apply_contribution の WHEN が無い");
  await bad(`  IF p_type = 'policy_elements' THEN\n    RETURN policy_jp.same_claim_matches_policy_elements(COALESCE(p_payload, '{}'::JSONB), p_ip_hash, p_exclude);\n  END IF;\n`, "", "分派器に分岐が無い");
  await bad(`'politician', 'policy', 'policy_elements'))\n  EXECUTE FUNCTION`, `'politician', 'policy'))\n  EXECUTE FUNCTION`, "収編觸發器の型別に無い");
  await bad(`  policy_jp.policy_element_normalize(JSONB), policy_jp.policy_elements_signature(JSONB), policy_jp.same_claim_matches_policy_elements(JSONB, TEXT, UUID)
  TO service_role;`, `  policy_jp.policy_element_normalize(JSONB), policy_jp.policy_elements_signature(JSONB), policy_jp.same_claim_matches_policy_elements(JSONB, TEXT, UUID)
  TO service_role, anon;`, "anon に渡す");
  await pre.exec(MIG_SQL);
  await pre.close();
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則・主控台登記が増えない", async () => {
  const db = await freshDb();
  const n = () => Promise.all([count(db, `SELECT 1 FROM policy_jp.activity_rules`), count(db, `SELECT 1 FROM policy_jp.console_arm_stage_map`)]);
  const before = await n();
  await db.exec(MIG_SQL);
  assertEquals(await n(), before);
  assertEquals((await one<{ e: boolean }>(db, `SELECT enabled AS e FROM policy_jp.activity_rules WHERE activity = 'policy_elements' AND priority IS NULL`)).e, false, "流し直しても預設關のまま");
  await db.close();
});

Deno.test("緊接在前一版：総表・臂名・順位は前の版に『1 行足しただけ』（残りは一字も変えない）", () => {
  const strip = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  const prevTotal = strip(fnText(PREV_RESULTS, TOTAL));
  const total = strip(fnText(MIG_SQL, TOTAL));
  assertEquals(total.replace(" UNION ALL SELECT 'policy_elements' AS arm, t.* FROM policy_jp.contribution_auto_tasks_policy_elements() t", ""), prevTotal);
  const prevRank = strip(fnText(PREV_RESULTS, "policy_jp.chain_step_rank"));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.chain_step_rank")).replace(" WHEN 'policy_elements_missing' THEN 8", ""), prevRank);
  const prevNames = strip(fnText(PREV_RESULTS, "policy_jp.activity_arm_names"));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.activity_arm_names")).replace(", 'policy_elements'", ""), prevNames);
});

Deno.test("権限：新しい関数は anon／authenticated が呼べない（service_role は呼べる）", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.contribution_auto_tasks_policy_elements()`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.policy_element_normalize('{}'::JSONB)`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.policy_elements_signature('{}'::JSONB)`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.same_claim_matches_policy_elements('{}'::JSONB, NULL, NULL)`), Error, "permission denied");
  }
  assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_policy_elements()`))[0].n, 0);
});
