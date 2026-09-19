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
import { changedFields, electionResultLabel, electionResultPatch } from "./candidacy-result.ts";
import { findPoliticianByNameStrict } from "./politician-identity.ts";
import { normElectionType } from "./identity-normalize.ts";
import { normalizeCategory } from "./category-map.ts";
import { type EditContext, recordInsert, recordUpdate } from "./edit-history.ts";
import { closeTask, createTask, validateTaskInput } from "./task-admin.ts";
import { manualTaskIdOf, shouldCloseOnApplied } from "./task-fulfilment.ts";
import { closeAdjudicationTasks, closeFixTasks } from "./adjudication.ts";
import { normalizeCorrection } from "./correction.ts";

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
  /** question_answer 落庫要記進 question_answers；其他型別的 apply 用不到，選填以免動到既有呼叫端 */
  agent_tool?: string | null;
  /** politician／candidacy：驗證者兩票指認的同一位（auto-apply 從 votes 算出）或維護者 approve 時指定 */
  resolved_politician_id?: string | null;
  /** 這筆貢獻是做哪個任務交的（contributions.task_id）。上線後拿它判斷任務該不該關，見 task-fulfilment.ts */
  task_id?: string | null;
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
  question_id?: string;
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
  if (resolved === "new") {
    // 兩票都說「都不是」：直接建新人物，不對到任何既有人物
    const forced = await ensurePolitician(supabase, candidate, { ...options, force_new: true });
    if (!forced.politician_id) return { disputed: "指認為新人物但建立失敗，交裁決" };
    return { politician_id: forced.politician_id, created: forced.created };
  }
  if (resolved) {
    const { data, error } = await supabase.from("politicians").select("id").eq("id", resolved).maybeSingle();
    throwIf(error, "politicians lookup resolved");
    if (!data) return { disputed: `指認的人物 ${resolved} 不存在，交維護者裁決` };
    return { politician_id: String(data.id), created: false };
  }
  // 提交者自己帶了 politician_id 就是那位（要存在），不再用姓名去猜身份。
  // 2026-09-19 抓到 7 筆落庫連續失敗＋蘇清泉 2 票齊了卻轉裁決：payload 都有 politician_id，
  // 這裡卻跳過它去比對姓名——比出「唯一候選但只有弱面向命中」就退件；candidacy 沒帶 name 更直接炸
  // 「candidate.name 為空」、politician 沒帶 position 撞 NOT NULL。帶了 id 還去猜，猜不準就退件，是這裡的錯。
  const given = str(row.payload.politician_id);
  if (given) {
    const { data, error } = await supabase.from("politicians").select("id").eq("id", given).maybeSingle();
    throwIf(error, "politicians lookup by payload id");
    if (data) return { politician_id: String(data.id), created: false };
    return { disputed: `payload.politician_id ${given} 不存在，交維護者裁決` };
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

  // 選舉結果三欄（election_result_missing 任務補的）：有給才寫；2026-09-19 前這裡直接丟掉
  const resultPatch = electionResultPatch(p);
  const newSourceNote = `${sourceNote(row)}${rawStatus === "withdrawn" ? "；已退選" : ""}`;
  const participation = await upsertParticipation(supabase, {
    politician_id: ensured.politician_id,
    election_id: electionId,
    position: str(p.position) ?? `${electionType}候選人`,
    election_type: electionType,
    candidate_status: candidateStatus,
    source_note: newSourceNote,
    always: resultPatch,
  });
  if (participation.outcome === "created") {
    const { data: after } = await supabase.from("politician_elections").select("*").eq("id", participation.id).maybeSingle();
    await recordInsert(supabase, ctx, "politician_elections", String(participation.id), after ?? { id: participation.id });
  } else {
    // 只記真的變的欄位：confirmed→confirmed 不進 edit_history
    const after = { candidate_status: candidateStatus, source_note: newSourceNote, ...resultPatch };
    for (const [field, oldValue, newValue] of changedFields(before ?? null, after)) {
      await recordUpdate(supabase, ctx, "politician_elections", String(participation.id), field, oldValue, newValue);
    }
  }
  const resultLabel = electionResultLabel(p);
  return {
    status: "applied",
    politician_id: ensured.politician_id,
    created_politician: ensured.created,
    message: `參選紀錄已${participation.outcome === "created" ? "建立" : "更新"}為 ${candidateStatus}${resultLabel ? `，選舉結果 ${resultLabel}` : ""}`,
  };
}

