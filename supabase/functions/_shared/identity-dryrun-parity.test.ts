// 派工時的身份 dry-run 與落庫時的比對要用同一份正規化（2026-09-23 馮印才 8fa33531）：
// 派工說 new、identity_pick_required=false，落庫卻正規化後命中弱面向 → ambiguous → 「未指認」退件，兩張照規則投的票白投。
import { assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { fetchVerifyContext, shapeVerifyCurrent } from "./task-context.ts";
import { identityInputOf } from "./candidate-import.ts";
import { createSupabaseIdentityStore, resolvePolitician } from "./politician-identity.ts";

const P1 = "24835ca6-0000-4000-8000-000000000001";

Deno.test("政黨寫「無」：派工 dry-run 跟落庫比出同一個結論", async () => {
  const payload = { name: "馮印才", party: "無", region: "連江縣", election_type: "縣市議員", candidate_status: "registered", election_id: 2026 };
  const seed = {
    politicians: [{ id: P1, name: "馮印才", party: "無黨籍", region: "金門縣" }],
    politician_keys: [{ politician_id: P1, key_type: "party", key_value: "馮印才|無黨籍", strength: 1 }],
    politician_elections: [],
  };
  const fake = createFakeSupabase(seed);
  const atApply = await resolvePolitician(createSupabaseIdentityStore(fake.client), identityInputOf(payload), { persist: false });
  const ctx = await fetchVerifyContext(fake.client, "candidacy", payload);
  assertEquals(ctx.identity?.decision, atApply.decision, "派工與落庫的判定要一致");
  const current = shapeVerifyCurrent("candidacy", payload, ctx);
  assertEquals(current.identity_pick_required, atApply.decision === "ambiguous");
});

Deno.test("identityInputOf：政黨與選舉類型正規化、姓名去空白", () => {
  const i = identityInputOf({ name: " 馮印才 ", party: "無", election_type: "縣市議員" });
  assertEquals(i.name, "馮印才");
  assertEquals(i.party, "無黨籍");
});
