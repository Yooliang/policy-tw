/**
 * Jev 身份檢查的兩道（2026-11-08，維護者小良核准）。
 *
 *   1. 合併身份核對（merge_politician）：兩筆人物是不是同一個人。事實（兩人的基本資料、全部參選紀錄、中選會 2026 名冊的對應列）
 *      放 state，選項放 criteria，一筆貢獻只問一次。
 *   2. 新人物相似度（candidacy／politician 沒帶 politician_id＝會建新人物）：同一場選舉、同選舉類型、同單位裡，已有同名或近名的
 *      人物參選紀錄，或另一筆等票中的交件？問 Jev「是不是其中某一位／都不是／資料不足」。
 *
 * 起因：11-07 兩筆錯的 merge_politician 被驗過（張榮華 三星鄉第02選舉區 #2 vs 羅東鎮第03選舉區 #5；徐進忠 屏東春日 vs 宜蘭三星），
 * 以及同一個人的兩筆 candidacy（都沒帶 politician_id）在等票期間各自落庫成兩個人物（陳麗娟 冬山第04、王國華 南澳第02、楊金源 大同第02、邱德貴 北竿）。
 *
 * 票的形狀（跟既有系統票同一套：jev_decisions(contribution, source_support)，機率 ≥0.95 才算，contribution_effective_agree 折進門檻）：
 *   * 這裡的兩道檢查**只有「擋」的一邊**：not_supported（目標 +1，不是反對票、不觸發裁決）。supported 一律棄權（cannot_tell）——
 *     合併／新人物判錯的代價是抹掉或複製一個真實存在的人，Jev 的判斷讀的是我們自己的欄位，跟代理看的是同一批資料，
 *     不構成獨立證據（docs/decisions/2026-09-20-合併走high級468不拿系統票），所以不拿「少一票」的好處，只拿「多一票」的把關。
 *   * 紀錄：合併檢查的配對判定記 politician_pair／same_person（既有）；新人物檢查記 contribution／new_person（新題名）。
 *     兩者造成的票另寫一列 contribution／source_support（choice=not_supported，state.identity_hold 寫明理由），
 *     /next 的 current.system_vote 看得到。
 */
import { normalizeName, MIN_PROBABILITY, shortId, type DecisionRecord, type JevAnswer, type JevQuestion } from "./system-one.ts";
import { politicianIdFromTask } from "./task-politician.ts";

type Obj = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^[0-9]+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

// ============================================================
// 1. 合併身份核對
// ============================================================

export const MERGE_STATE_SCHEMA = "merge-identity-v2";

export interface ElectionFact {
  election_id: number | null;
  election_type: string | null;
  region: string | null;
  district: string | null;   // regions.sub_region（鄉鎮或「第NN選舉區」）
  village: string | null;
  cand_no: number | null;
  status: string | null;
}
export interface RosterFact {
  election_type: string;
  county: string;
  town: string;
  district: string;
  village_code: string;
  cand_no: number | null;
  party: string | null;
  birth: string | null;
}
export interface PersonFacts {
  id: string;
  name: string;
  birth_year: number | null;
  party: string | null;
  region: string | null;
  current_position: string | null;
  elections: ElectionFact[];
  roster: RosterFact[];
}

export const MERGE_INSTRUCTIONS =
  "a 與 b 是資料庫裡兩筆同名的政治人物（我們正考慮把其中一筆併進另一筆）。判斷是不是同一個人。" +
  "硬規則（來自 2026-11-07 兩個誤併案）：同一場選舉（election_id 與 election_type 都相同），一個人只會在一個選區登記一次——" +
  "兩邊各有一筆這場選舉的參選紀錄，而鄉鎮或選舉區（district）、村里（village）或號次（cand_no）不同，就是不同人（例：三星鄉第02選舉區 2 號 與 羅東鎮第03選舉區 5 號）；" +
  "中選會名冊（roster）的列若分別對上兩邊、而且不是同一列，也是不同人。" +
  "出生年兩邊都有而且不同＝不同人。政黨同義寫法算相同（國民黨＝中國國民黨、民眾黨＝台灣民眾黨、無黨籍＝無黨籍及未經政黨推薦＝無）；" +
  "只有政黨不同不足以判不同人（可能換黨），要看有沒有別的衝突。不同屆別、同縣市（例如 2022 選鄉鎮市長、2026 登記縣市長）常是同一人往上選。" +
  "兩邊的參選紀錄在同一場選舉、單位與號次都一致或互補，加上出生年不衝突，才選 same。資料不夠就選 unclear，不要猜。";

