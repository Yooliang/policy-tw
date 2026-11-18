import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildReportBody, CAUSE_CATEGORIES, handleStrongAdjudicate, type JobRow, type JobStatus, type Repo, type StrongAdjudicateDeps, toListItem } from "./strong-adjudicate.ts";
import { correctedSourceUrls } from "./strong-lane.ts";
import type { VerifyResult } from "./firebase-id-token.ts";

const OWNER = "owner@example.com";
const KEY = "k".repeat(32);
const OK_VERIFY: VerifyResult = { ok: true, claims: { sub: "u1", aud: "p", iss: "i", exp: 9e9, iat: 0, email: OWNER, email_verified: true } };
const NOW = new Date("2026-11-11T12:00:00Z");
const LANE_ITEM = { task_id: "t1", contribution_id: "c1", contribution_type: "policy", status: "disputed", subject: "王小明", votes: 5, created_at: "2026-11-08T12:00:00Z", reason: "投太多輪",
  verdicts: [{ verdict: "agree" }, { verdict: "disagree" }, { verdict: "disagree" }] };

let contribStatus = "disputed";
function memRepo(laneItems: Record<string, unknown>[] = [LANE_ITEM]) {
  const rows: JobRow[] = [];
  let n = 0;
  const repo: Repo = {
    strongLaneList: async () => ({ total: laneItems.length, items: laneItems }),
    jobsForTask: async (t) => rows.filter((r) => r.task_id === t).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    latestJobsByTask: async (ids) => rows.filter((r) => ids.includes(r.task_id)).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    insertJob: async (r) => {
      if (rows.some((x) => x.task_id === r.task_id && (x.status === "queued" || x.status === "running"))) return { row: null, conflict: true };
      const row = { id: `j${++n}`, ...r, status: "queued", claimed_by: null, claimed_at: null, completed_at: null, model: null, verdict: null, corrected_fields: null, reasoning: null, checked_urls: null, cause_category: null, cause_note: null, prompt_tokens: null, completion_tokens: null, cost: null, finalized_by: null, finalized_at: null, report_response: null, returned_by: null, returned_at: null, return_reason: null, error: null, last_error: null, claim_failures: 0, created_at: NOW.toISOString(), updated_at: NOW.toISOString() } as JobRow;
      rows.push(row);
      return { row, conflict: false };
    },
    getJob: async (id) => rows.find((r) => r.id === id) ?? null,
    transition: async (id, from: JobStatus[], patch) => {
      const r = rows.find((x) => x.id === id);
      if (!r || !from.includes(r.status)) return null;
      Object.assign(r, patch);
      return { ...r };
    },
    requeueStale: async (c) => {
      for (const r of rows) {
        if (r.status === "running" && r.claimed_at && r.claimed_at < c.runningCutoff) Object.assign(r, { status: "queued", claimed_at: null });
        if (r.status === "finalizing" && r.updated_at < c.finalizingCutoff) Object.assign(r, { status: "previewed", last_error: "finalize 逾時" });
      }
    },
    oldestQueued: async () => rows.filter((r) => r.status === "queued").sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null,
    jobsSince: async (s) => rows.filter((r) => r.created_at >= s),
    logUsage: async (u) => { usage.push(u); },
    contributionTypes: async (ids) => Object.fromEntries(ids.filter((i) => i === "c1").map((i) => [i, "policy"])),
    contributionStatus: async (id) => (id === "c1" ? contribStatus : null),
    contributionSourceUrls: async (id) => (id === "c1" ? ["https://orig.example.com/p.pdf", "https://xn--2lw665d.tw/self"] : []),
  };
  const usage: unknown[] = [];
  return { repo, rows, usage };
}

