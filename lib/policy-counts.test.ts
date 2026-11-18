import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  fallbackMapFromPolicies,
  groupRowsByElection,
  isPolicyCountsComplete,
  mapFromRawRows,
  pledgeCountKnown,
  pledgeCountOf,
  policyCountOfPeople,
  rawRowsFromPolicies,
  sliceForElection,
  slicesToState,
  type RawPolicyCountRow,
} from "./policy-counts.ts";

// #982 延伸：選舉頁的「N 項承諾」與 SEO 的「已收錄政見 N 項」改讀每人每屆承諾數對照，不再掃整份政見清單。

const raw: RawPolicyCountRow[] = [
  { politician_id: "a", election_id: 2026, pledge_count: 3, policy_count: 4 },
  { politician_id: "b", election_id: 2026, pledge_count: 0, policy_count: 2 },
  { politician_id: "c", election_id: 2026, pledge_count: 5, policy_count: 5 },
  { politician_id: "a", election_id: 2024, pledge_count: 1, policy_count: 1 },
];

Deno.test("groupRowsByElection：每屆一份，列是 [人, 承諾數, 政見數]", () => {
  const slices = groupRowsByElection(raw);
  assertEquals(slices.map((s) => s.electionId).sort(), [2024, 2026]);
  const s26 = slices.find((s) => s.electionId === 2026)!;
  assertEquals(s26.complete, true);
  assertEquals(s26.rows, [["a", 3, 4], ["b", 0, 2], ["c", 5, 5]]);
});

Deno.test("卡片數字：對照 → 這一屆承諾數；沒這個人＝0；別屆的數字不混進來", () => {
  const state = slicesToState(groupRowsByElection(raw));
  assertEquals(pledgeCountOf(state, 2026, "a"), 3);
  assertEquals(pledgeCountOf(state, 2024, "a"), 1);
  assertEquals(pledgeCountOf(state, 2026, "b"), 0);
  assertEquals(pledgeCountOf(state, 2026, "nobody"), 0);
  assertEquals(pledgeCountOf(state, 2022, "a"), 0, "沒有那一屆的對照");
  assertEquals(pledgeCountOf(state, undefined, "a"), 0);
  assertEquals(pledgeCountOf(state, 2026, 7 as never), 0, "id 可以是數字");
});

Deno.test("SEO：這批人這一屆的政見總數；同一人重複傳入只算一次；缺的人當 0", () => {
  const state = slicesToState(groupRowsByElection(raw));
  assertEquals(policyCountOfPeople(state, 2026, [{ id: "a" }, { id: "b" }, { id: "a" }, { id: "zzz" }]), 6);
  assertEquals(policyCountOfPeople(state, 2026, []), 0);
  assertEquals(policyCountOfPeople(state, 2022, [{ id: "a" }]), 0);
});

Deno.test("缺對照表（舊 state、直接進頁沒有預渲染）：數字未知、SEO 為 0、不是整屆齊全", () => {
  const empty = slicesToState(undefined);
  assertEquals(empty, {});
  assertEquals(pledgeCountKnown(empty, 2026, "a"), false, "不知道的人不能顯示 0");
  assertEquals(pledgeCountOf(empty, 2026, "a"), 0);
  assertEquals(policyCountOfPeople(empty, 2026, [{ id: "a" }]), 0);
  assertEquals(isPolicyCountsComplete(empty, 2026), false, "要向資料庫補撈");
});

Deno.test("整屆對照（全台頁）：缺的人就是真的 0，數字視為已知", () => {
  const state = slicesToState(sliceForElection(groupRowsByElection(raw), 2026));
  assertEquals(isPolicyCountsComplete(state, 2026), true);
  assertEquals(pledgeCountKnown(state, 2026, "nobody"), true);
  assertEquals(pledgeCountOf(state, 2026, "nobody"), 0);
});

Deno.test("縣市／鄉鎮頁切片：只留這頁的人、沒有政見的補 0 列、標成不完整（缺的人要等補撈）", () => {
  const slices = sliceForElection(groupRowsByElection(raw), 2026, new Set(["a", "z"]));
  assertEquals(slices.length, 1);
  assertEquals(slices[0].complete, false);
  assertEquals(slices[0].rows, [["a", 3, 4], ["z", 0, 0]]);
  const state = slicesToState(slices);
  assertEquals(pledgeCountKnown(state, 2026, "z"), true, "這頁的人：0 是真的 0");
  assertEquals(pledgeCountKnown(state, 2026, "b"), false, "不在這頁的人：還沒撈到，不顯示 0");
  assertEquals(isPolicyCountsComplete(state, 2026), false);
});

Deno.test("sliceForElection：沒有那一屆的資料回空陣列", () => {
  assertEquals(sliceForElection(groupRowsByElection(raw), 1999), []);
  assertEquals(sliceForElection(undefined, 2026), []);
});

Deno.test("rawRowsFromPolicies：視圖尚未上線時的退路，規則同視圖（有屆別才算、承諾只算 Campaign Pledge）", () => {
  const rows = rawRowsFromPolicies([
    { politicianId: "a", electionId: 2026, status: "Campaign Pledge" },
    { politicianId: "a", electionId: 2026, status: "In Progress" },
    { politicianId: "a", electionId: 2024, status: "Campaign Pledge" },
    { politicianId: "a", electionId: undefined, status: "Campaign Pledge" },
  ]);
  const byKey = new Map(rows.map((r) => [`${r.election_id}|${r.politician_id}`, r]));
  assertEquals(rows.length, 2, "沒標屆別的不進對照");
  assertEquals(byKey.get("2026|a"), { politician_id: "a", election_id: 2026, pledge_count: 1, policy_count: 2 });
  assertEquals(byKey.get("2024|a")?.pledge_count, 1);
});

