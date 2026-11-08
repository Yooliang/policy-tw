// 派工列的 Jev 分類（2026-11-08，階段 1）：組 state、解析、/next 的 shape、批次冪等與上限（Jev 與資料庫都是 stub）
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { QUESTIONS, SUBJECT_TYPES, type JevResponse } from "./system-one.ts";
import {
  buildTaskEstimateAsk, parseTaskEstimate, shapeEstimate, summarizeTarget, TASK_ESTIMATE_QUESTIONS, TASK_ESTIMATE_VERSION,
} from "./task-estimate.ts";
import { type Candidate, type EstimateDeps, runTaskEstimate, TASK_ESTIMATE_WINDOW_MAX } from "./task-estimate-run.ts";

const MIG = Deno.readTextFileSync(new URL("../../migrations/20261108010000_task_estimates.sql", import.meta.url));

const rosterTask = {
  task_id: "auto:roster_check:2026:x", task_type: "roster_check",
  target: { reconcile: { people: Array.from({ length: 8 }, (_, i) => ({ name: `人${i}` })) }, region: "台南市", note: "字".repeat(500) },
  what_we_need: "比對名冊".repeat(300), hint_sources: ["a", "b"],
};
const candTask = {
  task_id: "auto:candidacy_source_missing:cand_no:1", task_type: "candidacy_source_missing",
  target: { kind: "cand_no", items: [{ name: "甲" }, { name: "乙" }, { name: "丙" }], items_count: 3, region: "台南市" },
  what_we_need: "補號次", hint_sources: null,
};

function answers(over: Record<string, string> = {}): JevResponse {
  const pick = (q: string, c: string) => ({ type: "choice", choice: over[q] ?? c, probabilities: { [over[q] ?? c]: 0.9 } });
  return {
    model: "typesafe/jev-1.13.0",
    answers: {
      task_difficulty: pick("task_difficulty", "easy"), task_time: pick("task_time", "le10"),
      task_model: pick("task_model", "cheap"), task_hardness: pick("task_hardness", "single_official_page"),
    },
    usage: { input_tokens: 100, output_tokens: 10, cost: 0.0004 },
  };
}

Deno.test("summarizeTarget：陣列縮成筆數與前幾個名字、長字串截斷、算人數", () => {
  const s = summarizeTarget(rosterTask.target);
  assertEquals(s.people_count, 8);
  assert(JSON.stringify(s.summary).length < 800);
  const c = summarizeTarget(candTask.target);
  assertEquals(c.people_count, 3);
  assertEquals(c.items_count, 3);
  assertEquals(summarizeTarget(null).people_count, 0);
});

Deno.test("buildTaskEstimateAsk：一次四題、state 有 task_type／人數／what_we_need（截斷）／版本", () => {
  const { state, questions } = buildTaskEstimateAsk(rosterTask);
  assertEquals(Object.keys(questions), [...TASK_ESTIMATE_QUESTIONS]);
  assertEquals(state.task_type, "roster_check");
  assertEquals(state.origin, "auto_gap");
  assertEquals(state.people_count, 8);
  assertEquals(state.question_version, TASK_ESTIMATE_VERSION);
  assert(String(state.what_we_need).length <= 700);
  assertEquals(Object.keys(questions.task_difficulty.criteria), ["easy", "medium", "hard"]);
  assertEquals(Object.keys(questions.task_time.criteria), ["le10", "m10_30", "m30_60", "gt60"]);
  assertEquals(Object.keys(questions.task_model.criteria), ["cheap", "strong"]);
  assertEquals(Object.keys(questions.task_hardness.criteria), ["ocr", "cross_identity", "news_search", "single_official_page", "other"]);
  assertStringIncludes(questions.task_difficulty.instructions, "不要執行");
});

Deno.test("buildTaskEstimateAsk：手動任務與名冊分組任務的來源標記", () => {
  assertEquals(buildTaskEstimateAsk({ task_id: "6f1c2e0a-0000-0000-0000-000000000000", task_type: "other", target: {}, what_we_need: "x", hint_sources: [] }).state.origin, "manual");
  assertEquals(buildTaskEstimateAsk({ task_id: "6f1c2e0a-0000-0000-0000-000000000001", task_type: "other", target: { multi_person: true }, what_we_need: "x", hint_sources: [] }).state.origin, "roster_group");
});

Deno.test("parseTaskEstimate：四題齊全才收；缺題或不認得的選項回 null", () => {
  const ok = parseTaskEstimate(answers({ task_difficulty: "hard", task_hardness: "ocr" }));
  assertEquals(ok?.difficulty, "hard");
  assertEquals(ok?.hardness, "ocr");
  assertEquals(ok?.probabilities.difficulty, 0.9);
  const missing = answers();
  delete missing.answers.task_time;
  assertEquals(parseTaskEstimate(missing), null);
  assertEquals(parseTaskEstimate(answers({ task_model: "mega" })), null);
  assertEquals(parseTaskEstimate(undefined), null);
});

Deno.test("shapeEstimate：中文標籤與分鐘上限；沒估過或壞值是 null", () => {
  const e = shapeEstimate({ difficulty: "hard", time_bucket: "m30_60", model_need: "strong", hardness: "cross_identity", question_version: "1", estimated_at: "2026-11-08T00:00:00Z" });
  assertEquals(e?.difficulty_label, "困難");
  assertEquals(e?.time_label, "30–60 分");
  assertEquals(e?.max_minutes, 60);
  assertEquals(e?.model_label, "要強模型");
  assertEquals(e?.hardness_label, "要跨來源比對身分");
  assertEquals(shapeEstimate({ difficulty: "easy", time_bucket: "gt60", model_need: "cheap", hardness: "other" })?.max_minutes, null);
  assertEquals(shapeEstimate(null), null);
  assertEquals(shapeEstimate({ difficulty: "??", time_bucket: "le10", model_need: "cheap", hardness: "other" }), null);
});

