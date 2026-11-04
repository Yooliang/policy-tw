/**
 * 驗證票排序：任務被派出前的位置 − 14 天 ＋ 7 天 × 領走次數（migration 20261104120000_verify_ticket_key.sql，policy-ops#198，更正 2026-10-17）。
 *
 *   A. 文字層：新函式、新欄位、不碰任務列的行為（任務列分支一字不動）、舊 verify_queue_key 與 verify_follows_task 保留
 *   B. PGlite（真的觸發器、真的 task_dispatched、真的入列觸發器）：
 *      B1 情境表：任務 10/05（一般）與被插隊的任務，派出後交件，票領走 0～4 次的位置逐筆比對（絕對時間）
 *      B2 沒有基準：新增型、沒經過 /next 派出、無 task_id、母任務在交件之後才又被派出 → 退回交件建立時間
 *      B3 任務列行為不變：派出照舊插隊歸零、回隊尾（改前改後同一個劇本位置相同）
 *      B4 驗證票的插隊不因派出歸零；母任務之後被插隊／refresh 不讓已存在的票移位
 *      B5 no_change 的延後保留
 *      B6 既有的票過渡：套 migration 前後 queue_at 一張都沒動；之後被領走才開始 ＋7 天
 *   C. 還原驗證：不記派出前位置、驗證票派出就歸零插隊、拿掉每次領走的 7 天、回填少一項，各自對應的劇本要翻面
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261104120000_verify_ticket_key.sql";
const MIG = await readMig(MIG_NAME);
const DAY = 86400;
const BOOST = 157680000; // 5 年
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 任務列分支一字不動：新觸發器 ＝ 前一版（20261028140000）＋兩個標記區塊（>>> 驗證票排序）", async () => {
  const prev = await latestFn("task_dispatches_queue_key", MIG_NAME);
  const neu = fnText(MIG, "task_dispatches_queue_key");
  const stripBlocks = (s: string) => s.replace(/ {2,4}-- >>> 驗證票排序[^\n]*\n[\s\S]*?-- <<< 驗證票排序\n/g, "");
  const norm = (s: string) => code(s).split("\n").map((l) => l.trim()).filter((l) => l !== "").join("\n");
  // 任務列的 queue_at（ELSE 分支）一字不動
  assert(neu.includes("NEW.queue_at := task_queue_key(COALESCE(NEW.last_dispatched_at, now()), NEW.priority_seconds, NEW.cool_until, NEW.boost_seconds);"));
  assert(prev.includes("NEW.queue_at := task_queue_key(COALESCE(NEW.last_dispatched_at, now()), NEW.priority_seconds, NEW.cool_until, NEW.boost_seconds);"));
  assertEquals((neu.match(/>>> 驗證票排序/g) ?? []).length, 2, "兩個標記區塊");
  // 拿掉兩個標記區塊後，新定義比前一版少的只有「插隊歸零」「queue_at 的驗證票算法」，其餘行（去註解、去空白）都在前一版裡
  const rest = norm(stripBlocks(neu)).split("\n");
  const prevLines = new Set(norm(prev).split("\n"));
  assertEquals(rest.filter((l) => !prevLines.has(l)), [], "標記區塊以外的每一行都來自前一版");
  // 前一版有而新定義沒有的行：只有舊的 boost 歸零（IF 區塊）與舊的 queue_at 呼叫
  const neuLines = new Set(norm(neu).split("\n"));
  assertEquals([...prevLines].filter((l) => !neuLines.has(l)).sort(), [
    "IF TG_OP = 'UPDATE' AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count THEN",
    "NEW.queue_at := verify_queue_key(NEW.task_id, NEW.verify_follows_task, NEW.last_dispatched_at, NEW.priority_seconds, NEW.boost_seconds, NEW.defer_seconds);",
  ].sort());
});

Deno.test("A2 舊 verify_queue_key 與 verify_follows_task 保留（改簽名要分兩次上）；日本站與 task_boost 不在這支裡；新參數有 CHECK", () => {
  const c = code(MIG);
  assert(!/DROP\s+(FUNCTION|COLUMN)/i.test(c) && !/ALTER TABLE task_dispatches DROP/i.test(c), "這支不刪任何東西");
  assert(!/CREATE OR REPLACE FUNCTION verify_queue_key/.test(c), "舊的 verify_queue_key 不動");
  assert(!/policy_jp\./.test(c), "日本站不跟");
  assert(!/CREATE OR REPLACE FUNCTION (task_boost|task_dispatched|contribution_queue_row|seed_auto_task_queue)\(/.test(c));
  assert(c.includes("verify_redispatch_seconds INTEGER NOT NULL DEFAULT 604800"));
  assert(c.includes("CHECK (verify_redispatch_seconds BETWEEN 0 AND 31536000)"));
  assert(c.includes("ADD COLUMN IF NOT EXISTS dispatch_base_at TIMESTAMPTZ"));
});

Deno.test("A3 驗證票的排序鍵程式碼裡沒有任何日期字面值（不再有 1970／1980 年段）", () => {
  for (const n of ["verify_ticket_key", "verify_ticket_freeze_base", "verify_ticket_base", "task_dispatches_queue_key", "refresh_verify_ticket_keys"]) {
    assert(!/19[78]0|2000-01-01|contribution_queue_at\(/.test(code(fnText(MIG, n))), `${n} 不該有年份`);
  }
});

// ============================================================
// B. PGlite
// ============================================================
const SCHEMA = `
CREATE TABLE queue_settings (id smallint PRIMARY KEY, boost_seconds bigint NOT NULL DEFAULT ${BOOST}, visitor_front_seconds bigint NOT NULL DEFAULT 315360000,
  manual_front_seconds bigint NOT NULL DEFAULT 157680000, verify_priority_seconds integer NOT NULL DEFAULT 1209600, dispatch_horizon_seconds integer NOT NULL DEFAULT 86400,
  verify_inherit_negative boolean NOT NULL DEFAULT false, no_change_verify_defer_seconds integer NOT NULL DEFAULT 86400, no_change_verify_redispatch_defer_seconds integer NOT NULL DEFAULT 172800);
INSERT INTO queue_settings (id) VALUES (1);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz NOT NULL DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 1, refreshed_at timestamptz,
  queue_at timestamptz NOT NULL DEFAULT now(), task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb, what_we_need text, hint_sources text[], reward integer, region text,
  blocked boolean NOT NULL DEFAULT false, cooling boolean NOT NULL DEFAULT false, verify_target integer, priority_seconds integer NOT NULL DEFAULT 0,
  boost_seconds bigint NOT NULL DEFAULT 0, cool_until timestamptz, opened_at timestamptz NOT NULL DEFAULT now(), verify_follows_task boolean NOT NULL DEFAULT true,
  defer_seconds integer NOT NULL DEFAULT 0);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, contributor_ip_hash text, agent_name text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, task_type text NOT NULL, source text NOT NULL DEFAULT 'manual', status text NOT NULL DEFAULT 'open', last_dispatched_at timestamptz);
CREATE TABLE task_boosts (id BIGSERIAL PRIMARY KEY, label TEXT, filter JSONB, agent_name TEXT, ip_hash TEXT, matched_tasks INTEGER, matched_verifies INTEGER, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE _boost_src (task_id TEXT, kind TEXT);
CREATE FUNCTION task_boost_matches(p_filter JSONB) RETURNS TABLE(task_id TEXT, kind TEXT) LANGUAGE sql STABLE AS $f$ SELECT task_id, kind FROM _boost_src $f$;
`;
const FN_NAMES = ["uuid_or_null", "uuid_if_canonical", "question_answer_cap", "queue_slot", "task_dispatched", "task_queue_key", "verify_inherited_priority_seconds",
  "verify_ticket_is_new", "verify_ticket_parent", "verify_ticket_priority_seconds", "verify_ticket_defer_seconds", "verify_queue_key", "task_dispatches_queue_key",
  "refresh_verify_ticket_keys", "contribution_queue_row", "task_boost"];
async function oldFns(): Promise<string> {
  const parts: string[] = [];
  for (const n of FN_NAMES) parts.push(await latestFn(n, MIG_NAME));
  return parts.join("\n");
}
const TRIGGERS = `
CREATE TRIGGER trg_task_dispatches_queue_key BEFORE INSERT OR UPDATE ON task_dispatches FOR EACH ROW EXECUTE FUNCTION task_dispatches_queue_key();
CREATE TRIGGER trg_contribution_queue_row AFTER INSERT ON contributions FOR EACH ROW EXECUTE FUNCTION contribution_queue_row();
CREATE OR REPLACE FUNCTION seed_auto_task_queue() RETURNS integer LANGUAGE sql AS $f$ SELECT 0 $f$;
`;
/** 改前（沒套 migration）的資料庫；套 migration 用 apply() */
async function oldEnv(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(await oldFns());
  await db.exec(TRIGGERS);
  return db;
}
async function newEnv(mig: string = MIG): Promise<PGlite> {
  const db = await oldEnv();
  await db.exec(mig);
  return db;
}

