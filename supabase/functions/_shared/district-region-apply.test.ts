import { assertEquals } from "jsr:@std/assert@1";
import { applyContribution } from "./apply-contribution.ts";

/**
 * 落庫時把縣市議員候選人的 region_id 指到 regions 表對應列（2026-09-28，見 apply-contribution.ts
 * 的 districtRegionPatch）。這裡需要一個支援 insert／update／maybeSingle 都讀得到彼此寫入結果的假
 * db，比 apply-precheck.test.ts 的「表名固定回覆」再完整一點；只鋪陳 applyCandidacy 這條路徑會摸到的表。
 */

type Row = Record<string, unknown>;

function makeDb(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const inserted: Array<{ table: string; row: Row }> = [];

  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return api;
      },
      is: (col: string, val: unknown) => {
        filters.push((r) => (r[col] ?? null) === val);
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      neq: (col: string, val: unknown) => {
        filters.push((r) => r[col] !== val);
        return api;
      },
      order: () => api,
      limit: () => api,
      maybeSingle: () => {
        const rows = tables.get(table) ?? [];
        const match = rows.find((r) => filters.every((f) => f(r))) ?? null;
        return Promise.resolve({ data: match, error: null });
      },
      then: (res: (v: { data: Row[]; error: null }) => unknown) => {
        const rows = tables.get(table) ?? [];
        return res({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
      },
      insert: (row: Row | Row[]) => {
        const arr = Array.isArray(row) ? row : [row];
        const base = (tables.get(table) ?? []).length;
        const withIds = arr.map((r, i) => ({ id: base + i + 1, ...r }));
        tables.set(table, [...(tables.get(table) ?? []), ...withIds]);
        for (const r of withIds) inserted.push({ table, row: r });
        return {
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: withIds[0], error: null }),
          }),
        };
      },
      update: (patch: Row) => ({
        eq: (col: string, val: unknown) => {
          const rows = tables.get(table) ?? [];
          for (const r of rows) if (r[col] === val) Object.assign(r, patch);
          return Promise.resolve({ error: null });
        },
      }),
    };
    return api;
  }

  return { client: { from }, tables, inserted };
}

const POL = "8aa6ee40-231a-447a-a967-99bcf8b35d3f";

function candidacyRow(overrides: Row = {}) {
  return {
    id: "c1",
    contribution_type: "candidacy" as const,
    payload: {
      politician_id: POL,
      name: "王小明",
      election_id: 2026,
      election_type: "縣市議員",
      region: "台北市",
      candidate_status: "registered",
      ...overrides,
    },
    source_urls: ["https://db.cec.gov.tw/x"],
    note: null,
    agent_name: "tester",
    contributor_url: null,
  };
}

Deno.test("applyCandidacy：electoral_district 在 regions 表有對應列 → politician_elections.region_id 指過去", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [{ id: 501, region: "台北市", sub_region: "第02選舉區" }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ electoral_district: "第02選舉區" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id, 501);
});

Deno.test("applyCandidacy：regions 表沒有對應列 → 不動 region_id、也不新建 regions 列", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ electoral_district: "第99選舉區" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id ?? null, null, "regions 沒有對應列就不該有 region_id");
  assertEquals((tables.get("regions") ?? []).length, 0, "不能因為查不到就新建 regions 列");
});

Deno.test("applyCandidacy：沒有 electoral_district（例如縣市長候選人）→ 不查 regions、不動 region_id", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [{ id: 501, region: "台北市", sub_region: "第02選舉區" }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ election_type: "縣市長" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id ?? null, null);
});

Deno.test("applyCandidacy：既有參選紀錄再交一次，regions 對得到 → 更新時也補上 region_id", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [{ id: 501, region: "台北市", sub_region: "第02選舉區" }],
    politician_elections: [{ id: 9001, politician_id: POL, election_id: 2026, election_type: "縣市議員", candidate_status: "registered", region_id: null }],
  });
  const outcome = await applyContribution(client, candidacyRow({ electoral_district: "第02選舉區" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.id === 9001);
  assertEquals(row?.region_id, 501);
});
