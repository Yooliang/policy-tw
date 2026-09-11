/**
 * /next、/tasks 的 `current`（現況）與 `lookup`（現成 REST 網址）；kind=verify 的 `current`。
 * 純函式 shape*（可測）＋ fetch*（碰 DB）分開。長文字截 500 字並標 truncated:true。
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export const REST_BASE = "https://wiiqoaytpqvegtknlbue.supabase.co/rest/v1";
export const TEXT_LIMIT = 500;
export const MAX_EXISTING_POLICIES = 30;
export const MAX_TRACKING_LOGS = 5;

export function truncateText(value: unknown, limit = TEXT_LIMIT): { text: string | null; truncated: boolean } {
  if (typeof value !== "string") return { text: null, truncated: false };
  return value.length > limit ? { text: value.slice(0, limit), truncated: true } : { text: value, truncated: false };
}

/** 把物件裡的長字串欄位截短；有截短就加 truncated:true */
export function truncateFields<T extends Obj>(row: T, fields: readonly string[]): T & { truncated?: true } {
  let truncated = false;
  const out: Obj = { ...row };
  for (const f of fields) {
    const t = truncateText(row[f]);
    if (t.truncated) { out[f] = t.text; truncated = true; }
  }
  return (truncated ? { ...out, truncated: true } : out) as T & { truncated?: true };
}

export interface TaskContextData {
  politician?: Obj | null;
  elections?: Obj[];
  policies?: Obj[];
  policies_total?: number;
  policy?: Obj | null;
  tracking_logs?: Obj[];
  politician_election?: Obj | null;
}

const POLITICIAN_BRIEF = ["id", "name", "party", "region", "election_type", "current_position", "birth_year"] as const;
const PROFILE_FIELDS = ["birth_year", "current_position", "avatar_url", "education_level", "bio", "sub_region"] as const;

function pick(row: Obj | null | undefined, keys: readonly string[]): Obj | null {
  if (!row) return null;
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
}

/** 純函式：依 task_type 組 current */
export function shapeTaskCurrent(taskType: string, data: TaskContextData): Obj {
  const p = data.politician ?? null;
  switch (taskType) {
    case "policy_missing": {
      const list = (data.policies ?? []).slice(0, MAX_EXISTING_POLICIES).map((x) => pick(x, ["id", "title", "category", "status"]));
      return {
        politician: p ? { ...pick(p, POLITICIAN_BRIEF), has_avatar: !!p.avatar_url } : null,
        elections: (data.elections ?? []).map((e) => pick(e, ["election_id", "election_type", "candidate_status", "source_note"])),
        existing_policies: list,
        existing_policies_total: data.policies_total ?? (data.policies ?? []).length,
      };
    }
    case "progress_stale":
    case "policy_source_missing": {
      const policy = data.policy ? truncateFields(pick(data.policy, ["id", "title", "description", "category", "status", "progress", "source_url", "proposed_date", "last_updated"])!, ["description"]) : null;
      return {
        policy,
        politician: pick(p, POLITICIAN_BRIEF),
        recent_tracking_logs: (data.tracking_logs ?? []).slice(0, MAX_TRACKING_LOGS).map((l) => truncateFields(pick(l, ["date", "event", "description", "source_url"])!, ["description"])),
      };
    }
    case "profile_gap": {
      const full = p ? truncateFields(p, ["bio"]) : null;
      const missing = PROFILE_FIELDS.filter((f) => !p || p[f] === null || p[f] === undefined || p[f] === "");
      const present = PROFILE_FIELDS.filter((f) => !missing.includes(f));
      return { politician: full, missing_fields: missing, present_fields: present };
    }
    case "candidacy_source_missing":
      return { politician_election: data.politician_election ?? null, politician: pick(p, POLITICIAN_BRIEF) };
    default:
      return { politician: pick(p, POLITICIAN_BRIEF) };
  }
}

/** 現成 REST 查詢網址（要帶 apikey／Authorization header，見 skill.md §7） */
export function buildLookup(target: Obj): Record<string, string> {
  const pid = typeof target.politician_id === "string" ? target.politician_id : null;
  const policyId = typeof target.policy_id === "string" ? target.policy_id : null;
  const out: Record<string, string> = {};
  if (pid) {
    out.politician = `${REST_BASE}/politicians?select=*&id=eq.${pid}`;
    out.policies = `${REST_BASE}/policies?select=id,title,category,status,progress,source_url,election_id&politician_id=eq.${pid}&order=proposed_date.desc`;
    out.elections = `${REST_BASE}/politician_elections?select=id,election_id,election_type,position,candidate_status,source_note,verified&politician_id=eq.${pid}`;
  }
  if (policyId) {
    out.policy = `${REST_BASE}/policies?select=*&id=eq.${policyId}`;
    out.tracking_logs = `${REST_BASE}/tracking_logs?select=date,event,description,source_url&policy_id=eq.${policyId}&order=date.desc&limit=20`;
  }
  return out;
}

