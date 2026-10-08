import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { loadEntry, type LoadedEntry, type RestCall } from "./entry-harness.ts";
import { checkDispatchToken, DISPATCH_TOKEN_MINUTES, signDispatchToken } from "./dispatch-token.ts";
import { ipHashOf, legacyIpHashOf } from "./contribute-handler.ts";

/**
 * 派工憑證的入口行為測試（#484 審查）：真的載入 next／report 入口，用真的 Request 打進去，
 * 底下的 PostgREST 用有狀態的假資料庫（fetch 被換掉）。不再用正則掃原始碼證明「有接線」。
 *
 * 場景都是雲端代理：GET /next 從網段 N1（10.1.1.x）、POST /report 從網段 R（10.2.2.x）。
 */
const SALT = "test-salt";
const SERVICE_KEY = "service-role-key-0123456789";
const CID = "11111111-2222-3333-4444-555555555555";
const TASK = "auto:profile_gap:abc123";
const env = (extra: Record<string, string | undefined> = {}) => ({
  SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, CONTRIBUTION_IP_SALT: SALT, ...extra,
});
const at = (ip: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string> ?? {}), "x-forwarded-for": ip } });
const N1 = "10.1.1.5";
const R = "10.2.2.9";
const netHash = (ip: string) => ipHashOf(new Request("https://x/", at(ip)), SALT);

type Row = Record<string, unknown>;

/** 有狀態的假資料庫：只實作入口用到的幾張表，其餘回空 */
function makeDb(o: { pool?: Row[]; queue?: Row[] } = {}) {
  const votes: Row[] = [];
  const contributions: Row[] = [];
  const dispatches: Row[] = [];
  const candidate: Row = {
    id: CID, contribution_type: "policy", payload: { title: "測試政見" }, source_urls: ["https://example.test/a"], note: null, task_id: null,
    agent_name: "someone", contributor_ip_hash: "someone-else", status: "pending", agree_count: 0, disagree_count: 0, unsure_count: 0,
    created_at: "2026-10-01T00:00:00Z", queue_at: "2026-10-01T00:00:00Z", score: 0, target_score: 3, effective_required: 3,
  };
  const eqFilters = (u: URL) => [...u.searchParams.entries()].filter(([, v]) => v.startsWith("eq.")).map(([k, v]) => [k, v.slice(3)] as const);
  const match = (rows: Row[], u: URL) => rows.filter((r) => eqFilters(u).every(([k, v]) => String(r[k]) === v));
  const router = (c: RestCall): unknown => {
    const t = c.target;
    if (t === "rpc/contribution_verify_pool") return o.pool ?? [candidate];
    if (t === "rpc/contribution_queue_tasks") return o.queue ?? [];
    if (t === "rpc/contribution_effective_agree") return 3;
    if (t === "contributions") {
      if (c.method === "POST") {
        const rows = (Array.isArray(c.body) ? c.body : [c.body]) as Row[];
        const made = rows.map((r, i) => ({ ...r, id: `00000000-0000-4000-8000-${String(contributions.length + i + 1).padStart(12, "0")}`, status: "pending", agree_count: 0, disagree_count: 0, unsure_count: 0, score: 0 }));
        contributions.push(...made);
        return made;
      }
      if (c.method === "PATCH") {
        for (const r of match(contributions, c.url)) Object.assign(r, c.body);
        return [];
      }
      const id = c.url.searchParams.get("id");
      if (id === `eq.${CID}`) return [candidate];
      if (id) return match(contributions, c.url);
      return undefined;
    }
    if (t === "contribution_votes") {
      if (c.method === "POST") {
        const row = { ...(c.body as Row), id: `vote-${votes.length + 1}` };
        votes.push(row);
        return [row];
      }
      if (c.method === "PATCH") {
        const hit = match(votes, c.url);
        for (const r of hit) Object.assign(r, c.body);
        return hit;
      }
      return match(votes, c.url);
    }
    if (t === "verify_dispatches") {
      if (c.method === "POST") { dispatches.push(c.body as Row); return []; }
      return match(dispatches, c.url);
    }
    if (t === "politician_elections") return [{ id: 9827 }];
    if (t === "politicians") return [{ id: "22222222-2222-4222-8222-222222222222", merged_into: null }];
    return undefined;
  };
  return { votes, contributions, dispatches, candidate, router };
}