async function applyPolicy(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const politicianId = await locatePolitician(supabase, p);
  if (!politicianId) return { status: "failed", message: "找不到該政治人物（不會為了一條政見建新人物）；請先提交 politician 貢獻或帶 politician_id" };

  // 相似政見不再攔截（驗證者在 /next 的 current.similar_policies 已判斷過）；只擋完全同標題，讓重試／重複落庫冪等
  const { data: sameTitle, error: sameError } = await supabase.from("policies").select("id, removed_at, removed_reason").eq("politician_id", politicianId).eq("title", String(p.title).trim()).limit(1);
  throwIf(sameError, "policies same-title lookup");
  const existing = (sameTitle ?? [])[0] as { id: string; removed_at: string | null; removed_reason: string | null } | undefined;
  // 已被移除的同名政見不會因為有人再交一次就復活；照實說，不要讓代理以為新增成功
  if (existing?.removed_at) {
    return {
      status: "failed",
      policy_id: existing.id,
      politician_id: politicianId,
      message: `這筆政見先前已被移除（${existing.removed_reason ?? "未寫理由"}），不會因為重新提交而回到網站上。` +
        `確定它其實是有效政見，請用 correction 或在 note 說明理由請維護者還原，不要換個標題再交一次。`,
    };
  }
  if (existing) return { status: "applied", policy_id: existing.id, politician_id: politicianId, message: `同標題政見已存在（${existing.id}），沿用、未重複新增` };

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
    // 查不到提出日期就留空；填當天會把「資料送進來的日子」偽裝成「政見提出的日子」
    proposed_date: str(p.proposed_date) ?? null,
    last_updated: today,
    tags: Array.isArray(p.tags) ? p.tags : null,
  };
  const { data: inserted, error } = await supabase.from("policies").insert(rowToInsert).select("*").maybeSingle();
  throwIf(error, "policies insert");
  if (!inserted) throw new Error("policies insert 沒有回傳 id");
  await recordInsert(supabase, ctx, "policies", inserted.id, inserted);
  // 新政見落庫就問 Jev（影子模式：只寫 jev_decisions，不影響任何流程與計票）。
  // 不 await：落庫這條路不能依賴 OpenRouter 的可用性。漏掉的由 system-one 的 backfill 每 15 分鐘補——
  // 事件是加速，補漏才是保證（docs/BLUEPRINT-jev-decisions.md §6）。
  notifySystemOne("policy", inserted.id);
  return { status: "applied", policy_id: inserted.id, politician_id: politicianId, message: "政見已建立" };
}

