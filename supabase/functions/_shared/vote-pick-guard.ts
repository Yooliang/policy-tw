/**
 * 投票帶了同名指認（resolved_politician_id），被驗的卻不是會用到指認的型別（2026-10-13）。
 *
 * 指認只在 politician／candidacy（同名多位時選一位）、policy（以姓名指人物）與 adjudication（身份爭議的裁決）有用。其他型別帶指認，幾乎都是代理把上一件的判斷貼到這一件：
 * 蔣萬安營養午餐那筆 correction（屆別 2022→2026）的第一張同意票，理由寫的是宜蘭縣議員李淑芬、指認也是李淑芬，派出後 3 秒就投下；
 * 正式庫另有 4 張 no_change 的票同樣如此（都是「確認某某為議員，與系統判定候選人身份相符」的套語）。這種票不收，請代理重看這一件。
 */
// adjudication：身份爭議的裁決也可能要指認（adjudication.ts）
const PICK_TYPES = new Set(["politician", "candidacy", "policy", "adjudication"]);

export function votePickProblem(contributionType: string, resolvedPoliticianId: unknown): string | null {
  if (resolvedPoliticianId === undefined || resolvedPoliticianId === null || resolvedPoliticianId === "") return null;
  if (PICK_TYPES.has(contributionType)) return null;
  return `這筆是 ${contributionType}，不需要同名指認，你卻帶了 resolved_politician_id。這通常表示這張票的內容是寫給另一件的。` +
    "請重新打開這一件的內容與來源，依這一件本身判斷後再投（不要帶 resolved_politician_id）。這不算你被拒。";
}
