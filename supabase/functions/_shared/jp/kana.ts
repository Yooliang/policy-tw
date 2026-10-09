/**
 * 總務省「全国地方公共団体コード」的讀音（半角カナ，例：ｻｯﾎﾟﾛｼ）→ 交件用的ひらがな（さっぽろし）。
 *
 * 先 NFKC（半角轉全角、ﾞﾟ併進前一個字），再把カタカナ（ァ〜ヶ）平移成ひらがな；長音「ー」保留。
 * 交件的 kana 要全部是ひらがな（contribution-schema.ts 的 JP_KANA_RE），機器核對（lg_code_registry.kana）也存這個形式，
 * 兩邊用同一支函式，產生器（scripts/gen-jp-lg-registry.ts）與測試共用。
 */

export function hiraganaOf(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
