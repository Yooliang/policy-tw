/**
 * 落庫前原子認領（2026-10-21）：同一筆已驗證貢獻被兩個執行同時落庫，建出兩個人物（4010ebc0 陳清泉）。
 * 守三件事：
 *   1. 兩個並行的 autoApplyContribution（兩票各觸發、或投票＋掃地機）只落庫一次——真的 applyContribution、真的建人物；
 *   2. applyFn 失敗要釋放認領（retry 才撿得到）；執行中死掉沒釋放的認領，租約過期後別人可接手；
 *   3. migration 的欄位與條件式 UPDATE 在真的 Postgres（PGlite）上只有一個贏家。
 * 另守 applyCandidacy 建新人物時帶 sub_region（比照 applyPolitician）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { APPLY_CLAIM_LEASE_MS, autoApplyContribution, claimForApply } from "./auto-apply.ts";
import { applyContribution, type ContributionRow } from "./apply-contribution.ts";
import { readMig } from "./arms-pglite.ts";

const C1 = "4010ebc0-0000-4000-8000-000000000001";
const payload = { name: "陳清泉", election_id: 2026, election_type: "村里長", region: "彰化縣", sub_region: "伸港鄉", village: "泉州村", candidate_status: "registered" };

const contribution = (extra: Record<string, unknown> = {}) => ({
  id: C1, contribution_type: "candidacy", status: "verified", agent_name: "alice", contributor_url: null, note: null, retry_count: 0, next_retry_at: null, apply_claimed_at: null,
  payload, source_urls: ["https://web.cec.gov.tw/x"], ...extra,
});

const seed = (extra: Record<string, unknown> = {}) => ({
  regions: [
    { id: 900, region: "彰化縣", sub_region: null, village: null },
    { id: 901, region: "彰化縣", sub_region: "伸港鄉", village: null },
    { id: 902, region: "彰化縣", sub_region: "伸港鄉", village: "泉州村" },
  ],
  politicians: [],
  politician_elections: [],
  contributions: [contribution()],
  ...extra,
});

/** 讓 applyFn 在中途讓出執行權：沒有認領時，兩個執行會在這裡交錯、各自寫入一次 */
const slowApply = (calls: { n: number }) => async (supabase: unknown, row: ContributionRow) => {
  calls.n++;
  await new Promise((r) => setTimeout(r, 5));
  return await applyContribution(supabase, row);
};

Deno.test("C1 兩個並行的 autoApplyContribution：只落庫一次（一個人物、一列參選紀錄、applyFn 只跑一次）", async () => {
  const { client, db } = createFakeSupabase(seed());
  const calls = { n: 0 };
  const [a, b] = await Promise.all([
    autoApplyContribution(client, C1, slowApply(calls)),
    autoApplyContribution(client, C1, slowApply(calls)),
  ]);
  assertEquals(calls.n, 1, "applyFn 只能被一個執行呼叫");
  assertEquals([a.triggered, b.triggered].sort(), [false, true], "輸的一方放棄（triggered:false）");
  assertEquals(db.politicians.length, 1, "同一筆貢獻只建一個人物");
  assertEquals(db.politician_elections.length, 1, "只有一列參選紀錄");
  assertEquals(db.contributions[0].status, "applied");
  assertEquals(db.contributions[0].apply_claimed_at, null, "寫回狀態時釋放認領");
});

Deno.test("C2 三個並行（投票兩票＋掃地機）也只落庫一次；落庫完成後遲到的執行不再動", async () => {
  const { client, db } = createFakeSupabase(seed());
  const calls = { n: 0 };
  await Promise.all([1, 2, 3].map(() => autoApplyContribution(client, C1, slowApply(calls))));
  assertEquals(calls.n, 1);
  assertEquals(db.politicians.length, 1);
  const late = await autoApplyContribution(client, C1, slowApply(calls));
  assertEquals(late.triggered, false);
  assertEquals(calls.n, 1);
});

