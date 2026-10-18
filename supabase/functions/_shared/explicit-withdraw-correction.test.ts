/**
 * 協議 1.98.0 B：更正明講的「沒參選／退選」不被既有選舉結果蓋掉（8d5c8372「劉雁祿」pe 113：結果 not_elected、更正 filed→not_running 被判 superseded）。
 *   - nextCandidacyStatus 的 explicitCorrection：not_running／withdrawn 直接回 withdrawn；candidacy 重交仍套規則 ②
 *   - applyCorrection 傳 explicitCorrection（落庫端端到端）
 *   - 放寬就提高門檻：改成退選的更正要 ≥2 個不同來源 IP（TS needsTwoIps／scoreStatus、SQL contribution_needs_two_ips 用 PGlite 真的跑，逐案比對）
 * 還原驗證：拿掉 nextCandidacyStatus 的 explicitCorrection 那一行 → 前兩支紅；applyCorrection 不傳 true → 端到端那支紅；
 * needsTwoIps 的 correction 那一行拿掉、或 SQL 函式的 correction 那段拿掉 → 門檻那兩支紅。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyContribution } from "./apply-contribution.ts";
import { nextCandidacyStatus } from "./candidacy-status.ts";
import { needsTwoIps, scoreStatus } from "./consensus.ts";
import { readMig } from "./arms-pglite.ts";

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

const POL = "8d5c8372-1764-4ef7-9a7d-8a3e11658c62";
const base = { note: null, agent_name: "tester", contributor_url: null, source_urls: ["https://web.cec.gov.tw/announce/1"] };
const correction = (value: string, extra: Record<string, unknown> = {}) => ({
  ...base, id: "c1", contribution_type: "correction" as const,
  payload: { target_table: "politician_elections", target_id: "113", reason: "中選會公報上沒有這個人，他沒參選", changes: [{ field: "candidate_status", current_value: "filed", correct_value: value }], ...extra },
});

Deno.test("nextCandidacyStatus：existing = not_elected，明講的 not_running／withdrawn → withdrawn（不被規則 ② 蓋掉）", () => {
  for (const cs of ["not_running", "withdrawn"]) {
    for (const existing of ["not_elected", "elected"]) {
      assertEquals(nextCandidacyStatus({ candidateStatus: cs, listPublished: true, existing, explicitCorrection: true }).status, "withdrawn", `${cs}/${existing}`);
    }
  }
});

Deno.test("nextCandidacyStatus：candidacy 重交（沒有 explicitCorrection）規則 ② 照舊；明講也只放寬退選那一條", () => {
  for (const existing of ["not_elected", "elected"]) {
    assertEquals(nextCandidacyStatus({ candidateStatus: "confirmed", listPublished: true, existing }).status, existing, "confirmed 重交維持結果");
    assertEquals(nextCandidacyStatus({ candidateStatus: "not_running", listPublished: true, existing }).status, existing, "沒帶旗標的 not_running 仍維持結果");
    assertEquals(nextCandidacyStatus({ candidateStatus: "confirmed", listPublished: true, existing, explicitCorrection: true }).status, existing, "更正改成 confirmed 也不能把結果改回登記階段");
    assertEquals(nextCandidacyStatus({ candidateStatus: "qualified", listPublished: true, existing, explicitCorrection: true }).status, existing);
  }
  assertEquals(nextCandidacyStatus({ candidateStatus: "not_running", listPublished: true, existing: "filed", explicitCorrection: true }).status, "withdrawn", "沒有結果的照舊");
});

Deno.test("applyCorrection 端到端：pe 113 已是 not_elected，更正 filed→not_running → applied、變 withdrawn（不是 superseded）", async () => {
  const { client, tables } = makeDb({ politician_elections: [{ id: 113, politician_id: POL, election_id: 2022, election_type: "縣市長", candidacy_status: "not_elected", region_id: null }] }, false);
  const out = await applyContribution(client, correction("not_running"));
  assertEquals(out.status, "applied", String(out.message));
  assertEquals((tables.get("politician_elections") ?? [])[0].candidacy_status, "withdrawn");
});

Deno.test("applyCorrection 端到端：改成 confirmed 的更正碰到已有結果 → 維持結果（superseded），規則 ② 照舊", async () => {
  const { client, tables } = makeDb({ politician_elections: [{ id: 113, politician_id: POL, election_id: 2022, election_type: "縣市長", candidacy_status: "not_elected", region_id: null }] }, false);
  const out = await applyContribution(client, correction("confirmed"));
  assertEquals(out.status, "superseded");
  assertEquals((tables.get("politician_elections") ?? [])[0].candidacy_status, "not_elected");
});

const WITHDRAW_PAYLOADS: Array<[string, unknown, boolean]> = [
  ["新格式 not_running", correction("not_running").payload, true],
  ["新格式 withdrawn", correction("withdrawn").payload, true],
  ["舊格式 field＋correct_value", { target_table: "politician_elections", target_id: 113, field: "candidate_status", correct_value: "not_running", reason: "x" }, true],
  ["改成已登記不用", correction("registered").payload, false],
  ["改的是別的欄位不用", { target_table: "politician_elections", target_id: 113, changes: [{ field: "position", correct_value: "not_running" }] }, false],
  ["別張表不用", { target_table: "politicians", target_id: POL, changes: [{ field: "candidate_status", correct_value: "not_running" }] }, false],
  ["changes 不是陣列不炸", { target_table: "politician_elections", changes: "x" }, false],
];

Deno.test("門檻（TS）：改成退選的更正要 ≥2 個不同來源 IP；其他更正不變", () => {
  for (const [label, payload, two] of WITHDRAW_PAYLOADS) assertEquals(needsTwoIps("correction", payload), two, label);
  const wd = correction("not_running").payload;
  assertEquals(scoreStatus({ score: 3, target: 3, distinctIps: 1, contributionType: "correction", current: "pending", payload: wd }), "pending", "一個 IP 湊足分數還在等");
  assertEquals(scoreStatus({ score: 3, target: 3, distinctIps: 2, contributionType: "correction", current: "pending", payload: wd }), "verified");
  assertEquals(scoreStatus({ score: 3, target: 3, distinctIps: 1, contributionType: "correction", current: "pending", payload: correction("registered").payload }), "verified", "其他更正不受影響");
});

Deno.test("門檻（SQL 與 TS 一致）：contribution_needs_two_ips 真的跑，逐案跟 needsTwoIps 比", async () => {
  const sql = await readMig("20261018030000_correction_withdraw_two_ips.sql");
  const d = new PGlite();
  await d.exec(sql);
  for (const [label, payload, two] of WITHDRAW_PAYLOADS) {
    const r = await d.query<{ v: boolean }>("SELECT contribution_needs_two_ips('correction', $1::jsonb) AS v", [JSON.stringify(payload)]);
    assertEquals(r.rows[0].v, two, `SQL ${label}`);
  }
  for (const t of ["merge_politician", "candidacy", "removal", "reassign_candidacy"]) {
    assertEquals((await d.query<{ v: boolean }>("SELECT contribution_needs_two_ips($1, '{}'::jsonb) AS v", [t])).rows[0].v, true, t);
  }
  assertEquals((await d.query<{ v: boolean }>("SELECT contribution_needs_two_ips('lineage_handover', '{\"handover_type\":\"stop\"}'::jsonb) AS v")).rows[0].v, true);
  assertEquals((await d.query<{ v: boolean }>("SELECT contribution_needs_two_ips('policy', '{}'::jsonb) AS v")).rows[0].v, false);
  await d.close();
});
