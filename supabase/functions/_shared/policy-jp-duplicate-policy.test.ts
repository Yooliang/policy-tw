/**
 * 日本站派工臂對齊正見：重複政見 duplicate_policy＋交件型別 removal（migration 20261011180000_policy_jp_duplicate_policy.sql、工作単 Yooliang/policy-ops#95、第 2c 步）
 *   臂 duplicate_policy（task_type duplicate_policy、規則は預設關）＋交件型別 removal＋落庫 apply_removal（政見の軟移除＝review_status 'rejected'）。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts），時鐘用 `SET app.activity_today`。
 *
 *   a. 結構：臂名・総表・規則（預設關・常時窓・after_step なし・cap）・優先層（後段）・步驟順位 8・主控台の段・型別清單・共識（2 網段・目標 3・系統票なし）
 *   b. 預設關：seed しても派工列は 0；開くと 1 参選 1 件（公約 2 件以上だけ）、指紋・target・優先層 3
 *   c. 抑制：審議中の removal／confirmed は永久（指紋が同じ間）／not_found は冷却で戻る／清單が変われば新しい任務
 *   d. 落庫 apply_removal：公開済み → rejected＋edit_history＋出典；すでに rejected → unchanged；不合格は invalid（退件）；何も消さない；任務の收回
 *   e. 共識：removal は 3 票・2 網段
 *   f. 還原驗證・冪等・權限
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, applyOne, asRole, check, clock, count, dispatches, dispatchIds, events, expireCooling, freshDb, ICHI, migratedDb, mutate, one,
  openElectionWithRegion, readMig, rows, seed, statusOf, submit, vote,
} from "./policy-jp-chain-db.ts";

const MIG_FILE = "20261011180000_policy_jp_duplicate_policy.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV_DS = await readMig("20261011170000_policy_jp_district_seats.sql");
const POLLING = "2027-04-25";
const E1 = `${POLLING}_mayor_${ICHI}`;
const DUP_TYPES = ["duplicate_policy"];
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const KOUHOU = "https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf";
const TODAY = addDays(POLLING, -10);

const shared = await freshDb();
type Db = Awaited<ReturnType<typeof freshDb>>;

async function addCand(db: Db, name: string, kana: string): Promise<{ pid: string; peid: string }> {
  const payload = { election_id: E1, name, kana, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large" };
  const id = await submit(db, "candidacy", payload, { status: "verified", urls: [KOUHOU] });
  const out = await applyOne(db, id);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pid = (await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id;
  return { pid, peid: out.record_id! };
}
/** 公約を 1 件落庫する（policy 交件＝本番と同じ経路）。政見 id を返す */
async function addPolicy(db: Db, peid: string, title: string, description = "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。"): Promise<string> {
  const out = await applyOne(db, await submit(db, "policy", {
    politician_election_id: peid, title, description, category: "子育て", source_locator: "選挙公報 2 頁「子育て」", resolved_claim: "new",
  }, { status: "verified", urls: [KOUHOU] }));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  return out.record_id!;
}
/** ふだんの舞台：選挙・候補者 A（公約 2 件）・候補者 B（公約 1 件）。規則は開けない */
async function stage(db: Db) {
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "山田太郎", "やまだたろう");
  const p1 = await addPolicy(db, a.peid, "保育所の待機児童をなくす");
  const p2 = await addPolicy(db, a.peid, "子育て支援をもっと充実させる", "子育て世帯への支援を手厚くしていく。");
  const b = await addCand(db, "鈴木花子", "すずきはなこ");
  const pb = await addPolicy(db, b.peid, "公共交通を守る", "バス路線を維持する。");
  await clock(db, TODAY);
  return { a, b, p1, p2, pb };
}
const openRule = (db: Db) => db.exec(`UPDATE policy_jp.activity_rules SET enabled = true WHERE activity = 'duplicate_policy' AND priority IS NULL`);
const REMOVAL_ID_OK = (target: string, keep: string | null, o: Record<string, unknown> = {}) => ({
  target_table: "policies", target_id: target, ...(keep ? { keep_id: keep } : {}),
  reason: `${keep ?? "別の政見"} と同じ約束の言い換えで、${keep ?? "そちら"} の方が具体的なので残す`, ...o,
});
const submitRm = (db: Db, payload: Record<string, unknown>, o: Parameters<typeof submit>[3] = {}) =>
  submit(db, "removal", payload, { status: "verified", urls: [KOUHOU], ...o });
