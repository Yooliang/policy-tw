import { isConsoleOwner, verifyFirebaseIdToken, type FirebaseIdTokenClaims } from "./firebase-id-token.ts";

/**
 * console-admin 的業務邏輯（抽出來跟 Deno.serve 分開，才能在不打真的網路／資料庫的情況下單元測試——
 * 2026-10-09 agy 審查第 8 點：index.ts 本身完全沒有自動化測試，問題 2（錯誤訊息被轉成 "[object Object]"）、
 * 問題 3（空字串沒正規化成 null）、問題 5（簽名解碼例外沒攔）都是因此在測試階段漏掉的。
 *
 * index.ts 只負責：讀環境變數組出 RpcClient、呼叫 handleConsoleAdmin()、把 Response 原樣送出去。
 */

export interface RpcResult {
  data: unknown;
  error: unknown;
}
/** 呼叫一支 RPC（single row）；真正的實作在 index.ts 用 supabase-js 的 .rpc(fn, args).single() 包一層 */
export type RpcClient = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;

/** 站台白名單（2026-10-10 日本站）：body.site 只收這兩個字面值，永遠不接受 schema 名稱。 */
export const CONSOLE_SITES = ["tw", "jp"] as const;
export type ConsoleSite = typeof CONSOLE_SITES[number];

