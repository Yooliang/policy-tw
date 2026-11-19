/**
 * jev_decisions.state 保留政策（migration 20261119130000_jev_decisions_prune_state.sql）。
 *
 *   A. 文字層：migration 不含 DELETE／TRUNCATE、UPDATE 只動 state 與 state_pruned_at；
 *      保留天數下限（設定表 CHECK 與預設）不短於 trace_events 最後一版的回看窗（14 天）。
 *   B. PGlite 行為層（真的建 jev_decisions：原始 DDL＋當年 GENERATED 指紋，再套這支 migration）：
 *      state_hash 改一般欄位後既有指紋原值保留、新增由觸發器補算、同 state 重問仍被擋（含已清的列）；
 *      14 天內不動、14 天前 state 清成摘要而 state_hash／判決欄不變；同鍵多列清完不撞唯一索引；
 *      白名單欄位保留；還在流程中的交件不碰；分批上限；enabled=false；設定改值與 CHECK；冪等；權限。
 *   C. 還原驗證：把 migration 精確改壞一處，對應的測試必須紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const MIG = "20261119130000_jev_decisions_prune_state.sql";
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const read = async (name: string) => norm(await Deno.readTextFile(new URL(name, MIGRATIONS)));

const MIG_SQL = await read(MIG);
const JEV_BASE = await read("20260919000001_jev_decisions.sql");
const ROLLING = await read("20260919000003_system_one_rolling.sql");
const P0 = await read("20261008001000_activity_windows_p0.sql");

/** 去掉 -- 註解（檔頭說明裡會提到 DELETE 這個字） */
const stripComments = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 migration 不刪列：沒有 DELETE FROM／TRUNCATE／DROP TABLE，UPDATE jev_decisions 只動 state 與 state_pruned_at", () => {
  const code = stripComments(MIG_SQL);
  assert(!/\bDELETE\s+FROM\b/i.test(code), "不可有 DELETE FROM");
  assert(!/\bTRUNCATE\b/i.test(code), "不可有 TRUNCATE");
  assert(!/\bDROP\s+TABLE\b/i.test(code), "不可有 DROP TABLE");
  const upd = [...code.matchAll(/UPDATE\s+jev_decisions\s+d?\s*SET([\s\S]*?)FROM\s+picked/gi)];
  assertEquals(upd.length, 1, "清理函式只有一處 UPDATE jev_decisions");
  assert(/state_pruned_at\s*=\s*now\(\)/.test(upd[0][1]), "要記清理時間");
  for (const col of ["state_hash", "choice", "probability", "probabilities", "confidence", "model", "cost_usd", "asked_at", "subject_id", "subject_type", "question"]) {
    assert(!new RegExp(String.raw`(^|[\s,])${col}\s*=`).test(upd[0][1]), `UPDATE 不可動 ${col}`);
  }
});

Deno.test("A2 保留天數下限不短於 trace_events 最後一版的回看窗，預設值也一樣", async () => {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  const lastTrace = names.sort().filter((n) => n.includes("trace_events")).pop()!;
  const sql = await read(lastTrace);
  const days = [...sql.matchAll(/jev_decisions[\s\S]{0,600}?interval\s+'(\d+)\s+days'/gi)].map((m) => Number(m[1]));
  assert(days.length > 0, `${lastTrace} 讀 jev_decisions 的段落抽不出回看天數`);
  const window = Math.max(...days);
  const floor = Number(/days\s+INTEGER NOT NULL DEFAULT (\d+) CHECK \(days BETWEEN (\d+) AND/.exec(MIG_SQL)?.[2]);
  const def = Number(/days\s+INTEGER NOT NULL DEFAULT (\d+)/.exec(MIG_SQL)?.[1]);
  assert(floor >= window, `保留下限 ${floor} 天短於 /trace 回看窗 ${window} 天`);
  assert(def >= window, `預設 ${def} 天短於 /trace 回看窗 ${window} 天`);
});

// ============================================================
// B. PGlite
// ============================================================
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
CREATE TABLE contributions (id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'pending');
CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text NOT NULL, record_id text NOT NULL, field text NOT NULL, old_value jsonb, new_value jsonb,
  contribution_id uuid, agent_name text, applied_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz, reverted_by text);
