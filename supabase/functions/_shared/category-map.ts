/**
 * 政見分類正規化：categories 表只有 8 個正規值，但既有 policies.category 有舊寫法（交通／社會／經濟／環境／教育／社福）。
 * apply 落庫時用這張表把 payload 的 category 轉成正規值；scripts/normalize-policy-categories.sql 用同一張表清既有資料。
 * 「經濟補助」「能源」「其他」等不在表裡的值原樣保留（主線之後再決定）。
 */

export const POLICY_CATEGORIES = ["交通建設", "社會福利", "經濟發展", "教育文化", "環境保護", "公平正義", "行政革新", "政治議題"] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

export const CATEGORY_MAP: Readonly<Record<string, PolicyCategory>> = {
  "交通": "交通建設",
  "社會": "社會福利",
  "社福": "社會福利",
  "經濟": "經濟發展",
  "環境": "環境保護",
  "教育": "教育文化",
};

/** 正規化分類：對照表有的換成正規值，正規值原樣，其餘（含空值）原樣回傳。 */
export function normalizeCategory(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  return CATEGORY_MAP[s] ?? s;
}

export function isCanonicalCategory(v: unknown): v is PolicyCategory {
  return typeof v === "string" && (POLICY_CATEGORIES as readonly string[]).includes(v);
}
