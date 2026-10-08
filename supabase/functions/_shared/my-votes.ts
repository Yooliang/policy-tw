import { fetchAllRows } from "./fetch-all.ts";

/**
 * 這個來源投過票的雜湊們（#481，1.79.0 過渡期）。
 *
 * 新票存的是網段雜湊（ipHash）；切換前的票存的是單一 IP 的舊雜湊（legacyIpHash）。
 * 只查新的，切換前投過票的爭議案件會被派回給同一個來源裁決。
 * IP 認不得時新舊同值，去重後只剩一個。
 */
export function voterHashes(ipHash: string, legacyIpHash?: string): string[] {
  return legacyIpHash && legacyIpHash !== ipHash ? [ipHash, legacyIpHash] : [ipHash];
}

/**
 * 這個來源投過票的貢獻 id（給 /next 排掉「對原貢獻投過票的人又被派去裁決同一件爭議」用）。
 * 只是過濾自己投過的，不是新增清單現算——/next 只讀佇列的規則（2026-09-23）不受影響。
 * 這一份只會成長（沒有狀態篩選），所以要翻頁撈。
 */
// deno-lint-ignore no-explicit-any
export function fetchMyVotedRows(supabase: any, hashes: readonly string[]): Promise<Array<{ contribution_id: string }>> {
  return fetchAllRows<{ contribution_id: string }>("my votes", (from, to) =>
    supabase.from("contribution_votes").select("contribution_id")
      .in("verifier_ip_hash", [...hashes])
      .order("created_at", { ascending: true }).range(from, to));
}
