import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * AI Import Candidate - 供 Claude CLI 直接呼叫的 Edge Function
 *
 * 使用 API Key 認證而非 JWT，讓 Claude 可以直接呼叫
 */

interface ImportRequest {
  api_key: string; // 簡單的 API Key 認證
  prompt_id?: string; // 關聯的 ai_prompts ID
  election_year: number;
  candidate: {
    name: string;
    party?: string;
    position: string;
    region: string;
    status?: string; // confirmed, likely, rumored
    current_position?: string;
    note?: string;
    confidence?: number;
  };
}

interface UpdatePromptRequest {
  api_key: string;
  prompt_id: string;
  status: "completed" | "failed";
  result_summary: string;
  candidates_count?: number;
  sources?: string[];
  error_message?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const expectedApiKey = Deno.env.get("AI_IMPORT_API_KEY") || "policy-ai-2026";

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();

    // 簡單 API Key 驗證
    if (body.api_key !== expectedApiKey) {
      return new Response(
        JSON.stringify({ error: "Invalid API key" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 判斷請求類型
    if (body.status) {
      // 更新 prompt 狀態
      return await handleUpdatePrompt(supabaseService, body as UpdatePromptRequest);
    } else if (body.candidate) {
      // 匯入候選人
      return await handleImportCandidate(supabaseService, body as ImportRequest);
    } else {
      return new Response(
        JSON.stringify({ error: "Invalid request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (error: any) {
    console.error("ai-import-candidate error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", message: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function handleUpdatePrompt(
  supabase: any,
  body: UpdatePromptRequest
): Promise<Response> {
  const { prompt_id, status, result_summary, candidates_count, sources, error_message } = body;

  const updateData: any = {
    status,
    result_summary,
    completed_at: new Date().toISOString(),
  };

  if (candidates_count !== undefined) {
    updateData.result_data = {
      candidates_count,
      sources: sources || [],
    };
  }

  if (error_message) {
    updateData.error_message = error_message;
  }

  const { error } = await supabase
    .from("ai_prompts")
    .update(updateData)
    .eq("id", prompt_id);

  if (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, message: `Prompt ${prompt_id} updated to ${status}` }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleImportCandidate(
  supabase: any,
  body: ImportRequest
): Promise<Response> {
  const { election_year, candidate, prompt_id } = body;

  if (!election_year || !candidate?.name) {
    return new Response(
      JSON.stringify({ error: "Missing required fields" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 過濾無效的候選人名稱
  const invalidNamePatterns = [
    '未定', '待定', '待確認', '尚待確認', '未知', '未定人選',
    '其他', '人選', '可能人選', '潛在人選', '待公布',
  ];
  const isInvalidName = invalidNamePatterns.some(p => candidate.name.includes(p)) ||
    candidate.name.length < 2 ||
    candidate.name.length > 10 ||
    /^[a-zA-Z\s]+$/.test(candidate.name);

  if (isInvalidName) {
    return new Response(
      JSON.stringify({
        success: false,
        skipped: true,
        message: `跳過無效名稱: ${candidate.name}`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Find or create election for the year
  let { data: election } = await supabase
    .from("elections")
    .select("id")
    .gte("election_date", `${election_year}-01-01`)
    .lte("election_date", `${election_year}-12-31`)
    .single();

  if (!election) {
    const { data: newElection, error: electionError } = await supabase
      .from("elections")
      .insert({
        name: `${election_year}年地方公職人員選舉`,
        short_name: `${election_year}地方選舉`,
        start_date: `${election_year}-01-01`,
        end_date: `${election_year}-12-31`,
        election_date: `${election_year}-11-26`,
      })
      .select("id")
      .single();

    if (electionError) {
      throw new Error(`Failed to create election: ${electionError.message}`);
    }
    election = newElection;
  }

  // Map party name
  const partyMap: Record<string, string> = {
    "中國國民黨": "中國國民黨",
    "國民黨": "中國國民黨",
    "民主進步黨": "民主進步黨",
    "民進黨": "民主進步黨",
    "台灣民眾黨": "台灣民眾黨",
    "民眾黨": "台灣民眾黨",
    "時代力量": "時代力量",
    "台灣基進": "台灣基進",
    "無黨籍": "無黨籍",
    "無": "無黨籍",
  };
  const party = partyMap[candidate.party || ""] || "無黨籍";

  // Find or create politician
  let { data: politician } = await supabase
    .from("politicians")
    .select("id")
    .eq("name", candidate.name)
    .single();

  if (!politician) {
    const { data: newPolitician, error: politicianError } = await supabase
      .from("politicians")
      .insert({
        name: candidate.name,
        party: party,
        position: candidate.position,
        region: candidate.region,
        current_position: candidate.current_position || null,
        bio: candidate.current_position ? `現任${candidate.current_position}` : null,
      })
      .select("id")
      .single();

    if (politicianError) {
      throw new Error(`Failed to create politician: ${politicianError.message}`);
    }
    politician = newPolitician;
  }

  // Check existing politician_election
  const { data: existingPE } = await supabase
    .from("politician_elections")
    .select("id, candidate_status")
    .eq("politician_id", politician.id)
    .eq("election_id", election.id)
    .single();

  if (existingPE) {
    const { error: updateError } = await supabase
      .from("politician_elections")
      .update({
        candidate_status: candidate.status || existingPE.candidate_status || "rumored",
        source_note: `AI搜尋(${prompt_id?.substring(0, 8) || 'direct'})${candidate.note ? `: ${candidate.note}` : ""}`,
      })
      .eq("id", existingPE.id);

    if (updateError) {
      throw new Error(`Failed to update politician_election: ${updateError.message}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        action: "updated",
        message: `已更新 ${candidate.name}`,
        politician_id: politician.id,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Create politician_election
  const { error: peError } = await supabase
    .from("politician_elections")
    .insert({
      politician_id: politician.id,
      election_id: election.id,
      position: candidate.position,
      election_type: mapPositionToType(candidate.position),
      candidate_status: candidate.status || "rumored",
      verified: false,
      source_note: `AI搜尋(${prompt_id?.substring(0, 8) || 'direct'})${candidate.note ? `: ${candidate.note}` : ""}`,
    });

  if (peError) {
    throw new Error(`Failed to create politician_election: ${peError.message}`);
  }

  return new Response(
    JSON.stringify({
      success: true,
      action: "created",
      message: `成功匯入 ${candidate.name}`,
      politician_id: politician.id,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

function mapPositionToType(position: string): string {
  if (position.includes("總統") || position.includes("副總統")) return "總統副總統";
  if (position.includes("立法委員") || position.includes("立委")) return "立法委員";
  if (position.includes("市長") || position.includes("縣長")) return "縣市長";
  if (position.includes("議員")) return "縣市議員";
  if (position.includes("鄉長") || position.includes("鎮長") || position.includes("區長")) return "鄉鎮市長";
  if (position.includes("代表")) return "鄉鎮市民代表";
  if (position.includes("村長") || position.includes("里長")) return "村里長";
  return "縣市長";
}
