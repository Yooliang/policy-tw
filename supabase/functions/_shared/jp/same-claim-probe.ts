/**
 * jp-next 派任務時，用任務本身的鍵查「同一件事」（#521）：任務還沒有 payload，從 task_id 拆出要比對的型別與鍵，
 * 交給 policy_jp.same_claim_matches 的探查模式（election 只給團體＋職位＋任期満了日、統計與團體只給團體碼）。
 * task_id 的格式照臂（20261009130100／210100）：
 *   auto:election_discovery:<term_end>:<lg_code>:<head|assembly>
 *   auto:local_government_missing:<lg_code>
 *   auto:regional_stats_missing:<lg_code>
 *   auto:policy_missing:<參選紀錄 id>                                                          → policy（第 4 步）
 *   auto:profile_gap:<人物 id>／auto:profile_detail_gap:<人物 id>／auto:profile_detail_gap:sources:<人物 id>  → politician（選舉鏈第 3 步）
 */
export function jpSameClaimProbe(taskId: string): { type: string; payload: Record<string, unknown> } | null {
  let m = /^auto:election_discovery:(\d{4}-\d{2}-\d{2}):(\d{6}):(head|assembly)$/.exec(taskId);
  if (m) return { type: "election", payload: { term_end: m[1], lg_code: m[2], office_kind: m[3] } };
  m = /^auto:local_government_missing:(\d{6})$/.exec(taskId);
  if (m) return { type: "local_government", payload: { lg_code: m[1] } };
  m = /^auto:regional_stats_missing:(\d{6})$/.exec(taskId);
  if (m) return { type: "regional_stat", payload: { lg_code: m[1] } };
  // 建檔の任務（選舉鏈第 3 步）：事実を書かない探査＝この人の庫にある事実と審議中の提出を全部
  m = /^auto:(?:profile_gap|profile_detail_gap(?::sources)?):(\S+)$/.exec(taskId);
  if (m) return { type: "politician", payload: { politician_id: m[1] } };
  // 政見の任務（選舉鏈第 4 步）：題名を書かない探査＝この参選に掛かっている公約と審議中の提出を全部
  m = /^auto:policy_missing:(\S+)$/.exec(taskId);
  if (m) return { type: "policy", payload: { politician_election_id: m[1] } };
  return null;
}
