/**
 * 日本站「告示前の読み（kana）は選填」と roster_check の not_found の冷卻を告示日で打ち切る
 * （migration 20261010120000_policy_jp_kana_optional.sql、工作單 Yooliang/policy-ops#60）。
 *
 * 只要 --allow-read，測試不寫檔。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts）；時鐘用 `SET app.activity_today`。
 * ※ now() は本物の時刻のまま（task_checks.checked_at は本物の「今」）。日付はすべて「本物の今日」からの相対で組む：
 *    固定の年月日にすると、本物の時間がその日を過ぎたときに黙って別の事を試すテストになる。
 *
 *   a. kana：告示前は kana なしの declared が落庫できる（politicians.kana は NULL）／告示日以降は invalid（読みなし）／politician_id 付きは不要／告示日の記録がなければ告示前扱い
 *   b. 同一人：読みなしは「同名・同団体・生年が衝突しない」唯一命中だけ／複数は新しい人／読みありは従来どおり／庫に読みがない人に読みが付いたら空欄を埋める
 *   c. 読みがない人：profile_gap の缺口と target.missing／profile 完了判定／politician 交件で読みを足す（空欄だけ・違う値は conflict）／same_claim／
 *      NULL の読みでも他の臂（profile_detail_gap・policy_missing）の seed が落ちない
 *   d. roster_check の not_found の冷卻：告示日の 3 日前に報告→告示日当日に戻る／20 日前に報告→14 日で戻る／confirmed・unreachable は不変／
 *      告示日以降の報告は 14 日／告示日の記録がなければ 14 日。鏈の roster 步驟の done も同じ
 *   e. 説明文：roster_check の出典の書き方（告示前＝報道・本人や政党の発信で可、告示後＝選管の公表を優先）
 *   f. 文字守門：被重新定義の関数は「緊接在前の定義」＋登記した機械替換だけ／冪等／権限
 * 各行為は「修正の一行を戻すと赤くなる」ことを還原驗證する（mutate は標記字串がちょうど一か所のときだけ通る）。
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, applyOne, asRole, check, clock, count, dispatchIds, dispatches, events, expireCooling, freshDb, ELECTION_URL, ICHI, insertElection, mutate, one,
  openElectionWithRegion, readMig, rows, seed, stepsDone, submit,
} from "./policy-jp-chain-db.ts";

const MIG_FILE = "20261010120000_policy_jp_kana_optional.sql";
const MIG_SQL = await readMig(MIG_FILE);
const ROSTER = ["roster_check"];

// ---- 日付は本物の今日からの相対（UTC の日付）。告示日は今日の 100 日後、投票日はその 17 日後 ----
const REAL_TODAY = new Date().toISOString().slice(0, 10);
const NOTICE = addDays(REAL_TODAY, 100);
const POLLING = addDays(NOTICE, 17);
const E1 = `${POLLING}_mayor_${ICHI}`;
const TASK = `auto:roster_check:${E1}`;

type Db = Awaited<ReturnType<typeof freshDb>>;
const candPayload = (o: Record<string, unknown> = {}) => ({
  election_id: E1, name: "山田太郎", kana: "やまだたろう", candidacy_status: "declared", status_date: addDays(NOTICE, -20), district_kind: "at_large", ...o,
});
const noKana = (o: Record<string, unknown> = {}) => {
  const p = candPayload(o);
  delete (p as Record<string, unknown>).kana;
  return p;
};
const submitCand = (db: Db, payload: Record<string, unknown>) => submit(db, "candidacy", payload, { status: "verified", urls: [ELECTION_URL] });
/** candidacy を落庫して { 結果, 人物 id } を返す */
async function addCand(db: Db, payload: Record<string, unknown>) {
  const id = await submitCand(db, payload);
  const out = await applyOne(db, id);
  const pid = (await one<{ applied_politician_id: string | null }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id;
  return { out, pid, id };
}
async function open(db: Db, o: { notice?: string | null; polling?: string } = {}) {
  const polling = o.polling ?? POLLING;
  await openElectionWithRegion(db, ICHI, polling, { notice: o.notice === undefined ? NOTICE : o.notice });
  await clock(db, addDays(NOTICE, -30));
}
const politicians = (db: Db) => rows<{ id: string; name: string; kana: string | null; birth_year: number | null }>(db, `SELECT id, name, kana, birth_year FROM policy_jp.politicians ORDER BY created_at, id`);
/** 本物の migration を、指定の一か所だけ戻した版にして同じ庫に流し込む（freshDb は修正済みなので、流し込むと戻した版になる） */
async function reverted(edits: Array<[string, string]>, o: { keepSelfCheck?: boolean } = {}): Promise<Db> {
  const db = await freshDb();
  let sql = MIG_SQL;
  for (const [a, b] of edits) sql = mutate(sql, a, b);
  if (!o.keepSelfCheck) sql = withoutSelfCheck(sql);
  await db.exec(sql);
  return db;
}
/** migration 末尾の自我檢查（DO ブロック）を外す：還原驗證で『一行だけ戻した版』を流すため（自我檢查そのものは下の専用テストで見る） */
function withoutSelfCheck(sql: string): string {
  const a = sql.indexOf("DO $$\nBEGIN\n  IF EXISTS (SELECT 1 FROM information_schema.columns");
  const end = "\n$$;\n";
  const b = sql.indexOf(end, a);
  assert(a > 0 && b > a, "自我檢查のブロックが見つからない");
  return sql.slice(0, a) + sql.slice(b + end.length);
}
const REL = "policy_jp.roster_not_found_released(tc.task_id, tc.outcome, tc.checked_at)";

// =============================================================================================
// a. kana
// =============================================================================================
async function probePre(db: Db) {
  await open(db); // 告示日の 30 日前
  return await addCand(db, noKana());
}
async function probePost(db: Db) {
  await open(db);
  await clock(db, NOTICE); // 告示日当日
  return await addCand(db, noKana({ status_date: NOTICE }));
}

Deno.test("kana：告示前は kana なしの declared が落庫できる（politicians.kana は NULL）。還原驗證：告示日の判定を『いつでも必須』に戻すと落ちる", async () => {
  const db = await freshDb();
  const r = await probePre(db);
  assertEquals([r.out.status, r.out.outcome], ["applied", "applied"], JSON.stringify(r.out));
  const p = await politicians(db);
  assertEquals(p.map((x) => [x.name, x.kana]), [["山田太郎", null]]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politician_elections WHERE politician_id = '${r.pid}'`), 1);
  await db.close();

  const bad = await reverted([["    IF v_kana = '' AND policy_jp.candidacy_kana_required(e.id) THEN", "    IF v_kana = '' THEN"]]);
  const rb = await probePre(bad);
  assertEquals([rb.out.status, rb.out.outcome], ["rejected", "invalid"], "必須に戻すと告示前の読みなしが落ちる＝この行が修正の本体");
  await bad.close();
});

Deno.test("kana：告示日（当日を含む）以降の読みなしは invalid で退件、人物も参選も作らない。還原驗證：告示日の判定を常に false にすると通ってしまう", async () => {
  const db = await freshDb();
  const r = await probePost(db);
  assertEquals([r.out.status, r.out.outcome], ["rejected", "invalid"]);
  assert(String(r.out.message).includes("kana"), String(r.out.message));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politicians`), 0);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.politician_elections`), 0);
  // 前日はまだ告示前
  await clock(db, addDays(NOTICE, -1));
  assertEquals((await addCand(db, noKana({ status_date: addDays(NOTICE, -1) }))).out.status, "applied", "告示日の前日は読みなしで通る");
  await db.close();

  const bad = await reverted([["  SELECT COALESCE(policy_jp.activity_today() >= policy_jp.election_notice_date(p_election_id), false)", "  SELECT false"]]);
  const rb = await probePost(bad);
  assertEquals(rb.out.status, "applied", "判定を殺すと告示後でも読みなしが通る＝この行が告示日起必填の本体");
  await bad.close();
});

Deno.test("kana：politician_id 付き（既にいる人）は告示日以降でも kana 不要。読みがあれば告示後でも通る。告示日の記録がない選挙は告示前扱い", async () => {
  const db = await freshDb();
  await open(db);
  const first = await addCand(db, candPayload());
  assertEquals(first.out.status, "applied");
  await clock(db, NOTICE);
  const filed = await addCand(db, { election_id: E1, politician_id: first.pid, candidacy_status: "filed", status_date: NOTICE, district_kind: "at_large" });
  assertEquals([filed.out.status, filed.out.outcome], ["applied", "applied"], "politician_id があれば kana は要らない");
  const withKana = await addCand(db, candPayload({ name: "佐藤花子", kana: "さとうはなこ", status_date: NOTICE }));
  assertEquals(withKana.out.status, "applied", "告示後でも kana があれば通る");
  await db.close();

  // 告示日の記録がない選挙（notice_date が空）＝ 告示前扱い：いつでも読みなしで通る
  const db2 = await freshDb();
  await open(db2, { notice: null });
  await clock(db2, addDays(POLLING, -1));
  assertEquals((await addCand(db2, noKana({ status_date: addDays(POLLING, -2) }))).out.status, "applied");
  assertEquals((await one<{ r: boolean }>(db2, `SELECT policy_jp.candidacy_kana_required($1) AS r`, [E1])).r, false);
  await db2.close();
});

Deno.test("kana：candidacy_kana_required は里程碑表の告示日（整場の announced）を読む＝上書きが効く。選挙 id が空・知らない id は false", async () => {
  const db = await freshDb();
  await open(db);
  const req = async (id: string) => (await one<{ r: boolean }>(db, `SELECT policy_jp.candidacy_kana_required($1) AS r`, [id])).r;
  await clock(db, addDays(NOTICE, -5));
  assertEquals(await req(E1), false);
  await db.query(`INSERT INTO policy_jp.election_milestones (election_id, kind, on_date, basis, status) VALUES ($1, 'announced', $2::DATE, 'override', 'announced')`, [E1, addDays(NOTICE, -10)]);
  assertEquals(await req(E1), true, "里程碑表で告示日が前倒しされれば、今日はもう告示後");
  assertEquals(await req("no-such-election"), false);
  assertEquals((await one<{ d: string | null }>(db, `SELECT policy_jp.election_notice_date('no-such-election')::TEXT AS d`)).d, null);
  await db.close();
});

// =============================================================================================
// b. 同一人
// =============================================================================================
async function probeUnique(db: Db) {
  await open(db);
  await addCand(db, candPayload());
  const again = await addCand(db, noKana()); // 読みなし・同名・同団体：唯一命中
  return { again, n: (await politicians(db)).length };
}
async function probeNamesakes(db: Db) {
  await open(db);
  await addCand(db, candPayload()); // 山田太郎（やまだたろう）
  await addCand(db, candPayload({ kana: "やまだだいろう" })); // 同名・別読み＝別人
  const third = await addCand(db, noKana({ candidacy_status: "considering" })); // 読みなし：二人に命中＝新しい人（推測しない）
  return { third, n: (await politicians(db)).length };
}

Deno.test("同一人（読みなし）：同名・同団体で唯一命中＝同一人（二重に作らない）。還原驗證：読みなしの絞り込みを外すと別人が増える", async () => {
  const db = await freshDb();
  const r = await probeUnique(db);
  assertEquals(r.n, 1, "同じ人に二重に作らない");
  assertEquals([r.again.out.status, r.again.out.outcome], ["applied", "unchanged"], JSON.stringify(r.again.out));
  await db.close();

  const bad = await reverted([["     WHERE NOT EXISTS (SELECT 1 FROM exact) AND (k.kana IS NULL OR b.kana IS NULL)", "     WHERE NOT EXISTS (SELECT 1 FROM exact) AND (k.kana IS NOT NULL AND b.kana IS NULL)"]]);
  assertEquals((await probeUnique(bad)).n, 2, "読みなしで探さなくなると、同じ人が二人になる");
  await bad.close();
});

Deno.test("同一人（読みなし）：同名・同団体が二人いるときは新しい人を作る（推測しない）。還原驗證：複数命中を退件に戻すと作られない", async () => {
  const db = await freshDb();
  const r = await probeNamesakes(db);
  assertEquals(r.n, 3);
  assertEquals([r.third.out.status, r.third.out.outcome], ["applied", "applied"]);
  await db.close();

  const bad = await reverted([["    IF cardinality(v_ids) > 1 AND v_kana <> '' THEN", "    IF cardinality(v_ids) > 1 THEN"]]);
  const rb = await probeNamesakes(bad);
  assertEquals([rb.third.out.status, rb.n], ["rejected", 2], "複数命中を退件にすると三人目が作れない");
  await bad.close();
});

Deno.test("同一人：生年が衝突する同名は別人（読みなしでも）／読みありは従来どおり（読みの違う同名は別人、同じ読みが複数なら曖昧で退件）", async () => {
  const db = await freshDb();
  await open(db);
  await addCand(db, candPayload({ birth_year: 1970 }));
  // 生年が衝突する同名・読みなし＝別人（読みなしの人が一人できる）
  const other = await addCand(db, noKana({ birth_year: 1985 }));
  assertEquals(other.out.outcome, "applied");
  assertEquals((await politicians(db)).map((x) => [x.kana, x.birth_year]), [["やまだたろう", 1970], [null, 1985]]);
  await db.close();

  // 読みあり：読みの違う同名は別人（従来どおり。庫に読みのない人がいなければ読みなしの救済も働かない）
  const db2 = await freshDb();
  await open(db2);
  await addCand(db2, candPayload());
  const diff = await addCand(db2, candPayload({ kana: "やまだたけし", status_date: addDays(NOTICE, -19) }));
  assertEquals(diff.out.outcome, "applied");
  assertEquals((await politicians(db2)).length, 2);
  // 同じ読みの人が二人（同名・同読み・生年が空）→ 曖昧で退件（従来どおり）
  await db2.exec(`UPDATE policy_jp.politicians SET kana = 'やまだたろう'`);
  const amb = await addCand(db2, candPayload({ status_date: addDays(NOTICE, -18) }));
  assertEquals([amb.out.status, amb.out.outcome], ["rejected", "invalid"]);
  await db2.close();
});

Deno.test("同一人：庫に読みがない人に読みつきの candidacy が来たら、同一人として空欄を埋める（履歴つき）。既にある読みは上書きしない", async () => {
  const db = await freshDb();
  await open(db);
  const a = await addCand(db, noKana({ candidacy_status: "considering" }));
  assertEquals((await politicians(db))[0].kana, null);
  const b = await addCand(db, candPayload());
  assertEquals([b.out.status, b.pid], ["applied", a.pid], "読みなしで建った人と同一人");
  assertEquals((await politicians(db)).map((x) => x.kana), ["やまだたろう"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'politicians' AND field = 'kana' AND record_id = '${a.pid}'`), 1);
  // 既にある読みは上書きしない：politician_id 指定で別の読みを付けても変わらない
  await addCand(db, { election_id: E1, politician_id: a.pid, kana: "べつのよみ", candidacy_status: "filed", status_date: addDays(NOTICE, 1), district_kind: "at_large" });
  assertEquals((await politicians(db))[0].kana, "やまだたろう");
  await db.close();
});

