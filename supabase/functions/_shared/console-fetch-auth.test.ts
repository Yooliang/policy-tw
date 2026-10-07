import { assertEquals } from "jsr:@std/assert@1";
import { bearerOf, safeEqual, verifyCaller } from "./console-fetch-auth.ts";

const SECRET = "s3cret-s3cret-s3cret";
const SERVICE = "service-role-key-value";
const h = (o: Record<string, string>) => new Headers(o);
const denied = { ok: false, status: 401, error: "unauthorized" } as const;

/** 假的資料庫比對：只認 SECRET；記下被問過的值 */
function fakeCheck() {
  const asked: string[] = [];
  return { asked, check: (s: string) => { asked.push(s); return Promise.resolve(s === SECRET); } };
}

Deno.test("呼叫者驗證：x-cron-secret 經資料庫比對過 → 通過", async () => {
  const f = fakeCheck();
  assertEquals(await verifyCaller(h({ "x-cron-secret": SECRET }), { serviceRoleKey: SERVICE, checkCronSecret: f.check }), { ok: true, via: "cron-secret" });
  assertEquals(f.asked, [SECRET]);
});

Deno.test("呼叫者驗證：service role bearer 對 → 通過，而且不用去問資料庫（手動呼叫用）", async () => {
  const f = fakeCheck();
  assertEquals(await verifyCaller(h({ authorization: `Bearer ${SERVICE}` }), { serviceRoleKey: SERVICE, checkCronSecret: f.check }), { ok: true, via: "service-role" });
  assertEquals(await verifyCaller(h({ authorization: `bearer ${SERVICE}` }), { serviceRoleKey: SERVICE }), { ok: true, via: "service-role" });
  assertEquals(f.asked, []);
});

Deno.test("呼叫者驗證：沒帶、帶錯、帶別的東西 → 401", async () => {
  const f = fakeCheck();
  const cred = { serviceRoleKey: SERVICE, checkCronSecret: f.check };
  assertEquals(await verifyCaller(h({}), cred), denied);
  assertEquals(await verifyCaller(h({ "x-cron-secret": "wrong-wrong-wrong-wrong" }), cred), denied);
  assertEquals(await verifyCaller(h({ "x-cron-secret": "" }), cred), denied);
  assertEquals(await verifyCaller(h({ authorization: "Bearer nope" }), cred), denied);
  assertEquals(await verifyCaller(h({ authorization: SERVICE }), cred), denied, "沒有 Bearer 前綴不算");
  // 公開的 anon key 之類的 JWT 當 bearer 也不行
  assertEquals(await verifyCaller(h({ authorization: "Bearer eyJhbGciOi.anon.key" }), cred), denied);
});

Deno.test("呼叫者驗證：x-cron-secret 與 bearer 不能互換", async () => {
  const f = fakeCheck();
  const cred = { serviceRoleKey: SERVICE, checkCronSecret: f.check };
  assertEquals((await verifyCaller(h({ authorization: `Bearer ${SECRET}` }), cred)).ok, false);
  assertEquals((await verifyCaller(h({ "x-cron-secret": SERVICE }), cred)).ok, false);
});

Deno.test("呼叫者驗證：太短或太長的 x-cron-secret 不去打資料庫、直接 401", async () => {
  const f = fakeCheck();
  const cred = { serviceRoleKey: SERVICE, checkCronSecret: f.check };
  assertEquals(await verifyCaller(h({ "x-cron-secret": "short" }), cred), denied);
  assertEquals(await verifyCaller(h({ "x-cron-secret": "x".repeat(257) }), cred), denied);
  assertEquals(f.asked, []);
});

Deno.test("呼叫者驗證：資料庫那一步出錯（RPC 不存在、連不上）→ 503，不是放行也不是當成對", async () => {
  const boom = () => Promise.reject(new Error("function does not exist"));
  const r = await verifyCaller(h({ "x-cron-secret": SECRET }), { serviceRoleKey: SERVICE, checkCronSecret: boom });
  assertEquals(r.ok, false);
  assertEquals((r as { status: number }).status, 503);
  // 回傳不是 true（例如 null）也不放行
  assertEquals((await verifyCaller(h({ "x-cron-secret": SECRET }), { serviceRoleKey: SERVICE, checkCronSecret: () => Promise.resolve(null as unknown as boolean) })).ok, false);
});

Deno.test("呼叫者驗證：沒有任何可驗證的來源 → 503（fail closed）", async () => {
  assertEquals((await verifyCaller(h({}), {})).ok, false);
  assertEquals(await verifyCaller(h({ "x-cron-secret": SECRET, authorization: "Bearer " }), { serviceRoleKey: "" }), { ok: false, status: 503, error: "沒有可驗證呼叫者的憑證來源（SUPABASE_SERVICE_ROLE_KEY 缺少）" });
  // 沒設 service key 時，空的 bearer 不會對上空字串
  const f = fakeCheck();
  assertEquals((await verifyCaller(h({ authorization: "Bearer " }), { serviceRoleKey: "", checkCronSecret: f.check })).ok, false);
});

Deno.test("safeEqual／bearerOf", async () => {
  assertEquals(await safeEqual("a", "a"), true);
  assertEquals(await safeEqual("a", "b"), false);
  assertEquals(await safeEqual("a", "aa"), false);
  assertEquals(bearerOf(h({ authorization: "Bearer  tok " })), "tok");
  assertEquals(bearerOf(h({})), null);
});