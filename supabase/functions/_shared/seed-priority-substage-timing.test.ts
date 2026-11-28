/**
 * seed priority 段細分計時（migration 20261128030000_seed_priority_substage_timing.sql，2026-11-28）守門。
 *
 * 這支只加量測，不改任何邏輯：seed 本體多幾行標「子段計時」的行，拿掉之後必須與前一版（20261128020000）逐行相同。
 *   A1 時間戳大於前一版、前一版 seed 定義是 20261128020000
 *   A2 seed 本體拿掉「子段計時」的行之後與前一版逐行相同（還原驗證：多一行、少一行、改一行都必須紅）
 *   A3 三個函式層級 SET 在、結尾自我檢查它們
 *   A4 新增的計時：stage 名稱與位置（流量、需求快照、需求疊加、派工列回寫），row_count 用 GET DIAGNOSTICS
 *   A5 開頭註解寫了為什麼、每日呼叫量變化、回滾
 *   A6 新 seed 函式在 PGlite 的 plpgsql 語法能建起來，三個 SET 真的記在函式上
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { migrationNames, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261128030000_seed_priority_substage_timing.sql";
const PREV_NAME = "20261128020000_seed_priority_cache.sql";
const MARK = "子段計時";
const MIG = await readMig(MIG_NAME);
const PREV = await readMig(PREV_NAME);

function seedBody(src: string): string {
  const start = src.lastIndexOf("FUNCTION seed_auto_task_queue()");
  assert(start >= 0, "找不到 seed_auto_task_queue 定義");
  const open = src.indexOf("$$", start);
  const close = src.indexOf("$$", open + 2);
  return src.slice(open + 2, close);
}

/** 拿掉標「子段計時」的行 */
const strip = (body: string) => body.split("\n").filter((l) => !l.includes(MARK)).join("\n");

