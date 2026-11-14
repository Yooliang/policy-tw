/**
 * 派工優先級加「選舉類別提前天數」（migration 20261114010000_election_type_priority_days.sql，維護者 11-14 裁示：層級做成設定）。
 *
 *   priority_seconds 在選舉年優先之後再加 queue_settings.election_type_priority_days[職位] × 86400；排序鍵不動。
 *
 *   A. 文字層：seed 新定義 ＝ 上一版逐字 ＋ 一段標記區塊；手動任務進隊只多一項；預設 JSON 就是裁示的那張表；不升協議版號
 *   B. PGlite：預設天數、同屆同進隊時間排序（縣市長→議員→鄉鎮市長→代表→村里長）、target 沒職位時查 politician_elections、
 *      對不上加 0、UPDATE 設定立刻生效（改數字不改程式）、跨屆時選舉年仍壓過職位
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261114010000_election_type_priority_days.sql";
const MIG = await readMig(MIG_NAME);
const DAY = 86400;
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l !== "");

Deno.test("A1 seed：新定義 ＝ 上一版逐字 ＋ 一段標記區塊（>>> 選舉類別提前天數）", async () => {
  const prev = await latestFn("seed_auto_task_queue", MIG_NAME);
  const neu = fnText(MIG, "seed_auto_task_queue");
  const stripped = neu.replace(/  -- >>> 選舉類別提前天數[^\n]*\n[\s\S]*?  -- <<< 選舉類別提前天數\n/, "");
  assertNotEquals(stripped, neu, "有標記區塊");
  assertEquals(stripped, prev);
  assert(neu.includes("election_type_priority_seconds(g.target)"));
  // 疊在選舉年優先之後、換號沿用之前
  assert(neu.indexOf("<<< 選舉年優先") < neu.indexOf(">>> 選舉類別提前天數"));
  assert(neu.indexOf("<<< 選舉類別提前天數") < neu.indexOf(">>> 換號沿用排隊位置"));
});

Deno.test("A2 手動任務進隊：只多 election_type_priority_seconds(m.target) 一項", async () => {
  const prev = await latestFn("contribution_tasks_insert_dispatch", MIG_NAME);
  const neu = fnText(MIG, "contribution_tasks_insert_dispatch");
  const prevL = new Set(lines(prev));
  const added = lines(neu).filter((l) => !prevL.has(l));
  assert(added.some((l) => l.startsWith("+ election_type_priority_seconds(m.target),")), added.join("\n"));
  assert(neu.includes("election_year_priority_seconds(election_id_or_null(m.target->>'election_id'))"));
  assert(neu.includes("COALESCE(manual_front_seconds(m.task_id), 0)"));
});

Deno.test("A3 不升協議版號、不動 TS 協議檔", () => {
  assert(!/PROTOCOL_VERSION/.test(MIG));
});

const SCHEMA = `
CREATE TABLE elections (id INTEGER PRIMARY KEY, election_date DATE NOT NULL);
INSERT INTO elections VALUES (2022, '2022-11-26'), (2026, '2026-11-28');
CREATE TABLE queue_settings (id INTEGER PRIMARY KEY);
INSERT INTO queue_settings VALUES (1);
CREATE TABLE politician_elections (id SERIAL PRIMARY KEY, politician_id UUID, election_id INTEGER, election_type TEXT);
`;
async function env(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const n of ["uuid_or_null", "election_id_or_null"]) await db.exec(await latestFn(n, MIG_NAME));
  await db.exec(fnText(await readMig("20261112005000_election_year_priority.sql"), "election_year_priority_seconds"));
  const alter = /ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS election_type_priority_days[^;]*;/.exec(MIG)![0];
  await db.exec(alter);
  await db.exec(/ALTER TABLE queue_settings ADD CONSTRAINT [^;]*;/.exec(MIG)![0]);
  await db.exec(fnText(MIG, "election_type_priority_seconds"));
  return db;
}
const secs = async (db: PGlite, target: Record<string, unknown>): Promise<number> =>
  Number((await db.query<{ s: string }>(`SELECT election_type_priority_seconds('${JSON.stringify(target).replaceAll("'", "''")}'::jsonb) AS s`)).rows[0]!.s);

Deno.test("B1 預設天數：縣市長／直轄市長 6、議員 4、鄉鎮市長／山地區長 3、代表 2、村里長 0、其他 0", async () => {
  const db = await env();
  const want: Record<string, number> = {
    縣市長: 6, 直轄市長: 6, 縣市議員: 4, 直轄市議員: 4, 鄉鎮市長: 3, 直轄市山地原住民區長: 3,
    鄉鎮市民代表: 2, 直轄市山地原住民區民代表: 2, 村里長: 0, 立委: 0, 總統: 0,
  };
  for (const [t, d] of Object.entries(want)) assertEquals(await secs(db, { election_type: t }), d * DAY, t);
  await db.close();
});

Deno.test("B2 同屆同進隊時間：排序 縣市長 → 議員 → 鄉鎮市長 → 代表 → 村里長；差距正好是天數差", async () => {
  const db = await env();
  const entered = Date.parse("2026-10-05T00:00:00Z") / 1000;
  const key = async (t: string) => entered - (await secs(db, { election_id: 2026, election_type: t })); // queue_at ＝ 進隊 − 優先秒數
  const order = ["縣市長", "縣市議員", "鄉鎮市長", "鄉鎮市民代表", "村里長"];
  const ks = await Promise.all(order.map(key));
  for (let i = 1; i < ks.length; i++) assert(ks[i - 1]! < ks[i]!, `${order[i - 1]} 排在 ${order[i]} 前面`);
  assertEquals((ks[1]! - ks[0]!) / DAY, 2);
  assertEquals((ks[4]! - ks[0]!) / DAY, 6);
  await db.close();
});

Deno.test("B3 target 沒有 election_type：用 politician_id＋election_id 查 politician_elections；對不上加 0", async () => {
  const db = await env();
  const pid = "11111111-1111-4111-8111-111111111111";
  await db.exec(`INSERT INTO politician_elections (politician_id, election_id, election_type) VALUES ('${pid}', 2026, '縣市議員'), ('${pid}', 2022, '村里長')`);
  assertEquals(await secs(db, { politician_id: pid, election_id: 2026 }), 4 * DAY);
  assertEquals(await secs(db, { politician_id: pid, election_id: 2022 }), 0);
  assertEquals(await secs(db, { politician_id: "22222222-2222-4222-8222-222222222222", election_id: 2026 }), 0, "查無");
  assertEquals(await secs(db, {}), 0, "沒有職位的任務（網站請求、名冊…）");
  assertEquals(await secs(db, { election_type: "" }), 0, "空字串當沒有");
  await db.close();
});

Deno.test("B4 改數字不改程式：UPDATE 設定馬上生效；沒列的職位 0；可為負", async () => {
  const db = await env();
  await db.exec(`UPDATE queue_settings SET election_type_priority_days = '{"村里長": 9, "縣市長": -1}'::jsonb WHERE id = 1`);
  assertEquals(await secs(db, { election_type: "村里長" }), 9 * DAY);
  assertEquals(await secs(db, { election_type: "縣市長" }), -DAY);
  assertEquals(await secs(db, { election_type: "縣市議員" }), 0);
  await db.exec(`UPDATE queue_settings SET election_type_priority_days = '{"村里長": "abc"}'::jsonb WHERE id = 1`);
  assertEquals(await secs(db, { election_type: "村里長" }), 0, "壞值當 0，不拋錯");
  await assertRejects(db, `UPDATE queue_settings SET election_type_priority_days = '[]'::jsonb WHERE id = 1`);
  await db.close();
});

Deno.test("B5 跨屆：選舉年優先（每屆差 200 天以上）仍壓過職位（最多 6 天）", async () => {
  const db = await env();
  const yr = async (id: number) => Number((await db.query<{ s: string }>(`SELECT election_year_priority_seconds(${id}) AS s`)).rows[0]!.s);
  const total = async (id: number, t: string) => (await yr(id)) + (await secs(db, { election_id: id, election_type: t }));
  assert(await total(2026, "村里長") > await total(2022, "縣市長"), "2026 村里長仍排在 2022 縣市長前面");
  await db.close();
});

async function assertRejects(db: PGlite, sql: string): Promise<void> {
  let failed = false;
  try { await db.exec(sql); } catch { failed = true; }
  assert(failed, `應該被擋：${sql}`);
}
