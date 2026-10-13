import { assert, assertEquals } from "jsr:@std/assert@1";
import { inOfficePolicyFutureElectionProblem } from "./policy-term-guard.ts";
import { validateContributionRequest } from "./contribution-schema.ts";

const E2022 = { id: 2022, election_key: "2022-11-26_local", election_date: "2022-11-26" };
const E2026 = { id: 2026, election_key: "2026-11-28_local", election_date: "2026-11-28" };

Deno.test("任內施政承諾掛在還沒投票的選舉：擋", () => {
  assert(inOfficePolicyFutureElectionProblem("In Progress", E2026, "2026-10-13"));
  assert(inOfficePolicyFutureElectionProblem("Proposed", E2026, "2026-11-27"));
});

Deno.test("競選承諾、已投票的選舉、投票當天、不認得的選舉：不擋", () => {
  assertEquals(inOfficePolicyFutureElectionProblem("Campaign Pledge", E2026, "2026-10-13"), null);
  assertEquals(inOfficePolicyFutureElectionProblem(undefined, E2026, "2026-10-13"), null);
  assertEquals(inOfficePolicyFutureElectionProblem(null, E2026, "2026-10-13"), null);
  assertEquals(inOfficePolicyFutureElectionProblem("In Progress", E2022, "2026-10-13"), null);
  assertEquals(inOfficePolicyFutureElectionProblem("In Progress", E2026, "2026-11-28"), null);
  assertEquals(inOfficePolicyFutureElectionProblem("In Progress", undefined, "2026-10-13"), null);
});

Deno.test("policy 交件：status 非競選承諾＋未來的選舉回 400 欄位錯誤", () => {
  const future = { id: 9999, election_key: "2999-11-28_local", election_date: "2999-11-28" };
  const body = (status: string, election_id: number) => ({
    agent_name: "tester",
    contribution_type: "policy",
    payload: { name: "王小明", title: "營養午餐全面免費", description: "自下學年起公私立國中小營養午餐全面免費，市府每年編列預算。", category: "教育文化", status, election_id },
    source_urls: ["https://www.gov.taipei/News_Content.aspx?n=1"],
  });
  const bad = validateContributionRequest(body("In Progress", 9999), [E2022, future]);
  assert(!bad.ok);
  assert(bad.errors.some((e) => e.path === "payload.election_id"));
  const pledge = validateContributionRequest(body("Campaign Pledge", 9999), [E2022, future]);
  assert(!pledge.ok ? !pledge.errors.some((e) => e.path === "payload.election_id") : true);
  const past = validateContributionRequest(body("In Progress", 2022), [E2022, future]);
  assert(!past.ok ? !past.errors.some((e) => e.path === "payload.election_id") : true);
});
