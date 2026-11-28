/**
 * seed_auto_task_queue 暫存表瘦身（migration 20261119170000_seed_narrow_temp_tables.sql）。
 *
 * 起因：seed 每 10 分鐘一輪，_gaps_all／_gaps 各帶全部寬欄（約 3.2 萬列 × 約 1.4 KB），_gaps 又被 UPDATE 好幾次整列重寫。
 * 這支只把 _gaps 縮成要讀要改的欄位（task_id、src_rn、arm、target、opened_by），寬欄留在 _gaps_all、寫進 task_dispatches 時用 src_rn 取回；
 * 結果（task_dispatches 的每一列每一欄）一個字都不能變。
 *
 *   A. 文字層：函式帶 statement_timeout 與 work_mem；_gaps 沒有寬欄；沒有任何地方還從 _gaps 讀寬欄；只有 seed 一支函式被重定義
 *   B. PGlite：上一版（取自 migrations 最新定義）與這一版從同一個狀態各跑一次，逐輪比 task_dispatches 全部欄位完全相同
 *      （首次入列、什麼都沒變、六個內容欄各變一次、收回與新增、被濾掉列的窗口收回、換號沿用位置、流量提層、需求疊加、重複 task_id）
 *   C. 還原驗證：把回取寬欄的連接改壞，B 要紅
 *
 * 除了 seed 本體，其餘函式都是 stub（回放 _arms 表等）：這裡測的是「seed 怎麼用暫存表」，不是各臂與各規則。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261119170000_seed_narrow_temp_tables.sql";
const MIG = await readMig(MIG_NAME);
const NEW_SEED = fnText(MIG, "seed_auto_task_queue");
const OLD_SEED = await latestFn("seed_auto_task_queue", MIG_NAME);
const codeOf = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 函式定義帶 statement_timeout＝280s 與 work_mem＝16MB（CREATE OR REPLACE 會洗掉 ALTER FUNCTION 設的值）", () => {
  const head = NEW_SEED.slice(0, NEW_SEED.indexOf("AS $$"));
  assert(/SET statement_timeout = '280s'/.test(head));
  assert(/SET work_mem = '16MB'/.test(head));
});

Deno.test("A2 這支只重定義 seed_auto_task_queue，函式之外只有 NOTIFY；沒有 schema 變動", () => {
  const defs = [...MIG.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]);
  assertEquals(defs, ["seed_auto_task_queue"]);
  const outside = codeOf(MIG.replace(NEW_SEED, "")).replace(/'(?:[^']|'')*'/g, "''");
  assert(!/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE)\b/i.test(outside), "函式之外不該有 DDL／DML");
});

Deno.test("A3 這支是 seed 的最後一版，緊接著 20261114010000", async () => {
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION seed_auto_task_queue(")) defining.push(n);
  const i = defining.indexOf(MIG_NAME);
  assert(i > 0);
  assertEquals(defining[i - 1], "20261114010000_election_type_priority_days.sql", "前一版變了：要以最新的為底重做");
  assertEquals(defining.slice(i + 1), ["20261121193000_priority_bands.sql", "20261126150000_seed_arm_timings.sql", "20261126180000_dispatch_gaps_phase0b.sql", "20261127110000_seed_priority_skip_locked.sql", "20261127120000_gap_drain_batch.sql", "20261128020000_seed_priority_cache.sql"],"這支之後只允許層級×種類帶狀優先（守門在 priority-bands.test.ts）與各段計時（守門在 seed-arm-timings.test.ts）；又有人改了 seed：後合併的以最新那版為底重做，並更新各 seed 守門測試的版本清單");
});

Deno.test("A4 _gaps 只帶 task_id、src_rn、arm、target、opened_by；寬欄不進 _gaps，也沒有人從 _gaps 讀寬欄", () => {
  const create = /CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON \(g\.task_id\) ([^\n]*?) FROM _gaps_all g/.exec(NEW_SEED);
  assert(create, "找不到 _gaps 的建表句");
  assertEquals(create[1], "g.task_id, g.rn AS src_rn, g.arm, g.target, g.opened_by");
  const code = codeOf(NEW_SEED);
  for (const wide of ["task_type", "what_we_need", "hint_sources", "reward", "region"]) {
    assert(!new RegExp(`\\bg\\.${wide}\\b`).test(code), `不該再有 g.${wide}（_gaps 沒有這欄）`);
  }
  // 寬欄只從 _gaps_all（別名 a）取，連接鍵是 rn
  assertEquals((code.match(/JOIN _gaps_all a ON a\.rn = g\.src_rn/g) ?? []).length, 2, "內容 UPDATE 與新缺口 INSERT 各回取一次");
  assert(/CREATE UNIQUE INDEX ON _gaps_all \(rn\)/.test(code));
});

Deno.test("A5 往內容 UPDATE 加欄位時條件也要同步：SET 的欄、比較的左右兩邊一致（同 seed-skip-unchanged A5，來源改成 a.）", () => {
  const set = /UPDATE task_dispatches d SET ([\s\S]*?), refreshed_at = now\(\)/.exec(NEW_SEED)![1].split(",").map((s) => s.trim());
  const setCols = set.map((s) => s.split(" = ")[0]);
  const [, left, right] = /AND \(([^)]*)\) IS DISTINCT FROM \(([^)]*)\);/.exec(NEW_SEED)!;
  assertEquals(left.split(",").map((s) => s.trim().replace(/^d\./, "")), setCols);
  assertEquals(right.split(",").map((s) => s.trim().replace(/^[ag]\./, "")), setCols);
  assertEquals(setCols, ["task_type", "target", "what_we_need", "hint_sources", "reward", "region"]);
});

Deno.test("A6 選舉年優先與選舉類別提前併成一次 UPDATE，且與上一版兩次依序 UPDATE 同義（第一項回 NULL 時先當 0）", () => {
  assert(!/UPDATE _gaps g SET priority_seconds = COALESCE\(g\.priority_seconds, 0\) \+ election_year_priority_seconds/.test(NEW_SEED));
  assert(NEW_SEED.includes("COALESCE(COALESCE(g.priority_seconds, 0) + election_year_priority_seconds(election_id_or_null(g.target->>'election_id')), 0) + election_type_priority_seconds(g.target)"));
  assert(OLD_SEED.includes("election_type_priority_seconds(g.target);"));
});

// ============================================================
// B. PGlite 逐欄等價
// ============================================================
const SCHEMA = `
CREATE TABLE _arms (task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text, arm text, opened_by jsonb);
CREATE TABLE task_dispatches (
  task_id text PRIMARY KEY, last_dispatched_at timestamptz NOT NULL DEFAULT now(), queue_at timestamptz NOT NULL DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 0,
  task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text, refreshed_at timestamptz, opened_at timestamptz, opened_by jsonb,
  priority_seconds integer NOT NULL DEFAULT 0, boost_seconds integer NOT NULL DEFAULT 0, work_key text);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'pending', bundle_id uuid, bundle_released_at timestamptz);
CREATE TABLE queue_settings (id integer PRIMARY KEY, demand_enabled boolean NOT NULL DEFAULT false, rekey_keep_position boolean NOT NULL DEFAULT true);
INSERT INTO queue_settings VALUES (1);
CREATE TABLE traffic_boost_settings (id integer PRIMARY KEY, enabled boolean NOT NULL, boost_seconds integer NOT NULL);
INSERT INTO traffic_boost_settings VALUES (1, true, 5000);
CREATE TABLE work_cards (work_key text PRIMARY KEY, demand_seconds integer NOT NULL DEFAULT 0);
CREATE FUNCTION contribution_auto_tasks_arms() RETURNS TABLE (task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text, arm text, opened_by jsonb)
  LANGUAGE sql STABLE AS $$ SELECT a.task_id, a.task_type, a.target, a.what_we_need, a.hint_sources, a.reward, a.region, a.arm, a.opened_by FROM _arms a $$;
CREATE FUNCTION activity_priority_seconds(p_arm text, p_eid integer, p_etype text) RETURNS TABLE (seconds integer, rule_id bigint)
  LANGUAGE sql STABLE AS $$ SELECT length(p_arm) * 100 + COALESCE(p_eid, 0) % 7, 7::bigint $$;
CREATE FUNCTION election_id_or_null(t text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN t ~ '^[0-9]+$' THEN t::integer END $$;
CREATE FUNCTION election_year_priority_seconds(e integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN e IS NULL THEN 5 WHEN e = 1999 THEN NULL ELSE (e - 2000) * 100 END $$;
CREATE FUNCTION election_type_priority_seconds(t jsonb) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT CASE t->>'election_type' WHEN '縣市長' THEN 600 WHEN '縣市議員' THEN 400 ELSE 0 END $$;
-- 流量提層：和真的一樣只讀 _gaps 的 task_id／target／priority_seconds、改 opened_by
CREATE FUNCTION traffic_boost_apply() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  UPDATE _gaps g SET opened_by = COALESCE(g.opened_by, '{}'::jsonb) || '{"traffic_boost": true}'::jsonb
   WHERE g.target->>'hot' = '1' AND COALESCE(g.priority_seconds, 0) < 5000;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
CREATE FUNCTION work_card_demand_refresh() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION task_rekey_stable_key(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN t LIKE 'auto:rk:%' THEN regexp_replace(t, ':[^:]*$', '') END $$;
CREATE FUNCTION queue_slot(k text) RETURNS timestamptz LANGUAGE sql AS $$ SELECT now() $$;
CREATE FUNCTION manual_front_seconds(t text) RETURNS integer LANGUAGE sql AS $$ SELECT 11 $$;
CREATE FUNCTION bundle_carrier_id(b uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION refresh_dispatch_blocked() RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION refresh_verify_targets() RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION manual_front_pull() RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION refresh_verify_ticket_keys() RETURNS void LANGUAGE sql AS $$ SELECT $$;
`;

async function env(newSeed: string = NEW_SEED): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(OLD_SEED.replace("CREATE OR REPLACE FUNCTION seed_auto_task_queue()", "CREATE OR REPLACE FUNCTION seed_auto_task_queue_old()"));
  await db.exec(newSeed);
  return db;
}

const WIDE = "說明".repeat(40);
type Gap = { id: string; type?: string; target?: Record<string, unknown> | null; need?: string; hint?: string[] | null; reward?: number | null; region?: string | null; arm?: string; kept?: boolean; ob?: Record<string, unknown> };
const lit = (v: unknown) => (v === null || v === undefined ? "NULL" : `'${String(typeof v === "object" ? JSON.stringify(v) : v).replaceAll("'", "''")}'`);
const arr = (a: string[] | null | undefined) => (a === null || a === undefined ? "NULL" : `ARRAY[${a.map(lit).join(",")}]::text[]`);
const row = (g: Gap) =>
  `(${lit("auto:" + g.id)}, ${lit(g.type ?? "t_" + g.id)}, ${lit(g.target === undefined ? { election_id: 2026, election_type: "縣市議員", k: g.id } : g.target)}::jsonb, ${lit(g.need ?? WIDE + g.id)}, ${arr(g.hint === undefined ? ["h1", "h2"] : g.hint)}, ${g.reward === undefined ? 1 : g.reward}, ${lit(g.region === undefined ? "台北市" : g.region)}, ${lit(g.arm ?? "arm_a")}, ${g.kept === false ? "NULL" : lit(g.ob ?? { arm: g.arm ?? "arm_a", basis: "rule" })}::jsonb)`;
export const setArms = (gs: Gap[]) => `DELETE FROM _arms; ${gs.length ? `INSERT INTO _arms VALUES ${gs.map(row).join(",")};` : ""}`;

/** task_dispatches 全部欄位的快照；時間欄存「與這個交易 now() 的差」，兩個資料庫各自的 now() 不同也比得起來 */
const snap = async (db: PGlite): Promise<string> =>
  (await db.query<{ j: string }>(
    `SELECT coalesce(jsonb_agg((to_jsonb(t) - 'queue_at' - 'opened_at' - 'refreshed_at' - 'last_dispatched_at' - 'opened_by')
        || jsonb_build_object('qa', t.queue_at - now(), 'oa', t.opened_at - now(), 'ra', t.refreshed_at - now(), 'lda', t.last_dispatched_at - now(),
                              'ob', t.opened_by - 'chain_opened_at', 'cho', (t.opened_by->>'chain_opened_at')::timestamptz - now()) ORDER BY t.task_id), '[]')::text AS j
       FROM task_dispatches t WHERE t.task_id <> 'auto:dupe'`)).rows[0]!.j; // 重複 task_id 那列改前沒有決勝欄（取哪列不固定），改後固定取最小 rn：另外在 B1 單獨斷言
