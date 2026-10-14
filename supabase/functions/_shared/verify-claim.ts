/**
 * 驗證派工的原子認領（2026-10-14，migration 20261011370000／370100）。
 *
 * 同一個來源網段開好幾個視窗跑協議時，幾乎同時進來的 /next 會在對方寫 verify_dispatches 之前讀驗證池，拿到同一筆；
 * 一個網段一筆只算一票，後投的那邊查證做完才吃 409 already_voted。改成派出前先呼叫 SQL `verify_dispatch_claim` 認領：
 * 15 分鐘內已派給同一網段的回 false，就換下一筆候選（最多 VERIFY_CLAIM_TRIES 筆）。
 *
 * 退路：函式還沒上線（rpc 錯誤）或回傳不是布林值，照舊直接 upsert verify_dispatches、當作認領成功——
 * 跟改動前的行為一樣，派工不會因為認領查不到而停擺（手動部署順序反過來也安全）。
 * next 與 jp-next 共用；jp-next 的 client 固定 db.schema=policy_jp，rpc 與表都落在 policy_jp。
 */

/** 一輪 /next 最多試幾筆候選；都被同網段的並行請求認領走了就不派驗證（改派任務或回 none） */
export const VERIFY_CLAIM_TRIES = 5;

type RpcResult = { data: unknown; error: { message: string } | null };
// deno-lint-ignore no-explicit-any
type Client = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>; from: (t: string) => any };

export type VerifyClaimResult<T> = { pick: T | null; taken: string[] };

/** 依序認領候選；回第一筆認領成功的，與被別人先認領走的 id（記 log 用） */
export async function claimVerifyCandidate<T extends { id: string }>(
  supabase: Client,
  candidates: readonly T[],
  who: { ipHash: string; agentName: string },
  tries: number = VERIFY_CLAIM_TRIES,
): Promise<VerifyClaimResult<T>> {
  const taken: string[] = [];
  for (const c of candidates.slice(0, Math.max(1, tries))) {
    let res: RpcResult;
    try {
      res = await supabase.rpc("verify_dispatch_claim", { p_contribution_id: c.id, p_ip_hash: who.ipHash, p_agent_name: who.agentName });
    } catch (e) {
      res = { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
    if (!res.error && res.data === false) { taken.push(c.id); continue; }
    if (res.error || res.data !== true) {
      if (res.error) console.error("verify_dispatch_claim:", res.error.message);
      const { error: dErr } = await supabase.from("verify_dispatches")
        .upsert({ contribution_id: c.id, ip_hash: who.ipHash, agent_name: who.agentName, dispatched_at: new Date().toISOString() }, { onConflict: "contribution_id,ip_hash" });
      if (dErr) console.error("verify dispatch record failed:", dErr.message);
    }
    return { pick: c, taken };
  }
  return { pick: null, taken };
}
