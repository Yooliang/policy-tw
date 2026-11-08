/**
 * task_estimate 動作的本體（可注入 Jev 與資料庫，測試用 stub）。入口在 system-one/index.ts。
 * 守則：冪等（候選函式只回沒估過／目標變了／題目版本不同的）、有上限（limit＋時間窗成本上限＋單輪時間）、
 * 一個任務一次呼叫問四題、單筆失敗不拖累整輪（Jev 連掛 3 次就整輪停）。
 */
import { type DecisionRecord, type JevResponse, toRecords } from "./system-one.ts";
import { buildTaskEstimateAsk, parseTaskEstimate, TASK_ESTIMATE_SUBJECT, TASK_ESTIMATE_VERSION, type TaskEstimate, type TaskForEstimate } from "./task-estimate.ts";

export const TASK_ESTIMATE_DEFAULT_LIMIT = 20;
export const TASK_ESTIMATE_MAX_LIMIT = 100;
/** 時間窗成本上限（跟 backfill 同一套）：10 分鐘內最多估這麼多件，不帶金鑰的動作只能這樣守 */
export const TASK_ESTIMATE_WINDOW_MINUTES = 10;
export const TASK_ESTIMATE_WINDOW_MAX = 100;
const ROUND_MS = 45_000;

export type Candidate = TaskForEstimate & { target_hash: string };

export interface EstimateDeps {
  /** 時間窗內已估的件數（jev_decisions 的 task_difficulty 筆數） */
  recentCount(sinceIso: string): Promise<number>;
  candidates(limit: number, version: string): Promise<Candidate[]>;
  ask(state: Record<string, unknown>, questions: Record<string, import("./system-one.ts").JevQuestion>): Promise<JevResponse>;
  record(rows: DecisionRecord[]): Promise<{ inserted: number; skipped: number }>;
  save(row: Record<string, unknown>): Promise<void>;
  now?: () => number;
}

export interface EstimateResult {
  dry: boolean;
  candidates: number;
  asked: number;
  saved: number;
  unusable: number;
  budget: number;
  cost_usd: number;
  estimates: Array<{ task_id: string; task_type: string } & TaskEstimate>;
  failures: Array<{ task_id: string; error: string }>;
  elapsed_ms: number;
}

export async function runTaskEstimate(deps: EstimateDeps, opts: { limit?: number; dry?: boolean } = {}): Promise<EstimateResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const dry = !!opts.dry;
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? TASK_ESTIMATE_DEFAULT_LIMIT) || TASK_ESTIMATE_DEFAULT_LIMIT, 1), TASK_ESTIMATE_MAX_LIMIT);
  const since = new Date(started - TASK_ESTIMATE_WINDOW_MINUTES * 60_000).toISOString();
  const recent = await deps.recentCount(since);
  const budget = Math.max(0, Math.min(limit, TASK_ESTIMATE_WINDOW_MAX - recent));
  const out: EstimateResult = { dry, candidates: 0, asked: 0, saved: 0, unusable: 0, budget, cost_usd: 0, estimates: [], failures: [], elapsed_ms: 0 };
  if (budget === 0) { out.elapsed_ms = now() - started; return out; }

  const cands = await deps.candidates(budget, TASK_ESTIMATE_VERSION);
  out.candidates = cands.length;
  for (const c of cands) {
    if (now() - started > ROUND_MS) break;
    try {
      const { state, questions } = buildTaskEstimateAsk(c);
      const res = await deps.ask(state, questions);
      out.asked++;
      out.cost_usd += res.usage?.cost ?? 0;
      const est = parseTaskEstimate(res);
      if (!est) { out.unusable++; continue; }
      out.estimates.push({ task_id: c.task_id, task_type: c.task_type, ...est });
      if (dry) continue;
      await deps.record(toRecords(TASK_ESTIMATE_SUBJECT, c.task_id, state, res));
      await deps.save({
        task_id: c.task_id, target_hash: c.target_hash, question_version: TASK_ESTIMATE_VERSION,
        difficulty: est.difficulty, time_bucket: est.time_bucket, model_need: est.model_need, hardness: est.hardness,
        probabilities: est.probabilities, model: res.model, cost_usd: Number((res.usage?.cost ?? 0).toFixed(8)), estimated_at: new Date(now()).toISOString(),
      });
      out.saved++;
    } catch (e) {
      out.failures.push({ task_id: c.task_id, error: e instanceof Error ? e.message : String(e) });
      if (out.failures.length >= 3) break; // Jev 掛了就整輪停，不要每件各撞一次
    }
  }
  out.cost_usd = Number(out.cost_usd.toFixed(6));
  out.elapsed_ms = now() - started;
  return out;
}
