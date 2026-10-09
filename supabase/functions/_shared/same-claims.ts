/**
 * 同一件事只能有一筆（#521；設計 policy-jp docs/PLAN-same-claim.md；裁決 docs/decisions/2026-10-09-同一件事只能有一筆日本站試點.md）。
 *
 * 兩站通用的登記表與判斷，不帶 schema、不查資料庫：
 *   - SAME_CLAIM_REGISTRY：哪些型別要先回答「這跟已經有的哪一筆是同一件事」，精確鍵是什麼、比對寫在哪支 SQL。
 *     比對本身在 SQL（日本站 policy_jp.same_claim_matches，20261009280000），交件端（jp-report）與派工端（jp-next）呼叫同一支。
 *   - parseResolvedClaim：代理交件時 payload.resolved_claim 的四種寫法。
 *   - decideSameClaim：比對結果＋代理的宣告 → 收下／投同意票／409（純函式，交件端照它做）。
 *
 * 正見那一側：只有這個檔案與測試，不改正見 next／report 的行為（九合一 2026-11-28 之後才接）。
 * 已有的 claimKey 併票（duplicate-claim.ts）照舊管沒有登記在這裡的結構化型別（no_change、correction、task_suggestion…）；
 * 一個型別只能在其中一邊（守門：same-claims.test.ts）。
 */

/** 一個登記項：型別 → 精確鍵（說明用，比對在 SQL）、正式表、哪一站 */
export interface SameClaimEntry {
  /** contribution_type */
  type: string;
  /** 寫進哪張正式表（同一個 schema 下） */
  table: string;
  /** 精確鍵的欄位（說明與守門用；真正的比對規則在 SQL） */
  key: readonly string[];
  /** 哪一站已經接上（交件端要求 resolved_claim） */
  sites: readonly ("jp" | "tw")[];
}

export const SAME_CLAIM_REGISTRY: readonly SameClaimEntry[] = [
  { type: "election", table: "elections", key: ["lg_code", "office", "election_reason", "term"], sites: ["jp"] },
  { type: "regional_stat", table: "regional_stats", key: ["lg_code", "stat_key", "year"], sites: ["jp"] },
  { type: "local_government", table: "local_governments", key: ["lg_code"], sites: ["jp"] },
];

/** 這一站要求 resolved_claim 的型別 */
export function sameClaimTypes(site: "jp" | "tw"): string[] {
  return SAME_CLAIM_REGISTRY.filter((e) => e.sites.includes(site)).map((e) => e.type);
}

export function isSameClaimType(site: "jp" | "tw", type: string): boolean {
  return sameClaimTypes(site).includes(type);
}

/** 代理的宣告 */
export type ResolvedClaim =
  | { kind: "new" }
  | { kind: "ref"; id: string } // 在庫列的 id，或審議中那一筆的 contribution_id
  | { kind: "differs"; id: string }; // 內容不同：照常收，note 必填

/** payload.resolved_claim 的四種寫法；其他（含沒填）＝null */
export function parseResolvedClaim(v: unknown): ResolvedClaim | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "new") return { kind: "new" };
  if (s.startsWith("differs:")) {
    const id = s.slice("differs:".length).trim();
    return id && id.length <= 200 ? { kind: "differs", id } : null;
  }
  return s && s.length <= 200 && !/\s/.test(s) ? { kind: "ref", id: s } : null;
}

export const RESOLVED_CLAIM_HELP =
  'payload.resolved_claim 必填，四種之一："new"（item.current.same_claims 兩邊都沒有）／在庫那一列的 id（existing[].id，內容一致）／' +
  '審議中那一筆的 contribution_id（pending[].contribution_id，內容一致＝算你一張同意票）／"differs:<id>"（內容不同，note 寫差在哪、哪個出典）';

/** same_claim_matches 回來的形狀（兩站同一份） */
export interface SameClaimMatches {
  type: string;
  existing: Array<{ id: string; summary?: string; why?: string } & Record<string, unknown>>;
  pending: Array<{ contribution_id: string; your_network_voted?: boolean; yours?: boolean; summary?: string } & Record<string, unknown>>;
}

export type SameClaimDecision =
  /** 收成一筆新的（new 且兩邊都空、或 differs） */
  | { action: "insert" }
  /** 指向審議中那一筆：投同意票（投不成＝409 already_voted，不另收） */
  | { action: "vote"; contribution_id: string }
  /** 指向在庫列：不另開一筆（有任務的改記 no_change confirmed，沒有任務的什麼都不寫） */
  | { action: "existing"; id: string }
  /** 擋下：不寫入、不算退件 */
  | { action: "block"; error: "duplicate_claim" | "already_voted" | "claim_mismatch"; message: string; existing_ids: string[]; pending_ids: string[] };

/**
 * 比對結果＋宣告 → 怎麼處理（主線 10-09 四點裁定）：
 *   new，但比對到了               → 409 duplicate_claim（只回那幾筆的 id，不同時派驗證）
 *   ref＝審議中那一筆             → 投同意票；這個網段交過或投過 → 409 already_voted
 *   ref＝在庫列                   → existing（不另開）
 *   ref／differs 指的 id 不在比對結果裡 → 409 claim_mismatch
 *   differs                       → 照常收（兩筆並存進投票，不先等 Jev）
 */
export function decideSameClaim(resolved: ResolvedClaim, m: SameClaimMatches): SameClaimDecision {
  const existingIds = m.existing.map((e) => String(e.id));
  const pendingIds = m.pending.map((p) => String(p.contribution_id));
  const block = (error: "duplicate_claim" | "already_voted" | "claim_mismatch", message: string): SameClaimDecision =>
    ({ action: "block", error, message, existing_ids: existingIds, pending_ids: pendingIds });

  if (resolved.kind === "new") {
    if (existingIds.length === 0 && pendingIds.length === 0) return { action: "insert" };
    return block(
      "duplicate_claim",
      `同一件事已經有了（在庫：${existingIds.join("、") || "無"}／審議中：${pendingIds.join("、") || "無"}），這筆沒有收。` +
        "內容一致就把 resolved_claim 改成那一筆的 id；內容不同就寫 \"differs:<id>\"，note 寫差在哪、哪個出典，再交一次",
    );
  }
  const id = resolved.id;
  const inExisting = existingIds.includes(id);
  const pending = m.pending.find((p) => String(p.contribution_id) === id);
  if (!inExisting && !pending) {
    return block(
      "claim_mismatch",
      `resolved_claim 指的 ${id} 不是這筆的同一件事（比對到的：在庫 ${existingIds.join("、") || "無"}／審議中 ${pendingIds.join("、") || "無"}），這筆沒有收`,
    );
  }
  if (resolved.kind === "differs") return { action: "insert" };
  if (pending) {
    if (pending.your_network_voted || pending.yours) {
      return block("already_voted", `${id} 是這個來源網段交的、或已經投過票，一台機器只有一票；這筆沒有收，別再交同一件事，去做別的任務`);
    }
    return { action: "vote", contribution_id: id };
  }
  return { action: "existing", id };
}