// =============================================================================================
// c. 読みがない人
// =============================================================================================
async function noKanaPerson(db: Db, o: Record<string, unknown> = {}) {
  await open(db);
  const r = await addCand(db, noKana(o));
  assertEquals(r.out.status, "applied", JSON.stringify(r.out));
  return r.pid!;
}

Deno.test("profile_gap：読みがない人は缺口（target.missing に kana）。生年も空なら birth_year, kana の順。読みを足すと消える。還原驗證：缺口判定を生年だけに戻すと出ない", async () => {
  const db = await freshDb();
  const pid = await noKanaPerson(db);
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), [`auto:profile_gap:${pid}`]);
  const [d] = await dispatches(db, ["profile_gap"]);
  assertEquals(d.target.missing, ["birth_year", "kana"]);
  assertEquals(d.target.kana, null);
  assert(d.what_we_need.includes("読み（kana）") && d.what_we_need.includes("生年") && d.what_we_need.includes(pid) && !d.what_we_need.includes("（、"), d.what_we_need);
  // 生年だけ足す→読みが残る
  await applyOne(db, await submit(db, "politician", { politician_id: pid, birth_year: 1970, resolved_claim: "new" }, { status: "verified", urls: [ELECTION_URL] }));
  await seed(db);
  assertEquals((await dispatches(db, ["profile_gap"]))[0].target.missing, ["kana"]);
  assert(!(await dispatches(db, ["profile_gap"]))[0].what_we_need.includes("生年が分かると"), "生年の説明は出ない");
  // 読みを足す→消える
  await applyOne(db, await submit(db, "politician", { politician_id: pid, kana: "やまだたろう", resolved_claim: "new" }, { status: "verified", urls: [ELECTION_URL] }));
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), []);
  await db.close();

  const bad = await reverted([["     WHERE p.cap IS NOT NULL AND (s.birth_year IS NULL OR s.kana IS NULL)", "     WHERE p.cap IS NOT NULL AND s.birth_year IS NULL"]]);
  const pid2 = await noKanaPerson(bad, { birth_year: 1970 });
  await seed(bad);
  assertEquals(await dispatchIds(bad, ["profile_gap"]), [], `生年だけ見る版には出ない（${pid2}）`);
  await bad.close();
});

