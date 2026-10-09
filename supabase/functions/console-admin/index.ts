import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isConsoleOwner, verifyFirebaseIdToken } from "../_shared/firebase-id-token.ts";

/**
 * console-admin — 主控台（policy-console）手動調整派工開關與選舉日期（#518，2026-10-09）。
 *
 * 讀（每支派工臂今天開／關、目前有效的覆寫、各選舉里程碑日期）是公開唯讀（console_arm_status()、console_active_overrides、
 * console_election_milestones，見 migration 20261009260000），主控台用 anon key 直接查 PostgREST 就好，不用經過這支函式。
 * 這支只管「寫」：覆寫新增／撤銷、里程碑設定。三個動作都要先驗 Firebase ID Token（主控台用 Google 登入拿到的），只收主控台擁有者帳號。
 *
 * 驗證：Authorization: Bearer <Firebase ID token>。驗 RS256 簽名（Google 的 JWKS）、aud／iss 是這個 Firebase 專案、沒過期、
 * email_verified、email 等於擁有者信箱（CONSOLE_OWNER_EMAIL 環境變數，沒設才退回常數預設，跟 policy-console 的 firebase.ts OWNER_EMAIL
 * 同一個值，但只在這一處讀，不要散寫多處）。驗證通過才用 service_role 寫，寫入的三支 RPC（console_admin_override_create／
 * console_admin_override_revoke／console_admin_milestone_set）本身也只授權 service_role、reason 必填（defense in depth：這支先擋一次
 * 給使用者看得懂的 400，RPC 再擋一次防著被跳過這支直接打 RPC 的狀況，但 RPC 本來就只有 service_role 能叫，外部打不到）。
 *
 * POST body：
 *   { action: "override_create", activity, election_id?, election_type?, force, open_from?, open_until?, reason, expires_at? }
 *   { action: "override_revoke", id, reason }
 *   { action: "milestone_set", election_id, kind, election_type?, on_date, status, reason }
 *
 * 回應：{ success: true, row } 或 { success: false, error }。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** 跟 policy-console 的 src/firebase.ts OWNER_EMAIL 同一個值；可用 Supabase secret CONSOLE_OWNER_EMAIL 覆寫，不要散寫多處 */
const DEFAULT_OWNER_EMAIL = "cwen0708@gmail.com";
const DEFAULT_FIREBASE_PROJECT_ID = "policy-tw";

function bearerOf(headers: Headers): string | null {
  const h = headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "method not allowed" }, 405);

  const token = bearerOf(req.headers);
  if (!token) return json({ success: false, error: "缺少 Authorization: Bearer <Firebase ID token>" }, 401);

  const projectId = Deno.env.get("CONSOLE_FIREBASE_PROJECT_ID") || DEFAULT_FIREBASE_PROJECT_ID;
  const ownerEmail = Deno.env.get("CONSOLE_OWNER_EMAIL") || DEFAULT_OWNER_EMAIL;
  const verified = await verifyFirebaseIdToken(token, { projectId });
  if (!verified.ok) return json({ success: false, error: `驗證失敗：${verified.reason}` }, verified.reason === "jwks_unavailable" ? 503 : 401);
  if (!isConsoleOwner(verified.claims, ownerEmail)) return json({ success: false, error: "此帳號沒有權限" }, 403);
  const agentEmail = verified.claims.email!;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "body 不是合法的 JSON" }, 400);
  }
  const action = body.action;
  if (!nonEmpty(body.reason)) return json({ success: false, error: "reason 必填" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    if (action === "override_create") {
      if (!nonEmpty(body.activity)) return json({ success: false, error: "activity 必填" }, 400);
      if (!["open", "closed", "window"].includes(String(body.force))) return json({ success: false, error: "force 必須是 open／closed／window" }, 400);
      const { data, error } = await supabase.rpc("console_admin_override_create", {
        p_activity: body.activity,
        p_election_id: body.election_id ?? null,
        p_election_type: body.election_type ?? null,
        p_force: body.force,
        p_open_from: body.open_from ?? null,
        p_open_until: body.open_until ?? null,
        p_reason: body.reason,
        p_expires_at: body.expires_at ?? null,
        p_created_by: agentEmail,
      }).single();
      if (error) throw error;
      return json({ success: true, row: data });
    }

    if (action === "override_revoke") {
      if (typeof body.id !== "number") return json({ success: false, error: "id 必填（覆寫的 id）" }, 400);
      const { data, error } = await supabase.rpc("console_admin_override_revoke", {
        p_id: body.id, p_reason: body.reason, p_revoked_by: agentEmail,
      }).single();
      if (error) throw error;
      return json({ success: true, row: data });
    }

    if (action === "milestone_set") {
      if (typeof body.election_id !== "number") return json({ success: false, error: "election_id 必填" }, 400);
      if (!nonEmpty(body.kind)) return json({ success: false, error: "kind 必填" }, 400);
      if (!nonEmpty(body.on_date)) return json({ success: false, error: "on_date 必填" }, 400);
      if (!nonEmpty(body.status)) return json({ success: false, error: "status 必填" }, 400);
      const { data, error } = await supabase.rpc("console_admin_milestone_set", {
        p_election_id: body.election_id,
        p_kind: body.kind,
        p_election_type: body.election_type ?? null,
        p_on_date: body.on_date,
        p_status: body.status,
        p_reason: body.reason,
        p_set_by: agentEmail,
      }).single();
      if (error) throw error;
      return json({ success: true, row: data });
    }

    return json({ success: false, error: `不認得的 action：${String(action)}（要是 override_create／override_revoke／milestone_set）` }, 400);
  } catch (e) {
    // RPC 的 RAISE EXCEPTION（reason 必填、找不到可撤銷的覆寫、kind 不合法）與 CHECK 違反都是使用者端的輸入問題，回 400；
    // 其他（連線失敗等）才是伺服器端的問題。supabase-js 把 RPC 的錯誤都包成同一種形狀，這裡沒辦法細分，一律 400
    // ——寧可讓使用者看到「反正是輸入錯了」，也不要把真的系統錯誤誤判成使用者的錯被吞掉（這裡還是會把 message 原文帶出去，使用者看得出差異）。
    const message = e instanceof Error ? e.message : String(e);
    return json({ success: false, error: message }, 400);
  }
});
