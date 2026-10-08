/**
 * 派工紀錄定時清理（#485，migration 20261009080000_dispatch_records_purge.sql）。
 *
 * verify_dispatches、contribution_task_skips 兩張表沒有清理、一直累積。這支守門確保「清掉的東西沒有人還要看」：
 * 只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。
 *
 *   A. 文字層（不開資料庫）
 *      1. 讀者清單是從原始碼與 migration「抽」出來的，不是手寫的：
 *         程式端——全 repo 非測試檔裡每一條 .from("verify_dispatches"／"contribution_task_skips") 的查詢鏈，
 *                  讀取的把 .gte("dispatched_at"／"skipped_at", …) 的時間算成小時；沒有時限＝無限（直接紅）。
 *         SQL 端——所有 migration 照檔名排序，每支函式／視圖／排程只取「最後一版」（舊版已被取代，不算讀者），
 *                  本體裡每一處 FROM／JOIN 這兩張表的子查詢，抽 interval '15 minutes'、make_interval(… LEAST(…, 240)) 的時限。
 *      2. 保留天數（預設值＋之後所有 UPDATE dispatch_records_settings 的最終值）＋ 1 天邊際 ≥ 每一處的回看期；欄位 CHECK 的下限也要滿足
 *      3. 排程：每天一次、先 unschedule 再 schedule、呼叫 dispatch_records_purge()
 *      4. 沒有登記的新讀者、沒有時限的讀者、抽不出時限的讀者，一律紅（要嘛加時限、要嘛評估後調保留天數）
 *   B. PGlite（行為層）：真的 contribution_verify_pool、dispatch_recent、這支清理函式
 *      清理前後，驗證池、/queue、每台機器 2:1 的查詢、派工綁定查詢逐筆相同；只有超過保留期的列被刪；分批上限；停用；設定改值；CHECK 下限；審計；權限；冪等
 *   C. 每條守門都做還原驗證：把原始碼或 migration 精確改壞一處（改不到就失敗），對應的檢查必須紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const ROOT = new URL("../../../", import.meta.url);
const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const PURGE_MIG = "20261009080000_dispatch_records_purge.sql";
const TABLES = ["verify_dispatches", "contribution_task_skips"] as const;
type Table = typeof TABLES[number];
const TIME_COL: Record<Table, string> = { verify_dispatches: "dispatched_at", contribution_task_skips: "skipped_at" };
/** 保留天數至少要比最長回看期多這麼多小時 */
const MARGIN_HOURS = 24;

type Src = { path: string; text: string };
type Mig = { name: string; sql: string };
type Sources = { ts: Src[]; migs: Mig[] };
type Reader = { table: Table; where: string; hours: number };

// ============================================================
// 讀檔
// ============================================================
const norm = (s: string) => s.replace(/\r\n/g, "\n");
async function walk(dir: URL, out: Src[], rel = ""): Promise<void> {
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory) {
      if (["node_modules", ".git", ".claude", "dist", ".temp", ".wrangler", "migrations", "public", "docs"].includes(e.name)) continue;
      await walk(new URL(e.name + "/", dir), out, rel + e.name + "/");
    } else if (/\.(ts|tsx|vue|mjs|cjs|js)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push({ path: rel + e.name, text: norm(await Deno.readTextFile(new URL(e.name, dir))) });
    }
  }
}
async function loadSources(): Promise<Sources> {
  const ts: Src[] = [];
  await walk(ROOT, ts);
  const migs: Mig[] = [];
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort()) migs.push({ name, sql: norm(await Deno.readTextFile(new URL(name, MIGRATIONS))) });
  return { ts, migs };
}
const REAL = await loadSources();

