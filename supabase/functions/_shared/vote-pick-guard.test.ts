import { assert, assertEquals } from "jsr:@std/assert@1";
import { votePickProblem } from "./vote-pick-guard.ts";

Deno.test("非身份型別帶指認：擋", () => {
  assert(votePickProblem("correction", "560acdb8-adee-4569-9988-468d2b9f9b77"));
  assert(votePickProblem("no_change", "new"));
});

Deno.test("身份型別帶指認、或沒帶指認：不擋", () => {
  for (const t of ["politician", "candidacy", "policy"]) assertEquals(votePickProblem(t, "560acdb8-adee-4569-9988-468d2b9f9b77"), null);
  assertEquals(votePickProblem("correction", undefined), null);
  assertEquals(votePickProblem("correction", null), null);
});

Deno.test("verify-handler 有接上", async () => {
  const src = await Deno.readTextFile(new URL("./verify-handler.ts", import.meta.url));
  assert(src.includes("votePickProblem(contribution.contribution_type, input.resolved_politician_id)"));
});
