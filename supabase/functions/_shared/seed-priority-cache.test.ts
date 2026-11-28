/**
 * seed 增量化 3-A（migration 20261128020000_seed_priority_cache.sql）守門。
 *
 * 這支改的是：seed 裡「優先秒數再加屆基準＋層級＋種類」那句整表 UPDATE（每輪對全部缺口逐列呼叫兩支函式，約 10 秒），
 * 換成 seed_priority_year_band()：輸入沒變就讀 task_priority_cache。輸出必須與舊的整表 UPDATE 逐列相同。
 *
 *   A. 文字層：時間戳、前一版 seed 是 20261127120000、三個函式層級 SET、seed 本體拿掉標記區塊後與前一版（拿掉舊 UPDATE）逐字相同、
 *      靜態部分用到的純函式的最新定義檔名（改了要換程式版本字串 v1）、新表 RLS 與 REVOKE、開頭註解
 *   B. PGlite 行為：把前一版 seed 裡那句舊 UPDATE 原文抽出來當 oracle，與新函式對同一份資料逐列比：
 *      首輪、沒變動、目標變、插隊旗標變、參選紀錄職位變（觸發器失效）、選舉日期變（全域版本）、adjudicate 不快取、
 *      缺口消失清快取、24 小時輪替自癒
 *   C. 還原驗證：把失效觸發器改壞，B 的對應情境必須變紅
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { latestFn, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261128020000_seed_priority_cache.sql";
const PREV_NAME = "20261127120000_gap_drain_batch.sql";
const MIG = await readMig(MIG_NAME);
const PREV = await readMig(PREV_NAME);

function seedBody(src: string): string {
  const start = src.lastIndexOf("FUNCTION seed_auto_task_queue()");
  assert(start >= 0, "找不到 seed_auto_task_queue 定義");
  const open = src.indexOf("$$", start);
  const close = src.indexOf("$$", open + 2);
  return src.slice(open + 2, close);
}
const squash = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join(" ").replace(/\s+/g, " ").trim();

/** 前一版 seed 裡那句舊的整表 UPDATE（原文） */
const OLD_UPDATE_RE = /UPDATE _gaps g SET priority_seconds = COALESCE\(g\.priority_seconds, 0\)\s+\+ task_year_priority_seconds[\s\S]*?task_band_seconds\(g\.task_type, g\.target\);/;
const OLD_UPDATE = (OLD_UPDATE_RE.exec(seedBody(PREV)) ?? [""])[0];

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 時間戳大於 20261128010000，前一版 seed 定義是 20261127120000", async () => {
  assert(MIG_NAME > "20261128010000_seed_hash_mem_multiplier.sql");
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION seed_auto_task_queue(")) defining.push(n);
  assertEquals(defining[defining.indexOf(MIG_NAME) - 1], PREV_NAME, "前一版變了：要以最新的為底重做");
});

Deno.test("A2 舊 UPDATE 抽得出來，而且是整表逐列呼叫兩支函式的那句", () => {
  assert(OLD_UPDATE.length > 100, "前一版的舊 UPDATE 抽不到");
  assert(OLD_UPDATE.includes("task_year_priority_seconds(g.target") && OLD_UPDATE.includes("task_band_seconds(g.task_type, g.target)"));
});

Deno.test("A3 seed 三個函式層級 SET 都在，而且本檔結尾自我檢查它們", () => {
  const head = MIG.slice(MIG.lastIndexOf("FUNCTION seed_auto_task_queue()"));
  const pre = head.slice(0, head.indexOf("$$"));
  assert(/SET statement_timeout = '280s'/.test(pre));
  assert(/SET work_mem = '16MB'/.test(pre));
  assert(/SET hash_mem_multiplier = '1'/.test(pre));
  assert(MIG.includes("seed 函式層級 SET 沒帶全"));
});

