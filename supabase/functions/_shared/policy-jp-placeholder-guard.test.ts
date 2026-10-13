/**
 * 日本站：測試名の人物の入力拒否（触発器 trg_politicians_reject_placeholder_name）と、派工総表での隔離
 * （migration 20261011250000、正見 20261006140000／20261008114000 の日本版）。
 *   a. 触発器：INSERT／名前・読みの UPDATE が測試名なら拒む；普通の名前・読みなし・取り除き済み（rejected）・他の列の更新は通る；
 *      候補者の交件（apply_candidacy）が測試名なら落庫しない（人物が増えない）
 *   b. 隔離：target に測試名人物の id がある他臂の任務は総表に出ない（placeholder_politicians 臂だけ例外）；
 *      実在の人の任務は一件も変わらない；取り除き（rejected）後は隔離も外れる；MATERIALIZED（性能の前提）
 *   c. 還原驗證：触発器・隔離を外すと a／b が赤くなる
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import { addDays, applyOne, clock, freshDb, ICHI, openElectionWithRegion, one, readMig, renameAsPlaceholder, rows, seed, submit } from "./policy-jp-chain-db.ts";

const MIG_SQL = await readMig("20261011250000_policy_jp_news.sql");
const POLLING = "2027-04-25";
const E1 = `${POLLING}_mayor_${ICHI}`;
const KOUHOU = "https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf";
type Db = Awaited<ReturnType<typeof freshDb>>;

const insertPol = (db: Db, id: string, name: string, kana: string | null, status = "published") =>
  db.query(`INSERT INTO policy_jp.politicians (id, name, kana, review_status) VALUES ($1, $2, $3, $4)`, [id, name, kana, status]);
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return String((e as Error).message); } return null; };

Deno.test("触発器：テスト名（名前・読み・英語の単語）の INSERT／UPDATE は拒む；普通の名前・読みなし・取り除き済み・他の列の更新は通る", async () => {
  const db = await freshDb();
  assertEquals(await one(db, `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'trg_politicians_reject_placeholder_name'`), { tgname: "trg_politicians_reject_placeholder_name", tgenabled: "O" });
  for (const [n, k] of [["テスト太郎", "てすとたろう"], ["ﾃｽﾄ花子", "てすとはなこ"], ["架空 三郎", null], ["山田", "ダミー"], ["Test Taro", "teisuto"], ["Sample-san", null]] as const) {
    const msg = await rejects(insertPol(db, `x-${n}`, n, k));
    assert(msg?.includes("テスト用のデータに見えます"), `${n}: ${msg}`);
  }
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.politicians`)).n, 0);
  await insertPol(db, "ok-1", "山田太郎", "やまだたろう");
  await insertPol(db, "ok-2", "鈴木花子", null);
  await insertPol(db, "ok-3", "Testa Rossa", null);
  // 更新：名前を測試名にする／読みを測試名にする → 拒む
  assert(await rejects(db.query(`UPDATE policy_jp.politicians SET name = 'ダミー太郎' WHERE id = 'ok-1'`)));
  assert(await rejects(db.query(`UPDATE policy_jp.politicians SET kana = 'さんぷる' WHERE id = 'ok-1'`)));
  assertEquals((await one<{ name: string }>(db, `SELECT name FROM policy_jp.politicians WHERE id = 'ok-1'`)).name, "山田太郎");
  // すでにいる測試名の人物（検出は臂の仕事）：名前・読み以外の更新、取り除き（review_status）は通る
  await insertPol(db, "ph-1", "山田次郎", "やまだじろう");
  await renameAsPlaceholder(db, "ph-1", "テスト次郎", "てすとじろう");
  assertEquals(await rejects(db.query(`UPDATE policy_jp.politicians SET birth_year = 1970 WHERE id = 'ph-1'`)), null);
  assertEquals(await rejects(db.query(`UPDATE policy_jp.politicians SET review_status = 'rejected' WHERE id = 'ph-1'`)), null, "取り除き（軟移除）は通る");
  // 取り除き済みの行は名前・読みを動かしても拒まない（履歴を直せる）
  assertEquals(await rejects(db.query(`UPDATE policy_jp.politicians SET kana = 'てすとじろう2' WHERE id = 'ph-1'`)), null);
  // 触発器は検出の臂を邪魔しない：renameAsPlaceholder は触発器を元に戻している
  assertEquals((await one<{ tgenabled: string }>(db, `SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_politicians_reject_placeholder_name'`)).tgenabled, "O");
});

Deno.test("触発器：テスト名の候補者の交件（candidacy）は落庫に失敗して人物が増えない", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const id = await submit(db, "candidacy", { election_id: E1, name: "テスト太郎", kana: "てすとたろう", candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large" }, { status: "verified", urls: [KOUHOU] });
  const out = await applyOne(db, id).catch((e: Error) => ({ status: "threw", error: e.message }));
  assert((out as { status: string }).status !== "applied", JSON.stringify(out));
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.politicians`)).n, 0);
});

// =============================================================================================
// b. 隔離
// =============================================================================================
async function addCand(db: Db, name: string, kana: string, tag: string): Promise<{ pid: string; peid: string }> {
  const cid = await submit(db, "candidacy", { election_id: E1, name: `仮${tag}`, kana: `かり${tag}`, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large" }, { status: "verified", urls: [KOUHOU] });
  const out = await applyOne(db, cid);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pid = (await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [cid])).applied_politician_id;
  await renameAsPlaceholder(db, pid, name, kana);
  return { pid, peid: out.record_id! };
}
const ARMS = "policy_jp.contribution_auto_tasks_arms";
/** 隔離を入れる前の総表（20261011240000 の版）を別名で作る：『前後の差』が隔離だけであることを見る */
async function installOld(db: Db): Promise<void> {
  const prev = await readMig("20261011240000_policy_jp_consistency.sql");
  const body = fnText(prev, ARMS).replace("policy_jp.contribution_auto_tasks_arms()", "policy_jp.contribution_auto_tasks_arms_before_isolation()");
  // 前の版には news_discovery の分支がない；新しい版でも線索がなければ空なので比較に影響しない
  await db.exec(body);
}
const ids = (r: Array<{ task_id: string }>) => r.map((x) => x.task_id).sort();

