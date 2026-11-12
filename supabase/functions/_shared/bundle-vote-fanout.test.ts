/**
 * 一人一包 PR2（migration 20261112020000_bundle_vote_fanout.sql；docs/PLAN-bundle-policies.md 第 3 節）。
 *   A. 文字層：seed 只在補驗證列那段加包內排除（前一版 20261112005000 為底）；task_boost_matches 同理（20261102180000 為底）；權限
 *   B. PGlite：兩代理整包同意（目標 2）→各條 2 分、verified；例外條不寫票、被釋放並建自己的票；重複投回 already_voted；
 *      例外含載體時票移轉；整包 disagree／unsure 扇出同一 verdict；錯誤路徑不寫入
 *   C. seed 補票段（取 migration 裡真正的那句 INSERT 跑）不替「未釋放且 index>0」的條目建票
 *   D. 還原驗證：拿掉釋放、拿掉 seed 排除，對應劇本要翻面
 * 計分與共識：這裡用最小替身（weight＝±1、目標 2）驗「逐列走 contribution_votes 觸發器」這條路；真正的 weight／共識本體沒有改，
 * 不在這支重測（見 consensus.test.ts、contribution-score.test.ts）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261112020000_bundle_vote_fanout.sql";
const PR1_NAME = "20261112010000_policy_bundles.sql";
const MIG = await readMig(MIG_NAME);
const PR1 = await readMig(PR1_NAME);

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 seed：新定義＝20261112005000 的定義加一處登記的排除，拿掉就一字不差", async () => {
  const prev = fnText(await readMig("20261112005000_election_year_priority.sql"), "seed_auto_task_queue");
  const neu = fnText(MIG, "seed_auto_task_queue");
  const add = `     -- >>> 一人一包（20261112020000）：還在包裡、不是 0 號的條目沒有自己的票（票在載體上），不補
     AND NOT (c.bundle_id IS NOT NULL AND c.bundle_index > 0 AND c.bundle_released_at IS NULL)
     -- <<< 一人一包
`;
  assertEquals(neu.split(add).length - 1, 1);
  assertEquals(neu.replace(add, ""), prev);
  // 前一版是不是還是 seed 的最新定義（中間有人插一版，這裡的底就過期）
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION seed_auto_task_queue(")) defining.push(n);
  assertEquals(defining.slice(-2), ["20261112005000_election_year_priority.sql", MIG_NAME]);
});

Deno.test("A2 task_boost_matches：新定義＝20261102180000 的定義加一處登記的排除", async () => {
  const prevName = "20261102180000_boost_verify_fast_task_ids.sql";
  const prev = fnText(await readMig(prevName), "task_boost_matches");
  const neu = fnText(MIG, "task_boost_matches");
  const add = `       -- >>> 一人一包（20261112020000）：還在包裡、不是 0 號的條目沒有票，不算進插隊命中（matched_verifies 才不會多算）
       AND NOT (c.bundle_id IS NOT NULL AND c.bundle_index > 0 AND c.bundle_released_at IS NULL)
       -- <<< 一人一包
`;
  assertEquals(neu.split(add).length - 1, 1);
  assertEquals(neu.replace(add, ""), prev);
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION task_boost_matches(")) defining.push(n);
  assertEquals(defining.slice(-2), [prevName, MIG_NAME]);
});

Deno.test("A3 扇出函式只給 service_role；沒有 id::text 比對；不碰 TS（簽名固定 12 個參數）", () => {
  assert(MIG.includes("REVOKE ALL ON FUNCTION bundle_vote_fanout(UUID, UUID, TEXT, TEXT, TEXT, TEXT, SMALLINT[], JSONB, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;"));
  assert(!/\bid::text\s*=/.test(MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")));
  assert(/pg_advisory_xact_lock\(hashtext\(p_bundle::text\)\)/.test(fnText(MIG, "bundle_vote_fanout")));
});

// ============================================================
// B. PGlite
// ============================================================
const SCHEMA = `
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz NOT NULL DEFAULT now(), queue_at timestamptz NOT NULL DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 1);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'pending', score integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), bundle_id uuid, bundle_index smallint, bundle_released_at timestamptz);
CREATE TABLE policy_bundles (id uuid PRIMARY KEY, agent_name text NOT NULL DEFAULT 'tester', item_count smallint NOT NULL DEFAULT 1);
CREATE TABLE contribution_votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_id uuid NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  verdict text NOT NULL CHECK (verdict IN ('agree', 'disagree', 'unsure')), evidence_url text, judge_backed boolean NOT NULL DEFAULT false,
  evidence_checked_at timestamptz, evidence_verdict text, note text, agent_name text NOT NULL, agent_tool text, verifier_ip_hash text NOT NULL,
  actor_id text, via text, weight smallint, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contribution_votes_one_per_agent UNIQUE (contribution_id, agent_name));
CREATE TABLE bundle_votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bundle_id uuid NOT NULL REFERENCES policy_bundles(id) ON DELETE CASCADE,
  voter_key text NOT NULL, agent_name text NOT NULL, verdict text NOT NULL, except_indexes smallint[] NOT NULL DEFAULT '{}',
  reasons jsonb NOT NULL DEFAULT '{}'::jsonb, note text, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT bundle_votes_one_per_voter UNIQUE (bundle_id, voter_key));
-- 計分最小替身：weight＝±1（unsure 0）、分數＝權重總和、達 2 轉 verified（真本體不在這裡測）
CREATE FUNCTION contribution_votes_set_weight() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.weight := CASE NEW.verdict WHEN 'agree' THEN 1 WHEN 'disagree' THEN -1 ELSE 0 END; RETURN NEW; END $$;
CREATE TRIGGER trg_contribution_votes_weight BEFORE INSERT ON contribution_votes FOR EACH ROW EXECUTE FUNCTION contribution_votes_set_weight();
CREATE FUNCTION contribution_apply_consensus(p uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s integer;
BEGIN
  SELECT COALESCE(sum(weight), 0) INTO s FROM contribution_votes WHERE contribution_id = p;
  UPDATE contributions SET score = s, status = CASE WHEN s >= 2 THEN 'verified' ELSE status END WHERE id = p AND status = 'pending';
END $$;
`;
const grab = (re: RegExp): string => {
  const m = re.exec(PR1);
  assert(m, `PR1 migration 找不到 ${re}`);
  return m[0];
};
const PR1_CONSTRAINTS = [
  grab(/CREATE UNIQUE INDEX IF NOT EXISTS idx_contributions_bundle_index [^\n]*;/),
  grab(/ALTER TABLE contributions ADD CONSTRAINT contributions_bundle_index_check [^\n]*? NOT VALID;/),
].join("\n");

async function env(mutateFan: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(PR1_CONSTRAINTS);
  await db.exec(await latestFn("contribution_votes_trg", MIG_NAME));
  await db.exec(`CREATE TRIGGER trg_contribution_votes_consensus AFTER INSERT OR UPDATE OR DELETE ON contribution_votes FOR EACH ROW EXECUTE FUNCTION contribution_votes_trg();`);
  for (const n of ["verify_ticket_enqueue", "contribution_queue_row", "bundle_pick_carrier"]) await db.exec(fnText(PR1, n));
  await db.exec("CREATE TRIGGER trg_contribution_queue_row AFTER INSERT ON contributions FOR EACH ROW EXECUTE FUNCTION contribution_queue_row();");
  await db.exec(mutateFan(fnText(MIG, "bundle_vote_fanout")));
  return db;
}

const BUNDLE = "11111111-1111-4111-8111-111111111111";
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

/** 一個三條的包（index 0、1、2；0 是載體，建立時帶票）；回傳 id 陣列 */
async function bundle3(db: PGlite): Promise<string[]> {
  await db.exec(`INSERT INTO policy_bundles (id, item_count) VALUES ('${BUNDLE}', 3)`);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = uid();
    await db.exec(`INSERT INTO contributions (id, bundle_id, bundle_index) VALUES ('${id}', '${BUNDLE}', ${i})`);
    ids.push(id);
  }
  return ids;
}
type Res = { voted?: number; skipped?: number; released?: number; new_carrier?: string | null; error?: string };
async function vote(db: PGlite, carrier: string, agent: string, o: { except?: number[]; verdict?: string; actor?: string; note?: string } = {}): Promise<Res> {
  const ex = o.except && o.except.length ? `ARRAY[${o.except.join(",")}]::smallint[]` : "NULL::smallint[]";
  const r = await db.query<{ r: Res }>(
    `SELECT bundle_vote_fanout('${carrier}', '${BUNDLE}', '${agent}', '${o.actor ?? "ip:" + agent}', 'iphash', '${o.verdict ?? "agree"}', ${ex}, '{}'::jsonb, ${o.note ? `'${o.note}'` : "NULL"}, NULL, 'tool', 'report') AS r`);
  return r.rows[0]!.r;
}
const row = async (db: PGlite, id: string) => (await db.query<{ status: string; score: number; released: boolean }>(
  `SELECT status, score, (bundle_released_at IS NOT NULL) AS released FROM contributions WHERE id = '${id}'`)).rows[0]!;
