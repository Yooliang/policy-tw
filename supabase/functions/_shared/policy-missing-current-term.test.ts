/**
 * 承諾缺口只算當屆、缺口仍在不收回、村里長與鄉鎮市民代表等公報（migration 20261019110000_pledge_gap_2026.sql；#679 PR 1，維護者 2026-10-19）。
 *
 *   A. 文字層：raw 從 profile_gap 分支起、mayor_policies 除了一處之外，一字不差等於前一版（20261011300000）；只動了我們說的那幾處。
 *   B. PGlite（行為層）：缺口定義（沒有當屆承諾才算；舊屆政見不關缺口；縣市長分工不重複）、
 *      policy_missing_gap_open 與兩支臂逐人一致、觸發器（缺口還在不收回、其他任務與型別照舊）、說明文字。
 *   C. 窗口：用真的 activity_open（arm_windows_13 版）＋P0／P1 的規則表與里程碑：公報預估日不算，里程碑 done 才開，投票日後收；
 *      議員等其他職位不受影響。
 *   還原驗證：每一條都有「拿掉被守的東西，確認會紅」。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { buildArmsDb, fnText, latestFn, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261019110000_pledge_gap_2026.sql";
const MIG = await readMig(MIG_NAME);
const PREV_NAME = "20261011300000_campaign_election_arms.sql";
const PREV = await readMig(PREV_NAME);
const RAW = "contribution_auto_tasks_raw";
const MAYOR = "contribution_auto_tasks_mayor_policies";
const section = (sql: string, from: string, to?: string) => sql.slice(sql.indexOf(from), to ? sql.indexOf(to) : undefined);

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 前一版是 20261011300000，中間沒有人插一版", async () => {
  for (const arm of [RAW, MAYOR]) {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${arm}(`)) defining.push(n);
    const i = defining.indexOf(MIG_NAME);
    assert(i > 0, `${arm}：這支要在重新定義的清單裡`);
    assertEquals(defining[i - 1], PREV_NAME, `${arm}：前一版變了，要以最新的為底重做`);
  }
});

Deno.test("A2 raw：從 profile_gap 分支起一字不差等於前一版（只動 policy_missing 這一個分支與 CTE 開頭）", async () => {
  const prev = await latestFn(RAW, MIG_NAME);
  const neu = fnText(MIG, RAW);
  const tail = (f: string) => f.slice(f.indexOf("  UNION ALL\n  SELECT 'auto:profile_gap:'"));
  assert(tail(neu).length > 5000);
  assertEquals(tail(neu), tail(prev));
});

Deno.test("A3 mayor_policies：前一版只改當屆承諾數那一處", async () => {
  const prev = await latestFn(MAYOR, MIG_NAME);
  const neu = fnText(MIG, MAYOR);
  const undone = neu.replace(" AND is_campaign_pledge(pl.status::TEXT, pl.origin)) AS n_cur,", ") AS n_cur,");
  assertEquals(undone, prev);
});

Deno.test("A4 新增的函式只有 is_campaign_pledge、policy_missing_gap_open；不碰 seed、task_dispatches_queue_key、task_boost", () => {
  const code = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assertEquals([...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]).sort(), [MAYOR, RAW, "is_campaign_pledge", "policy_missing_gap_open"].sort());
  for (const banned of ["seed_auto_task_queue", "task_dispatches_queue_key", "task_boost", "DELETE FROM", "DROP TABLE"]) assert(!code.includes(banned), banned);
});

// ============================================================
// B. PGlite：缺口與觸發器
// ============================================================
const HELPERS = section(PREV, "-- 1. 當屆與年份", "-- 2. 規則 mayor_policies");
const PLEDGE_FN = fnText(MIG, "is_campaign_pledge");
const GAP_FN = fnText(MIG, "policy_missing_gap_open");
const TRIGGER_SQL = section(MIG, "DROP TRIGGER IF EXISTS contributions_drop_dispatch", "-- 6. 公報前");

/** raw 的 policy_missing 分支（到 UNION ALL profile_gap 之前）包成函式；其他分支各有自己的測試 */
function rawPmSql(raw = fnText(MIG, RAW)): string {
  const body = raw.slice(raw.indexOf("  WITH cur AS"), raw.indexOf("  UNION ALL\n  SELECT 'auto:profile_gap:'"));
  return `CREATE FUNCTION raw_pm() RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $f$\n${body}\n$f$;`;
}

