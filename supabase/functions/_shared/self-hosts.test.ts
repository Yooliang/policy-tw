import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleContribute } from "./contribute-handler.ts";
import { handleVerify } from "./verify-handler.ts";
import { fetchSource } from "./system-one.ts";
import { isSelfCitationUrl, SELF_HOSTS, selfCitationProblems, selfCitationUrls } from "./self-hosts.ts";

// issue #486（協議 1.84.0）：出處不得引用正見自己（含日本站），防循環引用。

const SELF = [
  "https://xn--2lw665d.tw/",
  "https://xn--2lw665d.tw/politician/8aa6ee40-231a-447a-a967-99bcf8b35d3f",
  "https://正見.tw/policy/abc", // 中文網域（URL 會轉成 punycode）
  "https://www.正見.tw/data/2026",
  "http://正見.tw/skill.md", // http
  "HTTPS://XN--2LW665D.TW/Skill", // 大小寫
  "https://xn--2lw665d.tw./x", // 結尾點
  "https://www.xn--2lw665d.tw/x", // 子網域
  "https://policy-tw.web.app/skill.md",
  "https://policy-tw.web.app/data/2026.md",
  "http://policy-tw.web.app",
  "https://Policy-TW.Web.App/x?utm=1#frag", // 大小寫＋查詢＋錨點
  "https://policy-tw.firebaseapp.com/politician/x",
  "https://policy-jp.web.app/lineage/1",
  "https://policy-jp.firebaseapp.com/",
  "https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/next",
  "https://wiiqoaytpqvegtknlbue.supabase.co/rest/v1/policies?select=*",
  "https://web.archive.org/web/20261005010203/https://policy-tw.web.app/data/2026", // 存檔的是自己
  "  https://policy-tw.web.app/x  ", // 前後空白
];

const NOT_SELF = [
  "https://policy-tw-foo.web.app/x", // 相似網域
  "https://foo-policy-tw.web.app/x",
  "https://notpolicy-tw.web.app/x",
  "https://policy-tw.web.app.evil.com/x", // 後面接別的網域
  "https://evil.com/policy-tw.web.app",
  "https://evil.com/?u=https://policy-tw.web.app",
  "https://xn--2lw665d.tw.evil.com/",
  "https://evilxn--2lw665d.tw/",
  "https://policy-jp-foo.web.app/",
  "https://other-project.supabase.co/rest/v1/x",
  "https://web.app/x",
  "https://www.cec.gov.tw/",
  "https://news.ltn.com.tw/news/politics/1",
  "ftp://policy-tw.web.app/x", // 不是 http(s)
  "不是網址",
  "",
];

Deno.test("正見自己的網域：punycode、中文網域、大小寫、子網域、帶路徑、http／https、存檔網址都認得", () => {
  for (const u of SELF) assert(isSelfCitationUrl(u), `應該算自己：${u}`);
});

Deno.test("不誤殺相似網域與非 http(s) 網址", () => {
  for (const u of NOT_SELF) assertEquals(isSelfCitationUrl(u), false, `不該算自己：${u}`);
  assertEquals(isSelfCitationUrl(undefined), false);
  assertEquals(isSelfCitationUrl(null), false);
  assertEquals(isSelfCitationUrl(42), false);
});

Deno.test("清單只放網域、不放路徑與協定；中文網域與 punycode 是同一個", () => {
  for (const d of SELF_HOSTS) assert(/^[a-z0-9.-]+$/.test(d), `清單項目要是小寫 ASCII 網域：${d}`);
  assertEquals(new URL("https://正見.tw/").hostname, "xn--2lw665d.tw");
  assert(SELF_HOSTS.includes("policy-jp.web.app"), "日本站前台要在清單裡");
  assert(SELF_HOSTS.includes("policy-tw.web.app"));
  assert(SELF_HOSTS.includes("xn--2lw665d.tw"));
});

