import { assert, assertEquals } from "jsr:@std/assert";
import { ARCHIVE_FALLBACK_MIN_CHARS, fetchSource } from "./system-one.ts";

// 2026-09-21：雲端 IP 抓媒體頁拿到 200 但 body 是空的，系統票因此棄權；archive.org 的快照救得回
// （leatherback 實測三筆：4,770／3,743／5,397 字）。這組測試用假的 fetch 走一遍，不打網路。

const ARTICLE = "<html><body><article>" + "候選人在記者會上說明敬老津貼加碼到一千五百點的財源，並提出三年期程。".repeat(12) + "</article></body></html>";
const EMPTY = "<html><head><script>challenge()</script></head><body></body></html>";

function fakeFetch(map: Record<string, { status: number; body: string }>): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const hit = Object.entries(map).find(([k]) => url.startsWith(k));
    const { status, body } = hit ? hit[1] : { status: 404, body: "" };
    return Promise.resolve(new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } }));
  }) as unknown as typeof fetch;
}

Deno.test("正文夠長就不去打 archive，note 記 raw 與 text 長度", async () => {
  const calls: string[] = [];
  const f = fakeFetch({ "https://news.example/a": { status: 200, body: ARTICLE } });
  const spy = ((i: string | URL | Request, init?: RequestInit) => { calls.push(String(i)); return f(i, init); }) as unknown as typeof fetch;
  const r = await fetchSource("https://news.example/a", spy);
  assertEquals(r.kind, "html");
  assert(r.text.length >= ARCHIVE_FALLBACK_MIN_CHARS);
  assertEquals(calls.length, 1, "沒有多打 archive");
  assert(/^raw:\d+ \| text:\d+ \| /.test(r.note), r.note);
});

Deno.test("正文是空的（軟封鎖）→ 改抓 archive.org 快照，note 記三個長度", async () => {
  const f = fakeFetch({
    "https://news.example/b": { status: 200, body: EMPTY },
    "https://web.archive.org/web/2026/https://news.example/b": { status: 200, body: ARTICLE },
  });
  const r = await fetchSource("https://news.example/b", f);
  assertEquals(r.kind, "html");
  assert(r.text.includes("敬老津貼"), "拿到的是快照的正文");
  assert(/^raw:\d+ \| archive:\d+ \| text:\d+ \| /.test(r.note), r.note);
});

Deno.test("archive 也沒有 → 回原本那份（可能是空的），note 記 archive:0，不丟錯", async () => {
  const f = fakeFetch({ "https://news.example/c": { status: 200, body: EMPTY } });
  const r = await fetchSource("https://news.example/c", f);
  assertEquals(r.kind, "html");
  assert(r.text.length < ARCHIVE_FALLBACK_MIN_CHARS);
  assert(r.note.includes("archive:0"), r.note);
});
