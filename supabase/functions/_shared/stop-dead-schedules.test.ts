// 停掉已死排程（20261101010000）：news-sweep-refresh 被 unschedule，之後沒有 migration 重新排回去。
// 還原驗證：拿掉 migration 裡的 cron.unschedule('news-sweep-refresh')，第一項會紅。
import { assert, assertStringIncludes } from "jsr:@std/assert@1";
import { readMig } from "./arms-pglite.ts";

const MIG = "20261101010000_stop_dead_schedules.sql";

Deno.test("news-sweep-refresh 已停：這支 migration unschedule，函式保留，之後沒人重排", async () => {
  const sql = await readMig(MIG);
  assertStringIncludes(sql, "cron.unschedule('news-sweep-refresh')");
  assert(!/DROP FUNCTION[^;]*news_sweep_refresh_tasks/i.test(sql), "只停排程，函式要保留以便恢復");
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) {
    if (e.name > MIG && e.name.endsWith(".sql")) {
      const s = await readMig(e.name);
      assert(!/cron\.schedule\(\s*'news-sweep-refresh'/.test(s), `${e.name} 重新排了 news-sweep-refresh：恢復前要先經維護者同意，並改這支測試`);
    }
  }
});