async function freshDb(opts: { raw?: string; trigger?: string; mayor?: string } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE elections (id INTEGER PRIMARY KEY, election_date DATE, election_reason TEXT);
    INSERT INTO elections VALUES (2022, '2022-11-26', 'regular'), (2024, '2024-01-13', 'regular'), (2026, '2026-11-28', 'regular');
    CREATE FUNCTION activity_today() RETURNS DATE LANGUAGE sql STABLE AS $$ SELECT '2026-10-19'::DATE $$;
    CREATE TABLE activity_rules (id BIGSERIAL PRIMARY KEY, activity TEXT, priority INTEGER, enabled BOOLEAN DEFAULT true, params JSONB DEFAULT '{}');
    INSERT INTO activity_rules (activity, priority, params) VALUES ('mayor_policies', NULL, '{"election_types": ["縣市長"], "max_policies": 5}');
    CREATE TABLE regions (id INTEGER PRIMARY KEY, region TEXT);
    CREATE TABLE politicians (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, party TEXT, birth_year INTEGER, current_position TEXT, avatar_url TEXT, region TEXT, merged_into UUID);
    CREATE TABLE politician_elections (id SERIAL PRIMARY KEY, politician_id UUID, election_id INTEGER, election_type TEXT, region_id INTEGER, candidacy_status TEXT, source_note TEXT, withdrawn_after_filing BOOLEAN);
    CREATE TABLE policies (id SERIAL PRIMARY KEY, politician_id UUID, election_id INTEGER, status TEXT, origin TEXT, removed_at TIMESTAMPTZ, category TEXT);
    CREATE TABLE contributions (id SERIAL PRIMARY KEY, task_id TEXT, contribution_type TEXT, status TEXT, payload JSONB DEFAULT '{}');
    CREATE TABLE task_dispatches (task_id TEXT PRIMARY KEY);
    CREATE FUNCTION candidacy_protocol_status(s TEXT, d DATE) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT s $$;
    CREATE FUNCTION candidacy_list_published(a INTEGER, b TEXT, c DATE) RETURNS DATE LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::DATE $$;
    CREATE FUNCTION task_dispatches_drop_applied() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.task_id IS NOT NULL AND NEW.task_id LIKE 'auto:%' THEN DELETE FROM task_dispatches WHERE task_id = NEW.task_id; END IF;
      RETURN NEW;
    END $$;
  `);
  await db.exec(await latestFn("uuid_or_null"));
  await db.exec(HELPERS);
  await db.exec(PLEDGE_FN);
  await db.exec(rawPmSql(opts.raw));
  await db.exec(opts.mayor ?? fnText(MIG, MAYOR));
  await db.exec(GAP_FN);
  await db.exec(opts.trigger ?? TRIGGER_SQL);
  return db;
}

type Pol = { eid: number; status?: string; origin?: string | null; removed?: boolean };
async function person(db: PGlite, name: string, type: string, cs: string, policies: Pol[] = [], eid = 2026): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`INSERT INTO politicians (name, party, region) VALUES ($1, '無', '某縣') RETURNING id`, [name]);
  const id = rows[0].id;
  await db.query(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status) VALUES ($1, $2, $3, $4)`, [id, eid, type, cs]);
  for (const p of policies) {
    await db.query(`INSERT INTO policies (politician_id, election_id, status, origin, removed_at, category) VALUES ($1, $2, $3, $4, $5, '教育')`,
      [id, p.eid, p.status ?? "Campaign Pledge", p.origin ?? null, p.removed ? "2026-10-01" : null]);
  }
  return id;
}
const pledge = (eid: number, n = 1): Pol[] => Array.from({ length: n }, () => ({ eid }));

async function gapIds(db: PGlite): Promise<Set<string>> {
  const a = await db.query<{ t: string }>("SELECT task_id AS t FROM raw_pm()");
  const b = await db.query<{ t: string }>(`SELECT task_id AS t FROM ${MAYOR}()`);
  const all = [...a.rows, ...b.rows].map((r) => r.t.replace("auto:policy_missing:", ""));
  assertEquals(new Set(all).size, all.length, "raw 與 mayor_policies 不重複派同一個人（同一個 task_id）");
  return new Set(all);
}

