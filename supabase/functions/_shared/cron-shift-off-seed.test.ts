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
