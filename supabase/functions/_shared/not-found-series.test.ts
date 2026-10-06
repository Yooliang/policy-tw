/**
 * 查無比例異常高的模型系列，查無交件門檻提高（協議 1.44.0，2026-10-04）。
 *
 * 測三件事：
 *   1. 統計（notFoundRates）算得對，而且只吃模型列、不重複算型別明細列
 *   2. 門檻（seriesVerdict）只在「樣本夠 ＋ 絕對高 ＋ 相對高」三個條件同時成立時才提高，不綁模型名
 *   3. 交件端真的擋得到、也真的放得過，統計拿不到時退回一般門檻
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  agentToolVerdict,
  type ModelStatRow,
  NOT_FOUND_RATE_FLOOR,
  NOT_FOUND_RATE_MIN_SAMPLE,
  NOT_FOUND_RATE_MULTIPLE,
  NOT_FOUND_RATE_WINDOW_DAYS,
  notFoundRates,
  resetNotFoundRatesCache,
  seriesVerdict,
} from "./not-found-series.ts";
import {
  distinctDomains,
  NOT_FOUND_ELEVATED_MIN_CHECKED_URLS,
  NOT_FOUND_ELEVATED_MIN_DOMAINS,
  NOT_FOUND_MIN_CHECKED_URLS,
  notFoundSearchShortfall,
} from "./not-found-guard.ts";
import { handleContribute } from "./contribute-handler.ts";

const PID = "98b8b1ff-d085-4597-8384-a02461f773f6";
const HAIKU = "Claude Haiku（未標版本）";

/** 近 14 天：Haiku 查無 61.7%、Sonnet 19%、Gemini 20%；全站 35% */
const STATS: ModelStatRow[] = [
  { model: HAIKU, contribution_type: null, submitted: 120, no_change_missing: 74 },
  { model: HAIKU, contribution_type: "no_change", submitted: 74, no_change_missing: 74 },
  { model: "Claude Sonnet 5", contribution_type: null, submitted: 200, no_change_missing: 38 },
  { model: "Claude Sonnet 5", contribution_type: "policy", submitted: 120, no_change_missing: 0 },
  { model: "Gemini 3.1 Pro", contribution_type: null, submitted: 100, no_change_missing: 20 },
];

Deno.test("統計：只吃模型列（contribution_type IS NULL），型別明細列不重複算", () => {
  const r = notFoundRates(STATS);
  assertEquals(r.series.length, 3, "三個系列，不含型別明細列");
  assertEquals(r.overall.submitted, 420);
  assertEquals(r.overall.not_found, 132);
  assertEquals(Number(r.overall.rate.toFixed(4)), 0.3143);
  assertEquals(Number(r.series.find((s) => s.model === HAIKU)!.rate.toFixed(4)), 0.6167);
});

Deno.test("統計：髒資料不會算出假比例", () => {
  const r = notFoundRates([
    { model: null, contribution_type: null, submitted: 50, no_change_missing: 50 },
    { model: "", contribution_type: null, submitted: 50, no_change_missing: 50 },
    { model: "A", contribution_type: null, submitted: 0, no_change_missing: 0 },
    // PostgREST 的 BIGINT 可能回字串；查無數大於交件數（不該發生）要夾回去，別算出 >100%
    { model: "B", contribution_type: null, submitted: "40" as unknown as number, no_change_missing: "90" as unknown as number },
  ]);
  assertEquals(r.series.map((s) => s.model), ["B"], "model 空的、交件 0 的都不列");
  assertEquals(r.series[0].rate, 1, "查無數被夾到交件數，最高 100%");
});

