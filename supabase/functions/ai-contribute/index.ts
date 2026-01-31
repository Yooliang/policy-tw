import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Minimum confidence required to contribute
const MIN_CONFIDENCE = 0.9;

interface PolicyInput {
  title: string;
  description: string;
  category: string;
  status?: string;
  proposed_date?: string;
  source_url?: string;
  tags?: string[];
}

interface ContributeRequest {
  original_analysis_id: string;
  politician_id: number;
  election_id?: number;
  policy: PolicyInput;
}

interface ContributeResponse {
  success: boolean;
  policy_id?: number;
  message: string;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Create service role client for database operations
    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Check authentication - extract JWT token and verify
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({
          error: "Authentication required",
          message: "請先登入才能使用此功能",
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
          message: authError?.message || "請先登入才能使用此功能",
        }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parse request body
    const body: ContributeRequest = await req.json();

    // Validate required fields
    if (!body.original_analysis_id) {
      return new Response(
        JSON.stringify({
          error: "Missing original_analysis_id",
          message: "缺少原始分析 ID",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!body.politician_id) {
      return new Response(
        JSON.stringify({
          error: "Missing politician_id",
          message: "請選擇關聯的政治人物",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (
      !body.policy?.title ||
      !body.policy?.description ||
      !body.policy?.category
    ) {
      return new Response(
        JSON.stringify({
          error: "Missing policy fields",
          message: "政見標題、描述和分類為必填欄位",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Verify original analysis exists and has sufficient confidence
    const { data: analysisLog, error: logError } = await supabaseService
      .from("ai_usage_logs")
      .select("id, confidence, contributed, user_id")
      .eq("id", body.original_analysis_id)
      .eq("function_type", "verify")
      .single();

    if (logError || !analysisLog) {
      return new Response(
        JSON.stringify({
          error: "Invalid analysis ID",
          message: "找不到對應的分析記錄",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Check confidence threshold
    if ((analysisLog.confidence || 0) < MIN_CONFIDENCE) {
      return new Response(
        JSON.stringify({
          error: "Confidence too low",
          message: `AI 信心度 (${analysisLog.confidence}) 未達貢獻門檻 (${MIN_CONFIDENCE})`,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Check if already contributed
    if (analysisLog.contributed) {
      return new Response(
        JSON.stringify({
          error: "Already contributed",
          message: "此分析結果已被貢獻過",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Verify politician exists
    const { data: politician, error: politicianError } = await supabaseService
      .from("politicians")
      .select("id, name")
      .eq("id", body.politician_id)
      .single();

    if (politicianError || !politician) {
      return new Response(
        JSON.stringify({
          error: "Invalid politician_id",
          message: "找不到對應的政治人物",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const today = new Date().toISOString().slice(0, 10);

    // Insert the policy
    const { data: policyData, error: policyError } = await supabaseService
      .from("policies")
      .insert({
        politician_id: body.politician_id,
        election_id: body.election_id || null,
        title: body.policy.title,
        description: body.policy.description,
        category: body.policy.category,
        status: body.policy.status || "Campaign Pledge",
        proposed_date: body.policy.proposed_date || today,
        last_updated: today,
        progress: 0,
        tags: body.policy.tags || [],
        source_url: body.policy.source_url,
        ai_extracted: true,
        ai_confidence: analysisLog.confidence,
      })
      .select("id")
      .single();

    if (policyError) {
      return new Response(
        JSON.stringify({
          error: "Failed to create policy",
          message: policyError.message,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Update the analysis log to mark as contributed
    await supabaseService
      .from("ai_usage_logs")
      .update({
        contributed: true,
        contributed_policy_id: policyData.id,
      })
      .eq("id", body.original_analysis_id);

    // Log the contribution action
    await supabaseService.from("ai_usage_logs").insert({
      function_type: "contribute",
      model_used: "user-contribution",
      success: true,
      contributed: true,
      contributed_policy_id: policyData.id,
      user_id: user.id,
    });

    // Add initial tracking log
    await supabaseService.from("tracking_logs").insert({
      policy_id: policyData.id,
      date: body.policy.proposed_date || today,
      event: "公民貢獻",
      description: `由公民透過 AI 輔助查核貢獻此政見資料`,
      source_url: body.policy.source_url,
      ai_extracted: true,
    });

    const response: ContributeResponse = {
      success: true,
      policy_id: policyData.id,
      message: `成功貢獻政見「${body.policy.title}」至 ${politician.name} 的政見列表`,
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("ai-contribute error:", error);

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

curl -X POST 'https://<project-ref>.supabase.co/functions/v1/ai-contribute' \
  -H 'Authorization: Bearer <user-jwt-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "original_analysis_id": "uuid-from-ai-verify",
    "politician_id": 123,
    "election_id": 1,
    "policy": {
      "title": "社會住宅政策",
      "description": "4年興建2萬戶社會住宅，優先提供青年及弱勢家庭申請",
      "category": "居住正義",
      "status": "Campaign Pledge",
      "proposed_date": "2026-01-01",
      "source_url": "https://news.example.com/article/123",
      "tags": ["社會住宅", "居住正義", "青年"]
    }
  }'

Response:
{
  "success": true,
  "policy_id": 456,
  "message": "成功貢獻政見「社會住宅政策」至 蘇巧慧 的政見列表"
}

*/
