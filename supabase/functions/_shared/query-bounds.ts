/**
 * 掃原始碼，把「可能被 PostgREST max-rows=1000 靜默截斷」的查詢找出來。
 *
 * 為什麼用掃原始碼這種笨方法：2026-09-17 貢獻榜的驗證票合計卡在 1000、9-18 在 /next 抓到四支、
 * 9-19 又抓到兩支漏網的（votedIds 連 limit 都沒寫，看起來像「全部」）。每次都是同一個坑，
 * 每次都靠人眼逐支翻。截斷不噴錯、不變慢，只讓數字悄悄變假——沒有守門它一定會再長回來。
 *
 * 判準：
 *   .range 翻頁            → 可以，但一定要有 .order（無序翻頁會重複／漏筆）
 *   .limit(n)，n <= 1000    → 可以（呼叫端自己聲明了最壞情況）
 *   .limit(n)，n > 1000     → 不行，伺服器只給 1000，寫大數字是騙自己
 *   count/head、寫入、單列   → 不用管
 *   .in("x", ids) 用變數    → 可以，列數由那批 id 決定
 *   .eq("xxx_id", v)       → 可以，綁在單一母體底下，扇出有天然上限
 *   其他                   → 不行，除非原始碼上方標了 query-bounds: ok — <理由>
 *
 * 豁免寫在被豁免的那一行上面，不另外開一份白名單：白名單跟程式碼是兩份真相，
 * 搬一次家就對不起來，而且理由留在原地才看得到。
 */

export type Chain = {
  file: string;
  line: number;
  text: string;
  /** 這條鏈被指派給哪個變數（`let query = supabase.from(...)` 的建構器寫法） */
  assignedTo: string | null;
  /** 上方的 `query-bounds: ok — 理由` 標記 */
  marker: string | null;
};

export type OkReason =
  | "paginated" | "bounded-limit" | "deferred-limit" | "count" | "write" | "single"
  | "bounded-by-ids" | "bounded-by-parent" | "marked";
export type Problem = "no-bound" | "limit-over-max-rows" | "unordered-pagination" | "marker-without-reason";
export type Verdict = { ok: true; reason: OkReason } | { ok: false; problem: Problem; detail: string };

/** PostgREST 伺服器端一次最多回幾列（Supabase 預設） */
export const MAX_ROWS = 1000;
/** 要豁免就在查詢上方寫這個，後面接一個說得出口的理由 */
export const MARKER = "query-bounds: ok";

const CHAIN_START = /\b(?:supabase|supabaseAdmin|client|sb|db)\s*\.\s*from\s*\(/g;

/** 跳過空白與註解，回傳下一個有意義的字元位置 */
function skipTrivia(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith("//", i)) { const nl = src.indexOf("\n", i); if (nl < 0) return src.length; i = nl + 1; continue; }
    if (src.startsWith("/*", i)) { const end = src.indexOf("*/", i); if (end < 0) return src.length; i = end + 2; continue; }
    return i;
  }
}

/** 往回找這條鏈上方的豁免標記（只看緊鄰的連續註解行） */
function markerAbove(src: string, start: number): string | null {
  const lines = src.slice(0, start).split("\n");
  lines.pop(); // 鏈自己那一行
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k].trim();
    if (l === "") continue;
    if (!l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*")) return null;
    const at = l.indexOf(MARKER);
    if (at >= 0) return l.slice(at + MARKER.length).replace(/^[\s—:-]+/, "").trim();
  }
  return null;
}

/** 這條鏈是不是 `let query = supabase.from(...)`：是的話回傳變數名 */
function assignedTo(src: string, start: number): string | null {
  const before = src.slice(Math.max(0, start - 80), start);
  const m = before.match(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/);
  return m ? m[1] : null;
}

/**
 * 從 `.from(` 往後吃完整條查詢鏈。
 * 規則：括號配對回到 0 之後，跳過空白與註解看下一個字元——是 `.` 就繼續，不是就收工。
 * 一定要跳註解：鏈常被「為什麼這樣排」的說明斷成兩截，斷了就看漏下半截的 .limit()。
 */
