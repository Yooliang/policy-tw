/**
 * 派工優先序改制：層級 × 種類帶狀優先（migration 20261121193000_priority_bands.sql，維護者 2026-11-21「這樣改吧」）。
 *
 *   priority_seconds ＝ 屆基準（插隊中用最新一屆）＋ 層級天數 ＋ 種類天數 ＋ 流量比例制（訪客數 × 1 天）＋ 需求疊加；排序鍵 task_queue_key 不動。
 *
 *   A. 文字層：seed／手動入列／traffic_boost_apply／verify_ticket_base 的新定義 ＝ 上一版逐字 ＋ 標記區塊；停用規則、插隊 200 天、不升協議版號
 *   B. PGlite：表值抽查（2026 縣市長抄公報 2785、村里長照片 2660、2022 縣市長被按 2985、county 脈絡 2782）、跨屆不混排、同層種類順序、
 *      層級怎麼對上（election_type／參選紀錄／最近一屆／lineage.level／「其他」組無層級）、流量 30 人 ＝ +30 天且無上限、插隊用最新一屆、驗證票帶狀
 *   不斷言「最新一支 migration」：只讀自己這支與它之前的版本。
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261121193000_priority_bands.sql";
const MIG = await readMig(MIG_NAME);
const DAY = 86400;
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l !== "");
const fn = (name: string) => fnText(MIG, name);

// ───────────── A. 文字層 ─────────────

Deno.test("A1 seed：新定義 ＝ 上一版逐字（拿掉被取代的兩段）＋ 三個標記區塊（>>> 帶狀優先）", async () => {
  const prev = await latestFn("seed_auto_task_queue", MIG_NAME);
  const neu = fn("seed_auto_task_queue");
  const neuStripped = neu
    .replace(/  -- >>> 帶狀優先[^\n]*\n[\s\S]*?  -- <<< 帶狀優先\n/g, "")
    .replace(", g.opened_by, g.task_type FROM", ", g.opened_by FROM");
  assertNotEquals(neuStripped, neu, "有標記區塊");
  const prevStripped = prev
    .replace(/  -- >>> 優先秒數：流量提層的缺口[\s\S]*?  -- <<< 優先秒數\n/, "")
    .replace(/  -- >>> 選舉年優先[\s\S]*?  -- <<< 選舉類別提前天數\n/, "");
  assertNotEquals(prevStripped, prev, "上一版有被取代的兩段");
  assertEquals(neuStripped, prevStripped);
  assertEquals((neu.match(/>>> 帶狀優先/g) ?? []).length, 2, "兩個區塊（流量比例制、屆基準＋層級＋種類）");
  // 順序：規則 → 流量提層 → 流量比例制（重新起算）→ 需求疊加 → 屆基準＋帶狀 → 換號沿用
  assert(neu.indexOf("<<< 流量提層") < neu.indexOf(">>> 帶狀優先"));
  assert(neu.indexOf("<<< 需求疊加") < neu.lastIndexOf(">>> 帶狀優先"));
  assert(neu.lastIndexOf("<<< 帶狀優先") < neu.indexOf(">>> 換號沿用排隊位置"));
  // 不再讀的東西
  assert(!neu.includes("election_type_priority_seconds"));
  assert(!neu.includes("election_year_priority_seconds"));
  assert(!neu.includes("boost_seconds\n"), "traffic_boost_settings.boost_seconds 不再讀");
  assert(neu.includes("SET statement_timeout = '280s'") && neu.includes("SET work_mem = '16MB'"), "函式層級設定照舊寫在定義裡");
});

Deno.test("A2 手動任務進隊：不再讀規則秒數／選舉年優先／類別提前天數，改 屆基準＋帶狀；插隊秒數照舊", async () => {
  const prev = await latestFn("contribution_tasks_insert_dispatch", MIG_NAME);
  const neu = fn("contribution_tasks_insert_dispatch");
  const prevL = new Set(lines(prev));
  const neuL = new Set(lines(neu));
  const added = lines(neu).filter((l) => !prevL.has(l));
  const removed = lines(prev).filter((l) => !neuL.has(l));
  assert(added.some((l) => l.startsWith("task_year_priority_seconds(m.target, COALESCE(manual_front_seconds(m.task_id), 0) > 0) + task_band_seconds(m.task_type, m.target),")), added.join("\n"));
  assertEquals(removed.length, 3, removed.join("\n"));
  assert(!neu.includes("activity_priority_seconds") && !neu.includes("election_type_priority_seconds") && !neu.includes("election_year_priority_seconds("));
  assert(neu.includes("COALESCE(manual_front_seconds(m.task_id), 0)\n"), "boost_seconds 欄照舊");
});

Deno.test("A3 traffic_boost_apply：比例制——帶人數、不再限「優先秒數 < boost_seconds」、標 traffic_users；其餘（no_yield／pause）逐字不動", async () => {
  const prev = await latestFn("traffic_boost_apply", MIG_NAME);
  const neu = fn("traffic_boost_apply");
  assert(prev.includes("< s.boost_seconds") && !neu.includes("< s.boost_seconds"));
  assert(neu.includes("h.users FROM page_traffic_hot h"));
  assert(neu.includes("'traffic_users', u.users"));
  assert(neu.includes("max(h.users)"), "對到多個達標頁取人數最大的那頁");
  for (const keep of ["paused_until = now() + make_interval(days => s.pause_days)", "s.no_yield_days", "lifted_task_ids", "last_yield_at"]) {
    assert(neu.includes(keep), keep);
  }
});

Deno.test("A4 verify_ticket_base：只差兩處（新增型與有基準的退路都減帶狀）；夾限邏輯與選舉年逐字不動", async () => {
  const prev = await latestFn("verify_ticket_base", MIG_NAME);
  const neu = fn("verify_ticket_base");
  const prevL = new Set(lines(prev));
  const neuL = new Set(lines(neu));
  const added = lines(neu).filter((l) => !prevL.has(l));
  const removed = lines(prev).filter((l) => !neuL.has(l));
  assertEquals(removed.length, 2, removed.join("\n")); // is_new 那一行與沒有母任務位置的退路
  assertEquals(added.length, 3, added.join("\n")); // 兩個基準不含層級的分支（層級＋19）與有母任務位置的分支（領先 19 − 母種類）
  assert(neu.includes("verify_ticket_parent_lead_seconds(p.task_type, p.target)"));
  assert(neu.includes("verify_ticket_band_seconds(p_verify_task_id)"));
  assert(neu.includes("task_queue_key(p.last_dispatched_at, p.priority_seconds, NULL, 0) - make_interval(secs => COALESCE(verify_ticket_base_floor_seconds(), 0))"), "夾限照舊");
  assert(neu.includes("p.last_dispatched_at <= COALESCE(t.created_at, now())"));
});

Deno.test("A5 設定：插隊四值 200 天、驗證領先 0、流量無門檻；規則 37／38／39 停用不刪；一次性重算冪等", () => {
  assert(MIG.includes("boost_seconds = 17280000, manual_front_seconds = 17280000, visitor_front_seconds = 17280000, visitor_front_pre_election_seconds = 17280000"));
  assert(MIG.includes("verify_priority_seconds = 0"));
  assert(/SET enabled = false,[\s\S]*?WHERE id IN \(37, 38, 39\)/.test(MIG));
  assert(!/DELETE FROM activity_rules/.test(MIG));
  assert(MIG.includes("priority_bands_applied_at IS NOT NULL") && MIG.includes("UPDATE queue_settings SET priority_bands_applied_at = now()"));
  assert(MIG.includes("min_users = 1, per_user_seconds = 86400"));
  assert(MIG.includes("-- 回滾："), "檔頭有回滾方式");
});

Deno.test("A6 不升協議版號、不動 TS、不重新定義排序鍵與觸發器", () => {
  assert(!/PROTOCOL_VERSION/.test(MIG));
  for (const name of ["task_queue_key", "task_dispatches_queue_key", "verify_ticket_key", "refresh_verify_ticket_keys", "election_year_priority_seconds"]) {
    assert(!MIG.includes(`CREATE OR REPLACE FUNCTION ${name}(`), `${name} 不動`);
  }
});

// ───────────── B. PGlite ─────────────

const SCHEMA = `
CREATE TABLE elections (id INTEGER PRIMARY KEY, election_date DATE NOT NULL, election_reason TEXT);
INSERT INTO elections VALUES (4, '2022-12-18', 'rerun'), (2022, '2022-11-26', 'regular'), (2024, '2024-01-13', 'regular'), (2026, '2026-11-28', 'regular');
CREATE TABLE politician_elections (id SERIAL PRIMARY KEY, politician_id UUID, election_id INTEGER, election_type TEXT);
CREATE TABLE task_dispatches (task_id TEXT PRIMARY KEY, task_type TEXT, target JSONB, boost_seconds BIGINT NOT NULL DEFAULT 0);
CREATE TABLE contributions (id UUID PRIMARY KEY, task_id TEXT, payload JSONB, applied_politician_id UUID);
`;
const FNS = [
  "election_level_days", "task_kind_days_by_type", "task_has_level", "task_target_level_text", "contribution_level_text", "task_level_text", "task_level_days", "task_kind_days", "verify_ticket_parent_lead_seconds",
  "task_band_priority_seconds", "task_band_seconds", "latest_election_base_seconds", "task_year_priority_seconds", "verify_ticket_band_seconds",
];
async function env(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const n of ["uuid_or_null", "election_id_or_null"]) await db.exec(await latestFn(n, MIG_NAME));
  await db.exec(fnText(await readMig("20261112005000_election_year_priority.sql"), "election_year_priority_seconds"));
  await db.exec(await latestFn("verify_ticket_election_type", MIG_NAME));
  for (const n of FNS) await db.exec(fn(n));
  return db;
}
const num = async (db: PGlite, sql: string): Promise<number> => Number((await db.query<{ v: string }>(`SELECT (${sql}) AS v`)).rows[0]!.v);
const lit = (o: unknown) => `'${JSON.stringify(o).replaceAll("'", "''")}'::jsonb`;
/** 一件任務的優先天數（屆基準＋層級＋種類） */
const days = async (db: PGlite, type: string, target: Record<string, unknown>, boosted = false): Promise<number> =>
  (await num(db, `task_year_priority_seconds(${lit(target)}, ${boosted}) + task_band_seconds('${type}', ${lit(target)})`)) / DAY;

