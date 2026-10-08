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

Deno.test("過渡期判斷：只認「切換前後是同一個 IP」——固定 IP 認得出，輪換 IP 認不出（單向雜湊換算不了網段）", async () => {
  const { isLegacySource } = await import("./verify-handler.ts");
  // 真實的雜湊，不是 "h1" 對 "h1" 這種自己等於自己的假資料
  const storedBeforeSwitch = await legacyIpHashOf(req("160.79.106.19"), "s");
  assertEquals(isLegacySource(storedBeforeSwitch, await legacyIpHashOf(req("160.79.106.19"), "s")), true, "同一個 IP 認得");
  // 雲端代理輪換：切換前用 .19 交的，切換後從同一個 /24 的 .21 來——新的網段雜湊相同，但舊雜湊對不上
  assertEquals(await ipHashOf(req("160.79.106.19"), "s"), await ipHashOf(req("160.79.106.21"), "s"));
  assertEquals(isLegacySource(storedBeforeSwitch, await legacyIpHashOf(req("160.79.106.21"), "s")), false, "輪換到同網段別的 IP，舊資料認不出來");
  assertEquals(isLegacySource("h1", "h1"), true);
  assertEquals(isLegacySource("h1", "h2"), false);
  assertEquals(isLegacySource(null, "h1"), false);
  assertEquals(isLegacySource("h1", undefined), false);
});
