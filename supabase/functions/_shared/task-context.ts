/**
 * /next、/tasks 的 `current`（現況）與 `lookup`（現成 REST 網址）；kind=verify 的 `current`。
 * 純函式 shape*（可測）＋ fetch*（碰 DB）分開。長文字截 500 字並標 truncated:true。
 */

import { createSupabaseIdentityStore, resolvePolitician } from "./politician-identity.ts";
import { identityInputOf } from "./candidate-import.ts";
import { normalizeCorrection } from "./correction.ts";
import { fetchAllRows } from "./fetch-all.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;
import { buildBranchTemplates, buildNoChangeTemplate, buildReportTemplate, PAYLOAD_SHAPE, TASK_GUIDANCE } from "./task-guidance.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";

export const POLICY_SIMILARITY_THRESHOLD = 0.6;

export const REST_BASE = "https://wiiqoaytpqvegtknlbue.supabase.co/rest/v1";
export const TEXT_LIMIT = 500;
export const MAX_EXISTING_POLICIES = 30;
/** duplicate_policy：整份清單要給代理看完才判得出重複；全站最長的一份是 25 筆，留一倍餘裕 */
export const MAX_POLICY_DUPE_LIST = 60;
/** 清單裡每筆描述只取開頭：判「是不是同一個承諾」看得到主旨就夠，不必整段 */
export const POLICY_DUPE_DESC_LIMIT = 200;
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
  /** profile_gap：內政部地方公職人員名單上同名同縣市的現職紀錄（照片、機關、職稱、黨籍），沒有就 undefined */
  moi_official?: Obj | null;
  roster?: unknown;
  politician?: Obj | null;
  elections?: Obj[];
  policies?: Obj[];
  policies_total?: number;
  /** duplicate_policy：這個人整份政見清單（含描述開頭），由代理逐組比對有沒有同一個承諾被記成兩筆 */
  /** policy_missing：這個人還在等票的政見提交（避免重複查同一件事） */
  queued_policies?: Obj[];
  policy?: Obj | null;
  tracking_logs?: Obj[];
  politician_election?: Obj | null;
  /** adjudicate：被裁決的貢獻、它的所有票、未定案的裁決數 */
  contribution?: Obj | null;
  votes?: Obj[];
  pending_adjudications?: number;
  /** legacy_audit：系統對這筆政見來源的逐欄核對（jev_decisions policy／source_support），沒有就 null */
  system_check?: Obj | null;
  /** duplicate_politician：兩筆人物各自的全欄、參選紀錄、政見標題；pair_verdict 是 Jev 的 same_person 判定 */
  pair?: { a: Obj | null; b: Obj | null; a_elections: Obj[]; b_elections: Obj[]; a_policies: Obj[]; b_policies: Obj[]; verdict: Obj | null };
  /** question：這一題本身（citizen_questions 一列） */
  question?: Obj | null;
  /** question：已經有哪些代理答過、答了什麼（citizen_questions.id = target.question_id） */
  question_answers?: Obj[];
}

const POLITICIAN_BRIEF = ["id", "name", "party", "region", "election_type", "current_position", "birth_year"] as const;
const PROFILE_FIELDS = ["birth_year", "current_position", "avatar_url", "education_level", "bio", "sub_region"] as const;

function pick(row: Obj | null | undefined, keys: readonly string[]): Obj | null {
  if (!row) return null;
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
}

/**
 * 任何一種任務最後都可能以 no_change 收尾，而 outcome 從 2026-09-21 起是必填的
 * （沒填會被 schema 擋下 400）。十幾條任務敘述散在 SQL 與這支檔案裡，逐條補字遲早漏一條，
 * 所以改成每個任務的 current 都帶著這份說明——代理讀 item 就看得到，不必回頭翻協議。
 * 現場實例：legacy_audit 的提示還停在「都對 → no_change」，照它送會被 400 擋。
 */
export const NO_CHANGE_OUTCOMES_HINT = {
  confirmed: "你打開了來源，來源支持這筆資料、內容無誤（只有這個值會把資料標成已核對）",
  unreachable: "拿不到來源內容：打不開、逾時、付費牆、或被導去不相干的頁面。填之前至少試過瀏覽器 UA、站內搜尋／另一家媒體、web.archive.org（遇 429 要退避重試）",
  not_found: "查了，公開資料找不到：找不到這項東西，或找不到任何能證明這筆宣稱的來源",
  _note: "來源打得開、主題也相關、但那一頁沒寫到這筆宣稱 → 先找真出處，找到用 correction 換 source_url，確實找不到才 no_change + not_found。來源與資料矛盾 → correction 或 removal，不要回 no_change",
} as const;

/** 純函式：依 task_type 組 current（尾端統一補上 no_change 的 outcome 說明） */
export function shapeTaskCurrent(
  taskType: string,
  data: TaskContextData,
  task?: { task_id?: string | null; target?: unknown },
): Obj {
  const inner = shapeTaskCurrentInner(taskType, data);
  // 「這一種任務怎麼做」隨任務送出（2026-09-21）：代理只做眼前這一筆，不該先讀一份 20 種型別的目錄。
  // 依當筆資料而變的 hint 由上面各 case 自己組，組過的就不要覆蓋。
  const hint = inner.hint ?? TASK_GUIDANCE[taskType];
  // 回報的 payload 形狀也跟著送：任務說「用 correction 回報」卻不說 correction 長什麼樣，
  // 代理只能回頭翻協議或用猜的，猜錯就是一次 400、查證的工白做（2026-09-21 現場回報）。
  const suggested = SUGGESTED_TYPE[taskType] ?? "";
  const shape = PAYLOAD_SHAPE[suggested];
  // 骨架把已知的 id 先填好。candidate_status_stale 要改 politician_elections 的某一列卻沒給
  // 那一列的 id，代理只能猜複合鍵——那個 id 其實一直在 task_id 裡（2026-09-21 實測回報）。
  const target = (task?.target && typeof task.target === "object" ? task.target : null) as Obj | null;
  const template = task ? buildReportTemplate(taskType, suggested, target, task.task_id) : null;
  return {
    ...inner,
    ...(hint ? { hint } : {}),
    ...(shape ? { payload_shape: shape } : {}),
    ...(template ? { report_template: template } : {}),
    // 查不到東西那一條路也要有骨架：教了 outcome 三選一卻沒示範怎麼送，
    // 代理會猜成 {"kind":"no_change"} 然後被 400 擋下（2026-09-21 實測）
    ...(task ? { report_template_no_change: buildNoChangeTemplate(task.task_id) } : {}),
    // 多分支任務把每一條路的骨架都送出去：實測發現正確分支常常不是預設那個
    // （legacy_audit 預設 no_change、正確是 correction），代理只好回頭翻 payload_shape——
    // 而整個改動的目的就是讓它不必回頭翻（2026-09-21）
    ...(task ? (() => { const b = buildBranchTemplates(taskType, target, task.task_id); return b ? { report_templates_by_type: b } : {}; })() : {}),
    no_change_outcomes: NO_CHANGE_OUTCOMES_HINT,
  };
}