const armRows = (db: Db) => rows<{ task_id: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[]; reward: number; region: string }>(db,
  `SELECT task_id, target, what_we_need, hint_sources, reward, region FROM policy_jp.contribution_auto_tasks_duplicate_policy() ORDER BY task_id`);
const polStatus = async (db: Db, id: string) => (await one<{ s: string }>(db, `SELECT review_status AS s FROM policy_jp.policies WHERE id = $1`, [id])).s;
/** 指紋を SQL で独立に計算し直す（臂の実装とは別の書き方：文字列連結ではなく行ごとに json を作って畳む） */
const fpOf = async (db: Db, peid: string) => (await one<{ fp: string }>(db,
  `SELECT md5(jsonb_agg(jsonb_build_array(id, title, description) ORDER BY id)::TEXT) AS fp FROM policy_jp.policies WHERE politician_election_id = $1 AND review_status = 'published'`, [peid])).fp;

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：臂名・総表・規則（預設關・常時窓・after_step なし・cap 20）・優先層（後段 1 条）・步驟順位 8・主控台の段 3・型別清單（CHECK・apply_types）・共識は動かさない", async () => {
  assert((await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a.includes("duplicate_policy"));
  assert(fnText(MIG_SQL, TOTAL).includes("SELECT 'duplicate_policy' AS arm, t.* FROM policy_jp.contribution_auto_tasks_duplicate_policy() t"), "総表に UNION 分支");
  const r = await one<{ window_kind: string; min_status: string; after_step: string | null; enabled: boolean; params: Record<string, unknown> }>(shared,
    `SELECT window_kind, min_status, after_step, enabled, params FROM policy_jp.activity_rules WHERE activity = 'duplicate_policy' AND priority IS NULL`);
  assertEquals([r.window_kind, r.min_status, r.after_step, r.enabled], ["always", "announced", null, false], "預設關");
  assertEquals(r.params, { cap: 20 });
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:duplicate_policy' AND priority = 3`), 1);
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:duplicate_policy'`), 1, "優先層は後段 1 条だけ");
  const rank = (id: string, t: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, t]).then((x) => x.r);
  assertEquals(await rank("auto:duplicate_policy:x:y", "duplicate_policy"), 8);
  assertEquals(await rank("auto:policy_elements_missing:x", "policy_elements_missing"), 8, "既存の順位は動かない");
  assertEquals(await rank("auto:district_seats_missing:x", "district_seats_missing"), 4, "既存の順位は動かない");
  assertEquals(await rank("auto:something_new:x", "something_new"), 9, "未登録は 9 のまま");
  assertEquals((await one<{ stage: number }>(shared, `SELECT stage::INT AS stage FROM policy_jp.console_arm_stage_map WHERE arm = 'duplicate_policy'`)).stage, 3);
  assert((await one<{ a: string[] }>(shared, `SELECT policy_jp.apply_types() AS a`)).a.includes("removal"));
  assertEquals(await count(shared, `SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%removal%'`), 1);
  // 共識：この migration は共識関数を触らない（前から removal は 2 網段・目標 3・系統票なし）
  assert(!/FUNCTION policy_jp\.(contribution_needs_two_ips|contribution_required_agree|system_vote_eligible)/.test(MIG_SQL));
  assertEquals((await one<{ n: boolean; a: number; s: boolean }>(shared,
    `SELECT policy_jp.contribution_needs_two_ips('removal', '{}'::JSONB) AS n, policy_jp.contribution_required_agree('removal', '{}'::JSONB, ARRAY[]::TEXT[]) AS a, policy_jp.system_vote_eligible('removal') AS s`)),
    { n: true, a: 3, s: false });
});

