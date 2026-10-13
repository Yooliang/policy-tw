/**
 * 日本站派工臂對齊正見：現職首長の公約 mayor_policies／term_policies（migration 20261011190000_policy_jp_term_policies.sql、工作単 Yooliang/policy-ops#95、C 期第 4 步）
 *   臂 mayor_policies（task_type policy_missing、task_id は policy_missing 臂と同じ）＋臂 term_policies（task_type term_policy_missing）。
 *   新しい交件型別はなく、どちらも既存の policy で答える（apply_policy は動かさない）。規則は enabled。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts），時鐘用 `SET app.activity_today`。
 *
 *   a. 結構：臂名・総表・規則（enabled・常時窓・after_step＋後備・cap）・優先層・步驟順位・主控台の段・権限
 *   b. term_policies：対象（任期の元になった当選の参選で公約 0 件）・target・文言・派工列（後段・鎖の gate）・除外（lookback・町村・職位・非公開・投票直後・開いている選挙なし）
 *   c. mayor_policies：対象（declared／filed で公約 1 件以上 5 件未満）・policy_missing 臂との引き継ぎ（同じ task_id）・審議中の分・cap
 *   d. 抑制と收回：not_found の冷却／no_change の等票中／policy の落庫（過去の選挙の参選にも掛かる）で任務が收回される
 *   e. TS：JP_TASK_ARMS・任務比對・同一件事の探査・協議版號
 *   f. 還原驗證・冪等・前の版に足しただけ
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, applyOne, asRole, check, clock, count, dispatches, dispatchIds, events, expireCooling, freshDb, ICHI, insertElection, insertLg, migratedDb, mutate, one,
  openElectionWithRegion, readMig, rows, seed, submit,
} from "./policy-jp-chain-db.ts";
import { JP_TASK_ARMS, validateContributionRequest } from "./jp/contribution-schema.ts";
import { jpSameClaimProbe } from "./jp/same-claim-probe.ts";
import { JP_PROTOCOL_VERSION } from "./jp/protocol.ts";

const MIG_FILE = "20261011190000_policy_jp_term_policies.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV = await readMig("20261011180000_policy_jp_duplicate_policy.sql");
const POLLING = "2027-04-25";
const E1 = `${POLLING}_mayor_${ICHI}`; // いま開いている選挙
const PAST = "2023-04-23";
const E0 = `${PAST}_mayor_${ICHI}`; // 前回の選挙（任期の元）
const TODAY = addDays(POLLING, -10);
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const TERM_TYPES = ["term_policy_missing"];
const KOUHOU = "https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf";

const shared = await freshDb();
type Db = Awaited<ReturnType<typeof freshDb>>;

/** 任期を入れる（自動の任期 office:<参選 id> は、参選が elected でなくなると同期が消すので、戻すときはこれで入れ直す） */
async function putOffice(db: Db, pid: string, peid: string, eid: string, o: { end?: string | null; officeStatus?: string; termNo?: number } = {}) {
  const end = o.end ?? null;
  await db.query(`INSERT INTO policy_jp.politician_offices (id, politician_id, position, lg_code, term_no, start_date, scheduled_end_date, end_date, end_reason, end_basis, election_id, politician_election_id, review_status)
                  VALUES ($1, $2, 'mayor', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
    [`office:${peid}`, pid, ICHI, o.termNo ?? 1, addDays(eid.slice(0, 10), 8), addDays(eid.slice(0, 10), 1460), end, end ? "term_expired" : null, end ? "law" : null, eid, peid, o.officeStatus ?? "published"]);
}
/** 前回の選挙で当選して在任中（または任期終了）の人：政治家・参選（elected）・任期を直接入れる */
async function addTerm(db: Db, name: string, kana: string, o: { election?: string; end?: string | null; status?: string; officeStatus?: string; termNo?: number } = {}) {
  const eid = o.election ?? E0;
  const pid = crypto.randomUUID();
  const peid = `${pid}:${eid}:at_large`;
  await db.query(`INSERT INTO policy_jp.politicians (id, name, kana, review_status) VALUES ($1, $2, $3, 'published')`, [pid, name, kana]);
  await db.query(`INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, status_date, district_kind, review_status)
                  VALUES ($1, $2, $3, $4, $5, 'at_large', 'published')`, [peid, pid, eid, o.status ?? "elected", eid.slice(0, 10)]);
  await putOffice(db, pid, peid, eid, o);
  return { pid, peid };
}
/** 今回の選挙の declared の候補者（candidacy 交件＝本番と同じ経路） */
async function addCand(db: Db, name: string, kana: string, status = "declared"): Promise<{ pid: string; peid: string }> {
  const payload = { election_id: E1, name, kana, candidacy_status: status, status_date: "2027-03-01", district_kind: "at_large" };
  const id = await submit(db, "candidacy", payload, { status: "verified", urls: [KOUHOU] });
  const out = await applyOne(db, id);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pid = (await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id;
  return { pid, peid: out.record_id! };
}
const POL_DESC = "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。";
async function addPolicy(db: Db, peid: string, title: string, category = "子育て", description = POL_DESC): Promise<string> {
  const out = await applyOne(db, await submit(db, "policy", {
    politician_election_id: peid, title, description, category, source_locator: "選挙公報 2 頁", resolved_claim: "new",
  }, { status: "verified", urls: [KOUHOU] }));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  return out.record_id!;
}
/** 舞台：前回の選挙・今回の選挙（統計まで済み）。今日は投票日の 10 日前（告示後）。まだ誰もいない */
async function stage(db: Db) {
  await openElectionWithRegion(db, ICHI, POLLING);
  await insertElection(db, ICHI, PAST);
  await clock(db, TODAY);
}
const termRows = (db: Db) => rows<{ task_id: string; task_type: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[]; reward: number; region: string }>(db,
  `SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM policy_jp.contribution_auto_tasks_term_policies() ORDER BY task_id`);
const mayorRows = (db: Db) => rows<{ task_id: string; task_type: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[]; reward: number; region: string }>(db,
  `SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM policy_jp.contribution_auto_tasks_mayor_policies() ORDER BY task_id`);
const setParams = (db: Db, activity: string, patch: Record<string, unknown>) =>
  db.query(`UPDATE policy_jp.activity_rules SET params = params || $2::JSONB WHERE activity = $1 AND priority IS NULL`, [activity, JSON.stringify(patch)]);

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：臂名・総表・規則（enabled・常時窓・after_step＋後備・cap）・優先層・步驟順位・主控台の段", async () => {
  const names = (await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a;
  assert(names.includes("mayor_policies") && names.includes("term_policies"));
  const total = fnText(MIG_SQL, TOTAL);
  assert(total.includes("SELECT 'mayor_policies' AS arm, t.* FROM policy_jp.contribution_auto_tasks_mayor_policies() t"), "総表に mayor_policies");
  assert(total.includes("SELECT 'term_policies' AS arm, t.* FROM policy_jp.contribution_auto_tasks_term_policies() t"), "総表に term_policies");
  type R = { window_kind: string; min_status: string; after_step: string | null; enabled: boolean; params: Record<string, unknown> };
  const q = (a: string) => one<R>(shared, `SELECT window_kind, min_status, after_step, enabled, params FROM policy_jp.activity_rules WHERE activity = $1 AND priority IS NULL`, [a]);
  const m = await q("mayor_policies");
  assertEquals([m.window_kind, m.after_step, m.enabled], ["always", "candidacy", true]);
  assertEquals(m.params, { cap: 100, max_policies: 5, election_types: ["governor", "mayor", "ward_mayor", "town_mayor"], chain_fallback: { kind: "announced", offset: 1 } });
  const t = await q("term_policies");
  assertEquals([t.window_kind, t.after_step, t.enabled], ["always", "regional_stats", true]);
  assertEquals(t.params, {
    cap: 100, lookback_years: 10, deep_kinds: ["prefecture", "designated_city", "core_city", "city"],
    election_types: ["governor", "mayor", "ward_mayor", "town_mayor"], chain_fallback: { kind: "announced", offset: 0 },
  });
  // 優先層：mayor は policy_missing と同じ（前段 1・後段 3）、term は後段 3 だけ
  assertEquals((await rows<{ priority: number }>(shared, `SELECT priority FROM policy_jp.activity_rules WHERE activity = 'priority:mayor_policies' ORDER BY priority`)).map((r) => r.priority), [1, 3]);
  assertEquals((await rows<{ priority: number }>(shared, `SELECT priority FROM policy_jp.activity_rules WHERE activity = 'priority:term_policies'`)).map((r) => r.priority), [3]);
  const rank = (id: string, ty: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, ty]).then((x) => x.r);
  assertEquals(await rank("auto:term_policy_missing:x", "term_policy_missing"), 8);
  assertEquals(await rank("auto:policy_missing:x", "policy_missing"), 6, "mayor_policies の型別は policy_missing のまま 6");
  assertEquals(await rank("auto:duplicate_policy:x:y", "duplicate_policy"), 8, "既存の順位は動かない");
  assertEquals(await rank("auto:something_new:x", "something_new"), 9, "未登録は 9 のまま");
  const st = await rows<{ arm: string; stage: number }>(shared, `SELECT arm, stage::INT AS stage FROM policy_jp.console_arm_stage_map WHERE arm IN ('mayor_policies', 'term_policies') ORDER BY arm`);
  assertEquals(st, [{ arm: "mayor_policies", stage: 3 }, { arm: "term_policies", stage: 1 }]);
  // 新しい交件型別は作らない：この migration は CHECK・apply_types・apply_policy・apply_contribution を触らない
  for (const f of ["policy_jp.apply_types", "policy_jp.apply_policy", "policy_jp.apply_contribution", "policy_jp.contribution_needs_two_ips", "policy_jp.contribution_required_agree"]) {
    assert(!MIG_SQL.includes(`FUNCTION ${f}(`), `${f} を定義しない`);
  }
  assert(!MIG_SQL.includes("policy_jp_contributions_type_check"), "DB CHECK を触らない");
  assert(!MIG_SQL.includes("public."), "public を触らない");
});

// =============================================================================================
// b. term_policies
// =============================================================================================
Deno.test("term_policies：在任中の当選者で公約 0 件 → 1 件。target（開いている選挙＋過去の選挙＋任期）・文言（日本語・当選時の公約・policy／no_change）・hint", async () => {
  const db = await freshDb();
  await stage(db);
  const x = await addTerm(db, "山田太郎", "やまだたろう");
  const a = await termRows(db);
  assertEquals(a.length, 1);
  const t = a[0];
  assertEquals([t.task_id, t.task_type, t.reward, t.region], [`auto:term_policy_missing:${x.peid}`, "term_policy_missing", 1, "愛知県"]);
  assertEquals(t.target, {
    politician_election_id: x.peid, politician_id: x.pid, name: "山田太郎", kana: "やまだたろう",
    election_id: E1, election_type: "mayor", election_date: POLLING,
    term_election_id: E0, term_election_name: "一宮市mayor選挙", term_election_date: PAST,
    office_id: `office:${x.peid}`, term_no: 1, term_start: addDays(PAST, 8), term_end: addDays(PAST, 1460), in_office: true,
    lg_code: ICHI, lg_name: "一宮市", queued_policies: [], chain_lg_code: ICHI,
  });
  for (const w of ["その選挙で掲げた公約", "当時の選挙公報", "施政方針演説", "contribution_type=policy", x.peid, "source_locator", "resolved_claim", "no_change", "outcome=not_found", "ウェイバックマシン", "WARP", "現在も在任中"]) {
    assert(t.what_we_need.includes(w), w);
  }
  assert(!/中選會|READr|cec\.gov|policy-tw|台灣|縣市長|Campaign Pledge/.test(t.what_we_need + t.hint_sources.join("")), "台湾の語を含まない");
  assertEquals(t.hint_sources.length, 5);
  await db.close();
});

Deno.test("term_policies：派工列は後段（priority 3）・鎖の gate は regional_stats（done）・opened_by.arm＝term_policies・target.election_id は開いている選挙；seed を繰り返しても増えない", async () => {
  const db = await freshDb();
  await stage(db);
  const x = await addTerm(db, "山田太郎", "やまだたろう");
  await seed(db);
  const d = await dispatches(db, TERM_TYPES);
  assertEquals(d.map((r) => r.task_id), [`auto:term_policy_missing:${x.peid}`]);
  assertEquals([d[0].priority, d[0].opened_by?.arm, d[0].region, d[0].target.election_id], [3, "term_policies", "愛知県", E1]);
  assertEquals(d[0].opened_by?.chain_gate, { after_step: "regional_stats", via: "done" });
  await seed(db);
  assertEquals((await dispatches(db, TERM_TYPES)).length, 1);
  assertEquals((await events(db, d[0].task_id)).map((e) => e.event), ["opened"]);
  await db.close();
});

Deno.test("term_policies：鎖の gate — 第 1 歩（統計）が済んでいなければ告示日まで開かない・告示日からは後備（fallback）で開く", async () => {
  const db = await freshDb();
  await insertElection(db, ICHI, POLLING); // 統計なし
  await insertElection(db, ICHI, PAST);
  const x = await addTerm(db, "山田太郎", "やまだたろう");
  await clock(db, addDays(POLLING, -30)); // 告示日（投票日の 17 日前）より前
  await seed(db);
  assertEquals(await dispatchIds(db, TERM_TYPES), [], "統計がなく、告示日前");
  await clock(db, addDays(POLLING, -17));
  await seed(db);
  assertEquals(await dispatchIds(db, TERM_TYPES), [`auto:term_policy_missing:${x.peid}`], "告示日に後備で開く");
  assertEquals((await dispatches(db, TERM_TYPES))[0].opened_by?.chain_gate, { after_step: "regional_stats", via: "fallback" });
  await db.close();
});

Deno.test("term_policies：対象にならないもの — 公約あり／落選／非公開の参選・任期・人物／今回の選挙が開いていない／別の団体／投票直後（policy_missing 臂が担当）", async () => {
  const db = await freshDb();
  await stage(db);
  const base = await addTerm(db, "山田太郎", "やまだたろう");
  assertEquals((await termRows(db)).length, 1);
  // 公開済みの政見が 1 件でもあれば出ない（未公開の政見は数えない）
  const pol = await addPolicy(db, base.peid, "保育所の待機児童をなくす");
  assertEquals((await termRows(db)).length, 0, "公約あり");
  await db.query(`UPDATE policy_jp.policies SET review_status = 'pending' WHERE id = $1`, [pol]);
  assertEquals((await termRows(db)).length, 1, "非公開の政見は数えない");
  await db.query(`UPDATE policy_jp.policies SET review_status = 'published' WHERE id = $1`, [pol]);
  await db.query(`DELETE FROM policy_jp.policies WHERE id = $1`, [pol]);
  // 落選・非公開
  await db.query(`UPDATE policy_jp.politician_elections SET candidacy_status = 'not_elected' WHERE id = $1`, [base.peid]);
  assertEquals((await termRows(db)).length, 0, "elected でない");
  await db.query(`UPDATE policy_jp.politician_elections SET candidacy_status = 'elected' WHERE id = $1`, [base.peid]);
  await putOffice(db, base.pid, base.peid, E0); // 落選に変えると自動の任期は同期が消す
  // （politician_elections を非公開にすると任期の同期が自動の任期を消すので、参選の非公開は最後に別枠で確かめる）
  for (const [tbl, col] of [["politician_offices", "politician_election_id"], ["politicians", "id"], ["elections", "id"]] as const) {
    const key = tbl === "politicians" ? base.pid : tbl === "elections" ? E0 : base.peid;
    await db.query(`UPDATE policy_jp.${tbl} SET review_status = 'pending' WHERE ${col} = $1`, [key]);
    assertEquals((await termRows(db)).length, 0, `${tbl} が非公開`);
    await db.query(`UPDATE policy_jp.${tbl} SET review_status = 'published' WHERE ${col} = $1`, [key]);
  }
  assertEquals((await termRows(db)).length, 1);
  await db.query(`UPDATE policy_jp.politician_elections SET review_status = 'pending' WHERE id = $1`, [base.peid]);
  assertEquals((await termRows(db)).length, 0, "参選が非公開");
  await db.query(`UPDATE policy_jp.politician_elections SET review_status = 'published' WHERE id = $1`, [base.peid]);
  await putOffice(db, base.pid, base.peid, E0);
  // 今回の選挙が（まだ）上線していない
  await db.query(`UPDATE policy_jp.elections SET review_status = 'pending' WHERE id = $1`, [E1]);
  assertEquals((await termRows(db)).length, 0, "いまの開いている選挙がない");
  await db.query(`UPDATE policy_jp.elections SET review_status = 'published' WHERE id = $1`, [E1]);
  // 任期の元の選挙が別の団体なら、今回の選挙とは結びつかない（団体が違う）：別団体の人を足しても出ない
  const other = "232122"; // 別の市
  await insertLg(db, other);
  const oe = await insertElection(db, other, PAST);
  const pid = crypto.randomUUID();
  await db.query(`INSERT INTO policy_jp.politicians (id, name, kana, review_status) VALUES ($1, '別市長', 'べついちちょう', 'published')`, [pid]);
  await db.query(`INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, status_date, district_kind, review_status) VALUES ($1, $2, $3, 'elected', $4, 'at_large', 'published')`,
    [`${pid}:${oe}:at_large`, pid, oe, PAST]);
  await db.query(`INSERT INTO policy_jp.politician_offices (id, politician_id, position, lg_code, term_no, start_date, scheduled_end_date, election_id, politician_election_id, review_status)
                  VALUES ($1, $2, 'mayor', $3, 1, $4, $5, $6, $7, 'published')`, [`office:${pid}`, pid, other, addDays(PAST, 8), addDays(PAST, 1460), oe, `${pid}:${oe}:at_large`]);
  assertEquals((await termRows(db)).map((r) => r.target.lg_code), [ICHI], "別の市の元市長は、その市に開いている選挙がないので出ない");
  await db.close();
});

Deno.test("term_policies：投票直後（過去の選挙がまだ開いている＝投票日から 90 日以内）は出さない（policy_missing 臂の担当）；90 日を過ぎると出る", async () => {
  const db = await freshDb();
  await stage(db);
  await addTerm(db, "山田太郎", "やまだたろう");
  await clock(db, addDays(PAST, 30));
  assertEquals((await termRows(db)).length, 0, "前回の選挙の投票から 30 日");
  await clock(db, addDays(PAST, 120));
  assertEquals((await termRows(db)).length, 1, "120 日");
  await db.close();
});

Deno.test("term_policies：lookback_years（任期の終わりが 10 年以内）・deep_kinds（町村は遡らない）・election_types・cap・在任中の人が先", async () => {
  const db = await freshDb();
  await stage(db);
  const cur = await addTerm(db, "山田太郎", "やまだたろう");
  // 2 期前（2019）の任期は 2023-04 に終わっている＝10 年以内。2005 の選挙の任期は 2009 に終わっている＝10 年より前（今日は 2027-04）
  const e19 = await insertElection(db, ICHI, "2019-04-21");
  const prev = await addTerm(db, "鈴木一郎", "すずきいちろう", { election: e19, end: "2023-04-30", termNo: 1 });
  const e05 = await insertElection(db, ICHI, "2005-04-24");
  await addTerm(db, "古川次郎", "ふるかわじろう", { election: e05, end: "2009-04-30" });
  const a = await termRows(db);
  assertEquals(a.map((r) => r.task_id), [`auto:term_policy_missing:${cur.peid}`, `auto:term_policy_missing:${prev.peid}`].sort(), "10 年より前の任期は出ない");
  assertEquals(a.find((r) => r.task_id.endsWith(prev.peid))!.target.in_office, false);
  assert(a.find((r) => r.task_id.endsWith(prev.peid))!.what_we_need.includes("2023-04-30 に任期を終えています"));
  // 在任中の人が先（cap 1 のとき残るのは在任中）
  await setParams(db, "term_policies", { cap: 1 });
  assertEquals((await termRows(db)).map((r) => r.task_id), [`auto:term_policy_missing:${cur.peid}`], "cap 1＝在任中が先");
  await setParams(db, "term_policies", { cap: 100, lookback_years: 30 });
  assertEquals((await termRows(db)).length, 3, "lookback_years を延ばせば古い任期も");
  await setParams(db, "term_policies", { lookback_years: 10, deep_kinds: ["prefecture"] });
  assertEquals((await termRows(db)).length, 0, "市は deep_kinds に無い（町村と同じ扱い）");
  await setParams(db, "term_policies", { deep_kinds: ["city"], election_types: ["governor"] });
  assertEquals((await termRows(db)).length, 0, "職位が違う");
  await db.exec(`UPDATE policy_jp.activity_rules SET params = params - 'cap' WHERE activity = 'term_policies' AND priority IS NULL`);
  await setParams(db, "term_policies", { election_types: ["mayor"], deep_kinds: ["city"] });
  assertEquals((await termRows(db)).length, 0, "cap なし");
  await db.close();
});

Deno.test("term_policies：規則を止める（enabled=false）と臂は何も返さず、総表にも出ない", async () => {
  const db = await freshDb();
  await stage(db);
  await addTerm(db, "山田太郎", "やまだたろう");
  assertEquals(await count(db, `SELECT 1 FROM ${TOTAL}() WHERE arm = 'term_policies'`), 1);
  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = false WHERE activity = 'term_policies' AND priority IS NULL`);
  assertEquals((await termRows(db)).length, 0);
  assertEquals(await count(db, `SELECT 1 FROM ${TOTAL}() WHERE arm = 'term_policies'`), 0);
  await db.close();
});

