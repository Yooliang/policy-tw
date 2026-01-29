import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface PolicyInput {
  politicianId?: number;
  politicianName?: string; // Alternative: lookup by name
  electionId?: number; // Election this policy belongs to
  title: string;
  description: string;
  category: string;
  status?: string;
  proposedDate?: string;
  tags?: string[];
  supportCount?: number;
  trackingLog?: {
    event: string;
    description?: string;
  };
}

interface RequestBody {
  policy?: PolicyInput;
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

    // Support both single policy and batch
    const policyInputs = body.policies || (body.policy ? [body.policy] : []);

    if (policyInputs.length === 0) {
      return new Response(
        JSON.stringify({ error: "No policy data provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const results: any[] = [];
    const errors: any[] = [];

    for (const input of policyInputs) {
      // Resolve politician ID
      let politicianId = input.politicianId;

      if (!politicianId && input.politicianName) {
        const { data: politician } = await supabase
          .from("politicians")
          .select("id")
          .eq("name", input.politicianName)
          .single();

        if (politician) {
          politicianId = politician.id;
        }
      }

      if (!politicianId) {
        errors.push({
          title: input.title,
          error: "Could not resolve politician ID. Provide politicianId or valid politicianName."
        });
        continue;
      }

      // Validate required fields
      if (!input.title || !input.description || !input.category) {
        errors.push({
          title: input.title || "(no title)",
          error: "Missing required fields: title, description, category"
        });
        continue;
      }

      // Insert policy
      const { data: policyData, error: policyError } = await supabase
        .from("policies")
        .insert({
          politician_id: politicianId,
          election_id: input.electionId || null,
          title: input.title,
          description: input.description,
          category: input.category,
          status: input.status || "Campaign Pledge",
          proposed_date: input.proposedDate || today,
          last_updated: input.proposedDate || today,
          progress: 0,
          tags: input.tags || [],
          support_count: input.supportCount || 0,
        })
        .select()
        .single();

      if (policyError) {
        errors.push({
          title: input.title,
          error: policyError.message
        });
        continue;
      }

      // Add tracking log if provided
      if (input.trackingLog && policyData) {
        await supabase.from("tracking_logs").insert({
          policy_id: policyData.id,
          date: input.proposedDate || today,
          event: input.trackingLog.event,
          description: input.trackingLog.description,
        });
      }

      results.push(policyData);
    }

    return new Response(
      JSON.stringify({
        success: errors.length === 0,
        created: results.length,
        failed: errors.length,
        policies: results,
        errors: errors.length > 0 ? errors : undefined,
        message: `Created ${results.length} policies${errors.length > 0 ? `, ${errors.length} failed` : ""}`,
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

# 單一政見（使用 politicianId）
curl -X POST 'https://<project-ref>.supabase.co/functions/v1/add-policy' \
  -H 'Authorization: Bearer <anon-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "policy": {
      "politicianId": 1,
      "title": "推動綠能發展",
      "description": "在台北市推動太陽能與風力發電",
      "category": "Environment",
      "proposedDate": "2026-01-28",
      "tags": ["綠能", "環保", "永續"],
      "supportCount": 5000,
      "trackingLog": {
        "event": "政見發布",
        "description": "於記者會正式宣布"
      }
    }
  }'

# 單一政見（使用 politicianName）
curl -X POST 'https://<project-ref>.supabase.co/functions/v1/add-policy' \
  -H 'Authorization: Bearer <anon-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "policy": {
      "politicianName": "吳怡農",
      "title": "青年住宅政策",
      "description": "推動台北市青年住宅興建計畫",
      "category": "Welfare",
      "tags": ["青年", "住宅", "居住正義"]
    }
  }'

# 批次新增多筆政見
curl -X POST 'https://<project-ref>.supabase.co/functions/v1/add-policy' \
  -H 'Authorization: Bearer <anon-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "policies": [
      {
        "politicianName": "蘇巧慧",
        "title": "政見一",
        "description": "描述一",
        "category": "Economy"
      },
      {
        "politicianName": "蘇巧慧",
        "title": "政見二",
        "description": "描述二",
        "category": "Traffic"
      }
    ]
  }'

*/
