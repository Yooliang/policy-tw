/**
 * 參選狀態合一欄 `politician_elections.candidacy_status`（#345 第一階段，migration 20261006034500）。
 *
 * 舊的兩欄 `candidate_status`（傳聞／可能參選／確認參選／已登記／審定合格／表態不參選…）＋`election_result`
 * （當選／落選／退選）重疊、會互相矛盾，日本站合併成一欄六值，正見照同一套。第一階段兩邊由觸發器同步；
 * 第二階段 A（2026-10-06）讀取端與寫入端都只認這一欄，舊兩欄只剩觸發器在同步（第二階段 B 刪）。
 * 這支放兩個方向的對應：`candidacyStatusFromLegacy()` 是 SQL `candidacy_status_from_legacy()` 的 TS 鏡像（測試直接讀 migration 的 CASE），
 * `nextCandidacyStatus()` 是落庫端把交件協議的詞（confirmed／registered…）換成新欄位值的規則。
 */

/** 六值，照日本站（政策の系譜 SCHEMA）的順序與代碼 */
export const CANDIDACY_STATUSES = ["considering", "declared", "filed", "withdrawn", "elected", "not_elected"] as const;
export type CandidacyStatus = (typeof CANDIDACY_STATUSES)[number];

/** 給人看的字（不收傳聞，所以沒有「傳聞」） */
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
 * 交件協議的詞（candidate_status：confirmed／registered／qualified／withdrawn／not_running，外加匯入端點的 likely、elected、defeated）
 * ＋選舉結果（election_result）→ 新欄位 candidacy_status（#345 第二階段 A：落庫只寫新欄位，舊兩欄由觸發器同步）。
 *
 * 規則（跟 SQL candidacy_status_from_legacy 同一套，只是多收協議的 withdrawn）：
 *   ① 有給選舉結果（elected／not_elected）→ 就是結果
 *   ② 這一筆原本已經有結果（elected／not_elected）而且這次沒給結果 → 維持原結果。結果比登記階段與不參選都大
 *      ——舊兩欄就是這樣（election_result 優先於 candidate_status），例如「照現況填 candidate_status」的更正任務不能把當選改回已登記
 *   ③ confirmed 只表示表態參選（declared）；正式名單公告之後（含已投票屆別）在名單上的人記成 filed（舊制記成 qualified，
 *      #345 後續的收窄）。這一筆原本就是 declared 的重交 confirmed 原樣不動——不能因為一件不相干的任務把早期匯入的值改掉
 *   ④ registered／qualified → filed；withdrawn／not_running → withdrawn；likely → considering；elected／defeated → 結果
 *   ⑤ 傳聞（rumored）與空值 → null：不收傳聞，呼叫端不寫狀態
 * `converted`＝這次把 confirmed 換成了「已登記」（回覆講一聲）。
 */
export function nextCandidacyStatus(input: {
  candidateStatus?: string | null;
  electionResult?: string | null;
  listPublished: boolean;
  existing?: string | null;
}): { status: CandidacyStatus | null; converted: boolean } {
  const { candidateStatus, electionResult, listPublished, existing } = input;
  if (electionResult === "elected" || electionResult === "not_elected") return { status: electionResult, converted: false };
  if (existing === "elected" || existing === "not_elected") return { status: existing, converted: false };
  switch (candidateStatus) {
    case "confirmed":
      if (listPublished && existing !== "declared") return { status: "filed", converted: existing !== "filed" };
      return { status: "declared", converted: false };
    case "registered":
    case "qualified": return { status: "filed", converted: false };
    case "withdrawn":
    case "not_running": return { status: "withdrawn", converted: false };
    case "likely": return { status: "considering", converted: false };
    case "elected": return { status: "elected", converted: false };
    case "defeated": return { status: "not_elected", converted: false };
    default: return { status: null, converted: false };
  }
}

export const CONFIRMED_NARROWED_NOTE =
  "；正式名單已公告，confirmed 只表示表態參選，名單上的人記成已登記（filed，含審定）";

/** 新欄 → 選舉結果（只有 elected／not_elected 算結果，其餘 null） */
export function resultOfCandidacyStatus(status: string | null | undefined): "elected" | "not_elected" | null {
  return status === "elected" || status === "not_elected" ? status : null;
}

/**
 * 新欄 → 交件協議的詞（派工說明「candidate_status 照現況填」那一句要填什麼）。SQL candidacy_protocol_status 的 TS 鏡像。
 * 名單公告後在名單上的人填 qualified、公告前填 registered；選完了（當選、落選）名單早已公告，填 qualified；
 * 空值（傳聞，不收）寫成 rumored——這是「現況」的描述，不是可以交的值（協議不收 rumored）。
 */
export function protocolStatusFromCandidacy(status: string | null | undefined, listPublished: boolean): string {
  switch (status) {
    case "withdrawn": return "not_running";
    case "declared": return "confirmed";
    case "filed": return listPublished ? "qualified" : "registered";
    case "elected":
    case "not_elected": return "qualified";
    case "considering": return "likely";
    default: return "rumored";
  }
}

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
