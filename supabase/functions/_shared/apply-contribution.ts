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

import { CORRECTION_FIELDS, type ContributionType, isTaskIdShape } from "./contribution-schema.ts";
import { ensurePolitician, upsertParticipation } from "./candidate-import.ts";
import { changedFields, electionResultLabel, electionResultPatch } from "./candidacy-result.ts";
import { CONFIRMED_NARROWED_NOTE, isListPublished, narrowConfirmed } from "./candidacy-status.ts";
import { checkAvatarUrl } from "./avatar-check.ts";
import { normalizeAvatarUrl } from "./avatar-url.ts";
import { politicianIdFromTask } from "./task-politician.ts";
import { findPoliticianByNameStrict } from "./politician-identity.ts";
import { normElectionType, normText } from "./identity-normalize.ts";
import { normalizeCategory } from "./category-map.ts";
import { type EditContext, recordInsert, recordUpdate } from "./edit-history.ts";
import { closeTask, createTask, validateTaskInput } from "./task-admin.ts";
import { manualTaskIdOf, shouldCloseOnApplied } from "./task-fulfilment.ts";
import { closeAdjudicationTasks, closeFixTasks } from "./adjudication.ts";
import { normalizeCorrection, splitNoOpChanges } from "./correction.ts";
import { councilDistrictKey, isCouncilAboriginalDistrict, legislatorDistrictKey, officialCouncilDistricts, regionFitFor } from "./electoral-district.ts";
import { normalizeCityName } from "./cec-city-codes.ts";
import { claimTarget, findSuperseded, DUPLICATE_ELIGIBLE_TYPES } from "./duplicate-claim.ts";
import { DISTRICT_SEAT_TYPES, type DistrictSeatKind, type ExistingDistrict, normalizeSeatDistrict, planDistrictSeats, type SeatInput, seatDistrictTown } from "./district-seats.ts";
import { missingAncestors, partyInfoIds, partyInfoItems, type PartyRow, planPartyInfo } from "./party-info.ts";
import { changedElementFields, elementPhrase, POLICY_ELEMENT_LABEL, policyElementValues } from "./policy-elements.ts";
import {
  changedLineageFields, HANDOVER_FIELDS, HANDOVER_TYPE_LABEL, type HandoverType, handoverValues, LINEAGE_LEVEL_LABEL, type LineageLevel,
  LINK_FIELDS, LINK_TYPE_LABEL, type LinkType, linkLevelProblem, linkValues, normalizeCountyName, parseCandidateTaskId, PARTICIPANT_FIELDS,
  participantPhrase, participantValues,
} from "./lineage.ts";
import { careerSourceNote } from "./politician-careers.ts";
import { type ExistingCandidacy, MAX_RESULTS_PER_SUBMISSION, planElectionResults, resultItems, resultsUnitLabel } from "./election-results.ts";
import { loadReassignContext, personLabel, reassignProblems } from "./reassign-candidacy.ts";

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
/** superseded＝落庫時現值已經跟更正一樣（別人先修好了），不寫 edit_history（#3，2026-09-22） */
export type ApplyStatus = "applied" | "disputed" | "failed" | "superseded";

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
  // profile_gap 任務交的沒帶 id 時，任務編號本身就指了是誰（2026-09-23 d5059957：用姓名猜成 new、差點建出一筆空人物）
  const given = str(row.payload.politician_id) ?? politicianIdFromTask(row.task_id);
  if (given) {
    const { data, error } = await supabase.from("politicians").select("id, name").eq("id", given).maybeSingle();
    throwIf(error, "politicians lookup by payload id");
    if (!data) return { disputed: `payload.politician_id ${given} 不存在，交維護者裁決` };
    // 帶了 id 也帶了姓名，兩者要是同一個人（2026-09-23 agy 審查）：id 填錯的話，參選紀錄會掛到別人名下。
    // 本名對不上再看別名（politician_keys alias_name），都不是才擋。
    const claimed = normText(candidate.name ?? null);
    if (claimed && claimed !== normText(String(data.name ?? ""))) {
      const { data: alias } = await supabase.from("politician_keys").select("politician_id")
        .eq("politician_id", given).eq("key_type", "alias_name").eq("key_value", claimed).limit(1).maybeSingle();
      if (!alias) return { disputed: `payload.politician_id ${given} 是「${data.name}」，但 payload.name 是「${candidate.name}」——id 與姓名不是同一人，這筆不落庫` };
    }
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
  const p = { ...row.payload };
  const ctx = ctxOf(row);
  // 照片形狀守門（2026-09-19）：橫幅、太小、不是圖的不套用，其他欄位照常；理由寫進回覆讓代理重找
  let avatarNote = "";
  if (typeof p.avatar_url === "string" && p.avatar_url) {
    // Wikimedia 縮圖寬度換成允許值（原本只有 update-avatar 做；那支 2026-09-23 下架，照片一律走貢獻）
    const avatar = normalizeAvatarUrl(p.avatar_url);
    p.avatar_url = avatar;
    const problem = await checkAvatarUrl(avatar);
    if (problem) { avatarNote = `；照片沒套用：${problem}`; p.avatar_url = null; }
  }
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
  // 學經歷的出處由資料庫觸發器在落庫時掛（#346）；這裡只把掛不掛得上講清楚
  const careerNote = careerSourceNote(p, row.source_urls);
  if (ensured.created) {
    await recordCreatedPolitician(supabase, ctx, ensured.politician_id);
    return { status: "applied", politician_id: ensured.politician_id, created_politician: true, message: `已建立新政治人物${avatarNote}${careerNote}` };
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
    message: `已對到既有人物${filled.length ? `，補上 ${filled.join("、")}` : "（無空欄位可補）"}${avatarNote}${careerNote}`,
  };
}

/**
 * 縣市議員候選人有 electoral_district（已經被 contribute-handler.ts 統一寫法）時，
 * 把參選紀錄的 region_id 指到 regions 表對應的那一列（region＋sub_region＝選區）。
 *
 * regions 沒有那一列時，只有「選區有官方根據」才新建（2026-10-05，見 councilDistrictConfirmed）；
 * 其他照舊不動 region_id、不新建——形狀不明的列建下去就是下一批髒列（#348），交給縣市層級退路與回覆。
 */
async function districtRegionPatch(supabase: SupabaseLike, electionType: string, p: Obj): Promise<Obj> {
  if (electionType === "立法委員") return await legislatorRegionPatch(supabase, p);
  if (electionType !== "縣市議員") return {};
  // 2026-10-05：選區與縣市一律先正規化（councilDistrictKey）——縣市寫「臺」、選區寫「第4選區」、
  // 或只寫在 position（「高雄市第10選舉區」）的，以前在這裡全都對不到，掉到縣市層級
  const key = councilDistrictKey(str(p.region), str(p.electoral_district), str(p.position));
  if (!key) return {};
  const find = async () => {
    // query-bounds: ok —（region, sub_region, village）是唯一鍵，選區列最多一列
    const { data } = await supabase.from("regions").select("id")
      .eq("region", key.region).eq("sub_region", key.sub_region).is("village", null).maybeSingle();
    return (data as { id?: number } | null)?.id ?? null;
  };
  const regionId = await find();
  if (regionId) return { region_id: regionId };
  // 原住民選區（2026-10-05）：regions 只有部分縣市有這幾列（花蓮、台東、屏東、苗栗、新竹縣……一列都沒有），
  // 中選會名單補進原住民選區之後，「補選區」與「當選缺紀錄」任務會請代理填這些選區，查不到列就永遠補不上。
  // 只在選區有官方根據時才建：中選會名單（已投票屆別，cec_candidates）上有這個縣市這個選區、查證過的
  // 原住民保留議席清單（COUNCIL_ABORIGINAL_DISTRICTS），或 2026 中選會登記彙總表的選區清單（COUNCIL_DISTRICT_COUNT_2026）。
  // 形狀跟既有選區列相同（縣市用「台」＋「第NN選舉區」）。
  if (!(await councilDistrictConfirmed(supabase, int(p.election_id), key.region, key.sub_region))) return {};
  const { data: created } = await supabase.from("regions")
    .insert({ region: key.region, sub_region: key.sub_region, village: null }).select("id").maybeSingle();
  // 同時兩筆交件撞唯一鍵時 insert 會失敗，再找一次就拿得到對方剛建的那列
  const id = (created as { id?: number } | null)?.id ?? await find();
  return id ? { region_id: id } : {};
}

/**
 * 這個議員選區有沒有官方根據：查證過的原住民保留議席清單、2026 登記彙總表的選區清單，
 * 或中選會名單（已投票的屆別）上有人登記在這個選區
 */
