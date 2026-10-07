/**
 * 查證來源清單（verification_sources 表）：純函式（比對／排序／轉 Markdown／給任務附上的精簡版）
 * 與碰 DB 的快取撈取分開，見 docs/DECISIONS.md 2026-09-28。
 *
 * 用途：
 *   1. `sources` 端點：GET ?party=&region=&election_type=&need=&format=md|json（無金鑰、公開讀）
 *   2. `_shared/task-context.ts`：派工時依人物的政黨／縣市／選舉別、任務要查的東西自動附上
 */

import { ALL_REGIONS, normalizeCityName } from "./cec-city-codes.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export interface VerificationSource {
  id: number;
  name: string;
  kind: "party" | "council" | "government" | "cec" | "media" | string;
  party: string | null;
  regions: string[] | null;
  election_types: string[] | null;
  provides: string[];
  list_url: string | null;
  detail_url_pattern: string | null;
  access: "html" | "js" | "json" | "pdf" | string;
  quality_note: string | null;
  how_to: string | null;
  last_checked: string | null;
  status: "ok" | "down" | string;
  sort: number;
}

export interface SourceQuery {
  party?: string | null;
  region?: string | null;
  electionType?: string | null;
  need?: readonly string[] | null;
}

export const KIND_LABELS: Record<string, string> = {
  party: "政黨",
  council: "議會",
  government: "政府",
  cec: "中選會",
  media: "媒體",
};

export const PROVIDES_LABELS: Record<string, string> = {
  photo: "照片",
  education: "學歷",
  experience: "經歷",
  district: "選區",
  policy: "政見",
  birth_year: "出生年",
  candidacy: "參選紀錄",
  roster: "名冊",
};

/** 純量欄位（如 party）：query 沒給值就不篩；來源該欄位是 null（不分）或跟 query 一樣才算符合 */
function scalarMatches(sourceValue: string | null, queryValue: string | null | undefined): boolean {
  if (!queryValue) return true;
  return sourceValue === null || sourceValue === queryValue;
}

/**
 * 縣市比對用的 key（2026-10-08）：臺→台，而且「台北市松山區」這種縣市＋鄉鎮市區的 region（村里長任務 target.region）
 * 取出縣市前綴；不是縣市開頭的字串原樣回傳。以前是純字串比對：村里長任務的 region 是「台北市松山區」，
 * 永遠比不到 verification_sources.regions（縣市清單）；正式庫也有 3 筆任務 target、2 筆交件寫「臺」。
 */
export function countyKey(region: string): string {
  const n = (normalizeCityName(region) ?? region).trim();
  return ALL_REGIONS.find((c) => n.startsWith(c)) ?? n;
}

/** 陣列欄位（regions／election_types）：query 沒給值就不篩；來源該欄位是 null（全部）或陣列包含 query 值才算符合；key 是比對前的正規化 */
function arrayMatches(sourceValues: string[] | null, queryValue: string | null | undefined, key: (s: string) => string = (s) => s): boolean {
  if (!queryValue) return true;
  return sourceValues === null || sourceValues.some((v) => key(v) === key(queryValue));
}

/** need 沒給就全部符合；有給就要跟 provides 有交集 */
function needMatches(provides: readonly string[], need: readonly string[] | null | undefined): boolean {
  if (!need || need.length === 0) return true;
  return provides.some((p) => need.includes(p));
}

/** 單筆是否符合查詢條件（party 相符或 null、regions 包含或 null、election_types 包含或 null、need 有交集） */
export function sourceMatches(source: VerificationSource, q: SourceQuery): boolean {
  return scalarMatches(source.party, q.party)
    && arrayMatches(source.regions, q.region, countyKey)
    && arrayMatches(source.election_types, q.electionType)
    && needMatches(source.provides, q.need);
}

export function matchSources(sources: readonly VerificationSource[], q: SourceQuery): VerificationSource[] {
  return sources.filter((s) => sourceMatches(s, q));
}

/** status=down 的排最後；同一種 status 內照 sort 遞增排序 */
export function sortSources(sources: readonly VerificationSource[]): VerificationSource[] {
  return [...sources].sort((a, b) => {
    const aDown = a.status === "down" ? 1 : 0;
    const bDown = b.status === "down" ? 1 : 0;
    if (aDown !== bDown) return aDown - bDown;
    return a.sort - b.sort;
  });
}

/** 依查詢條件篩選＋排序（down 最後） */
export function queryVerificationSources(sources: readonly VerificationSource[], q: SourceQuery): VerificationSource[] {
  return sortSources(matchSources(sources, q));
}

function fmtList(values: string[] | null, fallback: string, labels?: Record<string, string>): string {
  if (values === null) return fallback;
  if (values.length === 0) return "（無）";
  return values.map((v) => labels?.[v] ?? v).join("、");
}

