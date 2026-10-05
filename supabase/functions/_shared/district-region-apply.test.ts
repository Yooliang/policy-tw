import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
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

Deno.test("applyCandidacy：沒有 electoral_district、regions 也沒有縣市層級的列 → region_id 還是空的，但訊息要講出來", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [{ id: 501, region: "台北市", sub_region: "第02選舉區" }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ election_type: "縣市長" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id ?? null, null);
  // 靜靜地寫 NULL 是這次要修掉的行為：撈不到人、也沒人知道
  assertStringIncludes(outcome.message ?? "", "還沒有對到地區");
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

/**
 * 選區對不上時落回縣市層級（2026-10-04，見 apply-contribution.ts 的 countyRegionPatch）。
 * 盤點當下有 102 筆 2026 已登記的參選紀錄 region_id 是空的，用任何縣市篩選都撈不到、也不報錯。
 */
const COUNTY = { id: 900, region: "台北市", sub_region: null, village: null };

Deno.test("applyCandidacy：縣市長沒有選區 → region_id 指到縣市層級那一列", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [COUNTY, { id: 501, region: "台北市", sub_region: "第02選舉區" }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ election_type: "縣市長" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id, 900);
});

Deno.test("applyCandidacy：縣市議員的選區對不上 regions → 落到縣市層級，並在訊息裡要代理補選區", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [COUNTY, { id: 501, region: "台北市", sub_region: "第02選舉區" }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ electoral_district: "第99選舉區" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id, 900, "選區對不上也要至少記到縣市");
  assertStringIncludes(outcome.message ?? "", "只記到縣市");
  assertEquals((tables.get("regions") ?? []).length, 2, "不能因為查不到就新建 regions 列");
});

Deno.test("applyCandidacy：選區對得到時不會被縣市退路蓋掉", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [COUNTY, { id: 501, region: "台北市", sub_region: "第02選舉區" }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ electoral_district: "第02選舉區" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id, 501);
  assertEquals(outcome.message?.includes("只記到縣市"), false);
});

Deno.test("applyCandidacy：既有紀錄已經指到選舉區，重交沒帶選區時不會被降級成縣市", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [COUNTY, { id: 501, region: "台北市", sub_region: "第02選舉區" }],
    politician_elections: [{ id: 9001, politician_id: POL, election_id: 2026, election_type: "縣市議員", candidate_status: "registered", region_id: 501 }],
  });
  const outcome = await applyContribution(client, candidacyRow());
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.id === 9001);
  assertEquals(row?.region_id, 501, "已經有選舉區層級的 region_id 就不要動它");
});

Deno.test("applyCandidacy：鄉鎮層級的選舉不套縣市退路（那個空值是 township_gap 派任務的訊號）", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [COUNTY],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ election_type: "鄉鎮市民代表" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id ?? null, null, "沒填 sub_region 就該留空，讓 township_gap 派補鄉鎮的任務");
  assertEquals(outcome.message?.includes("還沒有對到地區"), false);
});

/**
 * 補縣市／補選區的自動派工（2026-10-05，contribution_auto_tasks_region_gap）收尾時走的就是這條：
 * 代理用 candidacy 重交同一人同一屆、帶 electoral_district。下面幾個 case 守住「重交之後缺口真的會消失」，
 * 不然任務會一直派回來。
 */
Deno.test("applyCandidacy：既有紀錄只到縣市，重交帶選區 → 升到選舉區那一列（補選區任務的收尾）", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [COUNTY, { id: 501, region: "台北市", sub_region: "第02選舉區" }],
    politician_elections: [{ id: 9001, politician_id: POL, election_id: 2026, election_type: "縣市議員", candidate_status: "registered", region_id: 900 }],
  });
  const outcome = await applyContribution(client, candidacyRow({ electoral_district: "第02選舉區" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.id === 9001);
  assertEquals(row?.region_id, 501);
});

Deno.test("applyCandidacy：既有紀錄只到縣市，重交的選區對不上 → 地區不動，但訊息要講出來", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [COUNTY, { id: 501, region: "台北市", sub_region: "第02選舉區" }],
    politician_elections: [{ id: 9001, politician_id: POL, election_id: 2026, election_type: "縣市議員", candidate_status: "registered", region_id: 900 }],
  });
  const outcome = await applyContribution(client, candidacyRow({ electoral_district: "第99選舉區" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.id === 9001);
  assertEquals(row?.region_id, 900);
  assertStringIncludes(outcome.message ?? "", "對不上");
});

const LEGISLATOR = { election_id: 2024, election_type: "立法委員", candidate_status: "confirmed" };

Deno.test("applyCandidacy：區域立委 → 指到「<縣市>第NN選區」那一列（regions 用的是中選會原字「臺」）", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [{ id: 700, region: "台中市", sub_region: "臺中市第01選區", village: null }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ ...LEGISLATOR, region: "台中市", electoral_district: "第1選區" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id, 700);
  assertEquals(outcome.message?.includes("選區"), false, "對到了就不該再要代理補選區");
});

