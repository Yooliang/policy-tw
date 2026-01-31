import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Rate limits
const DAILY_LIMIT_PER_IP = 50;
const DAILY_LIMIT_PER_USER = 50;

interface VerifyRequest {
  message: string;
  url?: string;
}

interface ExtractedPolicy {
  title: string;
  description: string;
  category: string;
  tags: string[];
}

interface ExtractedInfo {
  politician_name?: string;
  politician_matched_id?: number;
  election_year?: number;
  position?: string;
  policies?: ExtractedPolicy[];
}

interface VerifyResponse {
  is_election_related: boolean;
  is_policy_content: boolean;
  extracted_info?: ExtractedInfo;
  summary: string;
  confidence: number;
  can_contribute: boolean;
  usage: {
    tokens: number;
    estimated_cost: number;
  };
  rate_limit: {
    ip_remaining: number;
    user_remaining: number;
  };
  log_id?: string;
}

// Gemini API cost per token (approximate for gemini-2.0-flash)
const COST_PER_INPUT_TOKEN = 0.00000010; // $0.10 per 1M tokens
const COST_PER_OUTPUT_TOKEN = 0.00000040; // $0.40 per 1M tokens

async function fetchUrlContent(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; PolicyTracker/1.0; +https://zhengjian.tw)",
      },
    });
    if (!response.ok) {
      return `[Unable to fetch URL: ${response.status}]`;
    }
    const html = await response.text();
    // Simple HTML to text conversion
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 10000); // Limit to 10k chars
    return text;
  } catch (error) {
    return `[Error fetching URL: ${error}]`;
  }
}

