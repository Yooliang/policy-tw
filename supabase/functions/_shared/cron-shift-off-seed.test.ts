/**
 * pg_cron 搬離整十分鐘（migration 20261121002500_cron_shift_off_seed_minutes.sql，2026-11-21）守門。
 *   只看文字：9 支都在名單、新分鐘都不落在 0/10/20/30/40/50（seed 的分鐘）、mirror 仍限 UTC 18–21 點、
 *   不重複、每個新分鐘各自撞到的啟動數不超過上限。
 *   C8～C10（2026-11-27）：整表重算類的重 job 名單不落在 seed 前後一分鐘（:x9、:x0、:x1）。
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

// ── 2026-11-22 追加：整體斷言（20261122130000_cron_shift_remaining_ten_minutes.sql）──
// 依檔名順序讀所有 migration，取每支 job 最後一次的排程（cron.schedule('名','排程' 或 alter_job 的 VALUES 對），
// 斷言除 seed 外沒有任何 job 的分鐘欄含整十分鐘。
function finalSchedules(): Map<string, string> {
  const out = new Map<string, string>();
  const files = [...Deno.readDirSync(MIGRATIONS)].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
  for (const f of files) {
    const txt = Deno.readTextFileSync(new URL(f, MIGRATIONS)).replace(/\r\n/g, "\n").replace(/^--.*$/gm, "");
    const events: Array<{ at: number; name: string; sched: string | null }> = [];
    for (const m of txt.matchAll(/cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) events.push({ at: m.index!, name: m[1], sched: m[2] });
    for (const m of txt.matchAll(/cron\.unschedule\(\s*'([^']+)'\s*\)/g)) events.push({ at: m.index!, name: m[1], sched: null });
    for (const m of txt.matchAll(/cron\.unschedule\(j\.jobid\)[^;]*jobname\s*=\s*'([^']+)'/g)) events.push({ at: m.index!, name: m[1], sched: null });
    if (txt.includes("cron.alter_job")) {
      for (const m of txt.matchAll(/\(\s*'([a-z0-9-]+)'\s*,\s*'([^']+)'\s*\)/g)) events.push({ at: m.index!, name: m[1], sched: "alter:" + m[2] });
    }
    for (const e of events.sort((x, y) => x.at - y.at)) {
      if (e.sched === null) out.delete(e.name);
      else if (e.sched.startsWith("alter:")) { if (out.has(e.name)) out.set(e.name, e.sched.slice(6)); }
      else out.set(e.name, e.sched);
    }
  }
  return out;
}

Deno.test("C7 整體：除 seed 外，任何 cron 工作的分鐘欄都不含整十分鐘", () => {
  const all = finalSchedules();
  assert(all.size > 10, "解析到的 job 數太少，解析器壞了");
  for (const n of ["cec-sync-2022-weekly", "cec-sync-2022-rest", "cec-reconcile-weekly", "news-items-retention-weekly"]) {
    assert(all.has(n), `${n} 沒解析到`);
  }
  for (const [name, sched] of all) {
    if (name === "seed-auto-task-queue-10min") continue;
    const f = sched.split(" ")[0];
    const mins = f.startsWith("*/") ? Array.from({ length: Math.floor(60 / +f.slice(2)) }, (_, i) => i * +f.slice(2)) : minutes(f);
    for (const m of mins) assert(m % 10 !== 0, `${name} (${sched}) 仍落在 :${m}`);
  }
});

// ── 2026-11-27 追加：重 job 不與 seed 同分鐘（20261127063000_cron_stagger_heavy_off_seed.sql）──
// 13:56 資料庫記憶體撞頂重啟：整表重算類的 job 與 seed（:x0 起跑約 60～120 秒）疊在同一分鐘。
// 重 job 名單常數；之後新增整表重算類排程，請加進來。
const HEAVY_JOBS = ["regions-elected-policy-count-10min", "candidacy-map-stats-10min", "queue-task-counts-refresh"];
const SEED_JOB = "seed-auto-task-queue-10min";

// 展開一支 job 一小時內會起跑的分鐘（處理 每n分、逗號、a-b/n、純數字，足以涵蓋目前所有排程）
function firingMinutes(sched: string): number[] {
  const f = sched.split(" ")[0];
  if (f.startsWith("*/")) return Array.from({ length: Math.floor(60 / +f.slice(2)) }, (_, i) => i * +f.slice(2));
  if (f === "*") return Array.from({ length: 60 }, (_, i) => i);
  return minutes(f).length ? minutes(f) : [];
}

Deno.test("C8 重 job 名單：最新排程都解析得到，且不落在 seed 起跑的 :x9／:x0／:x1", () => {
  const all = finalSchedules();
  assert(all.has(SEED_JOB), "seed 排程沒解析到");
  const seedTails = new Set(firingMinutes(all.get(SEED_JOB)!).map((m) => m % 10));
  assertEquals([...seedTails], [0], "seed 預期是 */10");
  const danger = new Set([9, 0, 1]); // seed 起跑前一分鐘、當分鐘、後一分鐘（seed 跑 60～120 秒）
  for (const n of HEAVY_JOBS) {
    assert(all.has(n), `${n} 沒解析到`);
    for (const m of firingMinutes(all.get(n)!)) assert(!danger.has(m % 10), `${n} (${all.get(n)}) 仍落在 :${m}`);
  }
});

Deno.test("C9 重 job 的起跑分鐘：兩支重 job 不同分鐘、該分鐘每小時都跑的 job 不超過 5 支、避開 :29／:35", () => {
  const all = finalSchedules();
  const byMinute = new Map<number, string[]>();
  for (const [n, s] of all) {
    const f = s.split(" ");
    if (f[1] !== "*" || f[4] !== "*") continue; // 只看每小時都跑的（每日／每週的不會天天疊在同一時段）
    for (const m of new Set(firingMinutes(s))) byMinute.set(m, [...(byMinute.get(m) ?? []), n]);
  }
  for (const n of HEAVY_JOBS) {
    for (const m of firingMinutes(all.get(n)!)) {
      const here = byMinute.get(m) ?? [];
      assert(here.length <= 5, `:${m} 每小時都跑的 job 有 ${here.length} 支：${here.join(", ")}`);
      assert(m !== 29 && m !== 35, `${n} 落在 :${m}`);
      const otherHeavy = here.filter((x) => HEAVY_JOBS.includes(x) && x !== n);
      assertEquals(otherHeavy, [], `:${m} 同時有兩支重 job`);
    }
  }
});

Deno.test("C10 20261127063000 只用 alter_job 換三支重 job 的排程分鐘欄，後四欄不動", () => {
  const MIG3 = "20261127063000_cron_stagger_heavy_off_seed.sql";
  const body = Deno.readTextFileSync(new URL(MIG3, MIGRATIONS)).replace(/\r\n/g, "\n").replace(/^--.*$/gm, "");
  assert(!/cron\.(schedule|unschedule)\(/.test(body), "只能 alter_job，command 不重抄");
  const rows = [...body.matchAll(/\('([a-z0-9-]+)',\s*'([^']+)'\)/g)].map((m) => [m[1], m[2]] as const);
  assertEquals(rows.map(([n]) => n).sort(), [...HEAVY_JOBS].sort());
  for (const [n, s] of rows) assertEquals(s.split(" ").slice(1).join(" "), "* * * *", `${n} 後四欄必須仍是 * * * *`);
});
