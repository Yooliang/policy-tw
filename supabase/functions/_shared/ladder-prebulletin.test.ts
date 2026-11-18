/**
 * 查核階梯不計「公報索引上架前的查無」（規則 D 重做，migration 20261118110000_ladder_ignore_prebulletin_v2.sql）——PGlite 真的執行新版函式：
 * task_prebulletin_cutoffs、task_check_prebulletin_cutoff、task_check_cooldown_days_for、work_key_ladder_state、work_key_ladder_states、refresh_dispatch_blocked。
 *
 *   1. 公報上架前的 4 次查無不結案、不冷卻；上架後的第一次查無從階梯第 1 格（5 天）開始（單卡版與集合版）
 *   2. 只排除補政見卡的 not_found：confirmed、其他任務型別、沒有公報的候選人一律照舊
 *   3. 邊界：截止＝上架日隔天 00:00 UTC；前一分鐘排除、後一分鐘計入
 *   4. 只涵蓋參選紀錄直接對選舉單位的屆別（2022／2024 不在範圍）；退選的人沒有公報
 *   5. 手動任務（uuid task_id）與 auto 共用工作卡同樣排除；refresh_dispatch_blocked 開頭「手動任務自己的查核」結案段（#979）同樣排除
 *   6. 集合版與單卡版逐卡逐欄一致（含被排除的列）；未受影響的卡與規則 D 之前的行為相同
 *   7. 文字層：不動資料列；集合版只呼叫一次 task_prebulletin_cutoffs、不呼叫單卡版與 politician_bulletins 視圖（#977 慢的原因）
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261111100000_work_key.sql";
const NEW_NAME = "20261118110000_ladder_ignore_prebulletin_v2.sql";
const MIG = await readMig(MIG_NAME);
const NEW = await readMig(NEW_NAME);
const P1 = "0000b296-7ae8-4184-b704-c69d44cb696a"; // 2026 縣市長，有公報
const P2 = "ffd273b3-1d4c-45d5-bf61-b5b418f87233"; // 2026 縣市長，沒有公報（乙縣沒索引）
const P3 = "01c8a200-2fb6-4ff0-afdd-175e9a4643a9"; // 2022 有公報（不在規則範圍）
const P4 = "4444b296-7ae8-4184-b704-c69d44cb696a"; // 2026 退選：沒有公報
const MANUAL = "11111111-1111-4111-8111-111111111111";
const MANUAL2 = "22222222-2222-4222-8222-222222222222";

// 上架日＝前天（所以截止＝昨天 00:00 UTC，上架前的查核落在 1～10 天前，仍在冷卻窗口內，沒排除就會冷卻）
const CUT = "((current_date - 1)::timestamp AT TIME ZONE 'UTC')";

async function buildDb(): Promise<PGlite> {
  const db = new PGlite();
  const before = (n: string) => latestFn(n, MIG_NAME);
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date, election_reason text);
    INSERT INTO elections VALUES (2026, '2026-11-28', 'regular');
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT current_date $$;
    CREATE TABLE task_check_ladder_settings (outcome text PRIMARY KEY, days integer[] NOT NULL);
    INSERT INTO task_check_ladder_settings VALUES ('not_found', ARRAY[5, 10, 20]), ('confirmed', ARRAY[5, 10]);
    CREATE TABLE task_cooldown_settings (id smallint PRIMARY KEY, enabled boolean NOT NULL DEFAULT true, not_found_first_days integer NOT NULL DEFAULT 14,
      not_found_repeat_days integer NOT NULL DEFAULT 30, task_types text[] NOT NULL DEFAULT ARRAY['progress_stale', 'deadline_due']);
    INSERT INTO task_cooldown_settings (id) VALUES (1);
    ${await before("uuid_or_null")}
    ${await before("election_id_or_null")}
    ${await before("campaign_election_id")}
    ${await before("task_rekey_arms")}
    ${await before("task_check_cooldown_days")}
    ${await before("task_unreachable_cooldown_days")}
    ${await before("task_not_found_cooldown_days")}
    ${await before("task_check_ladder_days")}
    ${await before("task_check_ladder_exempt")}
    ${await before("task_cooldown_max_days")}
    ${await before("task_queue_key")}
    CREATE TABLE queue_settings (id smallint PRIMARY KEY, dispatch_horizon_seconds integer NOT NULL DEFAULT 86400);
    INSERT INTO queue_settings (id) VALUES (1);
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, task_type text, target jsonb, status text NOT NULL DEFAULT 'open', closed_at timestamptz);
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, target jsonb NOT NULL DEFAULT '{}'::jsonb, work_key text, blocked boolean NOT NULL DEFAULT false,
      cooling boolean NOT NULL DEFAULT false, cool_until timestamptz, last_dispatched_at timestamptz NOT NULL DEFAULT now(), priority_seconds integer NOT NULL DEFAULT 0,
      boost_seconds bigint NOT NULL DEFAULT 0);
    CREATE FUNCTION roster_group_person_status() RETURNS TABLE (cid text, closed boolean, cool_until timestamptz) LANGUAGE sql AS $$ SELECT NULL::text, NULL::boolean, NULL::timestamptz WHERE false $$;
    CREATE FUNCTION roster_group_check_task_id(a text, b text, c text) RETURNS text LANGUAGE sql AS $$ SELECT 'x:' || a $$;
    CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text NOT NULL, outcome text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), work_key text);
    ${fnText(MIG, "task_work_key_fp_arms")}
    ${fnText(MIG, "task_work_key")}
    ${fnText(MIG, "work_key_fill")}
    CREATE TRIGGER trg_task_checks_work_key BEFORE INSERT OR UPDATE OF task_id ON task_checks FOR EACH ROW EXECUTE FUNCTION work_key_fill();
    -- 參選紀錄 → 選舉單位 → 公報索引（規則 D 的三張表）
    CREATE TABLE politicians (id uuid PRIMARY KEY, merged_into uuid);
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE politician_elections (politician_id uuid, election_id integer, election_type text, region_id integer, candidacy_status text, PRIMARY KEY (politician_id, election_id));
    CREATE TABLE election_bulletins (election_id integer, election_type text, region text, sub_region text NOT NULL DEFAULT '', village text NOT NULL DEFAULT '', listed_on date NOT NULL);
    INSERT INTO politicians VALUES ('${P1}', NULL), ('${P2}', NULL), ('${P3}', NULL), ('${P4}', NULL);
    INSERT INTO regions VALUES (1, '甲縣', NULL, NULL), (2, '乙縣', NULL, NULL);
    INSERT INTO politician_elections VALUES ('${P1}', 2026, '縣市長', 1, 'filed'), ('${P2}', 2026, '縣市長', 2, 'filed'),
      ('${P3}', 2022, '縣市長', 1, 'not_elected'), ('${P4}', 2026, '縣市長', 1, 'withdrawn');
    INSERT INTO election_bulletins VALUES (2026, '縣市長', '甲縣', '', '', current_date - 2), (2022, '縣市長', '甲縣', '', '', current_date - 2);
    ${fnText(NEW, "task_prebulletin_cutoffs")}
    ${fnText(NEW, "task_check_prebulletin_cutoff")}
    ${fnText(NEW, "task_check_cooldown_days_for")}
    ${fnText(NEW, "work_key_ladder_state")}
    ${fnText(NEW, "work_key_ladder_states")}
    ${fnText(NEW, "refresh_dispatch_blocked")}
  `);
  return db;
}

/** 在「截止時間＋offset」寫一筆查核（offset 是 SQL interval 字串，例：'-1 day'、'1 hour'） */
const atCut = (db: PGlite, taskId: string, outcome: string, offset: string, workKey: string | null = null) =>
  db.query(`INSERT INTO task_checks (task_id, outcome, checked_at, work_key) VALUES ($1, $2, ${CUT} + $3::interval, $4)`, [taskId, outcome, offset, workKey]);
