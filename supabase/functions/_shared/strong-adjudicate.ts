/**
 * 強模型裁決端點 strong-adjudicate 的業務邏輯（2026-11-11 維護者要求，主控台「強模型裁決」頁）。
 *
 * 這支端點**不呼叫任何模型**。分工：
 *   維護者（Firebase ID Token，同 console-admin）：list／enqueue／status／finalize／return_to_human／summary
 *   執行者（標頭 x-strong-lane-key ＝ STRONG_LANE_KEY，VM 上帶鑰匙的 claude）：claim／complete／fail
 * 流程：enqueue（queued）→ claim（running；回題目）→ complete（previewed；結果存表，不送 /report）→ 維護者 finalize
 * （伺服器端帶鑰匙 POST /report，adjudication，單一裁決即定案）或 return_to_human（returned，任務不動）。
 * STRONG_LANE_KEY 只在伺服器端與執行者手上；瀏覽器／主控台永遠不經手，回應也絕不含鑰匙。
 */
import { isConsoleOwner, verifyFirebaseIdToken } from "./firebase-id-token.ts";
import { correctionProblems, STRONG_KEY_HEADER, STRONG_VERDICTS, strongKeyOk } from "./strong-lane.ts";

type Obj = Record<string, unknown>;

/** 成因類別（固定值；migration 的 CHECK 是同一份，守門測試比對） */
export const CAUSE_CATEGORIES = ["來源難讀", "前提過時", "沒判斷型別", "身分", "拿錯名冊", "規格不清", "來源打不開", "其他"] as const;
export type CauseCategory = (typeof CAUSE_CATEGORIES)[number];
export const JOB_STATUSES = ["queued", "running", "previewed", "finalizing", "finalized", "finalize_failed", "returned", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** 對 /next、/report 自報的代號（只記錄，授權只看鑰匙） */
export const RUNNER_AGENT_NAME = "console-strong-adjudicate";
/** 同一件任務這段時間內已有一份待處理的結果，就不再排新的（避免重複燒錢） */
export const RECENT_WINDOW_MIN = 30;
/** running 超過這麼久沒 complete 就自動退回 queued */
export const RUNNING_STALE_MIN = 30;
export const MAX_REASONING = 1000;
export const MIN_REASONING = 20; // /report 的 reason 至少 20 字
export const MAX_CAUSE_NOTE = 300;
export const SUMMARY_LIMIT = 500;

export interface JobRow {
  id: string; task_id: string; contribution_id: string | null; status: JobStatus;
  requested_by: string; claimed_by: string | null; claimed_at: string | null; completed_at: string | null;
  model: string | null; verdict: string | null; corrected_fields: Obj | null; reasoning: string | null; checked_urls: string[] | null;
  cause_category: string | null; cause_note: string | null;
  prompt_tokens: number | null; completion_tokens: number | null; cost: number | null;
  finalized_by: string | null; finalized_at: string | null; report_response: unknown;
  returned_by: string | null; returned_at: string | null; return_reason: string | null; error: string | null;
  created_at: string; updated_at: string;
}

export interface UsageLog { model: string; prompt_tokens: number; completion_tokens: number; cost: number; note: string }

/** 資料層（index.ts 用 supabase 實作，測試用記憶體假的） */
export interface Repo {
  strongLaneList(): Promise<Obj>;
  jobsForTask(taskId: string, limit: number): Promise<JobRow[]>;
  /** 這些任務各自的 job，新→舊 */
  latestJobsByTask(taskIds: string[]): Promise<JobRow[]>;
  insertJob(row: { task_id: string; contribution_id: string | null; requested_by: string }): Promise<{ row: JobRow | null; conflict: boolean }>;
  getJob(id: string): Promise<JobRow | null>;
  /** 只有現況在 from 裡才改（條件式 UPDATE）；改到回新列，沒改到回 null */
  transition(id: string, from: JobStatus[], patch: Partial<JobRow>): Promise<JobRow | null>;
  requeueStale(cutoffIso: string): Promise<void>;
  oldestQueued(): Promise<JobRow | null>;
  jobsSince(sinceIso: string, limit: number): Promise<JobRow[]>;
  logUsage(u: UsageLog): Promise<void>;
}

export interface StrongAdjudicateDeps {
  repo: Repo;
  projectId: string;
  ownerEmail: string;
  /** STRONG_LANE_KEY（只在伺服器端；沒設或太短＝整條線關閉） */
  laneKey: string | undefined;
  /** 函式根網址（…/functions/v1），用來打 /next、/report */
  functionsBase: string;
  fetchImpl?: typeof fetch;
  verifyToken?: typeof verifyFirebaseIdToken;
  now?: () => Date;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": `authorization, x-client-info, apikey, content-type, ${STRONG_KEY_HEADER}`,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const fail = (error: string, status: number, extra: Obj = {}) => json({ success: false, error, ...extra }, status);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && typeof (e as Obj).message === "string") return (e as Obj).message as string;
  return String(e);
}

const LANE_ACTIONS = new Set(["claim", "complete", "fail"]);
const MAINTAINER_ACTIONS = new Set(["list", "enqueue", "status", "finalize", "return_to_human", "summary"]);
const SECRET_KEYS = /ip_hash|contributor_ip|x-strong-lane-key|lane_key|authorization|dispatch_token/i;

/** 遞迴拿掉不該外流的欄位（ip 雜湊、鑰匙、派工憑證） */
export function scrub<T>(v: T): T {
  if (Array.isArray(v)) return v.map(scrub) as unknown as T;
  if (v && typeof v === "object") {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v as Obj)) if (!SECRET_KEYS.test(k)) out[k] = scrub(x);
    return out as T;
  }
  return v;
}