const ticketSet = async (db: PGlite): Promise<string[]> =>
  (await db.query<{ task_id: string }>(`SELECT task_id FROM task_dispatches ORDER BY task_id`)).rows.map((r) => r.task_id.replace("verify:", ""));
const nVotes = async (db: PGlite, id: string) => Number((await db.query<{ c: string }>(`SELECT count(*) AS c FROM contribution_votes WHERE contribution_id = '${id}'`)).rows[0]!.c);

Deno.test("B1 兩個代理整包同意：每條各 2 分、都 verified；票逐條（via=bundle、備註前綴 [包 #idx]）", async () => {
  const db = await env();
  const [c0, c1, c2] = await bundle3(db);
  assertEquals(await ticketSet(db), [c0!], "一包一張票（載體）");
  const a = await vote(db, c0!, "alice", { note: "公報第3頁" });
  assertEquals([a.voted, a.released], [3, 0]);
  for (const id of [c0!, c1!, c2!]) assertEquals((await row(db, id)).score, 1);
  const b = await vote(db, c0!, "bob");
  assertEquals(b.voted, 3);
  for (const id of [c0!, c1!, c2!]) {
    const r = await row(db, id);
    assertEquals([r.score, r.status], [2, "verified"]);
  }
  const notes = (await db.query<{ note: string; via: string }>(`SELECT note, via FROM contribution_votes WHERE agent_name = 'alice' ORDER BY note`)).rows;
  assertEquals(notes.map((x) => x.note), ["[包 #0] 公報第3頁", "[包 #1] 公報第3頁", "[包 #2] 公報第3頁"]);
  assert(notes.every((x) => x.via === "bundle"));
  assertEquals((await db.query(`SELECT 1 FROM bundle_votes`)).rows.length, 2);
  await db.close();
});

