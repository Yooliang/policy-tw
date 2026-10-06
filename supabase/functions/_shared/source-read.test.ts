import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { buildHistory, collectHistory, describeOrigin } from "./history.ts";
import {
  fetchPrimarySourceUrls, fetchSourceBriefs, overlayPrimarySources, overlaySourceUrl, primaryUrlOf, type SourceBrief, viewFromList, viewSources,
} from "./source-read.ts";

// issue #347：出處的讀取端。第二階段 A 是新表優先、舊欄位退路；第二階段 B-1 起沒有舊欄位退路（資料表的 source_url 不再被讀）：
// 出處表拿不到時不擋任何東西，但也不假裝「沒有出處」。

const POL = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";
const POLICY = "0c9c1a5e-1111-4222-8333-444444444444";
const C1 = "11111111-1111-4111-8111-111111111111";
const BULLETIN = "https://eebulletin.cec.gov.tw/111/a.pdf";
const NEWS = "https://news.ltn.com.tw/n1";
const OWN = "https://www.candidate-wang.tw/policy";
const ARCHIVE = "https://web.archive.org/web/20261001000000/https://eebulletin.cec.gov.tw/111/a.pdf";

const brief = (url: string, kind: string, extra: Partial<SourceBrief> = {}): SourceBrief =>
  ({ url, source_kind: kind, self_evidence: null, doc_kind: null, archive_url: null, title: null, publisher: null, ...extra });

Deno.test("viewSources：出處表有就用它的等級、認定根據、存檔；沒有就用網域自動判斷（不給 self）", () => {
  const briefs = new Map([
    [BULLETIN, brief(BULLETIN, "official", { doc_kind: "election_bulletin", archive_url: ARCHIVE })],
    [OWN, brief(OWN, "self", { self_evidence: "mutual_link" })],
  ]);
  assertEquals(viewSources([BULLETIN, OWN, NEWS, "https://x.example/a", " " + NEWS + " ", "不是網址", ""], briefs), [
    { url: BULLETIN, kind: "official", self_evidence: null, archive_url: ARCHIVE },
    { url: OWN, kind: "self", self_evidence: "mutual_link", archive_url: null },
    { url: NEWS, kind: "media", self_evidence: null, archive_url: null },
    { url: "https://x.example/a", kind: "other", self_evidence: null, archive_url: null },
    { url: "不是網址", kind: "other", self_evidence: null, archive_url: null },
  ]);
  assertEquals(viewSources(null, briefs), []);
  assertEquals(viewSources(undefined, briefs), []);
});

Deno.test("viewSources：出處表的等級不是四種之一（壞資料）就退回自動判斷", () => {
  const v = viewSources([NEWS], new Map([[NEWS, brief(NEWS, "亂寫")]]));
  assertEquals(v[0].kind, "media");
});

Deno.test("primaryUrlOf／viewFromList：主要出處優先；清單沒有就自動判斷", () => {
  const list = [
    { url: NEWS, role: "supporting", kind: "media", archive_url: null },
    { url: BULLETIN, role: "primary", kind: "official", archive_url: ARCHIVE, self_evidence: null },
  ];
  assertEquals(primaryUrlOf(list), BULLETIN);
  assertEquals(primaryUrlOf([{ url: NEWS, role: "supporting" }]), null);
  assertEquals(primaryUrlOf(null), null);
  assertEquals(primaryUrlOf("x"), null);
  assertEquals(viewFromList(list, BULLETIN), { url: BULLETIN, kind: "official", self_evidence: null, archive_url: ARCHIVE });
  assertEquals(viewFromList(null, NEWS), { url: NEWS, kind: "media", self_evidence: null, archive_url: null });
});

Deno.test("fetchSourceBriefs：用 RPC 一次問一批網址（去重、最多 500 個）；RPC 出錯或不存在回空表", async () => {
  let asked: string[] = [];
  const ok = createFakeSupabase({}, { source_briefs: (a) => { asked = a.p_urls as string[]; return [brief(NEWS, "media")]; } });
  const got = await fetchSourceBriefs(ok.client, [NEWS, NEWS, " " + NEWS + " ", OWN]);
  assertEquals(asked, [NEWS, OWN]);
  assertEquals([...got.keys()], [NEWS]);
  const many = Array.from({ length: 700 }, (_, i) => `https://e.example/${i}`);
  await fetchSourceBriefs(ok.client, many);
  assertEquals(asked.length, 500);

  const bad = { rpc: () => Promise.resolve({ data: null, error: { message: "function source_briefs does not exist" } }) };
  assertEquals((await fetchSourceBriefs(bad, [NEWS])).size, 0);
  assertEquals((await fetchSourceBriefs({ rpc: () => { throw new Error("連不上"); } }, [NEWS])).size, 0);
  assertEquals((await fetchSourceBriefs({}, [NEWS])).size, 0, "沒有 rpc 的替身也不炸");
  assertEquals((await fetchSourceBriefs(ok.client, [])).size, 0);
});

