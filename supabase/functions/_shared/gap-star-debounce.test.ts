/**
 * issue_too_broad 整臂事件 '*' 去抖守門（migration 20261127140000_itb_star_debounce.sql）。
 *
 * 實測（正式庫 2026-11-27）：近 24 小時 issue_too_broad 收到 109 筆 '*'，常駐表該臂只開 89／關 2，
 * 每小時整臂重算約 6 次、絕大多數結果不變，每次 gap_drain 約 37～72 秒。
 *
 * 用 PGlite 載入真的 dispatch_gap_enqueue（從遷移原文抽出）：
 *   A 重現：舊版（20261126170000）每次處理完就能再入 '*'（沒有去抖）
 *   B 30 分鐘內已有 '*'（未處理，或處理完在 30 分鐘內）→ 第二筆資料變動 '*' 不入列
 *   C 超過 30 分鐘（處理完在 30 分鐘前）會入列
 *   D 其他臂的 '*'、issue_too_broad 的按鍵事件、config／manual 類 '*' 不受影響
 *   E 遷移文字守門：時間戳、回滾段、呼叫量、行為變更段、只改這一支函式
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText } from "./arms-pglite.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const PR1 = await read("20261126170000_dispatch_gaps_phase0.sql");
const MIG_NAME = "20261127140000_itb_star_debounce.sql";
const MIG = await read(MIG_NAME);

const ENV = `
CREATE TABLE dispatch_gap_settings (id INTEGER PRIMARY KEY, events_enabled BOOLEAN NOT NULL DEFAULT true);
INSERT INTO dispatch_gap_settings VALUES (1, true);
CREATE TABLE dispatch_gap_events (
  id BIGSERIAL PRIMARY KEY, arm TEXT NOT NULL, scope_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (btrim(kind) <> ''),
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE UNIQUE INDEX dispatch_gap_events_pending_uidx ON dispatch_gap_events (arm, scope_key) WHERE processed_at IS NULL;
${fnText(PR1, "dispatch_gap_events_enabled")}
${fnText(PR1, "dispatch_gap_enqueue")}
`;

async function freshDb(fixed: boolean): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ENV);
  if (fixed) await db.exec(MIG);
  return db;
}
const enq = async (db: PGlite, arm: string, key: string, kind: string) =>
  (await db.query<{ v: boolean }>("SELECT dispatch_gap_enqueue($1, $2, $3) AS v", [arm, key, kind])).rows[0].v;
const count = async (db: PGlite, where = "true") =>
  (await db.query<{ v: number }>(`SELECT count(*)::int AS v FROM dispatch_gap_events WHERE ${where}`)).rows[0].v;
/** 把某臂的 '*' 事件標成「N 分鐘前處理完」 */
const processedAgo = (db: PGlite, arm: string, minutes: number) =>
  db.exec(`UPDATE dispatch_gap_events SET processed_at = now() - interval '${minutes} minutes' WHERE arm = '${arm}' AND scope_key = '*'`);

Deno.test("A 重現：舊版處理完立刻又能入 '*'（沒有去抖）", async () => {
  const db = await freshDb(false);
  assertEquals(await enq(db, "issue_too_broad", "*", "insert"), true);
  await processedAgo(db, "issue_too_broad", 1);
  assertEquals(await enq(db, "issue_too_broad", "*", "insert"), true, "舊版應該照入");
  assertEquals(await count(db, "arm = 'issue_too_broad'"), 2);
});

Deno.test("B 修後：30 分鐘內已有 '*'（未處理或剛處理完）不再入列", async () => {
  const db = await freshDb(true);
  assertEquals(await enq(db, "issue_too_broad", "*", "insert"), true, "第一筆入列");
  assertEquals(await enq(db, "issue_too_broad", "*", "update"), false, "未處理中不重複");
  await processedAgo(db, "issue_too_broad", 1);
  assertEquals(await enq(db, "issue_too_broad", "*", "insert"), false, "1 分鐘前處理完，窗內不入列");
  await processedAgo(db, "issue_too_broad", 29);
  assertEquals(await enq(db, "issue_too_broad", "*", "delete"), false, "29 分鐘前處理完，窗內不入列");
  assertEquals(await count(db, "arm = 'issue_too_broad'"), 1);
});

Deno.test("C 修後：處理完超過 30 分鐘會再入列", async () => {
  const db = await freshDb(true);
  assertEquals(await enq(db, "issue_too_broad", "*", "insert"), true);
  await processedAgo(db, "issue_too_broad", 31);
  assertEquals(await enq(db, "issue_too_broad", "*", "insert"), true, "31 分鐘前處理完，窗外要入列");
  assertEquals(await count(db, "arm = 'issue_too_broad' AND processed_at IS NULL"), 1);
});

Deno.test("D 修後：其他臂、按鍵事件、config／manual 類 '*' 不受影響", async () => {
  const db = await freshDb(true);
  assertEquals(await enq(db, "issue_too_broad", "*", "insert"), true);
  await processedAgo(db, "issue_too_broad", 1);
  // 其他臂的 '*' 照入，且不被 issue_too_broad 的窗影響
  assertEquals(await enq(db, "roster_villages", "*", "update"), true);
  await processedAgo(db, "roster_villages", 1);
  assertEquals(await enq(db, "roster_villages", "*", "update"), true, "其他臂沒有去抖");
  // issue_too_broad 的按鍵事件照入
  assertEquals(await enq(db, "issue_too_broad", "issue:2026:臺北市:交通", "update"), true);
  // 規則／設定變動（config、manual）要立刻反映，不去抖
  assertEquals(await enq(db, "issue_too_broad", "*", "config"), true);
  await processedAgo(db, "issue_too_broad", 1);
  assertEquals(await enq(db, "issue_too_broad", "*", "manual"), true);
  // 緊急開關仍有效
  await db.exec("UPDATE dispatch_gap_settings SET events_enabled = false");
  assertEquals(await enq(db, "legacy", "policy:p9", "insert"), false);
});

Deno.test("D2 去抖檢查用部分索引（不掃整張事件表）", async () => {
  const db = await freshDb(true);
  const r = await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'dispatch_gap_events_star_idx'");
  assertEquals(r.rows.length, 1);
  assert(/\(arm, processed_at DESC\) WHERE \(scope_key = '\*'::text\)/.test(r.rows[0].indexdef), r.rows[0].indexdef);
});

Deno.test("E 遷移文字守門", () => {
  const ts = MIG_NAME.slice(0, 14);
  assert(ts > "20261127130000", `時間戳要晚於 main 最新的 20261127130000：${ts}`);
  assert(/回滾/.test(MIG) && /20261126170000_dispatch_gaps_phase0\.sql/.test(MIG), "要寫回滾與前一版定義檔名");
  assert(/每日呼叫量變化：0/.test(MIG), "要寫每日呼叫量變化：0");
  assert(/行為變更/.test(MIG) && /計畫觀察/.test(MIG), "要有行為變更與計畫觀察段");
  const fns = [...MIG.matchAll(/CREATE OR REPLACE FUNCTION (\w+)/g)].map((m) => m[1]);
  assertEquals(fns, ["dispatch_gap_enqueue"], "只改入列函式這一支");
  // 去抖以外的本文與 20261126170000 的版本逐字相同
  const stripped = fnText(MIG, "dispatch_gap_enqueue").replace(/  -- >>> [\s\S]*?-- <<< 整臂事件去抖\n/, "");
  assertEquals(stripped, fnText(PR1, "dispatch_gap_enqueue"), "拿掉去抖區塊後要與前一版逐字相同");
});