// =============================================================================================
// c. mayor_policies
// =============================================================================================
Deno.test("mayor_policies：declared／filed の首長候補で公約 1～4 件 → 1 件（0 件は出ない＝policy_missing 臂、5 件で満足）。task_id は policy_missing と同じ、target に件数・分野", async () => {
  const db = await freshDb();
  await stage(db);
  const a = await addCand(db, "山田太郎", "やまだたろう");
  assertEquals((await mayorRows(db)).length, 0, "公約 0 件は mayor_policies の対象ではない");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_policy_missing() WHERE task_id = 'auto:policy_missing:${a.peid}'`), 1, "policy_missing 臂が出す");
  await addPolicy(db, a.peid, "保育所の待機児童をなくす", "子育て");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_policy_missing() WHERE task_id = 'auto:policy_missing:${a.peid}'`), 0, "1 件になると policy_missing 臂は出さない");
  const rowsA = await mayorRows(db);
  assertEquals(rowsA.length, 1);
  const t = rowsA[0];
  assertEquals([t.task_id, t.task_type, t.reward, t.region], [`auto:policy_missing:${a.peid}`, "policy_missing", 2, "愛知県"]);
  assertEquals([t.target.policies_now, t.target.policies_other_terms, t.target.queued, t.target.categories_now, t.target.politician_election_id, t.target.chain_lg_code],
    [1, 0, 0, "子育て", a.peid, ICHI]);
  for (const w of ["この選挙の", "あと 4 件", "contribution_type=policy", a.peid, "no_change", "outcome=not_found", "施政方針", "すでにある分野：子育て"]) assert(t.what_we_need.includes(w), w);
  assert(!/中選會|READr|cec\.gov|policy-tw|台灣|縣市長|2026/.test(t.what_we_need + t.hint_sources.join("")), "台湾の語・年を含まない");
  // 5 件で満足
  for (const [i, ttl] of ["公共交通を守る", "防災行政無線を更新する", "学校給食を無償にする", "商店街の空き店舗に補助を出す"].entries()) {
    await addPolicy(db, a.peid, ttl, ["交通", "防災", "教育", "経済"][i], `${ttl}ための取り組みを進めるとしている。`);
  }
  assertEquals((await mayorRows(db)).length, 0, "5 件");
  await db.close();
});

