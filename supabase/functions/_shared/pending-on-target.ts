/**
 * 派任務時附上「這個人身上等票中的交件」（協議 1.98.0，current.pending_on_target）。
 *
 * 起因：8d5c8372「劉雁祿」身上有一筆等票的「這人沒參選」更正、一筆等票的改名更正，
 * 後來領到任務的代理看不到它們。以前只有找政見類任務附 queued_policies，而且只限 policy 型別；
 * 改名（correction，鍵是 target_id）與合併（merge_politician，鍵是 keep_id／remove_id）型別不同，
 * duplicate-claim.ts 也永遠不會把它們配成一對。
 *
 * 規矩（裁決 #233／#234：/next 只讀佇列）：這支只在**已經選出那一件任務之後**，由 fetchTaskContext／fetchVerifyContext
 * 在同一層呼叫；不進候選過濾、不進排序、不進 seed。撈失敗回 null，呼叫端就不附、不擋派工。
 *
 * 只給 contribution_id、型別、一句話摘要（名稱，不印 id）、建立時間、分數；不給 agent_name、ip_hash、完整 payload。
 */
import { summarizeContribution } from "./contribution-summary.ts";
import { PENDING_ON_TARGET_GUIDE } from "./task-guidance.ts";
import { loadSummaryLookup } from "./summary-lookup.ts";

type Obj = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export const MAX_PENDING_ON_TARGET = 10;
/** 任務 target 帶一大串參選紀錄 id（名冊清查、整批補結果）時不拿來展開查：or 條件會爆長，且那類任務對象是整個單位不是某個人 */
const MAX_SCOPE_ELECTION_IDS = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null);
const posInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^[0-9]+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export interface PendingScope {
  politicianIds: string[];
  electionIds: number[];
  policyIds: string[];
}

export interface PendingOnTarget {
  items: Obj[];
  total: number;
}

/** 純函式：任務 target 指到哪些人物、參選紀錄、政見 */
export function scopeOfTarget(target: Obj): PendingScope {
  const politicianIds = new Set<string>();
  const electionIds = new Set<number>();
  const policyIds = new Set<string>();
  const addP = (v: unknown) => { const u = uuid(v); if (u) politicianIds.add(u); };
  addP(target.politician_id);
  const pol = uuid(target.policy_id);
  if (pol) policyIds.add(pol);
  const one = posInt(target.politician_election_id);
  if (one) electionIds.add(one);
  if (Array.isArray(target.politician_election_ids) && target.politician_election_ids.length <= MAX_SCOPE_ELECTION_IDS) {
    for (const v of target.politician_election_ids) { const n = posInt(v); if (n) electionIds.add(n); }
  }
  return { politicianIds: [...politicianIds], electionIds: [...electionIds], policyIds: [...policyIds] };
}

/** 純函式：一筆待驗交件的 payload 指到哪些人物、參選紀錄、政見（verify 情境用） */
export function scopeOfPayload(payload: Obj): PendingScope {
  const politicianIds = new Set<string>();
  const electionIds = new Set<number>();
  const policyIds = new Set<string>();
  for (const k of ["politician_id", "keep_id", "remove_id", "from_politician_id", "to_politician_id"]) {
    const u = uuid(payload[k]); if (u) politicianIds.add(u);
  }
  const pol = uuid(payload.policy_id);
  if (pol) policyIds.add(pol);
  const pe = posInt(payload.politician_election_id);
  if (pe) electionIds.add(pe);
  const table = payload.target_table;
  if (table === "politicians") { const u = uuid(payload.target_id); if (u) politicianIds.add(u); }
  if (table === "policies") { const u = uuid(payload.target_id); if (u) policyIds.add(u); }
  if (table === "politician_elections") { const n = posInt(payload.target_id); if (n) electionIds.add(n); }
  return { politicianIds: [...politicianIds], electionIds: [...electionIds], policyIds: [...policyIds] };
}

/**
 * 純函式：PostgREST `or=(…)` 條件。鍵：
 *   - payload／applied_politician_id 直接指到人物（candidacy、policy、politician 補資料…）
 *   - correction／removal 的 target_table＋target_id（比對 target_table，id 不會跨表誤配）
 *   - merge_politician 的 keep_id、remove_id；reassign_candidacy 的 from／to_politician_id 與 politician_election_id
 *   - 他的政見：payload.policy_id、applied_policy_id
 */
