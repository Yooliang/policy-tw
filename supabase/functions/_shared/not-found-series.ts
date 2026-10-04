/**
 * 「查無」比例異常高的模型系列，查無交件的門檻提高（協議 1.44.0，2026-10-04）。
 *
 * 近 14 天 Claude Haiku 的交件有 62% 是 no_change（查無／打不開），Sonnet 只有 19%；主線抽查那些「查無」，
 * 多半其實查得到。錯的查無代價不是一筆爛資料，而是**那個缺口 14 天不再派**——沒有人會發現它其實查得到。
 *
 * ## 為什麼不綁模型名
 * 寫死 'haiku' 兩個月後就過時（新模型、新系列、別家 CLI），而且會變成「換個字串就繞過」。
 * 這裡的判準是**行為**：你自報的 agent_tool 歸到哪一列（`model_display_name`），那一列近 14 天的查無率是多少。
 * 任何系列（含「未填」「其他」）的查無率異常高都會被套上同一道較嚴的門檻，Haiku 只是現在剛好中。
 *
 * ## 為什麼是「查無比例」而不是「查無退件率」
 * 查無走 no_change，是不動正式資料的型別、目標分數只有 2，驗證者多半照著按過——退件率低不代表那些查無是對的。
 * 而派工是**單一佇列、等最久的先派、不看模型**，所以每個系列拿到的任務難度分布大致相同；
 * 同樣的任務池裡一個系列的查無率是別人的三倍，差的是「找多久才放棄」，不是運氣。
 *
 * ## 統計哪裡來
 * 直接用統計頁在用的 `model_contribution_stats(p_days)`（migration 20261003000003）的模型列
 * （`contribution_type IS NULL`）：`submitted` 與 `no_change_missing`（型別 no_change 且 outcome 是
 * not_found／unreachable）。**不新增 SQL**，也就不會有第三份要同步的規則。
 *
 * ## 門檻提高成什麼
 * 網址 5 → 7 個，而且至少 4 個**不同網域**（見 not-found-guard.ts）。數量門檻擋不住湊數（2026-10-01 裁決自己寫了這句），
 * 網域才是「有沒有去不同的地方找」。而協議本來就要求搜尋引擎＋候選人臉書＋READr＋地方新聞／政黨頁——
 * 照協議做的代理本來就有 4 個以上網域，這道門檻只擋「只翻了同一個站」。
 */

import { modelDisplayName } from "./model-name.ts";

/** 統計視窗：跟統計頁「各模型表現」的預設一致，代理看到的數字跟維護者看到的是同一份 */
export const NOT_FOUND_RATE_WINDOW_DAYS = 14;
/** 樣本太小不判：14 天交不到這個數就不夠談比例（兩三筆查無就會算出 100%） */
export const NOT_FOUND_RATE_MIN_SAMPLE = 20;
/** 相對判準：查無率要達到全站的幾倍 */
export const NOT_FOUND_RATE_MULTIPLE = 1.5;
/** 絕對下限：全站查無率本來就低的時候，1.5 倍會把正常的系列也掃進來 */
export const NOT_FOUND_RATE_FLOOR = 0.40;
/** 統計快取多久（每筆交件都重算一次 14 天彙總太貴） */
export const NOT_FOUND_RATE_CACHE_MS = 5 * 60 * 1000;

/** model_contribution_stats 回傳列裡我們用到的欄位 */
export interface ModelStatRow {
  model: string | null;
  contribution_type: string | null;
  submitted: number | string | null;
  no_change_missing: number | string | null;
}

export interface SeriesRate {
  model: string;
  submitted: number;
  not_found: number;
  rate: number;
}

export interface NotFoundRates {
  /** 全站（所有系列加總） */
  overall: SeriesRate;
  series: readonly SeriesRate[];
}

