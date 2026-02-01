import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Task type definitions
type TaskType =
  | "candidate_search"
  | "politician_update"  // New: Update existing politician profile
  | "policy_import"
  | "policy_verify"
  | "progress_tracking"
  | "user_contribution";

interface ClassifyRequest {
  input: string;
  url?: string;
  politician_id?: string;
  politician_name?: string;
  policy_id?: string;
}

interface ClassifyResponse {
  success: boolean;
  prompt_id: string;
  task_type: TaskType;
  confidence: number;
  requires_review: boolean;
  message: string;
}

// Keywords for classification
const SEARCH_KEYWORDS = [
  "搜尋",
  "查找",
  "找",
  "搜索",
  "列出",
  "有哪些",
  "誰",
  "候選人",
  "參選",
];
const PROFILE_UPDATE_KEYWORDS = [
  "簡介",
  "經歷",
  "學歷",
  "頭像",
  "照片",
  "背景",
  "個人資料",
  "維基",
  "wikipedia",
];
const VERIFY_KEYWORDS = [
  "驗證",
  "查核",
  "是否屬實",
  "真的嗎",
  "確認",
  "是不是真的",
  "有沒有",
];
const PROGRESS_KEYWORDS = ["進度", "執行", "實現", "完成", "落實", "兌現"];

// Region patterns
const REGION_PATTERN =
  /(台北|新北|桃園|台中|台南|高雄|基隆|新竹|嘉義|苗栗|彰化|南投|雲林|屏東|宜蘭|花蓮|台東|澎湖|金門|連江)(市|縣)?/g;
const POSITION_PATTERN =
  /(縣市長|市長|縣長|議員|立委|立法委員|總統|副總統|鄉鎮市長|鄉長|鎮長|村里長|村長|里長|代表)/g;

// News URL patterns
const NEWS_DOMAINS = [
  "udn.com",
  "ltn.com.tw",
  "chinatimes.com",
  "tvbs.com.tw",
  "ettoday.net",
  "setn.com",
  "cna.com.tw",
  "storm.mg",
  "newtalk.tw",
  "appledaily.com",
  "nownews.com",
  "yahoo.com",
  "facebook.com",
];

function isNewsUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return NEWS_DOMAINS.some((domain) => hostname.includes(domain));
  } catch {
    return false;
  }
}

function hasKeywords(input: string, keywords: string[]): boolean {
  return keywords.some((k) => input.includes(k));
}

function extractParams(input: string): {
  regions: string[];
  positions: string[];
  year: number | null;
} {
  const regions = input.match(REGION_PATTERN) || [];
  const positions = input.match(POSITION_PATTERN) || [];

  // Extract year (2024-2030)
  const yearMatch = input.match(/20(2[4-9]|30)/);
  const year = yearMatch ? parseInt(yearMatch[0]) : null;

  return {
    regions: [...new Set(regions)],
    positions: [...new Set(positions)],
    year,
  };
}

function classifyInput(
  input: string,
  url?: string,
  politicianId?: string,
  politicianName?: string
): {
  task_type: TaskType;
  confidence: number;
  requires_review: boolean;
} {
  const hasUrl = !!url;
  const isNews = hasUrl && isNewsUrl(url!);
  const params = extractParams(input);
  const hasLocation = params.regions.length > 0 || params.positions.length > 0;
  const hasProfileKeywords = hasKeywords(input, PROFILE_UPDATE_KEYWORDS);

  // 0. Politician profile update (when we have politician_id or asking for profile info)
  // Check if input contains a quoted name like「蔡易餘」
  const nameMatch = input.match(/[「『]([^」』]+)[」』]/);
  const hasSpecificName = !!nameMatch || !!politicianName;

  if ((politicianId || hasSpecificName) && hasProfileKeywords) {
    return {
      task_type: "politician_update",
      confidence: 0.9,
      requires_review: false,
    };
  }

  // 1. Search for candidates
  if (hasKeywords(input, SEARCH_KEYWORDS) && hasLocation) {
    return {
      task_type: "candidate_search",
      confidence: 0.9,
      requires_review: false,
    };
  }

  // 2. News URL with election content -> policy import
  if (isNews) {
    return {
      task_type: "policy_import",
      confidence: 0.8,
      requires_review: true, // News needs review
    };
  }

  // 3. Verify keywords
  if (hasKeywords(input, VERIFY_KEYWORDS)) {
    return {
      task_type: "policy_verify",
      confidence: 0.85,
      requires_review: false,
    };
  }

  // 4. Progress tracking keywords
  if (hasKeywords(input, PROGRESS_KEYWORDS)) {
    return {
      task_type: "progress_tracking",
      confidence: 0.75,
      requires_review: false,
    };
  }

  // 5. Default: user contribution (needs review)
  return {
    task_type: "user_contribution",
    confidence: 0.6,
    requires_review: true,
  };
}

function getStatusMessage(
  task_type: TaskType,
  requires_review: boolean
): string {
  if (requires_review) {
    return "已收到您的提交，將在審核後處理";
  }
  switch (task_type) {
    case "candidate_search":
      return "正在搜尋候選人資訊，請稍候...";
    case "politician_update":
      return "正在搜尋並更新個人資料，請稍候...";
    case "policy_verify":
      return "正在驗證政見內容...";
    case "progress_tracking":
      return "正在查詢政見進度...";
    default:
      return "任務已建立，請稍候...";
  }
}

