// 門檻 = 型別風險 × 來源等級；計票依來源 IP 去重。SQL（migration 000013）與 TS（consensus.ts／source-priority.ts）必須一致
import { assert, assertEquals } from "jsr:@std/assert@1";
import { AGREE_THRESHOLDS, consensusStatus, isDuplicateVote, requiredAgree, riskLevel, tally, tallyByIp } from "./consensus.ts";
import { SOURCE_PRIORITY } from "./source-priority.ts";

/** 找最後一支（檔名排序最大）重新定義某個 SQL 物件的 migration，回傳從定義處起的內容 */
async function latestMigrationDefining(marker: string): Promise<string> {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    const at = sql.indexOf(marker);
    if (at >= 0) return sql.slice(at);
  }
  throw new Error(`找不到定義 ${marker} 的 migration`);
}

const OFFICIAL = "https://db.cec.gov.tw/ElecTable/Election/ElecTickets";
const MEDIA = "https://www.cna.com.tw/news/aipl/202609045002.aspx";
const SOCIAL = "https://www.facebook.com/candidate/posts/123";
const OTHER = "https://candidate-2026.tw/policy";

Deno.test("來源等級門檻：一般資料 官方 2／媒體 2／社群 3／其他 3", () => {
  assertEquals(requiredAgree("policy", {}, [OFFICIAL]), 2, "官方原本 1 票，但 1 票配上換機器就能規避的自我投票檢查等於單人可寫入");
  assertEquals(requiredAgree("policy", {}, [MEDIA]), 2);
  assertEquals(requiredAgree("policy", {}, [SOCIAL]), 3);
  assertEquals(requiredAgree("policy", {}, [OTHER]), 3);
  assertEquals(requiredAgree("policy", {}), 3, "沒給來源視為 other");
  assertEquals(consensusStatus(tally([{ verdict: "agree" }]), "pending", requiredAgree("policy", {}, [OFFICIAL])), "pending", "官方來源 1 票不再直接上線");
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }]), "pending", requiredAgree("policy", {}, [OFFICIAL])), "verified", "官方來源 2 票上線");
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }]), "pending", requiredAgree("policy", {}, [SOCIAL])), "pending", "社群來源 2 票不夠");
});

Deno.test("來源等級門檻：加減參選人 官方 4／媒體 6／社群與其他 8；correction 改 candidate_status 同級", () => {
  assertEquals(requiredAgree("candidacy", { candidate_status: "registered" }, [OFFICIAL]), 4);
  assertEquals(requiredAgree("candidacy", { candidate_status: "registered" }, [MEDIA]), 6);
  assertEquals(requiredAgree("candidacy", { candidate_status: "withdrawn" }, [SOCIAL]), 8);
  assertEquals(requiredAgree("candidacy", {}, [OTHER]), 8);
  assertEquals(requiredAgree("correction", { field: "candidate_status" }, [MEDIA]), 6);
  assertEquals(requiredAgree("correction", { field: "birth_year" }, [MEDIA]), 2, "一般欄位是一般資料");
  const need = requiredAgree("candidacy", {}, [MEDIA]);
  assertEquals(consensusStatus(tally(Array.from({ length: 6 }, () => ({ verdict: "agree" as const }))), "pending", need), "verified");
  assertEquals(consensusStatus(tally([...Array.from({ length: 6 }, () => ({ verdict: "agree" as const })), { verdict: "disagree" }]), "pending", need), "pending", "有 disagree 就不算");
});

Deno.test("來源等級門檻：task_suggestion／no_change 官方 1 其餘 2；adjudication 一律 4；多來源取最高等級", () => {
  assertEquals(requiredAgree("task_suggestion", {}, [OFFICIAL]), 1);
  assertEquals(requiredAgree("task_suggestion", {}, [SOCIAL]), 2);
  assertEquals(requiredAgree("no_change", {}, [OTHER]), 2);
  assertEquals(requiredAgree("adjudication", {}, [OFFICIAL]), 4);
  assertEquals(requiredAgree("adjudication", {}, [OTHER]), 4);
  assertEquals(requiredAgree("policy", {}, [OTHER, SOCIAL, MEDIA]), 2, "官方沒有、媒體有 → 媒體");
  assertEquals(requiredAgree("policy", {}, [OTHER, "https://www.ly.gov.tw/Pages/x"]), 2, "有一個官方就算官方");
  assertEquals(riskLevel("policy_progress", {}), "normal");
  assertEquals(riskLevel("candidacy", {}), "high");
});

