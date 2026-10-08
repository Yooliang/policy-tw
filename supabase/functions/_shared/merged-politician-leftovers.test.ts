// 已合併人物殘列清除（#466 A，migration 20261009160000）的守門測試：PGlite 真跑那支 migration。
// 撞鍵的子列整列記 edit_history 再刪；保留者沒有同鍵、掛錯人、人物沒被合併就 RAISE、一列不動；別人的列不動；重跑安靜。
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const FILE = "20261009160000_merged_politician_leftovers.sql";
const sql = (await Deno.readTextFile(new URL(`../../migrations/${FILE}`, import.meta.url))).replace(/\r\n/g, "\n");

const OLD = "54472fee-1dc4-475c-a104-64529aa0797a";
const KEEP = "8aa6ee40-231a-447a-a967-99bcf8b35d3f";
const OTHER = "00000000-0000-4000-8000-000000000009";
const REVIEWED = ["a356d6d1-1e2a-4987-b884-532f5f3d9abf", "732cbaa2-e596-4609-980c-a7800f946e65", "54472fee-1dc4-475c-a104-64529aa0797a", "90378e6f-00c3-4981-904e-7b050b3c3d3d"];

async function build(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE politicians (id uuid PRIMARY KEY, merged_into uuid);
    CREATE TABLE politician_elections (id int UNIQUE, politician_id uuid, election_id int, candidacy_status text, PRIMARY KEY (politician_id, election_id));
    CREATE TABLE politician_keys (id int PRIMARY KEY, politician_id uuid, key_type text, key_value text, source text, UNIQUE (politician_id, key_type, key_value));
    CREATE TABLE policy_dupe_reviews (politician_id uuid PRIMARY KEY, fingerprint text, note text);
    CREATE TABLE source_refs (source_id bigint, target_table text, target_id text, role text, origin text, PRIMARY KEY (target_table, target_id, source_id));
    CREATE TABLE edit_history (id serial PRIMARY KEY, table_name text, record_id text, field text, old_value jsonb, new_value jsonb, contribution_id uuid, agent_name text);
  `);
  await db.query(`INSERT INTO politicians VALUES ($1, $2), ($2, NULL), ($3, NULL)`, [OLD, KEEP, OTHER]);
  for (const p of REVIEWED.filter((x) => x !== OLD)) await db.query(`INSERT INTO politicians VALUES ($1, $2)`, [p, KEEP]);
  await db.query(`INSERT INTO politician_elections VALUES (36446, $1, 2026, 'filed'), (35367, $2, 2026, 'filed'), (500, $2, 2022, 'elected'), (600, $3, 2026, 'filed')`, [OLD, KEEP, OTHER]);
  await db.query(`INSERT INTO politician_keys VALUES
    (77586, $1, 'region_type', '陳瑩|台東縣|縣市長', 'derived'), (77587, $1, 'position', '陳瑩|縣市長', 'derived'), (77588, $1, 'party', '陳瑩|民主進步黨', 'derived'),
    (34426, $2, 'region_type', '陳瑩|台東縣|縣市長', 'backfill'), (34424, $2, 'position', '陳瑩|縣市長', 'backfill'), (34427, $2, 'party', '陳瑩|民主進步黨', 'backfill'),
    (90000, $3, 'party', '別人|無黨籍', 'derived')`, [OLD, KEEP, OTHER]);
  for (const p of REVIEWED) await db.query(`INSERT INTO policy_dupe_reviews VALUES ($1, 'fp', '逐項比對')`, [p]);
  await db.query(`INSERT INTO policy_dupe_reviews VALUES ($1, 'fp-other', '別人的審查')`, [OTHER]);
  // 出處：36446 有一筆 primary（正式庫實況）；別人的參選紀錄 600 也有一筆，不能被碰
  await db.query(`INSERT INTO source_refs VALUES (9276, 'politician_elections', '36446', 'primary', 'backfill:contribution'), (7000, 'politician_elections', '600', 'primary', 'x')`);
  return db;
}
const n = async (db: PGlite, q: string) => Number(((await db.query(q)).rows[0] as { n: string }).n);

Deno.test("清掉 36446、三筆重複鍵、四筆過期審查；保留者與別人的列不動", async () => {
  const db = await build();
  await db.exec(sql);
  assertEquals(await n(db, `SELECT count(*) n FROM politician_elections WHERE id = 36446`), 0);
  assertEquals(await n(db, `SELECT count(*) n FROM politician_elections`), 3, "35367、500、別人的 600 都在");
  assertEquals(await n(db, `SELECT count(*) n FROM politician_keys WHERE politician_id = '${OLD}'`), 0);
  assertEquals(await n(db, `SELECT count(*) n FROM politician_keys`), 4, "保留者三筆＋別人一筆");
  assertEquals(await n(db, `SELECT count(*) n FROM policy_dupe_reviews`), 1, "只剩別人的");
  await db.close();
});

Deno.test("每個刪掉的列各記一筆 edit_history（field='*'、old_value=整列、new_value 空），可依整列倒回", async () => {
  const db = await build();
  await db.exec(sql);
  const h = (await db.query(`SELECT table_name, record_id, field, old_value, new_value, agent_name FROM edit_history ORDER BY id`)).rows as Array<Record<string, unknown>>;
  assertEquals(h.length, 1 + 3 + 4 + 1, "另有一筆出處搬動的履歷");
  assert(h.filter((e) => e.table_name !== "source_refs").every((e) => e.field === "*" && e.new_value === null && e.agent_name === "migration-466"));
  const el = h.find((e) => e.table_name === "politician_elections")!;
  assertEquals(el.record_id, "36446");
  assertEquals((el.old_value as Record<string, unknown>).politician_id, OLD);
  assertEquals(h.filter((e) => e.table_name === "politician_keys").map((e) => e.record_id).sort(), ["77586", "77587", "77588"]);
  const rv = h.filter((e) => e.table_name === "policy_dupe_reviews");
  assertEquals(rv.length, 4);
  assert(rv.every((e) => (e.old_value as Record<string, unknown>).fingerprint === "fp" && !("_merged_into" in (e.old_value as object))));
  await db.close();
});

Deno.test("重跑安靜（列已不在，不再記履歷）", async () => {
  const db = await build();
  await db.exec(sql);
  await db.exec(sql);
  assertEquals(await n(db, `SELECT count(*) n FROM edit_history`), 9);
  await db.close();
});

async function rejected(mutate: (db: PGlite) => Promise<void>, msg: string) {
  const db = await build();
  await mutate(db);
  const before = [await n(db, `SELECT count(*) n FROM politician_elections`), await n(db, `SELECT count(*) n FROM politician_keys`), await n(db, `SELECT count(*) n FROM policy_dupe_reviews`)];
  await assertRejects(() => db.exec(sql), Error, msg);
  assertEquals([await n(db, `SELECT count(*) n FROM politician_elections`), await n(db, `SELECT count(*) n FROM politician_keys`), await n(db, `SELECT count(*) n FROM policy_dupe_reviews`)], before, "RAISE 時一列都不動");
  assertEquals(await n(db, `SELECT count(*) n FROM edit_history`), 0);
  await db.close();
}

Deno.test("防呆：保留者沒有同屆參選紀錄 → RAISE", () => rejected((db) => db.query(`DELETE FROM politician_elections WHERE id = 35367`).then(() => {}), "不是撞鍵的殘列"));
Deno.test("防呆：保留者缺其中一把同鍵 → RAISE", () => rejected((db) => db.query(`DELETE FROM politician_keys WHERE id = 34427`).then(() => {}), "不是重複的"));
Deno.test("防呆：36446 掛在別人名下 → RAISE", () => rejected((db) => db.query(`UPDATE politician_elections SET politician_id = '${OTHER}', election_id = 2018 WHERE id = 36446`).then(() => {}), "不是預期的"));
Deno.test("防呆：審查結論的人物沒被合併 → RAISE", () => rejected((db) => db.query(`UPDATE politicians SET merged_into = NULL WHERE id = '${REVIEWED[0]}'`).then(() => {}), "沒有被合併"));
Deno.test("防呆：54472fee 沒併進預期保留者 → RAISE", () => rejected((db) => db.query(`UPDATE politicians SET merged_into = '${OTHER}' WHERE id = '${OLD}'`).then(() => {}), "merged_into"));

// ── 出處（source_refs）要跟著處理（agy 審查 #502）──────────────────────────────

Deno.test("出處：36446 的出處搬到保留者同屆的 35367，記履歷；別人的出處不動", async () => {
  const db = await build();
  await db.exec(sql);
  const refs = (await db.query(`SELECT target_id, source_id, role FROM source_refs ORDER BY target_id`)).rows as Array<Record<string, unknown>>;
  assertEquals(refs.map((r) => `${r.target_id}:${r.source_id}:${r.role}`), ["35367:9276:primary", "600:7000:primary"]);
  const h = (await db.query(`SELECT record_id, field, old_value, new_value FROM edit_history WHERE table_name = 'source_refs'`)).rows as Array<Record<string, unknown>>;
  assertEquals(h.length, 1);
  assertEquals(h[0].record_id, "politician_elections:36446:9276");
  assertEquals(h[0].field, "target_id");
  assertEquals(h[0].old_value, "36446");
  assertEquals(h[0].new_value, "35367");
  await db.close();
});

Deno.test("出處：保留者已有同一個出處 → 刪被刪那列的、不搬，整列記履歷", async () => {
  const db = await build();
  await db.query(`INSERT INTO source_refs VALUES (9276, 'politician_elections', '35367', 'primary', 'x')`);
  await db.exec(sql);
  const refs = (await db.query(`SELECT target_id, source_id FROM source_refs WHERE target_table = 'politician_elections' ORDER BY target_id`)).rows as Array<Record<string, unknown>>;
  assertEquals(refs.map((r) => `${r.target_id}:${r.source_id}`), ["35367:9276", "600:7000"]);
  const h = (await db.query(`SELECT record_id, field, new_value FROM edit_history WHERE table_name = 'source_refs'`)).rows as Array<Record<string, unknown>>;
  assertEquals(h.length, 1);
  assertEquals(h[0].field, "*");
  assertEquals(h[0].new_value, null);
  await db.close();
});

Deno.test("出處：保留者已有別的主要出處 → RAISE，不猜哪個算主要", () =>
  rejected((db) => db.query(`INSERT INTO source_refs VALUES (1111, 'politician_elections', '35367', 'primary', 'x')`).then(() => {}), "不自動搬"));

Deno.test("出處：身份鍵若有出處 → 搬到保留者同鍵那一把（已有同出處就刪）", async () => {
  const db = await build();
  await db.query(`INSERT INTO source_refs VALUES (5000, 'politician_keys', '77586', 'primary', 'x'), (5001, 'politician_keys', '77587', 'supporting', 'x'), (5001, 'politician_keys', '34424', 'supporting', 'x')`);
  await db.exec(sql);
  const refs = (await db.query(`SELECT target_id, source_id FROM source_refs WHERE target_table = 'politician_keys' ORDER BY target_id, source_id`)).rows as Array<Record<string, unknown>>;
  assertEquals(refs.map((r) => `${r.target_id}:${r.source_id}`), ["34424:5001", "34426:5000"], "77586→34426 搬；77587 的 5001 保留者已有，刪");
  await db.close();
});
