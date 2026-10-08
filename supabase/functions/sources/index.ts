import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchVerificationSources, queryVerificationSources, sourcesToMarkdown } from "../_shared/verification-sources.ts";

/**
 * sources — 查證來源清單（政黨／議會／政府／中選會官網），公開唯讀、無金鑰。
 * 見 docs/DECISIONS.md 2026-09-28：代理常只查媒體首頁就回「查無」，這支端點把政黨官網、
 * 議會官網等其實查得到照片、學經歷、選區、政見的來源攤出來給人看、也給代理讀。
 *
 * GET ?party=&region=&election_type=&election_id=&need=photo,policy&format=json|md（預設 json）
 *   比對規則：party 相符或 null（不分政黨）、regions 包含 region 或 null（全國）、
 *             election_types 包含 election_type 或 null（全部）、election_ids 包含 election_id 或 null（每一屆）、
 *             need 有交集（沒給 need 就全回）
 *   status=down 的排最後（沿用 verification-sources.ts 的排序）。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

function markdown(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const url = new URL(req.url);
    const party = url.searchParams.get("party") || null;
    const region = url.searchParams.get("region") || null;
    const electionType = url.searchParams.get("election_type") || null;
    const needParam = url.searchParams.get("need");
    const need = needParam ? needParam.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const format = (url.searchParams.get("format") || "json").toLowerCase();
    // 屆別（elections.id，整數；2026-10-09）：沒給或不是整數就不篩。來源有填 election_ids 的（例如應選名額的選舉公告）才靠它分屆
    const electionIdParam = url.searchParams.get("election_id");
    const electionId = electionIdParam && /^\d+$/.test(electionIdParam) ? Number(electionIdParam) : null;

    const all = await fetchVerificationSources(supabase);
    const matched = queryVerificationSources(all, { party, region, electionType, electionId, need });

    if (format === "md" || format === "markdown") return markdown(sourcesToMarkdown(matched));
    return json({ success: true, total: matched.length, sources: matched });
  } catch (err) {
    console.error("sources:", err);
    return json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
