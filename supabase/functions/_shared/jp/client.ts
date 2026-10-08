/**
 * 日本站的 Supabase client：同一個專案、service_role，但所有查詢與 RPC 都只走 schema policy_jp。
 *
 * 新寫的（正見沒有對應檔案）。supabase-js 在 db.schema 指定後，GET／HEAD 帶 `Accept-Profile: policy_jp`，
 * 其餘（POST／PATCH／DELETE／RPC）帶 `Content-Profile: policy_jp`；測試（jp-entry.test.ts）逐一盯每個請求都帶。
 * 要注意 policy_jp 必須列在 PostgREST 的 exposed schemas（API settings），否則請求會 406——那是部署設定，不是這裡能處理的。
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

export const JP_SCHEMA = "policy_jp";

// deno-lint-ignore no-explicit-any
export function jpClient(url: string, serviceKey: string): any {
  return createClient<any, typeof JP_SCHEMA>(url, serviceKey, { db: { schema: JP_SCHEMA } });
}