export function buildMergeIdentityAsk(a: PersonFacts, b: PersonFacts): { state: Obj; questions: Record<string, JevQuestion> } {
  return {
    state: { schema: MERGE_STATE_SCHEMA, a: { ...a }, b: { ...b } },
    questions: {
      same_person: {
        type: "choice",
        instructions: MERGE_INSTRUCTIONS,
        criteria: {
          same: "同一人（同一場選舉的選區與號次對得上或互補、出生年不衝突、經歷連得起來）",
          diff: "不同人（同一場選舉選區／號次不同、出生年不同、名冊指向不同列，或政黨與經歷明顯是兩個人）",
          unclear: "資料不足，看不出來",
        },
      },
    },
  };
}

export interface SystemVoteRow { choice: "not_supported" | "cannot_tell"; probability: number }

/**
 * 配對判定 → 這筆合併貢獻的系統票。只留「擋」：Jev 的答案跟貢獻的宣稱相反（宣稱同一人而 Jev 說 diff，或宣稱不是同一人而 Jev 說 same）
 * 且機率 ≥0.95 → not_supported（SQL 認機率 ≥0.95 的，這裡照實記機率）；其餘（包括 Jev 同意宣稱）一律 cannot_tell＝棄權。
 */
export function mergeSystemVote(jevChoice: string, probability: number, claimsSame: boolean): SystemVoteRow {
  const contradicts = (claimsSame && jevChoice === "diff") || (!claimsSame && jevChoice === "same");
  return contradicts ? { choice: "not_supported", probability } : { choice: "cannot_tell", probability };
}

/** 讀一個人的全部事實：基本資料、全部參選紀錄、名冊對應列（只在有 2026 名冊鏡像資料時有） */
export async function loadPersonFacts(supabase: SupabaseLike, id: string): Promise<PersonFacts | null> {
  const { data: p, error } = await supabase.from("politicians")
    .select("id, name, party, region, birth_year, current_position").eq("id", id).maybeSingle();
  if (error) throw new Error(`politicians read: ${error.message}`);
  if (!p) return null;
  const { data: els, error: eErr } = await supabase.from("politician_elections")
    .select("election_id, election_type, cand_no, candidacy_status, regions(region, sub_region, village)").eq("politician_id", id).limit(40);
  if (eErr) throw new Error(`politician_elections read: ${eErr.message}`);
  const elections: ElectionFact[] = ((els ?? []) as Obj[]).map((e) => {
    const r = (e.regions && typeof e.regions === "object" ? e.regions : {}) as Obj;
    return {
      election_id: num(e.election_id), election_type: s(e.election_type), region: s(r.region), district: s(r.sub_region), village: s(r.village),
      cand_no: num(e.cand_no), status: s(e.candidacy_status),
    };
  });
  // 名冊：同名、而且縣市是這個人參選過的縣市（沒有就看戶籍縣市）。表可能還沒資料（登記期前）→ 空陣列
  const counties = [...new Set([...elections.map((e) => e.region), s(p.region)].filter((x): x is string => !!x))];
  let roster: RosterFact[] = [];
  if (counties.length > 0) {
    const { data: rs, error: rErr } = await supabase.from("cec_roster_2026")
      .select("election_type, county, town, district, li_code, cand_no, party, birth").eq("name", String(p.name)).in("county", counties.map((c) => c.replace(/臺/g, "台"))).limit(12);
    if (!rErr) {
      roster = ((rs ?? []) as Obj[]).map((r) => ({
        election_type: String(r.election_type ?? ""), county: String(r.county ?? ""), town: String(r.town ?? ""), district: String(r.district ?? ""),
        village_code: String(r.li_code ?? ""), cand_no: num(r.cand_no), party: s(r.party), birth: s(r.birth),
      }));
    }
  }
  return {
    id: String(p.id), name: String(p.name ?? ""), birth_year: num(p.birth_year), party: s(p.party), region: s(p.region),
    current_position: s(p.current_position), elections, roster,
  };
}

