/**
 * console-fetch 的呼叫者驗證（2026-10-07，10-08 改成密鑰只放資料庫）。
 *
 * 這個專案現有的 pg_cron → Edge Function 呼叫（cec-sync、moi-sync、news-fetch…）一律不帶任何憑證、閘道也不驗 JWT，
 * 靠「同一單位 N 小時內抓過就空轉」讓外人重複打也無害（2026-10-07 唯讀查正式庫 cron.job：沒有任何一條帶 Authorization 或用到 vault）。
 * console-fetch 不能照抄那一套：它每次都會打 GA／AdSense／Firestore 並寫入，沒有可空轉的單位，公開就是任何人都能燒配額。
 * 所以多這一道：呼叫者要帶下列其中一種憑證，驗不過或驗證本身出錯都不放行（fail closed）：
 *   1. x-cron-secret 標頭：值由 migration 自己產生、只存在 Supabase Vault；pg_cron 從 Vault 讀出來帶，
 *      函式端不持有這個值，而是呼叫 SQL 函式 console_fetch_cron_secret_ok(p_secret)（SECURITY DEFINER，只授權 service_role）請資料庫比對。
 *      這樣上線時不用有人在 Vault 與 Edge Function secrets 各放一份一樣的值；要換密鑰只要更新 Vault 那一筆。
 *   2. Authorization: Bearer <service role key>（與 system-one 的 ask 動作同一種做法，給維護者手動呼叫）。
 * service role 的比對用 SHA-256 摘要後逐位元組比，不因為第一個不同的字元就提早結束；cron secret 的比對在資料庫端也是比摘要。
 */

/** 密鑰長度的合理範圍：migration 產的是 64 字元十六進位；過短或過長的直接當不合格，不去打資料庫 */
const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 256;

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
  /** 環境變數 SUPABASE_SERVICE_ROLE_KEY（Edge runtime 自帶） */
  serviceRoleKey?: string;
  /** 請資料庫比對 x-cron-secret（呼叫 RPC console_fetch_cron_secret_ok）；丟錯代表驗證服務不可用 */
  checkCronSecret?: (secret: string) => Promise<boolean>;
}

export type CallerCheck =
  | { ok: true; via: "cron-secret" | "service-role" }
  | { ok: false; status: 401 | 503; error: string };

export function bearerOf(headers: Headers): string | null {
  const h = headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

export async function verifyCaller(headers: Headers, cred: CallerCredentials): Promise<CallerCheck> {
  const serviceKey = cred.serviceRoleKey || undefined;
  if (!serviceKey && !cred.checkCronSecret) {
    return { ok: false, status: 503, error: "沒有可驗證呼叫者的憑證來源（SUPABASE_SERVICE_ROLE_KEY 缺少）" };
  }
  const bearer = bearerOf(headers);
  if (serviceKey && bearer && (await safeEqual(bearer, serviceKey))) return { ok: true, via: "service-role" };
  const sent = headers.get("x-cron-secret");
  if (cred.checkCronSecret && sent && sent.length >= MIN_SECRET_LENGTH && sent.length <= MAX_SECRET_LENGTH) {
    let ok = false;
    try {
      ok = (await cred.checkCronSecret(sent)) === true;
    } catch {
      return { ok: false, status: 503, error: "驗證服務暫時不可用（console_fetch_cron_secret_ok 呼叫失敗）" };
    }
    if (ok) return { ok: true, via: "cron-secret" };
  }
  return { ok: false, status: 401, error: "unauthorized" };
}