// =============================================================================================
// b. 預設關と、開いたときの臂
// =============================================================================================
Deno.test("預設關：臂は行を返す（読み取りだけ）が、総表は 0 列・seed しても派工列は 0；enabled=true で開く（公約 2 件の参選だけ・1 件の参選は出ない）", async () => {
  const db = await freshDb();
  const s = await stage(db);
  assertEquals((await armRows(db)).map((x) => x.task_id.split(":")[2]), [s.a.peid, ].map((x) => x.split(":")[0]), "臂そのものは A だけ（公約 2 件）");
  assertEquals(await count(db, `SELECT 1 FROM ${TOTAL}() WHERE arm = 'duplicate_policy'`), 0, "総表は規則が閉じているので 0");
  await seed(db);
  assertEquals(await dispatchIds(db, DUP_TYPES), [], "派工列 0");
  await openRule(db);
  assertEquals(await count(db, `SELECT 1 FROM ${TOTAL}() WHERE arm = 'duplicate_policy'`), 1);
  await seed(db);
  const fp = await fpOf(db, s.a.peid);
  const taskId = `auto:duplicate_policy:${s.a.peid}:${fp}`;
  assertEquals(await dispatchIds(db, DUP_TYPES), [taskId]);
  const d = (await dispatches(db, DUP_TYPES))[0];
  assertEquals([d.task_type, d.priority, d.region, d.opened_by?.arm, d.opened_by?.chain_gate], ["duplicate_policy", 3, "愛知県", "duplicate_policy", undefined], "後段・鎖の gate なし");
  assertEquals(d.target.fingerprint, fp);
  assertEquals(fp.length, 32);
  await db.close();
});

Deno.test("target と文言：参選・人物・選挙・policies 全件（id 順、題名・要約・分野・出典）；日本語で、removal／no_change／task_id を案内し、台湾の語を含まない", async () => {
  const db = await freshDb();
  const s = await stage(db);
  const a = await armRows(db);
  assertEquals(a.length, 1);
  const t = a[0];
  assertEquals(t.reward, 1);
  assertEquals(t.region, "愛知県");
  assertEquals(t.target.politician_election_id, s.a.peid);
  assertEquals([t.target.politician_id, t.target.name, t.target.election_id, t.target.policies_count, t.target.lg_code, t.target.chain_lg_code], [s.a.pid, "山田太郎", E1, 2, ICHI, ICHI]);
  assertEquals(t.target.fingerprint, await fpOf(db, s.a.peid));
  const pols = t.target.policies as Array<Record<string, unknown>>;
  assertEquals(pols.map((p) => p.id), [s.p1, s.p2].sort(), "id 順");
  assertEquals(pols.find((p) => p.id === s.p1), {
    id: s.p1, title: "保育所の待機児童をなくす", description: "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。", category: "子育て", source_url: KOUHOU,
  });
  for (const w of ["removal", "target_table", "target_id", "keep_id", "reason", "no_change", "outcome=confirmed", t.task_id, "言い換え", "あいまいな方"]) assert(t.what_we_need.includes(w), w);
  assert(!/中選會|重複政見|READr|cec\.gov|policy-tw/i.test(t.what_we_need + t.hint_sources.join("")), "台湾の語を含まない");
  assert(t.hint_sources.some((h) => h.includes("target.policies")));
  await db.close();
});