interface Calls { url: string; init?: RequestInit }
function setup(opts: { laneItems?: Record<string, unknown>[]; fetchImpl?: typeof fetch } = {}) {
  const m = memRepo(opts.laneItems);
  const calls: Calls[] = [];
  const fetchImpl: typeof fetch = opts.fetchImpl
    ? ((u, i) => { calls.push({ url: String(u), init: i }); return opts.fetchImpl!(u, i); }) as typeof fetch
    : (async (u, i) => { calls.push({ url: String(u), init: i }); return new Response(JSON.stringify({ success: true }), { status: 200 }); }) as typeof fetch;
  const deps: StrongAdjudicateDeps = { repo: m.repo, projectId: "policy-tw", ownerEmail: OWNER, laneKey: KEY, functionsBase: "https://x.test/functions/v1", fetchImpl, verifyToken: (async () => OK_VERIFY) as never, now: () => NOW };
  return { ...m, calls, deps };
}
const maint = (body: unknown) => new Request("https://x.test/strong-adjudicate", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body) });
const lane = (body: unknown, key: string | null = KEY) => new Request("https://x.test/strong-adjudicate", { method: "POST", headers: { ...(key ? { "x-strong-lane-key": key } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
const NEXT_OK = () => new Response(JSON.stringify({ kind: "task", item: { task_id: "t1", contribution: { id: "c1", contributor_ip_hash: "SECRETHASH" } }, type_spec: "spec", how_to: "x", dispatch_token: "tok" }), { status: 200 });
const RESULT = { verdict: "uphold", reasoning: "逐一打開來源核對，原貢獻的欄位皆有官方公告支持。", cause_category: "來源難讀", cause_note: "PDF 掃描檔", model: "claude-opus-5-5-20261101", prompt_tokens: 1000, completion_tokens: 200, cost: 0.12, checked_urls: ["https://example.com/a"] };

Deno.test("憑證：沒帶任何憑證 401、維護者動作只帶鑰匙 401、執行者動作帶錯鑰匙 403、非擁有者 403", async () => {
  const s = setup();
  const none = await handleStrongAdjudicate(new Request("https://x.test/", { method: "POST", body: JSON.stringify({ action: "list" }) }), s.deps);
  assertEquals(none.status, 401);
  assertEquals((await handleStrongAdjudicate(lane({ action: "list" }), s.deps)).status, 401);
  assertEquals((await handleStrongAdjudicate(maint({ action: "claim" }), s.deps)).status, 401);
  assertEquals((await handleStrongAdjudicate(lane({ action: "claim" }, "wrong-key-wrong-key-wrong"), s.deps)).status, 403);
  const other = { ...s.deps, verifyToken: (async () => ({ ok: true, claims: { ...(OK_VERIFY as { claims: object }).claims, email: "x@y.z" } })) as never };
  assertEquals((await handleStrongAdjudicate(maint({ action: "list" }), other)).status, 403);
  assertEquals((await handleStrongAdjudicate(lane({ action: "claim" }), { ...s.deps, laneKey: undefined })).status, 403);
  assertEquals(s.calls.length, 0);
});

Deno.test("list：轉換 strong_lane_list，票數分布、等待時數，帶最近一筆 job 狀態", async () => {
  const item = toListItem(LANE_ITEM, null, NOW);
  assertEquals(item.tally, { agree: 1, disagree: 2, unsure: 0 });
  assertEquals(item.waiting_hours, 72);
  const s = setup();
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps);
  const res = await handleStrongAdjudicate(maint({ action: "list" }), s.deps);
  const body = await res.json();
  assertEquals(body.items[0].job.status, "queued");
  assertEquals(body.total, 1);
});

Deno.test("enqueue：不在待辦 404；已有排隊／執行中 409；剛出爐 30 分鐘內 409", async () => {
  const s = setup();
  assertEquals((await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "nope" }), s.deps)).status, 404);
  assertEquals((await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps)).status, 200);
  assertEquals((await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps)).status, 409);
  s.rows[0].status = "previewed";
  assertEquals((await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps)).status, 409);
  s.rows[0].completed_at = "2026-11-11T10:00:00Z"; // 出爐在兩小時前（看 completed_at，不是 created_at）
  assertEquals((await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps)).status, 200);
});

Deno.test("claim：queued→running，用伺服器端鑰匙取題，回應不含鑰匙與 ip 雜湊／派工憑證", async () => {
  const s = setup({ fetchImpl: async () => NEXT_OK() });
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps);
  const res = await handleStrongAdjudicate(lane({ action: "claim" }), s.deps);
  const text = await res.text();
  assertEquals(res.status, 200);
  assert(!text.includes(KEY) && !text.includes("SECRETHASH") && !text.includes("dispatch_token"));
  assertEquals(s.rows[0].status, "running");
  assert(s.calls[0].url.includes("/next?") && s.calls[0].url.includes("lane=strong") && s.calls[0].url.includes("task_id=t1"));
  assertEquals((s.calls[0].init!.headers as Record<string, string>)["x-strong-lane-key"], KEY);
  assertEquals(JSON.parse(text).task.type_spec, "spec");
  // 沒有排隊的了
  assertEquals((await (await handleStrongAdjudicate(lane({ action: "claim" }), s.deps)).json()).job, null);
});

Deno.test("claim：題目已不在待辦（/next 回 none）→ 該筆 failed，不卡住", async () => {
  const s = setup({ fetchImpl: async () => new Response(JSON.stringify({ kind: "none", reason: "已結案" }), { status: 200 }) });
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps);
  const body = await (await handleStrongAdjudicate(lane({ action: "claim" }), s.deps)).json();
  assertEquals(body.job, null);
  assertEquals(s.rows[0].status, "failed");
});

