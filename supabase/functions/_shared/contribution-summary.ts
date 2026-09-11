/**
 * 貢獻看板用：把 contribution 轉成「安全摘要」——一句人話＋目標連結，不回 ip_hash、不回長文（截 200 字）。
 * 純函式，可測。
 */

export const SITE_URL = "https://policy-tw.web.app";
export const SUMMARY_TEXT_LIMIT = 200;
import { normalizeCorrection } from "./correction.ts";

type Obj = Record<string, unknown>;

const CANDIDATE_STATUS_LABEL: Record<string, string> = {
  rumored: "傳聞", likely: "可能參選", confirmed: "確認參選", registered: "已登記", qualified: "審定合格",
  withdrawn: "退選", not_running: "未登記", elected: "當選", defeated: "落選",
};
const POLICY_STATUS_LABEL: Record<string, string> = {
  "Campaign Pledge": "競選承諾", Proposed: "提出", "In Progress": "進行中", Achieved: "已實現", Stalled: "滯後", Failed: "未達成",
};
const TABLE_LABEL: Record<string, string> = { politicians: "政治人物", politician_elections: "參選紀錄", policies: "政見" };
const FIELD_LABEL: Record<string, string> = {
  name: "姓名", party: "政黨", birth_year: "出生年", current_position: "現職", region: "縣市", sub_region: "選區", education_level: "學歷",
  bio: "簡介", avatar_url: "照片", candidate_status: "參選狀態", position: "職位", election_type: "選舉類型", title: "標題",
  description: "內容", category: "分類", status: "狀態", proposed_date: "提出日", election_id: "所屬選舉", source_url: "來源網址",
};

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
      summary = `將 ${name || "（未填姓名）"} ${str(p.election_id)} ${str(p.region)}${str(p.election_type)}參選狀態改為「${status}」`;
      break;
    }
    case "policy": {
      summary = `為「${name || "（政治人物）"}」新增政見：${clip(p.title, 80)}`;
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
    case "correction": {
      const table = TABLE_LABEL[str(p.target_table)] ?? str(p.target_table);
      const id = str(p.target_id);
      const { changes } = normalizeCorrection(p);
      summary = changes.length <= 1
        ? `把${table} ${id.slice(0, 8)} 的${FIELD_LABEL[changes[0]?.field ?? ""] ?? changes[0]?.field ?? "?"}改為「${clip(changes[0]?.correct_value, 80)}」`
        : `更正${table} ${id.slice(0, 8)} 的 ${changes.length} 個欄位：${changes.map((c) => `${FIELD_LABEL[c.field] ?? c.field}→「${clip(c.correct_value, 40)}」`).join("、")}`;
      targetName = null;
      if (str(p.target_table) === "politicians") return finish(summary, targetName, id || null, null);
      if (str(p.target_table) === "policies") return finish(summary, targetName, null, id || null);
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
    politician_url: politicianId ? `${SITE_URL}/politician/${politicianId}` : null,
    policy_url: policyId ? `${SITE_URL}/policy/${policyId}` : null,
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

export interface SummaryRow { status: string; agent_name: string | null; created_at: string }
export interface VoteRow { agent_name: string | null }

export interface FeedSummary {
  total: number;
  by_status: Record<string, number>;
  needs_attention: { total: number; disputed: number; retrying: number };
  /** open 的裁決任務數（disputed 的貢獻正由更多代理用 4 票決定；不是人工待辦） */
  adjudicating: number;
  contributors_30d: number;
  daily_last_7: Array<{ date: string; count: number }>;
  leaderboard: Array<{ agent_name: string; submitted: number; applied: number; verified_votes: number }>;
}

export function buildFeedSummary(rows: SummaryRow[], votes: VoteRow[], now: number = Date.now(), adjudicating = 0): FeedSummary {
  const byStatus: Record<string, number> = {};
  const byAgent = new Map<string, { submitted: number; applied: number; verified_votes: number }>();
  const recentAgents = new Set<string>();
  const since30 = now - CONTRIBUTORS_WINDOW_DAYS * 86400 * 1000;
  const daily: Record<string, number> = {};
  for (let i = 6; i >= 0; i--) daily[new Date(now - i * 86400 * 1000).toISOString().slice(0, 10)] = 0;

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
    if (!Number.isNaN(t) && t >= since30) recentAgents.add(agentOf(r));
    const d = String(r.created_at).slice(0, 10);
    if (d in daily) daily[d]++;
  }
  for (const v of votes) bump(agentOf(v)).verified_votes++;

  const leaderboard = [...byAgent.entries()]
    .map(([agent_name, v]) => ({ agent_name, ...v }))
    .sort((a, b) => b.applied - a.applied || b.submitted - a.submitted || b.verified_votes - a.verified_votes)
    .slice(0, 10);
  const needs = { disputed: byStatus.disputed ?? 0, retrying: byStatus.apply_failed ?? 0 }; // retrying 只是資訊，不算人工
  return {
    total: rows.length,
    by_status: byStatus,
    needs_attention: { total: needs.disputed, ...needs },
    adjudicating,
    contributors_30d: recentAgents.size,
    daily_last_7: Object.entries(daily).map(([date, count]) => ({ date, count })),
    leaderboard,
  };
}
