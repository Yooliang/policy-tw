/**
 * 日本站派工臂對齊正見：政策の継承（lineage／handover）— migration 20261011210000_policy_jp_lineage.sql、工作単 Yooliang/policy-ops#95、C 期第 6 步
 *   臂 lineage_candidates／handover_missing／lineage_roles／lineage_links ＋ 交件型別 lineage／lineage_participants／lineage_handover／lineage_link（落庫 SQL apply_lineage*）。
 *   規則は enabled・常時窓・after_step なし・cap（理由は migration の檔頭）。「見た」の記録は task_checks（正見の lineage_candidate_reviews 表は持たない）。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts），時鐘用 `SET app.activity_today`。
 *
 *   a. 結構：臂名・総表・規則・優先層（専用規則なし）・步驟順位・主控台の段・交件型別（CHECK・apply_types）・共識（stop だけ 2 網段）
 *   b. lineage_candidates：格・指紋・confirmed は永久・票待ち・cooling・cap
 *   c. handover_missing：交代・再選は出さない・既存の交接・まだ就任していない後任
 *   d. lineage_roles：議員任期のある人の政策・既存の参加者
 *   e. lineage_links：一つ上の層・同じ層は出さない・既存の関連・confirmed は永久
 *   f. 派工列（seed）：層・opened_by
 *   g. 落庫 4 型別：applied／unchanged／conflict／invalid・履歴・出典・task_checks・「検査してから書く」
 *   h. TS：JP_TASK_ARMS・任務比對・項目検査・stop の出典・協議版號・同一件事の第三の道
 *   i. 還原驗證・冪等・前の版に足しただけ・権限
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, applyOne, asRole, check, clock, count, dispatches, dispatchIds, expireCooling, freshDb, ICHI, insertElection, insertLg, migratedDb, mutate, one,
  readMig, rows, seed, submit,
} from "./policy-jp-chain-db.ts";
import { JP_TASK_ARMS, jpSetNowForTest, jpTodayTokyo, validateContributionRequest } from "./jp/contribution-schema.ts";
import { JP_APPLY_TYPES } from "./jp/apply-contribution.ts";
import { JP_PROTOCOL_VERSION } from "./jp/protocol.ts";
import { APPLY_IDEMPOTENT_TYPES, isSameClaimType } from "./same-claims.ts";
import { claimKey, DUPLICATE_ELIGIBLE_TYPES } from "./duplicate-claim.ts";

const MIG_FILE = "20261011210000_policy_jp_lineage.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV = await readMig("20261011200000_policy_jp_progress.sql");
const TODAY = "2027-01-10";
const AICHI = "230006";
const TOKYO = "130001";
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const TYPES = ["lineage_candidate", "handover_missing", "lineage_roles_missing", "lineage_link_candidate"];
const KOUHOU = "https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf";
const NEWS = "https://news.example.com/ichinomiya/1";
const E_OLD = `2019-04-21_mayor_${ICHI}`;
const E_NEW = `2023-04-23_mayor_${ICHI}`;
const E_ASM = `2023-04-23_muni_assembly_${ICHI}`;
const NOTE = "どちらも市庁舎の建て替えを指していて、事業名・場所・予算額が同じである";

const shared = await freshDb();
await shared.waitReady; // 最初のテストが PGlite の初期化読み込みの完了を跨がないように
type Db = Awaited<ReturnType<typeof freshDb>>;
type Row = { task_id: string; task_type: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[]; reward: number; region: string };

async function stage(db: Db) {
  await insertElection(db, ICHI, "2019-04-21");
  await insertElection(db, ICHI, "2023-04-23");
  await insertElection(db, ICHI, "2023-04-23", { type: "muni_assembly" });
  await clock(db, TODAY);
}
let seq = 0;
type Person = { pid: string; peid: string; oid: string };
type PersonOpts = { election?: string; status?: string; position?: string; start?: string; scheduledEnd?: string; end?: string | null; lg?: string };
/** 人物＋参選＋任期（end を渡すと卸任済み）。任期 id は office:test:… （politician_offices_sync の管理外） */
async function addPerson(db: Db, o: PersonOpts = {}): Promise<Person> {
  const n = ++seq;
  const election = o.election ?? E_NEW;
  const pid = crypto.randomUUID();
  const peid = `${pid}:${election}:at_large`;
  const date = election.slice(0, 10);
  const start = o.start ?? addDays(date, 8);
  await db.query(`INSERT INTO policy_jp.politicians (id, name, kana, review_status) VALUES ($1, $2, $3, 'published')`, [pid, `山田太郎${n}`, `やまだたろう${n}`]);
  await db.query(`INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, status_date, district_kind, review_status)
                  VALUES ($1, $2, $3, $4, $5, 'at_large', 'published')`, [peid, pid, election, o.status ?? "elected", date]);
  const oid = `office:test:${peid}`;
  const end = o.end === undefined ? null : o.end;
  await db.query(
    `INSERT INTO policy_jp.politician_offices (id, politician_id, position, lg_code, term_no, start_date, scheduled_end_date, end_date, end_reason, end_basis, election_id, politician_election_id, review_status)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, CASE WHEN $7::DATE IS NULL THEN NULL ELSE 'term_expired' END, CASE WHEN $7::DATE IS NULL THEN NULL ELSE 'law' END, $8, $9, 'published')`,
    [oid, pid, o.position ?? "mayor", o.lg ?? ICHI, start, o.scheduledEnd ?? addDays(start, 1460), end, election, peid]);
  return { pid, peid, oid };
}
const prevMayor = (db: Db, o: PersonOpts = {}) => addPerson(db, { election: E_OLD, start: "2019-04-29", end: "2023-04-28", scheduledEnd: "2023-04-28", ...o });
async function addPol(db: Db, p: Person, o: { title?: string; category?: string; lineage?: string | null; origin?: string; review?: string } = {}) {
  const id = crypto.randomUUID();
  const origin = o.origin ?? "pledge";
  await db.query(
    `INSERT INTO policy_jp.policies (id, title, description, category, origin, source_locator, politician_election_id, lg_code, office_ids, status, last_updated, review_status, lineage_id)
     VALUES ($1, $2, $3, $4, $5, '選挙公報 2 頁', $6, $7, $8, 'not_started', $9, $10, $11)`,
    [id, o.title ?? "新庁舎を建てる", "市庁舎の建て替えを進めるとしている。", o.category ?? "公共施設", origin, origin === "pledge" ? p.peid : null, ICHI,
     origin === "pledge" ? [] : [p.oid], addDays(TODAY, -5), o.review ?? "published", o.lineage ?? null]);
  return id;
}
async function addLineage(db: Db, o: { level?: string; lg?: string | null; category?: string; title?: string; review?: string } = {}) {
  const id = crypto.randomUUID();
  const level = o.level ?? "local";
  const lg = o.lg === undefined ? (level === "national" ? null : level === "regional" ? AICHI : ICHI) : o.lg;
  if (lg) await insertLg(db, lg);
  await db.query(`INSERT INTO policy_jp.lineages (id, title, category, level, lg_code, review_status) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, o.title ?? `新庁舎の建設${++seq}`, o.category ?? "公共施設", level, lg, o.review ?? "published"]);
  return id;
}
const armRows = (db: Db, fn: string) => rows<Row>(db, `SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM policy_jp.${fn}() ORDER BY task_id`);
const candRows = (db: Db) => armRows(db, "contribution_auto_tasks_lineage_candidates");
const hoRows = (db: Db) => armRows(db, "contribution_auto_tasks_handover_missing");
const roleRows = (db: Db) => armRows(db, "contribution_auto_tasks_lineage_roles");
const linkRows = (db: Db) => armRows(db, "contribution_auto_tasks_lineage_links");
const setParams = (db: Db, activity: string, patch: Record<string, unknown>) =>
  db.query(`UPDATE policy_jp.activity_rules SET params = params || $2::JSONB WHERE activity = $1 AND priority IS NULL`, [activity, JSON.stringify(patch)]);
const putInLineage = (db: Db, lineage: string, policyIds: string[]) => db.query(`UPDATE policy_jp.policies SET lineage_id = $1 WHERE id = ANY ($2)`, [lineage, policyIds]);

/** 格（公共施設）に 2 つの任期の政策を 1 件ずつ入れる。戻りは [前任の政策, 後任の政策, 前任, 後任] */
async function twoTerms(db: Db) {
  const a = await prevMayor(db);
  const b = await addPerson(db);
  return [await addPol(db, a, { title: "新庁舎を建てる" }), await addPol(db, b, { title: "新庁舎の開庁準備" }), a, b] as const;
}

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：臂名・総表・規則・優先層（専用規則なし）・步驟順位・主控台の段・交件型別・共識（stop だけ 2 網段）", async () => {
  const names = (await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a;
  for (const a of ["lineage_candidates", "handover_missing", "lineage_roles", "lineage_links"]) assert(names.includes(a), a);
  const total = fnText(MIG_SQL, TOTAL);
  for (const a of ["lineage_candidates", "handover_missing", "lineage_roles", "lineage_links"]) {
    assert(total.includes(`SELECT '${a}' AS arm, t.* FROM policy_jp.contribution_auto_tasks_${a}() t`), `総表に ${a}`);
  }
  type R = { window_kind: string; after_step: string | null; enabled: boolean; params: Record<string, unknown> };
  for (const a of ["lineage_candidates", "handover_missing", "lineage_roles", "lineage_links"]) {
    const r = await one<R>(shared, `SELECT window_kind, after_step, enabled, params FROM policy_jp.activity_rules WHERE activity = $1 AND priority IS NULL`, [a]);
    assertEquals([r.window_kind, r.after_step, r.enabled, r.params], ["always", null, true, { cap: 100 }], a);
    assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = $1`, [`priority:${a}`]), 0, `${a} に優先層の専用規則を置かない`);
  }
  const rank = (id: string, ty: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, ty]).then((x) => x.r);
  assertEquals(await rank("auto:lineage_candidate:x:y", "lineage_candidate"), 9);
  assertEquals(await rank("auto:handover_missing:x:y", "handover_missing"), 9);
  assertEquals(await rank("auto:lineage_roles_missing:x", "lineage_roles_missing"), 9);
  assertEquals(await rank("auto:lineage_link_candidate:x:y", "lineage_link_candidate"), 9);
  assertEquals(await rank("auto:progress_stale:x", "progress_stale"), 9, "既存の順位は動かない");
  assertEquals(await rank("auto:term_policy_missing:x", "term_policy_missing"), 8);
  assertEquals(await rank("auto:policy_missing:x", "policy_missing"), 6);
  const st = await rows<{ arm: string; stage: number }>(shared,
    `SELECT arm, stage::INT AS stage FROM policy_jp.console_arm_stage_map WHERE arm IN ('lineage_candidates', 'handover_missing', 'lineage_roles', 'lineage_links') ORDER BY arm`);
  assertEquals(st, [{ arm: "handover_missing", stage: 7 }, { arm: "lineage_candidates", stage: 6 }, { arm: "lineage_links", stage: 6 }, { arm: "lineage_roles", stage: 6 }]);
  // 交件型別
  const types = (await one<{ t: string[] }>(shared, `SELECT policy_jp.apply_types() AS t`)).t;
  assertEquals([...types].sort(), [...JP_APPLY_TYPES].sort(), "SQL の apply_types と TS の JP_APPLY_TYPES が一致");
  for (const t of ["lineage", "lineage_participants", "lineage_handover", "lineage_link"]) {
    assert(types.includes(t), t);
    assertEquals(await count(shared, `SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%${t}%'`), 1, `CHECK に ${t}`);
  }
  // 共識：stop の交接だけ 2 網段、他は 1 つ・目標 3・系統票の候選に入らない
  const ips = (t: string, p: Record<string, unknown> = {}) =>
    one<{ x: boolean }>(shared, `SELECT policy_jp.contribution_needs_two_ips($1, $2::JSONB) AS x`, [t, JSON.stringify(p)]).then((r) => r.x);
  assertEquals(await ips("lineage_handover", { handover_type: "stop" }), true);
  for (const ty of ["keep", "pivot", "shrink", "resume"]) assertEquals(await ips("lineage_handover", { handover_type: ty }), false, ty);
  assertEquals(await ips("lineage_handover", {}), false);
  for (const t of ["lineage", "lineage_participants", "lineage_link"]) assertEquals(await ips(t), false, t);
  assertEquals(await ips("candidacy"), true, "既存の 2 網段は動かない");
  assertEquals(await ips("removal"), true);
  assertEquals(await ips("policy_progress"), false);
  const sys = (await one<{ s: string[] }>(shared, `SELECT policy_jp.system_one_precheck_types() AS s`)).s;
  for (const t of ["lineage", "lineage_participants", "lineage_handover", "lineage_link"]) {
    assertEquals((await one<{ a: number }>(shared, `SELECT policy_jp.contribution_required_agree($1, '{}'::JSONB, ARRAY[]::TEXT[]) AS a`, [t])).a, 3, `${t} の目標は 3`);
    assertEquals((await one<{ a: number }>(shared, `SELECT policy_jp.contribution_reject_floor($1) AS a`, [t])).a, 3, `${t} の退件は −3`);
    assert(!sys.includes(t), `${t} は系統票の候選に入らない`);
  }
  // この支が定義する共識まわりの関数は contribution_needs_two_ips だけ
  for (const f of ["contribution_required_agree", "system_one_precheck_types", "system_vote_eligible", "same_claim_matches", "task_unavailable", "refresh_dispatch_blocked", "seed_auto_task_queue"]) {
    assert(!MIG_SQL.includes(`FUNCTION policy_jp.${f}(`), `${f} を定義しない`);
  }
  const code = MIG_SQL.replace(/--[^\n]*/g, "");
  assert(!code.includes("public.") && !code.includes("ditrust"), "public／ditrust を触らない");
  assert((await one<{ c: string }>(shared, `SELECT obj_description('policy_jp.chain_step_rank(text, text)'::regprocedure) AS c`)).c.includes("lineage_candidate"), "chain_step_rank の COMMENT も更新");
});