Deno.test("claim：running 超過 30 分鐘自動退回 queued 可再領", async () => {
  const s = setup({ fetchImpl: async () => NEXT_OK() });
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps);
  await handleStrongAdjudicate(lane({ action: "claim" }), s.deps);
  s.rows[0].claimed_at = "2026-11-11T11:00:00Z";
  const again = await (await handleStrongAdjudicate(lane({ action: "claim" }), s.deps)).json();
  assertEquals(again.job.id, s.rows[0].id);
});

Deno.test("complete：驗證欄位（錯 verdict／類別／缺 corrected_fields／reasoning 太短）400；成功後自動送 /report 定案並寫用量", async () => {
  const s = setup({ fetchImpl: async () => NEXT_OK() });
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps);
  await handleStrongAdjudicate(lane({ action: "claim" }), s.deps);
  const id = s.rows[0].id;
  for (const bad of [{ verdict: "maybe" }, { cause_category: "亂寫" }, { verdict: "uphold_with_correction" }, { reasoning: "太短" }, { cost: -1 }, { checked_urls: ["ftp://x"] }]) {
    assertEquals((await handleStrongAdjudicate(lane({ action: "complete", adjudication_id: id, ...RESULT, ...bad }), s.deps)).status, 400, JSON.stringify(bad));
  }
  assertEquals(s.rows[0].status, "running");
  const ok = await handleStrongAdjudicate(lane({ action: "complete", adjudication_id: id, ...RESULT }), s.deps);
  assertEquals(ok.status, 200);
  assertEquals(s.rows[0].status, "finalized");
  assertEquals(s.usage.length, 1);
  assertEquals((await handleStrongAdjudicate(lane({ action: "complete", adjudication_id: id, ...RESULT }), s.deps)).status, 409);
});

async function previewed(corrected = false) {
  const s = setup({ fetchImpl: async () => NEXT_OK() });
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps);
  await handleStrongAdjudicate(lane({ action: "claim" }), s.deps);
  const extra = corrected ? { verdict: "uphold_with_correction", corrected_fields: { title: "新標題" } } : {};
  // complete 現在會自動定案；這裡讓 /report 連線失敗再把列改回 previewed，模擬「自動定案上線前留下的 previewed 舊資料」
  const realFetch = s.deps.fetchImpl;
  s.deps.fetchImpl = (async (u: string | URL | Request, i?: RequestInit) => { if (String(u).endsWith("/report")) throw new Error("down"); return realFetch!(u, i); }) as typeof fetch;
  await handleStrongAdjudicate(lane({ action: "complete", adjudication_id: s.rows[0].id, ...RESULT, ...extra }), s.deps);
  s.deps.fetchImpl = realFetch;
  Object.assign(s.rows[0], { status: "previewed", finalized_by: null, error: null, last_error: null, report_response: null });
  s.calls.length = 0;
  return s;
}

Deno.test("finalize：伺服器端帶鑰匙 POST /report，adjudication payload 形狀正確，成功→finalized；只能 finalize 一次", async () => {
  const s = await previewed(true);
  s.deps.fetchImpl = (async (u: string | URL | Request, i?: RequestInit) => { s.calls.push({ url: String(u), init: i }); return new Response(JSON.stringify({ success: true, kind: "contribute", dispatch_token: "x" }), { status: 200 }); }) as typeof fetch;
  const res = await handleStrongAdjudicate(maint({ action: "finalize", adjudication_id: s.rows[0].id }), s.deps);
  const text = await res.text();
  assertEquals(res.status, 200);
  assert(!text.includes(KEY));
  assertEquals(s.rows[0].status, "finalized");
  assertEquals(s.calls.length, 1);
  assert(s.calls[0].url.endsWith("/report"));
  assertEquals((s.calls[0].init!.headers as Record<string, string>)["x-strong-lane-key"], KEY);
  const sent = JSON.parse(String(s.calls[0].init!.body));
  assertEquals(sent.kind, "contribute");
  assertEquals(sent.contribution_type, "adjudication");
  assertEquals(sent.payload.contribution_id, "c1");
  assertEquals(sent.payload.verdict, "uphold_with_correction");
  assertEquals(sent.payload.corrected_fields, { title: "新標題" });
  assert(sent.payload.reason.length >= 20);
  assertEquals(sent.payload.checked_urls, ["https://example.com/a"]);
  assertEquals((await handleStrongAdjudicate(maint({ action: "finalize", adjudication_id: s.rows[0].id }), s.deps)).status, 409);
  assertEquals(s.calls.length, 1);
});