Deno.test("mayor_policies：審議中の政見を足して 5 件なら出ない・審議中の題名は target.queued_policies／別の選挙の公約は数えない・考慮中・退選は対象外", async () => {
  const db = await freshDb();
  await stage(db);
  const a = await addCand(db, "山田太郎", "やまだたろう");
  await addPolicy(db, a.peid, "保育所の待機児童をなくす");
  for (const ttl of ["公共交通を守る", "防災行政無線を更新する", "学校給食を無償にする"]) {
    await submit(db, "policy", { politician_election_id: a.peid, title: ttl, description: `${ttl}ための取り組みを進めるとしている。`, category: "その他", source_locator: "公報", resolved_claim: "new" }, { status: "pending" });
  }
  let r = await mayorRows(db);
  assertEquals(r.length, 1, "公開 1＋審議中 3＝4 件");
  assertEquals([r[0].target.queued, r[0].target.policies_now], [3, 1]);
  assertEquals((r[0].target.queued_policies as string[]).slice().sort(), ["公共交通を守る", "学校給食を無償にする", "防災行政無線を更新する"].sort());
  await submit(db, "policy", { politician_election_id: a.peid, title: "図書館を増やす", description: "図書館を市内に 2 館増やすとしている。", category: "教育", source_locator: "公報", resolved_claim: "new" }, { status: "pending" });
  assertEquals((await mayorRows(db)).length, 0, "審議中を足して 5 件");
  // 別の選挙の公約は『この選挙の分』に数えない：同じ人の前回の参選に公約が 2 件あっても、いまの選挙の 1 件のまま
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE status = 'pending'`);
  const oldPe = `${a.pid}:${E0}:at_large`;
  await db.query(`INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, status_date, district_kind, review_status) VALUES ($1, $2, $3, 'elected', $4, 'at_large', 'published')`,
    [oldPe, a.pid, E0, PAST]);
  await addPolicy(db, oldPe, "前回の公約その一", "福祉", "前回の選挙で掲げた福祉の取り組みを進めるとしている。");
  await addPolicy(db, oldPe, "前回の公約その二", "環境", "前回の選挙で掲げた環境の取り組みを進めるとしている。");
  r = await mayorRows(db);
  assertEquals(r.length, 1);
  assertEquals([r[0].target.policies_now, r[0].target.policies_other_terms], [1, 2]);
  assert(r[0].what_we_need.includes("過去の選挙の公約が 2 件"));
  // 考慮中・退選は対象外
  await db.query(`UPDATE policy_jp.politician_elections SET candidacy_status = 'considering' WHERE id = $1`, [a.peid]);
  assertEquals((await mayorRows(db)).length, 0, "considering");
  await db.query(`UPDATE policy_jp.politician_elections SET candidacy_status = 'withdrawn' WHERE id = $1`, [a.peid]);
  assertEquals((await mayorRows(db)).length, 0, "withdrawn");
  await db.query(`UPDATE policy_jp.politician_elections SET candidacy_status = 'filed' WHERE id = $1`, [a.peid]);
  assertEquals((await mayorRows(db)).length, 1, "filed は対象");
  await db.close();
});

Deno.test("mayor_policies：cap・max_policies・election_types の params が効く；規則を止めると臂は何も返さない", async () => {
  const db = await freshDb();
  await stage(db);
  const a = await addCand(db, "山田太郎", "やまだたろう");
  const b = await addCand(db, "鈴木花子", "すずきはなこ");
  await addPolicy(db, a.peid, "保育所の待機児童をなくす");
  await addPolicy(db, b.peid, "公共交通を守る", "交通", "バス路線を維持するとしている。");
  assertEquals((await mayorRows(db)).length, 2);
  await setParams(db, "mayor_policies", { cap: 1 });
  assertEquals((await mayorRows(db)).length, 1);
  await setParams(db, "mayor_policies", { cap: 100, max_policies: 1 });
  assertEquals((await mayorRows(db)).length, 0, "1 件で満足なら出ない");
  await setParams(db, "mayor_policies", { max_policies: 5, election_types: ["governor"] });
  assertEquals((await mayorRows(db)).length, 0, "職位が違う");
  await setParams(db, "mayor_policies", { election_types: ["mayor"] });
  assertEquals((await mayorRows(db)).length, 2);
  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = false WHERE activity = 'mayor_policies' AND priority IS NULL`);
  assertEquals((await mayorRows(db)).length, 0);
  await db.close();
});