Deno.test("A4 seed 本體：拿掉靜態部分快取區塊，與前一版拿掉舊 UPDATE 後逐字相同", () => {
  const newBody = seedBody(MIG);
  const block = /-- >>> 靜態部分快取[\s\S]*?-- <<< 靜態部分快取\n/;
  assert(block.test(newBody), "新版缺標記區塊");
  const newStripped = newBody.replace(block, "");
  const oldStripped = seedBody(PREV).replace(OLD_UPDATE, "");
  assertEquals(squash(newStripped), squash(oldStripped));
  assert(newBody.includes("seed_priority_year_band()"));
  assert(!OLD_UPDATE_RE.test(newBody), "新版不該還有舊的整表 UPDATE");
});

Deno.test("A5 靜態部分用到的純函式，最新定義檔名沒變（改了要換 seed_priority_year_band 裡的版本字串 v1，再更新這張表）", async () => {
  const expected: Record<string, string> = {
    election_level_days: "20261121193000_priority_bands.sql",
    task_kind_days_by_type: "20261122160000_priority_bands_bulletin_first.sql",
    task_has_level: "20261121193000_priority_bands.sql",
    task_target_level_text: "20261121193000_priority_bands.sql",
    task_level_text: "20261121193000_priority_bands.sql",
    task_level_days: "20261121193000_priority_bands.sql",
    task_kind_days: "20261121193000_priority_bands.sql",
    task_band_seconds: "20261121193000_priority_bands.sql",
    latest_election_base_seconds: "20261121193000_priority_bands.sql",
    task_year_priority_seconds: "20261121193000_priority_bands.sql",
    election_year_priority_seconds: "20261112005000_election_year_priority.sql",
    election_id_or_null: "20261007030000_election_read_side.sql",
    uuid_or_null: "20260921000030_single_queue_boosts.sql",
    contribution_level_text: "20261121193000_priority_bands.sql",
  };
  const names = await migrationNames();
  for (const [fn, file] of Object.entries(expected)) {
    let last = "";
    for (const n of names) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}(`)) last = n;
    assertEquals(last, file, `${fn} 的定義換檔了：要把 seed_priority_year_band 的版本字串 v1 換成 v2，並更新本表`);
  }
  assert(MIG.includes("'|v1'"), "版本字串 v1 要在 sig 裡");
});

Deno.test("A6 新表有 RLS 與 REVOKE，新函式與觸發器函式有 REVOKE，開頭註解寫了為什麼與回滾", () => {
  for (const t of ["task_priority_cache", "task_priority_cache_state"]) {
    assert(MIG.includes(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`));
    assert(MIG.includes(`REVOKE ALL ON TABLE ${t} FROM PUBLIC, anon, authenticated;`));
  }
  assert(MIG.includes("REVOKE ALL ON FUNCTION seed_priority_year_band(INTEGER) FROM PUBLIC, anon, authenticated;"));
  const head = MIG.slice(0, MIG.indexOf("CREATE TABLE"));
  for (const must of ["3-A", "stage:priority_static", "不看現在時間", "回滾", "每日呼叫量變化：0", PREV_NAME.slice(0, 14)]) assert(head.includes(must), `註解缺「${must}」`);
});

Deno.test("A7 新 seed 函式的 plpgsql 語法能建起來，三個函式層級 SET 真的記在函式上", async () => {
  const db = new PGlite();
  const start = MIG.indexOf("CREATE OR REPLACE FUNCTION seed_auto_task_queue()");
  const end = MIG.indexOf("DO $$", start);
  await db.exec(MIG.slice(start, end));
  const r = await db.query<{ c: string[] }>("SELECT proconfig AS c FROM pg_proc WHERE proname = 'seed_auto_task_queue'");
  const cfg = r.rows[0].c;
  for (const s of ["statement_timeout=280s", "work_mem=16MB", "hash_mem_multiplier=1"]) assert(cfg.includes(s), `缺 ${s}`);
});