Deno.test("system-one 的主體與題目清單、migration 的 CHECK 都收得下 task", () => {
  assert((SUBJECT_TYPES as readonly string[]).includes("task"));
  for (const q of TASK_ESTIMATE_QUESTIONS) {
    assert((QUESTIONS as readonly string[]).includes(q), q);
    assertStringIncludes(MIG, `'${q}'`);
  }
  assertStringIncludes(MIG, "'task')");
  assertStringIncludes(MIG, "task_estimate_candidates");
  assertStringIncludes(MIG, "ENABLE ROW LEVEL SECURITY");
});

// ---- 批次 ----
function harness(cands: Candidate[], over: Partial<EstimateDeps> = {}) {
  const store = new Map<string, Record<string, unknown>>();
  const recorded: string[] = [];
  let asks = 0;
  const deps: EstimateDeps = {
    recentCount: () => Promise.resolve(0),
    candidates: (limit) => Promise.resolve(cands.filter((c) => {
      const row = store.get(c.task_id);
      return !row || row.target_hash !== c.target_hash || row.question_version !== TASK_ESTIMATE_VERSION;
    }).slice(0, limit)),
    ask: () => { asks++; return Promise.resolve(answers()); },
    record: (rows) => { rows.forEach((r) => recorded.push(`${r.subject_type}/${r.subject_id}/${r.question}`)); return Promise.resolve({ inserted: rows.length, skipped: 0 }); },
    save: (row) => { store.set(String(row.task_id), row); return Promise.resolve(); },
    ...over,
  };
  return { deps, store, recorded, asks: () => asks };
}
const C1: Candidate = { ...rosterTask, target_hash: "h1" };
const C2: Candidate = { ...candTask, target_hash: "h2" };

Deno.test("runTaskEstimate：估一次、寫側表與四筆 jev_decisions；第二輪冪等不再問", async () => {
  const h = harness([C1, C2]);
  const r1 = await runTaskEstimate(h.deps);
  assertEquals(r1.asked, 2);
  assertEquals(r1.saved, 2);
  assertEquals(h.store.size, 2);
  assertEquals(h.recorded.length, 8);
  assert(h.recorded.includes("task/auto:roster_check:2026:x/task_difficulty"));
  assertEquals(h.store.get(C1.task_id)?.question_version, TASK_ESTIMATE_VERSION);
  const r2 = await runTaskEstimate(h.deps);
  assertEquals(r2.candidates, 0);
  assertEquals(h.asks(), 2);
});

Deno.test("runTaskEstimate：目標變了（hash 不同）才重問，沒變的不動", async () => {
  const h = harness([C1, C2]);
  await runTaskEstimate(h.deps);
  const h2 = { ...h.deps, candidates: (limit: number) => Promise.resolve([{ ...C1, target_hash: "h1-changed" }, C2].filter((c) => h.store.get(c.task_id)?.target_hash !== c.target_hash).slice(0, limit)) };
  const r = await runTaskEstimate(h2);
  assertEquals(r.asked, 1);
  assertEquals(r.estimates[0].task_id, C1.task_id);
});

Deno.test("runTaskEstimate：dry 只問不寫", async () => {
  const h = harness([C1, C2]);
  const r = await runTaskEstimate(h.deps, { dry: true });
  assertEquals(r.asked, 2);
  assertEquals(r.estimates.length, 2);
  assertEquals(r.saved, 0);
  assertEquals(h.store.size, 0);
  assertEquals(h.recorded.length, 0);
});

Deno.test("runTaskEstimate：limit 與時間窗上限", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ ...C1, task_id: `auto:x:${i}`, target_hash: `h${i}` }));
  const h = harness(many);
  assertEquals((await runTaskEstimate(h.deps, { limit: 3 })).asked, 3);
  const full = harness(many, { recentCount: () => Promise.resolve(TASK_ESTIMATE_WINDOW_MAX) });
  const r = await runTaskEstimate(full.deps, { limit: 50 });
  assertEquals(r.budget, 0);
  assertEquals(r.asked, 0);
  assertEquals(full.asks(), 0);
  const some = harness(many, { recentCount: () => Promise.resolve(TASK_ESTIMATE_WINDOW_MAX - 2) });
  assertEquals((await runTaskEstimate(some.deps, { limit: 50 })).asked, 2);
});

Deno.test("runTaskEstimate：Jev 連掛三次整輪停；答不全的不存", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ ...C1, task_id: `auto:x:${i}`, target_hash: `h${i}` }));
  const bad = harness(many, { ask: () => Promise.reject(new Error("boom")) });
  const r = await runTaskEstimate(bad.deps);
  assertEquals(r.failures.length, 3);
  assertEquals(r.saved, 0);
  const partial = harness([C1], { ask: () => { const a = answers(); delete a.answers.task_model; return Promise.resolve(a); } });
  const r2 = await runTaskEstimate(partial.deps);
  assertEquals(r2.unusable, 1);
  assertEquals(partial.store.size, 0);
});
