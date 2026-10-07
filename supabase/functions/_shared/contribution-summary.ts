/**
 * 貢獻看板用：把 contribution 轉成「安全摘要」——一句人話＋目標連結，不回 ip_hash、不回長文（截 200 字）。
 * 純函式，可測。
 */

import { siteUrl } from "./site.ts";
export const SUMMARY_TEXT_LIMIT = 200;

/** 貢獻榜最多列幾名 */
export const LEADERBOARD_SIZE = 30;

/**
 * 貢獻榜的分數：提交 ＋ 上線 ＋ 驗證票三項相加。
 *
 * 原本只按 applied 排，結果是「做最多的人排在後面」——交了 44 筆、投了 22 票的人
 * 因為那 44 筆全卡在待驗證（沒人能驗），分數是 0，排在一個「交 2 筆上線 1 筆」的
 * 測試代號後面。那個排法量的不是貢獻多寡，是運氣好不好被核對到。
 *
 * applied 是 submitted 的子集，所以通過驗證的那幾筆實際上算兩次——這是刻意的：
 * 查證品質好、被同儕認可的貢獻本來就該比單純的量更值錢。驗證別人的資料也算分，
 * 因為這個平台目前最缺的就是願意花額度去核對別人的人。
 */
export function leaderboardScore(v: { submitted: number; applied: number; verified_votes: number }): number {
  return v.submitted + v.applied + v.verified_votes;
}

/**
 * 不列入貢獻榜與「近 30 天貢獻者」的代號：維護者自己開的測試與探測代理。
 *
 * **線上的真相是資料庫的 excluded_agents 表**（2026-10-07，盤點 #5；contribution_leaderboard、contribution_feed_summary
 * 讀它，要加新的測試代號就 INSERT 一列、不用發版）。這份是 TS 參考實作（buildLeaderboard／buildFeedSummary，只有測試在用，
 * 線上走 SQL）的預設值，等於 migration 20261008000010 的種子；excluded-agents.test.ts 對照所有 migration 的 INSERT，不一致就紅。
 * 它們交的資料是真的（有幾筆已通過驗證上線，那些不動），但它們不是外部參與者，
 * 留在榜上會把參與程度講得比實際好看——這個站的重點就是數字不能說謊。
 *
 * 刻意明列而不是用 `test-`／`xiaoliang-` 前綴：前綴會誤殺未來真的這樣取名的
 * 貢獻者，而且從程式碼看不出到底排除了誰。加新的測試代號時要記得補進來。
 */
export const EXCLUDED_AGENTS: ReadonlySet<string> = new Set([
  // 2026-09-11 盲測協議用的多方代理
  "test-deepseek",
  "test-deepseek-1",
  "test-deepseek-2",
  "test-deepseek-3",
  "test-deepseek-4",
  "test-deepseek-5",
  "test-claude",
  "test-gemini",
  // 2026-09-12 驗證派工／清查流程時的探測代號（送出的貢獻都已退件）
  "xiaoliang-roster",
  "xiaoliang-probe",
]);
import { normalizeCorrection } from "./correction.ts";
import { electionResultLabel } from "./candidacy-result.ts";
import { resultItems, resultsUnitLabel } from "./election-results.ts";
import { elementPhrase } from "./policy-elements.ts";
import { HANDOVER_TYPE_LABEL, lineagePlaceLabel, LINK_TYPE_LABEL, PARTICIPANT_BASIS_LABEL, participantPhrase } from "./lineage.ts";

type Obj = Record<string, unknown>;

const CANDIDATE_STATUS_LABEL: Record<string, string> = {
  rumored: "傳聞", likely: "可能參選", confirmed: "表態參選", registered: "已登記", qualified: "審定合格",
  withdrawn: "退選", not_running: "不參選", elected: "當選", defeated: "落選",
};
const POLICY_STATUS_LABEL: Record<string, string> = {
  "Campaign Pledge": "競選承諾", Proposed: "提出", "In Progress": "進行中", Achieved: "已實現", Stalled: "滯後", Failed: "未達成",
};
const TABLE_LABEL: Record<string, string> = { politicians: "政治人物", politician_elections: "參選紀錄", policies: "政見", politician_offices: "任期" };
const FIELD_LABEL: Record<string, string> = {
  name: "姓名", party: "政黨", birth_year: "出生年", current_position: "現職", region: "縣市", sub_region: "選區", education_level: "學歷",
  bio: "簡介", avatar_url: "照片", candidate_status: "參選狀態", position: "職位", election_type: "選舉類型", title: "標題",
  description: "內容", category: "分類", status: "狀態", proposed_date: "提出日", election_id: "所屬選舉", source_url: "來源網址",
  end_date: "卸任日", end_reason: "卸任原因", withdrawn_after_filing: "退選前有沒有登記",
};
/** 退選前有沒有登記（#345 後續）的值：網站上的說法 */
const WITHDRAWN_AFTER_FILING_LABEL: Record<string, string> = { true: "登記後退選", false: "表態不參選（沒登記過）" };