Deno.test("B2 例外條：這位不投、被釋放並建自己的票，其他條不受影響；另一人整包同意後例外條仍無票、維持 pending", async () => {
  const db = await env();
  const [c0, c1, c2] = await bundle3(db);
  const a = await vote(db, c0!, "alice", { except: [1] });
  assertEquals([a.voted, a.released, a.new_carrier ?? null], [2, 1, null]);
  assertEquals(await nVotes(db, c1!), 0);
  assertEquals((await row(db, c1!)).released, true);
  assertEquals(await ticketSet(db), [c0!, c1!].sort(), "載體票＋被釋放那條自己的票");
  assertEquals((await row(db, c2!)).released, false);
  const b = await vote(db, c0!, "bob");
  assertEquals(b.voted, 2, "被釋放的 c1 已不在包裡，扇出不碰它");
  assertEquals((await row(db, c0!)).status, "verified");
  assertEquals((await row(db, c2!)).status, "verified");
  const r1 = await row(db, c1!);
  assertEquals([r1.score, r1.status], [0, "pending"]); // 沒有任何人的票，仍需別人逐條驗（走自己的票）
  await db.close();
});

Deno.test("B3 重複投回 already_voted（代號不分大小寫；DiTrust 同帳號換代號也算），不多寫票", async () => {
  const db = await env();
  const [c0] = await bundle3(db);
  await vote(db, c0!, "alice");
  assertEquals((await vote(db, c0!, "alice")).error, "already_voted");
  assertEquals((await vote(db, c0!, "Alice")).error, "already_voted");
  await vote(db, c0!, "dt-one", { actor: "ditrust:abc" });
  assertEquals((await vote(db, c0!, "dt-two", { actor: "ditrust:abc" })).error, "already_voted");
  assertEquals(await nVotes(db, c0!), 2);
  assertEquals((await db.query(`SELECT 1 FROM bundle_votes`)).rows.length, 2);
  await db.close();
});

Deno.test("B4 例外含載體：載體釋放（保有自己的票），票移轉給包裡 index 最小的；包裡沒有可接的回 null", async () => {
  const db = await env();
  const [c0, c1, c2] = await bundle3(db);
  // 只例外載體：新載體是 c1
  const a = await vote(db, c0!, "alice", { except: [0] });
  assertEquals([a.voted, a.released, a.new_carrier], [2, 1, c1]);
  assertEquals(await ticketSet(db), [c0!, c1!].sort(), "c0 自己的票、新載體 c1 的票；c2 沒票");
  assertEquals(await nVotes(db, c0!), 0);
  // 新載體 c1 與 c2 都被例外：包裡沒有人可接
  const b = await vote(db, c1!, "bob", { except: [1, 2] });
  assertEquals([b.voted, b.released, b.new_carrier ?? null], [0, 2, null]);
  assertEquals((await ticketSet(db)).length, 3, "三條各自有票");
  await db.close();
  // 載體與 index 1 一起被例外：票移到 index 2
  const db2 = await env();
  const [d0, d1, d2] = await bundle3(db2);
  const r = await vote(db2, d0!, "alice", { except: [0, 1] });
  assertEquals([r.voted, r.released, r.new_carrier], [1, 2, d2]);
  assertEquals(await ticketSet(db2), [d0!, d1!, d2!].sort());
  await db2.close();
});