export function pendingOrFilter(scope: PendingScope): string | null {
  const parts: string[] = [];
  const pids = scope.politicianIds;
  if (pids.length > 0) {
    const list = pids.join(",");
    for (const k of ["politician_id", "keep_id", "remove_id", "from_politician_id", "to_politician_id"]) parts.push(`payload->>${k}.in.(${list})`);
    parts.push(`applied_politician_id.in.(${list})`);
    parts.push(`and(payload->>target_table.eq.politicians,payload->>target_id.in.(${list}))`);
  }
  if (scope.electionIds.length > 0) {
    const list = scope.electionIds.join(",");
    parts.push(`and(payload->>target_table.eq.politician_elections,payload->>target_id.in.(${list}))`);
    parts.push(`payload->>politician_election_id.in.(${list})`);
  }
  if (scope.policyIds.length > 0) {
    const list = scope.policyIds.join(",");
    parts.push(`payload->>policy_id.in.(${list})`);
    parts.push(`applied_policy_id.in.(${list})`);
    parts.push(`and(payload->>target_table.eq.policies,payload->>target_id.in.(${list}))`);
  }
  return parts.length > 0 ? parts.join(",") : null;
}

/**
 * 撈等票中的交件。人物對象再補上他自己的參選紀錄 id（一個人最多十幾筆），這樣「對 pe 113 的更正」
 * 在派給 8d5c8372 的任務上看得到。任何一步出錯回 null（呼叫端不附、不擋派工）。
 */
export async function fetchPendingOnTarget(
  supabase: SupabaseLike,
  scope: PendingScope,
  opts: { excludeContributionId?: string | null } = {},
): Promise<PendingOnTarget | null> {
  try {
    const full: PendingScope = { ...scope, electionIds: [...scope.electionIds] };
    if (scope.politicianIds.length > 0) {
      // query-bounds: ok — 一個人的參選紀錄，最多十幾屆；limit 50 當保險
      const { data: pes, error } = await supabase.from("politician_elections").select("id").in("politician_id", scope.politicianIds).limit(50);
      if (error) return null;
      for (const r of (pes ?? []) as Obj[]) { const n = posInt(r.id); if (n && !full.electionIds.includes(n)) full.electionIds.push(n); }
    }
    const filter = pendingOrFilter(full);
    if (!filter) return null;
    // query-bounds: ok — 下面 .limit(MAX_PENDING_ON_TARGET)（10 筆），條件先組在 q 上
    let q = supabase.from("contributions")
      .select("id, contribution_type, payload, applied_politician_id, applied_policy_id, created_at, score, target_score", { count: "exact" })
      .in("status", ["pending", "verified"])
      .or(filter);
    if (opts.excludeContributionId) q = q.neq("id", opts.excludeContributionId);
    const { data, count, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: true }).limit(MAX_PENDING_ON_TARGET);
    if (error) return null;
    const rows = (data ?? []) as Obj[];
    if (rows.length === 0) return { items: [], total: 0 };
    let lookup;
    try {
      lookup = await loadSummaryLookup(supabase, rows.map((r) => ({
        contribution_type: String(r.contribution_type ?? ""), payload: r.payload,
        applied_politician_id: (r.applied_politician_id as string | null) ?? null, applied_policy_id: (r.applied_policy_id as string | null) ?? null,
      })));
    } catch { lookup = undefined; } // 查名稱失敗：摘要退成「某位政治人物」這類中性說法，不印 id
    const items = rows.map((r) => ({
      contribution_id: r.id,
      contribution_type: r.contribution_type,
      summary: summarizeContribution({
        contribution_type: String(r.contribution_type ?? ""), payload: r.payload,
        applied_politician_id: (r.applied_politician_id as string | null) ?? null, applied_policy_id: (r.applied_policy_id as string | null) ?? null,
        lookup,
      }).summary,
      created_at: r.created_at,
      score: r.score ?? null,
      target_score: r.target_score ?? null,
    }));
    return { items, total: typeof count === "number" ? Math.max(count, items.length) : items.length };
  } catch (e) {
    console.error("pending_on_target:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** 純函式：放進 current 的形狀；沒有東西就不附 */
export function shapePendingOnTarget(p: PendingOnTarget | null | undefined): Obj {
  if (!p || p.items.length === 0) return {};
  return { pending_on_target: p.items, pending_on_target_hint: PENDING_ON_TARGET_GUIDE, ...(p.total > p.items.length ? { pending_on_target_total: p.total } : {}) };
}