export function clip(value: unknown, limit = SUMMARY_TEXT_LIMIT): string {
  const s = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v));

export interface ContributionSummary {
  summary: string;
  target_name: string | null;
  politician_id: string | null;
  policy_id: string | null;
  politician_url: string | null;
  policy_url: string | null;
}

export interface SummaryInput {
  contribution_type: string;
  payload: unknown;
  applied_politician_id?: string | null;
  applied_policy_id?: string | null;
}

export function summarizeContribution(input: SummaryInput): ContributionSummary {
  const p = (input.payload && typeof input.payload === "object" ? input.payload : {}) as Obj;
  const name = str(p.name);
  const politicianId = input.applied_politician_id ?? (typeof p.politician_id === "string" ? p.politician_id : null);
  const policyId = input.applied_policy_id ?? (typeof p.policy_id === "string" ? p.policy_id : null);
  let summary: string;
  let targetName: string | null = name || null;

  switch (input.contribution_type) {
    case "politician": {
      const fields = ["party", "region", "current_position", "birth_year", "education_level", "bio", "avatar_url", "slogan"].filter((k) => p[k] !== undefined && p[k] !== null && p[k] !== "");
      summary = fields.length > 0
        ? `為「${name || "（未填姓名）"}」補基本資料：${fields.map((k) => FIELD_LABEL[k] ?? k).join("、")}`
        : `新增政治人物「${name || "（未填姓名）"}」`;
      break;
    }
    case "candidacy": {
      const status = CANDIDATE_STATUS_LABEL[str(p.candidate_status)] ?? str(p.candidate_status);
      const result = electionResultLabel(p);
      // 帶選舉結果的（election_result_missing 的答案）重點是結果，不是「狀態改成確認參選」——那多半沒變
      summary = result
        ? `補 ${name || "（未填姓名）"} ${str(p.election_id)} ${str(p.region)}${str(p.election_type)}選舉結果：${result}`
        : `將 ${name || "（未填姓名）"} ${str(p.election_id)} ${str(p.region)}${str(p.election_type)}參選狀態改為「${status}」`;
      break;
    }
    case "policy": {
      // 代理可以只帶 politician_id。呼叫端（contributions-feed）會先把 id 換成姓名；
      // 真的換不到時退成 id 前八碼，至少讀者點得到那個人，不要只印一個空括號。
      const who = name || (politicianId ? `政治人物 ${politicianId.slice(0, 8)}` : "未指名的政治人物");
      summary = `為「${who}」新增政見：${clip(p.title, 80)}`;
      break;
    }
    case "policy_progress": {
      const status = POLICY_STATUS_LABEL[str(p.status)] ?? str(p.status);
      const title = str(p.policy_title) || (policyId ? `政見 ${policyId.slice(0, 8)}` : "政見");
      const progress = typeof p.progress === "number" ? `（${p.progress}%）` : "";
      summary = `更新「${clip(title, 60)}」進度為「${status}」${progress}：${clip(p.note, 80)}`;
      targetName = str(p.policy_title) || name || null;
      break;
    }
    case "policy_elements": {
      // 政見三要素（#364）：讀者要看得出拆了哪條政見、每個要素原文有沒有寫
      const title = str(p.policy_title) || (policyId ? `政見 ${policyId.slice(0, 8)}` : "政見");
      const parts = (Array.isArray(p.elements) ? p.elements : [])
        .filter((e): e is Obj => !!e && typeof e === "object")
        .map((e) => elementPhrase(e, 30));
      summary = `為「${clip(title, 60)}」拆政見三要素：${parts.join("；") || "（沒有要素）"}`;
      targetName = str(p.policy_title) || null;
      break;
    }
    case "correction": {
      const table = TABLE_LABEL[str(p.target_table)] ?? str(p.target_table);
      const id = str(p.target_id);
      // 標題／姓名優先，沒有才退回 id 前八碼（2026-09-17：「把政見 1b808b02 的…」
      // 這種畫面對讀者毫無意義）。呼叫端會先把 target_id 換成標題塞進 payload。
      const targetLabel = str(p.target_table) === "policies"
        ? str(p.policy_title)
        : str(p.target_table) === "politicians"
        ? str(p.name)
        // 參選紀錄的列 id（9827）對讀者沒有意義，呼叫端會查成「某某某 2026 縣市議員」
        : str(p.target_label);
      // 沒有標題時維持舊格式「政見 abcdef12 的…」，那個空白是格式的一部分
      const what = targetLabel ? `${table}「${clip(targetLabel, 40)}」` : `${table} ${id.slice(0, 8)} `;
      // 值也要看得懂：candidate_status／status 是固定 enum，翻成中文；其餘照原樣印
      const valueLabel = (field: string, v: unknown): string => {
        const raw = clip(v, 80);
        if (field === "candidate_status") return CANDIDATE_STATUS_LABEL[raw] ?? raw;
        if (field === "status") return POLICY_STATUS_LABEL[raw] ?? raw;
        if (field === "withdrawn_after_filing") return WITHDRAWN_AFTER_FILING_LABEL[raw] ?? raw;
        return raw;
      };
      const { changes } = normalizeCorrection(p);
      summary = changes.length <= 1
        ? `把${what}的${FIELD_LABEL[changes[0]?.field ?? ""] ?? changes[0]?.field ?? "?"}改為「${valueLabel(changes[0]?.field ?? "", changes[0]?.correct_value)}」`
        : `更正${what}的 ${changes.length} 個欄位：${changes.map((c) => `${FIELD_LABEL[c.field] ?? c.field}→「${valueLabel(c.field, c.correct_value)}」`).join("、")}`;
      targetName = null;
      if (str(p.target_table) === "politicians") return finish(summary, targetName, id || null, null);
      if (str(p.target_table) === "policies") return finish(summary, targetName, null, id || null);
      break;
    }
    case "adjudication": {
      // 裁決是對別人那筆貢獻的定奪，讀者要看得出是支持還是推翻，以及依據
      const verdict = str(p.verdict) === "uphold" ? "認為原貢獻正確" : str(p.verdict) === "reject" ? "認為原貢獻有誤" : "裁決";
      const cid = str(p.contribution_id).slice(0, 8);
      summary = `裁決貢獻 ${cid}：${verdict}${str(p.reason) ? `——${clip(p.reason, 100)}` : ""}`;
      targetName = null;
      break;
    }
    case "task_suggestion": {
      summary = `提議一項任務：${clip(p.title, 80)}`;
      targetName = null;
      break;
    }
    case "no_change": {
      // 「核對過、沒有要改」本身就是有價值的回報，讀者要看得出核對了什麼
      const note = clip(p.note, 120);
      summary = note ? `核對後回報沒有異動：${note}` : "核對後回報沒有異動";
      targetName = null;
      break;
    }
    case "roster_check": {
      const cec = typeof p.cec_count === "number" ? `${p.cec_count} 人` : "查不到";
      summary = `清查 ${str(p.region)} ${str(p.election_id)} ${str(p.election_type)} 名單：中選會 ${cec}、我們 ${typeof p.ours_count === "number" ? `${p.ours_count} 人` : "?"}、另補 ${typeof p.submitted === "number" ? p.submitted : 0} 筆`;
      targetName = null;
      break;
    }
    // 政策脈絡（#349）：讀者要看得出建了／歸入了哪條脈絡、標了誰的角色、記了哪一段交接或關聯
    case "lineage": {
      const nl = (p.new_lineage && typeof p.new_lineage === "object" ? p.new_lineage : null) as Obj | null;
      const n = Array.isArray(p.policy_ids) ? p.policy_ids.length : 0;
      const d = Array.isArray(p.detach_policy_ids) ? p.detach_policy_ids.length : 0;
      const parts = [n > 0 ? `歸入 ${n} 條政見` : "", d > 0 ? `拿掉 ${d} 條政見` : "", !nl && (p.title || p.summary || p.category) ? "更正脈絡內容" : ""].filter(Boolean);
      summary = nl
        ? `建立政策脈絡「${clip(nl.title, 60)}」（${lineagePlaceLabel(nl.level, nl.region, nl.sub_region)}）並${parts.join("、") || "歸入政見"}`
        : `政策脈絡 ${str(p.lineage_id).slice(0, 8)}：${parts.join("、") || "（沒有動作）"}`;
      targetName = nl ? str(nl.title) || null : null;
      break;
    }
    case "lineage_participants": {
      const items = Array.isArray(p.participants) ? (p.participants as unknown[]).filter((e): e is Obj => !!e && typeof e === "object") : [];
      const roles = items.slice(0, 3).map((e) => e.remove === true ? `拿掉一項${PARTICIPANT_BASIS_LABEL[str(e.basis) as keyof typeof PARTICIPANT_BASIS_LABEL] ?? ""}角色` : participantPhrase(e));
      summary = `為政策脈絡 ${str(p.lineage_id).slice(0, 8)} 標參與角色 ${items.length} 項：${roles.join("、")}${items.length > 3 ? "…" : ""}`;
      targetName = null;
      break;
    }
    case "lineage_handover": {
      const label = HANDOVER_TYPE_LABEL[str(p.handover_type) as keyof typeof HANDOVER_TYPE_LABEL] ?? str(p.handover_type);
      summary = `記政策脈絡 ${str(p.lineage_id).slice(0, 8)} 的交接：${label}——${clip(p.note, 80)}`;
      targetName = null;
      break;
    }
    case "lineage_link": {
      const label = LINK_TYPE_LABEL[str(p.link_type) as keyof typeof LINK_TYPE_LABEL] ?? str(p.link_type);
      summary = `記政策脈絡的上下級關聯（${label}）：${str(p.upper_lineage_id).slice(0, 8)} → ${str(p.lower_lineage_id).slice(0, 8)}——${clip(p.note, 60)}`;
      targetName = null;
      break;
    }
    case "party_info": {
      // 政黨資訊（#346 第二階段）：讀者要看得出補了哪個政黨的哪一欄
      const items = (Array.isArray(p.parties) ? p.parties : []).filter((it): it is Obj => !!it && typeof it === "object");
      const what = (it: Obj) => [
        it.valid_from ? `名稱起始日 ${str(it.valid_from)}` : "",
        it.valid_to ? `名稱停用日 ${str(it.valid_to)}` : "",
        it.predecessor_id ? `前身是政黨 ${str(it.predecessor_id)}` : "",
      ].filter(Boolean).join("、");
      summary = `補政黨資訊：${items.map((it) => `政黨 ${str(it.party_id)}（${what(it)}）`).join("；") || "（沒有政黨）"}`;
      targetName = null;
      break;
    }
    case "district_seats": {
      const ds = Array.isArray(p.districts) ? (p.districts as Array<Record<string, unknown>>) : [];
      const total = ds.reduce((n, d) => n + (typeof d.seats === "number" ? d.seats : 0), 0);
      summary = `補 ${str(p.region)} ${str(p.election_id)} ${str(p.election_type)} 應選名額：${ds.length} 個選舉區、共 ${total} 席`;
      targetName = null;
      break;
    }
    case "reassign_candidacy": {
      const to = p.to_politician_id ? `既有的 ${str(p.to_politician_id).slice(0, 8)}` : `新建的「${clip((p.new_politician as Obj | undefined)?.name, 30)}」`;
      summary = `參選紀錄 ${str(p.politician_election_id)} 改掛到${to}：${clip(p.reason, 100)}`;
      targetName = null;
      break;
    }
    case "election_results": {
      const items = resultItems(p);
      const elected = items.filter((it) => it.election_result === "elected").length;
      summary = `補 ${resultsUnitLabel(p)} 的選舉結果：${items.length} 位（當選 ${elected}、落選 ${items.length - elected}）`;
      targetName = null;
      break;
    }
    case "merge_politician": {
      const keep = str(p.keep_id).slice(0, 8), remove = str(p.remove_id).slice(0, 8);
      summary = p.same_person === false
        ? `判定人物 ${keep} 與 ${remove} 不是同一人：${clip(p.reason, 100)}`
        : `合併同名人物：${remove} 併入 ${keep}：${clip(p.reason, 100)}`;
      targetName = null;
      break;
    }
    case "removal": {
      // 移除是「這筆不該存在」，讀者最需要看到的是理由，不是 id
      const table = TABLE_LABEL[str(p.target_table)] ?? str(p.target_table);
      const id = str(p.target_id);
      summary = `建議移除${table} ${id.slice(0, 8)}：${clip(p.reason, 120)}`;
      targetName = null;
      if (str(p.target_table) === "policies") return finish(summary, targetName, null, id || null);
      if (str(p.target_table) === "politicians") return finish(summary, targetName, id || null, null);
      break;
    }
    case "question_answer": {
      summary = `回答公民提問：${clip(p.answer, 120)}`;
      targetName = null;
      break;
    }
    default:
      summary = `（${input.contribution_type}）`;
  }
  return finish(summary, targetName, politicianId, policyId);
}

