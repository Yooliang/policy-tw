/**
 * 任內施政承諾不能掛在還沒投票的選舉（2026-10-13）。
 *
 * status 不是 Campaign Pledge 的政見是「任內施政承諾」：election_id 要填他這一任當選的那屆（已經投過票的那場，見 skill-types.md 的 policy）。
 * 掛在還沒投票的選舉上，人物頁會把它放進「過往政績與追蹤」、標成那場還沒舉行的選舉（蔣萬安的營養午餐免費被 correction 從 2022 改成 2026，
 * 理由是「提出日期晚於 2022 投票日」——那正是任內施政的特徵，不是屆別錯了）。
 * 交件（policy）與更正（correction 改 policies 的 election_id 或 status）共用這一條。
 */
export function inOfficePolicyFutureElectionProblem(
  status: unknown,
  election: { id: number; election_date: string } | undefined,
  today: string,
): string | null {
  if (status === undefined || status === null || status === "Campaign Pledge") return null;
  if (!election || election.election_date <= today) return null;
  return `這筆政見的 status 是 ${String(status)}（任內施政承諾或已在推動），卻掛在 ${election.election_date} 才投票、還沒舉行的那場選舉。` +
    "任內施政承諾的 election_id 要填他這一任當選的那屆（已經投過票的那場）；提出日期晚於那場投票日是正常的，不是屆別錯了。" +
    "若它其實是這次選舉的競選承諾，status 要用 Campaign Pledge。這不算被拒。";
}
