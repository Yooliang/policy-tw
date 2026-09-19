/**
 * 身份解析：把請求裡的 agent_name 與來源 IP 雜湊變成一個身份鍵 actor_id。
 * 設計見 docs/BLUEPRINT-agent-identity.md §3（一個欄位、兩種等級）。
 *
 * actor_id 的格式是 <等級>:<鍵>：
 *   ip:<雜湊>          匿名代理。代號只給人看，身份是來源 IP（2026-09-19 裁決）。
 *   dtrust:<agent_id>  DiTurst 帳號。代理填 agent_name=diturst:<序號>，伺服器向 DiTurst 換 agent_id。
 *
 * 這一版（第 1 步）只認匿名。diturst: 前綴**先擋下來、講清楚還沒開放**，不能當成一般代號收進去——
 * 收了就等於把序號存進 agent_name、印在貢獻榜上。等 DiTurst 的 verify 端點上線再接（第 3 步）。
 */

import { isValidAgentName } from "./consensus.ts";

export const DTRUST_PREFIX = "diturst:";

export type ActorLevel = "ip" | "dtrust";

export interface Actor {
  level: ActorLevel;
  /** <等級>:<鍵>，寫進 contributions.actor_id／contribution_votes.actor_id */
  actor_id: string;
  /** 給人看的代號，寫進 agent_name */
  handle: string;
}

export function actorIdForIp(ipHash: string): string {
  return `ip:${ipHash}`;
}

/** 這個 agent_name 是不是在用 DiTurst 序號登入 */
export function isDtrustLogin(agentName: string): boolean {
  return agentName.toLowerCase().startsWith(DTRUST_PREFIX);
}

/**
 * 回傳不能用這個 agent_name 的原因；null 表示可以。
 * 放在 isValidAgentName 前面呼叫：isValidAgentName 會擋冒號，但那句錯誤訊息不會告訴代理
 * 「你填的是序號、只是還沒開放」，它會以為格式錯而把序號拆開重填——更糟。
 */
export function agentNameProblem(agentName: string): string | null {
  if (isDtrustLogin(agentName)) {
    return "diturst:<序號> 的登入方式還沒開放，請先用一般代號（2～64 字，字母數字與 ._-）。序號不要填進其他欄位。";
  }
  if (!isValidAgentName(agentName)) {
    return "agent_name 必填：使用者代號，2～64 字，字母數字與 ._-（模型名放 agent_tool）";
  }
  return null;
}

/** 第 1 步：只會回匿名身份。之後 dtrust 等級在這裡接上，呼叫端不用改 */
export function resolveActor(agentName: string, ipHash: string): Actor {
  return { level: "ip", actor_id: actorIdForIp(ipHash), handle: agentName };
}
