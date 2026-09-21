/**
 * 對外協議的版本（2026-09-18）。
 *
 * 代理啟動時讀一次 skill.md 就跑好幾個小時，中途協議改了它不會知道，
 * 會照舊規則做到下一次重啟。所以 /next 每次都回這個版本號，
 * 協議裡要求代理：跟自己手上那份不一樣，就先重讀 skill.md 再繼續。
 *
 * 這個數字必須跟 public/skill.md 檔頭的版本一致——不一致的話，代理會被無限叫去重讀，
 * 而讀到的還是同一份（protocol.test.ts 盯著兩邊）。
 */
export const PROTOCOL_VERSION = "1.15.0";
export const PROTOCOL_URL = "https://policy-tw.web.app/skill.md";
