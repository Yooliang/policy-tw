/**
 * 候選人匯入的共用流程（現在只有 batch-import-candidates 用；ai-action／ai-import-candidate／import-candidate 2026-10-07 已下架）。
 *
 * 全部查詢都走 maybeSingle() 並檢查 error——不再有「錯誤被當查無、再 insert」的路。
 */

import { normElectionType, normParty, normText } from "./identity-normalize.ts";
import { createSupabaseIdentityStore, resolvePolitician, type Resolution } from "./politician-identity.ts";
import { isPlaceholderName } from "./placeholder-name.ts";
import { type CandidacyStatus, isListPublished, nextCandidacyStatus } from "./candidacy-status.ts";

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

/**
 * 找該年度的定期選舉，沒有就建一場地方選舉佈局（舊 AI 管線與管理匯入用，只收投票年份）。
 * 只看 election_reason＝regular：同年的補選、重行選舉（例如 2022-12-18 嘉義市長）是另一場，不能混進來（#344 第二階段 A）。
 * 新建的選舉明給 election_key（建立後不改），投票日當天＝end_date。
 */
export async function findOrCreateElection(supabase: SupabaseLike, electionYear: number): Promise<number> {
  const { data: rows, error } = await supabase
    .from("elections")
    .select("id")
    .eq("election_reason", "regular")
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
      end_date: `${electionYear}-11-26`,
      election_date: `${electionYear}-11-26`,
      election_key: `${electionYear}-11-26_local`,
      election_reason: "regular",
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
  /** 驗證者兩票都指認 "new"：不管比對結果，直接建新人物（比對只用來產 key，不寫回別人） */
  force_new?: boolean;
}

export interface EnsurePoliticianResult {
  resolution: Resolution;
  /** ambiguous 時為 null（未建立、已進待審） */
  politician_id: string | null;
  created: boolean;
}

/**
 * 身份比對的輸入：姓名、政黨、選舉類型先正規化。落庫（ensurePolitician）與派工的 dry-run（task-context）
 * 必須用同一份，否則同一筆資料兩個時間點比出不同結論（2026-09-23 馮印才 8fa33531：派工時政黨用原字「無」
 * 對不到任何 key → new、不用指認；落庫時正規化成「無黨籍」命中弱面向 → ambiguous、未指認退件，兩張照規則投的票白投）。
 */
export function identityInputOf(candidate: CandidateInput) {
  const name = normText(candidate.name);
  if (name === null) throw new Error("candidate.name 為空");
  return {
    name,
    party: normalizeParty(candidate.party),
    region: candidate.region,
    election_type: normElectionType(candidate.election_type) ?? normElectionType(candidate.position),
    position: candidate.position,
    current_position: candidate.current_position,
    birth_year: candidate.birth_year,
    cec_cand_id: candidate.cec_cand_id,
    cec_theme_id: candidate.cec_theme_id,
  };
}

/**
 * 以多面向比對找人；找不到就建、模稜兩可就不動並進待審。
 */