Deno.test("対象の絞り込み：非公開の政見は数えない（公開 1 件になれば出ない）／非公開の参選・人物・選挙は出ない／別の人の公約は混ざらない", async () => {
  const db = await freshDb();
  const s = await stage(db);
  await db.query(`UPDATE policy_jp.policies SET review_status = 'pending' WHERE id = $1`, [s.p2]);
  assertEquals((await armRows(db)).length, 0, "公開 1 件");
  await db.query(`UPDATE policy_jp.policies SET review_status = 'published' WHERE id = $1`, [s.p2]);
  assertEquals((await armRows(db)).length, 1);
  await db.query(`UPDATE policy_jp.politician_elections SET review_status = 'pending' WHERE id = $1`, [s.a.peid]);
  assertEquals((await armRows(db)).length, 0, "参選が非公開");
  await db.query(`UPDATE policy_jp.politician_elections SET review_status = 'published' WHERE id = $1`, [s.a.peid]);
  await db.query(`UPDATE policy_jp.elections SET review_status = 'pending' WHERE id = $1`, [E1]);
  assertEquals((await armRows(db)).length, 0, "選挙が非公開");
  await db.close();
});

Deno.test("cap：params.cap で可派の前 N 件に絞る；cap なしなら 0 件", async () => {
  const db = await freshDb();
  const s = await stage(db);
  await addPolicy(db, s.b.peid, "公共交通の便を増やす", "コミュニティバスの便数を増やす。");
  assertEquals((await armRows(db)).length, 2);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = '{"cap":1}'::JSONB WHERE activity = 'duplicate_policy' AND priority IS NULL`);
  assertEquals((await armRows(db)).length, 1);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = '{}'::JSONB WHERE activity = 'duplicate_policy' AND priority IS NULL`);
  assertEquals((await armRows(db)).length, 0);
  await db.close();
});

// =============================================================================================
// c. 抑制
// =============================================================================================
Deno.test("抑制：清單の政見への removal が審議中（pending／verified／disputed／apply_failed）なら派さない、退件で戻る；別の人の政見への removal は関係ない", async () => {
  const db = await freshDb();
  const s = await stage(db);
  assertEquals((await armRows(db)).length, 1);
  const other = await submitRm(db, REMOVAL_ID_OK(s.pb, null), { status: "pending" });
  assertEquals((await armRows(db)).length, 1, "B の政見への removal は A の任務に関係ない");
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [other]);
  for (const st of ["pending", "verified", "disputed", "apply_failed"]) {
    const c = await submitRm(db, REMOVAL_ID_OK(s.p2, s.p1), { status: "pending" });
    await db.query(`UPDATE policy_jp.contributions SET status = $2 WHERE id = $1`, [c, st]);
    assertEquals((await armRows(db)).length, 0, `${st} は派さない`);
    await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [c]);
    assertEquals((await armRows(db)).length, 1, `${st} → 退件で戻る`);
  }
  await db.close();
});

