/**
 * contribute 的核心邏輯：POST /contribute 與 POST /report{kind:"contribute"} 共用。
 * 只寫 contributions（待審佇列）；schema 驗證、來源網址格式、每 IP 每日限額、24 小時去重。
 */

import { canonicalPayload, ENCODING_INVALID_MESSAGE, sha256Hex, validateContributionRequest } from "./contribution-schema.ts";
import { type Actor, resolveActor, resolveActorFromRequest } from "./actor.ts";
import { requiredAgree } from "./consensus.ts";
import { blockedSingleAnswerIndexes, IN_FLIGHT_STATUSES } from "./single-answer-guard.ts";
import { checkNoOp, type NoOpCheck, normalizeCorrection } from "./correction.ts";
import { withTaskPolitician } from "./task-politician.ts";
import { CORRECTION_FIELDS } from "./contribution-schema.ts";
import { policyLikenessNotice } from "./policy-likeness.ts";
import { claimKey, claimTarget, type ExistingClaim, findMergeTarget, findSameMachineClaim } from "./duplicate-claim.ts";
import { handleVerify } from "./verify-handler.ts";

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

/** 投票端（預設 handleVerify；測試可換掉） */
export type VerifyFn = typeof handleVerify;

/**
 * 撈「可能是同一個宣稱」的待驗證貢獻。
 * 依 (型別, 對象欄位) 分組，每組一次查詢——不是每筆一次，也不是整張表拉回來。
 */
async function fetchClaimCandidates(
  supabase: SupabaseLike,
  items: ReadonlyArray<{ contribution_type: string; payload: unknown }>,
): Promise<ExistingClaim[]> {
  const groups = new Map<string, { type: string; field: string; values: Set<string> }>();
  for (const item of items) {
    const target = claimTarget(item.contribution_type, item.payload);
    if (!target || claimKey(item.contribution_type, item.payload) === null) continue;
    const gk = `${item.contribution_type}|${target.field}`;
    const g = groups.get(gk) ?? { type: item.contribution_type, field: target.field, values: new Set<string>() };
    g.values.add(target.value);
    groups.set(gk, g);
  }
  if (groups.size === 0) return [];
  const rows = await Promise.all([...groups.values()].map(async (g) => {
    const { data, error } = await supabase.from("contributions")
      .select("id, contribution_type, payload, agent_name, contributor_ip_hash, status")
      .eq("contribution_type", g.type).eq("status", "pending")
      .in(`payload->>${g.field}`, [...g.values])
      .order("created_at", { ascending: true }).limit(200);
    if (error) throw new Error(`claim candidates (${g.type}): ${error.message}`);
    return (data ?? []) as ExistingClaim[];
  }));
  return rows.flat();
}

/** 合併時寫進票裡的理由——事後在查核履歷上看得出這票是怎麼來的 */
function mergeNote(agentName: string, sourceUrls: readonly string[], note: string | null | undefined): string {
  const head = `這票來自重複提交：${agentName} 獨立查證後提交了同一個宣稱，系統改記為對這一筆的同意票。`;
  const src = sourceUrls.length > 0 ? `對方的來源：${sourceUrls.join("、")}` : "";
  const own = note ? `對方備註：${note}` : "";
  return [head, src, own].filter(Boolean).join(" ").slice(0, 2000);
}