Deno.test("mayor_policies：1 件目の落庫で policy_missing の任務は収回され、次の seed で mayor_policies として同じ task_id が戻る（正見と同じ動き）；層は policy_missing と同じ", async () => {
  const db = await freshDb();
  await stage(db);
  const a = await addCand(db, "山田太郎", "やまだたろう");
  await seed(db);
  const tid = `auto:policy_missing:${a.peid}`;
  let d = await dispatches(db, ["policy_missing"]);
  assertEquals(d.map((r) => r.task_id), [tid]);
  assertEquals(d[0].opened_by?.arm, "policy_missing");
  // 代理が 1 件交ける（task_id つき）→ 落庫 → 派工列は即収回
  const c = await submit(db, "policy", { politician_election_id: a.peid, title: "保育所の待機児童をなくす", description: POL_DESC, category: "子育て", source_locator: "公報 2 頁", resolved_claim: "new" },
    { status: "verified", urls: [KOUHOU], task: tid });
  assertEquals((await applyOne(db, c)).outcome, "applied");
  assertEquals(await dispatchIds(db, ["policy_missing"]), [], "落庫で収回");
  await seed(db);
  d = await dispatches(db, ["policy_missing"]);
  assertEquals(d.map((r) => r.task_id), [tid], "あと 4 件：同じ task_id が mayor_policies として戻る");
  assertEquals(d[0].opened_by?.arm, "mayor_policies");
  const gate = d[0].opened_by?.chain_gate as { after_step: string; via: string };
  assertEquals(gate.after_step, "candidacy");
  assert(["done", "fallback", "sticky"].includes(gate.via), gate.via);
  assertEquals(d[0].priority, 1, "投票日の 10 日前＝前段（policy_missing と同じ）");
  assertEquals((await events(db, tid)).map((e) => e.event), ["opened", "closed", "reopened"]);
  await db.close();
});