const LEVELS: Record<string, number> = {
  縣市長: 170, 直轄市長: 170, 總統副總統: 170, 直轄市山地原住民區長: 150, 縣市議員: 130, 直轄市議員: 130, 立法委員: 130,
  鄉鎮市長: 110, 直轄市山地原住民區民代表: 90, 鄉鎮市民代表: 70, 村里長: 50,
};
const KINDS: Record<string, number> = {
  verify: 19, adjudicate: 19, policy_missing: 15, policy_election_missing: 15, term_policy_missing: 13,
  lineage_candidate: 12, lineage_roles_missing: 12, lineage_link_candidate: 12, lineage_stance_missing: 12,
  avatar_choice: 10, profile_gap: 8, profile_detail_gap: 8, party_info_missing: 8, candidacy_source_missing: 8, candidate_status_stale: 8,
  duplicate_policy: 5, duplicate_politician: 5, policy_election_mismatch: 5, source_mismatch: 5, policy_source_missing: 5, policy_validity: 5, issue_too_broad: 5, legacy_audit: 5,
  progress_stale: 3, deadline_due: 3,
  news_sweep: 0, regional_stat_missing: 0, roster_check: 0, other: 0, 沒列到的新型別: 0,
};

Deno.test("B1 層級天數：縣市長 170／原住民區長 150／議員 130／鄉鎮市長 110／區民代表 90／鄉民代表 70／村里長 50／無層級 30", async () => {
  const db = await env();
  for (const [t, d] of Object.entries(LEVELS)) assertEquals(await num(db, `election_level_days('${t}')`), d, t);
  for (const t of ["", "亂寫", "立委"]) assertEquals(await num(db, `election_level_days('${t}')`), 30, `「${t}」＝無層級`);
  assertEquals(await num(db, `election_level_days(NULL)`), 30);
  await db.close();
});

