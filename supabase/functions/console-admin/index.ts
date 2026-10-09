import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleConsoleAdmin } from "../_shared/console-admin-handler.ts";
import { jpClient } from "../_shared/jp/client.ts";

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
 * 2026-10-09 起業務邏輯（token 驗證、body 檢查、RPC 呼叫、錯誤訊息處理）搬到 _shared/console-admin-handler.ts，
 * 這支只負責接 Deno.serve、組出會打 Supabase 的 RpcClient；單元測試見 console-admin-handler.test.ts（agy 審查第 8 點）。
 *
 * ⚠️ config.toml 要有 [functions.console-admin]、verify_jwt = false：閘道預設驗 Supabase 自己的 JWT，Firebase ID Token
 * 簽發者不同，閘道那層就會先擋下、函式本體跑不到（2026-10-09 agy 審查第一點，退回修正）。守門見 console-admin-wiring.test.ts。
 *
 * POST body（共通選填 site："tw"（預設）或 "jp"，只收這兩個字面值，其他一律 400；jp 走 policy_jp 的同名 RPC，election_id 為字串）：
 *   { action: "override_create", activity, election_id?, election_type?, force, open_from?, open_until?, reason, expires_at? }
 *   { action: "override_revoke", id, reason }
 *   { action: "milestone_set", election_id, kind, election_type?, on_date, status, reason }
 *
 * 回應：{ success: true, row } 或 { success: false, error }。
 */

/** 跟 policy-console 的 src/firebase.ts OWNER_EMAIL 同一個值；可用 Supabase secret CONSOLE_OWNER_EMAIL 覆寫，不要散寫多處 */
const DEFAULT_OWNER_EMAIL = "cwen0708@gmail.com";
const DEFAULT_FIREBASE_PROJECT_ID = "policy-tw";

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  // 日本站：schema 固定 policy_jp（client 內寫死），schema 名稱不從請求來
  const supabaseJp = jpClient(supabaseUrl, serviceRoleKey);

  return handleConsoleAdmin(req, {
    projectId: Deno.env.get("CONSOLE_FIREBASE_PROJECT_ID") || DEFAULT_FIREBASE_PROJECT_ID,
    ownerEmail: Deno.env.get("CONSOLE_OWNER_EMAIL") || DEFAULT_OWNER_EMAIL,
    rpc: async (fn, args) => {
      const { data, error } = await supabase.rpc(fn, args).single();
      return { data, error };
    },
    rpcJp: async (fn, args) => {
      const { data, error } = await supabaseJp.rpc(fn, args).single();
      return { data, error };
    },
  });
});
