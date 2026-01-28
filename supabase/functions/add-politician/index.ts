import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface PoliticianInput {
  name: string;
  party: "國民黨" | "民進黨" | "民眾黨" | "無黨籍";
  status?: "incumbent" | "politician" | "potential" | "former";
  electionType?: string;
  position: string;
  region: string;
  subRegion?: string;
  avatarUrl?: string;
  slogan?: string;
  bio?: string;
  education?: string[];
  experience?: string[];
  electionIds?: number[];
}

interface PolicyInput {
  title: string;
  description: string;
  category: string;
  status?: string;
  proposedDate: string;
  tags?: string[];
  supportCount?: number;
}

interface RequestBody {
  politician: PoliticianInput;
  policies?: PolicyInput[];
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: RequestBody = await req.json();
    const { politician, policies } = body;

    // Validate required fields
    if (!politician?.name || !politician?.party || !politician?.position || !politician?.region) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: name, party, position, region" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Insert politician
    const { data: politicianData, error: politicianError } = await supabase
      .from("politicians")
      .insert({
        name: politician.name,
        party: politician.party,
        status: politician.status || "politician",
        election_type: politician.electionType || "縣市長",
        position: politician.position,
        region: politician.region,
        sub_region: politician.subRegion,
        avatar_url: politician.avatarUrl,
        slogan: politician.slogan,
        bio: politician.bio,
        education: politician.education,
        experience: politician.experience,
      })
      .select()
      .single();

    if (politicianError) {
      return new Response(
        JSON.stringify({ error: politicianError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const politicianId = politicianData.id;

    // Link to elections if provided
    if (politician.electionIds?.length) {
      const electionLinks = politician.electionIds.map((electionId) => ({
        politician_id: politicianId,
        election_id: electionId,
      }));
      await supabase.from("politician_elections").insert(electionLinks);
    } else {
      // Default: link to 2026 election (id=1)
      await supabase.from("politician_elections").insert({
        politician_id: politicianId,
        election_id: 1,
      });
    }

    // Insert policies if provided
    let insertedPolicies: any[] = [];
    if (policies?.length) {
      const today = new Date().toISOString().slice(0, 10);
      const policyRows = policies.map((p) => ({
        politician_id: politicianId,
        title: p.title,
        description: p.description,
        category: p.category,
        status: p.status || "Campaign Pledge",
        proposed_date: p.proposedDate || today,
        last_updated: p.proposedDate || today,
        progress: 0,
        tags: p.tags || [],
        support_count: p.supportCount || 0,
      }));

      const { data: policyData, error: policyError } = await supabase
        .from("policies")
        .insert(policyRows)
        .select();

      if (policyError) {
        return new Response(
          JSON.stringify({
            error: policyError.message,
            politicianId,
            message: "Politician created but policies failed"
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      insertedPolicies = policyData || [];
    }

    return new Response(
      JSON.stringify({
        success: true,
        politician: politicianData,
        policies: insertedPolicies,
        message: `Created politician "${politician.name}" with ${insertedPolicies.length} policies`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

/* 使用範例:

curl -i --location --request POST 'https://<project-ref>.supabase.co/functions/v1/add-politician' \
  --header 'Authorization: Bearer <anon-key>' \
  --header 'Content-Type: application/json' \
  --data '{
    "politician": {
      "name": "王小明",
      "party": "民進黨",
      "status": "politician",
      "position": "立法委員",
      "region": "台北市",
      "avatarUrl": "https://example.com/avatar.jpg"
    },
    "policies": [
      {
        "title": "推動綠能發展",
        "description": "在台北市推動太陽能與風力發電",
        "category": "Environment",
        "proposedDate": "2026-01-28",
        "tags": ["綠能", "環保", "永續"],
        "supportCount": 5000
      }
    ]
  }'

*/