Deno.test("finalize：/report 拒收→finalize_failed，記錯誤、不重試；uphold 的 payload 不帶 corrected_fields", async () => {
  const s = await previewed();
  assert(!("corrected_fields" in (buildReportBody(s.rows[0]).payload as object)));
  s.deps.fetchImpl = (async () => new Response(JSON.stringify({ success: false, error: "correction_invalid" }), { status: 400 })) as typeof fetch;
  const res = await handleStrongAdjudicate(maint({ action: "finalize", adjudication_id: s.rows[0].id }), s.deps);
  assertEquals(res.status, 502);
  assertEquals(s.rows[0].status, "finalize_failed");
  assert(String(s.rows[0].error).includes("400"));
});

Deno.test("return_to_human：需 reason；previewed→returned；已 finalized 不能退", async () => {
  const s = await previewed();
  const id = s.rows[0].id;
  assertEquals((await handleStrongAdjudicate(maint({ action: "return_to_human", adjudication_id: id }), s.deps)).status, 400);
  assertEquals((await handleStrongAdjudicate(maint({ action: "return_to_human", adjudication_id: id, reason: "來源要人看" }), s.deps)).status, 200);
  assertEquals(s.rows[0].status, "returned");
  assertEquals(s.rows[0].return_reason, "來源要人看");
  s.rows[0].status = "finalized";
  assertEquals((await handleStrongAdjudicate(maint({ action: "return_to_human", adjudication_id: id, reason: "x" }), s.deps)).status, 409);
});

Deno.test("summary：成因計數、判決計數、成本合計與逐件列表", async () => {
  const s = await previewed();
  const body = await (await handleStrongAdjudicate(maint({ action: "summary", since: "2026-11-01" }), s.deps)).json();
  assertEquals(body.by_cause, { "來源難讀": 1 });
  assertEquals(body.by_verdict, { uphold: 1 });
  assertEquals(body.cost_total, 0.12);
  assertEquals(body.items.length, 1);
  assertEquals((await handleStrongAdjudicate(maint({ action: "summary", since: "not-a-date" }), s.deps)).status, 400);
});

Deno.test("守門：成因類別 TS 常數與 migration CHECK 同一份；原始碼不含鑰匙值、不呼叫模型；config 登記", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
  const mig = await read("../../migrations/20261111180000_strong_adjudications.sql");
  const m = /cause_category[^\n]*IN \(([^)]*)\)/.exec(mig);
  assert(m);
  assertEquals(m![1].split(",").map((x) => x.trim().replace(/'/g, "")), [...CAUSE_CATEGORIES]);
  assert(/ENABLE ROW LEVEL SECURITY/.test(mig) && /REVOKE ALL ON strong_adjudications FROM PUBLIC, anon, authenticated/.test(mig));
  for (const f of ["./strong-adjudicate.ts", "./strong-adjudicate-repo.ts", "../strong-adjudicate/index.ts"]) {
    const src = await read(f);
    assert(!/(sk-|eyJ)[A-Za-z0-9_-]{20,}/.test(src), `${f} 疑似含金鑰值`);
    assert(!/openrouter|anthropic\.com|chat\/completions/i.test(src), `${f} 不該呼叫模型`);
  }
  const cfg = await read("../../config.toml");
  const c = /\[functions\.strong-adjudicate\]([\s\S]*?)(?=\n\[|$)/.exec(cfg);
  assert(c && /verify_jwt = false/.test(c[1]) && c[1].includes("./functions/strong-adjudicate/index.ts"));
  const idx = await read("../strong-adjudicate/index.ts");
  assert(idx.includes("handleStrongAdjudicate("));
});

Deno.test("claim：/next 5xx／連線錯誤放回 queued 記 last_error，連續 3 次才 failed；成功後歸零", async () => {
  let mode: "500" | "throw" | "ok" = "500";
  const s = setup({ fetchImpl: async () => { if (mode === "throw") throw new Error("boom"); return mode === "500" ? new Response("oops", { status: 503 }) : NEXT_OK(); } });
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps);
  assertEquals((await handleStrongAdjudicate(lane({ action: "claim" }), s.deps)).status, 502);
  assertEquals(s.rows[0].status, "queued");
  assertEquals(s.rows[0].claim_failures, 1);
  assert(String(s.rows[0].last_error).includes("503"));
  mode = "throw";
  assertEquals((await handleStrongAdjudicate(lane({ action: "claim" }), s.deps)).status, 502);
  assertEquals(s.rows[0].claim_failures, 2);
  mode = "ok";
  assertEquals((await (await handleStrongAdjudicate(lane({ action: "claim" }), s.deps)).json()).job.id, s.rows[0].id);
  assertEquals(s.rows[0].claim_failures, 0);
  assertEquals(s.rows[0].status, "running");
  const s2 = setup({ fetchImpl: async () => new Response("x", { status: 500 }) });
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s2.deps);
  await handleStrongAdjudicate(lane({ action: "claim" }), s2.deps);
  await handleStrongAdjudicate(lane({ action: "claim" }), s2.deps);
  assertEquals(s2.rows[0].status, "queued");
  await handleStrongAdjudicate(lane({ action: "claim" }), s2.deps);
  assertEquals(s2.rows[0].status, "failed");
  assertEquals(s2.rows[0].claim_failures, 3);
});