// ============================================================
// B. PGlite 行為：新函式 vs 前一版的整表 UPDATE
// ============================================================
const PES = ["uuid_or_null", "election_id_or_null", "election_level_days", "task_kind_days_by_type", "task_has_level", "task_target_level_text", "task_level_text",
  "task_level_days", "task_kind_days", "task_band_seconds", "election_year_priority_seconds", "latest_election_base_seconds", "task_year_priority_seconds"];

const P1 = "00000000-0000-0000-0000-000000000001";
const P2 = "00000000-0000-0000-0000-000000000002";
const P3 = "00000000-0000-0000-0000-000000000003";

async function freshDb(migText: string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date NOT NULL, election_reason text);
    CREATE TABLE politician_elections (id serial PRIMARY KEY, politician_id uuid NOT NULL, election_id integer, election_type text);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, boost_seconds integer NOT NULL DEFAULT 0);
    CREATE TABLE fake_contrib_level (cid uuid PRIMARY KEY, lvl text);
    CREATE FUNCTION manual_front_seconds(p_task_id text) RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT CASE WHEN p_task_id LIKE 'manual-front%' THEN 100::bigint ELSE 0::bigint END $$;
    CREATE FUNCTION verify_ticket_election_type(p text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
  `);
  for (const f of PES.filter((x) => x === "uuid_or_null" || x === "election_id_or_null")) await db.exec(await latestFn(f));
  // contribution_level_text 只有 adjudicate 會呼叫；真定義依賴一串交件表，這裡換成讀假表（行為一樣是「回交件的職位文字」）。SQL 函式建立時就驗證參照，所以要先建
  await db.exec(`CREATE FUNCTION contribution_level_text(p uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT lvl FROM fake_contrib_level WHERE cid = p $$;`);
  for (const f of PES.slice(2)) await db.exec(await latestFn(f));
  // 本檔 seed 之前的全部：兩張表、兩個觸發器、seed_priority_year_band
  await db.exec(migText.slice(0, migText.indexOf("CREATE OR REPLACE FUNCTION seed_auto_task_queue()")));
  await db.exec(`
    INSERT INTO elections VALUES (2022, '2022-11-26', 'regular'), (2024, '2024-01-13', 'regular'), (2026, '2026-11-28', 'regular');
    INSERT INTO politician_elections (politician_id, election_id, election_type) VALUES ('${P1}', 2026, '縣市長'), ('${P2}', 2022, '村里長'), ('${P3}', 2026, '縣市議員');
    INSERT INTO task_dispatches VALUES ('auto:boosted:1', 5);
    INSERT INTO fake_contrib_level VALUES ('00000000-0000-0000-0000-0000000000c1', '縣市長');
    CREATE TEMP TABLE _gaps (task_id text PRIMARY KEY, arm text, target jsonb, task_type text, priority_seconds integer);
    CREATE TEMP TABLE _gaps_old (task_id text PRIMARY KEY, arm text, target jsonb, task_type text, priority_seconds integer);
  `);
  return db;
}

type Gap = { id: string; arm: string; type: string; target: Record<string, unknown>; base: number | null };
const GAPS: Gap[] = [
  { id: "auto:profile_gap:p1", arm: "raw:profile_gap", type: "profile_gap", target: { politician_id: P1, election_id: 2026, missing: ["avatar_url"] }, base: 0 },
  { id: "auto:profile_gap:p2", arm: "raw:profile_gap", type: "profile_gap", target: { politician_id: P2, election_id: 2022 }, base: null },
  { id: "auto:policy_missing:p3", arm: "raw:policy_missing", type: "policy_missing", target: { politician_id: P3, election_id: 2026 }, base: 864000 },
  { id: "auto:roster:e", arm: "roster_villages", type: "roster_check", target: { election_type: "村里長", election_id: 2026 }, base: 0 },
  { id: "auto:lineage:1", arm: "lineage_candidates", type: "lineage_candidate", target: { level: "county" }, base: 0 },
  { id: "auto:other:1", arm: "regional_stats_missing", type: "regional_stat_missing", target: { region: "x" }, base: 0 },
  { id: "auto:boosted:1", arm: "raw:profile_gap", type: "profile_gap", target: { politician_id: P1, election_id: 2022 }, base: 0 },
  { id: "manual-front-1", arm: "manual_open", type: "other", target: { election_id: 2024 }, base: 0 },
  { id: "auto:adj:1", arm: "adjudicate", type: "adjudicate", target: { contribution_id: "00000000-0000-0000-0000-0000000000c1" }, base: 0 },
  { id: "auto:nopid:1", arm: "raw:policy_missing", type: "policy_missing", target: {}, base: 0 },
];

async function loadGaps(db: PGlite, gaps: Gap[]) {
  await db.exec("DELETE FROM _gaps; DELETE FROM _gaps_old;");
  for (const g of gaps) {
    const vals = `'${g.id}', '${g.arm}', '${JSON.stringify(g.target)}'::jsonb, '${g.type}', ${g.base === null ? "NULL" : g.base}`;
    await db.exec(`INSERT INTO _gaps VALUES (${vals}); INSERT INTO _gaps_old VALUES (${vals});`);
  }
}
/** 同一份輸入：舊的整表 UPDATE 跑在 _gaps_old，新函式跑在 _gaps；回新函式重算的列數 */
async function runBoth(db: PGlite, bucket = -1): Promise<number> {
  await db.exec(OLD_UPDATE.replace("UPDATE _gaps g", "UPDATE _gaps_old g"));
  const r = await db.query<{ n: number }>(`SELECT seed_priority_year_band(${bucket}) AS n`);
  return Number(r.rows[0].n);
}
async function diff(db: PGlite): Promise<number> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (
      (SELECT task_id, priority_seconds FROM _gaps EXCEPT SELECT task_id, priority_seconds FROM _gaps_old)
      UNION ALL (SELECT task_id, priority_seconds FROM _gaps_old EXCEPT SELECT task_id, priority_seconds FROM _gaps)) x`);
  return Number(r.rows[0].n);
}
const scalar = async (db: PGlite, sql: string) => Object.values((await db.query<Record<string, unknown>>(sql)).rows[0])[0];
const NONADJ = GAPS.filter((g) => g.type !== "adjudicate").length;

