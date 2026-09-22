import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ipHashOf } from "../_shared/contribute-handler.ts";
import { BOOST_FILTER_KEYS, BOOST_PER_IP_PER_HOUR, validateBoostFilter, validateBoostLabel } from "../_shared/boost-filter.ts";
import { PROTOCOL_URL, PROTOCOL_VERSION } from "../_shared/protocol.ts";

/**
 * boost — 插隊（2026-09-22，使用者裁示）。
 *
 * POST {label, filter, agent_name?}：符合 filter 的佇列項目（自動缺口、手動任務、待驗證貢獻）一次性排到最前；
 *   領走後回到時間軸，沒做完想再推就再打一次。無金鑰：條件是固定詞彙（_shared/boost-filter.ts 白名單），
 *   不能塞自由文字；同一個來源 IP 一小時最多 BOOST_PER_IP_PER_HOUR 次；誰插的、插了什麼都記在 task_boosts（公開可讀）。
 * GET：最近 20 次插隊與各自還剩多少沒領。
 *
 * 排序規則本身在 SQL（task_boost／task_boost_matches，migration 20260921000030）。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const USAGE = {
  post: "POST /boost {label:'六都 2026', filter:{regions:['台北市','新北市','桃園市','台中市','台南市','高雄市'], election_id:2026}, agent_name?}",
  filter_keys: BOOST_FILTER_KEYS,
  examples: [
    { label: "六都 2026 全部", filter: { regions: ["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市"], election_id: 2026 } },
    { label: "缺照片的人", filter: { missing_avatar: true, task_types: ["profile_gap"] } },
    { label: "2026 縣市長 政見", filter: { election_id: 2026, election_types: ["縣市長"], task_types: ["policy_missing"] } },
    { label: "只推驗證", filter: { regions: ["台南市"], kinds: ["verify"] } },
  ],
  docs: `${PROTOCOL_URL}#8-輔助端點`,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    if (req.method === "GET") {
      // query-bounds: ok — 最近 20 筆，有 order 有 limit
      const { data, error } = await supabase.from("task_boosts")
        .select("id, label, filter, agent_name, matched_tasks, matched_verifies, created_at")
        .order("id", { ascending: false }).limit(20);
      if (error) throw new Error(`task_boosts read: ${error.message}`);
      const rows = [];
      // 剩餘量要重算條件（掃全部缺口），只算最近 5 筆，其餘回 null
      for (const [i, b] of (data ?? []).entries()) {
        if (i >= 5) { rows.push({ ...b, remaining: null }); continue; }
        const { data: rem } = await supabase.rpc("task_boost_remaining", { p_id: b.id });
        rows.push({ ...b, remaining: rem ?? null });
      }
      return json({ success: true, protocol_version: PROTOCOL_VERSION, boosts: rows, usage: USAGE });
    }

    if (req.method !== "POST") return json({ success: false, error: "method_not_allowed", usage: USAGE }, 405);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ success: false, error: "body 要是 JSON 物件", usage: USAGE }, 400);
    const label = validateBoostLabel((body as Record<string, unknown>).label);
    if (!label.ok) return json({ success: false, error: label.error, usage: USAGE }, 400);
    const filter = validateBoostFilter((body as Record<string, unknown>).filter);
    if (!filter.ok) return json({ success: false, error: filter.error, usage: USAGE }, 400);
    const agentRaw = (body as Record<string, unknown>).agent_name;
    const agentName = typeof agentRaw === "string" && agentRaw.trim() ? agentRaw.trim().slice(0, 60) : null;

    const ipHash = await ipHashOf(req, Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl);
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: cErr } = await supabase.from("task_boosts").select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash).gte("created_at", since);
    if (cErr) throw new Error(`task_boosts count: ${cErr.message}`);
    if ((count ?? 0) >= BOOST_PER_IP_PER_HOUR) {
      return json({ success: false, error: "rate_limited", message: `同一個來源 IP 一小時最多插隊 ${BOOST_PER_IP_PER_HOUR} 次；插隊是一次性的，連按只會把別人的往後推` }, 429);
    }

    const { data, error } = await supabase.rpc("task_boost", { p_label: label.label, p_filter: filter.filter, p_agent: agentName, p_ip_hash: ipHash });
    if (error) throw new Error(`task_boost: ${error.message}`);
    const r = (data ?? {}) as Record<string, unknown>;
    return json({
      success: true,
      protocol_version: PROTOCOL_VERSION,
      boost: r,
      message: `已插隊：${r.matched_tasks ?? 0} 筆任務、${r.matched_verifies ?? 0} 筆驗證排到最前（一次性；領走後回到時間軸，要再推就再打一次）`,
      note: (r.matched_tasks ?? 0) === 0 && (r.matched_verifies ?? 0) === 0
        ? "沒有任何項目符合條件：檢查縣市名稱（台北市／臺北市要跟資料庫一致）、屆別、型別；GET /tasks 可以看目前的缺口型別"
        : undefined,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("boost error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
