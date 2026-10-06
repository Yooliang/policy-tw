/**
 * 補選舉結果改批次（維護者 2026-10-06：「改批次，票數 2 票，讓 jev 扣下來」；設計照 #377 第 4 節）。
 *
 * 已投票屆別、election_result 空白的參選紀錄 13,954 筆（10-06），逐人派會塞爆佇列、每件都要好幾張票。
 * 改成依單位（屆別×選舉別×縣市，村里長與代表再細到鄉鎮市區）聚成一件任務 election_results_missing，
 * 代理一次交一整個單位的結果（election_results，items 每位一項）。
 *
 * 計分（DB 與 TS 兩份，thresholds／protocol-guard 測試盯著）：
 *   - 目標分數 2（風險等級 batch_result）
 *   - 系統票：SQL election_results_system_check 逐位核對中選會名單，全部對得上投 supported → 照 3+1 機制折進目標（2−1＝1），
 *     再一張代理同意就上線；任何一位對不上不投票，目標照 2、驗證項列出是哪幾位
 *   - 不要求兩台機器；退件門檻照舊 −3
 *
 * 比對規則只在 SQL 一份（election_result_cec_matches）：派工、系統票、驗證項都叫它。這裡只放型別、上限、
 * 落庫的純函式（哪幾位會寫、哪幾位跳過）、驗證項的整理。落庫在 apply-contribution.ts。
 */
import { ELECTION_RESULTS, type ElectionResult } from "./candidacy-result.ts";

export const ELECTION_RESULTS_TASK = "election_results_missing";
export const ELECTION_RESULTS_TYPE = "election_results";

/** 一件任務、一筆交件最多幾位（派工臂的 120 跟這裡同一個數字，election-results.test.ts 盯著） */
export const MAX_RESULTS_PER_SUBMISSION = 120;

/** 系統票的 model（SQL election_results_system_check 寫的就是這個前綴） */
export const RESULTS_BATCH_MODEL_PREFIX = "policy-tw/cec-results-batch";

/** 交件逐位比對的狀態（SQL election_results_compare 的 status） */
export const COMPARE_STATUSES = ["match", "differs", "ambiguous", "not_found", "unknown", "wrong_unit", "no_record"] as const;
export type CompareStatus = typeof COMPARE_STATUSES[number];

export const COMPARE_STATUS_LABEL: Record<CompareStatus, string> = {
  match: "對得上中選會名單",
  differs: "中選會名單的當選與否跟交件不同",
  ambiguous: "中選會名單上同縣市同名的不只一位，系統分不出是哪一位",
  not_found: "中選會名單上找不到同縣市同名、地區也對得上的人",
  unknown: "中選會名單沒寫當選與否",
  wrong_unit: "這筆參選紀錄不是這一屆、這種選舉、這個縣市的",
  no_record: "參選紀錄不存在",
};

export interface ResultItem {
  politician_election_id: number;
  election_result: ElectionResult;
}

/** payload.items → 乾淨的清單（schema 已擋形狀；這裡給落庫與摘要用，看不懂的略過） */
export function resultItems(payload: unknown): ResultItem[] {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const raw = Array.isArray(p.items) ? p.items : [];
  const out: ResultItem[] = [];
  for (const it of raw) {
    const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const id = o.politician_election_id;
    const r = o.election_result;
    if (typeof id === "number" && Number.isInteger(id) && id > 0 && (ELECTION_RESULTS as readonly unknown[]).includes(r)) {
      out.push({ politician_election_id: id, election_result: r as ElectionResult });
    }
  }
  return out;
}

export interface ExistingCandidacy {
  id: number;
  election_id: number;
  election_type: string | null;
  election_result: string | null;
}

export interface ResultsPlan {
  /** 結果空白、這次要寫的 */
  writes: Array<{ id: number; election_result: ElectionResult }>;
  /** 已經是同一個結果（別人先補了） */
  unchanged: number[];
  /** 已經有不同的結果：不覆蓋（要改走 candidacy／correction 那條路，各自驗證） */
  conflicts: Array<{ id: number; current: string; claimed: ElectionResult }>;
  /** 參選紀錄不存在、或不是這一屆這種選舉的 */
  stray: number[];
}

/**
 * 這一筆交件會寫哪幾位（純函式，可測）。**只補空白、不覆蓋**：批次是用來補缺口的，
 * 已經有結果的那一位要改，得走一位一筆的 candidacy／correction，各自驗證。
 */
export function planElectionResults(
  existing: readonly ExistingCandidacy[],
  items: readonly ResultItem[],
  electionId: number,
  electionType: string,
): ResultsPlan {
  const plan: ResultsPlan = { writes: [], unchanged: [], conflicts: [], stray: [] };
  const byId = new Map(existing.map((e) => [e.id, e]));
  const seen = new Set<number>();
  for (const it of items) {
    if (seen.has(it.politician_election_id)) continue;
    seen.add(it.politician_election_id);
    const cur = byId.get(it.politician_election_id);
    if (!cur || cur.election_id !== electionId || cur.election_type !== electionType) {
      plan.stray.push(it.politician_election_id);
      continue;
    }
    if (cur.election_result === null || cur.election_result === undefined) {
      plan.writes.push({ id: cur.id, election_result: it.election_result });
    } else if (cur.election_result === it.election_result) {
      plan.unchanged.push(cur.id);
    } else {
      plan.conflicts.push({ id: cur.id, current: cur.election_result, claimed: it.election_result });
    }
  }
  return plan;
}

/** SQL election_results_compare 的一列 */
export interface CompareRow {
  politician_election_id: number | null;
  name?: string | null;
  county?: string | null;
  town?: string | null;
  village?: string | null;
  district?: string | null;
  claimed?: string | null;
  current_result?: string | null;
  status: CompareStatus | string;
  cec_hits?: number | null;
  cec_elected?: boolean | null;
  cec_sub_region?: string | null;
  cec_village?: string | null;
  cec_birth_year?: number | null;
}

/**
 * 系統票的規則（TS 鏡像；SQL election_results_system_check）：每一位都 match 才 supported，
 * 其他一律不投票（null）——不投 not_supported：名單對不上多半是我們的地區或姓名寫法，不是交件錯。
 */
export function resultsSystemVote(rows: readonly CompareRow[]): "supported" | null {
  return rows.length > 0 && rows.every((r) => r.status === "match") ? "supported" : null;
}

/** 驗證項：每一位一列，對不上的排前面、附中文說明 */
export function shapeResultsRows(rows: readonly CompareRow[]): Array<Record<string, unknown>> {
  const order = (s: string) => (s === "match" ? 1 : 0);
  return [...rows].sort((a, b) => order(String(a.status)) - order(String(b.status))).map((r) => ({
    politician_election_id: r.politician_election_id,
    name: r.name ?? null,
    place: [r.county, r.town, r.village].filter(Boolean).join(" ") || null,
    claimed: r.claimed ?? null,
    cec: r.cec_hits === 1 ? { elected: r.cec_elected ?? null, sub_region: r.cec_sub_region ?? null, village: r.cec_village ?? null, birth_year: r.cec_birth_year ?? null } : null,
    status: r.status,
    status_label: COMPARE_STATUS_LABEL[r.status as CompareStatus] ?? String(r.status),
  }));
}

/** 給人看的單位名稱：「台北市中山區 2022 村里長」 */
export function resultsUnitLabel(payload: unknown): string {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  return `${s(p.region)}${s(p.sub_region)} ${s(p.election_id)} ${s(p.election_type)}`.trim();
}