async function withEntries<T>(
  db: ReturnType<typeof makeDb>,
  e: Record<string, string | undefined>,
  fn: (x: { next: LoadedEntry; report: LoadedEntry }) => Promise<T>,
): Promise<T> {
  const next = await loadEntry("../next/index.ts", e, db.router);
  const report = await loadEntry("../report/index.ts", e, db.router);
  // loadEntry 每次換掉全域；兩個入口都要用，所以 fetch／env 保持最後一次安裝的狀態，由兩者共用同一個 router
  try {
    return await fn({ next, report });
  } finally {
    report.restore();
    next.restore();
  }
}

const getNext = async (next: LoadedEntry, ip: string, agent = "dave") => {
  const res = await next.call(new Request(`https://x/next?agent_name=${agent}&agent_tool=claude-code/claude-sonnet-5`, at(ip)));
  return { status: res.status, json: await res.json() as Row };
};
const post = async (entry: LoadedEntry, ip: string, body: Row) => {
  const res = await entry.call(new Request("https://x/report", at(ip, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })));
  return { status: res.status, json: await res.json() as Row };
};
const voteBody = (extra: Row = {}) => ({ kind: "verify", contribution_id: CID, verdict: "agree", agent_name: "dave", agent_tool: "claude-code/claude-sonnet-5", note: "打開來源逐欄核對，標題與內容都對得上（dave）", ...extra });
const ITEM = {
  kind: "contribute", contribution_type: "correction",
  payload: { target_table: "politician_elections", target_id: "9827", changes: [{ field: "candidate_status", correct_value: "registered" }], reason: "自由時報 2026-09-04 報導已完成登記" },
  source_urls: ["https://news.ltn.com.tw/news/politics/breakingnews/1"], agent_name: "dave", agent_tool: "pi/deepseek-v4-flash", task_id: TASK,
};
const taskRow = { task_id: TASK, task_type: "profile_gap", target: { politician_id: "22222222-2222-4222-8222-222222222222" }, what_we_need: "補基本資料", hint_sources: [], reward: 1, queue_at: "2026-10-01T00:00:00Z" };
const logsOf = (lines: string[]) => lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Row[];
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; log: string[]; warn: string[] }> {
  const log: string[] = [], warn: string[] = [];
  const ol = console.log, ow = console.warn;
  console.log = (...a: unknown[]) => { log.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { warn.push(a.map(String).join(" ")); };
  try { return { result: await fn(), log, warn }; } finally { console.log = ol; console.warn = ow; }
}

// ── 驗證：/next（網段 N1）→ /report（網段 R）端到端 ─────────────────────────────────

Deno.test("端到端：N1 領、R 交——不帶憑證 409 not_dispatched；帶 /next 給的憑證 201，票的來源是 N1", async () => {
  const db = makeDb();
  await withEntries(db, env(), async ({ next, report }) => {
    const got = await getNext(next, N1);
    assertEquals(got.json.kind, "verify");
    const token = got.json.dispatch_token as string;
    assert(token && token.startsWith("dpt1."), "verify 派出要帶 dispatch_token");
    assertEquals(typeof got.json.dispatch_token_expires_at, "string");

    const without = await post(report, R, voteBody());
    assertEquals(without.status, 409);
    assertEquals(without.json.error, "not_dispatched");
    assertEquals(db.votes.length, 0);

    const { result: withTok, log } = await captureConsole(() => post(report, R, voteBody({ dispatch_token: token })));
    assertEquals(withTok.status, 201, JSON.stringify(withTok.json));
    assertEquals(db.votes.length, 1);
    assertEquals(db.votes[0].verifier_ip_hash, await netHash(N1), "來源是領任務的網段");
    const rec = logsOf(log).find((r) => r.event === "dispatch_binding");
    assertEquals(rec?.binding, "token");
    assertEquals(rec?.cross_network, true);
    assertEquals(rec?.issued_net, (await netHash(N1)).slice(0, 8));
    assertEquals(rec?.report_net, (await netHash(R)).slice(0, 8));
    assert(!log.join("\n").includes(token));
  });
});

Deno.test("端到端：同一個網段 N1 領、N1 內另一個 IP 交——不帶憑證照舊可交（#482），來源是 N1", async () => {
  const db = makeDb();
  await withEntries(db, env(), async ({ next, report }) => {
    await getNext(next, "10.1.1.5");
    const res = await post(report, "10.1.1.77", voteBody());
    assertEquals(res.status, 201, JSON.stringify(res.json));
    assertEquals(db.votes[0].verifier_ip_hash, await netHash("10.1.1.5"));
  });
});

Deno.test("端到端：同一張憑證換網段、換代號再投 → 409，仍只有一張票", async () => {
  const db = makeDb();
  await withEntries(db, env(), async ({ next, report }) => {
    const token = (await getNext(next, N1)).json.dispatch_token as string;
    assertEquals((await post(report, R, voteBody({ dispatch_token: token }))).status, 201);
    const again = await post(report, "10.3.3.3", voteBody({ dispatch_token: token, agent_name: "erin", note: "另一個代號打開來源核對，欄位都對得上（erin）" }));
    assertEquals(again.status, 409, JSON.stringify(again.json));
    assertEquals(again.json.error, "already_voted");
    assertEquals(db.votes.length, 1);
  });
});

Deno.test("端到端：過期、竄改、別筆的憑證 → 403 invalid_dispatch_token，一票不寫（即使網段對得上）", async () => {
  const db = makeDb();
  await withEntries(db, env(), async ({ next, report }) => {
    const h = await netHash(R);
    const t0 = Date.now() - 2 * DISPATCH_TOKEN_MINUTES * 60_000;
    const expired = await signDispatchToken(SERVICE_KEY, { t: `verify:${CID}`, a: "dave", i: t0, e: t0 + DISPATCH_TOKEN_MINUTES * 60_000, h });
    const other = await signDispatchToken(SERVICE_KEY, { t: "verify:99999999-2222-3333-4444-555555555555", a: "dave", i: Date.now(), e: Date.now() + 60_000, h });
    const good = (await getNext(next, N1)).json.dispatch_token as string;
    const tampered = good.slice(0, -3) + (good.endsWith("AAA") ? "BBB" : "AAA");
    db.dispatches.push({ contribution_id: CID, ip_hash: h }); // 網段比對本來會過
    for (const [name, tok, reason] of [["過期", expired, "expired"], ["別筆", other, "task_mismatch"], ["竄改", tampered, "bad_signature"], ["亂寫", "x.y", "malformed"]] as const) {
      const res = await post(report, R, voteBody({ dispatch_token: tok }));
      assertEquals(res.status, 403, name);
      assertEquals(res.json.error, "invalid_dispatch_token", name);
      assertEquals(res.json.reason, reason, name);
    }
    assertEquals(db.votes.length, 0);
  });
});

// ── verify 與 contribute 的憑證不能互相拿去用 ──────────────────────────────────────

Deno.test("驗證的憑證拿去交件、交件的憑證拿去投票，都被擋（task_mismatch）", async () => {
  const dbV = makeDb();
  const verifyToken = await withEntries(dbV, env(), async ({ next }) => (await getNext(next, N1)).json.dispatch_token as string);
  const dbT = makeDb({ pool: [], queue: [taskRow] });
  const taskToken = await withEntries(dbT, env(), async ({ next }) => {
    const g = await getNext(next, N1);
    assertEquals(g.json.kind, "task", JSON.stringify(g.json).slice(0, 300));
    return g.json.dispatch_token as string;
  });
  const db = makeDb();
  await withEntries(db, env(), async ({ report }) => {
    const c = await post(report, R, { ...ITEM, dispatch_token: verifyToken });
    assertEquals(c.status, 403, JSON.stringify(c.json));
    assertEquals(c.json.reason, "task_mismatch");
    assertEquals(db.contributions.length, 0);
    const v = await post(report, R, voteBody({ dispatch_token: taskToken }));
    assertEquals(v.status, 403, JSON.stringify(v.json));
    assertEquals(v.json.reason, "task_mismatch");
    assertEquals(db.votes.length, 0);
  });
});

// ── 交件與撤回 ──────────────────────────────────────────────────────────────

Deno.test("N1 領、R 交、R 撤：交件記 N1；撤回帶憑證成功，不帶 403 not_yours，別的任務的憑證 403", async () => {
  const db = makeDb({ pool: [], queue: [taskRow] });
  await withEntries(db, env(), async ({ next, report }) => {
    const got = await getNext(next, N1);
    assertEquals(got.json.kind, "task");
    assertEquals((got.json.item as Row).task_id, TASK);
    const token = got.json.dispatch_token as string;
    const made = await post(report, R, { ...ITEM, dispatch_token: token });
    assertEquals(made.status, 201, JSON.stringify(made.json));
    assertEquals(db.contributions.length, 1);
    assertEquals(db.contributions[0].contributor_ip_hash, await netHash(N1), "帶憑證交件，存領任務的網段");
    const id = db.contributions[0].id as string;
    const reason = "來源打開後沒有提到這筆宣稱，我提交時沒有實際開啟";

    // 沒帶憑證從 R 撤：維持現狀（比回報網段）→ 403
    const noTok = await post(report, R, { kind: "withdraw", contribution_id: id, reason, agent_name: "dave" });
    assertEquals(noTok.status, 403);
    assertEquals(noTok.json.error, "not_yours");
    assertEquals(db.contributions[0].status, "pending");

    // 別的任務的憑證
    const otherTask = await signDispatchToken(SERVICE_KEY, { t: "auto:profile_gap:zzz", a: "dave", i: Date.now(), e: Date.now() + 60_000, h: await netHash(N1) });
    const wrong = await post(report, R, { kind: "withdraw", contribution_id: id, reason, agent_name: "dave", dispatch_token: otherTask });
    assertEquals(wrong.status, 403);
    assertEquals(wrong.json.reason, "task_mismatch");
    assertEquals(db.contributions[0].status, "pending");

    // 別的網段領的同一個任務的憑證（h 不是提交者）→ 不是本人
    const stranger = await signDispatchToken(SERVICE_KEY, { t: TASK, a: "mallory", i: Date.now(), e: Date.now() + 60_000, h: await netHash("10.9.9.9") });
    const notYou = await post(report, R, { kind: "withdraw", contribution_id: id, reason, agent_name: "mallory", dispatch_token: stranger });
    assertEquals(notYou.status, 403);
    assertEquals(notYou.json.error, "not_yours");

    // 驗證任務的憑證不能拿來撤回
    const wrongKind = await signDispatchToken(SERVICE_KEY, { t: `verify:${CID}`, a: "dave", i: Date.now(), e: Date.now() + 60_000, h: await netHash(N1) });
    assertEquals((await post(report, R, { kind: "withdraw", contribution_id: id, reason, agent_name: "dave", dispatch_token: wrongKind })).json.reason, "task_mismatch");

    const ok = await post(report, R, { kind: "withdraw", contribution_id: id, reason, agent_name: "dave", dispatch_token: token });
    assertEquals(ok.status, 200, JSON.stringify(ok.json));
    assertEquals(db.contributions[0].status, "withdrawn");
  });
});

Deno.test("撤回：沒帶憑證時 N1 內的人照舊撤得掉（維持現狀）；過期的憑證撤回 403", async () => {
  const db = makeDb({ pool: [], queue: [taskRow] });
  await withEntries(db, env(), async ({ next, report }) => {
    await getNext(next, N1);
    const made = await post(report, N1, ITEM);
    assertEquals(made.status, 201, JSON.stringify(made.json));
    const id = db.contributions[0].id as string;
    const t0 = Date.now() - 3600_000;
    const expired = await signDispatchToken(SERVICE_KEY, { t: TASK, a: "dave", i: t0, e: t0 + 60_000, h: await netHash(N1) });
    const e = await post(report, R, { kind: "withdraw", contribution_id: id, reason: "來源打開後沒有提到這筆宣稱，我提交時沒有實際開啟", agent_name: "dave", dispatch_token: expired });
    assertEquals(e.status, 403);
    assertEquals(e.json.reason, "expired");
    const ok = await post(report, N1, { kind: "withdraw", contribution_id: id, reason: "來源打開後沒有提到這筆宣稱，我提交時沒有實際開啟", agent_name: "dave" });
    assertEquals(ok.status, 200, JSON.stringify(ok.json));
  });
});

// ── 憑證過期後改票 ───────────────────────────────────────────────────────────

Deno.test("改票：憑證過期後帶 revise:true 仍能覆寫自己那張票；沒有自己的票、沒帶 revise、竄改都不行", async () => {
  const db = makeDb();
  await withEntries(db, env(), async ({ next, report }) => {
    const token = (await getNext(next, N1)).json.dispatch_token as string;
    assertEquals((await post(report, R, voteBody({ dispatch_token: token }))).status, 201);
    const h1 = await netHash(N1);
    const t0 = Date.now() - 3600_000;
    const expired = await signDispatchToken(SERVICE_KEY, { t: `verify:${CID}`, a: "dave", i: t0, e: t0 + 60_000, h: h1 });
    // 過期、沒帶 revise → 擋
    assertEquals((await post(report, R, voteBody({ dispatch_token: expired }))).json.reason, "expired");
    // 過期＋revise，自己有票 → 覆寫
    const revised = await post(report, R, voteBody({ dispatch_token: expired, revise: true, verdict: "unsure", note: "換了來源重新核對，這次看不出欄位是否一致（dave）" }));
    assertEquals(revised.status, 201, JSON.stringify(revised.json));
    assertEquals(revised.json.revised, true);
    assertEquals(db.votes.length, 1, "仍只有一張票");
    assertEquals(db.votes[0].verdict, "unsure");
    assertEquals(db.votes[0].verifier_ip_hash, h1);
    // 竄改過的過期憑證 → 簽章先擋
    const forged = expired.slice(0, -3) + (expired.endsWith("AAA") ? "BBB" : "AAA");
    assertEquals((await post(report, R, voteBody({ dispatch_token: forged, revise: true }))).json.reason, "bad_signature");
    // 過期＋revise，但這個來源在這筆沒有票 → 擋
    const stranger = await signDispatchToken(SERVICE_KEY, { t: `verify:${CID}`, a: "erin", i: t0, e: t0 + 60_000, h: await netHash("10.8.8.8") });
    const noVote = await post(report, "10.7.7.7", voteBody({ dispatch_token: stranger, revise: true, agent_name: "erin", note: "我沒有投過這一筆卻想拿過期憑證改票（erin）" }));
    assertEquals(noVote.status, 403, JSON.stringify(noVote.json));
    assertEquals(noVote.json.reason, "expired");
    // 過期＋revise，別筆的憑證 → task_mismatch
    const otherTask = await signDispatchToken(SERVICE_KEY, { t: "verify:99999999-2222-3333-4444-555555555555", a: "dave", i: t0, e: t0 + 60_000, h: h1 });
    assertEquals((await post(report, R, voteBody({ dispatch_token: otherTask, revise: true }))).json.reason, "task_mismatch");
    assertEquals(db.votes.length, 1);
  });
});

Deno.test("改票：自己那張票是沒帶憑證、從回報網段 R 投的 → 帶過期憑證加 revise 也認得（領任務網段或回報網段任一個有票）", async () => {
  const db = makeDb();
  await withEntries(db, env(), async ({ report }) => {
    const hR = await netHash(R);
    db.dispatches.push({ contribution_id: CID, ip_hash: hR });
    assertEquals((await post(report, R, voteBody())).status, 201);
    assertEquals(db.votes[0].verifier_ip_hash, hR);
    const t0 = Date.now() - 3600_000;
    const expired = await signDispatchToken(SERVICE_KEY, { t: `verify:${CID}`, a: "dave", i: t0, e: t0 + 60_000, h: await netHash(N1) });
    const res = await post(report, R, voteBody({ dispatch_token: expired, revise: true, verdict: "disagree", evidence_url: "https://other.example.test/x", note: "另一個網域的來源寫的年份不同，與提交內容矛盾" }));
    assertEquals(res.status, 201, JSON.stringify(res.json));
    assertEquals(res.json.revised, true);
    assertEquals(db.votes.length, 1);
    assertEquals(db.votes[0].verifier_ip_hash, hR);
  });
});

// ── 鑰匙 ────────────────────────────────────────────────────────────────────

Deno.test("鑰匙：DISPATCH_TOKEN_SECRET 太短 → 當沒設，退回 service role key 簽發（不是不發）", async () => {
  const db = makeDb();
  const { result, warn } = await captureConsole(() => withEntries(db, env({ DISPATCH_TOKEN_SECRET: "short" }), async ({ next }) => (await getNext(next, N1)).json));
  const token = result.dispatch_token as string;
  assert(token, "太短的專用鑰匙不能讓 /next 停止發憑證");
  assert((await checkDispatchToken(SERVICE_KEY, token, `verify:${CID}`)).ok, "要用 service role key 簽");
  assertEquals((await checkDispatchToken("short", token, `verify:${CID}`)).ok, false);
  assertEquals(warn.length, 0, "退回去之後鑰匙可用，不需要警告");
});

Deno.test("鑰匙：兩個都不能用 → /next 不發憑證，每次冷啟動警告一行（不含鑰匙），第二次請求不重複警告", async () => {
  const db = makeDb();
  const e = env({ DISPATCH_TOKEN_SECRET: "tooshort-secret", SUPABASE_SERVICE_ROLE_KEY: "tiny" });
  const { result, warn } = await captureConsole(() => withEntries(db, e, async ({ next }) => {
    const a = (await getNext(next, N1)).json;
    const b = (await getNext(next, N1)).json;
    return [a, b];
  }));
  for (const j of result) {
    assertEquals(j.success, true);
    assertEquals(j.dispatch_token, undefined, "沒有鑰匙就不發");
    assertEquals(j.kind, "verify", "派工照常");
  }
  assertEquals(warn.length, 1, `應該只警告一次：${warn.join("|")}`);
  assertStringIncludes(warn[0], "dispatch_token");
  assertStringIncludes(warn[0], "短於 16");
  assert(!warn[0].includes("tooshort-secret") && !warn[0].includes("tiny"), "警告不能含鑰匙");
});

Deno.test("鑰匙：完全沒設 → 警告寫『沒設』；帶憑證的回報 403 no_secret，不當成沒帶", async () => {
  const db = makeDb();
  const e = env({ DISPATCH_TOKEN_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: "tiny" }); // 少了 service role key 入口自己就建不了 client，所以用「太短」代表不可用
  const { result, warn } = await captureConsole(() => withEntries(db, e, async ({ next, report }) => {
    await getNext(next, N1);
    const tok = await signDispatchToken(SERVICE_KEY, { t: `verify:${CID}`, a: "dave", i: Date.now(), e: Date.now() + 60_000, h: await netHash(N1) });
    return await post(report, N1, voteBody({ dispatch_token: tok }));
  }));
  assertEquals(warn.length, 1);
  assertStringIncludes(warn[0], "沒設");
  assertEquals(result.status, 403);
  assertEquals(result.json.reason, "no_secret");
});

// ── 憑證格式：正規形式 ───────────────────────────────────────────────────────

Deno.test("憑證只有一種寫法：簽章尾端非零位元的變體被拒（atob 不拒絕，要重新編碼比對）", async () => {
  const secret = SERVICE_KEY;
  const token = await signDispatchToken(secret, { t: "x", a: "a", i: 1, e: Date.now() + 60_000, h: "h" });
  assert((await checkDispatchToken(secret, token, "x")).ok);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const [pre, body, sig] = token.split(".");
  // HMAC-SHA256 = 32 位元組 = 43 字元，最後一個字元只有高 4 位元有意義，低 2 位元必為 0；把低位元弄成非零就是另一種寫法
  const last = alphabet.indexOf(sig[sig.length - 1]);
  assertEquals(last % 4, 0);
  const variant = `${pre}.${body}.${sig.slice(0, -1)}${alphabet[last + 1]}`;
  assertNotEquals(variant, token);
  const r = await checkDispatchToken(secret, variant, "x");
  assertEquals(r.ok, false, "同一串位元組的第二種寫法不能通過");
  assertEquals(!r.ok && r.reason, "malformed");
});

// ── contribution_verify_pool 舊簽名相容 ──────────────────────────────────────

Deno.test("/next 對驗證池：IP 認不得（新舊雜湊同值）時用舊簽名的參數呼叫；認得時才多傳 p_legacy_ip_hash", async () => {
  const db = makeDb();
  await withEntries(db, env(), async ({ next, report }) => {
    // 沒有 x-forwarded-for → clientIp＝"unknown"，網段雜湊與舊雜湊同值
    await next.call(new Request("https://x/next?agent_name=dave"));
    await getNext(next, N1);
    // 兩個入口共用同一個假 fetch，最後安裝的是 report 那份，所以呼叫紀錄在它身上
    const pools = report.calls.filter((c) => c.target === "rpc/contribution_verify_pool");
    assertEquals(pools.length, 2);
    assertEquals(Object.keys(pools[0].body as Row).sort(), ["p_ip_hash", "p_limit", "p_region"], "舊簽名（沒有 p_legacy_ip_hash）");
    const legacy = await legacyIpHashOf(new Request("https://x/", at(N1)), SALT);
    assertEquals((pools[1].body as Row).p_legacy_ip_hash, legacy);
    assertEquals((pools[1].body as Row).p_ip_hash, await netHash(N1));
    assertNotEquals(legacy, await netHash(N1));
  });
});

Deno.test("SQL：新驗證池 = 舊簽名 + 一個有預設值的尾端參數；舊的四參數版本被 DROP；任何位置參數呼叫（≤4 個）仍解析得到", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const read = async (n: string) => (await Deno.readTextFile(new URL(n, dir))).replace(/\r\n/g, "\n");
  const params = (sql: string) => {
    const a = sql.indexOf("CREATE OR REPLACE FUNCTION contribution_verify_pool(");
    const open = sql.indexOf("(", a);
    const close = sql.indexOf(") RETURNS", a);
    return sql.slice(open + 1, close).split(",").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
  };
  const oldP = params(await read("20261006034900_policy_lineages.sql"));
  const newP = params(await read("20261009060000_verify_pool_legacy_hash.sql"));
  assertEquals(oldP, ["p_ip_hash TEXT", "p_region TEXT DEFAULT NULL", "p_limit INTEGER DEFAULT 30", "p_type TEXT DEFAULT NULL"]);
  assertEquals(newP.slice(0, 4), oldP, "前四個參數（名稱、順序、預設值）不變，舊呼叫才解析得到");
  assertEquals(newP.slice(4), ["p_legacy_ip_hash TEXT DEFAULT NULL"]);
  const mig = await read("20261009060000_verify_pool_legacy_hash.sql");
  assertStringIncludes(mig, "DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER, TEXT);");
  // 其他 SQL 呼叫端（位置參數）全部 ≤ 4 個參數
  let callers = 0;
  for await (const f of Deno.readDir(dir)) {
    if (!f.name.endsWith(".sql")) continue;
    const sql = await read(f.name);
    for (const m of sql.matchAll(/FROM contribution_verify_pool\(([^)]*)\)/g)) {
      callers++;
      assert(m[1].split(",").length <= 4, `${f.name}：${m[0]}`);
    }
  }
  assert(callers >= 1, "至少要掃到一個既有的位置參數呼叫（queue_ratio），不然這條斷言是空的");
});

