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
  position: string;
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

  title: string;

  description: string;
  category: string; // e.g., "Traffic", "Welfare"
  status: PolicyStatus;
  proposedDate: string;
  lastUpdated: string;
  progress: number; // 0-100
  tags: string[];
  logs: TrackingLog[];
  aiAnalysis?: string; // Daily summary
  supportCount?: number; // Only for Campaign Pledges
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