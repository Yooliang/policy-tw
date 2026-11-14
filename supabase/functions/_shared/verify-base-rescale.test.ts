/**
 * 驗證票基準補回舊插隊（migration 20261114070000_verify_base_rescale_legacy_boost.sql＋20261114070100_verify_base_clamp.sql，2026-11-14）。
 *
 *   A. 一次性修正：已開未結案的驗證票，dispatch_base_at 帶著舊的 5／10／15 年插隊，補 (舊 − 新) 秒；queue_at 由觸發器跟著動；冪等；不該動的不動
 *   B. 夾限：驗證票入列時從母任務抄的基準，不早於「母任務不含插隊的位置 − (最大合法插隊 ＋ verify_priority_seconds)」；最大值讀 queue_settings
 *   C. 文字層：兩支 migration 的範圍
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const FIX_NAME = "20261114070000_verify_base_rescale_legacy_boost.sql";
const CLAMP_NAME = "20261114070100_verify_base_clamp.sql";
const FIX = await readMig(FIX_NAME);
const CLAMP = await readMig(CLAMP_NAME);
const DAY = 86400;
const FIVE_Y = 157680000;

const SCHEMA = `
CREATE TABLE queue_settings (id smallint PRIMARY KEY, boost_seconds bigint NOT NULL DEFAULT 2592000, manual_front_seconds bigint NOT NULL DEFAULT 2592000,
  visitor_front_seconds bigint NOT NULL DEFAULT 4320000, visitor_front_pre_election_seconds bigint NOT NULL DEFAULT 8640000,
  verify_priority_seconds integer NOT NULL DEFAULT 1209600, verify_redispatch_seconds integer NOT NULL DEFAULT 604800,
  verify_no_change_redispatch_seconds integer NOT NULL DEFAULT 1209600, verify_inherit_negative boolean NOT NULL DEFAULT false);
INSERT INTO queue_settings (id) VALUES (1);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz NOT NULL DEFAULT '2026-11-12T00:00:00Z', dispatch_count integer NOT NULL DEFAULT 0,
  queue_at timestamptz NOT NULL DEFAULT now(), target jsonb NOT NULL DEFAULT '{}'::jsonb, priority_seconds integer NOT NULL DEFAULT 0, boost_seconds bigint NOT NULL DEFAULT 0, task_type text,
  cool_until timestamptz, verify_follows_task boolean NOT NULL DEFAULT true, dispatch_base_at timestamptz, opened_by jsonb);
CREATE TABLE contributions (id uuid PRIMARY KEY, task_id text, contribution_type text, status text NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT '2026-11-13T00:00:00Z');
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, task_type text NOT NULL, source text NOT NULL DEFAULT 'manual');
-- 選前／選後的判斷在 visitor_front_seconds_for（20261114020000，另有測試）；這裡只要它回傳兩種值之一
CREATE FUNCTION visitor_front_seconds_for(p JSONB) RETURNS BIGINT LANGUAGE sql STABLE AS $f$ SELECT CASE WHEN p->>'election_id' = '2026' THEN 8640000::BIGINT ELSE 4320000::BIGINT END $f$;
CREATE FUNCTION verify_ticket_election_seconds(p TEXT) RETURNS BIGINT LANGUAGE sql STABLE AS $f$ SELECT 0::BIGINT $f$;
CREATE FUNCTION verify_ticket_priority_seconds(p TEXT) RETURNS INTEGER LANGUAGE sql STABLE AS $f$ SELECT 0 $f$;
`;
const FN_NAMES = ["uuid_or_null", "task_queue_key", "manual_task_is_visitor", "verify_ticket_is_new", "verify_ticket_parent", "verify_ticket_step_seconds",
  "verify_ticket_key", "verify_ticket_freeze_base", "verify_ticket_base", "task_dispatches_queue_key"];

async function env(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const n of FN_NAMES) await db.exec(await latestFn(n, FIX_NAME));
  await db.exec(`CREATE TRIGGER trg_task_dispatches_queue_key BEFORE INSERT OR UPDATE ON task_dispatches FOR EACH ROW EXECUTE FUNCTION task_dispatches_queue_key();`);
  return db;
}

let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const q = (s: string) => s.replaceAll("'", "''");
const iso = (d: string, addDays = 0) => new Date(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) + addDays * DAY * 1000).toISOString().slice(0, 19);
const col = async (db: PGlite, id: string, c: string): Promise<string> =>
  (await db.query<{ t: string }>(`SELECT to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS t FROM task_dispatches WHERE task_id = '${q(id)}'`)).rows[0]!.t;

/** 母任務列：last_dispatched_at 2026-11-12、priority 1000 天 → 不含插隊的位置 U ＝ 2026-11-12 − 1000 天 */
const PRIO_DAYS = 1000;
const U0 = iso("2026-11-12", -PRIO_DAYS);
async function parent(db: PGlite, id: string, o: { target?: string; openedBy?: string } = {}): Promise<string> {
  await db.exec(`INSERT INTO task_dispatches (task_id, last_dispatched_at, priority_seconds, target, opened_by, dispatch_base_at)
    VALUES ('${q(id)}', '2026-11-12T00:00:00Z', ${PRIO_DAYS * DAY}, '${o.target ?? "{}"}', ${o.openedBy ? `'${o.openedBy}'` : "NULL"}, NULL)`);
  return id;
}
/** 驗證票：基準＝U 往前 baseBackDays 天；contribution 狀態 status */
async function ticket(db: PGlite, o: { parent: string | null; baseBackDays: number; status?: string; type?: string }): Promise<string> {
  const id = uid();
  await db.exec(`INSERT INTO contributions (id, task_id, contribution_type, status) VALUES ('${id}', ${o.parent == null ? "NULL" : `'${q(o.parent)}'`}, '${o.type ?? "politician"}', '${o.status ?? "pending"}')`);
  await db.exec(`INSERT INTO task_dispatches (task_id, dispatch_base_at, dispatch_count) VALUES ('verify:${id}', '${iso(U0, -o.baseBackDays)}Z', 2)`);
  return `verify:${id}`;
}