/** 給人看、也給代理讀的 Markdown（GET /sources?format=md）；依 kind 分組 */
export function sourcesToMarkdown(sources: readonly VerificationSource[]): string {
  const lines: string[] = ["# 查證來源清單", ""];
  const byKind = new Map<string, VerificationSource[]>();
  for (const s of sources) {
    const list = byKind.get(s.kind) ?? [];
    list.push(s);
    byKind.set(s.kind, list);
  }
  for (const [kind, list] of byKind) {
    lines.push(`## ${KIND_LABELS[kind] ?? kind}`, "");
    for (const s of list) {
      const downTag = s.status === "down" ? "（目前打不開）" : "";
      lines.push(`### ${s.name}${downTag}`);
      if (s.party) lines.push(`- 政黨：${s.party}`);
      lines.push(`- 適用縣市：${fmtList(s.regions, "全國")}`);
      lines.push(`- 適用選舉別：${fmtList(s.election_types, "全部")}`);
      lines.push(`- 能查：${fmtList(s.provides, "（無）", PROVIDES_LABELS)}`);
      if (s.list_url) lines.push(`- 列表頁：${s.list_url}`);
      if (s.detail_url_pattern) lines.push(`- 個人頁格式：${s.detail_url_pattern}`);
      if (s.how_to) lines.push(`- 怎麼查：${s.how_to}`);
      if (s.quality_note) lines.push(`- 品質說明：${s.quality_note}`);
      if (s.last_checked) lines.push(`- 最後確認：${s.last_checked}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** 派工時附給代理的精簡版 */
export interface TaskSourceHint {
  name: string;
  url: string | null;
  provides: string[];
  how_to: string | null;
  quality_note: string | null;
}

/** 有個人頁格式就給格式，沒有就給列表頁 */
function toTaskHint(source: VerificationSource): TaskSourceHint {
  return {
    name: source.name,
    url: source.detail_url_pattern ?? source.list_url ?? null,
    provides: source.provides,
    how_to: source.how_to,
    quality_note: source.quality_note,
  };
}

export const MAX_TASK_SOURCES = 6;

/** 任務要查的東西 → 派工時要帶哪幾種 provides；沒登記過的任務型別用預設值 */
export const TASK_SOURCE_NEEDS: Record<string, readonly string[]> = {
  profile_gap: ["photo", "education", "experience", "birth_year"],
  policy_missing: ["policy"],
  term_policy_missing: ["policy"],
  profile_detail_gap: ["education", "experience"],
  candidacy_source_missing: ["candidacy", "district"],
  candidate_status_stale: ["candidacy"],
  not_running_recheck: ["candidacy"],
  roster_check: ["candidacy", "district", "roster"],
  // 政見三要素要的是政見原文；期限到了查進度也是從政見那一頁找起（#364）
  policy_elements_missing: ["policy"],
  deadline_due: ["policy"],
  // 政策脈絡（#349）：同一件事要看政見原文；交接、上下級要看施政與預算；角色要看議事紀錄
  lineage_candidate: ["policy"],
  handover_missing: ["policy"],
  lineage_roles_missing: ["policy"],
  lineage_link_candidate: ["policy"],
};

/** 沒特別登記的任務型別（含手動任務）預設要的東西：不知道具體要查什麼，給最常用的一組 */
export const DEFAULT_TASK_SOURCE_NEED: readonly string[] = ["photo", "education", "experience", "district", "policy"];

export function needsForTask(taskType: string): readonly string[] {
  return TASK_SOURCE_NEEDS[taskType] ?? DEFAULT_TASK_SOURCE_NEED;
}

/** 依任務對象篩出最多 MAX_TASK_SOURCES 筆，轉成派工用的精簡形狀 */
export function sourcesForTask(sources: readonly VerificationSource[], q: SourceQuery, limit = MAX_TASK_SOURCES): TaskSourceHint[] {
  return queryVerificationSources(sources, q).slice(0, limit).map(toTaskHint);
}

// ── 碰 DB：撈全部來源，記憶體快取幾分鐘（表很小，不必每次派工都查一次） ──────────

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { at: number; rows: VerificationSource[] } | null = null;

/** 測試用：清快取，不然測試之間會互相汙染 */
export function resetVerificationSourcesCache(): void {
  cached = null;
}

export async function fetchVerificationSources(supabase: SupabaseLike): Promise<VerificationSource[]> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;
  const { data, error } = await supabase.from("verification_sources").select("*")
    .order("sort", { ascending: true }).limit(500);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as VerificationSource[];
  cached = { at: Date.now(), rows };
  return rows;
}

/**
 * 驗證項目要附哪些查證來源（2026-09-29）：原本只有任務會附，驗證者投票時看不到——
 * 苗栗縣議員那批 candidacy 一小時 28 張「無法判斷」，都說「官方名冊 11/17 才公布」，其實登記彙總表早就在。
 * 回 null＝這種貢獻不附（更正、移除等要查的東西不固定，附了反而誤導）。
 */
export function verifySourceQuery(contributionType: string, payload: Record<string, unknown>, politician?: Record<string, unknown> | null): SourceQuery | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const region = str(payload.region) ?? str(politician?.region);
  const party = str(payload.party) ?? str(politician?.party);
  if (contributionType === "candidacy") return { region, party, electionType: str(payload.election_type), need: ["candidacy", "district", "roster"] };
  if (contributionType === "politician") return { region, party, electionType: str(payload.election_type), need: DEFAULT_TASK_SOURCE_NEED };
  if (contributionType === "policy") return { region, party, need: ["policy"] };
  return null;
}
