/**
 * PostgREST 一次最多回 1000 列（伺服器端的 max-rows），程式裡寫 `.limit(20000)` 沒有用。
 *
 * 2026-09-17 小良哥看貢獻榜：「臨門投了 36 票，榜上只給 3 票」。追下去發現
 * 貢獻榜的驗證票合計剛好是 1000——我們今天跨過那條線，之後投的每一票都不被計分，
 * 「驗證票累計」那條線也會在 1000 卡死，而我們正拿它判斷代理跑得夠不夠快。
 *
 * 這支用 range 翻頁把整份撈回來。撈到上限會在 console 講一聲：
 * 數字悄悄變假比慢一點糟得多，寧可看得到警告。
 */

const PAGE = 1000;
/** 安全閥：超過這個量就該改成資料庫端聚合，不要再一頁頁撈 */
export const FETCH_ALL_HARD_CAP = 50_000;

// deno-lint-ignore no-explicit-any
type Query = any;

/**
 * @param label 出問題時印在 console 的名字
 * @param build 給一個起訖列號、回一個查詢（呼叫端自己決定 select 與條件）
 */
export async function fetchAllRows<T>(
  label: string,
  build: (from: number, to: number) => Query,
  cap: number = FETCH_ALL_HARD_CAP,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
  console.warn(`[fetch-all] ${label} 撈到上限 ${cap} 列就停了，統計可能不完整——該改成資料庫端聚合了`);
  return out;
}
