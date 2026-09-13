/**
 * 讀者對既有政見表態（支持／反對／更在意）。純函式：合法值判斷與 DB 欄位映射，
 * 避免魔術數字散在端點裡。policy_stances.stance 在 DB 是 SMALLINT
 * （1／-1／2，見 migration 20260913000001）。
 *
 * 這跟「貢獻的同儕驗證」是兩回事：驗證決定資料真假、要附來源；表態只是民意，
 * 不影響任何一筆資料會不會上線。
 */

export const POLICY_STANCES = ["support", "oppose", "priority"] as const;
export type PolicyStance = (typeof POLICY_STANCES)[number];

/** 同一個來源 IP 每日最多表態幾次 */
export const POLICY_STANCE_DAILY_LIMIT_PER_IP = 30;

/** DB 的 SMALLINT 值。加第四種時只動這裡與 migration 的 CHECK。 */
const VALUE: Record<PolicyStance, 1 | -1 | 2> = { support: 1, oppose: -1, priority: 2 };

export function isPolicyStance(v: unknown): v is PolicyStance {
  return typeof v === "string" && (POLICY_STANCES as readonly string[]).includes(v);
}

export function policyStanceValue(stance: PolicyStance): 1 | -1 | 2 {
  return VALUE[stance];
}

/** DB 值轉回名稱：回應要告訴前端「你現在的立場是哪個」，好把按鈕標成已選 */
export function policyStanceName(value: number): PolicyStance | null {
  const hit = (POLICY_STANCES as readonly PolicyStance[]).find((s) => VALUE[s] === value);
  return hit ?? null;
}
