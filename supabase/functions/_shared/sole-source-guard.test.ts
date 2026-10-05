import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleContribute } from "./contribute-handler.ts";
import { SOLE_SOURCE_TASK_NOTE, siteOf, soleSourceProblem, soleSourceProblems, unwrapArchiveUrl } from "./sole-source-guard.ts";
import { newsItemGuidance, TASK_GUIDANCE } from "./task-guidance.ts";

// issue #347 第 3 項（協議 1.45.0）：媒體不能當唯一出處。政見與政見進度沒有官方來源時，要兩個不同網站的來源。

const CNA = "https://www.cna.com.tw/news/aipl/202610050001.aspx";
const LTN = "https://news.ltn.com.tw/news/politics/breakingnews/1";
const LTN_EC = "https://ec.ltn.com.tw/article/breakingnews/2";
const UDN = "https://udn.com/news/story/1";
const FB = "https://www.facebook.com/candidate/posts/123";
const FB_M = "https://m.facebook.com/candidate/posts/456";
const OWN_SITE = "https://wang-2026.tw/policy";
const BULLETIN = "https://bulletin.cec.gov.tw/01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1/a.pdf";
const COUNCIL = "https://www.tncc.gov.tw/news/1";
const GOV_HOME = "https://www.tncc.gov.tw/";

Deno.test("網站：同一家媒體的不同子網域是同一個網站；各縣市議會是不同網站", () => {
  assertEquals(siteOf(LTN), "ltn.com.tw");
  assertEquals(siteOf(LTN_EC), "ltn.com.tw");
  assertEquals(siteOf(FB), "facebook.com");
  assertEquals(siteOf(FB_M), "facebook.com");
  assertEquals(siteOf(COUNCIL), "tncc.gov.tw");
  assertEquals(siteOf("https://www.kcc.gov.tw/x"), "kcc.gov.tw");
  assertEquals(siteOf("https://tw.news.yahoo.com/x"), "yahoo.com");
  assertEquals(siteOf("https://www.bbc.co.uk/news/1"), "bbc.co.uk");
  assertEquals(siteOf("不是網址"), null);
});

Deno.test("存檔網址照原網址算：原文加它的存檔不是兩個來源", () => {
  const archived = `https://web.archive.org/web/20261005010203/${UDN}`;
  assertEquals(unwrapArchiveUrl(archived), UDN);
  assertEquals(unwrapArchiveUrl("https://web.archive.org/web/2026id_/udn.com/news/story/1"), "http://udn.com/news/story/1");
  assertEquals(siteOf(archived), "udn.com");
  assert(soleSourceProblem(0, "policy", [UDN, archived]) !== null, "同一篇＋存檔仍只有一個網站");
  assertEquals(soleSourceProblem(0, "policy", [`https://web.archive.org/web/20221101000000/${BULLETIN}`]), null, "公報的存檔照樣算官方");
});

Deno.test("只有一篇報導、一則貼文、或同一家媒體兩篇 → 擋", () => {
  for (const urls of [[CNA], [FB], [OWN_SITE], [LTN, LTN_EC], [FB, FB_M], [GOV_HOME]]) {
    const p = soleSourceProblem(0, "policy", urls);
    assert(p !== null, `應該擋：${urls.join(" ")}`);
    assertEquals(p.sites, 1);
    assert(/不能當唯一出處/.test(p.message) && /不算被拒/.test(p.message));
  }
  assert(soleSourceProblem(0, "policy_progress", [CNA]) !== null, "政見進度也適用");
});

Deno.test("有官方來源、或兩個不同網站 → 放行", () => {
  assertEquals(soleSourceProblem(0, "policy", [BULLETIN]), null, "選舉公報");
  assertEquals(soleSourceProblem(0, "policy_progress", [COUNCIL]), null, "議會網站");
  assertEquals(soleSourceProblem(0, "policy", [CNA, LTN]), null, "兩家媒體");
  assertEquals(soleSourceProblem(0, "policy", [FB, UDN]), null, "候選人臉書＋報導");
  assertEquals(soleSourceProblem(0, "policy", [OWN_SITE, FB]), null, "本人官網＋本人臉書是兩個網站");
});

Deno.test("首頁不算官方：官網首頁撐不起具體宣稱", () => {
  assert(soleSourceProblem(0, "policy", [GOV_HOME]) !== null);
});

Deno.test("守門範圍只有政見與政見進度；其他型別不受影響", () => {
  for (const t of ["candidacy", "politician", "correction", "no_change", "question_answer", "removal", "task_suggestion"]) {
    assertEquals(soleSourceProblem(0, t, [CNA]), null, t);
  }
});

Deno.test("整批：回報每一筆有問題的位置", () => {
  const problems = soleSourceProblems([
    { contribution_type: "policy", source_urls: [CNA, UDN] },
    { contribution_type: "policy", source_urls: [CNA] },
    { contribution_type: "candidacy", source_urls: [CNA] },
    { contribution_type: "policy_progress", source_urls: [FB] },
  ]);
  assertEquals(problems.map((p) => p.index), [1, 3]);
  assert(problems[0].message.startsWith("第 2 筆"));
});

// ── 協議與任務說明講同一條規則（任務敘述與協議是同一份契約的兩個出口，09-21 裁決）─────────

Deno.test("協議 §2 第 1a 條寫著這條規則與錯誤代碼；會交政見的任務說明都提醒", async () => {
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assert(/1a\. \*\*媒體不能當唯一出處\*\*/.test(skill), "skill.md 要有第 1a 條");
  assert(skill.includes("400 single_non_official_source"), "skill.md 要寫出錯誤代碼");
  for (const t of ["policy_missing", "term_policy_missing", "progress_stale", "news_sweep"]) {
    assert(TASK_GUIDANCE[t].includes(SOLE_SOURCE_TASK_NOTE), `${t} 的說明要提醒`);
  }
  for (const s of ["progress", "new_policy"]) assert(/再附一個不同網站的來源/.test(newsItemGuidance(s)), `單則新聞任務（${s}）要提醒`);
});

// ── 接在交件端點上：真的會擋、不寫入、記守門次數 ──────────────────

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

Deno.test("交件端點：只有一篇報導的政見 → 400 single_non_official_source，不寫入、記一次守門", async () => {
  const { api, inserted } = fake();
  const res = await handleContribute(api, "https://x", { ...POLICY, source_urls: [CNA] }, "ip");
  assertEquals(res.status, 400);
  const body = res.body as { error: string; errors: Array<{ index: number }> };
  assertEquals(body.error, "single_non_official_source");
  assertEquals(body.errors.map((e) => e.index), [0]);
  assertEquals(inserted.contributions, undefined, "整批未收");
  assertEquals((inserted.gate_rejections ?? []).length, 1);
  assertEquals((inserted.gate_rejections![0] as { gate: string }).gate, "single_non_official_source");
});

Deno.test("交件端點：兩個不同網站 → 不被這道守門擋", async () => {
  const { api } = fake();
  const res = await handleContribute(api, "https://x", { ...POLICY, source_urls: [CNA, UDN] }, "ip");
  assert((res.body as { error?: string }).error !== "single_non_official_source", JSON.stringify(res.body).slice(0, 300));
});
