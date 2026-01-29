import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface PoliticianInput {
  name: string;
  party: string;
  status?: "incumbent" | "politician" | "potential" | "former";
  electionType?: string;
  position: string;
  region: string;
  subRegion?: string;
  birthYear?: number;
  educationLevel?: string;
  electionId?: number; // 指定要關聯的選舉 ID
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const inputList = body.politicians || (body.politician ? [body.politician] : []);
    const defaultElectionId = body.electionId || 2026; // 預設 2026

    const results = { added: 0, updated: 0, exists: 0, failed: 0, errors: [] as string[] };

    for (const p of inputList) {
      try {
        const targetElectionId = p.electionId || defaultElectionId;

        // 1. 查找同名人員
        const { data: candidates } = await supabase
          .from("politicians")
          .select("*")
          .eq("name", p.name);

        let existing = null;
        if (candidates && candidates.length > 0) {
          if (p.birthYear) {
            existing = candidates.find(c => c.birth_year === p.birthYear) || 
                       candidates.find(c => c.birth_year === null);
          } else {
            existing = candidates[0];
          }
        }

        if (existing) {
          // 如果找到了，且原本出生年為空，則更新它
          if (!existing.birth_year && p.birthYear) {
            await supabase.from("politicians")
              .update({ 
                birth_year: p.birthYear, 
                education_level: p.educationLevel || existing.education_level,
                sub_region: p.subRegion || existing.sub_region
              })
              .eq("id", existing.id);
            results.updated++;
          } else {
            results.exists++;
          }
          
          // 確保有關聯到該選舉
          await supabase.from("politician_elections").upsert({
            politician_id: existing.id,
            election_id: targetElectionId,
          }, { onConflict: 'politician_id,election_id' });

          continue;
        }

        // 2. 真正的新增
        const { data, error } = await supabase
          .from("politicians")
          .insert({
            name: p.name,
            party: p.party || "無黨籍",
            status: p.status || "politician",
            election_type: p.electionType || "其他",
            position: p.position || "",
            region: p.region || "未知",
            sub_region: p.subRegion || null,
            birth_year: p.birthYear || null,
            education_level: p.educationLevel || null
          })
          .select()
          .single();

        if (error) throw error;

        // 3. 關聯選舉
        await supabase.from("politician_elections").insert({
          politician_id: data.id,
          election_id: targetElectionId,
        });
        
        results.added++;
      } catch (e: any) {
        results.failed++;
        results.errors.push(`${p.name}: ${e.message}`);
      }
    }

    return new Response(JSON.stringify({ success: true, ...results }), { 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
});