// ============================================================
// A. 一次性修正
// ============================================================
Deno.test("A1 換算：5 年→30 天、10 年網站請求→選前 100 天／選後 50 天、10 年非網站請求→60 天、15 年→90 天；queue_at 由觸發器跟著動", async () => {
  const db = await env();
  const pAuto = await parent(db, "auto:profile_gap:1");
  const web = uid(), web2 = uid(), man = uid();
  await db.exec(`INSERT INTO contribution_tasks VALUES ('${web}', 'policy_missing', 'web_request'), ('${web2}', 'policy_missing', 'web_request'), ('${man}', 'audit', 'manual')`);
  const pWebPre = await parent(db, web, { target: '{"election_id":2026}' });
  const pWebPost = await parent(db, web2, { target: '{"election_id":2022}' });
  const pMan = await parent(db, man);
  const pGap = await parent(db, "auto:gap:x", { openedBy: '{"web_request_boost_ids":["a"]}', target: '{"election_id":2026}' });
  const pFifteen = await parent(db, "auto:policy_missing:15");
  // 帶舊插隊的基準：U − 舊插隊（5 年＝157680000 秒＝1825 天）− 母任務等了幾天（正常的等待）
  const Y5 = FIVE_Y / DAY;
  const t5 = await ticket(db, { parent: pAuto, baseBackDays: Y5 + 7 });
  const t10pre = await ticket(db, { parent: pWebPre, baseBackDays: 2 * Y5 + 3 });
  const t10post = await ticket(db, { parent: pWebPost, baseBackDays: 2 * Y5 + 20 });
  const t10man = await ticket(db, { parent: pMan, baseBackDays: 2 * Y5 });
  const t10gap = await ticket(db, { parent: pGap, baseBackDays: 2 * Y5 + 1 });
  const t15 = await ticket(db, { parent: pFifteen, baseBackDays: 3 * Y5 + 10 });
  const all = [t5, t10pre, t10post, t10man, t10gap, t15];
  const before: Record<string, [string, string]> = {};
  for (const t of all) before[t] = [await col(db, t, "dispatch_base_at"), await col(db, t, "queue_at")];
  await db.exec(FIX);
  // 補的秒數＝舊插隊 − 新插隊
  const shift = (k: number, newBoostDays: number) => k * Y5 - newBoostDays;
  const want: Array<[string, number]> = [[t5, shift(1, 30)], [t10pre, shift(2, 100)], [t10post, shift(2, 50)], [t10man, shift(2, 60)], [t10gap, shift(2, 100)], [t15, shift(3, 90)]];
  for (const [t, days] of want) {
    const [b0, q0] = before[t]!;
    assertEquals(await col(db, t, "dispatch_base_at"), iso(b0, days), `${t} 基準`);
    // queue_at ＝ 基準 − 14 天 ＋ 2 次領走 × 7 天（觸發器重算），所以也往後移同樣的天數
    assertEquals(await col(db, t, "queue_at"), iso(q0, days), `${t} queue_at 跟著動（不是手動改）`);
  }
  // 補完以後：基準都落在 U 之前一個合法插隊加等待的範圍內
  const gaps = (await db.query<{ g: string }>(`SELECT extract(epoch FROM (task_queue_key(p.last_dispatched_at, p.priority_seconds, NULL, 0) - d.dispatch_base_at)) / 86400 AS g
     FROM task_dispatches d JOIN contributions c ON 'verify:' || c.id = d.task_id JOIN task_dispatches p ON p.task_id = c.task_id WHERE d.task_id LIKE 'verify:%'`)).rows;
  assertEquals(gaps.length, 6);
  for (const r of gaps) assert(Number(r.g) < 121, `補完後差距 ${r.g} 天應小於 121`);
});

