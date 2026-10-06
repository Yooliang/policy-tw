/**
 * 同名人物接錯：參選紀錄改掛到正確的人（reassign_candidacy，2026-10-06，維護者點頭；#370 未決 1）。
 *
 * 簡嘉佑：台中市第09選舉區的民進黨簡嘉佑（1987 年生）的 2026 參選紀錄，掛到了 1959 年生的桃園市豐林里長；
 * 代理確認掛錯之後只能回 no_change——correction 只開放狀態、職位、選舉別，同名合併（merge_politician）方向相反。
 *
 * 這一型：指定一筆參選紀錄，改掛到「既有的另一位」（to_politician_id）或「新建一位」（new_politician）。
 * 伺服器檢查（交件與落庫各一次，都用 reassignProblems）：
 *   - 新舊兩人同名（或已知別名）——不同名的不是「同名接錯」，是別的錯，不走這條
 *   - 不是同一人：出生年都有而且一樣就擋（那是同一人分成兩筆，走 merge_politician）；記成同一人的擋
 *   - 出處的分辨資料（evidence）對得上：出生年要跟新的一樣（新的有記的話）、跟舊的不同
 *   - 改掛後同一個人同一屆不會有兩筆（參選紀錄的主鍵是 人物＋屆別）
 * 門檻：比照 merge_politician 要兩台不同機器（SCORE_TWO_IP_TYPES）；分數門檻一般值 3（不動計分）。
 * 系統票照現有規則：SQL reassign_candidacy_system_check 拿中選會名冊唯一對上那一列的出生年比（reassignSystemVote 是 TS 鏡像）。
 */
import { normText } from "./identity-normalize.ts";

export const REASSIGN_TYPE = "reassign_candidacy";
export const OWNER_MISMATCH_TASK = "candidacy_owner_mismatch";
/** 系統票的 model（SQL reassign_candidacy_system_check 寫的就是這個前綴） */
export const REASSIGN_MODEL_PREFIX = "policy-tw/cec-reassign-check";
export const REASSIGN_REASON_MIN = 20;
export const REASSIGN_REASON_MAX = 2000;
/** evidence 可以寫的分辨資料（至少一項） */
export const EVIDENCE_FIELDS = ["birth_year", "party", "district"] as const;

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export interface PersonBrief {
  id: string | null;
  name: string;
  birth_year: number | null;
  party?: string | null;
  region?: string | null;
  merged_into?: string | null;
  aliases?: string[];
}

export interface ReassignContext {
  pe: { id: number; politician_id: string; election_id: number; election_type: string | null; position?: string | null; county?: string | null } | null;
  from: PersonBrief | null;
  /** 改掛的對象：既有的（id 有值）或要新建的（id 為 null） */
  to: PersonBrief | null;
  /** 改掛的對象既有的參選屆別（新建的是空的） */
  to_election_ids: number[];
  /** 兩人之間已經記下的同一人／不同人判定 */
  pair_resolution: "same" | "different" | null;
}

