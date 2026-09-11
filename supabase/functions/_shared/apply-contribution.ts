/**
 * 把一筆 approved 的貢獻落進正式表。維護者透過 apply-contribution Edge Function 呼叫。
 *
 * - politician／candidacy：走 ensurePolitician（多面向身份比對）；ambiguous 已由 resolvePolitician 寫進
 *   politician_identity_reviews，這裡回 status=needs_identity_review、不動正式表。
 * - policy：人物必須已存在（不會為了一條政見建新人物）；insert policies 帶 source_url。
 * - policy_progress：更新 policies.status／progress，並補一筆 tracking_logs。
 * - correction：只允許 CORRECTION_FIELDS 白名單欄位，直接 UPDATE。
 * 每一步都檢查 error；成功回 applied 與落庫 id。
 */

import { CORRECTION_FIELDS, type ContributionType } from "./contribution-schema.ts";
import { ensurePolitician, upsertParticipation } from "./candidate-import.ts";
import { findPoliticianByNameStrict } from "./politician-identity.ts";
import { normElectionType } from "./identity-normalize.ts";
import { normalizeCategory } from "./category-map.ts";

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
}

export interface ApplyOutcome {
  status: "applied" | "needs_identity_review" | "failed";
  message: string;
  politician_id?: string;
  policy_id?: string;
  created_politician?: boolean;
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

/** 只補空欄位，不覆蓋既有值 */
async function fillBlanks(supabase: SupabaseLike, politicianId: string, values: Obj): Promise<string[]> {
  const entries = Object.entries(values).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return [];
  const { data: current, error } = await supabase.from("politicians").select(entries.map(([k]) => k).join(", ")).eq("id", politicianId).maybeSingle();
  throwIf(error, "politicians read");
  const patch = Object.fromEntries(entries.filter(([k]) => current?.[k] === null || current?.[k] === undefined || current?.[k] === ""));
  if (Object.keys(patch).length === 0) return [];
  const { error: updateError } = await supabase.from("politicians").update(patch).eq("id", politicianId);
  throwIf(updateError, "politicians fill blanks");
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

async function applyPolitician(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
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
  const filled = ensured.created ? [] : await fillBlanks(supabase, ensured.politician_id, {
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
    created_politician: ensured.created,
    message: ensured.created ? "已建立新政治人物" : `已對到既有人物${filled.length ? `，補上 ${filled.join("、")}` : "（無空欄位可補）"}`,
  };
}

async function applyCandidacy(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
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
  // withdrawn 在 DB 沒有對應值，落成 not_running 並在 source_note 註明
  const rawStatus = String(p.candidate_status);
  const candidateStatus = rawStatus === "withdrawn" ? "not_running" : rawStatus;
  const participation = await upsertParticipation(supabase, {
    politician_id: ensured.politician_id,
    election_id: Number(p.election_id),
    position: str(p.position) ?? `${electionType}候選人`,
    election_type: electionType,
    candidate_status: candidateStatus,
    source_note: `${sourceNote(row)}${rawStatus === "withdrawn" ? "；已退選" : ""}`,
  });
  return {
    status: "applied",
    politician_id: ensured.politician_id,
    created_politician: ensured.created,
    message: `參選紀錄已${participation.outcome === "created" ? "建立" : "更新"}為 ${candidateStatus}`,
  };
}

async function applyPolicy(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const politicianId = await locatePolitician(supabase, p);
  if (!politicianId) return { status: "failed", message: "找不到該政治人物（不會為了一條政見建新人物）；請先提交 politician 貢獻或帶 politician_id" };

  const { data: dup, error: dupError } = await supabase.from("policies").select("id").eq("politician_id", politicianId).ilike("title", String(p.title)).limit(1);
  throwIf(dupError, "policies dup check");
  if (dup && dup.length > 0) return { status: "failed", policy_id: dup[0].id, politician_id: politicianId, message: "同一人已有同標題政見" };

  const today = new Date().toISOString().slice(0, 10);
  const { data: inserted, error } = await supabase.from("policies").insert({
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
  }).select("id").maybeSingle();
  throwIf(error, "policies insert");
  if (!inserted) throw new Error("policies insert 沒有回傳 id");
  return { status: "applied", policy_id: inserted.id, politician_id: politicianId, message: "政見已建立" };
}

async function applyPolicyProgress(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
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
  const patch: Obj = { status: String(p.status), last_updated: String(p.date) };
  if (int(p.progress) !== null) patch.progress = p.progress;
  const { error } = await supabase.from("policies").update(patch).eq("id", policyId);
  throwIf(error, "policies update");
  const { error: logError } = await supabase.from("tracking_logs").insert({
    policy_id: policyId,
    date: String(p.date),
    event: `進度更新：${p.status}${int(p.progress) !== null ? `（${p.progress}%）` : ""}`,
    description: `${String(p.note)}\n\n${sourceNote(row)}`,
    source_url: row.source_urls[0],
  });
  throwIf(logError, "tracking_logs insert");
  return { status: "applied", policy_id: policyId!, message: "政見進度已更新並留下追蹤紀錄" };
}

async function applyCorrection(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const table = String(p.target_table) as keyof typeof CORRECTION_FIELDS;
  const field = String(p.field);
  if (!CORRECTION_FIELDS[table]?.includes(field)) return { status: "failed", message: `${table}.${field} 不在可修正欄位白名單` };
  const { data: current, error: readError } = await supabase.from(table).select(`id, ${field}`).eq("id", p.target_id).maybeSingle();
  throwIf(readError, `${table} read`);
  if (!current) return { status: "failed", message: `${table} 找不到 id=${p.target_id}` };
  const newValue = table === "policies" && field === "category" ? (normalizeCategory(String(p.correct_value)) ?? p.correct_value) : p.correct_value;
  const { error } = await supabase.from(table).update({ [field]: newValue }).eq("id", p.target_id);
  throwIf(error, `${table} correction update`);
  return {
    status: "applied",
    message: `${table}.${field}：「${current[field] ?? ""}」→「${String(p.correct_value)}」`,
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
