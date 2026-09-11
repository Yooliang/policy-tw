import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  ambiguousPayload,
  ensurePolitician,
  findOrCreateElection,
  positionToElectionType,
  upsertParticipation,
} from "../_shared/candidate-import.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * AI Import Candidate - 供 Claude CLI 直接呼叫的 Edge Function
 *
 * 使用 API Key 認證而非 JWT，讓 Claude 可以直接呼叫。
 * 找人走 _shared/politician-identity.ts 的多面向比對，不再用 name.eq().single()。
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const expectedApiKey = Deno.env.get("AI_IMPORT_API_KEY");
    if (!expectedApiKey) {
      return json({ error: "Server configuration error", message: "AI_IMPORT_API_KEY is not configured" }, 500);
    }

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();

    // 簡單 API Key 驗證
    if (body.api_key !== expectedApiKey) {
      return json({ error: "Invalid API key" }, 401);
    }

    // 判斷請求類型
    if (body.status) {
      return await handleUpdatePrompt(supabaseService, body as UpdatePromptRequest);
    } else if (body.candidate) {
      return await handleImportCandidate(supabaseService, body as ImportRequest);
    }
    return json({ error: "Invalid request body" }, 400);
  } catch (error: any) {
    console.error("ai-import-candidate error:", error);
    return json({ error: "Internal server error", message: error.message }, 500);
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
    return json({ success: false, error: error.message }, 500);
  }

  return json({ success: true, message: `Prompt ${prompt_id} updated to ${status}` });
}

async function handleImportCandidate(
  supabase: any,
  body: ImportRequest
): Promise<Response> {
  const { election_year, candidate, prompt_id } = body;

  if (!election_year || !candidate?.name) {
    return json({ error: "Missing required fields" }, 400);
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
    return json({ success: false, skipped: true, message: `跳過無效名稱: ${candidate.name}` });
  }

  const electionId = await findOrCreateElection(supabase, election_year);
  const sourceNote = `AI搜尋(${prompt_id?.substring(0, 8) || 'direct'})${candidate.note ? `: ${candidate.note}` : ""}`;

  const ensured = await ensurePolitician(supabase, candidate, {
    source: "ai-import-candidate",
    extraInsert: { bio: candidate.current_position ? `現任${candidate.current_position}` : null },
  });
  if (ensured.politician_id === null) {
    return json({ success: true, ...ambiguousPayload(candidate.name, ensured.resolution) });
  }

  const participation = await upsertParticipation(supabase, {
    politician_id: ensured.politician_id,
    election_id: electionId,
    position: candidate.position,
    election_type: positionToElectionType(candidate.position),
    candidate_status: candidate.status || undefined,
    source_note: sourceNote,
  });

  return json({
    success: true,
    action: participation.outcome,
    message: participation.outcome === "created" ? `成功匯入 ${candidate.name}` : `已更新 ${candidate.name}`,
    politician_id: ensured.politician_id,
    politician_created: ensured.created,
    identity: {
      decision: ensured.resolution.decision,
      matched_keys: ensured.resolution.matched_keys.map((k) => k.key_value),
      ...(ensured.resolution.flag ? { flag: ensured.resolution.flag } : {}),
    },
  });
}
