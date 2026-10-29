/**
 * 號次整批交件（cand_numbers，issue #781，維護者 2026-10-30 批准）。
 *
 * 補號次任務（candidacy_source_missing、target.kind＝cand_no）一個單位最多 50 位。以前代理每人交一份 candidacy，每人一張驗證票，
 * 同一份抽籤公告 PDF 被打開幾十次。現在整個任務交**一份** cand_numbers：payload.items 每人一列 {politician_election_id, cand_no}，
 * 一份交件一張驗證票，驗證者開一次公告逐列核對。
 *
 * 計分（DB 與 TS 兩份）：風險等級 cand_no（目標 1、不看來源、免兩台機器——跟 #754、#777 同一級）。
 *
 * 逐列標錯（最小可行做法）：計分仍以「整份交件」為單位（一份一張票），但驗證者投 agree 時可附 bad_items
 * （politician_election_id 陣列）＋ note 理由。落庫時：
 *   - 被標錯的列（標記它的 agree 票數 ≥ BAD_ROW_THRESHOLD）不寫，
 *   - 與號次重複的列（SQL cand_no_batch_conflicts：整批內部同號、或與已上線的他人同號）不寫，
 *   - 其餘列照寫（只補空白：cand_no 已有值的不覆蓋）。
 * 沒寫的列 cand_no 仍是空，補號次臂自然把它們重派。這份交件整體仍是 applied。
 * 取捨：不做逐列計分——驗證者要嘛整份 agree（可附錯列）、要嘛 disagree/unsure 整份；錯列靠「不寫＋重派」收斂，不靠分數退件。
 */

/** 一份交件最多幾列（比派工一件 50 位寬，留給之後調大派工單位） */
export const MAX_CAND_NUMBERS_PER_SUBMISSION = 150;

/** 一列被幾張 agree 票標錯就退回（目標分只有 1，實務上一張票標了就退） */
export const BAD_ROW_THRESHOLD = 1;

export const CAND_NUMBERS_TYPE = "cand_numbers";

export interface CandNoItem {
  politician_election_id: number;
  cand_no: number;
}

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** payload.items → 乾淨的清單（schema 已擋形狀；這裡給落庫與摘要用，看不懂的略過） */
export function candNoItems(payload: unknown): CandNoItem[] {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const raw = Array.isArray(p.items) ? p.items : [];
  const out: CandNoItem[] = [];
  for (const it of raw) {
    const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    if (isPosInt(o.politician_election_id) && isPosInt(o.cand_no) && o.cand_no <= 999999) {
      out.push({ politician_election_id: o.politician_election_id, cand_no: o.cand_no });
    }
  }
  return out;
}

/** 單位的人話標籤（給摘要與落庫回覆） */
export function candNumbersUnitLabel(payload: unknown): string {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const place = [p.region, p.sub_region].filter((x) => typeof x === "string" && x).join("");
  return `${place} ${String(p.election_id ?? "")} ${String(p.election_type ?? "")}`.trim();
}

/** bad_items 的乾淨版本：正整數、去重 */
export function cleanBadItems(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isPosInt))];
}

export interface VoteLike {
  verdict: string;
  bad_items?: unknown;
}

/** 被標錯的列：只算 agree 票的 bad_items；標記的 agree 票數 ≥ threshold 的列退回 */
export function flaggedRows(votes: VoteLike[], threshold: number = BAD_ROW_THRESHOLD): Set<number> {
  const count = new Map<number, number>();
  for (const v of votes) {
    if (v.verdict !== "agree") continue;
    for (const id of cleanBadItems(v.bad_items)) count.set(id, (count.get(id) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n >= threshold).map(([id]) => id));
}

export interface ExistingCandNo {
  id: number;
  election_id: number;
  election_type: string | null;
  cand_no: number | null;
}

export interface CandNumbersPlan {
  /** 要寫的列 */
  writes: CandNoItem[];
  /** 已經是同一個號次（別人先補了） */
  unchanged: number[];
  /** 已經有不同的號次：不覆蓋 */
  occupied: Array<{ id: number; current: number; claimed: number }>;
  /** 參選紀錄不存在、或不是這一屆這種選舉的 */
  stray: number[];
  /** 驗證者標錯的 */
  flagged: number[];
  /** 號次重複檢查擋下的（id → 原因） */
  conflicted: Array<{ id: number; cand_no: number; reason: string }>;
}

/** 純函式：哪幾列會寫、哪幾列退回（落庫與測試共用） */
export function planCandNumbers(
  existing: ExistingCandNo[],
  items: CandNoItem[],
  electionId: number,
  electionType: string,
  flagged: Set<number>,
  conflicts: Map<number, string>,
): CandNumbersPlan {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const plan: CandNumbersPlan = { writes: [], unchanged: [], occupied: [], stray: [], flagged: [], conflicted: [] };
  const seen = new Set<number>();
  for (const it of items) {
    if (seen.has(it.politician_election_id)) continue;
    seen.add(it.politician_election_id);
    const row = byId.get(it.politician_election_id);
    if (!row || row.election_id !== electionId || row.election_type !== electionType) { plan.stray.push(it.politician_election_id); continue; }
    if (flagged.has(it.politician_election_id)) { plan.flagged.push(it.politician_election_id); continue; }
    if (row.cand_no === it.cand_no) { plan.unchanged.push(it.politician_election_id); continue; }
    if (row.cand_no !== null && row.cand_no !== undefined) { plan.occupied.push({ id: row.id, current: row.cand_no, claimed: it.cand_no }); continue; }
    const why = conflicts.get(it.politician_election_id);
    if (why) { plan.conflicted.push({ id: it.politician_election_id, cand_no: it.cand_no, reason: why }); continue; }
    plan.writes.push(it);
  }
  return plan;
}
