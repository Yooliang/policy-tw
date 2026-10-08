/**
 * 日本站派工憑證的簽章鑰匙。
 *
 * 新寫的（正見用 ../dispatch-token.ts 的 dispatchTokenSecretFrom）。簽驗本身（signDispatchToken／checkDispatchToken）
 * 原封不動沿用 ../dispatch-token.ts；這裡只決定「用哪把鑰匙」，讓正見的憑證日本站驗不過、反過來也一樣：
 *   1. 有設 DISPATCH_TOKEN_SECRET_JP（≥16 字）就用它（日本站專用，最乾淨）；
 *   2. 沒設就拿正見那把基底鑰匙（DISPATCH_TOKEN_SECRET，再退 SUPABASE_SERVICE_ROLE_KEY）加上固定鹽 `|policy_jp`——
 *      HMAC 的鑰匙不同，簽章就不同，所以不需要新增 secret 也不會跟正見互通。
 * 選這個做法而不是「把 jp 範圍簽進 payload」：payload 的格式（t／a／i／e／h）是 dispatch-token.ts 的，不改它；
 * 換鑰匙是整張憑證不互通，比靠 payload 欄位比對更不容易漏檢。
 */
import { dispatchTokenSecretFrom, DISPATCH_SECRET_MIN_LENGTH } from "../dispatch-token.ts";

export const JP_TOKEN_SALT = "|policy_jp";

export function jpDispatchTokenSecretFrom(get: (name: string) => string | undefined): string | undefined {
  const dedicated = get("DISPATCH_TOKEN_SECRET_JP");
  if (typeof dedicated === "string" && dedicated.length >= DISPATCH_SECRET_MIN_LENGTH) return dedicated;
  const base = dispatchTokenSecretFrom(get);
  return base ? base + JP_TOKEN_SALT : undefined;
}

/** 鑰匙不能用時每次冷啟動警告一行（同 dispatch-token.ts 的 createSecretWarner，這裡看日本站的鑰匙） */
export function createJpSecretWarner(warn: (msg: string) => void = (m) => console.warn(m)): (get: (name: string) => string | undefined) => void {
  let warned = false;
  return (get) => {
    if (warned) return;
    const dedicated = get("DISPATCH_TOKEN_SECRET_JP");
    const dedicatedTooShort = typeof dedicated === "string" && dedicated.length > 0 && dedicated.length < DISPATCH_SECRET_MIN_LENGTH;
    const usable = jpDispatchTokenSecretFrom(get);
    if (usable && !dedicatedTooShort) return;
    warned = true;
    // 同 dispatch-token.ts 的 createSecretWarner：專用鑰匙有設但太短時講一聲（不然會悄悄退回加鹽的正見鑰匙）
    warn(usable
      ? `[jp dispatch-token] DISPATCH_TOKEN_SECRET_JP 有設但短於 ${DISPATCH_SECRET_MIN_LENGTH} 字，已忽略，改用正見的基底鑰匙加鹽（憑證照樣能發、跟正見不互通）。`
      : "[jp dispatch-token] 沒有可用的憑證鑰匙：jp-next 不會發 dispatch_token，跨網段的回報會吃 409 not_dispatched。DISPATCH_TOKEN_SECRET_JP／DISPATCH_TOKEN_SECRET／SUPABASE_SERVICE_ROLE_KEY 都不能用。");
  };
}