// =============================================================================================
// d. 抑制と收回
// =============================================================================================
Deno.test("抑制：not_found は冷却で戻る・unreachable も・no_change（confirmed）の交件が等票中は派さない（term／mayor 両方）", async () => {
  const db = await freshDb();
  await stage(db);
  const x = await addTerm(db, "山田太郎", "やまだたろう");
  const t0 = `auto:term_policy_missing:${x.peid}`;
  assertEquals((await termRows(db)).map((r) => r.task_id), [t0]);
  await check(db, t0, "not_found");
  assertEquals((await termRows(db)).length, 0, "not_found は冷却中");
  await expireCooling(db);
  assertEquals((await termRows(db)).length, 1, "冷却が過ぎれば戻る");
  const nc = await submit(db, "no_change", { task_id: t0, outcome: "not_found", checked_urls: [KOUHOU], finding: "選挙公報も当時の公式サイトも探したが、公約の記載は見つからなかった" }, { status: "pending", task: t0 });
  assertEquals((await termRows(db)).length, 0, "no_change 等票中");
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [nc]);
  assertEquals((await termRows(db)).length, 1);
  // mayor 側も同じ task_unavailable
  const a = await addCand(db, "鈴木花子", "すずきはなこ");
  await addPolicy(db, a.peid, "公共交通を守る", "交通", "バス路線を維持するとしている。");
  const m0 = `auto:policy_missing:${a.peid}`;
  assertEquals((await mayorRows(db)).map((r) => r.task_id), [m0]);
  await check(db, m0, "not_found");
  assertEquals((await mayorRows(db)).length, 0, "mayor も冷却中");
  await db.close();
});

