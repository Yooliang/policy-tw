/**
 * `.in()` 一次最多帶幾個值（2026-10-08，#455 審查）。
 *
 * 名冊逐位吻合的 candidacy 一批可到 150 筆（MAX_BATCH_ROSTER），150 個 uuid（36 字元）放進一條 PostgREST 網址約 5.5 KB、
 * 150 個雜湊（64 字元）約 10 KB，超過 Kong／PostgREST 的網址長度上限就回 414，沒接住的例外變成 500。
 * 所以交件這一路所有 `.in()` 都改成每 IN_CHUNK 個一查、結果合併。
 */
export const IN_CHUNK = 40;

/** 切成每 size 個一段（空陣列回空陣列） */
export function chunksOf<T>(xs: readonly T[], size: number = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
