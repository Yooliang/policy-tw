import { assert, assertEquals } from "jsr:@std/assert@1";
import { issueDispatchToken } from "./dispatch-token.ts";
import { handleVerify } from "./verify-handler.ts";

/**
 * 投票不看 IP 之後的兩道身分檢查（policy-ops#199 審查退回的必修）：
 *   1 改票要驗本人：匿名的投票人鍵只是自報代號，別人送 agent_name=<受害者>＋revise:true 不能改到對方的票（票上存的網段要對得上）
 *   2 一次派工不能換無限代號各投一票：憑證路徑 agent_name 必須等於憑證裡的代號；無憑證路徑要等於派工紀錄上的代號
 */
const SECRET = "test-secret-for-dispatch-token-0123456789";
const CID = "11111111-2222-3333-4444-555555555555";
const NET_A = "a".repeat(64);
const NET_B = "b".repeat(64);

type Row = Record<string, unknown>;

function fakeDb(o: { votes?: Row[]; dispatch?: { ip_hash: string; agent_name: string | null } | null } = {}) {
  const votes: Row[] = [...(o.votes ?? [])];
  const updates: Row[] = [];
  const contribution: Row = {
    id: CID, status: "pending", contribution_type: "policy", payload: { title: "測試政見" }, source_urls: ["https://example.test/a"],
    agent_name: "someone", contributor_ip_hash: "ip-other", actor_id: "ip:other", agree_count: 0, disagree_count: 0, unsure_count: 0, score: 0,
  };
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let updating = false;
      let patch: Row = {};
      const chain = {
        select() { return chain; },
        eq(c: string, v: unknown) { filters[c] = v; return chain; },
        gte() { return chain; }, order() { return chain; }, limit() { return chain; }, in() { return chain; }, neq() { return chain; },
        maybeSingle() {
          if (table === "contributions") return Promise.resolve({ data: filters.id === contribution.id ? contribution : null, error: null });
          if (table === "verify_dispatches") {
            const d = o.dispatch;
            const hit = d && filters.ip_hash === d.ip_hash && filters.contribution_id === contribution.id;
            return Promise.resolve({ data: hit ? { contribution_id: CID, agent_name: d!.agent_name } : null, error: null });
          }
          if (updating) { updates.push({ ...patch, id: filters.id }); return Promise.resolve({ data: { id: filters.id }, error: null }); }
          return Promise.resolve({ data: null, error: null });
        },
        then(res: (v: unknown) => unknown) {
          const rows = table === "contribution_votes" ? votes.map((v) => ({ ...v })) : [];
          return Promise.resolve({ data: rows, error: null, count: 0 }).then(res);
        },
        insert(row: Row) {
          if (table === "contribution_votes") votes.push({ id: `v${votes.length + 1}`, ...row });
          return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: `v${votes.length}` }, error: null }) }) };
        },
        update(row: Row) { updating = true; patch = row; return chain; },
        upsert() { return Promise.resolve({ error: null }); },
      };
      return chain;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { client, votes, updates };
}

const vote = (agent: string, extra: Row = {}) => ({
  agent_name: agent, contribution_id: CID, verdict: "agree", note: `打開來源逐欄核對，標題與內容都對得上（${agent}）`, evidence_url: "https://example.test/evidence", ...extra,
});
const post = (db: ReturnType<typeof fakeDb>, body: Row, net: string) =>
  handleVerify(db.client as never, body, net, undefined, "report", undefined, undefined, SECRET);

Deno.test("必修1 改票要驗本人：別的來源送受害者的代號＋revise → 403，票不動", async () => {
  const db = fakeDb({ votes: [{ id: "v1", agent_name: "victim", actor_id: `ip:${NET_A}`, verifier_ip_hash: NET_A, note: "原本的票" }], dispatch: { ip_hash: NET_B, agent_name: "victim" } });
  const res = await post(db, vote("victim", { revise: true }), NET_B);
  assertEquals(res.status, 403, JSON.stringify(res.body));
  assertEquals(res.body.error, "not_your_vote");
  assertEquals(db.updates.length, 0, "票沒被改");
  assertEquals(db.votes.length, 1);
});

Deno.test("必修1 改票：同一個來源（票上存的網段）改自己的票 → 放行", async () => {
  const db = fakeDb({ votes: [{ id: "v1", agent_name: "victim", actor_id: `ip:${NET_A}`, verifier_ip_hash: NET_A, note: "原本的票" }], dispatch: { ip_hash: NET_A, agent_name: "victim" } });
  const res = await post(db, vote("victim", { revise: true }), NET_A);
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(db.updates.length, 1);
});

Deno.test("必修1 過期憑證的 revise 一樣要驗本人：憑證網段與票上網段對不上 → 403 invalid_dispatch_token", async () => {
  const db = fakeDb({ votes: [{ id: "v1", agent_name: "victim", actor_id: `ip:${NET_A}`, verifier_ip_hash: NET_A, note: "原本的票" }] });
  const t0 = Date.now() - 3 * 3600_000;
  const issued = await issueDispatchToken(SECRET, { taskId: `verify:${CID}`, agentName: "victim", ipHash: NET_B, now: t0 });
  assert(issued);
  const res = await post(db, vote("victim", { revise: true, dispatch_token: issued.token }), NET_B);
  assertEquals(res.status, 403, JSON.stringify(res.body));
  assertEquals(res.body.error, "invalid_dispatch_token");
  assertEquals(db.updates.length, 0);
});

Deno.test("必修2 憑證路徑：agent_name 要等於憑證裡的代號（不分大小寫）；別的代號 → 403 agent_mismatch", async () => {
  const db = fakeDb();
  const issued = await issueDispatchToken(SECRET, { taskId: `verify:${CID}`, agentName: "Dave", ipHash: NET_A });
  assert(issued);
  const bad = await post(db, vote("a2", { dispatch_token: issued.token }), NET_A);
  assertEquals(bad.status, 403, JSON.stringify(bad.body));
  assertEquals(bad.body.reason, "agent_mismatch");
  assertEquals(db.votes.length, 0);
  const ok = await post(db, vote("dave", { dispatch_token: issued.token }), NET_A);
  assertEquals(ok.status, 201, JSON.stringify(ok.body));
});

Deno.test("必修2 無憑證路徑：派工紀錄上的代號要對得上，別的代號 → 409 not_dispatched；紀錄沒代號的舊列放行", async () => {
  const other = fakeDb({ dispatch: { ip_hash: NET_A, agent_name: "dave" } });
  const bad = await post(other, vote("a2"), NET_A);
  assertEquals(bad.status, 409, JSON.stringify(bad.body));
  assertEquals(bad.body.error, "not_dispatched");
  assertEquals(other.votes.length, 0);
  const same = fakeDb({ dispatch: { ip_hash: NET_A, agent_name: "Dave" } });
  assertEquals((await post(same, vote("dave"), NET_A)).status, 201);
  const old = fakeDb({ dispatch: { ip_hash: NET_A, agent_name: null } });
  assertEquals((await post(old, vote("anyone"), NET_A)).status, 201);
});