Deno.test("B2 種類天數：全部型別逐一對表（profile_gap 缺照片 10、其餘 8）", async () => {
  const db = await env();
  for (const [t, d] of Object.entries(KINDS)) assertEquals(await num(db, `task_kind_days_by_type('${t}', false)`), d, t);
  assertEquals(await num(db, `task_kind_days_by_type('profile_gap', true)`), 10);
  assertEquals(await num(db, `task_kind_days_by_type('policy_missing', true)`), 15, "缺照片旗標只影響 profile_gap");
  assertEquals(await num(db, `task_kind_days('profile_gap', ${lit({ missing: ["current_position", "avatar_url"] })})`), 10);
  assertEquals(await num(db, `task_kind_days('profile_gap', ${lit({ missing: ["birth_year"] })})`), 8);
  assertEquals(await num(db, `task_kind_days('profile_gap', ${lit({ region: "x" })})`), 8, "沒有 missing 欄＝人物基本資料");
  await db.close();
});

Deno.test("B3 表值抽查：2026 縣市長抄公報 2785、村里長照片 2660、2022 縣市長被按 2985、county 脈絡 2782", async () => {
  const db = await env();
  assertEquals(await days(db, "policy_missing", { election_id: 2026, election_type: "縣市長" }), 2600 + 170 + 15);
  assertEquals(await days(db, "policy_missing", { election_id: 2026, election_type: "縣市長" }), 2785);
  assertEquals(await days(db, "profile_gap", { election_id: 2026, election_type: "村里長", missing: ["avatar_url"] }), 2660);
  assertEquals(await days(db, "avatar_choice", { election_id: 2026, election_type: "村里長" }), 2660);
  // 2022 縣市長被按（網站請求／boost）：屆基準換成最新一屆 2600；加上 200 天的 boost_seconds ＝ 2985
  const pressed = await days(db, "policy_missing", { election_id: 2022, election_type: "縣市長" }, true);
  assertEquals(pressed, 2600 + 170 + 15);
  assertEquals(pressed + 17280000 / DAY, 2985);
  assertEquals(await days(db, "policy_missing", { election_id: 2022, election_type: "縣市長" }, false), 2200 + 170 + 15, "沒被按就是自己的屆");
  // county 脈絡：2026（沒有選舉 id 當 2026）＋ 縣市長層 170 ＋ 脈絡 12
  assertEquals(await days(db, "lineage_candidate", { level: "county", region: "雲林縣" }), 2782);
  assertEquals(await days(db, "lineage_link_candidate", { level: "township" }), 2600 + 110 + 12);
  assertEquals(await days(db, "lineage_roles_missing", { level: "village" }), 2600 + 50 + 12);
  // 驗證票：母任務層級 ＋ 19（縣市長 189、村里長 69）
  assertEquals(await num(db, `(election_level_days('縣市長') + task_kind_days_by_type('verify', false))`), 189);
  await db.close();
});