async function councilDistrictConfirmed(supabase: SupabaseLike, electionId: number | null, county: string, district: string): Promise<boolean> {
  if (isCouncilAboriginalDistrict(county, district)) return true;
  if (electionId && officialCouncilDistricts(electionId, county)?.includes(district)) return true;
  if (!electionId || !/^第\d+選舉區$/.test(district)) return false;
  // query-bounds: ok — 只要知道有沒有，limit(1)
  const { data } = await supabase.from("cec_candidates").select("id")
    .eq("election_id", electionId).eq("election_type", "縣市議員").eq("region", county).eq("sub_region", district)
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

/**
 * 立法委員（2026-10-05）：區域立委指到「<縣市>第NN選區」那一列，不分區／平地原住民／山地原住民
 * 指到「全國」那一列（規則見 electoral-district.ts 的 legislatorDistrictKey）。
 * 在這之前立委的參選紀錄從來走不到任何一條路，交件給了選區也一樣是 NULL。
 */
async function legislatorRegionPatch(supabase: SupabaseLike, p: Obj): Promise<Obj> {
  const key = legislatorDistrictKey(str(p.region), str(p.electoral_district));
  if (!key) return {};
  const find = async () => {
    for (const sub of key.sub_regions) {
      // query-bounds: ok —（region, sub_region, village）是唯一鍵，最多一列
      const { data } = await supabase.from("regions").select("id")
        .eq("region", key.region).eq("sub_region", sub).is("village", null).maybeSingle();
      const id = (data as { id?: number } | null)?.id;
      if (id) return id;
    }
    return null;
  };
  const existing = await find();
  if (existing) return { region_id: existing };
  if (!key.create) return {};
  // 同時兩筆交件撞唯一鍵時 insert 會失敗，再找一次就拿得到對方剛建的那列
  const { data: created } = await supabase.from("regions")
    .insert({ region: key.region, sub_region: key.sub_regions[0], village: null }).select("id").maybeSingle();
  const id = (created as { id?: number } | null)?.id ?? await find();
  return id ? { region_id: id } : {};
}

/**
 * 鄉鎮市長、代表、村里長、原住民區長／代表（2026-10-04 名單清查擴到這幾種）：參選紀錄要記得「哪個鄉鎮市區、哪個村里」。
 * 原本只有縣市議員會把 region_id 指到 regions 列（districtRegionPatch），這幾種的鄉鎮只靠人物表的 sub_region
 * ——那正是要淘汰的舊欄位（見 issue #328），而且同一人換村里參選就對不上。這裡改成每筆參選紀錄自己指到
 * regions（縣市＋鄉鎮市區［＋村里］）。regions 有 (region, sub_region, village) 唯一鍵，查不到就建一列，形狀固定。
 */
export const LOCAL_ELECTION_TYPES = ["鄉鎮市長", "鄉鎮市民代表", "村里長", "直轄市山地原住民區長", "直轄市山地原住民區民代表"] as const;

export function localRegionKey(electionType: string, p: Obj): { region: string; sub_region: string; village: string | null } | null {
  if (!(LOCAL_ELECTION_TYPES as readonly string[]).includes(electionType)) return null;
  const region = str(p.region);
  const township = str(p.sub_region);
  if (!region || !township || /選舉區/.test(township)) return null;
  const village = electionType === "村里長" ? str(p.village) : null;
  if (electionType === "村里長" && !village) return null;
  return { region, sub_region: township, village };
}

async function localRegionPatch(supabase: SupabaseLike, electionType: string, p: Obj): Promise<Obj> {
  const key = localRegionKey(electionType, p);
  if (!key) return {};
  const find = async () => {
    // query-bounds: ok — (region, sub_region, village) 是唯一鍵，最多一列
    let q = supabase.from("regions").select("id").eq("region", key.region).eq("sub_region", key.sub_region);
    q = key.village ? q.eq("village", key.village) : q.is("village", null);
    const { data } = await q.maybeSingle();
    return (data as { id?: number } | null)?.id ?? null;
  };
  const existing = await find();
  if (existing) return { region_id: existing };
  const { data: created } = await supabase.from("regions").insert(key).select("id").maybeSingle();
  const id = (created as { id?: number } | null)?.id ?? await find();
  return id ? { region_id: id } : {};
}

// 立法委員 2026-10-05 加入：區域立委選區對不上時至少落到縣市（不分區／原住民立委的 region 是「全國」，
// regions 沒有「全國」的縣市層級列，落不下去，回覆會請代理補 electoral_district）
const COUNTY_FALLBACK_TYPES = ["縣市長", "縣市議員", "立法委員"] as const;
/** 這幾種要記到選區，只有縣市不算補齊（contribution_auto_tasks_region_gap 也是這樣判） */
const DISTRICT_TYPES = ["縣市議員", "立法委員"] as const;

function regionIdOf(patch: Obj): number | null {
  return typeof patch.region_id === "number" ? patch.region_id : null;
}

/**
 * 縣市長／縣市議員：選區對不上時，至少把 region_id 指到「縣市層級」那一列（2026-10-04）。
 *
 * 在這之前，縣市議員少填 electoral_district、或填了但 regions 沒有那一列，region_id 就是 NULL；
 * 縣市長更是從來走不到 districtRegionPatch。而 get_politicians_by_filters 是
 * politician_elections LEFT JOIN regions 再比 r.region，region_id 空的那一筆用任何縣市篩選
 * 都撈不到、也不報錯——盤點當下有 102 筆 2026 已登記的紀錄是這樣（見
 * 20261004000020_fix_misassigned_regions.sql）。
 *
 * 只補到縣市，不猜選舉區：縣市長的選區就是那個縣市（2026 已經有 95 筆這樣指），
 * 縣市議員則是「先讓他出現在對的縣市」，選舉區留給代理流程補。
 * 畫面不會因此變差：politicians_with_elections 的 subRegion 是
 * COALESCE(per.sub_region, r.sub_region, p.sub_region)，縣市層級列的 sub_region 是 NULL，
 * 會自動落回原本那一層。
 *
 * 刻意不涵蓋 LOCAL_ELECTION_TYPES：那幾種的「region_id 是空的」正是
 * contribution_auto_tasks_township_gap 用來派「補鄉鎮」任務的訊號，補成縣市會把那個缺口藏起來。
 */
async function countyRegionPatch(supabase: SupabaseLike, electionType: string, p: Obj): Promise<Obj> {
  if (!(COUNTY_FALLBACK_TYPES as readonly string[]).includes(electionType)) return {};
  // regions 的縣市層級列一律寫「台」；交件寫「臺中市」的以前在這裡對不到，留成 NULL（2026-10-05）
  const region = normalizeCityName(str(p.region) ?? undefined) || null;
  if (!region) return {};
  // query-bounds: ok —（region, sub_region, village）是唯一鍵，縣市層級最多一列
  const { data } = await supabase.from("regions").select("id")
    .eq("region", region).is("sub_region", null).is("village", null).maybeSingle();
  const id = (data as { id?: number } | null)?.id;
  return id ? { region_id: id } : {};
}

/**
 * 既有參選紀錄指到的那一列，對這種選舉來說是哪一層（2026-10-05，規則在 electoral-district.ts 的 regionFitFor）。
 * 只看縣市長、縣市議員、立委；鄉鎮層級五種的地區本來就是鄉鎮或村里。查不到那一列就回 null（照舊不動）。
 */
async function beforeRegionFit(
  supabase: SupabaseLike,
  electionType: string,
  regionId: number,
): Promise<{ fit: ReturnType<typeof regionFitFor>; label: string } | null> {
  if (!(COUNTY_FALLBACK_TYPES as readonly string[]).includes(electionType)) return null;
  // query-bounds: ok — 按主鍵取一列
  const { data } = await supabase.from("regions").select("region, sub_region, village").eq("id", regionId).maybeSingle();
  if (!data) return null;
  const row = data as { region?: string | null; sub_region?: string | null; village?: string | null };
  return { fit: regionFitFor(electionType, row), label: [row.region, row.sub_region, row.village].filter(Boolean).join(" ") };
}

/**
 * 地區沒解析出來，就在回覆裡說清楚是哪一步沒成、代理該補什麼——不要讓它靜靜地寫成 NULL
 * （2026-10-04）。看這段訊息的是交件的代理，它就是能去補的那個人。
 */
function districtHowTo(electionType: string): string {
  return electionType === "立法委員"
    ? "electoral_district 填「第NN選區」（區域立委）；不分區或原住民立委 region 填「全國」、electoral_district 填「不分區」「平地原住民」或「山地原住民」"
    : "electoral_district 填「第NN選舉區」";
}

function regionGapNote(
  electionType: string,
  p: Obj,
  found: { resolved: number | null; county: number | null; district: number | null },
): string {
  if (!(COUNTY_FALLBACK_TYPES as readonly string[]).includes(electionType)) return "";
  const region = str(p.region);
  const needsDistrict = (DISTRICT_TYPES as readonly string[]).includes(electionType);
  if (found.resolved === null) {
    if (electionType === "立法委員") {
      return `；這筆還沒有對到地區，網站的縣市篩選撈不到他：region 填的是「${region ?? "（空的）"}」` +
        `、electoral_district 填的是「${str(p.electoral_district) ?? "（空的）"}」。請用 candidacy 型別重交同一人同一屆，${districtHowTo(electionType)}。`;
    }
    return `；這筆還沒有對到地區，網站的縣市篩選撈不到他：region 填的是「${region ?? "（空的）"}」` +
      `，系統的 regions 表裡找不到這個縣市${region ? "（縣市要用「台」不是「臺」，而且不要帶選區）" : ""}。` +
      `請改好 region 用 candidacy 型別重交同一人同一屆。`;
  }
  if (!needsDistrict || found.district !== null) return "";
  if (found.county !== null) {
    return `；選區沒給或對不上 regions 表，這筆先只記到縣市（${region}）。` +
      `之後請用 candidacy 型別重交同一人同一屆、${districtHowTo(electionType)}補上選區。`;
  }
  // 原本就有地區、這次給的選區卻對不上：照舊不動，但要講出來，不然「補選區」任務會一直派回來
  const given = str(p.electoral_district);
  return given
    ? `；electoral_district「${given}」在 regions 表對不上，這筆的地區維持原狀。請核對寫法後重交（${districtHowTo(electionType)}）。`
    : "";
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

  const rawStatus = String(p.candidate_status);
  const electionId = Number(p.election_id);
  const { data: before } = await supabase.from("politician_elections").select("*").eq("politician_id", ensured.politician_id).eq("election_id", electionId).maybeSingle();
  // confirmed 收窄（#345 後續）：正式名單公告後（含已投票屆別）記成 qualified；早期匯入的 confirmed 原樣重交不改
  const narrowed = rawStatus === "confirmed"
    ? narrowConfirmed(rawStatus, await isListPublished(supabase, electionId, electionType), (before as { candidate_status?: string | null } | null)?.candidate_status)
    : { status: rawStatus, converted: false };
  // withdrawn 在 DB 沒有對應值，落成 not_running 並在 source_note 註明
  const candidateStatus = narrowed.status === "withdrawn" ? "not_running" : narrowed.status;

  // 選舉結果三欄（election_result_missing 任務補的）：有給才寫；2026-09-19 前這裡直接丟掉
  // 號次有給才寫（2026-09-25 補欄位；之前協議收了但沒地方放）
  // 選區有給且 regions 表查得到對應列才寫 region_id（2026-09-28；見 districtRegionPatch 說明）
  // 選區對不上時至少落到縣市層級，不要留 NULL（2026-10-04；見 countyRegionPatch 說明）
  const districtPatch = {
    ...(await districtRegionPatch(supabase, electionType, p)),
    ...(await localRegionPatch(supabase, electionType, p)),
  };
  const beforeRegionId = (before as { region_id?: number | null } | null)?.region_id ?? null;
  const districtRegionId = regionIdOf(districtPatch);
  // 既有紀錄指到的列對這種選舉是掛錯層級（村里、鄉鎮、別種選舉的選區）就不算數，改記到縣市（2026-10-05）。
  // 同一人同一屆只有一筆參選紀錄：里長紀錄改成議員時（選舉別換了），原本那個里會原封不動留下來，
  // 畫面就把「大雅區 上雅里」當成議員的選區。
  const beforeFit = beforeRegionId !== null && !districtRegionId
    ? await beforeRegionFit(supabase, electionType, beforeRegionId)
    : null;
  const keepBefore = beforeRegionId !== null && beforeFit?.fit !== "wrong";
  const countyPatch = districtRegionId || keepBefore
    ? {}
    : await countyRegionPatch(supabase, electionType, p);
  const countyRegionId = regionIdOf(countyPatch);
  const resultPatch = {
    ...electionResultPatch(p),
    ...(int(p.cand_no) ? { cand_no: int(p.cand_no) } : {}),
    ...districtPatch,
    ...countyPatch,
  };
  const wrongLevelNote = beforeFit?.fit === "wrong"
    ? countyRegionId
      ? `；這筆原本掛在「${beforeFit.label}」，對${electionType}來說不是選區也不是縣市（多半是同一個人其他選舉的地區），已改記到縣市`
      : `；這筆掛在「${beforeFit.label}」，對${electionType}來說不是選區也不是縣市，但 region 對不到縣市，地區先維持原狀`
    : "";
  const regionNote = wrongLevelNote + regionGapNote(electionType, p, {
    resolved: districtRegionId ?? countyRegionId ?? (keepBefore ? beforeRegionId : null),
    county: countyRegionId,
    district: districtRegionId,
  });
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
    // 選舉別換了（傳聞選縣市長、實際登記縣市議員）也要記進履歷，見 candidate-import.ts 的 electionTypeSwitch
    const switched = before && before.election_type !== electionType ? { election_type: electionType, position: str(p.position) ?? `${electionType}候選人` } : {};
    const after = { candidate_status: candidateStatus, source_note: newSourceNote, ...resultPatch, ...switched };
    for (const [field, oldValue, newValue] of changedFields(before ?? null, after)) {
      await recordUpdate(supabase, ctx, "politician_elections", String(participation.id), field, oldValue, newValue);
    }
  }
  const resultLabel = electionResultLabel(p);
  return {
    status: "applied",
    politician_id: ensured.politician_id,
    created_politician: ensured.created,
    message: `參選紀錄已${participation.outcome === "created" ? "建立" : "更新"}為 ${candidateStatus}${resultLabel ? `，選舉結果 ${resultLabel}` : ""}${narrowed.converted ? CONFIRMED_NARROWED_NOTE : ""}${regionNote}`,
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
    // 政見從哪裡來（#349）：交件有給才寫；沒給的競選承諾由資料庫觸發器自動標 pledge
    ...(str(p.origin) ? { origin: str(p.origin) } : {}),
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

/** 進度事件比政見現況的最後更新日期舊（嚴格早於）→ 只記時間軸。現況沒有日期就當成新的 */
export function isOlderEvent(eventDate: string, currentLastUpdated: unknown): boolean {
  const cur = typeof currentLastUpdated === "string" ? currentLastUpdated.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cur) || !/^\d{4}-\d{2}-\d{2}/.test(eventDate)) return false;
  return eventDate.slice(0, 10) < cur;
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

  // 事件日期比現況舊：只進時間軸、不動目前狀態（2026-09-28：先交「10 月已完成」、後補「3 月開始推動」會讓現況倒退成推動中）
  const eventDate = String(p.date);
  const olderThanCurrent = isOlderEvent(eventDate, before.last_updated);
  const patch: Obj = { status: String(p.status), last_updated: eventDate };
  if (int(p.progress) !== null) patch.progress = p.progress;
  if (!olderThanCurrent) {
    const { error } = await supabase.from("policies").update(patch).eq("id", policyId);
    throwIf(error, "policies update");
    for (const [k, v] of Object.entries(patch)) await recordUpdate(supabase, ctx, "policies", policyId as string, k, before[k] ?? null, v);
  }

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
  return {
    status: "applied", policy_id: policyId as string,
    message: olderThanCurrent
      ? `這則進度的日期（${eventDate}）比政見現況（${String(before.last_updated).slice(0, 10)}）舊，已記進時間軸，目前狀態不變`
      : "政見進度已更新並留下追蹤紀錄",
  };
}

