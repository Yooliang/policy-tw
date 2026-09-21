/**
 * 頭像網址正規化（2026-09-22）。
 * Wikimedia 對外只供應固定幾種縮圖寬度（實測 250／330／500 回 200；200／220／240／300／320／400／440／640／800 回 400），
 * 而維基百科資訊框預設給的是 220px，/find-avatar 與 update-avatar 照收 → 24 位政治人物的頭像整批空白（2026 縣市長 11 位）。
 * 這裡把 upload／thumb.wikimedia.org 的縮圖寬度換成允許的：取 ≥ 原寬度的最小允許值，超過 500 就 500。
 */
export const WIKIMEDIA_THUMB_WIDTHS = [250, 330, 500] as const;

const WIKIMEDIA_THUMB_RE = /^(https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/[^/]+\/thumb\/.+\/)(\d+)(px-[^/]+)$/;

export function normalizeAvatarUrl(url: string): string {
  const m = WIKIMEDIA_THUMB_RE.exec(url.trim());
  if (!m) return url.trim();
  const width = Number(m[2]);
  if ((WIKIMEDIA_THUMB_WIDTHS as readonly number[]).includes(width)) return url.trim();
  const picked = WIKIMEDIA_THUMB_WIDTHS.find((w) => w >= width) ?? WIKIMEDIA_THUMB_WIDTHS[WIKIMEDIA_THUMB_WIDTHS.length - 1];
  return `${m[1]}${picked}${m[3]}`;
}