Deno.test("抑制：この指紋で no_change confirmed 済みなら永久（冷却が過ぎても戻らない）；not_found／unreachable は通常の冷却で戻る；清單が変われば（題名・要約・追加）指紋が変わり新しい任務が出る", async () => {
  const db = await freshDb();
  const s = await stage(db);
  const t0 = (await armRows(db))[0].task_id;
  await check(db, t0, "not_found");
  assertEquals((await armRows(db)).length, 0, "not_found は冷却中");
  await expireCooling(db);
  assertEquals((await armRows(db)).map((x) => x.task_id), [t0], "冷却が過ぎれば戻る");
  await check(db, t0, "unreachable");
  assertEquals((await armRows(db)).length, 0, "unreachable も冷却中");
  await expireCooling(db);
  assertEquals((await armRows(db)).length, 1);
  // confirmed：永久
  await check(db, t0, "confirmed");
  assertEquals((await armRows(db)).length, 0, "confirmed");
  await expireCooling(db);
  await db.exec(`UPDATE policy_jp.task_checks SET checked_at = now() - INTERVAL '400 days'`);
  assertEquals((await armRows(db)).length, 0, "一年経っても confirmed のまま派さない");
  // 清單が変わる：題名を直す → 新しい指紋＝新しい task_id
  await db.query(`UPDATE policy_jp.policies SET title = '保育所の待機児童をゼロにする' WHERE id = $1`, [s.p1]);
  const t1 = (await armRows(db)).map((x) => x.task_id);
  assertEquals(t1.length, 1);
  assert(t1[0] !== t0 && t1[0].startsWith(`auto:duplicate_policy:${s.a.peid}:`), "題名が変わって新しい任務");
  assertEquals(t1[0], `auto:duplicate_policy:${s.a.peid}:${await fpOf(db, s.a.peid)}`);
  await check(db, t1[0], "confirmed");
  assertEquals((await armRows(db)).length, 0);
  // 要約だけ変わっても、政見が増えても指紋が変わる
  await db.query(`UPDATE policy_jp.policies SET description = '保育所の定員を増やす。' WHERE id = $1`, [s.p2]);
  const t2 = (await armRows(db)).map((x) => x.task_id);
  assertEquals(t2.length, 1);
  await check(db, t2[0], "confirmed");
  await addPolicy(db, s.a.peid, "学童保育の時間を延ばす", "学童保育を午後 7 時まで開ける。");
  const t3 = (await armRows(db)).map((x) => x.task_id);
  assertEquals(t3.length, 1);
  assert(t3[0] !== t2[0]);
  assertEquals((await armRows(db))[0].target.policies_count, 3);
  await db.close();
});

Deno.test("抑制：no_change（confirmed）の交件が等票中・通過済みの間は派さない（task_unavailable）；落庫で task_checks に入る", async () => {
  const db = await freshDb();
  const s = await stage(db);
  await openRule(db);
  await seed(db);
  const t = (await armRows(db))[0].task_id;
  const nc = await submit(db, "no_change", { task_id: t, outcome: "confirmed", checked_urls: [KOUHOU], finding: "二つの公約を読み比べたが、対象も内容も違うので重複はない" }, { status: "pending", task: t });
  assertEquals((await armRows(db)).length, 0, "no_change 等票中");
  await db.query(`UPDATE policy_jp.contributions SET status = 'verified', verified_at = now() WHERE id = $1`, [nc]);
  assertEquals((await armRows(db)).length, 0, "通過済み");
  const out = await applyOne(db, nc);
  assertEquals(out.status, "applied", JSON.stringify(out));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.task_checks WHERE task_id = $1 AND outcome = 'confirmed'`, [t]), 1);
  assertEquals((await armRows(db)).length, 0, "落庫後は永久");
  await seed(db);
  assertEquals(await dispatchIds(db, DUP_TYPES), [], "派工列も収回");
  assertEquals(s.p1.length > 0, true);
  await db.close();
});

// =============================================================================================
// d. 落庫 apply_removal
// =============================================================================================
Deno.test("落庫：公開済みの政見 → review_status='rejected'；edit_history に旧行・新行（auto-apply）；出典は source_refs；行も子表（policy_elements）も消えない；applied_policy_id", async () => {
  const db = await freshDb();
  const s = await stage(db);
  await db.query(`INSERT INTO policy_jp.policy_elements (id, policy_id, element, stated, text, source_locator, review_status) VALUES ('e-t', $1, 'target', true, '300 人増やす', '公報 2 頁', 'published')`, [s.p2]);
  const id = await submitRm(db, REMOVAL_ID_OK(s.p2, s.p1));
  const out = await applyOne(db, id);
  assertEquals([out.status, out.outcome, out.table_name, out.record_id], ["applied", "applied", "policies", s.p2], JSON.stringify(out));
  assertEquals(await polStatus(db, s.p2), "rejected");
  assertEquals(await polStatus(db, s.p1), "published", "残す方は動かない");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.policies WHERE id = $1`, [s.p2]), 1, "行は残る");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.policy_elements WHERE policy_id = $1`, [s.p2]), 1, "子表は消えない");
  const h = await one<{ field: string; old_value: Record<string, unknown>; new_value: Record<string, unknown>; agent_name: string; contribution_id: string }>(db,
    `SELECT field, old_value, new_value, agent_name, contribution_id FROM policy_jp.edit_history WHERE table_name = 'policies' AND record_id = $1 AND contribution_id = $2`, [s.p2, id]);
  assertEquals([h.field, h.old_value.review_status, h.new_value.review_status, h.agent_name], ["*", "published", "rejected", "auto-apply"]);
  assertEquals(h.old_value.title, h.new_value.title, "旧行・新行で他は同じ（履歴から戻せる）");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'policies' AND target_id = $1 AND source_id IN (SELECT id FROM policy_jp.sources WHERE url = $2)`, [s.p2, KOUHOU]), 1);
  const c = await one<{ applied_policy_id: string; applied_politician_id: string; status: string }>(db, `SELECT applied_policy_id, applied_politician_id, status FROM policy_jp.contributions WHERE id = $1`, [id]);
  assertEquals([c.applied_policy_id, c.applied_politician_id, c.status], [s.p2, s.a.pid, "applied"]);
  // 公開読み取り：anon には見えなくなる（rejected）
  assertEquals((await asRole<{ n: number }>(db, "anon", `SELECT count(*)::INT AS n FROM policy_jp.policies WHERE id = '${s.p2}'`))[0].n, 0);
  assertEquals((await asRole<{ n: number }>(db, "anon", `SELECT count(*)::INT AS n FROM policy_jp.policies WHERE id = '${s.p1}'`))[0].n, 1);
  await db.close();
});

