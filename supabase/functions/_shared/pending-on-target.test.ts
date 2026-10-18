/**
 * 協議 1.98.0 D：派任務與驗證時附上「這個人身上等票中的交件」（current.pending_on_target）。
 * 劉雁祿形狀：人物 8d5c8372、參選紀錄 pe 113、等票中的「沒參選」更正（target_table＝politician_elections、target_id＝113）與改名更正（target_table＝politicians）。
 *   - 派以 8d5c8372 為對象的任務 → 列出那兩筆；摘要用名稱、不印 id；不帶 agent_name、ip_hash、完整 payload；上限 10 筆、超過附 total
 *   - 撈取丟錯 → 派工照常（不附、不丟）
 *   - 驗證情境排除被驗的那一筆自己
 *   - 查詢條件涵蓋 correction／removal 的 target_id（比對 target_table）、merge_politician 的兩方、reassign_candidacy 的三個 id、applied_politician_id
 *   - /next 只讀佇列（#233／#234）：查詢只在 task-context 的 fetchTaskContext／fetchVerifyContext 裡，不在派工過濾、排序、seed
 * 還原驗證：拿掉 fetchTaskContext 結尾的 fetchPendingOnTarget 呼叫 → 「劉雁祿形狀」紅；拿掉 fetchVerifyContext 的 excludeContributionId → 驗證排除那支紅；
 * 拿掉 try/catch → 丟錯那支紅；pendingOrFilter 拿掉 target_table 那一行 → 條件那支紅。
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { fetchPendingOnTarget, MAX_PENDING_ON_TARGET, pendingOrFilter, scopeOfPayload, scopeOfTarget, shapePendingOnTarget } from "./pending-on-target.ts";
import { fetchTaskContext, fetchVerifyContext, shapeTaskCurrent, shapeVerifyCurrent } from "./task-context.ts";
import { PENDING_ON_TARGET_GUIDE } from "./task-guidance.ts";

type Row = Record<string, unknown>;
const POL = "8d5c8372-1764-4ef7-9a7d-8a3e11658c62";
const REAL = "38d16e30-0000-4000-8000-000000000001";
const NOT_RUNNING = "a8bfe400-3671-4134-918e-74ccf8304e85";
const RENAME = "467636dc-9c24-4a4f-9f7b-19475531733e";

const contrib = (id: string, type: string, payload: Row, over: Row = {}): Row => ({
  id, contribution_type: type, payload, applied_politician_id: null, applied_policy_id: null,
  created_at: "2026-10-08T06:10:00Z", score: 1, target_score: 3, agent_name: "secret-agent", verifier_ip_hash: "deadbeef", ...over,
});
const ROWS: Row[] = [
  contrib(NOT_RUNNING, "correction", { target_table: "politician_elections", target_id: "113", reason: "公報沒有這個人", changes: [{ field: "candidate_status", current_value: "filed", correct_value: "not_running" }] }),
  contrib(RENAME, "correction", { target_table: "politicians", target_id: POL, reason: "改名", changes: [{ field: "name", current_value: "劉雁祿", correct_value: "劉復嵐" }] }, { created_at: "2026-10-17T20:42:00Z" }),
];

interface Fake { client: unknown; contributionQueries: Array<{ or: string | null; neq: string | null; limit: number | null }> }
/** 假 supabase：contributions 查詢記錄條件、回固定列（排除 neq 的 id）；其餘表回對照用的列 */
function fake(opts: { rows?: Row[]; fail?: boolean; total?: number } = {}): Fake {
  const contributionQueries: Fake["contributionQueries"] = [];
  const tables: Record<string, Row[]> = {
    politician_elections: [{ id: 113, politician_id: POL, election_id: 2022, election_type: "縣市長", politicians: { name: "劉雁祿" } }],
    politicians: [{ id: POL, name: "劉雁祿" }],
    policies: [], lineages: [], parties: [], admin_divisions: [],
  };
  const from = (table: string) => {
    let or: string | null = null; let neq: string | null = null; let limit: number | null = null;
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      in: () => api,
      eq: () => api,
      is: () => api,
      or: (f: string) => { or = f; return api; },
      neq: (_c: string, v: string) => { neq = v; return api; },
      order: () => api,
      limit: (n: number) => { limit = n; return api; },
      maybeSingle: () => Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => {
        if (table === "contributions") {
          contributionQueries.push({ or, neq, limit });
          if (opts.fail) return res({ data: null, count: null, error: { message: "boom" } });
          const rows = (opts.rows ?? ROWS).filter((r) => r.id !== neq).slice(0, limit ?? 1000);
          return res({ data: rows, count: opts.total ?? (opts.rows ?? ROWS).filter((r) => r.id !== neq).length, error: null });
        }
        return res({ data: tables[table] ?? [], error: null });
      },
    };
    return api;
  };
  return { client: { from, rpc: () => Promise.resolve({ data: null, error: null }) }, contributionQueries };
}