Deno.test("claim：kind:none 的 failed.error 只存 kind 與前 80 字原因", async () => {
  const s = setup({ fetchImpl: async () => new Response(JSON.stringify({ kind: "none", reason: "x".repeat(300) }), { status: 200 }) });
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps);
  await handleStrongAdjudicate(lane({ action: "claim" }), s.deps);
  assertEquals(s.rows[0].status, "failed");
  assert(String(s.rows[0].error).length < 120 && String(s.rows[0].error).includes("none"));
});

Deno.test("finalizing 逾時（函式中途死掉）→ 回 previewed 記 last_error，可再 finalize；未逾時不動", async () => {
  const s = await previewed();
  s.rows[0].status = "finalizing";
  s.rows[0].updated_at = "2026-11-11T11:55:00Z";
  await handleStrongAdjudicate(maint({ action: "status", adjudication_id: s.rows[0].id }), s.deps);
  assertEquals(s.rows[0].status, "finalizing");
  s.rows[0].updated_at = "2026-11-11T11:40:00Z";
  const body = await (await handleStrongAdjudicate(maint({ action: "status", adjudication_id: s.rows[0].id }), s.deps)).json();
  assertEquals(body.job.status, "previewed");
  assert(body.job.last_error);
  assertEquals((await handleStrongAdjudicate(maint({ action: "finalize", adjudication_id: s.rows[0].id }), s.deps)).status, 200);
});

Deno.test("return_to_human：只收 previewed／failed／finalize_failed；queued／running／finalizing 不行", async () => {
  const s = await previewed();
  for (const st of ["running", "finalizing", "queued"] as const) {
    s.rows[0].status = st;
    s.rows[0].updated_at = NOW.toISOString();
    assertEquals((await handleStrongAdjudicate(maint({ action: "return_to_human", adjudication_id: s.rows[0].id, reason: "x" }), s.deps)).status, 409, st);
  }
  for (const st of ["failed", "finalize_failed"] as const) {
    s.rows[0].status = st;
    assertEquals((await handleStrongAdjudicate(maint({ action: "return_to_human", adjudication_id: s.rows[0].id, reason: "x" }), s.deps)).status, 200, st);
    s.rows[0].status = "previewed";
  }
});

Deno.test("complete：tokens／cost 超上限回 400 不是 500", async () => {
  const s = setup({ fetchImpl: async () => NEXT_OK() });
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps);
  await handleStrongAdjudicate(lane({ action: "claim" }), s.deps);
  for (const bad of [{ cost: 1e7 }, { prompt_tokens: 2e9 }, { completion_tokens: 1.5 }]) {
    assertEquals((await handleStrongAdjudicate(lane({ action: "complete", adjudication_id: s.rows[0].id, ...RESULT, ...bad }), s.deps)).status, 400, JSON.stringify(bad));
  }
});

Deno.test("finalize：回應 scrub（/report 回的 ip 雜湊、派工憑證不外流）；執行者鑰匙打 finalize 回 401", async () => {
  const s = await previewed();
  assertEquals((await handleStrongAdjudicate(lane({ action: "finalize", adjudication_id: s.rows[0].id }), s.deps)).status, 401);
  assertEquals(s.rows[0].status, "previewed");
  s.deps.fetchImpl = (async () => new Response(JSON.stringify({ success: true, contributor_ip_hash: "LEAKHASH", dispatch_token: "LEAKTOK", nested: { ip_hash: "LEAK2", ok: 1 } }), { status: 200 })) as typeof fetch;
  const res = await handleStrongAdjudicate(maint({ action: "finalize", adjudication_id: s.rows[0].id }), s.deps);
  const text = await res.text();
  assertEquals(res.status, 200);
  assert(!/LEAK/.test(text) && !text.includes(KEY));
  assertEquals(JSON.parse(text).job.report_response.nested, { ok: 1 });
  assert(!JSON.stringify(s.rows[0].report_response).includes("LEAK"));
});