const days = async (db: PGlite, checkId: number): Promise<number> =>
  (await db.query<{ d: number }>("SELECT task_check_cooldown_days_for(task_id, outcome, checked_at, id) AS d FROM task_checks WHERE id = $1", [checkId])).rows[0].d;
const state = async (db: PGlite, wk: string) =>
  (await db.query<{ checks: number; closed: boolean; cool: boolean; cc: boolean }>(
    `SELECT checks::int AS checks, closed, (cool_until IS NOT NULL) AS cool, (check_cool_until IS NOT NULL) AS cc FROM work_key_ladder_state('${wk}')`)).rows[0];
const setState = async (db: PGlite, wk: string) =>
  (await db.query<{ checks: number; closed: boolean; cool: boolean }>(
    `SELECT checks::int AS checks, closed, (cool_until IS NOT NULL) AS cool FROM work_key_ladder_states() WHERE work_key = '${wk}'`)).rows[0];
const four = ["-8 days", "-6 days", "-4 days", "-2 days"]; // 都在截止之前（≥1 天前），且都在冷卻窗口內

Deno.test("1 公報上架前的 4 次查無不結案、不冷卻；上架後第一次查無從第 1 格（5 天）開始", async () => {
  const db = await buildDb();
  const pm = `auto:policy_missing:${P1}`;
  const wk = `politician:${P1}:policies:2026`;
  for (const o of four) await atCut(db, pm, "not_found", o);
  assertEquals(await state(db, wk), { checks: 0, closed: false, cool: false, cc: false }, "單卡版：4 次都在上架前，累計 0、沒結案、沒冷卻");
  assertEquals(await setState(db, wk), undefined, "集合版：整張卡都被排除＝不回列（refresh 不會把它當冷卻或結案）");
  await atCut(db, pm, "not_found", "1 hour"); // id 5：上架後第一次
  assertEquals(await days(db, 5), 5, "上架後第一次查無＝階梯第 1 格");
  assertEquals((await state(db, wk)).checks, 1);
  assertEquals(await setState(db, wk), { checks: 1, closed: false, cool: true });
});