Deno.test("A2 冪等：第二次、第三次跑一張都不動（基準與 queue_at 都不變）", async () => {
  const db = await env();
  const p = await parent(db, "auto:profile_gap:2");
  const t = await ticket(db, { parent: p, baseBackDays: FIVE_Y / DAY + 5 });
  await db.exec(FIX);
  const first = [await col(db, t, "dispatch_base_at"), await col(db, t, "queue_at")];
  await db.exec(FIX);
  await db.exec(FIX);
  assertEquals([await col(db, t, "dispatch_base_at"), await col(db, t, "queue_at")], first);
  assertEquals(first[0], iso(U0, -(FIVE_Y / DAY + 5) + (FIVE_Y / DAY - 30)), "第一次確實補了 5 年→30 天");
});

Deno.test("A3 不該動的不動：已結案、正常的票（差距小）、沒有母任務列、差距不像舊插隊（不是 5 年的整數倍）", async () => {
  const db = await env();
  const p = await parent(db, "auto:profile_gap:3");
  const Y5 = FIVE_Y / DAY;
  const closedApplied = await ticket(db, { parent: p, baseBackDays: Y5, status: "applied" });
  const closedRejected = await ticket(db, { parent: p, baseBackDays: 2 * Y5, status: "rejected" });
  const normal = await ticket(db, { parent: p, baseBackDays: 30 });
  const normal100 = await ticket(db, { parent: p, baseBackDays: 100 }); // 母任務等了 100 天，還在門檻（121 天）內
  const noParent = await ticket(db, { parent: "auto:gone:1", baseBackDays: Y5 }); // 母任務列已不在
  const noTaskId = await ticket(db, { parent: null, baseBackDays: Y5 });
  const odd = await ticket(db, { parent: p, baseBackDays: 3 * 365 }); // 約 3 年：不像 5 年的整數倍
  const all = [closedApplied, closedRejected, normal, normal100, noParent, noTaskId, odd];
  const snap = () => Promise.all(all.map(async (t) => [await col(db, t, "dispatch_base_at"), await col(db, t, "queue_at")]));
  const before = await snap();
  await db.exec(FIX);
  assertEquals(await snap(), before);
});