/** 精確改一處：改不到或改到兩處都算失敗（標記字串必須唯一，不然「還原驗證」可能什麼都沒改） */
function mutate(text: string, from: string, to: string): string {
  const n = text.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 70)}`);
  return text.replace(from, () => to);
}
const mutateSrc = (s: Sources, path: string, from: string, to: string): Sources => ({
  ...s, ts: s.ts.map((f) => f.path === path ? { ...f, text: mutate(f.text, from, to) } : f),
});
const mutateMig = (s: Sources, name: string, from: string, to: string): Sources => ({
  ...s, migs: s.migs.map((m) => m.name === name ? { ...m, sql: mutate(m.sql, from, to) } : m),
});

// ============================================================
// 程式端：抽回看期
// ============================================================
const stripTsComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

/** 從 dispatch.ts 讀 export const NAME = 數字;（讀文字不 import，所以還原驗證改文字就會跟著變） */
function constsOf(s: Sources): Record<string, number> {
  const f = s.ts.find((x) => x.path === "supabase/functions/_shared/dispatch.ts");
  assert(f, "找不到 dispatch.ts");
  const out: Record<string, number> = {};
  for (const m of stripTsComments(f.text).matchAll(/export const ([A-Z_0-9]+)\s*=\s*([\d_]+)\s*;/g)) out[m[1]] = Number(m[2].replaceAll("_", ""));
  return out;
}

/** 從某個位置的 .from( 開始，取到查詢鏈結束（括號配對；在最外層遇到分號或逗號就停） */
function chainFrom(code: string, idx: number): string {
  let d = 0;
  for (let i = idx; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") { if (d === 0) return code.slice(idx, i); d--; }
    else if (d === 0 && (c === ";" || c === ",")) return code.slice(idx, i);
  }
  return code.slice(idx);
}
/** 呼叫 .name( … ) 的引數文字（括號配對） */
function callArgs(code: string, openIdx: number): string {
  let d = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === "(") d++;
    else if (code[i] === ")") { d--; if (d === 0) return code.slice(openIdx + 1, i); }
  }
  return code.slice(openIdx + 1);
}
/** 毫秒運算式（常數名 × 數字）求值；常數名不認得就丟錯 */
function evalMs(expr: string, consts: Record<string, number>): number {
  const e = expr.replace(/[A-Z][A-Z_0-9]+/g, (id) => {
    if (!(id in consts)) throw new Error(`不認得的常數 ${id}`);
    return String(consts[id]);
  }).replaceAll("_", "");
  if (!/^[\d\s*+\-/().]+$/.test(e)) throw new Error(`算不出來的運算式：${expr}`);
  return Function(`"use strict"; return (${e});`)() as number;
}

function tsReaders(s: Sources): { readers: Reader[]; problems: string[] } {
  const consts = constsOf(s);
  const readers: Reader[] = [];
  const problems: string[] = [];
  for (const f of s.ts) {
    const code = stripTsComments(f.text);
    for (const m of code.matchAll(/\.from\(\s*["'`](verify_dispatches|contribution_task_skips)["'`]\s*\)/g)) {
      const table = m[1] as Table;
      const chain = chainFrom(code, m.index!);
      const first = /^\.from\([^)]*\)\s*\.(\w+)\(/.exec(chain)?.[1] ?? "";
      if (["upsert", "insert", "delete", "update"].includes(first)) continue; // 寫入不是讀者
      const where = `${f.path}（${table}）`;
      const col = TIME_COL[table];
      const g = new RegExp(`\\.(?:gte|gt)\\(\\s*["']${col}["']\\s*,`).exec(chain);
      if (!g) { readers.push({ table, where, hours: Infinity }); continue; }
      const arg = callArgs(chain, chain.indexOf("(", g.index)).replace(new RegExp(`^\\s*["']${col}["']\\s*,`), "").trim();
      let expr: string | null = null;
      if (/^[A-Za-z_]\w*$/.test(arg)) {
        const d = new RegExp(`(?:const|let)\\s+${arg}\\s*=\\s*new Date\\(\\s*Date\\.now\\(\\)\\s*-\\s*(.+?)\\)\\s*\\.toISOString\\(\\)`).exec(code);
        expr = d?.[1] ?? null;
      } else {
        expr = /Date\.now\(\)\s*-\s*(.+?)\)\s*\.toISOString\(\)/.exec(arg)?.[1] ?? null;
      }
      if (!expr) { problems.push(`${where}：抽不出 .gte("${col}", …) 的時限（${arg}）`); readers.push({ table, where, hours: Infinity }); continue; }
      try {
        readers.push({ table, where, hours: evalMs(expr, consts) / 3_600_000 });
      } catch (e) {
        problems.push(`${where}：${(e as Error).message}`);
        readers.push({ table, where, hours: Infinity });
      }
    }
  }
  return { readers, problems };
}

// ============================================================
// SQL 端：每支函式／視圖／排程只取最後一版，抽回看期
// ============================================================
type Def = { kind: "function" | "view" | "cron"; name: string; file: string; body: string };
const stripSqlComments = (t: string) => t.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

function finalDefs(migs: Mig[]): Map<string, Def> {
  const defs = new Map<string, Def>();
  for (const { name: file, sql } of migs) {
    const events: Array<{ pos: number; op: "set" | "del"; key: string; def?: Def }> = [];
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([A-Za-z_0-9]+)\s*\(/gi)) {
      const after = sql.slice(m.index! + m[0].length);
      const tag = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(after);
      if (!tag) continue;
      const nextCreate = after.search(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
      if (nextCreate >= 0 && tag.index! > nextCreate) continue;
      const start = tag.index! + tag[0].length;
      const end = after.indexOf(tag[1], start);
      if (end < 0) continue;
      const key = "fn:" + m[1].toLowerCase();
      events.push({ pos: m.index!, op: "set", key, def: { kind: "function", name: m[1].toLowerCase(), file, body: after.slice(start, end) } });
    }
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:public\.)?([A-Za-z_0-9]+)\b[^;]*?\bAS\b/gi)) {
      const start = m.index! + m[0].length;
      const end = sql.indexOf(";", start);
      events.push({ pos: m.index!, op: "set", key: "view:" + m[1].toLowerCase(), def: { kind: "view", name: m[1].toLowerCase(), file, body: sql.slice(start, end < 0 ? undefined : end) } });
    }
    for (const m of sql.matchAll(/cron\.schedule\(\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*(\$[A-Za-z_]*\$)/g)) {
      const start = m.index! + m[0].length;
      const end = sql.indexOf(m[2], start);
      events.push({ pos: m.index!, op: "set", key: "cron:" + m[1], def: { kind: "cron", name: m[1], file, body: sql.slice(start, end < 0 ? undefined : end) } });
    }
    for (const m of sql.matchAll(/cron\.unschedule\(\s*'([^']+)'\s*\)/g)) events.push({ pos: m.index!, op: "del", key: "cron:" + m[1] });
    for (const m of sql.matchAll(/DROP\s+(FUNCTION|VIEW)\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([A-Za-z_0-9]+)/gi)) {
      events.push({ pos: m.index!, op: "del", key: (m[1].toUpperCase() === "FUNCTION" ? "fn:" : "view:") + m[2].toLowerCase() });
    }
    events.sort((a, b) => a.pos - b.pos);
    for (const e of events) {
      if (e.op === "set") defs.set(e.key, e.def!);
      else defs.delete(e.key);
    }
  }
  return defs;
}

