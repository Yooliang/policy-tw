/**
 * 公報上網日偵測的資料庫段（migration 20261008113000_bulletin_watch.sql 的 milestone 與 auth 兩段，PGlite 真的跑）。
 * cron.schedule／net.http_post 要 pg_cron、pg_net，PGlite 沒有，那一段只做文字守門（bulletin-watch.test.ts）。
 *
 * 守什麼：
 *   1. 單一真相：回填只替 elections.bulletin_published_on 有值的列建預估里程碑（2026 一列、expected／statutory），2022、2024（NULL＝已上架）不建；
 *      elections.bulletin_published_on 是衍生——直接 INSERT／UPDATE 一律被擋，改里程碑那一列才會變（新增／修改／刪除都跟）。
 *   2. 偵測：bulletin_watch_targets 只列「有 bulletin_dir、整場里程碑還不是 done」的選舉，hot 模式只留預估日前後 14 天內（含頭含尾）；
 *      bulletin_watch_mark_published 把預估改成偵測當天、done、official，欄位跟著變，原預估與依據寫進 note，edit_history 留舊值新值；重複呼叫不動；沒有那一列回 NULL。
 *   3. 權限：兩支 RPC 與密鑰驗證函式只有 service_role 能執行（anon／authenticated／PUBLIC 都不行）；密鑰驗證只認自己的那一筆 Vault 密鑰。
 *   4. 重跑安全：同一支 migration 再套一次，不多建密鑰、不改已偵測到的列。
 *   5. 還原驗證：把 migration 文字改壞一處（精確改一處，改不到就失敗），對應的守門必須紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const MIG = await read("20261008113000_bulletin_watch.sql");
const P0 = await read("20261008001000_activity_windows_p0.sql");

/** 從 start 起（含）到 end 第一次出現為止（含 end） */
function between(sql: string, start: string, end: string): string {
  const a = sql.indexOf(start);
  assert(a >= 0, `找不到起點：${start.slice(0, 50)}`);
  const b = sql.indexOf(end, a);
  assert(b >= 0, `找不到終點：${end.slice(0, 50)}`);
  return sql.slice(a, b + end.length);
}
function section(sql: string, name: string): string {
  return between(sql, `-- ▼▼ SECTION: ${name} ▼▼`, `-- ▲▲ SECTION: ${name} ▲▲`);
}
/** 精確改一處：改不到或改到兩處都算失敗 */
function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 60)}`);
  return sql.replace(from, () => to);
}

// P0 的真實定義（不是在測試裡另寫一份）：里程碑表與唯一索引、審計與 updated_at 觸發器函式、activity_today
const P0_TABLE = between(P0, "CREATE TABLE IF NOT EXISTS election_milestones (", "(COALESCE(election_type, '')));");
const P0_AUDIT = between(P0, "CREATE OR REPLACE FUNCTION activity_audit()", "\n$$;");
const P0_TOUCH = between(P0, "CREATE OR REPLACE FUNCTION activity_touch_updated_at()", "$$;");
const P0_TODAY = between(P0, "CREATE OR REPLACE FUNCTION activity_today(", "$$;");
const P0_TRIGGERS = [
  "CREATE TRIGGER trg_election_milestones_touch BEFORE UPDATE ON election_milestones FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();",
  "CREATE TRIGGER trg_election_milestones_audit AFTER INSERT OR UPDATE OR DELETE ON election_milestones FOR EACH ROW EXECUTE FUNCTION activity_audit();",
];
for (const t of P0_TRIGGERS) assert(P0.includes(t), "P0 的觸發器寫法變了，這支測試要跟著改");

// 佇列優先層（#443，已在 main）的真實定義：它的視圖（多一段讀 elections.bulletin_published_on）、它的種子規則（「公報之前」降級）。
// 這支 migration 要把視圖拿回 P0 的寫法、把那條規則改成接受預估日期，所以測試先裝 #443 的原版，再套這支，比對前後。
const QP = await read("20261008090000_queue_priority_tiers.sql");
const P0_VIEW = between(P0, "CREATE OR REPLACE VIEW election_milestones_all AS", "WHERE election_term_end(e.id, t.election_type) IS NOT NULL;");
const QP_VIEW = between(QP, "CREATE OR REPLACE VIEW election_milestones_all AS",
  "AND NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = e.id AND m.kind = 'bulletin_published' AND m.election_type IS NULL);");
const QP_RULES = between(QP, "INSERT INTO activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, election_types, priority, note)",
  "WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.priority IS NOT NULL);");
const P0_RULES_TABLE = between(P0, "CREATE TABLE IF NOT EXISTS activity_rules (", "\n);");
const P0_OVERRIDES_TABLE = between(P0, "CREATE TABLE IF NOT EXISTS activity_overrides (", "\n);");
const P0_HELPERS = ["activity_level(p_election_type TEXT)", "activity_jurisdiction(p_election_id INTEGER)", "activity_status_rank(p_status TEXT)"]
  .map((sig) => between(P0, `CREATE OR REPLACE FUNCTION ${sig}`, "$$;")).join("\n");
const P0_OPEN = between(P0, "CREATE OR REPLACE FUNCTION activity_open(", "\n$$;");

const SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE elections (id integer PRIMARY KEY, election_key text, election_date date, election_reason text, election_types text[], bulletin_dir text, bulletin_hint text, bulletin_published_on date);
CREATE TABLE sources (id bigserial PRIMARY KEY, url text);
CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text NOT NULL, record_id text NOT NULL, field text NOT NULL, old_value jsonb, new_value jsonb,
  contribution_id uuid, agent_name text, applied_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz, reverted_by text);
${P0_TABLE}
${P0_AUDIT}
${P0_TOUCH}
${P0_TODAY}
${P0_TRIGGERS.join("\n")}
${P0_RULES_TABLE}
ALTER TABLE activity_rules ADD COLUMN priority SMALLINT; -- #443 加的欄位（外鍵與命名空間檢查不影響這裡，省略）
${P0_OVERRIDES_TABLE}
-- activity_health（P1 的視圖，這支加一段）用到的：roster_check_scope 表、臂名清單函式（這裡不需要，回空陣列）
CREATE TABLE roster_check_scope (election_id integer NOT NULL, election_type text NOT NULL, registration_closed_on date, list_announced_on date);
CREATE FUNCTION activity_arm_names() RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY[]::text[] $$;
${P0_HELPERS}
-- 任期起訖：這裡不需要（視圖只用 polling 與 bulletin_published），回 NULL 讓 term 兩段不產生列
CREATE FUNCTION election_term_start(integer, text) RETURNS date LANGUAGE sql AS $$ SELECT NULL::date $$;
CREATE FUNCTION election_term_end(integer, text) RETURNS date LANGUAGE sql AS $$ SELECT NULL::date $$;
${P0_VIEW}
${QP_VIEW}
${P0_OPEN}
-- Vault 與 pgcrypto 的替身：digest 回原字串的位元組（比摘要＝比字串），create_secret 寫進替身表
CREATE SCHEMA vault; CREATE SCHEMA extensions;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
CREATE FUNCTION extensions.digest(t text, a text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT convert_to(t, 'UTF8') $$;
CREATE FUNCTION extensions.gen_random_bytes(n integer) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(repeat('ab', n), 'hex') $$;
CREATE FUNCTION vault.create_secret(new_secret text, new_name text, new_description text) RETURNS uuid LANGUAGE sql
  AS $$ INSERT INTO vault.decrypted_secrets VALUES (new_name, new_secret) RETURNING gen_random_uuid() $$;
`;

