/**
 * 候選人匯入的共用流程（ai-action / ai-import-candidate / import-candidate / batch-import-candidates 共用）。
 *
 * 全部查詢都走 maybeSingle() 並檢查 error——不再有「錯誤被當查無、再 insert」的路。
 */

import { normElectionType, normParty, normText } from "./identity-normalize.ts";
import { createSupabaseIdentityStore, resolvePolitician, type Resolution } from "./politician-identity.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export interface CandidateInput {
  name: string;
  party?: string | null;
  position?: string | null;
  region?: string | null;
  election_type?: string | null;
  current_position?: string | null;
  birth_year?: number | string | null;
  /** 中選會 cand_id 與其選舉場次 theme_id（官方匯入才有；兩者都要才會產 cec_cand_id key） */
  cec_cand_id?: number | string | null;
  cec_theme_id?: string | null;
  status?: string | null;
  note?: string | null;
}

export const DEFAULT_PARTY = "無黨籍";
export const DEFAULT_ELECTION_TYPE = "縣市長";

function throwIf(error: { message: string } | null, where: string): void {
  if (error) throw new Error(`${where}: ${error.message}`);
}

/** 職位字串 → 選舉類型（舊 mapPositionToType 的替代；認不出沿用舊預設「縣市長」）。 */
export function positionToElectionType(position: string | null | undefined): string {
  return normElectionType(position) ?? DEFAULT_ELECTION_TYPE;
}

export function normalizeParty(party: string | null | undefined): string {
  return normParty(party) ?? DEFAULT_PARTY;
}

/** 找該年度的選舉，沒有就建一場地方選舉佈局。elections.id 就是年份。 */
export async function findOrCreateElection(supabase: SupabaseLike, electionYear: number): Promise<number> {
  const { data: rows, error } = await supabase
    .from("elections")
    .select("id")
    .gte("election_date", `${electionYear}-01-01`)
    .lte("election_date", `${electionYear}-12-31`)
    .order("id")
    .limit(2);
  throwIf(error, "elections lookup");
  const list: Array<{ id: number }> = rows ?? [];
  if (list.length === 1) return list[0].id;
  if (list.length > 1) {
    const exact = list.find((e) => e.id === electionYear);
    if (exact) return exact.id;
    throw new Error(`${electionYear} 年有 ${list.length} 場選舉，無法自動選定 election_id`);
  }

  const { data: created, error: insertError } = await supabase
    .from("elections")
    .insert({
      name: `${electionYear}年地方公職人員選舉`,
      short_name: `${electionYear}地方選舉`,
      start_date: `${electionYear}-01-01`,
      end_date: `${electionYear}-12-31`,
      election_date: `${electionYear}-11-26`,
    })
    .select("id")
    .maybeSingle();
  throwIf(insertError, "elections insert");
  if (!created) throw new Error("elections insert 沒有回傳 id");
  return created.id;
}

export interface EnsurePoliticianOptions {
  /** 寫進 politician_keys.source / reviews.source */
  source: string;
  /** new 時額外塞進 politicians 的欄位（例如 bio、gender） */
  extraInsert?: Record<string, unknown>;
}

export interface EnsurePoliticianResult {
  resolution: Resolution;
  /** ambiguous 時為 null（未建立、已進待審） */
  politician_id: string | null;
  created: boolean;
}

/**
 * 以多面向比對找人；找不到就建、模稜兩可就不動並進待審。
 */