export async function ensurePolitician(
  supabase: SupabaseLike,
  candidate: CandidateInput,
  options: EnsurePoliticianOptions,
): Promise<EnsurePoliticianResult> {
  const input = identityInputOf(candidate);
  const { name, party, election_type: electionType } = input;
  const store = createSupabaseIdentityStore(supabase);

  const resolution = await resolvePolitician(store, input, { source: options.source, persist: !options.force_new });

  const birthYear = typeof candidate.birth_year === "string" ? parseInt(candidate.birth_year, 10) : candidate.birth_year;
  const validBirthYear = Number.isInteger(birthYear) ? (birthYear as number) : null;

  if (!options.force_new && resolution.decision === "matched" && resolution.politician_id) {
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
  if (!options.force_new && resolution.decision === "ambiguous") {
    return { resolution, politician_id: null, created: false };
  }

  // 測試資料的姓名不建人物（2026-10-06）：管理端的匯入端點與交件落庫都走這裡；資料庫另有觸發器再擋一層
  if (isPlaceholderName(name)) throw new Error(`姓名「${name}」看起來是測試資料，不建立人物`);
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
  /**
   * 參選狀態（candidacy_status 六值，#345 第二階段 A：落庫只寫這一欄，舊的 candidate_status／election_result 由資料庫觸發器同步）。
   * 空值＝這次沒有可寫的狀態：既有的紀錄狀態不動；**新增時沒有狀態就不建**（不收傳聞，回 skipped）。
   */
  candidacy_status?: CandidacyStatus | null;
  source_note?: string | null;
  /** 只在新增時帶入的欄位 */
  insertOnly?: Record<string, unknown>;
  /** 新增與更新都帶的欄位（例如 verified、號次、地區） */
  always?: Record<string, unknown>;
}

export type ParticipationOutcome = "created" | "updated" | "skipped";

/**
 * 匯入端點收的自由文字狀態 → 新欄位 candidacy_status。
 * 這是管理端點的流程、不是交件：status 寫 confirmed／likely／rumored 都可能。傳聞（rumored）與沒寫的回 null——
 * #345 起不收傳聞，新增時 upsertParticipation 不會建這一筆；likely 記成考慮參選。
 * confirmed 看這一屆的正式名單公告了沒（公告後記成已登記）。
 */
export async function importCandidacyStatus(
  supabase: SupabaseLike,
  status: string | null | undefined,
  electionId: number,
  electionType: string,
): Promise<CandidacyStatus | null> {
  const raw = typeof status === "string" ? status.trim() : "";
  if (!raw) return null;
  const listPublished = raw === "confirmed" ? await isListPublished(supabase, electionId, electionType) : false;
  return nextCandidacyStatus({ candidateStatus: raw, listPublished }).status;
}

const RESULT_STATUSES: ReadonlySet<string> = new Set(["elected", "not_elected"]);

export interface ParticipationResult {
  outcome: ParticipationOutcome;
  /** skipped 沒有建紀錄，id 是 null */
  id: number | null;
  previous_status: CandidacyStatus | null;
  /** skipped 的理由（講給呼叫端與使用者看） */
  reason?: string;
}

/**
 * 「他沒有登記」是**否定的斷言**，而且是全站代價最大的一個狀態：
 * 標成 withdrawn（舊的 not_running）之後，這個人不進選舉頁、不算已收錄人員、全站搜尋不算正在參選
 * （lib/candidate-status.ts），而且 policy_missing／profile_gap／candidacy_source_missing／
 * election_result_missing 四種缺口同時不再派——等於單方面消音，沒有回頭路。
 *
 * 2026-09-21 實測線上：registered 有 281 筆帶網址、3 筆沒有；**not_running 102 筆全部沒有網址**，
 * 而且 76 筆的 source_note 寫著「可能再次挑戰」「可能被徵召」這種推測語氣——
 * 推測被寫成了結論。這 102 筆沒有一筆被驗證過（verified 全 false），影響 26 人、94 筆政見。
 *
 * 所以：沒有出處網址就不准寫 withdrawn。以前降成 rumored（傳聞）；#345 起不收傳聞，改成**不動狀態**——
 * 既有的紀錄維持原狀態、只在註記寫明為什麼沒改，新增的就不建（回 skipped）。
 * 登記截止後 `candidate_status_stale` 任務與名單清查照舊會追著問「登記了沒」，那正是該問的問題。
 *
 * 只擋 withdrawn：寫錯 registered 的代價小得多（多列一個人，名單清查會抓到），
 * 而且那條路實測 99% 都帶網址，沒有證據顯示需要擋。
 */
export function guardWithdrawn(
  candidacyStatus: CandidacyStatus | null | undefined,
  sourceNote: string | null | undefined,
): { candidacy_status: CandidacyStatus | null | undefined; source_note: string | null | undefined; downgraded: boolean } {
  if (candidacyStatus !== "withdrawn") return { candidacy_status: candidacyStatus, source_note: sourceNote, downgraded: false };
  if (/https?:\/\/\S+/.test(sourceNote ?? "")) return { candidacy_status: candidacyStatus, source_note: sourceNote, downgraded: false };
  return {
    candidacy_status: null,
    source_note: `${(sourceNote ?? "").trim()}${sourceNote ? "；" : ""}未附出處網址，不足以斷定不參選，狀態沒有改`.trim(),
    downgraded: true,
  };
}

/** politician_elections 找或建（同一人同一場只一筆）。 */
/** 正式的參選狀態：表明參選、登記過（含審定）、或已投票有結果 */
export const OFFICIAL_CANDIDACY_STATUSES: ReadonlySet<string> = new Set(["declared", "filed", "elected", "not_elected"]);

/**
 * 同一年只有一列（主鍵 politician_id＋election_id），但同一年有好幾種選舉（縣市長、縣市議員…）。
 * 2026-09-25：高嘉瑜被 AI 匯入成「可能選台北市長（rumored→not_running）」，之後中選會名冊證實她登記的是台北市議員；
 * 落庫只改了狀態，選舉別與職稱沒改，網站就顯示她「登記參選台北市長」。詹琬蓁、呂黃春金同一型。
 *
 * 規則：選舉別不同時——
 *   - 原本那列不是正式狀態（考慮參選、不參選、空值）→ 整列改成新的選舉別與職稱（她實際選的是這個）
 *   - 原本那列已是正式狀態 → 擋下：同一次選舉不能登記兩種，兩筆必有一筆錯，不能靜靜蓋掉
 * 回傳要改的欄位；不需要改選舉別時回 {}。
 */
export function electionTypeSwitch(
  existing: { election_type?: string | null; candidacy_status?: string | null },
  input: { election_type?: string | null; position?: string | null },
): Record<string, unknown> {
  if (!input.election_type || !existing.election_type || existing.election_type === input.election_type) return {};
  if (OFFICIAL_CANDIDACY_STATUSES.has(String(existing.candidacy_status))) {
    throw new Error(`同一年已有「${existing.election_type}」的正式參選紀錄（${existing.candidacy_status}），不能再寫成「${input.election_type}」——兩筆必有一筆錯，請先核對`);
  }
  return { election_type: input.election_type, ...(input.position ? { position: input.position } : {}) };
}

export async function upsertParticipation(
  supabase: SupabaseLike,
  input: ParticipationInput,
): Promise<ParticipationResult> {
  const guarded = guardWithdrawn(input.candidacy_status, input.source_note);
  input = { ...input, candidacy_status: guarded.candidacy_status, source_note: guarded.source_note };
  const { data: existing, error } = await supabase
    .from("politician_elections")
    .select("id, candidacy_status, election_type")
    .eq("politician_id", input.politician_id)
    .eq("election_id", input.election_id)
    .maybeSingle();
  throwIf(error, "politician_elections lookup");

  if (existing) {
    const typeSwitch = electionTypeSwitch(existing, input);
    // 結果比登記階段與不參選都大：這一筆已經有結果，匯入端這次給的是登記階段的狀態就不覆蓋（舊兩欄就是這樣：只改 candidate_status 不動 election_result）
    const keepResult = RESULT_STATUSES.has(String(existing.candidacy_status)) && !!input.candidacy_status && !RESULT_STATUSES.has(input.candidacy_status);
    const { error: updateError } = await supabase
      .from("politician_elections")
      .update({
        ...typeSwitch,
        ...(input.candidacy_status && !keepResult ? { candidacy_status: input.candidacy_status } : {}),
        ...(input.source_note !== undefined ? { source_note: input.source_note } : {}),
        ...(input.always ?? {}),
      })
      .eq("id", existing.id);
    throwIf(updateError, "politician_elections update");
    return { outcome: "updated", id: existing.id, previous_status: existing.candidacy_status ?? null };
  }

  // 不收傳聞：沒有狀態可寫（空值、傳聞、沒出處的不參選）就不建這筆
  if (!input.candidacy_status) {
    return {
      outcome: "skipped",
      id: null,
      previous_status: null,
      reason: guarded.downgraded
        ? "沒有附出處網址，不足以斷定不參選；也不收傳聞，所以沒有建立參選紀錄"
        : "沒有可寫的參選狀態（傳聞參選不收），沒有建立參選紀錄；要記就帶本人或政黨公開表態的報導（考慮參選）或登記名單（已登記）",
    };
  }
  const { data: inserted, error: insertError } = await supabase
    .from("politician_elections")
    .insert({
      politician_id: input.politician_id,
      election_id: input.election_id,
      position: input.position ?? null,
      election_type: input.election_type ?? positionToElectionType(input.position),
      candidacy_status: input.candidacy_status,
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
