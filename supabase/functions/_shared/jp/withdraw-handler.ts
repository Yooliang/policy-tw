/**
 * 日本站 withdraw：提交者撤回自己還沒落庫的貢獻（POST jp-report{kind:"withdraw"}）。
 *
 * 複製自 ../withdraw-handler.ts 的 validateWithdrawRequest／handleWithdraw，邏輯不變：
 * 只有提交者本人（同來源網段；帶派工憑證時比憑證裡的網段）、狀態 pending、沒有人投過反對票才能撤回，撤回不算退件。
 * 拿掉的：legacyIpHash 過渡。
 */
import { resolveIdentity, type HandlerResult } from "./contribute-handler.ts";
import type { Actor } from "../actor.ts";
import { checkDispatchToken, dispatchTokenOf, invalidTokenResult } from "../dispatch-token.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export const WITHDRAW_REASON_MIN = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WithdrawInput { contribution_id: string; reason: string }

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

export async function handleWithdraw(supabase: SupabaseLike, body: unknown, ipHashArg: string, dispatchSecret?: string): Promise<HandlerResult> {
  let ipHash = ipHashArg;
  let viaToken = false;
  const tokenField = dispatchTokenOf(body);
  const tokenCheck = tokenField.present ? await checkDispatchToken(dispatchSecret, tokenField.value, null) : null;
  if (tokenCheck) {
    if (!tokenCheck.ok) return invalidTokenResult(tokenCheck.reason);
    ipHash = tokenCheck.payload.h;
    viaToken = true;
  }
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

  if (viaToken && tokenCheck?.ok && (typeof row.task_id !== "string" || row.task_id !== tokenCheck.payload.t)) {
    return invalidTokenResult("task_mismatch");
  }
  if (row.contributor_ip_hash !== ipHash) {
    return {
      status: 403,
      body: { success: false, error: "not_yours", message: "只有提交者本人能撤回自己的貢獻。身份看的是來源網段，不是代號——換代號不會讓你變成提交者。別人交的東西有問題，請投 disagree 並附反證。" },
    };
  }
  if (row.status !== "pending") {
    const hint = row.status === "applied" || row.status === "verified"
      ? "已經通過的資料請提 correction 更正——撤回只處理還沒定案的東西。"
      : `這筆現在是 ${row.status}，不在等票，沒有東西可以撤回。`;
    return { status: 409, body: { success: false, error: "not_pending", message: hint, status_now: row.status } };
  }
  if ((row.disagree_count ?? 0) > 0) {
    return {
      status: 409,
      body: { success: false, error: "already_disputed", message: "已經有人投了反對票，這筆要走爭議流程決定，不能撤回——否則撤回會變成逃避爭議的後門。", disagree_count: row.disagree_count },
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
    .eq("status", "pending");
  if (uError) throw new Error(`contributions withdraw: ${uError.message}`);

  return {
    status: 200,
    body: {
      success: true,
      contribution_id: row.id,
      status: "withdrawn",
      counts_as_rejection: false,
      message: "已撤回。這不算你的退件——主動撤掉沒有根據的東西，跟查完回報「查不到」一樣是一種成果。" + (row.task_id ? "那筆缺口會自己回到任務池，請重新查證後再交一次。" : ""),
    },
  };
}
