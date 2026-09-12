import { assert, assertEquals } from "jsr:@std/assert@1";
import { describeManualTask, taskTarget, validateTaskInput } from "./task-admin.ts";
import { buildRequestTaskText, decideRequest, REQUEST_DAILY_LIMIT_PER_IP } from "./request-task.ts";
import { validateContributionRequest } from "./contribution-schema.ts";
import { applyContribution } from "./apply-contribution.ts";

const CNA = "https://www.cna.com.tw/news/aipl/202609045002.aspx";

Deno.test("task_suggestion schema：title 10～100、description ≥20、來源必附；task_type 只收六種", () => {
  const good = validateContributionRequest({
    agent_name: "tester", contribution_type: "task_suggestion",
    payload: { title: "補齊蔣萬安 2026 政見白皮書內容", description: "9/10 競選辦公室公布了政見白皮書，目前資料庫只有三條，應該逐條補進去並附白皮書網址。", task_type: "policy_missing", region: "台北市" },
    source_urls: [CNA],
  });
  assertEquals(good.errors, []);
  const bad = validateContributionRequest({
    agent_name: "tester", contribution_type: "task_suggestion",
    payload: { title: "查一下", description: "太短", task_type: "rumor" },
    source_urls: [CNA],
  });
  assertEquals(bad.errors.map((e) => e.path).sort(), ["payload.description", "payload.task_type", "payload.title"]);
});

Deno.test("維護者 create_task 輸入驗證：title 必填、uuid 格式、target 組法", () => {
  const v = validateTaskInput({ title: "補 2026 台北市長候選人政見", description: "六位登記者各至少 3 條", task_type: "policy_missing", target_politician_id: "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9", region: "臺北市", priority: 5 });
  assertEquals(v.ok, true);
  assertEquals(v.input?.region, "台北市");
  assertEquals(taskTarget(v.input!), { politician_id: "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9", region: "台北市" });
  const bad = validateTaskInput({ title: "短", target_policy_id: "nope", task_type: "x" });
  assertEquals(bad.ok, false);
  assertEquals(bad.errors.map((e) => e.path).sort(), ["task.target_policy_id", "task.task_type", "task.title"]);
});

Deno.test("task_suggestion 2 票通過 → apply 落庫成 open 任務（source=suggested、suggested_by=agent）", async () => {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const fake = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, row });
        return { select: () => ({ maybeSingle: async () => ({ data: { id: "task-1", ...row }, error: null }) }), error: null };
      },
    }),
  };
  // edit_history 的 insert 也走同一個 fake（回 {error:null}），這裡只檢查 contribution_tasks 那筆
  const outcome = await applyContribution(fake, {
    id: "c-1", contribution_type: "task_suggestion", source_urls: [CNA], note: null, agent_name: "gemini-tester", contributor_url: null,
    payload: { title: "補齊蔣萬安 2026 政見白皮書內容", description: "競選辦公室公布了政見白皮書，資料庫只有三條，應逐條補進去。", task_type: "policy_missing", region: "台北市" },
  });
  assertEquals(outcome.status, "applied");
  assertEquals(outcome.task_id, "task-1");
  const task = inserted.find((i) => i.table === "contribution_tasks")!.row;
  assertEquals(task.status, "open");
  assertEquals(task.source, "suggested");
  assertEquals(task.suggested_by, "gemini-tester");
  assertEquals(task.priority, 0);
  assert(inserted.some((i) => i.table === "edit_history"), "有寫 edit_history");
});

Deno.test("describeManualTask：question 任務講清楚型別、上限、重複角度沒有加分", () => {
  const described = describeManualTask({
    title: "回答民眾提問：市長有承諾要蓋長照據點嗎？",
    description: "市長有承諾要蓋長照據點嗎？大概什麼時候會完工？",
    task_type: "question",
    target: { question_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  });
  assert(described.what_we_need.includes("question_answer"));
  assert(described.what_we_need.includes("最多收 3 份"));
  assert(described.what_we_need.includes("沒有加分"), "講清楚重複角度沒有加分");
  assert(described.what_we_need.includes("市長有承諾要蓋長照據點嗎？大概什麼時候會完工？"), "帶出完整提問內容，不是只有截短的 title");
  assertEquals(described.source_url, null);
});

Deno.test("request-task 規則：已有 open 任務 → already_queued；對應自動缺口 → already_queued；限額 10", () => {
  assertEquals(decideRequest({ usedToday: 0, existingOpenTask: { id: "t1" }, autoGapTaskId: null }), { action: "already_queued", task_id: "t1", reason: "open_task" });
  assertEquals(decideRequest({ usedToday: 0, existingOpenTask: null, autoGapTaskId: "auto:policy_missing:p1" }), { action: "already_queued", task_id: "auto:policy_missing:p1", reason: "auto_gap" });
  assertEquals(decideRequest({ usedToday: 0, existingOpenTask: null, autoGapTaskId: null }), { action: "create" });
  assertEquals(decideRequest({ usedToday: REQUEST_DAILY_LIMIT_PER_IP, existingOpenTask: null, autoGapTaskId: null }), { action: "rate_limited" });
  const text = buildRequestTaskText({ kind: "progress", politician_id: "p", policy_id: "x", politician_name: "陳素月", policy_title: "長者健保全免" });
  assert(text.title.includes("長者健保全免"));
  assert(text.description.includes("policy_progress"));
});

Deno.test("news_sweep 任務：RSS 網址要提到 item.source_url，敘述要講死來源網址規則", () => {
  const described = describeManualTask({
    title: "掃 中央社 政治 找新政見",
    description: "打開 https://feeds.feedburner.com/rsscna/politics（RSS，最新 20～40 筆），"
      + "挑出提到 2026 候選人「具體政見」或既有政見「新進度」的報導。"
      + "source_urls 一律放新聞原文網址（RSS 裡 <link> 的值，不是這個 RSS 網址、不是搜尋結果、不是轉貼）。"
      + "看完沒有可提交的就用 no_change 回報。",
    task_type: "news_sweep",
    target: { feed_url: "https://feeds.feedburner.com/rsscna/politics", label: "中央社 政治" },
  });
  // 代理要能從 item.source_url 直接拿到 RSS，不必從中文敘述裡用正則撈網址
  assertEquals(described.source_url, "https://feeds.feedburner.com/rsscna/politics");
  assert(described.what_we_need.includes("新聞原文網址"), "要講明附的是原文網址不是 RSS 自己");
  assert(described.what_we_need.includes("no_change"), "要給查完沒東西的出口，否則任務不會關、來源從此不再被掃");
});

Deno.test("news_sweep 是合法的 task_type（task_suggestion 才提議得動）", () => {
  const v = validateContributionRequest({
    agent_name: "someone",
    contribution_type: "task_suggestion",
    payload: { title: "加掃公視新聞 RSS", description: "公視的政治新聞沒有被掃到，建議加一個來源。", task_type: "news_sweep" },
    source_urls: ["https://about.pts.org.tw/"],
  });
  assert(v.ok, `news_sweep 應該是合法 task_type，卻被擋：${JSON.stringify(v.ok ? [] : v.errors)}`);
});