Deno.test("門檻：樣本夠＋絕對高＋相對全站高，三個都成立才提高", () => {
  const rates = notFoundRates(STATS);
  assertEquals(seriesVerdict(rates, HAIKU).elevated, true, "61.7% 是全站 31.4% 的 1.96 倍");
  assertEquals(seriesVerdict(rates, "Claude Sonnet 5").elevated, false);
  assertEquals(seriesVerdict(rates, "Gemini 3.1 Pro").elevated, false);
  assertEquals(seriesVerdict(rates, "沒見過的模型").elevated, false, "沒資料不提高");

  // 樣本不足：比例 100% 也不判（兩三筆查無就會算出 100%）
  const tiny = notFoundRates([
    { model: "X", contribution_type: null, submitted: NOT_FOUND_RATE_MIN_SAMPLE - 1, no_change_missing: NOT_FOUND_RATE_MIN_SAMPLE - 1 },
    { model: "Y", contribution_type: null, submitted: 500, no_change_missing: 5 },
  ]);
  assertEquals(seriesVerdict(tiny, "X").elevated, false, `少於 ${NOT_FOUND_RATE_MIN_SAMPLE} 筆不判`);

  // 絕對下限：全站查無率極低時，1.5 倍仍然很低的不該被提高
  const low = notFoundRates([
    { model: "X", contribution_type: null, submitted: 100, no_change_missing: 10 },
    { model: "Y", contribution_type: null, submitted: 500, no_change_missing: 10 },
  ]);
  assert(seriesVerdict(low, "X").rate < NOT_FOUND_RATE_FLOOR);
  assertEquals(seriesVerdict(low, "X").elevated, false, "10% 雖然是全站的 2.5 倍，但本身不高");

  // 相對判準：全站本來就高（任務真的難查）時，不會把所有系列一起掃進來
  const allHigh = notFoundRates([
    { model: "X", contribution_type: null, submitted: 100, no_change_missing: 60 },
    { model: "Y", contribution_type: null, submitted: 100, no_change_missing: 60 },
  ]);
  assertEquals(seriesVerdict(allHigh, "X").elevated, false, `大家都 60% 時，門檻是 ${NOT_FOUND_RATE_MULTIPLE} 倍的 60%`);
});

Deno.test("門檻：由 agent_tool 經 model_display_name 歸列，不比對模型名稱字串", () => {
  const rates = notFoundRates(STATS);
  // 同一列的各種寫法都算同一個系列
  for (const tool of ["claude-code/haiku", "ClaudeCode/haiku", "aegis-agent/HAIKU"]) {
    assertEquals(agentToolVerdict(rates, tool).elevated, true, tool);
  }
  // 同系列但寫了精確版本 → 另一列、沒有異常紀錄 → 一般門檻
  assertEquals(agentToolVerdict(rates, "claude-code/claude-haiku-4-5").elevated, false, "有版本的是獨立一列");
  assertEquals(agentToolVerdict(rates, "claude-code/claude-sonnet-5").elevated, false);
});

Deno.test("提高後的要求：7 個網址、至少 4 個不同網域", () => {
  assertEquals(NOT_FOUND_MIN_CHECKED_URLS, 5);
  assertEquals(NOT_FOUND_ELEVATED_MIN_CHECKED_URLS, 7);
  assertEquals(NOT_FOUND_ELEVATED_MIN_DOMAINS, 4);
  const task = `auto:policy_missing:${PID}`;
  const urls = (n: number, host = (i: number) => `example${i}.tw`) =>
    Array.from({ length: n }, (_, i) => `https://${host(i)}/news/%E7%8E%8B%E5%B0%8F%E6%98%8E?i=${i}`);

  // 一般門檻：5 個同網域也過（不動誠實代理現在的做法）
  assertEquals(notFoundSearchShortfall(task, { outcome: "not_found", checked_urls: urls(5, () => "cec.gov.tw") }, false), null);
  // 提高後：5 個不夠
  assertEquals(notFoundSearchShortfall(task, { outcome: "not_found", checked_urls: urls(5) }, true)?.required, 7);
  // 提高後：7 個但全是同一個站 → 擋（數量擋不住湊數，網域才是「有沒有去不同地方找」）
  const sameSite = notFoundSearchShortfall(task, { outcome: "not_found", checked_urls: urls(7, () => "cec.gov.tw") }, true);
  assertEquals(sameSite?.domains, 1);
  assertEquals(sameSite?.required_domains, 4);
  // 提高後：7 個、4 個網域 → 過
  assertEquals(
    notFoundSearchShortfall(task, { outcome: "not_found", checked_urls: urls(7, (i) => `site${i % 4}.tw`) }, true),
    null,
  );
  // www 與裸網域是同一個網域
  assertEquals(distinctDomains(["https://www.cec.gov.tw/a", "https://cec.gov.tw/b", "https://whoareyou.readr.tw/c"]), 2);
});

// ---- 交件端 ----

function body(agentTool: string | undefined, urls: string[]) {
  return {
    agent_name: "tester",
    ...(agentTool ? { agent_tool: agentTool } : {}),
    contribution_type: "no_change",
    payload: {
      task_id: `auto:policy_missing:${PID}`,
      outcome: "not_found",
      checked_urls: urls,
      finding: "搜了「王小明 政見」「王小明 參選 2026」「王小明 臉書」，候選人臉書與兩家地方新聞都沒有具體政見。",
    },
    source_urls: urls.slice(0, 1),
  };
}

