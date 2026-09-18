import { assert, assertEquals } from "jsr:@std/assert@1";
import { manualTaskIdOf, shouldCloseOnApplied } from "./task-fulfilment.ts";
import { closeTaskIfFulfilled, type ContributionRow } from "./apply-contribution.ts";

const TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

Deno.test("任務何時算做完：補資料的貢獻上線就關；question／news_sweep／adjudicate／roster_check 不關", () => {
  for (const t of ["policy_missing", "profile_gap", "progress_stale", "policy_validity", "audit", "fix_disputed"]) {
    assert(shouldCloseOnApplied(t, "policy") || shouldCloseOnApplied(t, "politician"), `${t} 應該在補資料的貢獻上線後關閉`);
  }
  for (const t of ["question", "news_sweep", "adjudicate", "roster_check"]) {
    assertEquals(shouldCloseOnApplied(t, "policy"), false, `${t} 不該因為一筆上線就關`);
  }
  // 有自己收尾的貢獻型別不走這條
  for (const c of ["no_change", "adjudication", "task_suggestion", "question_answer", "roster_check"]) {
    assertEquals(shouldCloseOnApplied("policy_missing", c), false, `${c} 有自己的收尾`);
  }
  assertEquals(shouldCloseOnApplied(null, "policy"), false, "查不到任務型別就不動");
});

Deno.test("所屬任務 id：欄位優先、payload 次之；auto: 缺口與空值不算", () => {
  assertEquals(manualTaskIdOf({ task_id: TASK }), TASK);
  assertEquals(manualTaskIdOf({ payload: { task_id: TASK } }), TASK);
  assertEquals(manualTaskIdOf({ task_id: "auto:policy_missing:x" }), null);
  assertEquals(manualTaskIdOf({ task_id: "  " }), null);
  assertEquals(manualTaskIdOf({}), null);
});

function fakeDb(task: { status: string; task_type: string } | null) {
  const updates: Array<{ table: string; patch: Record<string, unknown>; id: string }> = [];
  const history: Array<Record<string, unknown>> = [];
  const db = {
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, id: string) => ({
          maybeSingle: async () => ({ data: table === "contribution_tasks" && task ? { id, ...task } : null, error: null }),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (_c: string, id: string) => {
          updates.push({ table, patch, id });
          return { select: () => ({ maybeSingle: async () => ({ data: { id, status: "closed" }, error: null }) }) };
        },
      }),
      insert: (row: Record<string, unknown>) => {
        if (table === "edit_history") history.push(row);
        return { error: null };
      },
    }),
  };
  return { db, updates, history };
}

const row = (over: Partial<ContributionRow> = {}): ContributionRow => ({
  id: "c1", contribution_type: "policy", payload: {}, source_urls: ["https://example.org"], note: null,
  agent_name: "hsinyi88", contributor_url: null, task_id: TASK, ...over,
});

Deno.test("政見上線 → 所屬的「查政見」任務關掉，並記進 edit_history（整筆還原時會重開）", async () => {
  const { db, updates, history } = fakeDb({ status: "open", task_type: "policy_missing" });
  // deno-lint-ignore no-explicit-any
  assertEquals(await closeTaskIfFulfilled(db as any, row()), true);
  assertEquals(updates.map((u) => [u.table, u.id, u.patch.status]), [["contribution_tasks", TASK, "closed"]]);
  assertEquals(history.map((h) => [h.table_name, h.record_id, h.old_value, h.new_value]), [["contribution_tasks", TASK, "open", "closed"]]);
});

Deno.test("不該關的情況一律不動：公民提問、已關閉、auto: 缺口、沒有 task_id", async () => {
  const cases: Array<[string, { status: string; task_type: string } | null, ContributionRow]> = [
    ["公民提問要收滿 3 份", { status: "open", task_type: "question" }, row()],
    ["已經關了", { status: "closed", task_type: "policy_missing" }, row()],
    ["auto: 缺口不是資料表裡的一列", { status: "open", task_type: "policy_missing" }, row({ task_id: "auto:policy_missing:x" })],
    ["沒帶 task_id", { status: "open", task_type: "policy_missing" }, row({ task_id: null })],
  ];
  for (const [why, task, r] of cases) {
    const { db, updates } = fakeDb(task);
    // deno-lint-ignore no-explicit-any
    assertEquals(await closeTaskIfFulfilled(db as any, r), false, why);
    assertEquals(updates.length, 0, why);
  }
});

// 讀貢獻的三個地方少撈 task_id，關任務就會永遠讀不到、默默不做——而且上面的測試照樣全綠
// （它們直接餵 task_id）。這裡盯住三個呼叫端撈的欄位。
Deno.test("三個上線入口撈貢獻時都要帶 task_id，不然關任務會默默失效", async () => {
  const files: Array<[string, RegExp]> = [
    ["./auto-apply.ts", /const ROW_COLUMNS = "([^"]+)"/],
    ["./apply-contribution.ts", /const ORIGINAL_COLUMNS = "([^"]+)"/],
    ["../apply/index.ts", /const ROW_COLUMNS = "([^"]+)"/],
  ];
  for (const [path, re] of files) {
    const src = await Deno.readTextFile(new URL(path, import.meta.url));
    const cols = src.match(re)?.[1].split(",").map((c) => c.trim()) ?? [];
    assert(cols.includes("task_id"), `${path} 撈貢獻的欄位少了 task_id`);
  }
});
