/**
 * region_mismatch_sweep()（migration 20261101100000）的守門測試。
 * 原案：吳炳輝 2026 縣市長掛台南市，三份通過驗證的 candidacy 交件寫雲林縣；落庫之外的來源（匯入腳本的 COALESCE(region_id, …)、合併、手動 SQL、
 * #795 之前已落庫的交件）不會經過 openRegionMismatch，沒人被通知。這支每小時對一次帳，只開任務、不改地區。
 * 守門：
 *   1. 縣市不同 → 開一件、target 欄位跟落庫端（buildRegionMismatchTask）同一組鍵；再跑不重開（冪等）；關掉的任務也算已開過
 *   2. 不開：臺／台寫法不同、現在的地區是選區層級、不是縣市長、交件縣市是「全國」或空、交件還沒落庫（verified）
 *   3. 同一人先後交不同縣市 → 只看最新一筆
 * 還原驗證：拿掉函式裡的 `c.id = (SELECT c2.id …)`（最新一筆）→ 測試 3 紅；拿掉 NOT EXISTS → 測試 1 紅；拿掉 replace('臺','台') → 第 4 個測試紅；拿掉「全國」排除 → 測試 2 紅（見 PR 說明）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { buildRegionMismatchTask } from "./region-mismatch.ts";

const MIGRATION = new URL("../../migrations/20261101100000_region_mismatch_sweep.sql", import.meta.url);

async function fnText(): Promise<string> {
  const t = (await Deno.readTextFile(MIGRATION)).replace(/\r\n/g, "\n");
  const at = t.indexOf("CREATE OR REPLACE FUNCTION region_mismatch_sweep(");
  assert(at >= 0, "找不到 region_mismatch_sweep 定義");
  const body = t.slice(at);
  return body.slice(0, body.indexOf("$$;", body.indexOf("$$") + 2) + 3);
}

const PID = "4f5ef190-21bb-4bf6-8c1c-234239982ed3";

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    INSERT INTO regions VALUES (4175,'台南市',NULL,NULL),(3197,'雲林縣',NULL,NULL),(5000,'雲林縣','第01選舉區',NULL),(1,'全國',NULL,NULL);
    CREATE TABLE politicians (id text PRIMARY KEY, name text);
    INSERT INTO politicians VALUES ('${PID}','吳炳輝');
    CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id text, election_id integer, election_type text, region_id integer, cand_no integer);
    CREATE TABLE contributions (id text PRIMARY KEY, contribution_type text, status text, payload jsonb, applied_politician_id text, created_at timestamptz);
    CREATE TABLE contribution_tasks (id serial PRIMARY KEY, title text, description text, task_type text, target jsonb, region text, priority int, reward int,
      status text, source text, created_by text, hint_sources text[]);
    ${await fnText()}`);
  return db;
}

async function pe(db: PGlite, regionId: number | null, type = "縣市長") {
  await db.query(`INSERT INTO politician_elections VALUES (35070, $1, 2026, $2, $3, 1)`, [PID, type, regionId]);
}
let n = 0;
async function contrib(db: PGlite, region: string | null, opts: { status?: string; at?: string } = {}) {
  n++;
  await db.query(`INSERT INTO contributions VALUES ($1,'candidacy',$2,$3::jsonb,$4,$5)`, [
    `c${n}`, opts.status ?? "applied", JSON.stringify({ election_id: 2026, ...(region === null ? {} : { region }) }), PID, opts.at ?? `2026-10-${10 + n}T00:00:00Z`,
  ]);
}
const sweep = async (db: PGlite) => (await db.query<{ v: number }>(`SELECT region_mismatch_sweep() v`)).rows[0].v;
const tasks = async (db: PGlite) => (await db.query<Record<string, unknown>>(`SELECT * FROM contribution_tasks`)).rows;

Deno.test("縣市不同：開一件、target 鍵跟落庫端同一組；再跑不重開；關掉的也算開過", async () => {
  const db = await setup();
  await pe(db, 4175);
  await contrib(db, "雲林縣");
  assertEquals(await sweep(db), 1);
  const [t] = await tasks(db);
  assertEquals([t.task_type, t.source, t.status, t.region], ["region_mismatch", "auto_dispute", "open", "雲林縣"]);
  const tg = t.target as Record<string, unknown>;
  assertEquals([tg.politician_election_id, tg.current_region_id, tg.proposed_region_id, tg.current_region, tg.proposed_region], [35070, 4175, 3197, "台南市", "雲林縣"]);
  // 鍵集合跟 buildRegionMismatchTask 一致（派工與 correction 守門讀這組鍵）
  const ts = buildRegionMismatchTask({
    politician_election_id: 35070, politician_id: PID, name: "吳炳輝", election_id: 2026, election_type: "縣市長", cand_no: 1,
    current_region_id: 4175, current_region: "台南市", proposed_region_id: 3197, proposed_region: "雲林縣", contribution_id: "c1",
  });
  assertEquals(Object.keys(tg).sort(), Object.keys(ts.target as Record<string, unknown>).sort());
  assertEquals(t.title, ts.title);
  assertEquals(await sweep(db), 0, "冪等");
  await db.exec(`UPDATE contribution_tasks SET status = 'closed'`);
  assertEquals(await sweep(db), 0, "關掉的任務也算開過");
  assertEquals((await tasks(db)).length, 1);
});

Deno.test("不開：臺／台寫法不同、選區層級、不是縣市長、全國或空、交件還沒落庫", async () => {
  let db = await setup(); await pe(db, 4175); await contrib(db, "臺南市");
  assertEquals(await sweep(db), 0, "臺／台視為相同");
  db = await setup(); await pe(db, 5000); await contrib(db, "台南市");
  assertEquals(await sweep(db), 0, "現在的地區是選區層級，不走縣市對帳");
  db = await setup(); await pe(db, 4175, "縣市議員"); await contrib(db, "雲林縣");
  assertEquals(await sweep(db), 0, "只管縣市長");
  db = await setup(); await pe(db, 4175); await contrib(db, "全國");
  assertEquals(await sweep(db), 0, "全國不是縣市");
  db = await setup(); await pe(db, 4175); await contrib(db, null);
  assertEquals(await sweep(db), 0, "交件沒帶縣市");
  db = await setup(); await pe(db, 4175); await contrib(db, "雲林縣", { status: "verified" });
  assertEquals(await sweep(db), 0, "還沒落庫的交件不算");
  db = await setup(); await pe(db, null); await contrib(db, "雲林縣");
  assertEquals(await sweep(db), 0, "地區是空的由落庫補，不是不一致");
});

Deno.test("同一人先後交不同縣市：只看最新一筆，且最新一筆跟現況相同時不開", async () => {
  let db = await setup(); await pe(db, 4175);
  await contrib(db, "雲林縣", { at: "2026-10-01T00:00:00Z" });
  await contrib(db, "台南市", { at: "2026-10-20T00:00:00Z" });
  assertEquals(await sweep(db), 0, "最新一筆是台南市＝跟現況一致");
  db = await setup(); await pe(db, 4175);
  await contrib(db, "台南市", { at: "2026-10-01T00:00:00Z" });
  await contrib(db, "雲林縣", { at: "2026-10-20T00:00:00Z" });
  assertEquals(await sweep(db), 1, "最新一筆是雲林縣");
  const tg = (await tasks(db))[0].target as Record<string, unknown>;
  assertEquals(tg.proposed_region, "雲林縣");
});

Deno.test("交件寫「臺南市」、現況是雲林縣：對得到台南市那一列，照開", async () => {
  const db = await setup();
  await pe(db, 3197);
  await contrib(db, "臺南市");
  assertEquals(await sweep(db), 1);
  const tg = (await tasks(db))[0].target as Record<string, unknown>;
  assertEquals([tg.proposed_region_id, tg.proposed_region], [4175, "台南市"]);
});
