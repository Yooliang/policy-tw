/**
 * work_card_demand_refresh() 集合運算化（migration 20261128050000_demand_refresh_incremental.sql，2026-11-28）守門。
 *
 * 背景：seed priority 段裡 work_card_demand_refresh 佔 8.5～11.3 秒，原因是對每張卡各呼叫一次 work_card_demand_seconds，
 * 其中單卡的 work_key_ladder_state 逐筆查核呼叫 task_check_cooldown_days_for。新版整批聚合，只對「單位數＞0 且減半未到上限」的卡算一次階梯。
 *
 *   A. 文字層：時間戳與前一版、新階梯函式與集合版只差過濾、不加觸發器／排程／表／索引、需求秒數函式不動
 *   B. PGlite 並排：前一版（20261114030000）refresh 以 _legacy 裝進同一個資料庫當 oracle，同一組事件序列後快照表雙向差集 0
 *      （新請求、同一件多人請求、請求關閉、工作卡換號、減半、冷卻中、階梯結案、公報前查無、訊號過期、什麼都不變連兩輪、隨機 60 張卡）
 *   C. 階梯函式 work_key_ladder_states_for 與集合版 work_key_ladder_states 逐欄相同（含公報截止時間）
 *   D. 真的只對需要的卡算階梯（用 spy 記下傳進去的鍵）
 *   E. 還原驗證：拿掉冷卻防線、拿掉建立者補算、讓階梯一張都不查，各自必須讓並排比對變紅
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261128050000_demand_refresh_incremental.sql";
const PREV_NAME = "20261114030000_demand_counts_request_creator.sql";
const BASE_NAME = "20261112070000_work_card_demand.sql";
const LADDER_NAME = "20261118110000_ladder_ignore_prebulletin_v2.sql";
const MIG = await readMig(MIG_NAME);
const PREV = await readMig(PREV_NAME);
const BASE = await readMig(BASE_NAME);
const LADDER = await readMig(LADDER_NAME);
const DAY = 86400;
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 時間戳大於前一版；work_card_demand_refresh 的前一版定義是 20261114030000，需求秒數函式沒被重新定義", async () => {
  assert(MIG_NAME > PREV_NAME);
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION work_card_demand_refresh(")) defining.push(n);
  assertEquals(defining[defining.indexOf(MIG_NAME) - 1], PREV_NAME, "前一版變了：要以最新的為底重做");
  assert(!MIG.includes("CREATE OR REPLACE FUNCTION work_card_demand_seconds("), "單卡需求函式一字不動（預覽視圖與單卡路徑還用它）");
  assertEquals(defining.length, 3, "只有 20261112070000、20261114030000 與本支定義過 refresh");
});

Deno.test("A2 work_key_ladder_states_for 與集合版 work_key_ladder_states 只差過濾（拿掉公報截止段、WHERE 與標頭後逐行相同）", () => {
  const norm = (t: string) =>
    code(t)
      .replace(/cuts AS MATERIALIZED \([\s\S]*?\n  \), t AS MATERIALIZED/, "cuts AS MATERIALIZED (X\n  ), t AS MATERIALIZED")
      .replace("WHERE tc.work_key IS NOT NULL", "WHERE tc.work_key = ANY (p_keys)")
      .replace("CREATE OR REPLACE FUNCTION work_key_ladder_states_for(p_keys TEXT[])", "CREATE OR REPLACE FUNCTION work_key_ladder_states()")
      .replace(/COMMENT ON FUNCTION[\s\S]*$/, "")
      .replace(/\s+/g, " ").trim();
  const full = fnText(LADDER, "work_key_ladder_states");
  const mine = fnText(MIG, "work_key_ladder_states_for");
  assertEquals(norm(mine), norm(full));
  // 還原驗證：集合版偷改一個條件，比對必須變紅
  assertNotEquals(norm(mine), norm(full.replace("n.cnt_nf >= 2", "n.cnt_nf >= 3")));
  assert(mine.includes("tc.work_key = ANY (p_keys)") && mine.includes("pe.politician_id IN (SELECT uuid_or_null"));
  assert(!code(mine).includes("task_prebulletin_cutoffs()"),"公報截止時間限這幾張卡的候選人，不整表算");
});

Deno.test("A3 不新增觸發器、排程、表、索引、對外呼叫；兩支新／改的函式都撤 PUBLIC／anon／authenticated；開頭註解齊全", () => {
  const sql = code(MIG);
  assert(!/cron\.schedule\(|CREATE TRIGGER|net\.http_|CREATE (UNIQUE )?INDEX|CREATE TABLE|CREATE VIEW|DROP /i.test(sql));
  assert(sql.includes("REVOKE ALL ON FUNCTION work_key_ladder_states_for(TEXT[]) FROM PUBLIC, anon, authenticated;"));
  assert(sql.includes("REVOKE ALL ON FUNCTION work_card_demand_refresh() FROM PUBLIC, anon, authenticated;"));
  const head = MIG.slice(0, MIG.indexOf("CREATE OR REPLACE FUNCTION"));
  for (const must of ["為什麼", "判讀", "做法", "預估", "每日呼叫量變化：0", "回滾", PREV_NAME.slice(0, 14), "8.5～11"]) assert(head.includes(must), `註解缺「${must}」`);
  const def = fnText(MIG, "work_card_demand_refresh");
  assert(def.includes("RETURNS INTEGER") && def.includes("SECURITY DEFINER SET search_path = public"), "簽名與安全屬性不變");
  assert(!def.includes("work_card_demand_seconds("), "refresh 不再逐卡呼叫單卡函式");
  assert(!def.includes("work_key_ladder_state("), "refresh 不再逐卡呼叫單卡階梯");
});

// ============================================================
// B. PGlite 環境：真的階梯函式（20261118110000 版）＋前一版 refresh 當 oracle
// ============================================================
const cols = /ALTER TABLE queue_settings[\s\S]*?;\n/.exec(BASE)![0];
const tables = /CREATE TABLE IF NOT EXISTS work_card_signals[\s\S]*?\n\);\nCREATE INDEX[^\n]*\n/.exec(BASE)![0] +
  /CREATE TABLE IF NOT EXISTS work_cards[\s\S]*?\n\);\n/.exec(BASE)![0];

interface Opt { refreshSql?: string; spy?: boolean }

async function buildDb(opt: Opt = {}): Promise<PGlite> {
  const db = new PGlite();
  const before = (n: string) => latestFn(n, MIG_NAME);
  const real = fnText(MIG, "work_key_ladder_states_for");
  const forSql = opt.spy
    ? real.replace("work_key_ladder_states_for(", "work_key_ladder_states_for_real(") + `
CREATE TABLE _spy (keys text[]);
CREATE FUNCTION work_key_ladder_states_for(p_keys TEXT[])
RETURNS TABLE (work_key TEXT, checks BIGINT, closed BOOLEAN, closed_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, cool_until TIMESTAMPTZ, check_cool_until TIMESTAMPTZ)
LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO _spy VALUES (p_keys);
  RETURN QUERY SELECT r.* FROM work_key_ladder_states_for_real(p_keys) r;
END
$f$;`
    : real;
  await db.exec(`
    CREATE TABLE task_check_ladder_settings (outcome text PRIMARY KEY, days integer[] NOT NULL);
    INSERT INTO task_check_ladder_settings VALUES ('not_found', ARRAY[5, 10, 20]), ('confirmed', ARRAY[5, 10]);
    CREATE TABLE task_cooldown_settings (id smallint PRIMARY KEY, enabled boolean NOT NULL DEFAULT true, not_found_first_days integer NOT NULL DEFAULT 14,
      not_found_repeat_days integer NOT NULL DEFAULT 30, task_types text[] NOT NULL DEFAULT ARRAY['progress_stale', 'deadline_due']);
    INSERT INTO task_cooldown_settings (id) VALUES (1);
    CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text NOT NULL, outcome text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), work_key text);
    CREATE TABLE politicians (id uuid PRIMARY KEY, merged_into uuid);
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE politician_elections (politician_id uuid, election_id integer, election_type text, region_id integer, candidacy_status text);
    CREATE TABLE election_bulletins (election_id integer, election_type text, region text, sub_region text NOT NULL DEFAULT '', village text NOT NULL DEFAULT '', listed_on date NOT NULL);
    CREATE TABLE queue_settings (id smallint PRIMARY KEY);
    INSERT INTO queue_settings (id) VALUES (1);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, work_key text, dispatch_count integer NOT NULL DEFAULT 0, priority_seconds integer NOT NULL DEFAULT 0);
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, status text NOT NULL DEFAULT 'open',
      requester_ip_hash text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION task_work_key(a text, b jsonb) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
    ${await before("uuid_or_null")}
    ${await before("task_check_cooldown_days")}
    ${await before("task_unreachable_cooldown_days")}
    ${await before("task_not_found_cooldown_days")}
    ${await before("task_check_ladder_days")}
    ${await before("task_check_ladder_exempt")}
    ${await before("task_cooldown_max_days")}
    ${fnText(LADDER, "task_prebulletin_cutoffs")}
    ${fnText(LADDER, "task_check_prebulletin_cutoff")}
    ${fnText(LADDER, "task_check_cooldown_days_for")}
    ${fnText(LADDER, "work_key_ladder_state")}
    ${fnText(LADDER, "work_key_ladder_states")}
  `);
  await db.exec(cols);
  await db.exec(tables);
  await db.exec(fnText(BASE, "work_card_signal_add"));
  // oracle：前一版（20261114030000）的需求秒數與逐卡 refresh
  await db.exec(fnText(PREV, "work_card_demand_seconds"));
  await db.exec(fnText(PREV, "work_card_demand_refresh").replace("work_card_demand_refresh()", "work_card_demand_refresh_legacy()"));
  await db.exec(forSql);
  await db.exec(opt.refreshSql ?? fnText(MIG, "work_card_demand_refresh"));
  return db;
}

type Row = { work_key: string; d: string };
const snapshot = async (db: PGlite): Promise<Row[]> =>
  (await db.query<Row>("SELECT work_key, demand_seconds::text AS d FROM work_cards ORDER BY work_key")).rows;

/** 同一份起始快照分別跑前一版與新版，回傳不一致的數目（列內容＋回傳的回寫列數）；新版連跑第二次必須 0 變動 */
async function compare(db: PGlite): Promise<{ mismatch: number; rows: Row[]; changed: number }> {
  await db.exec("DROP TABLE IF EXISTS _pre; CREATE TABLE _pre AS SELECT * FROM work_cards");
  const ln = (await db.query<{ n: number }>("SELECT work_card_demand_refresh_legacy() AS n")).rows[0].n;
  const L = await snapshot(db);
  await db.exec("DELETE FROM work_cards; INSERT INTO work_cards SELECT * FROM _pre");
  const nn = (await db.query<{ n: number }>("SELECT work_card_demand_refresh() AS n")).rows[0].n;
  const N = await snapshot(db);
  const again = (await db.query<{ n: number }>("SELECT work_card_demand_refresh() AS n")).rows[0].n;
  let mismatch = 0;
  if (JSON.stringify(L) !== JSON.stringify(N)) mismatch++;
  if (ln !== nn) mismatch++;
  if (again !== 0) mismatch++;
  return { mismatch, rows: N, changed: nn };
}