Deno.test("B1 缺口＝沒有當屆承諾：舊屆政見不關缺口；非承諾的當屆政見、被移除的承諾也不算", async () => {
  const db = await freshDb();
  const none = await person(db, "沒政見", "縣市議員", "filed");
  const old = await person(db, "只有舊屆", "縣市議員", "filed", [...pledge(2022, 2), ...pledge(2024)]);
  const has = await person(db, "有承諾", "縣市議員", "filed", pledge(2026));
  const notPledge = await person(db, "當屆非承諾", "縣市議員", "filed", [{ eid: 2026, status: "In Progress" }]);
  const origin = await person(db, "origin 是 pledge", "縣市議員", "filed", [{ eid: 2026, status: "In Progress", origin: "pledge" }]);
  const removed = await person(db, "承諾被移除", "縣市議員", "filed", [{ eid: 2026, removed: true }]);
  const wd = await person(db, "退選", "縣市議員", "withdrawn");
  const village = await person(db, "村里長", "村里長", "filed", pledge(2022));
  const oldYear = await person(db, "舊屆參選", "縣市議員", "filed", [], 2022);
  const ids = await gapIds(db);
  assertEquals(ids, new Set([none, old, notPledge, removed, village]));
  for (const x of [has, origin, wd, oldYear]) assert(!ids.has(x));
  await db.close();
});

Deno.test("B2 縣市長：已有政見的由 mayor_policies 派（當屆承諾＋等票 < 5），沒政見的由 raw 派；兩邊不重複", async () => {
  const db = await freshDb();
  const none = await person(db, "縣市長零政見", "縣市長", "filed");
  const old = await person(db, "縣市長只有舊屆", "縣市長", "filed", pledge(2022, 3));
  const four = await person(db, "縣市長四條", "縣市長", "declared", pledge(2026, 4));
  const five = await person(db, "縣市長五條", "縣市長", "filed", pledge(2026, 5));
  const queued = await person(db, "縣市長四條加一條等票", "縣市長", "filed", pledge(2026, 4));
  await db.query(`INSERT INTO contributions (task_id, contribution_type, status, payload) VALUES (NULL, 'policy', 'pending', $1)`, [JSON.stringify({ politician_id: queued, election_id: 2026 })]);
  const considering = await person(db, "縣市長還在考慮", "縣市長", "considering", pledge(2022));
  const ids = await gapIds(db);
  assertEquals(ids, new Set([none, old, four, considering]), "considering（還在考慮）不是 declared／filed，mayor 臂不收，raw 臂照一般候選人收");
  assert(!ids.has(five) && !ids.has(queued));
  await db.close();
});

Deno.test("B3 policy_missing_gap_open 與兩支臂逐人一致（每一種人）", async () => {
  const db = await freshDb();
  await person(db, "a", "縣市議員", "filed");
  await person(db, "b", "縣市議員", "filed", pledge(2022));
  await person(db, "c", "縣市議員", "filed", pledge(2026));
  await person(db, "d", "縣市長", "filed");
  await person(db, "e", "縣市長", "filed", pledge(2022, 2));
  await person(db, "f", "縣市長", "filed", pledge(2026, 4));
  await person(db, "g", "縣市長", "filed", pledge(2026, 5));
  await person(db, "h", "縣市長", "declared", [...pledge(2022), ...pledge(2026, 2)]);
  await person(db, "i", "縣市長", "considering", pledge(2022));
  await person(db, "j", "縣市長", "withdrawn", pledge(2022));
  await person(db, "k", "村里長", "filed", pledge(2022));
  const q = await person(db, "l", "縣市長", "filed", pledge(2026, 4));
  await db.query(`INSERT INTO contributions (contribution_type, status, payload) VALUES ('policy', 'verified', $1)`, [JSON.stringify({ politician_id: q })]);
  await db.query(`INSERT INTO contributions (contribution_type, status, payload) VALUES ('policy', 'applied', $1)`, [JSON.stringify({ politician_id: q })]);
  const ids = await gapIds(db);
  const { rows } = await db.query<{ id: string; open: boolean }>("SELECT id, policy_missing_gap_open(id) AS open FROM politicians");
  assert(rows.length === 12);
  for (const r of rows) assertEquals(r.open, ids.has(r.id), `${r.id}`);
  assertEquals(rows.filter((r) => r.open).length, ids.size);
  assertEquals((await db.query<{ o: boolean }>("SELECT policy_missing_gap_open(NULL) AS o")).rows[0].o, false);
  await db.close();
});

