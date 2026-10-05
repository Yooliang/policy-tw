import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleContribute } from "./contribute-handler.ts";

/**
 * 得票數、得票率不收（#345，協議 1.51.0）：candidacy 帶了照收這筆（不擋件），回覆的 warning 講一聲那兩欄略過。
 * 走真的 handleContribute（假 supabase＋假投票端），跟 district-gate.test.ts 同一套假 client 寫法。
 */

type TableConfig = { data?: unknown[] };

function fakeSupabase(tables: Record<string, TableConfig>) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      const result = { data: tables[table]?.data ?? [], error: null, count: 0 };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: (result.data as Array<Record<string, unknown>>)[0] ?? null, error: null }),
        insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
          const arr = Array.isArray(rows) ? rows : [rows];
          for (const r of arr) inserted.push({ table, row: r });
          return { select: () => ({ data: arr.map((r, i) => ({ id: `new-${i}`, payload_hash: (r as { payload_hash?: string }).payload_hash })), error: null }) };
        },
        delete: () => ({ in: () => ({ error: null }) }),
        then: (res: (v: typeof result) => unknown) => res(result),
      };
      return chain;
    },
  };
  return { client, inserted };
}

const POLITICIAN_ID = "8aa6ee40-231a-447a-a967-99bcf8b35d3f";
const noVote = () => Promise.resolve({ status: 403, body: { error: "self_vote" } });
const body = (extra: Record<string, unknown>) => ({
  agent_name: "tester",
  contribution_type: "candidacy",
  payload: { politician_id: POLITICIAN_ID, election_id: 2022, election_type: "縣市長", region: "台北市", candidate_status: "confirmed", election_result: "elected", ...extra },
  source_urls: ["https://db.cec.gov.tw/test"],
});

Deno.test("candidacy 帶得票數、得票率：照收（201），回覆 warning 講那兩欄不收", async () => {
  const { client, inserted } = fakeSupabase({ politicians: { data: [{ id: POLITICIAN_ID, merged_into: null }] } });
  const res = await handleContribute(client, "https://x", body({ votes_received: 29150, vote_percentage: 53.7 }), "ip-1", noVote);
  assertEquals(res.status, 201, JSON.stringify(res.body));
  const warning = String((res.body as Record<string, unknown>).warning ?? "");
  assert(warning.includes("不收") && warning.includes("votes_received") && warning.includes("vote_percentage"), warning);
  assert(inserted.some((r) => r.table === "contributions"), "這筆要照收");
});

// #345 後續：任期的 id 跟參選紀錄一樣是整數、填錯一號就改到別人——reason 要寫出本人姓名
Deno.test("任期更正：reason 沒寫到本人姓名 → 400 reason_missing_target_name；寫了就照收", async () => {
  const office = { politician_offices: { data: [{ id: 5, election_id: 2022, politicians: { name: "王小明" } }] } };
  const req = (reason: string) => ({
    agent_name: "tester", contribution_type: "correction", source_urls: ["https://www.tcc.gov.tw/x"],
    payload: { target_table: "politician_offices", target_id: "5", reason, changes: [{ field: "end_date", current_value: "2024-01-31", correct_value: "2024-01-15" }] },
  });
  const bad = await handleContribute(fakeSupabase(office).client, "https://x", req("議會公告 2024-01-15 辭職生效"), "ip-1", noVote);
  assertEquals(bad.status, 400, JSON.stringify(bad.body));
  assertEquals((bad.body as Record<string, unknown>).error, "reason_missing_target_name");
  const good = await handleContribute(fakeSupabase(office).client, "https://x", req("議會公告王小明 2024-01-15 辭職生效"), "ip-1", noVote);
  assertEquals(good.status, 201, JSON.stringify(good.body));
});

Deno.test("candidacy 沒帶票數：沒有 warning", async () => {
  const { client } = fakeSupabase({ politicians: { data: [{ id: POLITICIAN_ID, merged_into: null }] } });
  const res = await handleContribute(client, "https://x", body({}), "ip-1", noVote);
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals((res.body as Record<string, unknown>).warning, undefined);
});