function finish(summary: string, targetName: string | null, politicianId: string | null, policyId: string | null): ContributionSummary {
  return {
    summary: clip(summary),
    target_name: targetName,
    politician_id: politicianId,
    policy_id: policyId,
    politician_url: politicianId ? `${siteUrl()}/politician/${politicianId}` : null,
    policy_url: policyId ? `${siteUrl()}/policy/${policyId}` : null,
  };
}

/** payload 的安全版本：長文截 200、不含任何雜湊 */
export function safePayload(payload: unknown): Obj {
  const p = (payload && typeof payload === "object" ? payload : {}) as Obj;
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? clip(v) : Array.isArray(v) ? v.slice(0, 20).map((x) => (typeof x === "string" ? clip(x, 100) : x)) : v]));
}

// ---- 看板 summary（純函式，feed 端點呼叫）----

/** 需要維護者處理的狀態只有一種：disputed（2 票反對、身份指認衝突、或連續 3 次落庫失敗） */
export const ATTENTION_STATUSES = ["disputed"] as const;
export const CONTRIBUTORS_WINDOW_DAYS = 30;
/** 看板每日統計用台灣時間分日（UTC+8，沒有夏令時間）；原本切 UTC 日期，早上 8 點前的會算到前一天 */
const TAIWAN_OFFSET_MS = 8 * 3600 * 1000;
export function taiwanDate(ms: number): string {
  return new Date(ms + TAIWAN_OFFSET_MS).toISOString().slice(0, 10);
}