Deno.test("B4 任務說明：講清楚要的是當屆承諾；名下有舊屆政見會寫出幾筆", async () => {
  const db = await freshDb();
  await person(db, "沒政見", "縣市議員", "filed");
  await person(db, "只有舊屆", "縣市議員", "filed", pledge(2022, 3));
  const { rows } = await db.query<{ name: string; t: string; target: Record<string, unknown> }>(
    "SELECT target->>'name' AS name, what_we_need AS t, target FROM raw_pm() ORDER BY 1");
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert(by["沒政見"].t.includes("目前沒有 2026 這一屆的承諾") && by["沒政見"].t.includes("名下目前 0 筆政見"));
  assert(by["只有舊屆"].t.includes("名下另有 3 筆過去任期或上屆的政見，不算這一屆"));
  for (const r of rows) {
    assert(r.t.includes("這件任務只收 2026 這一屆的承諾"));
    assert(r.t.includes("election_id 填 2026"));
    assert(!r.t.includes("也可提交"), "舊的「過去選舉的承諾也可提交」不能留");
    assertEquals(r.target.election_id, 2026);
  }
  await db.close();
});

// ---- 觸發器 ----
let seq = 0;
async function applyOne(db: PGlite, taskId: string, type: string): Promise<boolean> {
  await db.query(`INSERT INTO task_dispatches (task_id) VALUES ($1) ON CONFLICT DO NOTHING`, [taskId]);
  const { rows } = await db.query<{ id: number }>(`INSERT INTO contributions (task_id, contribution_type, status) VALUES ($1, $2, 'pending') RETURNING id`, [taskId, type]);
  seq++;
  await db.query(`UPDATE contributions SET status = 'applied' WHERE id = $1`, [rows[0].id]);
  return (await db.query(`SELECT 1 FROM task_dispatches WHERE task_id = $1`, [taskId])).rows.length === 1; // true＝派工列還在
}
const tid = (id: string) => `auto:policy_missing:${id}`;
/** 交件上線的瞬間：先把政見寫進 policies（落庫），再把交件標 applied */
async function landPolicy(db: PGlite, id: string, taskId: string, pol: Pol, type = "policy"): Promise<boolean> {
  await db.query(`INSERT INTO policies (politician_id, election_id, status, origin, category) VALUES ($1, $2, $3, $4, '交通')`, [id, pol.eid, pol.status ?? "Campaign Pledge", pol.origin ?? null]);
  return await applyOne(db, taskId, type);
}

Deno.test("B5 觸發器：交的是舊屆政見、缺口還在 → 派工列留著；交了當屆承諾、缺口補上 → 照舊收回", async () => {
  const db = await freshDb();
  const a = await person(db, "議員", "縣市議員", "filed");
  assertEquals(await landPolicy(db, a, tid(a), { eid: 2022 }), true, "交舊屆政見：缺口還在，不收回");
  assertEquals(await landPolicy(db, a, tid(a), { eid: 2024 }), true, "再交一份舊屆：還是不收回");
  assertEquals(await landPolicy(db, a, tid(a), { eid: 2026 }), false, "交了當屆承諾：缺口補上，收回");
  await db.close();
});

Deno.test("B6 觸發器：縣市長補到 5 條才收回，之前每一次都留在原位", async () => {
  const db = await freshDb();
  const m = await person(db, "縣市長", "縣市長", "filed", pledge(2026, 2));
  assertEquals(await landPolicy(db, m, tid(m), { eid: 2026 }), true, "3 條");
  assertEquals(await landPolicy(db, m, tid(m), { eid: 2026 }), true, "4 條");
  assertEquals(await landPolicy(db, m, tid(m), { eid: 2026 }), false, "5 條：夠了，收回");
  await db.close();
});