const HINT_EE = (dir: string) => `https://eebulletin.cec.gov.tw/?dir=${dir} ← 中選會公報`;
/** 「公報之前」降級規則（priority:raw:policy_missing）在 2026 某職位、某一天開不開（0／1 列） */
const demotionOpen = async (db: PGlite, type: string, today: string) =>
  (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM activity_open('priority:raw:policy_missing', 2026, $1::text, $2::date)`, [type, today])).n;
const DEMOTION_DAYS = ["2026-10-08", "2026-11-17", "2026-11-18", "2026-11-19"];
const demotionDays = async (db: PGlite, type: string) => {
  const out: number[] = [];
  for (const d of DEMOTION_DAYS) out.push(await demotionOpen(db, type, d));
  return out;
};

interface Built {
  db: PGlite;
  migSql: string;
  /** 套這支 migration 之前（#443 的原版視圖＋種子規則）：村里長／縣市長的降級規則逐日開關 */
  baseline: { village: number[]; mayor: number[] };
}
async function buildDb(mutateMig: (sql: string) => string = (s) => s): Promise<Built> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  // migration 前的狀態（20261008000002 之後）：2022、2024 的 bulletin_published_on 是 NULL＝已上架；2026 暫填 11-18
  await db.exec(`INSERT INTO elections (id, election_key, election_date, election_reason, election_types, bulletin_dir, bulletin_hint, bulletin_published_on) VALUES
    (2022, '2022-11-26_local', '2022-11-26', 'regular', ARRAY['縣市長', '村里長'], '111', '${HINT_EE("111")}', NULL),
    (2024, '2024-01-13_national', '2024-01-13', 'regular', ARRAY['總統副總統', '立法委員'], '113', 'https://bulletin.cec.gov.tw/?dir=x ← 立委公報', NULL),
    (2026, '2026-11-28_local', '2026-11-28', 'regular', ARRAY['縣市長', '村里長'], '115', '${HINT_EE("115")}', DATE '2026-11-18')`);
  await db.exec(QP_RULES); // #443 的種子規則（priority:*、priority:raw:policy_missing）
  const baseline = { village: await demotionDays(db, "村里長"), mayor: await demotionDays(db, "縣市長") };
  const migSql = mutateMig(MIG_DB);
  await db.exec(migSql);
  return { db, migSql, baseline };
}
const MIG_DB = ["milestone", "auth", "priority", "health"].map((s) => section(MIG, s)).join("\n");

const rows = async <T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];
const setToday = (db: PGlite, d: string) => db.exec(`SET app.activity_today = '${d}'`);
const throws = async (f: () => Promise<unknown>): Promise<boolean> => {
  try {
    await f();
    return false;
  } catch {
    return true;
  }
};
const targets = async (db: PGlite, hot: boolean, today: string): Promise<number[]> => {
  await setToday(db, today);
  return (await rows<{ election_id: number }>(db, `SELECT election_id FROM bulletin_watch_targets($1)`, [hot])).map((r) => r.election_id);
};

type Verdicts = Record<string, boolean>;
async function guard(out: Verdicts, name: string, f: () => Promise<boolean>) {
  try {
    out[name] = await f();
  } catch {
    out[name] = false;
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function runSuite({ db, migSql, baseline }: Built): Promise<Verdicts> {
  const v: Verdicts = {};

  await guard(v, "backfill_only_estimated_rows", async () => {
    const r = await rows<{ election_id: number; kind: string; election_type: string | null; on_date: string; basis: string; status: string }>(db,
      `SELECT election_id, kind, election_type, on_date::text, basis, status FROM election_milestones ORDER BY election_id`);
    return same(r, [{ election_id: 2026, kind: "bulletin_published", election_type: null, on_date: "2026-11-18", basis: "statutory", status: "expected" }]);
  });
  await guard(v, "column_unchanged_by_backfill", async () => (await one<{ d: string }>(db, `SELECT bulletin_published_on::text AS d FROM elections WHERE id = 2026`)).d === "2026-11-18");

  // ---- 與佇列優先層（#443）接起來：套這支 migration 之後，「公報之前」降級規則的逐日開關跟套之前一模一樣 ----
  await guard(v, "priority_demotion_unchanged_by_migration", async () => {
    // 套之前（#443 原版：視圖讀 elections.bulletin_published_on，status＝announced）：非縣市長的村里長在 11-17（含）以前開著、11-18 起關；縣市長不在規則範圍
    if (!same(baseline.village, [1, 1, 0, 0]) || !same(baseline.mayor, [0, 0, 0, 0])) return false;
    // 套之後（里程碑表的預估列，status＝expected）：同樣的逐日結果。規則沒改 min_status 的話，expected 擋住它，整段都是 0
    return same(await demotionDays(db, "村里長"), baseline.village) && same(await demotionDays(db, "縣市長"), baseline.mayor);
  });
  await guard(v, "rule_min_status_expected_only_that_rule", async () => {
    const r = await rows<{ activity: string; min_status: string }>(db, `SELECT activity, min_status FROM activity_rules WHERE priority IS NOT NULL ORDER BY id`);
    return same(r, [{ activity: "priority:*", min_status: "announced" }, { activity: "priority:*", min_status: "announced" }, { activity: "priority:raw:policy_missing", min_status: "expected" }]);
  });
  await guard(v, "view_bulletin_only_from_table", async () => {
    // 守門觸發器暫時拿掉，硬把欄位寫成別的值：視圖不能讀它（不然就是第二個來源）
    await db.exec(`ALTER TABLE elections DISABLE TRIGGER trg_elections_bulletin_column_guard`);
    await db.exec(`UPDATE elections SET bulletin_published_on = DATE '2026-12-25' WHERE id = 2026`);
    const rowsNow = await rows<{ origin: string; on_date: string }>(db, `SELECT origin, on_date::text FROM election_milestones_all WHERE kind = 'bulletin_published' AND election_id = 2026`);
    await db.exec(`UPDATE elections SET bulletin_published_on = DATE '2026-11-18' WHERE id = 2026`);
    await db.exec(`ALTER TABLE elections ENABLE TRIGGER trg_elections_bulletin_column_guard`);
    return same(rowsNow, [{ origin: "table", on_date: "2026-11-18" }]);
  });

  // ---- 目標：有 bulletin_dir、整場里程碑還不是 done；hot 只留預估日前後 14 天內 ----
  await guard(v, "targets_all", async () => same(await targets(db, false, "2026-10-08"), [2026]));
  await guard(v, "targets_hot_window_edges", async () =>
    same(await targets(db, true, "2026-10-08"), []) && // 離預估日還遠：每小時那條空轉
    same(await targets(db, true, "2026-11-03"), []) && // 11-18 前 15 天
    same(await targets(db, true, "2026-11-04"), [2026]) && // 前 14 天（含）
    same(await targets(db, true, "2026-12-02"), [2026]) && // 後 14 天（含）
    same(await targets(db, true, "2026-12-03"), []));
  await guard(v, "targets_skip_elections_without_milestone", async () => {
    // 2022、2024 沒有里程碑列（NULL＝已上架），就算有 bulletin_dir 也不查
    const all = await targets(db, false, "2026-10-08");
    return !all.includes(2022) && !all.includes(2024);
  });

  // ---- 守門：elections.bulletin_published_on 是衍生欄位 ----
  await guard(v, "column_direct_update_blocked", async () =>
    (await throws(() => db.exec(`UPDATE elections SET bulletin_published_on = DATE '2026-11-01' WHERE id = 2026`))) &&
    (await throws(() => db.exec(`UPDATE elections SET bulletin_published_on = NULL WHERE id = 2026`))) &&
    (await one<{ d: string }>(db, `SELECT bulletin_published_on::text AS d FROM elections WHERE id = 2026`)).d === "2026-11-18");
  await guard(v, "column_direct_insert_blocked", async () =>
    (await throws(() => db.exec(`INSERT INTO elections (id, election_key, election_date, bulletin_published_on) VALUES (3000, '3000-01-01_local', '3000-01-01', DATE '3000-01-01')`))) &&
    !(await throws(() => db.exec(`INSERT INTO elections (id, election_key, election_date) VALUES (3001, '3001-01-01_local', '3001-01-01')`))));
  await guard(v, "other_columns_still_writable", async () => {
    await db.exec(`UPDATE elections SET bulletin_hint = '${HINT_EE("115")} （改過）' WHERE id = 2026`);
    await db.exec(`UPDATE elections SET bulletin_hint = '${HINT_EE("115")}' WHERE id = 2026`);
    return true;
  });

  // ---- 里程碑一變，欄位跟著變（新增、修改、刪除）----
  await guard(v, "column_follows_milestone_insert_update_delete", async () => {
    await db.exec(`INSERT INTO election_milestones (election_id, kind, on_date, basis, status) VALUES (3001, 'bulletin_published', DATE '3001-01-10', 'statutory', 'expected')`);
    const a = (await one<{ d: string }>(db, `SELECT bulletin_published_on::text AS d FROM elections WHERE id = 3001`)).d === "3001-01-10";
    await db.exec(`UPDATE election_milestones SET on_date = DATE '3001-01-12' WHERE election_id = 3001 AND kind = 'bulletin_published'`);
    const b = (await one<{ d: string }>(db, `SELECT bulletin_published_on::text AS d FROM elections WHERE id = 3001`)).d === "3001-01-12";
    await db.exec(`DELETE FROM election_milestones WHERE election_id = 3001 AND kind = 'bulletin_published'`);
    const c = (await one<{ d: string | null }>(db, `SELECT bulletin_published_on::text AS d FROM elections WHERE id = 3001`)).d === null;
    return a && b && c;
  });
  await guard(v, "type_specific_row_does_not_touch_column", async () => {
    // 只對某個職位的 bulletin_published 不是「整場的公報上架日」，不動欄位
    await db.exec(`INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES (2026, 'bulletin_published', '村里長', DATE '2026-11-19', 'official', 'announced')`);
    const ok = (await one<{ d: string }>(db, `SELECT bulletin_published_on::text AS d FROM elections WHERE id = 2026`)).d === "2026-11-18";
    await db.exec(`DELETE FROM election_milestones WHERE election_id = 2026 AND election_type = '村里長'`);
    return ok && (await one<{ d: string }>(db, `SELECT bulletin_published_on::text AS d FROM elections WHERE id = 2026`)).d === "2026-11-18";
  });

  // ---- 偵測到：預估 → 偵測當天、done、official ----
  await guard(v, "mark_on_nonexistent_row_returns_null", async () => {
    await setToday(db, "2026-11-12");
    const r = await one<{ d: string | null }>(db, `SELECT bulletin_watch_mark_published(2022, 'https://x', 't')::text AS d`);
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM election_milestones WHERE election_id = 2022`);
    return r.d === null && n.n === 0;
  });
  await guard(v, "mark_published_flow", async () => {
    await setToday(db, "2026-11-12"); // 比預估的 11-18 早
    const r = await one<{ d: string }>(db, `SELECT bulletin_watch_mark_published(2026, 'https://eebulletin.cec.gov.tw/?dir=115', '115 - 中央選舉委員會選舉及公民投票公報')::text AS d`);
    const m = await one<{ on_date: string; basis: string; status: string; note: string; election_type: string | null }>(db,
      `SELECT on_date::text, basis, status, note, election_type FROM election_milestones WHERE election_id = 2026 AND kind = 'bulletin_published'`);
    const col = (await one<{ d: string }>(db, `SELECT bulletin_published_on::text AS d FROM elections WHERE id = 2026`)).d;
    return r.d === "2026-11-12" && m.on_date === "2026-11-12" && m.basis === "official" && m.status === "done" && m.election_type === null && col === "2026-11-12" &&
      m.note.includes("eebulletin.cec.gov.tw/?dir=115") && m.note.includes("2026-11-18") && m.note.includes("statutory") && m.note.includes("偵測");
  });
  await guard(v, "priority_demotion_ends_at_detected_date", async () => {
    // 偵測到的上網日是 11-12：降級到 11-11（含）為止，11-12 起回到前段；偵測之前的預估是 11-18，所以這是提早結束
    return (await demotionOpen(db, "村里長", "2026-11-11")) === 1 && (await demotionOpen(db, "村里長", "2026-11-12")) === 0 && (await demotionOpen(db, "村里長", "2026-11-17")) === 0;
  });
  await guard(v, "mark_leaves_audit_trail", async () => {
    const h = await rows<{ old_on: string | null; new_on: string | null; new_status: string | null }>(db,
      `SELECT old_value->>'on_date' AS old_on, new_value->>'on_date' AS new_on, new_value->>'status' AS new_status
         FROM edit_history WHERE table_name = 'election_milestones' AND old_value->>'status' = 'expected' AND new_value->>'status' = 'done'`);
    return h.length === 1 && h[0].old_on === "2026-11-18" && h[0].new_on === "2026-11-12" && h[0].new_status === "done";
  });
  await guard(v, "mark_is_idempotent_once_done", async () => {
    await setToday(db, "2026-11-13");
    const r = await one<{ d: string }>(db, `SELECT bulletin_watch_mark_published(2026, 'https://eebulletin.cec.gov.tw/?dir=115', 'later')::text AS d`);
    const m = await one<{ on_date: string; note: string }>(db, `SELECT on_date::text, note FROM election_milestones WHERE election_id = 2026 AND kind = 'bulletin_published'`);
    return r.d === "2026-11-12" && m.on_date === "2026-11-12" && !m.note.includes("later");
  });
  await guard(v, "targets_empty_after_detection", async () => same(await targets(db, false, "2026-11-13"), []) && same(await targets(db, true, "2026-11-13"), []));

  // 偵測得比預估晚也照實記（預估 11-18、11-20 才看到）
  await guard(v, "mark_later_than_estimate", async () => {
    await db.exec(`INSERT INTO elections (id, election_key, election_date, bulletin_dir, bulletin_hint) VALUES (2030, '2030-11-30_local', '2030-11-30', '119', '${HINT_EE("119")}')`);
    await db.exec(`INSERT INTO election_milestones (election_id, kind, on_date, basis, status) VALUES (2030, 'bulletin_published', DATE '2030-11-20', 'statutory', 'expected')`);
    await setToday(db, "2030-11-23");
    const r = await one<{ d: string }>(db, `SELECT bulletin_watch_mark_published(2030, 'u', 't')::text AS d`);
    const col = (await one<{ d: string }>(db, `SELECT bulletin_published_on::text AS d FROM elections WHERE id = 2030`)).d;
    return r.d === "2030-11-23" && col === "2030-11-23";
  });

  // ---- 權限 ----
  await guard(v, "only_service_role_can_execute", async () => {
    const fns = ["public.bulletin_watch_targets(boolean, integer)", "public.bulletin_watch_mark_published(integer, text, text)", "public.bulletin_watch_cron_secret_ok(text)"];
    for (const f of fns) {
      const p = await one<{ s: boolean; a: boolean; u: boolean; pub: boolean }>(db,
        `SELECT has_function_privilege('service_role', '${f}', 'EXECUTE') AS s, has_function_privilege('anon', '${f}', 'EXECUTE') AS a,
                has_function_privilege('authenticated', '${f}', 'EXECUTE') AS u, has_function_privilege('public', '${f}', 'EXECUTE') AS pub`);
      if (!(p.s && !p.a && !p.u && !p.pub)) return false;
    }
    return true;
  });

  // ---- 密鑰驗證 ----
  await guard(v, "cron_secret_check", async () => {
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM vault.decrypted_secrets WHERE name = 'bulletin_watch_cron_secret'`);
    const secret = (await one<{ s: string }>(db, `SELECT decrypted_secret AS s FROM vault.decrypted_secrets WHERE name = 'bulletin_watch_cron_secret'`)).s;
    await db.exec(`INSERT INTO vault.decrypted_secrets VALUES ('console_fetch_cron_secret', 'another-secret-another-secret')`);
    const ok = async (s: string | null) => (await one<{ ok: boolean }>(db, `SELECT bulletin_watch_cron_secret_ok($1) AS ok`, [s])).ok;
    // 太短的密鑰就算跟 Vault 裡的一模一樣也不通過（Vault 被人放了一個短值時，不能因為「對得上」就放行）
    await db.exec(`INSERT INTO vault.decrypted_secrets VALUES ('bulletin_watch_cron_secret', 'tiny')`);
    const tinyRejected = !(await ok("tiny"));
    await db.exec(`DELETE FROM vault.decrypted_secrets WHERE decrypted_secret = 'tiny'`);
    return tinyRejected && n.n === 1 && secret.length === 64 && (await ok(secret)) && !(await ok("x".repeat(64))) && !(await ok("short")) && !(await ok(null)) && !(await ok("")) &&
      !(await ok("another-secret-another-secret")); // 別條排程的密鑰不能拿來呼叫這支
  });

  // ---- 健康檢查：有公報資料夾、還沒投票、卻沒有整場里程碑 → 報出來 ----
  await guard(v, "health_flags_missing_bulletin_milestone", async () => {
    await setToday(db, "2026-10-08");
    const flagged = async () => (await rows<{ subject: string }>(db, `SELECT subject FROM activity_health WHERE check_name = 'bulletin_milestone_missing' ORDER BY subject`)).map((r) => r.subject);
    const base = await flagged(); // 2026 有預估列、2022／2024 已投票：都不報
    await db.exec(`INSERT INTO elections (id, election_key, election_date, election_reason, election_types, bulletin_dir, bulletin_hint) VALUES
      (2028, '2028-01-15_national', '2028-01-15', 'regular', ARRAY['總統副總統'], '117', '${HINT_EE("117")}'),
      (2029, '2029-01-15_national', '2029-01-15', 'regular', ARRAY['總統副總統'], NULL, NULL)`);
    const missing = await flagged(); // 2028 有資料夾沒里程碑 → 報；2029 沒有資料夾 → 不報
    await db.exec(`INSERT INTO election_milestones (election_id, kind, on_date, basis, status) VALUES (2028, 'bulletin_published', DATE '2028-01-05', 'statutory', 'expected')`);
    const fixed = await flagged();
    // 只有職位專屬的列不算「整場」的
    await db.exec(`DELETE FROM election_milestones WHERE election_id = 2028`);
    await db.exec(`INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES (2028, 'bulletin_published', '總統副總統', DATE '2028-01-05', 'statutory', 'expected')`);
    const typeOnly = await flagged();
    await db.exec(`DELETE FROM election_milestones WHERE election_id = 2028`);
    await db.exec(`DELETE FROM elections WHERE id IN (2028, 2029)`);
    return same(base, []) && same(missing, ["2028"]) && same(fixed, []) && same(typeOnly, ["2028"]);
  });
  await guard(v, "health_view_otherwise_empty", async () => {
    await setToday(db, "2026-10-08");
    return (await rows(db, `SELECT 1 FROM activity_health WHERE check_name <> 'clock_overridden'`)).length === 0;
  });

  // ---- 重跑安全 ----
  await guard(v, "rerun_is_safe", async () => {
    const before = await one<{ on_date: string; status: string }>(db, `SELECT on_date::text, status FROM election_milestones WHERE election_id = 2026 AND kind = 'bulletin_published'`);
    await db.exec(migSql);
    const after = await one<{ on_date: string; status: string }>(db, `SELECT on_date::text, status FROM election_milestones WHERE election_id = 2026 AND kind = 'bulletin_published'`);
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM vault.decrypted_secrets WHERE name = 'bulletin_watch_cron_secret'`);
    const col = (await one<{ d: string }>(db, `SELECT bulletin_published_on::text AS d FROM elections WHERE id = 2026`)).d;
    return same(before, after) && after.status === "done" && n.n === 1 && col === "2026-11-12";
  });
  return v;
}