function shapeTaskCurrentInner(taskType: string, data: TaskContextData): Obj {
  const p = data.politician ?? null;
  switch (taskType) {
    case "policy_missing": {
      const list = (data.policies ?? []).slice(0, MAX_EXISTING_POLICIES).map((x) => pick(x, ["id", "title", "category", "status"]));
      // 已經有人交、還在等票的：交一樣的東西不會加分，看到同一件事請去投它的票
      const queued = (data.queued_policies ?? []).map((c) => ({
        contribution_id: c.id,
        title: (c.payload && typeof c.payload === "object" ? (c.payload as Obj).title : null) ?? null,
        agent_name: c.agent_name ?? null,
      })).filter((x) => typeof x.title === "string" && x.title.length > 0);
      return {
        politician: p ? { ...pick(p, POLITICIAN_BRIEF), has_avatar: !!p.avatar_url } : null,
        elections: (data.elections ?? []).map((e) => pick(e, ["election_id", "election_type", "candidate_status", "source_note"])),
        existing_policies: list,
        existing_policies_total: data.policies_total ?? (data.policies ?? []).length,
        queued_policies: queued,
        queued_policies_note: queued.length > 0
          ? `已經有 ${queued.length} 筆在等票，內容重複的不要再交；找到同一件事請改去投那一筆的票。`
          : null,
      };
    }
    case "policy_validity":
    case "policy_election_missing":
    case "policy_election_mismatch":
    case "progress_stale":
    case "policy_source_missing": {
      const policy = data.policy ? truncateFields(pick(data.policy, ["id", "title", "description", "category", "status", "progress", "source_url", "proposed_date", "last_updated"])!, ["description"]) : null;
      return {
        policy,
        politician: pick(p, POLITICIAN_BRIEF),
        // 競選承諾的 progress_stale 問的是「當選了嗎？兌現了嗎？」，
        // 所以參選紀錄（含 election_result）要一起給，代理不必為此多打一次 API。
        elections: (data.elections ?? []).map((e) => pick(e, ["election_id", "election_type", "candidate_status", "election_result"])),
        recent_tracking_logs: (data.tracking_logs ?? []).slice(0, MAX_TRACKING_LOGS).map((l) => truncateFields(pick(l, ["date", "event", "description", "source_url"])!, ["description"])),
      };
    }
    case "profile_gap": {
      const full = p ? truncateFields(p, ["bio"]) : null;
      const missing = PROFILE_FIELDS.filter((f) => !p || p[f] === null || p[f] === undefined || p[f] === "");
      const present = PROFILE_FIELDS.filter((f) => !missing.includes(f));
      const moi = data.moi_official ? pick(data.moi_official, ["name", "region", "org", "title", "party", "photo_url", "detail_url"]) : null;
      return {
        politician: full, missing_fields: missing, present_fields: present,
        ...(moi ? {
          official_record: moi,
          official_record_hint: "內政部地方公職人員名單上有同縣市、同名的現職紀錄。先打開 detail_url 確認是同一個人（機關、職稱對得上）；是的話，照片可用 photo_url、黨籍與現職照這份官方資料補，source_urls 放 detail_url。不是同一人就忽略這份。",
        } : {}),
      };
    }
    case "candidacy_source_missing":
    case "election_result_missing":
      return { politician_election: data.politician_election ?? null, politician: pick(p, POLITICIAN_BRIEF) };
    case "roster_check": {
      const r = (data.roster ?? null) as { rows?: Obj[]; history?: Obj[]; region?: string } | null;
      // politician_elections 的 join 會把人物包在 politicians 裡，攤平成代理好比對的樣子
      const ours = (r?.rows ?? []).map((row) => {
        const who = (row.politicians ?? {}) as Obj;
        return { name: who.name, party: who.party, region: r?.region ?? who.region, candidate_status: row.candidate_status, position: row.position };
      });
      return {
        region: r?.region ?? null,
        ours_count: ours.length,
        ours,
        previous_checks: r?.history ?? [],
        hint: "照任務敘述所說的階段去找名單（登記階段看該縣市選委會的登記公告或媒體整理的登記名單，審定公告後才看中選會），把名單全部列出來跟 ours 逐一比對。名單有、ours 沒有的，每一位用 candidacy 補一筆，附你查的那份名單網址；最後用 roster_check 回報這次清查。名字相同不代表同一人，比對時連政黨與選區一起看。",
      };
    }
    case "question": {
      const q = data.question ?? null;
      return {
        question: q ? truncateFields(pick(q, ["id", "question", "region", "stance_up", "stance_down", "answer_count"])!, ["question"]) : null,
        // 這題掛在哪個政見／人物：帶標題與姓名，不要只有 uuid，讓代理不用另外查
        policy: data.policy ? pick(data.policy, ["id", "title"]) : null,
        politician: p ? pick(p, ["id", "name"]) : null,
        // 已經有哪些代理答過、答了什麼：新代理不要重複同一個角度，該補不同角度或指出前一份的錯誤
        existing_answers: (data.question_answers ?? []).map((a) => truncateFields(pick(a, ["agent_name", "answer", "source_urls", "created_at"])!, ["answer"])),
        hint: q && (q.answer_count as number) > 0
          ? "已經有代理答過：看 existing_answers 的角度，答一樣的沒有加分，請補不同面向或指出前一份哪裡查證不足／有誤"
          : "還沒有人答過，找有出處的答案（政府網頁、新聞、候選人官方發言優先）",
      };
    }
    case "legacy_audit": {
      const policy = data.policy ? truncateFields(pick(data.policy, ["id", "title", "description", "category", "status", "source_url", "election_id", "proposed_date"])!, ["description"]) : null;
      return {
        policy,
        politician: pick(p, POLITICIAN_BRIEF),
        elections: (data.elections ?? []).map((e) => pick(e, ["election_id", "election_type", "candidate_status", "election_result"])),
        system_check: data.system_check ?? null,
        hint: "打開 policy.source_url：這是不是這個人說過的承諾、標題與內容對不對、是哪一場選舉的。都對 → no_change 且 outcome=confirmed（note 寫你核對到什麼，只有 confirmed 會把這筆標成已核對）；來源拿不到 → no_change 且 outcome=unreachable（不會標成已核對，過幾天換人再試）；來源打得開卻沒寫到這筆政見 → 先找真出處，找到用 correction 換 source_url、找不到才 no_change + not_found；欄位錯 → correction；不是政見 → removal。**每一個網址都要打開**，同批匯入的政見會互相借錯連結。system_check 是系統逐欄核對的結果，contradicted 的欄位優先看；它判 cannot_tell 是「系統看不出來」，不是背書。",
      };
    }
    case "duplicate_policy": {
      // 系統配不出「哪兩筆重複」（實測：真重複那對的字面相似度比不重複的那對還低），
      // 所以這裡不挑配對，整份清單交給代理判。它要回報比對過哪幾組，不能只給結論。
      const list = (data.policies ?? []).slice(0, MAX_POLICY_DUPE_LIST).map((x) => {
        const row = pick(x, ["id", "title", "description", "category", "status", "election_id", "proposed_date", "source_url", "ai_extracted"])!;
        const d = truncateText(row.description, POLICY_DUPE_DESC_LIMIT);
        return d.truncated ? { ...row, description: d.text, truncated: true } : row;
      });
      // 同一個 source_url 的先分好組給它看（selkie 2026-09-21：判掉的假重複全是「同一篇報導、
      // 不同標的」＝同場發表的 N 大政見）。我們沒有 source_title／發布日欄位，但「同一篇」
      // 光靠網址相同就判得出來，不必加欄位、也不必叫代理自己比對 60 條網址。
      const bySource = new Map<string, string[]>();
      for (const row of list) {
        const url = typeof row.source_url === "string" ? row.source_url.trim() : "";
        if (!url) continue;
        bySource.set(url, [...(bySource.get(url) ?? []), String(row.id)]);
      }
      const sameSource = [...bySource.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([source_url, policy_ids]) => ({ source_url, policy_ids }));
      return {
        politician: pick(p, POLITICIAN_BRIEF),
        policies: list,
        policies_total: data.policies_total ?? list.length,
        same_source_groups: sameSource,
        same_source_note: sameSource.length > 0
          ? "這幾組出自同一個網址，多半是同一場發表的「N 大政見」被正確拆成 N 筆——標的不同就不是重複，別急著退。"
          : null,
        hint: "逐組比對這份清單。**先看 source_url**：同一篇報導拆出來的多筆，標的不同（不同醫院、不同路線、不同補助對象）就不是重複（見 same_source_groups）。換句話說講同一件事才是重複——空泛的一筆碰上具體的一筆而且講同一件事，保留具體那筆、對空泛那筆提 removal，reason 寫「與 <保留的 policy_id> 是同一個承諾」；具體資訊只在要移除的那筆才有就先用 correction 補過去。ai_extracted=true 表示這筆是早期 AI 匯入的，來源掛錯的比率偏高，判之前先打開它的 source_url 確認那一頁真的講了這筆政見。沒有重複就用 no_change（outcome=confirmed）帶 task_id，note 列出你比對過哪幾組。",
      };
    }
    case "duplicate_politician": {
      const pr = data.pair;
      const side = (who: Obj | null, elections: Obj[], policies: Obj[]) => ({
        politician: who ? truncateFields(who, ["bio"]) : null,
        elections: elections.map((e) => pick(e, ["election_id", "election_type", "candidate_status", "election_result", "position", "source_note"])),
        policies: policies.slice(0, 10).map((x) => pick(x, ["id", "title", "election_id", "status"])),
        policies_total: policies.length,
      });
      return {
        a: side(pr?.a ?? null, pr?.a_elections ?? [], pr?.a_policies ?? []),
        b: side(pr?.b ?? null, pr?.b_elections ?? [], pr?.b_policies ?? []),
        system_vote: pr?.verdict ?? null,
        hint: "同名不代表同一人：連政黨、縣市／選區、出生年、歷屆參選一起看。中選會歷屆參選查詢會把同一人列在同一筆。是同一人就 merge_politician same_person=true，keep_id 選資料較完整、參選紀錄較多的那筆；不是就 same_person=false。兩種都附 reason（≥20 字）與你查的網址。",
      };
    }
    case "adjudicate": {
      const c = data.contribution ?? null;
      return {
        contribution: c
          ? { ...pick(c, ["id", "contribution_type", "status", "agent_name", "agent_tool", "source_urls", "note", "agree_count", "disagree_count", "unsure_count", "review_notes", "last_error", "created_at"]), payload: c.payload ?? null }
          : null,
        votes: (data.votes ?? []).map((v) => pick(v, ["verdict", "evidence_url", "note", "agent_name", "resolved_politician_id", "created_at"])),
        pending_adjudications: data.pending_adjudications ?? 0,
        hint: "正方＝contribution.source_urls，反方＝votes 裡 disagree 的 evidence_url／note；都打開、獨立判斷。uphold＝原貢獻正確、reject＝原貢獻有誤；payload 帶 contribution_id、verdict、reason（≥20 字）、checked_urls；身份爭議多帶 resolved_politician_id。你的裁決會再被 3 票驗證才定案。",
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
  // 補基本資料：內政部現職名單有這個人的話一起給（2026-09-24，陳雅倫的照片內政部就有，代理卻回報查無）
  if (taskType === "profile_gap" && pid) {
    const { data: m } = await supabase.rpc("moi_official_for", { p_politician_id: pid });
    data.moi_official = ((m ?? []) as Obj[])[0] ?? null;
  }
  if (taskType === "legacy_audit" && policyId) {
    const [pl, el, jv] = await Promise.all([
      supabase.from("policies").select("*").eq("id", policyId).maybeSingle(),
      pid ? supabase.from("politician_elections").select("election_id, election_type, candidate_status, election_result").eq("politician_id", pid).order("election_id", { ascending: false }).limit(10) : Promise.resolve({ data: [] }),
      supabase.from("jev_decisions").select("choice, probability, probabilities, asked_at").eq("subject_type", "policy").eq("subject_id", policyId).eq("question", "source_support").order("asked_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    data.policy = (pl.data as Obj | null) ?? null;
    data.elections = (el.data ?? []) as Obj[];
    const v = jv.data as { choice?: string; probability?: number; probabilities?: unknown; asked_at?: string } | null;
    data.system_check = v ? { verdict: v.choice, probability: Number(v.probability), fields: v.probabilities ?? null, checked_at: v.asked_at } : null;
  }
  if (taskType === "duplicate_politician") {
    const a = (target.a && typeof target.a === "object" ? (target.a as Obj).id : null) as string | null;
    const b = (target.b && typeof target.b === "object" ? (target.b as Obj).id : null) as string | null;
    if (a && b) {
      const pairKey = [a, b].sort().join("|");
      const [pa, pb, ea, eb, la, lb, jv] = await Promise.all([
        supabase.from("politicians").select("*").eq("id", a).maybeSingle(),
        supabase.from("politicians").select("*").eq("id", b).maybeSingle(),
        supabase.from("politician_elections").select("election_id, election_type, candidate_status, election_result, position, source_note").eq("politician_id", a).order("election_id", { ascending: false }).limit(20),
        supabase.from("politician_elections").select("election_id, election_type, candidate_status, election_result, position, source_note").eq("politician_id", b).order("election_id", { ascending: false }).limit(20),
        supabase.from("policies").select("id, title, election_id, status").eq("politician_id", a).is("removed_at", null).order("proposed_date", { ascending: false }).limit(50),
        supabase.from("policies").select("id, title, election_id, status").eq("politician_id", b).is("removed_at", null).order("proposed_date", { ascending: false }).limit(50),
        supabase.from("jev_decisions").select("choice, probability, asked_at").eq("subject_type", "politician_pair").eq("subject_id", pairKey).eq("question", "same_person").order("asked_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const v = jv.data as { choice?: string; probability?: number } | null;
      data.pair = {
        a: (pa.data as Obj | null) ?? null, b: (pb.data as Obj | null) ?? null,
        a_elections: (ea.data ?? []) as Obj[], b_elections: (eb.data ?? []) as Obj[],
        a_policies: (la.data ?? []) as Obj[], b_policies: (lb.data ?? []) as Obj[],
        verdict: v ? { verdict: v.choice === "same" ? "same_person" : v.choice === "diff" ? "different_person" : v.choice, probability: Number(v.probability) } : null,
      };
    }
  }
  if (taskType === "roster_check") {
    // 把「我們現有的名單」直接給代理。它的工作是跟中選會比對，
    // 沒必要為了知道我們有誰而多打幾次 API，也避免它查錯範圍。
    const electionId = typeof target.election_id === "number" ? target.election_id : null;
    const region = typeof target.region === "string" ? target.region : null;
    const electionType = typeof target.election_type === "string" ? target.election_type : null;
    if (electionId && region && electionType) {
      // 縣市怎麼算跟 SQL 的 ours 一模一樣：COALESCE(參選紀錄選區所屬縣市, 人物的縣市)。
      // 原本撈全國同類選舉前 300 筆再在這裡篩縣市——縣市議員全國上千人，目標縣市的人
      // 可能根本不在那 300 筆裡，代理會以為我們缺人而重複補（2026-09-18）。
      // 拆兩段在資料庫篩：有選區的看選區、沒選區的看人物；各自翻頁撈完。
      const base = "candidate_status, position, region_id";
      const [byDistrict, byPerson, history] = await Promise.all([
        fetchAllRows<Obj>("roster ours by district", (from, to) => supabase.from("politician_elections")
          .select(`${base}, regions!inner(region), politicians!inner(id, name, party, region)`)
          .eq("election_id", electionId).eq("election_type", electionType)
          .neq("candidate_status", "not_running").eq("regions.region", region)
          .order("politician_id", { ascending: true }).range(from, to)),
        fetchAllRows<Obj>("roster ours by person", (from, to) => supabase.from("politician_elections")
          .select(`${base}, politicians!inner(id, name, party, region)`)
          .eq("election_id", electionId).eq("election_type", electionType)
          .neq("candidate_status", "not_running").is("region_id", null).eq("politicians.region", region)
          .order("politician_id", { ascending: true }).range(from, to)),
        supabase.from("roster_checks")
          .select("checked_at, cec_count, ours_count, submitted, agent_name, source_url")
          .eq("election_id", electionId).eq("region", region).eq("election_type", electionType)
          .order("checked_at", { ascending: false }).limit(3),
      ]);
      data.roster = { rows: [...byDistrict, ...byPerson], history: history.data ?? [], region };
    }
  }
  if (taskType === "duplicate_policy" && pid) {
    const { data: pol, count } = await supabase.from("policies")
      .select("id, title, description, category, status, election_id, proposed_date, source_url, ai_extracted", { count: "exact" })
      .eq("politician_id", pid).is("removed_at", null)
      .order("proposed_date", { ascending: false, nullsFirst: false }).order("id", { ascending: true })
      .limit(MAX_POLICY_DUPE_LIST);
    data.policies = pol ?? [];
    data.policies_total = count ?? (data.policies ?? []).length;
  }
  if (taskType === "policy_missing" && pid) {
    const [el, pol, queued] = await Promise.all([
      supabase.from("politician_elections").select("election_id, election_type, candidate_status, source_note").eq("politician_id", pid).order("election_id", { ascending: false }),
      supabase.from("policies").select("id, title, category, status", { count: "exact" }).eq("politician_id", pid).is("removed_at", null).order("proposed_date", { ascending: false }).limit(MAX_EXISTING_POLICIES),
      // 還在等票的提交也要給代理看見（2026-09-17：「輪到這種任務時，要先問是不是
      // 已經有類似的政見了」）。只列已上線的害慘了李四川：21 筆等票的沒被列出來，
      // 代理看不到「居住新五箭」已經交過三次，於是交了第四次。
      supabase.from("contributions").select("id, payload, agent_name")
        .eq("contribution_type", "policy").in("status", ["pending", "verified"])
        .eq("payload->>politician_id", pid).order("created_at", { ascending: false }).limit(MAX_EXISTING_POLICIES),
    ]);
    data.elections = el.data ?? [];
    data.policies = pol.data ?? [];
    data.policies_total = pol.count ?? (data.policies ?? []).length;
    data.queued_policies = queued.data ?? [];
  }
  if ((taskType === "progress_stale" || taskType === "policy_source_missing" || taskType === "policy_validity" || taskType === "policy_election_missing" || taskType === "policy_election_mismatch") && policyId) {
    const [pl, logs] = await Promise.all([
      supabase.from("policies").select("*").eq("id", policyId).maybeSingle(),
      supabase.from("tracking_logs").select("date, event, description, source_url").eq("policy_id", policyId).order("date", { ascending: false }).limit(MAX_TRACKING_LOGS),
    ]);
    data.policy = pl.data ?? null;
    data.tracking_logs = logs.data ?? [];
  }
  // 承諾類的 progress_stale 要先判斷當選與否，把這個人的參選紀錄一起帶上
  if (taskType === "progress_stale" && pid) {
    const { data: el } = await supabase.from("politician_elections")
      .select("election_id, election_type, candidate_status, election_result")
      .eq("politician_id", pid).order("election_id", { ascending: false });
    data.elections = el ?? [];
  }
  if ((taskType === "candidacy_source_missing" || taskType === "election_result_missing") && pid) {
    const electionId = typeof target.election_id === "number" ? target.election_id : 2026;
    const { data: pe } = await supabase.from("politician_elections").select("*").eq("politician_id", pid).eq("election_id", electionId).maybeSingle();
    data.politician_election = pe ?? null;
  }
  if (taskType === "question" && typeof target.question_id === "string") {
    const questionId = target.question_id;
    const { data: q } = await supabase.from("citizen_questions").select("*").eq("id", questionId).maybeSingle();
    data.question = q ?? null;
    // question 的 target 不一定帶 politician_id／policy_id（ask 端點是照提問當下的欄位存的），
    // 這題本身掛的 policy_id 才是最新真相，query 一次現成的 policy 標題附上
    const linkedPolicyId = policyId ?? (typeof q?.policy_id === "string" ? q.policy_id : null);
    if (linkedPolicyId) {
      const { data: pl } = await supabase.from("policies").select("id, title").eq("id", linkedPolicyId).maybeSingle();
      data.policy = pl ?? null;
    }
    const questionPid = pid ?? (typeof q?.politician_id === "string" ? q.politician_id : null);
    if (questionPid && !data.politician) {
      const { data: pol } = await supabase.from("politicians").select("*").eq("id", questionPid).maybeSingle();
      data.politician = pol ?? null;
    }
    const { data: answers } = await supabase.from("question_answers").select("agent_name, answer, source_urls, created_at").eq("question_id", questionId).order("created_at", { ascending: true });
    data.question_answers = answers ?? [];
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
  /** merge_politician：跟 duplicate_politician 任務同一份 current（兩筆全欄、參選、政見、Jev 判定） */
  pair_current?: Obj | null;
  /** adjudication：跟 adjudicate 任務同一份 current（原貢獻＋正反票） */
  adjudicate_current?: Obj | null;
  /** no_change：這筆回報的是哪個任務（手動任務的標題與敘述；auto 任務拆出型別與目標） */
  task?: Obj | null;
  /** 派工池（contribution_verify_pool）回的目前分數／目標分數（2026-09-21 票數→分數）；兩者都是數字才附 scoring，缺一就不附（呼叫端沒傳，或池子還沒上這個欄位） */
  score?: number | null;
  target_score?: number | null;
  /** 這筆既有的票（去識別）：後到的驗證者要看得到前一張反對票的理由與反證，不然只能從頭重查（#7，實例 bd3fedaf 林鑫一） */
  votes?: Array<{ verdict: string; weight?: number | null; note?: string | null; evidence_url?: string | null; created_at?: string | null }>;
  /** 提交者附的來源網址；shapeVerifyCurrent 用它算按網域的 source_hints（#4） */
  source_urls?: string[] | null;
}

/**
 * 按網域的查證提示（#4，2026-09-21）。任務側的 hint_sources 傳不到驗證側，沒被特別交代過的代理
 * 碰到中選會登記頁只看到「這頁只有連結」就卡住。資訊系統早就知道，只是沒送到代理手上。
 */
export const SOURCE_HINTS: ReadonlyArray<{ host: RegExp; hint: string }> = [
  { host: /(^|\.)web\.cec\.gov\.tw$/, hint: "中選會登記公告：名單在頁面的 PDF 附件裡（候選人登記情形一覽表），系統不解析 PDF，你要自己下載讀。逐欄印的名冊不要用 pdftotext -layout（會錯配），各欄各抓成清單再 zip，三欄長度要相等。" },
  { host: /(^|\.)bulletin\.cec\.gov\.tw$/, hint: "中選會選舉公報：PDF，政見常做成圖，pdftotext 抽到空字串不代表沒有——裁切渲染成圖目視核對。" },
  { host: /(^|\.)db\.cec\.gov\.tw$/, hint: "中選會候選人資料庫：頁面是 SPA、抓不到正文；直接用 API `/query/api/v1/elections/candidates/query?cand_name=<姓名>`——它證明「這個人是誰」（出生年、歷屆），證明不了「本屆有沒有登記」（只有已投票的選舉，2026 登記期不在裡面）；系統核到 election_id／candidate_status absent 回 cannot_tell 是對的。" },
  { host: /(^|\.)cna\.com\.tw$/, hint: "中央社：不帶瀏覽器 User-Agent 會 403，帶了就 200。" },
  { host: /(^|\.)chinatimes\.com$/, hint: "中時：Cloudflare 擋程式，帶 UA 仍常 403；改抓 web.archive.org/web/2026/<網址> 的快照。" },
  { host: /(^|\.)upmedia\.mg$/, hint: "上報：常 403；改抓 archive.org 快照。" },
  { host: /(^|\.)udn\.com$/, hint: "聯合：舊文常 404（真的下架了，不是擋你）；archive.org 通常有。" },
];

export function sourceHintsFor(urls: ReadonlyArray<string> | null | undefined): Array<{ url: string; hint: string }> {
  const out: Array<{ url: string; hint: string }> = [];
  for (const u of urls ?? []) {
    let host = "";
    try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
    const m = SOURCE_HINTS.find((h) => h.host.test(host));
    if (m) out.push({ url: u, hint: m.hint });
  }
  return out;
}

/** 既有票去識別：只留判斷需要的（verdict／分數／理由／反證／時間），不留代號與 IP */
export function shapeVotes(votes: VerifyContextData["votes"]): Array<Record<string, unknown>> {
  return (votes ?? []).map((v) => ({
    verdict: v.verdict,
    ...(typeof v.weight === "number" ? { weight: v.weight } : {}),
    ...(v.note ? { note: String(v.note).slice(0, 500) } : {}),
    ...(v.evidence_url ? { evidence_url: v.evidence_url } : {}),
    ...(v.created_at ? { at: v.created_at } : {}),
  }));
}

/**
 * 候選人「為什麼被列進來」（#8，2026-09-21）。金門那批 11 筆同名衝突：清單只給了縣市欄位，代理用地理常識
 * 否決了本人；如果當時帶著「同出生年、2022 第01選舉區當選」，就不會。這裡只講事實，不下結論。
 */
export function candidateReasons(candidate: Obj, payload: Obj, elections: ReadonlyArray<Obj>): string[] {
  const why: string[] = [];
  const same = (a: unknown, b: unknown) => a !== undefined && a !== null && b !== undefined && b !== null && String(a).trim() !== "" && String(a).trim() === String(b).trim();
  if (same(candidate.name, payload.name)) why.push("同名");
  if (same(candidate.birth_year, payload.birth_year)) why.push(`同出生年 ${candidate.birth_year}`);
  else if (candidate.birth_year && payload.birth_year) why.push(`出生年不同（清單 ${candidate.birth_year}／提交 ${payload.birth_year}）`);
  if (same(candidate.party, payload.party)) why.push(`同政黨 ${candidate.party}`);
  if (same(candidate.region, payload.region)) why.push(`同縣市 ${candidate.region}`);
  else if (candidate.region && payload.region) why.push(`縣市不同（清單 ${candidate.region}／提交 ${payload.region}）——清單的縣市可能標錯，以中選會 API 為準`);
  const mine = elections.filter((e) => e.politician_id === candidate.id);
  const sameType = mine.filter((e) => same(e.election_type, payload.election_type));
  if (sameType.length > 0) why.push(`有 ${sameType.map((e) => `${e.election_id} ${e.election_type}（${e.candidate_status}）`).join("、")} 的紀錄`);
  if (candidate.current_position) why.push(`現職 ${candidate.current_position}`);
  return why;
}

/** 一票最多能加幾分、怎麼拿到滿分：給 shapeVerifyCurrent 的 scoring 區塊用 */
const VOTE_SCORE_GUIDE = {
  max: 2,
  how: "同意票預設要找第二來源：item.source_urls 是提交者附的，加分看的是你這票的 evidence_url——另一個網域、直接寫到當事人與這件事的來源，系統核過就是 +2；只打開提交者的來源核對是 +1。提交者附的同一個網域不算第二來源",
} as const;

/**
 * 這筆還差幾分、你這票能不能讓它上線（2026-09-23 小良哥：驗票儘量要求第二來源）。
 * 48 小時內只有 4 台機器在投票、一台一筆最多 +2、目標 3——+1 的票要三台全到，+2 的票兩台就夠，
 * 系統票把目標降到 2 時一張 +2 就夠。把這個算術當場講給代理聽，它才知道多花幾分鐘找第二來源值得。
 */
/** 提交者附的來源網域（去 www.、去重）：放進 evidence_url 不算第二來源 */
export function submittedDomains(sourceUrls: readonly string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const u of sourceUrls ?? []) {
    try { out.add(new URL(u).hostname.replace(/^www\./, "").toLowerCase()); } catch { /* 不是網址就略過 */ }
  }
  return [...out];
}

/**
 * 系統會核第二來源（evidence_url）的型別；其他型別附了也只算 +1（evidence_verdict=not_eligible）。
 * system-one 的 evidence／judge 用同一份。2026-09-24 實測：40 張附了 evidence_url 的票有 32 張投在
 * no_change／removal 上，全部白找（leatherback 經工頭轉：該在驗證項上直接講）。
 */
export const SECOND_SOURCE_TYPES: readonly string[] = ["policy", "candidacy", "politician", "correction", "policy_progress"];
export const secondSourceCounts = (contributionType?: string) => !contributionType || SECOND_SOURCE_TYPES.includes(contributionType);

export function scoringHint(score: number, target: number, contributionType?: string): { points_short: number; hint: string } {
  const short = Math.max(0, target - score);
  if (short === 0) return { points_short: 0, hint: "已達目標分數，等系統落庫" };
  if (!secondSourceCounts(contributionType)) {
    return { points_short: short, hint: `這筆差 ${short} 分。這種型別系統不核第二來源，附 evidence_url 也只算 +1——核對無誤投 +1 就是正常的一票，不用另外找來源` };
  }
  // 參選紀錄（2026-09-23 實測）：「附第二來源」推下去，代理拿中選會公告頁當第二來源——名單在附檔 PDF、頁面本身沒有姓名，
  // 系統核不了（no_subject 31 張裡 28 張是這種）。協議 §6 本來就寫登記期參選紀錄 +1 是正常的一票，不要讓提示跟它打架。
  if (contributionType === "candidacy") {
    return { points_short: short, hint: `這筆差 ${short} 分。參選紀錄的官方名冊多半是 PDF，系統核不了——你打開名冊逐欄核對無誤投 +1 就是正常的一票，不用為了 +2 硬找（中選會公告頁的姓名在附檔裡，當第二來源會被判「頁面沒有當事人」）；另一家媒體的登記報導寫到這個人，才值得附` };
  }
  if (short === 1) return { points_short: 1, hint: "這筆只差 1 分：你核對無誤投 agree（+1）就能讓它上線；附第二來源更穩" };
  if (short === 2) return { points_short: 2, hint: "這筆差 2 分：你附一個不同網域、系統核得過的第二來源（+2），這一票就能讓它上線；只投 +1 還要再等一台機器" };
  return { points_short: short, hint: `這筆差 ${short} 分：附第二來源（+2）能讓它少等一台機器；只投 +1 要再多兩台` };
}

const IDENTITY_HINT = {
  matched: "系統比對到唯一一位（identity.politician_id）；核對來源後 agree 即可，不用帶 resolved_politician_id",
  new: "系統找不到同一人，通過後會建新人物；若你認為其實是 identity_candidates 裡的某位，agree 時帶 resolved_politician_id（連同 cec_hits／cec_people，見 §2 第 11 條第 5 步）",
  ambiguous: "同名多位、系統判不出：核對來源後投 agree 時**必須帶 resolved_politician_id**（identity_candidates 之一的 id；都不是就填 \"new\" 建新人物）；通過時採用 agree 票裡帶的指認（目前一票指認即採用，所以請確定你指的是對的人）；指認不一致（含 new 與某人混）或都沒指認 → 這筆退件、缺口回到任務佇列重做（2026-09-21 起沒有裁決）。判斷方法見協議 §2 第 11 條：先用中選會 API 以出生年收斂同名者，再看這次提交跟哪一位相容；查無不是新人的證據。帶指認的 agree 要一併帶 cec_hits（中選會查這個姓名回幾筆）與 cec_people（依出生年收斂成幾人），伺服器會當場核 cec_hits（1.29.0）",
} as const;

/**
 * 純函式：依 contribution_type 組驗證用的 current。
 * scoring 區塊只在呼叫端傳了 score／target_score 兩個數字才附上（見 VerifyContextData 的說明）：
 * 派工池還沒上這兩欄、或這條路徑沒有分數概念（如 no_change）時，缺一律不附，不要印出 undefined／null 的分數騙代理。
 */
export function shapeVerifyCurrent(contributionType: string, payload: Obj, data: VerifyContextData): Obj {
  let out = shapeVerifyCurrentInner(contributionType, payload, data);
  if (typeof data.score === "number" && typeof data.target_score === "number") {
    out = {
      ...out,
      scoring: {
        target_score: data.target_score,
        current_score: data.score,
        ...scoringHint(data.score, data.target_score, contributionType),
        // 把系統知道、代理不知道的事先講出來（2026-09-23 leatherback-ec）：這些網域是提交者的，放進 evidence_url 會被判 same_source、不加分
        ...(submittedDomains(data.source_urls).length > 0 && secondSourceCounts(contributionType) ? { not_a_second_source: submittedDomains(data.source_urls) } : {}),
        second_source_counts: secondSourceCounts(contributionType),
        your_vote_could_be: secondSourceCounts(contributionType) ? VOTE_SCORE_GUIDE : { max: 1, how: "這種型別系統不核第二來源：打開提交者附的來源逐欄核對過、投 agree 就是 +1（附 evidence_url 也不會變 +2）" },
      },
    };
  }
  // #7：既有票公開（去識別）。看得到前一張反對票的理由，後到的人才能針對爭點查、也才看得出盲反對。
  if (data.votes && data.votes.length > 0) out = { ...out, votes: shapeVotes(data.votes) };
  // #4：按網域的查證提示
  const hints = sourceHintsFor(data.source_urls);
  if (hints.length > 0) out = { ...out, source_hints: hints };
  return out;
}

function shapeVerifyCurrentInner(contributionType: string, payload: Obj, data: VerifyContextData): Obj {
  switch (contributionType) {
    case "politician":
    case "candidacy": {
      const elections = (data.elections ?? []).map((e) => pick(e, ["politician_id", "election_id", "election_type", "candidate_status", "source_note"]));
      const candidates = (data.politicians ?? []).map((p) => ({
        ...pick(p, POLITICIAN_BRIEF),
        has_avatar: !!p.avatar_url,
        elections: elections.filter((e) => e?.politician_id === p.id).map((e) => `${e?.election_id} ${e?.election_type}（${e?.candidate_status}）`),
        // #8：為什麼被列進來——只講事實（同名／同出生年／同縣市／有哪一屆的紀錄），結論由你下
        why: candidateReasons(p, payload, (data.elections ?? []) as Obj[]),
      }));
      const decision = data.identity?.decision ?? null;
      return {
        identity: data.identity ? { decision: data.identity.decision, politician_id: data.identity.politician_id ?? null, reason: data.identity.reason } : null,
        identity_pick_required: decision === "ambiguous",
        identity_candidates: candidates,
        matching_politicians: candidates.map(({ elections: _e, ...rest }) => rest),
        elections,
        hint: (decision && decision in IDENTITY_HINT ? IDENTITY_HINT[decision as keyof typeof IDENTITY_HINT] : "同名多位時，用 payload 的政黨／縣市／現職／出生年判斷是不是同一人") +
          "；candidacy 要看該人是否已有這場選舉的紀錄。逐欄核對來源後投 agree／disagree（附 evidence_url 與 note）／unsure",
      };
    }
    case "policy":
      return {
        politician: pick(data.politicians?.[0] ?? null, POLITICIAN_BRIEF),
        existing_policy_titles: (data.policies ?? []).slice(0, MAX_EXISTING_POLICIES).map((x) => pick(x, ["id", "title", "category", "status"])),
        similar_policies: (data.similar_policies ?? []).map((s) => ({ id: s.id, title: s.title, similarity: Math.round(s.similarity * 100) / 100 })),
        hint: "先看重複：similar_policies 是系統用**字面**相似度撈的，中文換句話說的重複它抓不到（實測「加速都市更新」與「都更5夠力」的字面相似度低於兩筆不重複的政見），所以請把 existing_policy_titles 整份看過再判斷。與其中一條實質重複（同一承諾換句話說）就投 disagree 並在 note 寫「重複於 <policy_id>」；只是主題相近、標的不同（不同醫院、不同路線）就照來源核對。先確認來源證明的是這個人、年份與職權都對得上：主題相符的政府網頁不等於這位候選人的政見，把他人或前任的政績當成這位的政見來源要投 disagree",
      };
    case "policy_progress":
      return {
        policy: data.policy ? truncateFields(pick(data.policy, ["id", "title", "status", "progress", "last_updated", "source_url", "description"])!, ["description"]) : null,
        recent_tracking_logs: (data.tracking_logs ?? []).slice(0, MAX_TRACKING_LOGS).map((l) => truncateFields(pick(l, ["date", "event", "description", "source_url"])!, ["description"])),
        hint: "先確認來源證明的是這個人、年份與職權都對得上：施政成果要能歸屬到該政見主體本人任內、其職權範圍內，別人或前任做的同主題事情不算，對不上就投 disagree",
      };
    case "correction": {
      // 多欄位：每個 change 都附資料庫現值；第一個欄位另放在 field／current_value 維持相容
      const { changes } = normalizeCorrection(payload);
      const withCurrent = changes.map((c) => ({ field: c.field, claimed_current: c.current_value ?? null, db_current: data.target ? (data.target[c.field] ?? null) : null, correct_value: c.correct_value }));
      return {
        target_table: payload.target_table ?? null,
        target_id: payload.target_id ?? null,
        field: withCurrent[0]?.field ?? "",
        current_value: withCurrent[0]?.db_current ?? null,
        changes: withCurrent,
        target: data.target ? truncateFields(data.target, ["description", "bio"]) : null,
        hint: "逐欄核對：db_current 是資料庫現值、correct_value 是提交者主張的正確值；每個欄位都要在來源找得到才 agree，任一欄對不上就 disagree 並指出是哪一欄",
      };
    }
    // 2026-09-20 審查建議 5：這幾種型別的驗證項原本只有 payload，驗證者只能照 reason 投
    case "merge_politician": {
      // 跟 adjudication 同一個形狀：pair_current 是任務端的 current，它的 hint 寫給
      // 「要提交一份合併」的人看（「是同一人就 same_person=true」），驗證回合照抄的話，
      // 等於教投票的人去交一筆新貢獻。2026-09-21 把驗證守門測試的取樣擴大後掃出來的第二處。
      if (!data.pair_current) return { hint: "找不到那兩筆人物（可能已合併或不存在）：投 unsure" };
      const { hint: _submitHint, ...rest } = data.pair_current as Obj;
      return {
        ...rest,
        hint: "你要判的是**提交者的結論站不站得住**，不是自己重判一次：payload 的 same_person 是 true（同一人、通過後會軟合併）還是 false（不同人、這一對之後不再派）。" +
          "打開它附的 source_urls，看那份中選會或官方名單能不能支持這個結論；a／b 兩邊的政黨、縣市、出生年、歷屆參選也一起對。" +
          "**合併沒有便宜的回頭路**，判 same_person=true 的要特別嚴：同名同縣市不等於同一人。" +
          "支持就 agree、來源推不出這個結論或與它矛盾就 disagree（附 evidence_url 與 note）、看不出來就 unsure。**你這一票是 agree／disagree／unsure**。",
      };
    }
    case "adjudication": {
      // 任務端的 current（含 hint）是寫給「要提交一份裁決」的人看的——uphold／reject 是那一側的詞彙。
      // 驗證回合要做的事完全不同：對別人交的那份裁決投 agree／disagree／unsure。
      // 2026-09-21 之前這裡直接把任務端的 current 原樣回傳，於是教投票的人送 verdict:"reject"，
      // 被 schema 擋下 400（ballyhoo-4d 的子代理實際撞到）。hint 要換成驗證端的。
      const { hint: _submitHint, ...rest } = (data.adjudicate_current ?? {}) as Obj;
      return {
        ...rest,
        hint: "你要判的是**這份裁決站不站得住**，不是自己重判一次爭議：contribution 是被裁決的原貢獻、votes 是它的正反票，payload.verdict／reason／checked_urls 是裁決者的結論與理由。打開它列的 checked_urls，看理由是否從那些來源推得出來、有沒有漏掉反方的反證。站得住投 agree、推不出來或與來源矛盾投 disagree（附 evidence_url 與 note）、看不出來投 unsure。**你這一票是 agree／disagree／unsure**，uphold／reject 是裁決者提交時用的詞，不要填進 verdict。",
      };
    }
    case "removal":
      return {
        policy: data.policy ? truncateFields(pick(data.policy, ["id", "title", "description", "category", "status", "source_url", "election_id", "proposed_date"])!, ["description"]) : null,
        politician: data.politicians?.[0] ? pick(data.politicians[0], POLITICIAN_BRIEF) : null,
        hint: "看這筆政見的標題與內容：它是不是「當選後要做的具體事情」？口號、行程、表態、團隊組成不是政見 → agree 移除；是政見但只是缺出處 → disagree 並在 note 說應該用 correction 補 source_url",
      };
    case "no_change":
      return { task: data.task ?? null, hint: "看提交者說查了哪些網址、為什麼沒有可交的東西；你自己也查一下，真的沒有就 agree（這筆會讓那個缺口 14 天不再派）" };
    case "question_answer":
      return data.task ?? {};
    default:
      return {};
  }
}

/** 多面向身份比對 dry-run（persist:false，不寫 keys、不寫 reviews）；失敗不影響派工 */
async function dryRunIdentity(supabase: SupabaseLike, payload: Obj, name: string): Promise<VerifyContextData["identity"]> {
  try {
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    // 跟落庫同一份正規化（identityInputOf），派工說不用指認、落庫卻因未指認退件的落差由此而來
    const resolution = await resolvePolitician(createSupabaseIdentityStore(supabase), identityInputOf({
      name,
      party: s(payload.party),
      region: s(payload.region),
      election_type: s(payload.election_type),
      position: s(payload.position),
      current_position: s(payload.current_position),
      birth_year: typeof payload.birth_year === "number" ? payload.birth_year : s(payload.birth_year),
      cec_cand_id: typeof payload.cec_cand_id === "number" ? payload.cec_cand_id : s(payload.cec_cand_id),
      cec_theme_id: s(payload.cec_theme_id),
    }), { persist: false });
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
        supabase.from("policies").select("id, title, category, status").eq("politician_id", ids[0]).is("removed_at", null).limit(MAX_EXISTING_POLICIES),
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
  if (contributionType === "merge_politician") {
    const keep = typeof payload.keep_id === "string" ? payload.keep_id : null, remove = typeof payload.remove_id === "string" ? payload.remove_id : null;
    if (keep && remove) {
      const ctx = await fetchTaskContext(supabase, "duplicate_politician", { a: { id: keep }, b: { id: remove } });
      data.pair_current = ctx.pair?.a && ctx.pair?.b ? shapeTaskCurrent("duplicate_politician", ctx) : null;
    }
  }
  if (contributionType === "adjudication") {
    const cid = typeof payload.contribution_id === "string" ? payload.contribution_id : null;
    if (cid) data.adjudicate_current = shapeTaskCurrent("adjudicate", await fetchTaskContext(supabase, "adjudicate", { contribution_id: cid }));
  }
  if (contributionType === "removal") {
    const id = typeof payload.target_id === "string" ? payload.target_id : null;
    if (id && payload.target_table === "policies") {
      const { data: pl } = await supabase.from("policies").select("*").eq("id", id).maybeSingle();
      data.policy = pl ?? null;
      const pid = (pl as Obj | null)?.politician_id;
      if (typeof pid === "string") {
        const { data: p } = await supabase.from("politicians").select("*").eq("id", pid).maybeSingle();
        data.politicians = p ? [p] : [];
      }
    }
  }
  if (contributionType === "no_change" || contributionType === "question_answer") {
    const taskId = typeof payload.task_id === "string" ? payload.task_id : null;
    const questionId = typeof payload.question_id === "string" ? payload.question_id : null;
    if (questionId) {
      data.task = shapeTaskCurrent("question", await fetchTaskContext(supabase, "question", { question_id: questionId }));
    } else if (taskId?.startsWith("auto:")) {
      const [, taskType, ...rest] = taskId.split(":");
      data.task = { task_id: taskId, task_type: taskType, target_id: rest.join(":"), source: "auto" };
    } else if (taskId) {
      const { data: t } = await supabase.from("contribution_tasks").select("id, task_type, title, description, target, source").eq("id", taskId).maybeSingle();
      data.task = t ? { task_id: taskId, ...pick(t, ["task_type", "title", "description", "target", "source"]) } : { task_id: taskId };
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