Deno.test("查核履歷：每一筆交件的網址帶出處表的等級與存檔；出處表沒有的照網域判斷", async () => {
  const fake = createFakeSupabase({
    policies: [{ id: POLICY, title: "長者健保全免", politician_id: POL, source_url: NEWS, ai_extracted: false }],
    politicians: [{ id: POL, name: "王小明" }],
    contributions: [{
      id: C1, contribution_type: "policy", payload: { politician_id: POL, title: "長者健保全免" }, source_urls: [BULLETIN, OWN, NEWS], note: null, agent_name: "alice", agent_tool: null,
      status: "applied", review_notes: null, applied_at: "2026-09-10T01:00:00Z", applied_politician_id: POL, applied_policy_id: POLICY, created_at: "2026-09-09T23:00:00Z", agree_count: 2, disagree_count: 0, unsure_count: 0,
    }],
  }, {
    source_briefs: () => [brief(BULLETIN, "official", { doc_kind: "election_bulletin", archive_url: ARCHIVE }), brief(OWN, "self", { self_evidence: "linked_by_official" })],
    source_brief_list: () => [{ url: BULLETIN, role: "primary", kind: "official", archive_url: ARCHIVE, self_evidence: null }],
  });
  const data = await collectHistory(fake.client, "policy", POLICY);
  const [entry] = buildHistory(data);
  assertEquals(entry.source_urls, [BULLETIN, OWN, NEWS], "舊欄位 source_urls 原樣保留");
  assertEquals(entry.sources, [
    { url: BULLETIN, kind: "official", self_evidence: null, archive_url: ARCHIVE },
    { url: OWN, kind: "self", self_evidence: "linked_by_official", archive_url: null },
    { url: NEWS, kind: "media", self_evidence: null, archive_url: null },
  ]);
});

Deno.test("查核履歷：出處表拿不到（RPC 出錯）時照舊能出，等級退回網域判斷；來源說明當作沒有出處列（不讀舊欄位）", async () => {
  const fake = createFakeSupabase({
    policies: [{ id: POLICY, title: "長者健保全免", politician_id: POL, source_url: NEWS, ai_extracted: false }],
    politicians: [{ id: POL, name: "王小明" }],
    contributions: [{
      id: C1, contribution_type: "policy", payload: { politician_id: POL, title: "長者健保全免" }, source_urls: [NEWS], note: null, agent_name: "alice", agent_tool: null,
      status: "applied", review_notes: null, applied_at: "2026-09-10T01:00:00Z", applied_politician_id: POL, applied_policy_id: POLICY, created_at: "2026-09-09T23:00:00Z", agree_count: 2, disagree_count: 0, unsure_count: 0,
    }],
  });
  const brokenRpc = { ...fake.client, rpc: () => Promise.resolve({ data: null, error: { message: "not found" } }) };
  const data = await collectHistory(brokenRpc, "policy", POLICY);
  const [entry] = buildHistory(data);
  assertEquals(entry.sources, [{ url: NEWS, kind: "media", self_evidence: null, archive_url: null }]);
  const origin = describeOrigin("policy", data.origin_row, [], false);
  assertEquals(origin.source_url, null, "B-1 起沒有舊欄位的退路：RPC 出錯就是沒有出處列");
});

Deno.test("沒有履歷時的來源說明：出處表的主要出處（帶等級與存檔）；不讀舊欄位 source_url", () => {
  const withRefs = describeOrigin("policy", {
    id: POLICY, source_url: "https://old.example/ignored", ai_extracted: false,
    sources: [{ url: BULLETIN, role: "primary", kind: "official", archive_url: ARCHIVE, self_evidence: null }, { url: NEWS, role: "supporting", kind: "media", archive_url: null }],
  }, [], false);
  assertEquals(withRefs.kind, "imported");
  assertEquals(withRefs.source_url, BULLETIN, "新表的主要出處；列上就算還有舊欄位也不理它");
  assertEquals(withRefs.source, { url: BULLETIN, kind: "official", self_evidence: null, archive_url: ARCHIVE });

  const legacy = describeOrigin("policy", { id: POLICY, source_url: NEWS, ai_extracted: false, sources: [] }, [], false);
  assertEquals(legacy.source_url, null, "出處表沒有主要出處＝沒有出處，舊欄位的值不再冒出來");
  assertEquals(legacy.source, null);

  const none = describeOrigin("policy", { id: POLICY, source_url: null, ai_extracted: false }, [], false);
  assertEquals(none.source_url, null);
  assertEquals(none.source, null);
  assertEquals(none.kind, "unknown");

  assertEquals(describeOrigin("policy", { id: POLICY, source_url: NEWS }, [], true), { kind: "contributions", note: null }, "有履歷就不講匯入來源");
});

