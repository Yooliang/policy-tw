import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { networkOf } from "./ip-network.ts";
import { ipHashOf, legacyIpHashOf } from "./contribute-handler.ts";

Deno.test("IPv4 取 /24", () => {
  assertEquals(networkOf("160.79.106.21"), "160.79.106.0/24");
  assertEquals(networkOf(" 160.79.106.27 "), "160.79.106.0/24");
  assertEquals(networkOf("1.2.3.4"), "1.2.3.0/24");
});

Deno.test("IPv4 對應的 IPv6 照 IPv4 算", () => {
  assertEquals(networkOf("::ffff:160.79.106.19"), "160.79.106.0/24");
});

Deno.test("IPv6 取 /64，不同寫法同一網段", () => {
  assertEquals(networkOf("2001:db8:1:2::1"), "2001:0db8:0001:0002::/64");
  assertEquals(networkOf("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd"), "2001:0db8:0001:0002::/64");
  assertEquals(networkOf("2001:db8::1"), "2001:0db8:0000:0000::/64");
  assertEquals(networkOf("fe80::1%eth0"), "fe80:0000:0000:0000::/64");
});

Deno.test("認不得的原字回傳，不會把不同的值併在一起", () => {
  assertEquals(networkOf("unknown"), "unknown");
  assertEquals(networkOf("999.1.1.1"), "999.1.1.1");
  assertEquals(networkOf("1:2:3"), "1:2:3");
});

const req = (ip: string) => new Request("https://x/", { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });

Deno.test("同一個 /24 的輪換 IP 雜湊相同（雲端代理領任務與交件對得上）", async () => {
  const salt = "s";
  const hashes = await Promise.all(["160.79.106.21", "160.79.106.22", "160.79.106.19", "160.79.106.27"].map((ip) => ipHashOf(req(ip), salt)));
  assertEquals(new Set(hashes).size, 1);
  assertNotEquals(await ipHashOf(req("160.79.107.21"), salt), hashes[0]);
});

Deno.test("舊雜湊（單一 IP）照舊算法，過渡期用來認出切換前的提交與投票", async () => {
  const a = await legacyIpHashOf(req("160.79.106.21"), "s");
  const b = await legacyIpHashOf(req("160.79.106.22"), "s");
  assertNotEquals(a, b);
  assertNotEquals(a, await ipHashOf(req("160.79.106.21"), "s"));
});

Deno.test("過渡期判斷：只有存的雜湊等於這次請求的舊單一 IP 雜湊才算同一台", async () => {
  const { isLegacySource } = await import("./verify-handler.ts");
  assertEquals(isLegacySource("h1", "h1"), true);
  assertEquals(isLegacySource("h1", "h2"), false);
  assertEquals(isLegacySource(null, "h1"), false);
  assertEquals(isLegacySource("h1", undefined), false);
});
