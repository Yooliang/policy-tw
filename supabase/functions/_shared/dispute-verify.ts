/**
 * 爭點驗證（維護者 2026-10-18，協議 1.96.0；migration 20261017040000）。
 *
 * 驗證票的票數超過「近 30 天已結案交件平均票數 × queue_settings.overvoted_flag_multiplier」（與主控台
 * console_queue_state().overvoted 同一個定義，SQL 函式 contribution_dispute_votes／contribution_dispute_context
 * 內用 contribution_overvoted_flag_votes()，這裡不重算門檻）：
 *   - /next 派出時附前面每一票的結論與理由（item.dispute）和一段針對爭點的指示（how_to 最前面）
 *   - /report 的驗證（verify-handler）不收 unsure，回 400 dispute_no_unsure；不是罰則、改投同意或反對再送一次
 * 派出時與回報時各用資料庫現算一次：兩次之間票數剛好跨線，回報時照回報當下的結果（過線就擋、沒過線就收）。
 * 系統票（Jev 等）不經 handleVerify，不受影響。
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/** 每一票的理由送給下一位的上限（SQL 已截，這裡再保險一次） */
export const DISPUTE_NOTE_MAX = 300;
/** 送出的前票筆數上限（SQL 取最近 30 筆） */
export const DISPUTE_PRIOR_MAX = 30;

export interface DisputeVote {
  verdict: string;
  agent: string | null;
  note: string | null;
  evidence_url: string | null;
  at: string;
}
export interface DisputeContext {
  votes: number;
  baseline: number | null;
  flag: number | null;
  shown: number;
  prior: DisputeVote[];
  instruction: string;
}

/** 給代理的指示（純中文）。n＝已經驗了幾票 */
export function disputeInstruction(votes: number): string {
  return `這筆已經驗了 ${votes} 票還沒定案。下面是前面每一票的結論與理由。請針對爭點判斷誰說得對、為什麼（例如：同意的人說資料在網頁原始碼裡，你要去那裡找；或判斷多寫的一句算不算來源沒有的內容），而不是從頭重查。這一輪不收「不確定」，請選同意或反對，理由要回應前面的爭點。`;
}

/** /report 退回 unsure 的說明（純中文；強調不是罰則） */
export function disputeNoUnsureMessage(votes: number, blind = false): string {
  return `${blind ? "你投的反對只寫了打不開或確認不了、沒有反證，等同不確定。" : ""}這筆是爭點驗證（已經驗了 ${votes} 票還沒定案），不收不確定，請選同意或反對並回應前面的爭點。這不是罰則、也不算你被拒：回到 GET /next 給你的 item.dispute，看前面每一票的結論與理由，判斷誰說得對，再用同意或反對重送一次。`;
}

/**
 * 派出驗證票時呼叫：超過線回爭點資料，沒超過回 null。
 * 讀不到（舊資料庫沒有這支函式、暫時錯誤）回 null 並記 log：派工不因此失敗，回報端仍會擋 unsure。
 */
export async function fetchDisputeContext(supabase: SupabaseLike, contributionId: string): Promise<DisputeContext | null> {
  try {
    const { data, error } = await supabase.rpc("contribution_dispute_context", { p_contribution_id: contributionId });
    if (error) { console.error("dispute context:", error.message); return null; }
    return shapeDispute(data);
  } catch (e) {
    console.error("dispute context:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** 把 SQL 回的 jsonb 整理成送出的樣子（防呆：截斷理由、限筆數、補指示）；null／缺票數＝不是爭點驗證 */
export function shapeDispute(raw: unknown): DisputeContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const votes = Number(r.votes);
  if (!Number.isFinite(votes)) return null;
  const list = Array.isArray(r.prior) ? (r.prior as Array<Record<string, unknown>>) : [];
  const prior: DisputeVote[] = list.slice(-DISPUTE_PRIOR_MAX).map((p) => ({
    verdict: String(p.verdict ?? ""),
    agent: typeof p.agent === "string" ? p.agent : null,
    note: typeof p.note === "string" ? p.note.slice(0, DISPUTE_NOTE_MAX) : null,
    evidence_url: typeof p.evidence_url === "string" ? p.evidence_url : null,
    at: String(p.at ?? ""),
  }));
  return {
    votes,
    baseline: typeof r.baseline === "number" ? r.baseline : null,
    flag: typeof r.flag === "number" ? r.flag : null,
    shown: prior.length,
    prior,
    instruction: disputeInstruction(votes),
  };
}

/**
 * 回報時呼叫：這筆現在是不是爭點驗證（超過線）。回票數；不是就回 null。
 * 讀不到時回 null（不擋票）並記 log——寧可放行也不因為資料庫暫時錯誤讓代理的整輪查證白費。
 */
export async function disputeVotesNow(supabase: SupabaseLike, contributionId: string): Promise<number | null> {
  try {
    const { data, error } = await supabase.rpc("contribution_dispute_votes", { p_contribution_id: contributionId });
    if (error) { console.error("dispute votes:", error.message); return null; }
    return typeof data === "number" ? data : null;
  } catch (e) {
    console.error("dispute votes:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