Deno.test("落庫：過去の選挙の参選にも policy を掛けられる（pledge・not_started・出典・履歴）→ term 任務は即収回・臂も出さない；proposed_date は過去の投票日を超えない", async () => {
  const db = await freshDb();
  await stage(db);
  const x = await addTerm(db, "山田太郎", "やまだたろう");
  await seed(db);
  const tid = `auto:term_policy_missing:${x.peid}`;
  assertEquals(await dispatchIds(db, TERM_TYPES), [tid]);
  // proposed_date が前回の投票日より後なら invalid（apply_policy は動かしていない＝既存の検査）
  const bad = await submit(db, "policy", { politician_election_id: x.peid, title: "保育所の待機児童をなくす", description: POL_DESC, category: "子育て", source_locator: "公報", resolved_claim: "new", proposed_date: "2024-01-01" },
    { status: "verified", urls: [KOUHOU], task: tid });
  const badOut = await applyOne(db, bad);
  assertEquals([badOut.status, badOut.outcome], ["rejected", "invalid"], JSON.stringify(badOut));
  assertEquals(await dispatchIds(db, TERM_TYPES), [tid], "退件では収回されない");
  const ok = await submit(db, "policy", { politician_election_id: x.peid, title: "保育所の待機児童をなくす", description: POL_DESC, category: "子育て", source_locator: "公報 2 頁", resolved_claim: "new", proposed_date: "2023-04-01" },
    { status: "verified", urls: [KOUHOU], task: tid });
  const out = await applyOne(db, ok);
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  const pol = await one<{ origin: string; status: string; politician_election_id: string; lg_code: string; review_status: string }>(db,
    `SELECT origin, status, politician_election_id, lg_code, review_status FROM policy_jp.policies WHERE id = $1`, [out.record_id]);
  assertEquals(pol, { origin: "pledge", status: "not_started", politician_election_id: x.peid, lg_code: ICHI, review_status: "published" });
  assertEquals(await dispatchIds(db, TERM_TYPES), [], "落庫で即収回");
  assertEquals((await termRows(db)).length, 0, "公約が入ったので臂も出さない");
  await seed(db);
  assertEquals(await dispatchIds(db, TERM_TYPES), []);
  assertEquals((await events(db, tid)).at(-1)?.event, "closed");
  await db.close();
});

