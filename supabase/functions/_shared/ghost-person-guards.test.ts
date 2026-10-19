// 幽靈人物「劉雁祿」（2026-10-18）：politician_elections 113 掛在早期匯入多建的人物 8d5c8372 上，
// 中選會公報上真人是劉復嵐（38d16e30，pe 914）。守四件事：
//  A1 落庫：交件的姓名跟 politician_id 指的人不是同一人 → disputed（given 分支，原本就有）
//  A2 落庫：同樣情況走 resolved 分支（cec-verify 的 resolvedPoliticianId、驗證者指認）→ disputed（原本完全不比姓名）
//  A3 交件端：politician_id 與 name 不是同一人 → 400 politician_name_mismatch，不算被拒
//  C1 交件端：correction 改名成同屆、同選舉類型、同縣市另一位參選人的名字 → 400 rename_duplicates_person，附既有人物 id
//  C2 落庫端：等票期間才撞名 → disputed
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { applyContribution } from "./apply-contribution.ts";
import { handleContribute } from "./contribute-handler.ts";

const GHOST = "8d5c8372-1764-4ef7-9a7d-8a3e11658c62";
const REAL = "38d16e30-0000-4000-8000-000000000914";
const C1 = "72bad160-d099-4c09-bd8a-efa8e792e5f9";

const tables = (extra: Record<string, unknown[]> = {}) => ({
  politicians: [
    { id: GHOST, name: "劉雁祿", region: "新竹縣", merged_into: null },
    { id: REAL, name: "劉復嵐", region: "新竹縣", merged_into: null },
  ],
  politician_elections: [
    { id: 113, politician_id: GHOST, election_id: 2022, election_type: "縣市長" },
    { id: 914, politician_id: REAL, election_id: 2022, election_type: "縣市長" },
  ],
  politician_keys: [],
  ...extra,
});

const candidacy = (payload: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: C1, contribution_type: "candidacy", status: "verified", agent_name: "alice", contributor_ip_hash: "ip-a", contributor_url: null, note: null, retry_count: 0,
  task_id: "auto:election_result_missing:113",
  payload: { name: "劉復嵐", region: "新竹縣", election_id: 2022, election_type: "縣市長", election_result: "not_elected", candidate_status: "qualified", ...payload },
  source_urls: ["https://example.test/a"],
  ...over,
});

Deno.test("A1 given 分支：pe 113 形狀（name≠人物名、沒別名）→ disputed，訊息講兩個名字", async () => {
  const row = candidacy({ politician_id: GHOST });
  const f = createFakeSupabase({ contributions: [row], ...tables() });
  const out = await applyContribution(f.client, row as never);
  assertEquals(out.status, "disputed");
  assertStringIncludes(String(out.message), "劉雁祿");
  assertStringIncludes(String(out.message), "劉復嵐");
});

Deno.test("A2 resolved 分支（cec-verify／驗證者指認）：同樣情況也是 disputed", async () => {
  // 72bad160 的真實路徑：cec-verify 先把交件標 verified（score 0），再 autoApply(resolvedPoliticianId = 我們庫裡 payload.politician_id 那位)
  const row = { ...candidacy({ politician_id: GHOST }), resolved_politician_id: GHOST };
  const f = createFakeSupabase({ contributions: [row], ...tables() });
  const out = await applyContribution(f.client, row as never);
  assertEquals(out.status, "disputed");
  assertStringIncludes(String(out.message), "不是同一人");
  assertStringIncludes(String(out.message), "劉雁祿");
  assertStringIncludes(String(out.message), "劉復嵐");
  assertEquals(f.db.politician_elections.length, 2, "不能多寫或改參選紀錄");
});

Deno.test("A2 resolved 分支：姓名是別名時照常通過這道檢查", async () => {
  const row = { ...candidacy({ politician_id: GHOST }), resolved_politician_id: GHOST };
  const f = createFakeSupabase({ contributions: [row], ...tables({ politician_keys: [{ politician_id: GHOST, key_type: "alias_name", key_value: "劉復嵐", strength: 3 }] }) });
  const out = await applyContribution(f.client, row as never);
  assert(!String(out.message).includes("不是同一人"), String(out.message));
});

const ITEM = (payload: Record<string, unknown>) => ({
  contribution_type: "candidacy",
  payload: { name: "劉復嵐", region: "新竹縣", election_id: 2022, election_type: "縣市長", election_result: "not_elected", candidate_status: "qualified", ...payload },
  source_urls: ["https://example.test/a"], agent_name: "tester", agent_tool: "claude-code/sonnet",
});

