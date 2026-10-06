export enum PolicyStatus {
  PROPOSED = 'Proposed', // 提出
  IN_PROGRESS = 'In Progress', // 進行中
  ACHIEVED = 'Achieved', // 已實現
  STALLED = 'Stalled', // 滯後/卡關
  FAILED = 'Failed', // 跳票
  CAMPAIGN = 'Campaign Pledge', // 2026 競選承諾
}

export enum PoliticalParty {
  KMT = '國民黨',
  DPP = '民進黨',
  TPP = '民眾黨',
  IND = '無黨籍',
}

export enum ElectionType {
  PRESIDENT = '總統副總統',
  LEGISLATOR = '立法委員',
  MAYOR = '縣市長',
  COUNCILOR = '縣市議員',
  TOWNSHIP_MAYOR = '鄉鎮市長',
  INDIGENOUS_DISTRICT_CHIEF = '直轄市山地原住民區長',
  REPRESENTATIVE = '鄉鎮市民代表',
  INDIGENOUS_DISTRICT_REP = '直轄市山地原住民區民代表',
  CHIEF = '村里長',
}

export interface Election {
  /** 內部整數主鍵；舊三屆剛好等於投票年份，之後新增的選舉（補選、罷免、重行選舉）不是——年份與先後看 electionDate */
  id: number;
  /** 一場選舉的識別「投票日_種類[_地區代碼]」，建立後不改；新增的選舉網址用它（lib/election-route.ts） */
  electionKey: string;
  /** regular 定期改選／by_election 補選／recall 罷免投票／rerun 重行選舉 */
  electionReason?: string;
  name: string;
  shortName: string;
  startDate: string;
  endDate: string;
  /** 投票日 YYYY-MM-DD（先後、年份、任期一律看這個，不看 id） */
  electionDate: string;
  types: ElectionType[];
  /** 投票率（%），首長選舉合計（elections.turnout 的註解）；投票前、還沒同步就沒有這個欄位 */
  turnout?: number;
}

// Normalized region data
export interface Region {
  id: number;
  region: string;        // County/City (縣市)
  subRegion?: string;    // District/Township (鄉鎮市區)
  village?: string;      // Village (村里)
}

// 參選狀態是一欄六值 CandidacyStatus（見下面；#345 第二階段 A 起畫面只讀這一欄，
// 舊的 candidate_status＋election_result 兩欄讀取端已不再使用，第二階段 B 刪欄）

// Election-specific data for a politician
export interface PoliticianElectionData {
  electionId: number;
  position: string;      // Running position (參選職位)
  slogan?: string;       // Campaign slogan (競選口號)
  electionType?: string; // Election type (參選類型)
  regionId?: number;     // Region ID (正規化地區 ID)
  region: string;        // Region name (選區)
  subRegion?: string;    // Sub-region (子選區)
  village?: string;      // Village (村里)
  candNo?: number;       // 選票上的號次（名單公告、抽籤後才有）
  /** 這場選舉的投票日（視圖帶出來；舊視圖、舊快取沒有就退回用 electionId 排先後，見 lib/election-route.ts 的 newerFirst） */
  electionDate?: string;
  sourceNote?: string;   // 來源備註 (AI搜尋匯入的備註)
  /**
   * 參選狀態合一欄（#345，六值：選前、選中、選後同一欄；不收傳聞，空值＝不顯示）。
   * 取代舊的 candidateStatus（登記階段）＋electionResult（當選落選）兩欄；過去選舉的結果空著＝「結果待補」。
   */
  candidacyStatus?: CandidacyStatus;
  /** 退選之前有沒有登記過：true 登記後退選／false 表態不參選／空的＝判斷不了（顯示「不參選」）。只在退選時有值（#345 後續） */
  withdrawnAfterFiling?: boolean;
}

/** 參選狀態合一欄的六值（#345，跟日本站同一套；不收傳聞） */
export type CandidacyStatus = 'considering' | 'declared' | 'filed' | 'withdrawn' | 'elected' | 'not_elected';

/**
 * 任期表 `politician_offices` 的一列（#345）。人物頁拿已卸任的來列「卸任的公職」；現任的職稱走 `PoliticianOffice`（同一張表，第二階段 A 起視圖 `politicians_with_elections.offices` 直接讀它）。
 * `endBasis` 是 inferred 的卸任日是推定的（轉任別的公職，記新任期就任前一天），畫面要標「推定」。
 */