let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const q = (s: string) => s.replaceAll("'", "''");
const at = async (db: PGlite, taskId: string, col = "queue_at"): Promise<string> =>
  (await db.query<{ t: string }>(`SELECT to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS t FROM task_dispatches WHERE task_id = '${q(taskId)}'`)).rows[0]!.t;
const secsAgo = async (db: PGlite, taskId: string): Promise<number> =>
  Number((await db.query<{ s: string }>(`SELECT extract(epoch FROM now() - queue_at) AS s FROM task_dispatches WHERE task_id = '${q(taskId)}'`)).rows[0]!.s);
const near = (got: number, want: number, msg: string) => assert(Math.abs(got - want) < 5, `${msg}：得到 ${got.toFixed(1)}，應為 ${want}`);
const iso = (d: string, addDays = 0) => new Date(Date.parse(`${d}T00:00:00Z`) + addDays * DAY * 1000).toISOString().slice(0, 19);

/** 任務列（還沒派出）：進隊時間用絕對日期 */
async function task(db: PGlite, o: { id?: string; type?: string; entered: string; prio?: number; boost?: number }): Promise<string> {
  const id = o.id ?? `auto:${o.type ?? "profile_gap"}:${++n}`;
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, last_dispatched_at, dispatch_count, priority_seconds, boost_seconds)
    VALUES ('${q(id)}', '${o.type ?? "profile_gap"}', '${o.entered}T00:00:00Z', 0, ${o.prio ?? 0}, ${o.boost ?? 0})`);
  return id;
}
async function submit(db: PGlite, o: { type: string; task?: string | null; payloadTask?: string; createdAt?: string }): Promise<{ id: string; vid: string }> {
  const id = uid();
  const payload = o.payloadTask ? JSON.stringify({ task_id: o.payloadTask }) : "{}";
  await db.exec(`INSERT INTO contributions (id, task_id, contribution_type, payload, created_at)
    VALUES ('${id}', ${o.task == null ? "NULL" : `'${q(o.task)}'`}, '${o.type}', '${q(payload)}', ${o.createdAt ? `'${o.createdAt}T00:00:00Z'` : "now()"})`);
  return { id, vid: `verify:${id}` };
}
const dispatch = (db: PGlite, taskId: string) => db.exec(`SELECT task_dispatched('${q(taskId)}')`);

Deno.test("B1 情境表：任務 10/05 與被插隊的任務，派出後交件，票領走 0～4 次的位置逐筆比對（基準 − 14 天 ＋ 7 天 × 次數）", async () => {
  const db = await newEnv();
  const plain = await task(db, { entered: "2026-10-05" });
  const boosted = await task(db, { entered: "2026-10-05", boost: BOOST });
  assertEquals(await at(db, plain), "2026-10-05T00:00:00");
  assertEquals(await at(db, boosted), iso("2026-10-05", -BOOST / DAY));
  // 任務被派出：照舊回隊尾、插隊歸零；派出前的位置記在 dispatch_base_at
  await dispatch(db, plain);
  await dispatch(db, boosted);
  assertEquals(await at(db, plain, "dispatch_base_at"), "2026-10-05T00:00:00", "一般任務：派出前的位置 10/05");
  assertEquals(await at(db, boosted, "dispatch_base_at"), iso("2026-10-05", -BOOST / DAY), "被插隊的任務：含插隊秒數");
  near(await secsAgo(db, plain), 0, "任務本身：回隊尾（≈ 現在）");
  near(await secsAgo(db, boosted), 0, "被插隊的任務：插隊歸零、回隊尾");
  assertEquals((await db.query<{ b: string }>(`SELECT boost_seconds::text AS b FROM task_dispatches WHERE task_id = '${q(boosted)}'`)).rows[0]!.b, "0");
  // 交件 → 驗證票
  const t1 = await submit(db, { type: "correction", task: plain });
  const t2 = await submit(db, { type: "correction", task: boosted });
  const want = (base: string, k: number) => iso(base, -14 + 7 * k);
  const baseBoosted = iso("2026-10-05", -BOOST / DAY).slice(0, 10);
  for (let k = 0; k <= 4; k++) {
    assertEquals(await at(db, t1.vid), want("2026-10-05", k), `一般任務的票，領走 ${k} 次：10/05 − 14 天 ＋ ${7 * k} 天`);
    assertEquals(await at(db, t2.vid), want(baseBoosted, k), `被插隊任務的票，領走 ${k} 次`);
    assertEquals(await at(db, t1.vid, "dispatch_base_at"), "2026-10-05T00:00:00", "基準凍結，領走不改它");
    if (k < 4) { await dispatch(db, t1.vid); await dispatch(db, t2.vid); }
  }
  assertEquals((await db.query<{ n: number }>(`SELECT dispatch_count AS n FROM task_dispatches WHERE task_id = '${t1.vid}'`)).rows[0]!.n, 4);
  // 對照：改前，票看的是母任務回隊尾後的位置（≈ 現在 − 14 天），領走一次又回隊尾
  const old = await oldEnv();
  const op = await task(old, { entered: "2026-10-05" });
  await dispatch(old, op);
  const ot = await submit(old, { type: "correction", task: op });
  near(await secsAgo(old, ot.vid), 14 * DAY, "改前：≈ 現在 − 14 天（跟 10/05 無關）");
  await old.close(); await db.close();
});

Deno.test("B2 沒有基準：新增型、沒經過 /next 派出就交件、無 task_id、母任務在交件之後才又被派出 → 交件建立時間 − 14 天（再加領走次數）", async () => {
  const db = await newEnv();
  const day = (d: string, k = 0) => iso(d, -14 + 7 * k);
  // 新增型（policy）：就算母任務被派出過、有基準，也用交件建立時間
  const p = await task(db, { entered: "2026-10-05", type: "policy_missing" });
  await dispatch(db, p);
  const pol = await submit(db, { type: "policy", task: p, createdAt: "2026-10-20" });
  assertEquals(await at(db, pol.vid), day("2026-10-20"));
  // roster_check 的 candidacy／politician 也是新增型；補欄位任務的 candidacy 是一般任務
  const rc = await task(db, { entered: "2026-10-05", type: "roster_check" });
  await dispatch(db, rc);
  const cand = await submit(db, { type: "candidacy", task: rc, createdAt: "2026-10-21" });
  assertEquals(await at(db, cand.vid), day("2026-10-21"), "roster_check 的 candidacy：新增型");
  // 一般任務但母任務沒有基準（從沒經過 /next 派出：dispatch_count 0）→ 交件建立時間
  const never = await task(db, { entered: "2026-10-05" });
  const s1 = await submit(db, { type: "correction", task: never, createdAt: "2026-10-22" });
  assertEquals(await at(db, s1.vid), day("2026-10-22"), "母任務沒有 dispatch_base_at");
  // 無 task_id、母任務列不存在
  const s2 = await submit(db, { type: "correction", task: null, createdAt: "2026-10-23" });
  const s3 = await submit(db, { type: "correction", task: "auto:gone:1", createdAt: "2026-10-24" });
  assertEquals([await at(db, s2.vid), await at(db, s3.vid)], [day("2026-10-23"), day("2026-10-24")]);
  // 母任務在這張交件「之後」才又被派出：不採用那個基準（它是別人那一次派出前的位置）
  const re = await task(db, { entered: "2026-10-05" });
  await dispatch(db, re);
  const late = await submit(db, { type: "correction", task: re, createdAt: "2026-10-01" });
  assertEquals(await at(db, late.vid), day("2026-10-01"), "交件建立時間早於母任務最近一次派出 → 用交件建立時間");
  // 新增型被領走也 ＋7 天
  await dispatch(db, pol.vid);
  assertEquals(await at(db, pol.vid), day("2026-10-20", 1));
  await db.close();
});

Deno.test("B3 任務列的行為不變：派出照舊插隊歸零、回隊尾；改前改後同一個劇本位置相同（含優先秒數、冷卻）", async () => {
  const run = async (db: PGlite) => {
    const a = await task(db, { entered: "2026-10-05", prio: 3 * DAY });
    const b = await task(db, { entered: "2026-10-06", boost: BOOST, prio: -30 * DAY });
    const before = [await at(db, a), await at(db, b)];
    await dispatch(db, a);
    await dispatch(db, b);
    const boosts = (await db.query<{ b: string }>(`SELECT boost_seconds::text AS b FROM task_dispatches WHERE task_id IN ('${q(a)}', '${q(b)}') ORDER BY task_id`)).rows.map((r) => r.b);
    return { before, after: [await secsAgo(db, a), await secsAgo(db, b)], boosts };
  };
  const old = await oldEnv(), neu = await newEnv();
  const o = await run(old), w = await run(neu);
  assertEquals(w.before.map((x) => x.slice(0, 10)), o.before.map((x) => x.slice(0, 10)), "派出前位置相同");
  assertEquals(w.boosts, o.boosts);
  assertEquals(w.boosts, ["0", "0"], "任務列派出就歸零");
  near(w.after[0], 3 * DAY, "派出後：回隊尾（現在 − 優先秒數），改前一樣");
  near(w.after[0], o.after[0], "改前改後相同");
  near(w.after[1], o.after[1], "負的優先秒數：改前改後相同");
  // 基準記的是「含插隊、負的優先秒數當 0」：b 的 prio −30 天、boost 5 年 → 進隊時間 − 5 年
  assertEquals((await at(neu, (await neu.query<{ task_id: string }>(`SELECT task_id FROM task_dispatches ORDER BY task_id DESC LIMIT 1`)).rows[0]!.task_id, "dispatch_base_at")).slice(0, 10), iso("2026-10-06", -BOOST / DAY).slice(0, 10));
  await old.close(); await neu.close();
});

Deno.test("B4 驗證票的插隊不因派出歸零；母任務之後被插隊或 refresh 都不讓已存在的票移位；/boost 指定票本身才會動", async () => {
  const db = await newEnv();
  const p = await task(db, { entered: "2026-10-05" });
  await dispatch(db, p);
  const t = await submit(db, { type: "correction", task: p });
  const base = iso("2026-10-05", -14);
  assertEquals(await at(db, t.vid), base);
  // 母任務之後被插隊、refresh：票不動
  await db.exec(`UPDATE task_dispatches SET boost_seconds = ${BOOST} WHERE task_id = '${q(p)}'`);
  assertEquals((await db.query<{ n: number }>(`SELECT refresh_verify_ticket_keys() AS n`)).rows[0]!.n, 0, "refresh 沒有票需要換位置");
  assertEquals(await at(db, t.vid), base, "母任務被插隊：已存在的票不跟著動");
  // 插隊指定票本身（task_boost）：每次減 boost_seconds
  await db.exec(`INSERT INTO _boost_src VALUES ('${t.vid}', 'verify')`);
  await db.exec(`SELECT task_boost('a', '{}'::jsonb)`);
  assertEquals(await at(db, t.vid), iso("2026-10-05", -14 - BOOST / DAY), "插一次：減 5 年");
  // 領走：插隊秒數保留、位置只多 7 天
  await dispatch(db, t.vid);
  assertEquals((await db.query<{ b: string }>(`SELECT boost_seconds::text AS b FROM task_dispatches WHERE task_id = '${t.vid}'`)).rows[0]!.b, String(BOOST), "驗證票的插隊不因派出歸零");
  assertEquals(await at(db, t.vid), iso("2026-10-05", -14 - BOOST / DAY + 7));
  // 任務列一旦被派出，插隊還是歸零（對照）
  await dispatch(db, p);
  assertEquals((await db.query<{ b: string }>(`SELECT boost_seconds::text AS b FROM task_dispatches WHERE task_id = '${q(p)}'`)).rows[0]!.b, "0");
  // 設定改了（7 天 → 3 天），refresh 依凍結值重算
  await db.exec(`UPDATE queue_settings SET verify_redispatch_seconds = ${3 * DAY} WHERE id = 1`);
  assertEquals((await db.query<{ n: number }>(`SELECT refresh_verify_ticket_keys() AS n`)).rows[0]!.n, 1);
  assertEquals(await at(db, t.vid), iso("2026-10-05", -14 - BOOST / DAY + 3));
  await db.close();
});

Deno.test("B5 no_change 的延後保留：第一次進隊 1 天、被領走後 2 天（不累加）；網站請求來源不延後", async () => {
  const db = await newEnv();
  const p = await task(db, { entered: "2026-10-05" });
  await dispatch(db, p);
  const nc = await submit(db, { type: "no_change", task: p });
  assertEquals(await at(db, nc.vid), iso("2026-10-05", -14 + 1), "進隊：基準 − 14 天 ＋ 1 天延後");
  await dispatch(db, nc.vid);
  assertEquals(await at(db, nc.vid), iso("2026-10-05", -14 + 7 + 2), "領走一次：＋7 天 ＋ 2 天延後");
  await dispatch(db, nc.vid);
  assertEquals(await at(db, nc.vid), iso("2026-10-05", -14 + 14 + 2), "再領一次：延後不累加（仍 2 天），＋7 天累加");
  const web = uid();
  await db.exec(`INSERT INTO contribution_tasks (id, task_type, source) VALUES ('${web}', 'policy_missing', 'web_request')`);
  await task(db, { id: web, type: "policy_missing", entered: "2026-10-05" });
  await dispatch(db, web);
  const wnc = await submit(db, { type: "no_change", task: web });
  assertEquals(await at(db, wnc.vid), iso("2026-10-05", -14), "網站請求來源的 no_change 不延後");
  await db.close();
});

Deno.test("B6 既有的票過渡：套 migration 前後 queue_at 一張都沒動（領走過的、插隊中的、延後的、各種領走次數），之後被領走才開始 ＋7 天", async () => {
  const db = await oldEnv();
  const parents: string[] = [];
  for (let i = 0; i < 4; i++) { const p = await task(db, { entered: iso("2026-10-05", i).slice(0, 10), boost: i % 2 ? BOOST : 0, prio: i * DAY }); await dispatch(db, p); parents.push(p); }
  const tickets: string[] = [];
  const types = ["correction", "no_change", "policy", "correction", "candidacy", "no_change"];
  for (let i = 0; i < 6; i++) tickets.push((await submit(db, { type: types[i]!, task: parents[i % 4]!, createdAt: iso("2026-10-10", i).slice(0, 10) })).vid);
  // 領走 0～4 次、其中兩張帶插隊秒數（跟 #96 一樣）
  for (let i = 0; i < tickets.length; i++) for (let k = 0; k < i % 5; k++) await dispatch(db, tickets[i]!);
  await db.exec(`UPDATE task_dispatches SET boost_seconds = ${BOOST} WHERE task_id IN ('${tickets[1]}', '${tickets[4]}')`);
  const snap = async () => (await db.query<{ task_id: string; q: string; c: number; b: string }>(
    `SELECT task_id, queue_at::text AS q, dispatch_count AS c, boost_seconds::text AS b FROM task_dispatches WHERE task_id LIKE 'verify:%' ORDER BY task_id`)).rows;
  const before = await snap();
  assertEquals(before.length, 6);
  assert(before.some((r) => r.c >= 3) && before.some((r) => r.b !== "0"), "情境有領走多次與插隊中的票");
  await db.exec(MIG); // 過渡
  const after = await snap();
  assertEquals(after.map((r) => [r.task_id, r.q, r.c, r.b]), before.map((r) => [r.task_id, r.q, r.c, r.b]), "套 migration 前後完全一樣：不跳位、插隊保留");
  assertEquals((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'verify:%' AND dispatch_base_at IS NULL`)).rows[0]!.n, 0, "每張都凍結了基準");
  assertEquals((await db.query<{ n: number }>(`SELECT refresh_verify_ticket_keys() AS n`)).rows[0]!.n, 0, "之後 refresh 也不會動它們");
  // 之後被領走：多 7 天，插隊不歸零
  const vid = tickets[1]!;
  const was = await at(db, vid);
  await dispatch(db, vid);
  const wasMs = Date.parse(was + "Z");
  assertEquals(Date.parse((await at(db, vid)) + "Z") - wasMs, 7 * DAY * 1000, "領走一次剛好 ＋7 天（no_change 的延後本來就是 2 天，已在凍結值裡）");
  assertEquals((await db.query<{ b: string }>(`SELECT boost_seconds::text AS b FROM task_dispatches WHERE task_id = '${vid}'`)).rows[0]!.b, String(BOOST));
  await db.close();
});

