/**
 * vote_baseline 每小時重算（migration 20261121111500_vote_baseline_hourly.sql，2026-11-21）守門。
 *   只看文字：排程分鐘不在整十分鐘（seed 的分鐘）、不與 20261121002500 搬過的分鐘重複、先 unschedule 再 schedule、
 *   pg_cron 不在時略過、migration 內有立刻重算一次。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (f: string) => (await Deno.readTextFile(new URL(f, MIGRATIONS))).replace(/\r\n/g, "\n");
const mig = await read("20261121111500_vote_baseline_hourly.sql");
const shift = await read("20261121002500_cron_shift_off_seed_minutes.sql");
const code = mig.replace(/^--.*$/gm, "");

const sched = code.match(/cron\.schedule\('vote-baseline-hourly',\s*'([^']+)',\s*'([^']+)'\)/);

Deno.test("V1 每小時一次、呼叫 public 的重算函數", () => {
  assert(sched, "找不到 vote-baseline-hourly 排程");
  const f = sched![1].split(" ");
  assert(/^\d+$/.test(f[0]));
  assertEquals(f.slice(1).join(" "), "* * * *");
  assertEquals(sched![2], "SELECT public.contribution_vote_baseline_refresh();");
});

Deno.test("V2 分鐘不在整十分鐘（seed）、不與上一輪搬過的分鐘重複", () => {
  const m = Number(sched![1].split(" ")[0]);
  assert(m % 10 !== 0, `落在 seed 的 :${m}`);
  const body = shift.slice(shift.indexOf("FROM (VALUES"), shift.indexOf(") AS m(jobname, new_schedule)"));
  const used = new Set<number>();
  for (const x of body.matchAll(/'([^']+)'\)/g)) {
    const field = x[1].split(" ")[0];
    const r = field.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (r) for (let k = +r[1]; k <= +r[2]; k += +r[3]) used.add(k);
    else for (const p of field.split(",")) if (/^\d+$/.test(p)) used.add(Number(p));
  }
  assert(!used.has(m), `:${m} 已被 20261121002500 使用`);
});

Deno.test("V3 先 unschedule 再 schedule、pg_cron 不在就略過、立刻重算一次", () => {
  assert(code.indexOf("cron.unschedule('vote-baseline-hourly')") < code.indexOf("cron.schedule('vote-baseline-hourly'"));
  assert(code.includes("to_regnamespace('cron') IS NOT NULL"));
  assert(/^SELECT public\.contribution_vote_baseline_refresh\(\);$/m.test(code));
});
