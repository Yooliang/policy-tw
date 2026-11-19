/**
 * 驗證先於任務（2026-11-19，migration 20261119100000）。
 *
 * 規則：①/next 有能派的驗證票就先派（pickDispatchKind），沒有才看手動任務／自動缺口；
 *       ②驗證隊伍內：差一票（有票）的先 → 層級（縣市 → 鄉鎮 → 村里）→ queue_at；
 *       ③有票的票每被領走只往後 1 小時，沒人投過的 7 天（no_change 14 天）。
 * SQL 部分用 PGlite 真的跑 migration 裡的函式、觸發器與驗證池。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText } from "./arms-pglite.ts";
import { pickDispatchKind } from "./dispatch.ts";
import { POSITIONS } from "../../../lib/election-levels.ts";

const read = async (name: string) => (await Deno.readTextFile(new URL(`../../migrations/${name}`, import.meta.url))).replace(/\r\n/g, "\n");
const MIG = await read("20261119100000_verify_first_rank.sql");
const KEY_MIG = await read("20261104120000_verify_ticket_key.sql");
const POOL_MIG = await read("20261114080000_agent_breaker_skip_cooldown.sql");
const NEXT = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));

// ── TS：這一輪派哪一類 ──
Deno.test("pickDispatchKind：有可驗的票就先派驗證，不管任務的 queue_at 多早", () => {
  assertEquals(pickDispatchKind({
    verifyAvailable: true,
    manual: { queue_at: "1970-01-01T00:00:00Z" },
    auto: { queue_at: "1970-01-01T00:00:00Z" },
  }), "verify");
});

Deno.test("pickDispatchKind：沒有可驗的票才看任務；同一刻手動任務先；都沒有回 null", () => {
  const t = "2026-11-01T00:00:00Z";
  assertEquals(pickDispatchKind({ verifyAvailable: false, manual: { queue_at: t }, auto: { queue_at: t } }), "manual");
  assertEquals(pickDispatchKind({ verifyAvailable: false, manual: { queue_at: "2026-11-02T00:00:00Z" }, auto: { queue_at: t } }), "auto");
  assertEquals(pickDispatchKind({ verifyAvailable: false, manual: null, auto: { queue_at: t } }), "auto");
  assertEquals(pickDispatchKind({ verifyAvailable: false, manual: null, auto: null }), null);
});

Deno.test("next：用 pickDispatchKind 決定，驗證沒派成退回任務、不再讓驗證跟任務比 queue_at", () => {
  assert(NEXT.includes("pickDispatchKind({ verifyAvailable: verifyHead !== null"));
  assert(NEXT.includes("pickDispatchKind({ verifyAvailable: false"), "驗證沒派成要退回任務");
  assert(!NEXT.includes("pickQueueHead("));
});

// ── SQL ──
Deno.test("migration：版號大於 main 最新、池子只改 ORDER BY、不動日本站", () => {
  assert(MIG.includes("ORDER BY d.verify_rank ASC NULLS LAST, d.queue_at ASC, d.task_id"));
  assert(MIG.includes("CREATE INDEX IF NOT EXISTS task_dispatches_verify_rank_idx ON task_dispatches (verify_rank, queue_at, task_id) WHERE task_id LIKE 'verify:%'"));
  const code = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!code.includes("policy_jp."), "日本站不跟");
  // 池子與上一版逐字相同，只差 ORDER BY 那一行（含標記註解）
  const prev = fnText(POOL_MIG, "contribution_verify_pool");
  const cur = fnText(MIG, "contribution_verify_pool");
  const strip = (s: string) => s.split("\n").filter((l) => !l.includes(">>> 驗證先於任務") && !l.includes("<<< 驗證先於任務"))
    .map((l) => l.replace("ORDER BY d.verify_rank ASC NULLS LAST, d.queue_at ASC, d.task_id", "ORDER BY d.queue_at ASC, d.task_id")).join("\n");
  assertEquals(strip(cur), prev);
});

const KEY_FNS = ["verify_ticket_key"].map((n) => fnText(KEY_MIG, n));

async function db(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE queue_settings (id int PRIMARY KEY, verify_priority_seconds int, verify_redispatch_seconds int, verify_no_change_redispatch_seconds int, verify_voted_redispatch_seconds int, redispatch_cooldown_seconds int DEFAULT 14400);
    INSERT INTO queue_settings VALUES (1, 1209600, 604800, 1209600, 3600);
    CREATE TABLE politician_elections (id serial PRIMARY KEY, politician_id uuid, election_id int, election_type text);
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, payload jsonb DEFAULT '{}', source_urls text[], note text,
      task_id text, agent_name text DEFAULT 'author', actor_id text, contributor_ip_hash text DEFAULT 'net-x', status text DEFAULT 'pending',
      agree_count int DEFAULT 0, disagree_count int DEFAULT 0, unsure_count int DEFAULT 0, created_at timestamptz DEFAULT now(),
      score int DEFAULT 0, target_score int DEFAULT 3, voter_ips int DEFAULT 0, needs_identity_pick boolean DEFAULT false);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, queue_at timestamptz, verify_target int, target jsonb, dispatch_count int DEFAULT 0, boost_seconds bigint DEFAULT 0,
      priority_seconds bigint DEFAULT 0, last_dispatched_at timestamptz, cool_until timestamptz, dispatch_base_at timestamptz, verify_follows_task boolean,
      verify_has_votes boolean NOT NULL DEFAULT false, verify_level smallint, verify_rank smallint);
    CREATE TABLE contribution_votes (contribution_id uuid, agent_name text, actor_id text);
    CREATE TABLE verify_dispatches (contribution_id uuid, ip_hash text, agent_name text, dispatched_at timestamptz DEFAULT now());
    CREATE FUNCTION uuid_or_null(t text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $f$ BEGIN RETURN t::uuid; EXCEPTION WHEN others THEN RETURN NULL; END $f$;
    CREATE FUNCTION election_id_or_null(t text) RETURNS int LANGUAGE sql IMMUTABLE AS $f$ SELECT CASE WHEN t ~ '^[0-9]+$' THEN t::int END $f$;
    CREATE FUNCTION uuid_if_canonical(text) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE FUNCTION contribution_effective_agree(uuid) RETURNS int LANGUAGE sql AS 'SELECT 3';
    CREATE FUNCTION contribution_overvoted_stop_votes() RETURNS int LANGUAGE sql AS 'SELECT 100';
    CREATE FUNCTION verify_ticket_priority_seconds(text) RETURNS bigint LANGUAGE sql AS 'SELECT 0::bigint';
    CREATE FUNCTION verify_ticket_base(text) RETURNS timestamptz LANGUAGE sql AS $f$ SELECT '2026-11-01 00:00:00+00'::timestamptz $f$;
    CREATE FUNCTION verify_ticket_freeze_base(timestamptz, int, bigint, int) RETURNS timestamptz LANGUAGE sql AS 'SELECT $1';
    CREATE FUNCTION task_queue_key(timestamptz, bigint, timestamptz, bigint) RETURNS timestamptz LANGUAGE sql AS 'SELECT $1';
    -- 一參數版步長（20261104120000 的真實定義需要 no_change 判斷，這裡照它的形狀）
    CREATE FUNCTION verify_ticket_step_seconds(p_verify_task_id TEXT) RETURNS INTEGER LANGUAGE sql STABLE AS $f$
      SELECT CASE WHEN EXISTS (SELECT 1 FROM contributions c WHERE c.id = uuid_or_null(substr(p_verify_task_id, 8)) AND c.contribution_type = 'no_change')
                  THEN q.verify_no_change_redispatch_seconds ELSE q.verify_redispatch_seconds END
        FROM queue_settings q WHERE q.id = 1 $f$;
  `);
  for (const f of KEY_FNS) await d.exec(f);
  // 以下全部是 migration 裡的真函式
  for (const n of ["verify_election_type_level", "verify_ticket_election_type", "verify_ticket_level", "verify_ticket_has_votes", "task_dispatches_queue_key", "contribution_sync_verify_has_votes"]) {
    await d.exec(fnText(MIG, n));
  }
  await d.exec(`CREATE FUNCTION verify_ticket_step_seconds(p_verify_task_id TEXT, p_has_votes BOOLEAN) RETURNS INTEGER
LANGUAGE sql STABLE AS $f$
  SELECT CASE WHEN COALESCE(p_has_votes, false)
              THEN COALESCE((SELECT q.verify_voted_redispatch_seconds FROM queue_settings q WHERE q.id = 1), 3600)
              ELSE verify_ticket_step_seconds(p_verify_task_id) END
$f$;`);
  await d.exec(`
    CREATE TRIGGER trg_task_dispatches_queue_key BEFORE INSERT OR UPDATE ON task_dispatches FOR EACH ROW EXECUTE FUNCTION task_dispatches_queue_key();
    CREATE TRIGGER trg_contributions_verify_has_votes AFTER UPDATE OF score ON contributions
      FOR EACH ROW WHEN ((OLD.score >= 1) IS DISTINCT FROM (NEW.score >= 1)) EXECUTE FUNCTION contribution_sync_verify_has_votes();
  `);
  return d;
}

const cid = (n: number) => `c0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
async function addTicket(d: PGlite, n: number, opts: { etype?: string | null; score?: number; type?: string; dispatches?: number } = {}) {
  const payload = opts.etype ? JSON.stringify({ election_type: opts.etype }) : "{}";
  await d.query(`INSERT INTO contributions (id, contribution_type, payload, score) VALUES ($1, $2, $3::jsonb, $4)`, [cid(n), opts.type ?? "policy", payload, opts.score ?? 0]);
  await d.query(`INSERT INTO task_dispatches (task_id, dispatch_count) VALUES ($1, $2)`, [`verify:${cid(n)}`, opts.dispatches ?? 0]);
}
const row = async (d: PGlite, n: number) =>
  (await d.query<{ verify_rank: number; verify_level: number; verify_has_votes: boolean; days: number }>(
    `SELECT verify_rank, verify_level, verify_has_votes, extract(epoch FROM (queue_at - '2026-11-01 00:00:00+00'::timestamptz)) / 86400.0 AS days FROM task_dispatches WHERE task_id = $1`,
    [`verify:${cid(n)}`])).rows[0]!;

Deno.test("SQL：職位 → 層級對照 lib/election-levels.ts 的 POSITIONS（national／county 0、township 1、village 2），對不上職位算 1", async () => {
  const d = await db();
  for (const p of POSITIONS) {
    const want = p.level === "village" ? 2 : p.level === "township" ? 1 : 0;
    const r = await d.query<{ l: number }>(`SELECT verify_election_type_level($1) AS l`, [p.type]);
    assertEquals(r.rows[0]!.l, want, p.type);
  }
  for (const t of ["直轄市長", "直轄市議員"]) assertEquals((await d.query<{ l: number }>(`SELECT verify_election_type_level($1) AS l`, [t])).rows[0]!.l, 0, t);
  assertEquals((await d.query<{ l: number }>(`SELECT verify_election_type_level(NULL) AS l`)).rows[0]!.l, 1);
  assertEquals((await d.query<{ l: number }>(`SELECT verify_election_type_level('網站請求') AS l`)).rows[0]!.l, 1);
  await d.close();
});

Deno.test("SQL：入列時算層級與排序階——有票 0＋層級、沒票 3＋層級", async () => {
  const d = await db();
  await addTicket(d, 1, { etype: "縣市議員", score: 0 });
  await addTicket(d, 2, { etype: "縣市議員", score: 1 });
  await addTicket(d, 3, { etype: "鄉鎮市民代表", score: 2 });
  await addTicket(d, 4, { etype: "村里長", score: 1 });
  await addTicket(d, 5, { etype: "村里長", score: 0 });
  await addTicket(d, 6, { etype: null, score: 0 });
  const r = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => row(d, n)));
  assertEquals(r.map((x) => x.verify_rank), [3, 0, 1, 2, 5, 4]);
  assertEquals(r.map((x) => x.verify_has_votes), [false, true, true, true, false, false]);
  await d.close();
});

Deno.test("SQL：職位也可以從母任務 target 或 politician_elections 查到", async () => {
  const d = await db();
  const pid = "d0000000-0000-4000-8000-000000000001";
  await d.query(`INSERT INTO politician_elections (politician_id, election_id, election_type) VALUES ($1, 2026, '村里長')`, [pid]);
  await d.query(`INSERT INTO task_dispatches (task_id, target) VALUES ('auto:parent', '{"election_type":"鄉鎮市長"}')`);
  await d.query(`INSERT INTO contributions (id, contribution_type, payload, task_id) VALUES ($1, 'policy', '{}', 'auto:parent')`, [cid(1)]);
  await d.query(`INSERT INTO contributions (id, contribution_type, payload) VALUES ($1, 'policy', $2::jsonb)`, [cid(2), JSON.stringify({ politician_id: pid, election_id: 2026 })]);
  for (const n of [1, 2]) await d.query(`INSERT INTO task_dispatches (task_id) VALUES ($1)`, [`verify:${cid(n)}`]);
  assertEquals((await row(d, 1)).verify_level, 1, "母任務 target.election_type＝鄉鎮市長");
  assertEquals((await row(d, 2)).verify_level, 2, "politician_elections 查到村里長");
  await d.close();
});

Deno.test("SQL：懲罰——被領走 3 次，有票的往後 3 小時、沒人投過的往後 21 天（基準 − 14 天另計）", async () => {
  const d = await db();
  await addTicket(d, 1, { etype: "縣市長", score: 1, dispatches: 3 });
  await addTicket(d, 2, { etype: "縣市長", score: 0, dispatches: 3 });
  await addTicket(d, 3, { etype: "縣市長", score: 0, dispatches: 3, type: "no_change" });
  await addTicket(d, 4, { etype: "縣市長", score: 1, dispatches: 0 });
  const base = -14; // 基準 2026-11-01 − 14 天
  assertEquals(Math.round(Number((await row(d, 1)).days) * 24 * 60), Math.round((base * 24 + 3) * 60), "有票：+3 小時");
  assertEquals(Math.round((await row(d, 2)).days * 1e6) / 1e6, base + 21, "沒票：+21 天");
  assertEquals(Math.round((await row(d, 3)).days * 1e6) / 1e6, base + 42, "no_change 沒票：+42 天");
  assertEquals(Math.round(Number((await row(d, 4)).days) * 1e6) / 1e6, base, "沒被領走過：基準 − 14 天");
  await d.close();
});

Deno.test("SQL：領走時 dispatch_count＋1——有票只多 1 小時、沒票多 7 天", async () => {
  const d = await db();
  await addTicket(d, 1, { etype: "縣市長", score: 1 });
  await addTicket(d, 2, { etype: "縣市長", score: 0 });
  const before = await Promise.all([row(d, 1), row(d, 2)]);
  for (const n of [1, 2]) await d.query(`UPDATE task_dispatches SET dispatch_count = dispatch_count + 1 WHERE task_id = $1`, [`verify:${cid(n)}`]);
  const after = await Promise.all([row(d, 1), row(d, 2)]);
  assertEquals(Math.round((after[0]!.days - before[0]!.days) * 24 * 60), 60);
  assertEquals(Math.round((after[1]!.days - before[1]!.days) * 1e6) / 1e6, 7);
  await d.close();
});

Deno.test("SQL：分數跨過 1 時列上同步——第一票進來票往前（排序階 3→0、領走次數的 7 天不再計），掉回 0 又回去", async () => {
  const d = await db();
  await addTicket(d, 1, { etype: "村里長", score: 0, dispatches: 2 });
  const a = await row(d, 1);
  assertEquals([a.verify_rank, a.verify_has_votes], [5, false]);
  assertEquals(Math.round(a.days * 1e6) / 1e6, -14 + 14);
  await d.query(`UPDATE contributions SET score = 1 WHERE id = $1`, [cid(1)]);
  const b = await row(d, 1);
  assertEquals([b.verify_rank, b.verify_has_votes], [2, true]);
  assertEquals(Math.round(b.days * 24 * 60), Math.round((-14 * 24 + 2) * 60));
  await d.query(`UPDATE contributions SET score = 2 WHERE id = $1`, [cid(1)]); // 仍有票：不重算
  assertEquals((await row(d, 1)).verify_rank, 2);
  await d.query(`UPDATE contributions SET score = 0 WHERE id = $1`, [cid(1)]);
  const c = await row(d, 1);
  assertEquals([c.verify_rank, c.verify_has_votes], [5, false]);
  await d.close();
});

Deno.test("SQL：任務列不受影響（verify_rank 為 NULL、queue_at 走 task_queue_key）", async () => {
  const d = await db();
  await d.query(`INSERT INTO task_dispatches (task_id, last_dispatched_at) VALUES ('auto:x', '2026-10-01 00:00:00+00')`);
  const r = await d.query<{ verify_rank: number | null; q: string }>(`SELECT verify_rank, queue_at::text AS q FROM task_dispatches WHERE task_id = 'auto:x'`);
  assertEquals(r.rows[0]!.verify_rank, null);
  assert(r.rows[0]!.q.startsWith("2026-10-01"));
  await d.close();
});

Deno.test("SQL（驗證池）：差一票 ＞ 層級 ＞ queue_at；同階內照 queue_at；過濾條件照舊", async () => {
  const d = await db();
  await d.exec(`CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, source text);`);
  await d.exec(fnText(MIG, "contribution_verify_pool"));
  // 直接寫 verify_rank／queue_at（觸發器在這裡先停用），驗證排序本身
  await d.exec(`ALTER TABLE task_dispatches DISABLE TRIGGER trg_task_dispatches_queue_key`);
  const cases: Array<[number, number, string]> = [
    // [編號, verify_rank, queue_at]
    [1, 5, "2026-01-01"], // 沒票・村里・最早
    [2, 3, "2026-06-01"], // 沒票・縣市
    [3, 1, "2026-10-01"], // 有票・鄉鎮・最晚
    [4, 2, "2026-02-01"], // 有票・村里
    [5, 1, "2026-09-01"], // 有票・鄉鎮・比 3 早
    [6, 0, "2026-11-01"], // 有票・縣市・最晚
  ];
  for (const [n, rank, at] of cases) {
    await d.query(`INSERT INTO contributions (id, contribution_type, status, score, target_score) VALUES ($1, 'policy', 'pending', 0, 3)`, [cid(n)]);
    await d.query(`INSERT INTO task_dispatches (task_id, queue_at, verify_rank) VALUES ($1, $2, $3)`, [`verify:${cid(n)}`, at, rank]);
  }
  const ids = async (agent: string) => (await d.query<{ id: string }>(`SELECT id FROM contribution_verify_pool('net-me', NULL, 30, NULL, NULL, $1, NULL, false)`, [agent])).rows.map((r) => Number(r.id.slice(-2)));
  assertEquals(await ids("bot"), [6, 5, 3, 4, 2, 1]);
  // 這隻代理投過 6：下一張接上
  await d.query(`INSERT INTO contribution_votes VALUES ($1, 'bot', NULL)`, [cid(6)]);
  assertEquals(await ids("bot"), [5, 3, 4, 2, 1]);
  // LIMIT 仍然生效
  assertEquals((await d.query(`SELECT id FROM contribution_verify_pool('net-me', NULL, 2, NULL, NULL, 'bot', NULL, false)`)).rows.length, 2);
  await d.close();
});

Deno.test("SQL（驗證池）：兩千多張驗證列＋三萬任務列的合成資料下，規劃器可順著 (verify_rank, queue_at, task_id) 部分索引取前 30、不另外排序", async () => {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, queue_at timestamptz, verify_rank smallint);
    INSERT INTO task_dispatches SELECT 'verify:' || g, now() - (g || ' hours')::interval, (g % 6)::smallint FROM generate_series(1, 2300) g;
    INSERT INTO task_dispatches SELECT 'auto:' || g, now() - (g || ' hours')::interval, NULL FROM generate_series(1, 30000) g;
  `);
  await d.exec(MIG.slice(MIG.indexOf("CREATE INDEX IF NOT EXISTS task_dispatches_verify_rank_idx"), MIG.indexOf("\n", MIG.indexOf("CREATE INDEX IF NOT EXISTS task_dispatches_verify_rank_idx"))));
  await d.exec(`ANALYZE task_dispatches`);
  const plan = (await d.query<{ "QUERY PLAN": string }>(
    `EXPLAIN SELECT task_id FROM task_dispatches d WHERE d.task_id LIKE 'verify:%' ORDER BY d.verify_rank ASC NULLS LAST, d.queue_at ASC, d.task_id LIMIT 30`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
  assert(plan.includes("task_dispatches_verify_rank_idx"), plan);
  assert(!plan.includes("Sort"), `不該另外排序：\n${plan}`);
  await d.close();
});
