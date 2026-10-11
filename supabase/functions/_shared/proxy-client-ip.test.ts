/**
 * api.hustings.net 轉送的真實來源 IP（工作單 Yooliang/policy-ops#85；cloudflare/api-worker.js、ip-network.ts 的 clientIpFrom）。
 *   - 密鑰對（而且函式端有設、夠長）才採信 x-hustings-client-ip；其他情況一律照原本的 x-forwarded-for／x-real-ip
 *   - 偽造：沒設密鑰、密鑰太短、密鑰錯、只帶 IP 不帶密鑰，都不採信
 *   - 兩站的 clientIp 都走 clientIpFrom、讀 Supabase secrets 的 HUSTINGS_PROXY_SECRET；程式碼裡沒有密鑰的值
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { clientIpFrom, PROXY_CLIENT_IP_HEADER, PROXY_SECRET_HEADER, PROXY_SECRET_MIN_LENGTH } from "./ip-network.ts";
const IPN = await Deno.readTextFile(new URL("./ip-network.ts", import.meta.url));

const SECRET = "s".repeat(PROXY_SECRET_MIN_LENGTH);
const req = (h: Record<string, string>) => new Request("https://x.supabase.co/functions/v1/next", { headers: h });
const VIA_PROXY = { "x-forwarded-for": "104.28.1.2", [PROXY_CLIENT_IP_HEADER]: "203.0.113.9", [PROXY_SECRET_HEADER]: SECRET };

Deno.test("密鑰對：用 Worker 轉送的真實 IP", () => {
  assertEquals(clientIpFrom(req(VIA_PROXY), SECRET), "203.0.113.9");
});

Deno.test("偽造無效：沒設密鑰、密鑰太短、密鑰錯、少密鑰標頭、少 IP 標頭，一律照 x-forwarded-for", () => {
  assertEquals(clientIpFrom(req(VIA_PROXY), undefined), "104.28.1.2", "函式端沒設密鑰");
  assertEquals(clientIpFrom(req(VIA_PROXY), ""), "104.28.1.2");
  const short = "s".repeat(PROXY_SECRET_MIN_LENGTH - 1);
  assertEquals(clientIpFrom(req({ ...VIA_PROXY, [PROXY_SECRET_HEADER]: short }), short), "104.28.1.2", "密鑰太短當沒設");
  assertEquals(clientIpFrom(req({ ...VIA_PROXY, [PROXY_SECRET_HEADER]: "t".repeat(PROXY_SECRET_MIN_LENGTH) }), SECRET), "104.28.1.2", "密鑰錯");
  assertEquals(clientIpFrom(req({ ...VIA_PROXY, [PROXY_SECRET_HEADER]: SECRET + "x" }), SECRET), "104.28.1.2", "長度不同");
  const { [PROXY_SECRET_HEADER]: _s, ...noSecret } = VIA_PROXY;
  assertEquals(clientIpFrom(req(noSecret), SECRET), "104.28.1.2", "只帶 IP 不帶密鑰");
  const { [PROXY_CLIENT_IP_HEADER]: _i, ...noIp } = VIA_PROXY;
  assertEquals(clientIpFrom(req(noIp), SECRET), "104.28.1.2", "只帶密鑰不帶 IP");
});

Deno.test("沒經過 Worker：照原本的規則（x-forwarded-for 第一個 → x-real-ip → unknown）", () => {
  assertEquals(clientIpFrom(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), SECRET), "1.2.3.4");
  assertEquals(clientIpFrom(req({ "x-real-ip": "9.9.9.9" }), SECRET), "9.9.9.9");
  assertEquals(clientIpFrom(req({}), SECRET), "unknown");
});

Deno.test("兩站的 clientIp 都走 clientIpFrom、讀 HUSTINGS_PROXY_SECRET；程式碼裡沒有寫死密鑰", async () => {
  for (const f of ["./contribute-handler.ts", "./jp/contribute-handler.ts"]) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    assertStringIncludes(src, "return clientIpFrom(req, proxySecretFromEnv());", f);
    assert(!/x-forwarded-for/.test(src.slice(src.indexOf("export function clientIp("), src.indexOf("export function clientIp(") + 300)), `${f} 的 clientIp 不能再自己讀 x-forwarded-for`);
  }
  assertStringIncludes(IPN, 'return Deno.env.get("HUSTINGS_PROXY_SECRET");', "函式端的密鑰從 Supabase secrets 讀");
  const worker = await Deno.readTextFile(new URL("../../../cloudflare/api-worker.js", import.meta.url));
  assertStringIncludes(worker, "env && env.HUSTINGS_PROXY_SECRET", "Worker 的密鑰從 wrangler secret 讀");
  assert(!/HUSTINGS_PROXY_SECRET\s*=\s*['"]/.test(worker), "Worker 程式碼裡不能有密鑰的值");
  const toml = await Deno.readTextFile(new URL("../../../cloudflare/api-wrangler.toml", import.meta.url));
  assert(!/^\s*HUSTINGS_PROXY_SECRET\s*=/m.test(toml), "wrangler 設定檔不能寫密鑰（要用 wrangler secret put）");
});
