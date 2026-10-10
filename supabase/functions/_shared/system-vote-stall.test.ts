/**
 * 系統票無聲停擺的告警（2026-10-10；起因：10-09 05:13 UTC 起 jev_decisions 寫入全部失敗約 16 小時，cron 照跑回 200 沒人發現）。
 *   a. SQL system_vote_stall()（migration 20261010020000，PGlite 真的跑）：最近一筆來源核對系統票早於門檻、之後又有等待中的合格貢獻 → 一列；
 *      正常（最近有票）、沒有新貢獻、新貢獻還不到 1 小時、不合格型別、已不在等待 → 沒有列；還原驗證：拿掉「早於門檻」那個條件就會誤報
 *   b. activity_health：舊的分支一字不動（＝20261008165000 的定義），只在最後加 system_vote_stalled 一段、讀 system_vote_stall()
 *   c. system-one：一輪有失敗而且一筆都沒做成 → 500（batchHttpStatus），四個批次出口都套用
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { batchHttpStatus } from "./batch-status.ts";

const MIG = new URL("../../migrations/", import.meta.url);
const read = async (n: string) => (await Deno.readTextFile(new URL(n, MIG))).replace(/\r\n/g, "\n");
const SQL = await read("20261010020000_system_vote_stall_health.sql");
const PREV = await read("20261008165000_manual_tasks_as_arm.sql");
const fnBlock = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION system_vote_stall_hours()"), sql.indexOf("COMMENT ON FUNCTION system_vote_stall IS"));

async function db(fns = fnBlock(SQL)): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE jev_decisions (id serial, subject_type text, question text, asked_at timestamptz);
    CREATE TABLE contributions (id serial, status text, contribution_type text, created_at timestamptz);
    CREATE FUNCTION system_vote_eligible(t text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT t IN ('policy', 'candidacy') $$;
  `);
  await d.exec(fns);
  return d;
}
const ago = (h: number) => `now() - interval '${h} hours'`;
const stalled = async (d: PGlite) => (await d.query<{ waiting: number }>(`SELECT waiting::int FROM system_vote_stall()`)).rows;

Deno.test("a. 最近的系統票早於 3 小時、之後有等待中的合格貢獻 → 報；其他情況都不報", async () => {
  const d = await db();
  await d.exec(`INSERT INTO jev_decisions (subject_type, question, asked_at) VALUES ('contribution', 'source_support', ${ago(16)}), ('contribution', 'vote_budget', ${ago(0.1)}), ('policy', 'source_support', ${ago(0.1)})`);
  await d.exec(`INSERT INTO contributions (status, contribution_type, created_at) VALUES
    ('pending', 'policy', ${ago(10)}), ('pending', 'candidacy', ${ago(5)}),
    ('pending', 'policy', ${ago(0.5)}), ('pending', 'no_change', ${ago(5)}), ('applied', 'policy', ${ago(5)}), ('pending', 'policy', ${ago(20)})`);
  assertEquals(await stalled(d), [{ waiting: 2 }], "16 小時前的票之後有 2 筆合格等待（不到 1 小時、不合格、已落庫、比最後一票早的都不算；別的 question／subject_type 不算系統票）");
  await d.exec(`INSERT INTO jev_decisions (subject_type, question, asked_at) VALUES ('contribution', 'source_support', ${ago(2)})`);
  assertEquals(await stalled(d), [], "2 小時前還有票：沒到門檻");
  await d.close();

  const quiet = await db();
  await quiet.exec(`INSERT INTO jev_decisions (subject_type, question, asked_at) VALUES ('contribution', 'source_support', ${ago(16)})`);
  assertEquals(await stalled(quiet), [], "很久沒票，但也沒有新的貢獻：不是停擺");
  await quiet.close();

  const never = await db();
  await never.exec(`INSERT INTO contributions (status, contribution_type, created_at) VALUES ('pending', 'policy', ${ago(5)})`);
  assertEquals(await stalled(never), [{ waiting: 1 }], "從來沒有系統票也算");
  await never.close();
});

Deno.test("a. 還原驗證：拿掉「早於門檻」的條件，正常（剛有票）時也會誤報", async () => {
  const cond = "   WHERE COALESCE(j.last_at, '-infinity'::timestamptz) < now() - make_interval(hours => system_vote_stall_hours())\n     AND w.n > 0";
  assertEquals(SQL.split(cond).length - 1, 1, "替換點要剛好出現一次");
  const broken = await db(fnBlock(SQL.replace(cond, "   WHERE w.n > 0")));
  await broken.exec(`INSERT INTO jev_decisions (subject_type, question, asked_at) VALUES ('contribution', 'source_support', ${ago(2)})`);
  await broken.exec(`INSERT INTO contributions (status, contribution_type, created_at) VALUES ('pending', 'policy', ${ago(1.5)})`);
  assertEquals((await stalled(broken)).length, 1, "壞掉的版本會報");
  await broken.close();
  const ok = await db();
  await ok.exec(`INSERT INTO jev_decisions (subject_type, question, asked_at) VALUES ('contribution', 'source_support', ${ago(2)})`);
  await ok.exec(`INSERT INTO contributions (status, contribution_type, created_at) VALUES ('pending', 'policy', ${ago(1.5)})`);
  assertEquals(await stalled(ok), [], "正確的版本不報");
  await ok.close();
  assert(SQL.includes("CREATE OR REPLACE FUNCTION system_vote_stall_hours() RETURNS INTEGER\nLANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;"), "門檻是一支函式（3 小時）");
});

Deno.test("b. activity_health：舊分支一字不動，只在最後加 system_vote_stalled", () => {
  const view = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE VIEW activity_health AS"), sql.indexOf("COMMENT ON VIEW activity_health IS"));
  const prev = view(PREV).trimEnd().replace(/;$/, "");
  const now = view(SQL).trimEnd();
  assert(now.startsWith(prev), "前面要跟 20261008165000 的定義一模一樣");
  const added = now.slice(prev.length).trim();
  assert(added.startsWith("UNION ALL\n  SELECT 'system_vote_stalled', 'jev_decisions',"), added.slice(0, 80));
  assert(added.endsWith("FROM system_vote_stall() s;"));
});

Deno.test("c. system-one：有失敗而且一筆都沒做成 → 500；部分成功、沒有失敗照舊 200；四個批次出口都套用", async () => {
  assertEquals(batchHttpStatus(0, [{ error: "x" }]), 500);
  assertEquals(batchHttpStatus(1, [{ error: "x" }]), 200, "部分成功");
  assertEquals(batchHttpStatus(0, []), 200, "沒有候選");
  const src = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  assertEquals(src.split("batchHttpStatus(asked, failures)").length - 1, 4);
});
