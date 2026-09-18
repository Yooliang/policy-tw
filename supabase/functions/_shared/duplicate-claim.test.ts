import { assert, assertEquals } from "jsr:@std/assert@1";
import { claimKey, claimTarget, DUPLICATE_ELIGIBLE_TYPES, type ExistingClaim, findMergeTarget, sameClaim } from "./duplicate-claim.ts";

// 案例取自 2026-09-18 線上 1,207 筆 pending 的實測配對
const P1 = "98b8b1ff-d085-4597-8384-a02461f773f6";

Deno.test("correction：同一列、同一組欄位→新值＝同一個宣稱，理由不同不影響", () => {
  // lampstand 與 a-zhen 各交一份「林子宇 2026 縣市議員參選狀態改為已登記」
  const a = { contribution_type: "correction", payload: { target_table: "politician_elections", target_id: "9827", changes: [{ field: "candidate_status", correct_value: "registered" }], reason: "中選會登記名冊有這一筆" } };
  const b = { contribution_type: "correction", payload: { target_table: "politician_elections", target_id: "9827", changes: [{ field: "candidate_status", correct_value: "registered" }], reason: "自由時報 2026-09-04 報導已完成登記" } };
  assert(sameClaim(a, b), "理由寫得不一樣，主張是同一個");

  // 值不同就是不同宣稱
  const c = { ...b, payload: { ...b.payload, changes: [{ field: "candidate_status", correct_value: "not_running" }] } };
  assert(!sameClaim(a, c), "改成不同的值＝不同宣稱");
  // 欄位不同也是
  const d = { ...b, payload: { ...b.payload, changes: [{ field: "election_id", correct_value: "registered" }] } };
  assert(!sameClaim(a, d));
});

Deno.test("correction：單一欄位寫法與 changes 陣列寫法要收斂成同一個鍵；多欄位順序不影響", () => {
  const arr = { contribution_type: "correction", payload: { target_table: "policies", target_id: "p1", changes: [{ field: "election_id", correct_value: "2024" }] } };
  const flat = { contribution_type: "correction", payload: { target_table: "policies", target_id: "p1", field: "election_id", correct_value: "2024" } };
  assert(sameClaim(arr, flat), "兩種寫法是同一個宣稱");

  const x = { contribution_type: "correction", payload: { target_table: "policies", target_id: "p1", changes: [{ field: "a", correct_value: "1" }, { field: "b", correct_value: "2" }] } };
  const y = { contribution_type: "correction", payload: { target_table: "policies", target_id: "p1", changes: [{ field: "b", correct_value: "2" }, { field: "a", correct_value: "1" }] } };
  assert(sameClaim(x, y), "欄位順序不該影響");
});

Deno.test("candidacy：人、屆別、選舉種類、狀態四者相同才算同一個宣稱", () => {
  const base = { contribution_type: "candidacy", payload: { politician_id: P1, election_id: 2026, election_type: "縣市長", candidate_status: "registered", region: "新北市" } };
  assert(sameClaim(base, { ...base, payload: { ...base.payload, region: "台北市" } }), "region 不影響（值本身另有查核）");
  assert(!sameClaim(base, { ...base, payload: { ...base.payload, election_id: 2022 } }), "不同屆是不同宣稱");
  assert(!sameClaim(base, { ...base, payload: { ...base.payload, candidate_status: "withdrawn" } }), "狀態不同是不同宣稱");
  assert(!sameClaim(base, { ...base, payload: { ...base.payload, election_type: "縣市議員" } }));
});

Deno.test("policy_progress：同一筆政見的不同里程碑是不同宣稱（日期要進鍵）", () => {
  const a = { contribution_type: "policy_progress", payload: { policy_id: "x", status: "In Progress", progress: 30, date: "2026-08-28" } };
  const b = { contribution_type: "policy_progress", payload: { policy_id: "x", status: "In Progress", progress: 30, date: "2026-09-10" } };
  assert(!sameClaim(a, b), "不同日期是不同進度，不能合併");
  assert(sameClaim(a, { ...a, payload: { ...a.payload, note: "另一個代理的敘述" } }), "敘述不同不影響");
});