const fiveDomains = [
  "https://www.instagram.com/wang/", // 2026-10-06 起搜尋結果頁不計入，這裡換成實際頁面
  "https://www.facebook.com/wang/posts",
  "https://whoareyou.readr.tw/politics/123",
  "https://db.cec.gov.tw/ElecTable/Election",
  "https://www.cna.com.tw/news/aipl/202609045002.aspx",
];
const sevenDomains = [
  ...fiveDomains,
  "https://www.ltn.com.tw/article/paper/123",
  "https://www.kmt.org.tw/candidates/wang",
];

/** 假 supabase：查詢一律回空，insert 記下來，rpc 可指定 */
function fakeSupabase(stats: ModelStatRow[] | null) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  let nextId = 1;
  const client = {
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, order: () => chain, limit: () => chain, neq: () => chain, is: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (row: Record<string, unknown> | Record<string, unknown>[]) => {
          const rows = (Array.isArray(row) ? row : [row]).map((r) => ({ id: `row-${nextId++}`, ...r }));
          for (const r of rows) inserted.push({ table, row: r });
          const selectResult = {
            then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
            maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
          };
          return { error: null, select: () => selectResult };
        },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        delete: () => ({ in: () => Promise.resolve({ error: null }) }),
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(res),
      };
      return chain;
    },
    rpc: async (name: string) =>
      name === "model_contribution_stats" ? { data: stats, error: stats ? null : { message: "boom" } } : { data: null, error: null },
  };
  return { client, inserted };
}

Deno.test("交件：查無率異常高的系列，5 個網址（5 個網域）被擋，訊息講出比例與門檻", async () => {
  resetNotFoundRatesCache();
  const { client, inserted } = fakeSupabase(STATS);
  const res = await handleContribute(client, "https://x", body("claude-code/haiku", fiveDomains), "ip-1");
  assertEquals(res.status, 400);
  const b = res.body as Record<string, unknown>;
  assertEquals(b.error, "not_found_search_insufficient", "錯誤代碼不變，代理原有的處理照用");
  assertEquals(b.required, 7);
  assertEquals(b.required_domains, 4);
  const msg = String(b.message);
  assertStringIncludes(msg, HAIKU);
  assertStringIncludes(msg, "62%");
  assertStringIncludes(msg, "不算被拒");
  assertEquals((b.elevated as Record<string, unknown>).window_days, NOT_FOUND_RATE_WINDOW_DAYS);
  assertEquals(inserted.filter((r) => r.table === "contributions").length, 0);
  assertEquals(
    inserted.filter((r) => r.table === "gate_rejections").map((r) => r.row.gate),
    ["not_found_search_insufficient_elevated"],
    "較嚴的那道單獨記，才看得出它擋了幾次",
  );
  resetNotFoundRatesCache();
});

Deno.test("交件：同一個系列附 7 個網址、7 個網域就收", async () => {
  resetNotFoundRatesCache();
  const { client } = fakeSupabase(STATS);
  const res = await handleContribute(client, "https://x", body("claude-code/haiku", sevenDomains), "ip-1");
  assert(res.status < 400, `應該收下，實際 ${res.status}：${JSON.stringify(res.body)}`);
  resetNotFoundRatesCache();
});

Deno.test("交件：查無率正常的系列照舊 5 個網址就收，且回應提醒 agent_tool 要填精確模型 ID", async () => {
  resetNotFoundRatesCache();
  const { client } = fakeSupabase(STATS);
  const res = await handleContribute(client, "https://x", body("claude-code/sonnet", fiveDomains), "ip-1");
  assert(res.status < 400, `應該收下，實際 ${res.status}：${JSON.stringify(res.body)}`);
  assertStringIncludes(String((res.body as Record<string, unknown>).notice), "Claude Sonnet（未標版本）");
  resetNotFoundRatesCache();
});

Deno.test("交件：統計拿不到時退回一般門檻，不把誠實的代理擋在門外", async () => {
  resetNotFoundRatesCache();
  const { client } = fakeSupabase(null);
  const res = await handleContribute(client, "https://x", body("claude-code/haiku", fiveDomains), "ip-1");
  assert(res.status < 400, `統計壞掉時應該放行，實際 ${res.status}：${JSON.stringify(res.body)}`);
  resetNotFoundRatesCache();
});

Deno.test("交件：一般門檻仍然擋少於 5 個（原本那道守門沒被改掉）", async () => {
  resetNotFoundRatesCache();
  const { client } = fakeSupabase(null);
  const res = await handleContribute(client, "https://x", body("claude-code/claude-sonnet-5", fiveDomains.slice(0, 3)), "ip-1");
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).required, 5);
  resetNotFoundRatesCache();
});
