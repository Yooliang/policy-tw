import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const politicians = body.politicians || (body.politician ? [body.politician] : []);
    const defaultElectionId = body.electionId || 1;

    const results = { added: 0, updated: 0, exists: 0, failed: 0, errors: [] as string[] };

    for (const p of politicians) {
      const { data, error } = await supabase.rpc('upsert_politician', {
        p_name: p.name,
        p_party: p.party || "無黨籍",
        p_status: p.status || "politician",
        p_election_type: p.electionType || "其他",
        p_position: p.position || "",
        p_current_position: p.currentPosition || null,
        p_region: p.region || "未知",
        p_sub_region: p.subRegion || null,
        p_village: p.village || null,
        p_birth_year: p.birthYear || null,
        p_education_level: p.educationLevel || null,
        p_avatar_url: p.avatarUrl || null,
        p_slogan: p.slogan || null,
        p_election_id: p.electionId || defaultElectionId
      });

      if (error) {
        results.failed++;
        results.errors.push(`${p.name}: ${error.message}`);
      } else if (data === 'inserted') {
        results.added++;
      } else if (data === 'updated') {
        results.updated++;
      } else {
        results.exists++;
      }
    }

    return new Response(JSON.stringify({ success: true, ...results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
