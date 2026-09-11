import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ensurePolitician, findOrCreateElection, upsertParticipation } from "../_shared/candidate-import.ts";
import { normElectionType } from "../_shared/identity-normalize.ts";

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

// Admin check
async function isAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`user_profiles lookup: ${error.message}`);
  return data?.is_admin === true;
}

interface CandidateData {
  name: string;
  region: string;
  party?: string;
  birth_year?: number;
  gender?: string;
  votes?: number;
  elected?: boolean;
}

interface ImportRequest {
  election_year: number;
  election_type: string;
  data_source: string;
  candidates: CandidateData[];
}

// 官方資料（中選會）的政黨名照原樣保留，只把常見簡稱正規化
const partyMap: Record<string, string> = {
  "中國國民黨": "中國國民黨",
  "國民黨": "中國國民黨",
  "民主進步黨": "民主進步黨",
  "民進黨": "民主進步黨",
  "台灣民眾黨": "台灣民眾黨",
  "民眾黨": "台灣民眾黨",
  "無黨籍": "無黨籍",
  "無": "無黨籍",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return json({ error: "Authentication required" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseService.auth.getUser(token);

    if (authError || !user) {
      return json({ error: "Authentication required" }, 401);
    }

    // Admin check
    const userIsAdmin = await isAdmin(supabaseService, user.id);
    if (!userIsAdmin) {
      return json({ error: "Forbidden", message: "此功能僅限管理員使用" }, 403);
    }

    const body: ImportRequest = await req.json();
    const { election_year, election_type, data_source, candidates } = body;

    if (!election_year || !candidates?.length) {
      return json({ error: "Missing required fields" }, 400);
    }

    const electionId = await findOrCreateElection(supabaseService, election_year);
    const normalizedType = normElectionType(election_type) ?? "縣市長";

    let success = 0;
    let failed = 0;
    let skipped = 0;
    let ambiguous = 0;
    const importedNames: string[] = [];
    const ambiguousNames: string[] = [];
    const errors: string[] = [];

    for (const candidate of candidates) {
      try {
        const party = partyMap[candidate.party || ""] || candidate.party || "無黨籍";

        // 多面向身份比對（官方資料帶出生年，birth 是強面向）
        const ensured = await ensurePolitician(supabaseService, {
          name: candidate.name,
          party,
          region: candidate.region,
          election_type: normalizedType,
          position: election_type,
          birth_year: candidate.birth_year,
        }, {
          source: `batch-import:${data_source}`,
          extraInsert: { gender: candidate.gender ?? null },
        });

        if (ensured.politician_id === null) {
          ambiguous++;
          ambiguousNames.push(candidate.name);
          continue;
        }

        // 既有人物補空的出生年（欄位是 birth_year，不是 birthYear）
        if (!ensured.created && candidate.birth_year) {
          const { error: birthError } = await supabaseService
            .from("politicians")
            .update({ birth_year: candidate.birth_year })
            .eq("id", ensured.politician_id)
            .is("birth_year", null);
          if (birthError) throw new Error(`politicians birth_year update: ${birthError.message}`);
        }

        const verifiedFields = {
          votes_received: candidate.votes,
          election_result: candidate.elected ? "elected" : "not_elected",
          verified: true,
          verified_at: new Date().toISOString(),
          verified_by: user.id,
          source_note: data_source,
        };

        const participation = await upsertParticipation(supabaseService, {
          politician_id: ensured.politician_id,
          election_id: electionId,
          position: election_type,
          election_type: normalizedType,
          candidate_status: "confirmed",
          source_note: data_source,
          always: verifiedFields,
        });

        if (participation.outcome === "updated") {
          skipped++;
          continue;
        }

        success++;
        importedNames.push(candidate.name);

      } catch (err: any) {
        errors.push(`${candidate.name}: ${err.message}`);
        failed++;
      }
    }

    return json({
      success,
      failed,
      skipped,
      ambiguous,
      imported_names: importedNames,
      ambiguous_names: ambiguousNames.slice(0, 20),
      errors: errors.slice(0, 10), // Limit errors in response
    });

  } catch (error: any) {
    console.error("batch-import error:", error);
    return json({ error: "Internal server error", message: error.message }, 500);
  }
});
