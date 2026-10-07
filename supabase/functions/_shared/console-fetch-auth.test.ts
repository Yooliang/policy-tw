import { assertEquals } from "jsr:@std/assert@1";
import { bearerOf, safeEqual, verifyCaller } from "./console-fetch-auth.ts";

const SECRET = "s3cret-s3cret-s3cret";
const SERVICE = "service-role-key-value";
const h = (o: Record<string, string>) => new Headers(o);

Deno.test("呼叫者驗證：x-cron-secret 對 → 通過", async () => {
  assertEquals(await verifyCaller(h({ "x-cron-secret": SECRET }), { cronSecret: SECRET, serviceRoleKey: SERVICE }), { ok: true, via: "cron-secret" });
});

Deno.test("呼叫者驗證：service role bearer 對 → 通過（手動呼叫用）", async () => {
  assertEquals(await verifyCaller(h({ authorization: `Bearer ${SERVICE}` }), { cronSecret: SECRET, serviceRoleKey: SERVICE }), { ok: true, via: "service-role" });
  assertEquals(await verifyCaller(h({ authorization: `bearer ${SERVICE}` }), { serviceRoleKey: SERVICE }), { ok: true, via: "service-role" });
});

Deno.test("呼叫者驗證：沒帶、帶錯、帶別的東西 → 401", async () => {
  const cred = { cronSecret: SECRET, serviceRoleKey: SERVICE };
  const denied = { ok: false, status: 401, error: "unauthorized" } as const;
  assertEquals(await verifyCaller(h({}), cred), denied);
  assertEquals(await verifyCaller(h({ "x-cron-secret": "wrong-wrong-wrong-wrong" }), cred), denied);
  assertEquals(await verifyCaller(h({ "x-cron-secret": "" }), cred), denied);
  assertEquals(await verifyCaller(h({ authorization: "Bearer nope" }), cred), denied);
  assertEquals(await verifyCaller(h({ authorization: SERVICE }), cred), denied, "沒有 Bearer 前綴不算");
  // 公開的 anon key 之類的 JWT 當 bearer 也不行
  assertEquals(await verifyCaller(h({ authorization: "Bearer eyJhbGciOi.anon.key" }), cred), denied);
});

Deno.test("呼叫者驗證：x-cron-secret 與 bearer 不能互換", async () => {
  const cred = { cronSecret: SECRET, serviceRoleKey: SERVICE };
  assertEquals((await verifyCaller(h({ authorization: `Bearer ${SECRET}` }), cred)).ok, false);
  assertEquals((await verifyCaller(h({ "x-cron-secret": SERVICE }), cred)).ok, false);
});

Deno.test("呼叫者驗證：兩種憑證都沒設定（或 cron secret 太短）→ 一律拒絕（fail closed），不是放行", async () => {
  assertEquals((await verifyCaller(h({}), {})).ok, false);
  assertEquals(await verifyCaller(h({ "x-cron-secret": "" }), { cronSecret: "" }), { ok: false, status: 503, error: "沒有設定可驗證呼叫者的憑證（CONSOLE_FETCH_CRON_SECRET 缺少或少於 16 字元）" });
  // 太短的 secret 視同沒設定：就算呼叫者帶一樣的也不放行
  assertEquals((await verifyCaller(h({ "x-cron-secret": "short" }), { cronSecret: "short" })).ok, false);
  // 沒設 service key 時，空的 bearer 不會對上空字串
  assertEquals((await verifyCaller(h({ authorization: "Bearer " }), { cronSecret: SECRET, serviceRoleKey: "" })).ok, false);
  // 只設了 service key 時，cron secret 這條不通
  assertEquals((await verifyCaller(h({ "x-cron-secret": SECRET }), { serviceRoleKey: SERVICE })).ok, false);
});

Deno.test("safeEqual／bearerOf", async () => {
  assertEquals(await safeEqual("a", "a"), true);
  assertEquals(await safeEqual("a", "b"), false);
  assertEquals(await safeEqual("a", "aa"), false);
  assertEquals(bearerOf(h({ authorization: "Bearer  tok " })), "tok");
  assertEquals(bearerOf(h({})), null);
});