Deno.test("B7 觸發器：其他一律照舊（no_change、其他交件型別、其他任務、別人的 task_id）", async () => {
  const db = await freshDb();
  const a = await person(db, "議員", "縣市議員", "filed");
  assertEquals(await applyOne(db, tid(a), "no_change"), false, "查無仍收回（冷卻另有機制）");
  assertEquals(await applyOne(db, tid(a), "correction"), false, "policy 以外的交件型別照舊收回");
  assertEquals(await applyOne(db, `auto:profile_gap:${a}`, "policy"), false, "別的任務型別照舊");
  assertEquals(await applyOne(db, "auto:policy_missing:not-a-uuid", "policy"), false, "task_id 不是人物 uuid：照舊收回，不炸");
  assertEquals(await applyOne(db, "auto:roster_check:2026|縣市議員|臺北市", "candidacy"), true, "名單清查的既有排除還在");
  assertEquals(await applyOne(db, "auto:roster_check:2026|縣市議員|臺北市", "roster_check"), false);
  await db.close();
});

Deno.test("還原驗證：觸發器換回原本的 WHEN（沒有缺口仍在條件）→ 舊屆政見一上線就收回", async () => {
  const broken = mutate(TRIGGER_SQL,
    "\n                     AND NOT (NEW.task_id LIKE 'auto:policy_missing:%' AND NEW.contribution_type = 'policy'\n                              AND policy_missing_gap_open(uuid_or_null(substr(NEW.task_id, 21)))))",
    ")");
  const db = await freshDb({ trigger: broken });
  const a = await person(db, "議員", "縣市議員", "filed");
  assertEquals(await landPolicy(db, a, tid(a), { eid: 2022 }), false);
  await db.close();
});

Deno.test("還原驗證：缺口條件換回「名下沒有任何政見」→ 只有舊屆政見的人不再是缺口", async () => {
  const raw = mutate(fnText(MIG, RAW), "\n                      AND pl.election_id = c.eid AND is_campaign_pledge(pl.status::TEXT, pl.origin))", ")");
  const db = await freshDb({ raw });
  const old = await person(db, "只有舊屆", "縣市議員", "filed", pledge(2022));
  assert(!(await gapIds(db)).has(old));
  await db.close();
  const ok = await freshDb();
  const old2 = await person(ok, "只有舊屆", "縣市議員", "filed", pledge(2022));
  assert((await gapIds(ok)).has(old2));
  await ok.close();
});

Deno.test("還原驗證：拿掉縣市長分工 → raw 與 mayor_policies 派同一個人兩次", async () => {
  const raw = mutate(fnText(MIG, RAW), "    AND NOT (c.cs IN ('declared', 'filed') AND c.election_type = ANY ((SELECT mcfg.election_types FROM mcfg)::TEXT[])\n             AND EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL))\n", "");
  const db = await freshDb({ raw });
  await person(db, "縣市長只有舊屆", "縣市長", "filed", pledge(2022));
  let threw = false;
  try {
    await gapIds(db);
  } catch {
    threw = true;
  }
  assert(threw, "重複派工要被偵測到");
  await db.close();
});

// ============================================================
// C. 窗口：公報前村里長與鄉鎮市民代表不派，公報上架（里程碑 done）起開，投票日後收
// ============================================================
const VILLAGE_MIG = await readMig("20261009010000_village_chief_progress_cooling.sql");
const WIN13 = await readMig("20261011030000_arm_windows_13.sql");
const RULES_SQL = section(MIG, "DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM activity_rules WHERE id = 3", "-- 7. 自我檢查");
const SELF_CHECK = section(MIG, "-- 7. 自我檢查");

