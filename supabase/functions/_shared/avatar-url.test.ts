import { assertEquals } from "jsr:@std/assert@1";
import { normalizeAvatarUrl } from "./avatar-url.ts";

// 2026-09-22：Wikimedia 只供 250／330／500px 縮圖，220px（維基資訊框預設）整批回 400，頭像空白。
Deno.test("220px → 250px（≥ 原寬度的最小允許值）", () => {
  assertEquals(
    normalizeAvatarUrl("https://upload.wikimedia.org/wikipedia/commons/thumb/9/94/Lee_Shu-chuan_2023.jpg/220px-Lee_Shu-chuan_2023.jpg"),
    "https://upload.wikimedia.org/wikipedia/commons/thumb/9/94/Lee_Shu-chuan_2023.jpg/250px-Lee_Shu-chuan_2023.jpg",
  );
});
Deno.test("440px → 500px；800px 封頂 500px；thumb.wikimedia.org 也算", () => {
  assertEquals(normalizeAvatarUrl("https://upload.wikimedia.org/wikipedia/commons/thumb/2/2b/A.jpg/440px-A.jpg"), "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2b/A.jpg/500px-A.jpg");
  assertEquals(normalizeAvatarUrl("https://upload.wikimedia.org/wikipedia/commons/thumb/2/2b/A.jpg/800px-A.jpg"), "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2b/A.jpg/500px-A.jpg");
  assertEquals(normalizeAvatarUrl("https://thumb.wikimedia.org/wikipedia/commons/thumb/3/36/P.jpg/220px-P.jpg"), "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/36/P.jpg/250px-P.jpg");
});
Deno.test("已是允許寬度、原檔網址、其他網域：原樣", () => {
  const ok = "https://upload.wikimedia.org/wikipedia/commons/thumb/b/ba/Z.jpg/500px-Z.jpg";
  assertEquals(normalizeAvatarUrl(ok), ok);
  const orig = "https://upload.wikimedia.org/wikipedia/commons/9/94/Lee_Shu-chuan_2023.jpg";
  assertEquals(normalizeAvatarUrl(orig), orig);
  assertEquals(normalizeAvatarUrl("https://www.ly.gov.tw/Images/Legislators/110093.jpg "), "https://www.ly.gov.tw/Images/Legislators/110093.jpg");
});
Deno.test("百分比編碼的中文檔名照樣換", () => {
  const u = "https://upload.wikimedia.org/wikipedia/commons/thumb/9/96/%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1.jpg/220px-%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1.jpg";
  assertEquals(normalizeAvatarUrl(u), u.replace("/220px-", "/250px-"));
});