/**
 * 政見三要素（#364，2026-10-05）：一條政見一個要素一列（policy_id, element 唯一）。
 * 還沒有的那一列新增（edit_history 記整列），已經有的照這次覆蓋、每個變動的欄位記一筆——
 * 重交同一條政見的某個要素，就是更正它的路（不另開 correction 欄位）。
 * 出處由資料表觸發器把 source_url 同步進 source_refs（migration 20261005005640），這裡不必另外寫。
 * 全部跟現有一樣 → superseded（別人先交了，不寫假的履歷）。
 */
async function applyPolicyElements(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const policyId = str(p.policy_id);
  const elements = Array.isArray(p.elements) ? (p.elements as unknown[]).filter((e): e is Obj => !!e && typeof e === "object") : [];
  if (!policyId || elements.length === 0) return { status: "failed", message: "policy_elements 要帶 policy_id 與 elements" };

  const { data: policy, error: policyError } = await supabase.from("policies").select("id, title, removed_at, removed_reason").eq("id", policyId).maybeSingle();
  throwIf(policyError, "policies read");
  if (!policy) return { status: "failed", message: `找不到政見 ${policyId}` };
  if (policy.removed_at) {
    return { status: "failed", message: `政見 ${policyId} 已被移除（${policy.removed_reason ?? "未寫理由"}），不接受三要素；如果認為它其實是有效政見，請在 note 說明理由請維護者還原` };
  }

  // query-bounds: ok — 一條政見最多三列（policy_id, element 唯一）
  const { data: existingRows, error: existingError } = await supabase.from("policy_elements").select("*").eq("policy_id", policyId).limit(3);
  throwIf(existingError, "policy_elements read");
  const existing = (existingRows ?? []) as Obj[];

  const written: string[] = [];
  const unchanged: string[] = [];
  for (const raw of elements) {
    const values = policyElementValues(raw, row.source_urls);
    const label = POLICY_ELEMENT_LABEL[values.element] ?? values.element;
    const current = existing.find((r) => r.element === values.element);
    if (!current) {
      const { data: inserted, error } = await supabase.from("policy_elements")
        .insert({ policy_id: policyId, ...values, contribution_id: row.id }).select("*").maybeSingle();
      throwIf(error, "policy_elements insert");
      if (!inserted) throw new Error("policy_elements insert 沒有回傳 id");
      await recordInsert(supabase, ctx, "policy_elements", String(inserted.id), inserted);
      written.push(elementPhrase(values));
      continue;
    }
    const fields = changedElementFields(current, values);
    if (fields.length === 0) { unchanged.push(label); continue; }
    const patch: Obj = Object.fromEntries(fields.map((f) => [f, values[f]]));
    const { error } = await supabase.from("policy_elements").update({ ...patch, contribution_id: row.id }).eq("id", current.id);
    throwIf(error, "policy_elements update");
    for (const f of fields) await recordUpdate(supabase, ctx, "policy_elements", String(current.id), f, current[f] ?? null, values[f]);
    written.push(elementPhrase(values));
  }
  if (written.length === 0) {
    return { status: "superseded", message: `「${policy.title}」的${unchanged.join("、")}跟網站上現有的一樣（別人先交了），不重複寫入` };
  }
  return {
    status: "applied",
    policy_id: policyId,
    message: `「${policy.title}」的政見三要素已上線：${written.join("；")}${unchanged.length > 0 ? `（${unchanged.join("、")}跟現有的一樣，略過）` : ""}`,
  };
}

// ── 政策脈絡（#349，2026-10-06）──────────────────────────────────────────────────
// 四種型別各自落一張表；每個新增／更動／刪除都寫 edit_history（整筆還原：新增的刪掉、改的倒回、刪的放回去）。
// 出處由資料表觸發器把 source_url 同步進 source_refs（migration 20261006034900），這裡不必另外寫。

const uuidList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().toLowerCase()))] : [];

/**
 * 脈絡的地方 → 網站寫法的縣市／鄉鎮＋內政部官方代碼（regions.admin_code，#348）。
 * 縣市接受「臺／台」兩種寫法；鄉鎮要真的在那個縣市（regions 有那一列、而且有官方代碼）。找不到回錯誤訊息。
 */
export async function resolveLineagePlace(
  supabase: SupabaseLike, level: unknown, region: unknown, subRegion: unknown,
): Promise<{ region: string | null; sub_region: string | null; admin_code: string | null } | { error: string }> {
  if (level === "national") return { region: null, sub_region: null, admin_code: null };
  const county = normalizeCountyName(region);
  if (!county) return { error: "縣市、鄉鎮層級的脈絡要填 region（縣市）" };
  const spellings = [...new Set([county, county.replace(/台/g, "臺")])];
  const sub = level === "township" && typeof subRegion === "string" && subRegion.trim() ? subRegion.trim() : null;
  if (level === "township" && !sub) return { error: "鄉鎮層級的脈絡要填 sub_region（鄉鎮市區）" };
  let q = supabase.from("regions").select("id, region, sub_region, admin_code").in("region", spellings).is("village", null);
  q = sub ? q.eq("sub_region", sub) : q.is("sub_region", null);
  // query-bounds: ok — 同一個縣市（＋鄉鎮）的列最多兩三列（台／臺兩種寫法）
  const { data, error } = await q.limit(5);
  throwIf(error, "regions lookup");
  const want = level === "township" ? /^\d{8}$/ : /^\d{5}$/;
  const row = ((data ?? []) as Array<{ admin_code?: string | null }>).find((r) => typeof r.admin_code === "string" && want.test(r.admin_code));
  if (!row) return { error: `找不到${sub ? `「${county}${sub}」` : `「${county}」`}（要照內政部行政區的名稱寫，例：台中市、大雅區）` };
  return { region: county, sub_region: sub, admin_code: String(row.admin_code) };
}

/** 交了候選清查任務的脈絡或關聯並落庫＝這一份清單看過了；跟 no_change confirmed 寫同一列 */
async function recordCandidateReview(supabase: SupabaseLike, row: ContributionRow, note: string | null): Promise<boolean> {
  const parsed = parseCandidateTaskId(row.task_id ?? row.payload.task_id);
  if (!parsed) return false;
  await upsertCandidateReview(supabase, row, { review_key: parsed.review_key, fingerprint: parsed.fingerprint, agent_name: row.agent_name, contribution_id: row.id, note });
  return true;
}

/** 寫一列候選清查結論；履歷的 record_id 要是那一列的 id（executeRevert 的 delete 寫死 .eq("id", record_id)） */
async function upsertCandidateReview(supabase: SupabaseLike, row: ContributionRow, review: Obj): Promise<void> {
  const { data, error } = await supabase.from("lineage_candidate_reviews").upsert(review, { onConflict: "review_key" }).select("id").maybeSingle();
  throwIf(error, "lineage_candidate_reviews upsert");
  if (!data?.id) throw new Error("lineage_candidate_reviews upsert 沒有回傳 id");
  await recordInsert(supabase, ctxOf(row), "lineage_candidate_reviews", String(data.id), { id: data.id, ...review });
}

/** 人物要存在；被合併了就改指保留的那一位（同 apply-precheck 的判準，等票期間被合併的也接得住） */
async function livePoliticianIds(supabase: SupabaseLike, ids: readonly string[]): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  if (ids.length === 0) return out;
  // query-bounds: ok — 一筆最多 MAX_PARTICIPANTS（50）位或兩位（交接）
  const { data, error } = await supabase.from("politicians").select("id, name, merged_into").in("id", [...ids]).limit(100);
  throwIf(error, "politicians lookup");
  const rows = (data ?? []) as Array<{ id: string; name: string; merged_into: string | null }>;
  const mergedTo = rows.filter((r) => r.merged_into).map((r) => String(r.merged_into));
  const kept = new Map<string, string>();
  if (mergedTo.length > 0) {
    // query-bounds: ok — 被合併的那幾位的保留者
    const { data: keep, error: keepError } = await supabase.from("politicians").select("id, name").in("id", mergedTo).limit(100);
    throwIf(keepError, "politicians merged lookup");
    for (const k of (keep ?? []) as Array<{ id: string; name: string }>) kept.set(String(k.id), k.name);
  }
  for (const r of rows) {
    const id = String(r.id).toLowerCase();
    if (r.merged_into) out.set(id, { id: String(r.merged_into), name: kept.get(String(r.merged_into)) ?? r.name });
    else out.set(id, { id: String(r.id), name: r.name });
  }
  return out;
}

