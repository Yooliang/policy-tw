/**
 * 強模型待辦（2026-11-09，協議 1.126.0）：太難、一般代理投不出共識的交件，開一件標 `target.requires_tier='strong'` 的 adjudicate 任務，
 * 不進一般派工（`/next` 不派、`contribution_queue_tasks` 排除），只由「持有 STRONG_LANE_KEY 的人」用 `GET /next?lane=strong` 明確認領，
 * 用 `POST /report`（帶同一把鑰匙，標頭 x-strong-lane-key）交一份裁決，單一裁決即定案（見 apply-contribution.ts applyAdjudication）。
 *
 * 授權只看鑰匙：agent_name／agent_tool 是自報的、驗不了真假，只記錄供稽核，絕不拿來判斷能不能認領或交裁決。
 */

export const STRONG_TIER = "strong";
export const STRONG_KEY_HEADER = "x-strong-lane-key";
/** 單一裁決定案的標記：寫在裁決那筆貢獻的 reviewed_by（只有系統程式會寫，代理的 payload 寫不進去） */
export const STRONG_REVIEWER = "strong-adjudication";
export const STRONG_LEASE_MINUTES = 30;
export const STRONG_VERDICTS = ["uphold", "reject", "uphold_with_correction"] as const;
/** 鑰匙至少這麼長才算設好（太短當沒設，整條線關閉） */
export const STRONG_KEY_MIN_LENGTH = 16;
/** uphold_with_correction 最多改幾個欄位、單欄值最長 */
export const MAX_CORRECTED_FIELDS = 30;
/** 不准用更正去改的欄位（裁決指向的任務、身份由 resolved_politician_id 另外處理） */
export const CORRECTION_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["task_id", "contribution_id", "__proto__", "constructor"]);

type Obj = Record<string, unknown>;

export function isStrongTarget(target: unknown): boolean {
  return !!target && typeof target === "object" && (target as Obj).requires_tier === STRONG_TIER;
}

/** 常數時間比對；沒設鑰匙（或太短）一律不通過 */
export function strongKeyOk(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected || expected.length < STRONG_KEY_MIN_LENGTH) return false;
  if (!provided) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function strongKeyFromRequest(req: Request, env: (k: string) => string | undefined): boolean {
  return strongKeyOk(req.headers.get(STRONG_KEY_HEADER), env("STRONG_LANE_KEY"));
}

/** 純函式：把 corrected_fields（淺層差異，值 null＝刪欄位）套到原 payload；回新 payload 與每欄「前→後」 */
export function applyPayloadCorrection(original: Obj, fields: Obj): { payload: Obj; diff: Array<{ field: string; before: unknown; after: unknown }> } {
  const payload: Obj = { ...original };
  const diff: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const [k, v] of Object.entries(fields)) {
    if (CORRECTION_FORBIDDEN_KEYS.has(k)) continue;
    const before = original[k];
    if (JSON.stringify(before) === JSON.stringify(v === null ? undefined : v)) continue;
    if (v === null) delete payload[k]; else payload[k] = v;
    diff.push({ field: k, before: before ?? null, after: v });
  }
  return { payload, diff };
}

export function correctionProblems(fields: unknown): string | null {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return "uphold_with_correction 要帶 corrected_fields（物件：要改的欄位 → 改好的值，null＝刪掉該欄）";
  const keys = Object.keys(fields as Obj);
  if (keys.length === 0) return "corrected_fields 不能是空的；原貢獻不用改就用 uphold";
  if (keys.length > MAX_CORRECTED_FIELDS) return `corrected_fields 最多 ${MAX_CORRECTED_FIELDS} 個欄位`;
  const bad = keys.filter((k) => CORRECTION_FORBIDDEN_KEYS.has(k));
  if (bad.length > 0) return `corrected_fields 不能改：${bad.join("、")}`;
  return null;
}

export function diffText(diff: ReadonlyArray<{ field: string; before: unknown; after: unknown }>): string {
  return diff.map((d) => `${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join("；").slice(0, 800);
}

export interface StrongVote { verdict: string; agent_name: string | null; agent_tool?: string | null; note: string | null; evidence_url: string | null; created_at?: string }

export const STRONG_INSTRUCTIONS =
  "這是一般代理投不出共識的難題，由你單獨裁決，你的一份裁決就是定案（不再等 3 票）。請：" +
  "①逐一打開 hint_sources 與每張票的 evidence_url，自己查原始來源，不要只信票上的結論；" +
  "動態網頁（例如 lawmaker.twreporter.org 這類先載空殼再用 JS 載資料的站）不要只看 HTML，改找它背後的 API／JSON；" +
  "②檢查 election_id（是不是對的那一屆）、人物身份（同名不同人、同一人被重複建）、有沒有重複的既有紀錄、來源是否真的支持每個欄位；" +
  "③用 POST /report（kind:'contribute'，標頭帶 x-strong-lane-key）交 contribution_type=adjudication，payload＝{contribution_id, verdict, reason（≥20 字，寫清楚查了什麼）, checked_urls[]}。verdict 三選一：" +
  "uphold（原貢獻正確，照原樣落庫）；reject（原貢獻有誤，退件，reason 會記進退件說明）；" +
  "uphold_with_correction（大致正確但有欄位要改：另帶 corrected_fields＝{欄位: 改好的值}，null＝刪欄位，系統先套這個差異再落庫，每個欄位的前後值會記進紀錄）。" +
  "身份爭議可加 resolved_politician_id。" +
  "④單一裁決即定案：交出後立刻落庫（或退件）並關閉任務，記下裁決者與自報模型；認領 30 分鐘，逾時別人可再領；不能認領自己交的件；uphold_with_correction 套完差異後仍須通過一般交件驗證，否則 400 correction_invalid。";

/** 組給認領者的完整簡報（純函式） */
export function buildStrongBrief(
  task: { id: string; title: string; description: string | null; target: Obj; hint_sources: string[] | null; created_at?: string },
  original: { id: string; contribution_type: string; payload: Obj; source_urls: string[] | null; agent_name: string | null; agent_tool?: string | null; status: string; review_notes?: string | null; agree_count?: number; disagree_count?: number; unsure_count?: number } | null,
  votes: readonly StrongVote[],
): Obj {
  const evidence = votes.map((v) => v.evidence_url).filter((u): u is string => typeof u === "string" && u.length > 0);
  return {
    task_id: task.id,
    task_type: "adjudicate",
    tier: STRONG_TIER,
    title: task.title,
    description: task.description,
    contribution: original,
    votes: votes.map((v) => ({ verdict: v.verdict, agent: v.agent_name, agent_tool: v.agent_tool ?? null, reason: v.note, evidence_url: v.evidence_url, at: v.created_at ?? null })),
    hint_sources: [...new Set([...(task.hint_sources ?? []), ...(original?.source_urls ?? []), ...evidence])],
    instructions: STRONG_INSTRUCTIONS,
    verdicts: STRONG_VERDICTS,
    report_how: "POST /report 帶標頭 x-strong-lane-key；body {kind:'contribute', agent_name, agent_tool, contribution_type:'adjudication', payload:{contribution_id:'" + (original?.id ?? "") + "', verdict, reason, checked_urls, corrected_fields?}, source_urls?}",
  };
}
