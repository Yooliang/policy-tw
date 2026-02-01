import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface PromptStatus {
  id: string;
  task_type: string;
  status: string;
  priority: number;
  started_at: string | null;
  completed_at: string | null;
  result_summary: string | null;
  result_data: any | null;
  confidence: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface StatusResponse {
  success: boolean;
  prompt: PromptStatus | null;
  message?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Check authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({
          error: "Authentication required",
          message: "請先登入",
        }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authError,
    } = await supabaseService.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({
          error: "Authentication required",
          message: authError?.message || "請先登入",
        }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Get prompt_id from query params or body
    const url = new URL(req.url);
    let promptId = url.searchParams.get("prompt_id");

    if (!promptId && req.method === "POST") {
      const body = await req.json();
      promptId = body.prompt_id;
    }

    if (!promptId) {
      return new Response(
        JSON.stringify({
          error: "Missing prompt_id",
          message: "請提供 prompt_id",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Fetch prompt status
    const { data: prompt, error: fetchError } = await supabaseService
      .from("ai_prompts")
      .select(`
        id,
        task_type,
        status,
        priority,
        started_at,
        completed_at,
        result_summary,
        result_data,
        confidence,
        error_message,
        created_at,
        updated_at
      `)
      .eq("id", promptId)
      .single();

    if (fetchError) {
      console.error("Fetch error:", fetchError);

      if (fetchError.code === "PGRST116") {
        return new Response(
          JSON.stringify({
            success: false,
            prompt: null,
            message: "找不到指定的任務",
          }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      throw new Error(`Failed to fetch prompt: ${fetchError.message}`);
    }

    // Check if user owns this prompt or is admin
    const { data: promptFull } = await supabaseService
      .from("ai_prompts")
      .select("created_by")
      .eq("id", promptId)
      .single();

    const { data: userProfile } = await supabaseService
      .from("user_profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single();

    const isOwner = promptFull?.created_by === user.id;
    const isAdmin = userProfile?.is_admin === true;

    if (!isOwner && !isAdmin) {
      return new Response(
        JSON.stringify({
          error: "Forbidden",
          message: "您沒有權限查看此任務",
        }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const response: StatusResponse = {
      success: true,
      prompt: prompt as PromptStatus,
    };

    // Add message based on status
    switch (prompt.status) {
      case "pending":
        response.message = "任務等待處理中";
        break;
      case "scheduled":
        response.message = "任務已排程";
        break;
      case "processing":
        response.message = "任務處理中";
        break;
      case "completed":
        response.message = "任務已完成";
        break;
      case "failed":
        response.message = prompt.error_message || "任務失敗";
        break;
    }

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("ai-prompt-status error:", error);

    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

/* Usage Example:

GET /functions/v1/ai-prompt-status?prompt_id=<uuid>
Authorization: Bearer <jwt-token>

Response (pending):
{
  "success": true,
  "prompt": {
    "id": "uuid",
    "task_type": "candidate_search",
    "status": "pending",
    "priority": 8,
    "started_at": null,
    "completed_at": null,
    "result_summary": null,
    "result_data": null,
    "confidence": null,
    "error_message": null,
    "created_at": "2026-02-01T12:00:00Z",
    "updated_at": "2026-02-01T12:00:00Z"
  },
  "message": "任務等待處理中"
}

Response (completed):
{
  "success": true,
  "prompt": {
    "id": "uuid",
    "task_type": "candidate_search",
    "status": "completed",
    "priority": 8,
    "started_at": "2026-02-01T12:00:05Z",
    "completed_at": "2026-02-01T12:01:30Z",
    "result_summary": "找到 5 位候選人",
    "result_data": {
      "candidates": [...],
      "summary": "...",
      "sources": [...]
    },
    "confidence": 0.85,
    "error_message": null,
    "created_at": "2026-02-01T12:00:00Z",
    "updated_at": "2026-02-01T12:01:30Z"
  },
  "message": "任務已完成"
}
*/
