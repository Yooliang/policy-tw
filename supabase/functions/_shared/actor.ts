/**
 * 身份解析：把請求裡的 agent_name 與來源 IP 雜湊變成一個身份鍵 actor_id。
 * 設計見 docs/BLUEPRINT-agent-identity.md §3（一個欄位、兩種等級）。
 *
 * actor_id 的格式是 <等級>:<鍵>：
 *   ip:<雜湊>          匿名代理。代號只給人看，身份是來源 IP（2026-09-19 裁決）。
 *   ditrust:<agent_id> DiTrust 帳號。代理填 agent_name=ditrust:<序號>，伺服器向 DiTrust 換 agent_id。
 *
 * ditrust:<序號> 由 resolveActorFromRequest 向同專案的 agents-verify 換身份（第 3 步，2026-09-19）。
 * 序號永遠不能當成一般代號收進去——收了就等於把序號存進 agent_name、印在貢獻榜上。
 */

import { isValidAgentName } from "./consensus.ts";

/** 協議字串（IDN-R11：全案統一 ditrust）。舊拼法 diturst: 也擋，免得打錯的序號被當一般代號收進去 */
export const DITRUST_PREFIX = "ditrust:";
const LEGACY_TYPO_PREFIX = "diturst:";

export type ActorLevel = "ip" | "ditrust";

export interface Actor {
  level: ActorLevel;
  /** <等級>:<鍵>，寫進 contributions.actor_id／contribution_votes.actor_id */
  actor_id: string;
  /** 給人看的代號，寫進 agent_name */
  handle: string;
}

export function actorIdForIp(ipHash: string): string {
  return `ip:${ipHash}`;
}

/** 這個 agent_name 是不是在用 DiTurst 序號登入 */
export function isDitrustLogin(agentName: string): boolean {
  const n = agentName.toLowerCase();
  return n.startsWith(DITRUST_PREFIX) || n.startsWith(LEGACY_TYPO_PREFIX);
}

/**
 * 回傳不能用這個 agent_name 的原因；null 表示可以。
 * 放在 isValidAgentName 前面呼叫：isValidAgentName 會擋冒號，但那句錯誤訊息不會告訴代理
 * 「你填的是序號、只是還沒開放」，它會以為格式錯而把序號拆開重填——更糟。
 */
export function agentNameProblem(agentName: string): string | null {
  if (isDitrustLogin(agentName)) {
    // 序號登入由 resolveActorFromRequest 處理；到這裡表示呼叫端沒先解析（或解析失敗後又拿原字串來驗）
    return "ditrust:<序號> 要先經過身份解析；序號不要填進其他欄位。";
  }
  if (!isValidAgentName(agentName)) {
    return "agent_name 必填：使用者代號，2～64 字，字母數字與 ._-（模型名放 agent_tool）";
  }
  return null;
}

/** 匿名身份（同步）。寫入端用這個：agent_name 進到這裡時已經是解析過的代號，不會是序號 */
export function resolveActor(agentName: string, ipHash: string): Actor {
  return { level: "ip", actor_id: actorIdForIp(ipHash), handle: agentName };
}

/** DiTrust 驗證結果的快取：撤銷最多延遲這麼久，別設太長（藍圖 §9） */
const DITRUST_CACHE_TTL_MS = 5 * 60 * 1000;
const ditrustCache = new Map<string, { actor: Actor; expires: number }>();

export type ResolveOutcome = { ok: true; actor: Actor } | { ok: false; status: number; error: string };

/**
 * 入口用：把請求裡的 agent_name（可能是 ditrust:<序號>）換成身份。
 *   一般代號 → 匿名身份
 *   ditrust:<序號> → 打同專案的 agents-verify（service role bearer）換 agent_id 與顯示名；
 *                    序號無效／撤銷 → 401 講清楚；DiTrust 掛了且沒快取 → 503，不要降成匿名（那會把序號存進 agent_name）
 * 快取用序號的 sha256 當 key，記憶體裡不留序號明文。
 */
