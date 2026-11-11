import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleStrongAdjudicate } from "../_shared/strong-adjudicate.ts";
import { supabaseRepo } from "../_shared/strong-adjudicate-repo.ts";

/**
 * strong-adjudicate — 主控台「強模型裁決」頁的端點（2026-11-11）。薄包裝，邏輯與規格在 _shared/strong-adjudicate.ts、
 * 端點規格與執行者 claim／complete 做法在 docs/CONTRIBUTIONS-ADMIN.md。
 * 維護者動作驗 Firebase ID Token（同 console-admin）；執行者動作驗標頭 x-strong-lane-key ＝ STRONG_LANE_KEY。本端點不呼叫任何模型。
 * config.toml：verify_jwt = false（Firebase token 與執行者鑰匙都不是 Supabase JWT，函式自己驗）。
 */
const DEFAULT_OWNER_EMAIL = "cwen0708@gmail.com";
const DEFAULT_FIREBASE_PROJECT_ID = "policy-tw";

Deno.serve((req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  return handleStrongAdjudicate(req, {
    repo: supabaseRepo(supabase),
    projectId: Deno.env.get("CONSOLE_FIREBASE_PROJECT_ID") || DEFAULT_FIREBASE_PROJECT_ID,
    ownerEmail: Deno.env.get("CONSOLE_OWNER_EMAIL") || DEFAULT_OWNER_EMAIL,
    laneKey: Deno.env.get("STRONG_LANE_KEY"),
    functionsBase: `${supabaseUrl}/functions/v1`,
  });
});
