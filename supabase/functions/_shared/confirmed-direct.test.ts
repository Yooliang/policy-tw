/**
 * 「確認無誤」不進投票＋統一查核階梯（2026-11-09，小良；migration 20261109150000，協議 1.123.0）。
 *   A. SQL 設定表初值與 TS CHECK_LADDER_DAYS 一致；例外清單 SQL／TS 一致
 *   B. 階梯：同一任務 not_found＋confirmed 合計計次，第 n 次取該筆 outcome 的第 n 格，超過＝結案；各 outcome 各一列、可獨立改
 *   C. contribute-handler 把 confirmed 的 no_change 接上直接落庫；舊資料清理區塊；refresh_dispatch_blocked 把結案的 auto: 任務 blocked
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyContribution, CHECK_LADDER_DAYS, CONFIRMED_DIRECT_REVIEWER, isLadderExempt, LADDER_EXEMPT_TASK_TYPES } from "./apply-contribution.ts";

const MIG_PREFIX = "20261109150000";
const MIGRATIONS = new URL("../../migrations/", import.meta.url);
async function mig(): Promise<string> {
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.name.startsWith(MIG_PREFIX)) return (await Deno.readTextFile(new URL(e.name, MIGRATIONS))).replace(/\r\n/g, "\n");
  throw new Error("migration not found");
}
function fnBody(sql: string, sig: string): string {
  const at = sql.indexOf(`CREATE OR REPLACE FUNCTION ${sig}`);
  assert(at >= 0, sig);
  const body = sql.slice(at);
  return body.slice(0, body.indexOf("$$;", body.indexOf("$$") + 2) + 3);
}

async function ladderDb(notFound: readonly number[] = CHECK_LADDER_DAYS.not_found, confirmed: readonly number[] = CHECK_LADDER_DAYS.confirmed) {
  const sql = await mig();
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE task_cooldown_settings (id integer PRIMARY KEY, enabled boolean, task_types text[], not_found_first_days integer, not_found_repeat_days integer);
    INSERT INTO task_cooldown_settings VALUES (1, true, ARRAY['progress_stale','deadline_due'], 14, 30);
    CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text, outcome text, checked_at timestamptz DEFAULT now());
    CREATE TABLE task_check_ladder_settings (outcome text PRIMARY KEY, days integer[] NOT NULL);
    INSERT INTO task_check_ladder_settings VALUES ('not_found', ARRAY[${notFound.join(",")}]), ('confirmed', ARRAY[${confirmed.join(",")}]);
    CREATE FUNCTION task_unreachable_cooldown_days() RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$;
    CREATE FUNCTION task_check_cooldown_days() RETURNS integer LANGUAGE sql AS $$ SELECT 14 $$;
    CREATE FUNCTION task_not_found_cooldown_days() RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$;
    ${fnBody(sql, "task_check_ladder_days(")}
    ${fnBody(sql, "task_check_ladder_exempt(")}
    ${fnBody(sql, "task_check_cooldown_days_for(")}`);
  const v = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW task_ladder_closed"));
  await db.exec(v.slice(0, v.indexOf(";\n") + 1));
  return db;
}

/** 依序記 outcome，回每一筆的冷卻天數 */
async function walk(db: PGlite, taskId: string, outcomes: string[]): Promise<number[]> {
  const out: number[] = [];
  for (const o of outcomes) {
    const r = await db.query<{ id: number }>(`INSERT INTO task_checks (task_id, outcome) VALUES ($1, $2) RETURNING id`, [taskId, o]);
    const d = await db.query<{ d: number }>(`SELECT task_check_cooldown_days_for($1, $2, (SELECT checked_at FROM task_checks WHERE id = $3), $3) AS d`, [taskId, o, r.rows[0].id]);
    out.push(d.rows[0].d);
  }
  return out;
}

