/**
 * 政策脈絡（#349，2026-10-06；比照日本站 keifu 的 lineages／handovers，多「同級多人」與「上下級」兩個方向）。
 *
 * 一條脈絡＝一件事在某一層級、某一地方的來龍去脈：
 *   前後任：handovers（接手 keep／轉向 pivot／縮小 shrink／中止 stop／重新開始 resume，與日本站同值）
 *   同級多人：lineage_participants（提案／共同提案／連署／主張推動；官方紀錄 official_record 或本人宣稱 self_claim）
 *   上下級：lineage_links（上級立法或補助 → 下級執行 top_down；下級爭取 → 上級採納 bottom_up）
 * 政見以 policies.lineage_id 掛上來；policies.origin 記政見從哪裡來（照日本站 policy_origin）。
 *
 * SQL 那一份在 migration 20261006034900_policy_lineages.sql（CHECK 約束、派工臂），lineage.test.ts 盯兩邊同一組值。
 * 前端的中文標籤在 lib/lineage.ts，lib/lineage.test.ts 盯它跟這裡一致。
 */

import { sourceKind } from "./source-priority.ts";

type Obj = Record<string, unknown>;

export const LINEAGE_LEVELS = ["national", "county", "township"] as const;
export type LineageLevel = (typeof LINEAGE_LEVELS)[number];
export const LINEAGE_LEVEL_LABEL: Record<LineageLevel, string> = { national: "中央", county: "縣市", township: "鄉鎮市區" };

/** 跟 SQL CHECK（lineages_title_len／lineages_summary_len）同一組數字 */
export const LINEAGE_TITLE_MIN = 4;
export const LINEAGE_TITLE_MAX = 60;
export const LINEAGE_SUMMARY_MAX = 200;
/** lineage 交件的 note：為什麼這些是同一件事 */
export const LINEAGE_NOTE_MIN = 20;
export const LINEAGE_NOTE_MAX = 1000;
/** 一筆最多歸入／拿掉幾條政見 */
export const LINEAGE_MAX_POLICIES = 30;

export const PARTICIPANT_ROLES = ["proposer", "co_proposer", "cosigner", "advocate"] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];
export const PARTICIPANT_ROLE_LABEL: Record<ParticipantRole, string> = {
  proposer: "提案",
  co_proposer: "共同提案",
  cosigner: "連署",
  advocate: "主張推動",
};
export const PARTICIPANT_BASES = ["official_record", "self_claim"] as const;
export type ParticipantBasis = (typeof PARTICIPANT_BASES)[number];
export const PARTICIPANT_BASIS_LABEL: Record<ParticipantBasis, string> = { official_record: "官方紀錄", self_claim: "本人宣稱" };
/** 一筆最多標幾個人（立法院一案的連署人常常二三十位） */
export const MAX_PARTICIPANTS = 50;
export const PARTICIPANT_NOTE_MAX = 200;

export const HANDOVER_TYPES = ["keep", "pivot", "shrink", "stop", "resume"] as const;
export type HandoverType = (typeof HANDOVER_TYPES)[number];
export const HANDOVER_TYPE_LABEL: Record<HandoverType, string> = {
  keep: "接手",
  pivot: "轉向",
  shrink: "縮小",
  stop: "中止",
  resume: "重新開始",
};
/** 要兩台不同機器投過才上線的交接型態（小良哥 10-05：中止要較高票數，比照 merge_politician） */
export const HANDOVER_TWO_IP_TYPES: readonly HandoverType[] = ["stop"];

export const LINK_TYPES = ["top_down", "bottom_up"] as const;
export type LinkType = (typeof LINK_TYPES)[number];
export const LINK_TYPE_LABEL: Record<LinkType, string> = {
  top_down: "上級立法或補助，下級執行",
  bottom_up: "下級爭取，上級採納",
};

/** 交接、關聯的 note（跟 SQL CHECK 同一組數字） */
export const LINK_NOTE_MIN = 20;
export const LINK_NOTE_MAX = 500;
/** 出處的位置（議案編號、頁碼、會議日期與案由；跟 SQL CHECK 同一個上限） */
export const LOCATOR_MAX = 200;

/** 政見從哪裡來（照日本站 policy_origin） */
export const POLICY_ORIGINS = ["pledge", "policy_address", "assembly", "budget"] as const;
export type PolicyOrigin = (typeof POLICY_ORIGINS)[number];
export const POLICY_ORIGIN_LABEL: Record<PolicyOrigin, string> = {
  pledge: "競選承諾",
  policy_address: "施政報告",
  assembly: "議會提案",
  budget: "預算",
};