Deno.test("劉雁祿形狀：派以 8d5c8372 為對象的任務 → current.pending_on_target 列出等票的「沒參選」更正與改名更正", async () => {
  const f = fake();
  const data = await fetchTaskContext(f.client, "profile_gap", { politician_id: POL });
  const cur = shapeTaskCurrent("profile_gap", data);
  const items = cur.pending_on_target as Row[];
  assertEquals(items.map((i) => i.contribution_id), [NOT_RUNNING, RENAME]);
  assertEquals(items[0].contribution_type, "correction");
  assertEquals(items[0].score, 1);
  assertEquals(items[0].target_score, 3);
  assertEquals(items[0].created_at, "2026-10-08T06:10:00Z");
  assertEquals(cur.pending_on_target_hint, PENDING_ON_TARGET_GUIDE);
  assertFalse("pending_on_target_total" in cur, "沒超過上限不附 total");
  // 只給白名單欄位；不給 agent_name、ip_hash、完整 payload；摘要不印 id
  for (const it of items) {
    assertEquals(Object.keys(it).sort(), ["contribution_id", "contribution_type", "created_at", "score", "summary", "target_score"]);
    assertFalse(JSON.stringify(it).includes("secret-agent"));
    assertFalse(JSON.stringify(it).includes("deadbeef"));
    assertFalse(String(it.summary).includes(POL), "摘要不印人物 id");
    assertFalse(/\b113\b/.test(String(it.summary)), "摘要不印參選紀錄 id");
  }
  assertStringIncludes(String(items[0].summary), "劉雁祿");
  // 查詢帶到他的參選紀錄 pe 113（correction 的 target_id 比對 target_table）
  const q = f.contributionQueries[0];
  assertStringIncludes(q.or!, "and(payload->>target_table.eq.politician_elections,payload->>target_id.in.(113))");
  assertEquals(q.limit, MAX_PENDING_ON_TARGET);
});

Deno.test("沒有等票交件、或任務沒有人物／參選紀錄／政見對象 → 不附，也不多查", async () => {
  const none = fake({ rows: [] });
  assertFalse("pending_on_target" in shapeTaskCurrent("profile_gap", await fetchTaskContext(none.client, "profile_gap", { politician_id: POL })));
  const noTarget = fake();
  await fetchTaskContext(noTarget.client, "news_sweep", { feed_url: "https://example.com/rss" });
  assertEquals(noTarget.contributionQueries.length, 0);
});

Deno.test("撈取丟錯 → 派工照常（不附、不丟）", async () => {
  const bad = fake({ fail: true });
  const data = await fetchTaskContext(bad.client, "profile_gap", { politician_id: POL });
  assertEquals(data.pending_on_target, undefined);
  assertFalse("pending_on_target" in shapeTaskCurrent("profile_gap", data));
  assertEquals(await fetchPendingOnTarget({ from: () => { throw new Error("連線斷了"); } }, scopeOfTarget({ politician_id: POL })), null);
});

Deno.test("驗證情境：同一個對象上別筆等票的列出來，被驗的那一筆自己不列", async () => {
  const f = fake();
  const payload = ROWS[1].payload as Row;
  const data = await fetchVerifyContext(f.client, "correction", payload, RENAME);
  const cur = shapeVerifyCurrent("correction", payload, data);
  assertEquals((cur.pending_on_target as Row[]).map((i) => i.contribution_id), [NOT_RUNNING]);
  assertEquals(f.contributionQueries.at(-1)!.neq, RENAME);
});

