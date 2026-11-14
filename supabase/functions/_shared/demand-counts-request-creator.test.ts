/**
 * 需求加權：網站請求的第一個請求者也算一個單位（migration 20261114030000_demand_counts_request_creator.sql，維護者 2026-11-14）。
 *
 *   同一來源（ipHash）對同一件照擋（work_card_signals 唯一鍵）；不同人請求同一件各算一個單位（+2 天、上限 14 天）。
 *   缺口：建立任務的第一個請求者原本沒寫訊號。這支在需求公式補算。
 *
 *   A. 文字層：兩支函式只差標記區塊
 *   B. PGlite：A 建立、B 請求 → 2 單位；A 再按 → 仍 2；B 再按 → 仍 2；只有 A → 1 單位；舊訊號過期不補算；refresh 把只有建立者的卡納入
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261114030000_demand_counts_request_creator.sql";
const MIG = await readMig(MIG_NAME);
const BASE = await readMig("20261112070000_work_card_demand.sql");
const DAY = 86400;

Deno.test("A1 兩支函式只差標記區塊與引用，拿掉區塊與引用後與 20261112070000 一字不差", () => {
  for (const name of ["work_card_demand_seconds", "work_card_demand_refresh"]) {
    const neu = fnText(MIG, name);
    const stripped = neu
      .replace(/    -- >>> 第一個請求者也算一個單位[^\n]*\n[\s\S]*?    -- <<< 第一個請求者也算一個單位\n/, "")
      .replace(/  -- >>> 第一個請求者也算一個單位[^\n]*\n[\s\S]*?  -- <<< 第一個請求者也算一個單位\n/, "")
      .replace("(sig.direct + creators.n + GREATEST", "(sig.direct + GREATEST")
      .replace("FROM s, sig, card, creators", "FROM s, sig, card");
    assertNotEquals(stripped, neu, `${name} 有標記區塊`);
    assertEquals(stripped, fnText(BASE, name), name);
  }
});

const SCHEMA = `
CREATE TABLE queue_settings (id smallint PRIMARY KEY);
INSERT INTO queue_settings (id) VALUES (1);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, work_key text, dispatch_count integer NOT NULL DEFAULT 0, priority_seconds integer NOT NULL DEFAULT 0);
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, status text NOT NULL DEFAULT 'open',
  requester_ip_hash text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE _ladder (work_key text PRIMARY KEY, closed boolean NOT NULL DEFAULT false, check_cool_until timestamptz);
CREATE FUNCTION work_key_ladder_state(p_work_key TEXT)
RETURNS TABLE (checks BIGINT, closed BOOLEAN, closed_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, cool_until TIMESTAMPTZ, check_cool_until TIMESTAMPTZ)
LANGUAGE sql STABLE AS $f$
  SELECT 0::bigint, COALESCE((SELECT l.closed FROM _ladder l WHERE l.work_key = p_work_key), false), NULL::timestamptz, NULL::timestamptz,
         NULL::timestamptz, (SELECT l.check_cool_until FROM _ladder l WHERE l.work_key = p_work_key)
$f$;
`;
const cols = /ALTER TABLE queue_settings[\s\S]*?;\n/.exec(BASE)![0];
const tables = /CREATE TABLE IF NOT EXISTS work_card_signals[\s\S]*?\n\);\nCREATE INDEX[^\n]*\n/.exec(BASE)![0] +
  /CREATE TABLE IF NOT EXISTS work_cards[\s\S]*?\n\);\n/.exec(BASE)![0];

async function env(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(cols);
  await db.exec(tables);
  await db.exec(fnText(BASE, "work_card_signal_add"));
  await db.exec(fnText(MIG, "work_card_demand_seconds"));
  await db.exec(fnText(MIG, "work_card_demand_refresh"));
  return db;
}
const demand = async (db: PGlite, wk = "politician:p1:policies:2026"): Promise<number> =>
  Number((await db.query<{ v: string }>(`SELECT work_card_demand_seconds('${wk}')::text AS v`)).rows[0]!.v);
/** 模擬 request-task：沒有卡 → 建立手動任務（不寫訊號）；已有開著的任務 → 寫一筆 request 訊號（唯一鍵擋同人） */
async function request(db: PGlite, actor: string, wk = "politician:p1:policies:2026"): Promise<void> {
  const open = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM task_dispatches WHERE work_key = '${wk}'`)).rows[0]!.n;
  if (open === "0") {
    const id = crypto.randomUUID();
    await db.exec(`INSERT INTO contribution_tasks (id, source, requester_ip_hash) VALUES ('${id}', 'web_request', '${actor}')`);
    await db.exec(`INSERT INTO task_dispatches (task_id, work_key) VALUES ('${id}', '${wk}')`);
  } else {
    await db.exec(`SELECT work_card_signal_add('${wk}', 'request', '${actor}')`);
  }
}

Deno.test("B1 A 建立、B 請求 → 2 單位；A 再按 → 仍 2；B 再按 → 仍 2", async () => {
  const db = await env();
  assertEquals(await demand(db), 0);
  await request(db, "ipA");
  assertEquals(await demand(db), 1 * 2 * DAY, "只有建立者 A：1 單位");
  await request(db, "ipB");
  assertEquals(await demand(db), 2 * 2 * DAY, "A 建立、B 請求：2 單位");
  await request(db, "ipA");
  assertEquals(await demand(db), 2 * 2 * DAY, "A 再按：A 補寫自己的訊號，不再補算建立者，仍 2");
  await request(db, "ipB");
  assertEquals(await demand(db), 2 * 2 * DAY, "B 再按：唯一鍵擋住，仍 2");
  await db.close();
});

Deno.test("B2 同 IP 在 A 之後多次請求不累加；第三個人到來 +1；上限 14 天", async () => {
  const db = await env();
  for (const a of ["ipA", "ipA", "ipA", "ipB", "ipC"]) await request(db, a);
  assertEquals(await demand(db), 3 * 2 * DAY);
  for (let i = 0; i < 20; i++) await request(db, `ip${i}x`);
  assertEquals(await demand(db), 14 * DAY, "上限 14 天");
  await db.close();
});

Deno.test("B3 不是網站請求建的任務、已關閉的任務、超過訊號期限的任務都不補算", async () => {
  const db = await env();
  const wk = "politician:p2:policies:2026";
  const mk = async (src: string, status: string, ageDays: number, ip: string) => {
    const id = crypto.randomUUID();
    await db.exec(`INSERT INTO contribution_tasks (id, source, status, requester_ip_hash, created_at) VALUES ('${id}', '${src}', '${status}', '${ip}', now() - interval '${ageDays} days')`);
    await db.exec(`INSERT INTO task_dispatches (task_id, work_key) VALUES ('${id}', '${wk}')`);
  };
  await mk("manual", "open", 0, "m1");
  await mk("web_request", "done", 0, "m2");
  await mk("web_request", "open", 31, "m3");
  assertEquals(await demand(db, wk), 0);
  await mk("web_request", "open", 1, "m4");
  assertEquals(await demand(db, wk), 2 * DAY);
  await db.close();
});

Deno.test("B4 refresh：只有建立者、沒有任何訊號的卡也會被重算進快照", async () => {
  const db = await env();
  await request(db, "ipA");
  const n = (await db.query<{ n: number }>(`SELECT work_card_demand_refresh() AS n`)).rows[0]!.n;
  assert(n >= 1);
  const row = (await db.query<{ s: string }>(`SELECT demand_seconds::text AS s FROM work_cards WHERE work_key = 'politician:p1:policies:2026'`)).rows[0];
  assertEquals(Number(row?.s), 2 * DAY);
  await db.close();
});

Deno.test("B5 還原驗證：用舊的需求函式（沒有建立者補算）→ A 建立、B 請求只有 1 單位", async () => {
  const db = await env();
  await db.exec(fnText(BASE, "work_card_demand_seconds"));
  await request(db, "ipA");
  await request(db, "ipB");
  assertEquals(await demand(db), 1 * 2 * DAY, "舊行為：建立者沒被算，只有 B 的 1 單位");
  await db.close();
});
