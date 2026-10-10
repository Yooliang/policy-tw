/**
 * 日本站（policy-jp）對外協議的版本與網址。
 *
 * 複製自 ../protocol.ts（正見：PROTOCOL_VERSION／PROTOCOL_URL），只換成日本站自己的值。
 * 版號要跟 policy-jp 的 public/skill.md 開頭一致；對不上時代理會被叫去重讀同一份文件，所以兩邊同批上線
 * （正見是 protocol.test.ts 盯，日本站這邊目前沒有對應的守門）。
 * 網址：2026-10-09 起日本站正式網址是 jp.hustings.net（policy-ops docs/decisions/2026-10-09-hustings網域.md）；
 * 舊的 policy-jp.web.app/skill.md 仍讀得到，所以換網址不升版。
 */
export const JP_PROTOCOL_VERSION = "0.11.0";
export const JP_PROTOCOL_URL = "https://jp.hustings.net/skill.md";
