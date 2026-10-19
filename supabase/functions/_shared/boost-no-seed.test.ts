/**
 * /boost 插隊逾時（migration 20261019050000_boost_no_seed.sql，2026-10-19）。
 * 根因：task_boost 第一行跑整支 seed_auto_task_queue()（正式庫平均 7～9 秒），PostgREST 的 statement_timeout 是 8 秒 → 從 10-14 起每次逾時。
 *   A. 文字層：新 task_boost＝20261017010000 的現行定義只拿掉 seed 那一行（其餘一字不動）；之後的版本不能再加回 seed
 *   B. PGlite：seed 一呼叫就丟錯的環境裡 task_boost 照樣完成；命中的任務列與驗證票照樣加插隊秒數、驗證票鍵照樣重算（refresh 照呼叫）
 *   C. 還原驗證：把 seed 那一行加回去，B 就紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261019050000_boost_no_seed.sql";
const MIG = await readMig(MIG_NAME);
const NEW = fnText(MIG, "task_boost");
const SEED_LINE = "  PERFORM seed_auto_task_queue();\n";
const PREV = await latestFn("task_boost", MIG_NAME);
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const norm = (s: string) => code(s).split("\n").map((l) => l.trim()).filter((l) => l !== "").join("\n");

Deno.test("A1 task_boost：前一版（20261017010000）只拿掉 seed 那一行，其餘（去註解）一字不動", () => {
  assertEquals(PREV.split(SEED_LINE).length - 1, 1, "前一版的 seed 呼叫要剛好一處");
  assertEquals(norm(NEW), norm(PREV.replace(SEED_LINE, "")));
  assert(!/seed_auto_task_queue/.test(code(NEW)), "task_boost 不再呼叫 seed（seed 平均 7～9 秒，超過 /boost 的 8 秒逾時）");
});

Deno.test("A2 task_boost 的最新定義沒有 seed（之後有人又加回去會在這裡紅）", async () => {
  const latest = await latestFn("task_boost");
  assert(!/seed_auto_task_queue/.test(code(latest)), "task_boost 的最新定義又呼叫 seed 了");
});

const SCHEMA = `
CREATE TABLE task_boosts (id BIGSERIAL PRIMARY KEY, label TEXT, filter JSONB, agent_name TEXT, ip_hash TEXT, matched_tasks INTEGER, matched_verifies INTEGER);
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, last_dispatched_at timestamptz);
CREATE TABLE queue_settings (id INT PRIMARY KEY, boost_seconds BIGINT);
INSERT INTO queue_settings VALUES (1, 157680000);
CREATE TABLE task_dispatches (task_id TEXT PRIMARY KEY, boost_seconds BIGINT NOT NULL DEFAULT 0, cooling BOOLEAN NOT NULL DEFAULT false, queue_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE _refreshed (n INT);
CREATE FUNCTION task_boost_matches(p_filter JSONB) RETURNS TABLE(task_id TEXT, kind TEXT) LANGUAGE sql AS $f$
  SELECT 'auto:a', 'task' UNION ALL SELECT 'verify:v1', 'verify' $f$;
-- 驗證票鍵重算：這裡只記一筆（真正的重算由 verify-ticket-follows-task.test.ts 守）
CREATE FUNCTION refresh_verify_ticket_keys() RETURNS INTEGER LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO _refreshed VALUES (1); RETURN 1; END $f$;
-- seed 一呼叫就丟錯：模擬「seed 超過逾時」
CREATE FUNCTION seed_auto_task_queue() RETURNS INTEGER LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'seed 被呼叫了（正式庫要 7～9 秒）'; END $f$;
INSERT INTO task_dispatches (task_id, cooling) VALUES ('auto:a', true), ('verify:v1', false), ('auto:other', false);
`;
async function run(def: string) {
  const db = new PGlite();
  try {
    await db.exec(SCHEMA);
    await db.exec(def);
    const r = (await db.query<{ r: { matched_tasks: number; matched_verifies: number } }>(`SELECT task_boost('t', '{}'::jsonb, 'x', 'ip') AS r`)).rows[0]!.r;
    const rows = (await db.query<{ task_id: string; boost_seconds: string; cooling: boolean }>(`SELECT task_id, boost_seconds::text, cooling FROM task_dispatches ORDER BY 1`)).rows;
    const refreshed = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM _refreshed`)).rows[0]!.n;
    return { r, rows, refreshed };
  } finally {
    await db.close();
  }
}

Deno.test("B 不跑 seed 照樣完成：命中的任務列與驗證票加插隊秒數、冷卻解除、驗證票鍵重算、沒命中的不動", async () => {
  const { r, rows, refreshed } = await run(NEW);
  assertEquals([r.matched_tasks, r.matched_verifies], [1, 1]);
  assertEquals(rows, [
    { task_id: "auto:a", boost_seconds: "157680000", cooling: false },
    { task_id: "auto:other", boost_seconds: "0", cooling: false },
    { task_id: "verify:v1", boost_seconds: "157680000", cooling: false },
  ]);
  assertEquals(refreshed, 1, "插完隊呼叫一次 refresh_verify_ticket_keys（驗證票跟著母任務換位置）");
});

Deno.test("C 還原驗證：把 seed 那一行加回去，插隊就丟錯（B 翻面）", async () => {
  const bad = mutate(NEW, "BEGIN\n", "BEGIN\n" + SEED_LINE);
  let threw = false;
  try { await run(bad); } catch (e) { threw = String(e).includes("seed 被呼叫了"); }
  assert(threw, "加回 seed 之後 B 的環境應該丟錯");
});