/** 括號配對：idx 所在的子查詢（往回找沒配對的 "("，往後找它的結尾）；不在括號裡就取到 UNION／分號／本體結尾 */
function enclosingClause(body: string, idx: number): string {
  let depth = 0;
  let open = -1;
  for (let i = idx - 1; i >= 0; i--) {
    const c = body[i];
    if (c === ")") depth++;
    else if (c === "(") { if (depth === 0) { open = i; break; } depth--; }
  }
  let d = 0;
  let end = body.length;
  for (let i = idx; i < body.length; i++) {
    const c = body[i];
    if (c === "(") d++;
    else if (c === ")") { if (d === 0) { end = i; break; } d--; }
    else if (d === 0 && c === ";") { end = i; break; }
    else if (open < 0 && d === 0 && /^UNION\b/i.test(body.slice(i, i + 5))) { end = i; break; }
  }
  return body.slice(open >= 0 ? open : idx, end);
}
const UNIT_HOURS: Record<string, number> = {
  second: 1 / 3600, seconds: 1 / 3600, sec: 1 / 3600, secs: 1 / 3600, minute: 1 / 60, minutes: 1 / 60, min: 1 / 60, mins: 1 / 60,
  hour: 1, hours: 1, day: 24, days: 24, week: 168, weeks: 168,
};
/** 子查詢裡對時間欄的下界：dispatched_at > now() - interval '15 minutes' 或 make_interval(mins => LEAST(…, 240)) → 小時；沒有下界＝無限；寫法認不得就丟錯 */
function boundHours(clause: string, col: string): number {
  let best = Infinity;
  let found = false;
  for (const m of clause.matchAll(new RegExp(String.raw`(?<![A-Za-z_])${col}\s*>=?\s*([^\n]*)`, "gi"))) {
    const expr = m[1];
    let h: number | null = null;
    const iv = /interval\s+'\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|days?|weeks?)\s*'/i.exec(expr);
    if (iv) h = Number(iv[1]) * UNIT_HOURS[iv[2].toLowerCase()];
    const mi = /make_interval\(\s*(secs|mins|hours|days|weeks)\s*=>\s*(.+)\)/i.exec(expr);
    if (h === null && mi) {
      const cap = /LEAST\(.*,\s*(\d+)\s*\)/i.exec(mi[2]) ?? /^\s*(\d+)\s*\)*\s*$/.exec(mi[2]);
      if (cap) h = Number(cap[1]) * UNIT_HOURS[mi[1].toLowerCase()];
    }
    if (h === null || Number.isNaN(h)) throw new Error(`抽不出時限：${col} > ${expr.trim()}`);
    best = found ? Math.max(best, h) : h; // 同一個子查詢多個下界取最長（保守）
    found = true;
  }
  return found ? best : Infinity;
}
function sqlReaders(s: Sources): { readers: Reader[]; problems: string[] } {
  const readers: Reader[] = [];
  const problems: string[] = [];
  for (const def of finalDefs(s.migs).values()) {
    if (def.kind === "function" && def.name === "dispatch_records_purge") continue; // 清理者本人
    const body = stripSqlComments(def.body);
    for (const table of TABLES) {
      for (const m of body.matchAll(new RegExp(`\\b${table}\\b`, "g"))) {
        const before = body.slice(Math.max(0, m.index! - 40), m.index!);
        if (/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?$/i.test(before)) continue; // 寫入
        const where = `${def.kind} ${def.name}（${def.file}）→ ${table}`;
        try {
          readers.push({ table, where, hours: boundHours(enclosingClause(body, m.index!), TIME_COL[table]) });
        } catch (e) {
          problems.push(`${where}：${(e as Error).message}`);
          readers.push({ table, where, hours: Infinity });
        }
      }
    }
  }
  return { readers, problems };
}

// ============================================================
// 保留天數（預設＋之後所有 UPDATE 的最終值）與總檢查
// ============================================================
type Retention = { days: Record<Table, number>; floor: Record<Table, number> };
const COLS: Record<Table, string> = { verify_dispatches: "verify_dispatches_days", contribution_task_skips: "task_skips_days" };
const noStrings = (sql: string) => stripSqlComments(sql).replace(/'(?:[^']|'')*'/g, "''");
function retentionOf(s: Sources): { retention: Retention | null; problems: string[] } {
  const problems: string[] = [];
  const days = {} as Record<Table, number>;
  const floor = {} as Record<Table, number>;
  const defining = s.migs.find((m) => /CREATE TABLE IF NOT EXISTS dispatch_records_settings/.test(m.sql));
  if (!defining) return { retention: null, problems: ["找不到 dispatch_records_settings 的 migration"] };
  const ddl = noStrings(defining.sql);
  for (const t of TABLES) {
    const c = COLS[t];
    const m = new RegExp(`${c}\\s+INTEGER\\s+NOT NULL\\s+DEFAULT\\s+(\\d+)\\s+CHECK\\s*\\(\\s*${c}\\s+BETWEEN\\s+(\\d+)\\s+AND\\s+(\\d+)\\s*\\)`).exec(ddl);
    if (!m) { problems.push(`抽不出 ${c} 的預設值與 CHECK 範圍`); continue; }
    days[t] = Number(m[1]);
    floor[t] = Number(m[2]);
  }
  for (const mig of s.migs) {
    if (mig.name < defining.name) continue;
    for (const u of noStrings(mig.sql).matchAll(/UPDATE\s+dispatch_records_settings\s+SET([^;]*?)WHERE/gi)) {
      for (const t of TABLES) {
        const v = new RegExp(`\\b${COLS[t]}\\s*=\\s*(\\d+)`).exec(u[1]);
        if (v) days[t] = Number(v[1]);
      }
    }
  }
  if (TABLES.some((t) => days[t] === undefined)) return { retention: null, problems };
  return { retention: { days, floor }, problems };
}

