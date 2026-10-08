/**
 * 派工憑證（#484，協議 1.81.0）。
 *
 * 問題：雲端代理領任務（GET /next）與交件（POST /report）的對外 IP 不同網段，
 * 派工綁定（verify_dispatches 的 (貢獻, 來源網段)）對不上，回 409 not_dispatched。
 * #482 的 /24 只解同網段；跨網段要有一個「這一筆確實是伺服器派給你的」的證明，不靠 IP。
 *
 * 做法：HMAC 簽章的無狀態憑證（不新增資料表或欄位，不在 /next 另外現算清單，只在派出的那一筆簽一個）。
 *   - 不選「隨機 token＋雜湊存庫」：存庫要新欄位或新表，而且 verify_dispatches 的主鍵是 (貢獻, 網段)，
 *     同一網段的兩個代理領到同一筆會互相覆蓋對方的雜湊；簽章沒有這個問題，也不用多一次寫入。
 *   - 鑰匙：DISPATCH_TOKEN_SECRET（有設就用）；沒設就用 SUPABASE_SERVICE_ROLE_KEY（Edge Function 一定有，
 *     從不印出）。換鑰匙只會讓手上還沒交的憑證失效（30 分鐘壽命），代理重領即可。
 *
 * 憑證內容：綁 task_id（驗證任務是 verify:<貢獻 id>）、派出時間、到期時間、自報代號（僅供記錄，不作授權）、
 * 以及「派出當下的來源網段雜湊」。最後一項是這份設計的關鍵：
 *   憑證通過時，投票／交件的「來源」就是領任務的那個網段（見 verify-handler）。
 *   所以一張憑證只能換一張票——第二次拿同一張憑證來，來源網段一樣，被既有的「每個來源網段一票」擋下；
 *   換一個網段來交也沒用，因為來源不看交件當下的網段。憑證只解決「派工綁定」，沒有多開任何一個來源。
 *
 * 追查：不寫資料庫（維護者 10-08）。派出與使用各在 Edge Function log 記一行結構化紀錄（logDispatchBinding），
 * 只有雜湊前 8 碼，沒有原始 IP、沒有憑證原文。
 */

import { sha256Hex } from "./contribution-schema.ts";

/** 與現行租約一致（dispatch.ts 的 LEASE_MINUTES = 30）；寫成常數是為了讓憑證模組不必 import 整個派工檔，測試盯著兩者相等 */
export const DISPATCH_TOKEN_MINUTES = 30;
const PREFIX = "dpt1";

export interface DispatchTokenPayload {
  /** 派的是哪一個任務：自動缺口 auto:…、手動任務 uuid、驗證 verify:<貢獻 id> */
  t: string;
  /** 自報代號（僅供記錄） */
  a: string;
  /** 派出時間（毫秒） */
  i: number;
  /** 到期時間（毫秒） */
  e: number;
  /** 派出當下的來源網段雜湊（ipHashOf） */
  h: string;
}

export type TokenFailure = "malformed" | "bad_signature" | "expired" | "task_mismatch" | "no_secret";
export type TokenCheck = { ok: true; payload: DispatchTokenPayload; tokenId: string } | { ok: false; reason: TokenFailure };

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const s = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
    const raw = atob(s);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    // atob 不拒絕尾端的非零位元（同一串位元組有多種寫法）：重新編碼要回到原字串，才是正規形式，
    // 否則同一張憑證能有好幾個寫法，憑證識別碼（log 用）也會對不上
    if (b64urlEncode(bytes) !== text) return null;
    return bytes;
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export const DISPATCH_SECRET_MIN_LENGTH = 16;
const usable = (v: string | undefined): v is string => typeof v === "string" && v.length >= DISPATCH_SECRET_MIN_LENGTH;

/**
 * 取鑰匙：DISPATCH_TOKEN_SECRET 優先，其次 SUPABASE_SERVICE_ROLE_KEY。呼叫端傳讀環境變數的函式（測試不需要 --allow-env）。
 * 專用鑰匙設了但太短（< 16 字）＝當沒設，退回 service role key；兩個都不能用才回 undefined。
 */
export function dispatchTokenSecretFrom(get: (name: string) => string | undefined): string | undefined {
  const dedicated = get("DISPATCH_TOKEN_SECRET");
  if (usable(dedicated)) return dedicated;
  const fallback = get("SUPABASE_SERVICE_ROLE_KEY");
  return usable(fallback) ? fallback : undefined;
}

/**
 * 鑰匙不能用時要有訊號（不然 /next 靜靜地不發憑證，代理只會一直吃跨網段的 409，沒人知道為什麼）。
 * 每個實例（＝每次冷啟動）只警告一次；訊息不含鑰匙內容。
 */
export function createSecretWarner(warn: (msg: string) => void = (m) => console.warn(m)): (get: (name: string) => string | undefined) => void {
  let warned = false;
  return (get) => {
    if (warned || dispatchTokenSecretFrom(get)) return;
    warned = true;
    const dedicated = get("DISPATCH_TOKEN_SECRET");
    warn(
      "[dispatch-token] 沒有可用的憑證鑰匙：/next 不會發 dispatch_token，跨網段的回報會繼續吃 409 not_dispatched。" +
        (dedicated ? ` DISPATCH_TOKEN_SECRET 有設但短於 ${DISPATCH_SECRET_MIN_LENGTH} 字，已忽略；` : " DISPATCH_TOKEN_SECRET 沒設；") +
        ` SUPABASE_SERVICE_ROLE_KEY 也不能用（沒設或短於 ${DISPATCH_SECRET_MIN_LENGTH} 字）。`,
    );
  };
}

