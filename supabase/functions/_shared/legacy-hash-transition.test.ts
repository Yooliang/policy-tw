import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { handleVerify } from "./verify-handler.ts";
import { handleContribute, ipHashOf, legacyIpHashOf } from "./contribute-handler.ts";
import { fetchMyVotedRows } from "./my-votes.ts";
import { excludeOwnAdjudications } from "./dispatch.ts";

/**
 * 檔名沿用（原本守 #481 單一 IP 舊雜湊的過渡期）。2026-11-04 維護者裁定「投票不看 IP」後，舊雜湊／網段雜湊的過渡概念消失，
 * 這裡改守新語意：投票人＝代號（匿名）或 DiTrust 帳號；來源網段不影響自交、重投、/next 的已投排除、併票。
 *   1 裁決的利益迴避只看代號　2 併票：同網段不同代號可併、同代號擋　3 /next 的 my_votes 按代號／帳號查
 *   4 同代號重投 409＋revise 覆寫　5 輪換 IP：派工綁定仍認網段（那不是投票條件），去重不看網段
 */
const CID = "11111111-2222-3333-4444-555555555555";
const ORIG = "99999999-2222-3333-4444-555555555555";
const NEW = "net-hash";
const OLD = "ip-old-single";

type Row = Record<string, unknown>;

function fakeVerifyDb(o: { contribution?: Row; original?: Row; votes?: Row[]; dispatchedHash?: string | null }) {
  const inserted: Row[] = [];
  const updated: Array<{ id: string; patch: Row }> = [];
  const contribution: Row = {
    id: CID, status: "pending", contribution_type: "candidacy",
    payload: { name: "某某", election_id: 2026 }, source_urls: ["https://example.test/a"],
    agent_name: "someone", contributor_ip_hash: "ip-other",
    agree_count: 1, disagree_count: 0, unsure_count: 0, score: 1,
    ...(o.contribution ?? {}),
  };
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let pendingUpdate: Row | null = null;
      const chain = {
        select() { return chain; },
        eq(c: string, v: unknown) {
          filters[c] = v;
          if (pendingUpdate && c === "id") { updated.push({ id: String(v), patch: pendingUpdate }); pendingUpdate = null; }
          return chain;
        },
        gte() { return chain; }, order() { return chain; }, limit() { return chain; }, in() { return chain; }, neq() { return chain; },
        maybeSingle() {
          if (table === "contributions") {
            if (filters.id === contribution.id) return Promise.resolve({ data: contribution, error: null });
            if (filters.id === ORIG && o.original) return Promise.resolve({ data: o.original, error: null });
            return Promise.resolve({ data: null, error: null });
          }
          // 派工綁定：只有 /next 當時登記的那個來源雜湊對得上
          if (table === "verify_dispatches") {
            const hit = o.dispatchedHash != null && filters.ip_hash === o.dispatchedHash && filters.contribution_id === contribution.id;
            return Promise.resolve({ data: hit ? { contribution_id: contribution.id } : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(res: (v: unknown) => unknown) {
          const rows = table === "contribution_votes" ? (o.votes ?? []) : [];
          return Promise.resolve({ data: rows, error: null, count: 0 }).then(res);
        },
        insert(row: Row) { inserted.push({ table, ...row }); return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "v-new" }, error: null }) }) }; },
        update(patch: Row) { pendingUpdate = { table, ...patch }; return chain; },
        upsert() { return Promise.resolve({ error: null }); },
      };
      return chain;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { client, inserted, updated };
}

// 1.29.0 起帶指認的同意票要附中選會筆數；這裡用假的中選會回 1 筆，不打網路
const base = { agent_name: "dave", contribution_id: CID, verdict: "agree", note: "打開來源逐欄核對，登記日期與選區都對得上", resolved_politician_id: "new", cec_hits: 1, cec_people: 1 };
const cec = (() => Promise.resolve(new Response(JSON.stringify({ cand_data_list: [{ cand_name: "某某", cand_birthyear: "1970" }] })))) as typeof fetch;
const voteWrites = (rows: Row[]) => rows.filter((r) => r.table === "contribution_votes");