Deno.test("B4 跨屆不混排：任何 2024 的組合都低於任何 2026 的組合（屆差 200 天 > 層級＋種類最大 189 天）；2026 村里長照片 > 2024 縣市長抄公報", async () => {
  const db = await env();
  let max2024 = -Infinity, min2026 = Infinity, max2022 = -Infinity;
  for (const lvl of [...Object.keys(LEVELS), ""]) {
    for (const [type, k] of Object.entries(KINDS)) {
      const t = (id: number) => ({ election_id: id, ...(lvl ? { election_type: lvl } : {}) });
      const eff = type === "verify" ? "adjudicate" : type;
      const d = (id: number) => days(db, eff, t(id));
      const lv = lvl ? LEVELS[lvl]! : 30;
      const lvEff = ["news_sweep", "regional_stat_missing", "other", "沒列到的新型別"].includes(type) || type.startsWith("lineage_") ? 30 : lv;
      void k;
      max2024 = Math.max(max2024, await d(2024));
      max2022 = Math.max(max2022, await d(2022));
      min2026 = Math.min(min2026, await d(2026));
      assertEquals(await d(2026) - 2600, lvEff + KINDS[type]!, `${lvl || "無層級"} × ${type}`);
    }
  }
  assert(max2024 < min2026, `${max2024} < ${min2026}`);
  assert(max2022 < min2026);
  assert(await days(db, "profile_gap", { election_id: 2026, election_type: "村里長", missing: ["avatar_url"] }) > await days(db, "policy_missing", { election_id: 2024, election_type: "縣市長" }));
  await db.close();
});

Deno.test("B5 同屆同層種類順序：查證 > 抄公報 > 任內政見 > 脈絡 > 照片 > 人物基本資料 > 整理 > 進度 > 其他；層級順序縣市長 > … > 村里長", async () => {
  const db = await env();
  const order = ["adjudicate", "policy_missing", "term_policy_missing", "lineage_candidate", "avatar_choice", "profile_detail_gap", "duplicate_policy", "progress_stale", "roster_check"];
  const ds: number[] = [];
  for (const t of order) ds.push(await days(db, t, { election_id: 2026, election_type: "鄉鎮市長", ...(t.startsWith("lineage") ? { level: "township" } : {}) }));
  for (let i = 1; i < ds.length; i++) assert(ds[i - 1]! > ds[i]!, `${order[i - 1]} 排在 ${order[i]} 前面：${ds}`);
  const lv = ["縣市長", "直轄市山地原住民區長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區民代表", "鄉鎮市民代表", "村里長"];
  const ls: number[] = [];
  for (const l of lv) ls.push(await days(db, "policy_missing", { election_id: 2026, election_type: l }));
  for (let i = 1; i < ls.length; i++) assert(ls[i - 1]! > ls[i]!, `${lv[i - 1]} 排在 ${lv[i]} 前面`);
  // 層級 20 天一格、種類最大 19 天：同屆下，高一層的最低種類（0）仍高於低一層的最高種類（19）——「其他」例外（它沒有層級，30 天）
  assert(await days(db, "profile_detail_gap", { election_id: 2026, election_type: "縣市議員" }) > await days(db, "adjudicate", { election_id: 2026, election_type: "鄉鎮市長" }) - 20 + 0);
  await db.close();
});

