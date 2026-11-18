/**
 * 查核階梯不計「公報索引上架前的查無」（migration 20261118010000_ladder_ignore_prebulletin_checks.sql，方案 D）——PGlite 真的執行新版函式：
 * task_check_prebulletin、task_check_cooldown_days_for、work_key_ladder_state。
 *
 *   1. 公報上架前的 4 次查無不結案、不冷卻；上架後的第一次查無從階梯第 1 格開始（5 天）
 *   2. 只排除補政見任務的 not_found：confirmed、其他任務型別、沒有公報的候選人一律照舊
 *   3. 邊界：上架日（台北）整天都算尚未上架；隔天 00:00 台北起才計
 *   4. 要有「那一屆」的公報才排除（工作卡的屆別對得上 politician_bulletins.election_id）
 *   5. 文字層：三個函式都在新 migration、簽名不變、不動資料列、視圖與 refresh_dispatch_blocked 沒被重寫
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
    ${fnText(NEW, "task_check_prebulletin")}
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

Deno.test("3 邊界：上架日（台北）整天算尚未上架，隔天 00:00 台北起才計", async () => {
  const db = await buildDb();
  const pm = `auto:policy_missing:${P1}`;
  await at(db, pm, "not_found", "2026-11-17T15:59:00Z"); // 11-17 23:59 台北：上架日當天 → 排除
  await at(db, pm, "not_found", "2026-11-17T16:01:00Z"); // 11-18 00:01 台北 → 計
  const r = (await db.query<{ p: boolean }>(`SELECT task_check_prebulletin(task_id, work_key, outcome, checked_at) AS p FROM task_checks ORDER BY id`)).rows;
  assertEquals(r.map((x) => x.p), [true, false]);
});

Deno.test("4 要有「那一屆」的公報才排除：2022 有公報的人 2026 的查無照算；2022 屆上架前的才排除", async () => {
  const db = await buildDb();
  await at(db, `auto:policy_missing:${P3}`, "not_found", "2026-11-10T03:00:00Z"); // 工作卡屆別 2026：P3 沒有 2026 的公報
  assertEquals((await state(db, `politician:${P3}:policies:2026`)).checks, 1);
  await at(db, `auto:term_policy_missing:${P3}:2022`, "not_found", "2026-10-05T03:00:00Z"); // 2022 公報 10-06 上架前 → 排除
  await at(db, `auto:term_policy_missing:${P3}:2022`, "not_found", "2026-10-08T03:00:00Z"); // 上架後 → 計
  assertEquals((await state(db, `politician:${P3}:policies:2022`)).checks, 1);
});

Deno.test("5 文字層：新 migration 重寫這三個函式、不動資料列、不重寫視圖與 refresh，簽名不變", () => {
  for (const fn of ["task_check_prebulletin", "task_check_cooldown_days_for", "work_key_ladder_state"]) {
    assert(NEW.includes(`CREATE OR REPLACE FUNCTION ${fn}(`), fn);
  }
  const code = NEW.replace(/--.*$/gm, "");
  assert(!/UPDATE task_checks|DELETE FROM task_checks|INSERT INTO task_checks/.test(code), "不動資料列");
  assert(!code.includes("FUNCTION refresh_dispatch_blocked") && !code.includes("VIEW task_ladder_closed"), "視圖與 refresh 不重寫");
  assert(NEW.includes("RETURNS TABLE (checks BIGINT, closed BOOLEAN, closed_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, cool_until TIMESTAMPTZ, check_cool_until TIMESTAMPTZ)"));
  assert(NEW.includes("NOT task_check_prebulletin(tc.task_id, tc.work_key, tc.outcome, tc.checked_at)"));
  assertEquals(NEW.split("NOT task_check_prebulletin(x.task_id, x.work_key, x.outcome, x.checked_at)").length - 1, 2, "兩處累計都排除");
  assert(MIG.includes("work_key_ladder_state"), "舊版仍在（回滾依據）");
});
