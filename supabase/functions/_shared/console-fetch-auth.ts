/**
 * console-fetch 的呼叫者驗證（2026-10-07）。
 *
 * 這個專案現有的 pg_cron → Edge Function 呼叫（cec-sync、moi-sync、news-fetch…）一律不帶任何憑證、閘道也不驗 JWT，
 * 靠「同一單位 N 小時內抓過就空轉」讓外人重複打也無害（2026-10-07 唯讀查正式庫 cron.job：沒有任何一條帶 Authorization 或用到 vault）。
 * console-fetch 不能照抄那一套：它每次都會打 GA／AdSense／Firestore 並寫入，沒有可空轉的單位，公開就是任何人都能燒配額。
 * 所以多這一道：呼叫者要帶下列其中一種憑證，兩種都沒設定時一律拒絕（fail closed）：
 *   1. x-cron-secret 標頭＝環境變數 CONSOLE_FETCH_CRON_SECRET（pg_cron 從 Supabase Vault 讀同一個值帶過來，見 migration）；
 *   2. Authorization: Bearer <service role key>（與 system-one 的 ask 動作同一種做法，給維護者手動呼叫）。
 * 比對用 SHA-256 摘要後逐位元組比，不因為第一個不同的字元就提早結束。
 */

const MIN_SECRET_LENGTH = 16;

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** 恆定時間的字串相等 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export interface CallerCredentials {
  /** 環境變數 CONSOLE_FETCH_CRON_SECRET */
  cronSecret?: string;
  /** 環境變數 SUPABASE_SERVICE_ROLE_KEY */
  serviceRoleKey?: string;
}

export type CallerCheck =
  | { ok: true; via: "cron-secret" | "service-role" }
  | { ok: false; status: 401 | 503; error: string };

export function bearerOf(headers: Headers): string | null {
  const h = headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

export async function verifyCaller(headers: Headers, cred: CallerCredentials): Promise<CallerCheck> {
  const cronSecret = cred.cronSecret && cred.cronSecret.length >= MIN_SECRET_LENGTH ? cred.cronSecret : undefined;
  const serviceKey = cred.serviceRoleKey || undefined;
  if (!cronSecret && !serviceKey) {
    return { ok: false, status: 503, error: "沒有設定可驗證呼叫者的憑證（CONSOLE_FETCH_CRON_SECRET 缺少或少於 16 字元）" };
  }
  const sent = headers.get("x-cron-secret");
  if (cronSecret && sent && (await safeEqual(sent, cronSecret))) return { ok: true, via: "cron-secret" };
  const bearer = bearerOf(headers);
  if (serviceKey && bearer && (await safeEqual(bearer, serviceKey))) return { ok: true, via: "service-role" };
  return { ok: false, status: 401, error: "unauthorized" };
}