/** 建立／歸入脈絡：new_lineage 建一條、或 lineage_id 歸入既有的；policy_ids 掛上去、detach_policy_ids 拿掉、title／summary／category 更正 */
async function applyLineage(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const attach = uuidList(p.policy_ids);
  const detach = uuidList(p.detach_policy_ids);
  let lineageId = str(p.lineage_id)?.toLowerCase() ?? null;
  const nl = (p.new_lineage && typeof p.new_lineage === "object" ? p.new_lineage : null) as Obj | null;
  if (!lineageId && !nl) return { status: "failed", message: "lineage 要帶 lineage_id（歸入既有的）或 new_lineage（建一條新的）" };

  const ids = [...attach, ...detach];
  const policies = new Map<string, { id: string; title: string; removed_at: string | null; lineage_id: string | null }>();
  if (ids.length > 0) {
    // query-bounds: ok — 一筆最多 2×LINEAGE_MAX_POLICIES 條（schema 擋）
    const { data, error } = await supabase.from("policies").select("id, title, removed_at, lineage_id").in("id", ids).limit(100);
    throwIf(error, "policies read");
    for (const r of (data ?? []) as Array<{ id: string; title: string; removed_at: string | null; lineage_id: string | null }>) policies.set(String(r.id).toLowerCase(), r);
  }
  const missing = ids.filter((id) => !policies.has(id));
  if (missing.length > 0) return { status: "failed", message: `找不到政見 ${missing.join("、")}` };
  const removed = attach.filter((id) => policies.get(id)!.removed_at);
  if (removed.length > 0) return { status: "failed", message: `政見 ${removed.join("、")} 已被移除，不歸入脈絡` };

  let lineage: Obj | null = null;
  if (lineageId) {
    const { data, error } = await supabase.from("lineages").select("*").eq("id", lineageId).maybeSingle();
    throwIf(error, "lineages read");
    if (!data) return { status: "failed", message: `找不到脈絡 ${lineageId}` };
    lineage = data as Obj;
  }
  // 一條政見只屬於一條脈絡：已經在別條的，要先從那條拿掉（同一件事被建成兩條的話，先把政見集中到其中一條）
  const elsewhere = attach.filter((id) => {
    const cur = policies.get(id)!.lineage_id;
    return cur && String(cur).toLowerCase() !== lineageId;
  });
  if (elsewhere.length > 0) {
    return {
      status: "failed",
      message: `政見 ${elsewhere.map((id) => `「${policies.get(id)!.title}」（在脈絡 ${policies.get(id)!.lineage_id}）`).join("、")} 已經在另一條脈絡；` +
        "要改歸屬，先交一筆 lineage 對那條脈絡用 detach_policy_ids 拿掉，再歸入這條",
    };
  }

  const done: string[] = [];
  if (!lineageId && nl) {
    const place = await resolveLineagePlace(supabase, nl.level, nl.region, nl.sub_region);
    if ("error" in place) return { status: "failed", message: place.error };
    const title = String(nl.title ?? "").trim();
    // 同一層級、同一地方已有同名的脈絡：不另建（唯一索引也會擋），叫代理歸入那一條
    let dupQ = supabase.from("lineages").select("id, title").eq("level", String(nl.level)).eq("title", title);
    dupQ = place.admin_code ? dupQ.eq("admin_code", place.admin_code) : dupQ.is("admin_code", null);
    const { data: dup, error: dupError } = await dupQ.limit(1);
    throwIf(dupError, "lineages duplicate lookup");
    const same = ((dup ?? []) as Array<{ id: string; title: string }>)[0];
    if (same) return { status: "failed", message: `同一個地方已經有同名的脈絡「${same.title}」（${same.id}），請改帶 lineage_id 歸入那一條` };
    const newRow = {
      title,
      summary: typeof nl.summary === "string" && nl.summary.trim() ? nl.summary.trim() : null,
      category: normalizeCategory(String(nl.category ?? "")) ?? (str(nl.category) ?? null),
      level: String(nl.level),
      region: place.region,
      sub_region: place.sub_region,
      admin_code: place.admin_code,
      contribution_id: row.id,
    };
    const { data: inserted, error } = await supabase.from("lineages").insert(newRow).select("*").maybeSingle();
    throwIf(error, "lineages insert");
    if (!inserted) throw new Error("lineages insert 沒有回傳 id");
    await recordInsert(supabase, ctx, "lineages", String(inserted.id), inserted);
    lineageId = String(inserted.id).toLowerCase();
    lineage = inserted as Obj;
    done.push(`建立脈絡「${title}」（${LINEAGE_LEVEL_LABEL[newRow.level as LineageLevel] ?? newRow.level}${place.region ? `・${place.region}${place.sub_region ?? ""}` : ""}）`);
  } else if (lineage) {
    // 更正脈絡本身（標題、摘要、分類）：只動變了的欄位，每欄記一筆
    const patch: Obj = {};
    if (p.title !== undefined) patch.title = String(p.title).trim();
    if (p.summary !== undefined) patch.summary = String(p.summary).trim() || null;
    if (p.category !== undefined) patch.category = normalizeCategory(String(p.category)) ?? String(p.category);
    const fields = changedLineageFields(lineage, patch, Object.keys(patch));
    if (fields.length > 0) {
      const changed = Object.fromEntries(fields.map((f) => [f, patch[f]]));
      const { error } = await supabase.from("lineages").update(changed).eq("id", lineageId);
      throwIf(error, "lineages update");
      for (const f of fields) await recordUpdate(supabase, ctx, "lineages", String(lineageId), f, lineage[f] ?? null, patch[f]);
      done.push(`更正脈絡的${fields.map((f) => ({ title: "標題", summary: "摘要", category: "分類" } as Record<string, string>)[f] ?? f).join("、")}`);
    }
  }

  const attached: string[] = [];
  for (const id of attach) {
    const pol = policies.get(id)!;
    if (pol.lineage_id && String(pol.lineage_id).toLowerCase() === lineageId) continue; // 已經在這條
    const { error } = await supabase.from("policies").update({ lineage_id: lineageId }).eq("id", pol.id);
    throwIf(error, "policies lineage attach");
    await recordUpdate(supabase, ctx, "policies", String(pol.id), "lineage_id", pol.lineage_id ?? null, lineageId);
    attached.push(`「${pol.title}」`);
  }
  const detached: string[] = [];
  for (const id of detach) {
    const pol = policies.get(id)!;
    if (!pol.lineage_id || String(pol.lineage_id).toLowerCase() !== lineageId) continue; // 本來就不在這條
    const { error } = await supabase.from("policies").update({ lineage_id: null }).eq("id", pol.id);
    throwIf(error, "policies lineage detach");
    await recordUpdate(supabase, ctx, "policies", String(pol.id), "lineage_id", pol.lineage_id, null);
    detached.push(`「${pol.title}」`);
  }
  if (attached.length > 0) done.push(`歸入 ${attached.length} 條政見：${attached.join("、")}`);
  if (detached.length > 0) done.push(`拿掉 ${detached.length} 條政見：${detached.join("、")}`);

  const reviewed = await recordCandidateReview(supabase, row, str(p.note));
  if (done.length === 0) {
    return { status: "superseded", message: `脈絡「${lineage?.title ?? lineageId}」跟這筆要的一樣（別人先交了），不重複寫入${reviewed ? "；這一格的清單記為已看過" : ""}` };
  }
  return { status: "applied", message: `${done.join("；")}（脈絡 ${lineageId}）${reviewed ? "；這一格的清單記為已看過，清單有變動才會再派" : ""}` };
}

/** 標參與角色：一個人在一條脈絡裡，官方紀錄一個角色、本人宣稱一個角色；重交＝覆蓋，remove=true 拿掉 */
async function applyLineageParticipants(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const lineageId = str(p.lineage_id)?.toLowerCase();
  const items = Array.isArray(p.participants) ? (p.participants as unknown[]).filter((e): e is Obj => !!e && typeof e === "object") : [];
  if (!lineageId || items.length === 0) return { status: "failed", message: "lineage_participants 要帶 lineage_id 與 participants" };
  const { data: lineage, error: lineageError } = await supabase.from("lineages").select("id, title").eq("id", lineageId).maybeSingle();
  throwIf(lineageError, "lineages read");
  if (!lineage) return { status: "failed", message: `找不到脈絡 ${lineageId}` };

  const people = await livePoliticianIds(supabase, items.map((e) => String(e.politician_id ?? "").toLowerCase()));
  const unknown = items.map((e) => String(e.politician_id ?? "").toLowerCase()).filter((id) => !people.has(id));
  if (unknown.length > 0) return { status: "failed", message: `找不到人物 ${[...new Set(unknown)].join("、")}` };

  // query-bounds: ok — 一條脈絡的參與者最多幾十位（一案的連署人）
  const { data: existingRows, error: existingError } = await supabase.from("lineage_participants").select("*").eq("lineage_id", lineageId).limit(500);
  throwIf(existingError, "lineage_participants read");
  const existing = (existingRows ?? []) as Obj[];

  const written: string[] = [];
  const unchanged: string[] = [];
  for (const raw of items) {
    const person = people.get(String(raw.politician_id).toLowerCase())!;
    const basis = String(raw.basis);
    const current = existing.find((r) => String(r.politician_id).toLowerCase() === person.id.toLowerCase() && r.basis === basis);
    if (raw.remove === true) {
      if (!current) { unchanged.push(`${person.name}（本來就沒有）`); continue; }
      const { error } = await supabase.from("lineage_participants").delete().eq("id", current.id);
      throwIf(error, "lineage_participants delete");
      // 整列記下：還原時放回去
      await recordUpdate(supabase, ctx, "lineage_participants", String(current.id), "*", current, null);
      written.push(`拿掉 ${person.name} 的${participantPhrase({ role: current.role, basis: current.basis })}`);
      continue;
    }
    const values = { ...participantValues(raw, row.source_urls), politician_id: person.id };
    if (!current) {
      const { data: inserted, error } = await supabase.from("lineage_participants")
        .insert({ lineage_id: lineageId, ...values, contribution_id: row.id }).select("*").maybeSingle();
      throwIf(error, "lineage_participants insert");
      if (!inserted) throw new Error("lineage_participants insert 沒有回傳 id");
      await recordInsert(supabase, ctx, "lineage_participants", String(inserted.id), inserted);
      written.push(participantPhrase({ ...values, name: person.name }));
      continue;
    }
    const fields = changedLineageFields(current, values, [...PARTICIPANT_FIELDS]);
    if (fields.length === 0) { unchanged.push(person.name); continue; }
    const patch: Obj = Object.fromEntries(fields.map((f) => [f, values[f]]));
    const { error } = await supabase.from("lineage_participants").update({ ...patch, contribution_id: row.id }).eq("id", current.id);
    throwIf(error, "lineage_participants update");
    for (const f of fields) await recordUpdate(supabase, ctx, "lineage_participants", String(current.id), f, current[f] ?? null, values[f]);
    written.push(participantPhrase({ ...values, name: person.name }));
  }
  if (written.length === 0) {
    return { status: "superseded", message: `脈絡「${lineage.title}」的參與角色跟現有的一樣（${unchanged.join("、")}），不重複寫入` };
  }
  return {
    status: "applied",
    message: `脈絡「${lineage.title}」的參與角色已上線：${written.join("；")}${unchanged.length > 0 ? `（${unchanged.join("、")}跟現有的一樣，略過）` : ""}`,
  };
}

/** 記交接：同一條脈絡、同一對任期只有一筆，重交＝覆蓋（每欄記履歷） */
async function applyLineageHandover(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const lineageId = str(p.lineage_id)?.toLowerCase();
  if (!lineageId) return { status: "failed", message: "lineage_handover 要帶 lineage_id" };
  const { data: lineage, error: lineageError } = await supabase.from("lineages").select("id, title").eq("id", lineageId).maybeSingle();
  throwIf(lineageError, "lineages read");
  if (!lineage) return { status: "failed", message: `找不到脈絡 ${lineageId}` };

  const raw = handoverValues(p, row.source_urls);
  const people = await livePoliticianIds(supabase, [raw.from_politician_id.toLowerCase(), raw.to_politician_id.toLowerCase()]);
  const from = people.get(raw.from_politician_id.toLowerCase());
  const to = people.get(raw.to_politician_id.toLowerCase());
  if (!from || !to) return { status: "failed", message: `找不到人物 ${!from ? raw.from_politician_id : raw.to_politician_id}` };
  const values = { ...raw, from_politician_id: from.id, to_politician_id: to.id };
  if (from.id === to.id && values.from_election_id === values.to_election_id) {
    return { status: "failed", message: `前後兩任是同一人（${from.name}）同一屆，不是交接` };
  }

  let q = supabase.from("handovers").select("*").eq("lineage_id", lineageId).eq("from_politician_id", from.id).eq("to_politician_id", to.id);
  q = values.from_election_id === null ? q.is("from_election_id", null) : q.eq("from_election_id", values.from_election_id);
  q = values.to_election_id === null ? q.is("to_election_id", null) : q.eq("to_election_id", values.to_election_id);
  const { data: current, error: currentError } = await q.maybeSingle();
  throwIf(currentError, "handovers read");
  const phrase = `${from.name} → ${to.name}：${HANDOVER_TYPE_LABEL[values.handover_type as HandoverType] ?? values.handover_type}`;
  if (!current) {
    const { data: inserted, error } = await supabase.from("handovers").insert({ lineage_id: lineageId, ...values, contribution_id: row.id }).select("*").maybeSingle();
    throwIf(error, "handovers insert");
    if (!inserted) throw new Error("handovers insert 沒有回傳 id");
    await recordInsert(supabase, ctx, "handovers", String(inserted.id), inserted);
    return { status: "applied", message: `脈絡「${lineage.title}」記下交接：${phrase}` };
  }
  const fields = changedLineageFields(current as Obj, values, [...HANDOVER_FIELDS]);
  if (fields.length === 0) return { status: "superseded", message: `脈絡「${lineage.title}」已經有一樣的交接（${phrase}），不重複寫入` };
  const patch: Obj = Object.fromEntries(fields.map((f) => [f, values[f]]));
  const { error } = await supabase.from("handovers").update({ ...patch, contribution_id: row.id }).eq("id", (current as Obj).id);
  throwIf(error, "handovers update");
  for (const f of fields) await recordUpdate(supabase, ctx, "handovers", String((current as Obj).id), f, (current as Obj)[f] ?? null, values[f]);
  return { status: "applied", message: `脈絡「${lineage.title}」的交接已更正：${phrase}` };
}