// =============================================================================================
// b. lineage_candidates
// =============================================================================================
Deno.test("lineage_candidates：2 つの任期にまたがる格 → 1 件。target・文言・hint・region・task_id の形", async () => {
  const db = await freshDb();
  await stage(db);
  const [p1, p2, a, b] = await twoTerms(db);
  const r = await candRows(db);
  assertEquals(r.length, 1);
  const t = r[0];
  assert(/^auto:lineage_candidate:[0-9a-f]{12}:[0-9a-f]{8}$/.test(t.task_id), t.task_id);
  assertEquals([t.task_type, t.reward, t.region], ["lineage_candidate", 1, "愛知県"]);
  assertEquals([t.target.level, t.target.lg_code, t.target.lg_name, t.target.category, t.target.policies_total], ["local", ICHI, "一宮市", "公共施設", 2]);
  assertEquals((t.target.policies as Array<Record<string, unknown>>).map((x) => [x.policy_id, x.politician_id, x.election_id, x.election_year, x.lineage_id]),
    [[p1, a.pid, E_OLD, 2019, null], [p2, b.pid, E_NEW, 2023, null]], "選挙の古い順");
  assertEquals(t.target.existing_lineages, []);
  assert(t.what_we_need.includes("contribution_type=lineage") && t.what_we_need.includes("new_lineage") && t.what_we_need.includes("outcome=confirmed") && t.what_we_need.includes(t.task_id));
  assert(t.hint_sources.length === 4 && t.hint_sources.some((h) => h.includes("一宮市")));
  await db.close();
});

Deno.test("lineage_candidates：線引き（1 任期だけ・非公開・当選していない人の公約・全部脈絡入り・別の分野）と existing_lineages", async () => {
  const db = await freshDb();
  await stage(db);
  // 1 つの任期に政策が 2 件だけ → terms=1 で出ない
  const only = await addPerson(db);
  await addPol(db, only, { title: "A", category: "子育て" });
  await addPol(db, only, { title: "B", category: "子育て" });
  assertEquals((await candRows(db)).length, 0);
  // 落選者・非公開は数えない
  const lost = await addPerson(db, { status: "not_elected" });
  await addPol(db, lost, { title: "落選者の公約", category: "子育て" });
  await addPol(db, await prevMayor(db), { title: "非公開", category: "子育て", review: "pending" });
  assertEquals((await candRows(db)).length, 0);
  // 公約以外（任期の人物）は数える
  await addPol(db, await prevMayor(db), { title: "施政方針の項目", category: "子育て", origin: "policy_address" });
  assertEquals((await candRows(db)).length, 1);
  // 分野の違う政策は別の格
  await twoTerms(db);
  assertEquals((await candRows(db)).map((x) => x.target.category).sort(), ["公共施設", "子育て"]);
  // existing_lineages は同じ層・同じ団体の脈絡（同じ分野が先）。全部が脈絡に入ると出ない
  const lin = await addLineage(db, { category: "公共施設", title: "新庁舎の建設" });
  await addLineage(db, { category: "子育て", title: "保育所の整備" });
  await addLineage(db, { level: "regional", category: "公共施設", title: "県立施設" }); // 別の層は出ない
  const t = (await candRows(db)).find((x) => x.target.category === "公共施設")!;
  assertEquals((t.target.existing_lineages as Array<Record<string, unknown>>).map((x) => x.title), ["新庁舎の建設", "保育所の整備"]);
  await db.query(`UPDATE policy_jp.policies SET lineage_id = $1 WHERE category = '公共施設'`, [lin]);
  assertEquals((await candRows(db)).map((x) => x.target.category), ["子育て"], "公共施設の格は全部脈絡入りで出ない");
  await db.close();
});

Deno.test("lineage_candidates：confirmed は永久（指紋が同じ間）・清單が変わると出直す・票待ちの lineage は派さない・not_found は冷却", async () => {
  const db = await freshDb();
  await stage(db);
  const [, , , b] = await twoTerms(db);
  const t0 = (await candRows(db))[0];
  // 票待ちの lineage（同じ task_id）→ 派さない。rejected になれば戻る
  const pending = await submit(db, "lineage", { new_lineage: { title: "新庁舎の建設", category: "公共施設", level: "local", lg_code: ICHI }, policy_ids: [], note: NOTE }, { task: t0.task_id });
  assertEquals((await candRows(db)).length, 0);
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [pending]);
  assertEquals((await candRows(db)).map((x) => x.task_id), [t0.task_id]);
  // not_found は標準の冷却（confirmed ではない）
  await check(db, t0.task_id, "not_found");
  assertEquals((await candRows(db)).length, 0);
  await expireCooling(db);
  assertEquals((await candRows(db)).length, 1);
  // confirmed は永久（冷却が切れても戻らない）
  await check(db, t0.task_id, "confirmed");
  await expireCooling(db);
  assertEquals((await candRows(db)).length, 0, "confirmed は永久");
  // 清單が変わる（政策が増える）と指紋が変わり、また出る
  await addPol(db, b, { title: "新庁舎の外構工事" });
  const t1 = (await candRows(db))[0];
  assert(t1 && t1.task_id !== t0.task_id && t1.task_id.split(":")[2] === t0.task_id.split(":")[2], "格の鍵は同じで指紋だけ変わる");
  await db.close();
});

Deno.test("lineage_candidates：層（都道府県は regional）と cap・規則を止めると何も返さない", async () => {
  const db = await freshDb();
  await stage(db);
  await insertElection(db, AICHI, "2019-04-07", { type: "governor" });
  await insertElection(db, AICHI, "2023-04-09", { type: "governor" });
  const g1 = await addPerson(db, { election: `2019-04-07_governor_${AICHI}`, position: "governor", lg: AICHI, start: "2019-04-20", end: "2023-04-19", scheduledEnd: "2023-04-19" });
  const g2 = await addPerson(db, { election: `2023-04-09_governor_${AICHI}`, position: "governor", lg: AICHI });
  for (const p of [g1, g2]) {
    await db.query(
      `INSERT INTO policy_jp.policies (id, title, description, category, origin, source_locator, politician_election_id, lg_code, status, last_updated, review_status)
       VALUES ($1, '県立病院の再編', '県立病院を再編するとしている。', '医療', 'pledge', '選挙公報', $2, $3, 'not_started', $4, 'published')`, [crypto.randomUUID(), p.peid, AICHI, addDays(TODAY, -5)]);
  }
  await twoTerms(db);
  const all = await candRows(db);
  assertEquals(all.map((x) => [x.target.level, x.target.lg_code, x.target.category]).sort(), [["local", ICHI, "公共施設"], ["regional", AICHI, "医療"]]);
  await setParams(db, "lineage_candidates", { cap: 1 });
  assertEquals((await candRows(db)).length, 1);
  await setParams(db, "lineage_candidates", { cap: 100 });
  await db.query(`UPDATE policy_jp.activity_rules SET enabled = false WHERE activity = 'lineage_candidates'`);
  await seed(db);
  assertEquals((await dispatchIds(db, ["lineage_candidate"])), [], "規則を止めると総表が返さない");
  await db.query(`DELETE FROM policy_jp.activity_rules WHERE activity = 'lineage_candidates' AND priority IS NULL`);
  assertEquals((await candRows(db)).length, 0, "規則（cap）がなければ何も返さない");
  await db.close();
});