/** 字元數（跟 SQL char_length 一致） */
export function charLength(s: string): number {
  return [...s].length;
}

/**
 * 讀不到的社群（臉書、IG、Threads）：驗證者與系統都打不開，角色與交接不收它當出處（#349 裁決：臉書讀不到不收）。
 * 跟 source-priority.ts 的 social 等級不同：YouTube、X 至少看得到內容，這裡只擋要登入才看得到的那一族。
 */
export const UNREADABLE_SOCIAL_HOSTS = ["facebook.com", "fb.com", "fb.watch", "instagram.com", "threads.net"] as const;
export function isUnreadableSocial(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    return UNREADABLE_SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** 官方紀錄要附官方網址（立法院、議會、*.gov.tw）——跟門檻用的同一份網域清單 */
export function isOfficialUrl(url: unknown): boolean {
  return typeof url === "string" && sourceKind(url.trim()) === "official";
}

/** 縣市寫法統一成網站用的「台」（regions 的縣市列、lineages.region 都是這個寫法） */
export function normalizeCountyName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const t = name.trim().replace(/臺/g, "台");
  return t || null;
}

export const LEVEL_RANK: Record<LineageLevel, number> = { national: 3, county: 2, township: 1 };

/** 脈絡的地方怎麼念：全國／台中市／台中市大雅區 */
export function lineagePlaceLabel(level: unknown, region: unknown, subRegion: unknown): string {
  if (level === "national") return "全國";
  const r = typeof region === "string" ? region : "";
  const s = level === "township" && typeof subRegion === "string" ? subRegion : "";
  return `${r}${s}` || "（地方未填）";
}

interface LineagePlace { level?: unknown; region?: unknown; sub_region?: unknown; title?: unknown }

/**
 * 上下級關聯的層級對不對：上級要在下級的上一層（中央 → 縣市或鄉鎮；縣市 → 同縣市的鄉鎮）。
 * SQL 觸發器 lineage_links_check_levels 是同一條規則（落庫時擋），這裡在交件前置檢查與落庫前講清楚。
 */
export function linkLevelProblem(upper: LineagePlace, lower: LineagePlace): string | null {
  const u = upper.level as LineageLevel, d = lower.level as LineageLevel;
  if (u === "national" && (d === "county" || d === "township")) return null;
  if (u === "county" && d === "township") {
    return normalizeCountyName(upper.region) === normalizeCountyName(lower.region)
      ? null
      : `上級「${upper.title ?? ""}」是 ${upper.region} 的縣市脈絡，下級「${lower.title ?? ""}」在 ${lower.region}，不是同一個縣市`;
  }
  return `上級「${upper.title ?? ""}」（${LINEAGE_LEVEL_LABEL[u] ?? u}）不在下級「${lower.title ?? ""}」（${LINEAGE_LEVEL_LABEL[d] ?? d}）的上一層：` +
    "中央在縣市與鄉鎮之上、縣市在同縣市的鄉鎮之上；兩條如果其實是同一級，就是同一件事或沒有上下級關係";
}

const trimOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 參與者一項 → 要寫進 lineage_participants 的值（schema 已驗過形狀；source_url 沒給就是這筆交件的第一個來源） */
export interface ParticipantValues {
  politician_id: string;
  role: ParticipantRole;
  basis: ParticipantBasis;
  source_url: string;
  source_locator: string;
  note: string | null;
}
export function participantValues(raw: Obj, sourceUrls: readonly string[]): ParticipantValues {
  return {
    politician_id: String(raw.politician_id),
    role: String(raw.role) as ParticipantRole,
    basis: String(raw.basis) as ParticipantBasis,
    source_url: trimOrNull(raw.source_url) ?? (sourceUrls[0] ?? ""),
    source_locator: String(raw.source_locator ?? "").trim(),
    note: trimOrNull(raw.note),
  };
}