Deno.test("applyCandidacy：不分區立委 → 指到「全國／不分區」，沒有就建一列，第二位沿用同一列", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }, { id: "p2", name: "李小華", merged_into: null }],
    regions: [{ id: 1, region: "全國", sub_region: "全國", village: null }],
    politician_elections: [],
  });
  const first = await applyContribution(client, candidacyRow({ ...LEGISLATOR, region: "全國", electoral_district: "不分區", election_result: "elected" }));
  assertEquals(first.status, "applied");
  const atLarge = (tables.get("regions") ?? []).find((r) => r.region === "全國" && r.sub_region === "不分區");
  assertEquals(typeof atLarge?.id, "number", "要建出「全國／不分區」那一列");
  const second = await applyContribution(client, {
    ...candidacyRow({ ...LEGISLATOR, politician_id: "p2", name: "李小華", region: "全國", electoral_district: "全國不分區" }),
    id: "c2",
  });
  assertEquals(second.status, "applied");
  const rows = tables.get("politician_elections") ?? [];
  assertEquals(rows.find((r) => r.politician_id === POL)?.region_id, atLarge?.id);
  assertEquals(rows.find((r) => r.politician_id === "p2")?.region_id, atLarge?.id);
  assertEquals((tables.get("regions") ?? []).filter((r) => r.sub_region === "不分區").length, 1, "第二位不可以再建一列");
});

Deno.test("applyCandidacy：區域立委選區對不上 → 落到縣市層級，訊息教他立委的選區怎麼寫", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [COUNTY],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ ...LEGISLATOR, electoral_district: "第09選區" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id, 900);
  assertStringIncludes(outcome.message ?? "", "第NN選區");
  assertEquals((tables.get("regions") ?? []).length, 1, "區域選區查不到不新建");
});

Deno.test("applyCandidacy：立委填「全國」卻沒給選區 → 留空，訊息講出不分區／原住民怎麼填", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [{ id: 1, region: "全國", sub_region: "全國", village: null }],
    politician_elections: [],
  });
  const outcome = await applyContribution(client, candidacyRow({ ...LEGISLATOR, region: "全國" }));
  assertEquals(outcome.status, "applied");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id ?? null, null);
  assertStringIncludes(outcome.message ?? "", "平地原住民");
});

/**
 * 原住民選區的 regions 列（2026-10-05）：花蓮、台東、屏東、苗栗、新竹縣等縣市的原住民選區 regions 一列都沒有。
 * cec-sync 補抓原住民選區之後，補選區／當選缺紀錄任務會請代理填這些選區；有官方根據（中選會名單上有、
 * 或查證過的保留議席清單）才建列，其他照舊不建。
 */
const HUALIEN = { id: 950, region: "花蓮縣", sub_region: null, village: null };
const CEC_HUALIEN_05 = { id: 1, election_id: 2022, election_type: "縣市議員", region: "花蓮縣", sub_region: "第05選舉區", name: "蔡依靜" };

Deno.test("applyCandidacy：2022 花蓮縣第05選舉區（平地原住民）regions 沒有、中選會名單上有 → 建一列並指過去", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [HUALIEN],
    politician_elections: [],
    cec_candidates: [CEC_HUALIEN_05],
  });
  const outcome = await applyContribution(client, candidacyRow({ election_id: 2022, region: "花蓮縣", electoral_district: "第05選舉區", candidate_status: "confirmed" }));
  assertEquals(outcome.status, "applied");
  const created = (tables.get("regions") ?? []).find((r) => r.region === "花蓮縣" && r.sub_region === "第05選舉區");
  assertEquals(typeof created?.id, "number", "要建出「花蓮縣 第05選舉區」");
  assertEquals(created?.village, null);
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id, created?.id);
  assertEquals(outcome.message?.includes("只記到縣市"), false);
});

Deno.test("applyCandidacy：代理寫「臺東縣」→ 建出來的列用「台東縣」，第二位同選區沿用同一列", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }, { id: "p2", name: "李小華", merged_into: null }],
    regions: [],
    politician_elections: [],
    cec_candidates: [{ id: 2, election_id: 2022, election_type: "縣市議員", region: "台東縣", sub_region: "第12選舉區", name: "甲" }],
  });
  await applyContribution(client, candidacyRow({ election_id: 2022, region: "臺東縣", electoral_district: "第12選舉區", candidate_status: "confirmed" }));
  await applyContribution(client, {
    ...candidacyRow({ politician_id: "p2", name: "李小華", election_id: 2022, region: "台東縣", electoral_district: "第12選舉區", candidate_status: "confirmed" }),
    id: "c2",
  });
  const rows = (tables.get("regions") ?? []).filter((r) => r.sub_region === "第12選舉區");
  assertEquals(rows.map((r) => r.region), ["台東縣"], "只建一列、縣市用「台」");
  const pe = tables.get("politician_elections") ?? [];
  assertEquals(pe.find((r) => r.politician_id === POL)?.region_id, rows[0].id);
  assertEquals(pe.find((r) => r.politician_id === "p2")?.region_id, rows[0].id);
});

Deno.test("applyCandidacy：2026 桃園市第13選舉區（查證過的保留議席清單）regions 沒有 → 建一列", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [],
    politician_elections: [],
  });
  await applyContribution(client, candidacyRow({ region: "桃園市", electoral_district: "第13選舉區" }));
  const created = (tables.get("regions") ?? []).find((r) => r.region === "桃園市" && r.sub_region === "第13選舉區");
  assertEquals(typeof created?.id, "number");
});

Deno.test("applyCandidacy：中選會名單上沒有這個選區（花蓮縣第11選舉區）→ 照舊不建、落到縣市層級", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    regions: [HUALIEN],
    politician_elections: [],
    cec_candidates: [CEC_HUALIEN_05],
  });
  const outcome = await applyContribution(client, candidacyRow({ election_id: 2022, region: "花蓮縣", electoral_district: "第11選舉區", candidate_status: "confirmed" }));
  assertEquals(outcome.status, "applied");
  assertEquals((tables.get("regions") ?? []).length, 1, "沒有官方根據的選區不新建");
  const row = (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);
  assertEquals(row?.region_id, 950);
  assertStringIncludes(outcome.message ?? "", "只記到縣市");
});
