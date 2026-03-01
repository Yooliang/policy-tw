import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * AI Scheduler - 每日自動排程 AI 任務
 *
 * 三軌任務：
 * 1. daily_regions — 全台 22 縣市候選人掃描（每日）
 * 2. news_check — 搜尋 30 則最新新聞並交叉比對（每日）
 * 3. daily_review — 每日資料總整檢查（每日 23:00 台灣時間）
 *
 * 觸發方式：
 * - GCP PM2 cron（主要）
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

const ALL_REGIONS = Object.values(REGIONS).flat();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json().catch(() => ({}));
    const { mode = "daily_regions", regions: customRegions, task_type } = body;

    // 日期計算
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const searchDateLimit = new Date(today);
    searchDateLimit.setDate(searchDateLimit.getDate() - 30);
    const searchAfterDate = searchDateLimit.toISOString().split("T")[0];

    // ── news_check 模式：建立 1 筆新聞檢查任務 ──
    if (mode === "news_check") {
      return await handleNewsCheck(supabase, todayStr, searchAfterDate);
    }

    // ── daily_review 模式：建立 1 筆資料總整檢查任務 ──
    if (mode === "daily_review") {
      return await handleDailyReview(supabase, todayStr);
    }

    // ── 地區掃描模式 ──
    let regionsToProcess: string[] = [];
    const taskTypeToCreate = task_type || "candidate_search";

    if (mode === "manual" && customRegions) {
      regionsToProcess = customRegions;
    } else if (mode === "daily_regions" || mode === "all") {
      regionsToProcess = ALL_REGIONS;
    } else {
      // 向後相容：未知 mode 也跑全部
      regionsToProcess = ALL_REGIONS;
    }

    // 建立地區任務
    const createdTasks: any[] = [];
    const skippedTasks: any[] = [];

    for (const region of regionsToProcess) {
      // 防重複：今天已有同類型+同地區的任務就跳過
      const { data: existing } = await supabase
        .from("ai_prompts")
        .select("id")
        .eq("task_type", taskTypeToCreate)
        .contains("parameters", { region })
        .gte("created_at", todayStr)
        .limit(1);

      if (existing && existing.length > 0) {
        skippedTasks.push({ region, reason: "今日已排程" });
        continue;
      }

      const { data: prompt, error } = await supabase
        .from("ai_prompts")
        .insert({
          task_type: taskTypeToCreate,
          user_input: getRegionPrompt(region, searchAfterDate),
          parameters: {
            election_year: 2026,
            region,
            search_after_date: searchAfterDate,
            search_date_limit: 30,
          },
          status: "pending",
          priority: getRegionPriority(region),
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

    return jsonResponse({
      success: true,
      mode,
      message: `排程完成：建立 ${createdTasks.length} 個任務，跳過 ${skippedTasks.length} 個`,
      created: createdTasks,
      skipped: skippedTasks,
      search_date_limit: searchAfterDate,
    });
  } catch (error: any) {
    console.error("ai-scheduler error:", error);
    return jsonResponse(
      { error: "Internal server error", message: error.message },
      500
    );
  }
});

/**
 * 處理 news_check 模式
 */