Deno.test("summary／status／list：每件帶 contribution_type（join contributions），查不到＝null", async () => {
  const s = await previewed();
  const sum = await (await handleStrongAdjudicate(maint({ action: "summary", since: "2026-11-01" }), s.deps)).json();
  assertEquals(sum.items[0].contribution_type, "policy");
  const st = await (await handleStrongAdjudicate(maint({ action: "status", adjudication_id: s.rows[0].id }), s.deps)).json();
  assertEquals(st.job.contribution_type, "policy");
  const byTask = await (await handleStrongAdjudicate(maint({ action: "status", task_id: "t1" }), s.deps)).json();
  assertEquals(byTask.jobs[0].contribution_type, "policy");
  const list = await (await handleStrongAdjudicate(maint({ action: "list" }), s.deps)).json();
  assertEquals(list.items[0].contribution_type, "policy");
  s.rows[0].contribution_id = "gone";
  assertEquals((await (await handleStrongAdjudicate(maint({ action: "summary", since: "2026-11-01" }), s.deps)).json()).items[0].contribution_type, null);
});

const complete = (id: string, extra: Record<string, unknown> = {}) => lane({ action: "complete", adjudication_id: id, ...RESULT, ...extra });
async function running(fetchImpl: typeof fetch) {
  const s = setup({ fetchImpl });
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps);
  s.deps.fetchImpl = (async () => NEXT_OK()) as typeof fetch;
  await handleStrongAdjudicate(lane({ action: "claim" }), s.deps);
  s.deps.fetchImpl = fetchImpl;
  s.calls.length = 0;
  return s;
}
const reportBodies = (s: { calls: Calls[] }) => s.calls.filter((c) => c.url.endsWith("/report")).map((c) => JSON.parse(String(c.init!.body)));
const okFetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch;

Deno.test("自動定案：complete 後同一次呼叫就送 /report，成功→finalized", async () => {
  const s = await running(okFetch);
  s.deps.fetchImpl = (async (u: string | URL | Request, i?: RequestInit) => { s.calls.push({ url: String(u), init: i }); return okFetch(u, i); }) as typeof fetch;
  const res = await handleStrongAdjudicate(complete(s.rows[0].id), s.deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.finalized, true);
  assertEquals(body.job.status, "finalized");
  assertEquals(s.rows[0].status, "finalized");
  assertEquals(s.rows[0].finalized_by, "console-strong-adjudicate");
  assertEquals(reportBodies(s).length, 1);
  assertEquals(s.usage.length, 1);
});

Deno.test("自動定案：/report 拒收→finalize_failed，error 與 last_error 都寫；連線失敗同樣；之後可退回人工", async () => {
  const s = await running((async () => new Response(JSON.stringify({ success: false, error: "correction_invalid" }), { status: 400 })) as typeof fetch);
  const res = await handleStrongAdjudicate(complete(s.rows[0].id), s.deps);
  const body = await res.json();
  assertEquals(res.status, 200); // complete 本身收下了
  assertEquals(body.finalized, false);
  assertEquals(body.job.status, "finalize_failed");
  assert(String(body.job.error).includes("400") && String(body.job.last_error).includes("400"));
  assertEquals((await handleStrongAdjudicate(maint({ action: "return_to_human", adjudication_id: s.rows[0].id, reason: "來源要人看" }), s.deps)).status, 200);
  const s2 = await running((async () => { throw new Error("down"); }) as typeof fetch);
  const b2 = await (await handleStrongAdjudicate(complete(s2.rows[0].id), s2.deps)).json();
  assertEquals(b2.job.status, "finalize_failed");
  assert(b2.job.last_error);
});

Deno.test("手動 finalize 失敗也寫 last_error（主控台讀這欄）", async () => {
  const s = await previewed();
  s.deps.fetchImpl = (async () => new Response(JSON.stringify({ success: false }), { status: 422 })) as typeof fetch;
  await handleStrongAdjudicate(maint({ action: "finalize", adjudication_id: s.rows[0].id }), s.deps);
  assertEquals(s.rows[0].status, "finalize_failed");
  assert(String(s.rows[0].last_error).includes("422"));
});