Deno.test("落庫：keep_id なしでも通る；すでに rejected は unchanged（何も書かない）；二度目の落庫は何も増やさない", async () => {
  const db = await freshDb();
  const s = await stage(db);
  const first = await applyOne(db, await submitRm(db, REMOVAL_ID_OK(s.p2, null)));
  assertEquals(first.outcome, "applied", JSON.stringify(first));
  const n0 = await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'policies'`);
  const id2 = await submitRm(db, REMOVAL_ID_OK(s.p2, s.p1));
  const second = await applyOne(db, id2);
  assertEquals([second.status, second.outcome], ["applied", "unchanged"], JSON.stringify(second));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'policies'`), n0, "履歴は増えない");
  assertEquals(await statusOf(db, id2), "applied", "unchanged は成功扱い（冪等）");
  assertEquals(await polStatus(db, s.p2), "rejected");
  await db.close();
});

Deno.test("落庫：不合格は invalid で退件（何も変えない）— target_table が policies／politicians 以外／target_id なし／reason 短い／存在しない／pending の政見／keep_id が自分・存在しない・非公開・別の参選", async () => {
  const db = await freshDb();
  const s = await stage(db);
  const pendingP = await addPolicy(db, s.a.peid, "下書きの公約", "まだ公開していない公約。");
  await db.query(`UPDATE policy_jp.policies SET review_status = 'pending' WHERE id = $1`, [pendingP]);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["target_table が elections（政見と人物の removal だけ）", REMOVAL_ID_OK(s.p2, s.p1, { target_table: "elections" }), "policies"],
    ["target_table なし", (() => { const p = REMOVAL_ID_OK(s.p2, s.p1); delete (p as Record<string, unknown>).target_table; return p; })(), "policies"],
    ["target_id なし", REMOVAL_ID_OK(s.p2, s.p1, { target_id: "" }), "target_id"],
    ["reason が短い", REMOVAL_ID_OK(s.p2, s.p1, { reason: "重複しているため" }), "reason"],
    ["存在しない政見", REMOVAL_ID_OK("no-such-policy", s.p1), "登録されていない"],
    ["pending の政見", REMOVAL_ID_OK(pendingP, s.p1), "公開されていない"],
    ["keep_id が自分", REMOVAL_ID_OK(s.p2, s.p2), "同じ"],
    ["keep_id が存在しない", REMOVAL_ID_OK(s.p2, "no-such-keep"), "keep_id"],
    ["keep_id が非公開", REMOVAL_ID_OK(s.p2, pendingP), "keep_id"],
    ["keep_id が別の参選", REMOVAL_ID_OK(s.p2, s.pb), "同じ参選"],
  ];
  for (const [why, payload, needle] of cases) {
    const id = await submitRm(db, payload);
    const out = await applyOne(db, id);
    assertEquals([out.status, out.outcome], ["rejected", "invalid"], `${why}：${JSON.stringify(out)}`);
    assert(String(out.message).includes(needle), `${why}：${out.message}`);
    assertEquals(await statusOf(db, id), "rejected", why);
  }
  assertEquals(await polStatus(db, s.p2), "published", "どれも政見を動かさない");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'policies' AND field = '*' AND old_value->>'review_status' = 'published' AND new_value->>'review_status' = 'rejected'`), 0, "取り除いた履歴は 1 件もない");
  await db.close();
});

Deno.test("任務の收回：removal が applied になると派工列が落ち（task_id つき）、公開 1 件になった参選は臂が出さない（filled）；ledger に closed", async () => {
  const db = await freshDb();
  const s = await stage(db);
  await openRule(db);
  await seed(db);
  const t = (await dispatchIds(db, DUP_TYPES))[0];
  assert(t);
  const id = await submitRm(db, REMOVAL_ID_OK(s.p2, s.p1), { task: t });
  assertEquals((await applyOne(db, id)).outcome, "applied");
  assertEquals(await dispatchIds(db, DUP_TYPES), [], "落庫で即収回");
  await seed(db);
  assertEquals(await dispatchIds(db, DUP_TYPES), [], "seed 後も出ない");
  assertEquals((await events(db, t)).at(-1)?.event, "closed");
  assertEquals((await armRows(db)).length, 0);
  await db.close();
});

// =============================================================================================
// e. 共識
// =============================================================================================
Deno.test("共識：removal は 3 票・2 つ以上の網段で verified；同じ網段が 3 票でも足りない／2 票では足りない", async () => {
  const db = await freshDb();
  const s = await stage(db);
  const id = await submitRm(db, REMOVAL_ID_OK(s.p2, s.p1), { status: "pending", ip: "author-net" });
  assertEquals(await vote(db, id, "net-a"), "pending");
  assertEquals(await vote(db, id, "net-b"), "pending", "2 票");
  assertEquals(await vote(db, id, "net-c"), "verified", "3 票・3 網段");
  assertEquals((await applyOne(db, id)).outcome, "applied");
  assertEquals(await polStatus(db, s.p2), "rejected");
  // 同じ網段からの 3 票（代理は別）：点数は足りても 2 つの網段に届かないので通らない
  const s2 = await addPolicy(db, s.b.peid, "公共交通の便を増やす", "コミュニティバスの便数を増やす。");
  const id2 = await submitRm(db, REMOVAL_ID_OK(s2, s.pb), { status: "pending", ip: "author-net-2" });
  for (const n of ["a", "b", "c"]) {
    await db.query(`INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, agent_name, verifier_ip_hash, via, note, judge_backed) VALUES ($1, 'agree', $2, 'same-net', 'test', 'テスト', false)`, [id2, `other-agent-${n}`]);
  }
  assertEquals(await statusOf(db, id2), "pending", "同じ網段の 3 票");
  await vote(db, id2, "net-other-1");
  assertEquals(await vote(db, id2, "net-other-2"), "verified", "別の網段が加われば通る");
  await db.close();
});

// =============================================================================================
// f. 還原驗證・冪等・權限
// =============================================================================================
Deno.test("自我檢查（還原驗證）：規則が開いている／窓が違う／cap なし／優先層が欠ける・二重／総表の分支・臂名・順位・型別清單・WHEN・anon が欠ける／あると、migration が失敗する；元の SQL は通る", async () => {
  const pre = await migratedDb({ before: MIG_FILE });
  const bad = async (from: string, to: string, why: string) => {
    await assertRejects(() => pre.exec(mutate(MIG_SQL, from, to)), Error, undefined, why);
  };
  await bad(`SELECT 'duplicate_policy', 'always', 'announced', false,`, `SELECT 'duplicate_policy', 'always', 'announced', true,`, "規則が開いている");
  await bad(`'{"cap":20}'::JSONB,\n       '重複政見`, `'{}'::JSONB,\n       '重複政見`, "cap なし");
  await bad(`SELECT 'priority:duplicate_policy', 'always', 3,`, `SELECT 'priority:duplicate_policy', 'always', 1,`, "優先層が後段ではない");
  await bad(`  UNION ALL SELECT 'duplicate_policy' AS arm, t.* FROM policy_jp.contribution_auto_tasks_duplicate_policy() t\n`, "", "総表の分支が欠ける");
  await bad(`    'district_seats',\n    'duplicate_policy'\n  ]`, `    'district_seats'\n  ]`, "臂名が欠ける");
  await bad(`                  WHEN 'duplicate_policy' THEN 8\n`, "", "順位が欠ける");
  await bad(`'district_seats', 'removal', 'no_change']::TEXT[]`, `'district_seats', 'no_change']::TEXT[]`, "apply_types に無い");
  await bad(`               WHEN 'removal' THEN policy_jp.apply_removal(c)\n`, "", "apply_contribution の WHEN が無い");
  await bad(`'policy_elements', 'district_seats', 'removal'));`, `'policy_elements', 'district_seats'));`, "CHECK に無い");
  await bad(`  TO service_role;\n\n-- ------------------------------------------------------------\n-- 7.`, `  TO service_role, anon;\n\n-- ------------------------------------------------------------\n-- 7.`, "anon に渡す");
  await pre.exec(MIG_SQL);
  await pre.close();
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則・主控台登記が増えない（規則は閉じたまま）", async () => {
  const db = await freshDb();
  const n = () => Promise.all([count(db, `SELECT 1 FROM policy_jp.activity_rules`), count(db, `SELECT 1 FROM policy_jp.console_arm_stage_map`)]);
  const before = await n();
  await db.exec(MIG_SQL);
  assertEquals(await n(), before);
  assertEquals((await one<{ e: boolean }>(db, `SELECT enabled AS e FROM policy_jp.activity_rules WHERE activity = 'duplicate_policy' AND priority IS NULL`)).e, false);
  await db.close();
});

Deno.test("緊接在前一版：総表・臂名・順位は前の版に『1 行足しただけ』（残りは一字も変えない）", () => {
  const strip = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  assertEquals(strip(fnText(MIG_SQL, TOTAL)).replace(" UNION ALL SELECT 'duplicate_policy' AS arm, t.* FROM policy_jp.contribution_auto_tasks_duplicate_policy() t", ""), strip(fnText(PREV_DS, TOTAL)));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.chain_step_rank")).replace(" WHEN 'duplicate_policy' THEN 8", ""), strip(fnText(PREV_DS, "policy_jp.chain_step_rank")));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.activity_arm_names")).replace(", 'duplicate_policy'", ""), strip(fnText(PREV_DS, "policy_jp.activity_arm_names")));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.apply_contribution")).replace(" WHEN 'removal' THEN policy_jp.apply_removal(c)", ""), strip(fnText(PREV_DS, "policy_jp.apply_contribution")));
});

Deno.test("権限：新しい関数は anon／authenticated が呼べない（service_role は呼べる）", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.contribution_auto_tasks_duplicate_policy()`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.apply_removal(NULL::policy_jp.contributions)`), Error, "permission denied");
  }
  assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_duplicate_policy()`))[0].n, 0);
});