/** 碰 DB：依 task_type／target 撈 current 要的資料 */
export async function fetchTaskContext(supabase: SupabaseLike, taskType: string, target: Obj): Promise<TaskContextData> {
  const pid = typeof target.politician_id === "string" ? target.politician_id : null;
  const policyId = typeof target.policy_id === "string" ? target.policy_id : null;
  const data: TaskContextData = {};

  if (pid) {
    const { data: p } = await supabase.from("politicians").select("*").eq("id", pid).maybeSingle();
    data.politician = p ?? null;
  }
  if (taskType === "policy_missing" && pid) {
    const [el, pol] = await Promise.all([
      supabase.from("politician_elections").select("election_id, election_type, candidate_status, source_note").eq("politician_id", pid).order("election_id", { ascending: false }),
      supabase.from("policies").select("id, title, category, status", { count: "exact" }).eq("politician_id", pid).order("proposed_date", { ascending: false }).limit(MAX_EXISTING_POLICIES),
    ]);
    data.elections = el.data ?? [];
    data.policies = pol.data ?? [];
    data.policies_total = pol.count ?? (data.policies ?? []).length;
  }
  if ((taskType === "progress_stale" || taskType === "policy_source_missing") && policyId) {
    const [pl, logs] = await Promise.all([
      supabase.from("policies").select("*").eq("id", policyId).maybeSingle(),
      supabase.from("tracking_logs").select("date, event, description, source_url").eq("policy_id", policyId).order("date", { ascending: false }).limit(MAX_TRACKING_LOGS),
    ]);
    data.policy = pl.data ?? null;
    data.tracking_logs = logs.data ?? [];
  }
  if (taskType === "candidacy_source_missing" && pid) {
    const electionId = typeof target.election_id === "number" ? target.election_id : 2026;
    const { data: pe } = await supabase.from("politician_elections").select("*").eq("politician_id", pid).eq("election_id", electionId).maybeSingle();
    data.politician_election = pe ?? null;
  }
  return data;
}

export interface VerifyContextData {
  politicians?: Obj[];
  elections?: Obj[];
  policies?: Obj[];
  policy?: Obj | null;
  tracking_logs?: Obj[];
  target?: Obj | null;
}

/** 純函式：依 contribution_type 組驗證用的 current */
export function shapeVerifyCurrent(contributionType: string, payload: Obj, data: VerifyContextData): Obj {
  switch (contributionType) {
    case "politician":
    case "candidacy":
      return {
        matching_politicians: (data.politicians ?? []).map((p) => ({ ...pick(p, POLITICIAN_BRIEF), has_avatar: !!p.avatar_url })),
        elections: (data.elections ?? []).map((e) => pick(e, ["politician_id", "election_id", "election_type", "candidate_status", "source_note"])),
        hint: "同名多位時，用 payload 的政黨／縣市／現職／出生年判斷是不是同一人；candidacy 要看該人是否已有這場選舉的紀錄",
      };
    case "policy":
      return {
        politician: pick(data.politicians?.[0] ?? null, POLITICIAN_BRIEF),
        existing_policy_titles: (data.policies ?? []).slice(0, MAX_EXISTING_POLICIES).map((x) => pick(x, ["id", "title", "category", "status"])),
        hint: "看 payload.title 是否與既有政見重複或只是改寫；重複請投 disagree 並在 note 指出既有政見 id",
      };
    case "policy_progress":
      return {
        policy: data.policy ? truncateFields(pick(data.policy, ["id", "title", "status", "progress", "last_updated", "source_url", "description"])!, ["description"]) : null,
        recent_tracking_logs: (data.tracking_logs ?? []).slice(0, MAX_TRACKING_LOGS).map((l) => truncateFields(pick(l, ["date", "event", "description", "source_url"])!, ["description"])),
      };
    case "correction": {
      const field = typeof payload.field === "string" ? payload.field : "";
      return {
        target_table: payload.target_table ?? null,
        target_id: payload.target_id ?? null,
        field,
        current_value: data.target ? (data.target[field] ?? null) : null,
        target: data.target ? truncateFields(data.target, ["description", "bio"]) : null,
      };
    }
    default:
      return {};
  }
}

/** 碰 DB：依 contribution_type／payload 撈驗證用資料 */
export async function fetchVerifyContext(supabase: SupabaseLike, contributionType: string, payload: Obj): Promise<VerifyContextData> {
  const data: VerifyContextData = {};
  const pid = typeof payload.politician_id === "string" ? payload.politician_id : null;
  const name = typeof payload.name === "string" ? payload.name.trim() : null;

  if (contributionType === "politician" || contributionType === "candidacy" || contributionType === "policy") {
    let q = supabase.from("politicians").select("*").limit(10);
    q = pid ? q.eq("id", pid) : q.eq("name", name ?? "");
    const { data: ps } = await q;
    data.politicians = ps ?? [];
    const ids = (data.politicians ?? []).map((p) => p.id as string);
    if (ids.length > 0 && contributionType !== "policy") {
      const { data: el } = await supabase.from("politician_elections").select("politician_id, election_id, election_type, candidate_status, source_note").in("politician_id", ids).order("election_id", { ascending: false });
      data.elections = el ?? [];
    }
    if (ids.length === 1 && contributionType === "policy") {
      const { data: pol } = await supabase.from("policies").select("id, title, category, status").eq("politician_id", ids[0]).limit(MAX_EXISTING_POLICIES);
      data.policies = pol ?? [];
    }
  }
  if (contributionType === "policy_progress") {
    const policyId = typeof payload.policy_id === "string" ? payload.policy_id : null;
    if (policyId) {
      const [pl, logs] = await Promise.all([
        supabase.from("policies").select("*").eq("id", policyId).maybeSingle(),
        supabase.from("tracking_logs").select("date, event, description, source_url").eq("policy_id", policyId).order("date", { ascending: false }).limit(MAX_TRACKING_LOGS),
      ]);
      data.policy = pl.data ?? null;
      data.tracking_logs = logs.data ?? [];
    }
  }
  if (contributionType === "correction") {
    const table = typeof payload.target_table === "string" ? payload.target_table : null;
    const id = payload.target_id;
    if (table && id !== undefined && ["politicians", "politician_elections", "policies"].includes(table)) {
      const { data: t } = await supabase.from(table).select("*").eq("id", id).maybeSingle();
      data.target = t ?? null;
    }
  }
  return data;
}
