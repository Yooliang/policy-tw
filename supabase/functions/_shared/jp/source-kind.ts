/**
 * 出處網址的等級（依網域）——SQL policy_jp.source_kind_for_url 的 TS 版（20261009210000_policy_jp_apply.sql）。
 *
 * 用在兩個地方：
 *   1. 交件時：local_government、regional_stat 的 source_urls 至少要有一個 official 或 statistics 的網址
 *      （總務省的団体コード表／e-Stat／總務省統計／該団体的公式サイト）；
 *   2. 落庫時（SQL 版）：決定 sources.source_kind，第一個 official／statistics 的網址當主要出處。
 * 對齊測試（policy-jp-apply.test.ts）用 PGlite 對一批網址逐一比對，改一邊會紅。
 *
 * 規則（跟 SQL 一字一義）：
 *   statistics ＝ e-stat.go.jp、stat.go.jp（含子網域）；regional_stat 的 soumu.go.jp 也算
 *   official   ＝ *.go.jp、*.lg.jp，以及 city./town./vill./village./pref./ward. 開頭、.jp 結尾的網域（地方公共団体的地理型網域）
 *   other      ＝ 其餘（媒體、社群、一般網站）
 * 注意：這是「看網域」的啟發式，不是驗證——同儕驗證才判斷內容對不對（沿用 2026-09-12 裁示：來源等級只是優先序，不是白名單）。
 */

export type JpSourceKind = "official" | "statistics" | "other";

/** 網址的主機名（小寫）；不是 http(s) 或解析不出回 null（跟 SQL 的 substring 規則一致：不含埠號與 userinfo） */
function hostOf(url: string): string | null {
  const m = /^https?:\/\/([^/:?#@]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

export function jpSourceKind(url: string, contributionType?: string): JpSourceKind {
  const h = hostOf(url);
  if (!h) return "other";
  if (/(^|\.)(e-stat|stat)\.go\.jp$/.test(h)) return "statistics";
  if (/(^|\.)soumu\.go\.jp$/.test(h) && contributionType === "regional_stat") return "statistics";
  if (/\.(go|lg)\.jp$/.test(h)) return "official";
  if (/(^|\.)(city|town|vill|village|pref|ward)\.[a-z0-9.-]+\.jp$/.test(h)) return "official";
  return "other";
}

/** official 或 statistics ＝ 公的な出典 */
export const isJpOfficialSource = (url: string, contributionType?: string): boolean => jpSourceKind(url, contributionType) !== "other";
