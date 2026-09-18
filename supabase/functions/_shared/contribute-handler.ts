/**
 * contribute 的核心邏輯：POST /contribute 與 POST /report{kind:"contribute"} 共用。
 * 只寫 contributions（待審佇列）；schema 驗證、來源網址格式、每 IP 每日限額、24 小時去重。
 */

import { canonicalPayload, ENCODING_INVALID_MESSAGE, sha256Hex, validateContributionRequest } from "./contribution-schema.ts";
import { requiredAgree } from "./consensus.ts";
import { blockedSingleAnswerIndexes, IN_FLIGHT_STATUSES } from "./single-answer-guard.ts";
import { policyLikenessNotice } from "./policy-likeness.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/**
 * 每個來源 IP 每日最多提交幾筆。
 * 2026-09-14：「初期改 200 筆」——現在瓶頸是沒人來貢獻，不是有人灌水，
 * 額度卡住的是自己人。等真的有外部代理進來、也真的出現濫用再往下收。
 */
export const CONTRIBUTE_DAILY_LIMIT_PER_IP = 200;
export const DEDUPE_WINDOW_HOURS = 24;
const SITE_URL = "https://policy-tw.web.app";

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function ipHashOf(req: Request, ipSalt: string): Promise<string> {
  return await sha256Hex(`${ipSalt}|${clientIp(req)}`);
}

