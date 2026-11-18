/**
 * 查核階梯不計「公報索引上架前的查無」（migration 20261118010000_ladder_ignore_prebulletin_checks.sql，方案 D）——PGlite 真的執行新版函式：
 * task_check_prebulletin_cutoff、task_check_cooldown_days_for、work_key_ladder_state。
 *
 *   1. 公報上架前的 4 次查無不結案、不冷卻；上架後的第一次查無從階梯第 1 格開始（5 天）
 *   2. 只排除補政見任務的 not_found：confirmed、其他任務型別、沒有公報的候選人一律照舊
 *   3. 邊界：截止＝上架日隔天 00:00 UTC（索引 19:00Z 才上線）；前一分鐘排除、後一分鐘計入
 *   4. 要有「那一屆」的公報才排除（工作卡的屆別對得上 politician_bulletins.election_id）
 *   5. 網站請求等手動任務（uuid task_id）與 auto 共用工作卡，同樣排除；文字層：不動資料列、簽名不變
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261111100000_work_key.sql";
const NEW_NAME = "20261118010000_ladder_ignore_prebulletin_checks.sql";
const MIG = await readMig(MIG_NAME);
const NEW = await readMig(NEW_NAME);
const P1 = "0000b296-7ae8-4184-b704-c69d44cb696a"; // 2026 有公報（上架日 11-17）
const P2 = "ffd273b3-1d4c-45d5-bf61-b5b418f87233"; // 沒有任何公報
const P3 = "01c8a200-2fb6-4ff0-afdd-175e9a4643a9"; // 只有 2022 的公報（上架日 10-06）

async function buildDb(): Promise<PGlite> {
  const db = new PGlite();
  const before = (n: string) => latestFn(n, MIG_NAME);
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date, election_reason text);
    INSERT INTO elections VALUES (2026, '2026-11-28', 'regular');
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-11-18' $$;
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
    CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text NOT NULL, outcome text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), work_key text);
    ${fnText(MIG, "task_work_key_fp_arms")}
    ${fnText(MIG, "task_work_key")}
    ${fnText(MIG, "work_key_fill")}
    CREATE TRIGGER trg_task_checks_work_key BEFORE INSERT OR UPDATE OF task_id ON task_checks FOR EACH ROW EXECUTE FUNCTION work_key_fill();
    CREATE TABLE politician_bulletins (politician_id uuid, election_id integer, election_type text, region text, sub_region text NOT NULL DEFAULT '', village text NOT NULL DEFAULT '');
    CREATE TABLE election_bulletins (election_id integer, election_type text, region text, sub_region text NOT NULL DEFAULT '', village text NOT NULL DEFAULT '', listed_on date NOT NULL);
    INSERT INTO election_bulletins VALUES (2026, '縣市長', '甲縣', '', '', DATE '2026-11-17'), (2022, '縣市長', '乙縣', '', '', DATE '2026-10-06');
    INSERT INTO politician_bulletins VALUES ('${P1}', 2026, '縣市長', '甲縣', '', ''), ('${P3}', 2022, '縣市長', '乙縣', '', '');
    ${fnText(NEW, "task_check_prebulletin_cutoff")}
    ${fnText(NEW, "task_check_cooldown_days_for")}
    ${fnText(NEW, "work_key_ladder_state")}
  `);
  return db;
}

const at = (db: PGlite, taskId: string, outcome: string, ts: string) =>
  db.query("INSERT INTO task_checks (task_id, outcome, checked_at) VALUES ($1, $2, $3::timestamptz)", [taskId, outcome, ts]);
const days = async (db: PGlite, checkId: number): Promise<number> =>
  (await db.query<{ d: number }>("SELECT task_check_cooldown_days_for(task_id, outcome, checked_at, id) AS d FROM task_checks WHERE id = $1", [checkId])).rows[0].d;
const state = async (db: PGlite, wk: string) =>
  (await db.query<{ checks: number; closed: boolean }>(`SELECT checks::int AS checks, closed FROM work_key_ladder_state('${wk}')`)).rows[0];

Deno.test("1 公報上架前的 4 次查無不結案、不計階梯；上架後第一次查無從第 1 格（5 天）開始", async () => {
  const db = await buildDb();
  const pm = `auto:policy_missing:${P1}`;
  for (const t of ["2026-11-02", "2026-11-06", "2026-11-10", "2026-11-14"]) await at(db, pm, "not_found", `${t}T03:00:00Z`);
  const s = await state(db, `politician:${P1}:policies:2026`);
  assertEquals([s.checks, s.closed], [0, false], "4 次都在上架前：階梯累計 0、沒結案");
  const cool = (await db.query<{ c: boolean; cc: boolean }>(`SELECT (cool_until IS NOT NULL) AS c, (check_cool_until IS NOT NULL) AS cc FROM work_key_ladder_state('politician:${P1}:policies:2026')`)).rows[0];
  assertEquals([cool.c, cool.cc], [false, false], "被排除的列不產生冷卻（cool_until、check_cool_until 皆 NULL）");
  await at(db, pm, "not_found", "2026-11-18T05:00:00Z"); // id 5：上架後第一次
  assertEquals(await days(db, 5), 5, "上架後第一次查無＝階梯第 1 格");
  assertEquals((await state(db, `politician:${P1}:policies:2026`)).checks, 1);
});

Deno.test("2 只排除補政見任務的 not_found：confirmed、其他任務型別、沒有公報的候選人照舊", async () => {
  const db = await buildDb();
  await at(db, `auto:policy_missing:${P1}`, "confirmed", "2026-11-10T03:00:00Z");
  assertEquals((await state(db, `politician:${P1}:policies:2026`)).checks, 1, "confirmed 不排除");
  for (const t of ["2026-11-02", "2026-11-06", "2026-11-10", "2026-11-14"]) await at(db, `auto:policy_missing:${P2}`, "not_found", `${t}T03:00:00Z`);
  assertEquals((await state(db, `politician:${P2}:policies:2026`)).closed, true, "沒有公報的人不套新規則：4 次照樣結案");
  await at(db, `auto:profile_gap:${P1}`, "not_found", "2026-11-10T03:00:00Z");
  assertEquals((await state(db, `politician:${P1}:profile`)).checks, 1, "補基本資料的查無照算");
});

Deno.test("3 邊界：截止＝上架日隔天 00:00 UTC；前一分鐘排除、後一分鐘計入", async () => {
  const db = await buildDb();
  const pm = `auto:policy_missing:${P1}`;
  await at(db, pm, "not_found", "2026-11-17T23:59:00Z"); // 上架日 19:00Z 之後仍在截止前 → 排除
  await at(db, pm, "not_found", "2026-11-18T00:01:00Z"); // 截止後 → 計
  const r = (await db.query<{ p: boolean }>(
    `SELECT (outcome = 'not_found' AND checked_at < task_check_prebulletin_cutoff(work_key)) AS p FROM task_checks ORDER BY id`)).rows;
  assertEquals(r.map((x) => x.p), [true, false]);
  assertEquals((await state(db, `politician:${P1}:policies:2026`)).checks, 1, "只有截止後那一筆計入階梯");
});

Deno.test("4 要有「那一屆」的公報才排除：2022 有公報的人 2026 的查無照算；2022 屆上架前的才排除", async () => {
  const db = await buildDb();
  await at(db, `auto:policy_missing:${P3}`, "not_found", "2026-11-10T03:00:00Z"); // 工作卡屆別 2026：P3 沒有 2026 的公報
  assertEquals((await state(db, `politician:${P3}:policies:2026`)).checks, 1);
  await at(db, `auto:term_policy_missing:${P3}:2022`, "not_found", "2026-10-05T03:00:00Z"); // 2022 公報 10-06 上架前 → 排除
  await at(db, `auto:term_policy_missing:${P3}:2022`, "not_found", "2026-10-08T03:00:00Z"); // 上架後 → 計
  assertEquals((await state(db, `politician:${P3}:policies:2022`)).checks, 1);
});

Deno.test("5 網站請求等手動任務（uuid task_id）與 auto 共用工作卡，上架前的查無同樣排除", async () => {
  const db = await buildDb();
  const MANUAL = "11111111-1111-4111-8111-111111111111";
  // 手動任務的查核照現行寫法掛在同一把工作卡鍵上
  await db.query("INSERT INTO task_checks (task_id, outcome, checked_at, work_key) VALUES ($1, 'not_found', '2026-11-10T03:00:00Z', $2)", [MANUAL, `politician:${P1}:policies:2026`]);
  await at(db, `auto:policy_missing:${P1}`, "not_found", "2026-11-10T04:00:00Z");
  assertEquals((await state(db, `politician:${P1}:policies:2026`)).checks, 0, "手動與 auto 的上架前查無都不計");
  await db.query("INSERT INTO task_checks (task_id, outcome, checked_at, work_key) VALUES ($1, 'not_found', '2026-11-19T03:00:00Z', $2)", [MANUAL, `politician:${P1}:policies:2026`]);
  assertEquals((await state(db, `politician:${P1}:policies:2026`)).checks, 1, "上架後的手動查無照算");
  const code = NEW.replace(/--.*$/gm, "");
  assert(!/UPDATE task_checks|DELETE FROM task_checks|INSERT INTO task_checks/.test(code), "不動資料列");
});
