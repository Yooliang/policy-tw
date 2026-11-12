/**
 * 一人一包（PR3，docs/PLAN-bundle-policies.md 第 2 節）：交件端的包驗證（純函式）與旗標讀取。
 *
 * /report {kind:"contribute", bundle:true, contributions:[…]}：同一人、同一任務、同一屆、同一份公報的一包政見。
 * 旗標 queue_settings.bundle_enabled 預設關；關著時 contribute-handler 忽略 bundle（照舊逐條收，回應帶 bundle_ignored:true）。
 */
import { docKindOf } from "./source-archive.ts";
import { isSiteRoot } from "./source-priority.ts";

export const DEFAULT_BUNDLE_MAX_ITEMS = 30;
export const DEFAULT_BUNDLE_MIN_ITEMS = 2;

export interface BundleSettings {
  enabled: boolean;
  maxItems: number;
  minItems: number;
}

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

const intIn = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;

/** 讀 queue_settings 的包設定；查不到、欄位還不存在、丟錯一律當「關」（行為與沒有這個功能時一樣）。永遠不丟錯 */
export async function loadBundleSettings(supabase: SupabaseLike): Promise<BundleSettings> {
  const off: BundleSettings = { enabled: false, maxItems: DEFAULT_BUNDLE_MAX_ITEMS, minItems: DEFAULT_BUNDLE_MIN_ITEMS };
  try {
    const { data, error } = await supabase.from("queue_settings").select("bundle_enabled,bundle_max_items,bundle_min_items").eq("id", 1).limit(1);
    if (error || !Array.isArray(data) || !data[0] || typeof data[0] !== "object") return off;
    const r = data[0] as Record<string, unknown>;
    return {
      enabled: r.bundle_enabled === true,
      maxItems: intIn(r.bundle_max_items, 2, 100, DEFAULT_BUNDLE_MAX_ITEMS),
      minItems: intIn(r.bundle_min_items, 2, 100, DEFAULT_BUNDLE_MIN_ITEMS),
    };
  } catch {
    return off;
  }
}

export interface BundleItem {
  contribution_type: string;
  payload: unknown;
  source_urls: readonly string[];
  task_id?: string | null;
}

export interface BundleProblem {
  error: "bundle_invalid" | "bundle_requires_bulletin" | "bundle_duplicate_item" | "bundle_too_small" | "bundle_too_large";
  message: string;
  /** 有問題的條目序號（0 起算；整包層級的問題為空） */
  indexes: number[];
}

/** 標題正規化：NFKC、小寫、去掉空白與標點符號 */
export function normalizeBundleTitle(title: unknown): string {
  return typeof title === "string" ? title.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "") : "";
}

/** 一條裡的公報網址（election_bulletin 網域、不是站台首頁） */
export function bulletinUrlsOf(sourceUrls: readonly string[] | null | undefined): string[] {
  return (sourceUrls ?? [])
    .filter((u): u is string => typeof u === "string")
    .map((u) => u.trim())
    .filter((u) => docKindOf(u) === "election_bulletin" && !isSiteRoot(u));
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});

/** 一包的共同公報網址（每條都有的第一個）；沒有回 null */
export function sharedBulletinUrl(items: readonly BundleItem[]): string | null {
  if (items.length === 0) return null;
  const first = bulletinUrlsOf(items[0].source_urls);
  const rest = items.slice(1).map((it) => new Set(bulletinUrlsOf(it.source_urls)));
  return first.find((u) => rest.every((s) => s.has(u))) ?? null;
}

/** 與第 0 條不同（或沒有值）的條目序號 */
function differing<T>(items: readonly BundleItem[], pick: (it: BundleItem) => T, ok: (v: unknown) => boolean): number[] {
  const base = pick(items[0]);
  return items.map((it, i) => (ok(pick(it)) && pick(it) === base ? -1 : i)).filter((i) => i >= 0);
}

/**
 * 包的結構檢查（schema 驗證通過之後）：min～max 條、全 policy、同人、同一屆、同一任務、有共同公報網址、包內不重複標題。
 * 回 null＝合格。
 */
export function bundleProblems(items: readonly BundleItem[], opts: { minItems: number; maxItems: number }): BundleProblem | null {
  if (items.length < opts.minItems) {
    return { error: "bundle_too_small", message: `一包至少 ${opts.minItems} 條政見；只有 ${items.length} 條請不要帶 bundle:true，照一般方式逐條交。整批未收`, indexes: [] };
  }
  if (items.length > opts.maxItems) {
    return { error: "bundle_too_large", message: `一包最多 ${opts.maxItems} 條政見，這包 ${items.length} 條；請分成兩包。整批未收`, indexes: [] };
  }
  const notPolicy = items.map((it, i) => (it.contribution_type === "policy" ? -1 : i)).filter((i) => i >= 0);
  if (notPolicy.length > 0) {
    return { error: "bundle_invalid", message: "包裡每一條都要是 policy 型別；整批未收", indexes: notPolicy };
  }
  const badPerson = differing(items, (it) => obj(it.payload).politician_id, (v) => typeof v === "string");
  if (badPerson.length > 0) {
    return { error: "bundle_invalid", message: "一包的每一條都要帶同一個 payload.politician_id（同一個人）；整批未收", indexes: badPerson };
  }
  const badElection = differing(items, (it) => obj(it.payload).election_id, (v) => typeof v === "number");
  if (badElection.length > 0) {
    return { error: "bundle_invalid", message: "一包的每一條都要是同一屆（payload.election_id 相同）；整批未收", indexes: badElection };
  }
  const badTask = differing(items, (it) => it.task_id ?? null, (v) => typeof v === "string");
  if (badTask.length > 0) {
    return { error: "bundle_invalid", message: "一包的每一條都要帶同一個 task_id；整批未收", indexes: badTask };
  }
  const noBulletin = items.map((it, i) => (bulletinUrlsOf(it.source_urls).length === 0 ? i : -1)).filter((i) => i >= 0);
  if (noBulletin.length > 0 || sharedBulletinUrl(items) === null) {
    return { error: "bundle_requires_bulletin", message: "一包的每一條 source_urls 都要有同一份中選會選舉公報網址（eebulletin／bulletin.cec.gov.tw）；非公報來源請逐條交，不要帶 bundle:true。整批未收", indexes: noBulletin };
  }
  const seen = new Set<string>();
  const dups: number[] = [];
  items.forEach((it, i) => {
    const key = normalizeBundleTitle(obj(it.payload).title);
    if (!key) return;
    if (seen.has(key)) dups.push(i); else seen.add(key);
  });
  if (dups.length > 0) {
    return { error: "bundle_duplicate_item", message: `包裡有標題重複的政見（第 ${dups.join("、")} 條，序號 0 起算）；同一件事只留一條。整批未收`, indexes: dups };
  }
  return null;
}
