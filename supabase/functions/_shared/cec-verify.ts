/**
 * 用中選會的資料自動查證貢獻：對得上就上線、對不上就退件、查不到就留給同儕投票。
 *
 * 2026-09-17 小良哥：「如果有可驗證的 api 那他就可以只有 1 票」。往前一步——
 * 這一類根本不需要投票：選舉結果、得票數、出生年都有權威資料庫可查，
 * 機器比對比人投票可靠，而且目前 894 筆待驗證裡有 406 筆卡在 4～6 票的高門檻上。
 *
 * 這支只負責「敢不敢自動決定」，刻意保守：
 *   - 只處理已投票屆別（未來的選舉結果不存在，不能說沒當選）
 *   - 同名同姓在同一屆出現多筆 → 不碰，交給人判斷（我們沒有中選會的 id 可以對）
 *   - 宣稱的每一個可查欄位都要對得上才上線；有一個對不上就退件，並把中選會的數字寫進理由
 *   - 中選會查無此人 → 不代表錯（可能還沒公告、用字不同），留在佇列
 */

import type { CecCandidacy } from "./cec-candidate.ts";

/** 可自動查證的貢獻型別 */
export const CEC_VERIFIABLE_TYPES = ["candidacy", "politician"] as const;

export interface VerifiableClaim {
  contribution_type: string;
  payload: Record<string, unknown>;
  /** 我們資料庫裡這個人的現況，用來排除同名同姓 */
  politician?: { name?: string | null; party?: string | null; region?: string | null } | null;
}