Deno.test("2 只排除補政見卡的 not_found：confirmed、其他任務型別、沒有公報的候選人照舊", async () => {
  const db = await buildDb();
  await atCut(db, `auto:policy_missing:${P1}`, "confirmed", "-4 days");
  assertEquals((await state(db, `politician:${P1}:policies:2026`)).checks, 1, "confirmed 不排除");
  for (const o of four) await atCut(db, `auto:policy_missing:${P2}`, "not_found", o);
  assertEquals((await state(db, `politician:${P2}:policies:2026`)).closed, true, "沒有公報的人不套新規則：4 次照樣結案");
  assertEquals((await setState(db, `politician:${P2}:policies:2026`)).closed, true, "集合版同");
  await atCut(db, `auto:profile_gap:${P1}`, "not_found", "-4 days");
  assertEquals((await state(db, `politician:${P1}:profile`)).checks, 1, "補基本資料的查無照算");
  assertEquals((await db.query("SELECT task_check_prebulletin_cutoff($1) AS c", [`politician:${P1}:profile`])).rows[0], { c: null }, "不是補政見卡＝NULL");
});

Deno.test("3 邊界：截止＝上架日隔天 00:00 UTC；前一分鐘排除、後一分鐘計入", async () => {
  const db = await buildDb();
  const pm = `auto:policy_missing:${P1}`;
  await atCut(db, pm, "not_found", "-1 minute"); // 截止前 → 排除
  await atCut(db, pm, "not_found", "1 minute"); // 截止後 → 計
  const wk = `politician:${P1}:policies:2026`;
  assertEquals((await state(db, wk)).checks, 1, "單卡版：只有截止後那一筆計入階梯");
  assertEquals((await setState(db, wk)).checks, 1, "集合版同");
  const cut = (await db.query<{ ok: boolean }>(`SELECT task_check_prebulletin_cutoff($1) = ${CUT} AS ok`, [wk])).rows[0];
  assertEquals(cut.ok, true, "截止＝listed_on + 1 的 00:00 UTC");
});

