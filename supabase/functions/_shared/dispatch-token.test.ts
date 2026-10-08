import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { checkDispatchToken, DISPATCH_TOKEN_MINUTES, dispatchTokenId, dispatchTokenSecretFrom, issueDispatchToken, signDispatchToken } from "./dispatch-token.ts";
import { handleVerify } from "./verify-handler.ts";
import { handleContribute, ipHashOf } from "./contribute-handler.ts";
import { LEASE_MINUTES } from "./dispatch.ts";

/**
 * 派工憑證（#484，協議 1.81.0）。
 * 雲端代理領任務（GET /next）與交件（POST /report）的出口網段不同，#482 的 /24 只解同網段。
 * 憑證 = HMAC 簽章的 { task_id, 派出時間, 到期, 代號, 領任務時的網段雜湊 }。
 * 這支測試守五件事：
 *   1 跨網段帶憑證交得出去　2 不帶憑證照舊（同網段可、跨網段 409）　3 過期／task 不符／竄改／無效都擋，且不默默退回網段比對
 *   4 同一張憑證只能換一張票（去重沒被繞過）　5 追查只進 log：有綁定方式與雜湊前 8 碼，沒有原始 IP、沒有憑證原文
 */
const SECRET = "test-secret-for-dispatch-token-0123456789";
const CID = "11111111-2222-3333-4444-555555555555";
const OTHER_CID = "99999999-2222-3333-4444-555555555555";
const NET_A = "a".repeat(64); // /next 當時的網段
const NET_B = "b".repeat(64); // /report 當時的網段（跨網段）
const NET_C = "c".repeat(64); // 另一個網段
const NOW = Date.parse("2026-10-01T03:00:00Z"); // 固定在過去：tokenFor 簽出來的憑證在真實時間下一定已過期

type Row = Record<string, unknown>;

/** 有狀態的假資料庫：票寫進去之後，後面的查詢看得到（才測得出「同一張憑證投兩次」） */
function fakeDb(o: { dispatchedHash?: string | null; contribution?: Row } = {}) {
  const votes: Row[] = [];
  const contribution: Row = {
    id: CID, status: "pending", contribution_type: "policy",
    payload: { title: "測試政見" }, source_urls: ["https://example.test/a"],
    agent_name: "someone", contributor_ip_hash: "ip-other",
    agree_count: 0, disagree_count: 0, unsure_count: 0, score: 0,
    ...(o.contribution ?? {}),
  };
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        select() { return chain; },
        eq(c: string, v: unknown) { filters[c] = v; return chain; },
        gte() { return chain; }, order() { return chain; }, limit() { return chain; }, in() { return chain; }, neq() { return chain; },
        maybeSingle() {
          if (table === "contributions") return Promise.resolve({ data: filters.id === contribution.id ? contribution : null, error: null });
          if (table === "verify_dispatches") {
            const hit = o.dispatchedHash != null && filters.ip_hash === o.dispatchedHash && filters.contribution_id === contribution.id;
            return Promise.resolve({ data: hit ? { contribution_id: contribution.id } : null, error: null });
          }
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
        update() { return chain; },
        upsert() { return Promise.resolve({ error: null }); },
      };
      return chain;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { client, votes };
}

const vote = (agent = "dave", extra: Row = {}) => ({ agent_name: agent, contribution_id: CID, verdict: "agree", note: `打開來源逐欄核對，標題與內容都對得上（${agent}）`, ...extra });

const tokenFor = (taskId: string, h = NET_A, over: Partial<{ a: string; i: number; e: number }> = {}) =>
  signDispatchToken(SECRET, { t: taskId, a: "dave", i: NOW, e: NOW + DISPATCH_TOKEN_MINUTES * 60_000, h, ...over });

/** 攔 console.log，回傳那段期間的紀錄行 */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = orig;
  }
}

// ── 憑證本身 ────────────────────────────────────────────────────────────────

Deno.test("期限與現行租約一致（30 分鐘）", () => {
  assertEquals(DISPATCH_TOKEN_MINUTES, LEASE_MINUTES);
});

