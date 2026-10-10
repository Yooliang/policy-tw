/**
 * 對外協議的版本（2026-09-18）。
 *
 * 代理啟動時讀一次 skill.md 就跑好幾個小時，中途協議改了它不會知道，
 * 會照舊規則做到下一次重啟。所以 /next 每次都回這個版本號，
 * 協議裡要求代理：跟自己手上那份不一樣，就先重讀 skill.md 再繼續。
 *
 * 這個數字必須跟 public/skill.md 檔頭的版本一致——不一致的話，代理會被無限叫去重讀，
 * 而讀到的還是同一份（protocol.test.ts 盯著兩邊）。
 *
 * 版號只有兩處：這個常數（唯一真相）＋ skill.md 檔頭那一行（代理看得到的）。skill.md 檔尾
 * 不再重複版號（#492：以前檔頭檔尾兩處常常跟著別人的 PR 一起撞衝突）。測試不得把「現行」
 * 版號寫成等號比對（守門：protocol-version-literal.test.ts）；要驗「這個功能
 * 從哪版起有」，用「不低於某版」。升版號由主線配號。
 */
export const PROTOCOL_VERSION = "1.90.0";
export const PROTOCOL_URL = "https://policy-tw.web.app/skill.md";
