/**
 * 參選狀態合一欄 `politician_elections.candidacy_status`（#345 第一階段，migration 20261006034500）。
 *
 * 舊的兩欄 `candidate_status`（傳聞／可能參選／確認參選／已登記／審定合格／表態不參選…）＋`election_result`
 * （當選／落選／退選）重疊、會互相矛盾，日本站合併成一欄六值，正見照同一套。第一階段兩邊由觸發器同步，
 * 讀取端還讀舊欄位；這支是 SQL `candidacy_status_from_legacy()` 的 TS 鏡像，給第二階段改讀新欄位時用，
 * 也讓測試盯住兩邊的對應規則一致（candidacy-status.test.ts 直接讀 migration 的 CASE）。
 */

/** 六值，照日本站（政策の系譜 SCHEMA）的順序與代碼 */
export const CANDIDACY_STATUSES = ["considering", "declared", "filed", "withdrawn", "elected", "not_elected"] as const;
export type CandidacyStatus = (typeof CANDIDACY_STATUSES)[number];

/** 給人看的字（第二階段畫面改讀新欄位時用；不收傳聞，所以沒有「傳聞」） */
export const CANDIDACY_STATUS_LABELS: Record<CandidacyStatus, string> = {
  considering: "考慮參選",
  declared: "表明參選",
  filed: "已登記",
  withdrawn: "退選／不參選",
  elected: "當選",
  not_elected: "落選",
};

/** 台灣日期（YYYY-MM-DD） */
export function taipeiToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * confirmed 收窄（#345 後續，協調者 10-06 裁定）：confirmed 只表示「表態參選」（本人宣布、政黨提名）；
 * 正式候選人名單公告之後（含已投票的屆別），在名單上的一律記成 qualified（已審定）。
 * 落庫端照這支換值、回覆講一聲；舊資料原樣重交（例如補選區任務叫代理「candidate_status 照現況填」）不順手改，
 * 免得一筆早期匯入的 confirmed 因為一件不相干的任務被改掉。
 */
export function narrowConfirmed(
  status: string,
  listPublished: boolean,
  existing?: string | null,
): { status: string; converted: boolean } {
  if (status !== "confirmed" || !listPublished || existing === "confirmed") return { status, converted: false };
  return { status: "qualified", converted: true };
}

export const CONFIRMED_NARROWED_NOTE =
  "；正式名單已公告，confirmed 只表示表態參選，名單上的人記成 qualified（已審定）";

// deno-lint-ignore no-explicit-any
type RpcClient = any;

/**
 * 這一屆這種選舉的正式名單在今天公告了沒（SQL candidacy_list_published，已投票也算）。
 * 查不到（RPC 失敗、沒有選舉別）就當沒公告——寧可照原值寫，也不要猜著換掉。
 */
export async function isListPublished(supabase: RpcClient, electionId: number, electionType: string | null | undefined, today = taipeiToday()): Promise<boolean> {
  if (!supabase || typeof supabase.rpc !== "function" || !electionType || !Number.isInteger(electionId)) return false;
  try {
    const { data, error } = await supabase.rpc("candidacy_list_published", { p_election_id: electionId, p_election_type: electionType, p_on: today });
    return !error && data === true;
  } catch {
    return false;
  }
}

/**
 * 舊兩欄 → 新欄。`listPublished`＝這一屆這種選舉的正式候選人名單公告了沒（已投票也算），
 * 只用來決定 confirmed 是「表明參選」還是「已登記（名單上）」——見 migration 註解第 ③ 條。
 * 傳聞（rumored）與空值回 null：不收傳聞。
 */
export function candidacyStatusFromLegacy(
  candidateStatus: string | null | undefined,
  electionResult: string | null | undefined,
  listPublished: boolean,
): CandidacyStatus | null {
  if (electionResult === "elected") return "elected";
  if (electionResult === "not_elected") return "not_elected";
  if (electionResult === "withdrawn") return "withdrawn";
  switch (candidateStatus) {
    case "elected": return "elected";
    case "defeated": return "not_elected";
    case "not_running": return "withdrawn";
    case "registered":
    case "qualified": return "filed";
    case "confirmed": return listPublished ? "filed" : "declared";
    case "likely": return "considering";
    default: return null;
  }
}