function allProblems(s: Sources): string[] {
  const out: string[] = [];
  const ts = tsReaders(s);
  const sql = sqlReaders(s);
  out.push(...ts.problems, ...sql.problems);
  const consts = constsOf(s);
  const readers = [...ts.readers, ...sql.readers];
  // 曾經有的 24 小時：程式裡留著 @deprecated 常數，將來有人拿它復活 skip 判斷時，保留天數要跟得上
  if ("SKIP_MEMORY_HOURS" in consts) readers.push({ table: "contribution_task_skips", where: "SKIP_MEMORY_HOURS（dispatch.ts，@deprecated 常數）", hours: consts.SKIP_MEMORY_HOURS });
  const { retention, problems: rp } = retentionOf(s);
  out.push(...rp);
  if (retention) {
    for (const t of TABLES) {
      const longest = Math.max(0, ...readers.filter((r) => r.table === t).map((r) => r.hours));
      for (const r of readers.filter((x) => x.table === t)) {
        const need = r.hours + MARGIN_HOURS;
        if (retention.days[t] * 24 < need) out.push(`${t} 保留 ${retention.days[t]} 天 < ${r.where} 的回看期 ${r.hours === Infinity ? "無限" : r.hours + " 小時"} ＋ 邊際 ${MARGIN_HOURS} 小時`);
      }
      if (retention.floor[t] * 24 < longest + MARGIN_HOURS) out.push(`${t} 的 CHECK 下限 ${retention.floor[t]} 天 < 最長回看期 ${longest} 小時 ＋ 邊際：資料庫攔不住有人把保留天數改小`);
    }
  }
  // 排程
  const defs = finalDefs(s.migs);
  const cron = defs.get("cron:dispatch-records-purge");
  const sched = /cron\.schedule\(\s*'dispatch-records-purge'\s*,\s*'([^']+)'/.exec(s.migs.find((m) => m.name === cron?.file)?.sql ?? "")?.[1];
  if (!cron || !sched) out.push("沒有 dispatch-records-purge 排程");
  else {
    if (!/^\d{1,2} \d{1,2} \* \* \*$/.test(sched)) out.push(`排程不是每天一次：${sched}`);
    if (!/SELECT\s+dispatch_records_purge\(\)/i.test(cron.body)) out.push("排程沒有呼叫 dispatch_records_purge()");
    const sql = s.migs.find((m) => m.name === cron.file)!.sql;
    if (!/cron\.unschedule\('dispatch-records-purge'\)\s+WHERE EXISTS/.test(sql)) out.push("排程要先 unschedule（WHERE EXISTS）再 schedule，migration 才能重跑");
  }
  return out;
}

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 讀者清單抽得出來（不是瞎的）：程式端與 SQL 端各處的回看期", () => {
  const ts = tsReaders(REAL);
  const sql = sqlReaders(REAL);
  assertEquals([...ts.problems, ...sql.problems], []);
  const consts = constsOf(REAL);
  const find = (rs: Reader[], t: Table, frag: string) => rs.find((r) => r.table === t && r.where.includes(frag));
  assertEquals(find(ts.readers, "verify_dispatches", "next/index.ts")?.hours, consts.MACHINE_LOOKBACK_HOURS, "/next 每台機器 2:1");
  assertEquals(find(ts.readers, "verify_dispatches", "verify-handler.ts")?.hours, consts.VERIFY_BINDING_DAYS * 24, "派工綁定");
  assertEquals(find(sql.readers, "verify_dispatches", "contribution_verify_pool")?.hours, 15 / 60, "驗證池：剛派的 15 分鐘");
  assertEquals(find(sql.readers, "verify_dispatches", "dispatch_recent")?.hours, 240 / 60, "/queue：上限 240 分鐘");
  assertEquals(consts.MACHINE_LOOKBACK_HOURS, 3);
  assertEquals(consts.VERIFY_BINDING_DAYS, 7);
  // 寫入端不算讀者；skips 沒有任何讀者（正式庫 2026-10-08 查：沒有函式、視圖引用它）
  assertEquals(ts.readers.filter((r) => r.table === "contribution_task_skips").length, 0, "skips 在程式裡只有 upsert");
  assertEquals(sql.readers.filter((r) => r.table === "contribution_task_skips").length, 0, "skips 最後一版的函式／視圖／排程都不讀它");
  assertEquals(ts.readers.filter((r) => r.table === "verify_dispatches").length, 2, "程式端 verify_dispatches 的讀者只有 /next 與派工綁定");
  assertEquals(sql.readers.filter((r) => r.table === "verify_dispatches").length, 2, "SQL 端只有驗證池與 dispatch_recent");
});

Deno.test("A2 保留天數 ＋ 邊際 ≥ 每一處程式的回看期；欄位 CHECK 的下限也是；排程每天一次", () => {
  assertEquals(allProblems(REAL), []);
  const { retention } = retentionOf(REAL);
  assertEquals(retention?.days, { verify_dispatches: 14, contribution_task_skips: 7 });
  assertEquals(retention?.floor, { verify_dispatches: 8, contribution_task_skips: 2 });
});

Deno.test("A3 函式本體沒有寫死的天數與批量（全在 dispatch_records_settings）", () => {
  const sql = REAL.migs.find((m) => m.name === PURGE_MIG)!.sql;
  const defs = finalDefs([{ name: PURGE_MIG, sql }]);
  const body = stripSqlComments(defs.get("fn:dispatch_records_purge")!.body).replace(/'(?:[^']|'')*'/g, "''");
  assertEquals((body.match(/(?<![A-Za-z_.])\d+(?![A-Za-z_])/g) ?? []).filter((n) => n !== "0" && n !== "1"), [], "函式本體不該出現 1 以外的數字");
  assert(/FOR UPDATE SKIP LOCKED/.test(body), "要跳過被鎖住的列，不排隊等鎖");
  assert(/s\.verify_dispatches_days/.test(body) && /s\.task_skips_days/.test(body) && /s\.batch_size/.test(body) && /s\.max_batches/.test(body));
});

// ============================================================
// B. PGlite
// ============================================================
const MIG_SQL = REAL.migs.find((m) => m.name === PURGE_MIG)!.sql;
const P0 = REAL.migs.find((m) => m.name === "20261008001000_activity_windows_p0.sql")!.sql;
const migSql = (name: string) => REAL.migs.find((m) => m.name === name)!.sql;

function fnDefinition(s: Sources, name: string): string {
  const d = finalDefs(s.migs).get("fn:" + name);
  assert(d, `找不到 ${name} 的最後一版`);
  const sql = s.migs.find((m) => m.name === d.file)!.sql;
  const at = [...sql.matchAll(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, "gi"))].pop()!.index!;
  const rest = sql.slice(at);
  const tag = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(rest)!;
  const start = tag.index! + tag[0].length;
  const end = rest.indexOf(tag[1], start) + tag[1].length;
  return rest.slice(0, end) + ";";
}
function fnFromP0(name: string): string {
  const at = P0.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(at >= 0, name);
  const rest = P0.slice(at);
  const tag = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(rest)!;
  const start = tag.index! + tag[0].length;
  return rest.slice(0, rest.indexOf(tag[1], start) + tag[1].length) + ";";
}

