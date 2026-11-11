import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { collectWindow, TtlCache, type CollectResult, type TraceRow } from "../_shared/trace-slices.ts";

/**
 * trace — /trace 重播頁的資料端點，公開唯讀、不驗 JWT（照 sources 的無金鑰公開端點慣例）。
 *
 * 為什麼有這支：瀏覽器（anon）直接呼叫 rpc/trace_events 會被匿名角色的 statement timeout 砍掉；
 * 這裡用 service_role 呼叫同一支函式（函式本身仍有 8 秒 timeout 當保險），並在伺服器端分段取、
 * 合併、某一段回滿 1000 列就自己再切（_shared/trace-slices.ts），全站模式快取 60 秒。
 * 回傳只有 trace_events() 本來就對外的欄位（事件時間、種類、任務、交件、人物、代理顯示名、少量摘要）。
 *
 * GET ?scope=all[&hours=4]                      全站近 N 小時（1～4，預設 4）
 * GET ?scope=task|contribution|person&id=…      指定對象近 14 天
 * GET ?probe=<uuid>                             這個 uuid 是任務、交件還是人物（依序問，有事件就停）
 * 回 {success, rows, truncated, partial, since, until}；函式還沒上線回 503 {success:false, error:"unavailable"}。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES = ["all", "task", "contribution", "person"] as const;
type Scope = typeof SCOPES[number];

const allCache = new TtlCache<{ body: unknown }>(60_000);

function json(body: unknown, status = 200, cacheSeconds = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
    },
  });
}

class UnavailableError extends Error {}

function isMissingFunction(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "PGRST202";
}

// deno-lint-ignore no-explicit-any
function makeFetcher(supabase: any, scope: Scope, id: string | null) {
  return async (since: number, until: number): Promise<TraceRow[]> => {
    const { data, error } = await supabase.rpc("trace_events", {
      p_task_id: scope === "task" ? id : null,
      p_contribution_id: scope === "contribution" ? id : null,
      p_politician_id: scope === "person" ? id : null,
      p_since: new Date(since).toISOString(),
      p_until: new Date(until).toISOString(),
      p_limit: 1000,
    });
    if (error) {
      if (isMissingFunction(error)) throw new UnavailableError("trace_events missing");
      throw error;
    }
    return (data ?? []) as TraceRow[];
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ success: false, error: "method_not_allowed" }, 405);
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const url = new URL(req.url);
    const now = Date.now();

    const probe = url.searchParams.get("probe");
    if (probe !== null) {
      if (!UUID_RE.test(probe)) return json({ success: false, error: "bad_id" }, 400);
      const id = probe.toLowerCase();
      for (const scope of ["task", "contribution", "person"] as const) {
        const { data, error } = await supabase.rpc("trace_events", {
          p_task_id: scope === "task" ? id : null,
          p_contribution_id: scope === "contribution" ? id : null,
          p_politician_id: scope === "person" ? id : null,
          p_since: new Date(now - 14 * DAY).toISOString(),
          p_until: new Date(now + 60_000).toISOString(),
          p_limit: 1,
        });
        if (error) {
          if (isMissingFunction(error)) return json({ success: false, error: "unavailable" }, 503);
          throw error;
        }
        if (Array.isArray(data) && data.length > 0) return json({ success: true, scope }, 200, 30);
      }
      return json({ success: true, scope: null }, 200, 30);
    }

    const scopeParam = (url.searchParams.get("scope") || "all") as Scope;
    if (!SCOPES.includes(scopeParam)) return json({ success: false, error: "bad_scope" }, 400);
    const id = url.searchParams.get("id");
    if (scopeParam !== "all") {
      if (!id || id.length > 200) return json({ success: false, error: "bad_id" }, 400);
      if (scopeParam !== "task" && !UUID_RE.test(id)) return json({ success: false, error: "bad_id" }, 400);
    }
    const hoursParam = Number(url.searchParams.get("hours") || "4");
    const hours = Number.isFinite(hoursParam) ? Math.min(4, Math.max(1, Math.floor(hoursParam))) : 4;

    const cacheKey = scopeParam === "all" ? `all:${hours}` : "";
    if (cacheKey) {
      const hit = allCache.get(cacheKey, now);
      if (hit) return json(hit.body, 200, 60);
    }

    const since = scopeParam === "all" ? now - hours * HOUR : now - 14 * DAY;
    const until = now + 60_000;
    const fetcher = makeFetcher(supabase, scopeParam, scopeParam === "all" ? null : (scopeParam === "task" ? id : id!.toLowerCase()));
    const result: CollectResult = await collectWindow(fetcher, since, until, {
      step: scopeParam === "all" ? HOUR / 2 : 3 * DAY,
      onError: (e, a, b) => {
        if (e instanceof UnavailableError) throw e;
        console.info("trace: slice failed", new Date(a).toISOString(), new Date(b).toISOString(), e);
      },
    });
    const body = { success: true, rows: result.rows, truncated: result.truncated, partial: result.partial, since, until };
    // 有一段取不到的結果不放快取（下一次再試）
    if (cacheKey && !result.partial) allCache.set(cacheKey, { body }, now);
    return json(body, 200, cacheKey && !result.partial ? 60 : 0);
  } catch (err) {
    if (err instanceof UnavailableError) return json({ success: false, error: "unavailable" }, 503);
    console.error("trace:", err);
    return json({ success: false, error: "failed" }, 500);
  }
});