async function callGeminiAPI(
  message: string,
  urlContent?: string
): Promise<{
  result: any;
  promptTokens: number;
  completionTokens: number;
}> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const prompt = `你是台灣政治政見分析專家。請分析以下內容，判斷是否與台灣選舉相關，是否包含具體政見。

用戶提交的訊息：
${message}

${urlContent ? `相關網址內容：\n${urlContent}` : ""}

請以 JSON 格式回答（只回傳 JSON，不要其他文字）：
{
  "is_election_related": boolean,  // 是否與台灣選舉相關
  "is_policy_content": boolean,    // 是否包含具體政見內容
  "politician_name": string | null, // 政治人物姓名（如有提及）
  "election_year": number | null,  // 選舉年份（如有提及）
  "position": string | null,       // 參選職位（如：縣市長、立委、市議員等）
  "policies": [                    // 提取的政見列表
    {
      "title": string,             // 政見標題（簡短）
      "description": string,       // 政見詳細內容
      "category": string,          // 分類：交通建設/社會福利/經濟發展/環境保護/教育文化/居住正義/其他
      "tags": string[]             // 相關標籤
    }
  ],
  "summary": string,               // 分析摘要說明（中文）
  "confidence": number             // 信心度 0-1
}`;

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
          temperature: 0.3,
          maxOutputTokens: 2048,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  // Extract token usage from response
  const usageMetadata = data.usageMetadata || {};
  const promptTokens = usageMetadata.promptTokenCount || 0;
  const completionTokens = usageMetadata.candidatesTokenCount || 0;

  // Extract the generated text
  const generatedText =
    data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  // Parse JSON from response (handle markdown code blocks)
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
        is_election_related: false,
        is_policy_content: false,
        summary: "無法解析 AI 回應",
        confidence: 0,
      },
      promptTokens,
      completionTokens,
    };
  }
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

    // Create service role client for logging
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

    // Get client IP
    const clientIp =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";

    // Get today's start (UTC)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    // Check IP rate limit
    const { count: ipCount } = await supabaseService
      .from("ai_usage_logs")
      .select("id", { count: "exact", head: true })
      .eq("ip_address", clientIp)
      .eq("function_type", "verify")
      .gte("created_at", todayStart.toISOString());

    const ipUsed = ipCount || 0;
    if (ipUsed >= DAILY_LIMIT_PER_IP) {
      return new Response(
        JSON.stringify({
          error: "IP daily limit exceeded",
          message: `此 IP 今日已達查詢上限 (${DAILY_LIMIT_PER_IP} 次)`,
          rate_limit: {
            ip_remaining: 0,
            user_remaining: DAILY_LIMIT_PER_USER,
          },
        }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Check user rate limit
    const { count: userCount } = await supabaseService
      .from("ai_usage_logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("function_type", "verify")
      .gte("created_at", todayStart.toISOString());

    const userUsed = userCount || 0;
    if (userUsed >= DAILY_LIMIT_PER_USER) {
      return new Response(
        JSON.stringify({
          error: "User daily limit exceeded",
          message: `您今日已達查詢上限 (${DAILY_LIMIT_PER_USER} 次)`,
          rate_limit: {
            ip_remaining: DAILY_LIMIT_PER_IP - ipUsed,
            user_remaining: 0,
          },
        }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parse request body
    const body: VerifyRequest = await req.json();

    if (!body.message || body.message.trim().length === 0) {
      return new Response(
        JSON.stringify({
          error: "Message required",
          message: "請輸入要查核的內容",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Fetch URL content if provided
    let urlContent: string | undefined;
    if (body.url) {
      urlContent = await fetchUrlContent(body.url);
    }

    // Call Gemini API
    const { result, promptTokens, completionTokens } = await callGeminiAPI(
      body.message,
      urlContent
    );

    const totalTokens = promptTokens + completionTokens;
    const estimatedCost =
      promptTokens * COST_PER_INPUT_TOKEN +
      completionTokens * COST_PER_OUTPUT_TOKEN;

    // Try to match politician in database
    let matchedPoliticianId: number | undefined;
    if (result.politician_name) {
      const { data: politician } = await supabaseService
        .from("politicians")
        .select("id")
        .eq("name", result.politician_name)
        .single();

      if (politician) {
        matchedPoliticianId = politician.id;
      }
    }

    // Log usage
    const { data: logData } = await supabaseService
      .from("ai_usage_logs")
      .insert({
        function_type: "verify",
        input_url: body.url,
        input_message: body.message.slice(0, 1000), // Truncate for storage
        model_used: "gemini-2.0-flash",
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        estimated_cost: estimatedCost,
        success: true,
        confidence: result.confidence || 0,
        user_id: user.id,
        ip_address: clientIp,
      })
      .select("id")
      .single();

    // Build response
    const confidence = result.confidence || 0;
    const canContribute =
      confidence >= 0.9 &&
      result.is_policy_content === true &&
      result.policies?.length > 0;

    const response: VerifyResponse = {
      is_election_related: result.is_election_related || false,
      is_policy_content: result.is_policy_content || false,
      extracted_info:
        result.politician_name || result.policies?.length
          ? {
              politician_name: result.politician_name,
              politician_matched_id: matchedPoliticianId,
              election_year: result.election_year,
              position: result.position,
              policies: result.policies,
            }
          : undefined,
      summary: result.summary || "分析完成",
      confidence,
      can_contribute: canContribute,
      usage: {
        tokens: totalTokens,
        estimated_cost: estimatedCost,
      },
      rate_limit: {
        ip_remaining: DAILY_LIMIT_PER_IP - ipUsed - 1,
        user_remaining: DAILY_LIMIT_PER_USER - userUsed - 1,
      },
      log_id: logData?.id,
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("ai-verify error:", error);

    // Try to log the error
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

      await supabaseService.from("ai_usage_logs").insert({
        function_type: "verify",
        model_used: "gemini-2.0-flash",
        success: false,
        error_message: error.message,
      });
    } catch {
      // Ignore logging errors
    }

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

curl -X POST 'https://<project-ref>.supabase.co/functions/v1/ai-verify' \
  -H 'Authorization: Bearer <user-jwt-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "蘇巧慧宣布將在新北市興建2萬戶社會住宅",
    "url": "https://news.example.com/article/123"
  }'

Response:
{
  "is_election_related": true,
  "is_policy_content": true,
  "extracted_info": {
    "politician_name": "蘇巧慧",
    "politician_matched_id": 123,
    "election_year": 2026,
    "position": "縣市長",
    "policies": [{
      "title": "社會住宅政策",
      "description": "在新北市興建2萬戶社會住宅",
      "category": "居住正義",
      "tags": ["社會住宅", "居住正義", "新北市"]
    }]
  },
  "summary": "此內容為蘇巧慧參選新北市長的政見，涉及社會住宅興建計畫。",
  "confidence": 0.95,
  "can_contribute": true,
  "usage": {
    "tokens": 1234,
    "estimated_cost": 0.000123
  },
  "rate_limit": {
    "ip_remaining": 49,
    "user_remaining": 49
  },
  "log_id": "uuid-here"
}

*/
