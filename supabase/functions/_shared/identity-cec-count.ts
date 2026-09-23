/**
 * 同名指認要附中選會筆數（協議 1.29.0，2026-09-23 小良哥裁示）。
 *
 * 指認（resolved_politician_id）一票就採用，而金門重複建檔的教訓是：兩票都讀同一份錯的資料庫縣市，
 * 兩票等於一票。出生年在 identity_candidates 裡抄得到，證明不了代理查過；「中選會查這個姓名回幾筆」
 * 抄不到，只有真的去查才知道。所以指認票要寫 N（筆數）與 M（依出生年收斂成幾人），伺服器當場自己查一次核 N。
 *
 * 中選會的姓名查詢是**子字串比對**（查「林素貞」只回「徐林素貞」），所以 N 認兩種數法：
 * 回傳的全部筆數，或姓名完全相同的筆數——兩個都只有查過才拿得到。
 */
import { CEC_QUERY_URL } from "./cec-candidate.ts";

const UA = "Mozilla/5.0 (compatible; policy-tw-verify/1.0)";
const IDENTITY_TYPES = new Set(["politician", "candidacy"]);

export interface CecNameHits {
  /** API 回傳的全部筆數（含子字串命中） */
  all: number;
  /** 姓名完全相同的筆數 */
  exact: number;
  /** 完全同名者裡有幾個不同的出生年（沒有出生年的不算） */
  birthYears: number;
}

const norm = (s: string) => s.replace(/臺/g, "台").replace(/\s/g, "");

/**
 * 這張票要不要附中選會筆數：politician／candidacy 的 agree 票帶了指認，而且 payload 有姓名。
 * 回要查的姓名；不需要就回 null。只帶 politician_id、沒有姓名的提交不會有同名問題。
 */
export function cecCountName(contributionType: string, verdict: string, resolvedPoliticianId: string | null | undefined, payload: unknown): string | null {
  if (!IDENTITY_TYPES.has(contributionType) || verdict !== "agree" || !resolvedPoliticianId) return null;
  const name = payload && typeof payload === "object" ? (payload as Record<string, unknown>).name : null;
  return typeof name === "string" && norm(name).length >= 2 ? name.trim() : null;
}

/** 純函式：把中選會回的清單數成 N 的兩種數法與出生年數 */
export function countHits(name: string, list: readonly unknown[]): CecNameHits {
  const target = norm(name);
  const exact = list.filter((r) => r && typeof r === "object" && typeof (r as Record<string, unknown>).cand_name === "string" && norm((r as Record<string, string>).cand_name) === target);
  const years = new Set(exact.map((r) => String((r as Record<string, unknown>).cand_birthyear ?? "")).filter((y) => /^\d{4}$/.test(y)));
  return { all: list.length, exact: exact.length, birthYears: years.size };
}

/** 查中選會；API 掛了、逾時、格式不對都回 null（呼叫端照收這票，只註記沒核到） */
export async function fetchCecNameHits(name: string, fetchImpl: typeof fetch = fetch): Promise<CecNameHits | null> {
  try {
    const res = await fetchImpl(`${CEC_QUERY_URL}?${new URLSearchParams({ cand_name: name })}`, {
      headers: { "User-Agent": UA, Referer: "https://db.cec.gov.tw/" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const raw = await res.json();
    const list = raw?.cand_data_list;
    return Array.isArray(list) ? countHits(name, list) : null;
  } catch {
    return null;
  }
}

export type CecCountCheck =
  | { ok: true; noteSuffix: string }
  | { ok: false; error: "cec_count_required" | "cec_count_mismatch"; message: string };

/**
 * 純函式：核對代理寫的 N 與伺服器查到的。
 * hits 為 null（查詢失敗）時不擋——系統自己的問題不該讓代理白做工，只在備註留下「未核」。
 */
export function checkCecCount(name: string, claimed: { hits?: number; people?: number }, hits: CecNameHits | null): CecCountCheck {
  if (claimed.hits === undefined || claimed.people === undefined) {
    return {
      ok: false,
      error: "cec_count_required",
      message: `帶了 resolved_politician_id 的同意票，要一併寫 cec_hits（中選會候選人查詢 API 查「${name}」回幾筆）與 cec_people（依出生年收斂成幾個人）。` +
        "理由：出生年在 identity_candidates 裡抄得到，這兩個數字只有真的查過才知道；指認一票就採用，錯了會生出重複的人物。" +
        "查法見協議 §2 第 11 條。補上再送一次，這次不算你被拒。",
    };
  }
  if (!hits) return { ok: true, noteSuffix: `〔中選會同名核對：代理報 ${claimed.hits} 筆→${claimed.people} 人；系統查詢失敗，未核〕` };
  if (claimed.hits !== hits.all && claimed.hits !== hits.exact) {
    return {
      ok: false,
      error: "cec_count_mismatch",
      message: `你寫中選會查「${name}」有 ${claimed.hits} 筆，系統剛查到 ${hits.all} 筆（其中姓名完全相同的 ${hits.exact} 筆），對不上。` +
        `請實際打一次 ${CEC_QUERY_URL}?cand_name=${name}，依回來的紀錄重新判斷指認，再送一次。這次不算你被拒。`,
    };
  }
  return { ok: true, noteSuffix: `〔中選會同名核對：代理報 ${claimed.hits} 筆→${claimed.people} 人；系統核 ${hits.all} 筆（完全同名 ${hits.exact} 筆、${hits.birthYears} 個出生年），相符〕` };
}
