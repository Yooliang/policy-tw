/**
 * 把一筆貢獻落進正式表。同儕驗證通過（verified）後由 /report 或 apply-verified 自動呼叫；維護者 apply 也走這裡。
 *
 * - politician／candidacy：驗證者有指認（row.resolved_politician_id，兩票同一位）就用那位；否則走 ensurePolitician（多面向身份比對），
 *   ambiguous → disputed（唯一的人工點；politician_identity_reviews 只留紀錄）
 * - policy：人物必須已存在；相似政見不再攔截（派驗證時已把 similar_policies 給驗證者判斷），只擋完全同標題（冪等）
 * - policy_progress：更新 policies.status／progress／last_updated，補一筆 tracking_logs
 * - correction：只允許 CORRECTION_FIELDS 白名單欄位，直接 UPDATE（category 走正規化）
 * 每個 UPDATE／INSERT 都寫 edit_history（revert 用）；每一步檢查 error。
 */

import { CORRECTION_FIELDS, type ContributionType } from "./contribution-schema.ts";
import { ensurePolitician, upsertParticipation } from "./candidate-import.ts";
import { findPoliticianByNameStrict } from "./politician-identity.ts";
import { normElectionType } from "./identity-normalize.ts";
import { normalizeCategory } from "./category-map.ts";
import { type EditContext, recordInsert, recordUpdate } from "./edit-history.ts";
import { closeTask, createTask, validateTaskInput } from "./task-admin.ts";
import { closeAdjudicationTasks } from "./adjudication.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export interface ContributionRow {
  id: string;
  contribution_type: ContributionType;
  payload: Obj;
  source_urls: string[];
  note: string | null;
  agent_name: string | null;
  contributor_url: string | null;
  /** politician／candidacy：驗證者兩票指認的同一位（auto-apply 從 votes 算出）或維護者 approve 時指定 */
  resolved_politician_id?: string | null;
}

/** applied＝落庫完成；disputed＝需要人裁決（身份判不出／指認衝突）；failed＝技術性失敗（會自動重試） */
export type ApplyStatus = "applied" | "disputed" | "failed";

export interface ApplyOutcome {
  status: ApplyStatus;
  message: string;
  politician_id?: string;
  policy_id?: string;
  created_politician?: boolean;
  similar_policies?: Array<{ id: string; title: string; similarity: number }>;
  task_id?: string;
}

function throwIf(error: { message: string } | null, where: string): void {
  if (error) throw new Error(`${where}: ${error.message}`);
}