const WK = (c: string) => `card:${c}`;
const sig = (db: PGlite, c: string, kind: string, actor: string, daysAgo = 0) =>
  db.exec(`INSERT INTO work_card_signals (work_key, kind, actor, created_at) VALUES ('${WK(c)}', '${kind}', '${actor}', now() - interval '${daysAgo} days')`);
const webTask = async (db: PGlite, c: string, ip: string, status = "open", source = "web_request", daysAgo = 0) => {
  const id = crypto.randomUUID();
  await db.exec(`INSERT INTO contribution_tasks (id, source, status, requester_ip_hash, created_at) VALUES ('${id}', '${source}', '${status}', '${ip}', now() - interval '${daysAgo} days')`);
  await db.exec(`INSERT INTO task_dispatches (task_id, work_key) VALUES ('${id}', '${WK(c)}')`);
};
const check = (db: PGlite, c: string, outcome: string, daysAgo: number, taskId = `auto:policy_missing:${c}`) =>
  db.exec(`INSERT INTO task_checks (task_id, outcome, checked_at, work_key) VALUES ('${taskId}', '${outcome}', now() - interval '${daysAgo} days', '${WK(c)}')`);
const demandOf = (rows: Row[], c: string): number => Number(rows.find((r) => r.work_key === WK(c))?.d ?? NaN);

