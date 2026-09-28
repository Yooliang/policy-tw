import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleContribute } from "./contribute-handler.ts";
import { resetDistrictRegistryCache } from "./district-registry.ts";

/**
 * 交件時自動統一選區寫法＋驗證選區存在（2026-09-28，見 docs/DISTRICT-REGISTRY-2026.md 的後續工作）。
 *
 * 走真的 handleContribute（假 supabase＋假投票端），跟 apply-precheck.test.ts 同一套假 client 寫法。
 */

type TableConfig = { data?: unknown[]; error?: { message: string } | null };

function fakeSupabase(tables: Record<string, TableConfig>) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      const cfg = tables[table];
      const result = { data: cfg?.data ?? [], error: cfg?.error ?? null, count: 0 };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: (result.data as Array<Record<string, unknown>>)[0] ?? null, error: result.error }),
        insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
          const arr = Array.isArray(rows) ? rows : [rows];
          for (const r of arr) inserted.push({ table, row: r });
          return {
            select: () => ({ data: arr.map((r, i) => ({ id: `new-${i}`, payload_hash: (r as { payload_hash?: string }).payload_hash })), error: null }),
          };
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

const TAIPEI_2026_ROWS = [
  { region: "台北市", electoral_district: "第01選舉區" },
  { region: "台北市", electoral_district: "第02選舉區" },
  { region: "台北市", electoral_district: "第06選舉區" },
];

function candidacyBody(overrides: Record<string, unknown> = {}) {
  return {
    agent_name: "tester",
    contribution_type: "candidacy",
    payload: {
      politician_id: POLITICIAN_ID,
      election_id: 2026,
      election_type: "縣市議員",
      region: "台北市",
      candidate_status: "registered",
      ...overrides,
    },
    source_urls: ["https://db.cec.gov.tw/test"],
  };
}

const politiciansOk = { data: [{ id: POLITICIAN_ID, merged_into: null }] };

Deno.test("candidacy：electoral_district 寫法不統一，正規化後在名冊裡 → 照常收，payload 已經是標準寫法", async () => {
  resetDistrictRegistryCache();
  const { client, inserted } = fakeSupabase({
    politicians: politiciansOk,
    electoral_district_areas: { data: TAIPEI_2026_ROWS },
  });
  const res = await handleContribute(client, "https://x", candidacyBody({ electoral_district: "第6選區" }), "ip-1", noVote);
  assertEquals(res.status, 201, JSON.stringify(res.body));
  const row = inserted.find((r) => r.table === "contributions");
  assertEquals((row?.row.payload as Record<string, unknown>).electoral_district, "第06選舉區");
});

Deno.test("candidacy：沒給 electoral_district，從 position 抽出來再驗證", async () => {
  resetDistrictRegistryCache();
  const { client, inserted } = fakeSupabase({
    politicians: politiciansOk,
    electoral_district_areas: { data: TAIPEI_2026_ROWS },
  });
  const res = await handleContribute(client, "https://x", candidacyBody({ position: "台北市議員第2選舉區候選人" }), "ip-1", noVote);
  assertEquals(res.status, 201, JSON.stringify(res.body));
  const row = inserted.find((r) => r.table === "contributions");
  assertEquals((row?.row.payload as Record<string, unknown>).electoral_district, "第02選舉區");
  assertEquals((row?.row.payload as Record<string, unknown>).position, "台北市議員第2選舉區候選人");
});

Deno.test("candidacy：選區號碼是該縣市的原住民保留議席 → 照常收（即使名冊裡沒有這個號碼）", async () => {
  resetDistrictRegistryCache();
  const { client } = fakeSupabase({
    politicians: politiciansOk,
    electoral_district_areas: { data: TAIPEI_2026_ROWS },
  });
  const res = await handleContribute(client, "https://x", candidacyBody({ electoral_district: "第7選舉區" }), "ip-1", noVote);
  assertEquals(res.status, 201, JSON.stringify(res.body));
});

Deno.test("candidacy：名冊裡有這個縣市，選區號碼卻兩邊都對不上 → 400 unknown_electoral_district，不算被拒", async () => {
  resetDistrictRegistryCache();
  const { client, inserted } = fakeSupabase({
    politicians: politiciansOk,
    electoral_district_areas: { data: TAIPEI_2026_ROWS },
  });
  const res = await handleContribute(client, "https://x", candidacyBody({ electoral_district: "第99選舉區" }), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "unknown_electoral_district");
  assert(String((res.body as Record<string, unknown>).message).includes("第01選舉區"), "訊息要列出有效選區");
  assertEquals(inserted.filter((r) => r.table === "contributions").length, 0, "查到問題不該落庫任何東西");
});

Deno.test("candidacy：名冊裡沒有這個縣市（例如新竹縣 2026 還沒公告）→ 不擋，照常收", async () => {
  resetDistrictRegistryCache();
  const { client } = fakeSupabase({
    politicians: politiciansOk,
    electoral_district_areas: { data: TAIPEI_2026_ROWS }, // 只有台北市的資料
  });
  const res = await handleContribute(
    client,
    "https://x",
    { ...candidacyBody({ region: "新竹縣", electoral_district: "第11選舉區" }) },
    "ip-1",
    noVote,
  );
  assertEquals(res.status, 201, JSON.stringify(res.body));
});

Deno.test("candidacy：electoral_district_areas 查詢本身出錯 → 不擋，照常收", async () => {
  resetDistrictRegistryCache();
  const { client } = fakeSupabase({
    politicians: politiciansOk,
    electoral_district_areas: { data: [], error: { message: "boom：連線逾時" } },
  });
  const res = await handleContribute(client, "https://x", candidacyBody({ electoral_district: "第99選舉區" }), "ip-1", noVote);
  assertEquals(res.status, 201, "查詢出錯不能擋代理");
});

Deno.test("candidacy：election_type 不是縣市議員，不做選區驗證（電話選區欄位是縣市議員專屬）", async () => {
  resetDistrictRegistryCache();
  const { client } = fakeSupabase({
    politicians: politiciansOk,
    electoral_district_areas: { data: TAIPEI_2026_ROWS },
  });
  const res = await handleContribute(
    client,
    "https://x",
    candidacyBody({ election_type: "縣市長", electoral_district: "第99選舉區" }),
    "ip-1",
    noVote,
  );
  assertEquals(res.status, 201, JSON.stringify(res.body));
});
