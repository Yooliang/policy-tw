/**
 * 人物照的形狀守門（2026-09-19）。
 *
 * 周春米的 avatar_url 被三個代理核過（「官網的、alt 有名字」），但那張是 647×304 的橫幅：
 * 左邊大字「周春米／屏東向前 希望城市」、人只佔右邊三分之一，圓形裁切後是一團字。
 * 近 30 天代理補的 41 張量了一遍，3 張是橫幅（另兩張是中央社 1024×576 的新聞圖）。
 * Jev 只吃文字看不到圖，代理也不看圖——這裡用尺寸擋掉最明顯的：橫幅、太長、太小、不是圖片。
 * 只讀檔頭（前 128 KB），不下載整張。
 */

export interface ImageSize { type: "jpeg" | "png" | "gif" | "webp"; width: number; height: number }

/** 從檔頭讀尺寸；認不出來回 null */
export function parseImageSize(b: Uint8Array): ImageSize | null {
  if (b.length < 12) return null;
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  // PNG：\x89PNG\r\n\x1a\n + IHDR
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b.length >= 24) {
    return { type: "png", width: u32(16), height: u32(20) };
  }
  // GIF：GIF87a／GIF89a，尺寸 little-endian
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { type: "gif", width: le16(6), height: le16(8) };
  }
  // WebP：RIFF....WEBP，VP8 ／ VP8L ／ VP8X 三種
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 && b.length >= 30) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === "VP8X") return { type: "webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (tag === "VP8L") { const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
    if (tag === "VP8 ") return { type: "webp", width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    return null;
  }
  // JPEG：FFD8 開頭，走 segment 找 SOFn（C0–CF，扣掉 C4 DHT、C8 JPG、CC DAC）
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      const len = u16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "jpeg", height: u16(i + 5), width: u16(i + 7) };
      }
      if (marker === 0xda) return null; // 掃到影像資料還沒看到 SOF
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** 頭像的形狀規則：橫幅、太長、太小都不收。合格回 null，否則回給人看的理由 */
export function avatarShapeProblem(width: number, height: number): string | null {
  if (width <= 0 || height <= 0) return "讀不到尺寸";
  const ratio = width / height;
  if (ratio > 1.5) return `是橫幅（${width}×${height}），圓形裁切後只剩一團字；要正方形或直式的人像照`;
  if (ratio < 0.6) return `太長（${width}×${height}），不像人像照`;
  if (Math.min(width, height) < 120) return `太小（${width}×${height}），短邊至少 120px`;
  return null;
}

const HEAD_BYTES = 131_072;
const UA = "Mozilla/5.0 (compatible; policy-tw-avatar-check/1.0)";

/**
 * 抓檔頭看形狀。回 null＝可以用；回字串＝為什麼不能用。
 * 網路本身出錯（逾時、DNS）不擋——那是我們這邊的問題，不該記在代理頭上；HTTP 非 200 就擋，那個網址本來就拿不到圖。
 */
export async function checkAvatarUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { "User-Agent": UA, Range: `bytes=0-${HEAD_BYTES - 1}` }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  if (!res.ok) return `抓不到圖（HTTP ${res.status}）`;
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  let bytes: Uint8Array;
  try {
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = []; let got = 0;
    while (got < HEAD_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value); got += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* 已讀夠 */ }
    bytes = new Uint8Array(got); let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  } catch {
    return null;
  }
  const size = parseImageSize(bytes);
  if (!size) return ct.startsWith("image/") ? null : `不是圖片（${ct || "沒有 content-type"}）`;
  return avatarShapeProblem(size.width, size.height);
}