export interface HandoverValues {
  from_politician_id: string;
  from_election_id: number | null;
  to_politician_id: string;
  to_election_id: number | null;
  handover_type: HandoverType;
  decided_on: string | null;
  note: string;
  source_url: string;
  source_locator: string;
}
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
export function handoverValues(p: Obj, sourceUrls: readonly string[]): HandoverValues {
  return {
    from_politician_id: String(p.from_politician_id),
    from_election_id: intOrNull(p.from_election_id),
    to_politician_id: String(p.to_politician_id),
    to_election_id: intOrNull(p.to_election_id),
    handover_type: String(p.handover_type) as HandoverType,
    decided_on: trimOrNull(p.decided_on),
    note: String(p.note ?? "").trim(),
    source_url: trimOrNull(p.source_url) ?? (sourceUrls[0] ?? ""),
    source_locator: String(p.source_locator ?? "").trim(),
  };
}

export interface LinkValues {
  upper_lineage_id: string;
  lower_lineage_id: string;
  link_type: LinkType;
  note: string;
  source_url: string;
  source_locator: string;
}
export function linkValues(p: Obj, sourceUrls: readonly string[]): LinkValues {
  return {
    upper_lineage_id: String(p.upper_lineage_id),
    lower_lineage_id: String(p.lower_lineage_id),
    link_type: String(p.link_type) as LinkType,
    note: String(p.note ?? "").trim(),
    source_url: trimOrNull(p.source_url) ?? (sourceUrls[0] ?? ""),
    source_locator: String(p.source_locator ?? "").trim(),
  };
}

/** 現有那一列跟這次要寫的，哪幾欄不一樣（日期只比日期部分、字串去頭尾空白、空字串當 NULL） */
export function changedLineageFields<T extends object>(current: Obj, next: T, fields: ReadonlyArray<keyof T & string>): Array<keyof T & string> {
  const norm = (v: unknown): unknown => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : v.trim();
    return v;
  };
  return fields.filter((k) => norm(current[k]) !== norm((next as Obj)[k]));
}

export const PARTICIPANT_FIELDS = ["role", "source_url", "source_locator", "note"] as const;
export const HANDOVER_FIELDS = ["handover_type", "decided_on", "note", "source_url", "source_locator"] as const;
export const LINK_FIELDS = ["link_type", "note", "source_url", "source_locator"] as const;

/** 交接給人看的一句話：「王小明 → 林小華：轉向」 */
export function handoverPhrase(h: { handover_type?: unknown; from_name?: unknown; to_name?: unknown }): string {
  const label = HANDOVER_TYPE_LABEL[h.handover_type as HandoverType] ?? String(h.handover_type ?? "?");
  const from = typeof h.from_name === "string" && h.from_name ? h.from_name : "前任";
  const to = typeof h.to_name === "string" && h.to_name ? h.to_name : "後任";
  return `${from} → ${to}：${label}`;
}

/** 參與者給人看的一句話：「共同提案（官方紀錄）」／「提案（本人宣稱）」 */
export function participantPhrase(p: { role?: unknown; basis?: unknown; name?: unknown }): string {
  const role = PARTICIPANT_ROLE_LABEL[p.role as ParticipantRole] ?? String(p.role ?? "?");
  const basis = PARTICIPANT_BASIS_LABEL[p.basis as ParticipantBasis] ?? String(p.basis ?? "?");
  const who = typeof p.name === "string" && p.name ? `${p.name}：` : "";
  return `${who}${role}（${basis}）`;
}

/**
 * 候選清查的任務編號：auto:lineage_candidate:<格的鍵 12 碼>:<清單指紋 8 碼>、auto:lineage_link_candidate:<脈絡 id>:<指紋 8 碼>。
 * no_change confirmed 或交了脈絡／關聯並落庫後，記一列 lineage_candidate_reviews（review_key＝block:<鍵>／link:<id>），
 * 同一份清單就不再派（跟政見重複清查的 policy_dupe_reviews 同一個做法）。
 */
export function parseCandidateTaskId(taskId: unknown): { review_key: string; fingerprint: string; kind: "block" | "link" } | null {
  if (typeof taskId !== "string") return null;
  const block = /^auto:lineage_candidate:([0-9a-f]{12}):([0-9a-f]{8})$/i.exec(taskId);
  if (block) return { review_key: `block:${block[1].toLowerCase()}`, fingerprint: block[2].toLowerCase(), kind: "block" };
  const link = /^auto:lineage_link_candidate:([0-9a-f-]{36}):([0-9a-f]{8})$/i.exec(taskId);
  if (link) return { review_key: `link:${link[1].toLowerCase()}`, fingerprint: link[2].toLowerCase(), kind: "link" };
  return null;
}
