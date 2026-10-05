/**
 * 政見三要素（#364，2026-10-05；與日本站 keifu 的 policy_elements 同一套欄位與語意）。
 *
 * 一條政見拆成數值目標（target）、達成期限（deadline）、財源（funding），一個要素一列：
 *   stated=true   原文有寫，text 只寫原文的事實（120 字內）
 *   stated=false  查過原文、沒寫（畫面「未說明」），text 不填
 *   沒有這一列    還沒拆（畫面「未調查」）——「我們還沒查」跟「他沒說」不能混在一起
 * 正見是第三方：不幫候選人補數字、不換算、不評價。
 *
 * SQL 那一份在 migration 20261005005640_policy_elements.sql（CHECK 約束與派工臂），
 * policy-elements.test.ts 盯兩邊的字數上限、要素清單一致。
 */

export const POLICY_ELEMENT_KINDS = ["target", "deadline", "funding"] as const;
export type PolicyElementKind = (typeof POLICY_ELEMENT_KINDS)[number];

/** 要素文字上限（字元數；SQL 的 char_length 算的也是字元，不是 UTF-16 單位） */
export const POLICY_ELEMENT_TEXT_MAX = 120;
/** 原句位置的上限 */
export const POLICY_ELEMENT_LOCATOR_MAX = 200;
/** 期限日期合理的年份範圍（擋民國年、打錯的年份；不是在判斷期限合不合理） */
export const DEADLINE_YEAR_MIN = 1990;
export const DEADLINE_YEAR_MAX = 2100;

export const POLICY_ELEMENT_LABEL: Record<PolicyElementKind, string> = {
  target: "數值目標",
  deadline: "達成期限",
  funding: "財源",
};
/** 有列但 stated=false */
export const NOT_STATED_LABEL = "未說明";
/** 沒有列 */
export const UNCHECKED_LABEL = "未調查";

type Obj = Record<string, unknown>;

/** 字元數（跟 SQL char_length 一致；罕用字在 UTF-16 是兩個單位，用 .length 會多算） */
export function charLength(s: string): number {
  return [...s].length;
}

/** 真實存在的日期（2028-02-30 這種 Date.parse 會自己進位的也擋） */
export function isRealDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** 落庫寫進 policy_elements 的一列（不含 policy_id、contribution_id） */
export interface PolicyElementValues {
  element: PolicyElementKind;
  stated: boolean;
  text: string | null;
  deadline_date: string | null;
  source_url: string;
  source_locator: string;
}

/**
 * 交件的一個要素 → 要寫進資料表的值。schema 已經驗過形狀，這裡只做正規化：
 * 沒寫的 text、deadline_date 一律 NULL（不讓「未說明」這種字混進來冒充內容）；
 * source_url 沒給就是這筆交件的第一個來源。
 */
export function policyElementValues(e: Obj, sourceUrls: readonly string[]): PolicyElementValues {
  const element = String(e.element) as PolicyElementKind;
  const stated = e.stated === true;
  const text = stated && typeof e.text === "string" && e.text.trim() ? e.text.trim() : null;
  const deadline = stated && element === "deadline" && isRealDate(e.deadline_date) ? e.deadline_date : null;
  const url = typeof e.source_url === "string" && e.source_url.trim() ? e.source_url.trim() : (sourceUrls[0] ?? "");
  return {
    element,
    stated,
    text,
    deadline_date: deadline,
    source_url: url,
    source_locator: String(e.source_locator ?? "").trim(),
  };
}

/** 資料表的欄位（比對「跟現有那一列一不一樣」用；順序就是 edit_history 記的順序） */
export const POLICY_ELEMENT_FIELDS = ["stated", "text", "deadline_date", "source_url", "source_locator"] as const;

/** 現有那一列跟這次要寫的，哪幾欄不一樣（日期欄從資料庫回來可能帶時間，只比日期部分） */
export function changedElementFields(current: Obj, next: PolicyElementValues): Array<(typeof POLICY_ELEMENT_FIELDS)[number]> {
  const norm = (k: string, v: unknown): unknown => {
    if (v === undefined || v === null || v === "") return null;
    if (k === "deadline_date") return String(v).slice(0, 10);
    if (typeof v === "string") return v.trim();
    return v;
  };
  return POLICY_ELEMENT_FIELDS.filter((k) => norm(k, current[k]) !== norm(k, next[k]));
}

/** 一個要素給人看的一句話：「數值目標：新建 3 座…」／「財源：未說明」 */
export function elementPhrase(e: { element?: unknown; stated?: unknown; text?: unknown }, clipAt = 40): string {
  const label = POLICY_ELEMENT_LABEL[e.element as PolicyElementKind] ?? String(e.element ?? "?");
  if (e.stated !== true) return `${label}：${NOT_STATED_LABEL}`;
  const t = typeof e.text === "string" ? e.text.trim() : "";
  return `${label}：${t.length > clipAt ? `${t.slice(0, clipAt)}…` : t}`;
}

/** 這條政見還缺哪幾個要素（照 target、deadline、funding 的順序） */
export function missingElements(existing: ReadonlyArray<{ element?: unknown }>): PolicyElementKind[] {
  const have = new Set(existing.map((e) => String(e.element)));
  return POLICY_ELEMENT_KINDS.filter((k) => !have.has(k));
}