export interface SummaryRow { status: string; agent_name: string | null; created_at: string }
export interface VoteRow { agent_name: string | null; created_at?: string | null }

/** 貢獻榜的時間窗：總榜（null）／近 30 天／近 7 天 */
export const LEADERBOARD_WINDOWS = { all: null, d30: 30, d7: 7 } as const;
export type LeaderboardEntry = { agent_name: string; submitted: number; applied: number; verified_votes: number; score: number };

export interface FeedSummary {
  total: number;
  by_status: Record<string, number>;
  needs_attention: { total: number; disputed: number; retrying: number };
  /** open 的裁決任務數（disputed 的貢獻正由更多代理用 3 票決定；不是人工待辦） */
  adjudicating: number;
  contributors_30d: number;
  /** 有提交過的不重複代號（全部時間、不含測試代號）。規則跟 contributors_30d 相同，只是不限時間 */
  contributors_total: number;
  /** 近 7 日（台灣日期）：count＝新提交筆數（欄位名保留，外部有東西在讀）、verifications＝驗證票數 */
  daily_last_7: Array<{ date: string; count: number; verifications: number }>;
  /** 總榜（全部時間）。欄位名保留不動：外部有東西在讀它。 */
  leaderboard: LeaderboardEntry[];
  /** 近 30 天 */
  leaderboard_30d: LeaderboardEntry[];
  /** 近 7 天 */
  leaderboard_7d: LeaderboardEntry[];
}

