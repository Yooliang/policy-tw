import { assertEquals } from "jsr:@std/assert@1";
import { minutesUntilReset, quotaWindowEnd, quotaWindowFields, quotaWindowStart, taipeiClock } from "./quota-window.ts";

// 獨立算法：用 Intl 取台北牆上日期與小時，再組出 "+08:00" 的起點（不碰 quota-window.ts 的毫秒運算）
function expectedStart(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {} as Record<string, string>);
  const h = String(Math.floor(Number(parts.hour) / 4) * 4).padStart(2, "0");
  return new Date(`${parts.year}-${parts.month}-${parts.day}T${h}:00:00+08:00`).toISOString();
}

const cases: Array<[string, string]> = [
  // [現在（ISO）, 時段起點（台北牆上時間，給人對照）]
  ["2026-10-29T00:00:00+08:00", "2026-10-29T00:00:00+08:00"], // 台北日界剛好
  ["2026-10-28T23:59:59+08:00", "2026-10-28T20:00:00+08:00"], // 台北 23:59 仍在前一天的 20 點時段
  ["2026-10-29T03:59:59.999+08:00", "2026-10-29T00:00:00+08:00"],
  ["2026-10-29T04:00:00+08:00", "2026-10-29T04:00:00+08:00"],
  ["2026-10-29T07:59:00+08:00", "2026-10-29T04:00:00+08:00"],
  ["2026-10-29T12:30:00+08:00", "2026-10-29T12:00:00+08:00"],
  ["2026-10-29T19:59:59+08:00", "2026-10-29T16:00:00+08:00"],
  ["2026-10-29T20:00:00+08:00", "2026-10-29T20:00:00+08:00"],
  ["2026-10-29T00:30:00+08:00", "2026-10-29T00:00:00+08:00"], // UTC 還是 10-28、台北已是 10-29
  ["2026-10-28T16:00:00Z", "2026-10-29T00:00:00+08:00"], // 同上：UTC 16:00 ＝ 台北午夜
  ["2026-10-28T15:59:59Z", "2026-10-28T20:00:00+08:00"],
  ["2026-12-31T23:30:00Z", "2027-01-01T04:00:00+08:00"], // UTC 年底、台北已跨年
];

Deno.test("時段起點：逐案對齊台北牆上時間（跨台北日界、23:59→00:00、UTC 與台北日期不同）", () => {
  for (const [now, start] of cases) {
    assertEquals(quotaWindowStart(new Date(now)).toISOString(), new Date(start).toISOString(), `now=${now}`);
  }
});

Deno.test("時段起點：與 Intl 獨立算法逐小時對齊（掃兩天、每 17 分鐘一點）", () => {
  const t0 = Date.parse("2026-10-27T10:00:00Z");
  for (let i = 0; i < 2 * 24 * 60 / 17; i++) {
    const now = new Date(t0 + i * 17 * 60_000);
    assertEquals(quotaWindowStart(now).toISOString(), expectedStart(now), now.toISOString());
  }
});

Deno.test("時段終點＝起點＋4 小時；邊界上的瞬間屬於新時段", () => {
  for (const [now] of cases) {
    const d = new Date(now);
    assertEquals(quotaWindowEnd(d).getTime() - quotaWindowStart(d).getTime(), 4 * 3_600_000);
    assertEquals(quotaWindowStart(d) <= d && d < quotaWindowEnd(d), true);
  }
  const edge = new Date("2026-10-29T08:00:00+08:00");
  assertEquals(quotaWindowStart(edge).getTime(), edge.getTime());
  assertEquals(quotaWindowStart(new Date(edge.getTime() - 1)).getTime(), edge.getTime() - 4 * 3_600_000);
});

Deno.test("新時段重置：同一批用量時間戳，跨過終點後下限推進、舊用量不再被數到", () => {
  const usage = [Date.parse("2026-10-29T03:10:00+08:00"), Date.parse("2026-10-29T03:50:00+08:00")];
  const countIn = (now: string) => usage.filter((t) => t >= quotaWindowStart(new Date(now)).getTime()).length;
  assertEquals(countIn("2026-10-29T03:59:59+08:00"), 2);
  assertEquals(countIn("2026-10-29T04:00:00+08:00"), 0);
});

Deno.test("回應欄位與重置分鐘數", () => {
  const f = quotaWindowFields(new Date("2026-10-29T05:30:00+08:00"));
  assertEquals(f, { window_start: "2026-10-28T20:00:00.000Z", window_resets_at: "2026-10-29T00:00:00.000Z" });
  assertEquals(minutesUntilReset(new Date("2026-10-29T07:00:00+08:00")), 60);
  assertEquals(minutesUntilReset(new Date("2026-10-29T07:59:30+08:00")), 1);
  assertEquals(taipeiClock(new Date("2026-10-28T16:00:00Z")), "00:00");
  assertEquals(taipeiClock(new Date("2026-10-29T00:00:00Z")), "08:00");
});