// =============================================================================================
// c. handover_missing
// =============================================================================================
Deno.test("handover_missing：脈絡の中に前任市長の政策・任期は終了・別の人が後任 → 1 件。target・文言・task_id", async () => {
  const db = await freshDb();
  await stage(db);
  const [p1, p2, a, b] = await twoTerms(db);
  const lin = await addLineage(db);
  await putInLineage(db, lin, [p1, p2]);
  const r = await hoRows(db);
  assertEquals(r.length, 1);
  const t = r[0];
  assert(new RegExp(`^auto:handover_missing:${lin}:[0-9a-f]{8}$`).test(t.task_id), t.task_id);
  assertEquals([t.task_type, t.reward, t.region], ["handover_missing", 1, "愛知県"]);
  assertEquals([t.target.lineage_id, t.target.position, t.target.from_office_id, t.target.to_office_id, t.target.from_politician_id, t.target.to_politician_id],
    [lin, "mayor", a.oid, b.oid, a.pid, b.pid]);
  assertEquals([t.target.from_term_start, t.target.from_term_end, t.target.to_term_start], ["2019-04-29", "2023-04-28", "2023-05-01"]);
  assertEquals((t.target.from_policies as Array<Record<string, unknown>>).map((x) => x.policy_id), [p1]);
  assertEquals((t.target.to_policies as Array<Record<string, unknown>>).map((x) => x.policy_id), [p2]);
  assert(t.what_we_need.includes("contribution_type=lineage_handover") && t.what_we_need.includes("outcome=not_found") && t.what_we_need.includes("stop（中止）には"));
  assert(t.what_we_need.includes(a.oid) && t.what_we_need.includes(b.oid) && t.what_we_need.includes(lin));
  await db.close();
});

Deno.test("handover_missing：出さないもの（同じ人の再選・前任が在任中・後任が未就任・議員の任期・既存の交接・票待ち・非公開の脈絡）と冷却", async () => {
  const db = await freshDb();
  await stage(db);
  const [p1, p2, a, b] = await twoTerms(db);
  const lin = await addLineage(db);
  await putInLineage(db, lin, [p1, p2]);
  assertEquals((await hoRows(db)).length, 1);
  // 票待ち → 派さない、rejected で戻る
  const pend = await submit(db, "lineage_handover", { lineage_id: lin, from_office_id: a.oid, to_office_id: b.oid, handover_type: "keep", note: NOTE + "ことを予算書で確認した", source_locator: "予算書 12 頁" });
  assertEquals((await hoRows(db)).length, 0);
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [pend]);
  assertEquals((await hoRows(db)).length, 1);
  // 冷却
  const tid = (await hoRows(db))[0].task_id;
  await check(db, tid, "not_found");
  assertEquals((await hoRows(db)).length, 0);
  await expireCooling(db);
  assertEquals((await hoRows(db)).length, 1);
  // 既存の交接 → 出ない
  await db.query(`INSERT INTO policy_jp.handovers (id, lineage_id, from_office_id, to_office_id, handover_type, review_status) VALUES ('h1', $1, $2, $3, 'keep', 'published')`, [lin, a.oid, b.oid]);
  assertEquals((await hoRows(db)).length, 0);
  await db.query(`DELETE FROM policy_jp.handovers WHERE id = 'h1'`);
  assertEquals((await hoRows(db)).length, 1);
  // 前任が在任中（end_date が空）→ 出ない
  await db.query(`UPDATE policy_jp.politician_offices SET end_date = NULL, end_reason = NULL, end_basis = NULL WHERE id = $1`, [a.oid]);
  assertEquals((await hoRows(db)).length, 0);
  await db.query(`UPDATE policy_jp.politician_offices SET end_date = '2023-04-28', end_reason = 'term_expired', end_basis = 'law' WHERE id = $1`, [a.oid]);
  // 後任がまだ就任していない → 出ない
  await db.query(`UPDATE policy_jp.politician_offices SET start_date = $2, scheduled_end_date = $3 WHERE id = $1`, [b.oid, addDays(TODAY, 30), addDays(TODAY, 1500)]);
  assertEquals((await hoRows(db)).length, 0);
  await db.query(`UPDATE policy_jp.politician_offices SET start_date = '2023-05-01', scheduled_end_date = '2027-04-30' WHERE id = $1`, [b.oid]);
  assertEquals((await hoRows(db)).length, 1);
  // 同じ人の再選（後任の任期の人物が前任と同じ）→ 出ない
  await db.query(`UPDATE policy_jp.politician_offices SET politician_id = $2 WHERE id = $1`, [b.oid, a.pid]);
  assertEquals((await hoRows(db)).length, 0, "再選は交接の臂に出さない");
  await db.query(`UPDATE policy_jp.politician_offices SET politician_id = $2 WHERE id = $1`, [b.oid, b.pid]);
  // 非公開の脈絡
  await db.query(`UPDATE policy_jp.lineages SET review_status = 'pending' WHERE id = $1`, [lin]);
  assertEquals((await hoRows(db)).length, 0);
  await db.query(`UPDATE policy_jp.lineages SET review_status = 'published' WHERE id = $1`, [lin]);
  // 議員の任期の政策だけの脈絡は交接の対象にならない
  const lin2 = await addLineage(db, { title: "議員の件" });
  const m1 = await addPerson(db, { election: E_ASM, position: "muni_assembly_member", start: "2019-04-29", end: "2023-04-28", scheduledEnd: "2023-04-28" });
  await putInLineage(db, lin2, [await addPol(db, m1, { title: "議員の公約" })]);
  assertEquals((await hoRows(db)).map((x) => x.target.lineage_id), [lin]);
  await db.close();
});

// =============================================================================================
// d. lineage_roles
// =============================================================================================
Deno.test("lineage_roles：脈絡に議員任期のある人の政策がある → 1 件（人は名前順）。首長だけの脈絡・既存の参加者・未就任の議員は出ない", async () => {
  const db = await freshDb();
  await stage(db);
  const lin = await addLineage(db);
  const mayor = await addPerson(db);
  await putInLineage(db, lin, [await addPol(db, mayor)]);
  assertEquals((await roleRows(db)).length, 0, "首長だけの脈絡は議員の役割の対象ではない");
  const m1 = await addPerson(db, { election: E_ASM, position: "muni_assembly_member" });
  const m2 = await addPerson(db, { election: E_ASM, position: "muni_assembly_member" });
  await putInLineage(db, lin, [await addPol(db, m1, { title: "議員 1 の公約" }), await addPol(db, m2, { title: "議員 2 の公約" })]);
  const r = await roleRows(db);
  assertEquals(r.length, 1);
  const t = r[0];
  assertEquals([t.task_id, t.task_type, t.reward], [`auto:lineage_roles_missing:${lin}`, "lineage_roles_missing", 1]);
  assertEquals((t.target.people as Array<Record<string, unknown>>).map((x) => x.politician_id), [m1.pid, m2.pid]);
  assertEquals([t.target.lineage_id, t.target.level, t.target.lg_code, t.target.category], [lin, "local", ICHI, "公共施設"]);
  assert(t.what_we_need.includes("contribution_type=lineage_participants") && t.what_we_need.includes("outcome=not_found") && t.what_we_need.includes(`auto:lineage_roles_missing:${lin}`));
  // 1 人に参加者の記録ができると、残りの 1 人だけが target に残る
  await db.query(`INSERT INTO policy_jp.lineage_participants (id, lineage_id, politician_id, role, basis, source_locator, review_status) VALUES ('lp1', $1, $2, 'proposer', 'official_record', '議案 3 号', 'published')`, [lin, m1.pid]);
  assertEquals(((await roleRows(db))[0].target.people as Array<Record<string, unknown>>).map((x) => x.politician_id), [m2.pid]);
  await db.query(`INSERT INTO policy_jp.lineage_participants (id, lineage_id, politician_id, role, basis, source_locator, review_status) VALUES ('lp2', $1, $2, 'advocate', 'self_claim', '会議録', 'published')`, [lin, m2.pid]);
  assertEquals((await roleRows(db)).length, 0, "全員に記録ができれば出ない");
  await db.query(`DELETE FROM policy_jp.lineage_participants WHERE id = 'lp2'`);
  // 票待ち → 派さない
  const pend = await submit(db, "lineage_participants", { lineage_id: lin, participants: [] });
  assertEquals((await roleRows(db)).length, 0);
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [pend]);
  assertEquals((await roleRows(db)).length, 1);
  // 冷却
  await check(db, `auto:lineage_roles_missing:${lin}`, "not_found");
  assertEquals((await roleRows(db)).length, 0);
  await expireCooling(db);
  assertEquals((await roleRows(db)).length, 1);
  // 議員の任期がまだ始まっていない人は数えない
  await db.query(`UPDATE policy_jp.politician_offices SET start_date = $2, scheduled_end_date = $3 WHERE id = $1`, [m2.oid, addDays(TODAY, 30), addDays(TODAY, 1500)]);
  assertEquals((await roleRows(db)).length, 0, "m1 は記録済み・m2 は未就任＝対象の人がいない");
  await db.close();
});

// =============================================================================================
// e. lineage_links
// =============================================================================================
Deno.test("lineage_links：一つ上の層で同じ分野の脈絡がある下級 → 1 件。同じ層・別の分野・別の都道府県は候補にならない", async () => {
  const db = await freshDb();
  await stage(db);
  const lower = await addLineage(db, { title: "一宮市の庁舎整備" });
  assertEquals((await linkRows(db)).length, 0);
  await addLineage(db, { title: "同じ層", level: "local", lg: ICHI }); // 同じ層
  await addLineage(db, { title: "別の分野", level: "national", category: "子育て" });
  await addLineage(db, { title: "東京都の施設", level: "regional", lg: TOKYO }); // 別の都道府県
  assertEquals((await linkRows(db)).filter((x) => x.target.lineage_id === lower).length, 0);
  const natl = await addLineage(db, { title: "公共施設の国の補助", level: "national" });
  const pref = await addLineage(db, { title: "愛知県の施設整備", level: "regional" });
  const r = await linkRows(db);
  const t = r.find((x) => x.target.lineage_id === lower)!;
  assert(new RegExp(`^auto:lineage_link_candidate:${lower}:[0-9a-f]{8}$`).test(t.task_id), t.task_id);
  assertEquals([t.task_type, t.reward, t.region], ["lineage_link_candidate", 1, "愛知県"]);
  assertEquals((t.target.upper_candidates as Array<Record<string, unknown>>).map((x) => x.lineage_id).sort(), [natl, pref].sort());
  assertEquals([t.target.level, t.target.lg_code, t.target.category], ["local", ICHI, "公共施設"]);
  assert(t.what_we_need.includes("contribution_type=lineage_link") && t.what_we_need.includes("outcome=confirmed") && t.what_we_need.includes(t.task_id));
  const t2 = r.find((x) => x.target.lineage_id === pref)!;
  assertEquals((t2.target.upper_candidates as Array<Record<string, unknown>>).map((x) => x.lineage_id), [natl], "県の脈絡の上は国だけ");
  await db.close();
});