/** 對外的 job 形狀 */
export function publicJob(j: JobRow): Obj {
  return {
    id: j.id, task_id: j.task_id, contribution_id: j.contribution_id, status: j.status, requested_by: j.requested_by,
    created_at: j.created_at, claimed_at: j.claimed_at, completed_at: j.completed_at, model: j.model,
    verdict: j.verdict, corrected_fields: j.corrected_fields, reasoning: j.reasoning, checked_urls: j.checked_urls,
    cause_category: j.cause_category, cause_note: j.cause_note,
    prompt_tokens: j.prompt_tokens, completion_tokens: j.completion_tokens, cost: j.cost,
    finalized_by: j.finalized_by, finalized_at: j.finalized_at, report_response: scrub(j.report_response ?? null),
    returned_by: j.returned_by, returned_at: j.returned_at, return_reason: j.return_reason, error: j.error,
  };
}

/** list 的一列：strong_lane_list 的項目整理成主控台好用的形狀＋最近一筆 job */
export function toListItem(raw: Obj, job: JobRow | null, now: Date): Obj {
  const verdicts = Array.isArray(raw.verdicts) ? (raw.verdicts as Obj[]) : [];
  const tally = { agree: 0, disagree: 0, unsure: 0 };
  for (const v of verdicts) { const k = String(v.verdict); if (k in tally) tally[k as keyof typeof tally]++; }
  const created = typeof raw.created_at === "string" ? Date.parse(raw.created_at) : NaN;
  return {
    task_id: raw.task_id, contribution_id: raw.contribution_id, contribution_type: raw.contribution_type ?? null,
    subject: raw.subject ?? "", reason: raw.reason ?? null, contribution_status: raw.status ?? null,
    votes: raw.votes ?? 0, tally, created_at: raw.created_at ?? null,
    waiting_hours: Number.isFinite(created) ? Math.max(0, Math.round((now.getTime() - created) / 3_600_000)) : null,
    claimed_by: raw.claimed_by ?? null, claimed_at: raw.claimed_at ?? null,
    job: job ? { id: job.id, status: job.status, verdict: job.verdict, cause_category: job.cause_category, updated_at: job.updated_at } : null,
  };
}

