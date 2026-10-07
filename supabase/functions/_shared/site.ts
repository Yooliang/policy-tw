/**
 * 站點網址（盤點 #7，2026-10-07 維護者同意）：Edge Function 對外給人看／點的網站連結（人物頁、政見頁、任務看板）一律從這裡拿。
 *
 * 以前前端用 正見.tw、Edge Function 十幾處寫死 policy-tw.web.app（2026-09-22 換網域時只換了前端一半），
 * 代理拿到的連結與分享出去的連結不是同一個網域。現在：環境變數 SITE_URL（Supabase 的 secrets），沒設＝正見.tw。
 * 值只收「https 的網站根網址」（不含路徑），寫錯（缺 https、帶路徑、空字串）一律當沒設，不讓一個設定錯誤把全部連結弄壞。
 *
 * **不在這裡的**：協議文件網址 PROTOCOL_URL（_shared/protocol.ts）——它是版本握手的一部分，有 protocol-guard.test 守，維持
 * policy-tw.web.app/skill.md（回應裡的 docs 欄位與錯誤訊息提到 skill.md 也都引用它，不是 SITE_URL）；
 * 送給第三方網站的 User-Agent（cec-verify、source-archive 的「+網址」）也維持原樣，改了對方若有照 UA 放行就會斷。
 */

export const DEFAULT_SITE_URL = "https://xn--2lw665d.tw";

/** 只收 https 的網站根網址；結尾斜線去掉；其餘（空、沒有 https、帶路徑／查詢）回 null */
export function parseSiteUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/?#]+$/i.test(t)) return null;
  try {
    return new URL(t).origin;
  } catch {
    return null;
  }
}

function envGet(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined; // 沒有 env 權限（測試）就當沒設
  }
}

/** 站點網址：SITE_URL 環境變數，沒設或寫錯＝正見.tw */
export function siteUrl(get: (name: string) => string | undefined = envGet): string {
  const raw = get("SITE_URL");
  const parsed = parseSiteUrl(raw);
  if (raw !== undefined && raw.trim() !== "" && parsed === null) console.error(`SITE_URL 的值不是 https 網站根網址，改用預設 ${DEFAULT_SITE_URL}：${raw}`);
  return parsed ?? DEFAULT_SITE_URL;
}
