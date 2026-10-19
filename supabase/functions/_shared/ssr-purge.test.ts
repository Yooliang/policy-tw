import { assertEquals } from "jsr:@std/assert@1";
import { purgePathsFor, purgeSsrPages } from "./ssr-purge.ts";

const P = "0000b296-7ae8-4184-b704-c69d44cb696a";
const Q = "1111b296-7ae8-4184-b704-c69d44cb696a";

Deno.test("purgePathsFor：人物頁與政見頁，沒有 id 就沒有路徑", () => {
  assertEquals(purgePathsFor({ politician_id: P, policy_id: Q }), [`/politician/${P}`, `/policy/${Q}`]);
  assertEquals(purgePathsFor({ policy_id: Q }), [`/policy/${Q}`]);
  assertEquals(purgePathsFor({}), []);
});

Deno.test("purgeSsrPages：打 SITE_URL/__purge，帶 PURGE_SECRET 與路徑", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = ((url: string, init: RequestInit) => { calls.push({ url, init }); return Promise.resolve(new Response("{}")); }) as unknown as typeof fetch;
  await purgeSsrPages([`/politician/${P}`], { fetchFn, getEnv: (n) => ({ PURGE_SECRET: "s3", SITE_URL: "https://example.tw" })[n] });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://example.tw/__purge");
  assertEquals((calls[0].init.headers as Record<string, string>)["X-Purge-Secret"], "s3");
  assertEquals(JSON.parse(calls[0].init.body as string), { paths: [`/politician/${P}`] });
});

Deno.test("purgeSsrPages：沒設鑰匙或沒有路徑不送；fetch 丟錯／同步丟錯／非 2xx 都不丟出", async () => {
  let n = 0;
  const ok = (() => { n++; return Promise.resolve(new Response("")); }) as unknown as typeof fetch;
  await purgeSsrPages([`/policy/${Q}`], { fetchFn: ok, getEnv: () => undefined });
  await purgeSsrPages([], { fetchFn: ok, getEnv: () => "x" });
  assertEquals(n, 0);
  const env = () => "x";
  await purgeSsrPages(["/policy/a"], { fetchFn: (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch, getEnv: env });
  await purgeSsrPages(["/policy/a"], { fetchFn: (() => { throw new Error("sync"); }) as unknown as typeof fetch, getEnv: env });
  await purgeSsrPages(["/policy/a"], { fetchFn: (() => Promise.resolve(new Response("", { status: 403 }))) as unknown as typeof fetch, getEnv: env });
});
