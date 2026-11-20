/// <reference lib="deno.ns" />
/**
 * 脈絡完整關係圖（/lineage/<id>/graph，#675 第四期）的 Worker 回應標頭：X-Robots-Tag: noindex 與指向主頁的 canonical Link。
 * 殼檔的 noindex 靠 HTML，這是不用讀 HTML 就看得到的第二道；也不在 robots.txt 擋（擋了爬蟲讀不到 noindex）。
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { graphHeaders, withGraphHeaders } from "./graph-headers.js";

const ORIGIN = "https://xn--2lw665d.tw";
const ID = "8b1c0f5e-1111-4222-8333-444455556666";

Deno.test("關係圖路徑：補 noindex 與指向主頁的 canonical；主頁與其他路徑不補", () => {
  assertEquals(graphHeaders(`/lineage/${ID}/graph`, ORIGIN), { "X-Robots-Tag": "noindex", Link: `<${ORIGIN}/lineage/${ID}>; rel="canonical"` });
  assertEquals(graphHeaders(`/lineage/${ID}/graph/`, ORIGIN)?.["X-Robots-Tag"], "noindex");
  assertEquals(graphHeaders(`/lineage/${ID}`, ORIGIN), null, "主頁要收錄，不能帶 noindex");
  assertEquals(graphHeaders(`/lineage/${ID}/graph/x`, ORIGIN), null);
  assertEquals(graphHeaders("/policy/x", ORIGIN), null);
});

Deno.test("代理回應補標頭：原標頭保留、狀態與內容不變；非關係圖路徑原樣回傳同一個物件", async () => {
  const upstream = new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html", "X-Served-Via": "cloudflare-worker" } });
  const out = withGraphHeaders(upstream, `/lineage/${ID}/graph`, ORIGIN);
  assertEquals(out.status, 200);
  assertEquals(out.headers.get("X-Robots-Tag"), "noindex");
  assertEquals(out.headers.get("Link"), `<${ORIGIN}/lineage/${ID}>; rel="canonical"`);
  assertEquals(out.headers.get("Content-Type"), "text/html");
  assertEquals(out.headers.get("X-Served-Via"), "cloudflare-worker");
  assertEquals(await out.text(), "<html></html>");
  const plain = new Response("x");
  assert(withGraphHeaders(plain, `/lineage/${ID}`, ORIGIN) === plain);
  assertFalse(withGraphHeaders(new Response("x"), "/", ORIGIN).headers.has("X-Robots-Tag"));
});

Deno.test("上游回應標頭不可改也能補（複製一份）；404 等狀態照留", () => {
  const frozen = Response.redirect("https://example.com/", 302);
  const out = withGraphHeaders(frozen, `/lineage/${ID}/graph`, ORIGIN);
  assertEquals(out.status, 302);
  assertEquals(out.headers.get("X-Robots-Tag"), "noindex");
});

Deno.test("接線：Worker 的 fallthrough 代理回應要經過 withGraphHeaders，且 robots.txt 不擋 /graph", async () => {
  const worker = (await Deno.readTextFile(new URL("./ssr-worker.js", import.meta.url))).replace(/\r\n/g, "\n");
  assert(worker.includes("import { withGraphHeaders } from './graph-headers.js'"));
  assert(worker.includes("return withGraphHeaders(proxied, url.pathname, url.origin)"));
  const robots = await Deno.readTextFile(new URL("../public/robots.txt", import.meta.url)).catch(() => "");
  assertFalse(/Disallow:.*graph/i.test(robots), "不要在 robots.txt 擋：爬蟲讀不到 noindex");
});
