import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildRequestTaskText, decideRequest, isAuditUrl } from "./request-task.ts";
import { describeManualTask, sameAuditTarget, validateTaskInput } from "./task-admin.ts";
import { validateContributionRequest } from "./contribution-schema.ts";
import { applyContribution, TASK_CHECK_COOLDOWN_DAYS } from "./apply-contribution.ts";

const DOC = "https://www.gov.taipei/News_Content.aspx?n=1&s=2";
const POLICY = "0c9c1a5e-1111-4222-8333-444444444444";
const POL = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";

Deno.test("audit 任務：網址驗證、任務文字帶 source_url 與頁面情境、同網址同目標 24h 去重 → already_queued(duplicate_url)", () => {
  assert(isAuditUrl(DOC));
  assert(!isAuditUrl("gov.taipei/x"));
  assert(!isAuditUrl("javascript:alert(1)"));
  assert(!isAuditUrl("ftp://example.org/a"));

  const text = buildRequestTaskText({ kind: "audit", politician_id: POL, policy_id: POLICY, politician_name: "陳素月", policy_title: "長者健保全免", source_url: DOC, note: "第 3 頁有預算表" });
  assert(text.title.includes("核對這份文件"));
  assert(text.description.includes(DOC) && text.description.includes("長者健保全免") && text.description.includes("第 3 頁有預算表"));
  assertEquals(text.hint_sources, [DOC]);

  // createTask 會把 source_url 放進 target；/next、/tasks 用 describeManualTask 提到 item 上
  const v = validateTaskInput({ title: text.title, description: text.description, task_type: "audit", target_policy_id: POLICY, target_politician_id: POL, source_url: DOC });
  assertEquals(v.ok, true);
  const target = { policy_id: POLICY, politician_id: POL, source_url: DOC };
  const described = describeManualTask({ title: text.title, description: text.description, task_type: "audit", target });
  assertEquals(described.source_url, DOC);
  assert(described.what_we_need.startsWith("打開這份文件，核對其內容"));

  // 去重：同網址 + 同目標才算重複
  assert(sameAuditTarget(target, { policy_id: POLICY, politician_id: POL }));
  assert(!sameAuditTarget(target, { policy_id: null, politician_id: POL }));
  assertEquals(decideRequest({ usedToday: 0, existingOpenTask: null, autoGapTaskId: null, duplicateAuditTask: { id: "t-dup" } }), { action: "already_queued", task_id: "t-dup", reason: "duplicate_url" });
  assertEquals(decideRequest({ usedToday: 0, existingOpenTask: null, autoGapTaskId: null, duplicateAuditTask: null }), { action: "create" });
  assertEquals(validateTaskInput({ title: "核對這份文件", task_type: "audit", source_url: "not a url" }).errors.map((e) => e.path), ["task.source_url"]);
});

Deno.test("no_change：schema 要 task_id／checked_urls／finding，source_urls 可省略；落庫只關任務不改資料，auto: 任務只記錄", async () => {
  const ok = validateContributionRequest({
    agent_name: "tester", contribution_type: "no_change",
    payload: { task_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", outcome: "confirmed", checked_urls: [DOC], finding: "文件第 3 頁預算與資料庫進度 60% 一致，無需更新。" },
  });
  assertEquals(ok.errors, []);
  assertEquals(ok.items[0].source_urls, [DOC]);
  const bad = validateContributionRequest({ agent_name: "tester", contribution_type: "no_change", payload: { finding: "太短" }, source_urls: [DOC] });
  assertEquals(bad.errors.map((e) => e.path).sort(), ["payload.checked_urls", "payload.finding", "payload.outcome", "payload.task_id"]);
  // outcome 是三選一，不能自己發明一個（"partial"、"cannot_tell" 這類會變成新的模糊地帶）
  const invented = validateContributionRequest({
    agent_name: "tester", contribution_type: "no_change",
    payload: { task_id: "t", outcome: "cannot_tell", checked_urls: [DOC], finding: "看不出來，先交了再說。" },
  });
  assertEquals(invented.errors.map((e) => e.path), ["payload.outcome"]);

  const updates: Array<{ table: string; patch: Record<string, unknown>; id: string }> = [];
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const fake = {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          updates.push({ table, patch, id });
          return { select: () => ({ maybeSingle: async () => ({ data: { id, status: "closed" }, error: null }) }) };
        },
      }),
      insert: (row: Record<string, unknown>) => { inserted.push({ table, row }); return { error: null }; },
    }),
  };
  const outcome = await applyContribution(fake, {
    id: "c-9", contribution_type: "no_change", source_urls: [DOC], note: null, agent_name: "tester", contributor_url: null,
    payload: { task_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", outcome: "confirmed", checked_urls: [DOC], finding: "文件與資料庫一致，無需更新。" },
  });
  assertEquals(outcome.status, "applied");
  assertEquals(outcome.task_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assertEquals(updates.length, 1);
  assertEquals(updates[0].table, "contribution_tasks");
  assertEquals(updates[0].patch.status, "closed");
  assert(inserted.every((i) => i.table === "edit_history"), "除了 edit_history 不寫任何表");

  // 自動缺口不是靠關閉任務消失的（它是即時算出來的），所以不打 update；
  // 但一定要記一筆 task_checks，否則「查過、沒東西可補」不留痕跡，
  // 同一筆死路會被無限重派給每一個代理。
  const before = inserted.length;
  const auto = await applyContribution(fake, {
    id: "c-10", contribution_type: "no_change", source_urls: [DOC], note: null, agent_name: "tester", contributor_url: null,
    payload: { task_id: "auto:policy_missing:" + POL, checked_urls: [DOC], finding: "已查過三個來源，該候選人尚未公布政見。" },
  });
  assertEquals(auto.status, "applied");
  assertEquals(updates.length, 1, "auto: 任務不打 update");
  const added = inserted.slice(before);
  assert(added.some((i) => i.table === "task_checks"), "auto: 任務要記一筆 task_checks，冷卻期內才不會重派");
  assert(auto.message.includes(String(TASK_CHECK_COOLDOWN_DAYS)), "訊息要告訴代理冷卻幾天，它才知道這筆不是白做");
});
