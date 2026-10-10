/**
 * 用 GCP 服務帳號金鑰（JSON）換 OAuth access token（JWT bearer grant，RS256，WebCrypto 簽）。
 * 給 console-vm 打 Compute Engine API 用；金鑰放 Supabase secret CONSOLE_VM_SA_KEY，不進 repo。
 * token 有效一小時，同一個 isolate 內快取到過期前 5 分鐘。
 */

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = "https://www.googleapis.com/auth/compute";
let cache: { token: string; exp: number; email: string } | null = null;

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(body);
  const out = new ArrayBuffer(raw.length);
  const view = new Uint8Array(out);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return out;
}

export function parseServiceAccountKey(text: string | undefined): ServiceAccountKey | null {
  if (!text) return null;
  try {
    const k = JSON.parse(text);
    return typeof k.client_email === "string" && typeof k.private_key === "string" ? k : null;
  } catch {
    return null;
  }
}

export async function accessToken(key: ServiceAccountKey, fetchFn: typeof fetch = fetch): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.email === key.client_email && cache.exp - 300 > now) return cache.token;
  const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
  const signingKey = await crypto.subtle.importKey(
    "pkcs8", pemToDer(key.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(`${header}.${claims}`)));
  const assertion = `${header}.${claims}.${b64url(sig)}`;
  const res = await fetchFn(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`取 GCP token 失敗（HTTP ${res.status}）`);
  const j = await res.json();
  cache = { token: j.access_token, exp: now + (j.expires_in ?? 3600), email: key.client_email };
  return j.access_token;
}