function sourceNote(row: ContributionRow): string {
  const who = row.agent_name ? `貢獻者：${row.agent_name}` : "外部貢獻";
  return `${who}（${row.source_urls[0]}）`;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const ctxOf = (row: ContributionRow): EditContext => ({ contribution_id: row.id, agent_name: row.agent_name });

/** 純函式：標題互相包含（pg_trgm 的 similarity 在 SQL 算，這裡只補「包含」規則給沒有 DB 的測試用） */
export function titlesContainEachOther(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
}

/** 只補空欄位，不覆蓋既有值；每個補的欄位寫 edit_history */
async function fillBlanks(supabase: SupabaseLike, ctx: EditContext, politicianId: string, values: Obj): Promise<string[]> {
  const entries = Object.entries(values).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return [];
  const { data: current, error } = await supabase.from("politicians").select(entries.map(([k]) => k).join(", ")).eq("id", politicianId).maybeSingle();
  throwIf(error, "politicians read");
  const patch = Object.fromEntries(entries.filter(([k]) => current?.[k] === null || current?.[k] === undefined || current?.[k] === ""));
  if (Object.keys(patch).length === 0) return [];
  const { error: updateError } = await supabase.from("politicians").update(patch).eq("id", politicianId);
  throwIf(updateError, "politicians fill blanks");
  for (const [k, v] of Object.entries(patch)) await recordUpdate(supabase, ctx, "politicians", politicianId, k, current?.[k] ?? null, v);
  return Object.keys(patch);
}

async function locatePolitician(supabase: SupabaseLike, p: Obj): Promise<string | null> {
  const id = str(p.politician_id);
  if (id) {
    const { data, error } = await supabase.from("politicians").select("id").eq("id", id).maybeSingle();
    throwIf(error, "politicians lookup by id");
    return data?.id ?? null;
  }
  const name = str(p.name);
  if (!name) return null;
  const found = await findPoliticianByNameStrict(supabase, name); // 同名多位會丟錯，要求帶 politician_id
  return found?.id ?? null;
}

async function recordCreatedPolitician(supabase: SupabaseLike, ctx: EditContext, politicianId: string): Promise<void> {
  const { data } = await supabase.from("politicians").select("*").eq("id", politicianId).maybeSingle();
  await recordInsert(supabase, ctx, "politicians", politicianId, data ?? { id: politicianId });
}

type Ensured = { politician_id: string; created: boolean } | { disputed: string };

/** 驗證者／維護者有指認就用那位（要存在）；否則多面向比對：matched／new 照常，ambiguous → disputed */
async function ensureOrResolve(supabase: SupabaseLike, row: ContributionRow, candidate: Parameters<typeof ensurePolitician>[1], options: Parameters<typeof ensurePolitician>[2]): Promise<Ensured> {
  const resolved = str(row.resolved_politician_id);
  if (resolved) {
    const { data, error } = await supabase.from("politicians").select("id").eq("id", resolved).maybeSingle();
    throwIf(error, "politicians lookup resolved");
    if (!data) return { disputed: `指認的人物 ${resolved} 不存在，交維護者裁決` };
    return { politician_id: String(data.id), created: false };
  }
  const ensured = await ensurePolitician(supabase, candidate, options);
  if (ensured.politician_id === null) {
    const names = ensured.resolution.candidates.map((c) => `${c.name ?? "?"}（${c.politician_id.slice(0, 8)}）`).join("、");
    return { disputed: `身份判不出（同名多位：${names || "見 politician_identity_reviews"}）且驗證者未指認 resolved_politician_id，交維護者裁決：${ensured.resolution.reason}` };
  }
  return { politician_id: ensured.politician_id, created: ensured.created };
}

async function applyPolitician(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const ensured = await ensureOrResolve(supabase, row, {
    name: String(p.name),
    party: str(p.party),
    region: str(p.region),
    election_type: str(p.election_type),
    position: str(p.position),
    current_position: str(p.current_position),
    birth_year: int(p.birth_year),
  }, {
    source: `contribution:${row.id}`,
    extraInsert: {
      sub_region: str(p.sub_region),
      education_level: str(p.education_level),
      bio: str(p.bio),
      avatar_url: str(p.avatar_url),
      slogan: str(p.slogan),
      education: Array.isArray(p.education) ? p.education : null,
      experience: Array.isArray(p.experience) ? p.experience : null,
    },
  });
  if ("disputed" in ensured) return { status: "disputed", message: ensured.disputed };
  if (ensured.created) {
    await recordCreatedPolitician(supabase, ctx, ensured.politician_id);
    return { status: "applied", politician_id: ensured.politician_id, created_politician: true, message: "已建立新政治人物" };
  }
  const filled = await fillBlanks(supabase, ctx, ensured.politician_id, {
    birth_year: int(p.birth_year),
    current_position: str(p.current_position),
    sub_region: str(p.sub_region),
    education_level: str(p.education_level),
    bio: str(p.bio),
    avatar_url: str(p.avatar_url),
    slogan: str(p.slogan),
    education: Array.isArray(p.education) ? p.education : null,
    experience: Array.isArray(p.experience) ? p.experience : null,
  });
  return {
    status: "applied",
    politician_id: ensured.politician_id,
    created_politician: false,
    message: `已對到既有人物${filled.length ? `，補上 ${filled.join("、")}` : "（無空欄位可補）"}`,
  };
}

async function applyCandidacy(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const electionType = normElectionType(str(p.election_type)) ?? "縣市長";
  const ensured = await ensureOrResolve(supabase, row, {
    name: String(p.name ?? ""),
    party: str(p.party),
    region: str(p.region),
    election_type: electionType,
    position: str(p.position) ?? `${electionType}候選人`,
    current_position: str(p.current_position),
    birth_year: int(p.birth_year),
    cec_cand_id: str(p.cec_cand_id) ?? int(p.cec_cand_id),
    cec_theme_id: str(p.cec_theme_id),
  }, { source: `contribution:${row.id}` });
  if ("disputed" in ensured) return { status: "disputed", message: ensured.disputed };
  if (ensured.created) await recordCreatedPolitician(supabase, ctx, ensured.politician_id);

  // withdrawn 在 DB 沒有對應值，落成 not_running 並在 source_note 註明
  const rawStatus = String(p.candidate_status);
  const candidateStatus = rawStatus === "withdrawn" ? "not_running" : rawStatus;
  const electionId = Number(p.election_id);
  const { data: before } = await supabase.from("politician_elections").select("*").eq("politician_id", ensured.politician_id).eq("election_id", electionId).maybeSingle();

  const participation = await upsertParticipation(supabase, {
    politician_id: ensured.politician_id,
    election_id: electionId,
    position: str(p.position) ?? `${electionType}候選人`,
    election_type: electionType,
    candidate_status: candidateStatus,
    source_note: `${sourceNote(row)}${rawStatus === "withdrawn" ? "；已退選" : ""}`,
  });
  if (participation.outcome === "created") {
    const { data: after } = await supabase.from("politician_elections").select("*").eq("id", participation.id).maybeSingle();
    await recordInsert(supabase, ctx, "politician_elections", String(participation.id), after ?? { id: participation.id });
  } else {
    await recordUpdate(supabase, ctx, "politician_elections", String(participation.id), "candidate_status", before?.candidate_status ?? null, candidateStatus);
    await recordUpdate(supabase, ctx, "politician_elections", String(participation.id), "source_note", before?.source_note ?? null, sourceNote(row));
  }
  return {
    status: "applied",
    politician_id: ensured.politician_id,
    created_politician: ensured.created,
    message: `參選紀錄已${participation.outcome === "created" ? "建立" : "更新"}為 ${candidateStatus}`,
  };
}

async function applyPolicy(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const politicianId = await locatePolitician(supabase, p);
  if (!politicianId) return { status: "failed", message: "找不到該政治人物（不會為了一條政見建新人物）；請先提交 politician 貢獻或帶 politician_id" };

  // 相似政見不再攔截（驗證者在 /next 的 current.similar_policies 已判斷過）；只擋完全同標題，讓重試／重複落庫冪等
  const { data: sameTitle, error: sameError } = await supabase.from("policies").select("id").eq("politician_id", politicianId).eq("title", String(p.title).trim()).limit(1);
  throwIf(sameError, "policies same-title lookup");
  const existingId = (sameTitle ?? [])[0]?.id as string | undefined;
  if (existingId) return { status: "applied", policy_id: existingId, politician_id: politicianId, message: `同標題政見已存在（${existingId}），沿用、未重複新增` };

  const today = new Date().toISOString().slice(0, 10);
  const rowToInsert = {
    politician_id: politicianId,
    election_id: int(p.election_id),
    title: String(p.title),
    description: String(p.description),
    category: normalizeCategory(String(p.category)) ?? String(p.category),
    status: str(p.status) ?? "Campaign Pledge",
    source_url: row.source_urls[0],
    ai_extracted: false,
    proposed_date: str(p.proposed_date) ?? today,
    last_updated: today,
    tags: Array.isArray(p.tags) ? p.tags : null,
  };
  const { data: inserted, error } = await supabase.from("policies").insert(rowToInsert).select("*").maybeSingle();
  throwIf(error, "policies insert");
  if (!inserted) throw new Error("policies insert 沒有回傳 id");
  await recordInsert(supabase, ctx, "policies", inserted.id, inserted);
  return { status: "applied", policy_id: inserted.id, politician_id: politicianId, message: "政見已建立" };
}

async function applyPolicyProgress(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  let policyId = str(p.policy_id);
  if (!policyId) {
    const politicianId = await locatePolitician(supabase, p);
    if (!politicianId) return { status: "failed", message: "找不到政治人物" };
    const { data, error } = await supabase.from("policies").select("id").eq("politician_id", politicianId).ilike("title", `%${String(p.policy_title)}%`).limit(2);
    throwIf(error, "policies lookup");
    if (!data || data.length === 0) return { status: "failed", message: `找不到政見「${p.policy_title}」` };
    if (data.length > 1) return { status: "failed", message: `「${p.policy_title}」對到多筆政見，請帶 policy_id` };
    policyId = data[0].id;
  }
  const { data: before, error: beforeError } = await supabase.from("policies").select("status, progress, last_updated").eq("id", policyId).maybeSingle();
  throwIf(beforeError, "policies read");
  if (!before) return { status: "failed", message: `找不到政見 ${policyId}` };

  const patch: Obj = { status: String(p.status), last_updated: String(p.date) };
  if (int(p.progress) !== null) patch.progress = p.progress;
  const { error } = await supabase.from("policies").update(patch).eq("id", policyId);
  throwIf(error, "policies update");
  for (const [k, v] of Object.entries(patch)) await recordUpdate(supabase, ctx, "policies", policyId as string, k, before[k] ?? null, v);

  const logRow = {
    policy_id: policyId,
    date: String(p.date),
    event: `進度更新：${p.status}${int(p.progress) !== null ? `（${p.progress}%）` : ""}`,
    description: `${String(p.note)}\n\n${sourceNote(row)}`,
    source_url: row.source_urls[0],
  };
  const { data: log, error: logError } = await supabase.from("tracking_logs").insert(logRow).select("*").maybeSingle();
  throwIf(logError, "tracking_logs insert");
  if (log) await recordInsert(supabase, ctx, "tracking_logs", String(log.id), log);
  return { status: "applied", policy_id: policyId as string, message: "政見進度已更新並留下追蹤紀錄" };
}

async function applyCorrection(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const table = String(p.target_table) as keyof typeof CORRECTION_FIELDS;
  const field = String(p.field);
  if (!CORRECTION_FIELDS[table]?.includes(field)) return { status: "failed", message: `${table}.${field} 不在可修正欄位白名單` };
  const { data: current, error: readError } = await supabase.from(table).select(`id, ${field}`).eq("id", p.target_id).maybeSingle();
  throwIf(readError, `${table} read`);
  if (!current) return { status: "failed", message: `${table} 找不到 id=${p.target_id}` };
  const newValue = table === "policies" && field === "category" ? (normalizeCategory(String(p.correct_value)) ?? p.correct_value) : p.correct_value;
  const { error } = await supabase.from(table).update({ [field]: newValue }).eq("id", p.target_id);
  throwIf(error, `${table} correction update`);
  await recordUpdate(supabase, ctx, table, String(p.target_id), field, current[field] ?? null, newValue);
  return {
    status: "applied",
    message: `${table}.${field}：「${current[field] ?? ""}」→「${String(newValue)}」`,
    ...(table === "politicians" ? { politician_id: String(p.target_id) } : {}),
    ...(table === "policies" ? { policy_id: String(p.target_id) } : {}),
  };
}

/** 外部提議任務通過驗證 → 自動 insert 成 open 任務（source=suggested），/next 就會派 */
async function applyTaskSuggestion(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const validated = validateTaskInput({
    title: p.title, description: p.description, task_type: str(p.task_type) ?? "other",
    target_politician_id: str(p.target_politician_id), target_policy_id: str(p.target_policy_id), region: str(p.region),
    hint_sources: Array.isArray(p.hint_sources) ? p.hint_sources : [],
  });
  if (!validated.ok || !validated.input) return { status: "failed", message: `提議內容不合格：${validated.errors.map((e) => e.message).join("；")}` };
  const task = await createTask(supabase, validated.input, { source: "suggested", suggested_by: row.agent_name, created_by: row.agent_name });
  await recordInsert(supabase, ctxOf(row), "contribution_tasks", String(task.id), task);
  return { status: "applied", message: `提議已成為公開任務（task_id=${task.id}），/next 會派出`, task_id: String(task.id) };
}

/** no_change：代理核對後確認與資料庫一致 → 只關閉該任務、不動任何正式資料（自動缺口任務沒有列可關，只記錄） */
async function applyNoChange(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const taskId = str(row.payload.task_id);
  if (!taskId) return { status: "failed", message: "no_change 要帶 task_id" };
  if (taskId.startsWith("auto:")) return { status: "applied", message: `已記錄無異動（自動缺口任務 ${taskId} 會在資料補齊後自行消失）`, task_id: taskId };
  const task = await closeTask(supabase, taskId, row.agent_name);
  if (!task) return { status: "failed", message: `找不到任務 ${taskId}` };
  await recordUpdate(supabase, ctxOf(row), "contribution_tasks", taskId, "status", "open", "closed");
  return { status: "applied", message: `已記錄無異動並關閉任務 ${taskId}`, task_id: taskId };
}

const ORIGINAL_COLUMNS = "id, contribution_type, payload, source_urls, note, agent_name, contributor_url, status, review_notes";

/**
 * adjudication（4 票同向後）：uphold → 把原貢獻落庫並標 applied；reject → 原貢獻標 rejected 記理由。
 * 兩種都關閉該貢獻的裁決任務、把同一筆的其他未定案裁決退掉。原貢獻已非 disputed 就只收尾。
 */
async function applyAdjudication(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const targetId = str(p.contribution_id);
  const verdict = str(p.verdict);
  if (!targetId || !verdict) return { status: "failed", message: "adjudication 要帶 contribution_id 與 verdict" };
  const { data: original, error } = await supabase.from("contributions").select(ORIGINAL_COLUMNS).eq("id", targetId).maybeSingle();
  throwIf(error, "original contribution lookup");
  if (!original) return { status: "failed", message: `找不到原貢獻 ${targetId}` };

  const now = new Date().toISOString();
  const stamp = `[adjudication ${verdict}] ${str(p.reason) ?? ""}（裁決者 ${row.agent_name ?? "?"}，${row.id}）`;
  const finish = async () => {
    const closed = await closeAdjudicationTasks(supabase, targetId);
    const { error: e } = await supabase.from("contributions")
      .update({ status: "rejected", review_notes: `[auto] 同一筆爭議已由裁決 ${row.id} 定案`, reviewed_by: "adjudication", reviewed_at: now })
      .eq("contribution_type", "adjudication").eq("payload->>contribution_id", targetId).neq("id", row.id).in("status", ["pending", "verified", "disputed", "apply_failed"]);
    throwIf(e, "retire other adjudications");
    return closed;
  };

  if (original.status !== "disputed") {
    const closed = await finish();
    return { status: "applied", message: `原貢獻已是 ${original.status}，裁決不再需要（關閉 ${closed} 個任務）` };
  }

  if (verdict === "reject") {
    const { error: e } = await supabase.from("contributions").update({
      status: "rejected", review_notes: [original.review_notes, stamp].filter(Boolean).join("；"), reviewed_by: "adjudication", reviewed_at: now,
    }).eq("id", targetId).eq("status", "disputed");
    throwIf(e, "original reject");
    await finish();
    return { status: "applied", message: `裁決 reject 定案：原貢獻 ${targetId} 已退件` };
  }

  // uphold：把原貢獻落庫（身份爭議由裁決者指認）
  const outcome = await applyContribution(supabase, { ...(original as ContributionRow), resolved_politician_id: str(p.resolved_politician_id) });
  if (outcome.status === "failed") throw new Error(`原貢獻落庫失敗：${outcome.message}`);
  if (outcome.status === "disputed") {
    const { error: e } = await supabase.from("contributions").update({ review_notes: [original.review_notes, `${stamp}；但仍無法落庫：${outcome.message}`].filter(Boolean).join("；") }).eq("id", targetId);
    throwIf(e, "original note");
    return { status: "applied", message: `裁決 uphold 通過，但原貢獻仍無法落庫（${outcome.message}）；任務保持 open，下一位裁決者請帶 resolved_politician_id` };
  }
  const { error: e } = await supabase.from("contributions").update({
    status: "applied", applied_at: now, applied_politician_id: outcome.politician_id ?? null, applied_policy_id: outcome.policy_id ?? null,
    review_notes: [original.review_notes, `${stamp}；${outcome.message}`].filter(Boolean).join("；"), reviewed_by: "adjudication", reviewed_at: now,
    last_error: null, next_retry_at: null,
  }).eq("id", targetId).eq("status", "disputed");
  throwIf(e, "original mark applied");
  await finish();
  return { status: "applied", politician_id: outcome.politician_id, policy_id: outcome.policy_id, message: `裁決 uphold 定案：原貢獻已落庫（${outcome.message}）` };
}

export async function applyContribution(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  switch (row.contribution_type) {
    case "adjudication": return await applyAdjudication(supabase, row);
    case "no_change": return await applyNoChange(supabase, row);
    case "politician": return await applyPolitician(supabase, row);
    case "candidacy": return await applyCandidacy(supabase, row);
    case "policy": return await applyPolicy(supabase, row);
    case "policy_progress": return await applyPolicyProgress(supabase, row);
    case "correction": return await applyCorrection(supabase, row);
    case "task_suggestion": return await applyTaskSuggestion(supabase, row);
    default: return { status: "failed", message: `未知型別 ${row.contribution_type}` };
  }
}

/** apply 結果 → contributions.status */
export function contributionStatusFor(outcome: ApplyStatus): "applied" | "disputed" | "apply_failed" {
  switch (outcome) {
    case "applied": return "applied";
    case "disputed": return "disputed"; // 唯一的人工點
    default: return "apply_failed"; // 掃地機會重試
  }
}