Deno.test("question_answer 走一般資料門檻（沒有特例）：官方 2／媒體 2／社群 3／其他 3", () => {
  assertEquals(riskLevel("question_answer", {}), "normal");
  assertEquals(requiredAgree("question_answer", {}, [OFFICIAL]), 2);
  assertEquals(requiredAgree("question_answer", {}, [MEDIA]), 2);
  assertEquals(requiredAgree("question_answer", {}, [SOCIAL]), 3);
  assertEquals(requiredAgree("question_answer", {}, [OTHER]), 3);
});

Deno.test("SQL 與 TS 一致：網域清單與門檻矩陣等於 source-priority.ts 與 AGREE_THRESHOLDS；計票依來源 IP 去重", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20260912000009_zero_manual_points.sql", import.meta.url));
  const fn = sql.slice(sql.indexOf("FUNCTION contribution_source_kind"), sql.indexOf("FUNCTION contribution_required_agree"));
  const arrays = [...fn.matchAll(/ARRAY\[([^\]]+)\]/g)].map((m) => m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")));
  assertEquals(arrays.length, 3, "official／media／social 三組清單");
  const byKind = (kind: string) => SOURCE_PRIORITY.filter((s) => s.kind === kind).map((s) => s.host);
  assertEquals(arrays[0], byKind("official"));
  assertEquals(arrays[1], byKind("media"));
  assertEquals(arrays[2], byKind("social"));

  // 自己找「最後一支重新定義這個函式的 migration」。原本這裡寫死 000013，但函式後來在
  // 000015、000029 又各被改過一次，測試等於守著舊數字（2026-09-16 加 past_result 時發現）。
  const matrix = await latestMigrationDefining("FUNCTION contribution_required_agree");
  assert(matrix.includes(`p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb`), "多欄位 correction 含 candidate_status 也算高風險");
  const rowRe = /WHEN v_risk = '(\w+)' THEN CASE v_kind WHEN 'official' THEN (\d+) WHEN 'media' THEN (\d+) WHEN 'social' THEN (\d+) ELSE (\d+) END/g;
  const rows = Object.fromEntries([...matrix.matchAll(rowRe)].map((m) => [m[1], { official: +m[2], media: +m[3], social: +m[4], other: +m[5] }]));
  assertEquals(rows.normal, AGREE_THRESHOLDS.normal);
  assertEquals(rows.high, AGREE_THRESHOLDS.high);
  assertEquals(rows.light, AGREE_THRESHOLDS.light);
  assertEquals(rows.past_result, AGREE_THRESHOLDS.past_result, "補已投票選舉結果的門檻 SQL 與 TS 要一致");
  assertEquals(rows.removal, AGREE_THRESHOLDS.removal);
  assert(matrix.includes("p_payload->>'election_result' IN ('elected', 'not_elected')"), "SQL 也要認得「補選舉結果」這一類");
  // \s 而不是 \n：Windows 上 checkout 成 CRLF 時，寫死 \n 會抓不到，這支測試在本機一直紅
  const adj = matrix.match(/\s+ELSE (\d+)\s+END;/);
  assert(adj, "adjudication 走最後的 ELSE");
  assertEquals(+adj![1], AGREE_THRESHOLDS.adjudication.other);
  assert(new Set(Object.values(AGREE_THRESHOLDS.adjudication)).size === 1, "裁決不看來源");
  // 風險分級的判斷式也要對得上
  assert(matrix.includes("WHEN p_type = 'adjudication' THEN 'adjudication'"));
  assert(matrix.includes("WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR"));
  // roster_check 是 000029 加進 light 的；原本這裡寫死舊字串，指到最新 migration 後才露出來
  assert(matrix.includes("WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'"));
  assert(sql.includes("contribution_required_agree(contribution_type, payload, source_urls)"), "共識函式改用三參數");
});

