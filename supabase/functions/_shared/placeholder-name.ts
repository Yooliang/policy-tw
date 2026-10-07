/**
 * 測試資料的姓名守門（2026-10-06，主線裁定）。
 *
 * 2024 台東縣立委有三位「測試候選人ABC／XYZ／QQQ」掛在正式資料裡（人物＋參選紀錄 34401～34403）。
 * 查過的結果：2026-01 早期整批匯入那段時間寫進來的——2024 那一段參選紀錄的 id 從 344xx 起，這三筆排在最前面；
 * 沒有任何交件（contributions）建立它們，查核履歷（edit_history）也是空的（那時還沒有履歷），
 * 01-31 的 migration 20260131100007 再把 2022／2024 全部標成「中選會官方資料」、已核對，連它們一起蓋了章。
 * 現在還能寫人物的路：交件落庫（politician／candidacy）、管理端的匯入端點（batch-import-candidates，走 candidate-import.ts 的
 * ensurePolitician；import-candidate、ai-import-candidate、ai-action 已在 2026-10-07 下架）。另外 09-19 有一筆姓名就叫「測試」的 politician 交件還在等票。
 *
 * 守門三層：交件當下（contribution-schema.ts，400 不算被拒）、建人物時（ensurePolitician 拒建）、資料庫觸發器
 * （migration 20261006140000 的 politician_name_is_placeholder，任何寫入端新增或改名成測試名都擋——連查不到來路的那種）。
 * 三層用同一份字詞，SQL 那份跟這裡由 round2-followups.test.ts 盯一致。
 *
 * 只收「一看就是測試」的字：中文的測試、範例、示範、假資料，英文的 test、dummy、sample、placeholder（英文字要是一個完整的詞，
 * 原住民族語拼音、外文姓名裡的字母組合不會誤中——Testa、Sampleton 不算）。10-06 線上人物 16,233 位、中選會名單 19,775 位，只命中那三位。
 */

export const PLACEHOLDER_NAME_WORDS = ["測試", "範例", "示範", "假資料"] as const;
export const PLACEHOLDER_NAME_LATIN = ["test", "dummy", "sample", "placeholder"] as const;

const RE = new RegExp(`(${PLACEHOLDER_NAME_WORDS.join("|")})|(^|[^A-Za-z])(${PLACEHOLDER_NAME_LATIN.join("|")})([^A-Za-z]|$)`, "i");

export function isPlaceholderName(name: unknown): boolean {
  return typeof name === "string" && RE.test(name.normalize("NFKC"));
}

export const PLACEHOLDER_NAME_MSG =
  "姓名看起來是測試資料（含「測試」「範例」「test」這類字），正式資料不收。真的有這個人的話，照中選會名冊或官方網頁上的姓名寫";
