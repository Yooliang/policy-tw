/**
 * 名單清查任務不因單筆參選紀錄落庫被收回（migration 20261010070000；工作單 Yooliang/policy-ops#57）。
 * PGlite 上建最小的 contributions／task_dispatches，掛上這支 migration 的觸發器，收回函式照現行（auto:% 就刪派工列）。
 *   - auto:roster_check：candidacy／politician／correction 落庫 → 派工列留著；roster_check、no_change 落庫 → 收回
 *   - 其他 auto 任務：candidacy 落庫照樣收回（只改清查這一種）
 *   - 還原驗證：換回原本的 WHEN（只看 applied），第一筆 candidacy 落庫就被收回
 */
import { assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIG = new URL("../../migrations/", import.meta.url);
const SQL = (await Deno.readTextFile(new URL("20261010070000_roster_check_keep_dispatch.sql", MIG))).replace(/\r\n/g, "\n");
const OLD_WHEN = "  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied')\n  EXECUTE FUNCTION task_dispatches_drop_applied();";

async function db(mig = SQL): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contributions (id serial PRIMARY KEY, task_id text, contribution_type text, status text);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY);
    CREATE FUNCTION task_dispatches_drop_applied() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.task_id IS NOT NULL AND NEW.task_id LIKE 'auto:%' THEN DELETE FROM task_dispatches WHERE task_id = NEW.task_id; END IF;
      RETURN NEW;
    END $$;
  `);
  await d.exec(mig);
  return d;
}

async function applyOne(d: PGlite, task: string, type: string): Promise<boolean> {
  await d.query(`INSERT INTO task_dispatches (task_id) VALUES ($1) ON CONFLICT DO NOTHING`, [task]);
  const { rows } = await d.query<{ id: number }>(`INSERT INTO contributions (task_id, contribution_type, status) VALUES ($1, $2, 'pending') RETURNING id`, [task, type]);
  await d.query(`UPDATE contributions SET status = 'applied' WHERE id = $1`, [rows[0].id]);
  const left = await d.query(`SELECT 1 FROM task_dispatches WHERE task_id = $1`, [task]);
  return left.rows.length === 1; // true＝派工列還在
}

const RC = "auto:roster_check:2026|縣市議員|臺北市";

Deno.test("名單清查：參選紀錄、人物、更正落庫不收回；清查回報、查無落庫才收回", async () => {
  const d = await db();
  for (const t of ["candidacy", "politician", "correction"]) assertEquals(await applyOne(d, RC, t), true, t);
  assertEquals(await applyOne(d, RC, "roster_check"), false, "清查回報落庫收回");
  assertEquals(await applyOne(d, RC + "x", "no_change"), false, "查無落庫收回");
  await d.close();
});

Deno.test("其他自動任務照舊：candidacy 落庫就收回", async () => {
  const d = await db();
  assertEquals(await applyOne(d, "auto:candidacy_missing:abc", "candidacy"), false);
  await d.close();
});

Deno.test("還原驗證：換回原本只看 applied 的 WHEN，第一筆參選紀錄落庫就把清查收回", async () => {
  const from = SQL.slice(SQL.indexOf("  FOR EACH ROW WHEN"), SQL.indexOf("EXECUTE FUNCTION task_dispatches_drop_applied();") + "EXECUTE FUNCTION task_dispatches_drop_applied();".length);
  const d = await db(SQL.replace(from, OLD_WHEN));
  assertEquals(await applyOne(d, RC, "candidacy"), false);
  await d.close();
});