Deno.test("lineage_links：既存の関連は候補から外れ指紋が変わる・confirmed は永久・票待ち・冷却", async () => {
  const db = await freshDb();
  await stage(db);
  const lower = await addLineage(db, { title: "一宮市の庁舎整備" });
  const natl = await addLineage(db, { title: "国の補助", level: "national" });
  const pref = await addLineage(db, { title: "県の施設整備", level: "regional" });
  const mine = async () => (await linkRows(db)).filter((x) => x.target.lineage_id === lower);
  const t0 = (await mine())[0];
  await db.query(`INSERT INTO policy_jp.lineage_links (id, upper_lineage_id, lower_lineage_id, link_type, note, source_locator, review_status)
                  VALUES ('k1', $1, $2, 'top_down', $3, '通知 3 号', 'published')`, [natl, lower, NOTE + "ことが計画書に書かれている"]);
  const t1 = (await mine())[0];
  assertEquals((t1.target.upper_candidates as Array<Record<string, unknown>>).map((x) => x.lineage_id), [pref], "つながった上級は候補から外れる");
  assert(t1.task_id !== t0.task_id, "候補が変わると指紋が変わる");
  // confirmed は永久
  await check(db, t1.task_id, "confirmed");
  await expireCooling(db);
  assertEquals((await mine()).length, 0);
  // 票待ち → 派さない、rejected で戻る
  await db.query(`DELETE FROM policy_jp.task_checks WHERE task_id = $1`, [t1.task_id]);
  const pend = await submit(db, "lineage_link", { upper_lineage_id: pref, lower_lineage_id: lower, link_type: "top_down", note: NOTE + "ことが計画書に書かれている", source_locator: "計画書 3 頁" }, { task: t1.task_id });
  assertEquals((await mine()).length, 0);
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [pend]);
  assertEquals((await mine()).length, 1);
  // 冷却
  await check(db, t1.task_id, "unreachable");
  assertEquals((await mine()).length, 0);
  await expireCooling(db);
  assertEquals((await mine()).length, 1);
  // 全部の上級に関連があれば出ない
  await db.query(`INSERT INTO policy_jp.lineage_links (id, upper_lineage_id, lower_lineage_id, link_type, note, source_locator, review_status)
                  VALUES ('k2', $1, $2, 'bottom_up', $3, '通知 4 号', 'published')`, [pref, lower, NOTE + "ことが計画書に書かれている"]);
  assertEquals((await mine()).length, 0);
  await db.close();
});

// =============================================================================================
// f. 派工列（seed）
// =============================================================================================
Deno.test("seed：4 つの臂が派工列に載る（既定の中段・鎖の gate なし・opened_by に臂名）", async () => {
  const db = await freshDb();
  await stage(db);
  const [p1, p2] = await twoTerms(db);
  const lin = await addLineage(db, { title: "新庁舎の建設" });
  await putInLineage(db, lin, [p1, p2]);
  const m1 = await addPerson(db, { election: E_ASM, position: "muni_assembly_member" });
  await putInLineage(db, lin, [await addPol(db, m1, { title: "議員の公約", lineage: lin })]);
  await addLineage(db, { title: "国の補助", level: "national" });
  await seed(db);
  const disp = await dispatches(db, TYPES);
  // 脈絡に入っていない政策はない（候補の臂は出ない）。交接・役割・上下級の 3 つ
  assertEquals(disp.map((r) => r.task_type).sort(), ["handover_missing", "lineage_link_candidate", "lineage_roles_missing"]);
  const arm = (ty: string) => disp.find((r) => r.task_type === ty)!.opened_by?.arm;
  assertEquals([arm("handover_missing"), arm("lineage_roles_missing"), arm("lineage_link_candidate")], ["handover_missing", "lineage_roles", "lineage_links"]);
  for (const r of disp) {
    assertEquals(r.priority, 2, "専用の優先層規則なし＝既定の中段");
    assertEquals(r.opened_by?.chain_gate, undefined, "鎖の gate なし");
  }
  // 政策を 1 件脈絡から外すと候補の臂も出る
  await db.query(`UPDATE policy_jp.policies SET lineage_id = NULL WHERE id = $1`, [p2]);
  await seed(db);
  const c = (await dispatches(db, ["lineage_candidate"]))[0];
  assertEquals([c?.opened_by?.arm, c?.priority], ["lineage_candidates", 2]);
  await db.close();
});

// =============================================================================================
// g. 落庫
// =============================================================================================
const lineageNew = (policyIds: string[], patch: Record<string, unknown> = {}, nl: Record<string, unknown> = {}) => ({
  new_lineage: { title: "新庁舎の建設", summary: "市庁舎の建て替え", category: "公共施設", level: "local", lg_code: ICHI, ...nl }, policy_ids: policyIds, note: NOTE, ...patch,
});
const verified = (db: Db, type: string, payload: Record<string, unknown>, o: { urls?: string[]; task?: string } = {}) =>
  submit(db, type, payload, { status: "verified", urls: o.urls ?? [KOUHOU], task: o.task ?? null });

Deno.test("落庫 lineage：new_lineage で脈絡を建てて政策を掛ける（履歴・出典・applied_policy_id・候補の task_checks confirmed）→ 再度は conflict／既存への再掛けは unchanged", async () => {
  const db = await freshDb();
  await stage(db);
  const [p1, p2] = await twoTerms(db);
  await seed(db);
  const t0 = (await candRows(db))[0];
  assertEquals(await dispatchIds(db, ["lineage_candidate"]), [t0.task_id]);
  const id = await verified(db, "lineage", lineageNew([p1, p2]), { task: t0.task_id });
  const out = await applyOne(db, id);
  assertEquals([out.status, out.outcome, out.table_name], ["applied", "applied", "lineages"], JSON.stringify(out));
  const lin = out.record_id!;
  const l = await one<{ title: string; level: string; lg_code: string; category: string; summary: string; review_status: string }>(db, `SELECT title, level, lg_code, category, summary, review_status FROM policy_jp.lineages WHERE id = $1`, [lin]);
  assertEquals(l, { title: "新庁舎の建設", level: "local", lg_code: ICHI, category: "公共施設", summary: "市庁舎の建て替え", review_status: "published" });
  assertEquals((await rows<{ id: string }>(db, `SELECT id FROM policy_jp.policies WHERE lineage_id = $1 ORDER BY id`, [lin])).map((x) => x.id), [p1, p2].sort());
  const hist = await rows<{ table_name: string; field: string; agent_name: string }>(db, `SELECT table_name, field, agent_name FROM policy_jp.edit_history WHERE contribution_id = $1 ORDER BY id`, [id]);
  assertEquals(hist.map((h) => `${h.table_name}.${h.field}`), ["lineages.*", "policies.lineage_id", "policies.lineage_id"]);
  assert(hist.every((h) => h.agent_name === "auto-apply"));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'lineages' AND target_id = '${lin}'`), 1, "出典が lineages につく");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.task_checks WHERE task_id = '${t0.task_id}' AND outcome = 'confirmed'`), 1, "候補を見た記録");
  assertEquals((await one<{ s: string; p: string }>(db, `SELECT status AS s, applied_policy_id AS p FROM policy_jp.contributions WHERE id = $1`, [id])), { s: "applied", p: [p1, p2].sort()[0] });
  // 同じ内容をもう一度（別の人）→ 同名の脈絡なので conflict
  const again = await applyOne(db, await verified(db, "lineage", lineageNew([p1, p2])));
  assertEquals([again.status, again.outcome], ["rejected", "conflict"], JSON.stringify(again));
  // 既存の脈絡に同じ政策を入れ直す → unchanged
  const same = await applyOne(db, await verified(db, "lineage", { lineage_id: lin, policy_ids: [p1], note: NOTE }));
  assertEquals([same.status, same.outcome], ["applied", "unchanged"], JSON.stringify(same));
  // 派工は收回され、戻らない（同じ指紋の confirmed は永久）
  await seed(db);
  assertEquals(await dispatchIds(db, ["lineage_candidate"]), []);
  await db.close();
});

