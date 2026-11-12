/**
 * 一人一包 PR4：驗證端（docs/PLAN-bundle-policies.md 第 3、4 節；協議 1.131.0）。
 *
 *   /next：派出的驗證票是包的載體（bundle_carrier_id）時，item 多一個 bundle（loadBundleItem）。舊代理拿到同一個 item，只是多一個欄位。
 *   /report verify：載體帶 bundle_id 走 handleBundleVerify，呼叫 SQL bundle_vote_fanout 扇出成逐條票；
 *                   載體還在包裡卻沒帶 bundle_id → 400 bundle_vote_required（不靜默只投載體一條）。
 *
 * 計分、共識、落庫全走原路（逐列 contribution_votes 觸發器）；載體那條投完照舊即時 autoApply，其餘條目交 apply-verified 掃地機，
 * 不在單一請求內對 30 條各呼叫 autoApplyContribution。
 */
import type { HandlerResult } from "./contribute-handler.ts";
import { type ApplyFn, autoApplyContribution, shouldAutoApply } from "./auto-apply.ts";
import { BLIND_DISAGREE_NOTE, isBlindDisagree, isRepeatedNote, voterKey } from "./consensus.ts";
import { checkIdentityPick } from "./identity-pick-gate.ts";
import { sharedBulletinUrl } from "./policy-bundle.ts";
import type { VerifyInput } from "./contribution-schema.ts";
import { PROTOCOL_URL } from "./protocol.ts";
import type { Actor } from "./actor.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

/** 包票備註至少幾字（一票等於 N 票，橡皮圖章加嚴；主線拍板 2026-11-12） */
export const BUNDLE_NOTE_MIN = 40;
/** 例外條的理由至少幾字 */
export const BUNDLE_REASON_MIN = 10;
/** 同一投票人對同一提交者的整包 disagree，這段時間內最多一包（防報復） */
export const BUNDLE_DISAGREE_WINDOW_HOURS = 24;

export const BUNDLE_VOTE_REQUIRED_MESSAGE =
  "這張票是「整包一張票」：item.bundle 列出這包的所有條目，一票會逐條記到每一條。你的回報沒有帶 bundle_id，伺服器不會只替載體那一條投票（這次送的票沒有計入）。" +
  `請升級到協議 1.131.0（重讀 ${PROTOCOL_URL}），回報帶 bundle_id（item.bundle.bundle_id）、note（至少 40 字，寫出核對了公報哪幾頁）；` +
  "有不放行的條目用 except 與 reasons 列出。不是你的錯，這次不算被拒。";