Deno.test("B1 首輪：每一列都與舊的整表 UPDATE 相同，非 adjudicate 全部重算並進快取", async () => {
  const db = await freshDb(MIG);
  await loadGaps(db, GAPS);
  const miss = await runBoth(db);
  assertEquals(miss, NONADJ);
  assertEquals(await diff(db), 0);
  assertEquals(Number(await scalar(db, "SELECT count(*) FROM _gaps WHERE priority_seconds IS NULL")), 0);
  assertEquals(Number(await scalar(db, "SELECT count(*) FROM task_priority_cache")), NONADJ);
  // 輸出真的有東西（不是全 0 的空比對）
  assert(Number(await scalar(db, "SELECT count(DISTINCT priority_seconds) FROM _gaps")) >= 5);
});

Deno.test("B2 第二輪什麼都沒變：不重算任何列，輸出仍與舊的相同", async () => {
  const db = await freshDb(MIG);
  await loadGaps(db, GAPS);
  await runBoth(db);
  await loadGaps(db, GAPS);
  const miss = await runBoth(db);
  assertEquals(miss, 0);
  assertEquals(await diff(db), 0);
});

Deno.test("B3 目標變了：只重算那一列，輸出與舊的相同", async () => {
  const db = await freshDb(MIG);
  await loadGaps(db, GAPS);
  await runBoth(db);
  const changed = GAPS.map((g) => (g.id === "auto:profile_gap:p1" ? { ...g, target: { ...g.target, election_id: 2022 } } : g));
  await loadGaps(db, changed);
  const miss = await runBoth(db);
  assertEquals(miss, 1);
  assertEquals(await diff(db), 0);
});

