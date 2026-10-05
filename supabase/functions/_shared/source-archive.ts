/**
 * 出處存檔（issue #347 第一階段）：選舉公報、選委會公告類的出處送 Wayback Machine 存檔，記下 archive_url。
 *
 * 為什麼要存：中選會的公報站只掛最近一屆，投票後就換下來（日本站同一條規則：選挙公報・選管公告的
 * archive_url 必填）。正見 1,212 條有出處的政見裡 67 條引用公報，2026 公報 11 月上線後 2022 那批就會下架。
 *
 * 為什麼是伺服器排程、不是交件當下同步存、也不是派任務給代理（2026-10-05，理由詳見 docs/DECISIONS.md）：
 *   - 交件當下同步存：Wayback 存一頁要 10～60 秒、常回 429，會拖慢甚至卡住交件；而且要改協議端點。
 *   - 派「補存檔」任務：存檔是機械動作，派給代理要佔佇列、還要別人投票確認一個網址；代理回報的
 *     存檔網址也得再核一次（子代理編造驗證輸出的事前例在）。
 *   - 排程：交件當下觸發器就把這類網址登記進 sources（不必等投票），10 分鐘內存檔；失敗依次數退避、
 *     永不放棄（最長每天試一次）；不動協議、不動交件路徑、代理完全感覺不到。
 *
 * 文件類別的網域清單跟 SQL source_doc_kind()（migration 20261005000347）一致，source-archive.test.ts 盯。
 */

export type DocKind = "election_bulletin" | "election_notice";

/** 選舉公報：中選會公報站與電子公報站 */
export const BULLETIN_HOSTS = ["bulletin.cec.gov.tw", "eebulletin.cec.gov.tw"] as const;
/** 選委會公告與名冊：中選會官網（公告、登記彙總表 PDF 在 web.cec.gov.tw/api/file/） */
export const NOTICE_HOSTS = ["web.cec.gov.tw", "cec.gov.tw"] as const;

function hostOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** 這個網址是不是要存檔的文件類別；跟 SQL source_doc_kind() 同一份規則 */
export function docKindOf(url: string): DocKind | null {
  const host = hostOf(url);
  if (!host) return null;
  if ((BULLETIN_HOSTS as readonly string[]).includes(host)) return "election_bulletin";
  if ((NOTICE_HOSTS as readonly string[]).includes(host)) return "election_notice";
  return null;
}

const SNAPSHOT_RE = /^https?:\/\/web\.archive\.org\/web\/(\d{14})(?:[a-z_]{0,4})?\/(.+)$/i;

/** 是不是一個指向特定時間點的 Wayback 存檔網址；是就回傳 https 版本，否則 null */
export function normalizeSnapshotUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s.startsWith("/web/")) s = `https://web.archive.org${s}`;
  const m = SNAPSHOT_RE.exec(s);
  if (!m) return null;
  return `https://web.archive.org/web/${m[1]}/${m[2]}`;
}

/** 存檔網址裡的時間戳（YYYYMMDDhhmmss，UTC）→ Date */
export function snapshotTime(snapshotUrl: string): Date | null {
  const m = SNAPSHOT_RE.exec(snapshotUrl);
  if (!m) return null;
  const t = m[1];
  const d = new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 已經有的存檔能不能直接用（省一次「現在存」）：
 *   - 檔案（PDF、/api/file/）內容不會變，任何時間的存檔都算。
 *   - 網頁（公告列表、公報目錄）會改，只收「擷取時間前後 30 天內」的存檔；不知道擷取時間就只收 30 天內的。
 */
export const EXISTING_SNAPSHOT_WINDOW_DAYS = 30;
export function isFileLike(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return /\.(pdf|xlsx?|docx?|odt|ods|zip|jpe?g|png)$/i.test(decodeURIComponent(u.pathname)) || /\/api\/file\//i.test(u.pathname);
  } catch {
    return false;
  }
}
export function acceptExistingSnapshot(url: string, snapshotUrl: string, fetchedAt: Date | null, now: Date): boolean {
  if (!normalizeSnapshotUrl(snapshotUrl)) return false;
  if (isFileLike(url)) return true;
  const ts = snapshotTime(snapshotUrl);
  if (!ts) return false;
  const anchor = fetchedAt ?? now;
  return Math.abs(ts.getTime() - anchor.getTime()) <= EXISTING_SNAPSHOT_WINDOW_DAYS * 86_400_000;
}

/**
 * 失敗退避：第 n 次失敗後隔多久再試。30 分、1、2、4、8 小時，之後每天一次，**永不放棄**——
 * 公報下架前任何一次成功都有價值；不可逆的「放棄」會讓漏存的永遠沒人發現（2026-09-21 裁決：
 * 不可逆的排除條件一律要有時間窗）。
 */
export function retryDelayMinutes(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(30 * 2 ** (n - 1), 24 * 60);
}

/** Wayback 可用性 API 的回應 → 最近一份 200 的存檔網址 */
export function parseAvailability(json: unknown): string | null {
  const closest = (json as { archived_snapshots?: { closest?: { available?: boolean; url?: string; status?: string } } })
    ?.archived_snapshots?.closest;
  if (!closest || closest.available !== true || String(closest.status ?? "") !== "200") return null;
  return normalizeSnapshotUrl(closest.url ?? null);
}

/** 「現在存」（/save/）的回應 → 存檔網址。Wayback 有時 302 到存檔、有時 200 帶 Content-Location，或在跟隨轉址後的網址裡。 */
export function parseSaveResponse(res: { status: number; location?: string | null; contentLocation?: string | null; finalUrl?: string | null }): string | null {
  return normalizeSnapshotUrl(res.location ?? null) ??
    normalizeSnapshotUrl(res.contentLocation ?? null) ??
    normalizeSnapshotUrl(res.finalUrl ?? null);
}

