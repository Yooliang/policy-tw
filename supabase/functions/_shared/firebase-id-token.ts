/**
 * Firebase ID Token 驗證（主控台 console-admin 用，#518，2026-10-09）。
 *
 * 這個 repo 之前沒有驗 Firebase ID token 的程式（既有的呼叫者驗證都是 cron secret 或 service_role bearer，見 console-fetch-auth.ts）；
 * 主控台（policy-console）用 Firebase Auth（Google 登入）認使用者，console-admin 要能獨立驗證它拿到的 ID token，不依賴 firebase-admin（Deno
 * edge runtime 裡沒裝這個套件，這個專案的慣例也是用 Web Crypto 手刻 JWT，見 console-fetch.ts 的 buildJwtAssertion）。
 *
 * 流程（照 Google 文件 https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library）：
 *   1. 不驗簽先解 header 拿 kid、解 payload 做基本檢查（exp／iat／auth_time／aud／iss）。
 *   2. 用 kid 去 Google 的 JWKS 端點（https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com）
 *      找對應的公開金鑰（RSA JWK，可以直接餵給 crypto.subtle.importKey("jwk", …)，不用自己轉 PEM／PKCS8）。
 *   3. RS256 驗簽（crypto.subtle.verify）。
 *   4. 簽名與基本檢查都過，才檢查 email_verified 與 email 是不是主控台擁有者。
 *
 * JWKS 允許注入（測試用自己簽的金鑰，不用真的打 Google），照 console-fetch-auth.ts checkCronSecret 的依賴注入風格。
 */

export interface FirebaseIdTokenClaims {
  sub: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  auth_time?: number;
  email?: string;
  email_verified?: boolean;
  [key: string]: unknown;
}

export type VerifyResult =
  | { ok: true; claims: FirebaseIdTokenClaims }
  | { ok: false; reason: "malformed" | "expired" | "bad_signature" | "wrong_audience" | "wrong_issuer" | "key_not_found" | "jwks_unavailable" };

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

export interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
  [key: string]: unknown;
}

const GOOGLE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/** 預設從 Google 抓 JWKS；模組層快取（金鑰輪替很慢，一輪 function 的生命期內重用沒關係） */
let cachedJwks: Promise<{ keys: Jwk[] }> | undefined;
export async function fetchGoogleJwks(): Promise<{ keys: Jwk[] }> {
  if (!cachedJwks) {
    cachedJwks = fetch(GOOGLE_JWKS_URL).then((r) => {
      if (!r.ok) throw new Error(`JWKS ${r.status}`);
      return r.json() as Promise<{ keys: Jwk[] }>;
    }).catch((e) => {
      cachedJwks = undefined; // 失敗不要快取，下次重打
      throw e;
    });
  }
  return cachedJwks;
}

export interface VerifyOptions {
  /** Firebase 專案 id（aud 與 iss 都要對得上這個） */
  projectId: string;
  /** 取代預設的 fetchGoogleJwks（測試用：餵自己簽的金鑰） */
  getJwks?: () => Promise<{ keys: Jwk[] }>;
  /** 測試用假時鐘（epoch 秒） */
  nowSec?: number;
}

export async function verifyFirebaseIdToken(token: string, opts: VerifyOptions): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string; kid?: string };
  let claims: FirebaseIdTokenClaims;
  try {
    header = b64urlToJson(headerB64);
    claims = b64urlToJson(payloadB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "RS256" || !header.kid) return { ok: false, reason: "malformed" };
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "expired" };
  if (typeof claims.iat !== "number" || claims.iat > now + 60) return { ok: false, reason: "malformed" }; // 容許 60 秒時鐘誤差
  if (claims.aud !== opts.projectId) return { ok: false, reason: "wrong_audience" };
  if (claims.iss !== `https://securetoken.google.com/${opts.projectId}`) return { ok: false, reason: "wrong_issuer" };
  if (!claims.sub || typeof claims.sub !== "string") return { ok: false, reason: "malformed" };

  let jwks: { keys: Jwk[] };
  try {
    jwks = await (opts.getJwks ?? fetchGoogleJwks)();
  } catch {
    return { ok: false, reason: "jwks_unavailable" };
  }
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: "key_not_found" };

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(sigB64), signedData);
  if (!ok) return { ok: false, reason: "bad_signature" };
  return { ok: true, claims };
}

/** 主控台擁有者判定：email 對得上、而且 Google 這邊已驗證過 email（跟 policy-console 的 App.vue isOwner() 同一條件） */
export function isConsoleOwner(claims: FirebaseIdTokenClaims, ownerEmail: string): boolean {
  return claims.email_verified === true && typeof claims.email === "string" && claims.email.toLowerCase() === ownerEmail.toLowerCase();
}