Deno.test("B4 插隊旗標變了（既有列 boost_seconds 歸零、手動臂 manual_front 變）：重算且與舊的相同", async () => {
  const db = await freshDb(MIG);
  await loadGaps(db, GAPS);
  await runBoth(db);
  await db.exec("UPDATE task_dispatches SET boost_seconds = 0 WHERE task_id = 'auto:boosted:1'");
  await db.exec("INSERT INTO task_dispatches VALUES ('manual-front-1', 0)");  // 既有列、沒插隊：旗標由「手動臂」變「看列」
  await loadGaps(db, GAPS);
  const miss = await runBoth(db);
  assertEquals(miss, 2);
  assertEquals(await diff(db), 0);
});

Deno.test("B5 參選紀錄職位變了：觸發器標該人物名下的快取列，只重算那些列，輸出與舊的相同", async () => {
  const db = await freshDb(MIG);
  await loadGaps(db, GAPS);
  await runBoth(db);
  await db.exec(`UPDATE politician_elections SET election_type = '村里長' WHERE politician_id = '${P1}'`);
  assertEquals(Number(await scalar(db, "SELECT count(*) FROM task_priority_cache WHERE stale")), 2);  // P1 名下兩列
  await loadGaps(db, GAPS);
  const miss = await runBoth(db);
  assertEquals(miss, 2);
  assertEquals(await diff(db), 0);
  assertEquals(Number(await scalar(db, "SELECT count(*) FROM task_priority_cache WHERE stale")), 0);
});

Deno.test("B6 參選紀錄新增／刪除也失效（P3 原本只有縣市議員）", async () => {
  const db = await freshDb(MIG);
  await loadGaps(db, GAPS);
  await runBoth(db);
  await db.exec(`DELETE FROM politician_elections WHERE politician_id = '${P3}'`);
  await loadGaps(db, GAPS);
  assertEquals(await runBoth(db), 1);
  assertEquals(await diff(db), 0);
  await db.exec(`INSERT INTO politician_elections (politician_id, election_id, election_type) VALUES ('${P3}', 2026, '縣市長')`);
  await loadGaps(db, GAPS);
  assertEquals(await runBoth(db), 1);
  assertEquals(await diff(db), 0);
});

Deno.test("B7 選舉日期變了：全域版本加 1，全部非 adjudicate 重算，輸出與舊的相同（含插隊列的最新一屆基準）", async () => {
  const db = await freshDb(MIG);
  await loadGaps(db, GAPS);
  await runBoth(db);
  const e0 = Number(await scalar(db, "SELECT epoch FROM task_priority_cache_state"));
  await db.exec("UPDATE elections SET election_date = '2028-11-25' WHERE id = 2026");
  assertEquals(Number(await scalar(db, "SELECT epoch FROM task_priority_cache_state")), e0 + 1);
  await loadGaps(db, GAPS);
  assertEquals(await runBoth(db), NONADJ);
  assertEquals(await diff(db), 0);
  // 不碰日期與事由的更新不動版本
  await db.exec("UPDATE elections SET id = id WHERE id = 2022");
  assertEquals(Number(await scalar(db, "SELECT epoch FROM task_priority_cache_state")), e0 + 1);
});

Deno.test("B8 adjudicate 不快取：交件職位變了不用任何失效，輸出仍與舊的相同", async () => {
  const db = await freshDb(MIG);
  await loadGaps(db, GAPS);
  await runBoth(db);
  assertEquals(Number(await scalar(db, "SELECT count(*) FROM task_priority_cache WHERE task_id = 'auto:adj:1'")), 0);
  await db.exec("UPDATE fake_contrib_level SET lvl = '村里長'");
  await loadGaps(db, GAPS);
  const miss = await runBoth(db);
  assertEquals(miss, 0);
  assertEquals(await diff(db), 0);
});

