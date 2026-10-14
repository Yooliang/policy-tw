/**
 * 政見主題（docs/PLAN-markdown-views.md 第 3.4 節，第二期，2026-10-07）。
 *
 * 一條政見至多 2 個主題（固定詞彙，`topics.ts`＝`lib/topics.ts` 的一字不差的複本，守門測試盯），語意照政見三要素（policy_elements，#364）：
 *   有主題列        查過、屬於這個主題，evidence 是政見文字裡的依據句
 *   topic_key NULL  查過、不屬於任何已定義主題（交件的 topics 填空陣列）
 *   沒有列          還沒調查（未調查）——「還沒標」跟「查過、沒有主題」不能混在一起
 * 候選主題由系統用關鍵字算（topicCandidates），**只是候選、不是答案**；答案要走貢獻＋投票。
 *
 * SQL 那一份在 migration 20261007200000_policy_topics.sql（CHECK 約束、落庫函式 policy_topics_apply、派工臂），
 * policy-topics.test.ts 盯兩邊的 key 清單、字數上限、主題數上限一致。
 */

import { type Topic, TOPICS, TOPIC_BY_KEY, topicCandidates } from "./topics.ts";

/** 16 個主題 key（資料表 CHECK policy_topics_topic_key_check 與這份一致） */
export const POLICY_TOPIC_KEYS: readonly string[] = TOPICS.map((t) => t.key);

/** 一條政見最多幾個主題 */
export const POLICY_TOPIC_MAX = 2;
/** 依據句長度（字元；SQL 的 char_length 算的也是字元，不是 UTF-16 單位） */
export const POLICY_TOPIC_EVIDENCE_MAX = 150;
/** 依據句至少幾個字：「政見」「見上」這種不算依據 */
export const POLICY_TOPIC_EVIDENCE_MIN = 4;
/** 一筆交件（一件任務）最多幾條政見；派工臂 policy_ids 也只給這麼多（SQL 的 [1:30]） */
export const POLICY_TOPIC_BATCH_MAX = 30;

/** 有列、topic_key 為 NULL */
export const NO_TOPIC_LABEL = "查過、不屬於任何主題";
/** 沒有列 */
export const UNCHECKED_LABEL = "未調查";

type Obj = Record<string, unknown>;

/** 字元數（跟 SQL char_length 一致；罕用字在 UTF-16 是兩個單位，用 .length 會多算） */
export function charLength(s: string): number {
  return [...s].length;
}

export function topicLabel(key: unknown): string {
  return TOPIC_BY_KEY.get(String(key))?.label ?? String(key ?? "?");
}

/** 給代理看的詞彙表：key、名稱、主要落在的分類（同義詞不給——候選已經用同義詞算過，給了反而引導照關鍵字貼標） */
export function topicVocabulary(): Array<Pick<Topic, "key" | "label" | "categories">> {
  return TOPICS.map((t) => ({ key: t.key, label: t.label, categories: t.categories }));
}

/** 一筆政見的候選主題（系統用關鍵字算，依相關度排序，不截斷；只是候選） */
export function policyTopicCandidates(policy: { title?: unknown; description?: unknown; category?: unknown }): string[] {
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return topicCandidates({ title: s(policy.title), description: s(policy.description), category: s(policy.category) });
}

/** 交件的一筆政見：topics 空陣列＝查過、不屬於任何主題 */
export interface PolicyTopicItem {
  policy_id: string;
  topics: Array<{ topic: string; evidence: string }>;
}

/** 交件 payload.items 取出來（形狀已經由 schema 驗過，這裡只濾掉不是物件的） */
export function policyTopicItems(payload: unknown): PolicyTopicItem[] {
  const items = payload && typeof payload === "object" ? (payload as Obj).items : null;
  if (!Array.isArray(items)) return [];
  return items.filter((x): x is Obj => !!x && typeof x === "object").map((x) => ({
    policy_id: String(x.policy_id ?? "").trim().toLowerCase(),
    topics: (Array.isArray(x.topics) ? x.topics : []).filter((t): t is Obj => !!t && typeof t === "object").map((t) => ({
      topic: String(t.topic ?? "").trim(),
      evidence: String(t.evidence ?? "").trim(),
    })),
  }));
}

/** 這一筆要寫進資料表的平行陣列（policy_topics_apply 的 p_keys／p_evidence） */
export function policyTopicArrays(item: PolicyTopicItem): { keys: string[]; evidence: string[] } {
  return { keys: item.topics.map((t) => t.topic), evidence: item.topics.map((t) => t.evidence) };
}

/** 給人看的一句話：「少子化與育兒、長照與高齡」／「查過、不屬於任何主題」 */
export function topicsPhrase(topics: ReadonlyArray<{ topic?: unknown }>): string {
  return topics.length === 0 ? NO_TOPIC_LABEL : topics.map((t) => topicLabel(t.topic)).join("、");
}

/** apply 回傳的整列（policy_topics_apply 的 inserted／deleted）給查核履歷用的樣子 */
export interface PolicyTopicsApplyResult {
  inserted: Obj[];
  deleted: Obj[];
  updated: Array<{ id: string; topic_key: string; old_evidence: string | null; new_evidence: string | null }>;
}

export function parseApplyResult(data: unknown): PolicyTopicsApplyResult {
  const o = (data && typeof data === "object" ? data : {}) as Obj;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return { inserted: arr(o.inserted) as Obj[], deleted: arr(o.deleted) as Obj[], updated: arr(o.updated) as PolicyTopicsApplyResult["updated"] };
}
