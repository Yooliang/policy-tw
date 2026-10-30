/**
 * 號次缺口任務「查無」冷卻 2 天（2026-10-30，migration 20261030150100）。
 * 只有 task_id＝auto:candidacy_source_missing:cand_no:… 的 not_found 是 2 天；cand_no_recheck、其他型別、其他 outcome 照舊。
 * SQL 與 TS（CAND_NO_NOT_FOUND_COOLDOWN_DAYS）要是同一個數字。
 * 還原驗證：把 migration 的號次那一條 WHEN 拿掉（或改成 14），行為測試必須紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { CAND_NO_NOT_FOUND_COOLDOWN_DAYS, TASK_CHECK_COOLDOWN_DAYS } from "./apply-contribution.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

async function latestFnText(): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  let fn = "";
  for (const n of names) {
    const t = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
    const at = t.lastIndexOf("CREATE OR REPLACE FUNCTION task_check_cooldown_days_for(");
    if (at >= 0) {
      const body = t.slice(at);
      fn = body.slice(0, body.indexOf("$$;", body.indexOf("$$") + 2) + 3);
    }
  }
  assert(fn !== "", "找不到 task_check_cooldown_days_for 定義");
  return fn;
}

async function days(taskId: string, outcome: string): Promise<number> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE task_cooldown_settings (id integer PRIMARY KEY, enabled boolean, task_types text[], not_found_first_days integer, not_found_repeat_days integer);
    INSERT INTO task_cooldown_settings VALUES (1, true, ARRAY['progress_stale','deadline_due'], 14, 30);
    CREATE TABLE task_checks (id bigint PRIMARY KEY, task_id text, outcome text, checked_at timestamptz);
    CREATE FUNCTION task_unreachable_cooldown_days() RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$;
    CREATE FUNCTION task_check_cooldown_days() RETURNS integer LANGUAGE sql AS $$ SELECT ${TASK_CHECK_COOLDOWN_DAYS} $$;
    ${await latestFnText()}`);
  const r = await db.query<{ d: number }>(`SELECT task_check_cooldown_days_for($1, $2, now(), 1) AS d`, [taskId, outcome]);
  return r.rows[0].d;
}

Deno.test("號次缺口任務 not_found 冷卻 2 天，其餘不變", async () => {
  const P = "auto:candidacy_source_missing";
  assertEquals(await days(`${P}:cand_no:abc`, "not_found"), 2);
  assertEquals(await days(`${P}:cand_no:abc:p1`, "not_found"), 2);
  assertEquals(await days(`${P}:cand_no_recheck:abc`, "not_found"), TASK_CHECK_COOLDOWN_DAYS);
  assertEquals(await days(`${P}:cand_no:abc`, "confirmed"), TASK_CHECK_COOLDOWN_DAYS);
  assertEquals(await days(`${P}:cand_no:abc`, "unreachable"), 2);
  assertEquals(await days(`${P}:other:abc`, "not_found"), TASK_CHECK_COOLDOWN_DAYS);
  assertEquals(await days(`auto:profile_gap:cand_no:abc`, "not_found"), TASK_CHECK_COOLDOWN_DAYS);
  assertEquals(await days(`auto:progress_stale:xyz`, "not_found"), 14); // 進度追蹤類第一次仍 14 天
});

Deno.test("SQL 與 TS 的號次查無冷卻天數一致", async () => {
  const fn = await latestFnText();
  const m = fn.match(/split_part\(p_task_id, ':', 3\) = 'cand_no'\s+THEN\s+(\d+)/);
  assert(m, "找不到號次那一條 WHEN");
  assertEquals(Number(m![1]), CAND_NO_NOT_FOUND_COOLDOWN_DAYS);
});
