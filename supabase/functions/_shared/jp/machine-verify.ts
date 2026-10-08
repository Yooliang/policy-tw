/**
 * 日本站的機器核對（照正見 cec-verify）：有權威資料可查的交件，交進來就跟官方的表比，對得上直接落庫。
 *
 * 目前一種：local_government ↔ 總務省「全国地方公共団体コード」（SQL policy_jp.lg_registry_verify_pending，
 * migration 20261009210200；pg_cron 每 10 分鐘也會掃，這裡是交件當下就先跑一次，代理馬上看得到結果）。
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/** 機器核對的審核者（contributions.reviewed_by），SQL 那邊寫死同一個字 */
export const JP_MACHINE_REVIEWERS = ["soumu-auto"] as const;
/** 會被機器核對的交件型別 */
export const JP_MACHINE_VERIFIABLE_TYPES = ["local_government"] as const;

export interface MachineVerifyOutcome {
  applied: number;
  waiting: number;
  rejected: number;
  skipped: number;
  other: number;
}

/**
 * 交件當下對剛收下的那幾筆跑一次機器核對。失敗不影響交件成功（排程會再掃）：出錯回 null、只記 log。
 * ids 是剛 insert 的 contribution id，只挑會被機器核對的型別。
 */
export async function machineVerifyInline(
  supabase: SupabaseLike,
  rows: ReadonlyArray<{ id: string; contribution_type: string }>,
): Promise<MachineVerifyOutcome | null> {
  const ids = rows.filter((r) => (JP_MACHINE_VERIFIABLE_TYPES as readonly string[]).includes(r.contribution_type)).map((r) => r.id);
  if (ids.length === 0) return null;
  try {
    const { data, error } = await supabase.rpc("lg_registry_verify_pending", { p_limit: ids.length, p_ids: ids });
    if (error) {
      console.error("lg_registry_verify_pending:", error.message);
      return null;
    }
    const d = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
    const n = (k: string) => (typeof d[k] === "number" ? d[k] as number : 0);
    return { applied: n("applied"), waiting: n("waiting"), rejected: n("rejected"), skipped: n("skipped"), other: n("other") };
  } catch (e) {
    console.error("lg_registry_verify_pending:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