Deno.test("profile_gap：読みを足した提出が審議中なら派さない（生年と読みの両方が足りない人は両方足した提出だけが止める）", async () => {
  const db = await freshDb();
  const pid = await noKanaPerson(db);
  await seed(db);
  // 生年だけの提出は、読みがまだ足りないので止めない
  const only = await submit(db, "politician", { politician_id: pid, birth_year: 1970, resolved_claim: "new" }, { status: "pending", urls: [ELECTION_URL] });
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), [`auto:profile_gap:${pid}`]);
  await db.exec(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = '${only}'`);
  await submit(db, "politician", { politician_id: pid, birth_year: 1970, kana: "やまだたろう", resolved_claim: "new" }, { status: "pending", urls: [ELECTION_URL] });
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), [], "足りないものを全部足した提出が審議中＝派さない");
  await db.close();
});

Deno.test("profile 完了判定：読みがない人は『建檔済み』ではない（auto:profile_gap の not_found で冷卻中なら済み）。還原驗證：kana を判定から外すと済み扱いになる", async () => {
  const probe = async (db: Db) => {
    const pid = await noKanaPerson(db, { birth_year: 1970 });
    const done = async () => (await one<{ d: boolean }>(db, `SELECT policy_jp.chain_profile_done($1) AS d`, [pid])).d;
    const missing = (await one<{ m: Record<string, unknown> }>(db, `SELECT policy_jp.chain_profile_missing($1) AS m`, [pid])).m;
    await check(db, `auto:profile_detail_gap:${pid}`, "not_found"); // 学歴・経歴は『查無』で済み、残りは読みだけ
    const afterDetail = await done();
    await check(db, `auto:profile_gap:${pid}`, "not_found"); // 読みも『查無』
    return { missing, afterDetail, afterGap: await done() };
  };
  const db = await freshDb();
  const r = await probe(db);
  assertEquals(Object.keys(r.missing).sort(), ["careers", "kana"]);
  assertEquals([r.afterDetail, r.afterGap], [false, true]);
  await db.close();
  const bad = await reverted([["(NOT (m ? 'birth_year' OR m ? 'kana') OR", "(NOT (m ? 'birth_year') OR"]]);
  const rb = await probe(bad);
  assertEquals(rb.afterDetail, true, "kana を判定から外すと、読みがないのに済み扱い");
  await bad.close();
});

Deno.test("politician 交件：読みは空欄だけ埋める／同じ値は unchanged／違う値は conflict（庫は変わらない）／空文字・長すぎは invalid。還原驗證：書き込みを外すと埋まらない", async () => {
  const send = (db: Db, payload: Record<string, unknown>) => submit(db, "politician", { resolved_claim: "new", ...payload }, { status: "verified", urls: [ELECTION_URL] }).then((id) => applyOne(db, id));
  const probe = async (db: Db) => {
    const pid = await noKanaPerson(db);
    const out = await send(db, { politician_id: pid, kana: "やまだたろう" });
    return { out, kana: (await politicians(db))[0].kana, pid };
  };
  const db = await freshDb();
  const r = await probe(db);
  assertEquals([r.out.status, r.out.outcome, r.kana], ["applied", "applied", "やまだたろう"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'politicians' AND field = 'kana' AND record_id = '${r.pid}'`), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'politicians' AND target_id = '${r.pid}'`), 1, "出処を掛ける");
  assertEquals((await send(db, { politician_id: r.pid, kana: "やまだたろう" })).outcome, "unchanged", "同じ値");
  const conflict = await send(db, { politician_id: r.pid, kana: "べつのよみ" });
  assertEquals([conflict.status, conflict.outcome], ["rejected", "conflict"]);
  assertEquals((await politicians(db))[0].kana, "やまだたろう", "違う値で上書きしない");
  assertEquals((await send(db, { politician_id: r.pid, kana: " " })).outcome, "invalid");
  assertEquals((await send(db, { politician_id: r.pid, kana: "あ".repeat(81) })).outcome, "invalid");
  assertEquals((await send(db, { politician_id: r.pid, kana: 5 })).outcome, "invalid");
  assertEquals((await send(db, { politician_id: r.pid, name: "別名" })).outcome, "invalid", "名前は今も直さない");
  await db.close();

  const bad = await reverted([["      UPDATE policy_jp.politicians SET kana = v_kana WHERE id = v_pid;\n      INSERT INTO policy_jp.edit_history", "      UPDATE policy_jp.politicians SET kana = kana WHERE id = v_pid;\n      INSERT INTO policy_jp.edit_history"]]);
  assertEquals((await probe(bad)).kana, null, "書き込みを外すと読みが埋まらない");
  await bad.close();
});

Deno.test("politician 交件：読みと生年を同時に出して生年が衝突するときは、読みも書かない（半分だけ落ちない）", async () => {
  const db = await freshDb();
  await open(db);
  const { pid } = await addCand(db, noKana({ birth_year: 1970 }));
  const out = await applyOne(db, await submit(db, "politician", { politician_id: pid, birth_year: 1999, kana: "やまだたろう", resolved_claim: "new" }, { status: "verified", urls: [ELECTION_URL] }));
  assertEquals([out.status, out.outcome], ["rejected", "conflict"]);
  assertEquals((await politicians(db))[0].kana, null, "生年の衝突で全体が退件＝読みも書かれていない");
  await db.close();
});

Deno.test("same_claim：politician の kana は生年と同じ扱い（庫に読みがあれば重複／審議中の kana 提出が見える／探査には庫の読みが出る）。内容比較は kana も見る", async () => {
  const db = await freshDb();
  const pid = await noKanaPerson(db, { birth_year: 1970 });
  const m = async (p: Record<string, unknown>) => (await one<{ r: { existing: Array<Record<string, unknown>>; pending: Array<Record<string, unknown>> } }>(db,
    `SELECT policy_jp.same_claim_matches('politician', $1::JSONB, 'ip-x') AS r`, [JSON.stringify(p)])).r;
  assertEquals((await m({ politician_id: pid, kana: "やまだたろう" })).existing, [], "庫に読みがない＝重複なし");
  await applyOne(db, await submit(db, "politician", { politician_id: pid, kana: "やまだたろう", resolved_claim: "new" }, { status: "verified", urls: [ELECTION_URL] }));
  const dup = await m({ politician_id: pid, kana: "べつ" });
  assertEquals(dup.existing.map((e) => [e.fact, e.id]), [["kana", `${pid}:kana`]], "読みは値が違っても『庫に読みがある』＝同じこと（differs で出し直す）");
  assertEquals((await m({ politician_id: pid, birth_year: 1970 })).existing.map((e) => e.fact), ["birth_year"], "生年だけの提出に読みは出ない");
  assertEquals((await m({ politician_id: pid })).existing.map((e) => e.fact).sort(), ["birth_year", "kana"], "探査＝この人の庫にある事実を全部");
  await submit(db, "politician", { politician_id: pid, kana: "べつ", resolved_claim: "differs:x" }, { status: "pending", urls: [ELECTION_URL] });
  assertEquals((await m({ politician_id: pid, kana: "さらに" })).pending.length, 1, "審議中の kana 提出が見える");
  assertEquals((await m({ politician_id: pid, birth_year: 1990 })).pending.length, 0, "生年の提出とは重ならない");
  const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    one<{ s: boolean }>(db, `SELECT policy_jp.same_claim_same_content('politician', $1::JSONB, $2::JSONB) AS s`, [JSON.stringify(a), JSON.stringify(b)]).then((x) => x.s);
  assertEquals(await same({ kana: "あ" }, { kana: "あ" }), true);
  assertEquals(await same({ kana: "あ" }, { kana: "い" }), false);
  assertEquals(await same({ birth_year: 1970 }, { birth_year: 1970, kana: "あ" }), false);
  await db.close();
});

Deno.test("NULL の読みでも他の臂が落ちない：profile_detail_gap・policy_missing の説明文は NULL にならず seed が通る。還原驗證：読みの連結を元に戻すと seed が落ちる", async () => {
  const probe = async (db: Db) => {
    const pid = await noKanaPerson(db, { birth_year: 1970 });
    await clock(db, addDays(NOTICE, 1)); // 政見の後備（告示日の翌日）が来る
    await seed(db);
    return { pid, rows: await dispatches(db, ["profile_detail_gap", "policy_missing"]) };
  };
  const db = await freshDb();
  const r = await probe(db);
  assertEquals(r.rows.map((d) => d.task_type).sort(), ["policy_missing", "profile_detail_gap"]);
  for (const d of r.rows) assert(d.what_we_need && d.what_we_need.includes("山田太郎") && !d.what_we_need.includes("（、"), d.what_we_need);
  await db.close();

  const db2 = await freshDb();
  let sql = MIG_SQL;
  assertEquals(sql.split("'（' || COALESCE(g.kana || '、', '') || g.lg_name").length - 1, 4, "profile_gap 1＋profile_detail_gap 2＋policy_missing 1");
  sql = sql.split("'（' || COALESCE(g.kana || '、', '') || g.lg_name").join("'（' || g.kana || '、' || g.lg_name");
  await db2.exec(sql);
  let outcome: "threw" | "null" | "ok" = "ok";
  try {
    const rb = await probe(db2);
    if (rb.rows.some((d) => d.what_we_need == null)) outcome = "null";
  } catch { outcome = "threw"; }
  assertNotEquals(outcome, "ok", "連結を戻すと、読みがない人の任務は説明文が NULL になる（または seed が落ちる）");
  await db2.close();
});

// =============================================================================================
// d. roster_check の not_found の冷卻
// =============================================================================================
async function openRoster(db: Db, o: { notice?: string | null } = {}) {
  await openElectionWithRegion(db, ICHI, POLLING, { notice: o.notice === undefined ? NOTICE : o.notice });
  await clock(db, addDays(NOTICE, -30));
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK], "最初は開いている");
}
const dispatchRow = (db: Db) => one<{ cooling: boolean; blocked: boolean }>(db, `SELECT cooling, blocked FROM policy_jp.task_dispatches WHERE task_id = $1`, [TASK]);

/** 告示日の 3 日前に not_found を報告し、告示日の前々日・前日・当日を順に見る */
async function probeThreeDays(db: Db) {
  await openRoster(db);
  await clock(db, addDays(NOTICE, -3));
  await check(db, TASK, "not_found");
  const seen: Record<string, { ids: string[]; done: boolean; cooling: boolean | null }> = {};
  for (const [label, day] of [["D-3", addDays(NOTICE, -3)], ["D-2", addDays(NOTICE, -2)], ["D-1", addDays(NOTICE, -1)], ["D", NOTICE]] as const) {
    await clock(db, day);
    await seed(db);
    seen[label] = { ids: await dispatchIds(db, ROSTER), done: (await stepsDone(db, E1)).roster, cooling: (await dispatchRow(db))?.cooling ?? null };
  }
  return seen;
}

Deno.test("冷卻（告示日の 3 日前に not_found）：告示日の前日までは休み、告示日当日にもう一度派す（14 日待たない）。鏈 roster の done も同じ", async () => {
  const db = await freshDb();
  const s = await probeThreeDays(db);
  for (const day of ["D-3", "D-2", "D-1"]) assertEquals([s[day].ids, s[day].done], [[], true], `${day}：休み中・roster は済み`);
  assertEquals(s["D"].ids, [TASK], "告示日当日に戻る");
  assertEquals(s["D"].done, false, "冷卻が終わったので roster はもう済みではない（鏈の done も一致）");
  assertEquals(s["D"].cooling, false, "task_dispatches.cooling も下りている（/next が配る）");
  assertEquals((await events(db, TASK)).map((e) => e.event), ["opened", "closed", "reopened"]);
  await db.close();
});

Deno.test("冷卻の還原驗證（3 日前の not_found）：三か所の冷卻計算のどれか一つでも告示日の打ち切りを外すと、告示日当日が赤くなる", async () => {
  // chain_task_checked（鏈 roster の done）
  const a = await reverted([[`     AND NOT ${REL}  -- roster_check の not_found だけ、告示日で冷卻を打ち切る（工作單 policy-ops#60）\n`, ""]]);
  const sa = await probeThreeDays(a);
  assertEquals(sa["D"].done, true, "chain_task_checked から外すと告示日になっても roster は済みのまま");
  await a.close();
  // task_unavailable（臂の排除）
  const b = await reverted([[`                    AND NOT ${REL})  -- roster_check の not_found だけ告示日で打ち切る（工作單 policy-ops#60）\n`, ")\n"]]);
  const sb = await probeThreeDays(b);
  assertEquals(sb["D"].ids, [], "task_unavailable から外すと臂が出さないので戻らない");
  await b.close();
  // refresh_dispatch_blocked（task_dispatches.cooling）
  const c = await reverted([[`      AND NOT ${REL}  -- 日本版：roster_check の not_found だけ告示日で冷卻を打ち切る\n`, ""]]);
  const sc = await probeThreeDays(c);
  assertEquals(sc["D"].ids, [TASK], "列そのものは戻る");
  assertEquals(sc["D"].cooling, true, "でも cooling が立ったまま＝/next が配らない（refresh_dispatch_blocked の一行が要る）");
  await c.close();
  // 判定そのもの
  const d = await reverted([["  SELECT CASE WHEN p_outcome = 'not_found' AND p_task_id LIKE 'auto:roster_check:%'", "  SELECT CASE WHEN false AND p_task_id LIKE 'auto:roster_check:%'"]]);
  const sd = await probeThreeDays(d);
  assertEquals(sd["D"].ids, [], "判定を殺すと従来どおり 14 日待つ");
  await d.close();
});

