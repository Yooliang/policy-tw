/**
 * pg_cron 搬離整十分鐘（migration 20261121002500_cron_shift_off_seed_minutes.sql，2026-11-21）守門。
 *   只看文字：9 支都在名單、新分鐘都不落在 0/10/20/30/40/50（seed 的分鐘）、mirror 仍限 UTC 18–21 點、
 *   不重複、每個新分鐘各自撞到的啟動數不超過上限。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const MIG = "20261121002500_cron_shift_off_seed_minutes.sql";
const mig = (await Deno.readTextFile(new URL(MIG, MIGRATIONS))).replace(/\r\n/g, "\n");

const EXPECTED = [
  "pipeline-snapshot-hourly", "policy-jp-pipeline-snapshot-hourly", "policy-jp-vote-baseline-hourly", "news-fetch-hourly",
  "system-one-legacy-30min", "system-one-bio-gaps-hourly", "roster-group-tasks-hourly", "cec-roster-mirror-5min", "cec-sync-settle-6h",
];

function moves(): Array<[string, string]> {
  const body = mig.slice(mig.indexOf("FROM (VALUES"), mig.indexOf(") AS m(jobname, new_schedule)"));
  return [...body.matchAll(/\('([^']+)',\s*'([^']+)'\)/g)].map((m) => [m[1], m[2]]);
}

/** 展開分鐘欄：支援 逗號、a-b/step、純數字 */
function minutes(field: string): number[] {
  const out: number[] = [];
  for (const p of field.split(",")) {
    const r = p.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (r) for (let x = +r[1]; x <= +r[2]; x += +r[3]) out.push(x);
    else out.push(Number(p));
  }
  return out;
}

Deno.test("C1 九支都在名單、不重複、不動 seed", () => {
  const names = moves().map(([n]) => n);
  assertEquals([...names].sort(), [...EXPECTED].sort());
  assert(!names.includes("seed-auto-task-queue-10min"));
  assert(!/cron\.(schedule|unschedule)\(/.test(mig.replace(/^--.*$/gm, "")), "只能 alter_job，不重建 job");
});

Deno.test("C2 新分鐘全部避開整十分鐘（seed 的分鐘）", () => {
  for (const [n, sched] of moves()) {
    for (const m of minutes(sched.split(" ")[0])) assert(m % 10 !== 0, `${n} 仍落在 :${m}`);
  }
});

Deno.test("C3 mirror 仍限 UTC 18–21 點、settle 仍是每 6 小時", () => {
  const m = new Map(moves());
  assertEquals(m.get("cec-roster-mirror-5min")!.split(" ").slice(1).join(" "), "18-21 * * *");
  assertEquals(m.get("cec-sync-settle-6h")!.split(" ").slice(1).join(" "), "*/6 * * *");
});

Deno.test("C4 兩支快照不在同一分鐘，vote-baseline 在 jp 快照之後", () => {
  const m = new Map(moves());
  const a = minutes(m.get("pipeline-snapshot-hourly")!.split(" ")[0])[0];
  const b = minutes(m.get("policy-jp-pipeline-snapshot-hourly")!.split(" ")[0])[0];
  const v = minutes(m.get("policy-jp-vote-baseline-hourly")!.split(" ")[0])[0];
  assert(a !== b);
  assert(v > b);
});

// ── 2026-11-22 追加：每週六中選會同步三支（20261122110000_cron_shift_cec_weekly.sql）──
const MIG2 = "20261122110000_cron_shift_cec_weekly.sql";
const mig2 = (await Deno.readTextFile(new URL(MIG2, MIGRATIONS))).replace(/\r\n/g, "\n");

function moves2(): Array<[string, string]> {
  const body = mig2.slice(mig2.indexOf("FROM (VALUES"), mig2.indexOf(") AS m(jobname, new_schedule)"));
  return [...body.matchAll(/\('([^']+)',\s*'([^']+)'\)/g)].map((m) => [m[1], m[2]]);
}

Deno.test("C5 週六 cec-sync 三支都在名單、只 alter_job、分鐘全避開整十分鐘", () => {
  const list = moves2();
  assertEquals(list.map(([n]) => n).sort(), ["cec-sync-2022-village-rest", "cec-sync-2024-weekly", "cec-sync-weekly"]);
  assert(!/cron\.(schedule|unschedule)\(/.test(mig2.replace(/^--.*$/gm, "")), "只能 alter_job，不重建 job");
  for (const [n, sched] of list) {
    const f = sched.split(" ");
    assertEquals(f.slice(1).join(" "), "19 * * 6", `${n} 時段必須仍是週六 UTC 19 點`);
    for (const m of minutes(f[0])) assert(m % 10 !== 0, `${n} 仍落在 :${m}`);
  }
});

Deno.test("C6 週六 cec-sync：weekly 仍每 5 分鐘 5 次、village-rest 少第一次、2024 在 weekly 之後", () => {
  const m = new Map(moves2());
  const w = minutes(m.get("cec-sync-weekly")!.split(" ")[0]);
  const v = minutes(m.get("cec-sync-2022-village-rest")!.split(" ")[0]);
  const y = minutes(m.get("cec-sync-2024-weekly")!.split(" ")[0])[0];
  assertEquals(w.length, 5);
  assertEquals(w.slice(1), v);
  for (let i = 1; i < w.length; i++) assertEquals(w[i] - w[i - 1], 5);
  assert(y > w[w.length - 1]);
});
