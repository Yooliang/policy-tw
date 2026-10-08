import { assert, assertEquals } from "jsr:@std/assert@1";
import { loadEntry, type LoadedEntry, type RestCall } from "./jp/entry-harness.ts";
import { checkDispatchToken, dispatchTokenSecretFrom, issueDispatchToken } from "./dispatch-token.ts";
import { jpDispatchTokenSecretFrom } from "./jp/dispatch-secret.ts";
import { ipHashOf } from "./jp/contribute-handler.ts";

/**
 * 日本站入口（jp-next／jp-report）的行為測試：真的載入入口、用真的 Request 打進去，底下是有狀態的假 PostgREST。
 * 重點：每個 REST 請求都帶 schema 標頭 policy_jp（GET／HEAD 是 accept-profile，其餘 content-profile）；
 * 正見簽的憑證在日本站驗不過；no_change 交件與驗證投票一整圈走得通。
 */
const SALT = "test-salt";
const SERVICE_KEY = "service-role-key-0123456789";
const CID = "11111111-2222-4333-8444-555555555555";
const TASK = "auto:policy_missing:abc123";
const env = (extra: Record<string, string | undefined> = {}) => ({
  SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, CONTRIBUTION_IP_SALT: SALT, ...extra,
});
const at = (ip: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string> ?? {}), "x-forwarded-for": ip } });
const N1 = "10.1.1.5";
const R = "10.2.2.9";
const netHash = (ip: string) => ipHashOf(new Request("https://x/", at(ip)), SALT);

type Row = Record<string, unknown>;

function makeDb(o: { pool?: Row[]; queue?: Row[]; allow?: string[] } = {}) {
  const votes: Row[] = [];
  const contributions: Row[] = [];
  const dispatches: Row[] = [];
  const candidate: Row = {
    id: CID, contribution_type: "correction", payload: { target_table: "policies", target_id: "p-1" }, source_urls: ["https://example.test/a"], note: null, task_id: null,
    agent_name: "someone", contributor_ip_hash: "someone-else", status: "pending", agree_count: 0, disagree_count: 0, unsure_count: 0,
    created_at: "2026-10-01T00:00:00Z", queue_at: "2026-10-01T00:00:00Z", score: 0, target_score: 3, effective_required: 3,
  };
  const eq = (u: URL) => [...u.searchParams.entries()].filter(([, v]) => v.startsWith("eq.")).map(([k, v]) => [k, v.slice(3)] as const);
  const match = (rows: Row[], u: URL) => rows.filter((r) => eq(u).every(([k, v]) => String(r[k]) === v));
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
      if (c.method === "PATCH") { for (const r of match(contributions, c.url)) Object.assign(r, c.body); return []; }
      const id = c.url.searchParams.get("id");
      if (id === `eq.${CID}`) return [candidate];
      if (id) return match(contributions, c.url);
      return undefined;
    }
    if (t === "contribution_votes") {
      if (c.method === "POST") { const row = { ...(c.body as Row), id: `vote-${votes.length + 1}` }; votes.push(row); return [row]; }
      if (c.method === "PATCH") { const hit = match(votes, c.url); for (const r of hit) Object.assign(r, c.body); return hit; }
      return match(votes, c.url);
    }
    if (t === "verify_dispatches") {
      if (c.method === "POST") { dispatches.push(c.body as Row); return []; }
      return match(dispatches, c.url);
    }
    return undefined;
  };
  return { votes, contributions, dispatches, candidate, router };
}

// 注意：兩個入口都載入時 fetch 只剩最後裝的那一個，所有 REST 請求都記在 report.calls（next.calls 是空的）
async function withEntries<T>(db: ReturnType<typeof makeDb>, e: Record<string, string | undefined>, fn: (x: { next: LoadedEntry; report: LoadedEntry }) => Promise<T>): Promise<T> {
  const next = await loadEntry("../../jp-next/index.ts", e, db.router);
  const report = await loadEntry("../../jp-report/index.ts", e, db.router);
  try { return await fn({ next, report }); } finally { report.restore(); next.restore(); }
}

const getNext = async (next: LoadedEntry, ip: string, agent = "dave") => {
  const res = await next.call(new Request(`https://x/jp-next?agent_name=${agent}&agent_tool=claude-code/claude-sonnet-5`, at(ip)));
  return { status: res.status, json: await res.json() as Row };
};
const post = async (entry: LoadedEntry, ip: string, body: Row) => {
  const res = await entry.call(new Request("https://x/jp-report", at(ip, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })));
  return { status: res.status, json: await res.json() as Row };
};
const voteBody = (extra: Row = {}) => ({ kind: "verify", contribution_id: CID, verdict: "agree", agent_name: "dave", agent_tool: "claude-code/claude-sonnet-5", note: "公式サイトの第三段落で内容が一致することを確認した（dave）", ...extra });
const NO_CHANGE = {
  kind: "contribute", contribution_type: "no_change", task_id: TASK, agent_name: "dave", agent_tool: "claude-code/claude-sonnet-5",
  payload: { task_id: TASK, outcome: "confirmed", checked_urls: ["https://www.pref.example.lg.jp/a"], finding: "公式サイトを開いて登録内容と一致することを確認した" },
};
const taskRow = { task_id: TASK, task_type: "policy_missing", target: { politician_id: "22222222-2222-4222-8222-222222222222" }, what_we_need: "公約を探す", hint_sources: [], reward: 1, queue_at: "2026-10-01T00:00:00Z" };

