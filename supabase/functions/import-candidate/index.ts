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

    // Check admin
    const userIsAdmin = await isAdmin(supabaseService, user.id);
    if (!userIsAdmin) {
      return new Response(
        JSON.stringify({ error: "Forbidden", message: "此功能僅限管理員使用" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body: ImportRequest = await req.json();
    const { election_year, candidate } = body;

    if (!election_year || !candidate?.name) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Find or create election for the year
    let { data: election } = await supabaseService
      .from("elections")
      .select("id")
      .gte("election_date", `${election_year}-01-01`)
      .lte("election_date", `${election_year}-12-31`)
      .single();

    if (!election) {
      // Create a placeholder election for this year
      const { data: newElection, error: electionError } = await supabaseService
        .from("elections")
        .insert({
          name: `${election_year}年地方公職人員選舉`,
          short_name: `${election_year}地方選舉`,
          start_date: `${election_year}-01-01`,
          end_date: `${election_year}-12-31`,
          election_date: `${election_year}-11-26`, // Placeholder date
        })
        .select("id")
        .single();

      if (electionError) {
        throw new Error(`Failed to create election: ${electionError.message}`);
      }
      election = newElection;
    }

    // Map party name to enum value
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

    // Find existing politician by name
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
          party: party,
          region: candidate.region,
          bio: candidate.current_position ? `現任${candidate.current_position}` : null,
        })
        .select("id")
        .single();

      if (politicianError) {
        throw new Error(`Failed to create politician: ${politicianError.message}`);
      }
      politician = newPolitician;
    }

    // Check if politician_election already exists
    const { data: existingPE } = await supabaseService
      .from("politician_elections")
      .select("id")
      .eq("politician_id", politician.id)
      .eq("election_id", election.id)
      .single();

    if (existingPE) {
      return new Response(
        JSON.stringify({
          success: false,
          message: `${candidate.name} 已存在於此選舉中`,
          politician_id: politician.id,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create politician_election record
    const { error: peError } = await supabaseService
      .from("politician_elections")
      .insert({
        politician_id: politician.id,
        election_id: election.id,
        position: candidate.position,
        election_type: mapPositionToType(candidate.position),
        candidate_status: candidate.status || "rumored",
        verified: false,
        source_note: `AI搜尋匯入${candidate.note ? `: ${candidate.note}` : ""}`,
      });

    if (peError) {
      throw new Error(`Failed to create politician_election: ${peError.message}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `成功匯入 ${candidate.name}`,
        politician_id: politician.id,
        election_id: election.id,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("import-candidate error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", message: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function mapPositionToType(position: string): string {
  if (position.includes("總統") || position.includes("副總統")) return "總統副總統";
  if (position.includes("立法委員") || position.includes("立委")) return "立法委員";
  if (position.includes("市長") || position.includes("縣長")) return "縣市長";
  if (position.includes("議員")) return "縣市議員";
  if (position.includes("鄉長") || position.includes("鎮長") || position.includes("區長")) return "鄉鎮市長";
  if (position.includes("代表")) return "鄉鎮市民代表";
  if (position.includes("村長") || position.includes("里長")) return "村里長";
  return "縣市長"; // Default
}
