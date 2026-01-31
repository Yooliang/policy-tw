import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Admin check
async function isAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("user_profiles")
    .select("is_admin")
    .eq("id", userId)
    .single();
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

// Map party names to standard format
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
  "台灣團結聯盟": "台灣團結聯盟",
  "親民黨": "親民黨",
  "新黨": "新黨",
  "綠黨": "綠黨",
  "社會民主黨": "社會民主黨",
  "台灣維新": "台灣維新",
};

// Map election type to enum
function mapElectionType(type: string): string {
  const typeMap: Record<string, string> = {
    "縣市長": "縣市長",
    "縣市議員": "縣市議員",
    "立法委員": "立法委員",
    "鄉鎮市長": "鄉鎮市長",
    "村里長": "村里長",
    "總統副總統": "總統副總統",
  };
  return typeMap[type] || "縣市長";
}

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
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseService.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Admin check
    const userIsAdmin = await isAdmin(supabaseService, user.id);
    if (!userIsAdmin) {
      return new Response(
        JSON.stringify({ error: "Forbidden", message: "此功能僅限管理員使用" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body: ImportRequest = await req.json();
    const { election_year, election_type, data_source, candidates } = body;

    if (!election_year || !candidates?.length) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Find or create election
    let { data: election } = await supabaseService
      .from("elections")
      .select("id")
      .gte("election_date", `${election_year}-01-01`)
      .lte("election_date", `${election_year}-12-31`)
      .single();

    if (!election) {
      const { data: newElection, error: electionError } = await supabaseService
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

      if (electionError) throw new Error(`Failed to create election: ${electionError.message}`);
      election = newElection;
    }

    let success = 0;
    let failed = 0;
    let skipped = 0;
    const importedNames: string[] = [];
    const errors: string[] = [];

    for (const candidate of candidates) {
      try {
        // Normalize party
        const party = partyMap[candidate.party || ""] || candidate.party || "無黨籍";

        // Find or create politician
        let { data: politician } = await supabaseService
          .from("politicians")
          .select("id")
          .eq("name", candidate.name)
          .single();

        if (!politician) {
          // Create new politician
          const { data: newPolitician, error: politicianError } = await supabaseService
            .from("politicians")
            .insert({
              name: candidate.name,
              party,
              region: candidate.region,
              birthYear: candidate.birth_year,
              gender: candidate.gender,
            })
            .select("id")
            .single();

          if (politicianError) {
            errors.push(`${candidate.name}: ${politicianError.message}`);
            failed++;
            continue;
          }
          politician = newPolitician;
        } else {
          // Update birth year if missing
          if (candidate.birth_year) {
            await supabaseService
              .from("politicians")
              .update({ birthYear: candidate.birth_year })
              .eq("id", politician.id)
              .is("birthYear", null);
          }
        }

        // Check if politician_election exists
        const { data: existingPE } = await supabaseService
          .from("politician_elections")
          .select("id")
          .eq("politician_id", politician.id)
          .eq("election_id", election.id)
          .single();

        if (existingPE) {
          // Update existing record
          await supabaseService
            .from("politician_elections")
            .update({
              votes_received: candidate.votes,
              election_result: candidate.elected ? "elected" : "not_elected",
              verified: true,
              verified_at: new Date().toISOString(),
              verified_by: user.id,
              source_note: data_source,
            })
            .eq("id", existingPE.id);

          skipped++;
          continue;
        }

        // Create politician_election record
        const { error: peError } = await supabaseService
          .from("politician_elections")
          .insert({
            politician_id: politician.id,
            election_id: election.id,
            position: election_type,
            election_type: mapElectionType(election_type),
            votes_received: candidate.votes,
            election_result: candidate.elected ? "elected" : "not_elected",
            candidate_status: "confirmed",
            verified: true,
            verified_at: new Date().toISOString(),
            verified_by: user.id,
            source_note: data_source,
          });

        if (peError) {
          errors.push(`${candidate.name}: ${peError.message}`);
          failed++;
          continue;
        }

        success++;
        importedNames.push(candidate.name);

      } catch (err: any) {
        errors.push(`${candidate.name}: ${err.message}`);
        failed++;
      }
    }

    return new Response(
      JSON.stringify({
        success,
        failed,
        skipped,
        imported_names: importedNames,
        errors: errors.slice(0, 10), // Limit errors in response
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("batch-import error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", message: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