/** 叫 system-one 的 ask 動作。只有 service role 叫得動，所以帶 service key；失敗只記 log */
function notifySystemOne(subjectType: string, subjectId: string): void {
  let url: string | undefined, key: string | undefined;
  try {
    url = Deno.env.get("SUPABASE_URL");
    key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  } catch {
    // 測試沒開 --allow-env 會丟 PermissionDenied。觸發失敗不能拖倒落庫，這裡就是第一道
    return;
  }
  if (!url || !key) return;
  fetch(`${url}/functions/v1/system-one?action=ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ subject_type: subjectType, subject_id: subjectId }),
  }).then((r) => {
    if (!r.ok) console.warn(`[system-one] ask 回 ${r.status}`);
  }).catch((e) => console.warn(`[system-one] ask 送不出去：${e instanceof Error ? e.message : String(e)}`));
}

async function applyPolicyProgress(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  let policyId = str(p.policy_id);
  if (!policyId) {
    const politicianId = await locatePolitician(supabase, p);
    if (!politicianId) return { status: "failed", message: "找不到政治人物" };
    // 已移除的政見不接受進度更新：寫進去讀者也看不到，等於把代理的工丟進黑洞
    const { data, error } = await supabase.from("policies").select("id").eq("politician_id", politicianId).is("removed_at", null).ilike("title", `%${String(p.policy_title)}%`).limit(2);
    throwIf(error, "policies lookup");
    if (!data || data.length === 0) return { status: "failed", message: `找不到政見「${p.policy_title}」（已被移除的政見不接受進度更新）` };
    if (data.length > 1) return { status: "failed", message: `「${p.policy_title}」對到多筆政見，請帶 policy_id` };
    policyId = data[0].id;
  }
  const { data: before, error: beforeError } = await supabase.from("policies").select("status, progress, last_updated, removed_at, removed_reason").eq("id", policyId).maybeSingle();
  throwIf(beforeError, "policies read");
  if (!before) return { status: "failed", message: `找不到政見 ${policyId}` };
  // 帶 policy_id 指名的也要擋：進度寫進已移除的政見，讀者看不到，等於白做
  if (before.removed_at) {
    return {
      status: "failed",
      message: `政見 ${policyId} 已被移除（${before.removed_reason ?? "未寫理由"}），不接受進度更新。` +
        `如果你認為它其實是有效政見，請在 note 說明理由請維護者還原。`,
    };
  }

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

/** correction：一筆可改多個欄位（changes[]），逐欄套用、各寫一筆 edit_history；舊的單欄位格式由 normalizeCorrection 相容 */
// 空字串在 DATE 欄位會讓 PostgreSQL 直接報錯，而「查不到提出日期」是合法狀態，
// 所以清空一律轉成 null。分類則順手正規化成 19 個正式名稱之一。
function correctionValue(table: string, field: string, value: unknown): unknown {
  if (table === "policies" && field === "category") return normalizeCategory(String(value)) ?? value;
  if (table === "policies" && field === "proposed_date" && (value === undefined || value === null || value === "")) return null;
  return value;
}

async function applyCorrection(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const ctx = ctxOf(row);
  const { target_table, target_id, changes } = normalizeCorrection(row.payload);
  const table = String(target_table) as keyof typeof CORRECTION_FIELDS;
  if (!target_id || changes.length === 0) return { status: "failed", message: "correction 缺 target_id 或要更正的欄位" };
  const bad = changes.find((c) => !CORRECTION_FIELDS[table]?.includes(c.field));
  if (bad) return { status: "failed", message: `${table}.${bad.field} 不在可修正欄位白名單` };

  const fields = changes.map((c) => c.field);
  const { data: current, error: readError } = await supabase.from(table).select(`id, ${fields.join(", ")}`).eq("id", target_id).maybeSingle();
  throwIf(readError, `${table} read`);
  if (!current) return { status: "failed", message: `${table} 找不到 id=${target_id}` };

  const patch: Obj = Object.fromEntries(changes.map((c) => [c.field, correctionValue(table, c.field, c.correct_value)]));
  const { error } = await supabase.from(table).update(patch).eq("id", target_id);
  throwIf(error, `${table} correction update`);
  const applied: string[] = [];
  for (const [field, newValue] of Object.entries(patch)) {
    await recordUpdate(supabase, ctx, table, String(target_id), field, current[field] ?? null, newValue);
    applied.push(`${field}：「${current[field] ?? ""}」→「${newValue === null ? "（清空）" : String(newValue)}」`);
  }
  return {
    status: "applied",
    message: `${table} 更正 ${applied.length} 個欄位：${applied.join("；")}`,
    ...(table === "politicians" ? { politician_id: String(target_id) } : {}),
    ...(table === "policies" ? { policy_id: String(target_id) } : {}),
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

/**
 * question_answer：把答案寫進 question_answers。
 * 資料庫有兩道結構性防線（migration 20260912000014）：一個代號一題只能一份（UNIQUE），同一題最多三份（trigger）。
 * 這裡先用 SELECT 預檢做一樣的判斷，好給出講給 AI 看的清楚訊息；防線本身留給 DB，
 * 預檢與實際 insert 之間仍有極小的競態窗口，insert 若真的撞上唯一鍵／trigger 也轉成 failed，不當成技術性錯誤丟出去變 500。
 */
/**
 * 記下一次名單清查。
 *
 * 這筆落庫就是「這個縣市這種選舉已經清查過」的唯一憑據——自動缺口靠
 * roster_checks 的最後清查時間決定要不要再派，所以寫進去之後那個任務就消失，
 * 過了重查週期又自己出現。不需要任何人去關掉它。
 *
 * 它刻意不建立任何參選紀錄：缺的人由代理另外用 candidacy 逐筆提交，
 * 各自走自己的票數。一筆清查回報不該夾帶一整份名單的寫入權。
 */
async function applyRosterCheck(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const electionId = int(p.election_id);
  const region = str(p.region);
  const electionType = str(p.election_type);
  if (!electionId || !region || !electionType) {
    return { status: "failed", message: "缺 election_id／region／election_type，這三個要原樣帶回任務 target 裡的值" };
  }

  const { data: inserted, error } = await supabase.from("roster_checks").insert({
    election_id: electionId,
    region,
    election_type: electionType,
    cec_count: int(p.cec_count),
    ours_count: int(p.ours_count),
    submitted: int(p.submitted) ?? 0,
    agent_name: row.agent_name,
    source_url: row.source_urls[0] ?? null,
    contribution_id: row.id,
  }).select("id, checked_at").maybeSingle();
  throwIf(error, "roster_checks insert");
  if (!inserted) throw new Error("roster_checks insert 沒有回傳 id");

  await recordInsert(supabase, ctx, "roster_checks", String(inserted.id), inserted);
  // cec_count 留空代表「試過但找不到官方名單」，那不是清查完成。訊息要講清楚，
  // 否則回報的人會以為這個縣市結案了；缺口也只會壓一天就重新派（見 migration
  // 20260912000028 的兩個時鐘）。
  const cec = int(p.cec_count);
  const done = cec !== null && cec !== undefined;
  const message = done
    ? `${region} ${electionId} ${electionType} 名單已清查：中選會 ${cec} 人、我們 ${int(p.ours_count) ?? "?"} 人、另外補交 ${int(p.submitted) ?? 0} 筆`
    : `已記錄你這次的嘗試：${region} ${electionId} ${electionType} 查不到官方名單，所以還沒算清查完成，這個縣市明天會再派給別人試`;
  return { status: "applied", message };
}

/**
 * 移除一筆明顯不該存在的資料。
 *
 * 刻意做成軟移除：打上 removed_at 讓它從網站消失，資料與整條查核履歷都留著。
 * 因為救得回來，門檻才敢訂 3 票而不是比照加減參選人的 4～8 票。
 * 每一次移除都寫 edit_history，所以 apply 的 revert 可以整筆倒回。
 */
async function applyRemoval(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const table = str(p.target_table);
  const targetId = str(p.target_id);
  if (table !== "policies") return { status: "failed", message: `目前只能移除政見，收到 ${table}` };
  if (!targetId) return { status: "failed", message: "缺 target_id" };

  const { data: current, error: readError } = await supabase
    .from("policies").select("id, title, removed_at").eq("id", targetId).maybeSingle();
  throwIf(readError, "policies read");
  if (!current) return { status: "failed", message: `找不到政見 ${targetId}` };
  if (current.removed_at) {
    return { status: "applied", policy_id: targetId, message: "這筆政見先前已經移除過了，沿用、未重複處理" };
  }

  const reason = str(p.reason) ?? "";
  const { error } = await supabase.from("policies")
    .update({ removed_at: new Date().toISOString(), removed_reason: reason, removed_by: row.id })
    .eq("id", targetId);
  throwIf(error, "policies removal update");

  // 只記 removed_at 這一欄就夠 revert 用：把它倒回 null，資料就回到網站上
  await recordUpdate(supabase, ctx, "policies", targetId, "removed_at", null, "removed");
  return { status: "applied", policy_id: targetId, message: `政見「${current.title}」已從網站移除（資料留著，可還原）：${reason}` };
}

async function applyQuestionAnswer(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const questionId = str(p.question_id);
  const answer = str(p.answer);
  if (!questionId || !answer) return { status: "failed", message: "question_answer 要帶 question_id 與 answer" };
  const agentName = row.agent_name?.trim();
  if (!agentName) return { status: "failed", message: "question_answer 一定要有 agent_name（回答要掛在哪個代號底下）" };

  const { data: question, error: qError } = await supabase.from("citizen_questions").select("id, status").eq("id", questionId).maybeSingle();
  throwIf(qError, "citizen_questions lookup");
  if (!question) return { status: "failed", message: `找不到提問 ${questionId}，可能已被下架，不用再回答` };
  if (question.status === "hidden") return { status: "failed", message: "這題已被下架，不再收答案" };

  const { data: existing, error: existingError } = await supabase.from("question_answers").select("agent_name").eq("question_id", questionId);
  throwIf(existingError, "question_answers read");
  const answers = (existing ?? []) as Array<{ agent_name: string }>;
  if (answers.some((a) => a.agent_name.toLowerCase() === agentName.toLowerCase())) {
    return { status: "failed", message: `代號「${agentName}」已經回答過這一題，一個代號一題只能答一份；想補充請用不同角度指出前一份的不足，或去回答其他題目` };
  }
  if (answers.length >= 3) {
    return { status: "failed", message: "這題已經有 3 份答案了，不再收新的；請去回答其他題目" };
  }

  const insertRow = {
    question_id: questionId,
    agent_name: agentName,
    agent_tool: row.agent_tool ?? null,
    answer,
    source_urls: row.source_urls,
    contribution_id: row.id,
  };
  const { data: inserted, error } = await supabase.from("question_answers").insert(insertRow).select("*").maybeSingle();
  if (error) {
    // 競態窗口撞上 DB 的兩道防線：唯一鍵（重複代號）或 trigger（滿三份）；轉成講清楚的 failed，不當技術性錯誤重試
    const message = error.message ?? String(error);
    if (/question_answers_one_per_agent|duplicate key/i.test(message)) {
      return { status: "failed", message: `代號「${agentName}」已經回答過這一題，一個代號一題只能答一份` };
    }
    if (/已經有 3 份答案/.test(message)) {
      return { status: "failed", message: "這題已經有 3 份答案了，不再收新的；請去回答其他題目" };
    }
    throw new Error(`question_answers insert: ${message}`);
  }
  if (!inserted) throw new Error("question_answers insert 沒有回傳 id");
  await recordInsert(supabase, ctx, "question_answers", inserted.id, inserted);
  return { status: "applied", message: `已將「${agentName}」的答案登記到提問 ${questionId}`, question_id: questionId };
}

/** no_change：代理核對後確認與資料庫一致 → 只關閉該任務、不動任何正式資料（自動缺口任務沒有列可關，只記錄） */
/** 跟 SQL 的 task_check_cooldown_days() 同一個數字；改一邊要改另一邊，thresholds 測試會比對 */
export const TASK_CHECK_COOLDOWN_DAYS = 14;

async function applyNoChange(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const taskId = str(row.payload.task_id);
  if (!taskId) return { status: "failed", message: "no_change 要帶 task_id" };
  if (taskId.startsWith("auto:")) {
    // 自動缺口不是靠關閉任務消失的，它是即時算出來的。所以「查過了、沒東西可補」
    // 原本完全不留痕跡，同一筆死路會被無限重派給每一個代理，每個人都白跑一次。
    // 記一筆 task_checks，冷卻期內不再派；過期再出現，因為世界會變。
    const check = {
      task_id: taskId,
      agent_name: row.agent_name,
      note: str(row.payload.finding) ?? str(row.payload.note) ?? row.note ?? null,
      contribution_id: row.id,
    };
    const { error } = await supabase.from("task_checks").insert(check);
    throwIf(error, "task_checks insert");
    // 用 task_id 當紀錄鍵：這張表的 id 是流水號，回不回來都不影響還原，
    // 而 task_id 才是人看得懂、也是冷卻判斷用的那把鑰匙。
    await recordInsert(supabase, ctxOf(row), "task_checks", taskId, check);
    return { status: "applied", message: `已記錄「查過、無異動」，這筆缺口 ${TASK_CHECK_COOLDOWN_DAYS} 天內不會再派給任何人；期間資料若補齊也會自行消失`, task_id: taskId };
  }
  const task = await closeTask(supabase, taskId, row.agent_name);
  if (!task) return { status: "failed", message: `找不到任務 ${taskId}` };
  await recordUpdate(supabase, ctxOf(row), "contribution_tasks", taskId, "status", "open", "closed");
  return { status: "applied", message: `已記錄無異動並關閉任務 ${taskId}`, task_id: taskId };
}

// task_id 要撈：裁決 uphold 後原貢獻上線，它所屬的任務要能被關（task-fulfilment.ts）
const ORIGINAL_COLUMNS = "id, contribution_type, payload, source_urls, note, agent_name, agent_tool, contributor_url, status, review_notes, task_id";

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
    // 修正任務刻意不關：reject 代表「原貢獻有誤」，那筆「照反對意見修好它」的任務
    // 正是還沒做完的事。查過覺得無從修起的人用 no_change 帶 task_id 回報就會關掉。
    return { status: "applied", message: `裁決 reject 定案：原貢獻 ${targetId} 已退件；修正任務保持 open，等人依反對意見重提` };
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
  // uphold 代表原貢獻其實是對的，那筆修正任務就沒有東西要修了
  const fixClosed = await closeFixTasks(supabase, targetId);
  return {
    status: "applied",
    politician_id: outcome.politician_id,
    policy_id: outcome.policy_id,
    message: `裁決 uphold 定案：原貢獻已落庫（${outcome.message}）${fixClosed > 0 ? `；一併關閉 ${fixClosed} 筆修正任務` : ""}`,
  };
}

/**
 * 貢獻上線後，它所屬的手動任務若算做完了就關掉（規則見 task-fulfilment.ts）。回傳有沒有關。
 * 關任務也記進 edit_history，整筆還原時任務會跟著重新打開。
 */
export async function closeTaskIfFulfilled(supabase: SupabaseLike, row: ContributionRow): Promise<boolean> {
  const taskId = manualTaskIdOf(row);
  if (!taskId) return false;
  const { data: task, error } = await supabase.from("contribution_tasks").select("id, status, task_type").eq("id", taskId).maybeSingle();
  throwIf(error, "contribution_tasks lookup");
  if (!task || task.status !== "open") return false;
  if (!shouldCloseOnApplied(str(task.task_type), row.contribution_type)) return false;
  const closed = await closeTask(supabase, taskId, row.agent_name);
  if (!closed) return false;
  await recordUpdate(supabase, ctxOf(row), "contribution_tasks", taskId, "status", "open", "closed");
  return true;
}

export async function applyContribution(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const outcome = await applyByType(supabase, row);
  if (outcome.status === "applied") {
    // 資料已經寫進去了，關任務只是附帶動作：關不成只記錄，不能讓這筆被當成上線失敗
    // （上線失敗會被自動重試，資料會再寫一次）
    try {
      await closeTaskIfFulfilled(supabase, row);
    } catch (e) {
      console.error("closeTaskIfFulfilled:", e instanceof Error ? e.message : String(e));
    }
  }
  return outcome;
}

async function applyByType(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  switch (row.contribution_type) {
    case "adjudication": return await applyAdjudication(supabase, row);
    case "no_change": return await applyNoChange(supabase, row);
    case "politician": return await applyPolitician(supabase, row);
    case "candidacy": return await applyCandidacy(supabase, row);
    case "policy": return await applyPolicy(supabase, row);
    case "policy_progress": return await applyPolicyProgress(supabase, row);
    case "correction": return await applyCorrection(supabase, row);
    case "task_suggestion": return await applyTaskSuggestion(supabase, row);
    case "question_answer": return await applyQuestionAnswer(supabase, row);
    case "removal": return await applyRemoval(supabase, row);
    case "roster_check": return await applyRosterCheck(supabase, row);
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