async function handleNewsCheck(
  supabase: any,
  todayStr: string,
  searchAfterDate: string
) {
  // 防重複：今天已有 news_check 任務就跳過
  const { data: existing } = await supabase
    .from("ai_prompts")
    .select("id")
    .eq("task_type", "news_check")
    .gte("created_at", todayStr)
    .limit(1);

  if (existing && existing.length > 0) {
    return jsonResponse({
      success: true,
      mode: "news_check",
      message: "今日新聞檢查已排程，跳過",
      skipped: true,
    });
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const { data: prompt, error } = await supabase
    .from("ai_prompts")
    .insert({
      task_type: "news_check",
      user_input: getNewsCheckPrompt(yesterdayStr, todayStr),
      parameters: {
        election_year: 2026,
        search_after_date: yesterdayStr,
        target_count: 30,
      },
      status: "pending",
      priority: 8, // 高於地區掃描，優先執行
    })
    .select("id, task_type, parameters")
    .single();

  if (error) {
    console.error("Failed to create news_check task:", error);
    return jsonResponse(
      { success: false, error: error.message },
      500
    );
  }

  return jsonResponse({
    success: true,
    mode: "news_check",
    message: "新聞檢查任務已建立",
    created: [prompt],
  });
}

/**
 * 處理 daily_review 模式
 */
async function handleDailyReview(
  supabase: any,
  todayStr: string
) {
  // 防重複：今天已有 daily_review 任務就跳過
  const { data: existing } = await supabase
    .from("ai_prompts")
    .select("id")
    .eq("task_type", "daily_review")
    .gte("created_at", todayStr)
    .limit(1);

  if (existing && existing.length > 0) {
    return jsonResponse({
      success: true,
      mode: "daily_review",
      message: "今日資料總整檢查已排程，跳過",
      skipped: true,
    });
  }

  const { data: prompt, error } = await supabase
    .from("ai_prompts")
    .insert({
      task_type: "daily_review",
      user_input: getDailyReviewPrompt(todayStr),
      parameters: {
        target_date: todayStr,
      },
      status: "pending",
      priority: 6, // 低於 news_check(8)，收尾性質
    })
    .select("id, task_type, parameters")
    .single();

  if (error) {
    console.error("Failed to create daily_review task:", error);
    return jsonResponse(
      { success: false, error: error.message },
      500
    );
  }

  return jsonResponse({
    success: true,
    mode: "daily_review",
    message: "資料總整檢查任務已建立",
    created: [prompt],
  });
}

/**
 * 每日資料總整檢查提示詞
 */
function getDailyReviewPrompt(todayStr: string): string {
  return `
執行 ${todayStr} 的每日資料總整檢查。

## 執行步驟

### 步驟 1：取得資料品質問題清單
呼叫 query_data_quality（附 target_date: "${todayStr}"），取得當日所有資料品質問題。

### 步驟 2：分析問題嚴重程度
將問題分為三個等級：
- **critical**：重複資料、資料衝突
- **warning**：缺少重要欄位（bio、education）
- **info**：缺少非必要欄位（avatar_url）、短描述政見

### 步驟 3：嘗試自動修正
- 對缺少 bio/education 的候選人，嘗試網路搜尋並用 update_politician 補完
- 對重複資料，呼叫 deduplicate_candidates（dry_run=true 先預覽，不自動刪除）
- 對 urls_to_check 清單，用 curl HEAD 驗證 URL 可用性，回報 404 的

### 步驟 4：完成任務
呼叫 update_prompt 完成任務，result_data 包含：
- total_checked: 檢查項目總數
- issues_found: 發現問題數
- issues_fixed: 自動修正數
- 各類問題數量明細
- 無法自動修正的問題清單（供人工處理）

## 注意事項
- **不要刪除資料**：只標記問題或補完資料
- **補完資料需有來源**：不要編造 bio 或 education
- **重複資料只預覽**：deduplicate_candidates 必須用 dry_run=true
`.trim();
}

/**
 * 地區掃描提示詞
 */
function getRegionPrompt(region: string, searchAfter: string): string {
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
}

/**
 * 每日新聞檢查提示詞
 */
function getNewsCheckPrompt(afterDate: string, todayDate: string): string {
  return `
搜尋 ${afterDate} 至 ${todayDate} 期間台灣選舉與政治相關的最新新聞，目標約 30 則。

## 搜尋策略
依序使用以下關鍵字組合搜尋，蒐集約 30 則不重複新聞：
1. 「2026選舉 候選人 最新」
2. 「2026 縣市長 參選」
3. 「2026 議員 提名」
4. 「政見 發表 2026」
5. 「選舉 政策 台灣 ${todayDate.slice(0, 7)}」

**搜尋來源優先順序**：中央社 > 聯合報 > 自由時報 > 中時 > ETtoday > TVBS > 三立

## 執行步驟

### 步驟 1：掌握現有資料
- 呼叫 query_candidates（election_year=2026）了解已追蹤候選人
- 呼叫 query_policies 了解已追蹤政見

### 步驟 2：搜尋最新新聞
- 用上述 5+ 組關鍵字搜尋
- 只納入 ${afterDate} 之後的新聞
- 記錄每則新聞的標題、來源、日期、摘要

### 步驟 3：逐則分析與更新
對每則相關新聞判斷類型並執行對應 API：

**A. 新候選人宣布參選**（最重要）
→ import_candidate（confidence >= 0.7）

**B. 現有候選人的新政見**
→ add_policy（附來源 URL）

**C. 政見進度更新**（施政報告、預算通過、工程進度等）
→ update_policy 更新狀態 + add_tracking_log 記錄細節

**D. 候選人動態**（退選、轉換選區、政黨提名變動）
→ update_politician 更新資料

**E. 無法歸類但有參考價值的政治新聞**
→ 記錄在結果摘要中，不呼叫 API

### 步驟 4：完成任務
呼叫 update_prompt，result_data 包含：
- total_news_found: 搜尋到的新聞總數
- relevant_count: 與選舉相關的新聞數
- actions_taken: 各類型操作次數（import/add_policy/update/tracking_log）
- news_summary: 每則處理過的新聞標題與處理方式
- sources: 新聞來源 URL 列表

## 注意事項
- **先查詢再新增**：永遠先確認資料庫現有資料，避免重複
- **信心度門檻**：候選人匯入需 confidence >= 0.7
- **每個更新都要附新聞來源 URL**
- **不要編造資訊**：找不到就回報「無相關新聞」
- 若某類關鍵字搜尋結果為空，跳過即可，不需報錯
`.trim();
}

/**
 * 地區優先順序：六都 > 北部 > 其他
 */
function getRegionPriority(region: string): number {
  if (REGIONS.六都.includes(region)) return 5;
  if (REGIONS.北部.includes(region)) return 4;
  return 3;
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
