/// <reference lib="deno.ns" />
/**
 * GET /__health（policy-ops#45）：主控台的網域燈號靠它判斷「這個網域真的接到正見的 Worker」（200、讀得到內容）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { HEALTH_PATH, healthResponse } from "./health.js";

Deno.test("回 200 JSON、帶 CORS、不快取，內容寫出是哪個網域", async () => {
  const res = healthResponse(new Request("https://tw.hustings.net/__health"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  assertEquals(await res.json(), { ok: true, host: "tw.hustings.net", served_by: "policy-tw-worker" });
});

Deno.test("Worker 在其他路由之前接 /__health（GET）", async () => {
  const worker = await Deno.readTextFile(new URL("./ssr-worker.js", import.meta.url));
  assertEquals(HEALTH_PATH, "/__health");
  const i = worker.indexOf("url.pathname === HEALTH_PATH");
  assert(i > 0, "ssr-worker 要接 HEALTH_PATH");
  assert(i < worker.indexOf("url.pathname === '/__purge'"), "放在最前面（不受其他路由影響）");
});
