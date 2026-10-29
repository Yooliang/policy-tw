/**
 * 日本站人物頭像（migration 20261030120000_policy_jp_avatar.sql、policy-ops#162）
 *   臂 avatar_missing（task_type avatar_missing）、交件型別 politician_avatar（落庫 apply_politician_avatar）、politicians の頭像 5 欄と CHECK。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts）、時鐘用 `SET app.activity_today`。
 *   a. 結構：臂名・総表・規則（常時窓・cap・cooldown_days）・後段・型別清單・CHECK・権限
 *   b. 臂：立候補者を派す／現職も派す／頭像のある人は派さない／審議中は派さない／審議中の no_change／冷卻 90 日（14 日の通常冷卻では戻らない）
 *   c. 落庫：applied（5 欄・履歴・取得日）→ 収回／同じファイルは unchanged／別の画像は conflict／白名單外・非 Commons は invalid／出処（source_refs）は書かない
 *   d. 還原驗證：冷卻條件を外すと 14 日で戻ってしまう
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import { applyOne, asRole, check, clock, count, dispatchIds, expireCooling, freshDb, ICHI, one, openElectionWithRegion, readMig, rows, seed, submit } from "./policy-jp-chain-db.ts";
import { JP_APPLY_TYPES } from "./jp/apply-contribution.ts";
import { validateContributionRequest } from "./jp/contribution-schema.ts";

const MIG_SQL = await readMig("20261030120000_policy_jp_avatar.sql");
const POLLING = "2027-04-25";
const E1 = `${POLLING}_mayor_${ICHI}`;
const KOUHOU = "https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf";
const FILE = "https://commons.wikimedia.org/wiki/File:Taro_Yamada_2024.jpg";
const IMG = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Taro_Yamada_2024.jpg";
const AV = (pid: string, o: Record<string, unknown> = {}) => ({ politician_id: pid, image_url: IMG, file_page_url: FILE, license: "CC BY-SA 4.0", author: "Hanako Suzuki", ...o });
const AV_TASK = (pid: string) => `auto:avatar_missing:${pid}`;

const shared = await freshDb();
await shared.waitReady;
type Db = Awaited<ReturnType<typeof freshDb>>;

let seqCand = 0;
async function addCand(db: Db, name: string, kana: string): Promise<{ pid: string }> {
  const n = ++seqCand;
  const id = await submit(db, "candidacy", { election_id: E1, name, kana, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large" }, { status: "verified", urls: [KOUHOU] });
  const out = await applyOne(db, id);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pid = (await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id;
  return { pid };
}
async function stage(db: Db) {
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "山田太郎", "やまだたろう");
  await clock(db, "2027-04-15");
  return { a };
}

Deno.test("結構：臂名・総表・規則・後段・型別清單・CHECK・権限", async () => {
  assert((await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a.includes("avatar_missing"));
  assert(fnText(MIG_SQL, "policy_jp.contribution_auto_tasks_arms").includes("SELECT 'avatar_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_avatar_missing() t"));
  assertEquals(await one(shared, `SELECT window_kind, after_step, enabled, params FROM policy_jp.activity_rules WHERE activity = 'avatar_missing' AND priority IS NULL`),
    { window_kind: "always", after_step: null, enabled: true, params: { cap: 30, cooldown_days: 90 } });
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:avatar_missing' AND priority = 3 AND window_kind = 'always'`), 1, "後段");
  assertEquals((await one<{ t: string[] }>(shared, `SELECT policy_jp.apply_types() AS t`)).t, [...JP_APPLY_TYPES]);
  assert(JP_APPLY_TYPES.includes("politician_avatar"));
  assertEquals((await one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank('auto:avatar_missing:x', 'avatar_missing') AS r`)).r, 9);
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.console_arm_stage_map WHERE arm = 'avatar_missing' AND stage = 1`), 1);
  for (const f of ["contribution_auto_tasks_avatar_missing()", "avatar_subjects()", "apply_politician_avatar(policy_jp.contributions)"]) {
    assertEquals((await one<{ x: boolean }>(shared, `SELECT has_function_privilege('anon', 'policy_jp.${f}', 'EXECUTE') AS x`)).x, false, f);
  }
  // 交件型別の DB CHECK に politician_avatar が入っている（漏れると交件が全部 DB で弾かれる）
  assertEquals(await count(shared, `SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%politician_avatar%'`), 1);
});

Deno.test("politicians の CHECK：5 欄は全部空か全部正しい形。Commons 以外・授權白名單外・作者なしは DB が拒む", async () => {
  const db = await freshDb();
  const { a } = await stage(db);
  const upd = (set: string) => db.query(`UPDATE policy_jp.politicians SET ${set} WHERE id = $1`, [a.pid]);
  const ok = `avatar_url='${IMG}', avatar_file_page_url='${FILE}', avatar_license='CC BY 4.0', avatar_author='x', avatar_retrieved_on='2027-04-15'`;
  let threw = 0;
  for (const bad of [
    ok.replace("upload.wikimedia.org", "example.com"),
    ok.replace("commons.wikimedia.org", "ja.wikipedia.org"),
    ok.replace("CC BY 4.0", "CC BY-NC 4.0"),
    ok.replace("CC BY 4.0", "CC BY-ND 2.0"),
    ok.replace("CC BY 4.0", "GFDL"),
    ok.replace("avatar_author='x'", "avatar_author=' '"),
    `avatar_url='${IMG}'`,
  ]) {
    try { await upd(bad); } catch { threw++; }
  }
  assertEquals(threw, 7);
  for (const lic of ["CC0", "Public domain", "PD-Japan", "CC BY 2.0", "CC BY-SA 2.0 de", "CC BY-SA 4.0"]) {
    await upd(`avatar_url=NULL, avatar_file_page_url=NULL, avatar_license=NULL, avatar_author=NULL, avatar_retrieved_on=NULL`);
    await upd(ok.replace("CC BY 4.0", lic));
  }
});

Deno.test("臂：立候補者を派す・頭像のある人と審議中は派さない・派工列は後段・任務の target と指示", async () => {
  const db = await freshDb();
  const { a } = await stage(db);
  await seed(db);
  assertEquals(await dispatchIds(db, ["avatar_missing"]), [AV_TASK(a.pid)]);
  const d = await one<{ target: Record<string, unknown>; what_we_need: string }>(db, `SELECT target, what_we_need FROM policy_jp.contribution_auto_tasks_arms() WHERE task_type = 'avatar_missing'`);
  assertEquals(d.target.politician_id, a.pid);
  assertEquals(d.target.basis, "candidate");
  assert(d.what_we_need.includes("politician_avatar") && d.what_we_need.includes("Wikimedia Commons") && d.what_we_need.includes("90 日"));
  // 審議中の提出があれば派さない
  const id = await submit(db, "politician_avatar", AV(a.pid), { status: "pending", urls: [FILE] });
  await seed(db);
  assertEquals(await dispatchIds(db, ["avatar_missing"]), []);
  // 落ちれば戻る
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [id]);
  await seed(db);
  assertEquals(await dispatchIds(db, ["avatar_missing"]), [AV_TASK(a.pid)]);
});

Deno.test("臂：任期中の現職も派す（候補者として出ている人は重複しない）。任期の終わった人・非公開の人は派さない", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-04-15");
  const mk = async (id: string, name: string, kana: string) => {
    await db.query(`INSERT INTO policy_jp.politicians (id, name, kana, review_status) VALUES ($1, $2, $3, 'published')`, [id, name, kana]);
  };
  await mk("inc-1", "佐藤一郎", "さとういちろう");
  await mk("inc-2", "高橋二郎", "たかはしじろう");
  await mk("inc-3", "伊藤三郎", "いとうさぶろう");
  const office = (id: string, pid: string, start: string, end: string, extra = "") => db.query(
    `INSERT INTO policy_jp.politician_offices (id, politician_id, position, lg_code, term_no, start_date, scheduled_end_date, review_status${extra ? ", end_date, end_reason, end_basis" : ""})
     VALUES ($1, $2, 'mayor', $3, 1, $4, $5, 'published'${extra ? `, ${extra}` : ""})`, [id, pid, ICHI, start, end]);
  await office("o1", "inc-1", "2023-04-25", "2027-04-24");
  await office("o2", "inc-2", "2015-04-25", "2019-04-24", `'2019-04-24', 'term_expired', 'law'`);
  await db.query(`UPDATE policy_jp.politicians SET review_status = 'pending' WHERE id = 'inc-3'`);
  await office("o3", "inc-3", "2023-04-25", "2027-04-24");
  const subj = await rows<{ politician_id: string; basis: string }>(db, `SELECT politician_id, basis FROM policy_jp.avatar_subjects() ORDER BY 1`);
  assertEquals(subj, [{ politician_id: "inc-1", basis: "incumbent" }]);
  await seed(db);
  assertEquals(await dispatchIds(db, ["avatar_missing"]), [AV_TASK("inc-1")]);
});

Deno.test("冷卻：not_found の報告から 90 日は戻らない（通常の 14 日冷卻が切れても）・91 日で戻る・unreachable は 90 日の対象外", async () => {
  const db = await freshDb();
  const { a } = await stage(db);
  await seed(db);
  assertEquals((await dispatchIds(db, ["avatar_missing"])).length, 1);
  await check(db, AV_TASK(a.pid), "not_found");
  await seed(db);
  assertEquals(await dispatchIds(db, ["avatar_missing"]), [], "報告直後");
  await expireCooling(db); // 15 日前
  await seed(db);
  assertEquals(await dispatchIds(db, ["avatar_missing"]), [], "通常の 14 日冷卻が切れても 90 日は戻らない");
  await db.exec(`UPDATE policy_jp.task_checks SET checked_at = now() - INTERVAL '89 days'`);
  await seed(db);
  assertEquals(await dispatchIds(db, ["avatar_missing"]), [], "89 日");
  await db.exec(`UPDATE policy_jp.task_checks SET checked_at = now() - INTERVAL '91 days'`);
  await seed(db);
  assertEquals(await dispatchIds(db, ["avatar_missing"]), [AV_TASK(a.pid)], "91 日で戻る");
  // unreachable（開けなかった）は 90 日の対象にしない（通常の短い冷卻だけ）
  await db.exec(`DELETE FROM policy_jp.task_checks`);
  await check(db, AV_TASK(a.pid), "unreachable");
  await db.exec(`UPDATE policy_jp.task_checks SET checked_at = now() - INTERVAL '3 days'`);
  await seed(db);
  assertEquals(await dispatchIds(db, ["avatar_missing"]), [AV_TASK(a.pid)]);
});

Deno.test("還原驗證：臂から 90 日の除外を外すと、通常の 14 日冷卻が切れた時点で戻ってしまう（この守門が見張っている）", async () => {
  const body = fnText(MIG_SQL, "policy_jp.contribution_auto_tasks_avatar_missing");
  const cut = body.indexOf("AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc");
  assert(cut > 0, "除外句が臂の中にある");
  const end = body.indexOf("AND NOT policy_jp.task_unavailable", cut);
  const broken = body.slice(0, cut) + body.slice(end);
  const db = await freshDb();
  const { a } = await stage(db);
  await db.exec(broken.replace("CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_avatar_missing", "CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_avatar_missing"));
  await check(db, AV_TASK(a.pid), "not_found");
  await expireCooling(db);
  await seed(db);
  assertEquals(await dispatchIds(db, ["avatar_missing"]), [AV_TASK(a.pid)], "除外を外すと戻る＝通常の守りでは 90 日にならない");
});

Deno.test("落庫：applied（5 欄・履歴・取得日・派工の収回）・出処は書かない・同じファイルは unchanged・別の画像は conflict", async () => {
  const db = await freshDb();
  const { a } = await stage(db);
  await seed(db);
  const id = await submit(db, "politician_avatar", AV(a.pid), { status: "verified", urls: [FILE], task: AV_TASK(a.pid) });
  const refsBefore = await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'politicians' AND target_id = '${a.pid}'`);
  const out = await applyOne(db, id);
  assertEquals(out.status, "applied", JSON.stringify(out));
  assertEquals(out.outcome, "applied");
  const p = await one<Record<string, unknown>>(db, `SELECT avatar_url, avatar_file_page_url, avatar_license, avatar_author, to_char(avatar_retrieved_on, 'YYYY-MM-DD') AS d FROM policy_jp.politicians WHERE id = $1`, [a.pid]);
  assertEquals(p, { avatar_url: IMG, avatar_file_page_url: FILE, avatar_license: "CC BY-SA 4.0", avatar_author: "Hanako Suzuki", d: "2027-04-15" });
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'politicians' AND record_id = '${a.pid}' AND field LIKE 'avatar_%' AND contribution_id = '${id}'`), 5);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'politicians' AND target_id = '${a.pid}'`), refsBefore, "頭像のファイルページを人物の出処にしない");
  await seed(db);
  assertEquals(await dispatchIds(db, ["avatar_missing"]), [], "頭像ができたので派さない");
  // 同じファイル＝unchanged（applied 扱いで派工を閉じる）
  const again = await applyOne(db, await submit(db, "politician_avatar", AV(a.pid), { status: "verified", urls: [FILE] }));
  assertEquals([again.status, again.outcome], ["applied", "unchanged"]);
  // 別のファイル＝conflict（退件、上書きしない）
  const other = await applyOne(db, await submit(db, "politician_avatar", AV(a.pid, { file_page_url: "https://commons.wikimedia.org/wiki/File:Other.jpg", image_url: "https://upload.wikimedia.org/wikipedia/commons/c/cd/Other.jpg" }), { status: "verified", urls: [FILE] }));
  assertEquals([other.status, other.outcome], ["rejected", "conflict"]);
  assertEquals((await one<{ u: string }>(db, `SELECT avatar_url AS u FROM policy_jp.politicians WHERE id = $1`, [a.pid])).u, IMG);
});

Deno.test("落庫：Commons 以外・白名單外・欄位不足・知らない欄位・存在しない人は invalid で退件（庫は動かない）", async () => {
  const db = await freshDb();
  const { a } = await stage(db);
  const cases: Array<[string, Record<string, unknown>]> = [
    ["非 Commons 画像", AV(a.pid, { image_url: "https://example.com/a.jpg" })],
    ["非 Commons ページ", AV(a.pid, { file_page_url: "https://ja.wikipedia.org/wiki/File:A.jpg" })],
    ["NC", AV(a.pid, { license: "CC BY-NC 4.0" })],
    ["fair use", AV(a.pid, { license: "Fair use" })],
    ["作者なし", AV(a.pid, { author: "  " })],
    ["知らない欄位", AV(a.pid, { note: "x" })],
    ["存在しない人", AV("nobody")],
  ];
  for (const [label, payload] of cases) {
    const out = await applyOne(db, await submit(db, "politician_avatar", payload, { status: "verified", urls: [FILE] }));
    assertEquals([out.status, out.outcome], ["rejected", "invalid"], `${label}: ${JSON.stringify(out)}`);
  }
  assertEquals((await one<{ u: string | null }>(db, `SELECT avatar_url AS u FROM policy_jp.politicians WHERE id = $1`, [a.pid])).u, null);
});

Deno.test("公開読み取り：anon は politicians の頭像欄を読めるが、頭像の派工関数は呼べない", async () => {
  const db = await freshDb();
  const { a } = await stage(db);
  await db.query(`UPDATE policy_jp.politicians SET review_status = 'published' WHERE id = $1`, [a.pid]);
  const r = await asRole<{ avatar_url: string | null }>(db, "anon", `SELECT avatar_url FROM policy_jp.politicians WHERE id = '${a.pid}'`);
  assertEquals(r.length, 1);
  let denied = false;
  try { await asRole(db, "anon", `SELECT * FROM policy_jp.contribution_auto_tasks_avatar_missing()`); } catch { denied = true; }
  assert(denied);
});

Deno.test("TS：politician_avatar は avatar_missing の任務でだけ受け、task_id の人物と一致、source_urls に file_page_url が必要", () => {
  const base = { agent_name: "tester", agent_tool: "claude-code/claude-sonnet-4-5" };
  const item = (o: Record<string, unknown>, task: string | undefined, urls: string[] = [FILE]) => validateContributionRequest({
    ...base, contribution_type: "politician_avatar", payload: AV("p-1", o), source_urls: urls, ...(task ? { task_id: task } : {}),
  });
  assertEquals(item({}, AV_TASK("p-1")).errors, []);
  assert(item({}, AV_TASK("p-2")).errors.some((e) => e.path === "payload.politician_id"), "別の人物");
  assert(item({}, "auto:profile_gap:p-1").errors.some((e) => e.path === "task_id"), "別の任務型別");
  assert(item({}, AV_TASK("p-1"), ["https://example.com/"]).errors.some((e) => e.path === "source_urls"), "file_page_url が source_urls にない");
  assert(item({ license: "CC BY-NC 4.0" }, undefined).errors.some((e) => e.path === "payload.license"));
  assert(item({ x: 1 }, undefined).errors.some((e) => e.path === "payload.x"));
  assert(!JP_APPLY_TYPES.includes("nope" as never));
});