Deno.test("A1 SQL 設定表初值＝TS CHECK_LADDER_DAYS（not_found 5/10/20、confirmed 5/10）", async () => {
  const sql = await mig();
  const tail = sql.slice(sql.indexOf("INSERT INTO task_check_ladder_settings"));
  for (const o of ["not_found", "confirmed"] as const) {
    const m = new RegExp(`'${o}', ARRAY\\[([0-9, ]+)\\]`).exec(tail);
    assert(m, o);
    assertEquals(m![1].split(",").map((x) => Number(x.trim())), [...CHECK_LADDER_DAYS[o]]);
  }
  assertEquals([...CHECK_LADDER_DAYS.not_found], [5, 10, 20]);
  assertEquals([...CHECK_LADDER_DAYS.confirmed], [5, 10]);
});

Deno.test("A2 例外清單 SQL 與 TS 一致", async () => {
  const sql = await mig();
  const fn = fnBody(sql, "task_check_ladder_exempt(");
  for (const t of LADDER_EXEMPT_TASK_TYPES) {
    if (t === "progress_stale" || t === "deadline_due") continue; // 這兩個來自 task_cooldown_settings.task_types
    assert(fn.includes(`'${t}'`), t);
  }
  const db = await ladderDb();
  const ids = ["auto:progress_stale:x", "auto:deadline_due:x", "auto:not_running_recheck:1", "auto:roster_check:z", "auto:candidacy_source_missing:cand_no:a",
    "auto:candidacy_source_missing:cand_no_recheck:a", "auto:profile_gap:x", "auto:candidacy_source_missing:party:a", "0c9c1a5e-1111-4222-8333-444444444444"];
  for (const id of ids) {
    const r = await db.query<{ e: boolean }>(`SELECT task_check_ladder_exempt($1) AS e`, [id]);
    assertEquals(r.rows[0].e, isLadderExempt(id), id);
  }
});

Deno.test("B1 階梯：not_found＋confirmed 合計計次，天數看當下那筆的 outcome；超過該 outcome 的格數進結案視圖（第 3 次 confirmed 結案、第 4 次 not_found 結案）", async () => {
  const db = await ladderDb();
  const T = "auto:policy_missing:p1";
  assertEquals(await walk(db, T, ["not_found", "confirmed", "not_found", "confirmed"]), [5, 10, 20, 10]);
  const closed = await db.query<{ task_id: string }>(`SELECT task_id FROM task_ladder_closed`);
  assertEquals(closed.rows.map((r) => r.task_id), [T]);
  const db2 = await ladderDb();
  await walk(db2, T, ["confirmed", "confirmed"]);
  assertEquals((await db2.query(`SELECT 1 FROM task_ladder_closed`)).rows.length, 0);
  await walk(db2, T, ["confirmed"]); // 第 3 次 confirmed 超過 {5,10} → 結案
  assertEquals((await db2.query(`SELECT 1 FROM task_ladder_closed`)).rows.length, 1);
});

Deno.test("B2 各 outcome 獨立設定：confirmed 只有 1 格，第 2 次查核就結案；not_found 5/10/20", async () => {
  const db = await ladderDb([5, 10, 20], [5]);
  assertEquals(await walk(db, "auto:policy_missing:a", ["confirmed", "confirmed"]), [5, 5]);
  assertEquals((await db.query<{ task_id: string }>(`SELECT task_id FROM task_ladder_closed`)).rows.map((r) => r.task_id), ["auto:policy_missing:a"]);
  assertEquals(await walk(db, "auto:policy_missing:b", ["not_found", "not_found", "not_found"]), [5, 10, 20]);
  assertEquals((await db.query(`SELECT 1 FROM task_ladder_closed`)).rows.length, 1);
});

