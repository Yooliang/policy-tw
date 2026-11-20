/**
 * 「那一屆已投票且當選」的底層判斷（維護者 2026-10-19，協議 1.99.0；issue #672「承諾→政見」要用同一個條件）。
 *
 * 兩層：
 *   1. 這一支（最底層）：一條政見所屬的那一屆，已經投票（投票日早於今天；**投票日當天算還沒投票**），而且提出者在那一屆的參選紀錄有一筆當選
 *      （candidacy_status＝elected）。看**那條政見所屬的那一屆**（policies.election_id），不是看這個人現在在不在任。
 *      SQL 那一份是 policy_is_elected_term(政見 id, 今天 date；預設 activity_today()＝台北日期)（migration 20261019020000），lineage-elected-only.test.ts 把兩邊放在同一批資料上、
 *      用好幾個「今天」逐案比對。
 *   2. 脈絡的資格（lineage.ts 的 lineagePolicyIneligibleReason／SQL lineage_policy_ineligible_reason）建在這一層上面：
 *      先排除找不到、已移除、沒標屆別，再問這一層，不通過才分「還沒投票」或「沒當選」。
 *
 * 純函式、沒有任何 import：前端 lib 也可以直接引用（前端現行的「當選者」判斷是 lib/lineage.ts 的 termRoleLabel，
 * 不看投票日、另把現任公職當成當選；#672 要收斂成這一支）。
 */

/** 判斷要用到的事實（資料庫裡的原值，不先下結論） */
export interface ElectedTermFacts {
  /** 那條政見所屬那一屆的投票日（YYYY-MM-DD，帶時間也只看日期部分）；政見沒標屆別、或那一屆不存在給 null */
  election_date: string | null;
  /** 提出者在那一屆的每一筆參選紀錄的 candidacy_status（沒有紀錄就是空陣列） */
  candidacy_statuses: ReadonlyArray<string | null>;
}

/** 今天（台北日期，YYYY-MM-DD；跟 SQL 的 activity_today() 同一個口徑，台北沒有夏令時間，固定 +8 小時） */
export function taipeiToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 那一屆已經投票（投票日早於 today；投票日當天算還沒投票）。沒有投票日＝不知道，當成還沒 */
export function isElectionVoted(electionDate: string | null | undefined, today: string = taipeiToday()): boolean {
  return !!electionDate && electionDate.slice(0, 10) < today;
}

/** 那一屆已投票，而且提出者在那一屆有當選紀錄（同一屆有幾筆紀錄，只要有一筆當選） */
export function isElectedTerm(f: ElectedTermFacts, today: string = taipeiToday()): boolean {
  return isElectionVoted(f.election_date, today) && f.candidacy_statuses.includes("elected");
}

/** 一筆參選紀錄與那一屆的任期起訖（election_term_start／election_term_end 算出來的值；迄日沒有就給 null） */
export interface ElectedTermWindow {
  election_date: string | null;
  candidacy_status: string | null;
  term_start: string | null;
  term_end: string | null;
}

/**
 * 這個日期是不是落在某一個當選任期內（立場的表態日、事件的決定日用；policy-tw#675 第一期）。
 * 那一屆已投票（投票日當天算還沒）、當選，而且 term_start ≤ 日期 ≤ term_end（迄日沒有就當沒有迄日）。
 * SQL 那一份是 lineage_stance_within_elected_term(人物, 日期, 今天)（migration 20261120120000），lineage-stances-events.test.ts 逐案比對。
 */
export function isDateWithinElectedTerm(windows: ReadonlyArray<ElectedTermWindow>, date: string, today: string = taipeiToday()): boolean {
  const d = date.slice(0, 10);
  return windows.some((w) =>
    isElectedTerm({ election_date: w.election_date, candidacy_statuses: [w.candidacy_status] }, today) &&
    w.term_start !== null && d >= w.term_start.slice(0, 10) && (w.term_end === null || d <= w.term_end.slice(0, 10)));
}