Deno.test("冷卻（告示日の 20 日前に not_found）：min(14 日, 告示日の前日) の 14 日側が効く＝14 日たてば告示日を待たずに戻る。還原驗證：告示日まで伸ばす版は戻らない", async () => {
  const probe = async (db: Db) => {
    await openRoster(db);
    await clock(db, addDays(NOTICE, -20));
    await check(db, TASK, "not_found");
    await seed(db);
    const during = await dispatchIds(db, ROSTER);
    await expireCooling(db); // 報告から 15 日たった
    await clock(db, addDays(NOTICE, -5));
    await seed(db);
    return { during, after: await dispatchIds(db, ROSTER), done: (await stepsDone(db, E1)).roster };
  };
  const db = await freshDb();
  const r = await probe(db);
  assertEquals(r.during, [], "報告の直後は休み");
  assertEquals(r.after, [TASK], "14 日たったので、告示日（5 日先）を待たずに戻る");
  assertEquals(r.done, false);
  await db.close();

  // 告示日まで伸ばす版（休みを『告示日の前日まで』にしてしまう）：task_unavailable の冷卻を roster の not_found だけ告示日基準に差し替える
  const bad = await reverted([[
    `                    AND tc.checked_at > now() - (CASE WHEN tc.outcome = 'unreachable' THEN policy_jp.task_unreachable_cooldown_days() ELSE policy_jp.task_check_cooldown_days() END || ' days')::INTERVAL\n                    AND NOT ${REL})  -- roster_check の not_found だけ告示日で打ち切る（工作單 policy-ops#60）\n`,
    `                    AND CASE WHEN tc.outcome = 'not_found' AND tc.task_id LIKE 'auto:roster_check:%' THEN policy_jp.activity_today() < COALESCE(policy_jp.election_notice_date(substring(tc.task_id FROM 19)), DATE '9999-12-31')
                             ELSE tc.checked_at > now() - (CASE WHEN tc.outcome = 'unreachable' THEN policy_jp.task_unreachable_cooldown_days() ELSE policy_jp.task_check_cooldown_days() END || ' days')::INTERVAL END)\n`,
  ]]);
  const rb = await probe(bad);
  assertEquals(rb.after, [], "告示日まで伸ばすと、14 日たっても戻らない＝min の 14 日側が壊れる");
  await bad.close();
});

