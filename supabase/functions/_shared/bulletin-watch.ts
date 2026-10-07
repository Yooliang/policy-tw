/**
 * 公報上網日自動偵測（2026-10-08，migration 20261008113000_bulletin_watch.sql、Edge Function bulletin-watch）。
 *
 * 中選會公報站 https://eebulletin.cec.gov.tw/?dir=<民國年> 的行為（2026-10-08 實測，fixtures/bulletin-*.html 是當天抓的原頁）：
 *   那一年的資料夾還不存在 → 整站首頁，<title> 是「首頁 - 中央選舉委員會選舉及公民投票公報」（?dir=115、?dir=999 都是）；
 *   存在 → <title> 是「111 - 中央選舉委員會選舉及公民投票公報」（資料夾名稱 - 站名）。
 * 這裡全是純函式與一個接依賴的流程（fetch、RPC 由呼叫端傳進來），不連網、不連資料庫，測試用假依賴跑完整條。
 *
 * 判斷分三態，不是兩態：站改版、網路回了錯誤頁、title 變了格式都會落在 unknown——
 * 不能當成「資料夾還沒出現」靜靜吞掉（那樣偵測壞了也沒人知道），也不能當成「出現了」記下一個假的上網日。
 */

/** 公報站首頁與資料夾頁共用的站名尾巴 */
export const BULLETIN_SITE_NAME = "中央選舉委員會選舉及公民投票公報";
/** 偵測的網址只認這個站（立委公報在 bulletin.cec.gov.tw，路徑式資料夾，標題行為沒量過，不在這支的範圍） */
export const BULLETIN_WATCH_HOST = "eebulletin.cec.gov.tw";

export type BulletinFolderState = "present" | "absent" | "unknown";

/** <title> 的文字（第一個 title 標籤，去頭尾空白與 BOM、換行壓成空格、解開常見的實體）；沒有就是 null */
export function bulletinTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = m[1]
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[﻿\s]+/g, " ")
    .trim();
  return t === "" ? null : t;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 這一頁是不是「dir 這個資料夾」：
 *   title＝「<dir> - 站名」→ present；title＝「首頁 - 站名」→ absent（資料夾不存在，站回首頁）；其餘一律 unknown。
 * dir 是民國年三碼（'115'）；不是三位數字的直接 unknown（不拿怪值去拼比對）。
 */
export function classifyBulletinPage(html: string, dir: string): BulletinFolderState {
  if (!/^\d{3}$/.test(dir)) return "unknown";
  const title = bulletinTitle(html);
  if (title === null) return "unknown";
  if (new RegExp(`^${escapeRe(dir)}\\s*-\\s*${escapeRe(BULLETIN_SITE_NAME)}$`).test(title)) return "present";
  if (new RegExp(`^首頁\\s*-\\s*${escapeRe(BULLETIN_SITE_NAME)}$`).test(title)) return "absent";
  return "unknown";
}

/**
 * 要抓哪個網址：elections.bulletin_hint 的第一段（「網址 ← 說明」的網址）必須是 eebulletin.cec.gov.tw，
 * 而且 bulletin_dir 是三位數字，才組出 https://eebulletin.cec.gov.tw/?dir=<dir>；其他站（例如 2024 立委的 bulletin.cec.gov.tw）回 null，
 * 由呼叫端記成「不支援」，不去亂抓、也不拿別站的標題規則硬套。
 */
export function bulletinWatchUrl(hint: string | null | undefined, dir: string | null | undefined): string | null {
  if (!dir || !/^\d{3}$/.test(dir) || !hint) return null;
  const first = hint.split("←")[0].trim();
  let u: URL;
  try {
    u = new URL(first);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== BULLETIN_WATCH_HOST) return null;
  return `https://${BULLETIN_WATCH_HOST}/?dir=${dir}`;
}

export interface WatchTarget {
  election_id: number;
  bulletin_dir: string | null;
  bulletin_hint: string | null;
}

