import { assert, assertEquals } from "jsr:@std/assert@1";
import { consensusStatus, isDuplicateVote, isSelfVote, isValidAgentName, isValidAgentTool, requiredAgree, tally } from "./consensus.ts";
import { validateVerifyRequest } from "./contribution-schema.ts";

Deno.test("共識：2 agree、0 disagree → verified", () => {
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }]), "pending"), "verified");
  assertEquals(consensusStatus(tally([{ verdict: "agree" }]), "pending"), "pending", "只有 1 票不夠");
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }, { verdict: "unsure" }]), "pending"), "verified", "unsure 不影響");
});

Deno.test("共識：2 disagree → disputed；1 agree 1 disagree 維持 pending；verified 後被 2 disagree 翻成 disputed", () => {
  assertEquals(consensusStatus(tally([{ verdict: "disagree" }, { verdict: "disagree" }]), "pending"), "disputed");
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "disagree" }]), "pending"), "pending");
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }, { verdict: "disagree" }, { verdict: "disagree" }]), "verified"), "disputed");
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }]), "applied"), "applied", "維護者已處理的不受投票影響");
});

Deno.test("分級門檻：candidacy 2 票仍 pending、6 票才 verified", () => {
  const need = requiredAgree("candidacy", { candidate_status: "registered" });
  assertEquals(need, 6);
  const two = tally([{ verdict: "agree" }, { verdict: "agree" }]);
  assertEquals(consensusStatus(two, "pending", need), "pending", "加減參選人 2 票不夠");
  const six = tally(Array.from({ length: 6 }, () => ({ verdict: "agree" as const })));
  assertEquals(consensusStatus(six, "pending", need), "verified");
  assertEquals(consensusStatus(tally([...Array.from({ length: 6 }, () => ({ verdict: "agree" as const })), { verdict: "disagree" }]), "pending", need), "pending", "有 disagree 就不算");
});

Deno.test("分級門檻：correction 改 candidate_status 要 6 票，其他欄位與型別 2 票", () => {
  assertEquals(requiredAgree("correction", { field: "candidate_status" }), 6);
  assertEquals(requiredAgree("correction", { field: "birth_year" }), 2);
  assertEquals(requiredAgree("politician", {}), 2);
  assertEquals(requiredAgree("policy", {}), 2);
  assertEquals(requiredAgree("policy_progress", {}), 2);
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }]), "pending", requiredAgree("policy", {})), "verified");
});

Deno.test("不能驗自己提交的：agent_name 或 ip_hash 任一相同就擋", () => {
  const c = { agent_name: "xiaoliang", contributor_ip_hash: "ip-A" };
  assert(isSelfVote(c, { agent_name: "XiaoLiang", ip_hash: "ip-B" }), "同名（不分大小寫）");
  assert(isSelfVote(c, { agent_name: "someone", ip_hash: "ip-A" }), "同機");
  assert(!isSelfVote(c, { agent_name: "someone", ip_hash: "ip-B" }), "不同名不同機才可以");
});

Deno.test("同一筆同一 agent_name 重投被擋；同機不同名不算重投", () => {
  const existing = [{ agent_name: "gemini-tester" }];
  assert(isDuplicateVote(existing, { agent_name: "gemini-tester", ip_hash: "x" }));
  assert(!isDuplicateVote(existing, { agent_name: "gpt-tester", ip_hash: "x" }));
});

Deno.test("agent_name 格式：2～64 字、字母數字與 ._-（不含 @，模型名放 agent_tool）", () => {
  assert(isValidAgentName("xiaoliang"));
  assert(isValidAgentName("小牧_yooliang"));
  assert(!isValidAgentName("claude-code@xiaoliang"), "@ 不再允許");
  assert(isValidAgentTool("claude-code"));
  assert(isValidAgentTool("gpt-4o"));
  assert(!isValidAgentTool(""));
  assert(!isValidAgentName("a"));
  assert(!isValidAgentName("bad name with spaces"));
  assert(!isValidAgentName("x".repeat(65)));
});

Deno.test("verify 請求：disagree 必附 evidence_url（http(s)）；verdict 只能三選一", () => {
  const ok = validateVerifyRequest({ contribution_id: "5f0f2a2e-1c1e-4b3a-9d2c-0a1b2c3d4e5f", verdict: "agree", agent_name: "gemini-tester" });
  assertEquals(ok.errors, []);
  const noEvidence = validateVerifyRequest({ contribution_id: "5f0f2a2e-1c1e-4b3a-9d2c-0a1b2c3d4e5f", verdict: "disagree", agent_name: "gemini-tester", note: "來源寫的是 1967 不是 1966" });
  assert(noEvidence.errors.some((e) => e.path === "evidence_url"));
  const badVerdict = validateVerifyRequest({ contribution_id: "5f0f2a2e-1c1e-4b3a-9d2c-0a1b2c3d4e5f", verdict: "maybe", agent_name: "gemini-tester" });
  assert(badVerdict.errors.some((e) => e.path === "verdict"));
  const noAgent = validateVerifyRequest({ contribution_id: "5f0f2a2e-1c1e-4b3a-9d2c-0a1b2c3d4e5f", verdict: "agree" });
  assert(noAgent.errors.some((e) => e.path === "agent_name"));
});