// ── 守門：不靠載整份政見清單 ──

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));

Deno.test("候選人卡片：承諾數讀對照，不碰整份政見清單", () => {
  const grid = read("../pages/election/PoliticianGrid.vue");
  assert(grid.includes("pledgeCountOf("), "要讀對照");
  assert(!/\bpolicies\b\s*[,}]/.test(grid.slice(0, grid.indexOf("</script>"))), "script 不再取 policies");
  assert(!grid.includes("ensurePolicies"), "卡片不能觸發整份政見載入");
  assert(!grid.includes("PolicyStatus.CAMPAIGN"), "不再自己掃政見算承諾");
});

Deno.test("選舉頁：預設檢視不載整份政見；整份只在承諾／PK／更新時間與關注度排序時載", () => {
  const page = read("../pages/ElectionPage.vue");
  assert(page.includes("const needsFullPolicies = computed("), "要有「什麼時候才需要整份政見」的單一判斷");
  const calls = [...page.matchAll(/ensurePolicies\(\)/g)].length;
  assert(calls >= 1, "整份政見至少要有一處觸發");
  assert(!/^\s*(void )?ensurePolicies\(\)\s*$/m.test(page), "不能在 onMounted 無條件呼叫");
  assert(/if \(needsFullPolicies\.value\) ensurePolicies\(\)/.test(page), "掛載時要先看 needsFullPolicies");
  assert(/watch\(needsFullPolicies, \(need\) => \{ if \(need[^}]*ensurePolicies\(\)/.test(page));
  assert(page.includes("policyCountOfPeople(policyCountsByElection.value"), "SEO 政見數讀對照");
  assert(page.includes("ensurePolicyCounts(electionId.value)"), "對照不在時按屆別補撈一次");
});

Deno.test("預渲染：選舉頁三種切片都不嵌政見列，改嵌承諾數對照", () => {
  const src = read("./ssg/page-data.ts");
  for (const name of ["case 'election':", "case 'election-region':", "case 'election-township':"]) {
    const start = src.indexOf(name);
    assert(start > 0, name);
    const next = src.indexOf("\n    case ", start + 10);
    const body = src.slice(start, next);
    assert(body.includes("sliceForElection("), `${name} 要嵌對照`);
    assert(!body.includes("full.policies"), `${name} 不能再嵌政見列`);
  }
  const server = read("./ssg/server-data.ts");
  assert(server.includes("fetchPolicyCountRows"), "建置端從視圖撈");
});

Deno.test("migration：視圖 security_invoker、grant anon／authenticated、只算未移除", () => {
  const sql = read("../supabase/migrations/20261118120000_politician_election_policy_counts.sql");
  assert(sql.includes("CREATE OR REPLACE VIEW politician_election_policy_counts"));
  assert(sql.includes("security_invoker = on"));
  assert(sql.includes("GRANT SELECT ON politician_election_policy_counts TO anon, authenticated"));
  assert(sql.includes("removed_at IS NULL"));
  assert(sql.includes("'Campaign Pledge'"));
});

Deno.test("PGRST205 退路：整份政見自算的對照與視圖結果同形", () => {
  const viewRows: RawPolicyCountRow[] = [
    { politician_id: "a", election_id: 2026, pledge_count: 1, policy_count: 2 },
    { politician_id: "b", election_id: 2026, pledge_count: 0, policy_count: 1 },
  ];
  const policies = [
    { politicianId: "a", electionId: 2026, status: "Campaign Pledge" },
    { politicianId: "a", electionId: 2026, status: "In Progress" },
    { politicianId: "b", electionId: 2026, status: "In Progress" },
    { politicianId: "a", electionId: 2024, status: "Campaign Pledge" }, // 別屆不能混進來
    { politicianId: "c", electionId: undefined, status: "Campaign Pledge" },
  ];
  assertEquals(fallbackMapFromPolicies(policies, 2026), mapFromRawRows(viewRows));
  assertEquals(fallbackMapFromPolicies(policies, 1999), {}, "沒有那一屆就是空對照");
});

Deno.test("失敗狀態不等於 0：沒撈到的屆別 known 為 false，撈完後缺的人才是真的 0", () => {
  const failed = slicesToState([]);
  assertEquals(pledgeCountKnown(failed, 2026, "a"), false, "失敗時不能把沒讀到當成 0");
  const state = slicesToState([{ electionId: 2026, rows: [], complete: true }]);
  assertEquals(pledgeCountKnown(state, 2026, "a"), true);
});

Deno.test("守門：失敗要有獨立旗標與重試入口，不能掉進「尚無承諾」「載入中」", () => {
  const page = read("../pages/ElectionPage.vue");
  assert(page.includes('data-testid="pledges-error"') && page.includes('data-testid="pk-error"'), "承諾／PK 頁籤要有失敗顯示");
  assert(page.includes('data-testid="pledge-counts-error"'), "承諾數補撈失敗要有重試入口");
  assert(!/!policiesComplete && !error/.test(page), "載入中提示不能再靠 !error 消失");
  const grid = read("../pages/election/PoliticianGrid.vue");
  assert(grid.includes("暫時讀不到承諾數"), "卡片失敗要說讀不到");
  const sup = read("../composables/useSupabase.ts");
  assert(sup.includes("isMissingRelation(err)") && sup.includes("console.warn('[承諾數]"), "視圖不存在要退路並印 warn");
});
