import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ambiguousPayload, ensurePolitician, upsertParticipation } from "../_shared/candidate-import.ts";
import { normElectionType } from "../_shared/identity-normalize.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * 新增／更新政治人物（可一次多筆）。
 *
 * 舊版直接呼叫 RPC upsert_politician（同名＋同縣市視為同一人），換選區的人會被建成第二筆。
 * 現在先走多面向身份比對：
 *   matched   → 更新該人空白欄位 + 補參選紀錄
 *   new       → 建新人物 + 參選紀錄
 *   ambiguous → 不動，進 politician_identity_reviews
 */

interface IncomingPolitician {
  name: string;
  party?: string;
  status?: string;
  electionType?: string;
  position?: string;
  currentPosition?: string;
  region?: string;
  subRegion?: string;
  village?: string;
  birthYear?: number;
  educationLevel?: string;
  avatarUrl?: string;
  slogan?: string;
  electionId?: number;
  /** 中選會 cand_id（AdminScraper 官方匯入帶入，寫成強面向 key） */
  cecCandId?: number | string;
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const politicians: IncomingPolitician[] = body.politicians || (body.politician ? [body.politician] : []);
    const defaultElectionId: number = body.electionId || 1;

    const results = {
      added: 0,
      updated: 0,
      ambiguous: 0,
      failed: 0,
      errors: [] as string[],
      ambiguous_details: [] as unknown[],
    };

    for (const p of politicians) {
      try {
        const electionType = normElectionType(p.electionType) ?? normElectionType(p.position);
        const ensured = await ensurePolitician(supabase, {
          name: p.name,
          party: p.party,
          region: p.region,
          election_type: electionType,
          position: p.position,
          current_position: p.currentPosition,
          birth_year: p.birthYear,
          cec_cand_id: p.cecCandId,
        }, {
          source: "add-politician",
          extraInsert: compact({
            status: p.status || "politician",
            election_type: electionType,
            sub_region: p.subRegion,
            village: p.village,
            education_level: p.educationLevel,
            avatar_url: p.avatarUrl,
            slogan: p.slogan,
          }),
        });

        if (ensured.politician_id === null) {
          results.ambiguous++;
          results.ambiguous_details.push(ambiguousPayload(p.name, ensured.resolution));
          continue;
        }

        if (!ensured.created) {
          // 既有人物只補資料，不覆蓋姓名／出生年
          const patch = compact({
            party: p.party,
            current_position: p.currentPosition,
            sub_region: p.subRegion,
            village: p.village,
            education_level: p.educationLevel,
            avatar_url: p.avatarUrl,
            slogan: p.slogan,
          });
          if (Object.keys(patch).length > 0) {
            const { error } = await supabase.from("politicians").update(patch).eq("id", ensured.politician_id);
            if (error) throw new Error(`politicians update: ${error.message}`);
          }
        }

        await upsertParticipation(supabase, {
          politician_id: ensured.politician_id,
          election_id: p.electionId || defaultElectionId,
          position: p.position,
          election_type: electionType ?? undefined,
          candidate_status: "confirmed",
          source_note: "add-politician",
          insertOnly: compact({ slogan: p.slogan }),
        });

        if (ensured.created) results.added++;
        else results.updated++;
      } catch (error: any) {
        results.failed++;
        results.errors.push(`${p.name}: ${error.message}`);
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