Deno.test("同一個來源 IP 一筆貢獻只算一票：SQL 用 COUNT(DISTINCT verifier_ip_hash)，TS 的 tallyByIp 要一致", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20260912000013_distinct_ip_votes_and_official_two.sql", import.meta.url));
  const fn = sql.slice(sql.indexOf("FUNCTION contribution_apply_consensus"));
  assert(fn.includes("COUNT(DISTINCT verifier_ip_hash) FILTER (WHERE verdict = 'agree')"), "agree 依來源 IP 去重");
  assert(fn.includes("COUNT(DISTINCT verifier_ip_hash) FILTER (WHERE verdict = 'disagree')"), "disagree 也要去重，否則一個人就能把資料打成爭議");

  // 同一台機器換三個代號投同意 → 只算一票，過不了官方兩票的門檻
  const sameMachine = [
    { verdict: "agree" as const, verifier_ip_hash: "aaa" },
    { verdict: "agree" as const, verifier_ip_hash: "aaa" },
    { verdict: "agree" as const, verifier_ip_hash: "aaa" },
  ];
  assertEquals(tallyByIp(sameMachine).agree, 1);
  assertEquals(consensusStatus(tallyByIp(sameMachine), "pending", AGREE_THRESHOLDS.normal.official), "pending");

  // 兩台不同機器 → 兩票，達官方門檻
  const twoMachines = [
    { verdict: "agree" as const, verifier_ip_hash: "aaa" },
    { verdict: "agree" as const, verifier_ip_hash: "bbb" },
  ];
  assertEquals(tallyByIp(twoMachines).agree, 2);
  assertEquals(consensusStatus(tallyByIp(twoMachines), "pending", AGREE_THRESHOLDS.normal.official), "verified");

  // 同一台機器投反對也只算一票，湊不到爭議所需的兩票
  const sameMachineDisagree = [
    { verdict: "disagree" as const, verifier_ip_hash: "ccc" },
    { verdict: "disagree" as const, verifier_ip_hash: "ccc" },
  ];
  assertEquals(tallyByIp(sameMachineDisagree).disagree, 1);
  assertEquals(consensusStatus(tallyByIp(sameMachineDisagree), "pending", AGREE_THRESHOLDS.normal.official), "pending");

  // unsure 不影響狀態，維持總筆數
  assertEquals(tallyByIp([{ verdict: "unsure", verifier_ip_hash: "ddd" }, { verdict: "unsure", verifier_ip_hash: "ddd" }]).unsure, 2);
});

Deno.test("投票去重：同一筆貢獻，同代號或同來源 IP 都只能投一次", () => {
  const existing = [{ agent_name: "alice", verifier_ip_hash: "aaa" }];
  assert(isDuplicateVote(existing, { agent_name: "alice", ip_hash: "zzz" }), "同代號換機器不行");
  assert(isDuplicateVote(existing, { agent_name: "bob", ip_hash: "aaa" }), "同機器換代號也不行");
  assert(!isDuplicateVote(existing, { agent_name: "bob", ip_hash: "bbb" }), "不同人不同機器可以");
  assertEquals(isDuplicateVote([], { agent_name: "alice", ip_hash: "aaa" }), false);
});

Deno.test("補已投票選舉的結果只要 2 票，不看來源等級；沒帶 politician_id 仍是加減參選人", () => {
  // 小良哥 2026-09-16 指的那一筆：陳若翠 2024 高雄市立委，來源是維基＋中央社，原本要 6 票
  const pastResult = { politician_id: "a4ad066b-c02b-4046-84c9-889da17df8d5", election_id: 2024, election_result: "not_elected", votes_received: 64261, candidate_status: "confirmed" };
  assertEquals(riskLevel("candidacy", pastResult), "past_result");
  for (const src of [OFFICIAL, MEDIA, SOCIAL, OTHER]) assertEquals(requiredAgree("candidacy", pastResult, [src]), 2, `來源 ${src} 也該是 2 票`);
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }]), "pending", requiredAgree("candidacy", pastResult, [SOCIAL])), "verified");

  // 靠姓名新建的那條路會順手生出人物，維持高風險
  assertEquals(riskLevel("candidacy", { name: "某某", election_id: 2024, election_result: "elected" }), "high");
  // 還沒有結果的參選紀錄（登記、確認參選）也維持高風險
  assertEquals(riskLevel("candidacy", { politician_id: "a4ad066b-c02b-4046-84c9-889da17df8d5", candidate_status: "registered" }), "high");
});