Deno.test("隔離：測試名人物の他臂の任務は総表に出ない（placeholder 臂は出る）；実在の人の任務は一件も変わらない；取り除き後は外れる", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const t = await addCand(db, "テスト太郎", "てすとたろう", "ア");
  const a = await addCand(db, "山田太郎", "やまだたろう", "イ");
  await installOld(db);
  await clock(db, addDays(POLLING, -10));
  const before = await rows<{ task_id: string; arm: string; target: Record<string, unknown> }>(db, `SELECT task_id, arm, target FROM policy_jp.contribution_auto_tasks_arms_before_isolation()`);
  const after = await rows<{ task_id: string; arm: string }>(db, `SELECT task_id, arm FROM ${ARMS}()`);
  const mentionsT = (x: { target: Record<string, unknown> }) => JSON.stringify(x.target).includes(t.pid);
  const tOther = before.filter((x) => mentionsT(x) && x.arm !== "placeholder_politicians");
  assert(tOther.length > 0, "前提：隔離がなければ、テスト名の人物にも他臂の任務が出る（出ないならこのテストは何も守っていない）");
  assert(before.some((x) => x.arm === "placeholder_politicians" && mentionsT(x)), "placeholder 臂は出る");
  assertEquals(ids(before.filter((x) => !tOther.includes(x))), ids(after), "差は『テスト名人物に触れる他臂の任務』だけ");
  assert(after.some((x) => x.arm === "placeholder_politicians"), "隔離しても placeholder 臂は残る");
  assert(before.some((x) => JSON.stringify(x.target).includes(a.pid)) && after.some((x) => x.task_id.includes(a.pid) || before.find((b) => b.task_id === x.task_id && JSON.stringify(b.target).includes(a.pid))), "実在の人の任務は残る");
  // 取り除き（rejected）後は隔離が外れる：テスト名人物は ph に入らない
  await db.query(`UPDATE policy_jp.politicians SET review_status = 'rejected' WHERE id = $1`, [t.pid]);
  const gone = await rows<{ task_id: string }>(db, `SELECT task_id FROM ${ARMS}()`);
  assert(!gone.some((x) => x.task_id === `auto:placeholder_politician:${t.pid}`), "取り除き済みの人物には placeholder 任務も出ない");
  // seed を通しても同じ（派工列に出ない）
  await seed(db);
  assertEquals((await rows(db, `SELECT task_id FROM policy_jp.task_dispatches WHERE task_id LIKE $1 AND task_type <> 'placeholder_politician'`, [`%${t.pid}%`])).length, 0);
});

Deno.test("隔離：総表は ph を MATERIALIZED で持ち、strpos で比べる（性能の前提）；参選紀錄 id の中の人物 id にも当たる", async () => {
  const total = fnText(MIG_SQL, ARMS);
  assert(total.includes("ph AS MATERIALIZED (SELECT p.id AS pid FROM policy_jp.politicians p WHERE p.review_status <> 'rejected' AND policy_jp.politician_name_is_placeholder(p.name, p.kana))"));
  assert(total.includes("g.arm = 'placeholder_politicians' OR NOT EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)"));
  // 日本の参選紀錄 id は <人物 id>:<選挙 id>:<区分>：人物 id の文字列検索で参選紀錄 id を持つ target（politician_election_id[s]）にも当たる
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const t = await addCand(db, "テスト太郎", "てすとたろう", "ウ");
  assert(t.peid.startsWith(`${t.pid}:`), t.peid);
});

// =============================================================================================
// c. 還原驗證
// =============================================================================================
Deno.test("還原驗證：隔離を外した総表では、テスト名人物の他臂の任務が出る（＝隔離のテストが守っている）／触発器を外せば INSERT が通る", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const t = await addCand(db, "テスト太郎", "てすとたろう", "エ");
  await clock(db, addDays(POLLING, -10));
  const before = (await rows<{ task_id: string; arm: string; target: Record<string, unknown> }>(db, `SELECT task_id, arm, target FROM ${ARMS}()`))
    .filter((x) => JSON.stringify(x.target).includes(t.pid) && x.arm !== "placeholder_politicians");
  assertEquals(before.length, 0, "本物の版：出ない");
  const broken = fnText(MIG_SQL, ARMS).replace(/     AND \(g\.arm = 'placeholder_politicians' OR NOT EXISTS[^\n]*\n/, "");
  assert(broken !== fnText(MIG_SQL, ARMS));
  await db.exec(broken);
  const leaked = (await rows<{ arm: string; target: Record<string, unknown> }>(db, `SELECT arm, target FROM ${ARMS}()`)).filter((x) => JSON.stringify(x.target).includes(t.pid) && x.arm !== "placeholder_politicians");
  assert(leaked.length > 0, "還原版：隔離がなければ出る");
  await db.exec(`DROP TRIGGER trg_politicians_reject_placeholder_name ON policy_jp.politicians`);
  assertEquals(await rejects(insertPol(db, "late-1", "ダミー一郎", "だみーいちろう")), null, "触発器を外せば入る");
});