Deno.test("4 只涵蓋參選紀錄直接對選舉單位的屆別：2022 不在範圍；退選沒有公報；屆別要對得上", async () => {
  const db = await buildDb();
  await atCut(db, `auto:term_policy_missing:${P3}:2022`, "not_found", "-4 days");
  assertEquals((await state(db, `politician:${P3}:policies:2022`)).checks, 1, "2022 的查無照算（姓名比對那條不在規則範圍）");
  await atCut(db, `auto:policy_missing:${P4}`, "not_found", "-4 days");
  assertEquals((await state(db, `politician:${P4}:policies:2026`)).checks, 1, "退選的人沒有公報，照算");
  await atCut(db, `auto:policy_missing:${P1}`, "not_found", "-4 days", `politician:${P1}:policies:2030`);
  assertEquals((await state(db, `politician:${P1}:policies:2030`)).checks, 1, "那一屆沒有他的參選紀錄＝沒有公報，照算");
  assertEquals((await db.query("SELECT count(*)::int AS n FROM task_prebulletin_cutoffs()")).rows[0], { n: 1 }, "集合函式只列 2026 有公報的 P1（P2 乙縣沒索引、P4 退選、2022 不在範圍）");
});

Deno.test("5 手動任務與 auto 共用工作卡同樣排除；refresh 開頭的手動任務結案段（#979）也排除", async () => {
  const db = await buildDb();
  const wk = `politician:${P1}:policies:2026`;
  await atCut(db, MANUAL, "not_found", "-8 days", wk);
  await atCut(db, `auto:policy_missing:${P1}`, "not_found", "-6 days");
  assertEquals((await state(db, wk)).checks, 0, "手動與 auto 的上架前查無都不計");
  await atCut(db, MANUAL, "not_found", "1 hour", wk);
  assertEquals((await state(db, wk)).checks, 1, "上架後的手動查無照算");
  // 手動任務結案段：MANUAL 自己 4 筆查無，只有 1 筆在上架後 → 不結案；沒有公報的 MANUAL2 4 筆 → 照舊結案
  await db.query(`INSERT INTO contribution_tasks (id, task_type, target) VALUES ('${MANUAL}', 'x', '{}'), ('${MANUAL2}', 'x', '{}')`);
  for (const o of ["-4 days", "-2 days"]) await atCut(db, MANUAL, "not_found", o, wk);
  const wk2 = `politician:${P2}:policies:2026`;
  for (const o of four) await atCut(db, MANUAL2, "not_found", o, wk2);
  await db.query("SELECT refresh_dispatch_blocked()");
  const st = (await db.query<{ id: string; status: string }>("SELECT id::text, status FROM contribution_tasks ORDER BY id")).rows;
  assertEquals(st, [{ id: MANUAL, status: "open" }, { id: MANUAL2, status: "closed" }],
    "MANUAL 自己 4 筆查無只有 1 筆計入、不結案；沒有公報的 MANUAL2 照舊 4 次結案");
});

