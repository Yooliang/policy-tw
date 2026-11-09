/**
 * 「查無」不進投票、冷卻 2 天（2026-11-07，小良；migration 20261107000000，協議 1.119.0）。
 *   A. SQL task_check_cooldown_days_for：任何任務的 not_found＝2 天；進度類第二次起 30 天；其餘不變；與 TS NOT_FOUND_COOLDOWN_DAYS 同一個數字
 *   B. TS applyNoChange：auto: 與手動任務的 not_found 都記 task_checks、手動任務不關
 *   C. contribute-handler 把 not_found no_change 接上直接落庫（reviewed_by）、cand_no_front_pull 不拉冷卻中的缺口
 * 還原驗證：把 migration 的 task_not_found_cooldown_days 改成 14、或拿掉 contribute-handler 的 notFoundDirect 迴圈，這些測試必須紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyContribution, CHECK_LADDER_DAYS, NOT_FOUND_COOLDOWN_DAYS, NOT_FOUND_DIRECT_REVIEWER, TASK_CHECK_COOLDOWN_DAYS } from "./apply-contribution.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

async function migrationTexts(): Promise<Array<[string, string]>> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  const out: Array<[string, string]> = [];
  for (const n of names) out.push([n, (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n")]);
  return out;
}

/** 某個函式最後一次的 CREATE OR REPLACE 本體 */
async function latestFn(signaturePrefix: string): Promise<string> {
  let fn = "";
  for (const [, t] of await migrationTexts()) {
    const at = t.lastIndexOf(`CREATE OR REPLACE FUNCTION ${signaturePrefix}`);
    if (at >= 0) {
      const body = t.slice(at);
      fn = body.slice(0, body.indexOf("$$;", body.indexOf("$$") + 2) + 3);
    }
  }
  assert(fn !== "", `找不到 ${signaturePrefix} 定義`);
  return fn;
}

