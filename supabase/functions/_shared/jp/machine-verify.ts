/**
 * 日本站的機器核對（照正見 cec-verify）：有權威資料可查的交件，交進來就跟官方的表比，對得上直接落庫。
 *
 * 目前兩種（都照交件型別分流）：
 *   local_government ↔ 總務省「全国地方公共団体コード」（SQL policy_jp.lg_registry_verify_pending，migration 20261009250000）
 *   regional_stat    ↔ e-Stat 令和7年国勢調査（SQL policy_jp.stat_registry_verify_pending，migration 20261009250200；人口・面積・高齢化率）
 * pg_cron 每 10 分鐘也會掃；這裡是交件當下就先跑一次，代理馬上看得到結果。
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/** 交件型別 → 機器核對（SQL 函式與它寫的 reviewed_by，SQL 那邊寫死同一個字） */
export const JP_MACHINE_VERIFIERS = {
  local_government: { rpc: "lg_registry_verify_pending", reviewer: "soumu-auto" },
  regional_stat: { rpc: "stat_registry_verify_pending", reviewer: "estat-auto" },
} as const;
/** 機器核對的審核者（contributions.reviewed_by） */
export const JP_MACHINE_REVIEWERS = Object.values(JP_MACHINE_VERIFIERS).map((v) => v.reviewer);
/** 會被機器核對的交件型別 */
export const JP_MACHINE_VERIFIABLE_TYPES = Object.keys(JP_MACHINE_VERIFIERS) as Array<keyof typeof JP_MACHINE_VERIFIERS>;

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
  const total: MachineVerifyOutcome = { applied: 0, waiting: 0, rejected: 0, skipped: 0, other: 0 };
  let called = false;
  for (const type of JP_MACHINE_VERIFIABLE_TYPES) {
    const ids = rows.filter((r) => r.contribution_type === type).map((r) => r.id);
    if (ids.length === 0) continue;
    called = true;
    try {
      const { data, error } = await supabase.rpc(JP_MACHINE_VERIFIERS[type].rpc, { p_limit: ids.length, p_ids: ids });
      if (error) {
        console.error(`${JP_MACHINE_VERIFIERS[type].rpc}:`, error.message);
        continue;
      }
      const d = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
      for (const k of Object.keys(total) as Array<keyof MachineVerifyOutcome>) total[k] += typeof d[k] === "number" ? d[k] as number : 0;
    } catch (e) {
      console.error(`${JP_MACHINE_VERIFIERS[type].rpc}:`, e instanceof Error ? e.message : String(e));
    }
  }
  return called ? total : null;
}
