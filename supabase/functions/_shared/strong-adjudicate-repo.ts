/**
 * strong-adjudicate 的資料層（supabase 實作）。表 strong_adjudications 只有 service_role 能碰（migration 20261111180000）。
 */
import type { JobRow, JobStatus, Repo, UsageLog } from "./strong-adjudicate.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

export function supabaseRepo(supabase: SupabaseLike): Repo {
  return {
    async strongLaneList() {
      const { data, error } = await supabase.rpc("strong_lane_list");
      if (error) throw new Error(`strong_lane_list: ${error.message}`);
      return (data ?? {}) as Record<string, unknown>;
    },
    async jobsForTask(taskId, limit) {
      return (must(await supabase.from("strong_adjudications").select("*").eq("task_id", taskId).order("created_at", { ascending: false }).limit(limit), "jobsForTask") ?? []) as JobRow[];
    },
    async latestJobsByTask(taskIds) {
      if (taskIds.length === 0) return [];
      // query-bounds: ok — task_id 來自 strong_lane_list（上限 200 件），每件最多少數幾筆，另有 limit 1000
      return (must(await supabase.from("strong_adjudications").select("*").in("task_id", taskIds).order("created_at", { ascending: false }).limit(1000), "latestJobsByTask") ?? []) as JobRow[];
    },
    async insertJob(row) {
      const { data, error } = await supabase.from("strong_adjudications").insert({ ...row, status: "queued" }).select("*").maybeSingle();
      if (error) {
        if ((error as { code?: string }).code === "23505") return { row: null, conflict: true };
        throw new Error(`insertJob: ${error.message}`);
      }
      return { row: data as JobRow, conflict: false };
    },
    async getJob(id) {
      const { data, error } = await supabase.from("strong_adjudications").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(`getJob: ${error.message}`);
      return (data ?? null) as JobRow | null;
    },
    async transition(id, from: JobStatus[], patch) {
      const { data, error } = await supabase.from("strong_adjudications").update(patch).eq("id", id).in("status", from).select("*").maybeSingle();
      if (error) throw new Error(`transition: ${error.message}`);
      return (data ?? null) as JobRow | null;
    },
    async requeueStale({ runningCutoff, finalizingCutoff }) {
      const { error } = await supabase.from("strong_adjudications").update({ status: "queued", claimed_by: null, claimed_at: null }).eq("status", "running").lt("claimed_at", runningCutoff);
      if (error) throw new Error(`requeueStale: ${error.message}`);
      // finalizing 卡住（函式中途死掉）：回 previewed 讓維護者可再 finalize；若 /report 其實已收下，再送會被拒收、記 finalize_failed
      const fin = await supabase.from("strong_adjudications").update({ status: "previewed", last_error: "finalize 逾時沒有結果，已回到待送出；若 /report 其實已收下，再送會被拒收" }).eq("status", "finalizing").lt("updated_at", finalizingCutoff);
      if (fin.error) throw new Error(`requeueStale finalizing: ${fin.error.message}`);
    },
    async oldestQueued() {
      const { data, error } = await supabase.from("strong_adjudications").select("*").eq("status", "queued").order("created_at", { ascending: true }).limit(1);
      if (error) throw new Error(`oldestQueued: ${error.message}`);
      return ((data ?? []) as JobRow[])[0] ?? null;
    },
    async jobsSince(sinceIso, limit) {
      return (must(await supabase.from("strong_adjudications").select("*").gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(limit), "jobsSince") ?? []) as JobRow[];
    },
    async logUsage(u: UsageLog) {
      // ai_usage_logs.function_type 有 CHECK（verify／contribute／search／update），裁決算「驗證」；執行者回報的用量，端點不呼叫模型
      const { error } = await supabase.from("ai_usage_logs").insert({
        function_type: "verify", input_message: u.note, model_used: u.model,
        prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.prompt_tokens + u.completion_tokens,
        estimated_cost: Math.min(u.cost, 9999.999999), success: true,
      });
      if (error) throw new Error(`ai_usage_logs: ${error.message}`);
    },
  };
}