// =============================================================================================
// e. TS
// =============================================================================================
const PEID = `5f0c8d6e-1111-4222-8333-444444444444:${E0}:at_large`;
const policyReq = (taskId: string | null, patch: Record<string, unknown> = {}) => validateContributionRequest({
  agent_name: "jp-agent", agent_tool: "claude-code/claude-sonnet-5", contribution_type: "policy",
  payload: { politician_election_id: PEID, title: "保育所の待機児童をなくす", description: POL_DESC, category: "子育て", source_locator: "選挙公報 2 頁", resolved_claim: "new", ...patch },
  source_urls: [KOUHOU], ...(taskId ? { task_id: taskId } : {}),
});

Deno.test("TS：term_policy_missing は policy で答える（JP_TASK_ARMS）；task_id の参選と payload の参選が一致しないと 400；他の型別で答えると 400；新しい交件型別はない", () => {
  assertEquals(JP_TASK_ARMS.term_policy_missing, "policy");
  assertEquals(JP_TASK_ARMS.policy_missing, "policy");
  const task = `auto:term_policy_missing:${PEID}`;
  const v = policyReq(task);
  assert(v.ok, JSON.stringify(v.errors));
  assertEquals(v.items[0].task_id, task);
  const other = policyReq(task, { politician_election_id: `5f0c8d6e-9999-4222-8333-444444444444:${E0}:at_large` });
  assertEquals(other.errors.map((e) => e.path), ["payload.politician_election_id"]);
  const wrong = validateContributionRequest({
    agent_name: "jp-agent", agent_tool: "claude-code/claude-sonnet-5", contribution_type: "politician",
    payload: { name: "山田太郎", kana: "やまだたろう", birth_year: 1970 }, source_urls: [KOUHOU], task_id: task,
  });
  const wrongTask = wrong.errors.find((e) => e.path === "task_id");
  assert(wrongTask && wrongTask.message.includes("policy"), JSON.stringify(wrong.errors));
  // mayor_policies の任務は policy_missing 型（これまでどおり）
  assert(policyReq(`auto:policy_missing:${PEID}`).ok);
  assertEquals(policyReq(`auto:policy_missing:${PEID}`, { politician_election_id: "x" }).errors.length > 0, true);
  // no_change で not_found を返せる（task_id の形が通る）
  const nc = validateContributionRequest({
    agent_name: "jp-agent", agent_tool: "claude-code/claude-sonnet-5", contribution_type: "no_change",
    payload: { task_id: task, outcome: "not_found", checked_urls: [KOUHOU], finding: "選挙公報も当時の公式サイトも探したが見つからなかった" }, source_urls: [KOUHOU], task_id: task,
  });
  assert(nc.ok, JSON.stringify(nc.errors));
});

Deno.test("TS：同一件事の探査 — term_policy_missing は policy_missing と同じく『その参選の公約』を探す", () => {
  assertEquals(jpSameClaimProbe(`auto:term_policy_missing:${PEID}`), { type: "policy", payload: { politician_election_id: PEID } });
  assertEquals(jpSameClaimProbe(`auto:policy_missing:${PEID}`), { type: "policy", payload: { politician_election_id: PEID } });
  assertEquals(jpSameClaimProbe("auto:term_policy_missingx:abc"), null);
});

