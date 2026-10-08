import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { applyContribution, repDistrictKey } from "./apply-contribution.ts";

/**
 * 代表（鄉鎮市民代表、直轄市山地原住民區民代表）的選舉區落庫（#464，2026-10-09）。
 * 代表的號次按選舉區編，參選紀錄要記得選舉區才檢查得了；選舉區記在 regions 的「<鄉鎮>第NN選舉區」那一列（2022 區民代表的既有形狀）。
 * 假資料庫同 district-region-apply.test.ts：支援 insert／update／maybeSingle 彼此讀得到。
 */

type Row = Record<string, unknown>;

function makeDb(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return api; },
      is: (col: string, val: unknown) => { filters.push((r) => (r[col] ?? null) === val); return api; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return api; },
      neq: (col: string, val: unknown) => { filters.push((r) => r[col] !== val); return api; },
      order: () => api,
      limit: () => api,
      maybeSingle: () => {
        const match = (tables.get(table) ?? []).find((r) => filters.every((f) => f(r))) ?? null;
        return Promise.resolve({ data: match, error: null });
      },
      then: (res: (v: { data: Row[]; error: null }) => unknown) => res({ data: (tables.get(table) ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
      insert: (row: Row | Row[]) => {
        const arr = Array.isArray(row) ? row : [row];
        const base = (tables.get(table) ?? []).length;
        const withIds = arr.map((r, i) => ({ id: base + i + 1, ...r }));
        tables.set(table, [...(tables.get(table) ?? []), ...withIds]);
        return { select: () => ({ maybeSingle: () => Promise.resolve({ data: withIds[0], error: null }) }) };
      },
      update: (patch: Row) => ({
        eq: (col: string, val: unknown) => {
          for (const r of tables.get(table) ?? []) if (r[col] === val) Object.assign(r, patch);
          return Promise.resolve({ error: null });
        },
      }),
    };
    return api;
  }
  return { client: { from }, tables };
}

const POL = "8aa6ee40-231a-447a-a967-99bcf8b35d3f";
const candidacyRow = (overrides: Row = {}) => ({
  id: "c1",
  contribution_type: "candidacy" as const,
  payload: {
    politician_id: POL, name: "林加友", election_id: 2026, election_type: "鄉鎮市民代表", region: "連江縣", sub_region: "北竿鄉",
    candidate_status: "registered", ...overrides,
  },
  source_urls: ["https://web.cec.gov.tw/api/file/00000000-0000-4000-8000-000000000000.pdf"],
  note: null, agent_name: "tester", contributor_url: null,
});
const peOf = (tables: Map<string, Row[]>) => (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);

Deno.test("R1 repDistrictKey：sub_region＋electoral_district 組出 鄉鎮＋第NN選舉區；寫法不同（第4、中文數字、整段寫在選舉區、臺→台）收斂成同一個", () => {
  const base = { region: "連江縣", election_id: 2026 };
  const want = { region: "連江縣", town: "北竿鄉", district: "第02選舉區" };
  assertEquals(repDistrictKey("鄉鎮市民代表", { ...base, sub_region: "北竿鄉", electoral_district: "第02選舉區" }), want);
  assertEquals(repDistrictKey("鄉鎮市民代表", { ...base, sub_region: "北竿鄉", electoral_district: "第 2 選舉區" }), want);
  assertEquals(repDistrictKey("鄉鎮市民代表", { ...base, sub_region: "北竿鄉", electoral_district: "第二選舉區" }), want);
  assertEquals(repDistrictKey("鄉鎮市民代表", { ...base, electoral_district: "北竿鄉第02選舉區" }), want, "鄉鎮寫在選舉區前面也行");
  assertEquals(repDistrictKey("鄉鎮市民代表", { ...base, sub_region: "北竿鄉第02選舉區", electoral_district: "第2選舉區" }), want, "sub_region 誤帶選舉區要去掉");
  assertEquals(repDistrictKey("鄉鎮市民代表", { ...base, region: "臺中市", sub_region: "臺西鄉", electoral_district: "第1選舉區" }), { region: "台中市", town: "台西鄉", district: "第01選舉區" });
  assertEquals(repDistrictKey("直轄市山地原住民區民代表", { region: "台中市", sub_region: "和平區", electoral_district: "第01選舉區" }), { region: "台中市", town: "和平區", district: "第01選舉區" });
});

Deno.test("R2 repDistrictKey：沒給選舉區、沒給鄉鎮、看不出第幾區、鄉鎮互相矛盾、別種選舉 → null（不猜）", () => {
  const base = { region: "連江縣", sub_region: "北竿鄉" };
  assertEquals(repDistrictKey("鄉鎮市民代表", base), null);
  assertEquals(repDistrictKey("鄉鎮市民代表", { region: "連江縣", electoral_district: "第02選舉區" }), null, "沒有鄉鎮");
  assertEquals(repDistrictKey("鄉鎮市民代表", { ...base, electoral_district: "蘭嶼鄉選舉區" }), null, "沒有號碼的單一選區寫法不認");
  assertEquals(repDistrictKey("鄉鎮市民代表", { ...base, electoral_district: "南竿鄉第01選舉區" }), null, "sub_region 與選舉區前面的鄉鎮不一致");
  assertEquals(repDistrictKey("縣市議員", { region: "台北市", electoral_district: "第02選舉區" }), null, "議員走自己的 districtRegionPatch");
  assertEquals(repDistrictKey("村里長", { ...base, electoral_district: "第02選舉區" }), null);
});

