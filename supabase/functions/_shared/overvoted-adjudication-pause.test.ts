// 投太多輪的裁決：不插隊、暫停開新的（20261017030000，維護者 2026-10-17）
// 還原驗證：拿掉 manual_front_seconds 的 auto-overvoted 分支，或拿掉 cron.unschedule，對應那一項會紅。
import { assert, assertStringIncludes } from "jsr:@std/assert@1";
import { latestFn, readMig } from "./arms-pglite.ts";

const MIG = "20261017030000_overvoted_adjudication_pause.sql";

Deno.test("manual_front_seconds 的現行版：auto-overvoted 開的裁決任務 0 秒，而且排在其他分支之前", async () => {
  const fn = await latestFn("manual_front_seconds");
  const i = fn.indexOf("t.created_by = 'auto-overvoted' THEN 0");
  assert(i > 0, "現行 manual_front_seconds 要有 auto-overvoted → 0");
  assert(i < fn.indexOf("manual_task_is_visitor"), "auto-overvoted 分支要在網站請求與裁決 5 年之前判斷");
});

Deno.test("overvoted-tick-10min 暫停：這支 migration unschedule，之後沒有 migration 重新排回去", async () => {
  const sql = await readMig(MIG);
  assertStringIncludes(sql, "cron.unschedule('overvoted-tick-10min')");
  const later: string[] = [];
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) {
    if (e.name > MIG && e.name.endsWith(".sql")) later.push(e.name);
  }
  for (const f of later) {
    const s = await readMig(f);
    assert(!/cron\.schedule\(\s*'overvoted-tick-10min'/.test(s), `${f} 重新排了 overvoted-tick-10min：恢復裁決要先經維護者同意，並改這支測試`);
  }
});