Deno.test("超過 10 筆：只給 10 筆、附 pending_on_target_total", async () => {
  const many = Array.from({ length: 14 }, (_, i) => contrib(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, "correction", ROWS[0].payload as Row));
  const out = await fetchPendingOnTarget(fake({ rows: many }).client, scopeOfTarget({ politician_id: POL }));
  assertEquals(out!.items.length, 10);
  assertEquals(out!.total, 14);
  assertEquals(shapePendingOnTarget(out).pending_on_target_total, 14);
});

Deno.test("查詢條件涵蓋：直接指到人物、correction／removal 的 target_id（比對 target_table）、merge 兩方、reassign 三個 id、政見", () => {
  const f = pendingOrFilter({ politicianIds: [POL], electionIds: [113], policyIds: [REAL] })!;
  for (const k of ["politician_id", "keep_id", "remove_id", "from_politician_id", "to_politician_id"]) assertStringIncludes(f, `payload->>${k}.in.(${POL})`);
  assertStringIncludes(f, `applied_politician_id.in.(${POL})`);
  assertStringIncludes(f, `and(payload->>target_table.eq.politicians,payload->>target_id.in.(${POL}))`);
  assertStringIncludes(f, "and(payload->>target_table.eq.politician_elections,payload->>target_id.in.(113))");
  assertStringIncludes(f, "payload->>politician_election_id.in.(113)");
  assertStringIncludes(f, `and(payload->>target_table.eq.policies,payload->>target_id.in.(${REAL}))`);
  assertEquals(pendingOrFilter({ politicianIds: [], electionIds: [], policyIds: [] }), null);
});

Deno.test("scope：從任務 target 與待驗 payload 抽 id；亂格式的丟掉、參選紀錄一長串不展開", () => {
  assertEquals(scopeOfTarget({ politician_id: POL, politician_election_ids: [113, "914", "x"] }), { politicianIds: [POL], electionIds: [113, 914], policyIds: [] });
  assertEquals(scopeOfTarget({ politician_id: "not-a-uuid" }).politicianIds, []);
  assertEquals(scopeOfTarget({ politician_election_ids: Array.from({ length: 80 }, (_, i) => i + 1) }).electionIds, []);
  assertEquals(scopeOfPayload({ keep_id: REAL, remove_id: POL, same_person: true }).politicianIds.sort(), [POL, REAL].sort());
  assertEquals(scopeOfPayload({ target_table: "politician_elections", target_id: "113" }).electionIds, [113]);
  assertEquals(scopeOfPayload({ from_politician_id: POL, to_politician_id: REAL, politician_election_id: 113 }).electionIds, [113]);
});

Deno.test("/next 只讀佇列（#233／#234）：等票查詢只在 task-context 的 fetchTaskContext／fetchVerifyContext 層，派工過濾、排序、seed 不碰", async () => {
  const dir = new URL("./", import.meta.url);
  const hits: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
    if ((await Deno.readTextFile(new URL(e.name, dir))).includes("fetchPendingOnTarget")) hits.push(e.name);
  }
  assertEquals(hits.sort(), ["pending-on-target.ts", "task-context.ts"]);
  for (const f of ["dispatch.ts", "verify-claim.ts"]) assert(!(await Deno.readTextFile(new URL(f, dir))).includes("pending_on_target"), f);
  const ctx = await Deno.readTextFile(new URL("task-context.ts", dir));
  assertEquals(ctx.split("fetchPendingOnTarget(supabase").length - 1, 2, "只有任務現況與驗證現況兩處呼叫");
  const sql = (await Deno.readTextFile(new URL("../../migrations/20261018030000_correction_withdraw_two_ips.sql", dir)));
  assertFalse(/seed_auto_task_queue|pending_on_target/.test(sql.replace(/^--.*$/gm, "")), "migration 不碰 seed");
});