// ── 1 裁決驗證 ──────────────────────────────────────────────────────────────

const adjudication = { contribution_type: "adjudication", payload: { contribution_id: ORIG, outcome: "uphold" } };

Deno.test("1 裁決：原貢獻是同一個代號交的（不管 IP）→ 不能投裁決票", async () => {
  const { client, inserted } = fakeVerifyDb({
    contribution: adjudication,
    original: { agent_name: "Dave", contributor_ip_hash: "ip-whatever" },
    dispatchedHash: NEW,
  });
  const res = await handleVerify(client, base, NEW, undefined, "verify", cec, OLD);
  assertEquals(res.status, 403, JSON.stringify(res.body));
  assertEquals(res.body.error, "self_vote");
  assert(String(res.body.message).includes("裁決"), "要講是對自己那筆貢獻的裁決");
  assertEquals(voteWrites(inserted).length, 0);
});

Deno.test("1 裁決：原貢獻是同網段、不同代號交的 → 不擋（投票不看 IP）", async () => {
  for (const ip of [NEW, OLD]) {
    const { client } = fakeVerifyDb({
      contribution: adjudication,
      original: { agent_name: "proposer", contributor_ip_hash: ip },
      dispatchedHash: NEW,
    });
    const res = await handleVerify(client, base, NEW, undefined, "verify", cec, OLD);
    assertNotEquals(res.body.error, "self_vote", JSON.stringify(res.body));
  }
});

// ── 2 重複宣稱併票 ───────────────────────────────────────────────────────────

const CLAIM = {
  id: "11111111-1111-4111-8111-111111111111",
  contribution_type: "correction",
  payload: { target_table: "politician_elections", target_id: "9827", changes: [{ field: "candidate_status", correct_value: "registered" }] },
  agent_name: "a-zhen",
  contributor_ip_hash: NEW, // 同一個網段、別的代號交的待審宣稱
  status: "pending",
  source_urls: ["https://news.ltn.com.tw/news/politics/breakingnews/1"],
  agree_count: 0, disagree_count: 0, unsure_count: 0, score: 0,
};
const ITEM = {
  contribution_type: "correction",
  payload: { target_table: "politician_elections", target_id: "9827", changes: [{ field: "candidate_status", correct_value: "registered" }], reason: "自由時報 2026-09-04 報導已完成登記" },
  source_urls: ["https://news.ltn.com.tw/news/politics/breakingnews/1"],
  agent_name: "lampstand",
  agent_tool: "pi/deepseek-v4-flash",
};

function fakeContributeDb(claim: Row) {
  const inserted: unknown[][] = [];
  const api = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { q[col] = val; return chain; },
        in: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
        insert: (rows: unknown[]) => { inserted.push(rows); return { select: () => ({ data: (rows as Array<{ payload_hash: string }>).map((r, i) => ({ id: `new-${i}`, payload_hash: r.payload_hash })), error: null }) }; },
        delete: () => ({ in: () => ({ error: null }) }),
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) => {
          if (table === "contributions" && q.status === "pending") return res({ data: [claim], error: null, count: 0 });
          if (table === "politician_elections") return res({ data: [{ id: 9827 }], error: null, count: 0 });
          if (table === "politicians") return res({ data: [{ id: "22222222-2222-4222-8222-222222222222", merged_into: null }], error: null, count: 0 });
          return res({ data: [], error: null, count: 0 });
        },
      };
      return chain;
    },
  };
  return { api, inserted };
}

