/**
 * 日本站貢獻看板（jp-contributions-feed）專用的純函式：分數欄位、選舉名稱解析、摘要。
 *
 * jp-contributions-feed 照搬正見的 contributions-feed，只換 schema 與標題解析；這裡放的是換掉的那幾段（可測、沒有資料庫）：
 *   - 分數：policy_jp.contributions 沒有 PostgREST 計算欄位 effective_agree（正見的 SQL 函式 effective_agree(contributions)），
 *     目標分數存在欄位 target_score（SQL 觸發器 contribution_apply_consensus 維護）。所以 select 改帶 target_score，
 *     空的（剛提交、還沒計過票）退回日本站的門檻（_shared/jp/consensus.ts），不是正見的門檻矩陣。
 *   - 標題解析：election → payload.name，沒有就用 policy_jp.elections 的 name（id＝日期_種類_團體碼）；
 *     local_government → payload.name；candidacy → payload.name＋candidacy_status（選舉 id）；regional_stat → payload.lg_code＋payload.stat_key；no_change → 核對的內容（finding；任務代號 payload.task_id 是內部識別碼，不印在摘要上，仍在 task_id 欄位）。
 *     其餘型別（task_suggestion、correction）仍走正見的 summarizeContribution，但不回人物／政見連結（那是正見網站的網址，日本站的 id 對不上）。
 */

import { contributionScore, type ScoreSource } from "../contribution-score.ts";
import { clip, type ContributionSummary, summarizeContribution, type SummaryInput } from "../contribution-summary.ts";
import { requiredAgree } from "./consensus.ts";
import { JP_NATIONAL_ELECTION_TYPES, JP_STAT_UNITS } from "./contribution-schema.ts";

type Obj = Record<string, unknown>;

/** 查 policy_jp.contributions 要撈的分數欄位（正見是 "score, effective_agree"） */
export const JP_SCORE_COLUMNS = "score, target_score";

export interface JpScoreSource extends ScoreSource {
  target_score?: number | null;
}

/** 一筆貢獻現在的分數與目標分數；target_score 空的退回日本站門檻。取法其餘同正見（contribution-score.ts） */
export function jpContributionScore(row: JpScoreSource): { score: number; target_score: number } {
  const target = typeof row.target_score === "number" ? row.target_score : requiredAgree(row.contribution_type, row.payload, row.source_urls ?? []);
  return contributionScore({ ...row, effective_agree: target });
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v));
const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});

/** election 交件對應的 policy_jp.elections.id：投票日_種類_團體碼（國政是 national）；欄位不全回 null */
export function jpElectionIdOf(payload: unknown): string | null {
  const p = asObj(payload);
  const date = str(p.election_date);
  const type = str(p.election_type);
  if (!date || !type) return null;
  const national = (JP_NATIONAL_ELECTION_TYPES as readonly string[]).includes(type);
  const scope = national ? "national" : str(p.lg_code);
  return scope ? `${date}_${type}_${scope}` : null;
}

/** 這一頁裡，election 交件沒帶 name、要去 elections 表找名稱的 id（去重） */
export function jpElectionIdsNeedingName(payloads: readonly unknown[], contributionTypes: readonly string[]): string[] {
  const ids = new Set<string>();
  payloads.forEach((payload, i) => {
    if (contributionTypes[i] !== "election") return;
    if (str(asObj(payload).name)) return;
    const id = jpElectionIdOf(payload);
    if (id) ids.add(id);
  });
  return [...ids];
}

/** 摘要用的 payload：election 沒帶 name 時補上 elections 表的名稱（找不到就維持原樣） */
export function jpPayloadForSummary(contributionType: string, payload: unknown, nameByElectionId: ReadonlyMap<string, string>): unknown {
  if (contributionType !== "election") return payload;
  const p = asObj(payload);
  if (str(p.name)) return payload;
  const id = jpElectionIdOf(p);
  const name = id ? nameByElectionId.get(id) : undefined;
  return name ? { ...p, name } : payload;
}

const ELECTION_TYPE_LABEL: Record<string, string> = {
  governor: "知事選舉", mayor: "市長選舉", ward_mayor: "區長選舉", town_mayor: "町村長選舉",
  national_lower: "眾議院選舉", national_upper: "參議院選舉", pref_assembly: "都道府縣議會選舉", muni_assembly: "市區町村議會選舉",
};
const CANDIDACY_STATUS_LABEL: Record<string, string> = {
  considering: "檢討出馬", declared: "表明參選", filed: "已提出届出", withdrawn: "退選", elected: "當選", not_elected: "落選",
};
const STAT_LABEL: Record<string, string> = { population: "人口", area_km2: "面積", budget_expenditure: "歲出", aging_rate: "高齡化率" };

/** 日本站五種有自己摘要的型別之外，仍用正見的摘要；一律不回人物／政見連結（正見網站的網址，日本站的 id 對不上） */
export function jpSummarizeContribution(input: SummaryInput): ContributionSummary {
  const p = asObj(input.payload);
  const base = (summary: string, targetName: string | null): ContributionSummary => ({
    summary: clip(summary), target_name: targetName, politician_id: null, policy_id: null, politician_url: null, policy_url: null,
  });
  switch (input.contribution_type) {
    case "election": {
      const name = str(p.name);
      const date = str(p.election_date);
      const label = name || `${ELECTION_TYPE_LABEL[str(p.election_type)] ?? "選舉"}`;
      return base(`回報選舉「${label}」${date ? `（投票日 ${date}）` : ""}`, name || null);
    }
    case "local_government": {
      const name = str(p.name);
      return base(`回報地方公共團體「${name || "（未填名稱）"}」的基本資料`, name || null);
    }
    case "candidacy": {
      // 參選人（第 2 步）：人名只有新的人才帶（已在庫的只帶 politician_id，id 不印在摘要上）；絕不印得票數（payload 本來就不收）
      const name = str(p.name);
      const status = CANDIDACY_STATUS_LABEL[str(p.candidacy_status)] ?? str(p.candidacy_status);
      return base(`回報${name ? `「${name}」` : "一位候選人"}在選舉 ${str(p.election_id)} 的參選狀態：${status}`, name || null);
    }
    case "regional_stat": {
      const key = str(p.stat_key);
      const label = STAT_LABEL[key] ?? key;
      const unit = str(p.unit) || (JP_STAT_UNITS as Record<string, string>)[key] || "";
      return base(`補團體 ${str(p.lg_code)} ${str(p.year)} 年的${label}：${String(p.value ?? "")} ${unit}`.trim(), null);
    }
    case "no_change": {
      // 任務代號（payload.task_id）是內部識別碼，不印在摘要上；讀者要看的是核對了什麼（finding），代號照樣在 task_id 欄位與 payload 裡
      const finding = clip(p.finding, 120);
      return base(finding ? `核對後回報沒有異動：${finding}` : "核對後回報沒有異動", null);
    }
    default: {
      const s = summarizeContribution({ contribution_type: input.contribution_type, payload: input.payload });
      return { ...s, politician_id: null, policy_id: null, politician_url: null, policy_url: null };
    }
  }
}