Deno.test("簽發→驗證：綁 task、代號、派出時間與領任務網段；期限內有效", async () => {
  const issued = await issueDispatchToken(SECRET, { taskId: `verify:${CID}`, agentName: "dave", ipHash: NET_A, now: NOW });
  assert(issued);
  assertEquals(issued.expiresAt, new Date(NOW + 30 * 60_000).toISOString());
  const chk = await checkDispatchToken(SECRET, issued.token, `verify:${CID}`, NOW + 29 * 60_000);
  assert(chk.ok);
  if (chk.ok) {
    assertEquals(chk.payload, { t: `verify:${CID}`, a: "dave", i: NOW, e: NOW + 30 * 60_000, h: NET_A });
    assertEquals(chk.tokenId, issued.tokenId);
    assertEquals(chk.tokenId.length, 8);
  }
});

Deno.test("過期、task 不符、竄改、換鑰匙、格式不對、沒有鑰匙 → 都不通過", async () => {
  const t = await tokenFor(`verify:${CID}`);
  assertEquals(await checkDispatchToken(SECRET, t, `verify:${CID}`, NOW + 30 * 60_000), { ok: false, reason: "expired" });
  assertEquals(await checkDispatchToken(SECRET, t, `verify:${OTHER_CID}`, NOW), { ok: false, reason: "task_mismatch" });
  // 竄改 payload（把網段換成別的、把到期延後）：簽章對不上
  const [pre, body, sig] = t.split(".");
  const forged = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  forged.e += 3600_000;
  const forgedBody = btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assertEquals(await checkDispatchToken(SECRET, `${pre}.${forgedBody}.${sig}`, `verify:${CID}`, NOW), { ok: false, reason: "bad_signature" });
  // 竄改簽章最後一碼
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  assertEquals(await checkDispatchToken(SECRET, `${pre}.${body}.${flipped}`, `verify:${CID}`, NOW), { ok: false, reason: "bad_signature" });
  assertEquals(await checkDispatchToken("another-secret-0123456789abcdef", t, `verify:${CID}`, NOW), { ok: false, reason: "bad_signature" });
  for (const junk of ["", "abc", "dpt1.only.two", `x.${body}.${sig}`, 123, {}, [], true]) {
    assertEquals((await checkDispatchToken(SECRET, junk, null, NOW)).ok, false, `junk ${JSON.stringify(junk)}`);
  }
  assertEquals(await checkDispatchToken(undefined, t, `verify:${CID}`, NOW), { ok: false, reason: "no_secret" });
  assertEquals(await issueDispatchToken(undefined, { taskId: "x", agentName: "dave", ipHash: NET_A }), null, "沒鑰匙就不發，派工照常");
});

Deno.test("鑰匙：DISPATCH_TOKEN_SECRET 優先，沒設退回 SUPABASE_SERVICE_ROLE_KEY，太短不收", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  assertEquals(dispatchTokenSecretFrom(env({ DISPATCH_TOKEN_SECRET: "x".repeat(20), SUPABASE_SERVICE_ROLE_KEY: "y".repeat(20) })), "x".repeat(20));
  assertEquals(dispatchTokenSecretFrom(env({ SUPABASE_SERVICE_ROLE_KEY: "y".repeat(20) })), "y".repeat(20));
  assertEquals(dispatchTokenSecretFrom(env({})), undefined);
  assertEquals(dispatchTokenSecretFrom(env({ SUPABASE_SERVICE_ROLE_KEY: "short" })), undefined);
});

// ── 投票：跨網段帶憑證 ──────────────────────────────────────────────────────

Deno.test("1 對照：沒帶憑證的跨網段仍是 409 not_dispatched，訊息指向憑證這條路", async () => {
  const { client, votes } = fakeDb({ dispatchedHash: NET_A }); // 派工列只有 A；B 沒有
  const without = await handleVerify(client, vote(), NET_B, undefined, "report", undefined, undefined, SECRET);
  assertEquals(without.status, 409);
  assertEquals(without.body.error, "not_dispatched");
  assertStringIncludes(String(without.body.message), "dispatch_token");
  assertEquals(votes.length, 0);
});