/** 記脈絡關聯：一對上下級只有一筆，重交＝覆蓋；上級要在下級的上一層 */
async function applyLineageLink(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const values = linkValues(p, row.source_urls);
  const upperId = values.upper_lineage_id.toLowerCase(), lowerId = values.lower_lineage_id.toLowerCase();
  // query-bounds: ok — 兩條脈絡
  const { data: rows, error: readError } = await supabase.from("lineages").select("id, title, level, region, sub_region").in("id", [upperId, lowerId]).limit(2);
  throwIf(readError, "lineages read");
  const upper = ((rows ?? []) as Obj[]).find((r) => String(r.id).toLowerCase() === upperId);
  const lower = ((rows ?? []) as Obj[]).find((r) => String(r.id).toLowerCase() === lowerId);
  if (!upper || !lower) return { status: "failed", message: `找不到脈絡 ${!upper ? upperId : lowerId}` };
  const problem = linkLevelProblem(upper, lower);
  if (problem) return { status: "failed", message: problem };

  const { data: current, error: currentError } = await supabase.from("lineage_links").select("*").eq("upper_lineage_id", upperId).eq("lower_lineage_id", lowerId).maybeSingle();
  throwIf(currentError, "lineage_links read");
  const writeValues = { ...values, upper_lineage_id: upperId, lower_lineage_id: lowerId };
  const phrase = `「${upper.title}」→「${lower.title}」：${LINK_TYPE_LABEL[values.link_type as LinkType] ?? values.link_type}`;
  let message: string;
  if (!current) {
    const { data: inserted, error } = await supabase.from("lineage_links").insert({ ...writeValues, contribution_id: row.id }).select("*").maybeSingle();
    throwIf(error, "lineage_links insert");
    if (!inserted) throw new Error("lineage_links insert 沒有回傳 id");
    await recordInsert(supabase, ctx, "lineage_links", String(inserted.id), inserted);
    message = `記下上下級關聯：${phrase}`;
  } else {
    const fields = changedLineageFields(current as Obj, writeValues, [...LINK_FIELDS]);
    if (fields.length === 0) {
      const reviewed = await recordCandidateReview(supabase, row, str(p.note));
      return { status: "superseded", message: `已經有一樣的關聯（${phrase}），不重複寫入${reviewed ? "；這份候選清單記為已看過" : ""}` };
    }
    const patch: Obj = Object.fromEntries(fields.map((f) => [f, writeValues[f]]));
    const { error } = await supabase.from("lineage_links").update({ ...patch, contribution_id: row.id }).eq("id", (current as Obj).id);
    throwIf(error, "lineage_links update");
    for (const f of fields) await recordUpdate(supabase, ctx, "lineage_links", String((current as Obj).id), f, (current as Obj)[f] ?? null, writeValues[f]);
    message = `上下級關聯已更正：${phrase}`;
  }
  const reviewed = await recordCandidateReview(supabase, row, str(p.note));
  return { status: "applied", message: `${message}${reviewed ? "；這份候選清單記為已看過，有新的上級脈絡才會再派" : ""}` };
}

