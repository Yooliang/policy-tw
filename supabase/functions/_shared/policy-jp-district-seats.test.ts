/**
 * 日本站派工臂對齊正見：議員定数 district_seats（migration 20261011170000_policy_jp_district_seats.sql、工作単 Yooliang/policy-ops#95、第 2b 步）
 *   臂 district_seats（task_type district_seats_missing）＋交件型別 district_seats＋落庫 apply_district_seats＋同一件事登記。規則は最初から開く（enabled=true）。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts），時鐘用 `SET app.activity_today`。
 *
 *   a. 結構：臂名・総表・規則（開いている・投票日まで・after_step なし・cap）・優先層・步驟順位 4・主控台の段・型別清單
 *   b. 臂：議会議員選挙だけ・定数が揃った選挙は出ない・交件待ちは派さない・派工列になる（前段）・投票日を過ぎると窓が閉じる
 *   c. 落庫：at_large 1 件・選挙区複数（pref_assembly）・冪等 unchanged・違う定数 conflict・種類混在／合計不一致は invalid・空の行を埋める・出典と履歴
 *   d. 任務の收回：落庫で filled
 *   e. 同一件事
 *   f. 還原驗證・冪等・權限
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, AICHI, applyOne, asRole, clock, count, dispatches, dispatchIds, events, freshDb, ICHI, insertElection, migratedDb, mutate, one,
  readMig, rows, seed, submit,
} from "./policy-jp-chain-db.ts";

const MIG_FILE = "20261011170000_policy_jp_district_seats.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV_PE = await readMig("20261011140000_policy_jp_policy_elements.sql");
const POLLING = "2027-04-25";
const TODAY = addDays(POLLING, -10);
const E_MUNI = `${POLLING}_muni_assembly_${ICHI}`;
const E_PREF = `${POLLING}_pref_assembly_${AICHI}`;
const E_MAYOR = `${POLLING}_mayor_${ICHI}`;
const DS_TYPES = ["district_seats_missing"];
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const REIKI = "https://www.city.ichinomiya.aichi.jp/reiki/teisuu.html";
const taskId = (eid: string) => `auto:district_seats_missing:${eid}`;

const shared = await freshDb();
type Db = Awaited<ReturnType<typeof freshDb>>;

const submitDs = (db: Db, eid: string, total: number, districts: unknown[], o: Parameters<typeof submit>[3] & { basis?: string } = {}) =>
  submit(db, "district_seats", { election_id: eid, seats_total: total, seats_basis: o.basis ?? "law", districts, resolved_claim: "new" }, { status: "verified", urls: [REIKI], ...o });
const atLarge = (n: number) => [{ district_kind: "at_large", seats: n }];
type DRow = { district_kind: string; district_name: string | null; district_lg_code: string | null; seats: number | null; seats_basis: string | null };
const dRows = (db: Db, eid: string) => rows<DRow>(db, `SELECT district_kind, district_name, district_lg_code, seats, seats_basis FROM policy_jp.election_districts WHERE election_id = $1 ORDER BY district_name NULLS FIRST`, [eid]);
const seatsOf = async (db: Db, eid: string) => (await one<{ seats: number | null }>(db, `SELECT seats FROM policy_jp.elections WHERE id = $1`, [eid])).seats;
const armRows = (db: Db) => rows<{ task_id: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[]; region: string }>(db,
  `SELECT task_id, target, what_we_need, hint_sources, region FROM policy_jp.contribution_auto_tasks_district_seats() ORDER BY task_id`);
async function stage(db: Db) {
  await insertElection(db, ICHI, POLLING, { type: "muni_assembly" });
  await insertElection(db, AICHI, POLLING, { type: "pref_assembly" });
  await insertElection(db, ICHI, POLLING, { type: "mayor" });
  await clock(db, TODAY);
}

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：臂名・総表・規則（開いている・投票日まで・after_step なし・cap）・優先層・步驟順位 4・主控台の段・型別清單（CHECK・apply_types）", async () => {
  assert((await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a.includes("district_seats"));
  assert(fnText(MIG_SQL, TOTAL).includes("SELECT 'district_seats' AS arm, t.* FROM policy_jp.contribution_auto_tasks_district_seats() t"), "総表に UNION 分支");
  const r = await one<{ window_kind: string; from_kind: string | null; until_kind: string; until_offset: number; min_status: string; after_step: string | null; enabled: boolean; params: Record<string, unknown>; election_types: string[] }>(shared,
    `SELECT window_kind, from_kind, until_kind, until_offset, min_status, after_step, enabled, params, election_types FROM policy_jp.activity_rules WHERE activity = 'district_seats' AND priority IS NULL`);
  assertEquals([r.window_kind, r.from_kind, r.until_kind, r.until_offset, r.after_step, r.enabled], ["event", null, "polling", 0, null, true]);
  assertEquals(r.params, { cap: 100 });
  assertEquals(r.election_types, ["pref_assembly", "muni_assembly"]);
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:district_seats' AND priority IN (1, 3)`), 2);
  const rank = (id: string, t: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, t]).then((x) => x.r);
  assertEquals(await rank(taskId("x"), "district_seats_missing"), 4);
  assertEquals(await rank("auto:roster_check:x", "roster_check"), 4);
  assertEquals(await rank("auto:policy_elements_missing:x", "policy_elements_missing"), 8, "既存の順位は動かない");
  assertEquals(await rank("auto:policy_missing:x", "policy_missing"), 6, "既存の順位は動かない");
  assertEquals(await rank("auto:something_new:x", "something_new"), 9, "未登録は 9 のまま");
  assertEquals((await one<{ stage: number }>(shared, `SELECT stage::INT AS stage FROM policy_jp.console_arm_stage_map WHERE arm = 'district_seats'`)).stage, 2);
  assert((await one<{ a: string[] }>(shared, `SELECT policy_jp.apply_types() AS a`)).a.includes("district_seats"));
  assertEquals(await count(shared, `SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%district_seats%'`), 1);
});

// =============================================================================================
// b. 臂
// =============================================================================================
Deno.test("臂：議会議員選挙だけ（首長選挙は出ない）／定数が揃った選挙は出ない／交件待ちは派さない（退件で戻る）；文言は日本語で台湾の語を含まない", async () => {
  const db = await freshDb();
  await stage(db);
  const a = await armRows(db);
  assertEquals(a.map((x) => x.task_id), [taskId(E_PREF), taskId(E_MUNI)].sort(), "議会議員選挙 2 件だけ（市長選挙は出ない）");
  assert(!a.some((x) => x.task_id === taskId(E_MAYOR)));
  const muni = a.find((x) => x.task_id === taskId(E_MUNI))!;
  assertEquals([muni.target.election_id, muni.target.election_type, muni.target.lg_code, muni.target.seats, muni.target.known_districts], [E_MUNI, "muni_assembly", ICHI, null, []]);
  assertEquals(muni.region, "愛知県");
  assert(muni.what_we_need.includes("at_large") && muni.what_we_need.includes("seats_total") && muni.what_we_need.includes("議員定数条例") && muni.what_we_need.includes(E_MUNI) && muni.what_we_need.includes("推測しない"));
  assert(!/中選會|READr|cec\.gov/i.test(muni.what_we_need + muni.hint_sources.join("")), "台湾の語を含まない");
  assert(muni.hint_sources.some((h) => h.includes("議員定数条例（例規集）")) && muni.hint_sources.some((h) => h.includes("選挙管理委員会の告示")));
  const pref = a.find((x) => x.task_id === taskId(E_PREF))!;
  assert(pref.what_we_need.includes("選挙区ごとに定数が決まっています") && pref.hint_sources.some((h) => h === "愛知県 選挙管理委員会"), "都道府県議会の案内");
  assert(!muni.hint_sources.some((h) => h === "愛知県 選挙管理委員会"));
  // 交件待ち（pending）は派さない；退件で戻る
  const c = await submitDs(db, E_MUNI, 36, atLarge(36), { status: "pending" });
  assertEquals((await armRows(db)).map((x) => x.task_id), [taskId(E_PREF)], "交件待ち");
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [c]);
  assertEquals((await armRows(db)).length, 2, "退件で戻る");
  // 定数合計だけ入っていて選挙区行がない → まだ出る；選挙区行が揃えば出ない
  await db.query(`UPDATE policy_jp.elections SET seats = 36 WHERE id = $1`, [E_MUNI]);
  assert((await armRows(db)).some((x) => x.task_id === taskId(E_MUNI)), "選挙区行なし");
  await db.query(`INSERT INTO policy_jp.election_districts (election_id, district_kind, seats, seats_basis) VALUES ($1, 'at_large', 36, 'law')`, [E_MUNI]);
  assert(!(await armRows(db)).some((x) => x.task_id === taskId(E_MUNI)), "定数が揃った");
  // seats が空の行が 1 つでもあれば出る（known_districts に載る）
  await db.query(`INSERT INTO policy_jp.election_districts (election_id, district_kind, district_name) VALUES ($1, 'district', '千種区')`, [E_PREF]);
  const withNull = (await armRows(db)).find((x) => x.task_id === taskId(E_PREF))!;
  assertEquals((withNull.target.known_districts as Array<Record<string, unknown>>).map((d) => [d.district_name, d.seats]), [["千種区", null]]);
  // 非公開の選挙は出ない
  await db.query(`UPDATE policy_jp.elections SET review_status = 'pending' WHERE id = $1`, [E_PREF]);
  assertEquals((await armRows(db)).length, 0);
  await db.close();
});

Deno.test("派工列：規則が開いているので seed で派工列になる（前段・region・target）；cap で絞る；投票日を過ぎると窓が閉じて收回（window）", async () => {
  const db = await freshDb();
  await stage(db);
  await seed(db);
  assertEquals((await dispatchIds(db, DS_TYPES)).sort(), [taskId(E_PREF), taskId(E_MUNI)].sort());
  const d = (await dispatches(db, DS_TYPES)).find((x) => x.task_id === taskId(E_MUNI))!;
  assertEquals([d.opened_by?.arm, d.priority, d.region, d.target.election_id, d.target.chain_lg_code], ["district_seats", 1, "愛知県", E_MUNI, ICHI]);
  assertEquals(d.opened_by?.chain_gate, undefined, "鎖の gate なし");
  // cap=1：投票日が同じなら選挙 id の小さい方だけ
  await db.query(`UPDATE policy_jp.activity_rules SET params = '{"cap":1}'::JSONB WHERE activity = 'district_seats' AND priority IS NULL`);
  assertEquals((await armRows(db)).length, 1);
  await db.query(`UPDATE policy_jp.activity_rules SET params = '{"cap":100}'::JSONB WHERE activity = 'district_seats' AND priority IS NULL`);
  // 投票日の翌日：窓が閉じる（臂は読み取りで行を返すが総表が落とす）
  await clock(db, addDays(POLLING, 1));
  await seed(db);
  assertEquals(await dispatchIds(db, DS_TYPES), []);
  const ev = await events(db, taskId(E_MUNI));
  assertEquals(ev.at(-1)?.event, "closed");
  assertEquals(ev.at(-1)?.reason, "window");
  await db.close();
});

// =============================================================================================
// c. 落庫
// =============================================================================================
Deno.test("落庫：市町村議会（at_large 1 件）— election_districts に 1 行、elections.seats が入る；出典は source_refs（選挙区行・選挙）、履歴は edit_history", async () => {
  const db = await freshDb();
  await stage(db);
  const id = await submitDs(db, E_MUNI, 36, atLarge(36));
  const out = await applyOne(db, id);
  assertEquals([out.status, out.outcome, out.table_name, out.record_id], ["applied", "applied", "election_districts", E_MUNI], JSON.stringify(out));
  assertEquals(await dRows(db, E_MUNI), [{ district_kind: "at_large", district_name: null, district_lg_code: null, seats: 36, seats_basis: "law" }]);
  assertEquals(await seatsOf(db, E_MUNI), 36);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs r JOIN policy_jp.election_districts d ON d.id::TEXT = r.target_id WHERE r.target_table = 'election_districts' AND d.election_id = $1`, [E_MUNI]), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'elections' AND target_id = $1`, [E_MUNI]), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name IN ('election_districts', 'elections') AND contribution_id = $1 AND agent_name = 'auto-apply'`, [id]), 2);
  assertEquals((await one<{ status: string }>(db, `SELECT status FROM policy_jp.contributions WHERE id = $1`, [id])).status, "applied");
  // 公開読み取り（anon）
  assertEquals((await asRole<{ n: number }>(db, "anon", `SELECT count(*)::INT AS n FROM policy_jp.election_districts WHERE election_id = '${E_MUNI}'`))[0].n, 1);
  await db.close();
});

Deno.test("落庫：都道府県議会（選挙区複数）— 全部の行が入り、合計が elections.seats；根拠 notice；district_lg_code は団体表にあれば入る", async () => {
  const db = await freshDb();
  await stage(db);
  const out = await applyOne(db, await submitDs(db, E_PREF, 8, [
    { district_kind: "district", district_name: "千種区", seats: 3, district_lg_code: "231011" },
    { district_kind: "district", district_name: "東区", seats: 2 },
    { district_kind: "district", district_name: "北区", seats: 3 },
  ], { basis: "notice" }));
  assertEquals([out.status, out.outcome], ["applied", "applied"], JSON.stringify(out));
  assertEquals(await dRows(db, E_PREF), [
    { district_kind: "district", district_name: "千種区", district_lg_code: "231011", seats: 3, seats_basis: "notice" },
    { district_kind: "district", district_name: "北区", district_lg_code: null, seats: 3, seats_basis: "notice" },
    { district_kind: "district", district_name: "東区", district_lg_code: null, seats: 2, seats_basis: "notice" },
  ].sort((a, b) => ((a.district_name ?? "") < (b.district_name ?? "") ? -1 : 1)));
  assertEquals(await seatsOf(db, E_PREF), 8);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'election_districts' AND record_id ~ '^[0-9]+$'`), 3);
  await db.close();
});

Deno.test("落庫：同じ内容をもう一度は unchanged（出典だけ足す）／違う定数は conflict で全体を退件（上書きしない・何も書かない）", async () => {
  const db = await freshDb();
  await stage(db);
  await applyOne(db, await submitDs(db, E_MUNI, 36, atLarge(36)));
  const o1 = await applyOne(db, await submitDs(db, E_MUNI, 36, atLarge(36), { urls: ["https://www.pref.aichi.lg.jp/senkyo/teisuu.html"] }));
  assertEquals([o1.status, o1.outcome], ["applied", "unchanged"], JSON.stringify(o1));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs r JOIN policy_jp.election_districts d ON d.id::TEXT = r.target_id WHERE r.target_table = 'election_districts' AND d.election_id = $1`, [E_MUNI]), 2, "出典が足される");
  // 違う定数
  const diff = await submitDs(db, E_MUNI, 34, atLarge(34));
  const o2 = await applyOne(db, diff);
  assertEquals([o2.status, o2.outcome], ["rejected", "conflict"], JSON.stringify(o2));
  assertEquals(await seatsOf(db, E_MUNI), 36, "elections.seats は上書きしない");
  assertEquals((await dRows(db, E_MUNI))[0].seats, 36);
  assertEquals((await one<{ status: string }>(db, `SELECT status FROM policy_jp.contributions WHERE id = $1`, [diff])).status, "rejected");
  // 別の種類（庫は at_large、提出は district）
  const o3 = await applyOne(db, await submitDs(db, E_MUNI, 36, [{ district_kind: "district", district_name: "A", seats: 36 }]));
  assertEquals(o3.outcome, "conflict", JSON.stringify(o3));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.election_districts WHERE election_id = $1`, [E_MUNI]), 1);
  // 選挙区の定数が違う／庫の選挙区が提出に含まれない（半分だけ書かない）
  await applyOne(db, await submitDs(db, E_PREF, 5, [{ district_kind: "district", district_name: "千種区", seats: 3 }, { district_kind: "district", district_name: "東区", seats: 2 }]));
  const o4 = await applyOne(db, await submitDs(db, E_PREF, 5, [{ district_kind: "district", district_name: "千種区", seats: 2 }, { district_kind: "district", district_name: "東区", seats: 3 }]));
  assertEquals(o4.outcome, "conflict");
  const o5 = await applyOne(db, await submitDs(db, E_PREF, 6, [{ district_kind: "district", district_name: "千種区", seats: 3 }, { district_kind: "district", district_name: "北区", seats: 3 }]));
  assertEquals(o5.outcome, "conflict", "庫の東区が提出にない＋総定数も違う");
  assertEquals((await dRows(db, E_PREF)).map((r) => [r.district_name, r.seats]), [["千種区", 3], ["東区", 2]], "何も増えない");
  // 総定数が同じで庫の行が提出にない（提出が不完全）
  const o6 = await applyOne(db, await submitDs(db, E_PREF, 5, [{ district_kind: "district", district_name: "千種区", seats: 3 }, { district_kind: "district", district_name: "北区", seats: 2 }]));
  assertEquals(o6.outcome, "conflict");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.election_districts WHERE election_id = $1`, [E_PREF]), 2);
  await db.close();
});

Deno.test("落庫：seats が空の行は埋める（elections.seats が空なら合計も）、無い行は挿入；不備は invalid（種類混在・at_large 複数・重複・合計不一致・範囲外・存在しない選挙・首長選挙・団体コード・出典なし）", async () => {
  const db = await freshDb();
  await stage(db);
  await db.query(`INSERT INTO policy_jp.election_districts (election_id, district_kind, district_name) VALUES ($1, 'district', '千種区')`, [E_PREF]);
  const o = await applyOne(db, await submitDs(db, E_PREF, 5, [{ district_kind: "district", district_name: "千種区", seats: 3 }, { district_kind: "district", district_name: "東区", seats: 2 }]));
  assertEquals(o.outcome, "applied", JSON.stringify(o));
  assertEquals((await dRows(db, E_PREF)).map((r) => [r.district_name, r.seats, r.seats_basis]), [["千種区", 3, "law"], ["東区", 2, "law"]]);
  assertEquals(await seatsOf(db, E_PREF), 5);
  const bad = async (eid: string, total: number, districts: unknown[], needle: string, o2: { urls?: string[] } = {}) => {
    const r = await applyOne(db, await submitDs(db, eid, total, districts, { urls: o2.urls }));
    assertEquals([r.status, r.outcome], ["rejected", "invalid"], `${needle}：${JSON.stringify(r)}`);
    assert((r.message ?? "").includes(needle), `${needle} ← ${r.message}`);
  };
  const D = (name: string, seats: number, extra: Record<string, unknown> = {}) => ({ district_kind: "district", district_name: name, seats, ...extra });
  await bad(E_MUNI, 10, [{ district_kind: "at_large", seats: 4 }, D("A", 6)], "混ぜない");
  await bad(E_MUNI, 8, [{ district_kind: "at_large", seats: 4 }, { district_kind: "at_large", seats: 4 }], "重複");
  await bad(E_MUNI, 8, [D("A", 4), D("A", 4)], "重複");
  await bad(E_MUNI, 9, [D("A", 4), D("B", 4)], "合計");
  await bad(E_MUNI, 0, [D("A", 0)], "seats_total");
  await bad(E_MUNI, 201, [D("A", 201)], "seats_total");
  await bad(E_MUNI, 8, [{ district_kind: "district", seats: 8 }], "district_name");
  await bad(E_MUNI, 8, [{ district_kind: "at_large", district_name: "全域", seats: 8 }], "district_name");
  await bad(E_MUNI, 8, [D("A", 8, { district_lg_code: "999999" })], "団体表にない");
  await bad(E_MUNI, 8, [{ district_kind: "ward", seats: 8 }], "district_kind");
  await bad(E_MUNI, 8, [], "districts");
  await bad(E_MAYOR, 1, atLarge(1), "議会議員選挙");
  await bad("2099-01-01_muni_assembly_232033", 8, atLarge(8), "登録されていないか");
  await bad(E_MUNI, 8, atLarge(8), "使える http(s)", { urls: ["ftp://example.com/x"] });
  assertEquals(await seatsOf(db, E_MUNI), null, "不備の交件は何も書かない");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.election_districts WHERE election_id = $1`, [E_MUNI]), 0);
  await db.close();
});

// =============================================================================================
// d. 任務の收回
// =============================================================================================
Deno.test("收回：落庫で派工列が收回され、定数が揃ったので次の seed でも戻らない（filled）", async () => {
  const db = await freshDb();
  await stage(db);
  await seed(db);
  assert((await dispatchIds(db, DS_TYPES)).includes(taskId(E_MUNI)));
  const out = await applyOne(db, await submitDs(db, E_MUNI, 36, atLarge(36), { task: taskId(E_MUNI) }));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  assert(!(await dispatchIds(db, DS_TYPES)).includes(taskId(E_MUNI)), "落庫で收回");
  await seed(db);
  assert(!(await dispatchIds(db, DS_TYPES)).includes(taskId(E_MUNI)));
  const ev = await events(db, taskId(E_MUNI));
  assertEquals(ev.at(-1)?.event, "closed");
  assertEquals(ev.at(-1)?.reason, "filled");
  assert((await dispatchIds(db, DS_TYPES)).includes(taskId(E_PREF)), "他の選挙は残る");
  await db.close();
});

// =============================================================================================
// e. 同一件事
// =============================================================================================
Deno.test("同一件事：same_claim_matches が district_seats を分派する（在庫・審議中・探査）、内容が同じなら収編の「同じ内容」", async () => {
  const db = await freshDb();
  await stage(db);
  await applyOne(db, await submitDs(db, E_PREF, 5, [{ district_kind: "district", district_name: "千種区", seats: 3 }, { district_kind: "district", district_name: "東区", seats: 2 }]));
  const pend = await submitDs(db, E_PREF, 6, [{ district_kind: "district", district_name: "千種区", seats: 6 }], { status: "pending" });
  const m = async (payload: unknown) => (await one<{ m: { type: string; existing: Array<Record<string, unknown>>; pending: Array<Record<string, unknown>> } }>(db,
    `SELECT policy_jp.same_claim_matches('district_seats', $1::JSONB) AS m`, [JSON.stringify(payload)])).m;
  const probe = await m({ election_id: E_PREF });
  assertEquals(probe.type, "district_seats");
  assertEquals(probe.existing.map((x) => x.summary), ["定数合計 5", "千種区 3", "東区 2"]);
  assertEquals(probe.pending.map((x) => x.contribution_id), [pend]);
  assertEquals((await m({ election_id: E_MUNI })).existing.length, 0, "別の選挙には出ない");
  assertEquals((await m({})).existing.length, 0);
  const same = (a: unknown, b: unknown) => one<{ r: boolean }>(db, `SELECT policy_jp.same_claim_same_content('district_seats', $1::JSONB, $2::JSONB) AS r`, [JSON.stringify(a), JSON.stringify(b)]).then((x) => x.r);
  const A = { election_id: E_PREF, seats_total: 5, seats_basis: "law", districts: [{ district_kind: "district", district_name: "千種区", seats: 3 }, { district_kind: "district", district_name: "東区", seats: 2 }] };
  assertEquals(await same(A, { ...A, districts: [...A.districts].reverse() }), true, "順序を問わない");
  assertEquals(await same(A, { ...A, seats_basis: "notice" }), false, "根拠が違う");
  assertEquals(await same(A, { ...A, seats_total: 6, districts: [{ district_kind: "district", district_name: "千種区", seats: 6 }] }), false);
  assertEquals(await same(A, { ...A, districts: "x" }), false, "形が違う");
  // 収編：同じ内容の審議中が、落庫した方に収編される
  const dup = await submitDs(db, E_MUNI, 36, atLarge(36), { status: "pending" });
  await applyOne(db, await submitDs(db, E_MUNI, 36, atLarge(36)));
  assertEquals((await one<{ status: string }>(db, `SELECT status FROM policy_jp.contributions WHERE id = $1`, [dup])).status, "superseded");
  await db.close();
});

// =============================================================================================
// f. 還原驗證・冪等・權限
// =============================================================================================
Deno.test("自我檢查（還原驗證）：規則が閉じている／after_step がある／cap なし／総表の分支・臂名・順位・型別清單・分派器・觸發器の型別・anon が欠ける／あると、migration が失敗する；元の SQL は通る", async () => {
  const pre = await migratedDb({ before: MIG_FILE });
  const bad = async (from: string, to: string, why: string) => {
    await assertRejects(() => pre.exec(mutate(MIG_SQL, from, to)), Error, undefined, why);
  };
  await bad(`'announced', ARRAY['pref_assembly', 'muni_assembly']::TEXT[], true,`, `'announced', ARRAY['pref_assembly', 'muni_assembly']::TEXT[], false,`, "規則が閉じている");
  await bad(`SELECT 'district_seats', 'event', 'polling', 0,`, `SELECT 'district_seats', 'event', 'polling', 1,`, "窓が違う");
  await bad(`'{"cap":100}'::JSONB,\n       '議員定数`, `'{}'::JSONB,\n       '議員定数`, "cap なし");
  await bad(`  UNION ALL SELECT 'district_seats' AS arm, t.* FROM policy_jp.contribution_auto_tasks_district_seats() t\n`, "", "総表の分支が欠ける");
  await bad(`    'policy_elements',\n    'district_seats'\n  ]`, `    'policy_elements'\n  ]`, "臂名が欠ける");
  await bad(`                  WHEN 'district_seats_missing' THEN 4\n`, "", "順位が欠ける");
  await bad(`'policy_elements', 'district_seats', 'no_change']::TEXT[]`, `'policy_elements', 'no_change']::TEXT[]`, "apply_types に無い");
  await bad(`               WHEN 'district_seats' THEN policy_jp.apply_district_seats(c)\n`, "", "apply_contribution の WHEN が無い");
  await bad(`  IF p_type = 'district_seats' THEN\n    RETURN policy_jp.same_claim_matches_district_seats(COALESCE(p_payload, '{}'::JSONB), p_ip_hash, p_exclude);\n  END IF;\n`, "", "分派器に分岐が無い");
  await bad(`'policy_elements', 'district_seats'))\n  EXECUTE FUNCTION`, `'policy_elements'))\n  EXECUTE FUNCTION`, "収編觸發器の型別に無い");
  await bad(`  policy_jp.district_seats_normalize(JSONB), policy_jp.district_seats_signature(JSONB), policy_jp.same_claim_matches_district_seats(JSONB, TEXT, UUID)
  TO service_role;`, `  policy_jp.district_seats_normalize(JSONB), policy_jp.district_seats_signature(JSONB), policy_jp.same_claim_matches_district_seats(JSONB, TEXT, UUID)
  TO service_role, anon;`, "anon に渡す");
  await pre.exec(MIG_SQL);
  await pre.close();
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則・主控台登記が増えない（規則は開いたまま）", async () => {
  const db = await freshDb();
  const n = () => Promise.all([count(db, `SELECT 1 FROM policy_jp.activity_rules`), count(db, `SELECT 1 FROM policy_jp.console_arm_stage_map`)]);
  const before = await n();
  await db.exec(MIG_SQL);
  assertEquals(await n(), before);
  assertEquals((await one<{ e: boolean }>(db, `SELECT enabled AS e FROM policy_jp.activity_rules WHERE activity = 'district_seats' AND priority IS NULL`)).e, true);
  await db.close();
});

Deno.test("緊接在前一版：総表・臂名・順位は前の版に『1 行足しただけ』（残りは一字も変えない）", () => {
  const strip = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  assertEquals(strip(fnText(MIG_SQL, TOTAL)).replace(" UNION ALL SELECT 'district_seats' AS arm, t.* FROM policy_jp.contribution_auto_tasks_district_seats() t", ""), strip(fnText(PREV_PE, TOTAL)));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.chain_step_rank")).replace(" WHEN 'district_seats_missing' THEN 4", ""), strip(fnText(PREV_PE, "policy_jp.chain_step_rank")));
  assertEquals(strip(fnText(MIG_SQL, "policy_jp.activity_arm_names")).replace(", 'district_seats'", ""), strip(fnText(PREV_PE, "policy_jp.activity_arm_names")));
});

Deno.test("権限：新しい関数は anon／authenticated が呼べない（service_role は呼べる）", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assertRejects(() => asRole(shared, role, `SELECT * FROM policy_jp.contribution_auto_tasks_district_seats()`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.district_seats_normalize('{}'::JSONB)`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.district_seats_signature('{}'::JSONB)`), Error, "permission denied");
    await assertRejects(() => asRole(shared, role, `SELECT policy_jp.same_claim_matches_district_seats('{}'::JSONB, NULL, NULL)`), Error, "permission denied");
  }
  assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_district_seats()`))[0].n, 0);
});
