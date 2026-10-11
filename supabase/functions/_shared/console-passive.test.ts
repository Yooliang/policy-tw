/**
 * 主控台派工頁「被動（新聞與交件驅動）」段（migration 20261010230000／230100；工作單 Yooliang/policy-ops#78）。
 *   - 等驗證交件依來源分：公民提問的回答、網站請求、新聞任務、裁決、其餘一般代理交件；不是 pending 的不算
 *   - 新聞任務依 suggestion 分開著與近 7 天完成；news_queued＝佇列裡的新聞任務列數（主控台從 manual_open 扣掉）
 *   - 近 7 天新聞漏斗：開了任務、併進既有任務、延後分開數
 *   - 權限：anon 可呼叫、SECURITY DEFINER、REVOKE ALL FROM PUBLIC
 *   還原驗證：拿掉「新聞任務」那一類，新聞的交件就算進一般代理交件
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { readMig } from "./arms-pglite.ts";

const SQL = await readMig("20261010230000_console_passive.sql");
const JP = await readMig("20261010230100_policy_jp_console_passive.sql");

const T_WEB = "11111111-1111-4111-8111-111111111111";
const T_NEWS = "22222222-2222-4222-8222-222222222222";
const T_NEWS_OLD = "33333333-3333-4333-8333-333333333333";

async function db(sql = SQL): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, source text, task_type text, target jsonb, status text, closed_at timestamptz);
    CREATE TABLE contributions (id serial PRIMARY KEY, contribution_type text, task_id text, status text);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY);
    CREATE TABLE news_items (id serial PRIMARY KEY, created_at timestamptz, screened_at timestamptz, screen jsonb, task_id text);
    INSERT INTO contribution_tasks VALUES
      ('${T_WEB}', 'web_request', 'policy_missing', '{}', 'open', NULL),
      ('${T_NEWS}', 'manual', 'news_sweep', '{"kind":"news_item","suggestion":"new_pledge"}', 'open', NULL),
      ('${T_NEWS_OLD}', 'manual', 'news_sweep', '{"kind":"news_item","suggestion":"progress"}', 'closed', now() - interval '2 days');
    INSERT INTO contributions (contribution_type, task_id, status) VALUES
      ('question_answer', 'q', 'pending'), ('policy', '${T_WEB}', 'pending'), ('policy', '${T_NEWS}', 'pending'),
      ('adjudication', NULL, 'pending'), ('policy', 'auto:policy_missing:x', 'pending'), ('policy', 'auto:policy_missing:y', 'verified');
    INSERT INTO task_dispatches VALUES ('${T_NEWS}'), ('${T_WEB}'), ('auto:policy_missing:x');
    INSERT INTO news_items (created_at, screened_at, screen, task_id) VALUES
      (now(), now(), '{"result":"no_name"}', NULL),
      (now(), now(), '{"result":"new_pledge"}', '${T_NEWS}'),
      (now(), now(), '{"result":"new_pledge","appended_to_task":"${T_NEWS}"}', NULL),
      (now(), now(), '{"result":"new_pledge","deferred":true}', NULL),
      (now() - interval '9 days', now() - interval '9 days', '{"result":"new_pledge"}', NULL);
  `);
  await d.exec(sql);
  return d;
}

const run = async (d: PGlite) => (await d.query<{ j: Record<string, unknown> }>(`SELECT console_passive() AS j`)).rows[0].j;

Deno.test("等驗證交件依來源分；不是 pending 的不算", async () => {
  const d = await db();
  assertEquals((await run(d)).verify_pending, { question: 1, web_request: 1, news: 1, adjudication: 1, agent: 1 });
  await d.close();
});

Deno.test("新聞任務：開著與近 7 天完成依 suggestion 分；佇列裡的新聞任務列數；近 7 天漏斗", async () => {
  const d = await db();
  const j = await run(d);
  assertEquals(j.news_tasks, { new_pledge: { open: 1, closed_7d: 0 }, progress: { open: 0, closed_7d: 1 } });
  assertEquals(j.news_queued, 1, "只算新聞任務，網站請求與自動缺口不算");
  const f = j.news_7d as Record<string, number>;
  assertEquals([f.received, f.no_name, f.new_pledge, f.opened, f.appended, f.deferred], [4, 1, 3, 1, 1, 1], "9 天前的不算");
  await d.close();
});

Deno.test("還原驗證：拿掉新聞任務那一類，新聞的交件就算進一般代理交件", async () => {
  const broken = SQL.replace("             WHEN t.task_type = 'news_sweep' THEN 'news'\n", "");
  assert(broken !== SQL);
  const d = await db(broken);
  assertEquals((await run(d)).verify_pending, { question: 1, web_request: 1, adjudication: 1, agent: 2 });
  await d.close();
});

Deno.test("權限：SECURITY DEFINER、釘 search_path、REVOKE ALL FROM PUBLIC、anon 可呼叫（兩站）", () => {
  for (const [s, fn] of [[SQL, "console_passive()"], [JP, "policy_jp.console_passive()"]] as const) {
    assertStringIncludes(s, "SECURITY DEFINER SET search_path =");
    assertStringIncludes(s, `REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
    assertStringIncludes(s, `GRANT EXECUTE ON FUNCTION ${fn} TO anon, authenticated, service_role;`);
  }
});

Deno.test("只加一支唯讀函式：不動派工、時間軸、規則", () => {
  const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_.]+)\(/g)].map((m) => m[1]);
  assertEquals(defined, ["console_passive"]);
  assert(!/\b(UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE|DROP)\b/.test(code));
});
