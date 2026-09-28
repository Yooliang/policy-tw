import { assertEquals } from "jsr:@std/assert";
import { checkElectoralDistrict, resetDistrictRegistryCache } from "./district-registry.ts";

/** 假 supabase：electoral_district_areas 回設定好的 rows；query error 用來測「查詢出錯不擋」 */
function fakeSupabase(rows: Array<{ region: string; electoral_district: string }> | null, error: { message: string } | null = null) {
  return {
    from(_table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        limit: () => Promise.resolve({ data: rows, error }),
      };
      return chain;
    },
  };
}

const ROWS_2026 = [
  { region: "台北市", electoral_district: "第01選舉區" },
  { region: "台北市", electoral_district: "第02選舉區" },
  { region: "彰化縣", electoral_district: "第01選舉區" },
];

Deno.test("checkElectoralDistrict：選區在名冊裡 → ok", async () => {
  resetDistrictRegistryCache();
  const client = fakeSupabase(ROWS_2026);
  const r = await checkElectoralDistrict(client, 2026, "台北市", "第01選舉區");
  assertEquals(r.status, "ok");
});

Deno.test("checkElectoralDistrict：原住民保留議席 → ok（即使名冊裡沒有這個號碼）", async () => {
  resetDistrictRegistryCache();
  const client = fakeSupabase(ROWS_2026);
  const r = await checkElectoralDistrict(client, 2026, "台北市", "第07選舉區");
  assertEquals(r.status, "ok");
});

Deno.test("checkElectoralDistrict：名冊有這個縣市、但選區號碼兩邊都對不上 → unknown，附有效選區清單", async () => {
  resetDistrictRegistryCache();
  const client = fakeSupabase(ROWS_2026);
  const r = await checkElectoralDistrict(client, 2026, "台北市", "第99選舉區");
  assertEquals(r.status, "unknown");
  assertEquals(r.validDistricts?.includes("第01選舉區"), true);
  assertEquals(r.validDistricts?.includes("第02選舉區"), true);
  assertEquals(r.validDistricts?.includes("第07選舉區"), true, "有效清單要含原住民保留議席，代理才知道還能填什麼");
});

Deno.test("checkElectoralDistrict：名冊裡沒有這個縣市（例如新竹縣 2026）→ no_registry，不擋", async () => {
  resetDistrictRegistryCache();
  const client = fakeSupabase(ROWS_2026);
  const r = await checkElectoralDistrict(client, 2026, "新竹縣", "第01選舉區");
  assertEquals(r.status, "no_registry");
});

Deno.test("checkElectoralDistrict：查詢本身出錯 → no_registry，不擋", async () => {
  resetDistrictRegistryCache();
  const client = fakeSupabase(null, { message: "boom：連線逾時" });
  const r = await checkElectoralDistrict(client, 2026, "台北市", "第01選舉區");
  assertEquals(r.status, "no_registry");
});

Deno.test("checkElectoralDistrict：同一個 electionId 短時間內重複查只打一次資料庫（記憶體快取）", async () => {
  resetDistrictRegistryCache();
  let calls = 0;
  const client = {
    from(_table: string) {
      calls++;
      // deno-lint-ignore no-explicit-any
      const chain: any = { select: () => chain, eq: () => chain, limit: () => Promise.resolve({ data: ROWS_2026, error: null }) };
      return chain;
    },
  };
  await checkElectoralDistrict(client, 2026, "台北市", "第01選舉區");
  await checkElectoralDistrict(client, 2026, "彰化縣", "第01選舉區");
  assertEquals(calls, 1, "第二次查詢應該吃快取，不再打資料庫");
});

// 主線 09-28：原住民保留議席沒查證的縣市，大於一般選區最大號的放行；一般範圍內對不上的照擋
Deno.test("未查證原住民議席的縣市：超過一般選區號碼放行、範圍內對不上照擋", async () => {
  resetDistrictRegistryCache();
  const rows = [{ region: "屏東縣", electoral_district: "第01選舉區" }, { region: "屏東縣", electoral_district: "第07選舉區" }];
  const db = { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }) };
  assertEquals((await checkElectoralDistrict(db, 2026, "屏東縣", "第09選舉區")).status, "ok");
  assertEquals((await checkElectoralDistrict(db, 2026, "屏東縣", "第03選舉區")).status, "unknown");
});