/** correction：一筆可改多個欄位（changes[]），逐欄套用、各寫一筆 edit_history；舊的單欄位格式由 normalizeCorrection 相容 */
// 空字串在 DATE 欄位會讓 PostgreSQL 直接報錯，而「查不到提出日期」是合法狀態，
// 所以清空一律轉成 null。分類則順手正規化成 19 個正式名稱之一。
export function correctionValue(table: string, field: string, value: unknown): unknown {
  if (table === "policies" && field === "category") return normalizeCategory(String(value)) ?? value;
  if (table === "policies" && field === "proposed_date" && (value === undefined || value === null || value === "")) return null;
  if (table === "politicians" && field === "avatar_url" && typeof value === "string" && value) return normalizeAvatarUrl(value);
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
  // 任期的卸任日要連根據一起看（#345 後續）；參選紀錄改 confirmed 要知道是哪一屆、哪種選舉（名單公告了沒）
  const extraRead = table === "politician_offices" ? ["end_date", "end_reason", "end_basis", "source_url"]
    : table === "politician_elections" ? ["election_id", "election_type", "candidacy_status"] : [];
  const readCols = [...new Set(["id", ...fields, ...extraRead])];
  const { data: current, error: readError } = await supabase.from(table).select(readCols.join(", ")).eq("id", target_id).maybeSingle();
  throwIf(readError, `${table} read`);
  if (!current) return { status: "failed", message: `${table} 找不到 id=${target_id}` };

  const patch: Obj = Object.fromEntries(changes.map((c) => [c.field, correctionValue(table, c.field, c.correct_value)]));
  // confirmed 收窄（#345 後續）：正式名單公告後（含已投票屆別）改成 confirmed 的，記成 qualified
  let narrowNote = "";
  if (table === "politician_elections" && patch.candidate_status === "confirmed") {
    const cur = current as { election_id?: number; election_type?: string | null; candidate_status?: string | null };
    const n = narrowConfirmed("confirmed", await isListPublished(supabase, Number(cur.election_id), cur.election_type), cur.candidate_status);
    if (n.converted) { patch.candidate_status = n.status; narrowNote = CONFIRMED_NARROWED_NOTE; }
  }
  // 退選前有沒有登記（#345 後續，協議 1.55.0）只在退選的紀錄上有值（資料庫 CHECK）：等票期間這一列被改成不是退選
  // （例如有人補成已登記），這筆就沒有東西可改了——標 superseded，不讓 CHECK 炸成 apply_failed 一直重試
  if (table === "politician_elections" && "withdrawn_after_filing" in patch) {
    const cur = current as { candidacy_status?: string | null };
    if (cur.candidacy_status !== "withdrawn") {
      return {
        status: "superseded",
        message: `這筆參選紀錄現在不是退選（candidacy_status＝${cur.candidacy_status ?? "空的"}），「退選前有沒有登記」沒有東西可改；他在名冊上、還在選的話，狀態已經有人改過了`,
      };
    }
  }
  // 任期的卸任日附出處更正（#345 後續：轉任的卸任日是推定的）：在任中的要連原因一起給（資料庫 CHECK 卸任日與原因成對）
  let officeExtra: Obj = {};
  if (table === "politician_offices" && ("end_date" in patch || "end_reason" in patch)) {
    const cur = current as { end_date?: string | null; end_reason?: string | null };
    const endDate = "end_date" in patch ? patch.end_date : cur.end_date;
    const endReason = "end_reason" in patch ? patch.end_reason : cur.end_reason;
    if (!endDate || !endReason) {
      return { status: "failed", message: "任期更正要同時有卸任日（end_date）與卸任原因（end_reason）：在任中的任期兩欄都要給" };
    }
    officeExtra = { end_basis: "source", source_url: row.source_urls?.[0] ?? null };
  }
  // 照片形狀守門（2026-09-19）：只改照片而照片不合格就退成爭議，理由帶回 fix_disputed 任務；連同別的欄位一起改就只跳過照片
  let avatarNote = "";
  if (table === "politicians" && typeof patch.avatar_url === "string" && patch.avatar_url) {
    const problem = await checkAvatarUrl(patch.avatar_url);
    if (problem) {
      if (Object.keys(patch).length === 1) return { status: "disputed", message: `照片不能用：${problem}` };
      delete patch.avatar_url; avatarNote = `；照片沒套用：${problem}`;
    }
  }
  // #3／#6（2026-09-22）：等票期間別人可能先修好了。全部一樣 → superseded，不寫假的 edit_history；
  // 部分一樣 → 只改真的會改的欄位，一樣的那幾欄寫進訊息讓提交者知道。
  const { changed, noop } = splitNoOpChanges(patch, current as Record<string, unknown>);
  if (Object.keys(changed).length === 0) {
    return { status: "superseded", message: `${table} 的 ${noop.join("、")} 現值已經跟這筆更正一樣（別人先修好了），不重複寫入` };
  }
  // 任期：卸任日或原因真的有改才把根據換成「有出處」
  const extra: Obj = table === "politician_offices" && ("end_date" in changed || "end_reason" in changed)
    ? Object.fromEntries(Object.entries(officeExtra).filter(([k, v]) => (current as Obj)[k] !== v))
    : {};
  const { error } = await supabase.from(table).update({ ...changed, ...extra, ...(table === "politician_offices" ? { updated_at: new Date().toISOString() } : {}) }).eq("id", target_id);
  throwIf(error, `${table} correction update`);
  const applied: string[] = [];
  if (noop.length > 0) avatarNote += `；${noop.join("、")} 現值已相同，略過`;
  avatarNote += narrowNote;
  for (const [field, newValue] of Object.entries({ ...changed, ...extra })) {
    await recordUpdate(supabase, ctx, table, String(target_id), field, current[field] ?? null, newValue);
    applied.push(`${field}：「${current[field] ?? ""}」→「${newValue === null ? "（清空）" : String(newValue)}」`);
  }
  return {
    status: "applied",
    message: `${table} 更正 ${applied.length} 個欄位：${applied.join("；")}${avatarNote}`,
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
  // 同一任務、同一來源交的參選紀錄裡，系統逐位核對過中選會名冊的，整批放行（2026-09-24，migration 20260924000013）
  let batchApproved = 0;
  {
    const { data: n, error: bErr } = await supabase.rpc("roster_batch_approve", { p_roster_id: row.id });
    if (!bErr && typeof n === "number") batchApproved = n;
  }
  const cec = int(p.cec_count);
  const done = cec !== null && cec !== undefined;
  const message = done
    ? `${region} ${electionId} ${electionType} 名單已清查：中選會 ${cec} 人、我們 ${int(p.ours_count) ?? "?"} 人、另外補交 ${int(p.submitted) ?? 0} 筆${batchApproved > 0 ? `；其中 ${batchApproved} 筆經系統逐位核對名冊、整批放行` : ""}`
    : `已記錄你這次的嘗試：${region} ${electionId} ${electionType} 查不到官方名單，所以還沒算清查完成，這個縣市明天會再派給別人試`;
  return { status: "applied", message };
}

/**
 * 應選名額（#344，2026-10-06）：照選舉公告把一個縣市、一種選舉每個選舉區的名額寫進 election_districts。
 *
 * - 既有的選舉區（選舉區對照表、中選會名單同步建的）只改 seats／seats_basis／seats_source，一次 UPDATE 三欄
 *   （表的 CHECK 要求名額與依據同時有值）；每一欄各寫一筆 edit_history，還原時併回一次 UPDATE（edit-history.ts）
 * - 公告上有、我們沒有的（多半是原住民選舉區、2026 新竹縣議員）新增一列
 * - 法律定死的名額（seats_basis=law）不讓交件覆蓋；名額一樣的不重寫（不洗掉第一個出處）
 * - 代表的選舉區要落在這個縣市真的有的鄉鎮市區裡（看同一屆鄉鎮市長／原住民區長的選舉區），打錯字的鄉鎮整筆退件
 */
async function applyDistrictSeats(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const electionId = int(p.election_id);
  const electionType = str(p.election_type);
  const region = str(p.region);
  if (!electionId || !electionType || !region || !(DISTRICT_SEAT_TYPES as readonly string[]).includes(electionType)) {
    return { status: "failed", message: "缺 election_id／election_type／region，或選舉別不是議員或代表" };
  }
  const source = row.source_urls[0] ?? null;
  const districts: SeatInput[] = [];
  for (const d of (Array.isArray(p.districts) ? p.districts : []) as Obj[]) {
    const name = normalizeSeatDistrict(electionType, d?.district);
    const seats = int(d?.seats);
    if (!name || !seats) return { status: "disputed", message: `選舉區「${String(d?.district ?? "")}」或名額看不懂` };
    districts.push({ district: name, seats, ...(typeof d.kind === "string" ? { kind: d.kind as DistrictSeatKind } : {}) });
  }
  if (districts.length === 0) return { status: "disputed", message: "districts 是空的" };

  // query-bounds: ok — 一個縣市一種選舉的選舉區（彰化縣代表約百區），上限 1000
  const { data: existing, error: readError } = await supabase.from("election_districts")
    .select("id, sub_region, village, district_kind, seats, seats_basis, seats_source")
    .eq("election_id", electionId).eq("election_type", electionType).eq("region", region)
    .limit(1000);
  throwIf(readError, "election_districts read");

  if (electionType !== "縣市議員") {
    // 代表的選舉區要落在真的有的鄉鎮市區：鄉鎮市民代表看鄉鎮市長、原住民區民代表看原住民區長的選舉區
    const headType = electionType === "鄉鎮市民代表" ? "鄉鎮市長" : "直轄市山地原住民區長";
    // query-bounds: ok — 一個縣市的鄉鎮市區（最多 33 個）
    const { data: heads, error: headError } = await supabase.from("election_districts")
      .select("sub_region").eq("election_id", electionId).eq("election_type", headType).eq("region", region).limit(200);
    throwIf(headError, "election_districts towns read");
    const towns = new Set(((heads ?? []) as Obj[]).map((h) => str(h.sub_region)).filter((t): t is string => !!t));
    const stray = districts.map((d) => d.district).filter((sub) => !towns.has(seatDistrictTown(sub) ?? ""));
    if (towns.size === 0) return { status: "disputed", message: `${region} ${electionId} 沒有${headType}的選舉區可以對照鄉鎮，這種選舉不在這個縣市` };
    if (stray.length > 0) return { status: "disputed", message: `這些選舉區的鄉鎮市區不在 ${region}：${stray.join("、")}` };
  }

  const plan = planDistrictSeats((existing ?? []) as ExistingDistrict[], districts);
  if (plan.updates.length === 0 && plan.inserts.length === 0) {
    return { status: "superseded", message: `${region} ${electionId} ${electionType} 這幾區的名額現值已經一樣（別人先補好了），不重複寫入` };
  }
  for (const u of plan.updates) {
    const patch = { seats: u.seats, seats_basis: "cec_notice", seats_source: source };
    const { error } = await supabase.from("election_districts").update(patch).eq("id", u.id);
    throwIf(error, "election_districts update");
    for (const [field, value] of Object.entries(patch)) {
      const old = u.old[field as keyof typeof u.old] ?? null;
      if (old !== value) await recordUpdate(supabase, ctx, "election_districts", String(u.id), field, old, value);
    }
  }
  for (const ins of plan.inserts) {
    const { data: created, error } = await supabase.from("election_districts").insert({
      election_id: electionId, election_type: electionType, district_kind: ins.kind, region, sub_region: ins.district,
      seats: ins.seats, seats_basis: "cec_notice", seats_source: source,
    }).select("*").maybeSingle();
    throwIf(error, "election_districts insert");
    if (!created) throw new Error("election_districts insert 沒有回傳");
    await recordInsert(supabase, ctx, "election_districts", String(created.id), created);
  }
  const notes = [
    plan.locked.length > 0 ? `法律定死的名額不改：${plan.locked.join("、")}` : "",
    plan.kind_mismatch.length > 0 ? `選舉區種類跟我們記的不同、沒改：${plan.kind_mismatch.join("、")}` : "",
    plan.still_missing.length > 0 ? `這個縣市還有 ${plan.still_missing.length} 區沒有名額：${plan.still_missing.slice(0, 20).join("、")}` : "",
  ].filter(Boolean);
  return {
    status: "applied",
    message: `${region} ${electionId} ${electionType} 應選名額：更新 ${plan.updates.length} 區、新增 ${plan.inserts.length} 區、${plan.unchanged.length} 區原本就一樣` +
      (notes.length > 0 ? `；${notes.join("；")}` : ""),
  };
}

/**
 * 政黨資訊的那幾個政黨，連前身往上追幾代（看得出改名鏈有沒有繞圈）。找不到的就不在 Map 裡。
 * 交件時的前置檢查（apply-precheck.ts）與落庫共用。
 */
export async function loadPartyChain(supabase: SupabaseLike, ids: readonly number[]): Promise<Map<number, PartyRow>> {
  const rows = new Map<number, PartyRow>();
  const tried = new Set<number>();
  let want = [...new Set(ids)];
  for (let depth = 0; want.length > 0 && depth < 10; depth++) {
    for (const id of want) tried.add(id);
    // query-bounds: ok — 一筆最多 5 個政黨（＋各自的前身），往上追每一代也只有幾個
    const { data, error } = await supabase.from("parties").select("id, name, valid_from, valid_to, predecessor_id").in("id", want).limit(50);
    throwIf(error, "parties read");
    for (const r of (data ?? []) as Obj[]) {
      rows.set(Number(r.id), {
        id: Number(r.id), name: String(r.name ?? ""), valid_from: (r.valid_from as string | null) ?? null, valid_to: (r.valid_to as string | null) ?? null,
        predecessor_id: r.predecessor_id === null || r.predecessor_id === undefined ? null : Number(r.predecessor_id),
      });
    }
    want = missingAncestors(rows).filter((id) => !tried.has(id));
  }
  return rows;
}

const PARTY_FIELD_LABEL: Record<string, string> = { valid_from: "名稱起始日", valid_to: "名稱停用日", predecessor_id: "前身" };

/**
 * 政黨資訊（#346 第二階段，協議 1.56.0）：改名的前身與名稱起訖、解散日、名冊外政黨的對應，寫進 parties。
 *
 * - 一個政黨一次 UPDATE（parties 的 CHECK 要求 valid_to ≥ valid_from）；每一欄一筆 edit_history，還原時併回一次 UPDATE（edit-history.ts）
 * - 值一樣的不重寫；找不到政黨、前身往上追會繞回自己、改完起訖顛倒的，整筆不寫（disputed，講清楚是哪一個）
 * - 名稱、名冊狀態照內政部名冊（scripts/fetch-moi-parties.py），交件改不了
 * - 出處由資料庫觸發器在落庫後掛到 source_refs（migration 20261006100100），這裡不另外寫
 */
async function applyPartyInfo(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const items = partyInfoItems(row.payload);
  if (items.length === 0) return { status: "failed", message: "party_info 要帶 parties（每個政黨一項）" };
  const rows = await loadPartyChain(supabase, partyInfoIds(items));
  const plan = planPartyInfo(rows, items);
  if (plan.problems.length > 0) return { status: "disputed", message: plan.problems.join("；") };
  if (plan.updates.length === 0) {
    return { status: "superseded", message: `這幾個政黨的資料現值已經一樣（${plan.unchanged.join("、")}，別人先補好了），不重複寫入` };
  }
  const ctx = ctxOf(row);
  const done: string[] = [];
  for (const u of plan.updates) {
    const { error } = await supabase.from("parties").update(u.patch).eq("id", u.id);
    throwIf(error, "parties update");
    for (const [field, value] of Object.entries(u.patch)) {
      await recordUpdate(supabase, ctx, "parties", String(u.id), field, u.old[field as keyof typeof u.old] ?? null, value);
    }
    done.push(`${u.name}（${u.id}）${Object.entries(u.patch).map(([f, v]) => `${PARTY_FIELD_LABEL[f] ?? f}「${u.old[f as keyof typeof u.old] ?? ""}」→「${v}」`).join("、")}`);
  }
  return {
    status: "applied",
    message: `政黨資訊更新 ${plan.updates.length} 個政黨：${done.join("；")}${plan.unchanged.length > 0 ? `；${plan.unchanged.join("、")} 現值已相同，略過` : ""}；出處掛到這幾個政黨（臉書、IG、Threads 不算）`,
  };
}

/**
 * 整批補已投票選舉的結果（2026-10-06）：一個單位一筆，items 每位寫一次 politician_elections.election_result。
 *
 * - **只補空白、不覆蓋**（planElectionResults）：已經有不同結果的那一位跳過、回覆講出來（要改走一位一筆的 candidacy／correction）
 * - 參選紀錄不是這一屆這種選舉的跳過（交件已擋過，等票期間被改了才會碰到）
 * - 同一個結果寫一次 UPDATE（當選一批、落選一批），每一位各記一筆 edit_history，整筆可還原
 * - 參選狀態（candidacy_status）由 #376 的觸發器同步、任期由 #377 的觸發器建，這裡不另外寫
 */
async function applyElectionResults(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const electionId = int(p.election_id);
  const electionType = str(p.election_type);
  const items = resultItems(p);
  if (!electionId || !electionType || items.length === 0) return { status: "failed", message: "缺 election_id／election_type，或 items 是空的" };

  // query-bounds: ok — 一筆最多 MAX_RESULTS_PER_SUBMISSION（120）位，按主鍵取
  const { data: existing, error: readError } = await supabase.from("politician_elections")
    .select("id, election_id, election_type, election_result")
    .in("id", items.map((it) => it.politician_election_id)).limit(MAX_RESULTS_PER_SUBMISSION + 10);
  throwIf(readError, "politician_elections read");
  const plan = planElectionResults((existing ?? []) as ExistingCandidacy[], items, electionId, electionType);
  if (plan.writes.length === 0) {
    const why = [
      plan.unchanged.length > 0 ? `${plan.unchanged.length} 位已經是同一個結果（別人先補了）` : "",
      plan.conflicts.length > 0 ? `${plan.conflicts.length} 位已經有不同的結果，沒有覆蓋` : "",
      plan.stray.length > 0 ? `${plan.stray.length} 位的參選紀錄不是這一屆這種選舉` : "",
    ].filter(Boolean).join("、");
    return { status: "superseded", message: `這一筆沒有要寫的：${why || "沒有結果空白的人"}` };
  }
  const before = new Map(((existing ?? []) as ExistingCandidacy[]).map((e) => [e.id, e.election_result ?? null]));
  const written: Array<{ id: number; election_result: string }> = [];
  for (const result of ["elected", "not_elected"] as const) {
    const ids = plan.writes.filter((w) => w.election_result === result).map((w) => w.id);
    if (ids.length === 0) continue;
    // 只寫還空著的（等票期間別人可能先補了；照 is null 再篩一次，不覆蓋）
    // 履歷只記真的寫進去的那幾列
    const { data: updated, error } = await supabase.from("politician_elections").update({ election_result: result })
      .in("id", ids).is("election_result", null).select("id");
    throwIf(error, "politician_elections results update");
    for (const u of (updated ?? []) as Array<{ id: number }>) {
      written.push({ id: u.id, election_result: result });
      await recordUpdate(supabase, ctx, "politician_elections", String(u.id), "election_result", before.get(u.id) ?? null, result);
    }
  }
  if (written.length === 0) return { status: "superseded", message: `${resultsUnitLabel(p)} 這幾位的結果在等票期間已經被別人補上了，不重複寫入` };
  const elected = written.filter((w) => w.election_result === "elected").length;
  const notes = [
    plan.unchanged.length > 0 ? `${plan.unchanged.length} 位已經是同一個結果、略過` : "",
    plan.conflicts.length > 0 ? `${plan.conflicts.length} 位已經有不同的結果、沒有覆蓋（參選紀錄 ${plan.conflicts.map((c) => c.id).join("、")}；要改請一位一筆用 candidacy 交）` : "",
    plan.stray.length > 0 ? `${plan.stray.length} 位的參選紀錄不是這一屆這種選舉、略過（${plan.stray.join("、")}）` : "",
  ].filter(Boolean);
  return {
    status: "applied",
    message: `${resultsUnitLabel(p)} 選舉結果已補 ${written.length} 位（當選 ${elected}、落選 ${written.length - elected}）${notes.length > 0 ? `；${notes.join("；")}` : ""}`,
  };
}

/**
 * 同名人物接錯：一筆參選紀錄改掛到正確的人（2026-10-06，reassign_candidacy）。
 *
 * - 交件時檢查過的（同名、不是同一人、出處的出生年對得上、改掛後同一屆不會有兩筆）落庫前再檢查一次——等票期間資料可能變了
 * - 新建的人照一般建人物的路（ensurePolitician force_new），整列記 edit_history
 * - UPDATE politician_elections.politician_id（只在還掛著原本那位時改），記 edit_history；兩人記成「不同人」（同名清查不再配這一對）
 * - 人物的衍生欄位（最新一屆）、任期由既有觸發器跟著 politician_id 的變動重算
 * - 整筆還原：參選紀錄改回原本那位、不同人的判定刪掉、新建的人刪掉
 */
async function applyReassignCandidacy(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const rc = await loadReassignContext(supabase, p);
  // 等票期間這筆被改掛、合併過：現在掛的已經不是交件時那位 → 不蓋過去
  const claimedFrom = str(p.from_politician_id);
  if (rc.pe && claimedFrom && rc.pe.politician_id.toLowerCase() !== claimedFrom.toLowerCase()) {
    return { status: "superseded", message: `參選紀錄 ${rc.pe.id} 現在掛的已經不是 ${claimedFrom}（等票期間被改過），這筆不重複改` };
  }
  const problems = reassignProblems(rc, p);
  if (problems.length > 0) return { status: "disputed", message: `這筆不能改掛：${problems.map((x) => x.message).join("；")}` };
  const pe = rc.pe!, from = rc.from!, to = rc.to!;
  let toId = to.id;
  let created = false;
  if (!toId) {
    const n = (p.new_politician ?? {}) as Obj;
    const ensured = await ensurePolitician(supabase, {
      name: String(n.name ?? to.name),
      party: str(n.party),
      // politicians.region、party、position 都是 NOT NULL：縣市不填就用這筆參選紀錄的縣市
      region: str(n.region) ?? pe.county ?? from.region ?? null,
      election_type: pe.election_type,
      position: pe.position ?? `${pe.election_type ?? ""}候選人`,
      birth_year: int(n.birth_year),
    }, { source: `contribution:${row.id}`, force_new: true });
    if (!ensured.politician_id) return { status: "failed", message: "新建人物失敗" };
    toId = ensured.politician_id;
    created = true;
    await recordCreatedPolitician(supabase, ctx, toId);
  }
  // 只在還掛著原本那位時改：等票期間被別人改掛、合併過的，不蓋過去
  const { data: moved, error } = await supabase.from("politician_elections").update({ politician_id: toId })
    .eq("id", pe.id).eq("politician_id", pe.politician_id).select("id");
  throwIf(error, "politician_elections reassign");
  if (!moved || (moved as unknown[]).length === 0) {
    return { status: "superseded", message: `參選紀錄 ${pe.id} 已經不掛在 ${from.name}（${pe.politician_id}）身上了（等票期間被改過），不重複改` };
  }
  await recordUpdate(supabase, ctx, "politician_elections", String(pe.id), "politician_id", pe.politician_id, toId);
  // 兩人記成「不同人」：同名清查（duplicate_politician）不再把這一對配起來；還原時刪掉（record_id 是那一列的 id）
  if (rc.pair_resolution === null) {
    const [a, b] = [pe.politician_id, toId].sort();
    const { data: res, error: resError } = await supabase.from("politician_pair_resolutions")
      .upsert({ pair_key: `${a}|${b}`, a, b, resolution: "different", contribution_id: row.id }, { onConflict: "pair_key" })
      .select("*").maybeSingle();
    throwIf(resError, "politician_pair_resolutions upsert");
    if (res && typeof (res as Obj).id === "string") await recordInsert(supabase, ctx, "politician_pair_resolutions", String((res as Obj).id), res as Obj);
  }
  // 舊的人名下同一屆的政見不會跟著搬：講出來，要不要搬由人判斷
  // query-bounds: ok — 只要筆數
  const { count: policyCount } = await supabase.from("policies").select("id", { count: "exact", head: true })
    .eq("politician_id", pe.politician_id).eq("election_id", pe.election_id).is("removed_at", null);
  const policyNote = policyCount && policyCount > 0
    ? `；${from.name} 名下還有 ${policyCount} 筆 ${pe.election_id} 的政見沒有跟著搬，若也是掛錯請另外處理`
    : "";
  return {
    status: "applied",
    politician_id: toId,
    created_politician: created,
    message: `參選紀錄 ${pe.id}（${pe.election_id} ${pe.election_type ?? ""}）已從 ${personLabel(from)} 改掛到 ${personLabel({ ...to, id: toId })}${created ? "（新建）" : ""}；兩人已記為不同人${policyNote}`,
  };
}

/**
 * 移除一筆明顯不該存在的資料。
 *
 * 刻意做成軟移除：打上 removed_at 讓它從網站消失，資料與整條查核履歷都留著。
 * 因為救得回來，門檻才敢訂 3 票而不是比照加減參選人的 4～8 票。
 * 每一次移除都寫 edit_history，所以 apply 的 revert 可以整筆倒回。
 */
/**
 * 同名人物（2026-09-19）：same_person=true → SQL merge_politician 軟合併；false → 記 politician_pair_resolutions 為 different，
 * duplicate_politician 任務就不再派這一對。合併本身在 SQL 一個交易裡做完。
 */
async function applyMergePolitician(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const keep = str(p.keep_id), remove = str(p.remove_id);
  if (!keep || !remove) return { status: "failed", message: "缺 keep_id／remove_id" };
  if (p.same_person === false) {
    const [a, b] = [keep, remove].sort();
    // 「不同人」跟合併一樣是永久決定：寫下去之後 duplicate_politician 就不再派這一對，
    // 沒有冷卻、沒有重查。所以它必須跟 same 分支一樣留查核履歷，否則 planRevert 救不回來——
    // 那會是全站唯一一個「判錯了、連還原都沒有」的動作（2026-09-21 子代理掃出來的）。
    const { data: resolution, error } = await supabase.from("politician_pair_resolutions")
      .upsert({ pair_key: `${a}|${b}`, a, b, resolution: "different", contribution_id: row.id }, { onConflict: "pair_key" })
      .select("*").maybeSingle();
    if (error) return { status: "failed", message: `pair_resolutions upsert: ${error.message}` };
    // record_id 要傳這一列的 id（UUID）而不是 pair_key：executeRevert 的 delete 寫死 .eq("id", record_id)，
    // SQL 版 merge 的 same 分支也是照這個約定記的。
    if (resolution && typeof (resolution as Obj).id === "string") {
      await recordInsert(supabase, ctxOf(row), "politician_pair_resolutions", String((resolution as Obj).id), resolution as Obj);
    }
    return { status: "applied", message: `已記為不同人：${keep.slice(0, 8)} 與 ${remove.slice(0, 8)}，這一對不再派任務（判錯的話這筆可以整筆還原）` };
  }
  const { data, error } = await supabase.rpc("merge_politician", { p_keep: keep, p_remove: remove, p_contribution: row.id, p_agent: row.agent_name });
  if (error) return { status: "failed", message: `merge_politician: ${error.message}` };
  const r = (data ?? {}) as { moved_policies?: number; moved_elections?: number; filled?: string[] };
  return {
    status: "applied", politician_id: keep, created_politician: false,
    message: `已合併：${remove.slice(0, 8)} 併入 ${keep.slice(0, 8)}（搬 ${r.moved_policies ?? 0} 筆政見、${r.moved_elections ?? 0} 筆參選${(r.filled ?? []).length ? `，補上 ${(r.filled ?? []).join("、")}` : ""}）`,
  };
}

async function applyRemoval(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const p = row.payload;
  const ctx = ctxOf(row);
  const table = str(p.target_table);
  const targetId = str(p.target_id);
  if (table === "politicians") return await applyPoliticianRemoval(supabase, row);
  if (table !== "policies") return { status: "failed", message: `目前只能移除政見或人物，收到 ${table}` };
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

/**
 * 移除人物（2026-10-06）擋在什麼情況：只收測試資料、查無此人這種——它身上不能掛著任何真的內容。
 * 有政見（含已移除的）、任期、學經歷、公民提問、政策脈絡的角色或交接、或別人併進來的，都不是「不存在的人」，
 * 要嘛是同一人重複（走 merge_politician），要嘛是資料錯（走 correction）。交件前置檢查（apply-precheck.ts）與落庫共用。
 * 回傳擋下的理由；空陣列＝可以移除。
 */
export async function politicianRemovalBlockers(supabase: SupabaseLike, politicianId: string): Promise<string[]> {
  const checks: Array<[string, string, string]> = [
    ["policies", "politician_id", "政見"],
    ["politician_offices", "politician_id", "任期"],
    ["politician_careers", "politician_id", "學經歷"],
    ["citizen_questions", "politician_id", "公民提問"],
    ["lineage_participants", "politician_id", "政策脈絡的角色"],
    ["handovers", "from_politician_id", "政策脈絡的交接"],
    ["handovers", "to_politician_id", "政策脈絡的交接"],
    ["politicians", "merged_into", "併進來的人物"],
  ];
  const out: string[] = [];
  for (const [table, col, label] of checks) {
    // query-bounds: ok — 只看有沒有（head＋count），不撈列
    const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true }).eq(col, politicianId);
    throwIf(error, `${table} count`);
    if ((count ?? 0) > 0 && !out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * 移除人物（測試資料、查無此人；2026-10-06 主線裁定「測試候選人」走 removal 流程，不直接刪）：
 * 他的參選紀錄與人物本身整列刪掉，每一列整列寫進 edit_history（old＝整列、new＝null），還原時整列放回去——
 * 先記參選紀錄、最後記人物，還原由新到舊，所以人物先回去、參選紀錄再回去（外鍵）。
 * 身份鍵（politician_keys）隨人物連帶刪掉，人物放回去時由觸發器重建。
 */
async function applyPoliticianRemoval(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const ctx = ctxOf(row);
  const targetId = str(row.payload.target_id);
  if (!targetId) return { status: "failed", message: "缺 target_id" };
  const { data: person, error: readError } = await supabase.from("politicians").select("*").eq("id", targetId).maybeSingle();
  throwIf(readError, "politicians read");
  if (!person) return { status: "superseded", message: `人物 ${targetId} 已經不在了（先前移除或合併過），不重複處理` };
  const blockers = await politicianRemovalBlockers(supabase, targetId);
  if (blockers.length > 0) {
    return { status: "disputed", message: `「${person.name}」身上還有${blockers.join("、")}，不是查無此人的資料，不能整個移除；同一人重複請用 merge_politician，資料錯請用 correction` };
  }
  // query-bounds: ok — 一個人的參選紀錄（一屆一筆）
  const { data: elections, error: peError } = await supabase.from("politician_elections").select("*").eq("politician_id", targetId).limit(50);
  throwIf(peError, "politician_elections read");
  for (const pe of (elections ?? []) as Obj[]) {
    await recordUpdate(supabase, ctx, "politician_elections", String(pe.id), "*", pe, null);
    const { error } = await supabase.from("politician_elections").delete().eq("id", pe.id);
    throwIf(error, "politician_elections delete");
  }
  await recordUpdate(supabase, ctx, "politicians", targetId, "*", person, null);
  const { error: delError } = await supabase.from("politicians").delete().eq("id", targetId);
  throwIf(delError, "politicians delete");
  return {
    status: "applied",
    message: `「${person.name}」已移除（人物與 ${(elections ?? []).length} 筆參選紀錄整列留在查核履歷，可還原）：${str(row.payload.reason) ?? ""}`,
  };
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
/** 跟 SQL 的 task_unreachable_cooldown_days() 同一個數字；「我拿不到來源」是換人再試，不是結案 */
export const TASK_UNREACHABLE_COOLDOWN_DAYS = 2;

async function applyNoChange(supabase: SupabaseLike, row: ContributionRow): Promise<ApplyOutcome> {
  const taskId = str(row.payload.task_id);
  if (!taskId) return { status: "failed", message: "no_change 要帶 task_id" };
  // 舊資料：交件端 09-25 前不核格式，自己組的 task_id 會在關任務時炸 uuid 錯、重試到退件。沒有對應的任務就沒東西可關
  if (!taskId.startsWith("auto:") && !isTaskIdShape(taskId)) return { status: "superseded", message: `task_id「${taskId}」不是 /next 給的任務編號，沒有可關的任務，不重試` };
  if (taskId.startsWith("auto:")) {
    // 自動缺口不是靠關閉任務消失的，它是即時算出來的。所以「查過了、沒東西可補」
    // 原本完全不留痕跡，同一筆死路會被無限重派給每一個代理，每個人都白跑一次。
    // 記一筆 task_checks，冷卻期內不再派；過期再出現，因為世界會變。
    // outcome 決定這筆「查過」到底是哪一種主張；2026-09-21 之前的舊資料沒有這個欄位，
    // 一律當成「不是 confirmed」——不蓋章比誤蓋安全，章一蓋那筆政見就永遠不再被派。
    const outcome = str(row.payload.outcome) ?? null;
    const check = {
      task_id: taskId,
      agent_name: row.agent_name,
      note: str(row.payload.finding) ?? str(row.payload.note) ?? row.note ?? null,
      contribution_id: row.id,
      outcome,
    };
    const { error } = await supabase.from("task_checks").insert(check);
    throwIf(error, "task_checks insert");
    // 用 task_id 當紀錄鍵：這張表的 id 是流水號，回不回來都不影響還原，
    // 而 task_id 才是人看得懂、也是冷卻判斷用的那把鑰匙。
    await recordInsert(supabase, ctxOf(row), "task_checks", taskId, check);
    // 早期匯入核對（2026-09-20）：no_change 通過＝這筆政見查核過了。寫一列 policies.audit，
    // 頁面的「尚未查核」變「已查核」、legacy_audit 任務隨之消失（它的條件是「沒有任何查核履歷」）
    const legacy = /^auto:legacy_audit:([0-9a-f-]{36})$/i.exec(taskId);
    if (legacy && outcome !== "confirmed") {
      // 拿不到來源、或公開資料就是沒有：記下來進冷卻，但不可以宣稱核對過。
      // 蓋章的條件是「來源支持、資料無誤」，不是「有人回報過」。
      return {
        status: "applied",
        message: outcome === "unreachable"
          ? `已記錄「拿不到來源、未能確認」：這筆政見**不會**被標成已核對，${TASK_UNREACHABLE_COOLDOWN_DAYS} 天後會換人再試`
          : "已記錄「公開資料查不到」：這筆政見不會被標成已核對",
        task_id: taskId,
        // 這裡**不可以**回 policy_id：呼叫端會把它寫進 contributions.applied_policy_id，
        // 而那個欄位是 legacy_audit 的另一條永久排除條件。回了就等於「我沒確認」也能讓它消失。
      };
    }
    if (legacy) {
      const { data: pl } = await supabase.from("policies").select("id, source_url").eq("id", legacy[1]).maybeSingle();
      if (pl) {
        let host = String((pl as { source_url?: string }).source_url ?? "");
        try { host = new URL(host).hostname.replace(/^www\./, ""); } catch { /* 原樣 */ }
        const note = check.note ? `：${String(check.note).slice(0, 200)}` : "";
        await recordUpdate(supabase, ctxOf(row), "policies", legacy[1], "audit", null, `已核對來源 ${host}${note}`);
      }
      return { status: "applied", message: "已核對：這筆早期匯入的政見從「尚未查核」變成「已查核」", task_id: taskId, policy_id: legacy[1] };
    }
    // 政見重複清查（2026-09-21）：no_change 通過＝這個人目前這份清單已經逐組比對過、沒有重複。
    // 記進 policy_dupe_reviews（鍵是清單指紋）就永遠不再派——同一份清單 14 天後再問一次還是同一個答案。
    // 新增、編輯或移除任何一筆政見，指紋就變，任務自己重新出現。
    // 不參選重查（2026-09-21）：確認他確實不在登記名單上，才把這一列標成已核對。
    // 這個章的代價特別大——標成不參選之後，這個人的政見／基本資料／參選來源／選舉結果
    // 四種缺口都不會再被派，所以只有 confirmed 能蓋，而且走 recordUpdate 留履歷、可還原。
    // 參選紀錄的 id 是整數（auto:not_running_recheck:35043）。2026-10-06 前這裡寫成 uuid 的樣子，一筆都對不上——
    // 10-06 線上 72 筆「確實不在名單上」通過了，一筆都沒蓋到章（edit_history 的 verified 0 筆），同一列每 14 天又派一次（task_checks 的一般冷卻）
    const notRunning = /^auto:not_running_recheck:(\d+)$/.exec(taskId);
    if (notRunning) {
      if (outcome !== "confirmed") {
        return {
          status: "applied",
          message: "已記錄，但**沒有**把這筆參選紀錄標成已核對——只有 outcome=confirmed（對過官方登記名單、確認他不在上面）才會鎖住它",
          task_id: taskId,
        };
      }
      const { error: verifyError } = await supabase.from("politician_elections").update({ verified: true }).eq("id", notRunning[1]);
      throwIf(verifyError, "politician_elections verified");
      await recordUpdate(supabase, ctxOf(row), "politician_elections", notRunning[1], "verified", false, true);
      return {
        status: "applied",
        message: "已核對：這筆「不參選」對過官方登記名單了，不會再重派（判錯的話這筆可以還原）",
        task_id: taskId,
      };
    }
    const dupe = /^auto:duplicate_policy:([0-9a-f-]{36}):([0-9a-f]{8})$/i.exec(taskId);
    if (dupe && outcome !== "confirmed") {
      // 跟 legacy_audit 的章是同一個病（selkie 2026-09-21 指出）：policy_dupe_reviews 一寫下去，
      // 那份清單就永遠不再派。沒有真的逐組比對完（拿不到來源、只掃過去）就不該鎖住它。
      return {
        status: "applied",
        message: "已記錄，但**沒有**把這份政見清單標成已比對——只有 outcome=confirmed（逐組比對完、確認沒有重複）才會鎖住它",
        task_id: taskId,
        politician_id: dupe[1],
      };
    }
    if (dupe) {
      // 等票期間那個人可能被合併掉（輸家那筆刪除）：寫下去會撞外鍵、apply_failed 一直重試（2026-09-28 實例）
      const { data: person } = await supabase.from("politicians").select("id").eq("id", dupe[1]).maybeSingle();
      if (!person) return { status: "superseded", message: `人物 ${dupe[1]} 已不存在（多半是被合併了），這份清單沒得鎖，不重試` };
      const review ={ politician_id: dupe[1], fingerprint: dupe[2], agent_name: row.agent_name, contribution_id: row.id, note: check.note };
      const { error: dupeError } = await supabase.from("policy_dupe_reviews").upsert(review, { onConflict: "politician_id" });
      throwIf(dupeError, "policy_dupe_reviews upsert");
      await recordInsert(supabase, ctxOf(row), "policy_dupe_reviews", dupe[1], review);
      return { status: "applied", message: "已記錄：這個人目前這份政見清單已逐組比對過、沒有重複；清單有變動才會再派一次", task_id: taskId, politician_id: dupe[1] };
    }
    // 政策脈絡的候選清查（#349）：no_change confirmed＝這一格（或這份上級候選）整份比對過、沒有同一件事／沒有上下級關係。
    // 跟政見重複清查同一個做法：記進 lineage_candidate_reviews（鍵是清單指紋）就不再派，清單有變動才再派；
    // 沒有真的比對完（拿不到來源、查無）就不鎖，走一般的冷卻。
    const candidate = parseCandidateTaskId(taskId);
    if (candidate && outcome === "confirmed") {
      await upsertCandidateReview(supabase, row, { review_key: candidate.review_key, fingerprint: candidate.fingerprint, agent_name: row.agent_name, contribution_id: row.id, note: check.note });
      return {
        status: "applied",
        message: candidate.kind === "block"
          ? "已記錄：這一格的政見已逐組比對過、沒有同一件事；清單有變動才會再派"
          : "已記錄：這條脈絡跟這些上級脈絡逐條看過、沒有上下級關係；有新的上級脈絡才會再派",
        task_id: taskId,
      };
    }
    if (outcome === "unreachable") {
      return { status: "applied", message: `已記錄「拿不到來源、未能確認」，這筆缺口 ${TASK_UNREACHABLE_COOLDOWN_DAYS} 天後會換人再試（不是結案）`, task_id: taskId };
    }
    return { status: "applied", message: `已記錄「查過、無異動」，這筆缺口 ${TASK_CHECK_COOLDOWN_DAYS} 天內不會再派給任何人；期間資料若補齊也會自行消失`, task_id: taskId };
  }
  // 提問任務不因 no_change 關閉（2026-09-20）：關了就沒人再答，訪客永遠看到「正在查證」。新的 no_change 在 contribute 就會被擋，這裡守舊資料。
  // 這次查詢順便拿來判斷任務存不存在（unreachable 分支要用，不能只靠 closeTask 的回傳值判斷）。
  // 測試的假 supabase 只有 update／insert：查不到就當非提問、當任務不存在（真 DB 一定查得到）
  let manualTask: { task_type?: string } | null = null;
  try {
    // query-bounds: ok — 按 id 查一列（maybeSingle），鏈被拆開只是為了容忍測試的假 supabase
    const q = supabase.from("contribution_tasks") as { select?: (cols: string) => { eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: { task_type?: string } | null }> } } };
    if (typeof q.select === "function") manualTask = (await q.select("id, task_type").eq("id", taskId).maybeSingle()).data ?? null;
  } catch { /* 查不到就當非提問、當任務不存在 */ }
  if (manualTask?.task_type === "question") {
    return { status: "applied", message: "已記錄；提問任務不因 no_change 關閉，仍等有人用 question_answer 回一份說明", task_id: taskId };
  }
  // 打不開不能關手動任務（2026-09-26）：「查不到來源」不是「這個任務做完了」，任務要留著換人再試，
  // 不然這條死路就永遠沒人再碰（跟 auto: 任務的 task_unreachable_cooldown 是同一個道理，只是手動任務沒有冷卻機制、
  // 靠「不關」讓它繼續留在佇列裡）。contribute 端已經先讓伺服器自己試抓過一次，這裡收到的 unreachable
  // 都是系統也抓不到的，不是代理偷懶。
  const outcome = str(row.payload.outcome) ?? null;
  if (outcome === "unreachable") {
    if (!manualTask) return { status: "superseded", message: `任務 ${taskId} 已不存在，這筆無異動沒有可關的任務，不重試` };
    return { status: "applied", message: `已記錄「拿不到來源、未能確認」：任務 ${taskId} 留著給別人接手，不會關閉`, task_id: taskId };
  }
  const task = await closeTask(supabase, taskId, row.agent_name);
  // 任務已經不存在（被刪了）：沒有東西可關，重試也不會變（2026-09-25 第一次出現 apply_failed，重試三次後會被當落庫失敗退件）
  if (!task) return { status: "superseded", message: `任務 ${taskId} 已不存在，這筆無異動沒有可關的任務，不重試` };
  await recordUpdate(supabase, ctxOf(row), "contribution_tasks", taskId, "status", "open", "closed");
  return { status: "applied", message: `已記錄無異動並關閉任務 ${taskId}`, task_id: taskId };
}

// task_id 要撈：裁決 uphold 後原貢獻上線，它所屬的任務要能被關（task-fulfilment.ts）
const ORIGINAL_COLUMNS = "id, contribution_type, payload, source_urls, note, agent_name, agent_tool, contributor_url, status, review_notes, task_id";

/**
 * adjudication（3 票同向後）：uphold → 把原貢獻落庫並標 applied；reject → 原貢獻標 rejected 記理由。
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
    // 同一宣稱還在等票的其他提交收編成 superseded（2026-09-21）：驗證者不用再投票在已成事實的東西上
    try {
      await supersedeDuplicates(supabase, row);
    } catch (e) {
      console.error("supersedeDuplicates:", e instanceof Error ? e.message : String(e));
    }
  }
  return outcome;
}

async function supersedeDuplicates(supabase: SupabaseLike, row: ContributionRow): Promise<void> {
  if (!(DUPLICATE_ELIGIBLE_TYPES as readonly string[]).includes(row.contribution_type)) return;
  const target = claimTarget(row.contribution_type, row.payload);
  if (!target) return;
  const { data } = await supabase.from("contributions").select("id, contribution_type, payload, status")
    .eq("contribution_type", row.contribution_type).eq(`payload->>${target.field}`, target.value).in("status", ["pending", "verified"]).neq("id", row.id).limit(200);
  const ids = findSuperseded({ id: row.id, contribution_type: row.contribution_type, payload: row.payload }, (data ?? []) as Array<{ id: string; contribution_type: string; payload: unknown; status: string }>);
  if (ids.length === 0) return;
  const { error } = await supabase.from("contributions")
    .update({ status: "superseded", review_notes: `同一宣稱已由 ${row.agent_name ?? "?"} 的提交（${row.id}）上線` }).in("id", ids);
  throwIf(error, "supersede duplicates");
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
    case "merge_politician": return await applyMergePolitician(supabase, row);
    case "roster_check": return await applyRosterCheck(supabase, row);
    case "district_seats": return await applyDistrictSeats(supabase, row);
    case "party_info": return await applyPartyInfo(supabase, row);
    case "election_results": return await applyElectionResults(supabase, row);
    case "reassign_candidacy": return await applyReassignCandidacy(supabase, row);
    case "policy_elements": return await applyPolicyElements(supabase, row);
    case "lineage": return await applyLineage(supabase, row);
    case "lineage_participants": return await applyLineageParticipants(supabase, row);
    case "lineage_handover": return await applyLineageHandover(supabase, row);
    case "lineage_link": return await applyLineageLink(supabase, row);
    default: return { status: "failed", message: `未知型別 ${row.contribution_type}` };
  }
}

/** apply 結果 → contributions.status */
export function contributionStatusFor(outcome: ApplyStatus): "applied" | "rejected" | "apply_failed" | "superseded" {
  // 2026-09-21：disputed 退場。身份判不出／指認衝突一律退件，缺口回到任務佇列由之後的任務重做，不硬建。
  if (outcome === "applied") return "applied";
  if (outcome === "disputed") return "rejected";
  if (outcome === "superseded") return "superseded";
  return "apply_failed";
}
