import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * AI Action - 統一的 AI 任務處理 Edge Function
 *
 * 支援的 action 類型：
 *
 * 查詢類（先查詢再決定是否新增）：
 * - query_candidates: 查詢現有候選人（防止重複）
 * - query_policies: 查詢現有政見（防止重複）
 *
 * 寫入類（需要信心度檢查）：
 * - import_candidate: 匯入候選人（需 confidence >= 0.7）
 * - update_politician: 更新候選人資料（簡介、經歷、學歷、頭像）
 * - add_policy: 新增政見
 * - update_policy: 更新政見進度
 * - add_tracking_log: 新增追蹤紀錄
 * - update_prompt: 更新任務狀態
 * - add_policy_source: 新增政見資料來源
 * - query_policy_sources: 查詢政見資料來源
 */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const expectedApiKey = Deno.env.get("AI_IMPORT_API_KEY") || "policy-ai-2026";

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();

    // API Key 驗證
    if (body.api_key !== expectedApiKey) {
      return new Response(
        JSON.stringify({ error: "Invalid API key" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { action, prompt_id } = body;

    switch (action) {
      // 查詢類 API（讓 Claude 先查再新增）
      case "query_candidates":
        return await handleQueryCandidates(supabase, body);

      case "query_policies":
        return await handleQueryPolicies(supabase, body);

      // 寫入類 API
      case "import_candidate":
        return await handleImportCandidate(supabase, body);

      case "update_politician":
        return await handleUpdatePolitician(supabase, body);

      case "add_policy":
        return await handleAddPolicy(supabase, body);

      case "update_policy":
        return await handleUpdatePolicy(supabase, body);

      case "add_tracking_log":
        return await handleAddTrackingLog(supabase, body);

      case "update_prompt":
        return await handleUpdatePrompt(supabase, body);

      case "add_policy_source":
        return await handleAddPolicySource(supabase, body);

      case "query_policy_sources":
        return await handleQueryPolicySources(supabase, body);

      case "deduplicate_candidates":
        return await handleDeduplicateCandidates(supabase, body);

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  } catch (error: any) {
    console.error("ai-action error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", message: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ============================================================
// 查詢類 Action Handlers
// ============================================================

/**
 * 查詢現有候選人（讓 Claude 先查詢再決定是否新增）
 */
async function handleQueryCandidates(supabase: any, body: any): Promise<Response> {
  const { election_year, region, position, name } = body;

  let query = supabase
    .from("politicians")
    .select(`
      id,
      name,
      party,
      position,
      region,
      current_position,
      politician_elections!inner (
        id,
        candidate_status,
        verified,
        elections!inner (
          id,
          election_date
        )
      )
    `);

  // 按年份過濾
  if (election_year) {
    query = query
      .gte("politician_elections.elections.election_date", `${election_year}-01-01`)
      .lte("politician_elections.elections.election_date", `${election_year}-12-31`);
  }

  // 按地區過濾
  if (region) {
    query = query.ilike("region", `%${region}%`);
  }

  // 按職位過濾
  if (position) {
    query = query.ilike("position", `%${position}%`);
  }

  // 按姓名過濾（模糊搜尋）
  if (name) {
    query = query.ilike("name", `%${name}%`);
  }

  const { data, error } = await query.limit(50);

  if (error) {
    return errorResponse(error.message, 500);
  }

  // 整理回傳格式
  const candidates = (data || []).map((p: any) => ({
    id: p.id,
    name: p.name,
    party: p.party,
    position: p.position,
    region: p.region,
    current_position: p.current_position,
    candidate_status: p.politician_elections?.[0]?.candidate_status,
    verified: p.politician_elections?.[0]?.verified,
  }));

  return successResponse({
    count: candidates.length,
    candidates,
    message: candidates.length > 0
      ? `找到 ${candidates.length} 位現有候選人`
      : "沒有找到符合條件的候選人",
  });
}

/**
 * 查詢現有政見（讓 Claude 先查詢再決定是否新增）
 */
async function handleQueryPolicies(supabase: any, body: any): Promise<Response> {
  const { politician_name, politician_id, category, keywords } = body;

  let politicianIds: number[] = [];

  // 如果有政治人物 ID，直接使用
  if (politician_id) {
    politicianIds = [politician_id];
  } else if (politician_name) {
    // 先找政治人物
    const { data: politicians } = await supabase
      .from("politicians")
      .select("id")
      .ilike("name", `%${politician_name}%`);

    if (politicians && politicians.length > 0) {
      politicianIds = politicians.map((p: any) => p.id);
    }
  }

  if (politicianIds.length === 0 && politician_name) {
    return successResponse({
      count: 0,
      policies: [],
      message: `找不到政治人物: ${politician_name}`,
    });
  }

  let query = supabase
    .from("policies")
    .select(`
      id,
      title,
      description,
      category,
      status,
      source_url,
      politicians (
        id,
        name
      )
    `);

  // 按政治人物過濾
  if (politicianIds.length > 0) {
    query = query.in("politician_id", politicianIds);
  }

  // 按分類過濾
  if (category) {
    query = query.eq("category", category);
  }

  // 按關鍵字過濾（標題或描述）
  if (keywords && keywords.length > 0) {
    const keywordFilters = keywords.map((k: string) => `title.ilike.%${k}%,description.ilike.%${k}%`);
    query = query.or(keywordFilters.join(","));
  }

  const { data, error } = await query.limit(50);

  if (error) {
    return errorResponse(error.message, 500);
  }

  // 整理回傳格式
  const policies = (data || []).map((p: any) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    category: p.category,
    status: p.status,
    source_url: p.source_url,
    politician_name: p.politicians?.name,
  }));

  return successResponse({
    count: policies.length,
    policies,
    message: policies.length > 0
      ? `找到 ${policies.length} 條現有政見`
      : "沒有找到符合條件的政見",
  });
}

// ============================================================
// 寫入類 Action Handlers
// ============================================================

/**
 * 更新任務狀態
 */
async function handleUpdatePrompt(supabase: any, body: any): Promise<Response> {
  const { prompt_id, status, result_summary, result_data, error_message } = body;

  if (!prompt_id) {
    return errorResponse("Missing prompt_id");
  }

  const updateData: any = {
    status,
    result_summary,
    completed_at: new Date().toISOString(),
  };

  if (result_data) {
    updateData.result_data = result_data;
  }

  if (error_message) {
    updateData.error_message = error_message;
  }

  const { error } = await supabase
    .from("ai_prompts")
    .update(updateData)
    .eq("id", prompt_id);

  if (error) {
    return errorResponse(error.message, 500);
  }

  return successResponse({ message: `Prompt ${prompt_id} updated to ${status}` });
}

/**
 * 匯入候選人
 *
 * 需要信心度檢查：
 * - confidence >= 0.7: 允許新增
 * - confidence < 0.7: 跳過，僅記錄
 * - 若無 confidence 欄位，預設為 0.5（不允許新增）
 */
async function handleImportCandidate(supabase: any, body: any): Promise<Response> {
  const { prompt_id, election_year, candidate } = body;

  if (!election_year || !candidate?.name) {
    return errorResponse("Missing election_year or candidate.name");
  }

  // 信心度檢查（需 >= 0.7 才能新增）
  const confidence = candidate.confidence ?? 0.5;
  const CONFIDENCE_THRESHOLD = 0.7;

  if (confidence < CONFIDENCE_THRESHOLD) {
    return successResponse({
      skipped: true,
      reason: "low_confidence",
      message: `跳過低信心度候選人: ${candidate.name} (confidence: ${confidence}, 需要 >= ${CONFIDENCE_THRESHOLD})`,
      candidate_name: candidate.name,
      confidence,
    });
  }

  // 過濾無效名稱
  const invalidPatterns = ['未定', '待定', '待確認', '未知', '人選', '待公布'];
  if (invalidPatterns.some(p => candidate.name.includes(p)) ||
      candidate.name.length < 2 || candidate.name.length > 10) {
    return successResponse({ skipped: true, reason: "invalid_name", message: `跳過無效名稱: ${candidate.name}` });
  }

  // 找或建立選舉
  let { data: election } = await supabase
    .from("elections")
    .select("id")
    .gte("election_date", `${election_year}-01-01`)
    .lte("election_date", `${election_year}-12-31`)
    .single();

  if (!election) {
    const { data: newElection, error } = await supabase
      .from("elections")
      .insert({
        name: `${election_year}年地方公職人員選舉`,
        short_name: `${election_year}地方選舉`,
        election_date: `${election_year}-11-26`,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    election = newElection;
  }

  // 政黨對應
  const partyMap: Record<string, string> = {
    "國民黨": "中國國民黨", "中國國民黨": "中國國民黨",
    "民進黨": "民主進步黨", "民主進步黨": "民主進步黨",
    "民眾黨": "台灣民眾黨", "台灣民眾黨": "台灣民眾黨",
    "時代力量": "時代力量", "台灣基進": "台灣基進",
    "無黨籍": "無黨籍", "無": "無黨籍",
  };
  const party = partyMap[candidate.party || ""] || "無黨籍";

  // 找或建立政治人物
  let { data: politician } = await supabase
    .from("politicians")
    .select("id")
    .eq("name", candidate.name)
    .single();

  if (!politician) {
    const { data: newPol, error } = await supabase
      .from("politicians")
      .insert({
        name: candidate.name,
        party,
        position: candidate.position,
        region: candidate.region,
        current_position: candidate.current_position || null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    politician = newPol;
  }

  // 檢查是否已有參選紀錄
  const { data: existingPE } = await supabase
    .from("politician_elections")
    .select("id")
    .eq("politician_id", politician.id)
    .eq("election_id", election.id)
    .single();

  if (existingPE) {
    await supabase
      .from("politician_elections")
      .update({
        candidate_status: candidate.status || "rumored",
        source_note: `AI(${prompt_id?.substring(0, 8) || '-'})`,
      })
      .eq("id", existingPE.id);
    return successResponse({ action: "updated", name: candidate.name, politician_id: politician.id });
  }

  // 建立參選紀錄
  const { error: peError } = await supabase
    .from("politician_elections")
    .insert({
      politician_id: politician.id,
      election_id: election.id,
      position: candidate.position,
      election_type: mapPositionToType(candidate.position),
      candidate_status: candidate.status || "rumored",
      verified: false,
      source_note: `AI(${prompt_id?.substring(0, 8) || '-'})`,
    });

  if (peError) throw new Error(peError.message);

  return successResponse({ action: "created", name: candidate.name, politician_id: politician.id });
}

/**
 * 更新候選人資料（簡介、經歷、學歷、頭像）
 *
 * 支援更新欄位：
 * - bio: 個人簡介
 * - experience: 經歷陣列 (string[])
 * - education: 學歷陣列 (string[])
 * - education_level: 最高學歷
 * - birth_year: 出生年份
 * - avatar_url: 頭像網址
 * - slogan: 競選口號
 * - current_position: 現任職位
 */
async function handleUpdatePolitician(supabase: any, body: any): Promise<Response> {
  const { prompt_id, politician_id, politician_name, updates } = body;

  if (!politician_id && !politician_name) {
    return errorResponse("Missing politician_id or politician_name");
  }

  if (!updates || Object.keys(updates).length === 0) {
    return errorResponse("Missing updates object");
  }

  // 找到政治人物
  let politicianId = politician_id;

  if (!politicianId && politician_name) {
    const { data: politician } = await supabase
      .from("politicians")
      .select("id")
      .eq("name", politician_name)
      .single();

    if (!politician) {
      return errorResponse(`找不到政治人物: ${politician_name}`, 404);
    }
    politicianId = politician.id;
  }

  // 構建更新資料（只允許特定欄位）
  const allowedFields = [
    "bio",
    "experience",
    "education",
    "education_level",
    "birth_year",
    "avatar_url",
    "slogan",
    "current_position",
  ];

  // 欄位別名映射（AI 可能使用不同的名稱）
  const fieldAliases: Record<string, string> = {
    "biography": "bio",
    "photo_url": "avatar_url",
    "photo": "avatar_url",
    "image_url": "avatar_url",
    "avatar": "avatar_url",
  };

  const updateData: Record<string, any> = {};

  // 先處理別名
  for (const [alias, canonical] of Object.entries(fieldAliases)) {
    if (updates[alias] !== undefined && updates[canonical] === undefined) {
      updates[canonical] = updates[alias];
    }
  }

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      // 特殊處理陣列欄位
      if (field === "experience" || field === "education") {
        // 確保是陣列
        if (Array.isArray(updates[field])) {
          updateData[field] = updates[field];
        } else if (typeof updates[field] === "string") {
          // 如果是字串，嘗試分割成陣列
          updateData[field] = updates[field].split(/[,、\n]/).map((s: string) => s.trim()).filter(Boolean);
        }
      } else if (field === "birth_year") {
        // 確保是數字
        const year = parseInt(updates[field], 10);
        if (!isNaN(year) && year >= 1900 && year <= 2010) {
          updateData[field] = year;
        }
      } else if (field === "avatar_url") {
        // avatar_url 需要異步驗證，先暫存
        const url = updates[field];
        if (typeof url === "string" && url.length > 0) {
          // 基本格式檢查：必須是實際圖片 URL，不能是 Wikipedia 分類頁面
          const isValidFormat = (
            url.includes("upload.wikimedia.org") ||
            url.includes(".jpg") ||
            url.includes(".jpeg") ||
            url.includes(".png") ||
            url.includes(".webp") ||
            url.includes("taichung.gov.tw/media") ||
            url.includes("taipei.gov.tw") ||
            url.includes("kcg.gov.tw")
          ) && !url.includes("commons.wikimedia.org/wiki/Category:");

          if (isValidFormat) {
            // 嘗試下載驗證圖片是否可用
            try {
              const response = await fetch(url, {
                method: "HEAD",
                headers: {
                  "User-Agent": "Mozilla/5.0 (compatible; PolicyTracker/1.0)",
                },
              });

              if (response.ok) {
                const contentType = response.headers.get("content-type") || "";
                if (contentType.startsWith("image/")) {
                  updateData[field] = url;
                  console.log(`[update_politician] Verified avatar_url: ${url}`);
                } else {
                  console.log(`[update_politician] Rejected avatar_url (not image): ${url}, content-type: ${contentType}`);
                }
              } else {
                console.log(`[update_politician] Rejected avatar_url (fetch failed): ${url}, status: ${response.status}`);
              }
            } catch (fetchError) {
              console.log(`[update_politician] Rejected avatar_url (fetch error): ${url}, error: ${fetchError}`);
            }
          } else {
            console.log(`[update_politician] Rejected invalid avatar_url format: ${url}`);
          }
        }
      } else {
        // 其他欄位直接設定
        updateData[field] = updates[field];
      }
    }
  }

  if (Object.keys(updateData).length === 0) {
    return errorResponse("No valid fields to update");
  }

  // 執行更新
  const { error } = await supabase
    .from("politicians")
    .update(updateData)
    .eq("id", politicianId);

  if (error) {
    return errorResponse(error.message, 500);
  }

  // 記錄更新來源
  const updatedFields = Object.keys(updateData);
  console.log(`[update_politician] Updated ${politician_name || politicianId}: ${updatedFields.join(", ")} (prompt: ${prompt_id?.substring(0, 8) || '-'})`);

  return successResponse({
    action: "updated",
    politician_id: politicianId,
    updated_fields: updatedFields,
    message: `已更新 ${updatedFields.length} 個欄位`,
  });
}

/**
 * 新增政見
 */
async function handleAddPolicy(supabase: any, body: any): Promise<Response> {
  const { prompt_id, politician_name, policy } = body;

  if (!politician_name || !policy?.title) {
    return errorResponse("Missing politician_name or policy.title");
  }

  // 找政治人物
  const { data: politician } = await supabase
    .from("politicians")
    .select("id")
    .eq("name", politician_name)
    .single();

  if (!politician) {
    return errorResponse(`找不到政治人物: ${politician_name}`, 404);
  }

  // 檢查是否已有相同政見
  const { data: existing } = await supabase
    .from("policies")
    .select("id")
    .eq("politician_id", politician.id)
    .ilike("title", policy.title)
    .single();

  if (existing) {
    return successResponse({ action: "exists", policy_id: existing.id, message: "政見已存在" });
  }

  // 建立政見
  const today = new Date().toISOString().split('T')[0];
  const { data: newPolicy, error } = await supabase
    .from("policies")
    .insert({
      politician_id: politician.id,
      title: policy.title,
      description: policy.description || null,
      category: policy.category || "其他",
      status: policy.status || "Campaign Pledge",
      source_url: policy.source_url || null,
      ai_extracted: true,
      proposed_date: today,
      last_updated: today,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  return successResponse({ action: "created", policy_id: newPolicy.id, title: policy.title });
}

/**
 * 更新政見進度
 */
async function handleUpdatePolicy(supabase: any, body: any): Promise<Response> {
  const { prompt_id, policy_id, politician_name, policy_title, new_status, progress_note } = body;

  let policyId = policy_id;

  // 如果沒有 policy_id，用政治人物名稱+政見標題查找
  if (!policyId && politician_name && policy_title) {
    const { data: politician } = await supabase
      .from("politicians")
      .select("id")
      .eq("name", politician_name)
      .single();

    if (!politician) {
      return errorResponse(`找不到政治人物: ${politician_name}`, 404);
    }

    const { data: policy } = await supabase
      .from("policies")
      .select("id")
      .eq("politician_id", politician.id)
      .ilike("title", `%${policy_title}%`)
      .single();

    if (!policy) {
      return errorResponse(`找不到政見: ${policy_title}`, 404);
    }
    policyId = policy.id;
  }

  if (!policyId) {
    return errorResponse("Missing policy_id or politician_name+policy_title");
  }

  // 更新政見狀態
  const updateData: any = {};
  if (new_status) {
    updateData.status = new_status;
  }

  if (Object.keys(updateData).length > 0) {
    const { error } = await supabase
      .from("policies")
      .update(updateData)
      .eq("id", policyId);
    if (error) throw new Error(error.message);
  }

  // 新增追蹤紀錄
  if (progress_note) {
    await supabase
      .from("tracking_logs")
      .insert({
        policy_id: policyId,
        status: new_status || "進行中",
        content: progress_note,
        source_name: `AI(${prompt_id?.substring(0, 8) || '-'})`,
        log_date: new Date().toISOString().split('T')[0],
      });
  }

  return successResponse({ action: "updated", policy_id: policyId });
}

/**
 * 新增追蹤紀錄
 */
async function handleAddTrackingLog(supabase: any, body: any): Promise<Response> {
  const { prompt_id, policy_id, politician_name, policy_title, log } = body;

  let policyId = policy_id;

  // 如果沒有 policy_id，用政治人物名稱+政見標題查找
  if (!policyId && politician_name && policy_title) {
    const { data: politician } = await supabase
      .from("politicians")
      .select("id")
      .eq("name", politician_name)
      .single();

    if (politician) {
      const { data: policy } = await supabase
        .from("policies")
        .select("id")
        .eq("politician_id", politician.id)
        .ilike("title", `%${policy_title}%`)
        .single();
      if (policy) policyId = policy.id;
    }
  }

  if (!policyId) {
    return errorResponse("找不到對應的政見");
  }

  const { data: newLog, error } = await supabase
    .from("tracking_logs")
    .insert({
      policy_id: policyId,
      status: log.status || "進行中",
      content: log.content,
      source_url: log.source_url || null,
      source_name: log.source_name || `AI(${prompt_id?.substring(0, 8) || '-'})`,
      log_date: log.date || new Date().toISOString().split('T')[0],
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  return successResponse({ action: "created", log_id: newLog.id });
}

/**
 * 去重候選人資料
 *
 * 找出同名同選舉的重複 politician_elections 記錄並合併
 */
async function handleDeduplicateCandidates(supabase: any, body: any): Promise<Response> {
  const { election_year, dry_run = true } = body;

  if (!election_year) {
    return errorResponse("Missing election_year");
  }

  // 找出該選舉年份的所有參選記錄
  const { data: elections } = await supabase
    .from("elections")
    .select("id")
    .gte("election_date", `${election_year}-01-01`)
    .lte("election_date", `${election_year}-12-31`);

  if (!elections || elections.length === 0) {
    return successResponse({ message: "找不到該年份的選舉", duplicates: [] });
  }

  const electionIds = elections.map((e: any) => e.id);

  // 找出重複的 politician_elections (同一 politician 在同一 election 有多筆記錄)
  const { data: allPE } = await supabase
    .from("politician_elections")
    .select(`
      id,
      politician_id,
      election_id,
      position,
      candidate_status,
      created_at,
      politicians (
        id,
        name,
        region
      )
    `)
    .in("election_id", electionIds)
    .order("created_at", { ascending: true });

  if (!allPE || allPE.length === 0) {
    return successResponse({ message: "沒有參選記錄", duplicates: [] });
  }

  // 按 politician_id + election_id 分組
  const groups: Record<string, any[]> = {};
  for (const pe of allPE) {
    const key = `${pe.politician_id}-${pe.election_id}`;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(pe);
  }

  // 找出有重複的群組
  const duplicates: any[] = [];
  const toDelete: string[] = [];

  for (const [key, records] of Object.entries(groups)) {
    if (records.length > 1) {
      // 保留最早的記錄，刪除其他
      const [keep, ...remove] = records;
      duplicates.push({
        name: keep.politicians?.name,
        region: keep.politicians?.region,
        kept: keep.id,
        removed: remove.map((r: any) => r.id),
        count: records.length,
      });
      toDelete.push(...remove.map((r: any) => r.id));
    }
  }

  // 如果不是 dry_run，執行刪除
  let deleted = 0;
  if (!dry_run && toDelete.length > 0) {
    const { error } = await supabase
      .from("politician_elections")
      .delete()
      .in("id", toDelete);

    if (error) {
      return errorResponse(`刪除失敗: ${error.message}`, 500);
    }
    deleted = toDelete.length;
  }

  return successResponse({
    message: dry_run
      ? `找到 ${duplicates.length} 組重複資料（預覽模式，未刪除）`
      : `已刪除 ${deleted} 筆重複資料`,
    dry_run,
    duplicate_groups: duplicates.length,
    total_duplicates: toDelete.length,
    duplicates: duplicates.slice(0, 20), // 只回傳前 20 筆
  });
}

// ============================================================
// 資料來源 Action Handlers
// ============================================================

/**
 * 新增政見資料來源
 *
 * 支援兩種查找方式：
 * - 直接提供 policy_id
 * - 提供 politician_name + policy_title 反查
 */
async function handleAddPolicySource(supabase: any, body: any): Promise<Response> {
  const { policy_id, politician_name, policy_title, sources } = body;

  if (!sources || !Array.isArray(sources) || sources.length === 0) {
    return errorResponse("Missing or empty sources array");
  }

  let policyId = policy_id;

  // 如果沒有 policy_id，用政治人物名稱+政見標題查找
  if (!policyId && politician_name && policy_title) {
    const { data: politician } = await supabase
      .from("politicians")
      .select("id")
      .eq("name", politician_name)
      .single();

    if (!politician) {
      return errorResponse(`找不到政治人物: ${politician_name}`, 404);
    }

    const { data: policy } = await supabase
      .from("policies")
      .select("id")
      .eq("politician_id", politician.id)
      .ilike("title", `%${policy_title}%`)
      .single();

    if (!policy) {
      return errorResponse(`找不到政見: ${policy_title}`, 404);
    }
    policyId = policy.id;
  }

  if (!policyId) {
    return errorResponse("Missing policy_id or politician_name+policy_title");
  }

  // 準備 upsert 資料
  const rows = sources.map((s: any) => ({
    policy_id: policyId,
    url: s.url,
    title: s.title || null,
    source_name: s.source_name || null,
    published_date: s.published_date || null,
  }));

  // upsert：衝突時不做任何事（避免重複 URL）
  const { data, error } = await supabase
    .from("policy_sources")
    .upsert(rows, { onConflict: "policy_id,url", ignoreDuplicates: true })
    .select("id");

  if (error) {
    return errorResponse(error.message, 500);
  }

  return successResponse({
    action: "added",
    policy_id: policyId,
    inserted_count: data?.length || 0,
    message: `新增 ${data?.length || 0} 筆資料來源`,
  });
}

/**
 * 查詢政見資料來源
 */
async function handleQueryPolicySources(supabase: any, body: any): Promise<Response> {
  const { policy_id, limit: queryLimit, offset: queryOffset } = body;

  if (!policy_id) {
    return errorResponse("Missing policy_id");
  }

  let query = supabase
    .from("policy_sources")
    .select("*")
    .eq("policy_id", policy_id)
    .order("published_date", { ascending: false, nullsFirst: false });

  if (queryLimit) {
    query = query.limit(queryLimit);
  }
  if (queryOffset) {
    query = query.range(queryOffset, queryOffset + (queryLimit || 50) - 1);
  }

  const { data, error } = await query;

  if (error) {
    return errorResponse(error.message, 500);
  }

  return successResponse({
    policy_id,
    count: data?.length || 0,
    sources: data || [],
  });
}

// ============================================================
// Helpers
// ============================================================

function successResponse(data: any): Response {
  return new Response(
    JSON.stringify({ success: true, ...data }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

function errorResponse(message: string, status = 400): Response {
  return new Response(
    JSON.stringify({ success: false, error: message }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

function mapPositionToType(position: string): string {
  if (position.includes("總統")) return "總統副總統";
  if (position.includes("立法委員") || position.includes("立委")) return "立法委員";
  if (position.includes("市長") || position.includes("縣長")) return "縣市長";
  if (position.includes("議員")) return "縣市議員";
  if (position.includes("鄉長") || position.includes("鎮長")) return "鄉鎮市長";
  if (position.includes("代表")) return "鄉鎮市民代表";
  if (position.includes("村長") || position.includes("里長")) return "村里長";
  return "縣市長";
}