Deno.test("C3 applyFn 失敗釋放認領：狀態轉 apply_failed、認領清空，retry 模式撿得到並成功", async () => {
  const { client, db } = createFakeSupabase(seed());
  const r = await autoApplyContribution(client, C1, async () => { throw new Error("boom"); });
  assertEquals(r.status, "apply_failed");
  assertEquals(db.contributions[0].apply_claimed_at, null, "失敗要釋放認領");
  db.contributions[0].next_retry_at = new Date(Date.now() - 1000).toISOString();
  const calls = { n: 0 };
  const retry = await autoApplyContribution(client, C1, slowApply(calls), { retry: true });
  assertEquals(retry.status, "applied");
  assertEquals(db.politicians.length, 1);
});

Deno.test("C4 defer（還沒到可寫的時候）也釋放認領，下一輪掃地機再撿", async () => {
  const { client, db } = createFakeSupabase(seed());
  const r = await autoApplyContribution(client, C1, async () => ({ status: "failed" as const, message: "投票日當天", defer: true }));
  assertEquals(r.triggered, false);
  assertEquals(db.contributions[0].status, "verified");
  assertEquals(db.contributions[0].apply_claimed_at, null);
});

Deno.test("C5 租約：別人持有中的認領搶不到；過期（執行中死掉沒釋放）後可接手", async () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const held = (ageMs: number) => seed({ contributions: [contribution({ apply_claimed_at: new Date(now.getTime() - ageMs).toISOString() })] });
  const fresh = createFakeSupabase(held(60 * 1000));
  assertEquals((await claimForApply(fresh.client, C1, "verified", now.toISOString())).won, false);
  const stale = createFakeSupabase(held(APPLY_CLAIM_LEASE_MS + 1000));
  assertEquals((await claimForApply(stale.client, C1, "verified", now.toISOString())).won, true);
  assertEquals(stale.db.contributions[0].apply_claimed_at, now.toISOString());
  // 狀態變了（別人已落庫完）一律搶不到
  const done = createFakeSupabase(seed({ contributions: [contribution({ status: "applied" })] }));
  assertEquals((await claimForApply(done.client, C1, "verified", now.toISOString())).won, false);
});

Deno.test("C6 PGlite：migration 加欄位後，條件式 UPDATE 認領只有第一個贏、釋放後可再搶、過期可接手", async () => {
  const db = new PGlite();
  await db.exec("CREATE TABLE contributions (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  await db.exec("INSERT INTO contributions VALUES ('c', 'verified')");
  await db.exec(await readMig("20261021060000_contributions_apply_claim.sql"));
  const claim = async () =>
    (await db.query(
      `UPDATE contributions SET apply_claimed_at = now() WHERE id = 'c' AND status = 'verified' AND (apply_claimed_at IS NULL OR apply_claimed_at < now() - interval '10 minutes') RETURNING id`,
    )).rows.length;
  assertEquals(await claim(), 1, "第一個贏");
  assertEquals(await claim(), 0, "第二個 0 列");
  await db.exec("UPDATE contributions SET apply_claimed_at = now() - interval '11 minutes'");
  assertEquals(await claim(), 1, "租約過期後可接手");
  await db.exec("UPDATE contributions SET apply_claimed_at = NULL");
  assertEquals(await claim(), 1, "釋放後可再搶");
  await db.close();
});

Deno.test("S1 applyCandidacy 建新人物帶 sub_region 與 village；沒帶時仍是空值不炸", async () => {
  const { client, db } = createFakeSupabase(seed());
  const out = await applyContribution(client, { ...(contribution() as unknown as ContributionRow), resolved_politician_id: "new" });
  assertEquals(out.status, "applied", out.message);
  assertEquals(db.politicians.length, 1);
  assertEquals(db.politicians[0].sub_region, "伸港鄉");
  assertEquals(db.politicians[0].village, "泉州村");

  const bare = createFakeSupabase(seed());
  const { sub_region: _s, village: _v, ...rest } = payload;
  const out2 = await applyContribution(bare.client, { ...(contribution({ payload: { ...rest, election_type: "縣市議員" } }) as unknown as ContributionRow), resolved_politician_id: "new" });
  assertEquals(out2.status, "applied", out2.message);
  assert(bare.db.politicians[0].sub_region == null);
});
