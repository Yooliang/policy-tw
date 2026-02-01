import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch recent prompts
    const { data: prompts, error: fetchError } = await supabaseService
      .from("ai_prompts")
      .select(`
        id,
        task_type,
        status,
        priority,
        parameters,
        started_at,
        completed_at,
        result_summary,
        error_message,
        created_at
      `)
      .order("created_at", { ascending: false })
      .limit(10);

    if (fetchError) {
      throw new Error(`Failed to fetch prompts: ${fetchError.message}`);
    }

    return new Response(JSON.stringify({ success: true, prompts }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("debug-prompts error:", error);

    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