/** 憑證的識別碼：憑證原文的 SHA-256 前 8 碼，只用在 log，反查「這張憑證何時派出、何時用掉」 */
export async function dispatchTokenId(token: string): Promise<string> {
  return (await sha256Hex(token)).slice(0, 8);
}

export async function signDispatchToken(secret: string, p: DispatchTokenPayload): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(p)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${PREFIX}.${body}`)));
  return `${PREFIX}.${body}.${b64urlEncode(sig)}`;
}

/** 派出一張憑證；沒有鑰匙就回 null（派工照常，只是沒有憑證，代理走網段比對） */
export async function issueDispatchToken(
  secret: string | undefined,
  o: { taskId: string; agentName: string; ipHash: string; now?: number },
): Promise<{ token: string; expiresAt: string; tokenId: string } | null> {
  if (!secret) return null;
  const now = o.now ?? Date.now();
  const e = now + DISPATCH_TOKEN_MINUTES * 60_000;
  const token = await signDispatchToken(secret, { t: o.taskId, a: o.agentName, i: now, e, h: o.ipHash });
  return { token, expiresAt: new Date(e).toISOString(), tokenId: await dispatchTokenId(token) };
}

/**
 * 驗憑證：簽章、期限、task_id。
 * `expectedTaskId` 給了就必須相符（投票：verify:<貢獻 id>）；沒給（交件，一批可含多個 task）就只驗簽章與期限，task 比對由呼叫端做。
 */
export async function checkDispatchToken(
  secret: string | undefined,
  token: unknown,
  expectedTaskId: string | null,
  now = Date.now(),
  // 改票專用：簽章與 task 照驗，只放過「已過期」（見 verify-handler 的改票說明）
  opts: { ignoreExpiry?: boolean } = {},
): Promise<TokenCheck> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2000) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  if (!secret) return { ok: false, reason: "no_secret" };
  const body = b64urlDecode(parts[1]);
  const sig = b64urlDecode(parts[2]);
  if (!body || !sig) return { ok: false, reason: "malformed" };
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(`${PREFIX}.${parts[1]}`));
  if (!valid) return { ok: false, reason: "bad_signature" };
  let p: DispatchTokenPayload;
  try {
    p = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!p || typeof p.t !== "string" || typeof p.h !== "string" || typeof p.e !== "number" || typeof p.i !== "number" || typeof p.a !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (now >= p.e && !opts.ignoreExpiry) return { ok: false, reason: "expired" };
  if (expectedTaskId !== null && p.t !== expectedTaskId) return { ok: false, reason: "task_mismatch" };
  return { ok: true, payload: p, tokenId: await dispatchTokenId(token) };
}

/** body 有沒有帶憑證：沒這個欄位（或 null）＝沒帶；帶了但不是字串、是空字串＝帶了無效的 */
export function dispatchTokenOf(body: unknown): { present: false } | { present: true; value: unknown } {
  if (!body || typeof body !== "object") return { present: false };
  const v = (body as Record<string, unknown>).dispatch_token;
  if (v === undefined || v === null) return { present: false };
  return { present: true, value: v };
}

const REASON_MESSAGE: Record<TokenFailure, string> = {
  malformed: "dispatch_token 格式不對。請原樣帶 GET /next 回應裡的 dispatch_token（一整串，不要截斷）。",
  bad_signature: "dispatch_token 驗不過（被改過，或不是這個伺服器發的）。請原樣帶 GET /next 給的那一張。",
  expired: `dispatch_token 已過期（有效 ${DISPATCH_TOKEN_MINUTES} 分鐘，與認領期同長）。重新 GET /next 領一筆；或不帶憑證，改用原本的來源網段比對。`,
  task_mismatch: "dispatch_token 是派給別的任務的，不能拿來交這一筆。每筆任務／驗證各有自己的憑證，請用 GET /next 派這一筆時給的那一張。",
  no_secret: "伺服器目前沒有可用的憑證鑰匙，無法驗憑證。請不帶 dispatch_token 重送（改用來源網段比對）。",
};

/** 帶了憑證但無效：回清楚的 4xx，不默默退回網段比對（退回去會讓代理以為憑證有效） */
export function invalidTokenResult(reason: TokenFailure): { status: number; body: Record<string, unknown> } {
  return { status: 403, body: { success: false, error: "invalid_dispatch_token", reason, message: REASON_MESSAGE[reason] } };
}

/** 結構化紀錄：只有雜湊前 8 碼與憑證識別碼，不記原始 IP、不記憑證原文 */
export function logDispatchBinding(rec: {
  event: "dispatch_token_issued" | "dispatch_binding";
  endpoint?: string;
  binding?: "token" | "token_expired_revise" | "ip" | "none";
  task_id: string;
  agent_name: string;
  token_id?: string | null;
  /** 領任務時的網段雜湊 */
  issued_net?: string | null;
  /** 交件／投票當下的網段雜湊 */
  report_net?: string | null;
}): void {
  const cut = (h: string | null | undefined) => (h ? h.slice(0, 8) : null);
  const line = {
    ...rec,
    token_id: rec.token_id ?? null,
    issued_net: cut(rec.issued_net),
    report_net: cut(rec.report_net),
    ...(rec.issued_net && rec.report_net ? { cross_network: rec.issued_net !== rec.report_net } : {}),
  };
  console.log(JSON.stringify(line));
}