export interface ReassignProblem {
  code: "target_not_found" | "apply_would_fail";
  path: string;
  message: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 兩個名字是不是同一個名字（正規化後相同，或其中一位登記過另一位的名字當別名） */
export function sameNameOrAlias(a: PersonBrief, b: PersonBrief): boolean {
  const na = normText(a.name), nb = normText(b.name);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return (a.aliases ?? []).map((x) => normText(x)).includes(nb) || (b.aliases ?? []).map((x) => normText(x)).includes(na);
}

/** payload 裡出處的分辨資料 */
export function evidenceOf(payload: unknown): { birth_year: number | null; party: string | null; district: string | null } {
  const p = (payload && typeof payload === "object" ? payload : {}) as Obj;
  const e = (p.evidence && typeof p.evidence === "object" ? p.evidence : {}) as Obj;
  return { birth_year: int(e.birth_year), party: str(e.party), district: str(e.district) };
}

/**
 * 伺服器檢查（純函式）：交件前置檢查與落庫都用這一份。沒有問題回空陣列。
 */
export function reassignProblems(ctx: ReassignContext, payload: unknown): ReassignProblem[] {
  const out: ReassignProblem[] = [];
  if (!ctx.pe) return [{ code: "target_not_found", path: "payload.politician_election_id", message: "找不到這筆參選紀錄：請照任務 target 的 politician_election_id 帶（整數 id，不是人物 uuid）" }];
  if (!ctx.from) return [{ code: "target_not_found", path: "payload.politician_election_id", message: "這筆參選紀錄現在掛的人物找不到" }];
  if (!ctx.to) return [{ code: "target_not_found", path: "payload.to_politician_id", message: "找不到改掛的對象：to_politician_id 要是既有人物的 uuid（任務 target.same_name 裡的），都不是就用 new_politician 新建" }];
  const to = ctx.to, from = ctx.from;
  const claimedFrom = str((payload && typeof payload === "object" ? payload as Obj : {}).from_politician_id);
  if (claimedFrom && from.id && claimedFrom.toLowerCase() !== from.id.toLowerCase()) {
    out.push({ code: "apply_would_fail", path: "payload.from_politician_id", message: `這筆參選紀錄現在掛的是 ${from.name}（${from.id}），不是 from_politician_id 寫的 ${claimedFrom}：可能已經被改過，請重新領任務看現況` });
    return out;
  }
  if (to.merged_into) out.push({ code: "apply_would_fail", path: "payload.to_politician_id", message: `改掛的對象 ${to.id} 已經併入 ${to.merged_into}，請改帶 ${to.merged_into}` });
  if (to.id && to.id.toLowerCase() === from.id?.toLowerCase()) {
    out.push({ code: "apply_would_fail", path: "payload.to_politician_id", message: "改掛的對象就是現在掛的這位；這筆沒有掛錯的話請回 no_change（outcome=confirmed）" });
    return out;
  }
  if (!sameNameOrAlias(from, to)) {
    out.push({ code: "apply_would_fail", path: to.id ? "payload.to_politician_id" : "payload.new_politician.name", message: `改掛只收同名（或已知別名）的兩個人：現在掛的是「${from.name}」、改掛的對象是「${to.name}」。名字不同的不是同名接錯，請用別的型別更正` });
  }
  if (from.birth_year !== null && to.birth_year !== null && from.birth_year === to.birth_year) {
    out.push({ code: "apply_would_fail", path: to.id ? "payload.to_politician_id" : "payload.new_politician.birth_year", message: `兩位的出生年都是 ${to.birth_year}，看起來是同一個人分成兩筆——那要用 merge_politician 合併，不是改掛` });
  }
  if (ctx.pair_resolution === "same") {
    out.push({ code: "apply_would_fail", path: "payload.to_politician_id", message: "這兩位已經被判定是同一個人（同名人物確認）；要推翻請先處理那一筆" });
  }
  const ev = evidenceOf(payload);
  if (ev.birth_year !== null) {
    if (to.birth_year !== null && to.birth_year !== ev.birth_year) {
      out.push({ code: "apply_would_fail", path: "payload.evidence.birth_year", message: `出處上這一筆的出生年是 ${ev.birth_year}，改掛的對象記的是 ${to.birth_year}，對不上：要改掛到的不是這一位` });
    }
    if (from.birth_year !== null && from.birth_year === ev.birth_year) {
      out.push({ code: "apply_would_fail", path: "payload.evidence.birth_year", message: `出處上這一筆的出生年是 ${ev.birth_year}，跟現在掛的這位一樣：這筆就是他的，不用改掛` });
    }
  }
  if (ctx.to_election_ids.includes(ctx.pe.election_id)) {
    out.push({ code: "apply_would_fail", path: "payload.to_politician_id", message: `改掛的對象已經有 ${ctx.pe.election_id} 這一屆的參選紀錄，改掛後同一個人同一屆會有兩筆；先確認那一筆是不是同一場參選` });
  }
  return out;
}

/**
 * 系統票（TS 鏡像；SQL reassign_candidacy_system_check）：中選會名冊唯一對上那一列的出生年，
 * 對得上新的、對不上舊的 → supported；對得上舊的、對不上新的 → not_supported；其餘棄權。
 */
export function reassignSystemVote(cecHits: number | null, cecBirthYear: number | null, fromBy: number | null, toBy: number | null): "supported" | "not_supported" | null {
  if (cecHits !== 1 || cecBirthYear === null) return null;
  if (toBy === cecBirthYear && fromBy !== cecBirthYear) return "supported";
  if (fromBy === cecBirthYear && toBy !== cecBirthYear) return "not_supported";
  return null;
}

/** 碰 DB：把交件要用到的東西撈齊（交件前置檢查與落庫共用）。查不到的欄位留 null，由 reassignProblems 報 */
export async function loadReassignContext(supabase: SupabaseLike, payload: unknown): Promise<ReassignContext> {
  const p = (payload && typeof payload === "object" ? payload : {}) as Obj;
  const peId = int(p.politician_election_id);
  const ctx: ReassignContext = { pe: null, from: null, to: null, to_election_ids: [], pair_resolution: null };
  if (!peId) return ctx;
  // query-bounds: ok — 按主鍵取一列
  const { data: pe, error } = await supabase.from("politician_elections")
    .select("id, politician_id, election_id, election_type, position, regions(region), politicians(id, name, birth_year, party, region, merged_into)")
    .eq("id", peId).maybeSingle();
  if (error) throw new Error(`politician_elections read: ${error.message}`);
  if (!pe) return ctx;
  const row = pe as Obj & { regions?: { region?: string | null } | null; politicians?: Obj | null };
  const person = row.politicians ?? null;
  ctx.pe = {
    id: Number(row.id), politician_id: String(row.politician_id), election_id: Number(row.election_id),
    election_type: (row.election_type as string | null) ?? null, position: (row.position as string | null) ?? null,
    county: row.regions?.region ?? (person?.region as string | null) ?? null,
  };
  const ids = [ctx.pe.politician_id];
  const toId = str(p.to_politician_id);
  if (toId && UUID_RE.test(toId)) ids.push(toId);
  // query-bounds: ok — 最多兩位人物的別名
  const { data: keys } = await supabase.from("politician_keys").select("politician_id, key_value")
    .in("politician_id", ids).eq("key_type", "alias_name").limit(50);
  const aliasesOf = (id: string) => ((keys ?? []) as Array<{ politician_id: string; key_value: string }>).filter((k) => k.politician_id === id).map((k) => k.key_value);
  if (person) {
    ctx.from = {
      id: String(person.id), name: String(person.name ?? ""), birth_year: int(person.birth_year), party: (person.party as string | null) ?? null,
      region: (person.region as string | null) ?? null, merged_into: (person.merged_into as string | null) ?? null, aliases: aliasesOf(String(person.id)),
    };
  }
  if (toId && UUID_RE.test(toId)) {
    // query-bounds: ok — 按主鍵取一列
    const { data: t } = await supabase.from("politicians").select("id, name, birth_year, party, region, merged_into").eq("id", toId).maybeSingle();
    if (t) {
      const tt = t as Obj;
      ctx.to = { id: String(tt.id), name: String(tt.name ?? ""), birth_year: int(tt.birth_year), party: (tt.party as string | null) ?? null, region: (tt.region as string | null) ?? null, merged_into: (tt.merged_into as string | null) ?? null, aliases: aliasesOf(String(tt.id)) };
      // query-bounds: ok — 一個人的參選紀錄，最多十幾屆
      const { data: els } = await supabase.from("politician_elections").select("election_id").eq("politician_id", toId).limit(100);
      ctx.to_election_ids = ((els ?? []) as Array<{ election_id: number }>).map((e) => Number(e.election_id));
      const [a, b] = [ctx.pe.politician_id, toId].sort();
      // query-bounds: ok — 主鍵取一列
      const { data: res } = await supabase.from("politician_pair_resolutions").select("resolution").eq("pair_key", `${a}|${b}`).maybeSingle();
      const r = (res as { resolution?: string } | null)?.resolution;
      ctx.pair_resolution = r === "same" || r === "different" ? r : null;
    }
  } else if (p.new_politician && typeof p.new_politician === "object") {
    const n = p.new_politician as Obj;
    ctx.to = { id: null, name: String(n.name ?? ""), birth_year: int(n.birth_year), party: str(n.party), region: str(n.region) ?? ctx.pe.county ?? null };
  }
  return ctx;
}

/** 給人看的一個人：「簡嘉佑（1959 年生，桃園市，無黨籍）」 */
export function personLabel(p: PersonBrief | null | undefined): string {
  if (!p) return "（查不到）";
  const parts = [p.birth_year ? `${p.birth_year} 年生` : "出生年不詳", p.region, p.party].filter(Boolean);
  return `${p.name}（${parts.join("，")}）`;
}
