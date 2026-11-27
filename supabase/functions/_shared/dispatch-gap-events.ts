/**
 * 派工缺口事件（第 2 期 PR-2，migration 20261127082000）：同步函式寫完名單後，把「哪些單位換了」一次告訴資料庫，
 * 由 SQL 的 dispatch_gap_enqueue_cec_units(p_units jsonb) 展開成各臂的單位鍵入列。
 *
 * 原本靠 cec_candidates 的語句層級觸發器：同步一次刪寫一個單位就入一筆整臂事件（開票夜每 10 分鐘一次），
 * 一批事件的成本等於把名冊族整臂重算一遍；現在只入受影響的單位。
 *
 * 入列失敗不影響同步（名單已經寫好了）：回傳 ok=false 與錯誤訊息，由呼叫端放進回應；漏掉的事件由每小時雙軌比對與每日對帳補。
 */

export interface GapUnit {
  election_id: number;
  election_type: string;
  region: string;
  sub_region?: string;
}

export interface RpcClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface EnqueueResult {
  ok: boolean;
  /** 送進資料庫的單位數（去重後） */
  units: number;
  /** 資料庫回報新增的事件數 */
  events: number;
  error?: string;
}

/** 一次 rpc 最多送幾個單位（payload 大小考量；一次同步最多幾百個單位） */
export const GAP_UNIT_BATCH = 200;

export const GAP_RPC_NAME = "dispatch_gap_enqueue_cec_units";

function unitKey(u: GapUnit): string {
  return `${u.election_id}|${u.election_type}|${u.region}|${u.sub_region ?? ""}`;
}

/** 去重（同一個單位被碰到兩次只送一次），保持第一次出現的順序 */
export function dedupeUnits(units: readonly GapUnit[]): GapUnit[] {
  const seen = new Set<string>();
  const out: GapUnit[] = [];
  for (const u of units) {
    const k = unitKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ election_id: u.election_id, election_type: u.election_type, region: u.region, ...(u.sub_region ? { sub_region: u.sub_region } : {}) });
  }
  return out;
}

export async function enqueueCecUnits(supabase: RpcClient, units: readonly GapUnit[]): Promise<EnqueueResult> {
  const list = dedupeUnits(units);
  if (list.length === 0) return { ok: true, units: 0, events: 0 };
  let events = 0;
  try {
    for (let i = 0; i < list.length; i += GAP_UNIT_BATCH) {
      const { data, error } = await supabase.rpc(GAP_RPC_NAME, { p_units: list.slice(i, i + GAP_UNIT_BATCH) });
      if (error) return { ok: false, units: list.length, events, error: error.message };
      if (typeof data === "number") events += data;
    }
  } catch (e) {
    return { ok: false, units: list.length, events, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, units: list.length, events };
}