// ============================================================
// C. 還原驗證
// ============================================================
/** 劇本：一般任務 10/05 派出、交件、票領走 2 次 → 回傳 [基準, 票位置, 票的插隊秒數] */
async function scenario(mig: string): Promise<[string, string, string]> {
  const db = await newEnv(mig);
  const p = await task(db, { entered: "2026-10-05" });
  await dispatch(db, p);
  const t = await submit(db, { type: "correction", task: p });
  await db.exec(`UPDATE task_dispatches SET boost_seconds = 1000 WHERE task_id = '${t.vid}'`);
  await dispatch(db, t.vid);
  await dispatch(db, t.vid);
  const out: [string, string, string] = [await at(db, t.vid, "dispatch_base_at"), await at(db, t.vid), (await db.query<{ b: string }>(`SELECT boost_seconds::text AS b FROM task_dispatches WHERE task_id = '${t.vid}'`)).rows[0]!.b];
  await db.close();
  return out;
}

Deno.test("C1 正常版的劇本：基準 10/05、票＝10/05 − 14 天 ＋ 14 天（領走兩次）− 1000 秒、插隊保留", async () => {
  assertEquals(await scenario(MIG), ["2026-10-05T00:00:00", "2026-10-04T23:43:20", "1000"]);
});

Deno.test("C2 還原驗證：任務列派出時不記派出前的位置 → 票的基準退回交件時間，劇本翻面", async () => {
  const bad = mutate(MIG, "    NEW.dispatch_base_at := task_queue_key(\n", "    NEW.dispatch_base_at := NULL; PERFORM task_queue_key(\n");
  const [base] = await scenario(bad);
  assert(base !== "2026-10-05T00:00:00");
});