Deno.test("公報上網日偵測（PGlite 跑 migration 的資料庫段）：全部守門通過", async () => {
  const v = await runSuite(await buildDb());
  const red = Object.entries(v).filter(([, ok]) => !ok).map(([k]) => k);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
  assert(Object.keys(v).length >= 15, "守門數不該變少");
});

// ---- 還原驗證：改壞 migration 一處，指定的守門必須紅（其餘不限）----
type Pair = [from: string, to: string];
const REVERT: Array<[label: string, pairs: Pair[], mustBeRed: string[]]> = [
  ["拿掉守門觸發器（直接寫欄位又能寫了）", [["CREATE TRIGGER trg_elections_bulletin_column_guard BEFORE INSERT OR UPDATE OF bulletin_published_on ON elections",
    "CREATE TRIGGER trg_elections_bulletin_column_guard BEFORE DELETE ON elections"]], ["column_direct_update_blocked", "column_direct_insert_blocked"]],
  ["守門的深度條件改成永遠擋（連同步觸發器自己也被擋）", [["IF pg_trigger_depth() < 2 THEN", "IF true THEN"]], ["column_follows_milestone_insert_update_delete", "mark_published_flow"]],
  ["守門的深度條件改成永遠放行", [["IF pg_trigger_depth() < 2 THEN", "IF false THEN"]], ["column_direct_update_blocked", "column_direct_insert_blocked"]],
  ["拿掉同步觸發器（欄位與里程碑走鐘）", [["AFTER INSERT OR UPDATE OR DELETE ON election_milestones\n  FOR EACH ROW EXECUTE FUNCTION election_bulletin_sync_column();",
    "AFTER INSERT ON election_milestones\n  FOR EACH ROW WHEN (false) EXECUTE FUNCTION election_bulletin_sync_column();"]], ["column_follows_milestone_insert_update_delete", "mark_published_flow"]],
  ["偵測後 status 不標 done", [["SET on_date = v_today, basis = 'official', status = 'done',", "SET on_date = v_today, basis = 'official', status = 'announced',"]], ["mark_published_flow", "targets_empty_after_detection"]],
  ["偵測後 basis 不標 official", [["SET on_date = v_today, basis = 'official', status = 'done',", "SET on_date = v_today, basis = 'statutory', status = 'done',"]], ["mark_published_flow"]],
  ["偵測日不是偵測當天（寫成預估日）", [["SET on_date = v_today, basis", "SET on_date = v_row.on_date, basis"]], ["mark_published_flow", "mark_later_than_estimate"]],
  ["已經 done 還繼續改（不冪等）", [["IF v_row.status = 'done' THEN\n    RETURN v_row.on_date;\n  END IF;", "IF false THEN\n    RETURN v_row.on_date;\n  END IF;"]], ["mark_is_idempotent_once_done"]],
  ["目標清單不排除已確定的", [["AND m.status <> 'done'", "AND true"]], ["targets_empty_after_detection"]],
  ["hot 窗口迄日少一天", [["BETWEEN m.on_date - p_hot_days AND m.on_date + p_hot_days", "BETWEEN m.on_date - p_hot_days AND m.on_date + p_hot_days - 1"]], ["targets_hot_window_edges"]],
  ["hot 窗口起日多一天", [["BETWEEN m.on_date - p_hot_days AND m.on_date + p_hot_days", "BETWEEN m.on_date - p_hot_days + 1 AND m.on_date + p_hot_days"]], ["targets_hot_window_edges"]],
  ["回填把已上架的（NULL）也建里程碑", [
    ["SELECT e.id, 'bulletin_published', NULL, e.bulletin_published_on, 'statutory'", "SELECT e.id, 'bulletin_published', NULL, COALESCE(e.bulletin_published_on, e.election_date), 'statutory'"],
    ["WHERE e.bulletin_published_on IS NOT NULL\nON CONFLICT", "WHERE true\nON CONFLICT"],
  ], ["backfill_only_estimated_rows", "targets_skip_elections_without_milestone"]],
  ["預估列標成 announced", [["'statutory', 'expected',\n       '2026-10-08 由", "'statutory', 'announced',\n       '2026-10-08 由"]], ["backfill_only_estimated_rows"]],
  ["把 mark 授權給 anon", [["GRANT EXECUTE ON FUNCTION public.bulletin_watch_mark_published(integer, text, text) TO service_role;",
    "GRANT EXECUTE ON FUNCTION public.bulletin_watch_mark_published(integer, text, text) TO service_role, anon;"]], ["only_service_role_can_execute"]],
  ["不收回 PUBLIC 對密鑰驗證函式的執行權", [["REVOKE ALL ON FUNCTION public.bulletin_watch_cron_secret_ok(text) FROM PUBLIC;", ""]], ["only_service_role_can_execute"]],
  ["密鑰驗證不看長度", [["AND length(p_secret) >= 16\n", ""]], ["cron_secret_check"]],
  ["密鑰驗證比到別條排程的密鑰", [["WHERE s.name = 'bulletin_watch_cron_secret'\n          AND extensions", "WHERE s.name LIKE '%_cron_secret'\n          AND extensions"]], ["cron_secret_check"]],
  ["密鑰每次重跑都再產一個", [["IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'bulletin_watch_cron_secret') THEN", "IF true THEN"]], ["rerun_is_safe"]],
  ["沒有把降級規則改成接受預估日期（expected 擋住它，偵測前降級無聲失效）", [["SET min_status = 'expected'\n WHERE activity = 'priority:raw:policy_missing'", "SET min_status = 'announced'\n WHERE activity = 'priority:raw:policy_missing'"]],
    ["priority_demotion_unchanged_by_migration", "rule_min_status_expected_only_that_rule"]],
  ["規則的 min_status 改到所有優先規則", [["WHERE activity = 'priority:raw:policy_missing'\n   AND from_kind IS NULL\n   AND until_kind = 'bulletin_published'\n", "WHERE activity LIKE 'priority:%'\n"]], ["rule_min_status_expected_only_that_rule"]],
  ["視圖沒有拿回 P0 的寫法（仍讀 elections.bulletin_published_on）", [["CREATE OR REPLACE VIEW election_milestones_all AS\n  SELECT m.election_id, m.kind, m.election_type, m.on_date, m.basis, m.status, m.source_id, m.note,\n         'table'::TEXT AS origin, m.id AS milestone_id\n    FROM election_milestones m\n  UNION ALL\n  SELECT e.id, 'polling'::TEXT",
    "CREATE OR REPLACE VIEW election_milestones_all AS\n  SELECT m.election_id, m.kind, m.election_type, m.on_date, m.basis, m.status, m.source_id, m.note,\n         'table'::TEXT AS origin, m.id AS milestone_id\n    FROM election_milestones m\n  UNION ALL\n  SELECT e.id, 'bulletin_published'::TEXT, NULL::TEXT, e.bulletin_published_on + 1, 'official'::TEXT, 'announced', NULL::BIGINT, NULL::TEXT, 'elections'::TEXT, NULL::BIGINT FROM elections e WHERE e.bulletin_published_on IS NOT NULL\n  UNION ALL\n  SELECT e.id, 'polling'::TEXT"]],
    ["view_bulletin_only_from_table"]],
  ["健康檢查拿掉「沒有里程碑」的條件（永遠報）", [["     AND NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = e.id AND m.kind = 'bulletin_published' AND m.election_type IS NULL)\n", ""]],
    ["health_flags_missing_bulletin_milestone", "health_view_otherwise_empty"]],
  ["健康檢查把職位專屬的列也當整場", [["AND m.kind = 'bulletin_published' AND m.election_type IS NULL)\n", "AND m.kind = 'bulletin_published')\n"]], ["health_flags_missing_bulletin_milestone"]],
  ["健康檢查連已投票的選舉也報", [["     AND e.election_date >= activity_today()\n", ""]], ["health_view_otherwise_empty"]],
  ["健康檢查不看有沒有公報資料夾", [["   WHERE e.bulletin_dir IS NOT NULL\n     AND e.election_date >= activity_today()", "   WHERE e.election_date >= activity_today()"]], ["health_flags_missing_bulletin_milestone"]],
  ["同步觸發器把型別專屬的列也當整場", [["AND NEW.election_type IS NULL THEN\n    v_new_eid", "THEN\n    v_new_eid"]], ["type_specific_row_does_not_touch_column"]],
];
for (const [label, pairs, mustBeRed] of REVERT) {
  Deno.test(`還原驗證：${label} → ${mustBeRed.join("、")} 要紅`, async () => {
    const v = await runSuite(await buildDb((sql) => pairs.reduce((s, [from, to]) => mutate(s, from, to), sql)));
    for (const name of mustBeRed) assertEquals(v[name], false, `改壞「${label}」之後，守門 ${name} 還是綠的（它沒有守住這件事）`);
  });
}