export interface PoliticianTerm {
  id: number;
  electionId: number;
  electionType: string;
  region?: string;
  subRegion?: string;
  village?: string;
  startDate: string;
  endDate?: string;
  endReason?: string;
  endBasis?: 'law' | 'inferred' | 'source';
  sourceUrl?: string;
}

/**
 * 一筆現任公職（任期表 `politician_offices` 的一列：已就任而且卸任日為空；由 `politicians_with_elections.offices` 帶出來。
 * #345 第二階段 A 起讀任期表，之前讀舊視圖 `politician_offices_derived`，兩邊 8,544 位職稱逐人比對一樣）。
 * 判「是不是現任」已經在資料庫做完（見 migration 20261006034510），
 * 前端只負責組字與排序——職稱的規則在 `lib/politician-office.ts`。
 */
export interface PoliticianOffice {
  electionId: number;
  /** 選出這個任期的那場選舉的投票日（視圖帶出來；沒有就退回用 electionId） */
  electionDate?: string;
  electionType?: string;
  region?: string;
  subRegion?: string;
  village?: string;
  /** 卸任日（任期最後一天） */
  termEnd?: string;
}

export enum PoliticianStatus {
  INCUMBENT = 'incumbent',       // 現任
  POLITICIAN = 'politician',       // 已登記參選
  POTENTIAL = 'potential',       // 潛在人選（尚未宣布）
  FORMER = 'former',             // 前任
}

export interface Politician {
  id: string; // Changed from number to UUID string
  /** 軟合併：已併進哪一筆；有值的不進清單，人物頁自動轉向過去 */
  mergedInto?: string;
  name: string;
  party: string; // Changed from PoliticalParty to string for flexibility
  status?: PoliticianStatus;
  electionType?: string; // Changed from ElectionType to string for flexibility
  position: string; // 參選職位 (e.g., 縣市長候選人)
  currentPosition?: string; // 現職 (e.g., 立法委員, 現任市長)
  avatarUrl?: string;
  region: string;
  subRegion?: string;
  village?: string; // 村里名稱（用於村里長選舉）
  electionIds?: number[];
  slogan?: string;
  bio?: string;
  birthYear?: number;
  educationLevel?: string;
  education?: string[];
  experience?: string[];
  candidacyStatus?: CandidacyStatus; // 參選狀態 (for current election context)
  /** 這一屆退選前有沒有登記過（for current election context；#345 後續） */
  withdrawnAfterFiling?: boolean;
  candNo?: number; // 號次 (for current election context)
  sourceNote?: string; // 來源備註 (for current election context)

  // Election-specific data (new)
  elections?: PoliticianElectionData[];

  /**
   * 現任公職（2026-10-04）。**職稱只能從這裡來**：`position` 是「最近一筆參選紀錄」的職位，
   * 不分當選落選，拿它當職稱會讓落選者看起來像現任。空陣列就是沒有現任職稱，不要找別的欄位頂替。
   */
  offices?: PoliticianOffice[];
}


/** 出處等級（sources.source_kind，#347）：官方／本人（要有認定根據）／媒體（含沒有認定根據的社群）／其他 */
export type SourceLevel = 'official' | 'self' | 'media' | 'other';

/**
 * 一筆資料引用的一個出處（出處表 sources 一列＋引用 source_refs，#347 第二階段 A）。
 * 畫面：等級用小標籤、有存檔網址就多一個「存檔」小連結。
 */
export interface SourceRef {
  url: string;
  title?: string | null;
  publisher?: string | null;
  publishedDate?: string | null;
  /** 出處等級；沒有出處表那一列（視圖還沒上線、只剩舊欄位 source_url 的退路）時沒有值，畫面就不標等級 */
  kind?: SourceLevel;
  /** 本人來源的認定根據：linked_by_official 被議會・選委會・政黨官網連結／mutual_link 與本人官網互相連結／platform_verified 平台認證 */
  selfEvidence?: string | null;
  /** Wayback Machine 的存檔網址（選舉公報、選委會公告類出處由排程存） */
  archiveUrl?: string | null;
  /** primary 主要出處／supporting 佐證 */
  role: 'primary' | 'supporting';
}

