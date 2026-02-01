import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * AI Scheduler - 自動化排程 AI 任務
 *
 * 用途：
 * 1. 每日自動排程搜尋任務
 * 2. 輪換不同縣市
 * 3. 避免重複搜尋舊資料
 *
 * 觸發方式：
 * - Supabase pg_cron
 * - GCP Cloud Scheduler
 * - 手動呼叫
 */

// 台灣 22 縣市
const REGIONS = {
  六都: ["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市"],
  北部: ["基隆市", "新竹市", "新竹縣", "苗栗縣", "宜蘭縣"],
  中部: ["彰化縣", "南投縣", "雲林縣", "嘉義市", "嘉義縣"],
  南部東部: ["屏東縣", "花蓮縣", "台東縣", "澎湖縣"],
  離島: ["金門縣", "連江縣"],
};

// 週排程（0=週日, 1=週一, ...）
const WEEKLY_SCHEDULE: Record<number, string[]> = {
  1: REGIONS.六都,                    // 週一：六都
  2: REGIONS.北部,                    // 週二：北部
  3: REGIONS.中部,                    // 週三：中部
  4: REGIONS.南部東部,                // 週四：南部東部
  5: REGIONS.離島,                    // 週五：離島
  // 週六、週日不排程
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json().catch(() => ({}));
    const { mode, regions: customRegions, task_type } = body;

    let regionsToProcess: string[] = [];
    let taskTypeToCreate = task_type || "candidate_search";

    // 決定要處理的縣市
    if (mode === "manual" && customRegions) {
      // 手動指定縣市
      regionsToProcess = customRegions;
    } else if (mode === "all") {
      // 所有縣市
      regionsToProcess = Object.values(REGIONS).flat();
    } else {
      // 按週排程
      const dayOfWeek = new Date().getDay();
      regionsToProcess = WEEKLY_SCHEDULE[dayOfWeek] || [];
    }

    if (regionsToProcess.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "今日無排程任務（週末休息）",
          scheduled: [],
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 計算搜尋日期限制（過去 30 天）
    const today = new Date();
    const searchDateLimit = new Date(today);
    searchDateLimit.setDate(searchDateLimit.getDate() - 30);
    const searchAfterDate = searchDateLimit.toISOString().split("T")[0];

    // 建立任務
    const createdTasks: any[] = [];
    const skippedTasks: any[] = [];

    for (const region of regionsToProcess) {
      // 檢查今天是否已有相同任務
      const { data: existing } = await supabase
        .from("ai_prompts")
        .select("id")
        .eq("task_type", taskTypeToCreate)
        .contains("parameters", { region })
        .gte("created_at", today.toISOString().split("T")[0])
        .limit(1);

      if (existing && existing.length > 0) {
        skippedTasks.push({ region, reason: "今日已排程" });
        continue;
      }

      // 建立新任務
      const { data: prompt, error } = await supabase
        .from("ai_prompts")
        .insert({
          task_type: taskTypeToCreate,
          prompt_template: getPromptTemplate(taskTypeToCreate, region),
          parameters: {
            election_year: 2026,
            region,
            search_after_date: searchAfterDate,
            search_date_limit: 30,
          },
          status: "pending",
          priority: getPriority(region),
        })
        .select("id, task_type, parameters")
        .single();

      if (error) {
        console.error(`Failed to create task for ${region}:`, error);
        skippedTasks.push({ region, reason: error.message });
      } else {
        createdTasks.push(prompt);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `排程完成：建立 ${createdTasks.length} 個任務，跳過 ${skippedTasks.length} 個`,
        created: createdTasks,
        skipped: skippedTasks,
        search_date_limit: searchAfterDate,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("ai-scheduler error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", message: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

/**
 * 取得任務提示詞模板
 */
function getPromptTemplate(taskType: string, region: string): string {
  const today = new Date().toISOString().split("T")[0];
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const searchAfter = thirtyDaysAgo.toISOString().split("T")[0];

  switch (taskType) {
    case "candidate_search":
      return `
搜尋 2026 年 ${region} 的縣市長與議員候選人。

## 搜尋日期限制
**重要**：只搜尋 ${searchAfter} 之後的新聞資料。
- 使用搜尋語法：2026年${region}候選人 after:${searchAfter}
- 排除 2022 年或更早的選舉資訊
- 優先使用最近一週的新聞

## 執行步驟
1. 先查詢現有候選人（query_candidates）
2. 網路搜尋新候選人
3. 評估每位候選人的信心度
4. 只匯入信心度 >= 0.7 且不重複的候選人
5. 更新任務狀態

若無最新消息，回報「${region}無最新候選人消息」並完成任務。
      `.trim();

    case "policy_search":
      return `
搜尋 ${region} 現任首長的最新政見與施政報告。

## 搜尋日期限制
只搜尋 ${searchAfter} 之後的新聞。

## 執行步驟
1. 先查詢現有政見（query_policies）
2. 網路搜尋新政見
3. 只新增不重複的政見
4. 更新任務狀態
      `.trim();

    default:
      return `執行 ${taskType} 任務，地區：${region}`;
  }
}

/**
 * 取得任務優先順序
 */
function getPriority(region: string): number {
  // 六都優先
  if (REGIONS.六都.includes(region)) return 1;
  // 北部次之
  if (REGIONS.北部.includes(region)) return 2;
  // 其他
  return 3;
}