Deno.test("冷卻：confirmed・unreachable は従来どおり（confirmed は 14 日、unreachable は 2 日）。告示日が来ても confirmed は済みのまま", async () => {
  const db = await freshDb();
  await openRoster(db);
  await clock(db, addDays(NOTICE, -3));
  await check(db, TASK, "confirmed");
  for (const day of [addDays(NOTICE, -1), NOTICE, addDays(NOTICE, 2)]) {
    await clock(db, day);
    await seed(db);
    assertEquals(await dispatchIds(db, ROSTER), [], `${day}：confirmed は告示日になっても休み（14 日）`);
    assertEquals((await stepsDone(db, E1)).roster, true);
  }
  await expireCooling(db);
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK], "14 日たてば戻る");
  // unreachable は『済み』ではない・2 日で戻る：告示日の影響を受けない
  await db.exec(`DELETE FROM policy_jp.task_checks`);
  await check(db, TASK, "unreachable");
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [], "unreachable の直後は休み（2 日）");
  assertEquals((await stepsDone(db, E1)).roster, false, "unreachable は完成ではない");
  await db.exec(`UPDATE policy_jp.task_checks SET checked_at = now() - INTERVAL '3 days'`);
  await seed(db);
  assertEquals(await dispatchIds(db, ROSTER), [TASK], "2 日たてば戻る");
  await db.close();
});