Deno.test("1 跨網段帶憑證可以交（用真實時間簽發）：票寫進去、來源是領任務的網段、紀錄有綁定方式", async () => {
  const { client, votes } = fakeDb({ dispatchedHash: null }); // 派工列一筆都沒有：不靠 IP
  const issued = await issueDispatchToken(SECRET, { taskId: `verify:${CID}`, agentName: "dave", ipHash: NET_A });
  assert(issued);
  const { result: res, lines } = await captureLogs(() =>
    handleVerify(client, vote("dave", { dispatch_token: issued.token }), NET_B, undefined, "report", undefined, undefined, SECRET)
  );
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(votes.length, 1);
  assertEquals(votes[0].verifier_ip_hash, NET_A, "來源是領任務的網段：一張憑證只能換一張票，跨網段也不多開來源");
  assertEquals(votes[0].via, "report");
  // log：一行結構化紀錄
  const rec = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r?.event === "dispatch_binding");
  assert(rec, `沒有 dispatch_binding 紀錄：${lines.join("|")}`);
  assertEquals(rec.binding, "token");
  assertEquals(rec.task_id, `verify:${CID}`);
  assertEquals(rec.agent_name, "dave");
  assertEquals(rec.token_id, issued.tokenId);
  assertEquals(rec.issued_net, NET_A.slice(0, 8));
  assertEquals(rec.report_net, NET_B.slice(0, 8));
  assertEquals(rec.cross_network, true);
  // 不記憑證原文、不記完整雜湊
  const all = lines.join("\n");
  assert(!all.includes(issued.token), "log 不能有憑證原文");
  assert(!all.includes(NET_A) && !all.includes(NET_B), "log 只放雜湊前 8 碼");
});

Deno.test("2 不帶憑證照舊：同網段可、跨網段 409；log 記 ip", async () => {
  const same = fakeDb({ dispatchedHash: NET_A });
  const { result: ok, lines } = await captureLogs(() => handleVerify(same.client, vote(), NET_A, undefined, "report", undefined, undefined, SECRET));
  assertEquals(ok.status, 201, JSON.stringify(ok.body));
  assertEquals(same.votes[0].verifier_ip_hash, NET_A);
  const rec = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r?.event === "dispatch_binding");
  assertEquals(rec?.binding, "ip");
  assertEquals(rec?.token_id, null);

  const cross = fakeDb({ dispatchedHash: NET_A });
  const bad = await handleVerify(cross.client, vote(), NET_B, undefined, "report", undefined, undefined, SECRET);
  assertEquals(bad.status, 409);
  assertEquals(bad.body.error, "not_dispatched");
  assertEquals(cross.votes.length, 0);
});

Deno.test("3 帶了無效的憑證 → 403 invalid_dispatch_token，不退回網段比對（即使網段對得上）", async () => {
  const { client, votes } = fakeDb({ dispatchedHash: NET_B }); // 網段比對本來會過
  const expired = await tokenFor(`verify:${CID}`); // NOW 在過去 → 過期
  const issued = await issueDispatchToken(SECRET, { taskId: `verify:${CID}`, agentName: "dave", ipHash: NET_A });
  assert(issued);
  const wrongTask = await issueDispatchToken(SECRET, { taskId: `verify:${OTHER_CID}`, agentName: "dave", ipHash: NET_A });
  assert(wrongTask);
  const [pre, body, sig] = issued.token.split(".");
  const tampered = `${pre}.${body.slice(0, -2)}${body.endsWith("AA") ? "BB" : "AA"}.${sig}`;
  const cases: Array<[string, unknown, string]> = [
    ["過期", expired, "expired"],
    ["task 不符（拿別筆的憑證）", wrongTask.token, "task_mismatch"],
    ["竄改", tampered, "bad_signature"],
    ["亂寫", "not-a-token", "malformed"],
    ["空字串", "", "malformed"],
    ["不是字串", 12345, "malformed"],
  ];
  for (const [name, tok, reason] of cases) {
    const res = await handleVerify(client, vote("dave", { dispatch_token: tok }), NET_B, undefined, "report", undefined, undefined, SECRET);
    assertEquals(res.status, 403, `${name}：${JSON.stringify(res.body)}`);
    assertEquals(res.body.error, "invalid_dispatch_token", name);
    assertEquals(res.body.reason, reason, name);
    assertEquals(typeof res.body.message, "string");
  }
  assertEquals(votes.length, 0, "全部擋下，一張票都不能寫");
  // 沒有鑰匙（伺服器沒設）也不能把「帶了憑證」當成沒帶
  const nokey = await handleVerify(client, vote("dave", { dispatch_token: issued.token }), NET_B, undefined, "report", undefined, undefined, undefined);
  assertEquals(nokey.status, 403);
  assertEquals(nokey.body.reason, "no_secret");
});