// Check if user is admin
async function isAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("user_profiles")
    .select("is_admin")
    .eq("id", userId)
    .single();
  return data?.is_admin === true;
}

// Rate limiting: 20 tasks per user per day
const DAILY_TASK_LIMIT = 20;

async function getTodayTaskCount(
  supabase: any,
  userId: string
): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString();

  const { count, error } = await supabase
    .from("ai_prompts")
    .select("*", { count: "exact", head: true })
    .eq("created_by", userId)
    .gte("created_at", todayIso);

  if (error) {
    console.error("Error checking rate limit:", error);
    return 0;
  }

  return count || 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Create service role client for all operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Check authentication - extract JWT token and verify
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Authentication required",
          message: "請先登入後再使用 AI 助手",
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
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid token",
          message: authError?.message || "登入已過期，請重新登入",
        }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Check rate limit (admins are exempt)
    const userIsAdmin = await isAdmin(supabase, user.id);
    if (!userIsAdmin) {
      const todayCount = await getTodayTaskCount(supabase, user.id);
      if (todayCount >= DAILY_TASK_LIMIT) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Rate limit exceeded",
            message: `已達今日上限（${DAILY_TASK_LIMIT} 個任務），請明天再試`,
          }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    // Parse request
    const body: ClassifyRequest = await req.json();

    if (!body.input || body.input.trim().length < 5) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          message: "請輸入至少 5 個字元",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const input = body.input.trim();
    const url = body.url?.trim() || null;
    const politicianId = body.politician_id || null;
    const politicianName = body.politician_name || null;
    const policyId = body.policy_id || null;

    // Classify the input (pass politician info for better classification)
    const classification = classifyInput(input, url || undefined, politicianId || undefined, politicianName || undefined);
    const params = extractParams(input);

    // Extract politician name from quoted text if not provided
    const nameMatch = input.match(/[「『]([^」』]+)[」』]/);
    const extractedPoliticianName = politicianName || (nameMatch ? nameMatch[1] : null);

    // Admin submissions don't require review (userIsAdmin already checked above)
    const requires_review = userIsAdmin
      ? false
      : classification.requires_review;
    const priority = userIsAdmin ? 8 : requires_review ? 5 : 7;

    // Find election ID for current/specified year
    const electionYear = params.year || 2026;
    const { data: electionData } = await supabase
      .from("elections")
      .select("id")
      .gte("election_date", `${electionYear}-01-01`)
      .lte("election_date", `${electionYear}-12-31`)
      .limit(1)
      .single();

    // Build prompt template based on task type
    let promptTemplate = input;
    if (classification.task_type === "candidate_search") {
      promptTemplate = `搜尋 ${electionYear} 年台灣`;
      if (params.regions.length > 0) {
        promptTemplate += params.regions.join("、");
      }
      if (params.positions.length > 0) {
        promptTemplate += params.positions.join("、");
      }
      promptTemplate += "選舉候選人名單";
    }

    // Create ai_prompts record
    const { data: prompt, error: insertError } = await supabase
      .from("ai_prompts")
      .insert({
        task_type: classification.task_type,
        prompt_template: promptTemplate,
        user_input: input,
        source_url: url,
        parameters: {
          election_year: electionYear,
          regions: params.regions,
          positions: params.positions,
          url: url,
          original_input: input,
          politician_id: politicianId,
          politician_name: extractedPoliticianName,  // Use extracted name if not provided
          policy_id: policyId,
        },
        status: "pending",
        priority: priority,
        confidence: classification.confidence,
        requires_review: requires_review,
        election_id: electionData?.id || null,
        region: params.regions[0] || null,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      throw new Error(`Failed to create task: ${insertError.message}`);
    }

    // Log AI usage
    await supabase.from("ai_usage_logs").insert({
      function_type: "search",
      input_message: input.substring(0, 500),
      input_url: url,
      model_used: "ai-classify",
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated_cost: 0,
      success: true,
      confidence: classification.confidence,
      user_id: user.id,
    });

    const response: ClassifyResponse = {
      success: true,
      prompt_id: prompt.id,
      task_type: classification.task_type,
      confidence: classification.confidence,
      requires_review: requires_review,
      message: getStatusMessage(classification.task_type, requires_review),
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("ai-classify error:", error);

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

POST /functions/v1/ai-classify
Authorization: Bearer <jwt-token>
Content-Type: application/json

Request 1 - Search candidates:
{
  "input": "請幫我找 2026 年台北市長候選人"
}

Response:
{
  "success": true,
  "prompt_id": "uuid",
  "task_type": "candidate_search",
  "confidence": 0.9,
  "requires_review": false,
  "message": "正在搜尋候選人資訊，請稍候..."
}

Request 2 - News submission:
{
  "input": "這是蔣萬安的政見新聞",
  "url": "https://udn.com/news/story/..."
}

Response:
{
  "success": true,
  "prompt_id": "uuid",
  "task_type": "policy_import",
  "confidence": 0.8,
  "requires_review": true,
  "message": "已收到您的提交，將在審核後處理"
}

Then poll /functions/v1/ai-prompt-status with prompt_id
*/
