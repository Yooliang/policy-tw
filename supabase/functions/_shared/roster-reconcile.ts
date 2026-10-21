/**
 * 名冊對帳：系統建立（#678 第一階段，維護者 2026-10-19「好，作」）。
 *
 * 對帳在資料庫（視圖 roster_reconcile，migration 20261019120000）：登記彙總表（cec_registrations）× 我們的 2026 參選紀錄，
 * 一人一列。這支只做一件事——把對帳判定「唯一可建」（category＝missing_creatable）的人，用跟代理交件落庫同一支邏輯
 * （apply-contribution.ts 的 applyCandidacy，經 applySystemCandidacy）建成參選紀錄；人物不存在才建，已存在（唯一同名、同地方）就掛上去。
 *
 * 系統寫入的規矩（維護者）：
 *   * 來源＝登記彙總表那一列：source_urls 放名冊網址、roster_reconcile_log 記 reg_id／row_no；
 *   * 進 edit_history（agent_name＝system:roster-reconcile，contribution_id 留空）；
 *   * 可整筆還原（SQL 函式 roster_reconcile_revert，整輪或逐筆）；
 *   * 只建「唯一對上」的：同名多筆、人物對不唯一、兩邊不一對一一律不碰（它們在對帳裡是 missing_ambiguous／match_ambiguous，派代理）；
 *   * 試了建不起來（落庫回 disputed／failed）或丟例外，都記進 log（unresolved／error）並停止重試——對帳視圖把它歸成 missing_ambiguous，改派代理，
 *     不會每 10 分鐘撞同一面牆，也不會因為「建到一半又重來」多建一個人物。
 */

import { type ApplyOutcome, applySystemCandidacy, type RegionResolution, resolveCandidacyRegion, type SystemCandidacyRow } from "./apply-contribution.ts";
import { purgePathsFor, purgeSsrPages } from "./ssr-purge.ts";
import { displayNameOf } from "./candidate-import.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

/** roster_reconcile_next() 回的一列：系統這一輪要建的人 */
export interface ReconcileCandidate {
  reg_id: number | string;
  election_id: number;
  election_type: string;
  county: string;
  sub_region: string | null;
  village: string | null;
  district: string | null;
  name: string;
  party: string | null;
  source_url: string;
  row_no: number;
  /** new＝全庫沒有同名者，建新人物；attach＝全庫剛好一位同名者（同地方出現過、這一屆沒有別筆），掛上去 */
  person_action: "new" | "attach";
  politician_id: string | null;
}

/** roster_reconcile_region_next() 回的一列：名冊唯一對上（both）、我們那筆參選紀錄 region_id 還是空的人（#731 補地區） */
export interface RegionCandidate {
  reg_id: number | string;
  pe_id: number;
  politician_id: string | null;
  election_id: number;
  election_type: string;
  county: string;
  sub_region: string | null;
  village: string | null;
  district: string | null;
  name: string;
  source_url: string;
  row_no: number;
}

export const DEFAULT_AGENT_NAME = "system:roster-reconcile";
/** 單次呼叫的時間預算（Edge Function 上限 150 秒；留餘裕給刷新彙總與回應） */
export const BUDGET_MS = 100_000;

/** 登記彙總表那一列 → 跟代理交 candidacy 一樣的 payload（協議的詞：candidate_status＝registered） */
export function candidacyPayloadOf(c: Omit<ReconcileCandidate, "party" | "person_action" | "politician_id"> & { party?: string | null }): Obj {
  return {
    name: displayNameOf(c.name),   // 名冊原文，只 trim、連續空白壓成一個；比對才用 roster_name_key
    election_id: c.election_id,
    election_type: c.election_type,
    region: c.county,
    candidate_status: "registered",
    ...(c.party ? { party: c.party } : {}),
    ...(c.sub_region ? { sub_region: c.sub_region } : {}),
    ...(c.election_type === "村里長" && c.village ? { village: c.village } : {}),
    ...(c.district ? { electoral_district: c.district } : {}),
  };
}