Deno.test("A4 門檻讀 queue_settings：最大合法插隊調到 200 天時，差距 150 天的正常票仍不動；5 年的照補", async () => {
  const db = await env();
  await db.exec(`UPDATE queue_settings SET visitor_front_pre_election_seconds = ${200 * DAY}`);
  const p = await parent(db, "auto:profile_gap:4");
  const Y5 = FIVE_Y / DAY;
  const t150 = await ticket(db, { parent: p, baseBackDays: 150 });
  const t5 = await ticket(db, { parent: p, baseBackDays: Y5 });
  const b150 = await col(db, t150, "dispatch_base_at");
  await db.exec(FIX);
  assertEquals(await col(db, t150, "dispatch_base_at"), b150);
  assertEquals(await col(db, t5, "dispatch_base_at"), iso(U0, -Y5 + (Y5 - 30)));
});

// ============================================================
// B. 夾限
// ============================================================
async function clampEnv(): Promise<PGlite> {
  const db = await env();
  await db.exec(CLAMP);
  return db;
}
/** 母任務列（帶 dispatch_base_at）＋一筆交件，回傳驗證票 id */
async function submitTo(db: PGlite, parentBase: string): Promise<string> {
  const pid = `auto:profile_gap:b${++n}`;
  await db.exec(`INSERT INTO task_dispatches (task_id, last_dispatched_at, priority_seconds, dispatch_base_at) VALUES ('${pid}', '2026-11-12T00:00:00Z', ${PRIO_DAYS * DAY}, '${parentBase}Z')`);
  const id = uid();
  await db.exec(`INSERT INTO contributions (id, task_id, contribution_type, created_at) VALUES ('${id}', '${pid}', 'politician', '2026-11-13T00:00:00Z')`);
  return `verify:${id}`;
}
const baseOf = async (db: PGlite, vid: string) =>
  (await db.query<{ t: string }>(`SELECT to_char(verify_ticket_base('${vid}') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS t`)).rows[0]!.t;

Deno.test("B1 夾限生效：母任務的基準帶 5 年舊插隊 → 夾在 U − (100 天 ＋ 14 天)", async () => {
  const db = await clampEnv();
  const vid = await submitTo(db, iso(U0, -FIVE_Y / DAY));
  assertEquals(await baseOf(db, vid), iso(U0, -(100 + 14)));
});

Deno.test("B2 正常票不受影響：基準在夾限範圍內（沒插隊、等了幾天、插隊 100 天）原樣抄", async () => {
  const db = await clampEnv();
  for (const back of [0, 20, 100, 113]) {
    assertEquals(await baseOf(db, await submitTo(db, iso(U0, -back))), iso(U0, -back), `往前 ${back} 天`);
  }
  assertEquals(await baseOf(db, await submitTo(db, iso(U0, 5))), iso(U0, 5), "夾限只管下限");
});

