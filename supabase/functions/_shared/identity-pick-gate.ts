/**
 * 必須指認的件，同意票沒帶指認 → 投票當下就退回重投（協議 1.129.0，2026-11-11）。
 *
 * 彰化溪州鄉廖文雄（1946 年生）：站上同名 3 位都不是他，規則要求同意票帶 resolved_politician_id（都不是填 "new"），
 * 驗證者沒帶、伺服器照收，等到落庫才以「同名多位，判不出身分」整筆退件——交件與投票全白做、件回隊尾。
 * 這裡把判斷提前到收票那一刻：判定函式與落庫端（ensurePolitician）同一個——resolvePolitician 回 ambiguous 就是必須指認，
 * 輸入也用同一份正規化（identityInputOf）。落庫端的退件不動，留作最後防線。
 *
 * 退回不算退件、不扣分、不記為已投；disagree／unsure 不受影響。
 */
import { identityInputOf } from "./candidate-import.ts";
import { identityCandidateOf } from "./identity-candidate.ts";
import { createSupabaseIdentityStore, resolvePolitician } from "./politician-identity.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

const MAX_CANDIDATES = 20;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 必須指認的唯一判定（派工的 identity_pick_required 與收票的閘共用）：同名多位、系統判不出身分 */
export function identityPickRequired(resolution: { decision: string } | null | undefined): boolean {
  return resolution?.decision === "ambiguous";
}

export interface PickCandidate {
  id: string;
  name: string | null;
  birth_year: number | null;
  region: string | null;
  party: string | null;
}
export interface IdentityPickCheck {
  required: boolean;
  candidates: PickCandidate[];
  /** 比對拋例外、閘門放行（fail-open）：呼叫端要留可觀察的紀錄 */
  error?: boolean;
}

/**
 * 這一筆已經有一張同意票帶了指認（consensus／auto-apply 目前一票指認即採用）：之後的同意票不必再帶（過嚴，主線裁示）。
 * 修訂自己那張票時排除自己（自己改掉指認就不算數）。查不到不當作有（照常檢查）。
 */
export async function hasExistingPick(supabase: SupabaseLike, contributionId: string, excludeVoteId?: string | null): Promise<boolean> {
  try {
    const { data } = await supabase.from("contribution_votes").select("id, verdict, resolved_politician_id").eq("contribution_id", contributionId).limit(200);
    return ((data ?? []) as Obj[]).some((v) => v.verdict === "agree" && str(v.resolved_politician_id) !== null && v.id !== excludeVoteId);
  } catch (e) {
    console.error("identity pick gate existing votes:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** 這一件要不要指認、候選有誰。比對失敗不擋（回 required:false）——系統的問題不該讓代理白做，落庫端仍是最後防線 */
export async function checkIdentityPick(supabase: SupabaseLike, contributionType: string, payload: Obj, taskId: unknown): Promise<IdentityPickCheck> {
  const none: IdentityPickCheck = { required: false, candidates: [] };
  const candidate = identityCandidateOf(contributionType, payload, taskId);
  if (!candidate) return none;
  try {
    const resolution = await resolvePolitician(createSupabaseIdentityStore(supabase), identityInputOf(candidate), { persist: false });
    if (!identityPickRequired(resolution)) return none;
    // 候選＝比對命中的人，加上站上同名的人（比對沒命中任何 key 的同名者，也要讓驗證者看得到、能指認）
    const scored = resolution.candidates.map((c) => c.politician_id);
    const { data: sameName } = resolution.names.length > 0
      ? await supabase.from("politicians").select("id, name, birth_year, region, party, merged_into").in("name", resolution.names).limit(MAX_CANDIDATES)
      : { data: [] };
    const { data: scoredRows } = scored.length > 0
      ? await supabase.from("politicians").select("id, name, birth_year, region, party, merged_into").in("id", scored)
      : { data: [] };
    // 已併入別人的人物殼不列（指認要指保留的那一位）；落庫端 followMergedInto 本來就會轉過去
    const rows = [...((scoredRows ?? []) as Obj[]), ...((sameName ?? []) as Obj[])].filter((p) => !p.merged_into);
    const byId = new Map(rows.map((p) => [String(p.id), p]));
    const ids = [...new Set([...scored, ...rows.map((p) => String(p.id))])].filter((id) => byId.has(id)).slice(0, MAX_CANDIDATES);
    return {
      required: true,
      candidates: ids.map((id) => {
        const p = byId.get(id);
        return { id, name: (p?.name as string) ?? null, birth_year: (p?.birth_year as number) ?? null, region: (p?.region as string) ?? null, party: (p?.party as string) ?? null };
      }),
    };
  } catch (e) {
    console.error("identity pick gate:", e instanceof Error ? e.message : String(e));
    return { ...none, error: true };
  }
}

export const IDENTITY_PICK_MESSAGE =
  "這一筆站上有同名的人，系統判不出是哪一位，同意票必須指認：請在 resolved_politician_id 指認是哪一位（candidates 裡的 id），都不是填 \"new\"。" +
  "補上再送一次，這次不算退件、不扣分、也還沒記為已投。";