Deno.test("冷卻：告示日以降に報告された not_found は上限をかけない（従来どおり 14 日）／告示日の記録がない選挙も 14 日。還原驗證：『報告日が告示日より前』の条件を外すと即座に戻る", async () => {
  const probe = async (db: Db, notice: string | null) => {
    await openElectionWithRegion(db, ICHI, POLLING, { notice });
    await clock(db, REAL_TODAY);
    await seed(db);
    await check(db, TASK, "not_found"); // 今日報告
    await clock(db, addDays(REAL_TODAY, 3));
    await seed(db);
    return await dispatchIds(db, ROSTER);
  };
  // 告示日はもう過ぎている（報告日 ≥ 告示日）
  const db = await freshDb();
  assertEquals(await probe(db, addDays(REAL_TODAY, -2)), [], "告示日の後に報告された not_found は 14 日休む（上限で 0 日にならない）");
  await db.close();
  // 告示日の記録がない
  const db2 = await freshDb();
  assertEquals(await probe(db2, null), [], "告示日が分からない選挙は従来どおり 14 日");
  await db2.close();

  const bad = await reverted([["AND (p_checked_at AT TIME ZONE 'Asia/Tokyo')::DATE < x.nd", ""]]);
  assertEquals(await probe(bad, addDays(REAL_TODAY, -2)), [TASK], "報告日の条件を外すと、告示後の not_found がすぐ戻って回り続ける");
  await bad.close();
});

