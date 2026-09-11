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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Admin check helper function
async function isAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`user_profiles lookup: ${error.message}`);
  return data?.is_admin === true;
}

interface ImportRequest {
  election_year: number;
  candidate: {
    name: string;
    party?: string;
    position: string;
    region: string;
    status?: string; // confirmed, likely, rumored
    current_position?: string;
    note?: string;
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Check authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return json({ error: "Authentication required" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseService.auth.getUser(token);

    if (authError || !user) {
      return json({ error: "Authentication required" }, 401);
    }

    // Check admin
    const userIsAdmin = await isAdmin(supabaseService, user.id);
    if (!userIsAdmin) {
      return json({ error: "Forbidden", message: "此功能僅限管理員使用" }, 403);
    }

    const body: ImportRequest = await req.json();
    const { election_year, candidate } = body;

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
      /^[a-zA-Z\s]+$/.test(candidate.name); // 純英文名

    if (isInvalidName) {
      return json({ success: false, skipped: true, message: `跳過無效名稱: ${candidate.name}` });
    }

    const electionId = await findOrCreateElection(supabaseService, election_year);
    const sourceNote = `AI搜尋匯入${candidate.note ? `: ${candidate.note}` : ""}`;

    // 多面向身份比對找人；模稜兩可不新增、進待審
    const ensured = await ensurePolitician(supabaseService, candidate, {
      source: `import-candidate:${user.id}`,
      extraInsert: { bio: candidate.current_position ? `現任${candidate.current_position}` : null },
    });
    if (ensured.politician_id === null) {
      return json({ success: true, ...ambiguousPayload(candidate.name, ensured.resolution) });
    }

    const participation = await upsertParticipation(supabaseService, {
      politician_id: ensured.politician_id,
      election_id: electionId,
      position: candidate.position,
      election_type: positionToElectionType(candidate.position),
      candidate_status: candidate.status || undefined,
      source_note: sourceNote,
    });

    if (participation.outcome === "updated") {
      return json({
        success: true,
        message: `已更新 ${candidate.name} 的參選狀態`,
        politician_id: ensured.politician_id,
        updated: true,
      });
    }

    return json({
      success: true,
      message: `成功匯入 ${candidate.name}`,
      politician_id: ensured.politician_id,
      politician_created: ensured.created,
      election_id: electionId,
    });

  } catch (error: any) {
    console.error("import-candidate error:", error);
    return json({ error: "Internal server error", message: error.message }, 500);
  }
});