export interface TrackingLog {
  id: number;
  date: string;
  event: string;
  description?: string;
  /** 這則進度的主要出處網址：出處表優先，沒有才退回舊欄位 tracking_logs.source_url（#347 第二階段 A） */
  sourceUrl?: string;
  sources?: SourceRef[];
}

export interface Policy {
  id: string; // Changed from number to UUID string
  politicianId: string; // Changed from number to UUID string
  electionId?: number; // Election this policy belongs to

  title: string;

  description: string;
  category: string; // e.g., "Traffic", "Welfare"
  status: PolicyStatus;
  proposedDate: string | null;
  lastUpdated: string;
  /** 內容最後一次變動的時間（timestamptz，DB 觸發器維護）；lastUpdated 只有「日」，排序用這個（2026-09-22） */
  updatedAt?: string;
  /**
   * 主要出處網址。2026-09-23 起帶到前端：結構化標記的 citation、給 AI 的「引用這筆資料」。
   * #347 第二階段 A 起出處表（`sources`）優先，沒有才退回舊欄位 policies.source_url。
   */
  sourceUrl?: string;
  /** 這筆政見的所有出處（主要在前），帶等級與存檔網址；視圖還沒有這一欄時由舊的 source_url 補一筆 */
  sources?: SourceRef[];
  progress: number; // 0-100
  tags: string[];
  logs: TrackingLog[];
  aiAnalysis?: string; // Daily summary
  supportCount?: number; // Only for Campaign Pledges
  /** 讀者表態：支持／反對／更在意（policy_stances） */
  stanceSupport: number;
  stanceOppose: number;
  stancePriority: number;
  /**
   * 政見三要素（#364，視圖 policies_with_logs.elements）：查過的要素才有一筆。
   * **陣列裡沒有的要素＝未調查**；有而 stated=false＝未說明（原文沒寫）。兩者不能混，規則在 lib/policy-elements.ts。
   * 視圖還沒有這一欄時（舊快照、資料流程那支 PR 還沒上線）是 undefined，一律當成三個都未調查。
   */
  elements?: PolicyElement[];
  /** 屬於哪條政策脈絡（#349，policies.lineage_id）；沒歸入是 null／undefined */
  lineageId?: string | null;
  /** 所屬脈絡的摘要（視圖 policies_with_logs.lineage），政見頁「所屬脈絡」那一塊用 */
  lineage?: LineageSummary | null;
  /** 政見從哪裡來（#349，照日本站 policy_origin）：競選承諾／施政報告／議會提案／預算；還沒標是 null */
  origin?: PolicyOrigin | null;
}

/** 政見從哪裡來（#349，照日本站 policy_origin） */
export type PolicyOrigin = 'pledge' | 'policy_address' | 'assembly' | 'budget';
/** 政策脈絡的層級：中央／縣市／鄉鎮市區 */
export type LineageLevel = 'national' | 'county' | 'township';
export type HandoverType = 'keep' | 'pivot' | 'shrink' | 'stop' | 'resume';
export type ParticipantRole = 'proposer' | 'co_proposer' | 'cosigner' | 'advocate';
export type ParticipantBasis = 'official_record' | 'self_claim';
export type LineageLinkType = 'top_down' | 'bottom_up';

/** 政策脈絡的摘要（政見頁、清單用） */
export interface LineageSummary {
  id: string;
  title: string;
  level: LineageLevel;
  region: string | null;
  subRegion: string | null;
  category: string | null;
  summary: string | null;
}

/** 出處（sources 一列的摘要） */
export interface LineageSource {
  url: string;
  title?: string | null;
  publisher?: string | null;
  kind?: string | null;
  archiveUrl?: string | null;
}

export interface LineageParticipant {
  id: string;
  politicianId: string;
  name: string;
  role: ParticipantRole;
  basis: ParticipantBasis;
  sourceUrl: string;
  sourceLocator: string;
  note: string | null;
  source: LineageSource | null;
}

export interface LineageHandover {
  id: string;
  fromPoliticianId: string;
  fromName: string;
  fromElectionId: number | null;
  toPoliticianId: string;
  toName: string;
  toElectionId: number | null;
  handoverType: HandoverType;
  decidedOn: string | null;
  note: string;
  sourceUrl: string;
  sourceLocator: string;
  source: LineageSource | null;
}