Deno.test("4 同一張憑證不能投兩票：第二次（換網段、換代號）被擋；去重沒被繞過", async () => {
  const { client, votes } = fakeDb({ dispatchedHash: null });
  const issued = await issueDispatchToken(SECRET, { taskId: `verify:${CID}`, agentName: "dave", ipHash: NET_A });
  assert(issued);
  const first = await handleVerify(client, vote("dave", { dispatch_token: issued.token }), NET_B, undefined, "report", undefined, undefined, SECRET);
  assertEquals(first.status, 201, JSON.stringify(first.body));
  // 同一張憑證，從第三個網段、換一個代號再投
  const second = await handleVerify(client, vote("erin", { dispatch_token: issued.token }), NET_C, undefined, "report", undefined, undefined, SECRET);
  assertEquals(second.status, 409, JSON.stringify(second.body));
  assertEquals(second.body.error, "already_voted");
  assertEquals(votes.length, 1, "仍然只有一張票");
  // 同樣的重複不帶 revise → 還是 409；而不是靜默覆寫
  const third = await handleVerify(client, vote("dave", { dispatch_token: issued.token }), NET_B, undefined, "report", undefined, undefined, SECRET);
  assertEquals(third.status, 409);
  assertEquals(votes.length, 1);
});

Deno.test("4 憑證不繞過「每個來源一票」：同一個網段領了兩張憑證，也只能投一票", async () => {
  const { client, votes } = fakeDb({ dispatchedHash: null });
  const t1 = await issueDispatchToken(SECRET, { taskId: `verify:${CID}`, agentName: "dave", ipHash: NET_A });
  const t2 = await issueDispatchToken(SECRET, { taskId: `verify:${CID}`, agentName: "erin", ipHash: NET_A, now: Date.now() + 1000 });
  assert(t1 && t2);
  assertNotEquals(t1.token, t2.token);
  assertEquals((await handleVerify(client, vote("dave", { dispatch_token: t1.token }), NET_B, undefined, "report", undefined, undefined, SECRET)).status, 201);
  const res = await handleVerify(client, vote("erin", { dispatch_token: t2.token }), NET_C, undefined, "report", undefined, undefined, SECRET);
  assertEquals(res.status, 409);
  assertEquals(res.body.error, "already_voted");
  assertEquals(votes.length, 1);
});

Deno.test("4 自己不能驗自己：提交者的網段是領任務的網段、或是交件當下的網段，都擋", async () => {
  const issued = await issueDispatchToken(SECRET, { taskId: `verify:${CID}`, agentName: "dave", ipHash: NET_A });
  assert(issued);
  // 提交者是領任務的網段 A
  const a = fakeDb({ contribution: { contributor_ip_hash: NET_A } });
  const ra = await handleVerify(a.client, vote("dave", { dispatch_token: issued.token }), NET_B, undefined, "report", undefined, undefined, SECRET);
  assertEquals(ra.status, 403);
  assertEquals(ra.body.error, "self_vote");
  // 提交者是交件當下的網段 B（領任務在 A、交件在 B，B 正是它自己交過那筆的網段）
  const b = fakeDb({ contribution: { contributor_ip_hash: NET_B } });
  const rb = await handleVerify(b.client, vote("dave", { dispatch_token: issued.token }), NET_B, undefined, "report", undefined, undefined, SECRET);
  assertEquals(rb.status, 403);
  assertEquals(rb.body.error, "self_vote");
  // 同代號也擋（照舊）
  const c = fakeDb({ contribution: { agent_name: "dave" } });
  assertEquals((await handleVerify(c.client, vote("dave", { dispatch_token: issued.token }), NET_B, undefined, "report", undefined, undefined, SECRET)).status, 403);
  assertEquals(a.votes.length + b.votes.length + c.votes.length, 0);
});