export type ArchiveOutcome =
  | { ok: true; archiveUrl: string; method: "existing" | "saved" }
  | { ok: false; error: string; rateLimited: boolean };

const UA = "policy-tw-source-archive/1.0 (+https://policy-tw.web.app/sources)";

/**
 * 存一個網址：先查有沒有可用的既有存檔，沒有才請 Wayback 現在存。
 * 不丟錯：任何失敗都回 { ok:false }，由呼叫端寫進 archive_error 並排下次。
 */
export async function archiveOne(
  url: string,
  fetchedAt: Date | null,
  opts: { fetchImpl?: typeof fetch; now?: Date; saveTimeoutMs?: number } = {},
): Promise<ArchiveOutcome> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const target = url.trim();

  try {
    const res = await f(`https://archive.org/wayback/available?url=${encodeURIComponent(target)}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const snap = parseAvailability(await res.json());
      if (snap && acceptExistingSnapshot(target, snap, fetchedAt, now)) return { ok: true, archiveUrl: snap, method: "existing" };
    } else {
      await res.body?.cancel();
    }
  } catch {
    // 查不到既有存檔不算失敗，直接去存
  }

  try {
    const res = await f(`https://web.archive.org/save/${target}`, {
      headers: { "User-Agent": UA },
      redirect: "manual",
      signal: AbortSignal.timeout(opts.saveTimeoutMs ?? 90_000),
    });
    const snap = parseSaveResponse({
      status: res.status,
      location: res.headers.get("location"),
      contentLocation: res.headers.get("content-location"),
      finalUrl: res.url,
    });
    await res.body?.cancel();
    if (snap) return { ok: true, archiveUrl: snap, method: "saved" };
    if (res.status === 429) return { ok: false, error: "Wayback 429（存檔請求太頻繁）", rateLimited: true };
    return { ok: false, error: `Wayback 存檔沒有回傳存檔網址（HTTP ${res.status}）`, rateLimited: false };
  } catch (e) {
    return { ok: false, error: `Wayback 存檔失敗：${e instanceof Error ? e.message : String(e)}`.slice(0, 300), rateLimited: false };
  }
}

/** source_archive_claim() 回傳的一列 */
export interface ClaimedSource {
  id: number;
  url: string;
  doc_kind: string | null;
  fetched_at: string | null;
  archive_attempts: number;
}

/** 寫回 sources 的欄位 */
export type ArchivePatch =
  | { archive_url: string; archived_at: string; archive_error: null; archive_next_at: null }
  | { archive_error: string; archive_next_at: string };

export interface RoundReport {
  id: number;
  url: string;
  ok: boolean;
  archive_url?: string;
  method?: "existing" | "saved";
  error?: string;
}

/**
 * 一輪存檔：一次領一筆、存完寫回、再領下一筆，直到件數或時間用完。
 *   - 一次只領一筆：領了沒做完的會被 30 分鐘租約卡住，所以不預先多領。
 *   - 遇到 429 就整輪停下：Wayback 在叫我們慢一點，繼續送只會讓限流更久。
 *   - 領到的網址若已不屬於要存檔的類別（SQL 與 TS 規則分歧的保險），不送 Wayback、記錯誤。
 */
export async function runArchiveRound(deps: {
  claim: () => Promise<ClaimedSource | null>;
  update: (id: number, patch: ArchivePatch) => Promise<void>;
  archive: (url: string, fetchedAt: Date | null) => Promise<ArchiveOutcome>;
  now: () => Date;
  maxItems: number;
  timeBudgetMs: number;
}): Promise<{ reports: RoundReport[]; stoppedBy: "done" | "max_items" | "time" | "rate_limited" }> {
  const started = deps.now().getTime();
  const reports: RoundReport[] = [];
  while (true) {
    if (reports.length >= deps.maxItems) return { reports, stoppedBy: "max_items" };
    if (deps.now().getTime() - started >= deps.timeBudgetMs) return { reports, stoppedBy: "time" };
    const row = await deps.claim();
    if (!row) return { reports, stoppedBy: "done" };

    const retryAt = (attempts: number) => new Date(deps.now().getTime() + retryDelayMinutes(attempts) * 60_000).toISOString();
    if (!docKindOf(row.url)) {
      const error = "網址不屬於選舉公報／選委會公告（SQL 與程式的判斷不一致），未送存檔";
      await deps.update(row.id, { archive_error: error, archive_next_at: retryAt(row.archive_attempts) });
      reports.push({ id: row.id, url: row.url, ok: false, error });
      continue;
    }
    const fetchedAt = row.fetched_at ? new Date(row.fetched_at) : null;
    const out = await deps.archive(row.url, fetchedAt && !Number.isNaN(fetchedAt.getTime()) ? fetchedAt : null);
    if (out.ok) {
      await deps.update(row.id, { archive_url: out.archiveUrl, archived_at: deps.now().toISOString(), archive_error: null, archive_next_at: null });
      reports.push({ id: row.id, url: row.url, ok: true, archive_url: out.archiveUrl, method: out.method });
      continue;
    }
    await deps.update(row.id, { archive_error: out.error, archive_next_at: retryAt(row.archive_attempts) });
    reports.push({ id: row.id, url: row.url, ok: false, error: out.error });
    if (out.rateLimited) return { reports, stoppedBy: "rate_limited" };
  }
}
