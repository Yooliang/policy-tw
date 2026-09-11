/**
 * 把一筆貢獻落進正式表。同儕驗證通過（verified）後由 /report 或 apply-verified 自動呼叫；維護者 apply 也走這裡。
 *
 * - politician／candidacy：走 ensurePolitician（多面向身份比對）；ambiguous → needs_identity_review（進 politician_identity_reviews，不動正式表）
 * - policy：人物必須已存在；同一人既有政見標題 similarity ≥ 0.6 或互相包含 → needs_review（不新增，列出相似政見）
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

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export const POLICY_SIMILARITY_THRESHOLD = 0.6;

export interface ContributionRow {
  id: string;
  contribution_type: ContributionType;
  payload: Obj;
  source_urls: string[];
  note: string | null;
  agent_name: string | null;
  contributor_url: string | null;
}

export type ApplyStatus = "applied" | "needs_identity_review" | "needs_review" | "failed";

export interface ApplyOutcome {
  status: ApplyStatus;
  message: string;
  politician_id?: string;
  policy_id?: string;
  created_politician?: boolean;
  similar_policies?: Array<{ id: string; title: string; similarity: number }>;
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

async function applyPolitician(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const ensured = await ensurePolitician(supabase, {
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
  if (ensured.politician_id === null) {
    return { status: "needs_identity_review", message: `身份比對模稜兩可，已進 politician_identity_reviews：${ensured.resolution.reason}` };
  }
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
  const ensured = await ensurePolitician(supabase, {
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
  if (ensured.politician_id === null) {
    return { status: "needs_identity_review", message: `身份比對模稜兩可，已進 politician_identity_reviews：${ensured.resolution.reason}` };
  }
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

  // 相似度守門：同一人既有政見標題 similarity ≥ 0.6 或互相包含 → 不新增，轉 needs_review
  const { data: similar, error: simError } = await supabase.rpc("find_similar_policies", {
    p_politician_id: politicianId, p_title: String(p.title), p_threshold: POLICY_SIMILARITY_THRESHOLD,
  });
  throwIf(simError, "find_similar_policies");
  const hits = ((similar ?? []) as Array<{ id: string; title: string; similarity: number }>);
  if (hits.length > 0) {
    return {
      status: "needs_review",
      politician_id: politicianId,
      similar_policies: hits,
      message: `疑似與既有政見重複，未新增：${hits.map((h) => `「${h.title}」(${(h.similarity * 100).toFixed(0)}%)`).join("、")}`,
    };
  }

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

export async function applyContribution(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  switch (row.contribution_type) {
    case "politician": return await applyPolitician(supabase, row);
    case "candidacy": return await applyCandidacy(supabase, row);
    case "policy": return await applyPolicy(supabase, row);
    case "policy_progress": return await applyPolicyProgress(supabase, row);
    case "correction": return await applyCorrection(supabase, row);
    default: return { status: "failed", message: `未知型別 ${row.contribution_type}` };
  }
}

/** apply 結果 → contributions.status */
export function contributionStatusFor(outcome: ApplyStatus): "applied" | "approved" | "needs_review" | "apply_failed" {
  switch (outcome) {
    case "applied": return "applied";
    case "needs_identity_review": return "approved"; // 身份待人工，維護者從 politician_identity_reviews 處理
    case "needs_review": return "needs_review";
    default: return "apply_failed";
  }
}
