// 落庫不能寫到已合併的舊人物 id（#466 A）：陳瑩 54472fee 併進 8aa6ee40 之後，又多了一筆參選紀錄 36446 掛在舊 id。
// 守門：ensureOrResolve（payload.politician_id／resolved_politician_id／比對）與 locatePolitician 都沿 merged_into 走到保留者；
// 鏈要有深度上限、成環要丟錯；沒合併過的人行為不變。
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { applyContribution, followMergedInto, MAX_MERGE_HOPS } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";

const OLD = "54472fee-1dc4-475c-a104-64529aa0797a";
const KEEP = "8aa6ee40-231a-447a-a967-99bcf8b35d3f";
const C1 = "11111111-1111-4111-8111-111111111111";

const people = () => [
  { id: OLD, name: "陳瑩", region: "臺東縣", merged_into: KEEP },
  { id: KEEP, name: "陳瑩", region: "臺東縣", merged_into: null },
];

const candidacy = (extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
  id: C1, contribution_type: "candidacy", status: "verified", agent_name: "alice", contributor_ip_hash: "ip-a", contributor_url: null, note: null, retry_count: 0,
  payload: { politician_id: OLD, name: "陳瑩", election_id: 2026, election_type: "縣市長", candidate_status: "registered", region: "臺東縣", ...payload },
  source_urls: ["https://example.test/a"], ...extra,
});

const electionsOf = (f: ReturnType<typeof createFakeSupabase>) => f.db.politician_elections as Array<Record<string, unknown>>;

Deno.test("candidacy：payload.politician_id 是已合併的舊 id → 參選紀錄寫到保留者，舊 id 一筆都不增", async () => {
  const f = createFakeSupabase({ contributions: [candidacy()], politicians: people(), politician_elections: [], elections: [{ id: 2026 }] });
  const out = await applyContribution(f.client, candidacy() as never);
  assertEquals(out.status, "applied", out.message);
  const rows = electionsOf(f);
  assertEquals(rows.filter((r) => r.politician_id === OLD).length, 0, "舊 id 底下不能再長出參選紀錄");
  assertEquals(rows.filter((r) => r.politician_id === KEEP && r.election_id === 2026).length, 1);
});

Deno.test("candidacy：resolved_politician_id 指到已合併的舊 id → 也走到保留者", async () => {
  const row = candidacy({ resolved_politician_id: OLD }, { politician_id: undefined });
  const f = createFakeSupabase({ contributions: [row], politicians: people(), politician_elections: [], elections: [{ id: 2026 }] });
  const out = await applyContribution(f.client, row as never);
  assertEquals(out.status, "applied", out.message);
  assertEquals(electionsOf(f).filter((r) => r.politician_id === OLD).length, 0);
  assertEquals(electionsOf(f).filter((r) => r.politician_id === KEEP).length, 1);
});

Deno.test("candidacy：沒合併過的人行為不變（寫在自己名下）", async () => {
  const f = createFakeSupabase({
    contributions: [candidacy({}, { politician_id: KEEP })], politicians: people(), politician_elections: [], elections: [{ id: 2026 }],
  });
  const out = await applyContribution(f.client, candidacy({}, { politician_id: KEEP }) as never);
  assertEquals(out.status, "applied", out.message);
  assertEquals(electionsOf(f).filter((r) => r.politician_id === KEEP).length, 1);
});

Deno.test("followMergedInto：多層鏈走到底、沒合併的原樣、查無此人原樣回傳", async () => {
  const f = createFakeSupabase({ politicians: [
    { id: "a", merged_into: "b" }, { id: "b", merged_into: "c" }, { id: "c", merged_into: null },
  ] });
  assertEquals(await followMergedInto(f.client, "a"), "c");
  assertEquals(await followMergedInto(f.client, "c"), "c");
  assertEquals(await followMergedInto(f.client, "zzz"), "zzz");
});

Deno.test("followMergedInto：成環丟錯（不無限迴圈）", async () => {
  const f = createFakeSupabase({ politicians: [{ id: "a", merged_into: "b" }, { id: "b", merged_into: "a" }] });
  await assertRejects(() => followMergedInto(f.client, "a"), Error, "成環");
});

Deno.test("followMergedInto：鏈超過深度上限丟錯", async () => {
  const n = MAX_MERGE_HOPS + 3;
  const rows = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, merged_into: i + 1 < n ? `p${i + 1}` : null }));
  const f = createFakeSurrogate(rows);
  await assertRejects(() => followMergedInto(f.client, "p0"), Error, "超過");
  assert(MAX_MERGE_HOPS >= 2 && MAX_MERGE_HOPS <= 10, "上限要有、且不能小到擋掉合理的二層鏈");
});

function createFakeSurrogate(rows: Array<Record<string, unknown>>) {
  return createFakeSupabase({ politicians: rows });
}