export interface LineageLink {
  id: string;
  /** upper＝對方是這條的上級；lower＝對方是這條的下級 */
  direction: 'upper' | 'lower';
  lineageId: string;
  title: string;
  level: LineageLevel;
  region: string | null;
  subRegion: string | null;
  linkType: LineageLinkType;
  note: string;
  sourceUrl: string;
  sourceLocator: string;
  source: LineageSource | null;
}

/** 一條政策脈絡（視圖 lineages_full 一列，#349）：一件事在某一層級、某一地方的來龍去脈 */
export interface Lineage extends LineageSummary {
  policyIds: string[];
  participants: LineageParticipant[];
  handovers: LineageHandover[];
  links: LineageLink[];
  createdAt?: string;
  updatedAt?: string;
}

export type PolicyElementKind = 'target' | 'deadline' | 'funding';

/** 政見三要素的一個要素（policy_elements 一列）。跟日本站 keifu 的 policy_elements 同一套欄位 */
export interface PolicyElement {
  element: PolicyElementKind;
  /** true＝原文有寫；false＝查過原文、沒寫（未說明） */
  stated: boolean;
  /** 原文寫的事實（120 字內）；stated=false 時是 null */
  text: string | null;
  /** 達成期限換算的日期（會計年度是曆年）；換不成日期或不是期限就是 null */
  deadlineDate: string | null;
  /** 原句在原文的位置（公報第幾頁哪一段、影片時間點） */
  sourceLocator: string | null;
  /** 這個要素的出處（查的是哪份原文）；stated=false 也有 */
  source: PolicyElementSource | null;
}

export interface PolicyElementSource {
  url: string;
  title?: string | null;
  publisher?: string | null;
  /** official 官方／self 本人／media 媒體／other 其他（sources.source_kind） */
  kind?: string | null;
  /** Wayback Machine 的存檔網址（選舉公報下架後還看得到） */
  archiveUrl?: string | null;
}


export interface DonationMethod {
  id: string;
  name: string;
  type: 'fiat' | 'crypto' | 'linepay';
  details: string;
  icon: string;
}

export interface DiscussionAuthor {
  id: string;
  name: string;
  avatarUrl: string;
}

export interface CommentReply {
  id: number;
  author: DiscussionAuthor;
  content: string;
  likes: number;
  createdAt: string;
}

export interface DiscussionComment {
  id: number;
  author: DiscussionAuthor;
  content: string;
  likes: number;
  createdAt: string;
  replies: CommentReply[];
}

export interface Discussion {
  id: number;
  policyId: string; // Changed to UUID string
  policyTitle: string;

  author: DiscussionAuthor;
  title: string;
  content: string;
  likes: number;
  tags: string[];
  createdAt: string;
  createdAtTs: number;
  viewCount: number;
  comments: DiscussionComment[];
}

// === 公民提問（citizen_questions／question_answers）===
// 訪客提問，AI 代理查證作答；同一題可有多個代理各答一份，並陳讓讀者比對。
// stance_up／stance_down 是唯一公開的表態來源，question_stances 表本身沒有開放讀取。

export type CitizenQuestionStatus = 'open' | 'answered' | 'hidden';

export interface CitizenQuestion {
  id: string;
  question: string;
  policyId: string | null;
  politicianId: string | null;
  region: string | null;
  status: CitizenQuestionStatus;
  answerCount: number;
  stanceUp: number;
  stanceDown: number;
  createdAt: string;
}

export interface QuestionAnswer {
  id: string;
  questionId: string;
  agentName: string;
  agentTool: string | null;
  answer: string;
  sourceUrls: string[];
  createdAt: string;
}

export interface RawCitizenQuestion {
  id: string;
  question: string;
  policy_id: string | null;
  politician_id: string | null;
  region: string | null;
  status: CitizenQuestionStatus;
  answer_count: number;
  stance_up: number;
  stance_down: number;
  created_at: string;
}

export interface RawQuestionAnswer {
  id: string;
  question_id: string;
  agent_name: string;
  agent_tool: string | null;
  answer: string;
  source_urls?: string[] | null;
  created_at: string;
}