`;

/** 正式庫 migration 前的樣子：原始 DDL＋GENERATED 的 state_hash＋once_per_state（取 20260919000003 的第 1 段原文） */
async function buildDb(migSql: string = MIG_SQL): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(fnFromP0("activity_audit"));
  await db.exec(fnFromP0("activity_touch_updated_at"));
  await db.exec(JEV_BASE);
  // 後來的 migration 把這兩個 CHECK 放寬了；測試只需要放行 contribution／source_support 等值
  await db.exec(`ALTER TABLE jev_decisions DROP CONSTRAINT jev_decisions_subject_type_check; ALTER TABLE jev_decisions DROP CONSTRAINT jev_decisions_question_check;`);
  await db.exec(ROLLING.slice(0, ROLLING.indexOf("-- 2. 補漏候選")));
  await db.exec(migSql);
  return db;
}
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Array<Record<string, unknown>>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const big = (n = 4000) => "x".repeat(n);

type Row = { type?: string; id: string; question?: string; model?: string; state: unknown; days: number };
async function insert(db: PGlite, r: Row): Promise<void> {
  await db.query(
    `INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability, probabilities, model, state, cost_usd, asked_at)
     VALUES ($1, $2, $3, 'supported', 0.97, '{"a":0.97}', $4, $5::jsonb, 0.0123, now() - ($6 || ' days')::interval)`,
    [r.type ?? "policy", r.id, r.question ?? "source_support", r.model ?? "typesafe/jev-1.13-20260917", JSON.stringify(r.state), String(r.days)],
  );
}
const run = async (db: PGlite, ...args: Array<number | null>) =>
  Number((await q(db, `SELECT jev_decisions_prune_state(${args.length ? args.map((a) => (a === null ? "NULL" : a)).join(",") : ""}) n`))[0].n);

Deno.test("B1 state_hash 不再是 GENERATED、既有指紋原值保留、新增由觸發器算", async () => {
  const pre = new PGlite();
  await pre.exec(BASE + `SELECT 1;`);
  await pre.close();
  const db = new PGlite();
  try {
    await db.exec(BASE);
    await db.exec(fnFromP0("activity_audit"));
    await db.exec(fnFromP0("activity_touch_updated_at"));
    await db.exec(JEV_BASE);
    await db.exec(`ALTER TABLE jev_decisions DROP CONSTRAINT jev_decisions_subject_type_check; ALTER TABLE jev_decisions DROP CONSTRAINT jev_decisions_question_check;`);
    await db.exec(ROLLING.slice(0, ROLLING.indexOf("-- 2. 補漏候選")));
    assertEquals((await q(db, `SELECT attgenerated g FROM pg_attribute WHERE attrelid='jev_decisions'::regclass AND attname='state_hash'`))[0].g, "s", "前置：原本是 GENERATED STORED");
    await insert(db, { id: "old", state: { a: 1 }, days: 1 });
    const before = (await q(db, `SELECT state_hash h FROM jev_decisions`))[0].h;
    await db.exec(MIG_SQL);
    assertEquals((await q(db, `SELECT attgenerated g FROM pg_attribute WHERE attrelid='jev_decisions'::regclass AND attname='state_hash'`))[0].g, "");
    assertEquals((await q(db, `SELECT state_hash h FROM jev_decisions`))[0].h, before, "既有指紋原值保留");
    await insert(db, { id: "new", state: { b: 2 }, days: 0 });
    assertEquals((await q(db, `SELECT state_hash = md5(state::text) ok FROM jev_decisions WHERE subject_id='new'`))[0].ok, true);
  } finally {
    await db.close();
  }
});

Deno.test("B2 14 天內不動；14 天前清成摘要，state_hash 與判決欄不變；清過的列仍擋同 state 重問", async () => {
  const db = await buildDb();
  try {
    await insert(db, { id: "fresh", state: { page: { text: big() } }, days: 3 });
    await insert(db, { id: "stale", state: { page: { text: big() } }, days: 20 });
    const snap = async () => await q(db, `SELECT id, subject_id, question, choice, probability::text p, probabilities::text pr, model, cost_usd::text c, asked_at::text a, state_hash FROM jev_decisions ORDER BY id`);
    const before = await snap();
    assertEquals(await run(db), 1);
    assertEquals(await snap(), before, "只有 state 與 state_pruned_at 變，其餘每個欄位逐字相同（含 state_hash）");
    const rows = await q(db, `SELECT subject_id, state::text s, state_pruned_at IS NOT NULL pruned FROM jev_decisions ORDER BY id`);
    assertEquals(JSON.parse(rows[0].s as string), { page: { text: big() } });
    assertEquals(rows[0].pruned, false);
    assertEquals(rows[1].s, "{}");
    assertEquals(rows[1].pruned, true);
    // 重問同一件、同 state：照舊被擋（與寫入端 upsert ignoreDuplicates 同一條路）
    const re = await q(db, `INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability, model, state)
      VALUES ('policy', 'stale', 'source_support', 'supported', 0.9, 'typesafe/jev-1.13-20260917', $1::jsonb)
      ON CONFLICT (subject_type, subject_id, question, model, state_hash) DO NOTHING RETURNING id`, [JSON.stringify({ page: { text: big() } })]);
    assertEquals(re.length, 0, "已清的列仍擋同 state 重問");
    // state 真的變了：照舊新增一列
    const re2 = await q(db, `INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability, model, state)
      VALUES ('policy', 'stale', 'source_support', 'supported', 0.9, 'typesafe/jev-1.13-20260917', '{"page":{"text":"changed"}}')
      ON CONFLICT (subject_type, subject_id, question, model, state_hash) DO NOTHING RETURNING id`);
    assertEquals(re2.length, 1);
    assertEquals(await run(db), 0, "沒事做時立即回 0");
  } finally {
    await db.close();
  }
});

Deno.test("B3 同一件事留下好幾列歷史（同鍵不同 state）清完不撞唯一索引", async () => {
  const db = await buildDb();
  try {
    for (const v of ["v1", "v2", "v3"]) await insert(db, { id: "same", state: { page: { text: v + big() } }, days: 30 });
    assertEquals(await run(db), 3);
    assertEquals(Number((await q(db, `SELECT count(DISTINCT state_hash) c FROM jev_decisions`))[0].c), 3, "三個不同的指紋都還在");
  } finally {
    await db.close();
  }
});

Deno.test("B4 白名單：supported_sources／schema／reason 留下（字串截 200），其餘清掉；型別不對的鍵不留", async () => {
  const db = await buildDb();
  try {
    await insert(db, { id: "w1", state: { supported_sources: 2, schema: "merge-identity-v2", reason: "名冊上找不到姓名".padEnd(300, "。"), page: { text: big() }, claim: { a: 1 } }, days: 20 });
    await insert(db, { id: "w2", state: { supported_sources: { evil: big() }, schema: ["x"] }, days: 20 });
    await run(db);
    const s1 = (await q(db, `SELECT state s FROM jev_decisions WHERE subject_id='w1'`))[0].s as Record<string, unknown>;
    assertEquals(Object.keys(s1).sort(), ["reason", "schema", "supported_sources"]);
    assertEquals(s1.supported_sources, 2);
    assertEquals(s1.schema, "merge-identity-v2");
    assertEquals((s1.reason as string).length, 200);
    assertEquals((await q(db, `SELECT state::text s FROM jev_decisions WHERE subject_id='w2'`))[0].s, "{}");
    // 白名單是資料：清空後全清
    await db.exec(`UPDATE jev_prune_settings SET keep_keys = '{}' WHERE id = 1`);
    await insert(db, { id: "w3", state: { supported_sources: 2 }, days: 20 });
    await run(db);
    assertEquals((await q(db, `SELECT state::text s FROM jev_decisions WHERE subject_id='w3'`))[0].s, "{}");
  } finally {
    await db.close();
  }
});

Deno.test("B5 還在流程中的交件整列不碰；結案的、非交件的照清", async () => {
  const db = await buildDb();
  try {
    const st = ["pending", "verified", "disputed", "applied", "rejected", "superseded", "withdrawn", "reverted"];
    for (let i = 0; i < st.length; i++) {
      await db.exec(`INSERT INTO contributions (id, status) VALUES ('${uuid(i + 1)}', '${st[i]}')`);
      await insert(db, { type: "contribution", id: uuid(i + 1), state: { page: { text: big() } }, days: 40 });
    }
    await insert(db, { type: "policy", id: uuid(1), state: { page: { text: big() } }, days: 40 }); // 同 id 但不是交件
    await run(db);
    const got = await q(db, `SELECT subject_type t, subject_id i, state_pruned_at IS NOT NULL pruned FROM jev_decisions ORDER BY id`);
    assertEquals(got.slice(0, 8).map((r) => r.pruned), [false, false, false, true, true, true, true, true]);
    assertEquals(got[8].pruned, true, "非交件的判決照清");
  } finally {
    await db.close();
  }
});

Deno.test("B6 分批上限、參數只能把保留天數調長；改值有審計；CHECK 擋掉不安全的值", async () => {
  const db = await buildDb();
  try {
    await db.exec(`INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability, model, state, asked_at)
      SELECT 'policy', 'g' || g, 'is_policy', 'yes', 0.9, 'm', jsonb_build_object('t', repeat('y', 500), 'n', g), now() - interval '30 days' FROM generate_series(1, 450) g`);
    await db.exec(`UPDATE jev_prune_settings SET batch_size = 100, max_batches = 2 WHERE id = 1`);
    assertEquals([await run(db), await run(db), await run(db), await run(db)], [200, 200, 50, 0]);
    // 明給的 p_days 比設定短不生效
    await insert(db, { id: "z", state: { t: big() }, days: 20 });
    assertEquals(await run(db, 1), 1, "p_days=1 仍以設定的 14 天為下限：20 天前的清、不會把 14 天內的也清");
    await insert(db, { id: "y", state: { t: big() }, days: 10 });
    assertEquals(await run(db, 1), 0);
    // 明給 p_days 比設定長：照長的
    await insert(db, { id: "x", state: { t: big() }, days: 20 });
    assertEquals(await run(db, 60), 0);
    await db.exec(`UPDATE jev_prune_settings SET days = 30, note = '測試' WHERE id = 1`);
    const audit = await q(db, `SELECT agent_name, new_value->>'days' d FROM edit_history WHERE table_name = 'jev_prune_settings' ORDER BY id`);
    assertEquals(audit[audit.length - 1], { agent_name: "activity-audit", d: "30" });
    for (const bad of ["days = 13", "days = 1", "batch_size = 99999999", "max_batches = 0"]) {
      let failed = false;
      try { await db.exec(`UPDATE jev_prune_settings SET ${bad} WHERE id = 1`); } catch { failed = true; }
      assert(failed, `${bad} 應被 CHECK 擋掉`);
    }
    let two = false;
    try { await db.exec(`INSERT INTO jev_prune_settings (id) VALUES (2)`); } catch { two = true; }
    assert(two, "只能有 id=1 一列");
  } finally {
    await db.close();
  }
});

Deno.test("B7 enabled=false 什麼都不動", async () => {
  const db = await buildDb();
  try {
    await insert(db, { id: "a", state: { t: big() }, days: 40 });
    await db.exec(`UPDATE jev_prune_settings SET enabled = false WHERE id = 1`);
    assertEquals(await run(db), 0);
    assertEquals(await run(db, 14, 5000, 20), 0, "明給參數也不能繞過停用");
    assertEquals((await q(db, `SELECT state_pruned_at IS NULL u FROM jev_decisions`))[0].u, true);
    await db.exec(`UPDATE jev_prune_settings SET enabled = true WHERE id = 1`);
    assertEquals(await run(db), 1);
  } finally {
    await db.close();
  }
});

Deno.test("B8 排程是 */10 且冪等；migration 重跑不多設定、不多觸發器；函式只有 service_role 能執行", async () => {
  const db = await buildDb();
  try {
    await db.exec(MIG_SQL);
    assertEquals(await q(db, `SELECT jobname, schedule, command FROM cron.job`), [{ jobname: "jev-state-prune", schedule: "*/10 * * * *", command: "SELECT jev_decisions_prune_state();" }]);
    assertEquals(Number((await q(db, `SELECT count(*) c FROM jev_prune_settings`))[0].c), 1);
    assertEquals(Number((await q(db, `SELECT count(*) c FROM pg_trigger WHERE tgrelid='jev_decisions'::regclass AND tgname='trg_jev_decisions_state_hash'`))[0].c), 1);
    const can = async (role: string) => (await q(db, `SELECT has_function_privilege('${role}', 'jev_decisions_prune_state(integer,integer,integer)', 'EXECUTE') ok`))[0].ok;
    assertEquals([await can("service_role"), await can("anon"), await can("authenticated")], [true, false, false]);
  } finally {
    await db.close();
  }
});

// ============================================================
// C. 還原驗證：把 migration 精確改壞一處，對應的行為必須紅
// ============================================================
function mutate(from: string, to: string): string {
  assert(MIG_SQL.includes(from), `改不到：${from}`);
  return MIG_SQL.replace(from, to);
}

Deno.test("C1 不放掉 GENERATED（沒有 DROP EXPRESSION）→ 清理必失敗", async () => {
  const bad = mutate("ALTER TABLE jev_decisions ALTER COLUMN state_hash DROP EXPRESSION;", "NULL;").replace("CREATE TRIGGER trg_jev_decisions_state_hash", "-- CREATE TRIGGER trg_jev_decisions_state_hash").replace("FOR EACH ROW EXECUTE FUNCTION jev_decisions_set_state_hash();", "");
  const db = await buildDb(bad);
  try {
    await insert(db, { id: "a", state: { t: big() }, days: 40 });
    const before = (await q(db, `SELECT state_hash h FROM jev_decisions`))[0].h;
    let failed = false;
    try { await run(db); } catch { failed = true; }
    const after = failed ? before : (await q(db, `SELECT state_hash h FROM jev_decisions`))[0].h;
    assert(failed || after !== before, "GENERATED 欄位會讓指紋跟著 state 變（或清理失敗）＝B2 的「指紋不變」會紅");
  } finally {
    await db.close();
  }
});

Deno.test("C2 拿掉流程中交件的排除 → B5 的前提變紅", async () => {
  const bad = mutate("AND NOT (j.subject_type = 'contribution' AND j.subject_id IN (", "AND NOT (false AND j.subject_id IN (");
  const db = await buildDb(bad);
  try {
    await db.exec(`INSERT INTO contributions (id, status) VALUES ('${uuid(1)}', 'pending')`);
    await insert(db, { type: "contribution", id: uuid(1), state: { t: big() }, days: 40 });
    await run(db);
    assertEquals((await q(db, `SELECT state_pruned_at IS NOT NULL p FROM jev_decisions`))[0].p, true, "改壞後 pending 的判決被清掉＝守門抓得到");
  } finally {
    await db.close();
  }
});

Deno.test("C3 保留天數下限改成 7 → A2 的下限檢查紅", () => {
  const bad = mutate("CHECK (days BETWEEN 14 AND 3650)", "CHECK (days BETWEEN 7 AND 3650)");
  const floor = Number(/days\s+INTEGER NOT NULL DEFAULT (\d+) CHECK \(days BETWEEN (\d+) AND/.exec(bad)?.[2]);
  assert(floor < 14);
});