Deno.test("落庫 lineage：既存への掛け外し・題名の訂正・別の脈絡にある政策は conflict・invalid 各種（書く前に止める）", async () => {
  const db = await freshDb();
  await stage(db);
  const [p1, p2, a] = await twoTerms(db);
  const p3 = await addPol(db, a, { title: "庁舎の駐車場" });
  const lin = await addLineage(db, { title: "新庁舎の建設" });
  const other = await addLineage(db, { title: "別の件" });
  await putInLineage(db, other, [p3]);
  const run = async (payload: Record<string, unknown>) => applyOne(db, await verified(db, "lineage", payload));
  // 掛ける
  let o = await run({ lineage_id: lin, policy_ids: [p1, p2], note: NOTE });
  assertEquals([o.status, o.outcome], ["applied", "applied"], JSON.stringify(o));
  // 別の脈絡にある政策は conflict
  o = await run({ lineage_id: lin, policy_ids: [p3], note: NOTE });
  assertEquals([o.status, o.outcome], ["rejected", "conflict"], JSON.stringify(o));
  assertEquals((await one<{ l: string }>(db, `SELECT lineage_id AS l FROM policy_jp.policies WHERE id = $1`, [p3])).l, other, "conflict は書かない");
  // 外す
  o = await run({ lineage_id: lin, detach_policy_ids: [p2], note: NOTE });
  assertEquals([o.status, o.outcome], ["applied", "applied"], JSON.stringify(o));
  assertEquals((await one<{ l: string | null }>(db, `SELECT lineage_id AS l FROM policy_jp.policies WHERE id = $1`, [p2])).l, null);
  // 題名・要約・分野の訂正
  o = await run({ lineage_id: lin, title: "新庁舎の建設と開庁", summary: "更新", category: "公共施設", note: NOTE });
  assertEquals([o.status, o.outcome], ["applied", "applied"], JSON.stringify(o));
  assertEquals((await one<{ t: string; s: string }>(db, `SELECT title AS t, summary AS s FROM policy_jp.lineages WHERE id = $1`, [lin])), { t: "新庁舎の建設と開庁", s: "更新" });
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'lineages' AND record_id = '${lin}' AND field = 'title'`), 1);
  // invalid：どれも書かない
  const before = await count(db, `SELECT 1 FROM policy_jp.edit_history`);
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ["両方ない", { policy_ids: [p1], note: NOTE }, "どちらか一方"],
    ["両方ある", { lineage_id: lin, ...lineageNew([p1, p2]) }, "どちらか一方"],
    ["note が短い", { lineage_id: lin, policy_ids: [p1], note: "短い" }, "note は 20～1000"],
    ["存在しない政策", { lineage_id: lin, policy_ids: ["no-such"], note: NOTE }, "登録されていない"],
    ["掛けると外すが同じ", { lineage_id: lin, policy_ids: [p1], detach_policy_ids: [p1], note: NOTE }, "同時に外す"],
    ["存在しない脈絡", { lineage_id: "no-such", policy_ids: [p1], note: NOTE }, "登録されていない"],
    ["空の訂正", { lineage_id: lin, note: NOTE }, "policy_ids"],
    ["title が短い", { lineage_id: lin, title: "短", note: NOTE }, "title は 4～60"],
    ["local に政策 1 件", lineageNew([p1], {}, { title: "別の名前の件" }), "2 件以上"],
    ["local なのに lg_code なし", lineageNew([p1, p2], {}, { title: "別の名前の件", lg_code: null }), "lg_code"],
    ["national に lg_code", lineageNew([p1, p2], {}, { title: "別の名前の件", level: "national" }), "lg_code を付けない"],
    ["level と団体の種類が合わない", lineageNew([p1, p2], {}, { title: "別の名前の件", level: "regional" }), "合わない"],
    ["level が不正", lineageNew([p1, p2], {}, { title: "別の名前の件", level: "county" }), "level は"],
    ["新規に detach", lineageNew([p1, p2], { detach_policy_ids: [p3] }, { title: "別の名前の件" }), "外す政策はない"],
  ];
  for (const [why, payload, msg] of bad) {
    const r = await run(payload);
    assertEquals([r.status, r.outcome], ["rejected", "invalid"], `${why}：${JSON.stringify(r)}`);
    assert(String(r.message).includes(msg), `${why}：${r.message}`);
  }
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history`), before, "invalid は何も書かない");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.lineages`), 2, "脈絡は増えていない");
  await db.close();
});

Deno.test("落庫 lineage_participants：applied／上書き／remove／unchanged・official_record の出典・不正な 1 件で全部止まる（半端に書かない）・task の收回", async () => {
  const db = await freshDb();
  await stage(db);
  const lin = await addLineage(db);
  const m1 = await addPerson(db, { election: E_ASM, position: "muni_assembly_member" });
  const m2 = await addPerson(db, { election: E_ASM, position: "muni_assembly_member" });
  await putInLineage(db, lin, [await addPol(db, m1, { title: "1" }), await addPol(db, m2, { title: "2" })]);
  await seed(db);
  const tid = `auto:lineage_roles_missing:${lin}`;
  assertEquals(await dispatchIds(db, ["lineage_roles_missing"]), [tid]);
  const part = (pid: string, role: string, patch: Record<string, unknown> = {}) => ({ politician_id: pid, role, basis: "official_record", source_locator: "議案第 12 号 提出者欄", ...patch });
  const run = async (participants: unknown[], o: { urls?: string[]; task?: string } = {}) => applyOne(db, await verified(db, "lineage_participants", { lineage_id: lin, participants }, o));
  let out = await run([part(m1.pid, "proposer"), part(m2.pid, "cosigner", { note: "賛成者として連署" })], { task: tid });
  assertEquals([out.status, out.outcome, out.table_name], ["applied", "applied", "lineage_participants"], JSON.stringify(out));
  const got = await rows<{ politician_id: string; role: string; basis: string; review_status: string }>(db,
    `SELECT politician_id, role, basis, review_status FROM policy_jp.lineage_participants WHERE lineage_id = $1 ORDER BY role`, [lin]);
  assertEquals(got.map((g) => [g.politician_id, g.role, g.basis, g.review_status]), [[m2.pid, "cosigner", "official_record", "published"], [m1.pid, "proposer", "official_record", "published"]]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'lineage_participants'`), 2);
  assert(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'lineage_participants'`) >= 2);
  await seed(db);
  assertEquals(await dispatchIds(db, ["lineage_roles_missing"]), [], "全員に記録ができて收回");
  // 同じ内容 → unchanged
  out = await run([part(m1.pid, "proposer")]);
  assertEquals([out.status, out.outcome], ["applied", "unchanged"], JSON.stringify(out));
  // 役割を上書き
  out = await run([part(m1.pid, "co_proposer")]);
  assertEquals(out.outcome, "applied");
  assertEquals((await one<{ role: string }>(db, `SELECT role FROM policy_jp.lineage_participants WHERE lineage_id = $1 AND politician_id = $2 AND basis = 'official_record'`, [lin, m1.pid])).role, "co_proposer");
  // self_claim は別の行（同じ人の同じ根拠でなければ併存）
  out = await run([part(m1.pid, "advocate", { basis: "self_claim" })], { urls: [NEWS] });
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.lineage_participants WHERE lineage_id = '${lin}' AND politician_id = '${m1.pid}'`), 2);
  // remove
  out = await run([{ politician_id: m1.pid, basis: "self_claim", source_locator: "取り消し", remove: true }]);
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.lineage_participants WHERE lineage_id = '${lin}' AND politician_id = '${m1.pid}' AND basis = 'self_claim'`), 0);
  // invalid：どれも書かない（先頭の 1 件は正しいが、2 件目が不正）
  const before = await count(db, `SELECT 1 FROM policy_jp.edit_history`);
  const snapshot = await rows(db, `SELECT politician_id, role, basis FROM policy_jp.lineage_participants ORDER BY id`);
  const bad: Array<[string, unknown[], string[], string]> = [
    ["official_record に報道だけ", [part(m2.pid, "proposer")], [NEWS], "official 等級"],
    ["存在しない人", [part(m2.pid, "advocate"), part("no-such", "advocate")], [KOUHOU], "登録されていない"],
    ["役割が不正", [part(m2.pid, "advocate"), part(m1.pid, "leader")], [KOUHOU], "role は"],
    ["根拠が不正", [part(m2.pid, "advocate"), part(m1.pid, "advocate", { basis: "rumor" })], [KOUHOU], "basis は"],
    ["同じ人の同じ根拠が 2 回", [part(m2.pid, "advocate"), part(m2.pid, "proposer")], [KOUHOU], "1 回だけ"],
    ["source_locator なし", [part(m2.pid, "advocate"), part(m1.pid, "advocate", { source_locator: "" })], [KOUHOU], "source_locator"],
    ["件数 0", [], [KOUHOU], "1～50"],
  ];
  for (const [why, ps, urls, msg] of bad) {
    const r = await run(ps, { urls });
    assertEquals([r.status, r.outcome], ["rejected", "invalid"], `${why}：${JSON.stringify(r)}`);
    assert(String(r.message).includes(msg), `${why}：${r.message}`);
  }
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history`), before, "invalid は何も書かない");
  assertEquals(await rows(db, `SELECT politician_id, role, basis FROM policy_jp.lineage_participants ORDER BY id`), snapshot);
  await db.close();
});

Deno.test("落庫 lineage_handover：applied（from／to_policy_ids を自動で埋める）／unchanged／上書き・stop は official 等級の出典・不正な組・task の收回", async () => {
  const db = await freshDb();
  await stage(db);
  const [p1, p2, a, b] = await twoTerms(db);
  const lin = await addLineage(db);
  await putInLineage(db, lin, [p1, p2]);
  await seed(db);
  const tid = (await hoRows(db))[0].task_id;
  assertEquals(await dispatchIds(db, ["handover_missing"]), [tid]);
  const ho = (patch: Record<string, unknown> = {}) => ({ lineage_id: lin, from_office_id: a.oid, to_office_id: b.oid, handover_type: "keep", note: "後任の令和 6 年度予算書に同じ事業の工事費が計上されている", source_locator: "予算書 12 頁", ...patch });
  const run = async (payload: Record<string, unknown>, o: { urls?: string[]; task?: string } = {}) => applyOne(db, await verified(db, "lineage_handover", payload, o));
  let out = await run(ho({ decided_on: "2023-06-20" }), { task: tid });
  assertEquals([out.status, out.outcome, out.table_name], ["applied", "applied", "handovers"], JSON.stringify(out));
  const h = await one<{ from_policy_ids: string[]; to_policy_ids: string[]; handover_type: string; decided_on: string; review_status: string }>(db,
    `SELECT from_policy_ids, to_policy_ids, handover_type, to_char(decided_on, 'YYYY-MM-DD') AS decided_on, review_status FROM policy_jp.handovers WHERE id = $1`, [out.record_id]);
  assertEquals(h, { from_policy_ids: [p1], to_policy_ids: [p2], handover_type: "keep", decided_on: "2023-06-20", review_status: "published" });
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'handovers' AND target_id = '${out.record_id}'`), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'handovers' AND contribution_id IS NOT NULL`), 1);
  await seed(db);
  assertEquals(await dispatchIds(db, ["handover_missing"]), [], "交接ができて收回");
  // 同じ内容 → unchanged
  out = await run(ho({ decided_on: "2023-06-20" }));
  assertEquals([out.status, out.outcome], ["applied", "unchanged"], JSON.stringify(out));
  // 上書き（shrink）
  out = await run(ho({ handover_type: "shrink", note: "後任の令和 6 年度予算書では事業費が半分に縮められている" }));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.handovers WHERE lineage_id = '${lin}'`), 1, "同じ一対は 1 件");
  assertEquals((await one<{ t: string }>(db, `SELECT handover_type AS t FROM policy_jp.handovers WHERE lineage_id = $1`, [lin])).t, "shrink");
  // stop：報道だけでは invalid、官の出典があれば applied
  const stop = ho({ handover_type: "stop", note: "後任が令和 5 年 6 月議会で庁舎の建設の中止を表明し議事録に残っている" });
  out = await run(stop, { urls: [NEWS] });
  assertEquals([out.status, out.outcome], ["rejected", "invalid"], JSON.stringify(out));
  assert(String(out.message).includes("公的な出典"));
  out = await run(stop, { urls: [NEWS, KOUHOU] });
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  // 不正：書かない
  const before = await count(db, `SELECT 1 FROM policy_jp.edit_history`);
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ["前後が逆", ho({ from_office_id: b.oid, to_office_id: a.oid }), "前の任期から後の任期"],
    ["同じ任期", ho({ to_office_id: a.oid }), "前の任期から後の任期"],
    ["存在しない任期", ho({ to_office_id: "no-such" }), "登録されていない"],
    ["存在しない脈絡", ho({ lineage_id: "no-such" }), "登録されていない"],
    ["型が不正", ho({ handover_type: "continue" }), "handover_type は"],
    ["note が短い", ho({ note: "短い" }), "note は 20～500"],
    ["source_locator なし", ho({ source_locator: "" }), "source_locator"],
    ["decided_on の形", ho({ decided_on: "2023/06/20" }), "decided_on は"],
    ["decided_on が未来", ho({ decided_on: "2030-01-01" }), "超えない"],
    ["decided_on が実在しない日", ho({ decided_on: "2023-02-30" }), "実在しない"],
  ];
  for (const [why, payload, msg] of bad) {
    const r = await run(payload);
    assertEquals([r.status, r.outcome], ["rejected", "invalid"], `${why}：${JSON.stringify(r)}`);
    assert(String(r.message).includes(msg), `${why}：${r.message}`);
  }
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history`), before, "invalid は何も書かない");
  // 職位が違う任期の組は交接にならない
  const m = await addPerson(db, { election: E_ASM, position: "muni_assembly_member" });
  out = await run(ho({ to_office_id: m.oid }));
  assertEquals(out.outcome, "invalid");
  await db.close();
});