Deno.test("協議版號：JP_PROTOCOL_VERSION は 0.19.0 以上（この支で 0.18.0 → 0.19.0）", () => {
  const n = (v: string) => v.split(".").map(Number).reduce((a, x) => a * 1000 + x, 0);
  assert(n(JP_PROTOCOL_VERSION) >= n("0.19.0"), JP_PROTOCOL_VERSION);
});

// =============================================================================================
// f. 還原驗證・冪等・前の版に足しただけ・権限
// =============================================================================================
Deno.test("自我檢查（還原驗證）：規則が欠ける・after_step／後備／cap が欠ける・優先層が欠ける・総表の分支・臂名・順位・主控台の段・anon が欠ける／あると、migration が失敗する", async () => {
  const pre = await migratedDb({ before: MIG_FILE });
  const bad = async (from: string, to: string, why: string) => {
    await assertRejects(() => pre.exec(mutate(MIG_SQL, from, to)), Error, undefined, why);
  };
  await bad(`SELECT 'mayor_policies', 'always', 'announced', 'candidacy',`, `SELECT 'mayor_policies', 'always', 'announced', NULL,`, "mayor_policies が鎖にぶら下がっていない");
  await bad(`SELECT 'term_policies', 'always', 'announced', 'regional_stats',`, `SELECT 'term_policies', 'always', 'announced', NULL,`, "term_policies が鎖にぶら下がっていない");
  await bad(`"chain_fallback":{"kind":"announced","offset":0}}'::JSONB,`, `}'::JSONB,`, "term_policies に後備がない");
  await bad(`"max_policies":5,`, ``, "mayor_policies に max_policies がない");
  await bad(`"lookback_years":10,`, ``, "term_policies に lookback_years がない");
  await bad(`SELECT 'priority:term_policies', 'always', 3,`, `SELECT 'priority:term_policies', 'always', 1,`, "term の優先層が後段でない");
  await bad(`    ('priority:mayor_policies', NULL::TEXT, 0,  'polling', -181, 3::SMALLINT,`, `    ('priority:mayor_policies', NULL::TEXT, 0,  'polling', -181, 2::SMALLINT,`, "mayor の後段が欠ける");
  await bad(`  UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM policy_jp.contribution_auto_tasks_mayor_policies() t\n`, "", "総表に mayor_policies が無い");
  await bad(`  UNION ALL SELECT 'term_policies' AS arm, t.* FROM policy_jp.contribution_auto_tasks_term_policies() t\n`, "", "総表に term_policies が無い");
  await bad(`    'duplicate_policy',\n    'mayor_policies',\n    'term_policies'\n  ]`, `    'duplicate_policy',\n    'mayor_policies'\n  ]`, "臂名が欠ける");
  await bad(`                  WHEN 'term_policy_missing' THEN 8\n`, "", "順位が欠ける");
  await bad(`  ('term_policies', 1, '過去の任期`, `  ('term_policies', 2, '過去の任期`, "主控台の段が違う");
  await bad(`  TO service_role;\n\n-- ------------------------------------------------------------\n-- 6.`, `  TO service_role, anon;\n\n-- ------------------------------------------------------------\n-- 6.`, "anon に渡す");
  await pre.exec(MIG_SQL);
  await pre.close();
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則・主控台登記が増えない（規則は開いたまま）", async () => {
  const db = await freshDb();
  const n = () => Promise.all([count(db, `SELECT 1 FROM policy_jp.activity_rules`), count(db, `SELECT 1 FROM policy_jp.console_arm_stage_map`)]);
  const before = await n();
  await db.exec(MIG_SQL);
  assertEquals(await n(), before);
  assertEquals((await rows<{ a: string; e: boolean }>(db, `SELECT activity AS a, enabled AS e FROM policy_jp.activity_rules WHERE activity IN ('mayor_policies', 'term_policies') AND priority IS NULL ORDER BY 1`)),
    [{ a: "mayor_policies", e: true }, { a: "term_policies", e: true }]);
  await db.close();
});

Deno.test("緊接在前一版：総表・臂名・順位は前の版に『足しただけ』（残りは一字も変えない）；交件まわりの関数は定義しない", () => {
  const strip = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  assertEquals(
    strip(fnText(MIG_SQL, TOTAL))
      .replace(" UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM policy_jp.contribution_auto_tasks_mayor_policies() t", "")
      .replace(" UNION ALL SELECT 'term_policies' AS arm, t.* FROM policy_jp.contribution_auto_tasks_term_policies() t", ""),
    strip(fnText(PREV, TOTAL)));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.chain_step_rank")).replace(" WHEN 'term_policy_missing' THEN 8", ""), strip(fnText(PREV, "policy_jp.chain_step_rank")));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.activity_arm_names")).replace(", 'mayor_policies', 'term_policies'", ""), strip(fnText(PREV, "policy_jp.activity_arm_names")));
});

Deno.test("権限：新しい関数は anon／authenticated が呼べない（service_role は呼べる）", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const f of ["mayor_policies", "term_policies"]) {
      await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.contribution_auto_tasks_${f}()`), Error, "permission denied");
    }
  }
  for (const f of ["mayor_policies", "term_policies"]) {
    assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_${f}()`))[0].n, 0);
  }
});