async function days(taskId: string, outcome: string, priorNotFound = 0): Promise<number> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE task_cooldown_settings (id integer PRIMARY KEY, enabled boolean, task_types text[], not_found_first_days integer, not_found_repeat_days integer);
    INSERT INTO task_cooldown_settings VALUES (1, true, ARRAY['progress_stale','deadline_due'], 14, 30);
    CREATE TABLE task_checks (id bigint PRIMARY KEY, task_id text, outcome text, checked_at timestamptz);
    CREATE FUNCTION task_unreachable_cooldown_days() RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$;
    CREATE FUNCTION task_check_cooldown_days() RETURNS integer LANGUAGE sql AS $$ SELECT ${TASK_CHECK_COOLDOWN_DAYS} $$;
    CREATE TABLE task_check_ladder_settings (outcome text PRIMARY KEY, days integer[] NOT NULL);
    INSERT INTO task_check_ladder_settings VALUES ('not_found', ARRAY[5,10,20]), ('confirmed', ARRAY[5,10]);
    ${await latestFn("task_check_ladder_days(")}
    ${await latestFn("task_check_ladder_exempt(")}
    ${await latestFn("task_not_found_cooldown_days(")}
    ${await latestFn("task_check_cooldown_days_for(")}`);
  // 前面已有 priorNotFound 筆 not_found，這一筆是第 priorNotFound+1 次（id 最大、時間最晚）
  for (let i = 1; i <= priorNotFound; i++) {
    await db.query(`INSERT INTO task_checks VALUES ($1, $2, 'not_found', now() - interval '5 days')`, [i, taskId]);
  }
  await db.query(`INSERT INTO task_checks VALUES (100, $1, $2, now())`, [taskId, outcome]);
  const r = await db.query<{ d: number }>(`SELECT task_check_cooldown_days_for($1, $2, (SELECT checked_at FROM task_checks WHERE id = 100), 100) AS d`, [taskId, outcome]);
  return r.rows[0].d;
}

Deno.test("A1 not_found：例外型別（號次缺口等）仍 2 天；其餘任務走查核階梯第 1 次（confirmed-direct.test.ts 細測階梯）；unreachable 2 天不變", async () => {
  const P = "auto:candidacy_source_missing";
  for (const id of [`${P}:cand_no:abc`, `${P}:cand_no_recheck:abc`, "auto:roster_check:abc", "auto:not_running_recheck:1"]) {
    assertEquals(await days(id, "not_found"), NOT_FOUND_COOLDOWN_DAYS, id);
  }
  for (const id of [`${P}:other:abc`, `auto:profile_gap:x:abc`, `auto:policy_missing:abc`, "0c9c1a5e-1111-4222-8333-444444444444"]) {
    assertEquals(await days(id, "not_found"), CHECK_LADDER_DAYS.not_found[0], id);
  }
  assertEquals(await days(`${P}:cand_no:abc`, "confirmed"), TASK_CHECK_COOLDOWN_DAYS);
  assertEquals(await days(`auto:profile_gap:x:abc`, "confirmed"), CHECK_LADDER_DAYS.confirmed[0]);
  assertEquals(await days(`${P}:cand_no:abc`, "unreachable"), 2);
});

Deno.test("A2 進度追蹤類（例外）：第一次 2 天、第二次起照設定表 30 天（保留）；一般型別第二次是階梯第 2 格", async () => {
  assertEquals(await days("auto:progress_stale:xyz", "not_found"), 2);
  assertEquals(await days("auto:progress_stale:xyz", "not_found", 1), 30);
  assertEquals(await days("auto:deadline_due:xyz", "not_found", 1), 30);
  assertEquals(await days("auto:policy_missing:xyz", "not_found", 3), CHECK_LADDER_DAYS.not_found[2]);
});

Deno.test("A3 SQL 與 TS 的查無冷卻天數一致", async () => {
  const fn = await latestFn("task_not_found_cooldown_days(");
  const m = fn.match(/SELECT\s+(\d+)\s+\$\$/);
  assert(m, "找不到天數");
  assertEquals(Number(m![1]), NOT_FOUND_COOLDOWN_DAYS);
});

// ---- B. applyNoChange ----
type Row = Record<string, unknown>;
function fakeSupabase(manualTask: { task_type: string } | null) {
  const inserted: Array<{ table: string; row: Row }> = [];
  const closed: string[] = [];
  const fake = {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "contribution_tasks" ? manualTask : null, error: null }) }) }),
      insert: (row: Row) => { inserted.push({ table, row }); return { error: null, select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }; },
      update: () => { closed.push(table); return { eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "x" }, error: null }) }) }) }; },
    }),
  };
  return { fake, inserted, closed };
}
const nc = (task_id: string, outcome: string) => ({
  id: "c-1", contribution_type: "no_change", source_urls: ["https://example.org/a"], note: null, agent_name: "tester", contributor_url: null,
  payload: { task_id, outcome, checked_urls: ["https://example.org/a"], finding: "查過了" },
});

Deno.test("B1 auto: 任務 not_found（含號次、一般）記 task_checks，訊息講 2 天、不投票、重新派出", async () => {
  for (const id of ["auto:candidacy_source_missing:cand_no:abc", "auto:profile_gap:abc", "auto:progress_stale:abc"]) {
    const { fake, inserted } = fakeSupabase(null);
    const r = await applyContribution(fake as never, nc(id, "not_found") as never);
    assertEquals(r.status, "applied", id);
    assert(r.message.includes("不需要別人驗證") && /天/.test(r.message), r.message);
    assert(inserted.some((i) => i.table === "task_checks" && i.row.task_id === id && i.row.outcome === "not_found"), id);
  }
});

Deno.test("B2 手動任務 not_found：記 task_checks 進冷卻、不關任務；confirmed 仍關任務；任務不存在 superseded", async () => {
  const TASK = "0c9c1a5e-1111-4222-8333-444444444444";
  {
    const { fake, inserted, closed } = fakeSupabase({ task_type: "profile" });
    const r = await applyContribution(fake as never, nc(TASK, "not_found") as never);
    assertEquals(r.status, "applied");
    assert(inserted.some((i) => i.table === "task_checks" && i.row.task_id === TASK && i.row.outcome === "not_found" && i.row.contribution_id === "c-1"));
    assert(!closed.includes("contribution_tasks"), "不能關手動任務");
    assert(r.message.includes("不會馬上關閉"), r.message);
  }
  {
    const { fake, inserted } = fakeSupabase(null);
    const r = await applyContribution(fake as never, nc(TASK, "not_found") as never);
    assertEquals(r.status, "superseded");
    assertEquals(inserted.filter((i) => i.table === "task_checks").length, 0);
  }
  {
    const { fake, closed } = fakeSupabase({ task_type: "profile" });
    await applyContribution(fake as never, nc(TASK, "confirmed") as never);
    assert(closed.includes("contribution_tasks"), "confirmed 照舊關任務");
  }
});

// ---- C. 原始碼與 migration 守門 ----
Deno.test("C1 contribute-handler：not_found 的 no_change 直接落庫，reviewed_by 用共用常數，precheck 照跑", async () => {
  assertEquals(NOT_FOUND_DIRECT_REVIEWER, "system:not-found-direct");
  const src = (await Deno.readTextFile(new URL("./contribute-handler.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(/\.outcome === "not_found"/.test(src), "要判 outcome=not_found");
  assert(src.includes("reviewedBy: NOT_FOUND_DIRECT_REVIEWER"));
  assert(src.includes("reviewed_by: reviewedBy"), "寫庫的 reviewed_by 不能寫死 unreachable-precheck");
  // precheckSkip 在 notFoundDirect 併進 bypassNotes 之前建好：not_found 要經過落庫前置檢查
  assert(src.indexOf("const notFoundDirect") < src.indexOf("const precheckSkip"));
  assert(src.indexOf("const precheckSkip") < src.indexOf("const confirmed = (validation.items[i]"));
});

Deno.test("C2 cand_no_front_pull 最新版：冷卻中的缺口不拉（cool_until 與 task_checks 兩道）", async () => {
  const fn = await latestFn("cand_no_front_pull(");
  assert(fn.includes("d.cool_until IS NULL OR d.cool_until <= now()"));
  assert(/task_checks tc[\s\S]*tc\.outcome = 'not_found'[\s\S]*task_not_found_cooldown_days\(\)/.test(fn));
});

Deno.test("C3 舊資料清理區塊：只動 pending 的 no_change not_found，寫 task_checks 與共用 reviewed_by，收掉驗證票", async () => {
  const sql = (await migrationTexts()).find(([n]) => n.startsWith("20261107000000"))![1];
  assert(sql.includes("c.status = 'pending' AND c.payload->>'outcome' = 'not_found'"));
  assert(sql.includes(`reviewed_by = '${NOT_FOUND_DIRECT_REVIEWER}'`));
  assert(sql.includes("'verify:' || n.id::text"));
  assert(sql.includes("NOT EXISTS (SELECT 1 FROM task_checks x WHERE x.contribution_id = n.id)"), "task_checks 插入要可重跑");
});