export interface PolicySource {
  id: number;
  policyId: string;
  url: string;
  title?: string;
  sourceName?: string;
  publishedDate?: string;
  createdAt: string;
}

// === DB raw row types (snake_case, matching Supabase response) ===

export interface RawPolicySource {
  id: number;
  policy_id: string;
  url: string;
  title?: string;
  source_name?: string;
  published_date?: string;
  created_at: string;
}

export interface RegionStats {
  id: number;
  region: string;
  sub_region: string | null;
  village: string | null;
  total_politicians: number;
  mayor_count: number;
  councilor_count: number;
  township_mayor_count: number;
  representative_count: number;
  village_chief_count: number;
  policy_count: number;
  updated_at: string;
}

export interface ElectoralDistrictArea {
  id: number;
  region: string;
  electoral_district: string;
  township: string;
  election_id: number;
  prv_code: string | null;
  area_code: string | null;
  dept_code: string | null;
  created_at: string;
}

export interface ElectionTypeTableRow {
  election_id: number;
  type: string;
}

/** 查證來源清單（verification_sources 表，見 /sources 頁與 sources 端點；docs/DECISIONS.md 2026-09-28） */
export interface VerificationSource {
  id: number;
  name: string;
  kind: string;
  party: string | null;
  regions: string[] | null;
  election_types: string[] | null;
  provides: string[];
  list_url: string | null;
  detail_url_pattern: string | null;
  access: string;
  quality_note: string | null;
  how_to: string | null;
  last_checked: string | null;
  status: string;
  sort: number;
}

export interface RawElection {
  id: number;
  election_key: string;
  election_reason?: string | null;
  /** 這次選哪些職位（elections.election_types，#344；取代 election_types 表） */
  election_types?: string[] | null;
  name: string;
  short_name: string;
  start_date: string;
  end_date: string;
  election_date: string;
  types?: ElectionType[];
  /** NUMERIC(5,2)；PostgREST 回數字，保險起見也收字串 */
  turnout?: number | string | null;
}

export interface RawPoliticianElectionData {
  electionId: number;
  electionDate?: string | null;
  position?: string;
  slogan?: string;
  electionType?: string;
  regionId?: number;
  region?: string;
  subRegion?: string;
  village?: string;
  candNo?: number;
  sourceNote?: string;
  candidacyStatus?: CandidacyStatus | null;
  withdrawnAfterFiling?: boolean | null;
}

export interface RawPolitician {
  id: string;
  name: string;
  party: string;
  /** 軟合併：這筆已併進哪一筆（2026-09-19）；清單過濾、人物頁轉向 */
  merged_into?: string | null;
  status?: PoliticianStatus;
  election_type?: string;
  position?: string;
  current_position?: string;
  region?: string;
  sub_region?: string;
  village?: string;
  avatar_url?: string;
  slogan?: string;
  bio?: string;
  education?: string[];
  experience?: string[];
  election_ids?: number[];
  birth_year?: number;
  education_level?: string;
  elections?: RawPoliticianElectionData[];
  /** 現任公職；視圖已經用 camelCase 組好 JSON，跟 PoliticianOffice 同形狀 */
  offices?: PoliticianOffice[];
}

/** 視圖 policies_with_logs 的 sources（資料庫函式 source_brief_list 的一筆） */
export interface RawSourceRef {
  url: string;
  title?: string | null;
  publisher?: string | null;
  published_date?: string | null;
  kind?: string | null;
  self_evidence?: string | null;
  archive_url?: string | null;
  role?: string | null;
}

export interface RawTrackingLog {
  id: number;
  date: string;
  event: string;
  description?: string;
  /** 舊欄位（退路）；舊視圖沒有 */
  source_url?: string | null;
  sources?: RawSourceRef[] | null;
}