Deno.test("selfCitationUrls／selfCitationProblems：source_urls 與 checked_urls 都看，回報是哪個網址", () => {
  assertEquals(selfCitationUrls(["https://a.example/x", "https://policy-tw.web.app/data", 5, null]), ["https://policy-tw.web.app/data"]);
  const problems = selfCitationProblems([
    { source_urls: ["https://www.cna.com.tw/a"] },
    { source_urls: ["https://www.cna.com.tw/a", "https://正見.tw/politician/x", "https://正見.tw/politician/x"] },
    { source_urls: undefined, payload: { checked_urls: ["https://policy-jp.web.app/"] } },
    { source_urls: ["https://policy-tw-foo.web.app/x"] },
  ]);
  assertEquals(problems, [
    { index: 1, urls: ["https://正見.tw/politician/x"] },
    { index: 2, urls: ["https://policy-jp.web.app/"] },
  ]);
});

// ── 交件端點 ──────────────────────────────────────────────

function fake() {
  const inserted: Record<string, unknown[]> = {};
  const api = {
    from(table: string) {
      const chain = {
        select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, is: () => chain, order: () => chain, limit: () => chain,
        insert: (rows: unknown) => {
          (inserted[table] ??= []).push(...(Array.isArray(rows) ? rows : [rows]));
          const arr = (Array.isArray(rows) ? rows : [rows]) as Array<{ payload_hash?: string }>;
          return { select: () => ({ data: arr.map((r, i) => ({ id: `new-${i}`, payload_hash: r.payload_hash })), error: null }), error: null };
        },
        delete: () => ({ in: () => ({ error: null }) }),
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) =>
          res({ data: table === "politicians" ? [{ id: "8aa6ee40-231a-447a-a967-99bcf8b35d3f", region: "台東縣" }] : [], error: null, count: 0 }),
      };
      return chain;
    },
  };
  return { api: api as unknown as Parameters<typeof handleContribute>[0], inserted };
}

const POLICY = {
  contribution_type: "policy",
  payload: {
    politician_id: "8aa6ee40-231a-447a-a967-99bcf8b35d3f",
    title: "推動偏鄉學童午餐全額補助",
    description: "縣府編列預算，全縣偏鄉國中小學童午餐全額補助，四年內擴及全縣所有國中小。",
    election_id: 2026, category: "教育文化", status: "Campaign Pledge",
  },
  agent_name: "tester",
  agent_tool: "claude-code/claude-sonnet-4-5",
};
const CNA = "https://www.cna.com.tw/news/aipl/202610050001.aspx";
const UDN = "https://udn.com/news/story/1";

Deno.test("交件端點：source_urls 含正見自己 → 422 self_citation，指出網址，整批未收、記一次守門", async () => {
  const { api, inserted } = fake();
  const res = await handleContribute(api, "https://x", { ...POLICY, source_urls: [CNA, UDN, "https://正見.tw/politician/abc"] }, "ip");
  assertEquals(res.status, 422);
  const body = res.body as { error: string; message: string; errors: Array<{ index: number; urls: string[]; message: string }> };
  assertEquals(body.error, "self_citation");
  assertEquals(body.errors[0].index, 0);
  assertEquals(body.errors[0].urls, ["https://正見.tw/politician/abc"]);
  assert(body.errors[0].message.includes("https://正見.tw/politician/abc"));
  assert(body.message.includes("不可引用正見本身"));
  assertEquals(inserted.contributions, undefined, "整批未收");
  assertEquals((inserted.gate_rejections![0] as { gate: string }).gate, "self_citation");
});

Deno.test("交件端點：日本站與 /skill 路徑一樣擋；相似網域與正常來源不被這道擋", async () => {
  for (const u of ["https://policy-jp.web.app/lineage/x", "https://policy-tw.web.app/skill.md", "http://xn--2lw665d.tw/data/2026.md"]) {
    const { api } = fake();
    const res = await handleContribute(api, "https://x", { ...POLICY, source_urls: [CNA, u] }, "ip");
    assertEquals((res.body as { error?: string }).error, "self_citation", u);
    assertEquals(res.status, 422);
  }
  const { api } = fake();
  const ok = await handleContribute(api, "https://x", { ...POLICY, source_urls: [CNA, UDN, "https://policy-tw-foo.web.app/x"] }, "ip");
  assert((ok.body as { error?: string }).error !== "self_citation", JSON.stringify(ok.body).slice(0, 300));
});

// ── 驗證端點：evidence_url ─────────────────────────────────

const CID = "11111111-2222-3333-4444-555555555555";

