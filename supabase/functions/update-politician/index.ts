import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};


// 這支端點原本沒有任何程式碼層的授權檢查，只靠平台的 verify_jwt，
// 等於任何登入帳號都能覆寫政治人物資料。守衛照 batch-import-candidates 的同一套。
async function isAdmin(supabase: ReturnType<typeof createClient>, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from("user_profiles").select("is_admin").eq("id", userId).maybeSingle();
  if (error) throw new Error(`user_profiles lookup: ${error.message}`);
  return (data as { is_admin?: boolean } | null)?.is_admin === true;
}

async function requireAdmin(req: Request, supabase: ReturnType<typeof createClient>): Promise<Response | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { data: { user }, error } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (error || !user || !(await isAdmin(supabase, user.id))) {
    return new Response(JSON.stringify({ error: "Forbidden", message: "此功能僅限管理員使用" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return null;
}

interface PoliticianUpdate {
  id?: string; // Changed to string for UUID
  name?: string; // Used if id is not provided
  party?: string;
  status?: "incumbent" | "politician" | "potential" | "former";
  electionType?: string;
  position?: string;
  region?: string;
  subRegion?: string;
  avatarUrl?: string;
  slogan?: string;
  bio?: string;
  education?: string[];
  experience?: string[];
  birthYear?: number;
  educationLevel?: string;
}

interface RequestBody {
  update: PoliticianUpdate;
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

    const denied = await requireAdmin(req, supabase);
    if (denied) return denied;

    const body: RequestBody = await req.json();
    const { update } = body;

    if (!update) {
      return new Response(
        JSON.stringify({ error: "Missing update object" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!update.id && !update.name) {
      return new Response(
        JSON.stringify({ error: "Missing politician identifier (id or name)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Map camelCase to snake_case for DB
    const dbUpdate: any = {};
    if (update.party !== undefined) dbUpdate.party = update.party;
    if (update.status !== undefined) dbUpdate.status = update.status;
    if (update.electionType !== undefined) dbUpdate.election_type = update.electionType;
    if (update.position !== undefined) dbUpdate.position = update.position;
    if (update.region !== undefined) dbUpdate.region = update.region;
    if (update.subRegion !== undefined) dbUpdate.sub_region = update.subRegion;
    if (update.avatarUrl !== undefined) dbUpdate.avatar_url = update.avatarUrl;
    if (update.slogan !== undefined) dbUpdate.slogan = update.slogan;
    if (update.bio !== undefined) dbUpdate.bio = update.bio;
    if (update.education !== undefined) dbUpdate.education = update.education;
    if (update.experience !== undefined) dbUpdate.experience = update.experience;
    if (update.birthYear !== undefined) dbUpdate.birth_year = update.birthYear;
    if (update.educationLevel !== undefined) dbUpdate.education_level = update.educationLevel;

    let query = supabase.from("politicians").update(dbUpdate);
    
    if (update.id) {
      query = query.eq("id", update.id);
    } else {
      query = query.eq("name", update.name);
    }

    const { data, error } = await query.select().single();

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Updated politician "${data.name}" (ID: ${data.id})`,
        politician: data,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