/** 每個 REST 請求都要帶 policy_jp 的 schema 標頭 */
function assertAllJpSchema(calls: RestCall[]) {
  assert(calls.length > 0, "應該有 REST 請求");
  for (const c of calls) {
    const readOnly = c.method === "GET" || c.method === "HEAD";
    const h = c.headers[readOnly ? "accept-profile" : "content-profile"];
    assertEquals(h, "policy_jp", `${c.method} ${c.target} 沒帶 policy_jp（${readOnly ? "accept" : "content"}-profile=${h}）`);
    assert(c.headers[readOnly ? "content-profile" : "accept-profile"] === undefined || c.headers[readOnly ? "content-profile" : "accept-profile"] === "policy_jp");
  }
}

Deno.test("jp-next：驗證項帶 policy_jp 標頭、發日本站憑證；每個 REST 請求都帶 schema 標頭", async () => {
  const db = makeDb();
  await withEntries(db, env(), async ({ next, report }) => {
    const got = await getNext(next, N1);
    assertEquals(got.status, 200);
    assertEquals(got.json.kind, "verify");
    assertEquals(got.json.protocol_version, "0.5.0");
    const token = got.json.dispatch_token as string;
    assert(token?.startsWith("dpt1."));
    // 是日本站的鑰匙簽的，不是正見的
    const env0 = (k: string) => env()[k as keyof ReturnType<typeof env>];
    assert((await checkDispatchToken(jpDispatchTokenSecretFrom(env0), token, `verify:${CID}`)).ok);
    assert(!(await checkDispatchToken(dispatchTokenSecretFrom(env0), token, `verify:${CID}`)).ok);
    assertAllJpSchema(report.calls);
    // 寫入也在 policy_jp：verify_dispatches 的 upsert
    assert(report.calls.some((c) => c.target === "verify_dispatches" && c.method === "POST"));
  });
});

Deno.test("jp-next：任務項（認領＋憑證）；寫入全在 policy_jp", async () => {
  const db = makeDb({ pool: [], queue: [taskRow] });
  await withEntries(db, env(), async ({ next, report }) => {
    const got = await getNext(next, N1);
    assertEquals(got.json.kind, "task");
    assertEquals((got.json.item as Row).task_id, TASK);
    assert(typeof got.json.dispatch_token === "string");
    assert(report.calls.some((c) => c.target === "contribution_task_leases" && c.method === "POST"));
    assertAllJpSchema(report.calls);
  });
});

Deno.test("no_change 一整圈：N1 領任務、R 帶憑證交件 201，提交者網段是 N1；全程 policy_jp", async () => {
  const db = makeDb({ pool: [], queue: [taskRow] });
  await withEntries(db, env(), async ({ next, report }) => {
    const got = await getNext(next, N1);
    const token = got.json.dispatch_token as string;
    const res = await post(report, R, { ...NO_CHANGE, dispatch_token: token });
    assertEquals(res.status, 201, JSON.stringify(res.json));
    assertEquals(res.json.kind, "contribute");
    assertEquals(res.json.status, "pending");
    assertEquals(res.json.required_agree, 2);
    assertEquals(db.contributions.length, 1);
    assertEquals(db.contributions[0].contributor_ip_hash, await netHash(N1));
    assertEquals(db.contributions[0].contribution_type, "no_change");
    assertAllJpSchema(report.calls);
  });
});

// 選舉日程（election，PR②）：election_discovery 臂的任務，代理查到選管的告示後交 election
const ED_TASK = "auto:election_discovery:2027-01-31:232033:head";
const edTaskRow = {
  task_id: ED_TASK, task_type: "election_discovery",
  target: { lg_code: "232033", election_type: "mayor", office_kind: "head", term_end: "2027-01-31" },
  what_we_need: "一宮市の長の任期は 2027-01-31 に満了します。", hint_sources: ["愛知県選挙管理委員会"], reward: 2, queue_at: "2026-10-01T00:00:00Z",
};
const ELECTION_SUBMIT = {
  kind: "contribute", contribution_type: "election", task_id: ED_TASK, agent_name: "dave", agent_tool: "claude-code/claude-sonnet-5",
  payload: { lg_code: "232033", election_type: "mayor", election_reason: "regular", election_date: "2027-01-24", notice_date: "2027-01-17", name: "一宮市長選挙" },
  source_urls: ["https://www.city.ichinomiya.aichi.jp/senkyo/"],
};

