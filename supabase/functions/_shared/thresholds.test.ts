// 門檻 = 型別風險 × 來源等級；計票依來源 IP 去重。SQL（migration 000013）與 TS（consensus.ts／source-priority.ts）必須一致
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CONTRIBUTION_TYPES } from "./contribution-schema.ts";
import { AGREE_THRESHOLDS, consensusStatus, effectiveRequiredAgree, isDuplicateVote, requiredAgree, riskLevel, SYSTEM_VOTE_ELIGIBLE_TYPES, tally, tallyByIp } from "./consensus.ts";
import { SOURCE_PRIORITY, sourceKind } from "./source-priority.ts";

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
  // 2026-09-20：傳聞參選改成登記／不參選是一般級（2 票），登記→不參選才是加減參選人
  assertEquals(requiredAgree("correction", { changes: [{ field: "candidate_status", current_value: "rumored", correct_value: "registered" }] }, [OFFICIAL]), 2);
  assertEquals(requiredAgree("correction", { changes: [{ field: "candidate_status", current_value: "likely", correct_value: "not_running" }] }, [MEDIA]), 2);
  assertEquals(requiredAgree("correction", { changes: [{ field: "candidate_status", current_value: "registered", correct_value: "not_running" }] }, [OFFICIAL]), 4);
  assertEquals(requiredAgree("correction", { changes: [{ field: "candidate_status", current_value: "rumored", correct_value: "registered" }, { field: "candidate_status", current_value: "confirmed", correct_value: "not_running" }] }, [OFFICIAL]), 4, "混著一筆真的加減就走高風險");
  assertEquals(requiredAgree("correction", { field: "birth_year" }, [MEDIA]), 2, "一般欄位是一般資料");
  const need = requiredAgree("candidacy", {}, [MEDIA]);
  assertEquals(consensusStatus(tally(Array.from({ length: 6 }, () => ({ verdict: "agree" as const }))), "pending", need), "verified");
  // 2026-09-19 改：達標而只有一張反對 → 通過（盲反對在 verify 端點改記 unsure；兩張反對才是爭議）
  assertEquals(consensusStatus(tally([...Array.from({ length: 6 }, () => ({ verdict: "agree" as const })), { verdict: "disagree" }]), "pending", need), "verified", "達標＋一張反對＝通過");
  assertEquals(consensusStatus(tally([...Array.from({ length: 6 }, () => ({ verdict: "agree" as const })), { verdict: "disagree" }, { verdict: "disagree" }]), "pending", need), "disputed", "兩張反對才是爭議");
});

Deno.test("來源等級門檻：task_suggestion／no_change 官方 1 其餘 2；adjudication 一律 3（2026-09-21 從 4 降）；多來源取最高等級", () => {
  assertEquals(requiredAgree("task_suggestion", {}, [OFFICIAL]), 1);
  assertEquals(requiredAgree("task_suggestion", {}, [SOCIAL]), 2);
  assertEquals(requiredAgree("no_change", {}, [OTHER]), 2);
  assertEquals(requiredAgree("adjudication", {}, [OFFICIAL]), 3, "2026-09-21：裁決線太久沒人投，4 票降 3 票");
  assertEquals(requiredAgree("adjudication", {}, [OTHER]), 3);
  assertEquals(requiredAgree("policy", {}, [OTHER, SOCIAL, MEDIA]), 2, "官方沒有、媒體有 → 媒體");
  assertEquals(requiredAgree("policy", {}, [OTHER, "https://www.ly.gov.tw/Pages/x"]), 2, "有一個官方就算官方");
  assertEquals(riskLevel("policy_progress", {}), "normal");
  assertEquals(riskLevel("merge_politician", { same_person: true }), "high", "同名合併走 high：誤併沒有便宜的回頭路（2026-09-20）");
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
  assert(matrix.includes("WHEN p_type = 'merge_politician' THEN 'high'"), "SQL 也要把同名合併算成 high 級");
  assert(matrix.includes("correction_only_from_rumor(p_payload)"), "SQL 也要把「傳聞→登記／不參選」算成一般級");
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

// 2026-09-19 裁決：投票身份是來源 IP，不是代號。代號自報、可共用；同代號在兩台機器是兩個人。
// 原本是「同代號或同 IP 都擋」，同代號換機器會被當重投——那會擋掉共用代號的另一個人。
Deno.test("投票去重：同一筆貢獻，同一個來源 IP 只能投一次；代號不是身份", () => {
  const existing = [{ agent_name: "alice", verifier_ip_hash: "aaa" }];
  assert(!isDuplicateVote(existing, { agent_name: "alice", ip_hash: "zzz" }), "同代號換機器＝另一個人，可以");
  assert(isDuplicateVote(existing, { agent_name: "bob", ip_hash: "aaa" }), "同機器換代號不行");
  assert(!isDuplicateVote(existing, { agent_name: "bob", ip_hash: "bbb" }), "不同人不同機器可以");
  assertEquals(isDuplicateVote([], { agent_name: "alice", ip_hash: "aaa" }), false);
});

Deno.test("補已投票選舉的結果只要 2 票，不看來源等級；沒帶 politician_id 仍是加減參選人", () => {
  // 2026-09-16 指出的那一筆：陳若翠 2024 高雄市立委，來源是維基＋中央社，原本要 6 票
  const pastResult = { politician_id: "a4ad066b-c02b-4046-84c9-889da17df8d5", election_id: 2024, election_result: "not_elected", votes_received: 64261, candidate_status: "confirmed" };
  assertEquals(riskLevel("candidacy", pastResult), "past_result");
  for (const src of [OFFICIAL, MEDIA, SOCIAL, OTHER]) assertEquals(requiredAgree("candidacy", pastResult, [src]), 2, `來源 ${src} 也該是 2 票`);
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }]), "pending", requiredAgree("candidacy", pastResult, [SOCIAL])), "verified");

  // 靠姓名新建的那條路會順手生出人物，維持高風險
  assertEquals(riskLevel("candidacy", { name: "某某", election_id: 2024, election_result: "elected" }), "high");
  // 還沒有結果的參選紀錄（登記、確認參選）也維持高風險
  assertEquals(riskLevel("candidacy", { politician_id: "a4ad066b-c02b-4046-84c9-889da17df8d5", candidate_status: "registered" }), "high");
});