export async function handleContribute(supabase: SupabaseLike, supabaseUrl: string, body: unknown, ipHash: string, verifyFn: VerifyFn = handleVerify, via = "contribute"): Promise<HandlerResult> {
  // 身份：agent_name 可能是 ditrust:<序號>，先換成代號與身份鍵，再做格式驗證（序號不能當代號收進去）
  const identity = await resolveIdentity(body, ipHash);
  if (!identity.ok) return { status: identity.status, body: { success: false, error: "identity_invalid", message: identity.error } };
  body = identity.body;
  const actor: Actor = identity.actor;
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
  // profile_gap 交的 politician 沒帶 id → 用任務編號裡的那位補上（存進 payload，驗證時的身份比對與落庫都看得到）
  for (const item of validation.items) {
    (item as { payload: unknown }).payload = withTaskPolitician(item.contribution_type, item.payload, item.task_id);
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
  // 提問任務只收 question_answer（2026-09-20）：no_change 通過會把提問任務關掉，訪客卻永遠看到「AI 正在查證」。
  // 查不到、連結打不開也要回一份說明——那才是訪客看得到的東西。
  const manualNoChange = validation.items.filter((it) => it.contribution_type === "no_change" && typeof it.task_id === "string" && !it.task_id.startsWith("auto:")).map((it) => it.task_id as string);
  if (manualNoChange.length > 0) {
    const { data: qTasks } = await supabase.from("contribution_tasks").select("id").in("id", manualNoChange).eq("task_type", "question").limit(50);
    if ((qTasks ?? []).length > 0) {
      return { status: 400, body: { success: false, error: "question_needs_answer", message: "提問任務只收 question_answer：查不到、連結需登入打不開，也請用 question_answer 回一份說明（訪客看得到的是回答，不是 no_change）", task_ids: ((qTasks ?? []) as Array<{ id: string }>).map((t) => t.id) } };
    }
  }
  const blocked = await findBlockedSingleAnswers(supabase, validation.items, ipHash);

  const hashes = await Promise.all(validation.items.map((item) => sha256Hex(canonicalPayload(item))));
  const since = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { data: existing, error: dupError } = await supabase
    .from("contributions").select("id, payload_hash, status").in("payload_hash", hashes).gte("created_at", since);
  if (dupError) throw new Error(`dedupe lookup: ${dupError.message}`);
  type ExistingRow = { id: string; payload_hash: string; status: string };
  const existingByHash = new Map<string, ExistingRow>(((existing ?? []) as ExistingRow[]).map((r) => [r.payload_hash, r]));

  /**
   * 重複提交＝同意票（2026-09-18）。
   *
   * 兩個代理各自查證後得到同一個宣稱，比「看別人交的東西投一票」更強的證據，
   * 但原本是各躺各的、兩筆都 0 票——李四川那 21 筆堆積就是這麼來的。
   * 實測線上 1,207 筆 pending 有 110 對這種配對（涉及 152 筆）。
   *
   * 只對結構化型別生效（見 duplicate-claim.ts），而且走 handleVerify 投票——
   * 自驗、重複票、每日額度、自動落庫、爭議建案全部沿用既有那一套，這裡不另開一條路。
   * 投不成（自己那台交的／已投過／對方剛定案／額度用完）就照原路收下這筆，不能默默丟掉。
   */
  const mergedByIndex = new Map<number, { existing_id: string; agree_count: number; status: string; required_agree: number; from_agent: string | null }>();
  /** 同對象的既有提交是同一台機器（同 IP）交的：不能併成票，但要告訴它，不然它會一直重交（2026-09-22） */
  const sameMachineDup = new Map<number, string>();
  const mergeCandidateIdx = validation.items
    .map((item, i) => ({ item, i }))
    .filter(({ item, i }) => !existingByHash.has(hashes[i]) && !blocked.has(i) && claimKey(item.contribution_type, item.payload) !== null);
  if (mergeCandidateIdx.length > 0) {
    const candidates = await fetchClaimCandidates(supabase, mergeCandidateIdx.map(({ item }) => item));
    const claimed = new Set<string>(); // 同一批裡兩筆指向同一個既有貢獻時，只投一票
    for (const { item, i } of mergeCandidateIdx) {
      const target = findMergeTarget(item, { agent_name: validation.contributor.agent_name, ip_hash: ipHash }, candidates);
      if (!target) {
        const sameMachine = findSameMachineClaim(item, { agent_name: validation.contributor.agent_name, ip_hash: ipHash }, candidates);
        if (sameMachine) sameMachineDup.set(i, sameMachine.id);
        continue;
      }
      if (claimed.has(target.id)) continue;
      const voted = await verifyFn(supabase, {
        contribution_id: target.id,
        verdict: "agree",
        agent_name: validation.contributor.agent_name,
        ...(validation.contributor.agent_tool ? { agent_tool: validation.contributor.agent_tool } : {}),
        note: mergeNote(validation.contributor.agent_name, item.source_urls, item.note),
        ...(item.source_urls[0] ? { evidence_url: item.source_urls[0] } : {}),
      // via "merge"：這一票是系統把重複提交配對成的，不是代理自己挑的題目——派發閘對它放行。
      // 2026-09-21 派發閘上線後，這條路安靜地被關了 10 小時（每筆重複都變新件），leatherback 打端點才發現。
      }, ipHash, undefined, "merge");
      if (voted.status !== 201) continue; // 投不成就照原路收下
      claimed.add(target.id);
      const b = voted.body as Record<string, unknown>;
      mergedByIndex.set(i, {
        existing_id: target.id,
        agree_count: typeof b.agree_count === "number" ? b.agree_count : 0,
        status: typeof b.status === "string" ? b.status : "pending",
        required_agree: typeof b.required_agree === "number" ? b.required_agree : 0,
        from_agent: target.agent_name,
      });
    }
  }

  // 空操作的更正在這裡擋掉（2026-09-21，兩隻跑任務的代理各自獨立回報）：
  // 改完之後值跟現在一樣的 correction，照樣佔一個驗證名額、要好幾票、通過還寫一筆
  // edit_history。而驗證票是最稀缺的資源（全站 1,400+ 筆待驗證）。
  // 成因多半是資料新鮮度——提交者看到的是舊的，別人已經修好了。
  const noOpIndexes = new Map<number, NoOpCheck>();
  // #6（2026-09-22）：一筆多個 change 只有部分是 no-op → 收下，但當場告訴提交者哪幾欄白做（不擋）
  const partialNoOp = new Map<number, string[]>();
  {
    const corrections = validation.items
      .map((item, i) => ({ item, i }))
      .filter(({ item, i }) => item.contribution_type === "correction" && !blocked.has(i) && !mergedByIndex.has(i));
    for (const { item, i } of corrections) {
      const { target_table, target_id } = normalizeCorrection(item.payload);
      if (!target_table || !target_id) continue;
      const cols = CORRECTION_FIELDS[target_table as keyof typeof CORRECTION_FIELDS];
      if (!cols) continue;
      try {
        // query-bounds: ok — 按 id 取一列
        const { data: row } = await supabase.from(target_table).select(["id", ...cols].join(", ")).eq("id", target_id).maybeSingle();
        const check = checkNoOp(item.payload, row as Record<string, unknown> | null);
        if (check.allNoOp) noOpIndexes.set(i, check);
        else if (check.fields.some((f) => f.same)) partialNoOp.set(i, check.fields.filter((f) => f.same).map((f) => f.field));
      } catch { /* 查不到就不擋，讓它照常走驗證 */ }
    }
  }
  if (noOpIndexes.size > 0 && noOpIndexes.size === validation.items.filter((_, i) => !blocked.has(i) && !mergedByIndex.has(i)).length) {
    const first = [...noOpIndexes.values()][0];
    return {
      status: 400,
      body: {
        success: false,
        error: "no_op_correction",
        message: "這筆更正改完之後值跟現在一樣——資料已經是對的了，可能是別人先修好了。請重新讀一次現值再決定要不要提交；**這不算你做錯**，也不計入你的退件。",
        fields: first.fields.map((f) => ({ field: f.field, db_current: f.db_current,correct_value: f.correct_value })),
      },
    };
  }

  const toInsert = validation.items
    .map((item, i) => ({ item, hash: hashes[i], i }))
    .filter(({ hash, i }) => !existingByHash.has(hash) && !blocked.has(i) && !mergedByIndex.has(i))
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
      // 身份鍵：去重與歸戶看這個，agent_name 只給人看（docs/BLUEPRINT-agent-identity.md §3）
      actor_id: actor.actor_id,
      payload_hash: hash,
      // 從哪個端點進來的：要收掉舊端點之前，得先看得到還有誰在用（2026-09-21）
      via,
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
    const merged = mergedByIndex.get(i);
    if (merged) {
      return {
        index: i,
        contribution_type: item.contribution_type,
        contribution_id: merged.existing_id,
        status: "counted_as_vote",
        agree_count: merged.agree_count,
        required_agree: merged.required_agree,
        message: `${merged.from_agent ?? "另一個代理"} 已經交過同一個宣稱，你這筆改記為對那一筆的同意票（目前同意 ${merged.agree_count}／${merged.required_agree}${merged.status === "applied" ? "，已上線" : ""}）。下次可以先看 /verifications 有沒有人交過，直接投票比重交一份快。`,
        review_url: `${supabaseUrl}/functions/v1/contribution-status?id=${merged.existing_id}`,
      };
    }
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
      ...(sameMachineDup.has(i) ? { note: `同一台機器（同來源 IP）已經交過同對象的同一件事（${sameMachineDup.get(i)}），你這筆**不會**算成對它的同意票——一台機器只有一票。之後同對象的別再交，去驗別人的。` } : {}),
      ...(partialNoOp.has(i) ? { warning: `這幾欄改完跟現值一樣（別人先修好了）：${partialNoOp.get(i)!.join("、")}；只有其餘欄位會被驗證與套用` } : {}),
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
      message: [
        `已收到 ${inserted.length} 筆新貢獻`,
        mergedByIndex.size > 0 ? `${mergedByIndex.size} 筆與別人交過的是同一件事，改記為對那幾筆的同意票` : "",
        results.length - inserted.length - mergedByIndex.size > 0 ? `${results.length - inserted.length - mergedByIndex.size} 筆重複` : "",
      ].filter(Boolean).join("；") + `；通過 ${needs.join("／")} 票同儕驗證後自動上線（required_agree=${needs.join("／")}），有爭議或疑似重複才由維護者處理`,
      agent_name: validation.contributor.agent_name,
      ...(single ? results[0] : { results }),
      daily_quota: { limit: CONTRIBUTE_DAILY_LIMIT_PER_IP, used: used + inserted.length },
      docs: `${SITE_URL}/skill.md`,
    },
  };
}

/** 把 body.agent_name 從 ditrust:<序號> 換成代號；回新的 body 與身份。一般代號原樣通過 */
export async function resolveIdentity(body: unknown, ipHash: string): Promise<
  { ok: true; body: unknown; actor: Actor } | { ok: false; status: number; error: string }
> {
  const raw = (body && typeof body === "object") ? body as Record<string, unknown> : null;
  const name = raw && typeof raw.agent_name === "string" ? raw.agent_name : "";
  const outcome = await resolveActorFromRequest(name, ipHash);
  if (!outcome.ok) return outcome;
  const next = raw && outcome.actor.level !== "ip" ? { ...raw, agent_name: outcome.actor.handle } : body;
  return { ok: true, body: next, actor: outcome.actor };
}