Deno.test("A3 交件端：politician_id 與 name 不是同一人 → 400，不算被拒，提示 merge_politician／removal", async () => {
  const f = createFakeSupabase({ contributions: [], ...tables() });
  const res = await handleContribute(f.client, "https://x", ITEM({ politician_id: GHOST }), "ip");
  assertEquals(res.status, 400);
  const body = res.body as { error: string; message: string };
  assertEquals(body.error, "politician_name_mismatch");
  assertStringIncludes(body.message, "merge_politician");
  assertStringIncludes(body.message, "removal");
  assertStringIncludes(body.message, "這不算被拒");
});

Deno.test("A3 交件端：id 與 name 對得上、或有別名 → 不是這個錯", async () => {
  const ok = await handleContribute(createFakeSupabase({ contributions: [], ...tables() }).client, "https://x", ITEM({ politician_id: REAL }), "ip");
  assert((ok.body as { error?: string }).error !== "politician_name_mismatch");
  const alias = await handleContribute(createFakeSupabase({ contributions: [], ...tables({ politician_keys: [{ politician_id: GHOST, key_type: "alias_name", key_value: "劉復嵐" }] }) }).client, "https://x", ITEM({ politician_id: GHOST }), "ip");
  assert((alias.body as { error?: string }).error !== "politician_name_mismatch");
});

const rename = (name: string, target = GHOST) => ({
  contribution_type: "correction",
  payload: { target_table: "politicians", target_id: target, changes: [{ field: "name", correct_value: name }], reason: "中選會公報 2022 新竹縣長只有 5 人，真名劉復嵐" },
  source_urls: ["https://bulletin.cec.gov.tw/example"], agent_name: "tester", agent_tool: "claude-code/sonnet",
});

Deno.test("C1 交件端：改名成同屆同類型同縣市另一位的名字 → 400，附既有人物 id 與 merge_politician", async () => {
  const f = createFakeSupabase({ contributions: [], ...tables() });
  const res = await handleContribute(f.client, "https://x", rename("劉復嵐"), "ip");
  assertEquals(res.status, 400);
  const body = res.body as { error: string; message: string };
  assertEquals(body.error, "rename_duplicates_person");
  assertStringIncludes(body.message, "merge_politician");
  assertStringIncludes(body.message, REAL);
  assertStringIncludes(body.message, GHOST);
});

Deno.test("C1 交件端：改成不撞名的名字、或撞的是別縣市／別屆的人 → 照常（不是這個錯）", async () => {
  const fresh = await handleContribute(createFakeSupabase({ contributions: [], ...tables() }).client, "https://x", rename("劉大明"), "ip");
  assert((fresh.body as { error?: string }).error !== "rename_duplicates_person");
  const otherCounty = tables();
  otherCounty.politicians[1] = { ...otherCounty.politicians[1], region: "宜蘭縣" };
  const r2 = await handleContribute(createFakeSupabase({ contributions: [], ...otherCounty }).client, "https://x", rename("劉復嵐"), "ip");
  assert((r2.body as { error?: string }).error !== "rename_duplicates_person");
  const otherTerm = tables();
  otherTerm.politician_elections[1] = { ...otherTerm.politician_elections[1], election_id: 2018 };
  const r3 = await handleContribute(createFakeSupabase({ contributions: [], ...otherTerm }).client, "https://x", rename("劉復嵐"), "ip");
  assert((r3.body as { error?: string }).error !== "rename_duplicates_person");
});

Deno.test("C2 落庫端：等票期間才撞名 → disputed、不改名；不撞名照常改", async () => {
  const row = (name: string) => ({ ...rename(name), id: "467636dc-9c24-4a4f-9f7b-19475531733e", status: "verified", contributor_ip_hash: "ip-a", contributor_url: null, note: null, retry_count: 0, task_id: null });
  const f = createFakeSupabase({ contributions: [], ...tables() });
  const out = await applyContribution(f.client, row("劉復嵐") as never);
  assertEquals(out.status, "disputed");
  assertStringIncludes(String(out.message), "merge_politician");
  assertEquals(f.db.politicians.find((p) => p.id === GHOST)!.name, "劉雁祿");
  const g = createFakeSupabase({ contributions: [], ...tables() });
  const ok = await applyContribution(g.client, row("劉大明") as never);
  assertEquals(ok.status, "applied");
  assertEquals(g.db.politicians.find((p: Record<string, unknown>) => p.id === GHOST)!.name, "劉大明");
});