/**
 * 算一張貢獻榜。windowDays 給 null＝總榜；給數字＝只算那幾天內的貢獻與票。
 *
 * 時間窗看的是「這筆貢獻／這張票是什麼時候發生的」，不是它現在什麼狀態。
 * 所以一筆三週前提交、昨天才通過驗證的貢獻，不會出現在 7 天榜裡——
 * 榜量的是這段期間做了多少事，不是這段期間有多少東西剛好落庫。
 *
 * 票沒有 created_at 時（舊資料或呼叫端沒撈）一律算進總榜、不算進任何時間窗，
 * 寧可少算也不要把時間不明的票塞進本週。
 */
export function buildLeaderboard(
  rows: readonly SummaryRow[],
  votes: readonly VoteRow[],
  windowDays: number | null,
  now: number = Date.now(),
  excluded: ReadonlySet<string> = EXCLUDED_AGENTS,
): LeaderboardEntry[] {
  const since = windowDays === null ? null : now - windowDays * 86400 * 1000;
  const inWindow = (iso: string | null | undefined): boolean => {
    if (since === null) return true;
    if (!iso) return false;
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t >= since;
  };
  const agentOf = (r: { agent_name: string | null }) => (r.agent_name && r.agent_name.trim()) || "(unknown)";
  const byAgent = new Map<string, { submitted: number; applied: number; verified_votes: number }>();
  const bump = (name: string) => {
    const a = byAgent.get(name) ?? { submitted: 0, applied: 0, verified_votes: 0 };
    byAgent.set(name, a);
    return a;
  };
  for (const r of rows) {
    if (!inWindow(r.created_at)) continue;
    const a = bump(agentOf(r));
    a.submitted++;
    if (r.status === "applied") a.applied++;
  }
  for (const v of votes) {
    if (!inWindow(v.created_at)) continue;
    bump(agentOf(v)).verified_votes++;
  }
  return [...byAgent.entries()]
    .filter(([agent_name]) => !excluded.has(agent_name))
    .map(([agent_name, v]) => ({ agent_name, ...v, score: leaderboardScore(v) }))
    // 同分時先看上線、再看提交，讓名次穩定可預測（不要靠 Map 的插入順序）
    .sort((a, b) => b.score - a.score || b.applied - a.applied || b.submitted - a.submitted)
    .filter((r) => r.score > 0)
    .slice(0, LEADERBOARD_SIZE);
}