Deno.test("B6 層級怎麼對上：election_type → 參選紀錄 → 最近一屆 → lineage.level → 「其他」組無層級", async () => {
  const db = await env();
  const pid = "11111111-1111-4111-8111-111111111111";
  await db.exec(`INSERT INTO politician_elections (politician_id, election_id, election_type) VALUES ('${pid}', 2026, '縣市議員'), ('${pid}', 2022, '村里長')`);
  const lvl = async (type: string, target: Record<string, unknown>) => num(db, `task_level_days('${type}', ${lit(target)})`);
  assertEquals(await lvl("policy_missing", { election_type: "縣市長", politician_id: pid, election_id: 2022 }), 170, "target.election_type 優先");
  assertEquals(await lvl("profile_gap", { politician_id: pid, election_id: 2026 }), 130, "沒有 election_type：查那一屆的參選紀錄（2026 議員）");
  assertEquals(await lvl("profile_gap", { politician_id: pid, election_id: 2022 }), 50, "2022 是村里長");
  assertEquals(await lvl("profile_gap", { politician_id: pid }), 130, "只有人物：取最近一屆的職位（2026 議員）");
  assertEquals(await lvl("profile_gap", { politician_id: "22222222-2222-4222-8222-222222222222", election_id: 2026 }), 30, "查無 ＝ 無層級");
  assertEquals(await lvl("profile_gap", {}), 30);
  assertEquals(await lvl("profile_gap", { election_type: "" }), 30, "空字串當沒有");
  assertEquals(await lvl("roster_check", { election_type: "鄉鎮市長" }), 110, "roster_check 照職位");
  assertEquals(await lvl("other", { election_type: "縣市長", politician_id: pid }), 30, "other 無層級");
  assertEquals(await lvl("news_sweep", { election_type: "縣市長" }), 30);
  assertEquals(await lvl("regional_stat_missing", { level: "county" }), 30);
  assertEquals(await lvl("lineage_candidate", { level: "county" }), 170);
  assertEquals(await lvl("lineage_candidate", { level: "national" }), 170);
  assertEquals(await lvl("lineage_roles_missing", { level: "township" }), 110);
  assertEquals(await lvl("lineage_link_candidate", { level: "village" }), 50);
  assertEquals(await lvl("lineage_candidate", {}), 30, "脈絡沒有 level ＝ 無層級");
  assertEquals(await lvl("lineage_candidate", { level: "county", election_type: "村里長" }), 170, "脈絡只看 target.level，不看人物職位");
  await db.close();
});

Deno.test("B7 最新一屆：election_date 最大的例行選舉（重行選舉不算）；插隊用它、不插隊用自己那一屆", async () => {
  const db = await env();
  assertEquals(await num(db, "latest_election_base_seconds()"), 2600 * DAY);
  await db.exec(`INSERT INTO elections VALUES (5, '2027-03-01', 'rerun')`);
  assertEquals(await num(db, "latest_election_base_seconds()"), 2600 * DAY, "重行選舉（rerun）即使日期更晚也不算");
  await db.exec(`INSERT INTO elections VALUES (2028, '2028-01-15', 'regular')`);
  assertEquals(await num(db, "latest_election_base_seconds()"), 2800 * DAY, "2028 例行選舉進來自動 2800");
  assertEquals(await days(db, "profile_gap", { election_id: 2022, election_type: "縣市長" }, true), 2800 + 170 + 8);
  assertEquals(await days(db, "profile_gap", { election_id: 2022, election_type: "縣市長" }, false), 2200 + 170 + 8);
  await db.exec(`DELETE FROM elections WHERE id IN (5, 2028, 2026, 2024, 2022, 4)`);
  assertEquals(await num(db, "latest_election_base_seconds()"), 2600 * DAY, "查無例行選舉＝當 2026");
  await db.close();
});