/** 逐步造事件、每步並排比對；回傳總不一致數與最後快照 */
async function scenario(db: PGlite): Promise<{ mismatch: number; rows: Row[] }> {
  let mismatch = 0;
  const step = async () => { const r = await compare(db); mismatch += r.mismatch; return r; };
  await step(); // 空庫
  await webTask(db, "new", "ipA"); await step();                                   // 新請求（只有建立者）
  await webTask(db, "two", "ipA"); await sig(db, "two", "request", "ipB"); await step(); // 同一件多人請求
  await sig(db, "two", "request", "ipA"); await step();                               // 建立者再按：不重複補算
  await webTask(db, "dup", "ipA"); await sig(db, "dup", "request", "ipA"); await step();
  await webTask(db, "closed", "ipA", "done"); await webTask(db, "manual", "ipA", "open", "manual"); await webTask(db, "stale", "ipA", "open", "web_request", 31); await step();
  for (let i = 1; i <= 12; i++) await sig(db, "views", "view", `v${i}`); await step(); // 頁面項
  for (let i = 0; i < 20; i++) await sig(db, "cap", "request", `a${i}`); await step();  // 上限
  // 查核階梯
  await sig(db, "cool", "request", "x1"); await sig(db, "cool", "request", "x2"); await check(db, "cool", "not_found", 1); await step(); // 冷卻中
  await sig(db, "closed2", "request", "x1"); await sig(db, "closed2", "request", "x2");
  for (const d of [40, 39, 38, 37]) await check(db, "closed2", "not_found", d); await step();                                            // 階梯結案
  await sig(db, "old", "request", "x1"); await sig(db, "old", "request", "x2"); await check(db, "old", "not_found", 40); await step();     // 舊查核不擋
  await sig(db, "exempt", "request", "x1"); await check(db, "exempt", "not_found", 1, "auto:progress_stale:exempt"); await step();        // 例外任務（不套階梯）
  await sig(db, "unreach", "request", "x1"); await check(db, "unreach", "unreachable", 1); await step();
  // 減半
  for (const [c, n] of [["h3", 3], ["h6", 6], ["h7", 7]] as const) {
    await sig(db, c, "request", "x1"); await sig(db, c, "request", "x2");
    await db.exec(`INSERT INTO work_cards (work_key, no_output_dispatches) VALUES ('${WK(c)}', ${n}) ON CONFLICT (work_key) DO UPDATE SET no_output_dispatches = ${n}`);
  }
  await step();
  // 工作卡換號：派工列換成別的 work_key；原卡留著快照
  await db.exec(`UPDATE task_dispatches SET work_key = '${WK("moved")}' WHERE work_key = '${WK("new")}'`); await step();
  // 訊號過期但快照還有舊值
  await sig(db, "expired", "request", "x1", 31);
  await db.exec(`INSERT INTO work_cards (work_key, demand_seconds) VALUES ('${WK("expired")}', 500)`); await step();
  // 補政見卡＋公報截止時間：公報前的查無不計
  const pid = "11111111-1111-4111-8111-111111111111";
  await db.exec(`INSERT INTO politicians (id) VALUES ('${pid}');
    INSERT INTO regions (id, region) VALUES (1, '某縣');
    INSERT INTO politician_elections VALUES ('${pid}', 2026, '縣市長', 1, 'filed');
    INSERT INTO election_bulletins (election_id, election_type, region, listed_on) VALUES (2026, '縣市長', '某縣', (now() - interval '10 days')::date)`);
  const pk = `politician:${pid}:policies:2026`;
  await db.exec(`INSERT INTO work_card_signals (work_key, kind, actor) VALUES ('${pk}', 'request', 'x1'), ('${pk}', 'request', 'x2')`);
  await db.exec(`INSERT INTO task_checks (task_id, outcome, checked_at, work_key) VALUES ('auto:policy_missing:p', 'not_found', now() - interval '12 days', '${pk}')`); await step(); // 公報前：不擋
  await db.exec(`INSERT INTO task_checks (task_id, outcome, checked_at, work_key) VALUES ('auto:policy_missing:p', 'not_found', now() - interval '1 days', '${pk}')`); await step();  // 公報後：冷卻
  // 什麼都不變連兩輪、再改一個旗標值後仍一致
  await step(); await step();
  await db.exec("UPDATE queue_settings SET demand_unit_seconds = 100000, demand_cap_seconds = 500000, demand_view_unit = 3"); await step();
  await db.exec("UPDATE queue_settings SET demand_signal_days = 2"); await step();
  return { mismatch, rows: await snapshot(db) };
}