export interface SeriesVerdict extends SeriesRate {
  elevated: boolean;
  overall_rate: number;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

const rate = (notFound: number, submitted: number) => (submitted > 0 ? notFound / submitted : 0);

/**
 * 純函式：把 model_contribution_stats 的列整理成各系列與全站的查無率。
 * 只取模型列（`contribution_type IS NULL`），型別明細列會重複計算同一批交件。
 */
export function notFoundRates(rows: readonly ModelStatRow[]): NotFoundRates {
  const series = rows
    .filter((r) => r.contribution_type === null && typeof r.model === "string" && r.model.length > 0)
    .map((r) => {
      const submitted = num(r.submitted);
      const notFound = Math.min(num(r.no_change_missing), submitted);
      return { model: r.model as string, submitted, not_found: notFound, rate: rate(notFound, submitted) };
    })
    .filter((s) => s.submitted > 0);
  const submitted = series.reduce((a, s) => a + s.submitted, 0);
  const notFound = series.reduce((a, s) => a + s.not_found, 0);
  return {
    overall: { model: "全站", submitted, not_found: notFound, rate: rate(notFound, submitted) },
    series,
  };
}

/**
 * 這個系列要不要套較嚴的門檻。三個條件都成立才算：樣本夠、絕對比例夠高、而且相對全站也夠高。
 * 找不到這個系列（第一次出現、或樣本不足）一律回 elevated=false——沒有證據就用一般門檻。
 */
export function seriesVerdict(rates: NotFoundRates, model: string): SeriesVerdict {
  const found = rates.series.find((s) => s.model === model);
  const row: SeriesRate = found ?? { model, submitted: 0, not_found: 0, rate: 0 };
  const elevated = row.submitted >= NOT_FOUND_RATE_MIN_SAMPLE &&
    row.rate >= NOT_FOUND_RATE_FLOOR &&
    row.rate >= NOT_FOUND_RATE_MULTIPLE * rates.overall.rate;
  return { ...row, elevated, overall_rate: rates.overall.rate };
}

/** 從 agent_tool 直接判；模型顯示名稱的規則表就是統計分列用的那一份 */
export function agentToolVerdict(rates: NotFoundRates, agentTool: string | null | undefined): SeriesVerdict {
  return seriesVerdict(rates, modelDisplayName(agentTool));
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** 寫進 400 訊息的那一句：講清楚是哪一列、憑什麼、提高到多少 */
export function seriesVerdictMessage(v: SeriesVerdict, requiredUrls: number, requiredDomains: number): string {
  return `你自報的 agent_tool 歸到統計的「${v.model}」一列：近 ${NOT_FOUND_RATE_WINDOW_DAYS} 天這一列 ${v.submitted} 筆交件有 ${pct(v.rate)} 是查無／打不開（全站 ${pct(v.overall_rate)}），` +
    `抽查多半其實查得到。所以這一列的「查無」要 ${requiredUrls} 個網址、且至少 ${requiredDomains} 個不同網域——` +
    `照協議做（搜尋引擎、候選人臉書、READr、地方新聞或政黨頁）本來就有這麼多個不同網域。比例降回全站水準就自動恢復一般門檻。`;
}

// ---- 統計取得（帶快取；查不到就回 null，由呼叫端退回一般門檻）----

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

let cache: { at: number; rates: NotFoundRates | null } | null = null;

/** 測試用：清掉快取 */
export function resetNotFoundRatesCache(): void {
  cache = null;
}

/**
 * 取各系列查無率。RPC 失敗、沒資料、或這個部署沒有那支函式 → 回 null（**失敗就放行**：
 * 統計拿不到時不該把誠實的代理擋在門外，一般門檻 5 個網址仍然在）。
 * 失敗也會進快取，避免每一筆交件都去撞同一個壞掉的查詢。
 */
export async function fetchNotFoundRates(supabase: SupabaseLike, now: number = Date.now()): Promise<NotFoundRates | null> {
  if (cache && now - cache.at < NOT_FOUND_RATE_CACHE_MS) return cache.rates;
  let rates: NotFoundRates | null = null;
  try {
    const { data, error } = await supabase.rpc("model_contribution_stats", { p_days: NOT_FOUND_RATE_WINDOW_DAYS });
    if (!error && Array.isArray(data) && data.length > 0) {
      const parsed = notFoundRates(data as ModelStatRow[]);
      rates = parsed.overall.submitted > 0 ? parsed : null;
    }
  } catch (e) {
    console.error("model_contribution_stats:", e instanceof Error ? e.message : String(e));
  }
  cache = { at: now, rates };
  return rates;
}
