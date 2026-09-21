import { assert, assertEquals } from "jsr:@std/assert";
import { candidateReasons, shapeVerifyCurrent, shapeVotes, sourceHintsFor } from "./task-context.ts";
import { isCopiedNote } from "./consensus.ts";

// 2026-09-21 #4／#7／#8：把系統已經有的資訊送到代理手上——按網域的查證提示、既有票的理由、候選人為什麼被列進來。

Deno.test("source_hints：中選會登記頁提示名單在 PDF 附件、cna 提示要帶 UA；一般網域沒提示", () => {
  const hints = sourceHintsFor(["https://web.cec.gov.tw/central/article/64709", "https://www.cna.com.tw/news/aipl/1.aspx", "https://example.org/x"]);
  assertEquals(hints.length, 2);
  assert(hints[0].hint.includes("PDF"), hints[0].hint);
  assert(hints[0].hint.includes("-layout"), "要講不要用 -layout");
  assert(hints[1].hint.includes("User-Agent"));
  assertEquals(sourceHintsFor(["not a url"]), []);
  assertEquals(sourceHintsFor(null), []);
});

Deno.test("既有票公開但去識別：留 verdict／分數／理由／反證／時間，不留代號與 IP", () => {
  const out = shapeVotes([
    { verdict: "disagree", weight: -1, note: "來源第 3 頁沒有這一列", evidence_url: "https://db.cec.gov.tw/x", created_at: "2026-09-21T10:00:00Z", agent_name: "someone", verifier_ip_hash: "ip" } as never,
    { verdict: "agree", weight: 1, note: "", evidence_url: null, created_at: null },
  ]);
  assertEquals(out.length, 2);
  assertEquals(out[0].verdict, "disagree");
  assertEquals(out[0].weight, -1);
  assertEquals(out[0].evidence_url, "https://db.cec.gov.tw/x");
  assertEquals("agent_name" in out[0], false);
  assertEquals("verifier_ip_hash" in out[0], false);
  assertEquals("note" in out[1], false, "空理由不印空字串");
});

Deno.test("shapeVerifyCurrent：有既有票就附 votes、有已知網域就附 source_hints；沒有就不附", () => {
  const payload = { name: "陳麒翔", region: "金門縣", election_type: "縣市議員", birth_year: 1980 };
  const withAll = shapeVerifyCurrent("candidacy", payload, {
    politicians: [{ id: "p1", name: "陳麒翔", region: "台中市", birth_year: 1971, current_position: "霧峰區甲寅里里長" }],
    elections: [{ politician_id: "p1", election_id: 2022, election_type: "村里長", candidate_status: "elected" }],
    votes: [{ verdict: "agree", weight: 1, note: "查了" }],
    source_urls: ["https://web.cec.gov.tw/central/article/1"],
    score: 1, target_score: 3,
  });
  assert(Array.isArray(withAll.votes) && (withAll.votes as unknown[]).length === 1);
  assert(Array.isArray(withAll.source_hints) && (withAll.source_hints as unknown[]).length === 1);
  const cands = withAll.identity_candidates as Array<{ why: string[] }>;
  assert(cands[0].why.includes("同名"));
  assert(cands[0].why.some((w) => w.startsWith("出生年不同")), cands[0].why.join("｜"));
  assert(cands[0].why.some((w) => w.startsWith("縣市不同")), "縣市不同要講、而且要提醒清單的縣市可能標錯");
  assert(cands[0].why.some((w) => w.includes("現職")));
  const bare = shapeVerifyCurrent("policy", { title: "x" }, { politicians: [], policies: [] });
  assertEquals("votes" in bare, false);
  assertEquals("source_hints" in bare, false);
});

Deno.test("candidateReasons：同出生年＋同縣市＋同型別紀錄都要講出來（金門那批若有帶，代理就不會用地理常識否決本人）", () => {
  const why = candidateReasons(
    { id: "c1", name: "董森堡", region: "連江縣", birth_year: 1978, party: "無黨籍" },
    { name: "董森堡", region: "金門縣", birth_year: 1978, party: "無黨籍", election_type: "縣市議員" },
    [{ politician_id: "c1", election_id: 2022, election_type: "縣市議員", candidate_status: "elected" }],
  );
  assert(why.includes("同名"));
  assert(why.includes("同出生年 1978"));
  assert(why.some((w) => w.includes("2022 縣市議員（elected）")), why.join("｜"));
  assert(why.some((w) => w.includes("以中選會 API 為準")));
});

Deno.test("isCopiedNote：一字不差且沒引文才算抄；帶數字／引號的放行；同型不同列不算", () => {
  const existing = ["打開來源逐欄核對，都對得上", "第 1633 行「金門縣第1選舉區 林鑫一」對得上"];
  assertEquals(isCopiedNote("打開來源逐欄核對，都對得上。", existing), true, "只差標點");
  assertEquals(isCopiedNote("第 1647 行「金門縣第1選舉區 洪允典」對得上", existing), false, "有自己的行號與引句");
  assertEquals(isCopiedNote("打開來源逐欄核對，欄位都對得上", existing), false, "不是一字不差就不擋——相似度會誤傷同一份名冊的不同列");
  assertEquals(isCopiedNote("", existing), false);
});
