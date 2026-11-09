/**
 * GET /next?lane=strong 的本體（1.126.0）。從 next/index.ts 拆出來：/next 的守門測試要求主檔只讀佇列、contribution_tasks 只剩單筆查，
 * 強模型待辦是另一條明確認領的線，不在一般派工路徑上。授權只看鑰匙（x-strong-lane-key ＝ STRONG_LANE_KEY）；agent_tool 只記錄、不授權。
 */
import { taskTargetKey } from "./dispatch.ts";
import { buildStrongBrief, STRONG_LEASE_MINUTES, strongKeyFromRequest, type StrongVote } from "./strong-lane.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export interface StrongLaneCtx {
  supabase: SupabaseLike;
  req: Request;
  url: URL;
  agentName: string;
  agentTool: string | null;
  ipHash: string;
  base: Record<string, unknown>;
  tokenFor: (taskId: string) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  retryAfterMin: number;
}

export async function serveStrongLane(ctx: StrongLaneCtx): Promise<Response> {
  const { supabase, req, url, agentName, agentTool, ipHash, base, tokenFor, json, retryAfterMin: RETRY_AFTER_MIN } = ctx;
  {
  if (!strongKeyFromRequest(req, (k) => Deno.env.get(k))) {
    return json({ success: false, error: "strong_lane_key_required", message: "強模型待辦只給持有 STRONG_LANE_KEY 的人（維護者的 Opus 工作階段）：標頭 x-strong-lane-key。一般代理請照常 GET /next，不需要這條線" }, 403);
  }
  if (url.searchParams.get("list")) {
    const { data: listed, error: listErr } = await supabase.rpc("strong_lane_list");
    if (listErr) throw new Error(`strong_lane_list: ${listErr.message}`);
    return json({ ...base, kind: "strong_list", ...(listed as Record<string, unknown>) });
  }
  await supabase.rpc("contribution_task_leases_purge");
  // query-bounds: ok — 只有未過期的認領，同時在跑的人是個位數
  const { data: sLeaseRows, error: sLeaseErr } = await supabase.from("contribution_task_leases").select("task_id, agent_name").gt("leased_until", new Date().toISOString());
  if (sLeaseErr) throw new Error(`strong leases read: ${sLeaseErr.message}`);
  const sLeases = (sLeaseRows ?? []) as Array<{ task_id: string; agent_name: string }>;
  let sq = supabase.from("contribution_tasks").select("id, title, description, target, hint_sources, created_at")
    .eq("task_type", "adjudicate").eq("status", "open").eq("target->>requires_tier", "strong").order("created_at", { ascending: true }).limit(100);
  const wantId = url.searchParams.get("task_id");
  if (wantId) sq = sq.eq("id", wantId);
  const { data: sTasks, error: sErr } = await sq;
  if (sErr) throw new Error(`strong tasks read: ${sErr.message}`);
  for (const t of (sTasks ?? []) as Array<{ id: string; title: string; description: string | null; target: Record<string, unknown>; hint_sources: string[] | null; created_at: string }>) {
    if (sLeases.some((l) => l.task_id === t.id && l.agent_name.toLowerCase() !== agentName.toLowerCase())) continue;
    const origId = String(t.target?.contribution_id ?? "");
    const { data: orig, error: oErr } = await supabase.from("contributions")
      .select("id, contribution_type, payload, source_urls, agent_name, agent_tool, status, review_notes, agree_count, disagree_count, unsure_count").eq("id", origId).maybeSingle();
    if (oErr) throw new Error(`strong original read: ${oErr.message}`);
    if (orig && typeof orig.agent_name === "string" && orig.agent_name.toLowerCase() === agentName.toLowerCase()) continue; // 不裁決自己交的
    const { data: sVotes, error: svErr } = await supabase.from("contribution_votes")
      .select("verdict, agent_name, agent_tool, note, evidence_url, created_at").eq("contribution_id", origId).order("created_at", { ascending: true }).limit(100);
    if (svErr) throw new Error(`strong votes read: ${svErr.message}`);
    const { error: lErr } = await supabase.from("contribution_task_leases").upsert(
      { task_id: t.id, target_key: taskTargetKey({ task_id: t.id, target: t.target }), agent_name: agentName, ip_hash: ipHash, leased_until: new Date(Date.now() + STRONG_LEASE_MINUTES * 60 * 1000).toISOString() },
      { onConflict: "task_id" },
    );
    if (lErr) throw new Error(`strong lease upsert: ${lErr.message}`);
    // 稽核：誰（自報代號與模型）在什麼時候認領；只是紀錄，不是授權
    const claimedAt = new Date().toISOString();
    await supabase.from("contribution_tasks").update({ target: { ...t.target, claimed_by: agentName, claimed_tool: agentTool, claimed_at: claimedAt } }).eq("id", t.id);
    console.log(JSON.stringify({ event: "strong_lane_claim", agent_name: agentName, agent_tool: agentTool, task_id: t.id, contribution_id: origId }));
    return json({
      ...base, kind: "task", lane: "strong", lease_minutes: STRONG_LEASE_MINUTES, ...(await tokenFor(t.id)),
      item: buildStrongBrief(t, orig ?? null, (sVotes ?? []) as StrongVote[]),
      how_to: "照 item.instructions 查證後，POST /report（標頭 x-strong-lane-key）交 contribution_type=adjudication；你的一份裁決就是定案。認領 30 分鐘；做不了就不用理它，別人可再認領。",
    });
  }
  return json({ ...base, kind: "none", lane: "strong", reason: wantId ? "指定的強模型任務不存在、已結案、被別人認領中，或是你自己交的" : "目前沒有可認領的強模型待辦", retry_after_min: RETRY_AFTER_MIN });
  }
}
