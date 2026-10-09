import { assert, assertEquals } from "jsr:@std/assert@1";
import { isConsoleOwner, verifyFirebaseIdToken, type Jwk } from "./firebase-id-token.ts";

const PROJECT_ID = "policy-tw";
const OWNER = "cwen0708@gmail.com";

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
  return { privateKey: pair.privateKey, jwk: { kty: jwk.kty!, n: jwk.n!, e: jwk.e!, kid: "test-key-1", alg: "RS256" } as Jwk };
}

async function sign(privateKey: CryptoKey, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const h = b64url(JSON.stringify(header));
  const c = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${h}.${c}`));
  return `${h}.${c}.${b64url(new Uint8Array(sig))}`;
}

const NOW = 1_770_000_000;
function baseClaims(extra: Record<string, unknown> = {}) {
  return {
    sub: "uid-123", aud: PROJECT_ID, iss: `https://securetoken.google.com/${PROJECT_ID}`,
    iat: NOW - 10, exp: NOW + 3600, auth_time: NOW - 10,
    email: OWNER, email_verified: true,
    ...extra,
  };
}

Deno.test("verifyFirebaseIdToken：合法 token（正確簽名、aud、iss、未過期）通過，claims 帶出來", async () => {
  const { privateKey, jwk } = await makeKeyPair();
  const token = await sign(privateKey, { alg: "RS256", kid: jwk.kid }, baseClaims());
  const r = await verifyFirebaseIdToken(token, { projectId: PROJECT_ID, getJwks: async () => ({ keys: [jwk] }), nowSec: NOW });
  assert(r.ok, JSON.stringify(r));
  if (r.ok) {
    assertEquals(r.claims.email, OWNER);
    assert(isConsoleOwner(r.claims, OWNER));
  }
});

Deno.test("verifyFirebaseIdToken：格式不對（不是三段）直接 malformed", async () => {
  const r = await verifyFirebaseIdToken("not-a-jwt", { projectId: PROJECT_ID });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "malformed");
});

Deno.test("verifyFirebaseIdToken：過期回 expired", async () => {
  const { privateKey, jwk } = await makeKeyPair();
  const token = await sign(privateKey, { alg: "RS256", kid: jwk.kid }, baseClaims({ exp: NOW - 10 }));
  const r = await verifyFirebaseIdToken(token, { projectId: PROJECT_ID, getJwks: async () => ({ keys: [jwk] }), nowSec: NOW });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "expired");
});

Deno.test("verifyFirebaseIdToken：aud 不是這個專案回 wrong_audience", async () => {
  const { privateKey, jwk } = await makeKeyPair();
  const token = await sign(privateKey, { alg: "RS256", kid: jwk.kid }, baseClaims({ aud: "some-other-project" }));
  const r = await verifyFirebaseIdToken(token, { projectId: PROJECT_ID, getJwks: async () => ({ keys: [jwk] }), nowSec: NOW });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "wrong_audience");
});

Deno.test("verifyFirebaseIdToken：iss 不是 securetoken.google.com/<project> 回 wrong_issuer", async () => {
  const { privateKey, jwk } = await makeKeyPair();
  const token = await sign(privateKey, { alg: "RS256", kid: jwk.kid }, baseClaims({ iss: "https://evil.example/policy-tw" }));
  const r = await verifyFirebaseIdToken(token, { projectId: PROJECT_ID, getJwks: async () => ({ keys: [jwk] }), nowSec: NOW });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "wrong_issuer");
});

Deno.test("verifyFirebaseIdToken：kid 在 JWKS 裡找不到回 key_not_found", async () => {
  const { privateKey, jwk } = await makeKeyPair();
  const token = await sign(privateKey, { alg: "RS256", kid: "no-such-kid" }, baseClaims());
  const r = await verifyFirebaseIdToken(token, { projectId: PROJECT_ID, getJwks: async () => ({ keys: [jwk] }), nowSec: NOW });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "key_not_found");
});

Deno.test("verifyFirebaseIdToken：payload 被竄改（簽名驗不過）回 bad_signature", async () => {
  const { privateKey, jwk } = await makeKeyPair();
  const token = await sign(privateKey, { alg: "RS256", kid: jwk.kid }, baseClaims());
  const [h, , s] = token.split(".");
  const tampered = `${h}.${b64url(JSON.stringify(baseClaims({ email: "attacker@example.com" })))}.${s}`;
  const r = await verifyFirebaseIdToken(tampered, { projectId: PROJECT_ID, getJwks: async () => ({ keys: [jwk] }), nowSec: NOW });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "bad_signature");
});

Deno.test("verifyFirebaseIdToken：另一把金鑰簽的（換掉私鑰）驗不過", async () => {
  const { jwk } = await makeKeyPair();
  const other = await makeKeyPair();
  const token = await sign(other.privateKey, { alg: "RS256", kid: jwk.kid }, baseClaims());
  const r = await verifyFirebaseIdToken(token, { projectId: PROJECT_ID, getJwks: async () => ({ keys: [jwk] }), nowSec: NOW });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "bad_signature");
});

Deno.test("verifyFirebaseIdToken：JWKS 端點打不到回 jwks_unavailable（不是直接放行）", async () => {
  const { privateKey, jwk } = await makeKeyPair();
  const token = await sign(privateKey, { alg: "RS256", kid: jwk.kid }, baseClaims());
  const r = await verifyFirebaseIdToken(token, { projectId: PROJECT_ID, getJwks: async () => { throw new Error("network down"); }, nowSec: NOW });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "jwks_unavailable");
});

Deno.test("isConsoleOwner：email 對不上，或 email_verified 不是 true，都不算擁有者", () => {
  assert(!isConsoleOwner({ sub: "x", aud: "a", iss: "b", exp: 1, iat: 1, email: "someone-else@example.com", email_verified: true }, OWNER));
  assert(!isConsoleOwner({ sub: "x", aud: "a", iss: "b", exp: 1, iat: 1, email: OWNER, email_verified: false }, OWNER));
  assert(isConsoleOwner({ sub: "x", aud: "a", iss: "b", exp: 1, iat: 1, email: OWNER.toUpperCase(), email_verified: true }, OWNER));
});