Deno.test("合併票（via merge）不收憑證路徑：系統配對的票照舊放行，且不受 body 裡的 dispatch_token 影響", async () => {
  const { client, votes } = fakeDb({ dispatchedHash: null });
  const res = await handleVerify(client, vote("dave", { dispatch_token: "garbage" }), NET_A, undefined, "merge", undefined, undefined, SECRET);
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(votes[0].verifier_ip_hash, NET_A);
});

// ── 交件 ────────────────────────────────────────────────────────────────────

const TASK = "auto:profile_gap:abc123";
const ITEM = {
  contribution_type: "correction",
  payload: { target_table: "politician_elections", target_id: "9827", changes: [{ field: "candidate_status", correct_value: "registered" }], reason: "自由時報 2026-09-04 報導已完成登記" },
  source_urls: ["https://news.ltn.com.tw/news/politics/breakingnews/1"],
  agent_name: "dave",
  agent_tool: "pi/deepseek-v4-flash",
  task_id: TASK,
};

function fakeContributeDb() {
  const inserted: Row[][] = [];
  const api = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { q[col] = val; return chain; },
        in: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
        insert: (rows: Row[]) => { inserted.push(rows); return { select: () => ({ data: rows.map((r, i) => ({ id: `new-${i}`, payload_hash: r.payload_hash })), error: null }) }; },
        delete: () => ({ in: () => ({ error: null }) }),
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) => {
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

Deno.test("交件：跨網段帶憑證 → 收；來源是領任務的網段；紀錄 binding=token", async () => {
  const { api, inserted } = fakeContributeDb();
  const issued = await issueDispatchToken(SECRET, { taskId: TASK, agentName: "dave", ipHash: NET_A });
  assert(issued);
  const { result: res, lines } = await captureLogs(() =>
    handleContribute(api, "https://x", { ...ITEM, dispatch_token: issued.token }, NET_B, undefined, "report", undefined, undefined, undefined, SECRET)
  );
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0][0].contributor_ip_hash, NET_A);
  assertEquals(inserted[0][0].actor_id, `ip:${NET_A}`, "身份鍵跟著來源網段走，額度才跟 /next 報的一致");
  const rec = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r?.event === "dispatch_binding");
  assertEquals(rec?.binding, "token");
  assertEquals(rec?.task_id, TASK);
  assertEquals(rec?.cross_network, true);
  assert(!lines.join("\n").includes(issued.token));
});

Deno.test("交件：不帶憑證照舊（來源是交件當下的網段）；紀錄 binding=none", async () => {
  const { api, inserted } = fakeContributeDb();
  const { result: res, lines } = await captureLogs(() =>
    handleContribute(api, "https://x", ITEM, NET_B, undefined, "report", undefined, undefined, undefined, SECRET)
  );
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(inserted[0][0].contributor_ip_hash, NET_B);
  const rec = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r?.event === "dispatch_binding");
  assertEquals(rec?.binding, "none");
});