Deno.test("B8 帶狀秒數函式：task_band_priority_seconds(層級文字, 型別, 缺照片) ＝ (層級＋種類) × 86400；與 target 版一致", async () => {
  const db = await env();
  assertEquals(await num(db, `task_band_priority_seconds('縣市長', 'policy_missing', false)`), (170 + 15) * DAY);
  assertEquals(await num(db, `task_band_priority_seconds('村里長', 'profile_gap', true)`), (50 + 10) * DAY);
  assertEquals(await num(db, `task_band_priority_seconds(NULL, 'other', false)`), 30 * DAY);
  const target = { election_type: "鄉鎮市民代表", missing: ["avatar_url"] };
  assertEquals(await num(db, `task_band_seconds('profile_gap', ${lit(target)})`), await num(db, `task_band_priority_seconds('鄉鎮市民代表', 'profile_gap', true)`));
  await db.close();
});

// ── 流量比例制：拿 seed 裡的那一段 SQL 真的跑一遍 ──
function seedBlock(): { traffic: string; band: string } {
  const neu = fn("seed_auto_task_queue");
  const blocks = [...neu.matchAll(/  -- >>> 帶狀優先[^\n]*\n[\s\S]*?  -- <<< 帶狀優先\n/g)].map((m) => m[0]);
  assertEquals(blocks.length, 2);
  return { traffic: blocks[0]!, band: blocks[1]! };
}
async function seedEnv(): Promise<PGlite> {
  const db = await env();
  await db.exec(`
    CREATE TABLE traffic_boost_settings (id SMALLINT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT true, per_user_seconds INTEGER NOT NULL DEFAULT 86400);
    INSERT INTO traffic_boost_settings (id) VALUES (1);
    CREATE TABLE _manual_front (task_id TEXT PRIMARY KEY, secs BIGINT);
    CREATE FUNCTION manual_front_seconds(p_task_id TEXT) RETURNS BIGINT LANGUAGE sql STABLE AS $$ SELECT COALESCE((SELECT secs FROM _manual_front WHERE task_id = p_task_id), 0) $$;
    CREATE TABLE _gaps (task_id TEXT PRIMARY KEY, arm TEXT, task_type TEXT, target JSONB, opened_by JSONB, priority_seconds INTEGER);
  `);
  return db;
}
const runTraffic = (db: PGlite) => db.exec(seedBlock().traffic.replace(/--[^\n]*\n/g, "\n"));
const runBand = (db: PGlite) => db.exec(seedBlock().band.replace(/--[^\n]*\n/g, "\n"));
const prio = async (db: PGlite, id: string): Promise<number> => Number((await db.query<{ p: number }>(`SELECT priority_seconds AS p FROM _gaps WHERE task_id = '${id}'`)).rows[0]!.p);

Deno.test("B9 流量比例制：30 人 ＝ +30 天、1 人 ＝ +1 天、0 人／沒旗標 ＝ 0、無上限（575 人 ＝ +575 天）、改 per_user_seconds 立刻生效、停用歸零", async () => {
  const db = await seedEnv();
  await db.exec(`
    INSERT INTO _gaps VALUES
      ('t30', 'a', 'policy_missing', '{}', '{"traffic_boost": true, "traffic_users": 30}', 259200),
      ('t1', 'a', 'policy_missing', '{}', '{"traffic_boost": true, "traffic_users": 1}', 259200),
      ('t575', 'a', 'policy_missing', '{}', '{"traffic_boost": true, "traffic_users": 575}', 259200),
      ('t0', 'a', 'policy_missing', '{}', '{"traffic_boost": true, "traffic_users": 0}', 259200),
      ('tno', 'a', 'policy_missing', '{}', '{}', 259200),
      ('tbad', 'a', 'policy_missing', '{}', '{"traffic_boost": true}', 259200)`);
  await runTraffic(db);
  assertEquals(await prio(db, "t30"), 30 * DAY);
  assertEquals(await prio(db, "t1"), DAY);
  assertEquals(await prio(db, "t575"), 575 * DAY);
  assertEquals(await prio(db, "t0"), 0);
  assertEquals(await prio(db, "tno"), 0, "沒旗標 ＝ 0；規則秒數（前段 259200 ＝ 3 天）不再疊加");
  assertEquals(await prio(db, "tbad"), 0, "旗標有、人數缺 ＝ 0，不拋錯");
  await db.exec(`UPDATE traffic_boost_settings SET per_user_seconds = 3600 WHERE id = 1`);
  await db.exec(`UPDATE _gaps SET priority_seconds = 259200`);
  await runTraffic(db);
  assertEquals(await prio(db, "t30"), 30 * 3600);
  await db.exec(`UPDATE traffic_boost_settings SET enabled = false WHERE id = 1`);
  await runTraffic(db);
  assertEquals(await prio(db, "t30"), 0, "停用 ＝ 0");
  await db.close();
});

