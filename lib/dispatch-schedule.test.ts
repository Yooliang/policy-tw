import { assert, assertEquals } from "jsr:@std/assert@1";
import { DAILY_GROUPS, STAGE_META, armGroup, armLabel, fromDay, makeScale, milestoneLabel, toDay } from "./dispatch-schedule.ts";

Deno.test("日期與天數互轉", () => {
  assertEquals(fromDay(toDay("2026-11-28")), "2026-11-28");
  assertEquals(toDay("2026-11-29") - toDay("2026-11-28"), 1);
});

Deno.test("比例尺：單調遞增、貼齊兩端、近的日期不被遠的擠扁", () => {
  const d = (s: string) => toDay(s);
  const x = makeScale([d("2026-08-30"), d("2026-10-20"), d("2026-11-28"), d("2030-12-25")]);
  assertEquals(x(d("2000-01-01")), 0);
  assertEquals(x(d("2040-01-01")), 100);
  assert(x(d("2026-08-30")) < x(d("2026-10-20")));
  assert(x(d("2026-10-20")) < x(d("2026-11-28")));
  assert(x(d("2026-11-28")) < x(d("2030-12-25")));
  // 登記到投票這 90 天要比一整年的任期後段寬得多，不能被四年任期擠成一條線
  assert(x(d("2026-11-28")) - x(d("2026-08-30")) > 10);
});

Deno.test("段落標籤沒有編號、七段齊全", () => {
  for (let i = 1; i <= 7; i++) assert(!/^\d/.test(STAGE_META[i].label), `第 ${i} 段標籤不該以編號開頭`);
  assertEquals(Object.keys(STAGE_META).length, 7);
  assertEquals(STAGE_META[3].label, "登記後到投票");
});

Deno.test("名稱與歸類：查得到中文名、查不到原樣、未登記的歸未歸類", () => {
  assertEquals(armLabel("ballot_numbers"), "補號次");
  assertEquals(armLabel("no_such_arm"), "no_such_arm");
  assertEquals(armGroup("manual_visitor"), "passive");
  assertEquals(armGroup("dup"), "cleanup");
  assertEquals(armGroup("legacy"), "backlog");
  assertEquals(armGroup("ballot_numbers"), "election");
  assertEquals(armGroup("no_such_arm"), "unclassified");
  assertEquals(DAILY_GROUPS.map((g) => g.key), ["cleanup", "backlog", "unclassified"]);
  assertEquals(milestoneLabel("polling"), "投票日");
});
