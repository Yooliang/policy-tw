import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface AvatarUpdate {
  name: string;
  avatarUrl: string;
}

interface RequestBody {
  updates: AvatarUpdate[];
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
    const { updates } = body;

    if (!updates?.length) {
      return new Response(
        JSON.stringify({ error: "Missing updates array" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: { name: string; success: boolean; error?: string }[] = [];

    for (const update of updates) {
      if (!update.name || !update.avatarUrl) {
        results.push({ name: update.name || "unknown", success: false, error: "Missing name or avatarUrl" });
        continue;
      }

      const { error } = await supabase
        .from("politicians")
        .update({ avatar_url: update.avatarUrl })
        .eq("name", update.name);

      if (error) {
        results.push({ name: update.name, success: false, error: error.message });
      } else {
        results.push({ name: update.name, success: true });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return new Response(
      JSON.stringify({
        success: failCount === 0,
        message: `Updated ${successCount} politicians, ${failCount} failed`,
        results,
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

curl -i --location --request POST 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/update-avatar' \
  --header 'Authorization: Bearer <anon-key>' \
  --header 'Content-Type: application/json' \
  --data '{
    "updates": [
      {
        "name": "李四川",
        "avatarUrl": "https://upload.wikimedia.org/wikipedia/commons/thumb/9/94/Lee_Shu-chuan_2023.jpg/220px-Lee_Shu-chuan_2023.jpg"
      },
      {
        "name": "童子瑋",
        "avatarUrl": "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f4/童子瑋議長.jpg/220px-童子瑋議長.jpg"
      }
    ]
  }'

*/