Deno.test("R3 落庫：代表帶選舉區、regions 有「北竿鄉第02選舉區」→ region_id 指過去（不是鄉鎮那一列）", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "林加友", merged_into: null }],
    regions: [{ id: 10, region: "連江縣", sub_region: "北竿鄉", village: null }, { id: 11, region: "連江縣", sub_region: "北竿鄉第02選舉區", village: null }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ electoral_district: "第02選舉區" }));
  assertEquals(outcome.status, "applied");
  assertEquals(peOf(tables)?.region_id, 11);
  assertEquals(outcome.message.includes("沒有對上"), false);
});

Deno.test("R4 落庫：regions 沒有那一列，但中選會登記彙總表有這個鄉鎮的這一區 → 新建一列（形狀同既有）並指過去", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "林加友", merged_into: null }],
    regions: [{ id: 10, region: "連江縣", sub_region: "北竿鄉", village: null }],
    cec_registrations: [{ id: 1, election_id: 2026, election_type: "鄉鎮市民代表", region: "連江縣", sub_region: "北竿鄉", district: "第02選舉區" }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ electoral_district: "第2選舉區" }));
  assertEquals(outcome.status, "applied");
  const made = (tables.get("regions") ?? []).find((r) => r.sub_region === "北竿鄉第02選舉區");
  assertEquals(made?.region, "連江縣");
  assertEquals(made?.village ?? null, null);
  assertEquals(peOf(tables)?.region_id, made?.id);
});

Deno.test("R5 落庫：已投票屆別（2022）沒有登記彙總表，靠中選會名單 cec_candidates 的選舉區當根據", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "林加友", merged_into: null }],
    regions: [],
    cec_candidates: [{ id: 1, election_id: 2022, election_type: "鄉鎮市民代表", region: "連江縣", sub_region: "北竿鄉第02選舉區" }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ election_id: 2022, electoral_district: "第02選舉區" }));
  assertEquals(outcome.status, "applied");
  assertEquals((tables.get("regions") ?? []).map((r) => r.sub_region).sort(), ["北竿鄉第02選舉區", "北竿鄉"].sort());
});

Deno.test("R6 落庫：選舉區沒有官方根據（名冊與中選會名單都沒有這一區）→ 不新建 regions 列，退回鄉鎮那一列，回覆講出來", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "林加友", merged_into: null }],
    regions: [{ id: 10, region: "連江縣", sub_region: "北竿鄉", village: null }],
    cec_registrations: [{ id: 1, election_id: 2026, election_type: "鄉鎮市民代表", region: "連江縣", sub_region: "北竿鄉", district: "第02選舉區" }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ electoral_district: "第09選舉區" }));
  assertEquals(outcome.status, "applied");
  assertEquals((tables.get("regions") ?? []).length, 1, "不能因為交件這樣寫就新建");
  assertEquals(peOf(tables)?.region_id, 10);
  assertStringIncludes(outcome.message, "沒有對上");
});

Deno.test("R7 落庫：沒帶選舉區的代表交件，行為跟以前一樣（鄉鎮那一列），回覆不多話", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "林加友", merged_into: null }],
    regions: [{ id: 10, region: "連江縣", sub_region: "北竿鄉", village: null }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow());
  assertEquals(peOf(tables)?.region_id, 10);
  assertEquals(outcome.message.includes("沒有對上"), false);
});

Deno.test("R8 已經記了選舉區的代表，重交（補號次、改狀態）只帶鄉鎮 → region_id 不降回鄉鎮；帶了別區的選舉區 → 改指新的那一區", async () => {
  const seed = () => makeDb({
    politicians: [{ id: POL, name: "林加友", merged_into: null }],
    regions: [
      { id: 10, region: "連江縣", sub_region: "北竿鄉", village: null },
      { id: 11, region: "連江縣", sub_region: "北竿鄉第02選舉區", village: null },
      { id: 12, region: "連江縣", sub_region: "北竿鄉第05選舉區", village: null },
    ],
    politician_elections: [{ id: 1, politician_id: POL, election_id: 2026, election_type: "鄉鎮市民代表", region_id: 11, candidacy_status: "filed" }],
  });
  const a = seed();
  await applyContribution(a.client, candidacyRow({ cand_no: 3 }));
  assertEquals(peOf(a.tables)?.region_id, 11, "沒帶選舉區：不降級");
  assertEquals(peOf(a.tables)?.cand_no, 3, "號次照樣寫進去");
  const b = seed();
  await applyContribution(b.client, candidacyRow({ electoral_district: "第05選舉區" }));
  assertEquals(peOf(b.tables)?.region_id, 12, "帶了別區的選舉區：照新的記");
  const c = seed();
  await applyContribution(c.client, candidacyRow({ sub_region: "南竿鄉" }));
  assertEquals(peOf(c.tables)?.region_id !== 11, true, "改填別的鄉鎮：不是同一個鄉鎮的選舉區列，不保留");
});

Deno.test("R9 縣市議員不受影響：議員帶 electoral_district 還是走自己的選舉區列", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "林加友", merged_into: null }],
    regions: [{ id: 501, region: "台北市", sub_region: "第02選舉區", village: null }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ election_type: "縣市議員", region: "台北市", sub_region: undefined, electoral_district: "第02選舉區" }));
  assertEquals(outcome.status, "applied");
  assertEquals(peOf(tables)?.region_id, 501);
});
