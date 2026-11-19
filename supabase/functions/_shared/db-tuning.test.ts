/**
 * 資料庫減負（migration 20261119160000_db_tuning.sql，2026-11-19）守門。
 *   A. 文字層：清理函式與排程在、seed 的 * /10 沒被動、不准動的 job 不在錯開名單、work_mem／statement_timeout／autovacuum 設定在、
 *      之後的 migration 重定義那兩支函式時不能把 work_mem 洗掉、錯開後每分鐘啟動數不超過上限。
 *   B. PGlite：真的跑 cron_run_details_purge()（cron.job_run_details 用同欄位的假表）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const MIG = "20261119160000_db_tuning.sql";
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const mig = norm(await Deno.readTextFile(new URL(MIG, MIGRATIONS)));

/** 不准動（有時段語意或文件明寫分鐘） */
const UNTOUCHED = [
  "seed-auto-task-queue-10min", "cand-no-front-pull-hourly", "roster-reconcile-10min", "console-fetch-hourly",
  "bulletin-watch-daily", "bulletin-watch-hot", "cec-roster-mirror-5min", "system-one-evidence-5min",
  "pipeline-snapshot-hourly", "policy-jp-pipeline-snapshot-hourly", "dispatch-records-purge", "policy-jp-dispatch-records-purge",
];

function moves(): Array<[string, string]> {
  const body = mig.slice(mig.indexOf("FROM (VALUES"), mig.indexOf(") AS m(jobname, new_schedule)"));
  return [...body.matchAll(/\('([^']+)',\s*'([^']+)'\)/g)].map((m) => [m[1], m[2]]);
}