Deno.test("交件：憑證過期／task 不符／竄改／亂寫 → 403，一筆都不寫", async () => {
  const issued = await issueDispatchToken(SECRET, { taskId: TASK, agentName: "dave", ipHash: NET_A });
  const other = await issueDispatchToken(SECRET, { taskId: "auto:profile_gap:zzz", agentName: "dave", ipHash: NET_A });
  const verifyTok = await issueDispatchToken(SECRET, { taskId: `verify:${CID}`, agentName: "dave", ipHash: NET_A });
  assert(issued && other && verifyTok);
  const expired = await tokenFor(TASK);
  const [pre, body, sig] = issued.token.split(".");
  const tampered = `${pre}.${body}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
  const cases: Array<[string, unknown, string]> = [
    ["過期", expired, "expired"],
    ["task 不符", other.token, "task_mismatch"],
    ["拿驗證的憑證來交件", verifyTok.token, "task_mismatch"],
    ["竄改", tampered, "bad_signature"],
    ["亂寫", "nope", "malformed"],
  ];
  for (const [name, tok, reason] of cases) {
    const { api, inserted } = fakeContributeDb();
    const res = await handleContribute(api, "https://x", { ...ITEM, dispatch_token: tok }, NET_B, undefined, "report", undefined, undefined, undefined, SECRET);
    assertEquals(res.status, 403, `${name}：${JSON.stringify(res.body)}`);
    assertEquals(res.body.error, "invalid_dispatch_token", name);
    assertEquals(res.body.reason, reason, name);
    assertEquals(inserted.length, 0, name);
  }
  // 批次裡混了別的任務
  const { api, inserted } = fakeContributeDb();
  const mixed = await handleContribute(api, "https://x", { contributions: [ITEM, { ...ITEM, task_id: "auto:profile_gap:zzz", payload: { ...ITEM.payload, target_id: "9828" } }], agent_name: "dave", dispatch_token: issued.token }, NET_B, undefined, "report", undefined, undefined, undefined, SECRET);
  assertEquals(mixed.status, 403);
  assertEquals(inserted.length, 0);
});

Deno.test("交件：憑證不進內容雜湊，24 小時內容去重不受影響", async () => {
  // 去重看內容雜湊，與來源無關；憑證不改它。這裡直接證明：帶憑證與不帶憑證的同一份內容，算出的 payload_hash 相同。
  const issued = await issueDispatchToken(SECRET, { taskId: TASK, agentName: "dave", ipHash: NET_A });
  assert(issued);
  const a = fakeContributeDb();
  const b = fakeContributeDb();
  await handleContribute(a.api, "https://x", { ...ITEM, dispatch_token: issued.token }, NET_B, undefined, "report", undefined, undefined, undefined, SECRET);
  await handleContribute(b.api, "https://x", ITEM, NET_B, undefined, "report", undefined, undefined, undefined, SECRET);
  assertEquals(a.inserted[0][0].payload_hash, b.inserted[0][0].payload_hash, "憑證不進內容雜湊，去重不受影響");
});

// ── 接線 ────────────────────────────────────────────────────────────────────

Deno.test("接線：/next 派出時發憑證（驗證、手動任務、自動缺口三處），不新增清單查詢；report／verify／contribute 把鑰匙傳進處理器", async () => {
  const next = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assertEquals(next.split("...(await tokenFor(").length - 1, 3, "派出的三處（驗證、手動、自動）各發一張");
  assertStringIncludes(next, "`verify:${pick.id}`");
  assert(!/dispatch_tokens/.test(next), "憑證不存資料庫（維護者 10-08：用 log 看就好）");
  const report = await Deno.readTextFile(new URL("../report/index.ts", import.meta.url));
  assert(/handleVerify\([^;]*dispatchSecret/.test(report), "report 的 verify 要傳鑰匙");
  assert(/handleContribute\([^;]*dispatchTokenSecretFrom/.test(report), "report 的 contribute 要傳鑰匙");
  const verify = await Deno.readTextFile(new URL("../verify/index.ts", import.meta.url));
  assert(/handleVerify\([^;]*dispatchTokenSecretFrom/.test(verify), "/verify 要傳鑰匙");
  const contribute = await Deno.readTextFile(new URL("../contribute/index.ts", import.meta.url));
  assert(/handleContribute\([^;]*dispatchTokenSecretFrom/.test(contribute), "/contribute 要傳鑰匙");
});

Deno.test("沒有新欄位、沒有新資料表：憑證與追查都不碰資料庫結構", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  for await (const f of Deno.readDir(dir)) {
    if (!f.name.startsWith("202610090")) continue;
    const sql = await Deno.readTextFile(new URL(f.name, dir));
    assert(!/dispatch_token|dispatch_binding/.test(sql.replace(/--[^\n]*/g, "").replace(/COMMENT ON[^;]*;/g, "")), `${f.name} 不該為憑證加欄位或表`);
  }
});

Deno.test("ipHashOf 仍是網段雜湊（憑證是補跨網段，不是取代 #482）", async () => {
  const mk = (ip: string) => new Request("https://x/", { headers: { "x-forwarded-for": ip } });
  assertEquals(await ipHashOf(mk("160.79.106.19"), "s"), await ipHashOf(mk("160.79.106.27"), "s"));
  assertNotEquals(await ipHashOf(mk("160.79.106.19"), "s"), await ipHashOf(mk("160.79.107.19"), "s"));
  assertEquals((await dispatchTokenId("abc")).length, 8);
});
