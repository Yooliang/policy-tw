import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};


// 這支端點原本沒有任何程式碼層的授權檢查，只靠平台的 verify_jwt，
// 等於任何登入帳號都能呼叫。守衛照 batch-import-candidates 的同一套。
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

interface MergeRequest {
  name: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const denied = await requireAdmin(req, supabase);
    if (denied) return denied;

    // 停用中。這支的合併條件只有「姓名完全相同」，而同名不同人是真實存在的
    // （測試裡就有「彰化立委 vs 宜蘭村里長」這種案例），它會把兩個不同的人
    // 併成一個；而且第 2 步是真的 DELETE，不寫 edit_history，刪掉救不回來。
    // 重新設計成可逆（保留被合併的那一筆並標重導向）之前不開放。
    // 設計見 docs/BLUEPRINT-admin-to-tasks.md。
    return new Response(JSON.stringify({
      success: false,
      error: "disabled",
      message: "合併功能已停用：舊版只比對姓名，會把同名的不同人併成一個，而且是不可逆的刪除。重新設計成可逆之前不開放。",
    }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { name } = await req.json() as MergeRequest;

    if (!name) {
      return new Response(JSON.stringify({ error: "Missing name" }), { status: 400, headers: corsHeaders });
    }

    console.log(`正在合併人員: ${name}`);

    // 1. 取得所有同名的人
    const { data: list, error: fetchError } = await supabase
      .from("politicians")
      .select("*")
      .eq("name", name);

    if (fetchError) throw fetchError;
    if (!list || list.length <= 1) {
      return new Response(JSON.stringify({ success: true, message: "無須合併" }), { headers: corsHeaders });
    }

    // 2. 智慧排序邏輯
    // 優先保留：有出生年 > 選區完整 (不是"第XX選區") > ID 較小
    const sorted = [...list].sort((a, b) => {
      if (a.birth_year && !b.birth_year) return -1;
      if (!a.birth_year && b.birth_year) return 1;
      
      const aHasGoodRegion = a.region && !a.region.includes('選區');
      const bHasGoodRegion = b.region && !b.region.includes('選區');
      if (aHasGoodRegion && !bHasGoodRegion) return -1;
      if (!aHasGoodRegion && bHasGoodRegion) return 1;
      
      return 0;
    });

    const toKeep = sorted[0];
    const toDelete = sorted.slice(1);
    const results = { deleted: 0, updatedAssociations: 0 };

    for (const p of toDelete) {
      // 3. 轉移關聯 (Policies & Elections)
      const { count: polCount } = await supabase.from('policies').update({ politician_id: toKeep.id }).eq('politician_id', p.id);
      const { count: elecCount } = await supabase.from('politician_elections').update({ politician_id: toKeep.id }).eq('politician_id', p.id);
      
      // 4. 補全資料到保留項
      const patch: any = {};
      if (!toKeep.birth_year && p.birth_year) patch.birth_year = p.birth_year;
      if (!toKeep.education_level && p.education_level) patch.education_level = p.education_level;
      if (!toKeep.avatar_url && p.avatar_url) patch.avatar_url = p.avatar_url;
      if (!toKeep.sub_region && p.sub_region) patch.sub_region = p.sub_region;
      
      if (Object.keys(patch).length > 0) {
          await supabase.from('politicians').update(patch).eq('id', toKeep.id);
      }

      // 5. 刪除重複項
      const { error: delError } = await supabase.from('politicians').delete().eq('id', p.id);
      if (!delError) {
        results.deleted++;
        results.updatedAssociations += (polCount || 0) + (elecCount || 0);
      }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      message: `合併完成：刪除 ${results.deleted} 筆，轉移 ${results.updatedAssociations} 個關聯。`,
      results 
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
});