Deno.test("2 併票：同網段、不同代號交過同一宣稱 → 併成一票（不看 IP）", async () => {
  const { api, inserted } = fakeContributeDb(CLAIM);
  const verifyDb = fakeVerifyDb({ contribution: CLAIM });
  const votesTried: Row[] = [];
  await handleContribute(api, "https://x", ITEM, NEW, async (_s, body, ip, apply, via, cecFetch, legacy) => {
    const r = await handleVerify(verifyDb.client, body, ip, apply, via, cecFetch, legacy);
    votesTried.push({ status: r.status, error: (r.body as Row).error ?? null });
    return r;
  }, "report", undefined, undefined, OLD);
  assertEquals(votesTried.length, 1, "要嘗試併票");
  assertNotEquals(votesTried[0].error, "self_vote", "同網段不同代號不是自己");
  assertEquals(inserted.length, 0, "併成票就不另收一筆");
});

Deno.test("2 併票：自己（同代號）交的待審宣稱，再交一次 → 併不成自己的票，照原路收成新的一筆", async () => {
  const mine = { ...CLAIM, agent_name: "lampstand", contributor_ip_hash: "ip-elsewhere" };
  const { api, inserted } = fakeContributeDb(mine);
  const verifyDb = fakeVerifyDb({ contribution: mine });
  const votesTried: Row[] = [];
  const res = await handleContribute(api, "https://x", ITEM, NEW, async (_s, body, ip, apply, via, cecFetch, legacy) => {
    const r = await handleVerify(verifyDb.client, body, ip, apply, via, cecFetch, legacy);
    votesTried.push({ status: r.status, error: (r.body as Row).error });
    return r;
  }, "report", undefined, undefined, OLD);
  assert(votesTried.length === 0 || (votesTried[0].status === 403 && votesTried[0].error === "self_vote"), JSON.stringify(votesTried));
  assertEquals(voteWrites(verifyDb.inserted).length, 0, "不該寫進任何一張票");
  assertEquals(inserted.length, 1, "投不成就照常建這一筆，不能默默丟掉");
  assertEquals((res.body as Row).status, "pending");
});

// ── 3 /next 的 my_votes ─────────────────────────────────────────────────────

function fakeVotesDb(rows: Array<{ contribution_id: string; agent_name: string; actor_id?: string | null }>) {
  const calls: Array<{ op: string; col: string; val: string }> = [];
  return {
    calls,
    from(_t: string) {
      let pred: (r: Row) => boolean = () => true;
      const chain = {
        select() { return chain; },
        eq(c: string, v: string) { calls.push({ op: "eq", col: c, val: v }); pred = (r) => r[c] === v; return chain; },
        // ilike 不分大小寫；跳脫字元（反斜線＋字元）還原成字元本身
        ilike(c: string, v: string) {
          calls.push({ op: "ilike", col: c, val: v });
          const want = v.replace(/\\(.)/g, "$1").toLowerCase();
          pred = (r) => String(r[c]).toLowerCase() === want;
          return chain;
        },
        order() { return chain; },
        range() { return Promise.resolve({ data: rows.filter((r) => pred(r as Row)).map((r) => ({ contribution_id: r.contribution_id })), error: null }); },
      };
      return chain;
    },
  };
}

