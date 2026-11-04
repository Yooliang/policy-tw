import { assert, assertEquals } from "jsr:@std/assert@1";
import { consensusStatus, isDuplicateVote, isSelfVote, isValidAgentName, isValidAgentTool, tally, tallyByVoter, voterKey, needsTwoIps, scoreStatus, isBlindDisagree } from "./consensus.ts";
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


// 2026-11-04（維護者：投票不看 IP）：投票人的鍵＝DiTrust 帳號按 actor_id、匿名按小寫代號；來源網段不參與。
Deno.test("不能驗自己提交的：只看代號（不分大小寫）與 DiTrust actor_id，不看 IP", () => {
  const c = { agent_name: "xiaoliang", contributor_ip_hash: "ip-A" };
  assert(isSelfVote(c, { agent_name: "XiaoLiang", ip_hash: "ip-B" }), "同名（不分大小寫）");
  assert(!isSelfVote(c, { agent_name: "someone", ip_hash: "ip-A" }), "同機不同代號＝不是自己");
  assert(!isSelfVote(c, { agent_name: "someone", ip_hash: "ip-B" }), "不同名不同機當然可以");
  const d = { agent_name: "alice", contributor_ip_hash: "ip-A", actor_id: "ditrust:u1" };
  assert(isSelfVote(d, { agent_name: "alice-2", actor_id: "ditrust:u1" }), "DiTrust 同帳號換代號仍是自己");
  assert(!isSelfVote(d, { agent_name: "alice-2", actor_id: "ditrust:u2" }), "不同帳號不同代號不是自己");
  assert(!isSelfVote({ agent_name: "a", contributor_ip_hash: "x", actor_id: "ip-net-1" }, { agent_name: "b", actor_id: "ip-net-1" }), "匿名的 actor_id 是網段雜湊，不當身份");
});

Deno.test("voterKey：DiTrust＝actor_id、匿名＝小寫代號；DiTrust 與同名匿名分開", () => {
  assertEquals(voterKey({ agent_name: "Alice", actor_id: "ditrust:u1" }), "ditrust:u1");
  assertEquals(voterKey({ agent_name: "Alice", actor_id: "net-hash" }), "alice");
  assertEquals(voterKey({ agent_name: "Alice" }), "alice");
  assert(voterKey({ agent_name: "alice", actor_id: "ditrust:u1" }) !== voterKey({ agent_name: "alice" }), "同顯示名的 DiTrust 與匿名不同鍵");
});

Deno.test("重複投票：同代號（不分 IP）重投算重複；同 IP 不同代號不算；DiTrust 同 actor_id 換代號算重複", () => {
  const existing = [{ agent_name: "gemini-tester", verifier_ip_hash: "ip-A" }];
  assert(isDuplicateVote(existing, { agent_name: "Gemini-Tester", ip_hash: "ip-B" }), "同代號換機器＝同一個投票人");
  assert(!isDuplicateVote(existing, { agent_name: "someone-else", ip_hash: "ip-A" }), "同機換代號＝另一票");
  const old = [{ agent_name: "gemini-tester" }];
  assert(isDuplicateVote(old, { agent_name: "gemini-tester", ip_hash: "x" }));
  assert(!isDuplicateVote(old, { agent_name: "gpt-tester", ip_hash: "x" }));
  const dt = [{ agent_name: "alice", actor_id: "ditrust:u1", verifier_ip_hash: "ip-A" }];
  assert(isDuplicateVote(dt, { agent_name: "alice-new-handle", actor_id: "ditrust:u1" }), "同帳號換代號仍重複");
  assert(!isDuplicateVote(dt, { agent_name: "alice" }), "同顯示名的匿名＝不同鍵，不算重複");
  assert(!isDuplicateVote(dt, { agent_name: "alice", actor_id: "ditrust:u2" }), "另一個 DiTrust 帳號不算");
});

Deno.test("tallyByVoter：同一個投票人多張只算一張；同 IP 不同代號各算一張；unsure 算總筆數", () => {
  const c = tallyByVoter([
    { verdict: "agree", agent_name: "a" }, { verdict: "agree", agent_name: "A" },
    { verdict: "agree", agent_name: "b" }, { verdict: "disagree", agent_name: "c" },
    { verdict: "unsure", agent_name: "d" }, { verdict: "unsure", agent_name: "d" },
  ]);
  assertEquals(c, { agree: 2, disagree: 1, unsure: 2 });
});

Deno.test("needsTwoIps 全部型別恆為 false；scoreStatus 單一投票人分數到了就 verified（含高風險型別）", () => {
  for (const t of ["candidacy", "merge_politician", "removal", "reassign_candidacy", "correction", "lineage_handover", "politician", "no_change"]) {
    assertEquals(needsTwoIps(t, { handover_type: "abort", new_status: "withdrawn" }), false, t);
    assertEquals(scoreStatus({ score: 2, target: 2, distinctIps: 1, contributionType: t, current: "pending" }), "verified", t);
    assertEquals(scoreStatus({ score: 1, target: 2, distinctIps: 5, contributionType: t, current: "pending" }), "pending", t);
  }
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

  // 2026-09-21 現場：澎湖那批 19 筆 candidacy 共用一個已 404 的 udn 網址，四票寫「來源不存在…HTTP 404…
  // 查無快照」卻被記成真反對——CONTRADICTION_RE 的「不存在」「查無」本來要抓「這個人不存在」，撞在一起了。
  // 判準改成結構的：「讀不到」與「讀到了但內容不符」不可能同時成立。
  const DEAD = "https://udn.com/news/story/7326/8197777";
  const unreachable = "來源不存在：以瀏覽器 User-Agent 開啟 " + DEAD + " 一律回 HTTP 404，web.archive.org 查無快照。來源無法支持此筆宣稱，故反對。";
  assertEquals(isBlindDisagree(unreachable), false, "只看文字會漏：「不存在」「查無」讓它看起來像有反證");
  assertEquals(
    isBlindDisagree(unreachable, { evidenceUrl: DEAD, sourceUrls: [DEAD] }),
    true,
    "反證網址就是那個拿不到的來源＝沒有第二來源，只能是 unsure",
  );
  assertEquals(
    isBlindDisagree("提交來源 " + DEAD + " 已 404，改核官方名單：選委會彙總表載明政黨為中國國民黨，與 payload 的無黨籍不符", {
      evidenceUrl: "https://web.cec.gov.tw/phec/article/64633",
      sourceUrls: [DEAD],
    }),
    false,
    "真的找了第二來源（官方名單）並指出矛盾＝正當的反對，不可以改記 unsure",
  );
  assertEquals(
    isBlindDisagree("打不開", { evidenceUrl: "HTTPS://WWW.UDN.COM/news/story/7326/8197777/", sourceUrls: [DEAD] }),
    true,
    "同一頁的大小寫、www、尾斜線差異要算同一個",
  );
  assertEquals(isBlindDisagree("提交的 source_url 打不開：實際 GET https://bulletin.cec.gov.tw/… 回 404"), true);
  assertEquals(isBlindDisagree(""), false);
  assertEquals(isBlindDisagree(null), false);
});

Deno.test("同意還沒達標時的一張反對維持 pending（等更多票，不急著裁決）", () => {
  assertEquals(consensusStatus({ agree: 1, disagree: 1, unsure: 0 }, "pending", 2), "pending");
  assertEquals(consensusStatus({ agree: 2, disagree: 0, unsure: 0 }, "pending", 2), "verified");
  assertEquals(consensusStatus({ agree: 0, disagree: 2, unsure: 0 }, "pending", 2), "disputed");
});
