import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleVerify } from "./verify-handler.ts";

// 2026-09-21 #10：投票者投錯了要有出口。同一筆再送一次帶 revise:true → UPDATE 自己那張票，不是新增。
// 提交者改自己交的東西用 withdraw，投票者改自己投的票用 revise——兩邊都有「我搞錯了」的合法出口。
const CID = "11111111-2222-3333-4444-555555555555";
const MINE = "ip-mine";

function fake(opts: { existingVote: boolean }) {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const contribution = {
    id: CID, status: "pending", contribution_type: "candidacy",
    payload: { name: "某某", election_id: 2026 }, source_urls: ["https://example.test/a"],
    agent_name: "someone", contributor_ip_hash: "ip-other",
    agree_count: 1, disagree_count: 0, unsure_count: 0, score: 1,
  };
  const client = {
    from(table: string) {
      let pendingUpdate: Record<string, unknown> | null = null;
      const chain = {
        select() { return chain; },
        eq(_c: string, v: unknown) { if (pendingUpdate) { updated.push({ id: String(v), patch: pendingUpdate }); pendingUpdate = null; } return chain; },
        gte() { return chain; }, order() { return chain; }, limit() { return chain; }, in() { return chain; }, neq() { return chain; },
        maybeSingle() {
          if (table === "contributions") return Promise.resolve({ data: contribution, error: null });
          if (table === "verify_dispatches") return Promise.resolve({ data: { contribution_id: CID }, error: null });
          if (table === "contribution_votes") return Promise.resolve({ data: { id: "v-old" }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(res: (v: unknown) => unknown) {
          const rows = table === "contribution_votes" && opts.existingVote ? [{ id: "v-old", agent_name: "dave", verifier_ip_hash: MINE }] : [];
          return Promise.resolve({ data: rows, error: null, count: 0 }).then(res);
        },
        insert(row: Record<string, unknown>) { inserted.push({ table, ...row }); return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "v-new" }, error: null }) }) }; },
        update(patch: Record<string, unknown>) { pendingUpdate = { table, ...patch }; return chain; },
        upsert() { return Promise.resolve({ error: null }); },
      };
      return chain;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { client, inserted, updated };
}

const base = { agent_name: "dave", contribution_id: CID, verdict: "agree", note: "打開來源逐欄核對，登記日期與選區都對得上", resolved_politician_id: "new" };

Deno.test("投過了沒帶 revise → 409，訊息要告訴它怎麼改票", async () => {
  const { client, inserted, updated } = fake({ existingVote: true });
  const res = await handleVerify(client, base, MINE);
  assertEquals(res.status, 409);
  assertEquals(res.body.error, "already_voted");
  assert(String(res.body.message).includes("revise"), "要講怎麼改票");
  assertEquals(inserted.length, 0);
  assertEquals(updated.filter((u) => u.patch.table === "contribution_votes").length, 0);
});

Deno.test("帶 revise:true → 覆寫自己那張票（UPDATE 不 INSERT），指認換成新的，回應標 revised", async () => {
  const { client, inserted, updated } = fake({ existingVote: true });
  const res = await handleVerify(client, { ...base, revise: true, resolved_politician_id: "22222222-2222-3333-4444-555555555555", note: "查了中選會 API，出生年一致，是既有的那位" }, MINE);
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(res.body.revised, true);
  assertEquals(inserted.filter((r) => r.table === "contribution_votes").length, 0, "不該新增第二張票");
  const u = updated.find((x) => x.patch.table === "contribution_votes");
  assert(u, "要 UPDATE 那張票");
  assertEquals(u!.id, "v-old");
  assertEquals(u!.patch.resolved_politician_id, "22222222-2222-3333-4444-555555555555");
  assertEquals(u!.patch.via, "verify:revise", "稽核要分得出這是修訂");
});

Deno.test("沒投過卻帶 revise → 照常當新票收", async () => {
  const { client, inserted, updated } = fake({ existingVote: false });
  const res = await handleVerify(client, { ...base, revise: true }, MINE);
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(res.body.revised, undefined);
  assertEquals(inserted.filter((r) => r.table === "contribution_votes").length, 1);
  assertEquals(updated.filter((x) => x.patch.table === "contribution_votes").length, 0);
});