export interface RawPolicy {
  id: string;
  politician_id: string;
  election_id?: number;
  title: string;
  description: string;
  category: string;
  status: PolicyStatus;
  proposed_date: string | null;
  last_updated: string;
  updated_at?: string;
  /** 這筆政見的原始出處（policies.source_url）；結構化標記與「引用這筆資料」用 */
  source_url?: string | null;
  progress: number;
  tags?: string[];
  ai_analysis?: string;
  support_count?: number;
  /** 讀者表態計數（policy_stances 的 trigger 同步）。view 重建前這三欄不存在，所以是選填。 */
  stance_support?: number;
  stance_oppose?: number;
  stance_priority?: number;
  /** 軟移除：有值代表這筆已被移除，前端一律過濾掉 */
  removed_at?: string | null;
  logs?: RawTrackingLog[];
  /** 政見三要素（#364）：視圖 policies_with_logs 最後一欄；舊視圖沒有這一欄 */
  elements?: RawPolicyElement[] | null;
  /** 政策脈絡（#349）：所屬脈絡 id、摘要、政見從哪裡來；舊視圖沒有這三欄 */
  lineage_id?: string | null;
  lineage?: RawLineageSummary | null;
  origin?: string | null;
  /** 出處（#347 第二階段 A）：視圖 policies_with_logs 最後一欄；舊視圖沒有，那時退回上面的 source_url */
  sources?: RawSourceRef[] | null;
}

export interface RawLineageSummary {
  id: string;
  title: string;
  level: string;
  region?: string | null;
  sub_region?: string | null;
  category?: string | null;
  summary?: string | null;
}

export interface RawLineageSource { url?: string | null; title?: string | null; publisher?: string | null; kind?: string | null; archive_url?: string | null }

/** 視圖 lineages_full 一列（#349） */
export interface RawLineage extends RawLineageSummary {
  admin_code?: string | null;
  created_at?: string;
  updated_at?: string;
  policy_ids?: string[] | null;
  participants?: Array<{ id: string; politician_id: string; name?: string | null; role: string; basis: string; source_url: string; source_locator: string; note?: string | null; source?: RawLineageSource | null }> | null;
  handovers?: Array<{ id: string; from_politician_id: string; from_name?: string | null; from_election_id?: number | null; to_politician_id: string; to_name?: string | null; to_election_id?: number | null; handover_type: string; decided_on?: string | null; note: string; source_url: string; source_locator: string; source?: RawLineageSource | null }> | null;
  links?: Array<{ id: string; direction: string; lineage_id: string; title: string; level: string; region?: string | null; sub_region?: string | null; link_type: string; note: string; source_url: string; source_locator: string; source?: RawLineageSource | null }> | null;
}

export interface RawPolicyElement {
  element: string;
  stated: boolean;
  text?: string | null;
  deadline_date?: string | null;
  source_locator?: string | null;
  source_url?: string | null;
  updated_at?: string | null;
  source?: { url?: string | null; title?: string | null; publisher?: string | null; kind?: string | null; archive_url?: string | null } | null;
}

export interface RawDiscussionComment {
  id: number;
  author: DiscussionAuthor;
  content: string;
  likes: number;
  createdAt: string;
  replies?: RawCommentReply[];
}

export interface RawCommentReply {
  id: number;
  author: DiscussionAuthor;
  content: string;
  likes: number;
  createdAt: string;
}

export interface RawDiscussion {
  id: number;
  policy_id: string;
  policy_title: string;
  author_id: string;
  author_name: string;
  author_avatar_url: string;
  title: string;
  content: string;
  likes: number;
  tags?: string[];
  created_at: string;
  created_at_ts: number;
  view_count: number;
  comments?: RawDiscussionComment[];
}

export interface RawElectionTypeRow {
  election_type: string;
}

// 資料採集管線的健康度快照（每 4 小時一筆），用來畫「機制有沒有在動」的走勢圖
export interface RawPipelineSnapshot {
  taken_at: string;
  tasks_open: number;
  tasks_by_type: Record<string, number> | null; // 鍵會增減，不假設固定欄位
  pending: number;
  applied: number;
  disputed: number;
  rejected: number;
  votes_total: number;
  voters: number;
  policies: number;
  politicians: number;
  questions: number;
}

export interface PipelineSnapshot {
  takenAt: string;
  tasksOpen: number;
  tasksByType: Record<string, number>;
  /** 自動找出來的資料缺口總數（tasksByType 扣掉 manual_open） */
  gapsOpen: number;
  /** 任務清單裡 open 的手動任務數（tasksByType.manual_open） */
  manualOpen: number;
  pending: number;
  applied: number;
  disputed: number;
  rejected: number;
  votesTotal: number;
  voters: number;
  policies: number;
  politicians: number;
  questions: number;
}