Deno.test("C3 還原驗證：驗證票派出也歸零插隊 → 劇本的插隊秒數變 0", async () => {
  const bad = mutate(MIG, "AND NEW.task_id NOT LIKE 'verify:%' THEN\n    NEW.dispatch_base_at", "THEN\n    NEW.dispatch_base_at");
  const [, , boost] = await scenario(bad);
  assertEquals(boost, "0");
});

Deno.test("C4 還原驗證：拿掉每次領走的 7 天（公式少乘 dispatch_count）→ 票的位置翻面", async () => {
  const bad = mutate(MIG, "s.step::double precision * COALESCE(p_dispatch_count, 0) + COALESCE(p_defer_seconds, 0))\n    FROM (SELECT COALESCE((SELECT q.verify_priority_seconds FROM queue_settings q WHERE q.id = 1), 0) AS vs,\n                 COALESCE((SELECT q.verify_redispatch_seconds FROM queue_settings q WHERE q.id = 1), 0) AS step) s\n$$;\nCOMMENT ON FUNCTION verify_ticket_key",
    "COALESCE(p_defer_seconds, 0))\n    FROM (SELECT COALESCE((SELECT q.verify_priority_seconds FROM queue_settings q WHERE q.id = 1), 0) AS vs,\n                 COALESCE((SELECT q.verify_redispatch_seconds FROM queue_settings q WHERE q.id = 1), 0) AS step) s\n$$;\nCOMMENT ON FUNCTION verify_ticket_key");
  const [, pos] = await scenario(bad);
  assert(pos !== "2026-10-04T23:43:20");
});

