/**
 * api.hustings.net 的轉送 Worker（cloudflare/api-worker.js；工作單 Yooliang/policy-ops#85）。
 *   - /tw/<名稱> → functions/v1/<名稱>、/jp/<名稱> → functions/v1/jp-<名稱>，只轉白名單，其他 404
 *   - 方法、查詢字串、內文、標頭原樣送；用戶端自己帶的 x-hustings-* 一律先拿掉
 *   - 有密鑰時帶真實 IP（cf-connecting-ip）與密鑰；沒設密鑰時不帶
 *   - 回應原樣回來（狀態碼、CORS），多一個 X-Served-Via
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import worker, { API_ORIGIN, JP_FUNCTIONS, PROXY_CLIENT_IP_HEADER, PROXY_SECRET_HEADER, targetOf, TW_FUNCTIONS, upstreamRequest } from "./api-worker.js";

const BASE = "https://api.hustings.net";
const SECRET = "k".repeat(40);

Deno.test("路徑對應：tw 原名、jp 加 jp- 前綴、保留查詢字串；白名單外與其他路徑 null", () => {
  assertEquals(targetOf(new URL(`${BASE}/tw/next?agent_name=a`)), `${API_ORIGIN}/next?agent_name=a`);
  assertEquals(targetOf(new URL(`${BASE}/tw/report/`)), `${API_ORIGIN}/report`);
  assertEquals(targetOf(new URL(`${BASE}/jp/next`)), `${API_ORIGIN}/jp-next`);
  assertEquals(targetOf(new URL(`${BASE}/jp/contributions-feed?limit=5`)), `${API_ORIGIN}/jp-contributions-feed?limit=5`);
  assertEquals(targetOf(new URL(`${BASE}/tw/system-one`)), null, "內部函式不對外");
  assertEquals(targetOf(new URL(`${BASE}/jp/sources`)), null, "日本站沒有的端點");
  assertEquals(targetOf(new URL(`${BASE}/next`)), null);
  assertEquals(targetOf(new URL(`${BASE}/tw/next/extra`)), null);
  assert(TW_FUNCTIONS.has("next") && JP_FUNCTIONS.has("report"));
});

Deno.test("轉送請求：拿掉用戶端偽造的 x-hustings-*；有密鑰時帶真實 IP 與密鑰；方法與內文照送", async () => {
  const incoming = new Request(`${BASE}/tw/report`, {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: "Bearer anon", "cf-connecting-ip": "203.0.113.9",
      [PROXY_CLIENT_IP_HEADER]: "6.6.6.6", [PROXY_SECRET_HEADER]: "forged",
    },
    body: JSON.stringify({ a: 1 }),
  });
  const up = upstreamRequest(incoming, `${API_ORIGIN}/report`, SECRET);
  assertEquals(up.method, "POST");
  assertEquals(up.url, `${API_ORIGIN}/report`);
  assertEquals(up.headers.get(PROXY_CLIENT_IP_HEADER), "203.0.113.9");
  assertEquals(up.headers.get(PROXY_SECRET_HEADER), SECRET);
  assertEquals(up.headers.get("authorization"), "Bearer anon");
  assertEquals(up.headers.get("cf-connecting-ip"), null);
  assertEquals(await up.text(), JSON.stringify({ a: 1 }));
});

Deno.test("沒設密鑰：不帶 IP 與密鑰標頭（函式退回原本的來源判斷），用戶端偽造的照樣拿掉", () => {
  const incoming = new Request(`${BASE}/tw/next`, { headers: { "cf-connecting-ip": "203.0.113.9", [PROXY_CLIENT_IP_HEADER]: "6.6.6.6", [PROXY_SECRET_HEADER]: "forged" } });
  const up = upstreamRequest(incoming, `${API_ORIGIN}/next`, undefined);
  assertEquals(up.headers.get(PROXY_CLIENT_IP_HEADER), null);
  assertEquals(up.headers.get(PROXY_SECRET_HEADER), null);
});

Deno.test("Worker 本體：白名單外 404；轉送後回應原樣回來（狀態碼、CORS），加 X-Served-Via；/__health 說有沒有密鑰", async () => {
  const realFetch = globalThis.fetch;
  let seen: Request | null = null;
  globalThis.fetch = ((r: Request) => {
    seen = r;
    return Promise.resolve(new Response('{"ok":true}', { status: 201, headers: { "access-control-allow-origin": "*", "content-type": "application/json" } }));
  }) as typeof fetch;
  try {
    const nf = await worker.fetch(new Request(`${BASE}/tw/system-one`), { HUSTINGS_PROXY_SECRET: SECRET });
    assertEquals(nf.status, 404);
    assertEquals(seen, null, "404 的不轉送");
    const res = await worker.fetch(new Request(`${BASE}/jp/next?x=1`, { headers: { "cf-connecting-ip": "198.51.100.7" } }), { HUSTINGS_PROXY_SECRET: SECRET });
    assertEquals(res.status, 201);
    assertEquals(res.headers.get("access-control-allow-origin"), "*");
    assertEquals(res.headers.get("x-served-via"), "api.hustings.net");
    assertEquals(seen!.url, `${API_ORIGIN}/jp-next?x=1`);
    assertEquals(seen!.headers.get(PROXY_CLIENT_IP_HEADER), "198.51.100.7");
    const h = await (await worker.fetch(new Request(`${BASE}/__health`), {})).json();
    assertEquals(h, { ok: true, proxy_secret: false });
  } finally {
    globalThis.fetch = realFetch;
  }
});
