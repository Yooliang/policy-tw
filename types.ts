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
  id: number;
  name: string;
  shortName: string;
  startDate: string;
  endDate: string;
  electionDate: string;
  types: ElectionType[];
}

// Normalized region data
export interface Region {
  id: number;
  region: string;        // County/City (縣市)
  subRegion?: string;    // District/Township (鄉鎮市區)
  village?: string;      // Village (村里)
}

// Candidate status for elections (選舉前中後三階段)
// 選前: rumored(傳聞), likely(可能參選)
// 選中: confirmed(確認參選)
// 選後: elected(當選), defeated(落選)
// registered＝中選會已登記、qualified＝已審定、not_running＝AI 推測但未登記（選舉頁不顯示）
export type CandidateStatus = 'rumored' | 'likely' | 'confirmed' | 'registered' | 'qualified' | 'not_running' | 'elected' | 'defeated';

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
  candidateStatus?: CandidateStatus; // 參選狀態：confirmed(已宣布)、likely(可能參選)、rumored(傳聞)
  sourceNote?: string;   // 來源備註 (AI搜尋匯入的備註)
}

export enum PoliticianStatus {
  INCUMBENT = 'incumbent',       // 現任
  POLITICIAN = 'politician',       // 已登記參選
  POTENTIAL = 'potential',       // 潛在人選（尚未宣布）
  FORMER = 'former',             // 前任
}

export interface Politician {
  id: string; // Changed from number to UUID string
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
  candidateStatus?: CandidateStatus; // 參選狀態 (for current election context)
  sourceNote?: string; // 來源備註 (for current election context)

  // Election-specific data (new)
  elections?: PoliticianElectionData[];
}


export interface TrackingLog {
  id: number;
  date: string;
  event: string;
  description?: string;
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
  progress: number; // 0-100
  tags: string[];
  logs: TrackingLog[];
  aiAnalysis?: string; // Daily summary
  supportCount?: number; // Only for Campaign Pledges
  /** 讀者表態：支持／反對／更在意（policy_stances） */
  stanceSupport: number;
  stanceOppose: number;
  stancePriority: number;
  relatedPolicyIds?: string[]; // IDs of predecessor or successor policies (Cross-term tracking)
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

export interface RawElection {
  id: number;
  name: string;
  short_name: string;
  start_date: string;
  end_date: string;
  election_date: string;
  types?: ElectionType[];
}

export interface RawPoliticianElectionData {
  electionId: number;
  position?: string;
  slogan?: string;
  electionType?: string;
  regionId?: number;
  region?: string;
  subRegion?: string;
  village?: string;
  candidateStatus?: CandidateStatus;
  sourceNote?: string;
}

export interface RawPolitician {
  id: string;
  name: string;
  party: string;
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
}

export interface RawTrackingLog {
  id: number;
  date: string;
  event: string;
  description?: string;
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
  related_policy_ids?: string[];
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