Deno.test("B10 seed 屆基準＋層級＋種類：自動缺口用自己那一屆；插隊中（既有列 boost>0）與新手動缺口用最新一屆；派出後（boost 歸零）換回自己那一屆", async () => {
  const db = await seedEnv();
  await db.exec(`
    INSERT INTO task_dispatches (task_id, boost_seconds) VALUES ('boosted', 17280000), ('dispatched', 0);
    INSERT INTO _manual_front VALUES ('newweb', 17280000), ('newsugg', 0);
    INSERT INTO _gaps VALUES
      ('auto2022',   'policy_missing',    'policy_missing', '{"election_id": 2022, "election_type": "縣市長"}', '{}', 0),
      ('boosted',    'policy_missing',    'policy_missing', '{"election_id": 2022, "election_type": "縣市長"}', '{}', 0),
      ('dispatched', 'manual_web',        'policy_missing', '{"election_id": 2022, "election_type": "縣市長"}', '{}', 0),
      ('newweb',     'manual_visitor',    'profile_gap',    '{"region": "x"}', '{}', 0),
      ('newsugg',    'manual_suggested',  'other',          '{"election_id": 2022}', '{}', 0),
      ('traffic',    'policy_missing',    'policy_missing', '{"election_id": 2026, "election_type": "縣市長"}', '{"traffic_boost": true, "traffic_users": 30}', 0)`);
  await runTraffic(db);
  await runBand(db);
  assertEquals(await prio(db, "auto2022"), (2200 + 170 + 15) * DAY, "沒插隊：自己那一屆（2022）");
  assertEquals(await prio(db, "boosted"), (2600 + 170 + 15) * DAY, "插隊中：最新一屆（2026）；再加 boost 200 天 ＝ 2985");
  assertEquals(await prio(db, "dispatched"), (2200 + 170 + 15) * DAY, "手動臂但已派出（boost 歸零）：換回自己那一屆");
  assertEquals(await prio(db, "newweb"), (2600 + 30 + 8) * DAY, "新網站請求缺口：最新一屆；沒帶人物 ＝ 無層級 30；profile_gap 無 missing ＝ 人物基本資料 8");
  assertEquals(await prio(db, "newsugg"), (2200 + 30 + 0) * DAY, "手動臂但沒有插隊（manual_front_seconds ＝ 0）：自己那一屆");
  assertEquals(await prio(db, "traffic"), (30 + 2600 + 170 + 15) * DAY, "流量 30 人 ＝ +30 天，疊在屆基準＋帶狀之上");
  await db.close();
});

Deno.test("B11 驗證票帶狀：母任務層級 ＋ 19 天；母任務列不在看交件 payload；都沒有＝無層級", async () => {
  const db = await env();
  const c = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const pid = "33333333-3333-4333-8333-333333333333";
  await db.exec(`
    INSERT INTO politician_elections (politician_id, election_id, election_type) VALUES ('${pid}', 2026, '鄉鎮市民代表');
    INSERT INTO task_dispatches (task_id, task_type, target) VALUES
      ('auto:county', 'policy_missing', '{"election_id": 2026, "election_type": "縣市長"}'),
      ('auto:village', 'profile_gap', '{"election_id": 2026, "election_type": "村里長"}'),
      ('auto:lineage', 'lineage_candidate', '{"level": "township"}'),
      ('auto:other', 'other', '{"region": "x"}');
    INSERT INTO contributions (id, task_id, payload) VALUES
      ('${c(1)}', 'auto:county', '{}'), ('${c(2)}', 'auto:village', '{}'), ('${c(3)}', 'auto:lineage', '{}'),
      ('${c(4)}', 'gone:task', '{"election_type": "縣市議員"}'),
      ('${c(5)}', 'gone:task', '{"politician_id": "${pid}", "election_id": 2026}'),
      ('${c(6)}', NULL, '{}'),
      ('${c(7)}', 'auto:other', '{}')`);
  const band = (n: number) => num(db, `verify_ticket_band_seconds('verify:${c(n)}')`);
  assertEquals(await band(1), (170 + 19) * DAY, "縣市長母任務");
  assertEquals(await band(2), (50 + 19) * DAY, "村里長母任務");
  assertEquals(await band(3), (110 + 19) * DAY, "脈絡母任務：用 target.level");
  assertEquals(await band(4), (130 + 19) * DAY, "母任務列不在：交件 payload.election_type");
  assertEquals(await band(5), (70 + 19) * DAY, "母任務列不在：交件 payload 的人物＋選舉 → 參選紀錄");
  assertEquals(await band(6), (30 + 19) * DAY, "什麼都對不上＝無層級");
  assertEquals(await band(7), (30 + 19) * DAY, "母任務是 other（無層級）＝無層級");
  assertEquals(await num(db, `verify_ticket_band_seconds('verify:not-a-uuid')`), (30 + 19) * DAY, "亂的 id 不拋錯");
  await db.close();
});

