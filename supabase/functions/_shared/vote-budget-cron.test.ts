import { assert } from "jsr:@std/assert";
import { VOTE_DIMENSIONS } from "./vote-budget.ts";

// 排程打的 action 名稱、候選 RPC 名稱、候選型別清單三處要對得上（2026-09-23 影子模式排進排程）
const idx = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
const mig = await Deno.readTextFile(new URL("../../migrations/20260923000006_vote_budget_shadow_cron.sql", import.meta.url));

Deno.test("票數預算排程：cron 打的 action 在 system-one 裡存在", () => {
  assert(mig.includes("action=vote_budget_sweep"), "migration 的 cron 要打 vote_budget_sweep");
  assert(idx.includes('action === "vote_budget_sweep"'), "system-one 要有 vote_budget_sweep");
  assert(idx.includes('rpc("system_one_vote_budget_candidates"'), "sweep 要用 system_one_vote_budget_candidates 撿候選");
  assert(mig.includes("FUNCTION system_one_vote_budget_candidates"), "migration 要定義候選 RPC");
});

Deno.test("票數預算排程：候選型別清單 = VOTE_DIMENSIONS 有定義的型別", () => {
  const m = mig.match(/contribution_type IN \(([\s\S]*?)\)/);
  assert(m, "migration 要有 contribution_type IN (...)");
  const inSql = new Set([...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
  const inTs = new Set(Object.keys(VOTE_DIMENSIONS).filter((k) => VOTE_DIMENSIONS[k].length > 0));
  for (const t of inTs) assert(inSql.has(t), `${t} 有風險維度但 SQL 候選沒列`);
  for (const t of inSql) assert(inTs.has(t), `SQL 候選列了 ${t} 但 VOTE_DIMENSIONS 沒定義，排程會白問`);
});
