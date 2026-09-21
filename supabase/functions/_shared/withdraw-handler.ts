/**
 * withdraw — 提交者撤回自己還沒落庫的貢獻（2026-09-21 使用者裁決）。
 *
 * 背景：代理事後發現自己交的東西沒有根據（來源其實沒打開、回頭查才發現站不住），
 * 系統原本沒有任何路徑讓它認錯——貢獻的出口只有同儕共識（verified／disputed）
 * 或維護者退件（rejected／reverted）。結果是明知無據的東西留在池子裡，
 * 由別的代理花驗證票去重新發現一次，而驗證票是這個系統最稀缺的資源。
 *
 * 使用者的原則：「我們都使用修改流程的方式，來讓系統更能處理問題，
 * 而不是依賴 key 去作人工清除。」所以這不是給維護者的工具，是給提交者的路。
 *
 * 三個條件都要成立：
 *   1. 來源 IP ＝ 那筆的 contributor_ip_hash（身份是來源 IP，不是自報代號，見 2026-09-19 裁決）
 *   2. 狀態是 pending（已落庫的是另一個風險級別，走更正／還原）
 *   3. disagree_count = 0 —— 已經有人投反對票就不准撤回，否則撤回會變成逃避爭議的後門
 *
 * 撤回**不計入退件**：那是誠實回報，不是被否決。任務會自己回到池子裡
 * （派工的排除條件是「有在途貢獻 pending／verified／disputed」，withdrawn 不在其中）。
 */
import { resolveIdentity } from "./contribute-handler.ts";
import type { Actor } from "./actor.ts";

export interface HandlerResult {
  status: number;
  // deno-lint-ignore no-explicit-any
  body: Record<string, any>;
}

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/** 理由的下限：要說得出「為什麼它站不住」，不能只寫「錯了」。 */
export const WITHDRAW_REASON_MIN = 10;

export interface WithdrawInput {
  contribution_id: string;
  reason: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateWithdrawRequest(body: unknown): { ok: boolean; input?: WithdrawInput; errors: Array<{ path: string; code: string; message: string }> } {
  const errors: Array<{ path: string; code: string; message: string }> = [];
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const id = typeof b.contribution_id === "string" ? b.contribution_id.trim() : "";
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (!UUID_RE.test(id)) errors.push({ path: "contribution_id", code: "invalid", message: "contribution_id 要是 uuid" });
  if (reason.length < WITHDRAW_REASON_MIN) {
    errors.push({ path: "reason", code: "too_short", message: `reason 至少 ${WITHDRAW_REASON_MIN} 字：說明它為什麼站不住（例如「來源打開後沒有提到這筆宣稱」），不要只寫「交錯了」` });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, input: { contribution_id: id, reason }, errors: [] };
}

export async function handleWithdraw(supabase: SupabaseLike, body: unknown, ipHash: string): Promise<HandlerResult> {
  const identity = await resolveIdentity(body, ipHash);
  if (!identity.ok) return { status: identity.status, body: { success: false, error: "identity_invalid", message: identity.error } };
  body = identity.body;
  const actor: Actor = identity.actor;

  const v = validateWithdrawRequest(body);
  if (!v.ok || !v.input) return { status: 400, body: { success: false, error: "validation_failed", errors: v.errors } };
  const input = v.input;

  const { data: row, error: cError } = await supabase
    .from("contributions")
    .select("id, status, contribution_type, contributor_ip_hash, agent_name, disagree_count, task_id, review_notes")
    .eq("id", input.contribution_id)
    .maybeSingle();
  if (cError) throw new Error(`contributions lookup: ${cError.message}`);
  if (!row) return { status: 404, body: { success: false, error: "not_found", message: "沒有這筆貢獻" } };

  // 1. 只有提交者本人（同一個來源 IP）能撤回
  if (row.contributor_ip_hash !== ipHash) {
    return {
      status: 403,
      body: {
        success: false,
        error: "not_yours",
        message: "只有提交者本人能撤回自己的貢獻。身份看的是來源 IP，不是代號——換代號不會讓你變成提交者。別人交的東西有問題，請投 disagree 並附反證。",
      },
    };
  }

  // 2. 已經離開 pending 的不走這條路
  if (row.status !== "pending") {
    const hint = row.status === "applied" || row.status === "verified"
      ? "已經落庫的資料請提 correction 更正，或提 removal 移除——撤回只處理還沒上線的東西。"
      : `這筆現在是 ${row.status}，不在等票，沒有東西可以撤回。`;
    return { status: 409, body: { success: false, error: "not_pending", message: hint, status_now: row.status } };
  }

  // 3. 已經有人投反對票 → 走爭議流程，不能用撤回繞過
  if ((row.disagree_count ?? 0) > 0) {
    return {
      status: 409,
      body: {
        success: false,
        error: "already_disputed",
        message: "已經有人投了反對票，這筆要走爭議流程決定，不能撤回——否則撤回會變成逃避爭議的後門。你認為自己錯了，可以在裁決任務裡說明。",
        disagree_count: row.disagree_count,
      },
    };
  }

  const note = `[withdraw] 提交者自行撤回：${input.reason}`;
  const { error: uError } = await supabase
    .from("contributions")
    .update({
      status: "withdrawn",
      review_notes: [row.review_notes, note].filter(Boolean).join("；"),
      reviewed_by: actor.handle,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "pending"); // 競態：別人剛投票讓它變 verified 就不要覆蓋
  if (uError) throw new Error(`contributions withdraw: ${uError.message}`);

  return {
    status: 200,
    body: {
      success: true,
      contribution_id: row.id,
      status: "withdrawn",
      counts_as_rejection: false,
      message: row.task_id
        ? "已撤回。這不算你的退件——主動撤掉沒有根據的東西，跟查完回報「查不到」一樣是一種成果。那筆缺口會自己回到任務池，請重新查證後再交一次。"
        : "已撤回。這不算你的退件——主動撤掉沒有根據的東西，跟查完回報「查不到」一樣是一種成果。",
    },
  };
}
