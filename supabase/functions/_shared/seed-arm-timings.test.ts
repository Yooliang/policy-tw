/**
 * seed 排程各段／各臂計時（migration 20261126150000_seed_arm_timings.sql，2026-11-26）守門，文字層。
 *   · 小表 seed_arm_timings：欄位、索引、RLS 開、不給 anon／authenticated 任何權限、沒有 policy
 *   · seed 本體與前一版（20261121193000）逐行相同，只多了標「各段計時」的行與宣告；兩個函式層級 SET 還在
 *   · 探針逐臂單獨呼叫，臂清單與總表的臂函式對得上；排程不排在整十分鐘
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const mig = await read("20261126150000_seed_arm_timings.sql");
const prev = await read("20261121193000_priority_bands.sql");
const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const sql = noComments(mig);

/** 取 seed_auto_task_queue() 本體（兩個 $$ 之間） */
function seedBody(src: string): string {
  const start = src.lastIndexOf("FUNCTION seed_auto_task_queue()");
  assert(start >= 0, "找不到 seed_auto_task_queue 定義");
  const open = src.indexOf("$$", start);
  const close = src.indexOf("$$", open + 2);
  return src.slice(open + 2, close);
}

Deno.test("A1 小表：欄位、索引、RLS、權限", () => {
  assert(/CREATE TABLE IF NOT EXISTS seed_arm_timings \(/.test(sql));
  for (const col of ["id\\s+BIGSERIAL PRIMARY KEY", "run_started_at TIMESTAMPTZ NOT NULL", "arm\\s+TEXT\\s+NOT NULL", "elapsed_ms\\s+INTEGER\\s+NOT NULL", "row_count\\s+INTEGER", "ok\\s+BOOLEAN\\s+NOT NULL DEFAULT true", "error\\s+TEXT"]) {
    assert(new RegExp(col).test(sql), `缺欄位 ${col}`);
  }
  assert(/CREATE INDEX IF NOT EXISTS seed_arm_timings_run_started_at_idx ON seed_arm_timings \(run_started_at\)/.test(sql));
  assert(/ALTER TABLE seed_arm_timings ENABLE ROW LEVEL SECURITY/.test(sql));
  assert(/REVOKE ALL ON TABLE seed_arm_timings FROM PUBLIC, anon, authenticated/.test(sql));
  assert(!/CREATE POLICY[\s\S]{0,80}seed_arm_timings/.test(sql), "不建任何 policy");
  assert(!/GRANT[^;]*seed_arm_timings/i.test(sql), "不給任何權限");
});

Deno.test("A2 seed 本體：拿掉各段計時的行之後與前一版逐行相同", () => {
  const strip = (b: string) =>
    b.split("\n").filter((l) => !l.includes("各段計時") && !/^\s*PERFORM seed_arm_timing_log/.test(l))
      .join("\n");
  const cur = seedBody(mig);
  const old = seedBody(prev);
  // 宣告行多了計時變數，其餘逐行比對
  const curLines = strip(cur).split("\n").filter((l) => !/^\s*DELETE FROM seed_arm_timings/.test(l));
  const oldLines = old.split("\n");
  assertEquals(curLines.filter((l) => l.trim() !== "").join("\n"), oldLines.filter((l) => l.trim() !== "").join("\n"));
});

Deno.test("A3 seed 函式帶著兩個函式層級 SET（CREATE OR REPLACE 會洗掉）", () => {
  const head = mig.slice(mig.lastIndexOf("FUNCTION seed_auto_task_queue()"));
  const pre = head.slice(0, head.indexOf("$$"));
  assert(/SET statement_timeout = '280s'/.test(pre));
  assert(/SET work_mem = '16MB'/.test(pre));
});

Deno.test("A4 寫小表失敗不能讓 seed 掛掉；保留 7 天", () => {
  const fn = sql.slice(sql.indexOf("FUNCTION seed_arm_timing_log"));
  assert(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/.test(fn));
  assert(/DELETE FROM seed_arm_timings WHERE run_started_at < now\(\) - INTERVAL '7 days'/.test(sql));
});

Deno.test("A5 探針：每臂只讀單獨呼叫，臂函式都存在、排程不在整十分鐘", async () => {
  const all = (await Promise.all([...Deno.readDirSync(MIGRATIONS)].map((e) => e.name).filter((n) => n.endsWith(".sql")).map(read))).join("\n");
  const probe = sql.slice(sql.indexOf("FUNCTION seed_arm_timing_probe"));
  const calls = [...probe.matchAll(/\('([a-z_]+)', '([a-z_]+)\(/g)].map((m) => m[2]);
  assert(calls.length >= 35, `臂數不足：${calls.length}`);
  for (const fn of new Set(calls)) {
    assert(new RegExp(`FUNCTION (public\\.)?${fn}\\(`).test(all), `函式不存在：${fn}`);
  }
  assert(!/INSERT INTO (?!seed_arm_timings)|UPDATE |DELETE FROM (?!seed_arm_timings)/.test(probe.slice(0, probe.indexOf("REVOKE ALL ON FUNCTION seed_arm_timing_probe"))), "探針只讀");
  const m = /cron\.schedule\('seed-arm-timing-probe-hourly', '(\S+) \* \* \* \*'/.exec(sql);
  assert(m, "找不到排程");
  assert(Number(m![1]) % 10 !== 0, "不排在整十分鐘");
});
