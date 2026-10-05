/**
 * candidacy 裡的選舉結果欄位。
 *
 * 2026-09-19 發現：election_result_missing 任務叫代理用 candidacy 補 election_result／votes_received／vote_percentage，
 * skill.md 也這樣寫，但 schema 不驗、apply 不寫、摘要不顯示、去重鍵不看——61 筆待驗證答案全帶著結果，
 * 通過後也只會把 candidate_status 從 confirmed 改成 confirmed。這裡是三個地方共用的判讀。
 *
 * 2026-10-06（#345）：**得票數、得票率不收**。站上不顯示票數、不排名次（兩站共同守的線），留著沒人用的欄位遲早被誤用；
 * 這兩欄第一階段停止寫入、第二階段刪欄。代理交了也照收這筆（不擋件），只是這兩欄略過、回覆裡講一聲。
 */
export const ELECTION_RESULTS = ["elected", "not_elected"] as const;
export type ElectionResult = (typeof ELECTION_RESULTS)[number];

/** 不再寫入的票數欄位（#345；第二階段刪欄） */
export const IGNORED_VOTE_FIELDS = ["votes_received", "vote_percentage"] as const;

type Obj = Record<string, unknown>;

// type 而不是 interface：要能塞進 upsertParticipation 的 Record<string, unknown>（interface 沒有索引簽章）
export type ElectionResultPatch = {
  election_result?: ElectionResult;
};

/** payload 裡有給、而且格式對的選舉結果；沒給的不動既有值。得票數、得票率不收（#345） */
export function electionResultPatch(p: Obj): ElectionResultPatch {
  const out: ElectionResultPatch = {};
  if (p.election_result === "elected" || p.election_result === "not_elected") out.election_result = p.election_result;
  return out;
}

/** payload 裡帶了、但不會寫進去的票數欄位（給回覆講一聲用） */
export function ignoredVoteFields(p: Obj): string[] {
  return IGNORED_VOTE_FIELDS.filter((k) => p[k] !== undefined && p[k] !== null);
}

/** 交件回覆的提醒：帶了票數就講一聲「這兩欄不收」；沒帶回 null */
export function voteFieldsNotice(p: Obj): string | null {
  const fields = ignoredVoteFields(p);
  if (fields.length === 0) return null;
  return `得票數、得票率不收（站上不顯示票數，#345），這次帶的 ${fields.join("、")} 已略過，其餘欄位照常驗證與套用；之後不用再查、也不用再填`;
}

/** 給人看的：「當選」／「落選」；沒有結果就 null（不帶票數） */
export function electionResultLabel(p: Obj): string | null {
  const patch = electionResultPatch(p);
  if (!patch.election_result) return null;
  return patch.election_result === "elected" ? "當選" : "落選";
}

/**
 * 只列真的變了的欄位（[欄位, 舊值, 新值]）。
 * 之前每筆 candidacy 通過都記一條 confirmed→confirmed 進 edit_history，還原時也會被當成一次改動。
 */
export function changedFields(before: Obj | null, after: Obj): [string, unknown, unknown][] {
  const prev = before ?? {};
  return Object.entries(after)
    .filter(([k, v]) => v !== undefined && String(prev[k] ?? "") !== String(v ?? ""))
    .map(([k, v]) => [k, prev[k] ?? null, v]);
}
