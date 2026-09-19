import { assertEquals } from "jsr:@std/assert@1";
import { avatarShapeProblem, checkAvatarUrl, parseImageSize } from "./avatar-check.ts";

// 合成最小檔頭：只要 parseImageSize 認得的部分
function jpeg(w: number, h: number, progressive = false): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, progressive ? 0xc2 : 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0, 2]);
}
function png(w: number, h: number): Uint8Array {
  const be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be(w), ...be(h), 8, 2, 0, 0, 0]);
}
function gif(w: number, h: number): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 0xff, w >> 8, h & 0xff, h >> 8, 0, 0, 0, 0]);
}
function webpVP8X(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30); b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0]);
  const W = w - 1, H = h - 1; b[24] = W & 0xff; b[25] = (W >> 8) & 0xff; b[26] = (W >> 16) & 0xff; b[27] = H & 0xff; b[28] = (H >> 8) & 0xff; b[29] = (H >> 16) & 0xff;
  return b;
}

Deno.test("parseImageSize：JPEG（含 progressive）、PNG、GIF、WebP 都讀得到尺寸；垃圾回 null", () => {
  assertEquals(parseImageSize(jpeg(647, 304)), { type: "jpeg", width: 647, height: 304 });
  assertEquals(parseImageSize(jpeg(826, 1062, true)), { type: "jpeg", width: 826, height: 1062 });
  assertEquals(parseImageSize(png(500, 500)), { type: "png", width: 500, height: 500 });
  assertEquals(parseImageSize(gif(143, 199)), { type: "gif", width: 143, height: 199 });
  assertEquals(parseImageSize(webpVP8X(1024, 576)), { type: "webp", width: 1024, height: 576 });
  assertEquals(parseImageSize(new TextEncoder().encode("<html><body>not an image</body></html>")), null);
  assertEquals(parseImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])), null, "只有影像資料沒有 SOF");
});

// 2026-09-19：周春米 647×304 的橫幅被三個代理核過；吳品叡、吳淑瑾是中央社 1024×576 的新聞圖
Deno.test("avatarShapeProblem：橫幅、太長、太小擋掉；直式與方形放行", () => {
  assertEquals(avatarShapeProblem(647, 304)?.startsWith("是橫幅"), true);
  assertEquals(avatarShapeProblem(1024, 576)?.startsWith("是橫幅"), true);
  assertEquals(avatarShapeProblem(1024, 683), null, "1.5 剛好在邊上，新聞照放行");
  assertEquals(avatarShapeProblem(100, 400)?.startsWith("太長"), true);
  assertEquals(avatarShapeProblem(80, 100)?.startsWith("太小"), true);
  assertEquals(avatarShapeProblem(826, 1062), null);
  assertEquals(avatarShapeProblem(500, 500), null);
  assertEquals(avatarShapeProblem(143, 199), null);
});

Deno.test("checkAvatarUrl：只讀檔頭；HTTP 非 200 擋、不是圖片擋、橫幅擋、直式放行、網路錯不擋", async () => {
  const fake = (status: number, body: Uint8Array | string, ct: string) => ((_u: string | URL | Request) =>
    Promise.resolve(new Response(body as BodyInit, { status, headers: { "content-type": ct } }))) as unknown as typeof fetch;
  assertEquals(await checkAvatarUrl("https://x/a.jpg", fake(404, "", "text/html")), "抓不到圖（HTTP 404）");
  assertEquals(await checkAvatarUrl("https://x/a.jpg", fake(200, "<html>login</html>", "text/html; charset=utf-8")), "不是圖片（text/html; charset=utf-8）");
  assertEquals((await checkAvatarUrl("https://x/a.jpg", fake(200, jpeg(647, 304), "image/jpeg")))?.startsWith("是橫幅"), true);
  assertEquals(await checkAvatarUrl("https://x/a.jpg", fake(206, jpeg(826, 1062), "image/jpeg")), null, "Range 回 206 也算 ok");
  assertEquals(await checkAvatarUrl("https://x/a.jpg", fake(200, png(500, 500), "image/png")), null);
  const boom = ((_u: string | URL | Request) => Promise.reject(new TypeError("dns"))) as unknown as typeof fetch;
  assertEquals(await checkAvatarUrl("https://x/a.jpg", boom), null);
});
