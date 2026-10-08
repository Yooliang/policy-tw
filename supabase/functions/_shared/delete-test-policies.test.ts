// 刪除 8 筆標題 TEST 的已軟移除政見（#466 B，migration 20261009160100）的守門測試。
// 用 PGlite 真的跑那支 migration：只刪那 8 筆（含它們的 source_refs），別人不動；標題不是 TEST 或未軟移除就整支 RAISE、一列不刪；重跑安靜。
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const FILE = "20261009160100_delete_test_policies.sql";
const sql = (await Deno.readTextFile(new URL(`../../migrations/${FILE}`, import.meta.url))).replace(/\r\n/g, "\n");

const IDS = [
  "3b2c244f-a35f-4a53-9f28-f5a006b1eda6", "a8ea2375-dea9-4925-b020-9b27e7fe15f0", "ba088f6c-f95a-411a-9d98-75dc3c679a72",
  "c9ba038b-ee1d-4f4e-80a5-b0724e825337", "c9d8d858-dfa2-42d1-844f-1a620cf7e6e2", "cc49aa4a-0dc0-461b-8f72-3c56d11aef52",
  "d7f134f9-719f-4d68-96c1-69de118e4094", "e0015bb4-e82d-4db1-8817-595e13d283b0",
];
const BYSTANDER = "99999999-9999-4999-8999-999999999999";
const BYSTANDER_TEST = "3b2c244f-0000-4000-8000-000000000000"; // 前綴相同但不是那 8 筆的完整 id：不能被前綴誤傷

async function build(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE policies (id uuid PRIMARY KEY, title text, removed_at timestamptz);
    CREATE TABLE tracking_logs (id serial PRIMARY KEY, policy_id uuid REFERENCES policies(id) ON DELETE CASCADE);
    CREATE TABLE source_refs (source_id bigint, target_table text, target_id text, role text);
  `);
  for (const id of IDS) {
    await db.query(`INSERT INTO policies VALUES ($1, 'TEST', now())`, [id]);
    await db.query(`INSERT INTO source_refs VALUES (1, 'policies', $1, 'primary')`, [id]);
  }
  await db.query(`INSERT INTO policies VALUES ($1, '真的政見', NULL)`, [BYSTANDER]);
  await db.query(`INSERT INTO source_refs VALUES (2, 'policies', $1, 'primary')`, [BYSTANDER]);
  await db.query(`INSERT INTO policies VALUES ($1, 'TEST', now())`, [BYSTANDER_TEST]);
  await db.query(`INSERT INTO source_refs VALUES (3, 'politicians', $1, 'primary')`, [IDS[0]]); // 同 id 但不是政見的引用，不能刪
  return db;
}
const count = async (db: PGlite, q: string) => Number(((await db.query(q)).rows[0] as { n: string }).n);

Deno.test("migration：只刪那 8 筆與它們的 source_refs；別人、前綴相同的別筆、非政見的引用都不動", async () => {
  const db = await build();
  await db.exec(sql);
  assertEquals(await count(db, `SELECT count(*) n FROM policies WHERE id = ANY ('{${IDS.join(",")}}'::uuid[])`), 0);
  assertEquals(await count(db, `SELECT count(*) n FROM policies`), 2, "剩下真的政見與前綴相同的別筆");
  assertEquals(await count(db, `SELECT count(*) n FROM source_refs WHERE target_table = 'policies'`), 1, "只剩別人的那條");
  assertEquals(await count(db, `SELECT count(*) n FROM source_refs WHERE target_table = 'politicians'`), 1);
  await db.close();
});

Deno.test("migration：重跑是安靜的（資料已不在）", async () => {
  const db = await build();
  await db.exec(sql);
  await db.exec(sql);
  assertEquals(await count(db, `SELECT count(*) n FROM policies`), 2);
  await db.close();
});

Deno.test("防呆：其中一筆標題不是 TEST → RAISE，一列都不刪", async () => {
  const db = await build();
  await db.query(`UPDATE policies SET title = '真的政見標題' WHERE id = $1`, [IDS[3]]);
  await assertRejects(() => db.exec(sql), Error, "不是 TEST");
  assertEquals(await count(db, `SELECT count(*) n FROM policies`), 10);
  assertEquals(await count(db, `SELECT count(*) n FROM source_refs WHERE target_table = 'policies'`), 9);
  await db.close();
});

Deno.test("防呆：其中一筆還沒軟移除 → RAISE，一列都不刪", async () => {
  const db = await build();
  await db.query(`UPDATE policies SET removed_at = NULL WHERE id = $1`, [IDS[5]]);
  await assertRejects(() => db.exec(sql), Error, "還沒軟移除");
  assertEquals(await count(db, `SELECT count(*) n FROM policies`), 10);
  await db.close();
});

Deno.test("寫法：用完整 uuid、不用前綴比對；先清 source_refs 再刪政見", () => {
  for (const id of IDS) assertStringIncludes(sql, id);
  assert(!/LIKE/i.test(sql.replace(/--.*$/gm, "")), "不用 LIKE 前綴");
  const code = sql.replace(/--.*$/gm, "");
  assert(code.indexOf("DELETE FROM source_refs") < code.indexOf("DELETE FROM policies"));
});