Deno.test("6 集合版與單卡版逐卡逐欄一致（含被排除的列）；規則 D 沒碰到的卡與沒有公報時的算法相同", async () => {
  const db = await buildDb();
  let s = 7;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const outs = ["not_found", "not_found", "not_found", "confirmed", "unreachable"];
  const offs = ["-9 days", "-7 days", "-5 days", "-3 days", "-1 minute", "1 minute", "6 hours", "12 hours"];
  const syn = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const cards: { p: string; wk: string }[] = [
    { p: P1, wk: `politician:${P1}:policies:2026` }, { p: P2, wk: `politician:${P2}:policies:2026` },
    { p: P3, wk: `politician:${P3}:policies:2022` }, { p: P4, wk: `politician:${P4}:policies:2026` },
    ...Array.from({ length: 36 }, (_, i) => ({ p: syn(i), wk: i % 5 === 0 ? `politician:${syn(i)}:profile` : `politician:${syn(i)}:policies:2026` })),
  ];
  for (const [i, c] of cards.entries()) {
    const n = i === 0 ? 8 : 1 + Math.floor(rnd() * 5);
    for (let k = 0; k < n; k++) {
      const task = rnd() < 0.2 ? MANUAL : `auto:policy_missing:${c.p}`;
      await atCut(db, task, outs[Math.floor(rnd() * outs.length)], offs[Math.floor(rnd() * offs.length)], c.wk);
    }
  }
  const cols = "checks, closed, closed_at, last_checked_at, cool_until, check_cool_until";
  const one = `SELECT k.work_key, s.* FROM (SELECT DISTINCT work_key FROM task_checks WHERE work_key IS NOT NULL) k CROSS JOIN LATERAL work_key_ladder_state(k.work_key) s`;
  const set = `SELECT work_key, ${cols} FROM work_key_ladder_states()`;
  assertEquals((await db.query(`${set} EXCEPT ${one}`)).rows, [], "集合版有、單卡版沒有或不同");
  // 單卡版對「整張卡都被排除」的卡會回一列全空；集合版不回列
  const onlyOne = (await db.query(`${one} EXCEPT ${set}`)).rows as { checks: number; closed: boolean; closed_at: unknown; last_checked_at: unknown; cool_until: unknown; check_cool_until: unknown }[];
  assertEquals(onlyOne.filter((x) => !(x.checks == 0 && !x.closed && !x.closed_at && !x.last_checked_at && !x.cool_until && !x.check_cool_until)), [],
    "單卡版有、集合版沒有的卡，只能是整張卡都被排除的空狀態");
  const n = (await db.query<{ cards: number; closed: number; cool: number }>(
    `SELECT count(*)::int AS cards, count(*) FILTER (WHERE closed)::int AS closed, count(*) FILTER (WHERE cool_until IS NOT NULL)::int AS cool FROM work_key_ladder_states()`)).rows[0];
  assert(n.cards >= 15 && n.closed >= 1 && n.cool >= 5, `資料覆蓋不足：${JSON.stringify(n)}`);
  // 沒被規則 D 排除任何列的卡：與公報表清空（等於沒有規則 D）時的結果完全相同
  const keep = `work_key NOT IN (SELECT tc.work_key FROM task_checks tc WHERE tc.outcome = 'not_found' AND tc.work_key LIKE 'politician:%:policies:2026' AND tc.checked_at < ${CUT} AND tc.work_key LIKE '%:${P1}:%')`;
  const withD = (await db.query(`SELECT work_key, ${cols} FROM work_key_ladder_states() WHERE ${keep} ORDER BY work_key`)).rows;
  await db.query("DELETE FROM election_bulletins");
  const noD = (await db.query(`SELECT work_key, ${cols} FROM work_key_ladder_states() WHERE ${keep} ORDER BY work_key`)).rows;
  assert(withD.length >= 10, `未受影響的卡太少（${withD.length}）`);
  assertEquals(withD, noD, "沒受影響的卡與規則 D 之前相同");
});

Deno.test("7 文字層：不動資料列；集合版整表只算一次截止、不呼叫單卡版與 politician_bulletins 視圖", () => {
  const code = NEW.replace(/--.*$/gm, "");
  assert(!/UPDATE task_checks|DELETE FROM task_checks|INSERT INTO task_checks/.test(code), "不動資料列");
  const agg = fnText(NEW, "work_key_ladder_states").replace(/--.*$/gm, "");
  assertEquals(agg.split("task_prebulletin_cutoffs()").length - 1, 1, "集合版只呼叫一次 task_prebulletin_cutoffs()");
  assert(!agg.includes("task_check_prebulletin_cutoff") && !agg.includes("politician_bulletins") && !agg.includes("work_key_ladder_state("), "集合版不逐卡呼叫");
  assert(!fnText(NEW, "task_prebulletin_cutoffs").includes("politician_bulletins"), "截止集合不經過視圖（#977 慢的原因）");
  assert(!fnText(NEW, "task_prebulletin_cutoffs").includes("unnest"), "不展開網址陣列");
});
