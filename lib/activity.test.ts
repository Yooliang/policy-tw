import { assertEquals } from "jsr:@std/assert@1";
import { activityText, relativeTime } from "./activity.ts";

Deno.test("變動文字：投票要帶分數，不然看不出離通過還有多遠", () => {
  assertEquals(activityText("agree", { score: 2, target: 3 }), "有人投了同意（分數 2／目標 3，還差 1 分）");
  assertEquals(activityText("agree", { score: 3, target: 3 }), "有人投了同意（分數 3／目標 3）");
  assertEquals(activityText("disagree", { score: -1, target: 3 }), "有人投了反對（分數 -1／目標 3，還差 4 分）");
  assertEquals(activityText("unsure"), "有人投了存疑", "沒給票數就只講事件");
});

Deno.test("變動文字：狀態改變講結果；看不懂的代碼回 null，不要編一句話", () => {
  assertEquals(activityText("status:applied"), "已上線");
  assertEquals(activityText("status:rejected"), "已退件");
  assertEquals(activityText("status:apply_failed"), "上線失敗，系統會自動重試");
  assertEquals(activityText("created"), "剛提交，等待驗證");
  assertEquals(activityText("status:天外飛來一個新狀態"), null);
  assertEquals(activityText("亂碼"), null);
  assertEquals(activityText(null), null);
});

Deno.test("相對時間：分鐘、小時、天；超過七天回日期", () => {
  const now = Date.parse("2026-09-18T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assertEquals(relativeTime(ago(30 * 1000), now), "剛剛");
  assertEquals(relativeTime(ago(5 * 60 * 1000), now), "5 分鐘前");
  assertEquals(relativeTime(ago(3 * 3600 * 1000), now), "3 小時前");
  assertEquals(relativeTime(ago(2 * 86400 * 1000), now), "2 天前");
  assertEquals(relativeTime(ago(30 * 86400 * 1000), now)?.includes("/"), true, "超過七天改回日期");
});

Deno.test("相對時間：時鐘偏差造成的未來時間當成剛剛，不要出現負數", () => {
  const now = Date.parse("2026-09-18T12:00:00Z");
  assertEquals(relativeTime(new Date(now + 60 * 1000).toISOString(), now), "剛剛");
  assertEquals(relativeTime("不是時間", now), null);
  assertEquals(relativeTime(null, now), null);
});