Deno.test("removal 與 no_change：對象相同就是同一個主張", () => {
  const r1 = { contribution_type: "removal", payload: { target_id: "2db8cc91", reason: "這是選戰標語與團隊組成" } };
  const r2 = { contribution_type: "removal", payload: { target_id: "2db8cc91", reason: "為競選策略口號，非公共政策" } };
  assert(sameClaim(r1, r2), "同一筆的移除主張，理由各寫各的");
  assert(!sameClaim(r1, { ...r1, payload: { target_id: "other" } }));

  const n1 = { contribution_type: "no_change", payload: { task_id: "t1", finding: "連結回 400" } };
  const n2 = { contribution_type: "no_change", payload: { task_id: "t1", finding: "需登入才看得到" } };
  assert(sameClaim(n1, n2));
});

Deno.test("自由文字型別一律不判重複：policy／politician 回 null", () => {
  // 實測：politician 用欄位名當鍵會誤判（「南投縣縣長」vs「南投縣長」、照片來源也不同），
  // 用值當鍵則是 0 對；policy 標題完全相同 0 組。納入零收益、卻有實證的誤判風險。
  assertEquals(claimKey("politician", { politician_id: P1, party: "國民黨", current_position: "南投縣縣長" }), null);
  assertEquals(claimKey("policy", { politician_id: P1, title: "居住新五箭" }), null);
  assertEquals(claimKey("question_answer", { question_id: "q1", answer: "x" }), null);
  assert(!DUPLICATE_ELIGIBLE_TYPES.includes("policy" as never));
  assert(!DUPLICATE_ELIGIBLE_TYPES.includes("politician" as never));
});

Deno.test("拿不到對象就不判重複，不猜", () => {
  assertEquals(claimKey("candidacy", { election_id: 2026 }), null, "沒有 politician_id");
  assertEquals(claimKey("correction", {}), null);
  assertEquals(claimTarget("candidacy", { politician_id: P1 })?.value, P1);
  assertEquals(claimTarget("policy", { politician_id: P1 }), null, "不適用的型別沒有對象");
});

Deno.test("臺／台、空白、大小寫不算不同", () => {
  const a = { contribution_type: "correction", payload: { target_table: "policies", target_id: "p1", changes: [{ field: "region", correct_value: "臺中市" }] } };
  const b = { contribution_type: "correction", payload: { target_table: "policies", target_id: "p1", changes: [{ field: "region", correct_value: " 台中市 " }] } };
  assert(sameClaim(a, b));
});

Deno.test("findMergeTarget：同代號或同 IP 一律不算，最早那筆優先", () => {
  const incoming = { contribution_type: "removal", payload: { target_id: "2db8cc91", reason: "口號" } };
  const me = { agent_name: "linmen", ip_hash: "ip-me" };
  const mk = (over: Partial<ExistingClaim>): ExistingClaim => ({
    id: "c1", contribution_type: "removal", payload: { target_id: "2db8cc91" },
    agent_name: "a-zhen", contributor_ip_hash: "ip-other", status: "pending", ...over,
  });

  assertEquals(findMergeTarget(incoming, me, [mk({ id: "first" }), mk({ id: "second" })])?.id, "first", "取最早那筆，票才會集中");
  assertEquals(findMergeTarget(incoming, me, [mk({ agent_name: "LinMen" })]), null, "同代號（不分大小寫）不算");
  assertEquals(findMergeTarget(incoming, me, [mk({ contributor_ip_hash: "ip-me" })]), null, "同一台機器不算");
  assertEquals(findMergeTarget(incoming, me, [mk({ status: "applied" })]), null, "已定案的不收票");
  assertEquals(findMergeTarget(incoming, me, [mk({ payload: { target_id: "different" } })]), null);
  assertEquals(findMergeTarget({ contribution_type: "policy", payload: { title: "x" } }, me, [mk({ contribution_type: "policy" })]), null, "自由文字型別不合併");
});