function fakeVerify() {
  const inserted: Array<Record<string, unknown>> = [];
  const contribution = {
    id: CID, status: "pending", contribution_type: "candidacy",
    payload: { name: "林淑芬", election_id: 2026 }, source_urls: ["https://example.test/a"],
    agent_name: "someone", contributor_ip_hash: "ip-other",
    agree_count: 0, disagree_count: 0, unsure_count: 0,
  };
  const client = {
    from(table: string) {
      const chain = {
        select() { return chain; }, eq() { return chain; }, gte() { return chain; }, order() { return chain; },
        limit() { return chain; }, in() { return chain; }, neq() { return chain; },
        maybeSingle() {
          if (table === "contributions") return Promise.resolve({ data: contribution, error: null });
          if (table === "verify_dispatches") return Promise.resolve({ data: { contribution_id: CID }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(res: (v: unknown) => unknown) { return Promise.resolve({ data: [], error: null, count: 0 }).then(res); },
        insert(row: Record<string, unknown>) { inserted.push({ table, ...row }); return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "v1" }, error: null }) }) }; },
        update() { return chain; },
        upsert() { return Promise.resolve({ error: null }); },
      };
      return chain;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { client, inserted };
}

Deno.test("驗證端點：evidence_url 是正見自己 → 422 self_citation、不寫票、記守門", async () => {
  const { client, inserted } = fakeVerify();
  const vote = { agent_name: "dave", contribution_id: CID, verdict: "agree", note: "中選會名冊第 3 列查到林淑芬，與交件相符", evidence_url: "https://policy-tw.web.app/politician/x" };
  const res = await handleVerify(client, vote, "ip-mine");
  assertEquals(res.status, 422);
  const body = res.body as { error: string; urls: string[] };
  assertEquals(body.error, "self_citation");
  assertEquals(body.urls, ["https://policy-tw.web.app/politician/x"]);
  assertEquals(inserted.filter((r) => r.table === "contribution_votes").length, 0, "不寫票");
  assertEquals(inserted.find((r) => r.table === "gate_rejections")?.gate, "self_citation");
});

Deno.test("驗證端點：disagree 的反證網址是日本站 → 一樣擋；別的網域不被這道擋", async () => {
  const a = fakeVerify();
  const bad = await handleVerify(a.client, { agent_name: "dave", contribution_id: CID, verdict: "disagree", note: "名冊上沒有這個人", evidence_url: "https://policy-jp.web.app/x" }, "ip-mine");
  assertEquals((bad.body as { error?: string }).error, "self_citation");
  const b = fakeVerify();
  const ok = await handleVerify(b.client, { agent_name: "dave", contribution_id: CID, verdict: "disagree", note: "名冊上沒有這個人", evidence_url: "https://policy-tw-foo.web.app/x" }, "ip-mine");
  assert((ok.body as { error?: string }).error !== "self_citation");
});

// ── 系統票：不抓、不當證據 ─────────────────────────────────

Deno.test("系統票：正見自己的網址不抓取，回 error（各路徑因此棄權）；別的網址照抓", async () => {
  let called = 0;
  const spy = ((_u: unknown) => { called++; return Promise.resolve(new Response("<html><body>" + "林淑芬 ".repeat(100) + "</body></html>", { headers: { "content-type": "text/html" } })); }) as typeof fetch;
  const r = await fetchSource("https://正見.tw/politician/x", spy);
  assertEquals(r.kind, "error");
  assert(r.note.startsWith("self_citation"));
  assertEquals(called, 0, "連抓都不抓");
  await fetchSource("https://policy-jp.web.app/x", spy);
  assertEquals(called, 0);
  const ok = await fetchSource("https://policy-tw-foo.web.app/x", spy);
  assertEquals(called, 1);
  assertEquals(ok.kind, "html");
});

Deno.test("協議寫明不可引用正見本身（含日本站）與錯誤碼", async () => {
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assert(skill.includes("出處不可引用正見本身（含日本站）"));
  assert(skill.includes("422 `self_citation`"));
  for (const d of SELF_HOSTS) if (!d.endsWith(".supabase.co")) assert(skill.includes(d), `skill.md 要列出 ${d}`);
});