Deno.test("3 /next：my_votes 按代號（匿名）或帳號（DiTrust）查；同網段別人投過的不算我的", async () => {
  const db = fakeVotesDb([
    { contribution_id: "A-mine", agent_name: "Dave" },
    { contribution_id: "B-mine-2", agent_name: "dave" },
    { contribution_id: "C-same-net-other-agent", agent_name: "someone-else" },
    { contribution_id: "D-ditrust", agent_name: "dave-handle", actor_id: "ditrust:u1" },
  ]);
  const anon = await fetchMyVotedRows(db, { agentName: "dave", actorId: "net-hash" });
  assertEquals(anon.map((r) => r.contribution_id).sort(), ["A-mine", "B-mine-2"], "匿名的 actor_id 是網段雜湊，不當身份");
  assertEquals(db.calls[0].op, "ilike");
  const dt = await fetchMyVotedRows(db, { agentName: "whatever", actorId: "ditrust:u1" });
  assertEquals(dt.map((r) => r.contribution_id), ["D-ditrust"], "DiTrust 按 actor_id，換代號也算");
  assertEquals(db.calls.at(-1), { op: "eq", col: "actor_id", val: "ditrust:u1" });
  // 代號裡的 _ 是 ilike 萬用字元，要跳脫，不然 a_b 會撈到 aXb
  const esc = fakeVotesDb([{ contribution_id: "X", agent_name: "aXb" }, { contribution_id: "Y", agent_name: "a_b" }]);
  assertEquals((await fetchMyVotedRows(esc, { agentName: "a_b" })).map((r) => r.contribution_id), ["Y"]);

  // 接上 /next 實際用的排除：裁決的原貢獻是我投過的 → 這筆裁決不派給我
  const voted = new Set(anon.map((r) => r.contribution_id));
  const adj = (target: string) => ({
    contribution_type: "adjudication", payload: { contribution_id: target },
    id: `adj-${target}`, agent_name: "x", contributor_ip_hash: "y", source_urls: [], status: "pending",
  });
  const cands = [adj("A-mine"), adj("C-same-net-other-agent")];
  // deno-lint-ignore no-explicit-any
  const kept = excludeOwnAdjudications(cands as any, [], { agent_name: "dave", ip_hash: NEW, voted_ids: voted }, voted);
  assertEquals(kept.map((c) => (c.payload as Row).contribution_id), ["C-same-net-other-agent"]);
});

Deno.test("3 /next 接線：my_votes 走 fetchMyVotedRows({agentName, actorId})，不再用雜湊；驗證池不傳舊雜湊", async () => {
  const code = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assert(code.includes("fetchMyVotedRows(supabase, { agentName, actorId: actor.actor_id })"), "my_votes 要按代號／帳號查");
  assert(!code.includes("voterHashes"), "voterHashes 已刪");
  assert(!code.includes("p_legacy_ip_hash"), "驗證池不再傳舊雜湊");
  assert(!code.includes("legacyIpHashOf"), "/next 不再算舊雜湊");
  assert(!/"my votes"/.test(code), "舊的只查雜湊那段不該還在");
});

// ── 4 同代號重投與改票 ──────────────────────────────────────────────────────

const myVote = { id: "v-mine", agent_name: "Dave", verifier_ip_hash: "ip-from-before", note: "以前的備註" };

Deno.test("4 同代號（不管 IP）再投 → 409，而且講得出怎麼改票", async () => {
  const { client, inserted, updated } = fakeVerifyDb({ votes: [myVote], dispatchedHash: NEW });
  const res = await handleVerify(client, base, NEW, undefined, "verify", cec, OLD);
  assertEquals(res.status, 409);
  assertEquals(res.body.error, "already_voted");
  assert(String(res.body.message).includes("revise"), "死路要改成有出口：告訴它帶 revise");
  assertEquals(voteWrites(inserted).length, 0);
  assertEquals(updated.filter((u) => u.patch.table === "contribution_votes").length, 0);
});

Deno.test("4 同代號帶 revise:true → 覆寫那張票（UPDATE 不 INSERT）", async () => {
  const { client, inserted, updated } = fakeVerifyDb({ votes: [myVote], dispatchedHash: NEW });
  const res = await handleVerify(client, { ...base, revise: true, note: "換了不同網域的來源重新核對，欄位都對得上" }, NEW, undefined, "verify", cec, OLD);
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(res.body.revised, true);
  assertEquals(voteWrites(inserted).length, 0, "不該新增第二張票");
  const u = updated.find((x) => x.patch.table === "contribution_votes");
  assert(u, "要 UPDATE 那張票");
  assertEquals(u!.id, "v-mine");
  assertEquals(u!.patch.via, "verify:revise");
});

