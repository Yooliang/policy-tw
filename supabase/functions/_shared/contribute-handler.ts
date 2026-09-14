/**
 * contribute 的核心邏輯：POST /contribute 與 POST /report{kind:"contribute"} 共用。
 * 只寫 contributions（待審佇列）；schema 驗證、來源網址格式、每 IP 每日限額、24 小時去重。
 */

import { canonicalPayload, ENCODING_INVALID_MESSAGE, sha256Hex, validateContributionRequest } from "./contribution-schema.ts";
import { requiredAgree } from "./consensus.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/**
 * 每個來源 IP 每日最多提交幾筆。
 * 2026-09-14 小良哥：「初期改 200 筆」——現在瓶頸是沒人來貢獻，不是有人灌水，
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

  const hashes = await Promise.all(validation.items.map((item) => sha256Hex(canonicalPayload(item))));
  const since = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { data: existing, error: dupError } = await supabase
    .from("contributions").select("id, payload_hash, status").in("payload_hash", hashes).gte("created_at", since);
  if (dupError) throw new Error(`dedupe lookup: ${dupError.message}`);
  type ExistingRow = { id: string; payload_hash: string; status: string };
  const existingByHash = new Map<string, ExistingRow>(((existing ?? []) as ExistingRow[]).map((r) => [r.payload_hash, r]));

  const toInsert = validation.items
    .map((item, i) => ({ item, hash: hashes[i] }))
    .filter(({ hash }) => !existingByHash.has(hash))
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
      ...(dup ? { existing_status: dup.status, message: `${DEDUPE_WINDOW_HOURS} 小時內已有相同內容的貢獻，沿用原 id` } : {}),
      review_url: `${supabaseUrl}/functions/v1/contribution-status?id=${id}`,
    };
  });

  const needs = [...new Set(results.map((r) => r.required_agree))].sort((a, b) => a - b);
  const single = !Array.isArray((body as Record<string, unknown>).contributions);
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