Deno.test("落庫 lineage_link：applied／unchanged／上書き・層が合わなければ invalid・同じ脈絡は invalid・candidate の task_checks confirmed", async () => {
  const db = await freshDb();
  await stage(db);
  const lower = await addLineage(db, { title: "一宮市の庁舎整備" });
  const natl = await addLineage(db, { title: "国の補助", level: "national" });
  const pref = await addLineage(db, { title: "県の施設整備", level: "regional" });
  const other = await addLineage(db, { title: "同じ層の別の件" });
  await seed(db);
  const t0 = (await linkRows(db)).find((x) => x.target.lineage_id === lower)!;
  assert((await dispatchIds(db, ["lineage_link_candidate"])).includes(t0.task_id));
  const lk = (up: string, patch: Record<string, unknown> = {}) => ({ upper_lineage_id: up, lower_lineage_id: lower, link_type: "top_down", note: "国の交付金の決定通知に、一宮市の庁舎整備計画が事業として挙げられている", source_locator: "通知 令和 5 年 3 号", ...patch });
  const run = async (payload: Record<string, unknown>, o: { task?: string } = {}) => applyOne(db, await verified(db, "lineage_link", payload, o));
  let out = await run(lk(natl), { task: t0.task_id });
  assertEquals([out.status, out.outcome, out.table_name], ["applied", "applied", "lineage_links"], JSON.stringify(out));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.lineage_links WHERE upper_lineage_id = '${natl}' AND lower_lineage_id = '${lower}' AND review_status = 'published'`), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'lineage_links' AND target_id = '${out.record_id}'`), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.task_checks WHERE task_id = '${t0.task_id}' AND outcome = 'confirmed'`), 1, "候補を見た記録");
  await seed(db);
  assert(!(await dispatchIds(db, ["lineage_link_candidate"])).includes(t0.task_id), "旧指紋の派工は收回されている");
  // 同じ内容 → unchanged、内容が違えば上書き
  out = await run(lk(natl));
  assertEquals([out.status, out.outcome], ["applied", "unchanged"], JSON.stringify(out));
  out = await run(lk(natl, { link_type: "bottom_up" }));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  assertEquals((await one<{ t: string }>(db, `SELECT link_type AS t FROM policy_jp.lineage_links WHERE upper_lineage_id = $1 AND lower_lineage_id = $2`, [natl, lower])).t, "bottom_up");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.lineage_links WHERE upper_lineage_id = '${natl}' AND lower_lineage_id = '${lower}'`), 1);
  // 県も結べる（県→市）
  out = await run(lk(pref));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  // 不正：同じ層・同じ脈絡・逆向き・型・note・locator・存在しない
  const before = await count(db, `SELECT 1 FROM policy_jp.edit_history`);
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ["同じ層", lk(other), "一つ上の層"],
    ["逆向き", { ...lk(natl), upper_lineage_id: lower, lower_lineage_id: natl }, "一つ上の層"],
    ["同じ脈絡", lk(lower), "別々"],
    ["link_type が不正", lk(natl, { link_type: "sideways" }), "link_type は"],
    ["note が短い", lk(natl, { note: "短い" }), "note は 20～500"],
    ["source_locator なし", lk(natl, { source_locator: "" }), "source_locator"],
    ["存在しない上級", lk("no-such"), "登録されていない"],
  ];
  for (const [why, payload, msg] of bad) {
    const r = await run(payload);
    assertEquals([r.status, r.outcome], ["rejected", "invalid"], `${why}：${JSON.stringify(r)}`);
    assert(String(r.message).includes(msg), `${why}：${r.message}`);
  }
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history`), before, "invalid は何も書かない");
  // 別の都道府県の県の脈絡は結べない
  const tokyo = await addLineage(db, { title: "東京都の施設", level: "regional", lg: TOKYO });
  assertEquals((await run(lk(tokyo))).outcome, "invalid");
  await db.close();
});

// =============================================================================================
// h. TS
// =============================================================================================
const LID = "5f0c8d6e-1111-4222-8333-444444444444";
const LID2 = "5f0c8d6e-2222-4222-8333-444444444444";
const req = (type: string, payload: Record<string, unknown>, taskId?: string, urls = [KOUHOU]) => validateContributionRequest({
  agent_name: "jp-agent", agent_tool: "claude-code/claude-sonnet-5", contribution_type: type, payload, source_urls: urls, ...(taskId ? { task_id: taskId } : {}),
});
const paths = (r: ReturnType<typeof req>) => r.errors.map((e) => e.path);
const goodLineage = { new_lineage: { title: "新庁舎の建設", category: "公共施設", level: "local", lg_code: "232033" }, policy_ids: ["p1", "p2"], note: NOTE };
const goodPart = { lineage_id: LID, participants: [{ politician_id: "pp1", role: "proposer", basis: "official_record", source_locator: "議案第 12 号" }] };
const goodHo = { lineage_id: LID, from_office_id: "o1", to_office_id: "o2", handover_type: "keep", note: "後任の令和 6 年度予算書に同じ事業の工事費が計上されている", source_locator: "予算書 12 頁" };
const goodLink = { upper_lineage_id: LID, lower_lineage_id: LID2, link_type: "top_down", note: "国の交付金の決定通知に、一宮市の庁舎整備計画が事業として挙げられている", source_locator: "通知 3 号" };

Deno.test("TS：JP_TASK_ARMS の登録・4 型別の最小の交件が通る・同一件事の resolved_claim は要らない（第三の道）", () => {
  assertEquals(JP_TASK_ARMS.lineage_candidate, "lineage");
  assertEquals(JP_TASK_ARMS.handover_missing, "lineage_handover");
  assertEquals(JP_TASK_ARMS.lineage_roles_missing, "lineage_participants");
  assertEquals(JP_TASK_ARMS.lineage_link_candidate, "lineage_link");
  assert(req("lineage", goodLineage).ok, JSON.stringify(req("lineage", goodLineage).errors));
  assert(req("lineage", { lineage_id: LID, policy_ids: ["p1"], note: NOTE }).ok);
  assert(req("lineage", { lineage_id: LID, detach_policy_ids: ["p1"], note: NOTE }).ok);
  assert(req("lineage", { lineage_id: LID, title: "新庁舎の建設と開庁", note: NOTE }).ok);
  assert(req("lineage_participants", goodPart).ok, JSON.stringify(req("lineage_participants", goodPart).errors));
  assert(req("lineage_handover", goodHo).ok, JSON.stringify(req("lineage_handover", goodHo).errors));
  assert(req("lineage_link", goodLink).ok, JSON.stringify(req("lineage_link", goodLink).errors));
  for (const t of ["lineage", "lineage_participants", "lineage_handover", "lineage_link"]) {
    assert(!isSameClaimType("jp", t), `${t} は登記表の型別ではない`);
    assert(!(DUPLICATE_ELIGIBLE_TYPES as readonly string[]).includes(t), `${t} は claimKey 併票の型別ではない`);
    assert(APPLY_IDEMPOTENT_TYPES.includes(t), `${t} は冪等の型別`);
    assertEquals(claimKey(t as never, {} as never), null, `${t} の併票の鍵はない`);
    assert(JP_APPLY_TYPES.includes(t as never), `${t} は落庫の型別`);
  }
});

Deno.test("TS：lineage の項目検査（lineage_id と new_lineage の二択・level／lg_code・件数・note・訂正だけ）", () => {
  const nl = (patch: Record<string, unknown>) => ({ ...goodLineage, new_lineage: { ...goodLineage.new_lineage, ...patch } });
  assert(paths(req("lineage", { policy_ids: ["p1"], note: NOTE })).includes("payload.lineage_id"), "両方ない");
  assert(paths(req("lineage", { ...goodLineage, lineage_id: LID })).includes("payload.lineage_id"), "両方ある");
  assert(paths(req("lineage", { ...goodLineage, note: "短い" })).includes("payload.note"));
  assert(paths(req("lineage", nl({ title: "短" }))).includes("payload.new_lineage.title"));
  assert(paths(req("lineage", nl({ category: "" }))).includes("payload.new_lineage.category"));
  assert(paths(req("lineage", nl({ level: "county" }))).includes("payload.new_lineage.level"));
  assert(paths(req("lineage", nl({ lg_code: undefined }))).includes("payload.new_lineage.lg_code"), "local に lg_code なし");
  assert(paths(req("lineage", nl({ lg_code: "232034" }))).includes("payload.new_lineage.lg_code"), "検査碼が違う");
  assert(paths(req("lineage", nl({ level: "national" }))).includes("payload.new_lineage.lg_code"), "national に lg_code");
  assert(req("lineage", { new_lineage: { title: "国の補助制度", category: "公共施設", level: "national" }, policy_ids: ["p1"], note: NOTE }).ok, "national は政策 1 件でよい");
  assert(paths(req("lineage", { ...goodLineage, policy_ids: ["p1"] })).includes("payload.policy_ids"), "local は 2 件以上");
  assert(paths(req("lineage", { ...goodLineage, detach_policy_ids: ["p3"] })).includes("payload.detach_policy_ids"));
  assert(paths(req("lineage", { lineage_id: LID, policy_ids: ["p1"], detach_policy_ids: ["p1"], note: NOTE })).includes("payload.detach_policy_ids"));
  assert(paths(req("lineage", { lineage_id: LID, note: NOTE })).includes("payload.policy_ids"), "空の訂正");
  assert(paths(req("lineage", { lineage_id: LID, policy_ids: Array.from({ length: 31 }, (_, i) => `p${i}`), note: NOTE })).includes("payload.policy_ids"), "30 件まで");
  assert(paths(req("lineage", { lineage_id: LID, policy_ids: "p1", note: NOTE })).includes("payload.policy_ids"));
  assert(paths(req("lineage", { lineage_id: LID, title: "短", note: NOTE })).includes("payload.title"));
});

Deno.test("TS：lineage_participants／lineage_handover／lineage_link の項目検査・stop と official_record の出典", () => {
  // participants
  assert(paths(req("lineage_participants", { lineage_id: LID, participants: [] })).includes("payload.participants"));
  const one1 = (patch: Record<string, unknown>) => ({ lineage_id: LID, participants: [{ ...goodPart.participants[0], ...patch }] });
  assert(paths(req("lineage_participants", one1({ role: "leader" }))).includes("payload.participants[0].role"));
  assert(paths(req("lineage_participants", one1({ basis: "rumor" }))).includes("payload.participants[0].basis"));
  assert(paths(req("lineage_participants", one1({ source_locator: "" }))).includes("payload.participants[0].source_locator"));
  assert(paths(req("lineage_participants", one1({ politician_id: "" }))).includes("payload.participants[0].politician_id"));
  assert(req("lineage_participants", one1({ remove: true, role: undefined })).ok, "remove は role 不要");
  assert(paths(req("lineage_participants", { lineage_id: LID, participants: [goodPart.participants[0], { ...goodPart.participants[0], role: "cosigner" }] })).includes("payload.participants[1]"), "同じ人の同じ根拠が 2 回");
  assert(req("lineage_participants", { lineage_id: LID, participants: [goodPart.participants[0], { ...goodPart.participants[0], basis: "self_claim" }] }, undefined, [KOUHOU, NEWS]).ok, "根拠が違えば併存できる");
  assert(paths(req("lineage_participants", goodPart, undefined, [NEWS])).includes("payload.participants[0].source_url"), "official_record に報道だけ");
  assert(req("lineage_participants", one1({ basis: "self_claim" }), undefined, [NEWS]).ok, "self_claim は報道でもよい");
  assert(req("lineage_participants", one1({ source_url: KOUHOU }), undefined, [NEWS]).ok, "その人の source_url が official ならよい");
  // handover
  assert(paths(req("lineage_handover", { ...goodHo, handover_type: "continue" })).includes("payload.handover_type"));
  assert(paths(req("lineage_handover", { ...goodHo, to_office_id: "o1" })).includes("payload.to_office_id"));
  assert(paths(req("lineage_handover", { ...goodHo, note: "短い" })).includes("payload.note"));
  assert(paths(req("lineage_handover", { ...goodHo, source_locator: "" })).includes("payload.source_locator"));
  assert(paths(req("lineage_handover", { ...goodHo, decided_on: "2023-02-30" })).includes("payload.decided_on"));
  assert(paths(req("lineage_handover", { ...goodHo, from_office_id: undefined })).includes("payload.from_office_id"));
  const stop = { ...goodHo, handover_type: "stop" };
  assert(req("lineage_handover", stop, undefined, [KOUHOU]).ok);
  assert(paths(req("lineage_handover", stop, undefined, [NEWS])).includes("source_urls"), "stop に報道だけ");
  assert(req("lineage_handover", { ...goodHo, handover_type: "pivot" }, undefined, [NEWS]).ok, "stop 以外は報道でもよい");
  // link
  assert(paths(req("lineage_link", { ...goodLink, link_type: "sideways" })).includes("payload.link_type"));
  assert(paths(req("lineage_link", { ...goodLink, lower_lineage_id: LID })).includes("payload.lower_lineage_id"));
  assert(paths(req("lineage_link", { ...goodLink, note: "短い" })).includes("payload.note"));
  assert(paths(req("lineage_link", { ...goodLink, source_locator: "" })).includes("payload.source_locator"));
});

Deno.test("TS：任務比對（task_id の脈絡 id と payload が一致・別の型別で答えると 400・no_change は常に可）", () => {
  const fp = "0123abcd";
  // lineage_candidate
  assert(req("lineage", goodLineage, `auto:lineage_candidate:0123456789ab:${fp}`).ok);
  assert(paths(req("lineage", goodLineage, "auto:lineage_candidate:zz")).includes("task_id"), "形が違う");
  const wrong = req("lineage_link", goodLink, `auto:lineage_candidate:0123456789ab:${fp}`);
  assert(wrong.errors.some((e) => e.path === "task_id" && e.message.includes("contribution_type=lineage")), JSON.stringify(wrong.errors));
  // handover_missing
  assert(req("lineage_handover", goodHo, `auto:handover_missing:${LID}:${fp}`).ok);
  assertEquals(paths(req("lineage_handover", { ...goodHo, lineage_id: LID2 }, `auto:handover_missing:${LID}:${fp}`)), ["payload.lineage_id"]);
  assert(paths(req("lineage_handover", goodHo, `auto:handover_missing:${LID}`)).includes("task_id"), "指紋がない");
  // lineage_roles_missing
  assert(req("lineage_participants", goodPart, `auto:lineage_roles_missing:${LID}`).ok);
  assertEquals(paths(req("lineage_participants", { ...goodPart, lineage_id: LID2 }, `auto:lineage_roles_missing:${LID}`)), ["payload.lineage_id"]);
  // lineage_link_candidate：下級の脈絡
  assert(req("lineage_link", goodLink, `auto:lineage_link_candidate:${LID2}:${fp}`).ok);
  assertEquals(paths(req("lineage_link", goodLink, `auto:lineage_link_candidate:${LID}:${fp}`)), ["payload.lower_lineage_id"]);
  // 別の任務の型別で答える
  assert(paths(req("policy_progress", { policy_id: LID, status: "in_progress", date: "2026-06-01", note: "令和 8 年度当初予算に事業費が計上された" }, `auto:handover_missing:${LID}:${fp}`)).includes("task_id"));
  // no_change は任務の型に縛られない
  const nc = req("no_change", { task_id: `auto:handover_missing:${LID}:${fp}`, outcome: "not_found", checked_urls: [KOUHOU], finding: "予算書も会議録も探したが交接の記録は見つからなかった" }, `auto:handover_missing:${LID}:${fp}`);
  assert(nc.ok, JSON.stringify(nc.errors));
  const nc2 = req("no_change", { task_id: `auto:lineage_candidate:0123456789ab:${fp}`, outcome: "confirmed", checked_urls: [KOUHOU], finding: "格の政策を全部読んだが同じ件はなかった" }, `auto:lineage_candidate:0123456789ab:${fp}`);
  assert(nc2.ok, JSON.stringify(nc2.errors));
});

Deno.test("協議版號：JP_PROTOCOL_VERSION は 0.21.0 以上（この支で 0.20.0 → 0.21.0）", () => {
  const n = (v: string) => v.split(".").map(Number).reduce((a, x) => a * 1000 + x, 0);
  assert(n(JP_PROTOCOL_VERSION) >= n("0.21.0"), JP_PROTOCOL_VERSION);
});

// =============================================================================================
// i. 還原驗證・冪等・前の版に足しただけ・権限
// =============================================================================================
Deno.test("自我檢查（還原驗證）：規則・総表の分支・臂名・順位・主控台の段・CHECK・apply_types・WHEN・共識の stop・anon が欠ける／違うと、migration が失敗する", async () => {
  const pre = await migratedDb({ before: MIG_FILE });
  const bad = async (from: string, to: string, why: string) => {
    await assertRejects(() => pre.exec(mutate(MIG_SQL, from, to)), Error, undefined, why);
  };
  await bad(`SELECT 'lineage_candidates', 'always', 'announced',`, `SELECT 'lineage_candidates', 'month', 'announced',`, "lineage_candidates が常時窓でない");
  await bad(`SELECT 'handover_missing', 'always', 'announced',\n       '{"cap":100}'::JSONB,`, `SELECT 'handover_missing', 'always', 'announced',\n       '{}'::JSONB,`, "handover_missing に cap がない");
  await bad(`  UNION ALL SELECT 'lineage_roles' AS arm, t.* FROM policy_jp.contribution_auto_tasks_lineage_roles() t\n`, "", "総表に lineage_roles が無い");
  await bad(`    'deadline_due',\n    'lineage_candidates'`, `    'deadline_due',\n    'lineage_candidates_x'`, "臂名が違う");
  await bad(`  ('handover_missing', 7, '`, `  ('handover_missing', 5, '`, "主控台の段が違う");
  await bad(`'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link'));`, `'lineage', 'lineage_participants', 'lineage_link'));`, "CHECK に lineage_handover がない");
  await bad(`'policy_progress', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'no_change']`, `'policy_progress', 'lineage', 'lineage_participants', 'lineage_handover', 'no_change']`, "apply_types に lineage_link がない");
  await bad(`               WHEN 'lineage_link' THEN policy_jp.apply_lineage_link(c)\n`, "", "apply_contribution に WHEN がない");
  await bad(`      OR (p_type = 'lineage_handover' AND COALESCE(p_payload->>'handover_type', '') = 'stop')\n`, "", "stop の一句がない");
  await bad(`                  WHEN 'lineage_roles_missing' THEN 9`, `                  WHEN 'lineage_roles_missing' THEN 8`, "順位が違う");
  await bad(`  TO service_role;\n\n-- ------------------------------------------------------------\n-- 14.`, `  TO service_role, anon;\n\n-- ------------------------------------------------------------\n-- 14.`, "anon に渡す");
  await pre.exec(MIG_SQL);
  await pre.close();
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則・主控台登記が増えない（規則は開いたまま）", async () => {
  const db = await freshDb();
  const n = () => Promise.all([count(db, `SELECT 1 FROM policy_jp.activity_rules`), count(db, `SELECT 1 FROM policy_jp.console_arm_stage_map`)]);
  const before = await n();
  await db.exec(MIG_SQL);
  assertEquals(await n(), before);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.activity_rules WHERE activity IN ('lineage_candidates', 'handover_missing', 'lineage_roles', 'lineage_links') AND priority IS NULL AND enabled`), 4);
  await db.close();
});