Deno.test("C5 還原驗證：回填基準少減一項（不減 dispatch_count × 7 天）→ 自我檢查讓 migration 失敗", async () => {
  const bad = mutate(MIG, "- make_interval(secs => s.step::double precision * COALESCE(p_dispatch_count, 0) + COALESCE(p_defer_seconds, 0))\n    FROM (SELECT COALESCE((SELECT q.verify_priority_seconds FROM queue_settings q WHERE q.id = 1), 0) AS vs,\n                 COALESCE((SELECT q.verify_redispatch_seconds FROM queue_settings q WHERE q.id = 1), 0) AS step) s\n$$;\nCOMMENT ON FUNCTION verify_ticket_freeze_base",
    "- make_interval(secs => COALESCE(p_defer_seconds, 0))\n    FROM (SELECT COALESCE((SELECT q.verify_priority_seconds FROM queue_settings q WHERE q.id = 1), 0) AS vs,\n                 COALESCE((SELECT q.verify_redispatch_seconds FROM queue_settings q WHERE q.id = 1), 0) AS step) s\n$$;\nCOMMENT ON FUNCTION verify_ticket_freeze_base");
  const db = await oldEnv();
  const p = await task(db, { entered: "2026-10-05" });
  await dispatch(db, p);
  const t = await submit(db, { type: "correction", task: p });
  await dispatch(db, t.vid);
  let msg = "";
  try { await db.exec(bad); } catch (e) { msg = String(e); }
  assert(msg.includes("驗證票排序過渡失敗"), `自我檢查沒擋住：${msg.slice(0, 120)}`);
  await db.close();
  // 正常版同一個資料套得過
  const ok = await oldEnv();
  const p2 = await task(ok, { entered: "2026-10-05" });
  await dispatch(ok, p2);
  const t2 = await submit(ok, { type: "correction", task: p2 });
  await dispatch(ok, t2.vid);
  await ok.exec(MIG);
  await ok.close();
});