const BASE = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobname text, schedule text, command text);
CREATE FUNCTION cron.schedule(n text, s text, c text) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO cron.job VALUES (n, s, c) RETURNING 1::bigint $$;
CREATE FUNCTION cron.unschedule(n text) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = n RETURNING true $$;
CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text DEFAULT 'candidacy', payload jsonb DEFAULT '{}', source_urls text[], note text, task_id text,
  agent_name text, contributor_ip_hash text, status text DEFAULT 'pending', agree_count int DEFAULT 0, disagree_count int DEFAULT 0, unsure_count int DEFAULT 0,
  created_at timestamptz DEFAULT now(), score int DEFAULT 0, target_score int, voter_ips int DEFAULT 0);
CREATE TABLE contribution_votes (id bigserial PRIMARY KEY, contribution_id uuid, verifier_ip_hash text, created_at timestamptz DEFAULT now());
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, source text);
CREATE TABLE contribution_task_leases (task_id text PRIMARY KEY, agent_name text, ip_hash text, leased_until timestamptz);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, queue_at timestamptz NOT NULL DEFAULT now(), verify_target int);
CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text NOT NULL, record_id text NOT NULL, field text NOT NULL, old_value jsonb, new_value jsonb,
  contribution_id uuid, agent_name text, applied_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz, reverted_by text);