Deno.test("緊接在前一版：総表・臂名・順位・apply_contribution は前の版に『足しただけ』（残りは一字も変えない）", () => {
  const strip = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  const ARMS = ["lineage_candidates", "handover_missing", "lineage_roles", "lineage_links"];
  let total = strip(fnText(MIG_SQL, TOTAL));
  for (const a of ARMS) total = total.replace(` UNION ALL SELECT '${a}' AS arm, t.* FROM policy_jp.contribution_auto_tasks_${a}() t`, "");
  assertEquals(total, strip(fnText(PREV, TOTAL)));
  let rank = strip(fnText(MIG_SQL, "policy_jp.chain_step_rank"));
  for (const t of TYPES) rank = rank.replace(` WHEN '${t}' THEN 9`, "");
  assertEquals(rank.replace(/COMMENT.*$/, ""), strip(fnText(PREV, "policy_jp.chain_step_rank")).replace(/COMMENT.*$/, ""));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.activity_arm_names")).replace(", 'lineage_candidates', 'handover_missing', 'lineage_roles', 'lineage_links'", ""), strip(fnText(PREV, "policy_jp.activity_arm_names")));
  let apply = strip(fnText(MIG_SQL, "policy_jp.apply_contribution"));
  for (const t of ["lineage", "lineage_participants", "lineage_handover", "lineage_link"]) apply = apply.replace(` WHEN '${t}' THEN policy_jp.apply_${t}(c)`, "");
  assertEquals(apply, strip(fnText(PREV, "policy_jp.apply_contribution")));
});