Deno.test("B5 整包 disagree／unsure 扇出同一 verdict；except 搭配非 agree、載體不在包內回錯誤且不寫入", async () => {
  const db = await env();
  const [c0, c1, c2] = await bundle3(db);
  assertEquals((await vote(db, c0!, "alice", { verdict: "disagree" })).voted, 3);
  assertEquals((await vote(db, c0!, "bob", { verdict: "unsure" })).voted, 3);
  for (const id of [c0!, c1!, c2!]) {
    const vs = (await db.query<{ verdict: string }>(`SELECT verdict FROM contribution_votes WHERE contribution_id = '${id}' ORDER BY agent_name`)).rows.map((r) => r.verdict);
    assertEquals(vs, ["disagree", "unsure"]);
  }
  assertEquals((await vote(db, c0!, "carol", { verdict: "disagree", except: [1] })).error, "except_need_agree");
  assertEquals((await vote(db, uid(), "carol")).error, "carrier_not_in_bundle");
  assertEquals((await db.query(`SELECT 1 FROM bundle_votes WHERE agent_name = 'carol'`)).rows.length, 0);
  assertEquals(await nVotes(db, c0!), 2);
  await db.close();
});

Deno.test("B6 已定案、已釋放的條目不被扇出碰到（只扇到仍在包裡且 pending 的）", async () => {
  const db = await env();
  const [c0, c1, c2] = await bundle3(db);
  await db.exec(`UPDATE contributions SET status = 'rejected' WHERE id = '${c1}'`);
  await db.exec(`UPDATE contributions SET bundle_released_at = now() WHERE id = '${c2}'`);
  const a = await vote(db, c0!, "alice");
  assertEquals([a.voted, a.released], [1, 0]);
  assertEquals([await nVotes(db, c1!), await nVotes(db, c2!)], [0, 0]);
  await db.close();
});

// ============================================================
// C. seed 補票段
// ============================================================
const seedInsert = (() => {
  const t = fnText(MIG, "seed_auto_task_queue");
  const a = t.indexOf("  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)\n  SELECT 'verify:'");
  const e = t.indexOf("ON CONFLICT (task_id) DO NOTHING;", a);
  assert(a > 0 && e > a, "找不到補驗證列那句 INSERT");
  return t.slice(a, e + "ON CONFLICT (task_id) DO NOTHING;".length);
})();

async function seedScenario(insert: string): Promise<{ db: PGlite; ids: string[]; plain: string; released: string }> {
  const db = await env();
  const ids = await bundle3(db);
  const plain = uid();
  const released = uid();
  await db.exec(`INSERT INTO contributions (id) VALUES ('${plain}')`);
  await db.exec(`INSERT INTO contributions (id, bundle_id, bundle_index, bundle_released_at) VALUES ('${released}', '${BUNDLE}', 3, now())`);
  await db.exec("DELETE FROM task_dispatches"); // 假裝觸發器漏掉了
  await db.exec(insert);
  return { db, ids, plain, released };
}

Deno.test("C1 seed 補票段：只替載體、沒包的、已釋放的建票；未釋放且 index>0 不建", async () => {
  const { db, ids, plain, released } = await seedScenario(seedInsert);
  assertEquals(await ticketSet(db), [ids[0]!, plain, released].sort());
  await db.close();
});

// ============================================================
// D. 還原驗證
// ============================================================
Deno.test("D1 拿掉 seed 排除，index>0 就被補票（C1 要翻面）", async () => {
  const bad = seedInsert.replace(/     -- >>> 一人一包[\s\S]*?-- <<< 一人一包\n/, "");
  assert(bad !== seedInsert);
  const { db, ids } = await seedScenario(bad);
  assert((await ticketSet(db)).includes(ids[1]!));
  await db.close();
});

Deno.test("D2 拿掉釋放那段，例外條沒有自己的票（B2 要翻面）", async () => {
  const db = await env((s) => mutate(s, "      PERFORM verify_ticket_enqueue(r.id);\n", ""));
  const [c0, c1] = await bundle3(db);
  await vote(db, c0!, "alice", { except: [1] });
  assertEquals(await ticketSet(db), [c0!], "沒有補票：c1 被釋放卻沒人派得到");
  assert(!(await ticketSet(db)).includes(c1!));
  await db.close();
});
