import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Admin check helper function
async function isAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("user_profiles")
    .select("is_admin")
    .eq("id", userId)
    .single();
  return data?.is_admin === true;
}

interface SearchRequest {
  election_year: number;
  region?: string;
  position?: string;
  name?: string;
}

interface CreatePromptResponse {
  success: boolean;
  prompt_id: string;
  message: string;
  status: string;
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

    // Check if user is admin
    const userIsAdmin = await isAdmin(supabaseService, user.id);
    if (!userIsAdmin) {
      return new Response(
        JSON.stringify({
          error: "Forbidden",
          message: "此功能僅限管理員使用",
        }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const body: SearchRequest = await req.json();

    if (!body.election_year) {
      return new Response(
        JSON.stringify({
          error: "Missing election_year",
          message: "請指定選舉年份",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Build prompt template
    let promptTemplate = `搜尋 ${body.election_year} 年台灣`;
    if (body.region) {
      promptTemplate += body.region;
    }
    if (body.position) {
      promptTemplate += body.position;
    }
    if (body.name) {
      promptTemplate += `，特定人物：${body.name}`;
    } else {
      promptTemplate += "選舉候選人名單";
    }

    // Find election ID for the year
    const { data: electionData } = await supabaseService
      .from("elections")
      .select("id")
      .gte("election_date", `${body.election_year}-01-01`)
      .lte("election_date", `${body.election_year}-12-31`)
      .limit(1)
      .single();

    // Create ai_prompts record
    const { data: prompt, error: insertError } = await supabaseService
      .from("ai_prompts")
      .insert({
        task_type: "candidate_search",
        prompt_template: promptTemplate,
        parameters: {
          election_year: body.election_year,
          region: body.region || null,
          position: body.position || null,
          name: body.name || null,
        },
        status: "pending",
        priority: 8, // High priority for user-initiated searches
        election_id: electionData?.id || null,
        region: body.region || null,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      throw new Error(`Failed to create prompt: ${insertError.message}`);
    }

    // Log AI usage
    await supabaseService.from("ai_usage_logs").insert({
      function_type: "search",
      input_message: promptTemplate,
      model_used: "claude-cli",
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated_cost: 0,
      success: true,
      user_id: user.id,
    });

    const response: CreatePromptResponse = {
      success: true,
      prompt_id: prompt.id,
      message: "搜尋任務已建立，請等待處理",
      status: "pending",
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("ai-search error:", error);

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

/* Usage Example (Admin only):

POST /functions/v1/ai-search
Authorization: Bearer <admin-jwt-token>
Content-Type: application/json

Request:
{
  "election_year": 2026,
  "region": "台北市",
  "position": "縣市長"
}

Response:
{
  "success": true,
  "prompt_id": "uuid-here",
  "message": "搜尋任務已建立，請等待處理",
  "status": "pending"
}

Then poll /functions/v1/ai-prompt-status?prompt_id=<uuid>
to check for results.
*/