export function buildFeedSummary(rows: SummaryRow[], votes: VoteRow[], now: number = Date.now(), adjudicating = 0, excluded: ReadonlySet<string> = EXCLUDED_AGENTS): FeedSummary {
  const byStatus: Record<string, number> = {};
  const byAgent = new Map<string, { submitted: number; applied: number; verified_votes: number }>();
  const recentAgents = new Set<string>();
  const allAgents = new Set<string>();
  const since30 = now - CONTRIBUTORS_WINDOW_DAYS * 86400 * 1000;
  const daily: Record<string, { count: number; verifications: number }> = {};
  for (let i = 6; i >= 0; i--) daily[taiwanDate(now - i * 86400 * 1000)] = { count: 0, verifications: 0 };

  const agentOf = (r: { agent_name: string | null }) => (r.agent_name && r.agent_name.trim()) || "(unknown)";
  const bump = (name: string) => {
    const a = byAgent.get(name) ?? { submitted: 0, applied: 0, verified_votes: 0 };
    byAgent.set(name, a);
    return a;
  };
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const a = bump(agentOf(r));
    a.submitted++;
    if (r.status === "applied") a.applied++;
    const t = Date.parse(r.created_at);
    // 測試代號不算貢獻者，否則卡片上的「貢獻者（近 30 天）」會跟榜上的名單對不起來
    if (!Number.isNaN(t) && t >= since30 && !excluded.has(agentOf(r))) recentAgents.add(agentOf(r));
    if (!excluded.has(agentOf(r))) allAgents.add(agentOf(r));
    if (!Number.isNaN(t)) {
      const d = taiwanDate(t);
      if (d in daily) daily[d].count++;
    }
  }
  for (const v of votes) {
    bump(agentOf(v)).verified_votes++;
    const t = Date.parse(String(v.created_at ?? ""));
    if (!Number.isNaN(t)) {
      const d = taiwanDate(t);
      if (d in daily) daily[d].verifications++;
    }
  }
  const needs = { disputed: byStatus.disputed ?? 0, retrying: byStatus.apply_failed ?? 0 }; // retrying 只是資訊，不算人工
  return {
    total: rows.length,
    by_status: byStatus,
    needs_attention: { total: needs.disputed, ...needs },
    adjudicating,
    contributors_30d: recentAgents.size,
    contributors_total: allAgents.size,
    daily_last_7: Object.entries(daily).map(([date, v]) => ({ date, ...v })),
    leaderboard: buildLeaderboard(rows, votes, LEADERBOARD_WINDOWS.all, now, excluded),
    leaderboard_30d: buildLeaderboard(rows, votes, LEADERBOARD_WINDOWS.d30, now, excluded),
    leaderboard_7d: buildLeaderboard(rows, votes, LEADERBOARD_WINDOWS.d7, now, excluded),
  };
}