export async function ensurePolitician(
  supabase: SupabaseLike,
  candidate: CandidateInput,
  options: EnsurePoliticianOptions,
): Promise<EnsurePoliticianResult> {
  const name = normText(candidate.name);
  if (name === null) throw new Error("candidate.name 為空");

  const party = normalizeParty(candidate.party);
  const electionType = normElectionType(candidate.election_type) ?? normElectionType(candidate.position);
  const store = createSupabaseIdentityStore(supabase);

  const resolution = await resolvePolitician(store, {
    name,
    party,
    region: candidate.region,
    election_type: electionType,
    position: candidate.position,
    current_position: candidate.current_position,
    birth_year: candidate.birth_year,
    cec_cand_id: candidate.cec_cand_id,
    cec_theme_id: candidate.cec_theme_id,
  }, { source: options.source });

  const birthYear = typeof candidate.birth_year === "string" ? parseInt(candidate.birth_year, 10) : candidate.birth_year;
  const validBirthYear = Number.isInteger(birthYear) ? (birthYear as number) : null;

  if (resolution.decision === "matched" && resolution.politician_id) {
    // 官方資料帶出生年就補進沒有出生年的人（觸發器會順手產 birth key，之後跨屆靠它對人）
    if (validBirthYear !== null) {
      const { error: birthError } = await supabase
        .from("politicians")
        .update({ birth_year: validBirthYear })
        .eq("id", resolution.politician_id)
        .is("birth_year", null);
      throwIf(birthError, "politicians birth_year backfill");
    }
    return { resolution, politician_id: resolution.politician_id, created: false };
  }
  if (resolution.decision === "ambiguous") {
    return { resolution, politician_id: null, created: false };
  }

  const { data: inserted, error } = await supabase
    .from("politicians")
    .insert({
      name,
      party,
      position: candidate.position ?? null,
      region: candidate.region ?? null,
      current_position: candidate.current_position ?? null,
      birth_year: validBirthYear,
      ...(options.extraInsert ?? {}),
    })
    .select("id")
    .maybeSingle();
  throwIf(error, "politicians insert");
  if (!inserted) throw new Error("politicians insert 沒有回傳 id");

  // DB 觸發器已從欄位推導 key；這裡把候選資料帶進來的面向也寫回（幂等）
  await store.addKeys(inserted.id, resolution.keys, options.source);
  return { resolution, politician_id: inserted.id, created: true };
}

export interface ParticipationInput {
  politician_id: string;
  election_id: number;
  position?: string | null;
  election_type?: string | null;
  candidate_status?: string | null;
  source_note?: string | null;
  /** 只在新增時帶入的欄位 */
  insertOnly?: Record<string, unknown>;
  /** 新增與更新都帶的欄位（例如得票數、verified） */
  always?: Record<string, unknown>;
}

export type ParticipationOutcome = "created" | "updated";

/** politician_elections 找或建（同一人同一場只一筆）。 */
export async function upsertParticipation(
  supabase: SupabaseLike,
  input: ParticipationInput,
): Promise<{ outcome: ParticipationOutcome; id: number; previous_status: string | null }> {
  const { data: existing, error } = await supabase
    .from("politician_elections")
    .select("id, candidate_status")
    .eq("politician_id", input.politician_id)
    .eq("election_id", input.election_id)
    .maybeSingle();
  throwIf(error, "politician_elections lookup");

  if (existing) {
    const { error: updateError } = await supabase
      .from("politician_elections")
      .update({
        ...(input.candidate_status ? { candidate_status: input.candidate_status } : {}),
        ...(input.source_note !== undefined ? { source_note: input.source_note } : {}),
        ...(input.always ?? {}),
      })
      .eq("id", existing.id);
    throwIf(updateError, "politician_elections update");
    return { outcome: "updated", id: existing.id, previous_status: existing.candidate_status ?? null };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("politician_elections")
    .insert({
      politician_id: input.politician_id,
      election_id: input.election_id,
      position: input.position ?? null,
      election_type: input.election_type ?? positionToElectionType(input.position),
      candidate_status: input.candidate_status ?? "rumored",
      verified: false,
      source_note: input.source_note ?? null,
      ...(input.insertOnly ?? {}),
      ...(input.always ?? {}),
    })
    .select("id")
    .maybeSingle();
  throwIf(insertError, "politician_elections insert");
  if (!inserted) throw new Error("politician_elections insert 沒有回傳 id");
  return { outcome: "created", id: inserted.id, previous_status: null };
}

/** ambiguous 時回給呼叫端（AI）的說明 payload。 */
export function ambiguousPayload(name: string, resolution: Resolution) {
  return {
    skipped: true,
    reason: "ambiguous_identity",
    message: `「${name}」有多位可能對應的政治人物，已送入待審清單，未新增：${resolution.reason}`,
    candidate_name: name,
    candidates: resolution.candidates.map((c) => ({
      politician_id: c.politician_id,
      score: c.score,
      matched_keys: c.matched_keys.map((k) => k.key_value),
      ...(c.vetoed ? { vetoed: c.vetoed } : {}),
    })),
  };
}