export interface FetchedPage {
  status: number;
  text: string;
}

export interface WatchDeps {
  /** 抓頁面；網路錯誤就丟 */
  fetchPage: (url: string) => Promise<FetchedPage>;
  /** 記下實際上網日（呼叫資料庫 RPC bulletin_watch_mark_published），回傳記下的日期（YYYY-MM-DD） */
  markPublished: (t: { election_id: number; url: string; title: string }) => Promise<string | null>;
}

export type WatchOutcome =
  | { election_id: number; dir: string | null; state: "absent" }
  | { election_id: number; dir: string | null; state: "present"; marked_on: string | null }
  | { election_id: number; dir: string | null; state: "skipped"; reason: string }
  | { election_id: number; dir: string | null; state: "unknown"; reason: string };

/**
 * 逐一檢查：absent 什麼都不做；present 才呼叫 markPublished；unknown（錯誤頁、抓不到、title 格式不認得、記錄失敗）原樣回報。
 * 一個選舉失敗不影響其他選舉。
 */
export async function runBulletinWatch(targets: readonly WatchTarget[], deps: WatchDeps): Promise<WatchOutcome[]> {
  const out: WatchOutcome[] = [];
  for (const t of targets) {
    const dir = t.bulletin_dir;
    const url = bulletinWatchUrl(t.bulletin_hint, dir);
    if (!url) {
      out.push({ election_id: t.election_id, dir, state: "skipped", reason: `公報入口不是 ${BULLETIN_WATCH_HOST}，這支不偵測` });
      continue;
    }
    let page: FetchedPage;
    try {
      page = await deps.fetchPage(url);
    } catch (e) {
      out.push({ election_id: t.election_id, dir, state: "unknown", reason: `抓取失敗：${(e as Error).message}` });
      continue;
    }
    if (page.status !== 200) {
      out.push({ election_id: t.election_id, dir, state: "unknown", reason: `HTTP ${page.status}` });
      continue;
    }
    const state = classifyBulletinPage(page.text, dir ?? "");
    if (state === "absent") {
      out.push({ election_id: t.election_id, dir, state: "absent" });
    } else if (state === "present") {
      try {
        const marked = await deps.markPublished({ election_id: t.election_id, url, title: bulletinTitle(page.text) ?? "" });
        out.push({ election_id: t.election_id, dir, state: "present", marked_on: marked });
      } catch (e) {
        out.push({ election_id: t.election_id, dir, state: "unknown", reason: `資料夾已出現但記錄失敗：${(e as Error).message}` });
      }
    } else {
      out.push({ election_id: t.election_id, dir, state: "unknown", reason: `頁面標題認不得（${bulletinTitle(page.text) ?? "沒有 title"}）：站改版了？` });
    }
  }
  return out;
}

/** 有任何一個選舉的狀態是 unknown 就不算成功（呼叫端回 502，讓排程紀錄看得到，不是靜靜回 200） */
export function watchSucceeded(outcomes: readonly WatchOutcome[]): boolean {
  return outcomes.every((o) => o.state !== "unknown");
}

/** body 的 mode：'hot'（日期接近預估上架日的，每小時那條排程用）或 'all'（預設，每天一次那條）；其他值丟錯 */
export function parseWatchMode(v: unknown): "all" | "hot" {
  if (v === undefined || v === null || v === "") return "all";
  if (v === "all" || v === "hot") return v;
  throw new Error(`mode 只能是 all 或 hot（收到 ${String(v).slice(0, 20)}）`);
}

/**
 * 請求 body 的解析：空字串＝{}；必須是 JSON 物件（null、陣列、字串、數字都回錯）；不是合法 JSON 也回錯。
 * 兩種錯誤訊息不同，呼叫端一律回 400。
 */
export function parseWatchBody(text: string): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return { ok: false, error: "body 不是合法的 JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "body 必須是 JSON 物件" };
  return { ok: true, body: parsed as Record<string, unknown> };
}