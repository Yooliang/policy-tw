/**
 * /next、/tasks 的 `current`（現況）與 `lookup`（現成 REST 網址）；kind=verify 的 `current`。
 * 純函式 shape*（可測）＋ fetch*（碰 DB）分開。長文字截 500 字並標 truncated:true。
 */

import { createSupabaseIdentityStore, resolvePolitician } from "./politician-identity.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;
export const POLICY_SIMILARITY_THRESHOLD = 0.6;

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
  /** adjudicate：被裁決的貢獻、它的所有票、未定案的裁決數 */
  contribution?: Obj | null;
  votes?: Obj[];
  pending_adjudications?: number;
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
    case "adjudicate": {
      const c = data.contribution ?? null;
      return {
        contribution: c
          ? { ...pick(c, ["id", "contribution_type", "status", "agent_name", "agent_tool", "source_urls", "note", "agree_count", "disagree_count", "unsure_count", "review_notes", "last_error", "created_at"]), payload: c.payload ?? null }
          : null,
        votes: (data.votes ?? []).map((v) => pick(v, ["verdict", "evidence_url", "note", "agent_name", "resolved_politician_id", "created_at"])),
        pending_adjudications: data.pending_adjudications ?? 0,
        hint: "正方＝contribution.source_urls，反方＝votes 裡 disagree 的 evidence_url／note；都打開、獨立判斷。uphold＝原貢獻正確、reject＝原貢獻有誤；payload 帶 contribution_id、verdict、reason（≥20 字）、checked_urls；身份爭議多帶 resolved_politician_id。你的裁決會再被 4 票驗證才定案。",
      };
    }
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
  if (taskType === "adjudicate" && typeof target.contribution_id === "string") {
    const cid = target.contribution_id;
    const [c, votes, adj] = await Promise.all([
      supabase.from("contributions").select("*").eq("id", cid).maybeSingle(),
      supabase.from("contribution_votes").select("verdict, evidence_url, note, agent_name, resolved_politician_id, created_at").eq("contribution_id", cid).order("created_at", { ascending: true }),
      supabase.from("contributions").select("id", { count: "exact", head: true }).eq("contribution_type", "adjudication").eq("payload->>contribution_id", cid).in("status", ["pending", "verified"]),
    ]);
    data.contribution = c.data ?? null;
    data.votes = votes.data ?? [];
    data.pending_adjudications = adj.count ?? 0;
  }
  return data;
}

export interface VerifyContextData {
  politicians?: Obj[];
  elections?: Obj[];
  policies?: Obj[];
  /** policy：find_similar_policies（pg_trgm）命中的既有政見，給驗證者判斷是否重複 */
  similar_policies?: Array<{ id: string; title: string; similarity: number }>;
  /** politician／candidacy：多面向比對的 dry-run 結果（不寫回） */
  identity?: { decision: string; politician_id?: string | null; reason: string; candidate_ids: string[] } | null;
  policy?: Obj | null;
  tracking_logs?: Obj[];
  target?: Obj | null;
}

const IDENTITY_HINT = {
  matched: "系統比對到唯一一位（identity.politician_id）；核對來源後 agree 即可，不用帶 resolved_politician_id",
  new: "系統找不到同一人，通過後會建新人物；若你認為其實是 identity_candidates 裡的某位，agree 時帶 resolved_politician_id",
  ambiguous: "同名多位、系統判不出：核對來源後投 agree 時**必須帶 resolved_politician_id**（identity_candidates 之一）；兩票同一位才會落庫，指不同位或都沒指認會轉 disputed 交維護者",
} as const;