const count = async (db: PGlite): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*) n FROM task_dispatches`)).rows[0]!.n);

/**
 * 兩個資料庫同一套設定：A 跑上一版、B 跑這一版，每一輪做同樣的改動後各跑一次 seed，比 task_dispatches 與回傳值。
 * 不用同一個資料庫「SAVEPOINT／ROLLBACK」輪流跑：PGlite 在回滾暫存表的建立之後再建同名暫存表，會把別的暫存表連接的結果弄錯（正式庫每輪都是獨立交易，沒有這個情形）。
 */
async function scenario(newSeed: string = NEW_SEED): Promise<{ same: boolean[]; ret: boolean[]; counts: number[]; final: string; rekeyed: boolean; dupeTypes: string[] }> {
  const A = await env();
  const B = await env(newSeed);
  const same: boolean[] = [];
  const ret: boolean[] = [];
  const counts: number[] = [];
  const dupeTypes: string[] = [];
  const both = async (sql: string) => { await A.exec(sql); await B.exec(sql); };
  await both("BEGIN");
  async function round(label: string, setup: string) {
    if (setup) await both(setup);
    const oldRet = (await A.query<{ v: number }>(`SELECT seed_auto_task_queue_old() AS v`)).rows[0]!.v;
    const newRet = (await B.query<{ v: number }>(`SELECT seed_auto_task_queue() AS v`)).rows[0]!.v;
    const oldSnap = await snap(A);
    const newSnap = await snap(B);
    if (oldSnap !== newSnap) console.error(`[parity] 第「${label}」輪改前改後不同`);
    same.push(oldSnap === newSnap);
    ret.push(oldRet === newRet);
    counts.push(await count(B));
    dupeTypes.push((await B.query<{ t: string }>(`SELECT task_type t FROM task_dispatches WHERE task_id = 'auto:dupe'`)).rows[0]!.t);
  }
  const base: Gap[] = [
    { id: "a1" }, { id: "a2", arm: "arm_b" }, { id: "a3", target: null }, { id: "a4", hint: null, reward: null, region: null },
    { id: "hot1", target: { hot: "1", election_id: 2026 } }, { id: "y1999", target: { election_id: 1999 } },
    { id: "rk1", target: { election_id: 2026, election_type: "縣市長" } }, { id: "w1", arm: "arm_c" },
    { id: "dupe", type: "t_dupe_first", reward: 7 }, { id: "dupe", type: "t_dupe_second", reward: 8 }, // 同一個 task_id 兩列內容不同：只留最小 rn 那列（先出現者）、INSERT 不能重複
    { id: "filtered", kept: false },   // opened_by 為 NULL：只在 _gaps_all（拿來分辨收回原因），不進 _gaps
  ];
  await both(`INSERT INTO contributions (id, status) VALUES ('00000000-0000-4000-8000-000000000001', 'pending'), ('00000000-0000-4000-8000-000000000002', 'pending'), ('00000000-0000-4000-8000-000000000003', 'verified')`);
  await round("0 首次入列", setArms(base));
  await round("1 什麼都沒變", "");
  await round("2 又一輪", "");
  const changed = base.map((g) => ({ ...g }));
  const edit = (id: string, f: Partial<Gap>) => Object.assign(changed.find((g) => g.id === id)!, f);
  edit("a1", { type: "t_changed" });
  edit("a2", { target: { election_id: 2026, election_type: "縣市長", z: 1 } });
  edit("a3", { need: "改過的說明" });
  edit("a4", { hint: ["x"] });
  edit("hot1", { reward: 9 });
  edit("y1999", { region: "高雄市" });
  await round("3 六個內容欄各變一次", setArms(changed));
  // 被濾掉的列原本有派工列：收回（窗口）；另一列整個消失：收回（補上）；新缺口入列
  await both(`INSERT INTO task_dispatches (task_id, dispatch_count, task_type, target, opened_by) VALUES ('auto:filtered', 3, 'x', '{}', '{}'), ('auto:gone', 4, 'x', '{}', '{}')`);
  const next = changed.filter((g) => g.id !== "w1").concat([{ id: "n1", arm: "arm_d" }, { id: "n2", target: { election_id: 2022, election_type: "村里長" } }]);
  await round("4 收回與新增", setArms(next));
  // 換號沿用位置：rk1 的穩定鍵相同、末段指紋換了（舊列改名成 auto:rk:S:fp1，新缺口是 auto:rk:S:fp2）
  await both(`UPDATE task_dispatches SET dispatch_count = 6, last_dispatched_at = now() - INTERVAL '40 days', boost_seconds = 33 WHERE task_id = 'auto:rk1'`);
  await both(setArms(next.map((g) => (g.id === "rk1" ? { ...g, id: "rk:S:fp2" } : g))));
  await both(`UPDATE task_dispatches SET task_id = 'auto:rk:S:fp1' WHERE task_id = 'auto:rk1'`);
  await round("5 換號沿用排隊位置", "");
  const rekeyed = Number((await B.query<{ n: string }>(`SELECT count(*) n FROM task_dispatches WHERE opened_by->>'rekey_of' = 'auto:rk:S:fp1' AND dispatch_count = 6 AND boost_seconds = 33`)).rows[0]!.n) === 1;
  // 需求疊加：旗標開、對應工作卡有秒數
  await both(`UPDATE task_dispatches SET work_key = 'wk1' WHERE task_id IN ('auto:a1', 'auto:n1'); INSERT INTO work_cards VALUES ('wk1', 777); UPDATE queue_settings SET demand_enabled = true`);
  await round("6 需求疊加", "");
  await both(`UPDATE queue_settings SET rekey_keep_position = false`);
  await round("7 關閉換號沿用", setArms(next.map((g) => (g.id === "rk1" ? { ...g, id: "rk:S:fp3" } : g))));
  const final = await snap(B);
  await A.close();
  await B.close();
  return { same, ret, counts, final, rekeyed, dupeTypes };
}

Deno.test("B1 逐輪等價：改前與改後的 task_dispatches 每一列每一欄完全相同、回傳值相同", async () => {
  const r = await scenario();
  assertEquals(r.same, r.same.map(() => true), `各輪相同：${r.same}`);
  assertEquals(r.ret, r.ret.map(() => true), "seed 回傳值相同");
  assertEquals(r.dupeTypes, r.dupeTypes.map(() => "t_dupe_first"), "同一 task_id 兩列內容不同：每輪都固定取最小 rn（先出現）那列");
  // 非空：第一輪入列 9 個不同 task_id 加 2 張驗證票＝11 列；之後有成長
  assertEquals(r.counts[0], 11);
  assert(r.counts[4]! > r.counts[0]!, `收回與新增後列數變了：${r.counts}`);
  assert(r.final.includes('"traffic_boost": true'), "流量提層的標記確實寫進了派工列");
  assert(r.final.includes("t_changed") && r.final.includes("改過的說明"), "內容變更確實寫進了派工列");
  assert(r.rekeyed, "換號沿用有發生：新列沿用舊列的派出次數與插隊秒數");
});

Deno.test("B2 寬欄值真的寫進去了（不是兩邊都空）：入列的列帶著 what_we_need、hint_sources、task_type、reward、region", async () => {
  const db = await env();
  await db.exec(setArms([{ id: "w", need: "這是一段說明", hint: ["u1", "u2"], reward: 3, region: "新北市", type: "tt" }]));
  await db.exec("SELECT seed_auto_task_queue()");
  const r = (await db.query<{ task_type: string; what_we_need: string; hint_sources: string[]; reward: number; region: string; priority_seconds: number }>(
    `SELECT task_type, what_we_need, hint_sources, reward, region, priority_seconds FROM task_dispatches WHERE task_id = 'auto:w'`)).rows[0]!;
  assertEquals(r.task_type, "tt");
  assertEquals(r.what_we_need, "這是一段說明");
  assertEquals(r.hint_sources, ["u1", "u2"]);
  assertEquals(r.reward, 3);
  assertEquals(r.region, "新北市");
  // arm_a(5 字)*100 + 2026 % 7(＝3) ＋ 選舉年 2600 ＋ 議員 400
  assertEquals(r.priority_seconds, 500 + 3 + 2600 + 400);
  await db.close();
});

// ============================================================
// C. 還原驗證
// ============================================================
Deno.test("C1 還原驗證：INSERT 回取寬欄的連接改壞（rn 固定 1），B1 要紅", async () => {
  const bad = mutate(NEW_SEED, "    JOIN _gaps_all a ON a.rn = g.src_rn  -- 暫存表瘦身：寬欄從 _gaps_all 取\n    LEFT JOIN _rekey_prev", "    JOIN _gaps_all a ON a.rn = 1  -- 壞\n    LEFT JOIN _rekey_prev");
  const r = await scenario(bad);
  assert(r.same.includes(false), "改壞後至少一輪與改前不同");
});

Deno.test("C2 還原驗證：併 UPDATE 時漏掉 COALESCE（第一項回 NULL 會讓整個秒數變 NULL），B1 要紅", async () => {
  const bad = mutate(NEW_SEED, "COALESCE(COALESCE(g.priority_seconds, 0) + election_year_priority_seconds(election_id_or_null(g.target->>'election_id')), 0) + election_type_priority_seconds(g.target)", "COALESCE(g.priority_seconds, 0) + election_year_priority_seconds(election_id_or_null(g.target->>'election_id')) + election_type_priority_seconds(g.target)");
  const r = await scenario(bad);
  assert(r.same.includes(false), "y1999 那列（年份函式回 NULL）要讓兩邊不同");
});

Deno.test("C3 還原驗證：內容 UPDATE 的比較少看 a.region，區域變了不會被寫進去，B1 要紅", async () => {
  const bad = mutate(NEW_SEED, "(a.task_type, g.target, a.what_we_need, a.hint_sources, a.reward, a.region);", "(a.task_type, g.target, a.what_we_need, a.hint_sources, a.reward, d.region);");
  const r = await scenario(bad);
  assert(r.same.includes(false));
});