Deno.test("自我引用剔除：checked_urls 裡的正見網址不送 /report；剔光改用 corrected_fields.source_urls，再不行用原貢獻來源", async () => {
  const SELF = "https://xn--2lw665d.tw/skill.md";
  const wrap = (s: { calls: Calls[]; deps: StrongAdjudicateDeps }) => {
    s.deps.fetchImpl = (async (u: string | URL | Request, i?: RequestInit) => { s.calls.push({ url: String(u), init: i }); return okFetch(u, i); }) as typeof fetch;
  };
  const s = await running(okFetch);
  wrap(s);
  await handleStrongAdjudicate(complete(s.rows[0].id, { checked_urls: [SELF, "https://example.com/a", "https://policy-tw.web.app/x"] }), s.deps);
  let sent = reportBodies(s)[0];
  assertEquals(sent.payload.checked_urls, ["https://example.com/a"]);
  assertEquals(sent.source_urls, ["https://example.com/a"]);

  const s2 = await running(okFetch);
  wrap(s2);
  await handleStrongAdjudicate(complete(s2.rows[0].id, { verdict: "uphold_with_correction", checked_urls: [SELF], corrected_fields: { source_urls: ["https://example.com/new.pdf", SELF] } }), s2.deps);
  sent = reportBodies(s2)[0];
  assertEquals(sent.source_urls, ["https://example.com/new.pdf"]);
  assertEquals(sent.payload.checked_urls, ["https://example.com/new.pdf"]);

  const s3 = await running(okFetch);
  wrap(s3);
  await handleStrongAdjudicate(complete(s3.rows[0].id, { checked_urls: [SELF] }), s3.deps);
  sent = reportBodies(s3)[0];
  assertEquals(sent.source_urls, ["https://orig.example.com/p.pdf"]); // 原貢獻來源也剔除自家網址
});

Deno.test("buildReportBody：全被剔光時用備用來源；沒有任何可用來源才是空（交給 /report 講原因）", () => {
  const base = { contribution_id: "c1", verdict: "uphold", reasoning: "r".repeat(30), model: "m", checked_urls: ["https://xn--2lw665d.tw/skill.md"], corrected_fields: null } as unknown as JobRow;
  assertEquals((buildReportBody(base, ["https://a.example.com/"]) as { source_urls: string[] }).source_urls, ["https://a.example.com/"]);
  assertEquals((buildReportBody(base) as { source_urls: string[] }).source_urls, []);
});

Deno.test("enqueue_all：排入沒有進行中作業的任務，回 enqueued／skipped；limit 截斷；非法 limit 400；執行者鑰匙 401", async () => {
  const items = ["t1", "t2", "t3", "t4"].map((t, i) => ({ ...LANE_ITEM, task_id: t, contribution_id: `c${i + 1}` }));
  const s = setup({ laneItems: items });
  // t1 已排隊、t2 剛出爐（30 分內 previewed）、t3 出爐在兩小時前（可再排）
  await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps);
  s.rows.push({ ...s.rows[0], id: "jx2", task_id: "t2", status: "previewed", completed_at: "2026-11-11T11:50:00Z" });
  s.rows.push({ ...s.rows[0], id: "jx3", task_id: "t3", status: "finalize_failed", completed_at: "2026-11-11T10:00:00Z" });
  const res = await handleStrongAdjudicate(maint({ action: "enqueue_all" }), s.deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.enqueued, 2);
  assertEquals(body.skipped, 2);
  assertEquals(body.jobs.map((j: { task_id: string }) => j.task_id), ["t3", "t4"]);
  assertEquals(s.rows.filter((r) => r.status === "queued").length, 3);
  // 再按一次：全部都在排隊或剛出爐
  const again = await (await handleStrongAdjudicate(maint({ action: "enqueue_all" }), s.deps)).json();
  assertEquals([again.enqueued, again.skipped], [0, 4]);
  // limit
  const s2 = setup({ laneItems: items });
  const lim = await (await handleStrongAdjudicate(maint({ action: "enqueue_all", limit: 3 }), s2.deps)).json();
  assertEquals([lim.enqueued, lim.skipped, lim.over_limit], [3, 0, 1]);
  for (const bad of [0, -1, 1.5, "5", 201]) assertEquals((await handleStrongAdjudicate(maint({ action: "enqueue_all", limit: bad }), s2.deps)).status, 400, String(bad));
  assertEquals((await handleStrongAdjudicate(lane({ action: "enqueue_all" }), s2.deps)).status, 401);
});

Deno.test("守門：applyAdjudication 的 uphold_with_correction 把 corrected_fields.source_urls 也寫回頂層 source_urls", async () => {
  const a = await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url));
  const i = a.indexOf("async function applyAdjudication");
  const fn = a.slice(i, a.indexOf("export async function closeTaskIfFulfilled", i));
  assert(fn.includes("correctedSourceUrls") && fn.includes("source_urls: correctedSourceUrls"));
  assert(fn.includes("fields.source_urls"));
});