/** 純函式：依 contribution_type 組驗證用的 current */
export function shapeVerifyCurrent(contributionType: string, payload: Obj, data: VerifyContextData): Obj {
  switch (contributionType) {
    case "politician":
    case "candidacy": {
      const elections = (data.elections ?? []).map((e) => pick(e, ["politician_id", "election_id", "election_type", "candidate_status", "source_note"]));
      const candidates = (data.politicians ?? []).map((p) => ({
        ...pick(p, POLITICIAN_BRIEF),
        has_avatar: !!p.avatar_url,
        elections: elections.filter((e) => e?.politician_id === p.id).map((e) => `${e?.election_id} ${e?.election_type}（${e?.candidate_status}）`),
      }));
      const decision = data.identity?.decision ?? null;
      return {
        identity: data.identity ? { decision: data.identity.decision, politician_id: data.identity.politician_id ?? null, reason: data.identity.reason } : null,
        identity_pick_required: decision === "ambiguous",
        identity_candidates: candidates,
        matching_politicians: candidates.map(({ elections: _e, ...rest }) => rest),
        elections,
        hint: (decision && decision in IDENTITY_HINT ? IDENTITY_HINT[decision as keyof typeof IDENTITY_HINT] : "同名多位時，用 payload 的政黨／縣市／現職／出生年判斷是不是同一人") +
          "；candidacy 要看該人是否已有這場選舉的紀錄",
      };
    }
    case "policy":
      return {
        politician: pick(data.politicians?.[0] ?? null, POLITICIAN_BRIEF),
        existing_policy_titles: (data.policies ?? []).slice(0, MAX_EXISTING_POLICIES).map((x) => pick(x, ["id", "title", "category", "status"])),
        similar_policies: (data.similar_policies ?? []).map((s) => ({ id: s.id, title: s.title, similarity: Math.round(s.similarity * 100) / 100 })),
        hint: "similar_policies 是系統算出的相似既有政見（相似度 0～1）；若 payload 與其中一條實質重複（同一承諾換句話說），投 disagree 並在 note 寫「重複於 <policy_id>」；只是主題相近、內容不同就照來源核對",
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

/** 多面向身份比對 dry-run（persist:false，不寫 keys、不寫 reviews）；失敗不影響派工 */
async function dryRunIdentity(supabase: SupabaseLike, payload: Obj, name: string): Promise<VerifyContextData["identity"]> {
  try {
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const resolution = await resolvePolitician(createSupabaseIdentityStore(supabase), {
      name,
      party: s(payload.party),
      region: s(payload.region),
      election_type: s(payload.election_type),
      position: s(payload.position),
      current_position: s(payload.current_position),
      birth_year: typeof payload.birth_year === "number" ? payload.birth_year : s(payload.birth_year),
      cec_cand_id: typeof payload.cec_cand_id === "number" ? payload.cec_cand_id : s(payload.cec_cand_id),
      cec_theme_id: s(payload.cec_theme_id),
    }, { persist: false });
    return { decision: resolution.decision, politician_id: resolution.politician_id ?? null, reason: resolution.reason, candidate_ids: resolution.candidates.map((c) => c.politician_id) };
  } catch (e) {
    console.error("dryRunIdentity:", e instanceof Error ? e.message : String(e));
    return null;
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
      const [{ data: pol }, similar] = await Promise.all([
        supabase.from("policies").select("id, title, category, status").eq("politician_id", ids[0]).limit(MAX_EXISTING_POLICIES),
        typeof payload.title === "string"
          ? supabase.rpc("find_similar_policies", { p_politician_id: ids[0], p_title: payload.title, p_threshold: POLICY_SIMILARITY_THRESHOLD })
          : Promise.resolve({ data: [] }),
      ]);
      data.policies = pol ?? [];
      data.similar_policies = (similar.data ?? []) as VerifyContextData["similar_policies"];
    }
    if (contributionType !== "policy" && name) {
      data.identity = await dryRunIdentity(supabase, payload, name);
      // 比對出來的候選人若不在同名清單裡（別名／改名），一併附上，讓驗證者能指認
      const missing = (data.identity?.candidate_ids ?? []).filter((id) => !ids.includes(id));
      if (missing.length > 0) {
        const [{ data: more }, { data: moreEl }] = await Promise.all([
          supabase.from("politicians").select("*").in("id", missing),
          supabase.from("politician_elections").select("politician_id, election_id, election_type, candidate_status, source_note").in("politician_id", missing).order("election_id", { ascending: false }),
        ]);
        data.politicians = [...(data.politicians ?? []), ...(more ?? [])];
        data.elections = [...(data.elections ?? []), ...(moreEl ?? [])];
      }
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
