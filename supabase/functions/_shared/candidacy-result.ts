/**
 * candidacy 裡的選舉結果欄位。
 *
 * 2026-09-19 發現：election_result_missing 任務叫代理用 candidacy 補 election_result／votes_received／vote_percentage，
 * skill.md 也這樣寫，但 schema 不驗、apply 不寫、摘要不顯示、去重鍵不看——61 筆待驗證答案全帶著結果，
 * 通過後也只會把 candidate_status 從 confirmed 改成 confirmed。這裡是三個地方共用的判讀。
 */
export const ELECTION_RESULTS = ["elected", "not_elected"] as const;
export type ElectionResult = (typeof ELECTION_RESULTS)[number];

type Obj = Record<string, unknown>;

// type 而不是 interface：要能塞進 upsertParticipation 的 Record<string, unknown>（interface 沒有索引簽章）
export type ElectionResultPatch = {
  election_result?: ElectionResult;
  votes_received?: number;
  vote_percentage?: number;
};

/** payload 裡有給、而且格式對的結果欄位；沒給的不動既有值 */
export function electionResultPatch(p: Obj): ElectionResultPatch {
  const out: ElectionResultPatch = {};
  if (p.election_result === "elected" || p.election_result === "not_elected") out.election_result = p.election_result;
  if (typeof p.votes_received === "number" && Number.isInteger(p.votes_received) && p.votes_received >= 0) out.votes_received = p.votes_received;
  if (typeof p.vote_percentage === "number" && p.vote_percentage >= 0 && p.vote_percentage <= 100) out.vote_percentage = p.vote_percentage;
  return out;
}

/** 給人看的：「當選（29,150 票，53.7%）」；沒有結果就 null */
export function electionResultLabel(p: Obj): string | null {
  const patch = electionResultPatch(p);
  if (!patch.election_result) return null;
  const word = patch.election_result === "elected" ? "當選" : "落選";
  const parts: string[] = [];
  if (patch.votes_received !== undefined) parts.push(`${patch.votes_received.toLocaleString("en-US")} 票`);
  if (patch.vote_percentage !== undefined) parts.push(`${patch.vote_percentage}%`);
  return parts.length ? `${word}（${parts.join("，")}）` : word;
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