// ============================================================
// 2. 新人物相似度
// ============================================================

export const NEW_PERSON_QUESTION = "new_person";

export interface IncomingPerson {
  name: string;
  election_id: number | null;
  election_type: string | null;
  region: string | null;
  sub_region: string | null;
  electoral_district: string | null;
  village: string | null;
  party: string | null;
  birth_year: number | null;
  cand_no: number | null;
  current_position: string | null;
}

export interface NewPersonCandidate {
  key: string;                  // criteria 的鍵：p_<人物 id 前 8 碼>／s_<交件 id 前 8 碼>
  kind: "politician" | "submission";
  id: string;                   // 人物 id 或貢獻 id
  /** 交件候選若已指了某位人物（payload.politician_id），這裡是那位 */
  politician_id: string | null;
  name: string;
  party: string | null;
  birth_year: number | null;
  election_id: number | null;
  election_type: string | null;
  region: string | null;
  district: string | null;
  village: string | null;
  cand_no: number | null;
  status: string | null;
  /** submission 才有：等票中的狀態 */
  submission_status?: string | null;
  contribution_type?: string | null;
}

/** 這筆交件會不會建新人物？candidacy／politician、沒指 politician_id、不是補資料任務、有姓名 → 回它的事實；否則 null */
export function incomingOf(contribution: { contribution_type: string; payload: unknown; task_id?: unknown }): IncomingPerson | null {
  if (contribution.contribution_type !== "candidacy" && contribution.contribution_type !== "politician") return null;
  const p = (contribution.payload && typeof contribution.payload === "object" ? contribution.payload : {}) as Obj;
  if (s(p.politician_id) || s(p.resolved_politician_id) || politicianIdFromTask(contribution.task_id)) return null;
  const name = s(p.name);
  if (!name) return null;
  return {
    name, election_id: num(p.election_id), election_type: s(p.election_type), region: s(p.region), sub_region: s(p.sub_region),
    electoral_district: s(p.electoral_district), village: s(p.village), party: s(p.party), birth_year: num(p.birth_year),
    cand_no: num(p.cand_no), current_position: s(p.current_position),
  };
}

/** 同名或近名：正規化後相同，或三個字以上、等長、只差一個字（異體字、手誤） */
export function similarName(a: string, b: string): boolean {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 3 || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && ++diff > 1) return false;
  return true;
}

/** 單位對得上嗎：兩邊都有寫的欄位才比；一邊沒寫＝未知，放行（交給 Jev 看事實） */
export function sameUnit(inc: IncomingPerson, cand: { region: string | null; district: string | null; village: string | null }): boolean {
  const n = (v: string | null) => (v ? normalizeName(v) : "");
  if (n(inc.region) && n(cand.region) && n(inc.region) !== n(cand.region)) return false;
  const incDistricts = [n(inc.sub_region), n(inc.electoral_district), n(inc.sub_region) + n(inc.electoral_district)].filter(Boolean);
  const cd = n(cand.district);
  if (incDistricts.length > 0 && cd && !incDistricts.includes(cd)) return false;
  if (n(inc.village) && n(cand.village) && n(inc.village) !== n(cand.village)) return false;
  return true;
}

export const MAX_NEW_PERSON_CANDIDATES = 8;