Deno.test("fetchPrimarySourceUrls：只拿主要出處；出錯回 null（不是空表：查不到不能當成沒有出處）", async () => {
  const fake = createFakeSupabase({
    source_refs: [
      { target_table: "policies", target_id: "p1", role: "primary", sources: { url: BULLETIN } },
      { target_table: "policies", target_id: "p1", role: "supporting", sources: { url: NEWS } },
      { target_table: "policies", target_id: "p2", role: "primary", sources: [{ url: OWN }] },
      { target_table: "tracking_logs", target_id: "7", role: "primary", sources: { url: NEWS } },
    ],
  });
  const got = await fetchPrimarySourceUrls(fake.client, "policies", ["p1", "p2", "p3"]);
  assertEquals([...got!.entries()].sort(), [["p1", BULLETIN], ["p2", OWN]]);
  assertEquals([...(await fetchPrimarySourceUrls(fake.client, "tracking_logs", [7]))!.entries()], [["7", NEWS]]);
  assertEquals(await fetchPrimarySourceUrls({ from: () => { throw new Error("連不上"); } }, "policies", ["p1"]), null);
  assertEquals((await fetchPrimarySourceUrls(fake.client, "policies", []))!.size, 0);
});

Deno.test("overlaySourceUrl：每一列的 source_url ＝出處表的主要出處；沒有主要出處是 null；查詢出錯（null）就完全不動", () => {
  const rows: Array<Record<string, unknown>> = [{ id: "p1" }, { id: "p2", source_url: "https://old.example/2" }, { source_url: "沒有 id" }];
  overlaySourceUrl(rows, new Map([["p1", BULLETIN]]));
  assertEquals(rows.map((r) => r.source_url), [BULLETIN, null, "沒有 id"], "沒有主要出處＝null，不留列上原本的值");
  const keep: Array<Record<string, unknown>> = [{ id: "p1" }];
  overlaySourceUrl(keep, null);
  assertEquals("source_url" in keep[0], false, "出處表查詢出錯：欄位不給，比給 null 誠實");
});

Deno.test("任務現況：政見、清單、進度紀錄的 source_url 都來自出處表；其他欄位不動", async () => {
  const fake = createFakeSupabase({
    source_refs: [
      { target_table: "policies", target_id: "p1", role: "primary", sources: { url: BULLETIN } },
      { target_table: "policies", target_id: "p2", role: "primary", sources: { url: OWN } },
      { target_table: "tracking_logs", target_id: "7", role: "primary", sources: { url: NEWS } },
    ],
  });
  const data = {
    policy: { id: "p1", title: "A" } as Record<string, unknown>,
    policies: [{ id: "p2" }, { id: "p9" }] as Array<Record<string, unknown>>,
    lineage_policies: [{ id: "p1" }] as Array<Record<string, unknown>>,
    tracking_logs: [{ id: 7, date: "2026-10-01" }] as Array<Record<string, unknown>>,
    elections: [{ id: 1 }],
  };
  await overlayPrimarySources(fake.client, data);
  assertEquals(data.policy.source_url, BULLETIN);
  assertEquals(data.policy.title, "A");
  assertEquals(data.policies.map((p) => p.source_url), [OWN, null], "出處表沒有主要出處的那條是 null（我們沒有出處）");
  assertEquals(data.lineage_policies[0].source_url, BULLETIN);
  assertEquals(data.tracking_logs[0].source_url, NEWS);
  // 出處表不能用：不丟錯、欄位不給（不是 null——null 會被讀成「沒有出處」）
  const keep = { policy: { id: "p1" } as Record<string, unknown> };
  await overlayPrimarySources({ from: () => { throw new Error("連不上"); } }, keep);
  assertEquals("source_url" in keep.policy, false);
  await overlayPrimarySources(fake.client, {});
});

// ── 接線：讀取端真的用了新表（守門：拿掉就紅） ─────────────────────────────────

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));

Deno.test("接線：任務現況、查核履歷、貢獻看板都接了出處表的讀取", () => {
  assert(/await overlayPrimarySources\(supabase, data as Obj\);\s*return data;/.test(read("./task-context.ts")), "fetchTaskContext 結尾要換掉 source_url");
  // 進度紀錄要帶 id 才換得掉；摘要出去的欄位仍只有 date／event／description／source_url
  assert(read("./task-context.ts").includes('supabase.from("tracking_logs").select("id, date, event, description")'));
  assert(!/from\("tracking_logs"\)\.select\("[^"]*source_url/.test(read("./task-context.ts")), "進度紀錄不再選 source_url 欄");
  // 驗證項（fetchVerifyContext）跟派給代理的現況同一份：政見與進度的 source_url 來自出處表，更正的目標列也是
  assert(/await overlayPrimarySources\(supabase, data as Obj\);\s*if \(contributionType === "correction" && payload\.target_table === "policies"/.test(read("./task-context.ts")));
  assert(read("./history.ts").includes("fetchSourceBriefs(supabase, contributions.flatMap"));
  assert(read("./history.ts").includes('supabase.rpc("source_brief_list"'));
  assert(read("../contributions-feed/index.ts").includes("viewSources(r.source_urls, sourceBriefs)"));
});
