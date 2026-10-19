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
import { hostInList, UNREADABLE_SOCIAL_HOSTS } from "./source-domains.ts";
import { isElectedTerm, taipeiToday } from "./elected-term.ts";

// 今天（台北日期）的取法在最底層那支
export { taipeiToday };

// 清單的單一來源在 source-domains.ts；這裡留著原本的匯出名字，舊的 import 不用改
export { UNREADABLE_SOCIAL_HOSTS };

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
/** 要兩台不同機器投過才上線的交接型態（維護者 10-05：中止要較高票數，比照 merge_politician） */
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
export function isUnreadableSocial(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    return hostInList(host, UNREADABLE_SOCIAL_HOSTS);
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

// ── 脈絡只收「那一屆已投票且當選」的政見（維護者 2026-10-19，協議 1.99.0）──────────────────────────
//
// 「本來就該當選才叫政見啊，這之前叫承諾，這之後叫脈絡」：承諾 → 政見 → 脈絡。選前的是承諾、落選者的也不是政見，都不進脈絡。
// 判斷看**那條政見所屬的那一屆**（policies.election_id）：那一屆已經投票（投票日早於今天），而且提出者在那一屆的參選紀錄是當選
// （candidacy_status＝elected）。不是看這個人現在在不在任——2018 當選、2022 落選的人，2018 那一屆的政見仍然收。
//
// 兩層（#672「承諾→政見」要用同一個條件，不留兩份規則）：
//   底層「那一屆已投票且當選」＝ elected-term.ts 的 isElectedTerm（SQL policy_is_elected_term(政見 id, 今天)，純函式、前端 lib 也可引用）；
//   這裡的脈絡資格建在它上面：先排除找不到、已移除、沒標屆別，再問底層，不通過才分「還沒投票」或「沒當選」。
// SQL 那一份是 migration 20261019020000 的 lineage_policy_ineligible_reason(政見 id)（派工臂、候選格範圍用），這裡是同一條規則的
// TS 鏡像（交件前置檢查、落庫前用）；lineage-elected-only.test.ts 把兩邊放在同一批資料上逐案比對。改規則兩邊一起改。

/** 不合格的原因（跟 SQL 函式回的字串同一組；合格是 null） */
export const LINEAGE_INELIGIBLE_REASONS = ["not_found", "removed", "no_election", "not_voted_yet", "not_elected"] as const;
export type LineageIneligibleReason = (typeof LINEAGE_INELIGIBLE_REASONS)[number];

/** 判斷一條政見資不資格要用到的事實（都是資料庫裡的原值，不先下結論） */
export interface LineageEligibilityFacts {
  /** 政見本身；找不到這條政見給 null */
  policy: { removed_at: string | null; election_id: number | null } | null;
  /** 政見所屬那一屆的投票日（YYYY-MM-DD）；那一屆不存在給 null */
  election_date: string | null;
  /** 提出者在那一屆的每一筆參選紀錄的 candidacy_status（沒有紀錄就是空陣列） */
  candidacy_statuses: ReadonlyArray<string | null>;
}

/**
 * 這條政見能不能進脈絡：不能就回原因、能就回 null。順序跟 SQL 一樣：
 * 找不到 → 已移除 → 沒標屆別（或那一屆不存在）→ 底層 isElectedTerm 通過就合格 → 沒通過：投票日還沒到（當天也算還沒）是「還沒投票」，否則是「沒當選」。
 */
export function lineagePolicyIneligibleReason(f: LineageEligibilityFacts, today: string = taipeiToday()): LineageIneligibleReason | null {
  if (!f.policy) return "not_found";
  if (f.policy.removed_at) return "removed";
  if (f.policy.election_id === null || f.policy.election_id === undefined || !f.election_date) return "no_election";
  if (isElectedTerm({ election_date: f.election_date, candidacy_statuses: f.candidacy_statuses }, today)) return null;
  return f.election_date.slice(0, 10) >= today ? "not_voted_yet" : "not_elected";
}

/** 參選狀態給人看的字（只用在不合格的說明裡；跟 SQL 派工臂的 CASE 同一組） */
export const CANDIDACY_STATUS_LABEL: Record<string, string> = {
  considering: "評估中",
  declared: "表態參選",
  filed: "已登記",
  withdrawn: "退選",
  not_elected: "落選",
  elected: "當選",
};
export const NO_CANDIDACY_LABEL = "沒有這一屆的參選紀錄";

/** 提出者在那一屆的參選狀態，給人看的一句（沒有紀錄也講清楚） */
export function candidacyStatusText(statuses: ReadonlyArray<string | null>): string {
  const labels = [...new Set(statuses.map((s) => (s ? CANDIDACY_STATUS_LABEL[s] ?? s : "狀態未填")))];
  return labels.length > 0 ? labels.join("、") : NO_CANDIDACY_LABEL;
}

/** 不合格的原因講給代理聽：哪一條、為什麼、怎麼辦（交件前置檢查與落庫共用，同一份話） */
export function lineageIneligibleMessage(
  reason: LineageIneligibleReason,
  ctx: { policyId?: string; title?: string | null; electionDate?: string | null; statuses?: ReadonlyArray<string | null> },
): string {
  const which = `政見「${ctx.title ?? ctx.policyId ?? "?"}」`;
  const date = ctx.electionDate ? ctx.electionDate.slice(0, 10) : null;
  const rule = "脈絡只收那一屆已投票且當選的人提的政見（選前叫承諾、當選後才叫政見，政見串起來才叫脈絡）";
  switch (reason) {
    case "not_found": return `找不到${which}`;
    case "removed": return `${which}已被移除，不歸入脈絡`;
    case "no_election": return `${which}沒有記是哪一屆的，判斷不了它在不在資格內；${rule}，請先用 correction 補上它的 election_id`;
    case "not_voted_yet": return `${which}屬於${date ? ` ${date} ` : ""}投票的那一屆，還沒投票，現在還是承諾、不是政見；${rule}，等開票、他當選之後才能歸入`;
    case "not_elected": return `${which}屬於${date ? ` ${date} ` : ""}投票的那一屆，提出者在那一屆沒有當選（參選紀錄：${candidacyStatusText(ctx.statuses ?? [])}）；${rule}，落選者的承諾不收`;
  }
}

// ── 同一人同一屆的多條政見不是脈絡（維護者 2026-10-19 檢討後追加，同一個協議版 1.99.0）─────────────────────────
//
// 脈絡串的是**跨人**（同級多人、前後任）或**跨屆**（承諾當選後的延續）的政見。同一位政治人物在同一屆提的多條政見講同一件事，
// 那是重複政見，走重複清查（duplicate_policy），不是脈絡（例：澎湖「城市色彩」那條是陳佩真自己 2026 的 3 條承諾）。
// 建新脈絡：政見（兩條以上）全都是同一人同一屆 → 擋；歸入既有脈絡：加入、拿掉之後整條脈絡不能只剩同一人同一屆。
// 中央層級建新脈絡原本允許只有 1 條，照舊（一條政見談不上「全都是同一人同一屆」，這條規則只管兩條以上）。

/** 判斷「同一人同一屆」要用到的欄位（policies 表的原值；沒有就是不知道，不下結論） */
export interface LineageOwnedPolicy {
  id: string;
  title?: string | null;
  politician_id?: string | null;
  election_id?: number | null;
}

/** 兩條以上（id 不重複）的政見，而且全都是同一位政治人物在同一屆提的。人物或屆別有一條不知道就不算（不知道的另有資格判斷擋）。 */
export function isSamePersonSameTerm(policies: ReadonlyArray<LineageOwnedPolicy>): boolean {
  const byId = new Map<string, LineageOwnedPolicy>();
  for (const p of policies) byId.set(String(p.id).toLowerCase(), p);
  if (byId.size < 2) return false;
  const all = [...byId.values()];
  const person = typeof all[0].politician_id === "string" && all[0].politician_id ? all[0].politician_id.toLowerCase() : null;
  const term = typeof all[0].election_id === "number" ? all[0].election_id : null;
  if (person === null || term === null) return false;
  return all.every((p) => typeof p.politician_id === "string" && p.politician_id.toLowerCase() === person && p.election_id === term);
}

/** 同一人同一屆的說明，講給代理聽：不是脈絡、是重複政見、改走哪裡 */
export function lineageSamePersonMessage(policies: ReadonlyArray<LineageOwnedPolicy>): string {
  const titles = [...new Map(policies.map((p) => [String(p.id).toLowerCase(), p.title ?? p.id])).values()].slice(0, 6).map((t) => `「${t}」`).join("、");
  return `這些政見（${titles}）都是同一位政治人物在同一屆提的：同一個人同一屆的多條政見講同一件事，是重複政見、不是脈絡——請走重複清查（duplicate_policy 任務，用 removal 或 correction 處理重複）；` +
    "脈絡串的是跨人（同級多人、前後任）或跨屆（承諾當選後的延續）的政見，加入之後整條脈絡不能只剩同一人同一屆的政見";
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
