import { assert, assertEquals } from "jsr:@std/assert@1";
import { findSuperseded, claimKey, claimTarget, DUPLICATE_ELIGIBLE_TYPES, type ExistingClaim, findMergeTarget, sameClaim } from "./duplicate-claim.ts";

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

// 2026-09-19：election_result_missing 的答案若併進只有狀態的舊提交，結果欄位就丟了
Deno.test("candidacy：帶選舉結果的跟沒帶的不是同一個宣稱；結果相同才是", () => {
  const p = { politician_id: P1, election_id: 2022, election_type: "鄉鎮市長", candidate_status: "confirmed", region: "南投縣" };
  const plain = claimKey("candidacy", p);
  const won = claimKey("candidacy", { ...p, election_result: "elected", votes_received: 29150 });
  const won2 = claimKey("candidacy", { ...p, election_result: "elected", votes_received: 29151 });
  const lost = claimKey("candidacy", { ...p, election_result: "not_elected" });
  assertEquals(plain === won, false);
  assertEquals(won, won2, "得票數差一票仍是同一個宣稱（結果相同）");
  assertEquals(won === lost, false);
});

Deno.test("merge_politician：同一對（順序無關）＋同結論才是同一個宣稱", () => {
  const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
  const k1 = claimKey("merge_politician", { keep_id: A, remove_id: B, same_person: true });
  const k2 = claimKey("merge_politician", { keep_id: B, remove_id: A, same_person: true });
  const k3 = claimKey("merge_politician", { keep_id: A, remove_id: B, same_person: false });
  assertEquals(k1 === k2, false, "keep 不同就不是同一個宣稱（誰被留下來是結論的一部分）");
  assertEquals(k1 === k3, false);
  assertEquals(claimKey("merge_politician", { keep_id: A, remove_id: B, same_person: true }), k1);
});

// 2026-09-21：蔡培慧 2024 落選那筆三個代理各交一份，一筆上線後另兩筆還在等票
Deno.test("findSuperseded：同宣稱、還在等票的才收編；自己、不同宣稱、已定案的不動", () => {
  const p = { politician_id: P1, election_id: 2024, election_type: "立法委員", candidate_status: "confirmed", election_result: "not_elected", region: "南投縣" };
  const applied = { id: "a", contribution_type: "candidacy", payload: p };
  const pending = [
    { id: "a", contribution_type: "candidacy", payload: p, status: "pending" },
    { id: "b", contribution_type: "candidacy", payload: { ...p, votes_received: 66551 }, status: "pending" },
    { id: "c", contribution_type: "candidacy", payload: { ...p, election_result: "elected" }, status: "pending" },
    { id: "d", contribution_type: "candidacy", payload: p, status: "rejected" },
    { id: "e", contribution_type: "candidacy", payload: p, status: "verified" },
  ];
  assertEquals(findSuperseded(applied, pending), ["b", "e"]);
  assertEquals(findSuperseded({ id: "x", contribution_type: "policy", payload: { title: "t" } }, pending), [], "自由文字型別不併");
});


// 2026-09-21：提議任務也算重複宣稱（陳素月 9b990687 三方各提一次）
Deno.test("task_suggestion：同對象同型別＝同一個提議，標題描述不同不影響；型別不同或對象不同就不是", () => {
  const a = { contribution_type: "task_suggestion", payload: { title: "來源沒有 1000 億這個數字", description: "自由時報原文零命中", task_type: "other", target_policy_id: "9b990687-0000-0000-0000-000000000000" } };
  const b = { contribution_type: "task_suggestion", payload: { title: "description 的數字查無", description: "另一個代理的寫法", task_type: "other", target_policy_id: "9b990687-0000-0000-0000-000000000000" } };
  const c = { ...b, payload: { ...b.payload, task_type: "policy_source_missing" } };
  const d = { ...b, payload: { ...b.payload, target_policy_id: "11111111-0000-0000-0000-000000000000" } };
  assertEquals(sameClaim(a, b), true, "同對象同型別");
  assertEquals(sameClaim(a, c), false, "型別不同是不同缺陷");
  assertEquals(sameClaim(a, d), false, "對象不同");
  // 沒寫 task_type 視為 other
  const e = { ...b, payload: { title: b.payload.title, description: b.payload.description, target_policy_id: b.payload.target_policy_id } };
  assertEquals(sameClaim(a, e), true, "沒寫型別＝other");
  // 指人物的提議：用 target_politician_id 當對象
  const f = { contribution_type: "task_suggestion", payload: { title: "x".repeat(10), description: "y".repeat(20), task_type: "profile_gap", target_politician_id: "22222222-0000-0000-0000-000000000000" } };
  const g = { ...f, payload: { ...f.payload, title: "另一個標題不影響" } };
  assertEquals(sameClaim(f, g), true);
  assertEquals(claimTarget("task_suggestion", f.payload)?.field, "target_politician_id");
  // 兩個對象都沒有 → 不併
  assertEquals(claimKey("task_suggestion", { title: "x".repeat(10), description: "y".repeat(20), task_type: "other" }), null);
});
