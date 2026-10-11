/**
 * 網站請求與公民提問的交件：驗證一路排前段（migration 20261010130000；工作單 Yooliang/policy-ops#68）。
 * PGlite 上用正見現行的 queue_slot／contribution_queue_at／task_dispatched（20260924000002，派出就排回隊尾），掛上這支的觸發器：
 *   - 網站請求、公民提問的等票驗證列：派出後留在前段（1970 段），排到前段驗證列的最後面，輪流
 *   - 一般交件：派出照舊回隊尾
 *   - 通過或退件（不是 pending）：下一次派出回隊尾
 *   - rebalance 一類「只改 queue_at、沒有派出」的更新不攔；/boost 的 1980 段不攔
 *   - 既有已在隊尾的一次拉回前段，照交件時間先後
 *   - 還原驗證：拿掉觸發器，派出一次就回隊尾
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";

const SQL = await readMig("20261010130000_web_request_verify_front.sql");
const RATIO = await readMig("20260924000002_queue_ratio.sql");
const BASE = ["queue_slot", "contribution_queue_at", "task_dispatched"].map((n) => fnText(RATIO, n)).join("\n");

const WEB_TASK = "11111111-1111-4111-8111-111111111111";
const C_WEB_OLD = "a0000000-0000-4000-8000-000000000001"; // 網站請求，已經被排到隊尾（既有的）
const C_WEB_NEW = "a0000000-0000-4000-8000-000000000002"; // 網站請求，還在前段
const C_QA = "a0000000-0000-4000-8000-000000000003"; // 公民提問的回答
const C_PLAIN = "a0000000-0000-4000-8000-000000000004"; // 一般交件
const C_DONE = "a0000000-0000-4000-8000-000000000005"; // 網站請求但已通過

async function db(mig: string | null = SQL): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, source text);
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, task_id text, status text, created_at timestamptz);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz, queue_at timestamptz, dispatch_count int DEFAULT 0);
    INSERT INTO contribution_tasks VALUES ('${WEB_TASK}', 'web_request');
    INSERT INTO contributions VALUES
      ('${C_WEB_OLD}', 'policy', '${WEB_TASK}', 'pending', '2026-10-01'),
      ('${C_WEB_NEW}', 'policy', '${WEB_TASK}', 'pending', '2026-10-09'),
      ('${C_QA}', 'question_answer', 'q-1', 'pending', '2026-10-05'),
      ('${C_PLAIN}', 'policy', 'auto:policy_missing:x', 'pending', '2026-10-02'),
      ('${C_DONE}', 'policy', '${WEB_TASK}', 'verified', '2026-10-03');
    INSERT INTO task_dispatches VALUES
      ('verify:${C_WEB_OLD}', now(), now() + interval '3 hours', 1),
      ('verify:${C_WEB_NEW}', NULL, '1970-01-01', 0),
      ('verify:${C_QA}', NULL, '1970-01-01', 0),
      ('verify:${C_PLAIN}', NULL, now() + interval '1 hour', 0),
      ('verify:${C_DONE}', now(), '1970-01-01 00:00:09', 1),
      ('auto:policy_missing:y', NULL, now() + interval '2 hours', 0);
  `);
  await d.exec(BASE);
  if (mig) await d.exec(mig);
  return d;
}

const at = async (d: PGlite, id: string) =>
  new Date((await d.query<{ q: string }>(`SELECT queue_at AS q FROM task_dispatches WHERE task_id = $1`, [`verify:${id}`])).rows[0].q).getTime();
const dispatch = (d: PGlite, id: string) => d.query(`SELECT task_dispatched($1)`, [`verify:${id}`]);
const Y2000 = Date.UTC(2000, 0, 1);
const Y1971 = Date.UTC(1971, 0, 1);

Deno.test("既有已在隊尾的網站請求驗證列拉回前段；一般交件不動", async () => {
  const d = await db();
  const old = await at(d, C_WEB_OLD);
  assert(old < Y1971, "拉回 1970 段");
  assert(old > Date.UTC(1970, 0, 1, 0, 0, 9), "排在前段既有驗證列（含已通過那筆的 00:00:09）後面");
  assert((await at(d, C_PLAIN)) > Y2000, "一般交件不動");
  await d.close();
});

Deno.test("網站請求、公民提問派出後留在前段、排到前段最後面輪流；一般交件回隊尾", async () => {
  const d = await db();
  await dispatch(d, C_WEB_NEW);
  const a = await at(d, C_WEB_NEW);
  assert(a < Y1971, "網站請求派出後仍在前段");
  assert(a > await at(d, C_WEB_OLD), "排到前段驗證列的最後面");
  await dispatch(d, C_QA);
  assert((await at(d, C_QA)) > a, "公民提問的回答也留在前段、排在剛剛那筆後面");
  await dispatch(d, C_PLAIN);
  assert((await at(d, C_PLAIN)) > Y2000, "一般交件派出回隊尾");
  await d.close();
});

Deno.test("通過或退件之後（不是 pending）：派出照常回隊尾", async () => {
  const d = await db();
  await dispatch(d, C_DONE);
  assert((await at(d, C_DONE)) > Y2000);
  await d.query(`UPDATE contributions SET status = 'rejected' WHERE id = $1`, [C_WEB_NEW]);
  await dispatch(d, C_WEB_NEW);
  assert((await at(d, C_WEB_NEW)) > Y2000);
  await d.close();
});

Deno.test("沒有派出的改位置不攔：重排（只改 queue_at）、插隊 1980 段照原樣", async () => {
  const d = await db();
  await d.query(`UPDATE task_dispatches SET queue_at = now() + interval '5 hours' WHERE task_id = $1`, [`verify:${C_WEB_NEW}`]);
  assert((await at(d, C_WEB_NEW)) > Y2000, "dispatch_count 沒變＝不是派出，觸發器不改");
  await d.query(`UPDATE task_dispatches SET queue_at = '1979-12-31 23:59:00+00', dispatch_count = dispatch_count + 1 WHERE task_id = $1`, [`verify:${C_QA}`]);
  assertEquals(await at(d, C_QA), Date.UTC(1979, 11, 31, 23, 59), "插隊（1980 段）不攔");
  await d.close();
});

Deno.test("還原驗證：沒有這支 migration，網站請求派出一次就回隊尾", async () => {
  const d = await db(null);
  await dispatch(d, C_WEB_NEW);
  assert((await at(d, C_WEB_NEW)) > Y2000);
  await d.close();
});

Deno.test("判準只有一份：觸發器與拉回都用 contribution_queue_at（跟入列同一個條件），不另寫網站請求的判斷", () => {
  const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!code.includes("web_request"), "不另寫 source = 'web_request'");
  assert(!code.includes("question_answer"), "不另寫 question_answer");
  assertEquals(code.split("contribution_queue_at(").length - 1, 3, "觸發器、拉回、自我檢查三處都用它");
});

Deno.test("觸發器用主鍵找貢獻（不把 id 轉成文字比，否則每次派出全表掃描）；task_id 後段不是 uuid 也不出錯", async () => {
  const fn = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION verify_front_keep"), SQL.indexOf("COMMENT ON FUNCTION verify_front_keep"));
  assert(!fn.includes("c.id::TEXT"), "不可以 c.id::TEXT = …");
  assert(fn.includes("substr(NEW.task_id, 8)::uuid"));
  const d = await db();
  await d.exec(`INSERT INTO task_dispatches VALUES ('verify:not-a-uuid', NULL, '1970-01-01', 0)`);
  await d.query(`SELECT task_dispatched('verify:not-a-uuid')`);
  assert(new Date((await d.query<{ q: string }>(`SELECT queue_at AS q FROM task_dispatches WHERE task_id = 'verify:not-a-uuid'`)).rows[0].q).getTime() > Y2000);
  await d.close();
});