export function extractChains(file: string, source: string): Chain[] {
  const out: Chain[] = [];
  CHAIN_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHAIN_START.exec(source)) !== null) {
    const start = m.index;
    let i = m.index + m[0].length;
    let depth = 1;
    let quote: string | null = null;
    while (i < source.length) {
      const c = source[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; i++; continue; }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) {
          const j = skipTrivia(source, i + 1);
          if (source[j] === ".") { i = j; continue; }
          i++;
          break;
        }
      }
      i++;
    }
    out.push({
      file,
      line: source.slice(0, start).split("\n").length,
      text: source.slice(start, i),
      assignedTo: assignedTo(source, start),
      marker: markerAbove(source, start),
    });
    CHAIN_START.lastIndex = i;
  }
  return out;
}

export function judge(chain: Chain, source: string): Verdict {
  const t = chain.text;

  if (/\.(insert|update|upsert|delete)\s*\(/.test(t)) return { ok: true, reason: "write" };
  if (/head:\s*true/.test(t)) return { ok: true, reason: "count" };
  if (/\.(single|maybeSingle)\s*\(/.test(t)) return { ok: true, reason: "single" };
  if (/\.eq\(\s*"id"\s*,/.test(t) && !/\.in\(/.test(t)) return { ok: true, reason: "single" };

  if (/\.range\s*\(/.test(t)) {
    if (!/\.order\s*\(/.test(t)) {
      return { ok: false, problem: "unordered-pagination", detail: "翻頁沒有 .order：頁與頁之間的順序沒保證，會重複或漏筆" };
    }
    return { ok: true, reason: "paginated" };
  }

  const lim = t.match(/\.limit\s*\(\s*([0-9_]+)\s*\)/);
  if (lim) {
    const n = Number(lim[1].replace(/_/g, ""));
    if (n > MAX_ROWS) {
      return { ok: false, problem: "limit-over-max-rows", detail: `.limit(${n}) 超過伺服器上限 ${MAX_ROWS}：多的列拿不到，也不會報錯` };
    }
    return { ok: true, reason: "bounded-limit" };
  }
  if (/\.limit\s*\(/.test(t)) return { ok: true, reason: "bounded-limit" };

  // 建構器寫法：`let query = supabase.from(...)` 後面才 `query.limit(n)`
  if (chain.assignedTo) {
    const later = new RegExp(`\\b${chain.assignedTo}\\s*\\.\\s*(limit|range)\\s*\\(`);
    if (later.test(source)) return { ok: true, reason: "deferred-limit" };
  }

  // .in("id", ids)：列數由那批 id 決定。只認變數，不認寫死的陣列——
  // .in("status", ["pending","verified"]) 篩的是狀態不是身分，一點上限都沒給。
  if (/\.in\(\s*"[^"]+"\s*,\s*[A-Za-z_$[]/.test(t) && !/\.in\(\s*"[^"]+"\s*,\s*\[\s*["']/.test(t)) {
    return { ok: true, reason: "bounded-by-ids" };
  }
  // .eq("xxx_id", v)：綁在單一母體底下（一筆貢獻的票、一個提問的答案），扇出有天然上限
  if (/\.eq\(\s*"[a-z_]*_id"\s*,/.test(t)) return { ok: true, reason: "bounded-by-parent" };

  if (chain.marker !== null) {
    if (chain.marker === "") {
      return { ok: false, problem: "marker-without-reason", detail: `${MARKER} 後面要寫理由，寫不出來就表示沒算過` };
    }
    return { ok: true, reason: "marked" };
  }

  return { ok: false, problem: "no-bound", detail: `沒有 limit 也沒有翻頁：超過 ${MAX_ROWS} 列的部分會被靜默丟掉` };
}

/** 報告用：鏈的第一行 */
export function firstLineOf(chain: Chain): string {
  return chain.text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2).join(" ").slice(0, 140);
}

/** 掃一個目錄底下所有 Edge Function 原始碼（不含測試） */
export async function scanFunctions(root: string): Promise<Array<{ chain: Chain; verdict: Verdict }>> {
  const out: Array<{ chain: Chain; verdict: Verdict }> = [];
  const files: string[] = [];
  for await (const e of Deno.readDir(root)) {
    if (!e.isDirectory) continue;
    for await (const f of Deno.readDir(`${root}/${e.name}`)) {
      if (f.isFile && f.name.endsWith(".ts") && !f.name.endsWith(".test.ts")) files.push(`${e.name}/${f.name}`);
    }
  }
  files.sort();
  for (const f of files) {
    const src = await Deno.readTextFile(`${root}/${f}`);
    for (const chain of extractChains(f, src)) out.push({ chain, verdict: judge(chain, src) });
  }
  return out;
}
