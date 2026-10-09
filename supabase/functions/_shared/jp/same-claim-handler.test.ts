/**
 * 日本站交件端的「同一件事」（#521，協議 0.7.0）：jp/contribute-handler.ts 照 same_claim_matches 的結果處理 resolved_claim。
 * 假的 supabase（rpc same_claim_matches 回什麼由測試給）＋假的投票端。
 *   - resolved_claim 沒填、寫錯、differs 沒寫 note → 400
 *   - new 撞到 → 409 duplicate_claim，不寫入
 *   - 指向審議中那一筆 → 併成同意票（via merge）；這個網段投過 → 409 already_voted；投票端拒絕 → 409，不另收一筆
 *   - 指向在庫列：有任務 → 改記 no_change confirmed；沒有任務 → already_exists，什麼都不寫
 *   - 指的 id 不在比對結果 → 409 claim_mismatch；differs → 照常收
 *   - 一批裡有收的、有擋的 → 201，被擋的標 not_accepted；同一批兩筆 new 是同一件事 → 只收第一筆
 *   - claimKey 型別（no_change）併票投不成：不再照原路收下
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleContribute } from "./contribute-handler.ts";
import type { SameClaimMatches } from "../same-claims.ts";

const LG = "131130";
const E1 = "2027-04-25_ward_mayor_131130";
const C1 = "c1111111-0000-4000-8000-000000000001";

function fakeSupabase(o: { matches?: (type: string, payload: Record<string, unknown>) => SameClaimMatches; candidates?: unknown[] } = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const api = {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (fn === "same_claim_matches") {
        const m = o.matches?.(String(args.p_type), args.p_payload as Record<string, unknown>) ?? { type: String(args.p_type), existing: [], pending: [] };
        return Promise.resolve({ data: m, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { q[col] = val; return chain; },
        in: () => chain,
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: (rows: Array<Record<string, unknown>>) => {
          inserted.push(...rows);
          return { select: () => ({ data: rows.map((r, i) => ({ id: `new-${inserted.length - rows.length + i}`, payload_hash: r.payload_hash })), error: null }) };
        },
        delete: () => ({ in: () => ({ error: null }) }),
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) => {
          if (table === "contributions" && q.status === "pending") return res({ data: o.candidates ?? [], error: null, count: 0 });
          return res({ data: [], error: null, count: 0 });
        },
      };
      return chain;
    },
  };
  return { api, inserted, rpcCalls };
}

const election = (resolved: unknown, extra: Record<string, unknown> = {}) => ({
  contribution_type: "election",
  payload: { lg_code: LG, election_type: "ward_mayor", election_reason: "regular", election_date: "2027-04-25", name: "渋谷区長選挙", resolved_claim: resolved },
  source_urls: ["https://www.city.shibuya.tokyo.jp/kusei/senkyo/a.html"],
  ...extra,
});
const body = (item: Record<string, unknown>) => ({ ...item, agent_name: "tester-1", agent_tool: "test/model" });
const okVote = () => Promise.resolve({ status: 201, body: { agree_count: 2, required_agree: 3, status: "pending" } });
const noVote = () => { throw new Error("不該投票"); };
type R = Record<string, unknown>;

Deno.test("resolved_claim 沒填、寫錯 → 400；differs 沒寫 note → 400", async () => {
  for (const bad of [undefined, "", "two words"]) {
    const { api, inserted } = fakeSupabase();
    const res = await handleContribute(api, "https://x", body(election(bad)), "ip-me", noVote);
    assertEquals(res.status, 400, String(bad));
    assert(JSON.stringify(res.body).includes("payload.resolved_claim"));
    assertEquals(inserted.length, 0);
  }
  const { api } = fakeSupabase();
  const res = await handleContribute(api, "https://x", body(election(`differs:${E1}`)), "ip-me", noVote);
  assertEquals(res.status, 400);
  assert(JSON.stringify(res.body).includes('"path":"note"'));
});

Deno.test("new 而且兩邊都空 → 照常收；比對用的是這一筆的 payload 與網段", async () => {
  const { api, inserted, rpcCalls } = fakeSupabase();
  const res = await handleContribute(api, "https://x", body(election("new")), "ip-me", noVote);
  assertEquals(res.status, 201);
  assertEquals(inserted.length, 1);
  const call = rpcCalls.find((c) => c.fn === "same_claim_matches")!;
  assertEquals([call.args.p_type, (call.args.p_payload as R).lg_code, call.args.p_ip_hash], ["election", LG, "ip-me"]);
});

Deno.test("new 卻撞到 → 409 duplicate_claim，不寫入", async () => {
  const { api, inserted } = fakeSupabase({ matches: () => ({ type: "election", existing: [{ id: E1 }], pending: [] }) });
  const res = await handleContribute(api, "https://x", body(election("new")), "ip-me", noVote);
  assertEquals(res.status, 409);
  assertEquals((res.body as R).error, "duplicate_claim");
  assertEquals((res.body as R).existing_ids, [E1]);
  assertEquals(inserted.length, 0);
});

Deno.test("指向審議中那一筆 → 併成同意票（via merge），不另收", async () => {
  const { api, inserted } = fakeSupabase({ matches: () => ({ type: "election", existing: [], pending: [{ contribution_id: C1, agent: "AaBb", your_network_voted: false }] }) });
  const votes: R[] = [];
  const vias: unknown[] = [];
  const res = await handleContribute(api, "https://x", body(election(C1)), "ip-me", (_s, v, _ip, _a, via) => { votes.push(v as R); vias.push(via); return okVote(); });
  assertEquals(res.status, 201);
  assertEquals(inserted.length, 0);
  assertEquals([votes[0].contribution_id, votes[0].verdict, vias[0]], [C1, "agree", "merge"]);
  assertEquals([(res.body as R).status, (res.body as R).contribution_id], ["counted_as_vote", C1]);
  assert(String((res.body as R).message).includes("AaBb"));
});

Deno.test("指向審議中那一筆，但這個網段投過或交過 → 409 already_voted，不投也不收", async () => {
  const { api, inserted } = fakeSupabase({ matches: () => ({ type: "election", existing: [], pending: [{ contribution_id: C1, your_network_voted: true }] }) });
  const res = await handleContribute(api, "https://x", body(election(C1)), "ip-me", noVote);
  assertEquals([res.status, (res.body as R).error], [409, "already_voted"]);
  assertEquals(inserted.length, 0);
});

Deno.test("投票端拒絕（10-09 那 4 對的路）→ 409，不再照原路另收一筆", async () => {
  const { api, inserted } = fakeSupabase({ matches: () => ({ type: "election", existing: [], pending: [{ contribution_id: C1, your_network_voted: false }] }) });
  const res = await handleContribute(api, "https://x", body(election(C1)), "ip-me",
    () => Promise.resolve({ status: 409, body: { success: false, error: "already_voted", message: "這個來源已對這筆投過票" } }));
  assertEquals([res.status, (res.body as R).error], [409, "already_voted"]);
  assertEquals(inserted.length, 0);
  const closed = await handleContribute(fakeSupabase({ matches: () => ({ type: "election", existing: [], pending: [{ contribution_id: C1 }] }) }).api, "https://x", body(election(C1)), "ip-me",
    () => Promise.resolve({ status: 409, body: { success: false, error: "closed", message: "這筆已是 applied，不再收驗證" } }));
  assertEquals([closed.status, (closed.body as R).error], [409, "closed"]);
  assert(String((closed.body as R).message).includes("applied"));
});

Deno.test("指向在庫列：有任務 → 改記 no_change confirmed；沒有任務 → already_exists、不寫入", async () => {
  const m = () => ({ type: "election", existing: [{ id: E1 }], pending: [] });
  const task = "auto:election_discovery:2027-04-30:131130:head";
  const a = fakeSupabase({ matches: m });
  const res = await handleContribute(a.api, "https://x", body(election(E1, { task_id: task })), "ip-me", noVote);
  assertEquals(res.status, 201);
  assertEquals(a.inserted.length, 1);
  const row = a.inserted[0];
  assertEquals(row.contribution_type, "no_change");
  assertEquals((row.payload as R).task_id, task);
  assertEquals((row.payload as R).outcome, "confirmed");
  assertEquals((row.payload as R).checked_urls, ["https://www.city.shibuya.tokyo.jp/kusei/senkyo/a.html"]);
  assert(String((row.payload as R).finding).includes(E1));

  const b = fakeSupabase({ matches: m });
  const res2 = await handleContribute(b.api, "https://x", body(election(E1)), "ip-me", noVote);
  assertEquals(res2.status, 201);
  assertEquals((res2.body as R).status, "already_exists");
  assertEquals(b.inserted.length, 0);
});

Deno.test("指的 id 不在比對結果 → 409 claim_mismatch；differs → 照常收", async () => {
  const m = () => ({ type: "election", existing: [{ id: E1 }], pending: [] });
  const a = fakeSupabase({ matches: m });
  const res = await handleContribute(a.api, "https://x", body(election("2027-04-18_ward_mayor_131130")), "ip-me", noVote);
  assertEquals([res.status, (res.body as R).error], [409, "claim_mismatch"]);
  assertEquals(a.inserted.length, 0);
  const b = fakeSupabase({ matches: m });
  const res2 = await handleContribute(b.api, "https://x", body(election(`differs:${E1}`, { note: "投票日は 4/25（選管の日程表 2026-10-01 版）。登録済みのものは 4/18 になっている" })), "ip-me", noVote);
  assertEquals(res2.status, 201);
  assertEquals(b.inserted.length, 1);
  assertEquals((b.inserted[0].payload as R).resolved_claim, `differs:${E1}`, "宣告留在 payload 裡，事後查得到");
});

Deno.test("一批：有收的、有擋的 → 201，被擋的標 not_accepted；同一批兩筆 new 是同一件事 → 只收第一筆", async () => {
  const stat = (key: string, resolved: string) => ({
    contribution_type: "regional_stat",
    payload: { lg_code: LG, stat_key: key, year: 2025, value: 100, unit: key === "population" ? "人" : "km2", resolved_claim: resolved },
    source_urls: ["https://www.e-stat.go.jp/stat-search/a"],
  });
  const { api, inserted } = fakeSupabase({
    matches: (_t, p) => p.stat_key === "area_km2" ? { type: "regional_stat", existing: [{ id: "77" }], pending: [] } : { type: "regional_stat", existing: [], pending: [] },
  });
  const res = await handleContribute(api, "https://x", { agent_name: "tester-1", contributions: [stat("population", "new"), stat("area_km2", "new"), { ...stat("population", "new"), source_urls: ["https://www.e-stat.go.jp/stat-search/b"] }] }, "ip-me", noVote);
  assertEquals(res.status, 201);
  assertEquals(inserted.length, 1);
  const results = (res.body as R).results as R[];
  assertEquals(results.map((r) => r.status), ["pending", "not_accepted", "not_accepted"]);
  assertEquals(results.map((r) => r.error ?? null), [null, "duplicate_claim", "duplicate_claim"]);

  const all = fakeSupabase({ matches: () => ({ type: "regional_stat", existing: [{ id: "77" }], pending: [] }) });
  const res2 = await handleContribute(all.api, "https://x", { agent_name: "tester-1", contributions: [stat("population", "new"), stat("area_km2", "new")] }, "ip-me", noVote);
  assertEquals([res2.status, (res2.body as R).success], [409, false], "全部被擋＝409");
});

Deno.test("claimKey 型別（no_change）：併票投不成、或同一台機器交過，都不再另收一筆", async () => {
  const TASK = "auto:local_government_missing:131130";
  const item = { contribution_type: "no_change", payload: { task_id: TASK, outcome: "not_found", checked_urls: ["https://www.soumu.go.jp/a"], finding: "総務省の団体コード表に該当なし" }, source_urls: ["https://www.soumu.go.jp/a"] };
  const other = { id: C1, contribution_type: "no_change", payload: item.payload, agent_name: "AaBb", contributor_ip_hash: "ip-other", status: "pending" };
  const a = fakeSupabase({ candidates: [other] });
  const res = await handleContribute(a.api, "https://x", body(item), "ip-me",
    () => Promise.resolve({ status: 409, body: { success: false, error: "already_voted", message: "這個來源已對這筆投過票" } }));
  assertEquals([res.status, (res.body as R).error], [409, "already_voted"]);
  assertEquals(a.inserted.length, 0, "正見會照原路收下；日本站不收");
  const b = fakeSupabase({ candidates: [{ ...other, contributor_ip_hash: "ip-me" }] });
  const res2 = await handleContribute(b.api, "https://x", body(item), "ip-me", noVote);
  assertEquals([res2.status, (res2.body as R).error], [409, "already_voted"], "同一台機器交過同一件事");
  assertEquals(b.inserted.length, 0);
});