// ── 三種派出路徑都發憑證；進階端點也收 ──────────────────────────────────────────

Deno.test("/next 手動任務（task_id 是 uuid）也發憑證，綁的就是那個 uuid", async () => {
  const MANUAL = "33333333-3333-4333-8333-333333333333";
  const db = makeDb({ pool: [], queue: [{ ...taskRow, task_id: MANUAL, task_type: "audit" }] });
  const inner = db.router;
  const router = (c: RestCall): unknown => {
    if (c.target === "contribution_tasks") return [{ id: MANUAL, title: "手動任務", description: "d", task_type: "audit", target: {}, region: null, priority: 0, reward: 1, source: "manual", suggested_by: null, hint_sources: [], created_at: "2026-10-01T00:00:00Z" }];
    return inner(c);
  };
  const entry = await loadEntry("../next/index.ts", env(), router);
  try {
    const res = await entry.call(new Request("https://x/next?agent_name=dave", at(N1)));
    const j = await res.json() as Row;
    assertEquals(j.kind, "task", JSON.stringify(j).slice(0, 300));
    assertEquals((j.item as Row).task_id, MANUAL);
    const chk = await checkDispatchToken(SERVICE_KEY, j.dispatch_token, MANUAL);
    assert(chk.ok, "手動任務的憑證要綁它的 uuid");
  } finally { entry.restore(); }
});

