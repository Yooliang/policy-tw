import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { applyContribution } from "./apply-contribution.ts";

/**
 * #345 後續（協調者 10-06 裁定）：
 *   - confirmed 收窄：只表示表態參選；正式名單公告後（含已投票屆別）落庫記成 qualified，回覆講一聲；早期匯入的 confirmed 原樣重交不改
 *   - 任期的卸任日附出處更正：根據換成 source、出處記第一個網址；在任中的要連原因一起給
 * 假 db 跟 district-region-apply.test.ts 同一套，多一個 rpc（candidacy_list_published）。
 */

type Row = Record<string, unknown>;

function makeDb(seed: Record<string, Row[]>, listPublished: boolean | "no-rpc") {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const rpcCalls: Array<{ name: string; args: Row }> = [];
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => { filters.push((r) => String(r[col]) === String(val)); return api; },
      is: (col: string, val: unknown) => { filters.push((r) => (r[col] ?? null) === val); return api; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return api; },
      neq: (col: string, val: unknown) => { filters.push((r) => r[col] !== val); return api; },
      order: () => api,
      limit: () => api,
      maybeSingle: () => Promise.resolve({ data: (tables.get(table) ?? []).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      then: (res: (v: { data: Row[]; error: null }) => unknown) => res({ data: (tables.get(table) ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
      insert: (row: Row | Row[]) => {
        const arr = Array.isArray(row) ? row : [row];
        const base = (tables.get(table) ?? []).length;
        const withIds = arr.map((r, i) => ({ id: base + i + 1, ...r }));
        tables.set(table, [...(tables.get(table) ?? []), ...withIds]);
        // deno-lint-ignore no-explicit-any
        const done: any = Promise.resolve({ error: null });
        done.select = () => ({ maybeSingle: () => Promise.resolve({ data: withIds[0], error: null }) });
        return done;
      },
      update: (patch: Row) => ({
        eq: (col: string, val: unknown) => {
          for (const r of tables.get(table) ?? []) if (String(r[col]) === String(val)) Object.assign(r, patch);
          return Promise.resolve({ error: null });
        },
      }),
    };
    return api;
  }
  // deno-lint-ignore no-explicit-any
  const client: any = { from };
  if (listPublished !== "no-rpc") {
    client.rpc = (name: string, args: Row) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(name === "candidacy_list_published" ? { data: listPublished, error: null } : { data: null, error: null });
    };
  }
  return { client, tables, rpcCalls };
}

const POL = "8aa6ee40-231a-447a-a967-99bcf8b35d3f";
const base = { note: null, agent_name: "tester", contributor_url: null, source_urls: ["https://web.cec.gov.tw/announce/1"] };
const candidacy = (status: string) => ({
  ...base, id: "c1", contribution_type: "candidacy" as const,
  payload: { politician_id: POL, name: "王小明", election_id: 2026, election_type: "縣市長", region: "台北市", candidate_status: status },
});
const peOf = (tables: Map<string, Row[]>) => (tables.get("politician_elections") ?? []).find((r) => r.politician_id === POL);

Deno.test("名單公告後交 confirmed：記成 qualified，回覆講一聲；有問名單公告了沒", async () => {
  const { client, tables, rpcCalls } = makeDb({ politicians: [{ id: POL, name: "王小明", merged_into: null }], politician_elections: [] }, true);
  const out = await applyContribution(client, candidacy("confirmed"));
  assertEquals(out.status, "applied");
  assertEquals(peOf(tables)?.candidate_status, "qualified");
  assertStringIncludes(String(out.message), "qualified");
  assertEquals(rpcCalls[0]?.name, "candidacy_list_published");
  assertEquals(rpcCalls[0]?.args.p_election_type, "縣市長");
});

Deno.test("名單還沒公告交 confirmed：照存（表態參選）", async () => {
  const { client, tables } = makeDb({ politicians: [{ id: POL, name: "王小明", merged_into: null }], politician_elections: [] }, false);
  await applyContribution(client, candidacy("confirmed"));
  assertEquals(peOf(tables)?.candidate_status, "confirmed");
});

Deno.test("早期匯入的 confirmed 原樣重交（補選區任務叫代理照現況填）：不順手改", async () => {
  const { client, tables } = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    politician_elections: [{ id: 9, politician_id: POL, election_id: 2026, election_type: "縣市長", candidate_status: "confirmed" }],
  }, true);
  const out = await applyContribution(client, candidacy("confirmed"));
  assertEquals(peOf(tables)?.candidate_status, "confirmed");
  assertEquals(String(out.message).includes("qualified"), false);
});