export type CecDecision =
  | { action: "apply"; matched: string[]; candidacy: CecCandidacy }
  | { action: "reject"; reason: string; candidacy: CecCandidacy }
  | { action: "skip"; reason: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 得票率允許的誤差：中選會四捨五入到小數第二位 */
export const PERCENT_TOLERANCE = 0.05;

/** 臺／台、全形空白之類的寫法差異不算不同 */
function sameName(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.replace(/臺/g, "台").replace(/\s|‧|·|・/g, "");
  return norm(a) === norm(b);
}

/**
 * 光靠姓名會抓到別人：2026-09-17 乾跑時，中選會的「李四川」是彰化縣花壇鄉花壇村村長
 * （無黨籍、1960），我們的李四川是台北市副市長（國民黨、新北市）——差點把一筆正確的
 * 出生年退掉。所以一律要求「我們記的縣市」出現在中選會那筆的選區裡才算同一個人。
 * 政黨不能拿來當條件：同一個人會換黨（邱建富在中選會是民進黨、我們記無黨籍）。
 */
function sameRegion(ourRegion: string | null, cecArea: string | null): boolean {
  if (!ourRegion || !cecArea) return false;
  const norm = (s: string) => s.replace(/臺/g, "台").replace(/\s/g, "");
  return norm(cecArea).includes(norm(ourRegion));
}

/** 中選會有沒有哪一筆能對上我們這個人（姓名＋縣市） */
function matchesOurPerson(claim: VerifiableClaim, c: CecCandidacy, claimedName: string): boolean {
  return sameName(c.name, claimedName) && sameRegion(str(claim.politician?.region) ?? str(claim.payload.region), c.area);
}

/**
 * 純函式：這筆貢獻能不能用中選會的資料自動定案。
 * candidacies 是「用 payload 裡的姓名查中選會」的結果（已經過 withoutFutureResults）。
 */
export function decideByCec(claim: VerifiableClaim, candidacies: readonly CecCandidacy[]): CecDecision {
  const { contribution_type: type, payload } = claim;
  if (!(CEC_VERIFIABLE_TYPES as readonly string[]).includes(type)) {
    return { action: "skip", reason: "這個型別不在中選會查得到的範圍" };
  }

  const claimedName = str(payload.name) ?? str(claim.politician?.name);
  if (!claimedName) return { action: "skip", reason: "沒有姓名可查" };

  const sameNameOnly = candidacies.filter((c) => sameName(c.name, claimedName));
  if (sameNameOnly.length === 0) return { action: "skip", reason: "中選會查無此姓名（可能尚未公告或用字不同），留給同儕驗證" };
  const byName = sameNameOnly.filter((c) => matchesOurPerson(claim, c, claimedName));
  if (byName.length === 0) {
    return { action: "skip", reason: "中選會查得到同名的人，但選區跟我們記的縣市對不上，很可能是同名同姓——交給人判斷" };
  }

  // politician：只查出生年，不看屆別
  if (type === "politician") {
    const claimedBirth = num(payload.birth_year);
    if (claimedBirth === null) return { action: "skip", reason: "沒有宣稱出生年，沒有可自動查的欄位" };
    const years = [...new Set(byName.map((c) => c.birth_year).filter((y): y is number => y !== null))];
    if (years.length === 0) return { action: "skip", reason: "中選會沒有這個人的出生年" };
    if (years.length > 1) return { action: "skip", reason: `中選會有多個出生年（${years.join("、")}），可能是同名同姓` };
    if (years[0] !== claimedBirth) {
      return { action: "reject", reason: `出生年對不上：中選會是 ${years[0]}，這筆寫 ${claimedBirth}`, candidacy: byName[0] };
    }
    return { action: "apply", matched: ["birth_year"], candidacy: byName[0] };
  }

  // candidacy：要指名哪一屆
  const electionId = num(payload.election_id);
  if (electionId === null) return { action: "skip", reason: "沒有 election_id，不知道要查哪一屆" };
  const sameElection = byName.filter((c) => c.election_id === electionId);
  if (sameElection.length === 0) {
    return { action: "skip", reason: `中選會沒有 ${electionId} 這一屆的紀錄（可能尚未公告），留給同儕驗證` };
  }
  if (sameElection.length > 1) {
    // 同一屆同名多筆：用政黨或選區區分得出來才繼續
    const party = str(claim.politician?.party);
    const narrowed = party ? sameElection.filter((c) => c.party === party) : [];
    if (narrowed.length !== 1) {
      return { action: "skip", reason: `${electionId} 這一屆有 ${sameElection.length} 位同名候選人，分不出是誰，交給人判斷` };
    }
    return checkCandidacyFields(payload, narrowed[0]);
  }
  return checkCandidacyFields(payload, sameElection[0]);
}

function checkCandidacyFields(payload: Record<string, unknown>, c: CecCandidacy): CecDecision {
  if (c.election_result === null) {
    return { action: "skip", reason: "這一屆還沒投票，沒有結果可以對" };
  }
  const matched: string[] = [];

  const claimedResult = str(payload.election_result);
  if (claimedResult) {
    if (claimedResult !== c.election_result) {
      return { action: "reject", reason: `選舉結果對不上：中選會是「${c.election_result === "elected" ? "當選" : "落選"}」，這筆寫「${claimedResult}」`, candidacy: c };
    }
    matched.push("election_result");
  }

  const claimedVotes = num(payload.votes_received);
  if (claimedVotes !== null) {
    if (c.votes_received === null) return { action: "skip", reason: "中選會這一筆沒有得票數可以對" };
    if (claimedVotes !== c.votes_received) {
      return { action: "reject", reason: `得票數對不上：中選會是 ${c.votes_received}，這筆寫 ${claimedVotes}`, candidacy: c };
    }
    matched.push("votes_received");
  }

  const claimedPercent = num(payload.vote_percentage);
  if (claimedPercent !== null) {
    if (c.vote_percentage === null) return { action: "skip", reason: "中選會這一筆沒有得票率可以對" };
    if (Math.abs(claimedPercent - c.vote_percentage) > PERCENT_TOLERANCE) {
      return { action: "reject", reason: `得票率對不上：中選會是 ${c.vote_percentage}%，這筆寫 ${claimedPercent}%`, candidacy: c };
    }
    matched.push("vote_percentage");
  }

  if (matched.length === 0) return { action: "skip", reason: "沒有任何中選會查得到的欄位（例如只改參選狀態），留給同儕驗證" };
  return { action: "apply", matched, candidacy: c };
}