async function windowDb(): Promise<PGlite> {
  const db = await buildArmsDb({ migrationToday: "2026-10-19" });
  // 規則表欄位與現行 activity_open（村里長那支加了排除職位欄，arm_windows_13 換了 activity_open）；rule 3 照正式庫是第 3 號、到投票日為止
  await db.exec(section(VILLAGE_MIG, "ALTER TABLE activity_rules ADD COLUMN IF NOT EXISTS except_election_types", "ALTER TABLE activity_rules DROP CONSTRAINT IF EXISTS activity_rules_traffic_shape"));
  await db.exec("ALTER TABLE activity_rules ADD COLUMN IF NOT EXISTS requires_traffic BOOLEAN NOT NULL DEFAULT false");
  await db.exec(fnText(WIN13, "activity_open"));
  await db.exec("UPDATE activity_rules SET id = 3 WHERE activity = 'raw:policy_missing'");
  await db.exec("UPDATE activity_rules SET window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0 WHERE id = 3");
  await db.exec(`INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES (2026, 'bulletin_published', NULL, '2026-11-18', 'statutory', 'expected')`);
  return db;
}
async function isOpen(db: PGlite, type: string, day: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM activity_open('raw:policy_missing', 2026, $1, $2::date)`, [type, day]);
  return rows.length > 0;
}
const OTHERS = ["縣市長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區長", "直轄市山地原住民區民代表"];
const WAIT = ["村里長", "鄉鎮市民代表"];

Deno.test("C1 公報前村里長與鄉鎮市民代表不開、其他職位照開；預估的公報日不算", async () => {
  const db = await windowDb();
  await db.exec(RULES_SQL);
  for (const t of OTHERS) assertEquals(await isOpen(db, t, "2026-10-19"), true, t);
  for (const t of WAIT) for (const d of ["2026-10-19", "2026-11-17", "2026-11-18", "2026-11-25"]) assertEquals(await isOpen(db, t, d), false, `${t} ${d}：公報日還是預估（expected）`);
  await db.close();
});

Deno.test("C2 公報上架（里程碑改 done）後自動開，投票日當天還開、隔天收；不寫死日期", async () => {
  const db = await windowDb();
  await db.exec(RULES_SQL);
  // bulletin-watch 偵測到 → 日期改實際、狀態 done、依據 official
  await db.exec("UPDATE election_milestones SET on_date = '2026-11-20', status = 'done', basis = 'official' WHERE kind = 'bulletin_published' AND election_id = 2026");
  for (const t of WAIT) {
    assertEquals(await isOpen(db, t, "2026-11-19"), false, `${t}：公報上架日前一天`);
    assertEquals(await isOpen(db, t, "2026-11-20"), true, `${t}：公報上架日`);
    assertEquals(await isOpen(db, t, "2026-11-28"), true, `${t}：投票日當天`);
    assertEquals(await isOpen(db, t, "2026-11-29"), false, `${t}：投票日後交給補舊屆政見`);
  }
  for (const t of OTHERS) {
    assertEquals(await isOpen(db, t, "2026-11-28"), true, t);
    assertEquals(await isOpen(db, t, "2026-11-29"), false, t);
  }
  await db.close();
});

Deno.test("C3 重跑冪等（不重複插規則）；自我檢查通過；規則形狀改了自我檢查會停", async () => {
  const db = await windowDb();
  await db.exec(RULES_SQL);
  await db.exec(RULES_SQL.replace(/UPDATE activity_rules\n   SET except_election_types[^;]*;/, ""));
  assertEquals(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM activity_rules WHERE activity = 'raw:policy_missing'")).rows[0].n), 2);
  await db.exec(PLEDGE_FN);
  await db.exec(SELF_CHECK);
  await db.exec("INSERT INTO activity_rules (activity, window_kind) VALUES ('raw:policy_missing', 'always')");
  let threw = false;
  try {
    await db.exec(SELF_CHECK);
  } catch {
    threw = true;
  }
  assert(threw);
  await db.close();
});

Deno.test("還原驗證：新規則拿掉「done 才算」→ 預估的公報日就把村里長開了", async () => {
  const db = await windowDb();
  await db.exec(mutate(RULES_SQL, "'bulletin_published', 0, 'polling', 0, 'done'", "'bulletin_published', 0, 'polling', 0, 'expected'"));
  assertEquals(await isOpen(db, "村里長", "2026-11-18"), true, "壞掉的版本：預估日就開");
  await db.close();
});

Deno.test("還原驗證：規則 3 不排除村里長 → 公報前村里長照樣開", async () => {
  const db = await windowDb();
  await db.exec(mutate(RULES_SQL, "SET except_election_types = ARRAY['村里長', '鄉鎮市民代表'],", "SET"));
  assertEquals(await isOpen(db, "村里長", "2026-10-19"), true);
  await db.close();
});
