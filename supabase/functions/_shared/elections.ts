/**
 * 選舉清單與登記截止日：讀取端一律查資料庫（#344 第二階段 A），不再在程式裡寫死 2022／2024／2026。
 *
 * - elections 表：交件允許的選舉 id、election_key 對照、投票日（政見提出日期比對）、列印用的名稱
 * - roster_check_scope.registration_closed_on：各屆各職位的參選登記截止日（candidacy-guards 用）
 *
 * 查詢失敗時退回舊的三屆（後備，不讓守門整個失效或整支端點掛掉）；只快取一分鐘，新增選舉很快就認得。
 */

import { type ElectionRef, FALLBACK_ELECTIONS } from "./contribution-schema.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export interface ElectionLabelRef extends ElectionRef {
  short_name?: string | null;
}

const CACHE_MS = 60_000;
let electionsCache: { at: number; rows: ElectionLabelRef[] } | null = null;
let deadlinesCache: { at: number; map: RegistrationDeadlines } | null = null;

/** 查不到時的後備登記截止日（跟上線前寫死的 { 2026: "2026-09-04" } 一樣） */
export const FALLBACK_REGISTRATION_DEADLINES: Readonly<Record<number, string>> = { 2026: "2026-09-04" };

/** 選舉 id → 該屆各職位的登記截止日（職位沒有單獨的就用整屆最早的那一天） */
export interface RegistrationDeadlines {
  byElection: Record<number, string>;
  byElectionType: Record<string, string>;
}

export function clearElectionCaches(): void {
  electionsCache = null;
  deadlinesCache = null;
}

export async function loadElections(supabase: SupabaseLike): Promise<ElectionLabelRef[]> {
  if (electionsCache && Date.now() - electionsCache.at < CACHE_MS) return electionsCache.rows;
  try {
    const { data, error } = await supabase
      .from("elections")
      .select("id, election_key, election_date, short_name")
      .order("election_date", { ascending: true })
      .limit(500);
    if (error || !Array.isArray(data) || data.length === 0) throw new Error(error?.message ?? "elections 空的");
    const rows = (data as ElectionLabelRef[]).filter((r) =>
      Number.isInteger(r.id) && typeof r.election_key === "string" && typeof r.election_date === "string"
    ).map((r) => ({ ...r, election_date: r.election_date.slice(0, 10) }));
    if (rows.length === 0) throw new Error("elections 沒有可用的列");
    electionsCache = { at: Date.now(), rows };
    return rows;
  } catch (err) {
    console.error("[elections] 讀 elections 表失敗，退回舊三屆：", err instanceof Error ? err.message : err);
    return FALLBACK_ELECTIONS.map((e) => ({ ...e }));
  }
}

/**
 * 任務的 target 帶 election_id 時，旁邊補上 election_key（協議 1.65.0：代理可以用任一個指到選舉，補選、重行選舉不是年份，用 key 最清楚）。
 * 只用在回給代理的那份，不動租約用的 target（taskTargetKey 看原樣）。
 */
export function withElectionKey(target: unknown, elections: readonly ElectionLabelRef[]): unknown {
  if (!target || typeof target !== "object" || Array.isArray(target)) return target;
  const t = target as Record<string, unknown>;
  if (typeof t.election_id !== "number" || t.election_key !== undefined) return target;
  const key = elections.find((e) => e.id === t.election_id)?.election_key;
  return key ? { ...t, election_key: key } : target;
}

/** 列印給人看的選舉名稱：優先 short_name，否則「選舉 <id>」（不要把 id 印成年份） */
export function electionLabel(elections: readonly ElectionLabelRef[], id: number | null | undefined): string {
  if (id === null || id === undefined) return "（未指定選舉）";
  const e = elections.find((x) => x.id === id);
  return e?.short_name || e?.election_key || `選舉 ${id}`;
}

export async function loadRegistrationDeadlines(supabase: SupabaseLike): Promise<RegistrationDeadlines> {
  if (deadlinesCache && Date.now() - deadlinesCache.at < CACHE_MS) return deadlinesCache.map;
  try {
    const { data, error } = await supabase
      .from("roster_check_scope")
      .select("election_id, election_type, registration_closed_on")
      .not("registration_closed_on", "is", null)
      .limit(500);
    if (error || !Array.isArray(data)) throw new Error(error?.message ?? "roster_check_scope 讀不到");
    const map = deadlinesFromScope(data as ScopeRow[]);
    deadlinesCache = { at: Date.now(), map };
    return map;
  } catch (err) {
    console.error("[elections] 讀登記截止日失敗，退回舊的後備：", err instanceof Error ? err.message : err);
    return { byElection: { ...FALLBACK_REGISTRATION_DEADLINES }, byElectionType: {} };
  }
}

export interface ScopeRow {
  election_id: number;
  election_type: string;
  registration_closed_on: string | null;
}

/** roster_check_scope 的列 → 各屆（與各屆各職位）的登記截止日 */
export function deadlinesFromScope(rows: readonly ScopeRow[]): RegistrationDeadlines {
  const byElection: Record<number, string> = {};
  const byElectionType: Record<string, string> = {};
  for (const r of rows) {
    if (!r.registration_closed_on) continue;
    const day = String(r.registration_closed_on).slice(0, 10);
    byElectionType[`${r.election_id}:${r.election_type}`] = day;
    if (!byElection[r.election_id] || day < byElection[r.election_id]) byElection[r.election_id] = day;
  }
  return { byElection, byElectionType };
}

/** 某場選舉（某職位）的登記截止日；沒有登記截止日的屆別回 undefined */
export function registrationDeadlineOf(d: RegistrationDeadlines, electionId: number | null | undefined, electionType?: string | null): string | undefined {
  if (electionId === null || electionId === undefined) return undefined;
  return (electionType ? d.byElectionType[`${electionId}:${electionType}`] : undefined) ?? d.byElection[electionId];
}
