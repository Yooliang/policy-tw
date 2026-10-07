/**
 * 網站請求與公民提問排在所有加推之前，派出超過 6 小時還沒解決就回到最前面（2026-10-08 維護者）。
 *   「網站請求裡面的任務每 6 小時幫忙插隊一次，因為這個是有人在關注的東西」，公民提問一起照辦。
 *
 * 根因：手動任務的排隊位置是 manualQueueAt（沒派過的 web_request＝1980-01-01），但 task_boost 把加推的任務設成
 * 1980-01-01 減 n 分鐘，加推多了（2026-10-08 有 307 筆在 1979-12-31 之前）就排到網站請求前面。
 *
 *   A. 純函式：邊界（5h59m／6h01m／沒派過／已關閉）、公民提問與網站請求都適用、一般手動任務不變、與加推比先後
 *   B. 加推不會更早：task_boost 的公式（1980 減分鐘）釘住，1970 要 5,258,880 次加推才追得上
 *   C. 挑選：並列（都在最前）用 seed 散開、單一第一名不受 seed 影響；回到最前的任務仍要經過租約／回報查無／跳過／飽和／自己交的過濾
 *   D. /next 接線：另撈一份網站請求與公民提問的候選（20 筆窗口會被別的手動任務佔滿）、同一輪用同一個「現在」
 *   E. queue_preview（/queue 頁）的 SQL 跟 TS 同一條規則：文字層＝前一版加一處機械式替換；6 小時兩邊一致；PGlite 逐列對 manualQueueAt
 *
 * 只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。每條守門的還原驗證見 PR 說明（拿掉被守的東西確認會紅）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import {
  filterLeasedTasks,
  filterReportedDeadEnds,
  filterSaturatedTasks,
  filterSkippedTasks,
  isFrontQueueAt,
  isVisitorFacingTask,
  manualQueueAt,
  pickQueueHead,
  pickQueuedManual,
  QUEUE_FRONT,
  QUEUE_VISITOR_FRONT,
  VISITOR_REQUEUE_HOURS,
  VISITOR_REQUEUE_MS,
} from "./dispatch.ts";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const ago = (h: number, m = 0) => new Date(NOW - (h * 60 + m) * 60_000).toISOString();
const VISITOR_MS = Date.parse(QUEUE_VISITOR_FRONT);

// ============================================================
// A. 純函式
// ============================================================
Deno.test("A1 6 小時寫成具名常數", () => {
  assertEquals(VISITOR_REQUEUE_HOURS, 6);
  assertEquals(VISITOR_REQUEUE_MS, 6 * 3600_000);
});

Deno.test("A2 沒派過的網站請求＝最前（1970）；公民提問也是", () => {
  assertEquals(manualQueueAt({ source: "web_request", created_at: "2026-09-28T00:00:00Z" }, NOW), QUEUE_VISITOR_FRONT);
  assertEquals(manualQueueAt({ source: "web_request", last_dispatched_at: null, created_at: "2026-09-28T00:00:00Z" }, NOW), QUEUE_VISITOR_FRONT);
  // 公民提問：task_type=question（ask 建的任務 source 也是 web_request，但維護者手建的提問任務 source 不是，兩條路都要適用）
  assertEquals(manualQueueAt({ source: "manual", task_type: "question", created_at: "2026-09-28T00:00:00Z" }, NOW), QUEUE_VISITOR_FRONT);
  assertEquals(manualQueueAt({ source: "suggested", task_type: "question", created_at: "2026-09-28T00:00:00Z" }, NOW), QUEUE_VISITOR_FRONT);
  assertEquals(manualQueueAt({ source: "web_request", task_type: "question", created_at: "2026-09-28T00:00:00Z" }, NOW), QUEUE_VISITOR_FRONT);
});

Deno.test("A3 邊界：派出 5 小時 59 分＝照舊排在派出時間；6 小時 01 分＝回到最前", () => {
  for (const base of [{ source: "web_request" }, { source: "manual", task_type: "question" }]) {
    const young = ago(5, 59);
    assertEquals(manualQueueAt({ ...base, last_dispatched_at: young, created_at: "2026-09-28T00:00:00Z" }, NOW), young, JSON.stringify(base));
    assertEquals(manualQueueAt({ ...base, last_dispatched_at: ago(6, 1), created_at: "2026-09-28T00:00:00Z" }, NOW), QUEUE_VISITOR_FRONT, JSON.stringify(base));
  }
});

Deno.test("A4 邊界：剛好 6 小時還不算超過（超過才回到最前，SQL 同一條 <）", () => {
  const exactly = ago(6);
  assertEquals(manualQueueAt({ source: "web_request", last_dispatched_at: exactly }, NOW), exactly);
  assertEquals(manualQueueAt({ source: "web_request", last_dispatched_at: new Date(NOW - VISITOR_REQUEUE_MS - 1).toISOString() }, NOW), QUEUE_VISITOR_FRONT);
});

Deno.test("A5 已關閉的任務不插隊（回到最前只給還 open 的）", () => {
  const closed = { source: "web_request", status: "completed", last_dispatched_at: ago(7), created_at: "2026-09-28T00:00:00Z" };
  assertEquals(manualQueueAt(closed, NOW), ago(7));
  assertEquals(manualQueueAt({ ...closed, last_dispatched_at: null }, NOW), QUEUE_FRONT); // 沒有派出時間就走舊規則（web_request＝1980）
  assertEquals(manualQueueAt({ ...closed, status: "open" }, NOW), QUEUE_VISITOR_FRONT);
  // status 沒給＝當 open（撈手動任務本來就只撈 open）
  assertEquals(manualQueueAt({ source: "web_request", last_dispatched_at: ago(7) }, NOW), QUEUE_VISITOR_FRONT);
});

Deno.test("A6 一般手動任務行為不變：manual／auto_dispute 沒派過＝1980、派過＝派出時間（超過 6 小時也不回前）、suggested＝建立時間", () => {
  for (const source of ["manual", "auto_dispute"]) {
    assertEquals(manualQueueAt({ source, created_at: "2026-09-21T00:00:00Z" }, NOW), QUEUE_FRONT, source);
    assertEquals(manualQueueAt({ source, created_at: "2026-09-21T00:00:00Z", last_dispatched_at: ago(30) }, NOW), ago(30), source);
    assertEquals(manualQueueAt({ source, task_type: "politician_profile", last_dispatched_at: ago(7) }, NOW), ago(7), source);
  }
  assertEquals(manualQueueAt({ source: "suggested", created_at: "2026-09-21T00:00:00Z" }, NOW), "2026-09-21T00:00:00Z");
  assertEquals(manualQueueAt({ source: "suggested", task_type: "politician_profile", created_at: "2026-09-21T00:00:00Z", last_dispatched_at: ago(30) }, NOW), ago(30));
  assertEquals(manualQueueAt({ created_at: "2026-09-21T00:00:00Z" }, NOW), "2026-09-21T00:00:00Z");
});

Deno.test("A7 isVisitorFacingTask：只有 web_request 與 question", () => {
  assertEquals(isVisitorFacingTask({ source: "web_request" }), true);
  assertEquals(isVisitorFacingTask({ source: "manual", task_type: "question" }), true);
  for (const source of ["manual", "auto_dispute", "suggested", null, undefined]) assertEquals(isVisitorFacingTask({ source, task_type: "politician_profile" }), false, String(source));
});

Deno.test("A8 與加推比先後：1970 比任何加推（1980 減 n 分鐘）、比 1980 都早；6 小時內剛派過的不比加推早", () => {
  const boosted307 = new Date(Date.parse("1980-01-01T00:00:00Z") - 100_000 * 60_000).toISOString(); // 加推已經排到好幾千次
  assert(Date.parse(QUEUE_VISITOR_FRONT) < Date.parse(boosted307));
  assert(Date.parse(QUEUE_VISITOR_FRONT) < Date.parse(QUEUE_FRONT));
  assert(isFrontQueueAt(QUEUE_VISITOR_FRONT), "仍算插隊段（machineOwesVerifyDuringBoost 的 1:2 照樣適用）");
  // 派工合成佇列：網站請求（1970）贏過排在 1979-12-31 之前的自動缺口加推
  const head = pickQueueHead([
    { kind: "manual", queue_at: manualQueueAt({ source: "web_request", created_at: "2026-09-28T00:00:00Z" }, NOW) },
    { kind: "auto", queue_at: boosted307 },
    { kind: "verify", queue_at: "1979-12-31T23:00:00+00:00" },
  ]);
  assertEquals(head, "manual");
  // 剛派過（6 小時內）的網站請求回到隊尾，輸給加推
  const justDispatched = manualQueueAt({ source: "web_request", last_dispatched_at: ago(1) }, NOW);
  assertEquals(pickQueueHead([{ kind: "manual", queue_at: justDispatched }, { kind: "auto", queue_at: boosted307 }]), "auto");
  // 修之前：沒派過的 web_request 是 1980，輸給 1980 減分鐘的加推（這就是 307 筆加推把網站請求擠到後面的原因）
  assertEquals(pickQueueHead([{ kind: "manual", queue_at: QUEUE_FRONT }, { kind: "auto", queue_at: boosted307 }]), "auto");
});

// ============================================================
// B. 加推不會更早
// ============================================================
Deno.test("B1 task_boost 的公式是 1980-01-01 減 n 分鐘：要 5,258,880 次加推才會追到 1970（釘住公式，改了這裡就要重想）", async () => {
  const boost = await latestFn("task_boost");
  assert(boost.includes("v_at := TIMESTAMPTZ '1980-01-01' - (v_id * INTERVAL '1 minute');"), "task_boost 的 queue_at 公式變了：重新確認 QUEUE_VISITOR_FRONT 還在所有加推之前");
  const minutesTo1970 = (Date.parse("1980-01-01T00:00:00Z") - VISITOR_MS) / 60_000;
  assertEquals(minutesTo1970, 5_258_880);
  // 目前加推次數是三位數；就算每天加推一百次也要一百多年
  assert(minutesTo1970 / 100 / 365 > 100);
});

Deno.test("B2 其他寫 queue_at 的地方沒有比 1970 更早的哨兵", async () => {
  const names: string[] = [];
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) if (e.name.endsWith(".sql")) names.push(e.name);
  const early: string[] = [];
  for (const n of names.sort()) {
    const sql = await readMig(n);
    for (const m of sql.matchAll(/TIMESTAMPTZ\s+'(\d{4})-\d{2}-\d{2}/gi)) if (Number(m[1]) < 1970) early.push(`${n}:${m[0]}`);
  }
  assertEquals(early, []);
});

// ============================================================
// C. 挑選與過濾
// ============================================================
type T = { task_id: string; id: string; target?: unknown; source: string; task_type: string; status: string; last_dispatched_at: string | null; created_at: string };
const mk = (id: string, o: Partial<T> = {}): T => ({
  task_id: id, id, target: { politician_id: `p-${id}` }, source: "web_request", task_type: "politician_profile", status: "open",
  last_dispatched_at: null, created_at: "2026-09-28T00:00:00Z", ...o,
});

Deno.test("C1 pickQueuedManual：回到最前的網站請求贏過沒派過的 manual（1980）與 6 小時內剛派過的網站請求", () => {
  const picked = pickQueuedManual([
    mk("manual-new", { source: "manual" }),
    mk("fresh", { last_dispatched_at: ago(1) }),
    mk("stale", { last_dispatched_at: ago(7) }),
  ], "seed", NOW);
  assertEquals(picked?.id, "stale");
});

Deno.test("C2 pickQueuedManual：唯一的第一名不受 seed 影響", () => {
  const tasks = [mk("only", { source: "manual", task_type: "question" }), mk("m", { source: "manual" }), mk("s", { source: "suggested" })];
  for (const s of ["s1", "s2", "s3", "s4", "s5", "s6"]) assertEquals(pickQueuedManual(tasks, s, NOW)?.id, "only");
});

Deno.test("C3 pickQueuedManual：並列在最前（都是網站請求）用 seed 散開，且只在前 3 筆裡挑", () => {
  const tasks = ["a", "b", "c", "d", "e"].map((id) => mk(id));
  const seen = new Set(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((s) => pickQueuedManual(tasks, s, NOW)?.id));
  assert(seen.size > 1, "並列要散開");
  for (const id of seen) assert(["a", "b", "c"].includes(id!), `只能從前 3 筆挑：${id}`);
});

Deno.test("C4 時間用毫秒比、不是字串比：+00:00 與 Z 寫法不同也算同一刻", () => {
  const tied = pickQueuedManual([
    { id: "x", source: "manual", last_dispatched_at: "2026-10-08T01:00:00+00:00" },
    { id: "y", source: "manual", last_dispatched_at: "2026-10-08T01:00:00.000Z" },
  ], "seed", NOW);
  assert(tied !== null);
  assertEquals(pickQueuedManual([
    { id: "late", source: "suggested", created_at: "2026-10-08T01:00:00+00:00" },
    { id: "early", source: "suggested", created_at: "2026-10-08T00:00:00Z" },
  ], "seed", NOW)?.id, "early");
});

Deno.test("C5 回到最前的任務仍要經過租約／回報查無／跳過／飽和：過濾在選頭之前，被擋的不會被選中", () => {
  const stale = mk("stale", { last_dispatched_at: ago(7) });
  const rival = mk("rival", { last_dispatched_at: null, source: "web_request" });
  const other = mk("other", { source: "manual" });
  const pool = [stale, rival, other];
  const leases = [{ task_id: "stale", target_key: "politician:p-stale", agent_name: "someone-else", leased_until: "2999-01-01T00:00:00Z" }];
  const pickAfter = (filtered: T[]) => pickQueuedManual(filtered, "seed", NOW)?.id;
  // 租約：被別人領走的那筆被濾掉，剩下的並列第一是 rival（沒派過＝1970）
  const leased = filterLeasedTasks(pool, leases, "me");
  assert(!leased.some((t) => t.id === "stale"));
  assert(leased.some((t) => t.id === "rival"));
  // 自己的租約不擋
  assert(filterLeasedTasks(pool, [{ ...leases[0], agent_name: "me" }], "me").some((t) => t.id === "stale"));
  // 回報查無
  const dead = filterReportedDeadEnds(pool, new Set(["stale"]));
  assert(!dead.some((t) => t.id === "stale"));
  // 跳過
  const skipped = filterSkippedTasks(pool, new Set(["stale"]));
  assert(!skipped.some((t) => t.id === "stale"));
  // 飽和：在途貢獻已達上限
  const saturated = filterSaturatedTasks(pool, new Map([["stale", 99]]));
  assert(!saturated.some((t) => t.id === "stale"));
  // 全擋掉 stale 之後，挑的是剩下裡最前面的（rival 1970 贏 other 1980）
  assertEquals(pickAfter(skipped), "rival");
  assertEquals(pickAfter(dead), "rival");
  assertEquals(pickAfter(saturated), "rival");
  assertEquals(pickAfter(leased), "rival");
  // 沒有過濾時 stale、rival 並列最前，other（manual 1980）不會被挑到
  const picks = new Set(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((sd) => pickQueuedManual(pool, sd, NOW)?.id));
  for (const id of picks) assert(id === "stale" || id === "rival", `並列最前以外的不該被挑：${id}`);
});

// ============================================================
// D. /next 接線
// ============================================================
Deno.test("D1 /next：另撈網站請求與公民提問的候選、合併去重、同一輪用同一個現在", async () => {
  const src = (await Deno.readTextFile(new URL("../next/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  // 另撈一份：只撈 open 的 web_request／question，照派出時間由舊到新（沒派過的最前），有上限
  assert(/timed\("visitor",[\s\S]*?\.eq\("status", "open"\)[\s\S]*?\.or\("source\.eq\.web_request,task_type\.eq\.question"\)[\s\S]*?nullsFirst: true[\s\S]*?\.limit\(VISITOR_CANDIDATES\)/.test(src), "缺少網站請求／公民提問的候選查詢");
  assert(src.includes("visitorRes"), "visitorRes 要進解構");
  assert(/for \(const r of \[[^\]]*visitorRes[^\]]*\]\)\s*\{\s*if \(r\.error\)/.test(src), "visitorRes 失敗要跟其他查詢一樣丟錯");
  assert(src.includes("manualSeen"), "兩份候選要去重");
  // 同一輪一個 now
  assert(src.includes("const nowMs = Date.now();"));
  assert(src.includes("pickQueuedManual(freeManual, seed, nowMs)"));
  assertEquals(src.split("manualQueueAt(manualHead, nowMs)").length - 1, 2, "兩處 manualQueueAt 都要帶同一個 nowMs");
  assert(!/manualQueueAt\(manualHead\)/.test(src), "不能有沒帶 now 的 manualQueueAt 呼叫");
});

// ============================================================
// E. queue_preview（/queue 頁）
// ============================================================
const MIG = "20261008125000_queue_preview_visitor_front.sql";
const OLD_FRAG = `           COALESCE(t.last_dispatched_at,
                    CASE WHEN t.source IN ('manual', 'auto_dispute', 'web_request') THEN TIMESTAMPTZ '1980-01-01' ELSE t.created_at END), 1
`;
const NEW_FRAG = `           CASE WHEN (t.source = 'web_request' OR t.task_type = 'question')
                     AND (t.last_dispatched_at IS NULL OR t.last_dispatched_at < now() - INTERVAL '6 hours')
                THEN TIMESTAMPTZ '1970-01-01'
                ELSE COALESCE(t.last_dispatched_at,
                    CASE WHEN t.source IN ('manual', 'auto_dispute', 'web_request') THEN TIMESTAMPTZ '1980-01-01' ELSE t.created_at END)
           END, 1
`;
const mig = await readMig(MIG);
const newPreview = fnText(mig, "queue_preview");
const prevPreview = await latestFn("queue_preview", MIG);

Deno.test("E1 queue_preview 新定義＝前一版加一處機械式替換（其餘一字不差）", () => {
  assertEquals(mutate(prevPreview, OLD_FRAG, NEW_FRAG), newPreview);
});

Deno.test("E2 SQL 的 6 小時與 TS 的 VISITOR_REQUEUE_HOURS 一致、1970 與 QUEUE_VISITOR_FRONT 一致、SECURITY DEFINER 與授權照舊", () => {
  const m = /last_dispatched_at < now\(\) - INTERVAL '(\d+) hours'/.exec(newPreview);
  assert(m, "SQL 裡找不到 6 小時的條件");
  assertEquals(Number(m![1]), VISITOR_REQUEUE_HOURS);
  assert(newPreview.includes(`TIMESTAMPTZ '${QUEUE_VISITOR_FRONT.slice(0, 10)}'`));
  assert(newPreview.includes("SECURITY DEFINER SET search_path = public"));
  assert(mig.includes("GRANT EXECUTE ON FUNCTION queue_preview(INTEGER) TO anon, authenticated;"));
  assert(mig.includes("REVOKE ALL ON FUNCTION queue_preview(INTEGER) FROM public;"));
});

Deno.test("E3 PGlite：SQL 的手動任務 queue_at 逐列等於 TS 的 manualQueueAt（含 5h59m／6h01m 邊界、公民提問、已派過的一般任務）", async () => {
  const exprMatch = /SELECT 'task', t\.id::TEXT, t\.task_type, t\.title, t\.region,\n([\s\S]*?), 1\n      FROM contribution_tasks t/.exec(newPreview);
  assert(exprMatch, "找不到手動任務分支的 queue_at 運算式");
  const nowLit = `TIMESTAMPTZ '${new Date(NOW).toISOString()}'`;
  const expr = exprMatch![1].replaceAll("now()", nowLit);
  assert(!expr.includes("now()"));
  const rows: Array<Pick<T, "source" | "task_type" | "last_dispatched_at" | "created_at">> = [];
  const sources = ["web_request", "manual", "auto_dispute", "suggested"];
  const types = ["question", "politician_profile"];
  const dispatched = [null, ago(0, 5), ago(5, 59), ago(6, 1), ago(30)];
  for (const source of sources) for (const task_type of types) for (const last_dispatched_at of dispatched) rows.push({ source, task_type, last_dispatched_at, created_at: "2026-09-21T00:00:00Z" });
  const q = (v: string | null) => (v === null ? "NULL::timestamptz" : `TIMESTAMPTZ '${v}'`);
  const db = new PGlite();
  try {
    const values = rows.map((r, i) => `(${i}, '${r.source}', '${r.task_type}', ${q(r.last_dispatched_at)}, ${q(r.created_at)})`).join(",\n");
    const res = await db.query<{ i: number; q: string }>(
      `SELECT t.i, to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS q FROM (VALUES ${values}) AS t(i, source, task_type, last_dispatched_at, created_at) ORDER BY t.i`,
    );
    assertEquals(res.rows.length, rows.length);
    for (const r of res.rows) {
      const row = rows[r.i];
      const ts = new Date(manualQueueAt({ ...row, status: "open" }, NOW)).toISOString().slice(0, 19);
      assertEquals(r.q, ts, JSON.stringify(row));
    }
  } finally {
    await db.close();
  }
});