/** 資料來源（正式用 supabaseIdentityDb；測試給假的） */
export interface IdentityDb {
  /** 名字相近的人物（未被合併的）＋他們這場選舉的參選紀錄；沒有 election_id（politician 型別）就回他們的全部參選紀錄 */
  personElections(name: string, election_id: number | null, election_type: string | null): Promise<NewPersonCandidate[]>;
  /** 名字相近、等票中（pending／verified）的 candidacy／politician 交件 */
  pendingSubmissions(name: string, election_id: number | null, election_type: string | null): Promise<NewPersonCandidate[]>;
}

export async function gatherNewPersonCandidates(db: IdentityDb, inc: IncomingPerson, selfId: string): Promise<NewPersonCandidate[]> {
  const [people, pending] = await Promise.all([
    db.personElections(inc.name, inc.election_id, inc.election_type),
    db.pendingSubmissions(inc.name, inc.election_id, inc.election_type),
  ]);
  const out: NewPersonCandidate[] = [];
  const seen = new Set<string>();
  for (const c of [...people, ...pending]) {
    if (c.id === selfId) continue;
    if (!similarName(inc.name, c.name)) continue;
    if (inc.election_id !== null && c.election_id !== null && inc.election_id !== c.election_id) continue;
    if (inc.election_type && c.election_type && inc.election_type !== c.election_type) continue;
    if (!sameUnit(inc, c)) continue;
    const dedupe = `${c.kind}:${c.id}:${c.election_id ?? ""}:${c.district ?? ""}:${c.village ?? ""}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(c);
  }
  // 同一個人物多筆參選紀錄時 key 會撞：只留第一筆（同場選舉符合的優先，前面已按條件過濾）
  const byKey = new Map<string, NewPersonCandidate>();
  for (const c of out) if (!byKey.has(c.key)) byKey.set(c.key, c);
  return [...byKey.values()].slice(0, MAX_NEW_PERSON_CANDIDATES);
}

export const NEW_PERSON_INSTRUCTIONS =
  "incoming 是一筆等票中的交件，沒有指定是誰，照現在的流程會被建成一位新人物。candidates 是同一場選舉、同選舉類型、同單位裡同名或近名的" +
  "既有人物（p_ 開頭）或另一筆等票中的交件（s_ 開頭）。判斷 incoming 是不是其中某一位。" +
  "同一場選舉、同一個單位裡同名的兩位幾乎一定是同一個人，除非有硬衝突：號次（cand_no）兩邊都有而且不同（同一個單位的號次不會重複）、" +
  "出生年兩邊都有而且不同、政黨明顯不同（同義寫法算相同：國民黨＝中國國民黨、民眾黨＝台灣民眾黨、無黨籍＝無黨籍及未經政黨推薦）。" +
  "近名（差一個字）要有別的欄位（單位、號次、政黨、出生年）對上才選。" +
  "候選者若有 politician_id，代表那筆交件已經指了某位人物，incoming 就是那位。" +
  "選了某一位，就是說 incoming 不該建新人物；選 none，就是說這是一位全新的人；資料不足看不出來就選 unclear，不要猜。";

export function buildNewPersonAsk(inc: IncomingPerson, candidates: NewPersonCandidate[]): { state: Obj; questions: Record<string, JevQuestion> } {
  const criteria: Record<string, string> = {};
  const cands: Record<string, Obj> = {};
  for (const c of candidates) {
    criteria[c.key] = c.kind === "politician" ? `就是既有人物 ${c.name}（${c.key}）` : `就是等票中另一筆交件的那位 ${c.name}（${c.key}）`;
    const { key: _k, ...facts } = c;
    cands[c.key] = facts;
  }
  criteria.none = "都不是：這是一位新的人，可以建新人物";
  criteria.unclear = "資料不足，看不出來";
  return {
    state: { incoming: { ...inc }, candidates: cands },
    questions: { [NEW_PERSON_QUESTION]: { type: "choice", instructions: NEW_PERSON_INSTRUCTIONS, criteria } },
  };
}

export interface NewPersonVerdict {
  /** existing：就是既有人物；submission：就是另一筆等票中的交件；none／unclear：沒有擋 */
  kind: "existing" | "submission" | "none" | "unclear";
  choice: string;
  probability: number;
  candidate: NewPersonCandidate | null;
  /** 機率 ≥0.95 且指到某位／某筆：要擋 */
  hold: boolean;
}

export function newPersonVerdict(answer: JevAnswer | undefined, candidates: NewPersonCandidate[]): NewPersonVerdict {
  if (!answer) return { kind: "unclear", choice: "unclear", probability: 0, candidate: null, hold: false };
  const choice = String(answer.choice);
  const probability = Math.round((answer.probabilities?.[choice] ?? 0) * 10000) / 10000;
  const candidate = candidates.find((c) => c.key === choice) ?? null;
  if (candidate) return { kind: candidate.kind === "politician" ? "existing" : "submission", choice, probability, candidate, hold: probability >= MIN_PROBABILITY };
  return { kind: choice === "none" ? "none" : "unclear", choice, probability, candidate: null, hold: false };
}

function candidateLine(c: NewPersonCandidate): string {
  const where = [c.region, c.district, c.village].filter(Boolean).join("");
  return `${c.name}${where ? `（${where}${c.cand_no ? ` ${c.cand_no} 號` : ""}）` : ""}`;
}

/**
 * 把一次新人物判定寫成紀錄：
 *   * 一列 contribution／new_person：這筆交件的判定（也是「已經問過」的戳記，之後不再問）。
 *   * hold（≥0.95 指到某位／某筆）時再寫一列 contribution／source_support／not_supported（目標 +1）：
 *     必須在 new_person 之後、而且是另一次寫入（asked_at 較晚），共識取最新一張。
 *     若指到的是另一筆等票中的交件，對方也寫同樣一列（兩邊都 +1，免得只擋後到的、先到的照樣各建各的）。
 * 回傳 { audit, holds }：呼叫端先寫 audit 再寫 holds（分兩次寫入）。
 */
export function newPersonRecords(input: {
  contributionId: string; model: string; state: Obj; answer: JevAnswer | undefined; candidates: NewPersonCandidate[]; costUsd: number;
}): { audit: DecisionRecord[]; holds: DecisionRecord[]; verdict: NewPersonVerdict } {
  const verdict = newPersonVerdict(input.answer, input.candidates);
  const audit: DecisionRecord[] = [{
    subject_type: "contribution", subject_id: input.contributionId, question: NEW_PERSON_QUESTION,
    choice: verdict.choice, probability: verdict.probability, confidence: input.answer?.confidence ?? null,
    probabilities: input.answer?.probabilities ?? null, model: input.model, state: input.state, cost_usd: Number(input.costUsd.toFixed(8)),
  }];
  const holds: DecisionRecord[] = [];
  if (verdict.hold && verdict.candidate) {
    const c = verdict.candidate;
    const reason = c.kind === "politician"
      ? `疑似已是既有人物 ${candidateLine(c)}（${c.id}）：同一場選舉、同單位、同名，不該建新人物`
      : `疑似與等票中的另一筆交件（${c.id}）是同一位 ${candidateLine(c)}：兩筆各建一個人物會變兩位`;
    holds.push({
      subject_type: "contribution", subject_id: input.contributionId, question: "source_support",
      choice: "not_supported", probability: verdict.probability, confidence: null, probabilities: input.answer?.probabilities ?? null,
      model: input.model, cost_usd: 0,
      state: { identity_hold: { check: "new_person", reason, candidate: c, suggested_politician_id: c.kind === "politician" ? c.id : c.politician_id }, incoming: input.state.incoming },
    });
    if (c.kind === "submission") {
      holds.push({
        subject_type: "contribution", subject_id: c.id, question: "source_support",
        choice: "not_supported", probability: verdict.probability, confidence: null, probabilities: input.answer?.probabilities ?? null,
        model: input.model, cost_usd: 0,
        state: { identity_hold: { check: "new_person", reason: `另一筆等票中的交件（${input.contributionId}）疑似是同一位 ${(input.state.incoming as Obj | undefined)?.name ?? ""}`, other_contribution_id: input.contributionId } },
      });
    }
  }
  return { audit, holds, verdict };
}

// ---------- 正式資料來源 ----------

/** PostgREST like 的單字萬用（_）：差一個字的所有寫法。名字有逗號括號引號就不拼（會弄壞 or 語法） */
export function nameLikePatterns(name: string): string[] {
  const n = normalizeName(name);
  if (!n || /[,()"'*%\\]/.test(n)) return [];
  const out = [n];
  if (n.length >= 3) for (let i = 0; i < n.length; i++) out.push(n.slice(0, i) + "_" + n.slice(i + 1));
  return out;
}

export function supabaseIdentityDb(supabase: SupabaseLike): IdentityDb {
  const orName = (col: string, name: string): string | null => {
    const pats = nameLikePatterns(name);
    if (pats.length === 0) return null;
    return pats.map((p) => (p.includes("_") ? `${col}.like.${p}` : `${col}.eq.${p}`)).join(",");
  };
  return {
    async personElections(name, election_id, election_type) {
      const or = orName("name", name);
      if (!or) return [];
      const { data: pols, error } = await supabase.from("politicians").select("id, name, party, birth_year").is("merged_into", null).or(or).limit(40);
      if (error) throw new Error(`identity politicians: ${error.message}`);
      const list = (pols ?? []) as Obj[];
      if (list.length === 0) return [];
      let q = supabase.from("politician_elections")
        .select("politician_id, election_id, election_type, cand_no, candidacy_status, regions(region, sub_region, village)")
        .in("politician_id", list.map((p) => String(p.id)));
      if (election_id !== null) q = q.eq("election_id", election_id);
      if (election_type) q = q.eq("election_type", election_type);
      const { data: pes, error: eErr } = await q.limit(120);
      if (eErr) throw new Error(`identity politician_elections: ${eErr.message}`);
      const byId = new Map(list.map((p) => [String(p.id), p]));
      return ((pes ?? []) as Obj[]).map((e): NewPersonCandidate => {
        const p = byId.get(String(e.politician_id)) as Obj;
        const r = (e.regions && typeof e.regions === "object" ? e.regions : {}) as Obj;
        return {
          key: `p_${shortId(String(p.id))}`, kind: "politician", id: String(p.id), politician_id: String(p.id), name: String(p.name ?? ""), party: s(p.party), birth_year: num(p.birth_year),
          election_id: num(e.election_id), election_type: s(e.election_type), region: s(r.region), district: s(r.sub_region), village: s(r.village),
          cand_no: num(e.cand_no), status: s(e.candidacy_status),
        };
      });
    },
    async pendingSubmissions(name, election_id, election_type) {
      const or = orName("payload->>name", name);
      if (!or) return [];
      let q = supabase.from("contributions").select("id, contribution_type, status, payload")
        .in("contribution_type", ["candidacy", "politician"]).in("status", ["pending", "verified"]).or(or);
      if (election_id !== null) q = q.eq("payload->>election_id", String(election_id));
      if (election_type) q = q.eq("payload->>election_type", election_type);
      const { data, error } = await q.limit(40);
      if (error) throw new Error(`identity pending: ${error.message}`);
      return ((data ?? []) as Obj[]).map((c): NewPersonCandidate => {
        const p = (c.payload && typeof c.payload === "object" ? c.payload : {}) as Obj;
        return {
          key: `s_${shortId(String(c.id))}`, kind: "submission", id: String(c.id), politician_id: s(p.politician_id), name: String(p.name ?? ""), party: s(p.party), birth_year: num(p.birth_year),
          election_id: num(p.election_id), election_type: s(p.election_type), region: s(p.region), district: s(p.electoral_district) ?? s(p.sub_region), village: s(p.village),
          cand_no: num(p.cand_no), status: s(p.candidate_status), submission_status: s(c.status), contribution_type: s(c.contribution_type),
        };
      });
    },
  };
}