Deno.test("冷卻：roster_check 以外の任務の not_found は変えない（告示日が来ても 14 日）。判定関数は confirmed／他任務で常に false", async () => {
  const db = await freshDb();
  const rel = async (task: string, outcome: string) => (await one<{ r: boolean }>(db, `SELECT policy_jp.roster_not_found_released($1, $2, now()) AS r`, [task, outcome])).r;
  await openRoster(db);
  await clock(db, addDays(NOTICE, 1));
  assertEquals(await rel(TASK, "not_found"), true);
  assertEquals(await rel(TASK, "confirmed"), false);
  assertEquals(await rel(TASK, "unreachable"), false);
  assertEquals(await rel(`auto:profile_gap:${E1}`, "not_found"), false);
  assertEquals(await rel(`auto:regional_stats_missing:${ICHI}`, "not_found"), false);
  assertEquals(await rel("auto:roster_check:no-such-election", "not_found"), false);
  assertEquals(await rel("11111111-2222-4333-8444-555555555555", "not_found"), false);
  await db.close();
});

// =============================================================================================
// e. 説明文
// =============================================================================================
Deno.test("roster_check の説明文：告示前は報道・本人や政党の発信で可、告示後は選管の公表を優先。報道だけの出典は避ける旧文言は消えた。kana の規則と再確認の案内を書く", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING, { notice: NOTICE });
  await clock(db, addDays(NOTICE, -2));
  await seed(db);
  const pre = (await dispatches(db, ROSTER))[0].what_we_need;
  assert(pre.includes("告示前の段階"));
  assert(pre.includes("報道、または本人・政党の発信") && pre.includes("告示後は選管の公表を優先"), pre);
  assert(!pre.includes("報道だけの出典は避けて"), "旧文言");
  assert(pre.includes("告示前は任意") && pre.includes("告示日以降は必須"), "kana の規則");
  assert(pre.includes("告示日にもう一度"), "not_found の再確認の案内");
  await clock(db, addDays(NOTICE, 1));
  await db.exec(`DELETE FROM policy_jp.task_dispatches WHERE task_type = 'roster_check'`);
  await seed(db);
  const post = (await dispatches(db, ROSTER))[0].what_we_need;
  assert(post.includes("告示後の段階"));
  assert(post.includes("選管の公表（立候補者一覧・候補者届出の公示）を優先"), post);
  assert(!post.includes("報道、または本人・政党の発信"), "告示後は報道可の文言を出さない");
  await db.close();
});

// =============================================================================================
// f. 文字守門・冪等・権限
// =============================================================================================
Deno.test("文字守門：再定義した既存の関数は『緊接在前の定義』＋登記した機械替換だけ（候補の定義を前の移行から取り、替換を戻すと一致する）", async () => {
  const mig = (n: string) => readMig(n);
  const prevOf = async (name: string, files: string[]) => {
    let def: string | null = null;
    for (const f of files) { const sql = await mig(f); if (sql.includes(`CREATE OR REPLACE FUNCTION policy_jp.${name}(`)) def = fnText(sql, `policy_jp.${name}`); }
    assert(def, name);
    return def;
  };
  const CAND = "20261010040000_policy_jp_chain_candidacy.sql", PROFILE = "20261010050000_policy_jp_chain_profile.sql", POLICY = "20261010060000_policy_jp_chain_policy.sql";
  const ARMS = "20261009210100_policy_jp_gap_arms.sql", DISPATCH = "20261009130000_policy_jp_dispatch.sql";
  const all = [DISPATCH, ARMS, CAND, PROFILE, POLICY];
  // 一か所だけの機械替換（新→旧に戻す）
  const undo: Record<string, Array<[string, string]>> = {
    chain_task_checked: [[`     AND NOT ${REL}  -- roster_check の not_found だけ、告示日で冷卻を打ち切る（工作單 policy-ops#60）\n`, ""]],
    task_unavailable: [[`\n                    AND NOT ${REL})  -- roster_check の not_found だけ告示日で打ち切る（工作單 policy-ops#60）\n`, ")\n"]],
    refresh_dispatch_blocked: [[`      AND NOT ${REL}  -- 日本版：roster_check の not_found だけ告示日で冷卻を打ち切る\n`, ""]],
    chain_profile_done: [["(NOT (m ? 'birth_year' OR m ? 'kana') OR", "(NOT (m ? 'birth_year')      OR"]],
    chain_profile_missing: [["           'kana', CASE WHEN p.kana IS NULL THEN true END,  -- 告示前に読みなしで建った人（工作單 policy-ops#60）\n", ""]],
    contribution_auto_tasks_profile_detail_gap: [["'（' || COALESCE(g.kana || '、', '') || g.lg_name", "'（' || g.kana || '、' || g.lg_name"]],
    contribution_auto_tasks_policy_missing: [["'（' || COALESCE(g.kana || '、', '') || g.lg_name", "'（' || g.kana || '、' || g.lg_name"]],
    same_claim_same_content: [
      ["      AND (a->>'kana') IS NOT DISTINCT FROM (b->>'kana')\n", ""],
      ["    -- 政治人物：生年・読み・学歴・経歴が（順序を問わず）同じ", "    -- 政治人物：生年・学歴・経歴が（順序を問わず）同じ"],
    ],
  };
  for (const [name, edits] of Object.entries(undo)) {
    let now = fnText(MIG_SQL, `policy_jp.${name}`);
    for (const [from, to] of edits) {
      assertEquals(now.split(from).length - 1, name === "contribution_auto_tasks_profile_detail_gap" ? 2 : 1, `${name}：戻す箇所の数`);
      now = now.split(from).join(to);
    }
    assertEquals(now, await prevOf(name, all), `${name}：機械替換を戻すと緊接在前の定義と一致する`);
  }
  // 大きく書き換えた関数は『戻す箇所の登録』ではなく、触った範囲を限定して見張る：前の定義の大部分が残っている
  for (const name of ["apply_candidacy", "apply_politician", "contribution_auto_tasks_profile_gap", "contribution_auto_tasks_roster_check", "same_claim_matches_politician"]) {
    const prev = (await prevOf(name, all)).split("\n"), now = new Set(fnText(MIG_SQL, `policy_jp.${name}`).split("\n"));
    const kept = prev.filter((l) => now.has(l)).length;
    assert(kept / prev.length > 0.6, `${name}：前の定義の ${Math.round((kept / prev.length) * 100)}% しか残っていない（書き換えすぎ。足すのは kana／冷卻／説明文だけ）`);
  }
});

