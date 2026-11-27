/**
 * agy 加帳號：工作單寫入時由資料庫 realtime.send 廣播（20261127052000_agy_login_realtime_broadcast.sql）。
 * PGlite 沒有 realtime schema，測試自建 stub：realtime.send 把參數存進 realtime._sent。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (n: string) => (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");

const STUB_OK = `
  CREATE SCHEMA IF NOT EXISTS realtime;
  CREATE TABLE IF NOT EXISTS realtime._sent (id serial PRIMARY KEY, payload jsonb, event text, topic text, private boolean);
  CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true) RETURNS void
  LANGUAGE plpgsql AS $$ BEGIN INSERT INTO realtime._sent (payload, event, topic, private) VALUES (payload, event, topic, private); END $$;
`;
const STUB_FAIL = `
  CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true) RETURNS void
  LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'realtime 掛了'; END $$;
`;

async function build(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
  await db.exec(STUB_OK);
  for (const m of ["20261110040000_agy_login_requests.sql", "20261110130000_account_ticket_kind.sql", "20261127052000_agy_login_realtime_broadcast.sql"]) {
    await db.exec(await read(m));
  }
  return db;
}

async function newTicket(db: PGlite): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO agy_login_tickets (ticket_hash, expires_at) VALUES (md5(random()::text), now() + interval '1 hour') RETURNING id`,
  );
  return r.rows[0].id;
}

Deno.test("A1 建立工作單（agy_login_start）廣播一次：topic=agy-login、event=job、payload.id＝工作單 id、private=false", async () => {
  const db = await build();
  const t = await newTicket(db);
  const r = await db.query<{ res: { id: string } }>(`SELECT agy_login_start('${t}') AS res`);
  const id = r.rows[0].res.id;
  assert(id, "start 應回工作單 id");
  const sent = await db.query<{ payload: { id: string }; event: string; topic: string; private: boolean }>(`SELECT payload, event, topic, private FROM realtime._sent`);
  assertEquals(sent.rows.length, 1);
  assertEquals(sent.rows[0].topic, "agy-login");
  assertEquals(sent.rows[0].event, "job");
  assertEquals(sent.rows[0].private, false);
  assertEquals(sent.rows[0].payload, { id });
});

Deno.test("A2 realtime.send 失敗不擋寫入：工作單照樣建立、start 照樣回 id", async () => {
  const db = await build();
  await db.exec(STUB_FAIL);
  const t = await newTicket(db);
  const r = await db.query<{ res: { id: string } }>(`SELECT agy_login_start('${t}') AS res`);
  const id = r.rows[0].res.id;
  assert(id);
  const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM agy_login_requests WHERE id = '${id}'`);
  assertEquals(n.rows[0].n, 1);
});

Deno.test("A3 claim、取碼、完成等 UPDATE 路徑不廣播；claim 行為不變", async () => {
  const db = await build();
  const t = await newTicket(db);
  const r = await db.query<{ res: { id: string } }>(`SELECT agy_login_start('${t}') AS res`);
  const id = r.rows[0].res.id;
  const c = await db.query<{ v: string }>(`SELECT agy_login_claim('vm-x')::text AS v`);
  assertEquals(c.rows[0].v, id);
  await db.exec(`UPDATE agy_login_requests SET status = 'code_submitted', code = 'abc' WHERE id = '${id}'`);
  const code = await db.query<{ v: string }>(`SELECT agy_login_take_code('${id}') AS v`);
  assertEquals(code.rows[0].v, "abc");
  const done = await db.query<{ v: boolean }>(`SELECT agy_login_done('${id}', 'a1', 'x@example.com') AS v`);
  assertEquals(done.rows[0].v, true);
  const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM realtime._sent`);
  assertEquals(n.rows[0].n, 1, "整個流程只有建立那一次廣播");
});

Deno.test("A4 busy 的 start 沒建新工作單就不廣播", async () => {
  const db = await build();
  const t = await newTicket(db);
  await db.query(`SELECT agy_login_start('${t}')`);
  const r = await db.query<{ res: { reason?: string } }>(`SELECT agy_login_start('${t}') AS res`);
  assertEquals(r.rows[0].res.reason, "busy");
  const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM realtime._sent`);
  assertEquals(n.rows[0].n, 1);
});