Deno.test("B12 裁決（adjudicate）繼承母交件的層級：payload／母任務／applied_politician_id；取不到才無層級；仍排在同層抄公報之前", async () => {
  const db = await env();
  const c = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const pid = "44444444-4444-4444-8444-444444444444";
  await db.exec(`
    INSERT INTO politician_elections (politician_id, election_id, election_type) VALUES ('${pid}', 2026, '縣市議員');
    INSERT INTO task_dispatches (task_id, task_type, target) VALUES ('auto:county', 'policy_missing', '{"election_id": 2026, "election_type": "縣市長"}');
    INSERT INTO contributions (id, task_id, payload, applied_politician_id) VALUES
      ('${c(1)}', NULL, '{"election_type": "鄉鎮市長"}', NULL),
      ('${c(2)}', 'auto:county', '{}', NULL),
      ('${c(3)}', 'auto:gone:x', '{"bio": "x"}', '${pid}'),
      ('${c(4)}', NULL, '{}', NULL)`);
  const adj = (n: number) => num(db, `task_level_days('adjudicate', ${lit({ contribution_id: c(n), contribution_type: "politician" })})`);
  assertEquals(await adj(1), 110, "payload.election_type");
  assertEquals(await adj(2), 170, "母任務 target.election_type");
  assertEquals(await adj(3), 130, "母任務列已不在：applied_politician_id 的最近一屆職位（議員）");
  assertEquals(await adj(4), 30, "取不到＝無層級");
  assertEquals(await num(db, `task_level_days('adjudicate', ${lit({ contribution_id: "not-a-uuid" })})`), 30, "亂的 id 不拋錯");
  assertEquals(await num(db, `task_level_days('adjudicate', ${lit({ election_type: "村里長" })})`), 50, "沒有 contribution_id 時看 target 自己");
  // 縣市長層的裁決（2600＋170＋19）仍排在同層的抄公報（2600＋170＋15）之前
  const adjDays = (await num(db, `task_year_priority_seconds('{}'::jsonb, false)`)) / DAY + (await adj(2)) + 19;
  assert(adjDays > await days(db, "policy_missing", { election_id: 2026, election_type: "縣市長" }));
  await db.close();
});

Deno.test("B13 驗證票與母任務同層、票比母任務多 (19 − 母種類) 天，層級不重複算", async () => {
  const db = await env();
  for (const [type, k] of Object.entries(KINDS)) {
    if (type === "verify" || type === "adjudicate" || type === "沒列到的新型別") continue;
    const target = { election_id: 2026, election_type: "縣市議員", ...(type.startsWith("lineage") ? { level: "county" } : {}) };
    const lead = (await num(db, `verify_ticket_parent_lead_seconds('${type}', ${lit(target)})`)) / DAY;
    assertEquals(lead, 19 - k, `${type}：領先 19 − ${k}`);
    assert(lead >= 0);
    // 母任務總分（屆基準＋層級＋母種類）加領先 ＝ 屆基準＋母任務層級＋19
    const parentLevel = await num(db, `task_level_days('${type}', ${lit(target)})`);
    const parentTotal = await days(db, type, target);
    assertEquals(parentTotal + lead, 2600 + parentLevel + 19, `${type}：票 ＝ 屆基準＋母任務層級＋19`);
  }
  assertEquals(await num(db, `verify_ticket_parent_lead_seconds('adjudicate', '{}'::jsonb)`), 0, "母任務自己就是 19：不領先");
  await db.close();
});