// 2026-09-17：來源只給首頁的有 46 筆，6 筆已吵成爭議——首頁上看不到那筆事實，
// 卻跟公報的實際那一頁拿到一樣的官方等級、一樣只要 2 票。
Deno.test("只有網域的首頁降到最低等級，具體那一頁才算官方", () => {
  assertEquals(sourceKind("https://bulletin.cec.gov.tw/"), "other");
  assertEquals(sourceKind("https://db.cec.gov.tw"), "other");
  assertEquals(sourceKind("https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1"), "official");
  assertEquals(sourceKind("https://www.cna.com.tw/"), "other");
  assertEquals(sourceKind("https://www.cna.com.tw/news/aipl/202609045002.aspx"), "media");
  // 門檻跟著變：一般資料官方 2 票，降成 other 要 3 票
  assertEquals(requiredAgree("policy", {}, ["https://bulletin.cec.gov.tw/"]), 3);
  assertEquals(requiredAgree("policy", {}, ["https://bulletin.cec.gov.tw/?dir=x"]), 2);
});

// ---- 系統來源票（Jev）：4 票變 3+1，2026-09-19 使用者裁決 ----

Deno.test("系統票：supported 讓門檻 −1 但最少 1；not_supported 讓門檻 +1 不算反對；棄權不動", () => {
  assertEquals(effectiveRequiredAgree(4, "supported"), 3, "4 → 3+1");
  assertEquals(effectiveRequiredAgree(2, "supported"), 1, "2 → 1+1");
  assertEquals(effectiveRequiredAgree(1, "supported"), 1, "Jev 永遠不能單獨通過");
  assertEquals(effectiveRequiredAgree(4, null), 4);
  assertEquals(effectiveRequiredAgree(4, "not_supported"), 5, "2026-09-19：not_supported 只多要一張人票，不觸發裁決");
  // 卡伊．馬賴：4 agree、1 盲反對（已改記 unsure）、系統票 not_supported → 門檻 2+1=3 → 通過，不進裁決
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }, { verdict: "agree" }, { verdict: "agree" }, { verdict: "unsure" }]), "pending", effectiveRequiredAgree(2, "not_supported")), "verified");
  // 走一次完整判定：4 票門檻、Jev supported、3 張代理 agree → verified
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }, { verdict: "agree" }]), "pending", effectiveRequiredAgree(4, "supported")), "verified");
  assertEquals(consensusStatus(tally([{ verdict: "agree" }, { verdict: "agree" }, { verdict: "agree" }]), "pending", effectiveRequiredAgree(4, null)), "pending");
});