Deno.test("B9 缺口消失：快取列跟著清掉", async () => {
  const db = await freshDb(MIG);
  await loadGaps(db, GAPS);
  await runBoth(db);
  await loadGaps(db, GAPS.filter((g) => g.id !== "auto:other:1"));
  await runBoth(db);
  assertEquals(Number(await scalar(db, "SELECT count(*) FROM task_priority_cache WHERE task_id = 'auto:other:1'")), 0);
  assertEquals(await diff(db), 0);
});

Deno.test("B10 24 小時輪替：失效漏接（快取被改壞）輪到那一桶就自癒", async () => {
  const db = await freshDb(MIG);
  await loadGaps(db, GAPS);
  await runBoth(db);
  await db.exec("UPDATE task_priority_cache SET static_seconds = 1 WHERE task_id = 'auto:profile_gap:p1'");
  await loadGaps(db, GAPS);
  await runBoth(db);  // 桶號 -1＝不輪到：沒偵測到，輸出與舊的不同（證明測試的確能看出差異）
  assert(await diff(db) > 0);
  const bucket = Number(await scalar(db, "SELECT (hashtext('auto:profile_gap:p1')::bigint & 2147483647) % 144"));
  await loadGaps(db, GAPS);
  const miss = await runBoth(db, bucket);
  assert(miss >= 1);
  assertEquals(await diff(db), 0);
  // 144 桶合起來每一列都會輪到
  const seen = new Set<number>();
  for (const g of GAPS) seen.add(Number(await scalar(db, `SELECT (hashtext('${g.id}')::bigint & 2147483647) % 144`)));
  assert([...seen].every((b) => b >= 0 && b < 144));
});

// ============================================================
// C. 還原驗證：失效觸發器壞掉，B5 的情境必須與舊的不同
// ============================================================
Deno.test("C1 還原驗證：參選紀錄觸發器不標 stale，職位變了輸出就與舊的不同", async () => {
  const broken = mutate(MIG, "SET stale = true WHERE pid = OLD.politician_id AND NOT stale", "SET stale = false WHERE pid = OLD.politician_id AND NOT stale");
  const db = await freshDb(broken);
  await loadGaps(db, GAPS);
  await runBoth(db);
  await db.exec(`UPDATE politician_elections SET election_type = '村里長' WHERE politician_id = '${P1}'`);
  await loadGaps(db, GAPS);
  await runBoth(db);
  assertNotEquals(await diff(db), 0, "觸發器壞了卻沒被測出來");
});

Deno.test("C2 還原驗證：選舉觸發器不加版本，日期變了輸出就與舊的不同", async () => {
  const broken = mutate(MIG, "SET epoch = epoch + 1 WHERE id = 1", "SET epoch = epoch + 0 WHERE id = 1");
  const db = await freshDb(broken);
  await loadGaps(db, GAPS);
  await runBoth(db);
  await db.exec("UPDATE elections SET election_date = '2028-11-25' WHERE id = 2026");
  await loadGaps(db, GAPS);
  await runBoth(db);
  assertNotEquals(await diff(db), 0, "觸發器壞了卻沒被測出來");
});

Deno.test("C3 還原驗證：sig 不含插隊旗標，旗標變了輸出就與舊的不同", async () => {
  const broken = mutate(MIG, "|| COALESCE(x.boosted, false)::TEXT || '|' ||", "|| '|' ||");
  const db = await freshDb(broken);
  await loadGaps(db, GAPS);
  await runBoth(db);
  await db.exec("UPDATE task_dispatches SET boost_seconds = 0 WHERE task_id = 'auto:boosted:1'");
  await loadGaps(db, GAPS);
  await runBoth(db);
  assertNotEquals(await diff(db), 0, "sig 少了旗標卻沒被測出來");
});