Deno.test("権限：新しい関数は anon／authenticated が呼べない（service_role は呼べる）", async () => {
  const fns = [
    "contribution_auto_tasks_lineage_candidates()", "contribution_auto_tasks_handover_missing()", "contribution_auto_tasks_lineage_roles()", "contribution_auto_tasks_lineage_links()",
    "lineage_candidate_scope()",
  ];
  for (const role of ["anon", "authenticated"]) {
    for (const f of fns) await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.${f}`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.lineage_level_of('232033')`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.lineage_block_key('local', '232033', 'x')`), Error, "permission denied");
  }
  for (const f of fns) assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.${f}`))[0].n, 0);
  assertEquals((await asRole<{ l: string }>(shared, "service_role", `SELECT policy_jp.lineage_level_of(NULL) AS l`))[0].l, "national");
});

Deno.test("lineage_level_of／lineage_link_level_ok：国・都道府県・市区町村の判定（同じ都道府県の中だけ結べる）", async () => {
  const db = await freshDb();
  await insertLg(db, ICHI);
  await insertLg(db, TOKYO);
  const lvl = async (c: string | null) => (await one<{ l: string }>(db, `SELECT policy_jp.lineage_level_of($1) AS l`, [c])).l;
  assertEquals([await lvl(null), await lvl(AICHI), await lvl(ICHI)], ["national", "regional", "local"]);
  const ok = async (ul: string, ug: string | null, ll: string, lg: string | null) =>
    (await one<{ x: boolean }>(db, `SELECT policy_jp.lineage_link_level_ok($1, $2, $3, $4) AS x`, [ul, ug, ll, lg])).x;
  assertEquals(await ok("national", null, "regional", AICHI), true);
  assertEquals(await ok("national", null, "local", ICHI), true);
  assertEquals(await ok("regional", AICHI, "local", ICHI), true);
  assertEquals(await ok("regional", TOKYO, "local", ICHI), false, "別の都道府県");
  assertEquals(await ok("local", ICHI, "regional", AICHI), false, "逆向き");
  assertEquals(await ok("local", ICHI, "local", ICHI), false, "同じ層");
  assertEquals(await ok("national", null, "national", null), false);
  await db.close();
});

// =============================================================================================
// j. レビュー指摘の修正（official_record の出典・日本時間の今日・new_lineage の型・participants 欠落・office_ids・同名の同時作成）
// =============================================================================================
Deno.test("落庫 lineage_participants：source_urls が [報道, *.lg.jp] で official_record → official の方を使って applied（item に source_url がなくても）；全部報道なら invalid", async () => {
  const db = await freshDb();
  await stage(db);
  const lin = await addLineage(db);
  const m1 = await addPerson(db, { election: E_ASM, position: "muni_assembly_member" });
  await putInLineage(db, lin, [await addPol(db, m1)]);
  const part = { politician_id: m1.pid, role: "proposer", basis: "official_record", source_locator: "議案第 12 号" };
  const out = await applyOne(db, await verified(db, "lineage_participants", { lineage_id: lin, participants: [part] }, { urls: [NEWS, KOUHOU] }));
  assertEquals([out.status, out.outcome], ["applied", "applied"], JSON.stringify(out));
  assertEquals((await one<{ u: string }>(db, `SELECT s.url AS u FROM policy_jp.source_refs sr JOIN policy_jp.sources s ON s.id = sr.source_id WHERE sr.target_table = 'lineage_participants' LIMIT 1`)).u, KOUHOU);
  const bad = await applyOne(db, await verified(db, "lineage_participants", { lineage_id: lin, participants: [{ ...part, role: "cosigner" }] }, { urls: [NEWS, "https://news.example.com/2"] }));
  assertEquals(bad.outcome, "invalid");
  // self_claim は従来どおり最初の URL
  const sc = await applyOne(db, await verified(db, "lineage_participants", { lineage_id: lin, participants: [{ ...part, basis: "self_claim" }] }, { urls: [NEWS, KOUHOU] }));
  assertEquals(sc.outcome, "applied");
  await db.close();
});

Deno.test("落庫 lineage_participants：participants キーがない／配列でない → invalid（unchanged にならない）", async () => {
  const db = await freshDb();
  await stage(db);
  const lin = await addLineage(db);
  for (const payload of [{ lineage_id: lin }, { lineage_id: lin, participants: "x" }, { lineage_id: lin, participants: null }]) {
    const r = await applyOne(db, await verified(db, "lineage_participants", payload));
    assertEquals([r.status, r.outcome], ["rejected", "invalid"], JSON.stringify(r));
  }
  await db.close();
});

Deno.test("office_ids の先頭でなくても任期を引く：公約以外の政策（office_ids=[別の任期, 自分の任期]）が候補の term_key・交接・役割の臂で見える", async () => {
  const db = await freshDb();
  await stage(db);
  const a = await prevMayor(db);
  const b = await addPerson(db);
  const other = await addPerson(db, { election: E_ASM, position: "muni_assembly_member" });
  // 先頭は議員の任期（非公開）、2 番目が自分の任期
  await db.query(`UPDATE policy_jp.politician_offices SET review_status = 'pending' WHERE id = $1`, [other.oid]);
  const mk = async (p: Person, title: string) => {
    const id = crypto.randomUUID();
    await db.query(`INSERT INTO policy_jp.policies (id, title, description, category, origin, source_locator, lg_code, office_ids, status, last_updated, review_status)
                    VALUES ($1, $2, '説明', '公共施設', 'policy_address', '施政方針', $3, $4, 'not_started', $5, 'published')`, [id, title, ICHI, [other.oid, p.oid], addDays(TODAY, -5)]);
    return id;
  };
  const p1 = await mk(a, "前任の施政方針"), p2 = await mk(b, "後任の施政方針");
  assertEquals((await candRows(db)).length, 1, "2 つの任期にまたがる格として見える");
  const lin = await addLineage(db);
  await putInLineage(db, lin, [p1, p2]);
  assertEquals((await hoRows(db)).length, 1, "交接の臂も office_ids のどこにあっても前任の任期を見つける");
  await db.close();
});

Deno.test("apply_lineage：新規作成の前に層・団体・題名で advisory lock を取る（同時の同名作成を直列化）", () => {
  const fn = fnText(MIG_SQL, "policy_jp.apply_lineage");
  const lock = fn.indexOf("pg_advisory_xact_lock(hashtext(");
  const check = fn.indexOf("policy_title_key(x.title)");
  assert(lock > 0 && check > lock, "lock は同名検査より前");
  assert(fn.slice(lock, check).includes("policy_title_key(v_title)") && fn.slice(lock, check).includes("v_level") && fn.slice(lock, check).includes("v_lg"));
});

Deno.test("TS：日本時間（Asia/Tokyo）の今日で decided_on／policy_progress の date を切る（UTC との境目）", () => {
  try {
    // UTC 2027-01-10 15:30 ＝ 東京 2027-01-11 00:30
    jpSetNowForTest(() => new Date("2027-01-10T15:30:00Z"));
    assertEquals(jpTodayTokyo(), "2027-01-11");
    const prog = (date: string) => req("policy_progress", { policy_id: LID, status: "in_progress", date, note: "令和 8 年度当初予算に事業費が計上され、設計が始まった" });
    const ho = (d: string) => req("lineage_handover", { ...goodHo, decided_on: d });
    assert(prog("2027-01-11").ok, "東京の今日は通る（UTC の今日より先でも）");
    assert(paths(prog("2027-01-12")).includes("payload.date"));
    assert(ho("2027-01-11").ok);
    assert(paths(ho("2027-01-12")).includes("payload.decided_on"));
    // UTC 2027-01-10 14:59 ＝ 東京 2027-01-10：以前の『UTC＋1 日』なら 01-11 が通ってしまう
    jpSetNowForTest(() => new Date("2027-01-10T14:59:59Z"));
    assertEquals(jpTodayTokyo(), "2027-01-10");
    assert(prog("2027-01-10").ok);
    assert(paths(prog("2027-01-11")).includes("payload.date"), "東京ではまだ未来");
    assert(ho("2027-01-10").ok);
    assert(paths(ho("2027-01-11")).includes("payload.decided_on"));
  } finally {
    jpSetNowForTest(null);
  }
});

Deno.test("TS：new_lineage が文字列・配列・null ならエラー（lineage_id も無ければ二択のエラーも）", () => {
  for (const v of ["x", ["a"], null, 5]) {
    const r = req("lineage", { new_lineage: v, policy_ids: ["p1", "p2"], note: NOTE });
    assert(paths(r).includes("payload.new_lineage"), JSON.stringify(v));
    assert(!r.ok);
  }
});
