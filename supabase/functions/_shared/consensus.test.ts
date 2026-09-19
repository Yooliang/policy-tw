import { assert, assertEquals } from "jsr:@std/assert@1";
import { consensusStatus, isDuplicateVote, isSelfVote, isValidAgentName, isValidAgentTool, tally, isBlindDisagree } from "./consensus.ts";
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


Deno.test("不能驗自己提交的：agent_name 或 ip_hash 任一相同就擋", () => {
  const c = { agent_name: "xiaoliang", contributor_ip_hash: "ip-A" };
  assert(isSelfVote(c, { agent_name: "XiaoLiang", ip_hash: "ip-B" }), "同名（不分大小寫）");
  assert(isSelfVote(c, { agent_name: "someone", ip_hash: "ip-A" }), "同機");
  assert(!isSelfVote(c, { agent_name: "someone", ip_hash: "ip-B" }), "不同名不同機才可以");
});

Deno.test("舊票（沒記 IP 雜湊）退回比代號：同名重投被擋、不同名不算", () => {
  const existing = [{ agent_name: "gemini-tester" }];
  assert(isDuplicateVote(existing, { agent_name: "gemini-tester", ip_hash: "x" }));
  assert(!isDuplicateVote(existing, { agent_name: "gpt-tester", ip_hash: "x" }));
});

// 2026-09-19 裁決：身份是來源 IP。代號是自報的、可以共用；同一個代號在兩台機器是兩個人。
Deno.test("有記 IP 的票：同機換代號算重投；同代號換機器不算", () => {
  const existing = [{ agent_name: "gemini-tester", verifier_ip_hash: "ip-A" }];
  assert(isDuplicateVote(existing, { agent_name: "someone-else", ip_hash: "ip-A" }), "同機換代號");
  assert(!isDuplicateVote(existing, { agent_name: "gemini-tester", ip_hash: "ip-B" }), "同代號不同機＝兩個人");
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

// 2026-09-17 那版：達標但有 1 反對 → 爭議（避免懸空）。2026-09-19 改：一張反對不推翻達標的同意，直接通過；
// 「打不開來源」那種反對在 verify 端點就改記 unsure。沒有懸空：反對 ≥2 爭議、達標通過、其餘 pending。
Deno.test("同意達標而只有一張反對 → 通過，不進裁決", () => {
  assertEquals(consensusStatus({ agree: 2, disagree: 1, unsure: 0 }, "pending", 2), "verified");
  assertEquals(consensusStatus({ agree: 1, disagree: 1, unsure: 0 }, "pending", 1), "verified");
  assertEquals(consensusStatus({ agree: 4, disagree: 1, unsure: 1 }, "pending", 2), "verified", "卡伊．馬賴：4 agree 被一張「無法開啟 PDF」擋住的那種");
});

Deno.test("isBlindDisagree：打不開／確認不了是盲反對；寫了具體矛盾就不是", () => {
  assertEquals(isBlindDisagree("無法開啟來源PDF檔案以核對內容"), true);
  assertEquals(isBlindDisagree("來源無法確定，無法確認 election_id 的設定。"), true);
  assertEquals(isBlindDisagree("來源 www.pthg.gov.tw 在本執行環境無法連線：curl exit 7"), true);
  assertEquals(isBlindDisagree("HTTP 403，web.archive.org 也沒有存檔"), true);
  assertEquals(isBlindDisagree("中選會候選人資料出生年是 1967，不是 payload 的 1966"), false);
  assertEquals(isBlindDisagree("來源打不開，但改查中選會資料庫：登記的是第 6 選區，與 payload 第 7 選區不符"), false, "有具體矛盾就算反證");
  assertEquals(isBlindDisagree("出生年與學歷經金門日報《藝文沙龍》黃世團小檔案（2023/06/17：1951年生，師大美術系）核對，來源無法確認學歷"), false, "引了別的來源與數字＝有反證");
  assertEquals(isBlindDisagree("source_url 只是風傳媒首頁，非特定報導，頁面沒有任何東螺溪內容，無法核對 payload 的 7.66 億元"), false, "來源沒提到＝實質反對");
  assertEquals(isBlindDisagree("提交的 source_url 打不開：實際 GET https://bulletin.cec.gov.tw/… 回 404"), true);
  assertEquals(isBlindDisagree(""), false);
  assertEquals(isBlindDisagree(null), false);
});

Deno.test("同意還沒達標時的一張反對維持 pending（等更多票，不急著裁決）", () => {
  assertEquals(consensusStatus({ agree: 1, disagree: 1, unsure: 0 }, "pending", 2), "pending");
  assertEquals(consensusStatus({ agree: 2, disagree: 0, unsure: 0 }, "pending", 2), "verified");
  assertEquals(consensusStatus({ agree: 0, disagree: 2, unsure: 0 }, "pending", 2), "disputed");
});