Deno.test("自我檢查（還原驗證）：冷卻の三か所のどれかが roster_not_found_released を見なくなる／kana の NOT NULL が戻る／anon に渡す、と migration が失敗する", async () => {
  const run = async (edits: Array<[string, string]>) => {
    const db = await freshDb();
    let sql = MIG_SQL;
    for (const [a, b] of edits) sql = mutate(sql, a, b);
    try { await db.exec(sql); return null; } catch (e) { return String((e as Error).message ?? e); } finally { await db.close(); }
  };
  assertEquals(await run([]), null, "本物は通る");
  assert((await run([[`     AND NOT ${REL}  -- roster_check の not_found だけ、告示日で冷卻を打ち切る（工作單 policy-ops#60）
`, ""]]))?.includes("冷卻の三か所"));
  assert((await run([[`
                    AND NOT ${REL})  -- roster_check の not_found だけ告示日で打ち切る（工作單 policy-ops#60）
`, `)
`]]))?.includes("冷卻の三か所"));
  assert((await run([[`      AND NOT ${REL}  -- 日本版：roster_check の not_found だけ告示日で冷卻を打ち切る
`, ""]]))?.includes("冷卻の三か所"));
  assert((await run([["ALTER TABLE policy_jp.politicians ALTER COLUMN kana DROP NOT NULL;", "ALTER TABLE policy_jp.politicians ALTER COLUMN kana SET NOT NULL;"]]))?.length, "NOT NULL を戻すと、既に読みなしの行があれば失敗／なければ自我檢查が拾う");
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則・関数の数が増えない。kana の NOT NULL は外れたまま、CHECK（空文字を入れない）は残る", async () => {
  const db = await freshDb();
  const nRules = await count(db, `SELECT 1 FROM policy_jp.activity_rules`);
  await db.exec(MIG_SQL);
  await db.exec(MIG_SQL);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.activity_rules`), nRules);
  assertEquals((await one<{ n: string }>(db, `SELECT is_nullable AS n FROM information_schema.columns WHERE table_schema = 'policy_jp' AND table_name = 'politicians' AND column_name = 'kana'`)).n, "YES");
  let blocked = false;
  try { await db.exec(`INSERT INTO policy_jp.politicians (id, name, kana) VALUES ('x1', '空白読み', '  ')`); } catch { blocked = true; }
  assert(blocked, "空白だけの読みは CHECK で入らない");
  await db.exec(`INSERT INTO policy_jp.politicians (id, name, kana) VALUES ('x2', '読みなし', NULL)`);
  assertNotEquals(await count(db, `SELECT 1 FROM policy_jp.politicians WHERE id = 'x2'`), 0);
  await db.close();
});

Deno.test("権限：新しい関数は anon／authenticated が呼べない（service_role は呼べる）。関数は search_path を釘付け、public／ditrust を引かない", async () => {
  const db = await freshDb();
  for (const fnCall of [
    `policy_jp.candidacy_kana_required('x')`, `policy_jp.election_notice_date('x')`, `policy_jp.roster_not_found_released('auto:roster_check:x', 'not_found', now())`,
  ]) {
    for (const role of ["anon", "authenticated"]) {
      let denied = false;
      try { await asRole(db, role, `SELECT ${fnCall}`); } catch { denied = true; }
      assert(denied, `${role} が ${fnCall} を呼べてしまう`);
    }
    await asRole(db, "service_role", `SELECT ${fnCall}`);
  }
  for (const n of ["election_notice_date", "candidacy_kana_required", "roster_not_found_released", "candidacy_match_politicians", "apply_candidacy", "apply_politician"]) {
    assert(fnText(MIG_SQL, `policy_jp.${n}`).includes("SET search_path = policy_jp, pg_temp"), `${n} の search_path`);
  }
  const stripped = MIG_SQL.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(stripped) && !/\bditrust\b/.test(stripped));
  await db.close();
});
