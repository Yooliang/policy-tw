import { assert, assertEquals } from "jsr:@std/assert@1";
import { safePayload, summarizeContribution } from "./contribution-summary.ts";

Deno.test("貢獻摘要：五種型別各一句人話＋目標連結", () => {
  const policy = summarizeContribution({ contribution_type: "policy", payload: { name: "陳素月", title: "長者健保全免" }, applied_policy_id: "p-1", applied_politician_id: "bcdfd014" });
  assertEquals(policy.summary, "為「陳素月」新增政見：長者健保全免");
  assertEquals(policy.policy_url, "https://policy-tw.web.app/policy/p-1");
  assertEquals(policy.politician_url, "https://policy-tw.web.app/politician/bcdfd014");

  const cand = summarizeContribution({ contribution_type: "candidacy", payload: { name: "徐千晴", election_id: 2026, region: "新竹市", election_type: "縣市議員", candidate_status: "registered" } });
  assertEquals(cand.summary, "將 徐千晴 2026 新竹市縣市議員參選狀態改為「已登記」");

  const corr = summarizeContribution({ contribution_type: "correction", payload: { target_table: "policies", target_id: "abcdef12-0000", field: "proposed_date", correct_value: "2024-04-02", reason: "…" } });
  assertEquals(corr.summary, "把政見 abcdef12 的提出日改為「2024-04-02」");
  assertEquals(corr.policy_url, "https://policy-tw.web.app/policy/abcdef12-0000");

  const prog = summarizeContribution({ contribution_type: "policy_progress", payload: { policy_id: "p-2", status: "In Progress", progress: 40, note: "已編列預算" } });
  assert(prog.summary.startsWith("更新「政見 p-2」進度為「進行中」（40%）"));

  const pol = summarizeContribution({ contribution_type: "politician", payload: { name: "王大明", birth_year: 1970, bio: "x".repeat(300) } });
  assertEquals(pol.summary, "為「王大明」補基本資料：出生年、簡介");
});

Deno.test("安全 payload：長文截 200 字", () => {
  const sp = safePayload({ bio: "很".repeat(500), tags: ["a"], n: 1 });
  assertEquals((sp.bio as string).length, 201);
  assertEquals(sp.n, 1);
});