Deno.test("B1 事件序列：新版與前一版快照逐列相同，回寫列數相同，連跑第二輪 0 變動；每個分支都有被覆蓋到", async () => {
  const db = await buildDb();
  const { mismatch } = await scenario(db);
  assertEquals(mismatch, 0);
  await db.close();
  // 覆蓋檢查：換一份新庫只做到「不縮短訊號期限」那一步之前，看各卡的預期值
  const db2 = await buildDb();
  const first = await (async () => {
    // 與 scenario 前半相同的資料，再取快照值（不縮短 demand_signal_days）
    await webTask(db2, "new", "ipA"); await webTask(db2, "two", "ipA"); await sig(db2, "two", "request", "ipB");
    await webTask(db2, "dup", "ipA"); await sig(db2, "dup", "request", "ipA");
    for (let i = 1; i <= 12; i++) await sig(db2, "views", "view", `v${i}`);
    for (let i = 0; i < 20; i++) await sig(db2, "cap", "request", `a${i}`);
    await sig(db2, "cool", "request", "x1"); await sig(db2, "cool", "request", "x2"); await check(db2, "cool", "not_found", 1);
    await sig(db2, "closed2", "request", "x1"); await sig(db2, "closed2", "request", "x2");
    for (const d of [40, 39, 38, 37]) await check(db2, "closed2", "not_found", d);
    await sig(db2, "old", "request", "x1"); await sig(db2, "old", "request", "x2"); await check(db2, "old", "not_found", 40);
    await sig(db2, "h3", "request", "x1"); await sig(db2, "h3", "request", "x2");
    await db2.exec(`INSERT INTO work_cards (work_key, no_output_dispatches) VALUES ('${WK("h3")}', 3)`);
    await sig(db2, "h6", "request", "x1"); await db2.exec(`INSERT INTO work_cards (work_key, no_output_dispatches) VALUES ('${WK("h6")}', 6)`);
    await db2.exec("SELECT work_card_demand_refresh()");
    return await snapshot(db2);
  })();
  assertEquals(demandOf(first, "new"), 1 * 2 * DAY, "只有建立者 1 單位");
  assertEquals(demandOf(first, "two"), 2 * 2 * DAY, "A 建立、B 請求 2 單位");
  assertEquals(demandOf(first, "dup"), 1 * 2 * DAY, "建立者自己也寫了訊號不重複算");
  assertEquals(demandOf(first, "views"), 1 * 2 * DAY, "頁面項 12/5-1＝1");
  assertEquals(demandOf(first, "cap"), 14 * DAY, "上限 14 天");
  assertEquals(demandOf(first, "cool"), 0, "冷卻中不疊");
  assertEquals(demandOf(first, "closed2"), 0, "階梯結案不疊");
  assertEquals(demandOf(first, "old"), 2 * 2 * DAY, "舊查核已過冷卻不擋");
  assertEquals(demandOf(first, "h3"), Math.floor((2 * 2 * DAY) / 8), "減半 3 次");
  assertEquals(demandOf(first, "h6"), 0, "減半到上限視同 0");
  assert(first.every((r) => r.work_key !== WK("closed") && r.work_key !== WK("manual") && r.work_key !== WK("stale")), "關閉的、非網站請求的、過期的建立者沒有進卡清單");
  await db2.close();
});

