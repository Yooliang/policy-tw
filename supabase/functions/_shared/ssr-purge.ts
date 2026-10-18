/**
 * 落庫後通知正見.tw 的 Worker 清掉受影響頁面的邊緣快取（policy-ops#135，2026-10-19）。
 *
 * 為什麼：人物頁、政見頁與它們的 .md 在 Worker 的快取新鮮期拉到 1 小時，資料剛上線就要看得到，
 * 所以落庫成功後打 Worker 既有的 `POST /__purge`（帶 `X-Purge-Secret`，Worker 端會連 .md 一起清）。
 *
 * 鑰匙：環境變數 `PURGE_SECRET`（Supabase secrets，值要與 Worker 的 `PURGE_SECRET` 相同；兩邊都沒設或不一致只是不清快取，
 * 頁面最多舊 1 小時）。網址：`SITE_URL`（_shared/site.ts）。**不丟錯、不等結果**：清不掉只記 log，絕不影響落庫。
 */
import { siteUrl } from "./site.ts";

/** 落庫結果 → 要清的頁面路徑（人物頁、政見頁；.md 由 Worker 一併清）。沒有 id 就是空陣列 */
export function purgePathsFor(outcome: { politician_id?: string | null; policy_id?: string | null }): string[] {
  const out: string[] = [];
  if (outcome.politician_id) out.push(`/politician/${outcome.politician_id}`);
  if (outcome.policy_id) out.push(`/policy/${outcome.policy_id}`);
  return out;
}

function envGet(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined; // 沒有 env 權限（測試）就當沒設
  }
}

export interface PurgeDeps {
  fetchFn?: typeof fetch;
  getEnv?: (name: string) => string | undefined;
  /** 送出的請求交給這個接住（Edge Runtime 的 waitUntil）；沒有就讓它自己跑 */
  keepAlive?: (p: Promise<unknown>) => void;
}

/** 觸發清除；沒有路徑、沒設鑰匙就什麼都不做。回傳送出的 promise 只給測試等，呼叫端不必 await */
export function purgeSsrPages(paths: string[], deps: PurgeDeps = {}): Promise<void> {
  const getEnv = deps.getEnv ?? envGet;
  const secret = getEnv("PURGE_SECRET");
  if (paths.length === 0 || !secret) return Promise.resolve();
  const fetchFn = deps.fetchFn ?? fetch;
  let p: Promise<void>;
  try {
    p = Promise.resolve(fetchFn(`${siteUrl(getEnv)}/__purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Purge-Secret": secret },
      body: JSON.stringify({ paths }),
      signal: AbortSignal.timeout(5000),
    })).then((r) => {
      if (!r.ok) console.error(`ssr purge ${r.status}`);
    }).catch((e) => console.error("ssr purge:", e instanceof Error ? e.message : String(e)));
  } catch (e) {
    console.error("ssr purge:", e instanceof Error ? e.message : String(e));
    return Promise.resolve();
  }
  try {
    deps.keepAlive?.(p);
  } catch { /* 不影響 */ }
  return p;
}
