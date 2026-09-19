import { assertEquals } from "jsr:@std/assert@1";
import { isLostCampaignPromise } from "./policy-visibility.ts";
import { PolicyStatus } from "../types.ts";

// 2026-09-19：落選者的競選承諾只留在個人頁，首頁清單不再列
Deno.test("isLostCampaignPromise：競選承諾＋那場結果 not_elected 才算；查不到結果、當選、非承諾都不算", () => {
  const lost = { elections: [{ electionId: 2022, electionResult: "not_elected" as const }] };
  const won = { elections: [{ electionId: 2022, electionResult: "elected" as const }] };
  const unknown = { elections: [{ electionId: 2022 }] };
  const campaign2022 = { status: PolicyStatus.CAMPAIGN, electionId: 2022 };
  assertEquals(isLostCampaignPromise(campaign2022, lost as never), true);
  assertEquals(isLostCampaignPromise(campaign2022, won as never), false);
  assertEquals(isLostCampaignPromise(campaign2022, unknown as never), false);
  assertEquals(isLostCampaignPromise(campaign2022, undefined), false);
  assertEquals(isLostCampaignPromise({ status: PolicyStatus.CAMPAIGN, electionId: null as unknown as number }, lost as never), false, "沒標屆別不算");
  assertEquals(isLostCampaignPromise({ status: PolicyStatus.IN_PROGRESS, electionId: 2022 }, lost as never), false, "已在執行的不是承諾");
  assertEquals(isLostCampaignPromise({ status: PolicyStatus.CAMPAIGN, electionId: 2026 }, lost as never), false, "落選的是 2022 那場，2026 的承諾不受影響");
});
