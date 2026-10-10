/**
 * 插隊端點 /boost 逾時（migration 20261010140000；工作單 Yooliang/policy-ops#71）。
 *   A. 文字層：task_boost_matches＝前一版（20261008165000）只把任務那一半的來源從派工總表換成佇列 task_dispatches，其餘一字不動
 *   B. PGlite：佇列裡的任務照 task_type／縣市／屆別篩得到；驗證列不會被當成任務；待驗證貢獻照舊
 *   還原驗證：換回總表來源，A 的「不重算總表」就紅（量測：總表一次約 3 秒，見 PR 說明）
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG = "20261010140000_boost_matches_from_queue.sql";
const SQL = await readMig(MIG);
const NEW = fnText(SQL, "task_boost_matches");
const PREV = await latestFn("task_boost_matches", MIG);

const FROM_ARMS = "      FROM contribution_auto_tasks_arms() g\n";
const FROM_QUEUE = "      FROM task_dispatches g WHERE g.task_id NOT LIKE 'verify:%'\n";

Deno.test("文字層：只換任務那一半的來源（總表 → 佇列）與一段註解，其餘一字不動", () => {
  assertEquals(PREV.split(FROM_ARMS).length - 1, 1);
  const stripped = NEW.split("\n").filter((l) => !l.includes("不再重算整張派工總表") && !l.includes("插隊超過 8 秒的逾時")).join("\n");
  assertEquals(stripped, PREV.replace(FROM_ARMS, FROM_QUEUE));
  assert(!NEW.includes("contribution_auto_tasks_arms()"), "不重算整張派工總表");
});

Deno.test("還原驗證：換回總表來源就不是這一版", () => {
  assert(NEW.replace(FROM_QUEUE, FROM_ARMS).includes("contribution_auto_tasks_arms()"));
});

Deno.test("PGlite：佇列裡的任務照型別、縣市、屆別篩；驗證列不當任務；待驗證貢獻照舊", async () => {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE politicians (id uuid PRIMARY KEY, region text, avatar_url text);
    CREATE TABLE politician_elections (politician_id uuid, election_id int, election_type text);
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, status text, payload jsonb);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, task_type text, target jsonb, region text);
    CREATE FUNCTION uuid_or_null(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t::uuid END $$;
    CREATE FUNCTION election_id_or_null(t text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN t ~ '^[0-9]+$' THEN t::int END $$;
    CREATE FUNCTION contribution_subject_politician(p jsonb) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT uuid_or_null(p->>'politician_id') $$;
    INSERT INTO task_dispatches VALUES
      ('auto:legacy_audit:1', 'legacy_audit', '{"region":"臺北市"}', NULL),
      ('auto:legacy_audit:2', 'legacy_audit', '{}', '高雄市'),
      ('auto:policy_missing:3', 'policy_missing', '{"election_id":"2026"}', '臺北市'),
      ('verify:a0000000-0000-4000-8000-000000000001', NULL, NULL, NULL);
    INSERT INTO contributions VALUES
      ('a0000000-0000-4000-8000-000000000001', 'legacy_audit', 'pending', '{"region":"臺北市"}'),
      ('a0000000-0000-4000-8000-000000000002', 'legacy_audit', 'verified', '{}');
  `);
  await d.exec(NEW);
  const m = async (f: unknown) =>
    (await d.query<{ task_id: string; kind: string }>(`SELECT * FROM task_boost_matches($1) ORDER BY 1`, [JSON.stringify(f)])).rows.map((r) => `${r.kind}:${r.task_id}`);
  assertEquals(await m({ task_types: ["legacy_audit"] }), [
    "task:auto:legacy_audit:1", "task:auto:legacy_audit:2", "verify:verify:a0000000-0000-4000-8000-000000000001",
  ]);
  assertEquals(await m({ task_types: ["legacy_audit"], kinds: ["task"] }), ["task:auto:legacy_audit:1", "task:auto:legacy_audit:2"]);
  assertEquals(await m({ regions: ["臺北市"], kinds: ["task"] }), ["task:auto:legacy_audit:1", "task:auto:policy_missing:3"], "縣市：target 或佇列的 region");
  assertEquals(await m({ election_id: "2026", kinds: ["task"] }), ["task:auto:policy_missing:3"]);
  assert(!(await m({})).includes("task:verify:a0000000-0000-4000-8000-000000000001"), "驗證列不當任務");
  await d.close();
});
