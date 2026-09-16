/**
 * 中選會「按姓名查候選人」的純函式部分。
 *
 * 2026-09-17：代理回報 election_result_missing 的 hint_sources 指向 db.cec.gov.tw，
 * 但那是前端渲染的 SPA，curl 抓不到任何東西，整夜的工都卡在那裡。小良哥：
 *   「如果有可驗證的 api 那他就可以只有 1 票，而且可以多個項目一起驗」
 *
 * 實測可用的兩支（無金鑰、CORS 開放，2026-09-17 驗證）：
 *   按姓名查歷屆參選：/query/api/v1/elections/candidates/query?cand_name=蔡易餘
 *   查該場逐位得票：  /query/api/v1/elections/candidates/data?theme_id=…&cand_id=…
 *
 * 既有的 fetch-cec-data 走的是另一條（靜態 JSON、按選舉與地區整批抓），兩者互補：
 * 那條適合名單清查，這條適合「這個人那一場選上了沒有、拿幾票」。
 */

export const CEC_QUERY_URL = "https://db.cec.gov.tw/query/api/v1/elections/candidates/query";
export const CEC_DATA_URL = "https://db.cec.gov.tw/query/api/v1/elections/candidates/data";

/** 中選會回的一筆參選紀錄（只取我們用得到的欄位） */
export interface CecCandidacyRaw {
  theme_id?: string;
  theme_name?: string;
  vote_date?: string;
  cand_id?: number;
  cand_name?: string;
  cand_birthyear?: string;
  party_name?: string;
  /** "*" 代表當選 */
  is_victor?: string;
  area_data?: { current_area?: { area_name?: string } };
}

export interface CecCandidacy {
  theme_id: string | null;
  cand_id: number | null;
  name: string;
  /** 選舉名稱，例如「第11屆立法委員選舉 - 區域」 */
  election_name: string | null;
  /** 投票日 YYYY-MM-DD */
  vote_date: string | null;
  /** 我們資料庫用的屆別＝投票年份 */
  election_id: number | null;
  birth_year: number | null;
  party: string | null;
  /** elected／not_elected；中選會沒標就是 null */
  election_result: "elected" | "not_elected" | null;
  area: string | null;
  /** 得票數與得票率要另外查 data 端點，用 attachTickets 併進來；沒查就是 null */
  votes_received: number | null;
  vote_percentage: number | null;
}

function year(voteDate: unknown): number | null {
  const m = typeof voteDate === "string" ? voteDate.match(/^(\d{4})/) : null;
  return m ? Number(m[1]) : null;
}

/** 純函式：把中選會的一筆整理成我們的欄位名 */
export function normalizeCandidacy(raw: CecCandidacyRaw): CecCandidacy {
  const birth = Number(raw.cand_birthyear);
  return {
    theme_id: raw.theme_id ?? null,
    cand_id: typeof raw.cand_id === "number" ? raw.cand_id : null,
    name: String(raw.cand_name ?? "").trim(),
    election_name: raw.theme_name ?? null,
    vote_date: raw.vote_date ?? null,
    election_id: year(raw.vote_date),
    birth_year: Number.isInteger(birth) && birth > 1900 ? birth : null,
    party: raw.party_name ?? null,
    // is_victor 只有當選才給 "*"；沒有這個記號就是沒當選，但只有投票日已過才算數
    election_result: raw.is_victor === "*" ? "elected" : "not_elected",
    area: raw.area_data?.current_area?.area_name ?? null,
    votes_received: null,
    vote_percentage: null,
  };
}

/**
 * 同名的人會混在一起（中選會沒有我們的 politician_id），所以回全部、由呼叫端自己挑。
 * 依投票日新到舊排序：要查「最近那場選上沒有」的情況最多。
 */
export function normalizeCandidacies(list: readonly CecCandidacyRaw[]): CecCandidacy[] {
  return list.map(normalizeCandidacy).sort((a, b) => (b.vote_date ?? "").localeCompare(a.vote_date ?? ""));
}

/** 還沒投票的選舉不能說「沒當選」：投票日在今天之後的，結果一律當作未知 */
export function withoutFutureResults(list: readonly CecCandidacy[], today = new Date().toISOString().slice(0, 10)): CecCandidacy[] {
  return list.map((c) => (c.vote_date && c.vote_date > today ? { ...c, election_result: null } : c));
}

/** 挑出某一屆（投票年份）的那一筆；同年多筆（例如立委區域與不分區）回第一筆 */
export function pickByElectionId(list: readonly CecCandidacy[], electionId: number): CecCandidacy | null {
  return list.find((c) => c.election_id === electionId) ?? null;
}

/** data 端點回的逐位得票；只取用得到的欄位 */
interface TicketRow { cand_name?: string; ticket_num?: number; ticket_percent?: number }

/**
 * 純函式：把 data 端點的得票併進某一筆參選紀錄。
 * 該場次所有候選人都在 ticket_data 裡，用姓名挑出本人那一列。
 */
export function attachTickets(candidacy: CecCandidacy, ticketsJson: unknown): CecCandidacy {
  const themes = (ticketsJson && typeof ticketsJson === "object" ? (ticketsJson as Record<string, unknown>).theme_data : null);
  const rows: TicketRow[] = Array.isArray(themes)
    ? themes.flatMap((t) => (t && typeof t === "object" && Array.isArray((t as Record<string, unknown>).ticket_data) ? (t as Record<string, unknown>).ticket_data as TicketRow[] : []))
    : [];
  const norm = (s: string) => s.replace(/臺/g, "台").replace(/\s/g, "");
  const mine = rows.filter((r) => typeof r.cand_name === "string" && norm(r.cand_name) === norm(candidacy.name));
  // 同一場次同名多列（極少見）：分不出是哪一位就不要猜
  if (mine.length !== 1) return candidacy;
  return {
    ...candidacy,
    votes_received: typeof mine[0].ticket_num === "number" ? mine[0].ticket_num : null,
    vote_percentage: typeof mine[0].ticket_percent === "number" ? mine[0].ticket_percent : null,
  };
}
