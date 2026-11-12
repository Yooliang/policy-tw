/**
 * /next 的 current.bulletin_published（協議 1.136.0）：fetchTaskContext 把「這件任務那場選舉的公報上架了嗎」帶進 current。
 * 有 target.election_id 就用它、沒有用最新一屆參選紀錄；里程碑 done 才是 true；沒有公報里程碑的舊屆＝true；查失敗不給欄位。
 */
import { assertEquals, assertFalse } from "jsr:@std/assert@1";
import { bulletinPublishedFrom, fetchTaskContext, shapeTaskCurrent } from "./task-context.ts";

// ---------------------------------------------------------------- D. TS
type Row = Record<string, unknown>;
/** 假 supabase：politician_elections、election_milestones 可設；milestoneFail＝里程碑表查詢出錯 */
function fake(o: { elections?: Row[]; milestones?: Row[]; milestoneFail?: boolean }) {
  const milestoneQueries: Array<{ election_id: unknown }> = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      in: () => api,
      is: (c: string, v: unknown) => { filters[`is:${c}`] = v; return api; },
      eq: (c: string, v: unknown) => { filters[c] = v; return api; },
      order: () => api,
      limit: () => api,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (res: (v: unknown) => unknown) => {
        if (table === "election_milestones") {
          milestoneQueries.push({ election_id: filters.election_id });
          if (o.milestoneFail) return res({ data: null, error: { message: "boom" } });
          const rows = (o.milestones ?? []).filter((m) => m.election_id === filters.election_id && m.kind === filters.kind && m.election_type === null);
          return res({ data: rows.map((m) => ({ status: m.status })), error: null });
        }
        if (table === "politician_elections") return res({ data: o.elections ?? [], error: null });
        return res({ data: [], count: 0, error: null });
      },
    };
    return api;
  };
  return { client: { from, rpc: () => Promise.resolve({ data: null, error: null }) }, milestoneQueries };
}
const MS = (eid: number, status: string): Row => ({ election_id: eid, kind: "bulletin_published", election_type: null, status });
const PID = "00000000-0000-4000-8000-000000000001";

Deno.test("D1 bulletinPublishedFrom：done 才是 true；沒有里程碑（舊屆）true；查不到 undefined", () => {
  assertEquals(bulletinPublishedFrom([{ status: "done" }]), true);
  assertEquals(bulletinPublishedFrom([{ status: "expected" }]), false);
  assertEquals(bulletinPublishedFrom([{ status: "announced" }]), false);
  assertEquals(bulletinPublishedFrom([]), true);
  assertEquals(bulletinPublishedFrom(null), undefined);
});

Deno.test("D2 /next 的 current.bulletin_published：target.election_id 的里程碑是 expected → false，翻 done → true，沒有里程碑 → true", async () => {
  for (const type of ["policy_missing", "term_policy_missing"]) {
    const off = fake({ milestones: [MS(2026, "expected")] });
    const cur = shapeTaskCurrent(type, await fetchTaskContext(off.client, type, { politician_id: PID, election_id: 2026 })) as Row;
    assertEquals(cur.bulletin_published, false);
    assertEquals(off.milestoneQueries, [{ election_id: 2026 }]);

    const on = fake({ milestones: [MS(2026, "done")] });
    assertEquals((shapeTaskCurrent(type, await fetchTaskContext(on.client, type, { politician_id: PID, election_id: 2026 })) as Row).bulletin_published, true);

    const old = fake({ milestones: [MS(2026, "expected")] });
    assertEquals((shapeTaskCurrent(type, await fetchTaskContext(old.client, type, { politician_id: PID, election_id: 2022 })) as Row).bulletin_published, true);
  }
});

Deno.test("D3 target 沒有 election_id：用這個人最新一屆的參選紀錄（election_id 最大的那列）", async () => {
  const f = fake({ elections: [{ election_id: 2026, election_type: "縣市議員", candidacy_status: "filed" }, { election_id: 2022, election_type: "縣市議員", candidacy_status: "elected" }], milestones: [MS(2026, "expected")] });
  const cur = shapeTaskCurrent("policy_missing", await fetchTaskContext(f.client, "policy_missing", { politician_id: PID })) as Row;
  assertEquals(cur.bulletin_published, false);
  assertEquals(f.milestoneQueries, [{ election_id: 2026 }]);
  // 沒有參選紀錄也沒有 election_id：不查、不給欄位
  const none = fake({});
  const cur2 = shapeTaskCurrent("policy_missing", await fetchTaskContext(none.client, "policy_missing", { politician_id: PID })) as Row;
  assertFalse("bulletin_published" in cur2);
  assertEquals(none.milestoneQueries.length, 0);
});

Deno.test("D4 里程碑表查詢出錯：不給欄位、不擋派工；其他任務型別不帶這個欄位", async () => {
  const f = fake({ milestoneFail: true });
  const cur = shapeTaskCurrent("policy_missing", await fetchTaskContext(f.client, "policy_missing", { politician_id: PID, election_id: 2026 })) as Row;
  assertFalse("bulletin_published" in cur);
  const other = shapeTaskCurrent("profile_gap", { politician: { id: PID }, bulletin_published: false }) as Row;
  assertFalse("bulletin_published" in other);
});