Deno.test("A1 時間戳大於 20261128020000，前一版 seed 定義是 20261128020000", async () => {
  assert(MIG_NAME > PREV_NAME);
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION seed_auto_task_queue(")) defining.push(n);
  assertEquals(defining[defining.indexOf(MIG_NAME) - 1], PREV_NAME, "前一版變了：要以最新的為底重做");
});

Deno.test("A2 seed 本體：拿掉子段計時的行之後與前一版逐行相同（含還原驗證）", () => {
  const cur = seedBody(MIG);
  const old = seedBody(PREV);
  assertEquals(strip(cur), old);
  assert(cur.split("\n").some((l) => l.includes(MARK)), "新版一行子段計時都沒有");
  // 還原驗證：任何偷改邏輯或標記沒掛好的情況都必須讓比對變紅
  const sameAsOld = (b: string) => strip(b) === old;
  assert(sameAsOld(cur));
  assert(!sameAsOld(cur.replace("RETURN v_new + v_verify;", "RETURN v_new;")), "改了回傳值卻沒被抓到");
  assert(!sameAsOld(cur.replace("PERFORM refresh_dispatch_blocked();", "")), "少一句卻沒被抓到");
  assert(!sameAsOld(cur.replace("  PERFORM traffic_boost_apply();\n", "  PERFORM traffic_boost_apply();\n  PERFORM 1;\n")), "多一行卻沒被抓到");
  assert(!sameAsOld(cur.replace("FROM traffic_boost_settings s WHERE s.id = 1;", "FROM traffic_boost_settings s WHERE s.id = 2;")), "改條件卻沒被抓到");
  assert(!sameAsOld(cur.replace("  v_sn := 0;  -- 子段計時（20261128030000）\n", "  v_sn := 0;\n")), "標記掉了卻沒被抓到");
});

Deno.test("A3 seed 三個函式層級 SET 都在，而且本檔結尾自我檢查它們", () => {
  const head = MIG.slice(MIG.lastIndexOf("FUNCTION seed_auto_task_queue()"));
  const pre = head.slice(0, head.indexOf("$$"));
  assert(/SET statement_timeout = '280s'/.test(pre));
  assert(/SET work_mem = '16MB'/.test(pre));
  assert(/SET hash_mem_multiplier = '1'/.test(pre));
  assert(MIG.includes("seed 函式層級 SET 沒帶全"));
});

Deno.test("A4 新增的計時：四筆子段、三個 GET DIAGNOSTICS，位置在對的敘述旁邊", () => {
  const body = seedBody(MIG);
  const added = body.split("\n").filter((l) => l.includes(MARK));
  const stages = added.map((l) => /'stage:([a-z_]+)'/.exec(l)?.[1]).filter(Boolean);
  assertEquals(stages, ["priority_traffic", "priority_demand_refresh", "priority_demand", "priority_dispatch_write"]);
  assertEquals(added.filter((l) => l.includes("GET DIAGNOSTICS v_sn = ROW_COUNT;")).length, 3);
  // 流量秒數 UPDATE 緊接 GET DIAGNOSTICS 與計時
  assert(/FROM traffic_boost_settings s WHERE s\.id = 1;\n\s+GET DIAGNOSTICS v_sn = ROW_COUNT;[^\n]*\n\s+PERFORM seed_arm_timing_log\(v_run, 'stage:priority_traffic', v_s, v_sn\)/.test(body));
  // 需求快照：計時在 EXCEPTION 區塊的 END 之後
  assert(/RAISE WARNING 'work_card_demand_refresh：%', SQLERRM;[^\n]*\n\s+END;\n\s+PERFORM seed_arm_timing_log\(v_run, 'stage:priority_demand_refresh'/.test(body));
  // 需求疊加旗標關著時 row_count 是 0（v_sn 先歸零），開著時取 UPDATE 的列數
  assert(/v_sn := 0;[^\n]*\n\s+IF COALESCE\(\(SELECT q\.demand_enabled[\s\S]*?WHERE t\.task_id = g\.task_id;\n\s+GET DIAGNOSTICS v_sn = ROW_COUNT;[^\n]*\n\s+END IF;\n\s+PERFORM seed_arm_timing_log\(v_run, 'stage:priority_demand', v_s, v_sn\)/.test(body));
  // 派工列回寫：含 SKIP LOCKED 子查詢，計時在 UPDATE 之後、update_existing 計時之前
  assert(/FOR UPDATE OF d2 SKIP LOCKED\);\n\s+GET DIAGNOSTICS v_sn = ROW_COUNT;[^\n]*\n\s+PERFORM seed_arm_timing_log\(v_run, 'stage:priority_dispatch_write', v_s, v_sn\);[^\n]*\n\s+-- <<< 不等列鎖\n\s+-- <<< 優先秒數\n\s+PERFORM seed_arm_timing_log\(v_run, 'stage:update_existing'/.test(body));
  // 既有的整段與靜態部分計時仍在、沒被改
  assert(body.includes("PERFORM seed_arm_timing_log(v_run, 'stage:priority', v_t, NULL); v_t := clock_timestamp();"));
  assert(body.includes("PERFORM seed_arm_timing_log(v_run, 'stage:priority_static', v_t2, v_static);"));
});

Deno.test("A5 開頭註解寫了為什麼、每日呼叫量變化、回滾，沒有新排程或觸發器", () => {
  const head = MIG.slice(0, MIG.indexOf("CREATE OR REPLACE FUNCTION seed_auto_task_queue()"));
  for (const must of ["為什麼", "stage:priority_traffic", "stage:priority_demand_refresh", "stage:priority_demand", "stage:priority_dispatch_write", "stage:priority_static", "每日呼叫量變化：0", "回滾", PREV_NAME.slice(0, 14)]) {
    assert(head.includes(must), `註解缺「${must}」`);
  }
  const sql = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/cron\.schedule\(|CREATE TRIGGER|net\.http_/i.test(sql), "不新增排程、觸發器或對外呼叫");
  assert(!/CREATE (UNIQUE )?INDEX (?!ON _gaps_all)|CREATE TABLE|CREATE VIEW|CREATE OR REPLACE FUNCTION (?!seed_auto_task_queue\(\))/i.test(sql), "不新增表、索引、視圖或其他函式");
});

Deno.test("A6 新 seed 函式的 plpgsql 語法能建起來，三個函式層級 SET 真的記在函式上", async () => {
  const db = new PGlite();
  const start = MIG.indexOf("CREATE OR REPLACE FUNCTION seed_auto_task_queue()");
  const end = MIG.indexOf("DO $$", start);
  await db.exec(MIG.slice(start, end));
  const r = await db.query<{ c: string[] }>("SELECT proconfig AS c FROM pg_proc WHERE proname = 'seed_auto_task_queue'");
  const cfg = r.rows[0].c;
  for (const s of ["statement_timeout=280s", "work_mem=16MB", "hash_mem_multiplier=1"]) assert(cfg.includes(s), `缺 ${s}`);
});
