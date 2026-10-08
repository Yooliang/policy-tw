import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { handleVerify } from "./verify-handler.ts";
import { handleContribute, ipHashOf, legacyIpHashOf } from "./contribute-handler.ts";
import { fetchMyVotedRows, voterHashes } from "./my-votes.ts";
import { excludeOwnAdjudications } from "./dispatch.ts";

/**
 * 來源身份改看網段（#481，1.79.0）的過渡期：切換前存的是單一 IP 的舊雜湊（legacyIpHash），切換後是網段雜湊。
 * agy 同儕審查（PR #482）找到的缺口，逐點守住：
 *   1 裁決驗證要同時比新舊雜湊　2 重複宣稱併票要帶舊雜湊　3 /next 的 my_votes 新舊都查
 *   4 舊票可以 revise 並升級成新雜湊　5 輪換 IP 的情境要真的測（含舊資料認不出輪換 IP 的限制）
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

Deno.test("1 裁決：原貢獻是切換前（舊雜湊）交的，同一個來源不能投裁決票", async () => {
  const { client, inserted } = fakeVerifyDb({
    contribution: adjudication,
    original: { agent_name: "proposer", contributor_ip_hash: OLD },
    dispatchedHash: NEW,
  });
  const res = await handleVerify(client, base, NEW, undefined, "verify", cec, OLD);
  assertEquals(res.status, 403, JSON.stringify(res.body));
  assertEquals(res.body.error, "self_vote");
  assert(String(res.body.message).includes("裁決"), "要講是對自己那筆貢獻的裁決");
  assertEquals(voteWrites(inserted).length, 0);
});

Deno.test("1 裁決：原貢獻是別人交的（新舊雜湊都不同）→ 不會被誤擋", async () => {
  const { client } = fakeVerifyDb({
    contribution: adjudication,
    original: { agent_name: "proposer", contributor_ip_hash: "someone-elses" },
    dispatchedHash: NEW,
  });
  const res = await handleVerify(client, base, NEW, undefined, "verify", cec, OLD);
  assertNotEquals(res.body.error, "self_vote", JSON.stringify(res.body));
});

Deno.test("1 裁決：原貢獻是切換後（新網段雜湊）交的，照舊擋", async () => {
  const { client } = fakeVerifyDb({
    contribution: adjudication,
    original: { agent_name: "proposer", contributor_ip_hash: NEW },
    dispatchedHash: NEW,
  });
  const res = await handleVerify(client, base, NEW, undefined, "verify", cec, OLD);
  assertEquals(res.status, 403);
  assertEquals(res.body.error, "self_vote");
});

// ── 2 重複宣稱併票 ───────────────────────────────────────────────────────────

const CLAIM = {
  id: "11111111-1111-4111-8111-111111111111",
  contribution_type: "correction",
  payload: { target_table: "politician_elections", target_id: "9827", changes: [{ field: "candidate_status", correct_value: "registered" }] },
  agent_name: "a-zhen",
  contributor_ip_hash: OLD, // 切換前自己這個來源交的待審宣稱
  status: "pending",
  source_urls: ["https://news.ltn.com.tw/news/politics/breakingnews/1"],
  agree_count: 0, disagree_count: 0, unsure_count: 0, score: 0,
};
const ITEM = {
  contribution_type: "correction",
  payload: { target_table: "politician_elections", target_id: "9827", changes: [{ field: "candidate_status", correct_value: "registered" }], reason: "自由時報 2026-09-04 報導已完成登記" },
  source_urls: ["https://news.ltn.com.tw/news/politics/breakingnews/1"],
  agent_name: "lampstand", // 換了代號
  agent_tool: "pi/deepseek-v4-flash",
};

function fakeContributeDb() {
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
          if (table === "contributions" && q.status === "pending") return res({ data: [CLAIM], error: null, count: 0 });
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

Deno.test("2 併票：handleContribute 把舊雜湊交給投票端（不是 undefined）", async () => {
  const { api } = fakeContributeDb();
  let seen: string | undefined = "unset";
  let via: string | undefined;
  await handleContribute(api, "https://x", ITEM, NEW, (_s, _b, _ip, _apply, v, _cec, legacy) => {
    seen = legacy; via = v;
    return Promise.resolve({ status: 201, body: { agree_count: 1, required_agree: 2, status: "pending" } });
  }, "report", undefined, undefined, OLD);
  assertEquals(via, "merge");
  assertEquals(seen, OLD);
});

Deno.test("2 併票：切換前自己交的待審宣稱，換代號再交一次 → 併不成自己的票，照原路收成新的一筆", async () => {
  const { api, inserted } = fakeContributeDb();
  const verifyDb = fakeVerifyDb({ contribution: CLAIM });
  const votesTried: Row[] = [];
  const res = await handleContribute(api, "https://x", ITEM, NEW, async (_s, body, ip, apply, via, cecFetch, legacy) => {
    const r = await handleVerify(verifyDb.client, body, ip, apply, via, cecFetch, legacy);
    votesTried.push({ status: r.status, error: (r.body as Row).error });
    return r;
  }, "report", undefined, undefined, OLD);
  assertEquals(votesTried, [{ status: 403, error: "self_vote" }], "投票端要認出這是自己切換前交的");
  assertEquals(voteWrites(verifyDb.inserted).length, 0, "不該寫進任何一張票");
  assertEquals(inserted.length, 1, "投不成就照常建這一筆，不能默默丟掉");
  assertEquals((res.body as Row).status, "pending");
});

Deno.test("2 接線：report／contribute 兩個端點都把舊雜湊傳進 handleContribute", async () => {
  for (const f of ["../report/index.ts", "../contribute/index.ts"]) {
    const code = await Deno.readTextFile(new URL(f, import.meta.url));
    assert(/handleContribute\([^;]*legacyIpHash|handleContribute\([^;]*legacyIpHashOf/.test(code), `${f} 沒把舊雜湊傳給 handleContribute`);
  }
});

// ── 3 /next 的 my_votes ─────────────────────────────────────────────────────

function fakeVotesDb(rows: Array<{ contribution_id: string; verifier_ip_hash: string }>) {
  return {
    from(_t: string) {
      let want: string[] = [];
      const chain = {
        select() { return chain; },
        in(_c: string, vs: string[]) { want = vs; return chain; },
        eq(_c: string, v: string) { want = [v]; return chain; },
        order() { return chain; },
        range() { return Promise.resolve({ data: rows.filter((r) => want.includes(r.verifier_ip_hash)).map((r) => ({ contribution_id: r.contribution_id })), error: null }); },
      };
      return chain;
    },
  };
}

Deno.test("3 /next：my_votes 新舊雜湊都查，切換前投過票的爭議案件不會又派回給自己裁決", async () => {
  const db = fakeVotesDb([
    { contribution_id: "A-before-switch", verifier_ip_hash: OLD },
    { contribution_id: "B-after-switch", verifier_ip_hash: NEW },
    { contribution_id: "C-someone-else", verifier_ip_hash: "other" },
  ]);
  const rows = await fetchMyVotedRows(db, voterHashes(NEW, OLD));
  const voted = new Set(rows.map((r) => r.contribution_id));
  assertEquals([...voted].sort(), ["A-before-switch", "B-after-switch"]);

  // 接上 /next 實際用的排除：裁決的原貢獻是 A（我切換前投過）→ 這筆裁決不派給我
  const adj = (target: string) => ({
    contribution_type: "adjudication", payload: { contribution_id: target },
    id: `adj-${target}`, agent_name: "x", contributor_ip_hash: "y", source_urls: [], status: "pending",
  });
  const cands = [adj("A-before-switch"), adj("B-after-switch"), adj("C-someone-else")];
  // deno-lint-ignore no-explicit-any
  const kept = excludeOwnAdjudications(cands as any, [], { agent_name: "dave", ip_hash: NEW, voted_ids: voted }, voted);
  assertEquals(kept.map((c) => (c.payload as Row).contribution_id), ["C-someone-else"]);
});

Deno.test("3 /next：舊雜湊與新雜湊同值（IP 認不得）時只查一個；沒有舊雜湊也一樣", () => {
  assertEquals(voterHashes(NEW, NEW), [NEW]);
  assertEquals(voterHashes(NEW, undefined), [NEW]);
  assertEquals(voterHashes(NEW, OLD), [NEW, OLD]);
});

Deno.test("3 /next 接線：my_votes 走 fetchMyVotedRows(voterHashes(新, 舊))，不再只 eq 新雜湊", async () => {
  const code = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assert(code.includes("fetchMyVotedRows(supabase, voterHashes(ipHash, legacyIpHash))"), "my_votes 要新舊都查");
  assert(code.includes("legacyIpHashOf(req, ipSalt)"), "/next 要算舊雜湊");
  assert(!/"my votes"/.test(code), "舊的只查新雜湊那段不該還在");
});

// ── 4 舊票 revise ───────────────────────────────────────────────────────────

const legacyVote = { id: "v-legacy", agent_name: "dave-old-name", verifier_ip_hash: OLD, note: "以前的備註" };

Deno.test("4 舊票沒帶 revise → 409，而且講得出怎麼改票", async () => {
  const { client, inserted, updated } = fakeVerifyDb({ votes: [legacyVote], dispatchedHash: NEW });
  const res = await handleVerify(client, base, NEW, undefined, "verify", cec, OLD);
  assertEquals(res.status, 409);
  assertEquals(res.body.error, "already_voted");
  assert(String(res.body.message).includes("revise"), "死路要改成有出口：告訴它帶 revise");
  assertEquals(voteWrites(inserted).length, 0);
  assertEquals(updated.filter((u) => u.patch.table === "contribution_votes").length, 0);
});

Deno.test("4 舊票帶 revise:true → 覆寫那張票（UPDATE 不 INSERT），verifier_ip_hash 升級成新的網段雜湊", async () => {
  const { client, inserted, updated } = fakeVerifyDb({ votes: [legacyVote], dispatchedHash: NEW });
  const res = await handleVerify(client, { ...base, revise: true, note: "換了不同網域的來源重新核對，欄位都對得上" }, NEW, undefined, "verify", cec, OLD);
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(res.body.revised, true);
  assertEquals(voteWrites(inserted).length, 0, "不該新增第二張票");
  const u = updated.find((x) => x.patch.table === "contribution_votes");
  assert(u, "要 UPDATE 那張舊票");
  assertEquals(u!.id, "v-legacy");
  assertEquals(u!.patch.verifier_ip_hash, NEW, "舊雜湊要升級成網段雜湊");
  assertEquals(u!.patch.via, "verify:revise");
});

Deno.test("4 別人的舊票不受影響：帶 revise 但沒有自己的票 → 照常當新票", async () => {
  const { client, inserted, updated } = fakeVerifyDb({ votes: [{ id: "v-x", agent_name: "zed", verifier_ip_hash: "someone-else", note: null }], dispatchedHash: NEW });
  const res = await handleVerify(client, { ...base, revise: true }, NEW, undefined, "verify", cec, OLD);
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(res.body.revised, undefined);
  assertEquals(voteWrites(inserted).length, 1);
  assertEquals(updated.filter((x) => x.patch.table === "contribution_votes").length, 0);
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

Deno.test("5 輪換 IP：/report 來自別的 /24 → 仍是 409 not_dispatched（網段不同就是不同來源）", async () => {
  const salt = "s";
  const atNext = await ipHashOf(req("160.79.106.21"), salt);
  const other = req("160.79.107.22");
  const { client } = fakeVerifyDb({ dispatchedHash: atNext });
  const res = await handleVerify(client, base, await ipHashOf(other, salt), undefined, "report", cec, await legacyIpHashOf(other, salt));
  assertEquals(res.status, 409);
  assertEquals(res.body.error, "not_dispatched");
});

Deno.test("5 過渡期的限制：舊票只認得「同一個 IP」——固定 IP 認得出，輪換到同網段別的 IP 認不出（單向雜湊換算不了網段）", async () => {
  const salt = "s";
  const oldVote = { id: "v-before", agent_name: "dave", verifier_ip_hash: await legacyIpHashOf(req("160.79.106.19"), salt), note: null };

  // 切換後還是從 .19 來（固定 IP 的機器）：認得出，擋下
  const same = req("160.79.106.19");
  const a = fakeVerifyDb({ votes: [oldVote], dispatchedHash: await ipHashOf(same, salt) });
  const resSame = await handleVerify(a.client, base, await ipHashOf(same, salt), undefined, "verify", cec, await legacyIpHashOf(same, salt));
  assertEquals(resSame.status, 409);
  assertEquals(resSame.body.error, "already_voted");

  // 切換後從 .21 來（同一個 /24，IP 輪換）：舊票是 hash(.19)，這次的舊雜湊是 hash(.21)，對不上。
  // 這是數學上的限制，不是疏漏——文件（skill.md、DECISIONS）不能說輪換 IP 的舊資料也認得出來。
  const rotated = req("160.79.106.21");
  const b = fakeVerifyDb({ votes: [oldVote], dispatchedHash: await ipHashOf(rotated, salt) });
  const resRot = await handleVerify(b.client, base, await ipHashOf(rotated, salt), undefined, "verify", cec, await legacyIpHashOf(rotated, salt));
  assertEquals(resRot.status, 201, "輪換 IP 認不出切換前那張票；切換後新投的票是網段雜湊，之後的重複由新雜湊擋");
  assertEquals(voteWrites(b.inserted)[0].verifier_ip_hash, await ipHashOf(rotated, salt));

  // 而切換後留下的票（網段雜湊）不管 IP 怎麼輪都擋得住
  const after = { id: "v-after", agent_name: "dave", verifier_ip_hash: await ipHashOf(req("160.79.106.21"), salt), note: null };
  const third = req("160.79.106.27");
  const c = fakeVerifyDb({ votes: [after], dispatchedHash: await ipHashOf(third, salt) });
  const resAfter = await handleVerify(c.client, base, await ipHashOf(third, salt), undefined, "verify", cec, await legacyIpHashOf(third, salt));
  assertEquals(resAfter.status, 409);
  assertEquals(resAfter.body.error, "already_voted");
});