const mkItems = (n: number) => Array.from({ length: n }, (_, i) => ({ ...LANE_ITEM, task_id: `t${i + 1}`, contribution_id: `c${i + 1}` }));
function seedJob(s: { rows: JobRow[] }, task: string, status: JobStatus, n: number, completed = "2026-11-11T09:00:00Z") {
  s.rows.push({ id: `seed-${task}-${n}`, task_id: task, contribution_id: "c1", status, completed_at: completed, created_at: `2026-11-1${n}T08:00:00Z`, updated_at: `2026-11-1${n}T08:00:00Z` } as JobRow);
}

Deno.test("enqueue_all：最新一筆是 returned 的件跳過（人退回的不自動再跑）", async () => {
  const s = setup({ laneItems: mkItems(2) });
  seedJob(s, "t1", "returned", 1);
  const body = await (await handleStrongAdjudicate(maint({ action: "enqueue_all" }), s.deps)).json();
  assertEquals([body.enqueued, body.skipped], [1, 1]);
  assertEquals(body.skipped_reasons, { busy: 0, returned: 1, retry_cap: 0 });
  assertEquals(body.jobs[0].task_id, "t2");
});

Deno.test("enqueue_all：failed／finalize_failed 各一筆可再排一次，排完累計 2 筆就不再排（retry_cap）", async () => {
  const s = setup({ laneItems: mkItems(2) });
  seedJob(s, "t1", "failed", 1);
  seedJob(s, "t2", "finalize_failed", 1);
  const first = await (await handleStrongAdjudicate(maint({ action: "enqueue_all" }), s.deps)).json();
  assertEquals(first.enqueued, 2);
  // 排進去的新作業做完又失敗：每件都已有 2 筆，第三次不排
  for (const r of s.rows.filter((x) => x.status === "queued")) r.status = "finalize_failed";
  const second = await (await handleStrongAdjudicate(maint({ action: "enqueue_all" }), s.deps)).json();
  assertEquals(second.enqueued, 0);
  assertEquals(second.skipped_reasons, { busy: 0, returned: 0, retry_cap: 2 });
  // 單件 enqueue 不受上限限制（人逐件決定）
  assertEquals((await handleStrongAdjudicate(maint({ action: "enqueue", task_id: "t1" }), s.deps)).status, 200);
});

Deno.test("enqueue_all：busy 與 returned 優先於 retry_cap 的計數；回傳三種原因加總＝skipped", async () => {
  const s = setup({ laneItems: mkItems(4) });
  seedJob(s, "t1", "queued", 1);
  seedJob(s, "t2", "returned", 1);
  seedJob(s, "t3", "failed", 1);
  seedJob(s, "t3", "failed", 2);
  const body = await (await handleStrongAdjudicate(maint({ action: "enqueue_all" }), s.deps)).json();
  assertEquals(body.skipped_reasons, { busy: 1, returned: 1, retry_cap: 1 });
  assertEquals(body.skipped, 3);
  assertEquals(body.enqueued, 1);
});

Deno.test("更正來源：剔除正見自家網址，剔光回 null（不改頂層）", () => {
  assertEquals(correctedSourceUrls({ source_urls: ["https://xn--2lw665d.tw/skill.md", "https://example.com/a.pdf", "ftp://x"] }), ["https://example.com/a.pdf"]);
  assertEquals(correctedSourceUrls({ source_urls: ["https://xn--2lw665d.tw/skill.md"] }), null);
  assertEquals(correctedSourceUrls({ title: "x" }), null);
});

Deno.test("自動定案：/report 回 409 no_strong_task 但原貢獻已 applied → 記 finalized；未 applied 仍 finalize_failed", async () => {
  const conflict = (async () => new Response(JSON.stringify({ success: false, error: "no_strong_task" }), { status: 409 })) as typeof fetch;
  const s = await running(conflict);
  contribStatus = "applied";
  const ok = await (await handleStrongAdjudicate(complete(s.rows[0].id), s.deps)).json();
  assertEquals([ok.finalized, ok.job.status], [true, "finalized"]);
  contribStatus = "disputed";
  const s2 = await running(conflict);
  const bad = await (await handleStrongAdjudicate(complete(s2.rows[0].id), s2.deps)).json();
  assertEquals([bad.finalized, bad.job.status], [false, "finalize_failed"]);
});

Deno.test("自動定案：寫回定案結果時資料庫丟錯不讓 complete 變 500", async () => {
  const s = await running(okFetch);
  const real = s.deps.repo.transition;
  s.deps.repo = { ...s.deps.repo, transition: async (id, from, patch) => { if (patch.status === "finalized") throw new Error("db down"); return real(id, from, patch); } };
  const res = await handleStrongAdjudicate(complete(s.rows[0].id), s.deps);
  assertEquals(res.status, 200);
});