Deno.test("進階端點 /verify、/contribute 也收憑證（同一個處理器）：跨網段帶憑證交得出去，不帶仍 409／照舊", async () => {
  const db = makeDb({ pool: [], queue: [taskRow] });
  const tokenV = await signDispatchToken(SERVICE_KEY, { t: `verify:${CID}`, a: "dave", i: Date.now(), e: Date.now() + 60_000, h: await netHash(N1) });
  const tokenT = await signDispatchToken(SERVICE_KEY, { t: TASK, a: "dave", i: Date.now(), e: Date.now() + 60_000, h: await netHash(N1) });
  const verify = await loadEntry("../verify/index.ts", env(), db.router);
  try {
    const { kind: _k, ...body } = voteBody();
    const send = (extra: Row) => verify.call(new Request("https://x/verify", at(R, { method: "POST", body: JSON.stringify({ ...body, ...extra }), headers: { "content-type": "application/json" } })));
    assertEquals((await send({})).status, 409);
    const ok = await send({ dispatch_token: tokenV });
    assertEquals(ok.status, 201, await ok.text());
    assertEquals(db.votes[0].verifier_ip_hash, await netHash(N1));
  } finally { verify.restore(); }
  const contribute = await loadEntry("../contribute/index.ts", env(), db.router);
  try {
    const { kind: _k, ...item } = ITEM;
    const send = (extra: Row) => contribute.call(new Request("https://x/contribute", at(R, { method: "POST", body: JSON.stringify({ ...item, ...extra }), headers: { "content-type": "application/json" } })));
    const bad = await send({ dispatch_token: tokenV });
    assertEquals(bad.status, 403);
    const ok = await send({ dispatch_token: tokenT });
    assertEquals(ok.status, 201, await ok.text());
    assertEquals(db.contributions[0].contributor_ip_hash, await netHash(N1));
  } finally { contribute.restore(); }
});