Deno.test("查不到名單公告了沒（沒有 rpc）：照原值寫，不猜", async () => {
  const { client, tables } = makeDb({ politicians: [{ id: POL, name: "王小明", merged_into: null }], politician_elections: [] }, "no-rpc");
  await applyContribution(client, candidacy("confirmed"));
  assertEquals(peOf(tables)?.candidate_status, "confirmed");
});

Deno.test("registered 不受影響、不問名單", async () => {
  const { client, tables, rpcCalls } = makeDb({ politicians: [{ id: POL, name: "王小明", merged_into: null }], politician_elections: [] }, true);
  await applyContribution(client, candidacy("registered"));
  assertEquals(peOf(tables)?.candidate_status, "registered");
  assertEquals(rpcCalls.length, 0);
});

const correction = (target_table: string, target_id: string, changes: Row[]) => ({
  ...base, id: "k1", contribution_type: "correction" as const,
  payload: { target_table, target_id, reason: "王小明的名冊與議會公告", changes },
});

Deno.test("correction 改參選狀態成 confirmed、名單已公告：記成 qualified", async () => {
  const { client, tables } = makeDb({
    politician_elections: [{ id: "77", politician_id: POL, election_id: 2026, election_type: "縣市議員", candidate_status: "registered" }],
  }, true);
  const out = await applyContribution(client, correction("politician_elections", "77", [{ field: "candidate_status", current_value: "registered", correct_value: "confirmed" }]));
  assertEquals(out.status, "applied");
  assertEquals((tables.get("politician_elections") ?? [])[0].candidate_status, "qualified");
  assertStringIncludes(String(out.message), "qualified");
});

Deno.test("任期的推定卸任日附出處更正：根據換成 source、出處記第一個網址", async () => {
  const { client, tables } = makeDb({
    politician_offices: [{ id: "5", politician_id: POL, end_date: "2024-01-31", end_reason: "took_other_office", end_basis: "inferred", source_url: null }],
  }, true);
  const out = await applyContribution(client, correction("politician_offices", "5", [{ field: "end_date", current_value: "2024-01-31", correct_value: "2024-01-15" }]));
  assertEquals(out.status, "applied", String(out.message));
  const o = (tables.get("politician_offices") ?? [])[0];
  assertEquals(o.end_date, "2024-01-15");
  assertEquals(o.end_basis, "source");
  assertEquals(o.source_url, "https://web.cec.gov.tw/announce/1");
  const hist = (tables.get("edit_history") ?? []).map((h) => h.field);
  assert(hist.includes("end_date") && hist.includes("end_basis"), `履歷要記卸任日與根據：${hist.join(",")}`);
});

Deno.test("在任中的任期只給卸任日沒給原因：不落庫，講清楚要兩欄", async () => {
  const { client, tables } = makeDb({
    politician_offices: [{ id: "6", politician_id: POL, end_date: null, end_reason: null, end_basis: null, source_url: null }],
  }, true);
  const out = await applyContribution(client, correction("politician_offices", "6", [{ field: "end_date", current_value: null, correct_value: "2025-03-01" }]));
  assertEquals(out.status, "failed");
  assertStringIncludes(String(out.message), "end_reason");
  assertEquals((tables.get("politician_offices") ?? [])[0].end_date, null);
});

Deno.test("在任中的任期辭職：卸任日＋原因一起給就落庫", async () => {
  const { client, tables } = makeDb({
    politician_offices: [{ id: "6", politician_id: POL, end_date: null, end_reason: null, end_basis: null, source_url: null }],
  }, true);
  const out = await applyContribution(client, correction("politician_offices", "6", [
    { field: "end_date", current_value: null, correct_value: "2025-03-01" },
    { field: "end_reason", current_value: null, correct_value: "resigned" },
  ]));
  assertEquals(out.status, "applied", String(out.message));
  const o = (tables.get("politician_offices") ?? [])[0];
  assertEquals([o.end_date, o.end_reason, o.end_basis], ["2025-03-01", "resigned", "source"]);
});