Deno.test("SQL 與 TS 一致：系統票的形狀、合格型別、與 −1 最少 1 的規則都在計票函式裡", async () => {
  const fn = await latestMigrationDefining("FUNCTION contribution_apply_consensus");
  assert(fn.includes("contribution_effective_agree(p_contribution_id)"), "計票要用有效門檻那一支函式");
  assert(!fn.includes("v_disagree_eff"), "系統票不再混進反對數");
  // 有效門檻只有一份：supported −1（最少 1）、not_supported +1；派工池也要用它（2026-09-20 審查建議 1）
  const eff = await latestMigrationDefining("FUNCTION contribution_effective_agree");
  assert(eff.includes("contribution_system_vote(p_contribution_id)"), "有效門檻要讀系統票");
  assert(eff.includes("GREATEST(1, v_need - 1)"), "supported → 門檻 −1 且最少 1");
  assert(eff.includes("WHEN v_sys = 'not_supported' THEN v_need + 1"), "not_supported → 門檻 +1，不算反對");
  const pool = await latestMigrationDefining("FUNCTION contribution_verify_pool");
  // 2026-09-21 分數制：達標判斷看 score，不看 agree_count；目標仍是有效門檻那一支函式
  assert(pool.includes("c.score < contribution_effective_agree(c.id)"), "派工池要用分數對有效門檻，否則 not_supported 的那筆永久卡住");
  assert(pool.includes("effective_required"), "池子要把有效門檻回給 /next");
  assert(pool.includes("target_score"), "池子要把目標分數回給 /next（代理要知道自己這票能推多遠）");
  // 裁決退場：兩張反對不再變 disputed，跌到 −目標直接退件
  assert(!fn.includes("v_new := 'disputed'"), "分數制不再產生 disputed");
  assert(fn.includes("IF v_score <= -v_target THEN"), "跌到 −目標 → rejected");
  assert(fn.includes("v_score >= v_target"), "達到目標 → verified");
  assert(fn.includes("score = v_score"), "累計分數要寫回 contributions.score");
  assert(fn.includes("agree_count = v_agree"), "agree_count 仍是純代理票，系統票不混進去");
  const elig = await latestMigrationDefining("FUNCTION system_vote_eligible");
  for (const t of SYSTEM_VOTE_ELIGIBLE_TYPES) assert(elig.includes(`'${t}'`), `SQL 合格型別缺 ${t}`);
  assert(!elig.includes("'adjudication'") && !elig.includes("'removal'") && !elig.includes("'no_change'"), "沒有來源可核的型別不能有系統票");
});

// 2026-09-21：裁決線是死的（87 份等票平均 0.1 票）。驗證池的順序是「訪客觸發 > 裁決 > 其餘最早」，
// SQL 的 ORDER BY 跟 next/index.ts 的 serveVerify 是同一套規則的兩份寫法，改一邊沒改另一邊就會各派各的。
Deno.test("SQL 與 TS 一致：驗證池順序是訪客觸發 > 裁決（限三分之一）> 其餘最早，且合格判斷在 LIMIT 之前", async () => {
  const pool = await latestMigrationDefining("FUNCTION contribution_verify_pool");
  // 2026-09-21 起優先序在 bucket（0 訪客觸發／1 裁決／2 其餘），ORDER BY 只排 bucket 與時間。
  const bucket = pool.match(/CASE WHEN [\w.]*visitor_facing THEN 0 WHEN [\w.]*adjudication_facing THEN 1 ELSE 2 END AS bucket/);
  assert(bucket, "優先序要是 bucket：訪客觸發 0、裁決 1、其餘 2");
  assert(/ORDER BY [\w.]*bucket ASC, [\w.]*created_at ASC/.test(pool), "先照 bucket 再照提交時間");
  assert(pool.includes("adjudication_facing"), "池子要把裁決旗標回給 /next");
  // 2026-09-21：#119 讓 86 筆裁決塞滿 p_limit=30 的窗口，TS 在 LIMIT 之後才篩掉不合格的，
  // candidates 趨近 0、/next 只派任務。合格判斷要在 SQL、LIMIT 之前（#102–#105 已裁過的反模式）。
  assert(
    pool.includes("v2.verifier_ip_hash = p_ip_hash"),
    "裁決的合格判斷要在 SQL 裡：對原貢獻投過票的人不該拿到那筆裁決",
  );
  assert(
    pool.includes("o.contributor_ip_hash = p_ip_hash"),
    "裁決的合格判斷要在 SQL 裡：原貢獻的提交者不該拿到那筆裁決",
  );
  assert(
    /r\.bucket <> 1 OR r\.rn <= GREATEST\(1, COALESCE\(p_limit, 30\) \/ 3\)/.test(pool),
    "裁決最多佔窗口三分之一，否則它會排擠掉其他型別的驗證",
  );

  const serve = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  const at = serve.indexOf("const serveVerify");
  assert(at > 0, "找不到 serveVerify");
  const body = serve.slice(at, at + 1500);
  assert(body.includes(`c.contribution_type === "adjudication"`), "serveVerify 也要把裁決排第二順位");
  assert(
    body.indexOf("visitorFirst.length > 0") < body.indexOf("adjudicationsNext.length > 0"),
    "訪客觸發仍排在裁決前面",
  );
});

// 2026-09-20：merge_politician 進了 TS 清單、沒進 DB 的 CHECK，代理交了整天都被擋——兩份真相要一起改
Deno.test("contributions.contribution_type 的 CHECK 要包含 TS 的每一種型別", async () => {
  const sql = await latestMigrationDefining("CONSTRAINT contributions_contribution_type_check");
  for (const t of CONTRIBUTION_TYPES) assert(sql.includes(`'${t}'`), `DB 的 CHECK 少了型別 ${t}：加 migration 重建約束`);
});