Deno.test("B2 隨機 60 張卡（訊號、建立者、查核、減半、補政見卡與公報截止時間混合）：新版與前一版逐列相同", async () => {
  const db = await buildDb();
  let s = 1128;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const int = (n: number) => Math.floor(rnd() * n);
  const kinds = ["request", "request", "view", "suggest", "roster"];
  const outcomes = ["not_found", "not_found", "not_found", "confirmed", "unreachable", "other"];
  const pids = Array.from({ length: 6 }, (_, i) => `2222222${i}-1111-4111-8111-11111111111${i}`);
  for (const [i, p] of pids.entries()) {
    await db.exec(`INSERT INTO politicians (id) VALUES ('${p}'); INSERT INTO regions (id, region) VALUES (${100 + i}, 'r${i}');
      INSERT INTO politician_elections VALUES ('${p}', 2026, '縣市長', ${100 + i}, 'filed');
      INSERT INTO election_bulletins (election_id, election_type, region, listed_on) VALUES (2026, '縣市長', 'r${i}', (now() - interval '${5 + int(20)} days')::date)`);
  }
  for (let i = 0; i < 60; i++) {
    const isPol = i % 4 === 0;
    const c = isPol ? `politician:${pids[(i / 4) % pids.length | 0]}:policies:2026` : WK(`r${i}`);
    for (let k = 0; k < int(8); k++) {
      await db.query("INSERT INTO work_card_signals (work_key, kind, actor, created_at) VALUES ($1, $2, $3, now() - ($4 || ' days')::interval) ON CONFLICT DO NOTHING",
        [c, kinds[int(kinds.length)], `a${int(30)}`, String(rnd() < 0.2 ? 31 + int(10) : int(25))]);
    }
    for (let k = 0; k < int(7); k++) {
      await db.query("INSERT INTO task_checks (task_id, outcome, checked_at, work_key) VALUES ($1, $2, now() - ($3 || ' days')::interval, $4)",
        [rnd() < 0.15 ? `auto:progress_stale:${i}` : `auto:policy_missing:${i}`, outcomes[int(outcomes.length)], String(rnd() < 0.3 ? 31 + int(40) : int(28)), c]);
    }
    if (rnd() < 0.3) {
      const id = crypto.randomUUID();
      await db.query("INSERT INTO contribution_tasks (id, source, status, requester_ip_hash, created_at) VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval)",
        [id, rnd() < 0.8 ? "web_request" : "manual", rnd() < 0.8 ? "open" : "done", `a${int(30)}`, String(int(35))]);
      await db.query("INSERT INTO task_dispatches (task_id, work_key) VALUES ($1, $2)", [id, c]);
    }
    if (rnd() < 0.25) await db.query("INSERT INTO work_cards (work_key, no_output_dispatches, demand_seconds) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [c, int(9), int(2) * 1000]);
  }
  const r = await compare(db);
  assertEquals(r.mismatch, 0);
  const nonzero = r.rows.filter((x) => Number(x.d) > 0).length;
  const zero = r.rows.filter((x) => Number(x.d) === 0).length;
  assert(nonzero >= 10 && zero >= 10, `資料沒有覆蓋到兩邊（正 ${nonzero}、零 ${zero}）`);
  assert((await db.query("SELECT 1 FROM work_key_ladder_states() WHERE closed")).rows.length >= 2, "沒有覆蓋到階梯結案");
  await db.close();
});

// ============================================================
// C. 階梯函式 work_key_ladder_states_for ＝ 集合版
// ============================================================
Deno.test("C1 work_key_ladder_states_for 對任何子集都與 work_key_ladder_states 逐欄相同（含公報截止時間；沒有查核的卡不出列）", async () => {
  const db = await buildDb();
  const pid = "33333333-1111-4111-8111-111111111111";
  await db.exec(`INSERT INTO politicians (id) VALUES ('${pid}'); INSERT INTO regions (id, region) VALUES (1, '某縣');
    INSERT INTO politician_elections VALUES ('${pid}', 2026, '縣市長', 1, 'filed');
    INSERT INTO election_bulletins (election_id, election_type, region, listed_on) VALUES (2026, '縣市長', '某縣', (now() - interval '10 days')::date)`);
  const pk = `politician:${pid}:policies:2026`;
  await db.exec(`INSERT INTO task_checks (task_id, outcome, checked_at, work_key) VALUES
    ('auto:policy_missing:p', 'not_found', now() - interval '12 days', '${pk}'), ('auto:policy_missing:p', 'not_found', now() - interval '2 days', '${pk}')`);
  for (let i = 0; i < 25; i++) {
    for (let k = 0; k <= i % 6; k++) await check(db, `c${i}`, ["not_found", "confirmed", "unreachable"][k % 3], 1 + ((i * 7 + k * 5) % 45), `auto:policy_missing:c${i}`);
  }
  const all = (await db.query<{ k: string }>("SELECT DISTINCT work_key AS k FROM task_checks")).rows.map((r) => r.k);
  const cols = "work_key, checks, closed, closed_at, last_checked_at, cool_until, check_cool_until";
  const subsets: string[][] = [all, all.filter((_, i) => i % 3 === 0), [pk], [pk, "card:nobody"], []];
  for (const sub of subsets) {
    const arr = `ARRAY[${sub.map((k) => `'${k}'`).join(",")}]::text[]`;
    const mine = `SELECT ${cols} FROM work_key_ladder_states_for(${arr})`;
    const full = `SELECT ${cols} FROM work_key_ladder_states() WHERE work_key = ANY (${arr})`;
    assertEquals((await db.query(`${mine} EXCEPT ${full}`)).rows, [], "子集版有、集合版沒有或不同");
    assertEquals((await db.query(`${full} EXCEPT ${mine}`)).rows, [], "集合版有、子集版沒有或不同");
  }
  // 公報截止時間真的有作用：公報前 12 天前的那一筆查無不計，所以只剩 1 筆
  assertEquals(Number((await db.query<{ c: string }>(`SELECT checks::text AS c FROM work_key_ladder_states_for(ARRAY['${pk}'])`)).rows[0].c), 1);
  // 對照單卡版
  const one = (await db.query(`SELECT checks, closed, closed_at, last_checked_at, cool_until, check_cool_until FROM work_key_ladder_state('${pk}')`)).rows;
  const set = (await db.query(`SELECT checks, closed, closed_at, last_checked_at, cool_until, check_cool_until FROM work_key_ladder_states_for(ARRAY['${pk}'])`)).rows;
  assertEquals(set, one);
  await db.close();
});

// ============================================================
// D. 只對需要的卡算階梯
// ============================================================
Deno.test("D1 階梯只對「單位數＞0 且減半未到上限」的卡算，而且整輪只呼叫一次", async () => {
  const db = await buildDb({ spy: true });
  await sig(db, "pos", "request", "x1");                  // 單位數 1 → 要看
  await sig(db, "viewsonly", "view", "v1");               // 只有 1 個瀏覽者：單位數 max(0, 0-1)＝0 → 不看
  await sig(db, "halved", "request", "x1");               // 減半到上限 → 不看
  await db.exec(`INSERT INTO work_cards (work_key, no_output_dispatches) VALUES ('${WK("halved")}', 6)`);
  await db.exec(`INSERT INTO work_cards (work_key, demand_seconds) VALUES ('${WK("zeroed")}', 900)`); // 快照有舊值、已無訊號 → 單位數 0 → 不看，回寫 0
  await webTask(db, "creator", "ipA");                    // 只有建立者 → 要看
  const n = (await db.query<{ n: number }>("SELECT work_card_demand_refresh() AS n")).rows[0].n;
  assertEquals(n, 4, "回寫：pos、viewsonly（新列 0）、creator 新增，zeroed 由 900 改 0；halved 本來就是 0 不寫");
  const calls = (await db.query<{ keys: string[] }>("SELECT keys FROM _spy")).rows;
  assertEquals(calls.length, 1, "整輪只呼叫一次");
  assertEquals([...calls[0].keys].sort(), [WK("creator"), WK("pos")].sort());
  const rows = await snapshot(db);
  assertEquals(demandOf(rows, "pos"), 2 * DAY);
  assertEquals(demandOf(rows, "creator"), 2 * DAY);
  assertEquals(demandOf(rows, "halved"), 0);
  assertEquals(demandOf(rows, "zeroed"), 0);
  assertEquals(demandOf(rows, "viewsonly"), 0);
  await db.close();
});

// ============================================================
// E. 還原驗證：偷改任何一處，並排比對必須變紅
// ============================================================
const refreshDef = fnText(MIG, "work_card_demand_refresh");
const sabotages: Array<[string, string]> = [
  ["拿掉冷卻與結案防線", mutate(refreshDef, "CASE WHEN COALESCE(ls.closed OR COALESCE(ls.check_cool_until > now(), FALSE), FALSE) THEN 0", "CASE WHEN FALSE THEN 0")],
  ["拿掉建立者補算", refreshDef.replaceAll("b.direct + b.creators + ", "b.direct + ")],
  ["階梯一張都不查", mutate(refreshDef, "WHERE b.halv < s.demand_halving_max", "WHERE FALSE AND b.halv < s.demand_halving_max")],
  ["減半次數不算", mutate(refreshDef, "* power(0.5::NUMERIC, b.halv))::BIGINT", "* 1)::BIGINT")],
  ["訊號數不看期限", mutate(refreshDef, "     WHERE x.created_at > now() - make_interval(days => s.demand_signal_days)\n     GROUP BY x.work_key", "     GROUP BY x.work_key")],
];
for (const [name, def] of sabotages) {
  Deno.test(`E 還原驗證：${name} → 並排比對必須紅`, async () => {
    assertNotEquals(def, refreshDef, "沒有真的改到");
    const db = await buildDb({ refreshSql: def });
    const { mismatch } = await scenario(db);
    assert(mismatch > 0, `「${name}」竟然沒被抓到`);
    await db.close();
  });
}