/** 撈這批任務的型別與同 IP 排隊中的貢獻，交給純函式判斷要擋哪幾筆 */
async function findBlockedSingleAnswers(supabase: SupabaseLike, items: ReadonlyArray<{ task_id?: string | null }>, ipHash: string): Promise<Set<number>> {
  const taskIds = [...new Set(items.map((it) => it.task_id).filter((t): t is string => typeof t === "string" && t.length > 0))];
  if (taskIds.length === 0) return new Set();
  const manualIds = taskIds.filter((t) => !t.startsWith("auto:") && UUID_RE.test(t));
  const [manualRes, inFlightRes] = await Promise.all([
    manualIds.length > 0
      ? supabase.from("contribution_tasks").select("id, task_type").in("id", manualIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("contributions").select("task_id").eq("contributor_ip_hash", ipHash)
      .in("task_id", taskIds).in("status", [...IN_FLIGHT_STATUSES]).limit(1000),
  ]);
  if (manualRes.error) throw new Error(`task types lookup: ${manualRes.error.message}`);
  if (inFlightRes.error) throw new Error(`in-flight lookup: ${inFlightRes.error.message}`);
  const manualTypes = new Map<string, string>(((manualRes.data ?? []) as Array<{ id: string; task_type: string }>).map((r) => [r.id, r.task_type]));
  const inFlight = new Set<string>(((inFlightRes.data ?? []) as Array<{ task_id: string }>).map((r) => r.task_id));
  return blockedSingleAnswerIndexes(items, manualTypes, inFlight);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleContribute(supabase: SupabaseLike, supabaseUrl: string, body: unknown, ipHash: string): Promise<HandlerResult> {
  const validation = validateContributionRequest(body);
  if (!validation.ok) {
    const encoding = validation.errors.some((e) => e.code === "encoding_invalid");
    const category = validation.errors.some((e) => e.code === "category_invalid");
    const error = encoding ? "encoding_invalid" : category ? "category_invalid" : "validation_failed";
    const message = encoding
      ? ENCODING_INVALID_MESSAGE
      : category
      ? validation.errors.find((e) => e.code === "category_invalid")!.message
      : "有欄位不合格，整批未收；請依 errors 修正後重送（格式見 skill.md）";
    return { status: 400, body: { success: false, error, message, errors: validation.errors } };
  }

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count: usedToday, error: countError } = await supabase
    .from("contributions").select("id", { count: "exact", head: true })
    .eq("contributor_ip_hash", ipHash).gte("created_at", todayStart.toISOString());
  if (countError) throw new Error(`rate limit lookup: ${countError.message}`);
  const used = usedToday ?? 0;
  if (used + validation.items.length > CONTRIBUTE_DAILY_LIMIT_PER_IP) {
    return {
      status: 429,
      body: { success: false, error: "rate_limited", message: `每個來源 IP 每日最多 ${CONTRIBUTE_DAILY_LIMIT_PER_IP} 筆，今日已用 ${used}，這批 ${validation.items.length} 筆放不下`, retry_after: "tomorrow (UTC)" },
    };
  }

  // 單一答案型任務：同 IP 已有一份在排隊就不收第二份（見 single-answer-guard.ts）
  const blocked = await findBlockedSingleAnswers(supabase, validation.items, ipHash);

  const hashes = await Promise.all(validation.items.map((item) => sha256Hex(canonicalPayload(item))));
  const since = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { data: existing, error: dupError } = await supabase
    .from("contributions").select("id, payload_hash, status").in("payload_hash", hashes).gte("created_at", since);
  if (dupError) throw new Error(`dedupe lookup: ${dupError.message}`);
  type ExistingRow = { id: string; payload_hash: string; status: string };
  const existingByHash = new Map<string, ExistingRow>(((existing ?? []) as ExistingRow[]).map((r) => [r.payload_hash, r]));

  const toInsert = validation.items
    .map((item, i) => ({ item, hash: hashes[i], i }))
    .filter(({ hash, i }) => !existingByHash.has(hash) && !blocked.has(i))
    .map(({ item, hash }) => ({
      contribution_type: item.contribution_type,
      payload: item.payload,
      source_urls: item.source_urls,
      note: item.note ?? null,
      task_id: item.task_id ?? null,
      agent_name: validation.contributor.agent_name,
      agent_tool: validation.contributor.agent_tool ?? null,
      contributor_url: validation.contributor.url ?? null,
      contributor_ip_hash: ipHash,
      payload_hash: hash,
    }));

  let inserted: Array<{ id: string; payload_hash: string }> = [];
  if (toInsert.length > 0) {
    const { data, error } = await supabase.from("contributions").insert(toInsert).select("id, payload_hash");
    if (error) throw new Error(`contributions insert: ${error.message}`);
    inserted = data ?? [];
  }
  const insertedByHash = new Map(inserted.map((r) => [r.payload_hash, r.id]));

  // 提交後釋放該任務的軟認領（別人可以接手同一目標）
  const taskIds = [...new Set(validation.items.map((it) => it.task_id).filter((t): t is string => typeof t === "string"))];
  if (taskIds.length > 0) {
    const { error: leaseError } = await supabase.from("contribution_task_leases").delete().in("task_id", taskIds);
    if (leaseError) console.error("lease release failed:", leaseError.message);
  }

  const results = validation.items.map((item, i) => {
    if (blocked.has(i) && !existingByHash.has(hashes[i])) {
      return {
        index: i,
        contribution_type: item.contribution_type,
        contribution_id: null,
        status: "already_submitted",
        message: "這個任務只收一份，你（同一個來源 IP）已經有一份在等票；等它定案，或去 GET /next 領別的",
      };
    }
    const hash = hashes[i];
    const dup = existingByHash.get(hash);
    const id = dup ? dup.id : insertedByHash.get(hash)!;
    const need = requiredAgree(item.contribution_type, item.payload, item.source_urls);
    return {
      index: i,
      contribution_type: item.contribution_type,
      contribution_id: id,
      status: dup ? "duplicate" : "pending",
      required_agree: need,
      // 疑似口號／行程／個人表態：收下但當場告訴提交者，驗證者也會看到同一句（見 policy-likeness.ts）
      ...(item.contribution_type === "policy"
        ? (() => {
          const p = (item.payload && typeof item.payload === "object" ? item.payload : {}) as Record<string, unknown>;
          const notice = policyLikenessNotice(p.title, p.description);
          return notice ? { warning: notice } : {};
        })()
        : {}),
      ...(dup ? { existing_status: dup.status, message: `${DEDUPE_WINDOW_HOURS} 小時內已有相同內容的貢獻，沿用原 id` } : {}),
      review_url: `${supabaseUrl}/functions/v1/contribution-status?id=${id}`,
    };
  });

  const needs = [...new Set(results.map((r) => ("required_agree" in r ? r.required_agree : null)).filter((n): n is number => typeof n === "number"))].sort((a, b) => a - b);
  const single = !Array.isArray((body as Record<string, unknown>).contributions);
  // 整批都是「已經交過一份」：不是成功，回 409 讓代理知道去領別的
  if (results.every((r) => r.status === "already_submitted")) {
    return {
      status: 409,
      body: { success: false, error: "already_submitted", message: results[0].message, ...(single ? results[0] : { results }), docs: `${SITE_URL}/skill.md` },
    };
  }
  return {
    status: 201,
    body: {
      success: true,
      message: `已收到 ${inserted.length} 筆新貢獻${results.length - inserted.length > 0 ? `（${results.length - inserted.length} 筆重複）` : ""}；通過 ${needs.join("／")} 票同儕驗證後自動上線（required_agree=${needs.join("／")}），有爭議或疑似重複才由維護者處理`,
      agent_name: validation.contributor.agent_name,
      ...(single ? results[0] : { results }),
      daily_quota: { limit: CONTRIBUTE_DAILY_LIMIT_PER_IP, used: used + inserted.length },
      docs: `${SITE_URL}/skill.md`,
    },
  };
}