export interface ConsoleAdminDeps {
  /** 台灣站（public schema）的 RPC */
  rpc: RpcClient;
  /** 日本站（policy_jp schema）的 RPC；沒給就拒絕 site=jp（500） */
  rpcJp?: RpcClient;
  /** 這個 Firebase 專案的 id（aud／iss 都要對得上） */
  projectId: string;
  /** 主控台擁有者信箱 */
  ownerEmail: string;
  /** 可注入（測試用自己簽的金鑰）；不給就用真的 Google JWKS */
  verifyToken?: typeof verifyFirebaseIdToken;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
export function corsPreflight(): Response {
  return new Response("ok", { headers: corsHeaders });
}

function bearerOf(headers: Headers): string | null {
  const h = headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}
function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * 空字串正規化成 null（agy 審查第 3 點）：前端 `<input type="date">`／下拉選單留空常送出 ""，直接當參數傳給 SQL 函式會撞
 * `invalid input syntax for type date: ""` 或 CHECK 約束違反（election_type 既不是 NULL 也不是合法值）。這裡統一在送進 RPC
 * 之前把空字串（trim 後長度 0）變成 null；非字串（例如已經是 null、或打錯型別送數字）原樣放行，讓 RPC／資料庫自己的檢查處理。
 */
export function blank<T>(v: T): T | null {
  return typeof v === "string" && v.trim().length === 0 ? null : v;
}

/**
 * 從 catch 到的值安全取出錯誤訊息（agy 審查第 2 點）：supabase-js 的 RPC 錯誤是 PostgrestError
 * （`{ message, details, hint, code }`，不是 `Error` 實例），`e instanceof Error` 為 false 時原本會整個物件
 * 丟給 `String(e)` 變成 `"[object Object]"`，使用者看不到真正的失敗原因（reason 必填、CHECK 違反訊息等）。
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

export async function handleConsoleAdmin(req: Request, deps: ConsoleAdminDeps): Promise<Response> {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ success: false, error: "method not allowed" }, 405);

  const token = bearerOf(req.headers);
  if (!token) return json({ success: false, error: "缺少 Authorization: Bearer <Firebase ID token>" }, 401);

  const verify = deps.verifyToken ?? verifyFirebaseIdToken;
  const verified = await verify(token, { projectId: deps.projectId });
  if (!verified.ok) return json({ success: false, error: `驗證失敗：${verified.reason}` }, verified.reason === "jwks_unavailable" ? 503 : 401);
  const claims: FirebaseIdTokenClaims = verified.claims;
  if (!isConsoleOwner(claims, deps.ownerEmail)) return json({ success: false, error: "此帳號沒有權限" }, 403);
  const agentEmail = claims.email!;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "body 不是合法的 JSON" }, 400);
  }
  const action = body.action;

  // site 白名單：只認 "tw"／"jp"（沒給＝tw，維持舊呼叫端相容）；其他任何值（含 schema 名稱、大小寫變體、非字串）一律 400
  const site = body.site === undefined || body.site === null ? "tw" : body.site;
  if (site !== "tw" && site !== "jp") return json({ success: false, error: "site 只能是 tw 或 jp" }, 400);
  const rpc = site === "jp" ? deps.rpcJp : deps.rpc;
  if (!rpc) return json({ success: false, error: "日本站尚未設定" }, 500);
  // 選舉 id：台灣站是整數，日本站是 election_key 字串
  const electionIdOk = (v: unknown) => (site === "jp" ? nonEmpty(v) : typeof v === "number");
  const electionIdOrNull = (v: unknown) => (site === "jp" ? (nonEmpty(v) ? v.trim() : null) : typeof v === "number" ? v : null);

  if (!nonEmpty(body.reason)) return json({ success: false, error: "reason 必填" }, 400);

  try {
    if (action === "override_create") {
      if (!nonEmpty(body.activity)) return json({ success: false, error: "activity 必填" }, 400);
      if (!["open", "closed", "window"].includes(String(body.force))) return json({ success: false, error: "force 必須是 open／closed／window" }, 400);
      const { data, error } = await rpc("console_admin_override_create", {
        p_activity: body.activity,
        p_election_id: electionIdOrNull(body.election_id),
        p_election_type: blank(body.election_type ?? null),
        p_force: body.force,
        p_open_from: blank(body.open_from ?? null),
        p_open_until: blank(body.open_until ?? null),
        p_reason: body.reason,
        p_expires_at: blank(body.expires_at ?? null),
        p_created_by: agentEmail,
      });
      if (error) throw error;
      return json({ success: true, row: data });
    }

    if (action === "override_revoke") {
      if (typeof body.id !== "number") return json({ success: false, error: "id 必填（覆寫的 id）" }, 400);
      const { data, error } = await rpc("console_admin_override_revoke", {
        p_id: body.id, p_reason: body.reason, p_revoked_by: agentEmail,
      });
      if (error) throw error;
      return json({ success: true, row: data });
    }

    if (action === "milestone_set") {
      if (!electionIdOk(body.election_id)) return json({ success: false, error: "election_id 必填" }, 400);
      if (!nonEmpty(body.kind)) return json({ success: false, error: "kind 必填" }, 400);
      if (!nonEmpty(body.on_date)) return json({ success: false, error: "on_date 必填" }, 400);
      if (!nonEmpty(body.status)) return json({ success: false, error: "status 必填" }, 400);
      const { data, error } = await rpc("console_admin_milestone_set", {
        p_election_id: site === "jp" ? String(body.election_id).trim() : body.election_id,
        p_kind: body.kind,
        p_election_type: blank(body.election_type ?? null),
        p_on_date: body.on_date,
        p_status: body.status,
        p_reason: body.reason,
        p_set_by: agentEmail,
      });
      if (error) throw error;
      return json({ success: true, row: data });
    }

    return json({ success: false, error: `不認得的 action：${String(action)}（要是 override_create／override_revoke／milestone_set）` }, 400);
  } catch (e) {
    // RPC 的 RAISE EXCEPTION（reason 必填、找不到可撤銷的覆寫、kind 不合法）與 CHECK 違反都是使用者端的輸入問題，回 400；
    // 其他（連線失敗等）才是伺服器端的問題。supabase-js 把 RPC 的錯誤都包成同一種形狀，這裡沒辦法細分，一律 400
    // ——寧可讓使用者看到「反正是輸入錯了」，也不要把真的系統錯誤誤判成使用者的錯被吞掉（這裡還是會把 message 原文帶出去，使用者看得出差異）。
    return json({ success: false, error: errorMessage(e) }, 400);
  }
}
