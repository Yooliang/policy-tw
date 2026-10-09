/**
 * 日本站的自引用檢查（照搬正見 1.84.0 #486，日本協議 0.8.0）。
 * 網域清單不另寫一份，共用 ../self-hosts.ts 的 SELF_HOSTS（含 hustings.net、兩站 web.app、正見.tw、API）；
 * 這裡只放日本站回給代理的說明文字（正見那句寫的是「正見本身」，日本站要講「本站」）。
 */
export const JP_SELF_CITATION_MESSAGE =
  "出處不可引用本站或正見：jp.hustings.net（hustings.net 整個網域）、policy-jp.web.app、正見.tw、policy-tw.web.app 與 API 都是我們自己整理的資料，拿來當出處是循環引用。請改附原始出處（選管告示、總務省、自治體公式網站、議會會議錄、統計）";
