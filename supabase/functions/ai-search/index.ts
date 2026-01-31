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
}

interface CandidateInfo {
  name: string;
  party?: string;
  position: string;
  region: string;
  status?: string; // confirmed, likely, rumored
  current_position?: string;
  note?: string;
  source_url?: string;
}

interface SearchResponse {
  success: boolean;
  candidates: CandidateInfo[];
  summary: string;
  usage: {
    tokens: number;
    estimated_cost: number;
  };
}

// Gemini API cost per token
const COST_PER_INPUT_TOKEN = 0.00000010;
const COST_PER_OUTPUT_TOKEN = 0.00000040;

async function callGeminiWithSearch(
  query: string
): Promise<{
  result: any;
  promptTokens: number;
  completionTokens: number;
  rawResponse?: string;
}> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const prompt = `你是台灣選舉資料搜尋專家。請根據你的知識，列出以下選舉可能的候選人：

${query}

請列出所有符合以下條件的人選：
1. 已正式宣布參選的候選人
2. 現任者（如縣市長、立委等，通常會尋求連任）
3. 各政黨可能提名或點名的人選
4. 新聞媒體報導有意參選的政治人物
5. 政治評論中常被提及的潛在人選

請以 JSON 格式回答：
{
  "candidates": [
    {
      "name": "候選人姓名",
      "party": "政黨（中國國民黨/民主進步黨/台灣民眾黨/時代力量/台灣基進/無黨籍/未知）",
      "position": "參選職位",
      "region": "選區",
      "status": "confirmed（已宣布）/ likely（可能參選）/ rumored（傳聞）",
      "current_position": "現任職位（如有）",
      "note": "備註說明（如：現任、尋求連任、黨內初選等）"
    }
  ],
  "summary": "搜尋結果摘要，說明目前選情概況"
}

注意：
- 盡量列出所有可能人選，我們會滾動修正資料
- 即使選舉尚未舉行，也請列出目前已知或可能的參選人
- 如果是未來選舉，可根據現任者、政黨布局、新聞報導來推測`;

  // Note: For production, you would use Google Search grounding
  // This is a simplified version using basic Gemini
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
          maxOutputTokens: 4096,
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

  // Parse JSON from response
  let jsonStr = generatedText;
  const jsonMatch = generatedText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1];
  }

  try {
    const result = JSON.parse(jsonStr.trim());
    return { result, promptTokens, completionTokens, rawResponse: generatedText };
  } catch (e) {
    console.error("JSON parse error:", e);
    console.error("Raw response:", generatedText);
    return {
      result: {
        candidates: [],
        summary: "無法解析搜尋結果",
        raw_response: generatedText, // Include raw response for debugging
      },
      promptTokens,
      completionTokens,
      rawResponse: generatedText,
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

    // Build search query
    let query = `${body.election_year}年台灣`;
    if (body.region) {
      query += body.region;
    }
    if (body.position) {
      query += body.position;
    }
    query += "選舉候選人名單";

    // Call Gemini with search
    const { result, promptTokens, completionTokens, rawResponse } =
      await callGeminiWithSearch(query);

    const totalTokens = promptTokens + completionTokens;
    const estimatedCost =
      promptTokens * COST_PER_INPUT_TOKEN +
      completionTokens * COST_PER_OUTPUT_TOKEN;

    // Log usage with raw response for debugging
    await supabaseService.from("ai_usage_logs").insert({
      function_type: "search",
      input_message: query,
      model_used: "gemini-2.0-flash",
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      estimated_cost: estimatedCost,
      success: result.candidates?.length > 0,
      raw_response: rawResponse?.slice(0, 5000), // Truncate to 5000 chars
      user_id: user.id,
    });

    const response: SearchResponse = {
      success: true,
      candidates: result.candidates || [],
      summary: result.summary || "搜尋完成",
      usage: {
        tokens: totalTokens,
        estimated_cost: estimatedCost,
      },
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

curl -X POST 'https://<project-ref>.supabase.co/functions/v1/ai-search' \
  -H 'Authorization: Bearer <admin-jwt-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "election_year": 2026,
    "region": "台北市",
    "position": "縣市長"
  }'

Response:
{
  "success": true,
  "candidates": [
    {
      "name": "蔣萬安",
      "party": "中國國民黨",
      "position": "台北市長",
      "region": "台北市"
    }
  ],
  "summary": "找到 X 位候選人資料",
  "usage": {
    "tokens": 1234,
    "estimated_cost": 0.001
  }
}

*/