/** 驗 complete 的結果欄位 */
export function parseResult(b: Obj): { error: string } | { value: Obj } {
  if (typeof b.verdict !== "string" || !(STRONG_VERDICTS as readonly string[]).includes(b.verdict)) return { error: `verdict 要是 ${STRONG_VERDICTS.join("／")}` };
  let corrected: Obj | null = null;
  if (b.verdict === "uphold_with_correction") {
    const p = correctionProblems(b.corrected_fields);
    if (p) return { error: p };
    corrected = b.corrected_fields as Obj;
  }
  if (!nonEmpty(b.reasoning) || b.reasoning.trim().length < MIN_REASONING) return { error: `reasoning 至少 ${MIN_REASONING} 字（會原樣當 /report 的 reason）` };
  if (b.reasoning.length > MAX_REASONING) return { error: `reasoning 最多 ${MAX_REASONING} 字` };
  if (typeof b.cause_category !== "string" || !(CAUSE_CATEGORIES as readonly string[]).includes(b.cause_category)) return { error: `cause_category 要是 ${CAUSE_CATEGORIES.join("／")}` };
  if (b.cause_note !== undefined && b.cause_note !== null && (typeof b.cause_note !== "string" || b.cause_note.length > MAX_CAUSE_NOTE)) return { error: `cause_note 要是不超過 ${MAX_CAUSE_NOTE} 字的字串` };
  if (!nonEmpty(b.model) || b.model.length > 80) return { error: "model 必填（具體版本，不超過 80 字）" };
  const num = (k: string, int: boolean): number | null | "bad" => {
    const v = b[k];
    if (v === undefined || v === null) return null;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && (!int || Number.isInteger(v)) ? v : "bad";
  };
  const pt = num("prompt_tokens", true), ct = num("completion_tokens", true), cost = num("cost", false);
  if (pt === "bad" || ct === "bad" || cost === "bad") return { error: "prompt_tokens／completion_tokens 要是非負整數，cost 要是非負數字" };
  let urls: string[] = [];
  if (b.checked_urls !== undefined && b.checked_urls !== null) {
    if (!Array.isArray(b.checked_urls) || b.checked_urls.length > 30 || !b.checked_urls.every((u) => typeof u === "string" && /^https?:\/\//.test(u))) return { error: "checked_urls 要是最多 30 個 http(s) 網址的陣列" };
    urls = b.checked_urls as string[];
  }
  return { value: { verdict: b.verdict, corrected_fields: corrected, reasoning: b.reasoning.trim(), cause_category: b.cause_category, cause_note: nonEmpty(b.cause_note) ? b.cause_note.trim() : null, model: b.model.trim(), prompt_tokens: pt, completion_tokens: ct, cost, checked_urls: urls } };
}

/** finalize 送 /report 的 body（1.126.0 協議的 adjudication） */
export function buildReportBody(j: JobRow): Obj {
  const payload: Obj = { contribution_id: j.contribution_id, verdict: j.verdict, reason: j.reasoning, checked_urls: j.checked_urls ?? [] };
  if (j.verdict === "uphold_with_correction") payload.corrected_fields = j.corrected_fields;
  return { kind: "contribute", agent_name: RUNNER_AGENT_NAME, agent_tool: j.model, contribution_type: "adjudication", payload, source_urls: j.checked_urls ?? [] };
}

function bearerOf(h: Headers): string | null {
  const v = h.get("authorization") ?? "";
  return v.toLowerCase().startsWith("bearer ") ? v.slice(7).trim() : null;
}

export async function handleStrongAdjudicate(req: Request, deps: StrongAdjudicateDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("method not allowed", 405);

  // 憑證先驗：沒帶就 401，不管 body 寫什麼
  const hasLaneKey = req.headers.has(STRONG_KEY_HEADER);
  const bearer = bearerOf(req.headers);
  if (!hasLaneKey && !bearer) return fail(`缺少憑證：維護者帶 Authorization: Bearer <Firebase ID token>，執行者帶標頭 ${STRONG_KEY_HEADER}`, 401);

  let body: Obj;
  try { body = await req.json(); } catch { return fail("body 不是合法的 JSON", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("body 要是 JSON 物件", 400);
  const action = String(body.action ?? "");

  let actor: string;
  if (LANE_ACTIONS.has(action)) {
    if (!hasLaneKey) return fail(`${action} 是執行者動作，要帶標頭 ${STRONG_KEY_HEADER}`, 401);
    if (!strongKeyOk(req.headers.get(STRONG_KEY_HEADER), deps.laneKey)) return fail("強模型鑰匙不對（或這條線沒開）", 403);
    actor = RUNNER_AGENT_NAME;
  } else if (MAINTAINER_ACTIONS.has(action)) {
    if (!bearer) return fail(`${action} 是維護者動作，要帶 Authorization: Bearer <Firebase ID token>`, 401);
    const verified = await (deps.verifyToken ?? verifyFirebaseIdToken)(bearer, { projectId: deps.projectId });
    if (!verified.ok) return fail(`驗證失敗：${verified.reason}`, verified.reason === "jwks_unavailable" ? 503 : 401);
    if (!isConsoleOwner(verified.claims, deps.ownerEmail)) return fail("此帳號沒有權限", 403);
    actor = verified.claims.email!;
  } else {
    return fail(`不認得的 action：${action}（維護者：${[...MAINTAINER_ACTIONS].join("／")}；執行者：${[...LANE_ACTIONS].join("／")}）`, 400);
  }

  try {
    return await dispatch(action, body, actor, deps);
  } catch (e) {
    console.error("strong-adjudicate error:", errMsg(e));
    return fail("處理失敗，請稍後重試", 500);
  }
}

async function dispatch(action: string, b: Obj, actor: string, deps: StrongAdjudicateDeps): Promise<Response> {
  const { repo } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();

  if (action === "list") {
    const raw = await repo.strongLaneList();
    const items = Array.isArray(raw.items) ? (raw.items as Obj[]) : [];
    const jobs = await repo.latestJobsByTask(items.map((i) => String(i.task_id)));
    const byTask = new Map<string, JobRow>();
    for (const j of jobs) if (!byTask.has(j.task_id)) byTask.set(j.task_id, j);
    return json({ success: true, total: raw.total ?? items.length, items: items.map((i) => toListItem(i, byTask.get(String(i.task_id)) ?? null, now)) });
  }

  if (action === "enqueue") {
    if (!nonEmpty(b.task_id)) return fail("task_id 必填", 400);
    const taskId = b.task_id.trim();
    const items = ((await repo.strongLaneList()).items ?? []) as Obj[];
    const open = items.find((i) => String(i.task_id) === taskId);
    if (!open) return fail("這件不在強模型待辦（已結案或不是強模型任務）", 404);
    await repo.requeueStale(iso(-RUNNING_STALE_MIN * 60_000));
    const since = iso(-RECENT_WINDOW_MIN * 60_000);
    const blocking = (await repo.jobsForTask(taskId, 20)).find((j) =>
      j.status === "queued" || j.status === "running" || ((j.status === "previewed" || j.status === "finalizing") && j.created_at >= since));
    if (blocking) return fail("這件已有進行中或剛出爐的裁決，先處理它（避免重複燒錢）", 409, { job: publicJob(blocking) });
    const { row, conflict } = await repo.insertJob({ task_id: taskId, contribution_id: open.contribution_id ? String(open.contribution_id) : null, requested_by: actor });
    if (conflict || !row) return fail("這件已有排隊或執行中的裁決", 409);
    return json({ success: true, job: publicJob(row) });
  }

  if (action === "status") {
    if (nonEmpty(b.adjudication_id)) {
      const j = await repo.getJob(b.adjudication_id.trim());
      return j ? json({ success: true, job: publicJob(j) }) : fail("找不到這筆裁決", 404);
    }
    if (nonEmpty(b.task_id)) return json({ success: true, jobs: (await repo.jobsForTask(b.task_id.trim(), 20)).map(publicJob) });
    return fail("要帶 adjudication_id 或 task_id", 400);
  }

  if (action === "summary") {
    const sinceMs = nonEmpty(b.since) ? Date.parse(b.since) : now.getTime() - 7 * 86_400_000;
    if (!Number.isFinite(sinceMs)) return fail("since 要是日期（YYYY-MM-DD 或 ISO 時間）", 400);
    const rows = await repo.jobsSince(new Date(sinceMs).toISOString(), SUMMARY_LIMIT);
    const tally = (key: (j: JobRow) => string | null) => {
      const m: Record<string, number> = {};
      for (const j of rows) { const k = key(j); if (k) m[k] = (m[k] ?? 0) + 1; }
      return m;
    };
    return json({
      success: true, since: new Date(sinceMs).toISOString(), total: rows.length, truncated: rows.length >= SUMMARY_LIMIT,
      by_cause: tally((j) => j.cause_category), by_verdict: tally((j) => j.verdict), by_status: tally((j) => j.status),
      cost_total: rows.reduce((s, j) => s + Number(j.cost ?? 0), 0),
      tokens_total: rows.reduce((s, j) => s + (j.prompt_tokens ?? 0) + (j.completion_tokens ?? 0), 0),
      items: rows.map(publicJob),
    });
  }

  if (action === "claim") {
    await repo.requeueStale(iso(-RUNNING_STALE_MIN * 60_000));
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = await repo.oldestQueued();
      if (!next) return json({ success: true, job: null, message: "沒有排隊中的裁決" });
      const claimed = await repo.transition(next.id, ["queued"], { status: "running", claimed_by: nonEmpty(b.runner) ? String(b.runner).slice(0, 80) : actor, claimed_at: iso(0) });
      if (!claimed) continue; // 被別的執行者搶走，換下一筆
      const q = new URLSearchParams({ lane: "strong", task_id: claimed.task_id, agent_name: RUNNER_AGENT_NAME });
      let res: Response;
      try {
        res = await fetchImpl(`${deps.functionsBase}/next?${q}`, { headers: { [STRONG_KEY_HEADER]: deps.laneKey! } });
      } catch (e) {
        console.error("strong-adjudicate claim /next 失敗:", errMsg(e));
        await repo.transition(claimed.id, ["running"], { status: "queued", claimed_by: null, claimed_at: null });
        return fail("取題失敗，已放回排隊，請稍後重試", 502);
      }
      const nb = (await res.json().catch(() => ({}))) as Obj;
      if (!res.ok || nb.kind !== "task" || !nb.item) {
        await repo.transition(claimed.id, ["running"], { status: "failed", error: `取不到題目（HTTP ${res.status}，${String(nb.kind ?? nb.error ?? "")}）：${String(nb.reason ?? nb.message ?? "").slice(0, 200)}` });
        continue; // 這件已不在待辦，看下一筆
      }
      return json({
        success: true, job: publicJob(claimed),
        task: scrub({ item: nb.item, type_spec: nb.type_spec ?? null, dispute: nb.dispute ?? null, current: nb.current ?? null, how_to: nb.how_to ?? null }),
        result_fields: { verdicts: STRONG_VERDICTS, cause_categories: CAUSE_CATEGORIES },
      });
    }
    return json({ success: true, job: null, message: "排隊中的件都已不在強模型待辦" });
  }

  // 以下都要指定一筆
  if (!nonEmpty(b.adjudication_id)) return fail("adjudication_id 必填", 400);
  const id = b.adjudication_id.trim();
  const job = await repo.getJob(id);
  if (!job) return fail("找不到這筆裁決", 404);

  if (action === "complete") {
    const parsed = parseResult(b);
    if ("error" in parsed) return fail(parsed.error, 400);
    const v = parsed.value;
    const done = await repo.transition(id, ["running"], { ...(v as Partial<JobRow>), status: "previewed", completed_at: iso(0), error: null });
    if (!done) return fail(`現在是 ${job.status}，只有執行中（running）的能 complete（可能逾時被收回，請重新 claim）`, 409);
    try {
      await repo.logUsage({ model: String(v.model), prompt_tokens: Number(v.prompt_tokens ?? 0), completion_tokens: Number(v.completion_tokens ?? 0), cost: Number(v.cost ?? 0), note: `strong-adjudicate:${id}` });
    } catch (e) { console.error("ai_usage_logs 寫入失敗（不影響結果）:", errMsg(e)); }
    return json({ success: true, job: publicJob(done) });
  }

  if (action === "fail") {
    const msg = nonEmpty(b.error) ? b.error.slice(0, 500) : "執行者回報失敗";
    const done = await repo.transition(id, ["running"], { status: "failed", error: msg, completed_at: iso(0) });
    return done ? json({ success: true, job: publicJob(done) }) : fail(`現在是 ${job.status}，只有執行中的能回報失敗`, 409);
  }

  if (action === "return_to_human") {
    if (!nonEmpty(b.reason)) return fail("reason 必填", 400);
    const done = await repo.transition(id, ["queued", "running", "previewed", "finalize_failed", "failed"], { status: "returned", returned_by: actor, returned_at: iso(0), return_reason: b.reason.trim().slice(0, 500) });
    return done ? json({ success: true, job: publicJob(done) }) : fail(`現在是 ${job.status}，不能退回人工`, 409);
  }

  if (action === "finalize") {
    if (!deps.laneKey) return fail("強模型鑰匙沒設，不能送出裁決", 503);
    const locked = await repo.transition(id, ["previewed"], { status: "finalizing", finalized_by: actor });
    if (!locked) return fail(`現在是 ${job.status}，只有已出爐（previewed）的能 finalize`, 409);
    let res: Response, rb: unknown;
    try {
      res = await fetchImpl(`${deps.functionsBase}/report`, { method: "POST", headers: { "Content-Type": "application/json", [STRONG_KEY_HEADER]: deps.laneKey }, body: JSON.stringify(buildReportBody(locked)) });
      rb = await res.json().catch(() => null);
    } catch (e) {
      console.error("strong-adjudicate finalize /report 失敗:", errMsg(e));
      const failed = await repo.transition(id, ["finalizing"], { status: "finalize_failed", error: "送 /report 時連線失敗" });
      return fail("送出失敗（不自動重試）", 502, { job: failed ? publicJob(failed) : null });
    }
    const ok = res.ok && !(rb && typeof rb === "object" && (rb as Obj).success === false);
    const after = await repo.transition(id, ["finalizing"], ok
      ? { status: "finalized", finalized_at: iso(0), report_response: scrub(rb), error: null }
      : { status: "finalize_failed", report_response: scrub(rb), error: `/report 回 ${res.status}：${JSON.stringify(scrub(rb) ?? "").slice(0, 300)}` });
    return ok
      ? json({ success: true, job: after ? publicJob(after) : null })
      : fail("/report 沒收下這份裁決（不自動重試）", 502, { job: after ? publicJob(after) : null, report_status: res.status });
  }

  return fail("unreachable", 500);
}