Deno.test("election 一整圈：領 election_discovery 任務、帶憑證交 election 201（目標 3 票、不是 light），提交者網段是領任務的網段；全程 policy_jp", async () => {
  const db = makeDb({ pool: [], queue: [edTaskRow] });
  await withEntries(db, env(), async ({ next, report }) => {
    const got = await getNext(next, N1);
    assertEquals(got.json.kind, "task");
    assertEquals((got.json.item as Row).task_type, "election_discovery");
    const res = await post(report, R, { ...ELECTION_SUBMIT, dispatch_token: got.json.dispatch_token });
    assertEquals(res.status, 201, JSON.stringify(res.json));
    assertEquals(res.json.contribution_type, "election");
    assertEquals(res.json.status, "pending");
    assertEquals(res.json.required_agree, 3, "election 要 3 票同儕驗證（no_change 才是 2）");
    assertEquals(db.contributions.length, 1);
    const saved = db.contributions[0];
    assertEquals(saved.contribution_type, "election");
    assertEquals(saved.task_id, ED_TASK);
    assertEquals(saved.contributor_ip_hash, await netHash(N1));
    assertEquals((saved.payload as Row).election_date, "2027-01-24");
    assertEquals(saved.source_urls, ELECTION_SUBMIT.source_urls);
    // 提交後釋放認領（刪的是這個 task_id 的 lease）
    assert(report.calls.some((c) => c.target === "contribution_task_leases" && c.method === "DELETE"));
    assertAllJpSchema(report.calls);
  });
});

Deno.test("election：格式不對整批 400（validation_failed），不寫任何東西", async () => {
  const db = makeDb({ pool: [], queue: [edTaskRow] });
  await withEntries(db, env(), async ({ report }) => {
    const bad = { ...ELECTION_SUBMIT, payload: { ...ELECTION_SUBMIT.payload, election_date: "2027-02-30", lg_code: "23203" } };
    const res = await post(report, N1, bad);
    assertEquals(res.status, 400);
    assertEquals(res.json.error, "validation_failed");
    assertEquals((res.json.errors as Array<{ path: string }>).map((e) => e.path).sort(), ["payload.election_date", "payload.lg_code"]);
    assertEquals(db.contributions.length, 0);
    // 不認得的型別（foo）一樣被擋
    const foo = await post(report, N1, { ...ELECTION_SUBMIT, contribution_type: "foo" });
    assertEquals(foo.status, 400);
    assertEquals(db.contributions.length, 0);
  });
});

Deno.test("驗證一整圈：帶憑證跨網段投票 201；票的來源是領任務的網段", async () => {
  const db = makeDb();
  await withEntries(db, env(), async ({ next, report }) => {
    const got = await getNext(next, N1);
    const without = await post(report, R, voteBody());
    assertEquals(without.status, 409);
    assertEquals(without.json.error, "not_dispatched");
    const ok = await post(report, R, voteBody({ dispatch_token: got.json.dispatch_token }));
    assertEquals(ok.status, 201, JSON.stringify(ok.json));
    assertEquals(db.votes.length, 1);
    assertEquals(db.votes[0].verifier_ip_hash, await netHash(N1));
    assertEquals(ok.json.required_agree, 3);
    assertAllJpSchema(report.calls);
  });
});

Deno.test("正見簽的憑證：jp-report 驗證與交件都回 403 invalid_dispatch_token（bad_signature），不寫任何東西", async () => {
  const db = makeDb();
  await withEntries(db, env(), async ({ report }) => {
    const e0 = (k: string) => env()[k as keyof ReturnType<typeof env>];
    const twTok = (await issueDispatchToken(dispatchTokenSecretFrom(e0), { taskId: `verify:${CID}`, agentName: "dave", ipHash: await netHash(N1) }))!.token;
    const v = await post(report, R, voteBody({ dispatch_token: twTok }));
    assertEquals(v.status, 403);
    assertEquals(v.json.error, "invalid_dispatch_token");
    assertEquals(v.json.reason, "bad_signature");
    const twTask = (await issueDispatchToken(dispatchTokenSecretFrom(e0), { taskId: TASK, agentName: "dave", ipHash: await netHash(N1) }))!.token;
    const c = await post(report, R, { ...NO_CHANGE, dispatch_token: twTask });
    assertEquals(c.status, 403);
    assertEquals(c.json.reason, "bad_signature");
    assertEquals(db.votes.length + db.contributions.length, 0);
  });
});

Deno.test("jp-report：kind 不認得 400；GET 405", async () => {
  const db = makeDb();
  await withEntries(db, env(), async ({ report }) => {
    const r = await post(report, N1, { kind: "nope", agent_name: "dave" });
    assertEquals(r.status, 400);
    const g = await report.call(new Request("https://x/jp-report", at(N1)));
    assertEquals(g.status, 405);
  });
});