Deno.test("A1 清理函式、設定表與每天一次的排程", () => {
  assert(/CREATE OR REPLACE FUNCTION cron_run_details_purge\(\)/.test(mig));
  assert(/cron\.schedule\('cron-run-details-purge',\s*'55 19 \* \* \*'/.test(mig));
  assert(/cron\.unschedule\('cron-run-details-purge'\)/.test(mig));
  assert(/retention_days\s+INTEGER NOT NULL DEFAULT 7 CHECK \(retention_days BETWEEN 3 AND 365\)/.test(mig));
  assert(/end_time IS NOT NULL/.test(mig), "還在跑的（end_time 為 NULL）不能刪");
});

Deno.test("A2 錯開：不動 seed 的排程與名單內的 job", () => {
  const m = moves();
  assertEquals(m.length, 16);
  const names = m.map(([n]) => n);
  for (const u of UNTOUCHED) assert(!names.includes(u), `${u} 不該被錯開`);
  assertEquals(new Set(names).size, names.length);
});

Deno.test("A3 錯開後每分鐘啟動數 <= 4（含 cec-roster-mirror-5min 的每 5 分鐘）", () => {
  // 現況（2026-11-19 唯讀查正式庫）：[名稱, 週期, 起始分]；錯開名單覆蓋起始分
  const base: Array<[string, number, number]> = [
    ["apply-verified-10min", 10, 0], ["cec-sync-live-10min", 10, 0], ["cec-verify-10min", 10, 0], ["policy-jp-seed-10min", 10, 0],
    ["quota-snapshots-10min", 10, 0], ["seed-auto-task-queue-10min", 10, 0], ["regions-elected-policy-count-10min", 10, 1],
    ["policy-jp-lg-registry-verify", 10, 2], ["roster-batch-10min", 10, 2], ["cand-no-auto-10min", 10, 3],
    ["policy-jp-stat-registry-verify", 10, 3], ["roster-reconcile-units-10min", 10, 3], ["system-one-followup-clarify-10min", 10, 3],
    ["system-one-precheck-10min", 10, 3], ["cand-no-check-10min", 10, 4], ["moi-check-10min", 10, 4],
    ["web-request-gap-sync-10min", 10, 5], ["policy-jp-apply-verified", 10, 5], ["system-one-followups-10min", 10, 5],
    ["results-batch-10min", 10, 6], ["source-archive-10min", 10, 7], ["cec-results-auto-10min", 10, 7],
    ["policy-jp-system-one-precheck-10min", 10, 7], ["roster-reconcile-10min", 10, 7], ["reassign-check-10min", 10, 8],
    ["strong-lane-sweep-10min", 10, 8], ["system-one-identity-10min", 10, 8], ["system-one-vote-budget-10min", 10, 8],
    ["candidacy-map-stats-10min", 10, 9], ["system-one-evidence-5min", 5, 1], ["system-one-backfill-15min", 15, 0],
    ["platform-costs-15min", 15, 7], ["agent-usage-15min", 15, 11], ["system-one-legacy-30min", 30, 11],
    ["pipeline-snapshot-hourly", 60, 0], ["policy-jp-pipeline-snapshot-hourly", 60, 0], ["cand-no-front-pull-hourly", 60, 3],
    ["console-fetch-hourly", 60, 17], ["policy-jp-vote-baseline-hourly", 60, 17], ["news-fetch-hourly", 60, 5],
    ["policy-jp-news-fetch-hourly", 60, 23], ["system-one-bio-gaps-hourly", 60, 40], ["bulletin-watch-hot", 60, 41],
    ["roster-group-tasks-hourly", 60, 50], ["cec-roster-mirror-5min", 5, 0],
  ];
  const over = new Map(moves().map(([n, s]) => [n, s]));
  const load = Array(60).fill(0);
  for (const [n, p, b] of base) {
    const sched = over.get(n);
    const start = sched ? Number(sched.split(" ")[0].split(",")[0]) : b;
    for (let m = start % p; m < 60; m += p) load[m]++;
  }
  assert(Math.max(...load) <= 4, `某分鐘同時啟動 ${Math.max(...load)} 支：${load.join(",")}`);
});

Deno.test("A4 work_mem、statement_timeout、autovacuum 門檻", () => {
  assert(/ALTER FUNCTION public\.seed_auto_task_queue\(\) SET statement_timeout = '280s'/.test(mig));
  assert(/ALTER FUNCTION public\.seed_auto_task_queue\(\) SET work_mem = '16MB'/.test(mig));
  assert(/ALTER FUNCTION public\.contribution_auto_tasks_arms\(\) SET work_mem = '16MB'/.test(mig));
  for (const t of ["contribution_votes", "contributions", "task_dispatches", "jev_decisions"]) {
    assert(
      new RegExp(`ALTER TABLE public\\.${t}\\s+SET \\(autovacuum_analyze_scale_factor = 0\\.02, autovacuum_vacuum_scale_factor = 0\\.05\\)`).test(mig),
      t,
    );
  }
});

Deno.test("A5 之後的 migration 重定義這兩支函式要帶 work_mem（CREATE OR REPLACE 會洗掉 proconfig）", async () => {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql") && e.name > MIG) names.push(e.name);
  for (const n of names.sort()) {
    const sql = norm(await Deno.readTextFile(new URL(n, MIGRATIONS)));
    for (const fn of ["seed_auto_task_queue", "contribution_auto_tasks_arms"]) {
      const re = new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${fn}\\(\\)([\\s\\S]*?)\\$(\\w*)\\$`, "g");
      for (const m of sql.matchAll(re)) assert(/work_mem\s*=\s*'16MB'/.test(m[1]), `${n} 重定義 ${fn} 沒帶 SET work_mem`);
    }
  }
});

// ---------------- B. PGlite ----------------
async function setup() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA cron;
    CREATE TABLE cron.job_run_details (runid BIGSERIAL PRIMARY KEY, jobid BIGINT, status TEXT, start_time TIMESTAMPTZ, end_time TIMESTAMPTZ);`);
  const table = mig.match(/CREATE TABLE IF NOT EXISTS cron_run_details_settings \([\s\S]*?\n\);/)![0];
  await db.exec(table);
  await db.exec(`INSERT INTO cron_run_details_settings (id) VALUES (1)`);
  const fn = mig.match(/CREATE OR REPLACE FUNCTION cron_run_details_purge\(\)[\s\S]*?\n\$\$;/)![0];
  await db.exec(fn);
  return db;
}
const seedRows = (db: PGlite, days: number, n: number, ended = true) =>
  db.exec(`INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
    SELECT 1, 'succeeded', now() - interval '${days} days', ${ended ? `now() - interval '${days} days'` : "NULL"} FROM generate_series(1, ${n})`);
const count = async (db: PGlite) => Number((await db.query<{ c: string }>(`SELECT count(*) c FROM cron.job_run_details`)).rows[0].c);
const purge = async (db: PGlite) =>
  (await db.query<{ r: { enabled: boolean; job_run_details: number } }>(`SELECT cron_run_details_purge() r`)).rows[0].r;

Deno.test("B1 只刪超過保留天數的、還在跑的不刪", async () => {
  const db = await setup();
  await seedRows(db, 10, 30);
  await seedRows(db, 2, 20);
  await seedRows(db, 10, 5, false);
  assertEquals((await purge(db)).job_run_details, 30);
  assertEquals(await count(db), 25);
  assertEquals((await purge(db)).job_run_details, 0);
});

Deno.test("B2 批量上限、停用、CHECK 下限", async () => {
  const db = await setup();
  await seedRows(db, 10, 450);
  await db.exec(`UPDATE cron_run_details_settings SET batch_size = 100, max_batches = 2`);
  assertEquals((await purge(db)).job_run_details, 200);
  assertEquals(await count(db), 250);
  await db.exec(`UPDATE cron_run_details_settings SET enabled = false`);
  assertEquals((await purge(db)).enabled, false);
  assertEquals(await count(db), 250);
  let failed = false;
  try {
    await db.exec(`UPDATE cron_run_details_settings SET retention_days = 1`);
  } catch {
    failed = true;
  }
  assert(failed, "retention_days < 3 應被 CHECK 擋下");
});