CREATE FUNCTION contribution_effective_agree(uuid) RETURNS int LANGUAGE sql AS $$ SELECT 3 $$;
CREATE FUNCTION contribution_needs_two_ips(text, jsonb) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
`;

async function buildDb(purgeSql: string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(migSql("20260915000002_task_skips.sql"));
  await db.exec(migSql("20260921000014_verify_dispatch.sql"));
  await db.exec(fnFromP0("activity_audit"));
  await db.exec(fnFromP0("activity_touch_updated_at"));
  await db.exec(fnDefinition(REAL, "contribution_verify_pool"));
  await db.exec(fnDefinition(REAL, "dispatch_recent"));
  await db.exec(purgeSql);
  return db;
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Array<Record<string, unknown>>;

const consts = constsOf(REAL);
/** 這些查詢在程式裡的樣子（next/index.ts 的 since、verify-handler 的 bindingSince、驗證池、/queue）；清理前後各跑一次 */
async function snapshot(db: PGlite, ids: string[]): Promise<Record<string, unknown>> {
  const pool = await q(db, `SELECT id FROM contribution_verify_pool('A', NULL, 200, NULL, NULL) ORDER BY queue_at, id`);
  const recent = await q(db, `SELECT kind, task_id, agent_name, dispatched_at FROM dispatch_recent(240) ORDER BY 4 DESC, 2`);
  const machine = await q(db, `SELECT dispatched_at FROM verify_dispatches WHERE ip_hash = 'A' AND dispatched_at >= now() - make_interval(hours => ${consts.MACHINE_LOOKBACK_HOURS}) ORDER BY dispatched_at DESC LIMIT 3`);
  const binding: boolean[] = [];
  for (const id of ids) {
    binding.push((await q(db, `SELECT 1 FROM verify_dispatches WHERE contribution_id = $1 AND ip_hash = 'A' AND dispatched_at >= now() - make_interval(days => ${consts.VERIFY_BINDING_DAYS})`, [id])).length > 0);
  }
  return { pool: pool.map((r) => r.id), recent, machine, binding };
}

/** 一整套情境：各種年紀的派工紀錄與跳過紀錄；回傳這支清理有哪裡不對（空＝沒問題） */
async function scenario(purgeSql: string): Promise<string[]> {
  const problems: string[] = [];
  const db = await buildDb(purgeSql);
  try {
    // 13 筆待驗證貢獻（別人交的），各派給 A 一次，年紀不同；邊界附近留 1 分鐘以上的空隙
    const ages: Array<[string, number]> = [
      ["5 minutes", 1], ["14 minutes", 2], ["20 minutes", 3], ["2 hours", 4], ["3 hours 20 minutes", 5], ["1 day", 6], ["6 days", 7], ["6 days 23 hours", 8],
      ["8 days", 9], ["13 days", 10], ["14 days 1 hour", 11], ["20 days", 12], ["40 days", 13],
    ];
    const ids: string[] = [];
    for (const [age, n] of ages) {
      ids.push(uuid(n));
      await db.query(`INSERT INTO contributions (id, contributor_ip_hash, agent_name, created_at) VALUES ($1, 'other', 'other-agent', now() - interval '60 days')`, [uuid(n)]);
      await db.query(`INSERT INTO task_dispatches (task_id, queue_at) VALUES ($1, now() - make_interval(secs => $2))`, [`verify:${uuid(n)}`, 100000 - n]);
      await db.query(`INSERT INTO verify_dispatches (contribution_id, ip_hash, agent_name, dispatched_at) VALUES ($1, 'A', 'agent-a', now() - interval '${age}')`, [uuid(n)]);
    }
    // 別台機器 B 的紀錄：新舊各一
    await db.query(`INSERT INTO verify_dispatches (contribution_id, ip_hash, agent_name, dispatched_at) VALUES ($1, 'B', 'agent-b', now() - interval '1 hour'), ($2, 'B', 'agent-b', now() - interval '30 days')`, [uuid(1), uuid(13)]);
    // 跳過紀錄：A 的 1 小時、3 天、6 天 23 小時、8 天、30 天
    for (const [i, age] of ["1 hour", "3 days", "6 days 23 hours", "8 days", "30 days"].entries()) {
      await db.query(`INSERT INTO contribution_task_skips (task_id, ip_hash, agent_name, skipped_at) VALUES ($1, 'A', 'agent-a', now() - interval '${age}')`, [`auto:t${i}`]);
    }
    const before = await snapshot(db, ids);
    const counts0 = { vd: Number((await q(db, `SELECT count(*) c FROM verify_dispatches`))[0].c), sk: Number((await q(db, `SELECT count(*) c FROM contribution_task_skips`))[0].c) };
    const res = (await q(db, `SELECT dispatch_records_purge() AS r`))[0].r as Record<string, unknown>;
    const after = await snapshot(db, ids);
    const counts1 = { vd: Number((await q(db, `SELECT count(*) c FROM verify_dispatches`))[0].c), sk: Number((await q(db, `SELECT count(*) c FROM contribution_task_skips`))[0].c) };
    for (const k of Object.keys(before)) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) problems.push(`清理前後 ${k} 的結果不同`);
    // 不是空轉：該刪的真的刪了（A 的 3 筆＋B 的 1 筆 ＝ 4；skips 2 筆），沒到期的一筆都沒動
    if (counts0.vd - counts1.vd !== 4) problems.push(`verify_dispatches 該刪 4 筆，實際 ${counts0.vd - counts1.vd}`);
    if (counts0.sk - counts1.sk !== 2) problems.push(`contribution_task_skips 該刪 2 筆，實際 ${counts0.sk - counts1.sk}`);
    if (Number(res.verify_dispatches) !== 4 || Number(res.contribution_task_skips) !== 2) problems.push(`回傳的刪除筆數不對：${JSON.stringify(res)}`);
    const left = (await q(db, `SELECT count(*) c FROM verify_dispatches WHERE dispatched_at < now() - interval '14 days'`))[0].c;
    if (Number(left) !== 0) problems.push("還有超過 14 天的 verify_dispatches");
    // 該有的情境條件：池子真的排除了剛派的、機器查詢真的有東西，不然「前後相同」是空的
    if (!(before.pool as string[]).includes(uuid(3)) || (before.pool as string[]).includes(uuid(1))) problems.push("情境沒造好：驗證池應排除 5 分鐘前派的、保留 20 分鐘前派的");
    if ((before.machine as unknown[]).length !== 3) problems.push("情境沒造好：機器查詢應有 3 筆");
  } finally {
    await db.close();
  }
  return problems;
}

Deno.test("B1 清理前後：驗證池、/queue、每台機器 2:1、派工綁定的結果逐筆相同；只有超過保留期的列被刪", async () => {
  assertEquals(await scenario(MIG_SQL), []);
});

Deno.test("B2 分批與上限：每批 batch_size、最多 max_batches 批，沒刪完的下一次接著刪；沒東西可刪回 0", async () => {
  const db = await buildDb(MIG_SQL);
  try {
    await db.exec(`INSERT INTO contributions (id, contributor_ip_hash) SELECT ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'other' FROM generate_series(1, 450) g`);
    await db.exec(`INSERT INTO verify_dispatches (contribution_id, ip_hash, dispatched_at) SELECT id, 'A', now() - interval '30 days' FROM contributions`);
    await db.exec(`INSERT INTO contribution_task_skips (task_id, ip_hash, skipped_at) SELECT 'auto:' || g, 'A', now() - interval '30 days' FROM generate_series(1, 450) g`);
    await db.exec(`UPDATE dispatch_records_settings SET batch_size = 100, max_batches = 2 WHERE id = 1`);
    const run = async () => (await q(db, `SELECT dispatch_records_purge() r`))[0].r as Record<string, number | boolean>;
    assertEquals(await run(), { enabled: true, verify_dispatches: 200, contribution_task_skips: 200 });
    assertEquals(await run(), { enabled: true, verify_dispatches: 200, contribution_task_skips: 200 });
    assertEquals(await run(), { enabled: true, verify_dispatches: 50, contribution_task_skips: 50 });
    assertEquals(await run(), { enabled: true, verify_dispatches: 0, contribution_task_skips: 0 });
    assertEquals(Number((await q(db, `SELECT count(*) c FROM verify_dispatches`))[0].c), 0);
  } finally {
    await db.close();
  }
});

Deno.test("B3 停用不刪；設定是資料（改保留天數行為跟著變）；改值進審計", async () => {
  const db = await buildDb(MIG_SQL);
  try {
    await db.exec(`INSERT INTO contributions (id, contributor_ip_hash) VALUES ('${uuid(1)}', 'o'), ('${uuid(2)}', 'o'), ('${uuid(3)}', 'o')`);
    await db.exec(`INSERT INTO verify_dispatches (contribution_id, ip_hash, dispatched_at) VALUES ('${uuid(1)}', 'A', now() - interval '20 days'), ('${uuid(2)}', 'A', now() - interval '40 days'), ('${uuid(3)}', 'A', now() - interval '3 days')`);
    await db.exec(`UPDATE dispatch_records_settings SET enabled = false WHERE id = 1`);
    assertEquals((await q(db, `SELECT dispatch_records_purge() r`))[0].r, { enabled: false, verify_dispatches: 0, contribution_task_skips: 0 });
    assertEquals(Number((await q(db, `SELECT count(*) c FROM verify_dispatches`))[0].c), 3);
    await db.exec(`UPDATE dispatch_records_settings SET enabled = true, verify_dispatches_days = 30, note = '測試' WHERE id = 1`);
    assertEquals(((await q(db, `SELECT dispatch_records_purge() r`))[0].r as Record<string, number | boolean>).verify_dispatches, 1, "改成 30 天：只有 40 天前那筆被刪");
    const audit = await q(db, `SELECT agent_name, new_value->>'verify_dispatches_days' d FROM edit_history WHERE table_name = 'dispatch_records_settings' ORDER BY id`);
    assert(audit.length >= 2, "兩次修改各一列審計（初始那一列在觸發器建立之前就插了，沒有審計）");
    assertEquals(audit[audit.length - 1], { agent_name: "activity-audit", d: "30" });
  } finally {
    await db.close();
  }
});

Deno.test("B4 欄位 CHECK 擋掉不安全的保留天數（≤ 派工綁定 7 天、≤ 曾經的 24 小時）", async () => {
  const db = await buildDb(MIG_SQL);
  try {
    for (const bad of ["verify_dispatches_days = 7", "verify_dispatches_days = 1", "task_skips_days = 1", "batch_size = 99999999", "max_batches = 0"]) {
      let failed = false;
      try { await db.exec(`UPDATE dispatch_records_settings SET ${bad} WHERE id = 1`); } catch { failed = true; }
      assert(failed, `${bad} 應被 CHECK 擋掉`);
    }
    let two = false;
    try { await db.exec(`INSERT INTO dispatch_records_settings (id) VALUES (2)`); } catch { two = true; }
    assert(two, "只能有 id=1 一列");
  } finally {
    await db.close();
  }
});

Deno.test("B5 排程在、冪等（migration 重跑還是一條）；清理函式只有 service_role 能執行", async () => {
  const db = await buildDb(MIG_SQL);
  try {
    await db.exec(MIG_SQL); // 重跑
    assertEquals(await q(db, `SELECT jobname, schedule, command FROM cron.job`), [{ jobname: "dispatch-records-purge", schedule: "50 19 * * *", command: "SELECT dispatch_records_purge();" }]);
    assertEquals(Number((await q(db, `SELECT count(*) c FROM dispatch_records_settings`))[0].c), 1, "重跑不會多一列設定");
    const can = async (role: string) => (await q(db, `SELECT has_function_privilege('${role}', 'dispatch_records_purge()', 'EXECUTE') ok`))[0].ok;
    assertEquals(await can("service_role"), true);
    assertEquals(await can("anon"), false);
    assertEquals(await can("authenticated"), false);
  } finally {
    await db.close();
  }
});

// ============================================================
// C. 還原驗證：把原始碼或 migration 精確改壞一處，對應的檢查必須紅
// ============================================================
const MACHINE_FILE = "supabase/functions/next/index.ts";
const BINDING_FILE = "supabase/functions/_shared/verify-handler.ts";
const DISPATCH_FILE = "supabase/functions/_shared/dispatch.ts";
const hasProblem = (ps: string[], frag: string) => ps.some((p) => p.includes(frag));

Deno.test("C1 程式端回看期改大（3 小時→400 小時）：超過保留天數 ＋ 邊際，紅", () => {
  const bad = mutateSrc(REAL, DISPATCH_FILE, "export const MACHINE_LOOKBACK_HOURS = 3;", "export const MACHINE_LOOKBACK_HOURS = 400;");
  assert(hasProblem(allProblems(bad), "next/index.ts"), allProblems(bad).join("\n"));
});

Deno.test("C2 派工綁定的時限改成 30 天，或把 .gte 拿掉（變成無限）：紅", () => {
  const bigger = mutateSrc(REAL, DISPATCH_FILE, "export const VERIFY_BINDING_DAYS = 7;", "export const VERIFY_BINDING_DAYS = 30;");
  assert(hasProblem(allProblems(bigger), "verify-handler.ts"), allProblems(bigger).join("\n"));
  const unbounded = mutateSrc(REAL, BINDING_FILE, `.eq("ip_hash", ipHash).gte("dispatched_at", bindingSince).maybeSingle()`, `.eq("ip_hash", ipHash).maybeSingle()`);
  assert(hasProblem(allProblems(unbounded), "無限"), allProblems(unbounded).join("\n"));
});

Deno.test("C3 /next 的 since 改成寫死 30 天、或換成認不得的常數：紅", () => {
  const hard = mutateSrc(REAL, MACHINE_FILE, "MACHINE_LOOKBACK_HOURS * 3600_000", "30 * 24 * 3600_000");
  assert(hasProblem(allProblems(hard), "next/index.ts"), allProblems(hard).join("\n"));
  const unknown = mutateSrc(REAL, MACHINE_FILE, "MACHINE_LOOKBACK_HOURS * 3600_000", "SOME_NEW_LOOKBACK * 3600_000");
  assert(hasProblem(allProblems(unknown), "不認得的常數"), allProblems(unknown).join("\n"));
});

Deno.test("C4 SQL 端回看期改大：驗證池 15 分鐘→30 天、dispatch_recent 上限 240→100000 分鐘，紅", () => {
  const poolMig = finalDefs(REAL.migs).get("fn:contribution_verify_pool")!.file; // 驗證池最後一版在哪支就改哪支
  const pool = mutateMig(REAL, poolMig, "AND vd.dispatched_at > now() - interval '15 minutes'", "AND vd.dispatched_at > now() - interval '30 days'");
  assert(hasProblem(allProblems(pool), "contribution_verify_pool"), allProblems(pool).join("\n"));
  const recent = mutateMig(REAL, "20260924000007_dispatch_recent.sql", "COALESCE(p_minutes, 30), 1), 240))\n  ORDER BY 4", "COALESCE(p_minutes, 30), 1), 100000))\n  ORDER BY 4");
  assert(hasProblem(allProblems(recent), "dispatch_recent"), allProblems(recent).join("\n"));
});

Deno.test("C5 有人新增沒有時限的讀者（程式、SQL 各一）或復活 skip 判斷：紅", () => {
  const newTs: Sources = { ...REAL, ts: [...REAL.ts, { path: "supabase/functions/new-reader/index.ts", text: `const r = await supabase.from("verify_dispatches").select("ip_hash").eq("contribution_id", id);` }] };
  assert(hasProblem(allProblems(newTs), "new-reader/index.ts") && hasProblem(allProblems(newTs), "無限"), allProblems(newTs).join("\n"));
  const newSql: Sources = { ...REAL, migs: [...REAL.migs, { name: "29991231000000_x.sql", sql: `CREATE OR REPLACE FUNCTION some_new_fn() RETURNS INT LANGUAGE sql AS $$ SELECT count(*)::int FROM verify_dispatches vd WHERE vd.ip_hash = 'x' $$;` }] };
  assert(hasProblem(allProblems(newSql), "some_new_fn") && hasProblem(allProblems(newSql), "無限"), allProblems(newSql).join("\n"));
  const skipRead: Sources = { ...REAL, migs: [...REAL.migs, { name: "29991231000000_x.sql", sql: `CREATE OR REPLACE FUNCTION skip_aware() RETURNS INT LANGUAGE sql AS $$ SELECT count(*)::int FROM contribution_task_skips s WHERE s.skipped_at > now() - interval '30 days' $$;` }] };
  assert(hasProblem(allProblems(skipRead), "skip_aware") && hasProblem(allProblems(skipRead), "contribution_task_skips 保留"), allProblems(skipRead).join("\n"));
  // 抽不出時限的寫法（BETWEEN 之類）也不放過：丟錯＝問題
  const odd: Sources = { ...REAL, migs: [...REAL.migs, { name: "29991231000000_x.sql", sql: `CREATE OR REPLACE FUNCTION odd_fn() RETURNS INT LANGUAGE sql AS $$ SELECT count(*)::int FROM verify_dispatches vd WHERE vd.dispatched_at > some_cutoff() $$;` }] };
  assert(hasProblem(allProblems(odd), "抽不出時限"), allProblems(odd).join("\n"));
});

Deno.test("C6 保留天數預設改小（14→7）、之後 UPDATE 成 8 天以下、CHECK 下限放寬：紅", () => {
  const small = mutateMig(REAL, PURGE_MIG, "DEFAULT 14 CHECK (verify_dispatches_days BETWEEN 8 AND 365)", "DEFAULT 7 CHECK (verify_dispatches_days BETWEEN 8 AND 365)");
  assert(hasProblem(allProblems(small), "verify_dispatches 保留 7 天"), allProblems(small).join("\n"));
  const later: Sources = { ...REAL, migs: [...REAL.migs, { name: "29991231000000_x.sql", sql: `UPDATE dispatch_records_settings SET verify_dispatches_days = 8, note = 'x' WHERE id = 1;` }] };
  // 8 天 = 192 小時 = 7 天 + 24 小時邊際：剛好夠，不紅；7 天才紅
  assertEquals(allProblems(later), []);
  const later7: Sources = { ...REAL, migs: [...REAL.migs, { name: "29991231000000_x.sql", sql: `UPDATE dispatch_records_settings SET verify_dispatches_days = 7 WHERE id = 1;` }] };
  assert(hasProblem(allProblems(later7), "verify_dispatches 保留 7 天"), allProblems(later7).join("\n"));
  const floor = mutateMig(REAL, PURGE_MIG, "DEFAULT 14 CHECK (verify_dispatches_days BETWEEN 8 AND 365)", "DEFAULT 14 CHECK (verify_dispatches_days BETWEEN 2 AND 365)");
  assert(hasProblem(allProblems(floor), "CHECK 下限"), allProblems(floor).join("\n"));
  // 註解裡的範例 UPDATE 不算（COMMENT 字串）：真的 migration 有一句 UPDATE … = 21 的說明
  assert(MIG_SQL.includes("verify_dispatches_days = 21"));
  assertEquals(retentionOf(REAL).retention?.days.verify_dispatches, 14);
});

Deno.test("C7 排程拿掉、改成每週、不呼叫清理函式、沒有 unschedule：紅", () => {
  const none = mutateMig(REAL, PURGE_MIG, "SELECT cron.schedule('dispatch-records-purge', '50 19 * * *', $$SELECT dispatch_records_purge();$$);", "-- 沒排程");
  assert(hasProblem(allProblems(none), "沒有 dispatch-records-purge 排程"), allProblems(none).join("\n"));
  const weekly = mutateMig(REAL, PURGE_MIG, "'50 19 * * *'", "'50 19 * * 6'");
  assert(hasProblem(allProblems(weekly), "不是每天一次"), allProblems(weekly).join("\n"));
  const wrongCall = mutateMig(REAL, PURGE_MIG, "$$SELECT dispatch_records_purge();$$", "$$SELECT 1;$$");
  assert(hasProblem(allProblems(wrongCall), "沒有呼叫"), allProblems(wrongCall).join("\n"));
  const noUn = mutateMig(REAL, PURGE_MIG, "SELECT cron.unschedule('dispatch-records-purge') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-records-purge');", "-- 沒有 unschedule");
  assert(hasProblem(allProblems(noUn), "unschedule"), allProblems(noUn).join("\n"));
});

Deno.test("C8 清理函式改壞：不看時間（全刪）、跳過紀錄全刪、停用不生效、不分批——行為層必須紅", async () => {
  const killAll = mutate(MIG_SQL, "WHERE dispatched_at < now() - make_interval(days => s.verify_dispatches_days)", "WHERE dispatched_at < now()");
  assert((await scenario(killAll)).length > 0, "verify_dispatches 不看保留期全刪，前後比對要紅");
  const killSkips = mutate(MIG_SQL, "WHERE skipped_at < now() - make_interval(days => s.task_skips_days)", "WHERE skipped_at < now() - interval '1 hour'");
  assert((await scenario(killSkips)).length > 0, "skips 保留期改壞，筆數檢查要紅");
  const keepAll = mutate(MIG_SQL, "WHERE dispatched_at < now() - make_interval(days => s.verify_dispatches_days)", "WHERE dispatched_at < now() - interval '1000 days'");
  assert((await scenario(keepAll)).length > 0, "什麼都不刪也要紅（不是空轉）");
  const ignoreEnabled = mutate(MIG_SQL, "IF NOT FOUND OR NOT s.enabled THEN", "IF NOT FOUND THEN");
  const db = await buildDb(ignoreEnabled);
  try {
    await db.exec(`INSERT INTO contributions (id, contributor_ip_hash) VALUES ('${uuid(1)}', 'o')`);
    await db.exec(`INSERT INTO verify_dispatches (contribution_id, ip_hash, dispatched_at) VALUES ('${uuid(1)}', 'A', now() - interval '40 days')`);
    await db.exec(`UPDATE dispatch_records_settings SET enabled = false WHERE id = 1`);
    await db.query(`SELECT dispatch_records_purge()`);
    assertEquals(Number((await q(db, `SELECT count(*) c FROM verify_dispatches`))[0].c), 0, "改壞的版本停用也會刪（證明 B3 的停用檢查看得出來）");
  } finally {
    await db.close();
  }
});
