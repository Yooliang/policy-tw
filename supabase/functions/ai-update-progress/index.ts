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

interface UpdateRequest {
  policy_id?: number;
  politician_id?: number;
  election_id?: number;
}

interface ProgressUpdate {
  policy_id: number;
  policy_title: string;
  new_status?: string;
  new_progress?: number;
  event_description: string;
  source_url?: string;
  confidence: number;
}

interface UpdateResponse {
  success: boolean;
  updates: ProgressUpdate[];
  summary: string;
  usage: {
    tokens: number;
    estimated_cost: number;
  };
}

// Gemini API cost per token
const COST_PER_INPUT_TOKEN = 0.00000010;
const COST_PER_OUTPUT_TOKEN = 0.00000040;

// Policy status mapping
const STATUS_MAP: Record<string, string> = {
  "已實現": "Achieved",
  "進行中": "In Progress",
  "停滯": "Stalled",
  "失敗": "Failed",
  "提案中": "Proposed",
  "競選承諾": "Campaign Pledge",
};

async function callGeminiForProgress(
  politicianName: string,
  policyTitle: string,
  policyDescription: string
): Promise<{
  result: any;
  promptTokens: number;
  completionTokens: number;
}> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const prompt = `你是台灣政見執行進度追蹤專家。請搜尋以下政治人物的政見執行進度：

政治人物: ${politicianName}
政見標題: ${policyTitle}
政見內容: ${policyDescription}

請搜尋最新的執行進度資訊，並以 JSON 格式回答（只回傳 JSON，不要其他文字）：
{
  "has_update": boolean,        // 是否有新的進度資訊
  "new_status": string | null,  // 新狀態：已實現/進行中/停滯/失敗/提案中/競選承諾（如無變化則 null）
  "new_progress": number | null, // 新進度百分比 0-100（如無法評估則 null）
  "event_description": string,  // 進度事件描述
  "source_url": string | null,  // 資料來源網址
  "confidence": number          // 信心度 0-1
}

注意：
- 只回報有可靠來源的進度更新
- 如果找不到相關資訊，has_update 設為 false
- event_description 請用中文描述，包含時間、事件、具體進展等`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
        },
        // Note: Google Search grounding is incompatible with JSON mode
        // tools: [{ googleSearch: {} }],
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  const usageMetadata = data.usageMetadata || {};
  const promptTokens = usageMetadata.promptTokenCount || 0;
  const completionTokens = usageMetadata.candidatesTokenCount || 0;

  const generatedText =
    data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  let jsonStr = generatedText;
  const jsonMatch = generatedText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1];
  }

  try {
    const result = JSON.parse(jsonStr.trim());
    return { result, promptTokens, completionTokens };
  } catch {
    return {
      result: {
        has_update: false,
        event_description: "無法解析搜尋結果",
        confidence: 0,
      },
      promptTokens,
      completionTokens,
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Check authentication - extract JWT token and verify
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

    const body: UpdateRequest = await req.json();

    // Build query to get policies to update
    let policiesQuery = supabaseService
      .from("policies")
      .select(
        `
        id,
        title,
        description,
        status,
        progress,
        politician_id,
        politicians!inner (
          id,
          name,
          politician_elections!inner (
            election_result
          )
        )
      `
      )
      .eq("politicians.politician_elections.election_result", "elected");

    if (body.policy_id) {
      policiesQuery = policiesQuery.eq("id", body.policy_id);
    } else if (body.politician_id) {
      policiesQuery = policiesQuery.eq("politician_id", body.politician_id);
    } else if (body.election_id) {
      policiesQuery = policiesQuery.eq(
        "politicians.politician_elections.election_id",
        body.election_id
      );
    } else {
      // Limit to 10 policies if no filter specified
      policiesQuery = policiesQuery.limit(10);
    }

    const { data: policies, error: policiesError } = await policiesQuery;

    if (policiesError) {
      throw new Error(`Failed to fetch policies: ${policiesError.message}`);
    }

    if (!policies || policies.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          updates: [],
          summary: "找不到符合條件的政見（僅處理已當選者的政見）",
          usage: { tokens: 0, estimated_cost: 0 },
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const updates: ProgressUpdate[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for (const policy of policies) {
      const politician = (policy as any).politicians;
      if (!politician) continue;

      const { result, promptTokens, completionTokens } =
        await callGeminiForProgress(
          politician.name,
          policy.title,
          policy.description
        );

      totalPromptTokens += promptTokens;
      totalCompletionTokens += completionTokens;

      if (result.has_update && result.confidence >= 0.7) {
        const update: ProgressUpdate = {
          policy_id: policy.id,
          policy_title: policy.title,
          event_description: result.event_description,
          source_url: result.source_url,
          confidence: result.confidence,
        };

        // Map status if provided
        if (result.new_status && STATUS_MAP[result.new_status]) {
          update.new_status = STATUS_MAP[result.new_status];
        }

        if (
          result.new_progress !== null &&
          result.new_progress >= 0 &&
          result.new_progress <= 100
        ) {
          update.new_progress = result.new_progress;
        }

        updates.push(update);

        // Apply update to database
        const today = new Date().toISOString().slice(0, 10);

        // Update policy
        const policyUpdate: any = {
          last_updated: today,
        };
        if (update.new_status) {
          policyUpdate.status = update.new_status;
        }
        if (update.new_progress !== undefined) {
          policyUpdate.progress = update.new_progress;
        }

        await supabaseService
          .from("policies")
          .update(policyUpdate)
          .eq("id", policy.id);

        // Add tracking log
        await supabaseService.from("tracking_logs").insert({
          policy_id: policy.id,
          date: today,
          event: update.new_status
            ? `狀態更新: ${update.new_status}`
            : "進度更新",
          description: update.event_description,
          source_url: update.source_url,
          ai_extracted: true,
        });
      }
    }

    const totalTokens = totalPromptTokens + totalCompletionTokens;
    const estimatedCost =
      totalPromptTokens * COST_PER_INPUT_TOKEN +
      totalCompletionTokens * COST_PER_OUTPUT_TOKEN;

    // Log usage
    await supabaseService.from("ai_usage_logs").insert({
      function_type: "update",
      input_message: `Update progress for ${policies.length} policies`,
      model_used: "gemini-2.0-flash",
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      total_tokens: totalTokens,
      estimated_cost: estimatedCost,
      success: true,
      user_id: user.id,
    });

    const response: UpdateResponse = {
      success: true,
      updates,
      summary: `處理了 ${policies.length} 筆政見，更新了 ${updates.length} 筆進度`,
      usage: {
        tokens: totalTokens,
        estimated_cost: estimatedCost,
      },
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("ai-update-progress error:", error);

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

# Update specific policy
curl -X POST 'https://<project-ref>.supabase.co/functions/v1/ai-update-progress' \
  -H 'Authorization: Bearer <admin-jwt-token>' \
  -H 'Content-Type: application/json' \
  -d '{"policy_id": 123}'

# Update all policies for a politician
curl -X POST 'https://<project-ref>.supabase.co/functions/v1/ai-update-progress' \
  -H 'Authorization: Bearer <admin-jwt-token>' \
  -H 'Content-Type: application/json' \
  -d '{"politician_id": 456}'

# Update all policies for an election
curl -X POST 'https://<project-ref>.supabase.co/functions/v1/ai-update-progress' \
  -H 'Authorization: Bearer <admin-jwt-token>' \
  -H 'Content-Type: application/json' \
  -d '{"election_id": 1}'

Response:
{
  "success": true,
  "updates": [
    {
      "policy_id": 123,
      "policy_title": "社會住宅政策",
      "new_status": "In Progress",
      "new_progress": 30,
      "event_description": "2026年1月，市府宣布已完成5000戶社會住宅興建",
      "source_url": "https://news.example.com/...",
      "confidence": 0.85
    }
  ],
  "summary": "處理了 10 筆政見，更新了 3 筆進度",
  "usage": {
    "tokens": 12345,
    "estimated_cost": 0.012
  }
}

*/