const obj = (v: unknown): Obj => (v && typeof v === "object" ? v as Obj : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

const PAGE_RE = /第\s*[0-9０-９一二三四五六七八九十百]+\s*頁|(?:^|[^a-z])(?:p|pp|page)\.?\s*[0-9０-９]+|[0-9０-９]+\s*頁/i;
/** 備註有沒有提到頁碼（只用來提醒，不擋） */
export function mentionsPage(note: string | null | undefined): boolean {
  return PAGE_RE.test(note ?? "");
}

export interface BundleRow {
  id: string;
  bundle_index: number;
  contribution_type: string;
  payload: unknown;
  task_id: string | null;
  source_urls: string[] | null;
}

export interface BundleItemView {
  bundle_id: string;
  source_url: string | null;
  items: Array<{ index: number; contribution_id: string; title: unknown; description: unknown; category: unknown }>;
}

const ROW_COLUMNS = "id, bundle_index, contribution_type, payload, task_id, source_urls";

/** 還在包裡、pending 的條目（依序號）。query-bounds: ok — 一包最多 100 條（queue_settings.bundle_max_items 上限） */
async function openRows(supabase: SupabaseLike, bundleId: string): Promise<BundleRow[]> {
  const { data, error } = await supabase.from("contributions").select(ROW_COLUMNS)
    .eq("bundle_id", bundleId).is("bundle_released_at", null).eq("status", "pending").order("bundle_index", { ascending: true }).limit(100);
  if (error) throw new Error(`bundle items: ${error.message}`);
  return (Array.isArray(data) ? data : []) as BundleRow[];
}

/**
 * /next 用：這一筆是載體（還在包裡、是包裡 bundle_index 最小的 pending）時回 item.bundle，否則 null。
 * 永遠不丟錯（查不到就當不是包，派工照舊）。
 */
export async function loadBundleItem(supabase: SupabaseLike, contributionId: string): Promise<BundleItemView | null> {
  try {
    const { data: me, error } = await supabase.from("contributions").select("bundle_id, bundle_released_at").eq("id", contributionId).maybeSingle();
    if (error || !me || typeof me.bundle_id !== "string" || me.bundle_released_at) return null;
    const rows = await openRows(supabase, me.bundle_id);
    if (rows.length === 0 || rows[0].id !== contributionId) return null;
    return {
      bundle_id: me.bundle_id,
      source_url: sharedBulletinUrl(rows.map((r) => ({ contribution_type: r.contribution_type, payload: r.payload, source_urls: r.source_urls ?? [] }))),
      items: rows.map((r) => {
        const p = obj(r.payload);
        return { index: r.bundle_index, contribution_id: r.id, title: p.title ?? null, description: p.description ?? null, category: p.category ?? null };
      }),
    };
  } catch (e) {
    console.error("bundle item:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** how_to 附在包票後面的說明 */
export const BUNDLE_HOW_TO =
  "【整包一張票】這張票對應 item.bundle.items 的每一條（同一份公報）：打開 item.bundle.source_url，逐條核對。" +
  "POST /report {kind:'verify', contribution_id, bundle_id: item.bundle.bundle_id, verdict, note（至少 40 字，寫出核對了公報第幾頁）, evidence_url?(disagree 必附), except?:[序號…], reasons?:{序號:'與公報哪裡不符（至少 10 字）'}, agent_name, agent_tool, dispatch_token}。" +
  "except 只能搭 agree：被點名的條目不替你投票、釋放成各自的驗證票。整包 disagree 會對每一條各投一張反對，同一個提交者 24 小時內只能整包反對一次。";

export interface BundleVerifyCtx {
  supabase: SupabaseLike;
  input: VerifyInput;
  carrier: { id: string; bundle_id: string; agent_name: string; actor_id?: string | null };
  actor: Actor;
  ipHash: string;
  via: string;
  applyFn?: ApplyFn;
  /** 測試用：換掉逐條指認判斷 */
  pick?: (supabase: SupabaseLike, type: string, payload: Obj, taskId: unknown) => Promise<{ required: boolean }>;
}

const bad = (status: number, error: string, message: string, extra: Obj = {}): HandlerResult => ({ status, body: { success: false, error, message, ...extra } });

/** 純判斷：except／reasons／note 的檢查（不碰資料庫）。回 null＝通過 */
export function bundleInputProblem(input: VerifyInput, openIndexes: readonly number[], prevNote?: string | null): HandlerResult | null {
  const except = input.except ?? [];
  const stray = except.filter((i) => !openIndexes.includes(i));
  if (stray.length > 0) {
    return bad(400, "bundle_mismatch", `except 裡的序號 ${stray.join("、")} 不在這一包還沒釋放的條目裡（對照 item.bundle.items[].index）`, { indexes: stray });
  }
  if (except.length > 0 && input.verdict !== "agree") {
    return bad(400, "bundle_except_need_agree", "except 是「整包大致對、只有這幾條不放行」的同意票附的；整包不對請投 disagree（附 evidence_url 與 note），不確定請投 unsure。");
  }
  const reasons = input.reasons ?? {};
  const noReason = except.filter((i) => (reasons[String(i)] ?? "").trim().length < BUNDLE_REASON_MIN);
  if (noReason.length > 0) {
    return bad(400, "bundle_except_need_reason", `except 的每一條都要在 reasons 寫理由（至少 ${BUNDLE_REASON_MIN} 字：這一條與公報哪裡不符，或公報沒有這一條）；缺：${noReason.join("、")}。這次不算被拒。`, { indexes: noReason });
  }
  const note = (input.note ?? "").trim();
  if (note.length < BUNDLE_NOTE_MIN) {
    return bad(400, "bundle_note_too_short", `整包票的 note 至少 ${BUNDLE_NOTE_MIN} 字（一張票會記到每一條）：寫出你核對了公報哪幾頁、哪些條對得上。目前 ${note.length} 字。這次不算被拒。`);
  }
  if (prevNote && isRepeatedNote(note, prevNote)) {
    return bad(400, "note_repeated", "這句備註跟你上一票一字不差。每一包核對的是不同的頁面，請寫這一包你實際看到什麼（哪一頁、哪幾條）。改好再送一次，這次不算被拒。");
  }
  return null;
}

/** 整包 disagree：同一投票人對同一提交者 24 小時內是否已經整包反對過 */
async function disagreeRateLimited(supabase: SupabaseLike, key: string, submitter: { agent_name: string; actor_id?: string | null }): Promise<boolean> {
  const since = new Date(Date.now() - BUNDLE_DISAGREE_WINDOW_HOURS * 3_600_000).toISOString();
  const { data: mine, error } = await supabase.from("bundle_votes").select("bundle_id")
    .eq("voter_key", key).eq("verdict", "disagree").gte("created_at", since).limit(100);
  if (error) throw new Error(`bundle rate limit: ${error.message}`);
  const ids = ((mine ?? []) as Array<{ bundle_id: string }>).map((r) => r.bundle_id);
  if (ids.length === 0) return false;
  const { data: bundles, error: bErr } = await supabase.from("policy_bundles").select("id, agent_name, actor_id").in("id", ids).limit(100);
  if (bErr) throw new Error(`bundle rate limit bundles: ${bErr.message}`);
  const sub = submitter.agent_name.toLowerCase();
  return ((bundles ?? []) as Array<{ agent_name: string; actor_id?: string | null }>)
    .some((b) => b.agent_name.toLowerCase() === sub || (!!submitter.actor_id && b.actor_id === submitter.actor_id));
}

export async function handleBundleVerify(ctx: BundleVerifyCtx): Promise<HandlerResult> {
  const { supabase, input, carrier, actor, ipHash, via } = ctx;
  const voter = { agent_name: input.agent_name, actor_id: actor.actor_id };
  const key = voterKey(voter);
  const rows = await openRows(supabase, carrier.bundle_id);
  if (!rows.some((r) => r.id === carrier.id)) return bad(400, "bundle_mismatch", "這一筆已不在這一包裡（已釋放或已定案）；請領下一筆。這次不算被拒。");

  // 上一票的備註（重複備註守門）：同一個投票人最近一次整包票
  const { data: prev } = await supabase.from("bundle_votes").select("note").eq("voter_key", key).order("created_at", { ascending: false }).limit(1);
  const prevNote = Array.isArray(prev) && prev[0] ? (prev[0] as { note?: string | null }).note ?? null : null;
  const problem = bundleInputProblem(input, rows.map((r) => r.bundle_index), prevNote);
  if (problem) return problem;

  // 盲反對（比照一般票）：disagree 的理由是「打不開／確認不了」、沒有反證，改記 unsure，不對整包每一條各記 −1
  const carrierRow = rows.find((r) => r.id === carrier.id)!;
  const blind = input.verdict === "disagree" && isBlindDisagree(input.note, { evidenceUrl: input.evidence_url, sourceUrls: carrierRow.source_urls ?? [] });
  const verdict = blind ? "unsure" : input.verdict;
  const recordNote = blind ? `${BLIND_DISAGREE_NOTE}${input.note ?? ""}` : (input.note ?? null);
  if (verdict === "disagree" && await disagreeRateLimited(supabase, key, carrier)) {
    return bad(429, "bundle_rate_limited", `同一個提交者的整包，你 ${BUNDLE_DISAGREE_WINDOW_HOURS} 小時內已經整包反對過一次了；這次送的票沒有計入。請改用 except 只點名有問題的條目（投 agree），或稍後再試。`);
  }

  // 必須指認的條（站上同名多位、判不出是誰）：包票帶不了逐條指認，自動算例外、走個別票
  const explicit = new Set(input.except ?? []);
  const autoExcepted: number[] = [];
  const reasons: Record<string, string> = { ...(input.reasons ?? {}) };
  if (input.verdict === "agree") {
    for (const r of rows) {
      if (explicit.has(r.bundle_index)) continue;
      const pick = await (ctx.pick ?? checkIdentityPick)(supabase, r.contribution_type, obj(r.payload), r.task_id);
      if (pick.required) {
        autoExcepted.push(r.bundle_index);
        reasons[String(r.bundle_index)] = "系統自動例外：這一條需要逐條指認人物，整包票無法代為指認";
      }
    }
  }
  const except = [...new Set([...explicit, ...autoExcepted])].sort((a, b) => a - b);

  const { data: res, error } = await supabase.rpc("bundle_vote_fanout", {
    p_carrier: carrier.id, p_bundle: carrier.bundle_id, p_agent: input.agent_name, p_actor: actor.actor_id, p_ip: ipHash,
    p_verdict: verdict, p_except: except, p_reasons: reasons, p_note: recordNote,
    p_evidence: input.evidence_url ?? null, p_tool: input.agent_tool ?? null, p_via: via,
  });
  if (error) throw new Error(`bundle_vote_fanout: ${error.message}`);
  const out = obj(res);
  if (out.error === "already_voted") {
    return bad(409, "already_voted", "這一包你（同一個代號／帳號）已經投過了；這次送的票沒有計入。請直接領下一筆。");
  }
  if (out.error === "except_need_agree") return bad(400, "bundle_except_need_agree", "except 只能搭配 agree");
  if (out.error) return bad(400, "bundle_mismatch", `這一包無法投票（${String(out.error)}）`);

  // 載體那一條照舊即時落庫；其餘條目由 apply-verified 掃地機接手（不在單一請求內對整包逐條落庫）
  const { data: after } = await supabase.from("contributions").select("status, score").eq("id", carrier.id).maybeSingle();
  const autoApply = shouldAutoApply(after?.status) ? await autoApplyContribution(supabase, carrier.id, ctx.applyFn) : { triggered: false };
  const status = autoApply.triggered && autoApply.status ? autoApply.status : (after?.status ?? "pending");
  const note = (input.note ?? "").trim();

  return {
    status: 201,
    body: {
      success: true,
      bundle_id: carrier.bundle_id,
      contribution_id: carrier.id,
      verdict,
      ...(blind ? { downgraded_from: "disagree", downgrade_reason: "備註是「無法開啟／確認不了」：那是 unsure，不是反對。整包反對要寫出哪裡與公報矛盾或附反證網址；已改記 unsure（不對每一條各記反對）" } : {}),
      voted: out.voted ?? 0,
      skipped: out.skipped ?? 0,
      released: out.released ?? 0,
      new_carrier: out.new_carrier ?? null,
      ...(autoExcepted.length > 0 ? { auto_excepted: autoExcepted, auto_excepted_note: "這幾條需要逐條指認人物，整包票沒有替你投；它們已釋放成各自的驗證票。" } : {}),
      status,
      ...(autoApply.triggered ? { auto_apply: { status: autoApply.status, message: autoApply.outcome?.message ?? autoApply.error } } : {}),
      note: `整包票已逐條記入 ${out.voted ?? 0} 條，每條各算一票，分數與目標照舊；其餘條目達標後由系統自動上線。`,
      ...(mentionsPage(note) ? {} : { notice: "備註沒有提到頁碼：整包票請寫出你核對的公報頁碼，之後才分得出這張票是查過還是沒查過。" }),
    },
  };
}

/**
 * 驗證額度（每時段）對包票「一包算一次」：contribution_votes 的計數把 via='bundle' 的票（一包 N 條）扣掉，改加「這個時段扇出了幾包」。
 * 一次扇出在同一個交易、created_at 相同，所以以 created_at 去重當包數（最多讀 1000 列，遠大於任何額度）。
 * 只在 used 已經到上限、本來要回 429 時才呼叫（平常路徑不多一次查詢）。回調整後的已用數。
 */
export async function adjustedVerifyUsed(
  supabase: SupabaseLike,
  quota: { column: string; value: string },
  windowStartIso: string,
  used: number,
): Promise<number> {
  const { count: bundleVotes, error: cErr } = await supabase.from("contribution_votes").select("id", { count: "exact", head: true })
    .eq(quota.column, quota.value).eq("via", "bundle").gte("created_at", windowStartIso);
  if (cErr) throw new Error(`bundle quota count: ${cErr.message}`);
  if (!bundleVotes) return used;
  const { data, error } = await supabase.from("contribution_votes").select("created_at")
    .eq(quota.column, quota.value).eq("via", "bundle").gte("created_at", windowStartIso).limit(1000);
  if (error) throw new Error(`bundle quota rows: ${error.message}`);
  const bundles = new Set(((data ?? []) as Array<{ created_at: string }>).map((r) => new Date(r.created_at).getTime())).size;
  return used - bundleVotes + bundles;
}