export function systemRowOf(c: ReconcileCandidate, agentName: string): SystemCandidacyRow {
  if (c.person_action === "attach" && !c.politician_id) throw new Error(`reg ${c.reg_id}（${c.name}）要掛上既有人物，但對帳沒有給人物 id`);
  return {
    agent_name: agentName,
    payload: candidacyPayloadOf(c),
    source_urls: [c.source_url],
    resolved_politician_id: c.person_action === "new" ? "new" : String(c.politician_id),
    note: `名冊對帳：中選會登記彙總表第 ${c.row_no} 列（${c.source_url}）`,
  };
}

export type ApplyFn = (supabase: SupabaseLike, row: SystemCandidacyRow) => Promise<ApplyOutcome>;

export interface ReconcileSummary {
  run_id: string;
  skipped?: "disabled" | "concurrent_run";
  picked: number;
  applied: number;
  created_politicians: number;
  attached: number;
  unresolved: number;
  errors: number;
  /** 補地區（#731）：這一輪挑了幾位、寫進幾位、對不到唯一一列的、出錯的；settings.actions 沒有 region 就全是 0 */
  region: { picked: number; applied: number; unresolved: number; errors: number };
  stopped_by_budget: boolean;
  units_refreshed: number | null;
  samples: Array<{ reg_id: number | string; name: string; election_type: string; county: string; outcome: string; message: string }>;
  elapsed_ms: number;
}

export interface RunOptions {
  /** 這一輪最多建幾筆（沒給就讀 roster_reconcile_settings.batch_limit） */
  limit?: number;
  apply?: ApplyFn;
  /** 補地區：對 regions（測試注入；預設 apply-contribution.ts 的 resolveCandidacyRegion，只讀不建） */
  resolveRegion?: (supabase: SupabaseLike, electionType: string, payload: Obj) => Promise<RegionResolution>;
  /** 清 SSR 快取（測試注入；預設 ssr-purge.ts 的 purgeSsrPages） */
  purge?: (paths: string[]) => Promise<void>;
  runId?: string;
  now?: () => number;
  budgetMs?: number;
}

/**
 * 寫處理紀錄。失敗就再試一次，還是失敗就丟錯（整輪中止）：參選紀錄已經落庫卻沒有紀錄，之後無法溯源還原，也會被對帳當成「系統沒處理過」。
 * 唯一鍵衝突（別的執行先寫了同一位）不是遺失，當成功。
 */
async function writeLog(supabase: SupabaseLike, entry: Obj, table = "roster_reconcile_log"): Promise<void> {
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { error } = await supabase.from(table).insert(entry);
      if (!error) return;
      if (String(error.code) === "23505") return;
      last = error.message;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`${table} 寫入失敗（reg ${String(entry.reg_id)}，已重試一次）：${last}。這一筆參選紀錄可能已落庫，需人工對照 edit_history（agent_name＝system:*）`);
}