Deno.test("B3 例外型別不結案：進度類 2→30、號次缺口 2、confirmed 14；unreachable 2 不進階梯", async () => {
  const db = await ladderDb();
  assertEquals(await walk(db, "auto:progress_stale:a", ["not_found", "not_found", "not_found", "not_found", "not_found"]), [2, 30, 30, 30, 30]);
  assertEquals(await walk(db, "auto:candidacy_source_missing:cand_no:a", ["not_found", "not_found", "not_found", "not_found", "confirmed"]), [2, 2, 2, 2, 14]);
  assertEquals(await walk(db, "auto:policy_missing:u", ["unreachable", "unreachable", "unreachable", "unreachable", "unreachable"]), [2, 2, 2, 2, 2]);
  assertEquals((await db.query(`SELECT 1 FROM task_ladder_closed`)).rows.length, 0);
});

Deno.test("C1 contribute-handler：confirmed 的 no_change 直接落庫，reviewed_by 用共用常數", async () => {
  assertEquals(CONFIRMED_DIRECT_REVIEWER, "system:confirmed-direct");
  const src = (await Deno.readTextFile(new URL("./contribute-handler.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(/outcome === "confirmed"/.test(src));
  assert(src.includes("reviewedBy: CONFIRMED_DIRECT_REVIEWER"));
  assert(src.indexOf("const precheckSkip") < src.indexOf("const confirmed = (validation.items[i]"), "precheck 要在併進 bypassNotes 之前跑");
});

Deno.test("C2 舊資料清理區塊：只動 pending 的 no_change confirmed，共用 reviewed_by、收驗證票、可重跑，最後 refresh 結案", async () => {
  const sql = await mig();
  assert(sql.includes("c.status = 'pending' AND c.payload->>'outcome' = 'confirmed'"));
  assert(sql.includes(`reviewed_by = '${CONFIRMED_DIRECT_REVIEWER}'`));
  assert(sql.includes("'verify:' || n.id::text"));
  assert(sql.includes("NOT EXISTS (SELECT 1 FROM task_checks x WHERE x.contribution_id = n.id)"));
  assert(sql.trimEnd().endsWith("SELECT refresh_dispatch_blocked();"));
  // ON CONFLICT DO UPDATE 不能在同一條 INSERT 兩次碰同一列（正式庫同一個人有多筆等票的 duplicate_policy，第一次部署因此失敗）：兩個 upsert 都要先 DISTINCT ON
  assert(/INSERT INTO policy_dupe_reviews[\s\S]*?SELECT DISTINCT ON \(m\[1\]::uuid\)/.test(sql), "policy_dupe_reviews 要 DISTINCT ON 人物");
  assert(/INSERT INTO lineage_candidate_reviews[\s\S]*?SELECT DISTINCT ON \(k\.review_key\)/.test(sql), "lineage_candidate_reviews 要 DISTINCT ON review_key");
});

Deno.test("C3 refresh_dispatch_blocked：結案的 auto: 任務永久 blocked，手動任務關閉", async () => {
  const sql = await mig();
  const fn = fnBody(sql, "refresh_dispatch_blocked(");
  assert(/UNION SELECT lc\.task_id FROM task_ladder_closed lc WHERE lc\.task_id LIKE 'auto:%'/.test(fn));
  assert(/UPDATE contribution_tasks t SET status = 'closed'[\s\S]*task_ladder_closed/.test(fn));
});

Deno.test("D confirmed 落庫後 applyNoChange 的訊息講階梯（一般任務）", async () => {
  const fake = {
    from: () => ({
      insert: () => ({ error: null, select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  };
  const row = {
    id: "c", contribution_type: "no_change", source_urls: ["https://e.org/a"], note: null, agent_name: "t", contributor_url: null,
    payload: { task_id: "auto:profile_gap:abc", outcome: "confirmed", checked_urls: ["https://e.org/a"], finding: "ok" },
  };
  const r = await applyContribution(fake as never, row as never);
  assertEquals(r.status, "applied");
  assert(r.message.includes("不需要別人驗證") && r.message.includes(String(CHECK_LADDER_DAYS.confirmed[0])), r.message);
});