Deno.test("4 同網段別的代號的票不擋：同 IP、不同代號 → 照常當新票；帶 revise 但沒有自己的票也是新票", async () => {
  const other = { id: "v-x", agent_name: "zed", verifier_ip_hash: NEW, note: null };
  const a = fakeVerifyDb({ votes: [other], dispatchedHash: NEW });
  const r1 = await handleVerify(a.client, base, NEW, undefined, "verify", cec, OLD);
  assertEquals(r1.status, 201, JSON.stringify(r1.body));
  assertEquals(voteWrites(a.inserted).length, 1);
  const b = fakeVerifyDb({ votes: [other], dispatchedHash: NEW });
  const r2 = await handleVerify(b.client, { ...base, revise: true }, NEW, undefined, "verify", cec, OLD);
  assertEquals(r2.status, 201, JSON.stringify(r2.body));
  assertEquals(r2.body.revised, undefined);
  assertEquals(voteWrites(b.inserted).length, 1);
  assertEquals(b.updated.filter((x) => x.patch.table === "contribution_votes").length, 0);
});

// ── 5 輪換 IP ───────────────────────────────────────────────────────────────

const req = (ip: string) => new Request("https://x/", { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });

Deno.test("5 輪換 IP：/next 從 .21、/report 從 .22（同一個 /24）→ 派工綁定對得上，投得出去", async () => {
  const salt = "s";
  const atNext = await ipHashOf(req("160.79.106.21"), salt); // /next 當時登記的來源
  const atReport = await ipHashOf(req("160.79.106.22"), salt);
  const { client, inserted } = fakeVerifyDb({ dispatchedHash: atNext });
  const res = await handleVerify(client, base, atReport, undefined, "report", cec, await legacyIpHashOf(req("160.79.106.22"), salt));
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(voteWrites(inserted).length, 1);
  assertEquals((voteWrites(inserted)[0]).verifier_ip_hash, atReport);
});

Deno.test("5 輪換 IP：/report 來自別的 /24 → 仍是 409 not_dispatched（派工綁定仍認網段；那是「這筆是 /next 派的」的證明，不是投票條件）", async () => {
  const salt = "s";
  const atNext = await ipHashOf(req("160.79.106.21"), salt);
  const other = req("160.79.107.22");
  const { client } = fakeVerifyDb({ dispatchedHash: atNext });
  const res = await handleVerify(client, base, await ipHashOf(other, salt), undefined, "report", cec, await legacyIpHashOf(other, salt));
  assertEquals(res.status, 409);
  assertEquals(res.body.error, "not_dispatched");
});

Deno.test("5 去重不看 IP：同代號的舊票不管這次從哪個 IP 來都擋；同 IP 的別人票不擋", async () => {
  const salt = "s";
  const oldVote = { id: "v-before", agent_name: "dave", verifier_ip_hash: await ipHashOf(req("160.79.106.19"), salt), note: null };
  for (const ip of ["160.79.106.19", "160.79.106.21", "8.8.8.8"]) {
    const r = req(ip);
    const a = fakeVerifyDb({ votes: [oldVote], dispatchedHash: await ipHashOf(r, salt) });
    const res = await handleVerify(a.client, base, await ipHashOf(r, salt), undefined, "verify", cec, await legacyIpHashOf(r, salt));
    assertEquals(res.status, 409, ip);
    assertEquals(res.body.error, "already_voted", ip);
  }
  const r = req("160.79.106.19");
  const others = fakeVerifyDb({ votes: [{ ...oldVote, agent_name: "erin" }], dispatchedHash: await ipHashOf(r, salt) });
  const ok = await handleVerify(others.client, base, await ipHashOf(r, salt), undefined, "verify", cec, await legacyIpHashOf(r, salt));
  assertEquals(ok.status, 201, "同 IP 不同代號＝另一票");
});