/** 落庫成功後補參選紀錄的政黨（party_id／party_basis）：交件落庫由資料庫觸發器做，系統寫入沒有 contributions 那一列，所以自己呼叫同一支 SQL 函式 */
async function fillParty(supabase: SupabaseLike, politicianId: string, payload: Obj, agentName: string): Promise<void> {
  try {
    const { error } = await supabase.rpc("politician_election_party_from_candidacy", {
      p_politician_id: politicianId, p_payload: payload, p_contribution_id: null, p_agent_name: agentName,
    });
    if (error) console.error(`politician_election_party_from_candidacy 失敗（${politicianId}）：${error.message}`);
  } catch (e) {
    console.error(`politician_election_party_from_candidacy 例外（${politicianId}）：${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runRosterReconcile(supabase: SupabaseLike, opts: RunOptions = {}): Promise<ReconcileSummary> {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const summary: ReconcileSummary = {
    run_id: opts.runId ?? crypto.randomUUID(), picked: 0, applied: 0, created_politicians: 0, attached: 0, unresolved: 0, errors: 0,
    region: { picked: 0, applied: 0, unresolved: 0, errors: 0 }, stopped_by_budget: false, units_refreshed: null, samples: [], elapsed_ms: 0,
  };

  const { data: settings, error: sErr } = await supabase.from("roster_reconcile_settings")
    .select("enabled, batch_limit, agent_name, actions").eq("id", 1).maybeSingle();
  if (sErr) throw new Error(`roster_reconcile_settings: ${sErr.message}`);
  if (!settings) throw new Error("roster_reconcile_settings 沒有設定列（id=1），不執行");
  if (settings.enabled !== true) {
    summary.skipped = "disabled";
    summary.elapsed_ms = now() - started;
    return summary;
  }

  // 執行互斥：手動觸發與排程重疊時，兩邊會拿到同一批 new，各建一個人物。租約拿不到就空轉
  const { data: locked, error: lErr } = await supabase.rpc("roster_reconcile_lock", { p_minutes: 5 });
  if (lErr) throw new Error(`roster_reconcile_lock: ${lErr.message}`);
  if (locked !== true) {
    summary.skipped = "concurrent_run";
    summary.elapsed_ms = now() - started;
    return summary;
  }
  try {
    await runLocked(supabase, opts, settings, summary, started);
  } finally {
    try {
      const { error } = await supabase.rpc("roster_reconcile_unlock");
      if (error) console.error(`roster_reconcile_unlock 失敗（租約 5 分鐘後自己過期）：${error.message}`);
    } catch (e) {
      console.error(`roster_reconcile_unlock 例外：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  summary.elapsed_ms = now() - started;
  return summary;
}

async function runLocked(supabase: SupabaseLike, opts: RunOptions, settings: Obj, summary: ReconcileSummary, started: number): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const apply = opts.apply ?? applySystemCandidacy;
  const runId = summary.run_id;
  const agentName = String(settings.agent_name ?? DEFAULT_AGENT_NAME);
  const limit = Math.max(1, Math.min(Number(opts.limit ?? settings.batch_limit) || 100, 500));

  const { data: picked, error: nErr } = await supabase.rpc("roster_reconcile_next", { p_limit: limit });
  if (nErr) throw new Error(`roster_reconcile_next: ${nErr.message}`);
  const list = (picked ?? []) as ReconcileCandidate[];
  summary.picked = list.length;

  const purgePaths = new Set<string>();
  const budget = opts.budgetMs ?? BUDGET_MS;
  for (const c of list) {
    if (now() - started > budget) { summary.stopped_by_budget = true; break; }
    const base = {
      reg_id: c.reg_id, run_id: runId, source_url: c.source_url, row_no: c.row_no, person_action: c.person_action, agent_name: agentName,
    };
    const sample = (outcome: string, message: string) => {
      if (summary.samples.length < 20) summary.samples.push({ reg_id: c.reg_id, name: c.name, election_type: c.election_type, county: c.county, outcome, message });
    };
    let outcome: ApplyOutcome | null = null;
    let payload: Obj = {};
    try {
      const row = systemRowOf(c, agentName);
      payload = row.payload;
      outcome = await apply(supabase, row);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await writeLog(supabase, { ...base, outcome: "error", message: message.slice(0, 500) });
      summary.errors++;
      sample("error", message);
      continue;
    }
    // 落庫之後的記錄不包在上面的 try 裡：寫不進紀錄要中止整輪（writeLog 自己丟錯），不能被當成「這一位建不起來」吞掉
    if (outcome.status === "applied" && outcome.politician_election_id !== undefined && outcome.politician_id) {
      await fillParty(supabase, outcome.politician_id, payload, agentName);
      await writeLog(supabase, {
        ...base, outcome: "applied", message: outcome.message, politician_id: outcome.politician_id,
        politician_election_id: Number(outcome.politician_election_id), created_politician: outcome.created_politician === true,
      });
      for (const path of purgePathsFor(outcome)) purgePaths.add(path);
      summary.applied++;
      if (outcome.created_politician) summary.created_politicians++; else summary.attached++;
      sample("applied", outcome.message);
    } else {
      // disputed（身份對不起來等）、failed、superseded 或沒帶回參選紀錄 id：這一位不由系統建，改派代理
      await writeLog(supabase, { ...base, outcome: "unresolved", message: `${outcome.status}：${outcome.message}`.slice(0, 500) });
      summary.unresolved++;
      sample("unresolved", `${outcome.status}：${outcome.message}`);
    }
  }

  // 補地區（#731）：settings.actions 有 region 才做；跟上面的建立各自挑、各自記（roster_reconcile_region_log）
  if (Array.isArray(settings.actions) && (settings.actions as unknown[]).includes("region")) {
    await runRegionFill(supabase, opts, summary, { runId, agentName, limit, started, budget }, purgePaths);
  }

  // 受影響的人物頁請 Worker 清快取：一輪結束統一清一次（不逐筆發請求）；失敗不影響落庫
  if (purgePaths.size > 0) {
    try {
      await (opts.purge ?? purgeSsrPages)([...purgePaths]);
    } catch (e) {
      console.error(`purgeSsrPages 失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    const { data, error } = await supabase.rpc("roster_reconcile_refresh_units");
    if (error) console.error(`roster_reconcile_refresh_units 失敗：${error.message}`);
    else summary.units_refreshed = Number(data ?? 0);
  } catch (e) {
    console.error(`roster_reconcile_refresh_units 例外：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 補地區：名冊唯一對上（both）、我們那筆參選紀錄 region_id 為空的人，用名冊的縣市／鄉鎮／村里／選舉區對到 regions 唯一一列，寫進 region_id。
 * 只補空白、不覆蓋（寫入在資料庫函式 roster_reconcile_set_region 裡 WHERE region_id IS NULL，同一個交易記 edit_history 與 log）；
 * 找 regions 的邏輯是 applyCandidacy 那一套（resolveCandidacyRegion，只讀不建）；對不到唯一一列就不寫，log 記 unresolved 與原因，不重試。
 */
async function runRegionFill(
  supabase: SupabaseLike, opts: RunOptions, summary: ReconcileSummary,
  ctx: { runId: string; agentName: string; limit: number; started: number; budget: number }, purgePaths: Set<string>,
): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const resolve = opts.resolveRegion ?? resolveCandidacyRegion;
  const { data: picked, error } = await supabase.rpc("roster_reconcile_region_next", { p_limit: ctx.limit });
  if (error) throw new Error(`roster_reconcile_region_next: ${error.message}`);
  const list = (picked ?? []) as RegionCandidate[];
  summary.region.picked = list.length;
  for (const c of list) {
    if (now() - ctx.started > ctx.budget) { summary.stopped_by_budget = true; break; }
    const base = { reg_id: c.reg_id, run_id: ctx.runId, source_url: c.source_url, row_no: c.row_no, politician_election_id: c.pe_id, agent_name: ctx.agentName };
    const sample = (outcome: string, message: string) => {
      if (summary.samples.length < 20) summary.samples.push({ reg_id: c.reg_id, name: c.name, election_type: c.election_type, county: c.county, outcome: `region_${outcome}`, message });
    };
    let res: RegionResolution;
    try {
      res = await resolve(supabase, c.election_type, candidacyPayloadOf(c));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await writeLog(supabase, { ...base, outcome: "error", reason: "exception", message: message.slice(0, 500) }, "roster_reconcile_region_log");
      summary.region.errors++;
      sample("error", message);
      continue;
    }
    if (!res.ok) {
      await writeLog(supabase, { ...base, outcome: "unresolved", reason: res.reason, message: res.message.slice(0, 500) }, "roster_reconcile_region_log");
      summary.region.unresolved++;
      sample("unresolved", `${res.reason}：${res.message}`);
      continue;
    }
    // 寫入＋edit_history＋log 在同一個資料庫交易；回 false＝這一筆在挑出來之後已經有人補了地區（不覆蓋），函式自己記 unresolved
    const { data: wrote, error: wErr } = await supabase.rpc("roster_reconcile_set_region", {
      p_reg_id: c.reg_id, p_pe_id: c.pe_id, p_region_id: res.region_id, p_run: ctx.runId, p_agent: ctx.agentName,
      p_source_url: c.source_url, p_row_no: c.row_no, p_level: res.level,
    });
    if (wErr) throw new Error(`roster_reconcile_set_region（reg ${String(c.reg_id)}）：${wErr.message}。需人工對照 edit_history（agent_name＝system:*）`);
    if (wrote === true) {
      summary.region.applied++;
      for (const path of purgePathsFor({ politician_id: c.politician_id })) purgePaths.add(path);
      sample("applied", `region_id＝${res.region_id}（${res.level}）`);
    } else {
      summary.region.unresolved++;
      sample("unresolved", "region_already_set：挑出來之後這筆已經有地區，不覆蓋");
    }
  }
}