Deno.test("B3 夾限寬度讀 queue_settings 四個插隊值的最大者＋verify_priority_seconds，不寫死 100 天", async () => {
  const db = await clampEnv();
  const floor = async () => Number((await db.query<{ s: string }>(`SELECT verify_ticket_base_floor_seconds() AS s`)).rows[0]!.s);
  assertEquals(await floor(), (100 + 14) * DAY);
  for (const [c, days] of [["boost_seconds", 130], ["manual_front_seconds", 140], ["visitor_front_seconds", 150], ["visitor_front_pre_election_seconds", 160]] as const) {
    await db.exec(`UPDATE queue_settings SET boost_seconds = 2592000, manual_front_seconds = 2592000, visitor_front_seconds = 4320000, visitor_front_pre_election_seconds = 8640000`);
    await db.exec(`UPDATE queue_settings SET ${c} = ${days * DAY}`);
    assertEquals(await floor(), (days + 14) * DAY, c);
  }
  await db.exec(`UPDATE queue_settings SET boost_seconds = 2592000, manual_front_seconds = 2592000, visitor_front_seconds = 4320000, visitor_front_pre_election_seconds = 8640000, verify_priority_seconds = ${30 * DAY}`);
  assertEquals(await baseOf(db, await submitTo(db, iso(U0, -FIVE_Y / DAY))), iso(U0, -(100 + 30)));
});

Deno.test("B4 入列路徑：真的把驗證票插進去（沒給基準）→ 基準被夾、queue_at ＝ 夾後基準 − 14 天", async () => {
  const db = await clampEnv();
  const pid = "auto:profile_gap:ins";
  await db.exec(`INSERT INTO task_dispatches (task_id, last_dispatched_at, priority_seconds, dispatch_base_at) VALUES ('${pid}', '2026-11-12T00:00:00Z', ${PRIO_DAYS * DAY}, '${iso(U0, -FIVE_Y / DAY)}Z')`);
  const id = uid();
  await db.exec(`INSERT INTO contributions (id, task_id, contribution_type, created_at) VALUES ('${id}', '${pid}', 'politician', '2026-11-13T00:00:00Z')`);
  await db.exec(`INSERT INTO task_dispatches (task_id, dispatch_count) VALUES ('verify:${id}', 0)`);
  assertEquals(await col(db, `verify:${id}`, "dispatch_base_at"), iso(U0, -(100 + 14)));
  assertEquals(await col(db, `verify:${id}`, "queue_at"), iso(U0, -(100 + 14 + 14)));
});

// ============================================================
// C. 文字層
// ============================================================
Deno.test("C1 補回 migration：只動 dispatch_base_at（不手動改 queue_at）、只動 pending、不碰函式與設定、門檻不寫死", () => {
  const c = FIX.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/CREATE (OR REPLACE )?FUNCTION|ALTER TABLE|DROP (TABLE|FUNCTION)/.test(c));
  assert(!/\bSET\s+queue_at\s*=/.test(c), "不手動 UPDATE queue_at");
  assert(c.includes("c.status = 'pending'"));
  assert(c.includes("157680000") && c.includes("2592000") && c.includes("5184000") && c.includes("7776000"));
  assert(!c.includes("8640000"), "門檻讀 queue_settings，不寫死 100 天");
});

Deno.test("C2 夾限 migration：verify_ticket_base 只差標記的一處（其餘與前一版逐字相同）、新函式只讀 queue_settings、觸發器與排序鍵不動", async () => {
  const prev = await latestFn("verify_ticket_base", CLAMP_NAME);
  const neu = fnText(CLAMP, "verify_ticket_base");
  const strip = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join(" ").replace(/\s+/g, " ").trim();
  const noClamp = neu.replace(/SELECT GREATEST\(p\.dispatch_base_at,[^\n]*\n[^\n]*\n\s*FROM task_dispatches p/, "SELECT p.dispatch_base_at FROM task_dispatches p");
  assertEquals(strip(noClamp), strip(prev));
  assert(neu.includes(">>> 基準夾限"));
  const floor = fnText(CLAMP, "verify_ticket_base_floor_seconds");
  assert(floor.includes("GREATEST(q.boost_seconds, q.manual_front_seconds, q.visitor_front_seconds, q.visitor_front_pre_election_seconds)") && floor.includes("q.verify_priority_seconds"));
  assert(!/CREATE OR REPLACE FUNCTION (task_dispatches_queue_key|verify_ticket_key|refresh_verify_ticket_keys)\(/.test(CLAMP));
});