export async function resolveActorFromRequest(agentName: string, ipHash: string, fetchImpl: typeof fetch = fetch): Promise<ResolveOutcome> {
  if (!isDitrustLogin(agentName)) return { ok: true, actor: resolveActor(agentName, ipHash) };
  const secret = agentName.slice(agentName.indexOf(":") + 1).trim();
  if (!/^[0-9a-f]{64}$/i.test(secret)) return { ok: false, status: 400, error: "ditrust:<序號> 格式不對：序號是 64 位十六進位" };
  const key = await sha256Hex(secret);
  const hit = ditrustCache.get(key);
  if (hit && hit.expires > Date.now()) return { ok: true, actor: hit.actor };
  let url: string | undefined, serviceKey: string | undefined;
  try { url = Deno.env.get("SUPABASE_URL"); serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); } catch { /* 測試沒開 --allow-env */ }
  if (!url || !serviceKey) return { ok: false, status: 503, error: "身份服務未設定" };
  try {
    const res = await fetchImpl(`${url}/functions/v1/agents-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ secret }),
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401) return { ok: false, status: 401, error: "ditrust 序號無效或已撤銷，請到正見個人頁重新產生" };
    if (!res.ok) return { ok: false, status: 503, error: `身份服務回應 ${res.status}，請稍後再試` };
    const out = await res.json() as { agent_id?: string; display_name?: string | null };
    if (!out?.agent_id) return { ok: false, status: 503, error: "身份服務回應缺 agent_id" };
    const handle = (typeof out.display_name === "string" && out.display_name.trim()) ? out.display_name.trim() : `ditrust-${out.agent_id.slice(0, 8)}`;
    const actor: Actor = { level: "ditrust", actor_id: `ditrust:${out.agent_id}`, handle };
    ditrustCache.set(key, { actor, expires: Date.now() + DITRUST_CACHE_TTL_MS });
    return { ok: true, actor };
  } catch (e) {
    return { ok: false, status: 503, error: `身份服務連不上：${e instanceof Error ? e.name : String(e)}` };
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── 匿名冒用 DiTrust 顯示名（2026-10-29）──────────────────────────────────────────
// 起因：代理把 /next 回應裡的顯示名（涼糕）當成 agent_name 送回來 → 被當匿名（ip: 身分），
// 票算進網段匿名額度而不是 DiTrust 帳號額度。DiTrust 登入一律送 ditrust:<序號> 原樣。

/** 一定保留的 DiTrust 顯示名（含歷史名）；表讀不到時只靠這份 */
export const RESERVED_HANDLES: readonly string[] = ["QiLiang", "啟良", "小雯", "涼糕"];
const RESERVED_TTL_MS = 60_000;
const RESERVED_FAIL_TTL_MS = 15_000;
let reservedCache: { names: Set<string>; expires: number } | null = null;

export function normalizeHandle(s: string): string {
  return s.trim().toLowerCase();
}

/** 測試用：清掉快取 */
export function resetReservedHandlesCache(): void {
  reservedCache = null;
}

// deno-lint-ignore no-explicit-any
type ReservedDb = { from: (table: string) => any };

/** 保留名單＝常數 ＋ vm_ditrust_groups.display_name；模組級快取 60 秒，讀失敗不擋（退回常數，15 秒後再試） */
export async function loadReservedHandles(db: ReservedDb | null | undefined, now: number = Date.now()): Promise<Set<string>> {
  if (reservedCache && reservedCache.expires > now) return reservedCache.names;
  const names = new Set(RESERVED_HANDLES.map(normalizeHandle));
  let ok = false;
  if (db) {
    try {
      // query-bounds: ok — vm_ditrust_groups 只有 3 列（group_no 限 1～3），limit(50) 只是保險
      const { data, error } = await db.from("vm_ditrust_groups").select("display_name").limit(50);
      if (!error && Array.isArray(data)) {
        ok = true;
        for (const r of data as Array<{ display_name?: string | null }>) {
          if (typeof r?.display_name === "string" && r.display_name.trim()) names.add(normalizeHandle(r.display_name));
        }
      }
    } catch { /* 讀不到就退回常數 */ }
  }
  reservedCache = { names, expires: now + (ok ? RESERVED_TTL_MS : RESERVED_FAIL_TTL_MS) };
  return names;
}

export const DITRUST_NAME_RESERVED_MESSAGE =
  "這個名字屬於 DiTrust 帳號，請用 ditrust:<你的序號> 登入（agent_name 一律照登入字串原樣送出，不要改成回應裡的名字）；匿名請換其他代號";

/**
 * 匿名（ip 等級）請求的 agent_name 若等於 DiTrust 顯示名 → 回 400 內容，否則 null。
 * DiTrust 登入的 actor.level 是 ditrust，不會被擋。
 * 命中時輸出一行 anon_uses_ditrust_handle（只記 route、agent_name、網段雜湊前 8 碼、時間；不含序號）。
 */
export async function anonReservedBlock(
  db: ReservedDb | null | undefined,
  actor: Actor,
  route: string,
  ipHash: string,
): Promise<{ status: 400; code: "ditrust_name_reserved"; message: string } | null> {
  if (actor.level !== "ip") return null;
  const reserved = await loadReservedHandles(db);
  if (!reserved.has(normalizeHandle(actor.handle))) return null;
  console.warn(JSON.stringify({ event: "anon_uses_ditrust_handle", route, agent_name: actor.handle, net: ipHash.slice(0, 8), at: new Date().toISOString() }));
  return { status: 400, code: "ditrust_name_reserved", message: DITRUST_NAME_RESERVED_MESSAGE };
}

/** /next 回應裡的身份欄位：DiTrust 登入不放頂層 agent_name（代理會照抄），顯示名只在 agent 物件裡 */
export function nextIdentityFields(actor: Actor, agentName: string): Record<string, unknown> {
  if (actor.level === "ip") return { agent_name: agentName, agent: { handle: actor.handle, level: actor.level } };
  return {
    agent: { handle: actor.handle, display_name: actor.handle, level: actor.level },
    agent_name_rule: "請求的 agent_name 一律照你登入時的 ditrust:… 原樣送，不要改成回應裡的名字（agent.display_name 只是顯示）",
  };
}
