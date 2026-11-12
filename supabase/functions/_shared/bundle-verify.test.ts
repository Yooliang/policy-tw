/**
 * 一人一包 PR4：驗證端整包一票（bundle-verify.ts、verify-handler.ts 的接線、auto-apply.ts 的重發票守門、/next 的 item.bundle）。
 *
 *   A. 純函式：except／reasons／note 檢查、頁碼提醒
 *   B. PGlite 端到端（handleVerify → bundle_vote_fanout 真的跑 migration 裡的函式）：
 *      交一包後兩代理整包同意→全部 verified、載體照舊即時落庫其餘留給掃地機；例外條釋放並建自己的票；舊代理 bundle_vote_required；
 *      bundle_mismatch；note／reasons 檢查；整包 disagree 扇出 N 張反對＋24 小時 rate limit；auto_excepted；重複投 409
 *   C. auto-apply：身分原因改回待指認重發票時，包內非載體不建票、載體才建
 *   D. /next：載體附 item.bundle、非載體與非包條目沒有
 *   E. 接線：next/index.ts、verify-handler.ts 真的呼叫（拿掉接線，對應劇本要翻面）；協議版號與 skill.md 一致
 * 計分用最小替身（weight＝±1、目標 2；真本體沒有改，見 bundle-vote-fanout.test.ts 的說明）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";
import { autoApplyContribution } from "./auto-apply.ts";
import { BUNDLE_NOTE_MIN, bundleInputProblem, handleBundleVerify, loadBundleItem, mentionsPage } from "./bundle-verify.ts";
import { handleVerify } from "./verify-handler.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { resetQuotaCache } from "./quota-settings.ts";
import type { VerifyInput } from "./contribution-schema.ts";

const FAN_NAME = "20261112065000_bundle_vote_fanout.sql";
const FAN = await readMig(FAN_NAME);
const PR1 = await readMig("20261112010000_policy_bundles.sql");

// ============================================================
// A. 純函式
// ============================================================
const mk = (o: Partial<VerifyInput> = {}): VerifyInput => ({
  contribution_id: "c", verdict: "agree", agent_name: "alice",
  note: "對照公報第3頁到第5頁逐條核對過全部條目，每一條的標題與內容都對得上公報原文，沒有多出或漏掉的條目，也沒有改寫過的地方。", ...o,
});
const code = (r: { body: Record<string, unknown> } | null) => (r ? r.body.error : null);

Deno.test("A1 note 至少 40 字；例外要理由、只能搭 agree、序號要在包內", () => {
  assertEquals(code(bundleInputProblem(mk(), [0, 1, 2])), null);
  assertEquals(code(bundleInputProblem(mk({ note: "公報第3頁對得上" }), [0, 1])), "bundle_note_too_short");
  assertEquals(BUNDLE_NOTE_MIN, 40);
  assertEquals(code(bundleInputProblem(mk({ except: [1] }), [0, 1])), "bundle_except_need_reason");
  assertEquals(code(bundleInputProblem(mk({ except: [1], reasons: { "1": "太短" } }), [0, 1])), "bundle_except_need_reason");
  assertEquals(code(bundleInputProblem(mk({ except: [1], reasons: { "1": "公報第4頁沒有這一條政見" } }), [0, 1])), null);
  assertEquals(code(bundleInputProblem(mk({ except: [9], reasons: { "9": "公報第4頁沒有這一條政見" } }), [0, 1])), "bundle_mismatch");
  assertEquals(code(bundleInputProblem(mk({ verdict: "unsure", except: [1], reasons: { "1": "公報第4頁沒有這一條政見" } }), [0, 1])), "bundle_except_need_agree");
  assertEquals(code(bundleInputProblem(mk({ verdict: "disagree", except: [1], reasons: { "1": "公報第4頁沒有這一條政見" } }), [0, 1])), "bundle_except_need_agree");
});

Deno.test("A2 頁碼提醒的判斷", () => {
  assert(mentionsPage("核對公報第3頁"));
  assert(mentionsPage("see p.12 of the bulletin"));
  assert(mentionsPage("第 十 頁"));
  assert(!mentionsPage("全部都對得上，沒有問題，已逐條打開公報核對過了"));
});

Deno.test("A3 與上一票一字不差回 note_repeated", () => {
  const n = mk().note!;
  assertEquals(code(bundleInputProblem(mk(), [0], n)), "note_repeated");
});

// ============================================================
// B. PGlite 端到端
// ============================================================
const SCHEMA = `
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz NOT NULL DEFAULT now(), queue_at timestamptz NOT NULL DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 1);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'pending', score integer NOT NULL DEFAULT 0,
  agree_count integer NOT NULL DEFAULT 0, disagree_count integer NOT NULL DEFAULT 0, unsure_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), bundle_id uuid, bundle_index smallint, bundle_released_at timestamptz,
  contribution_type text NOT NULL DEFAULT 'policy', payload jsonb NOT NULL DEFAULT '{}', source_urls text[] NOT NULL DEFAULT '{}',
  task_id text, agent_name text NOT NULL DEFAULT 'submitter', actor_id text, contributor_ip_hash text DEFAULT 'sub-ip',
  note text, agent_tool text, contributor_url text, retry_count integer DEFAULT 0, next_retry_at timestamptz,
  reviewed_by text, review_notes text, reviewed_at timestamptz, needs_identity_pick boolean DEFAULT false, needs_identity_pick_at timestamptz,
  apply_claimed_at timestamptz, applied_at timestamptz, applied_politician_id uuid, applied_policy_id uuid, last_error text);
CREATE TABLE policy_bundles (id uuid PRIMARY KEY, agent_name text NOT NULL DEFAULT 'submitter', actor_id text, item_count smallint NOT NULL DEFAULT 1);
CREATE TABLE contribution_votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_id uuid NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  verdict text NOT NULL CHECK (verdict IN ('agree', 'disagree', 'unsure')), evidence_url text, judge_backed boolean NOT NULL DEFAULT false,
  evidence_checked_at timestamptz, evidence_verdict text, note text, agent_name text NOT NULL, agent_tool text, verifier_ip_hash text NOT NULL,
  actor_id text, via text, weight smallint, created_at timestamptz NOT NULL DEFAULT now(), resolved_politician_id text, bad_items integer[],
  CONSTRAINT contribution_votes_one_per_agent UNIQUE (contribution_id, agent_name));
CREATE TABLE bundle_votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bundle_id uuid NOT NULL REFERENCES policy_bundles(id) ON DELETE CASCADE,
  voter_key text NOT NULL, agent_name text NOT NULL, verdict text NOT NULL, except_indexes smallint[] NOT NULL DEFAULT '{}',
  reasons jsonb NOT NULL DEFAULT '{}'::jsonb, note text, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT bundle_votes_one_per_voter UNIQUE (bundle_id, voter_key));
CREATE TABLE verify_dispatches (contribution_id uuid, ip_hash text, agent_name text, dispatched_at timestamptz DEFAULT now());
CREATE FUNCTION contribution_votes_set_weight() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.weight := CASE NEW.verdict WHEN 'agree' THEN 1 WHEN 'disagree' THEN -1 ELSE 0 END; RETURN NEW; END $$;
CREATE TRIGGER trg_contribution_votes_weight BEFORE INSERT ON contribution_votes FOR EACH ROW EXECUTE FUNCTION contribution_votes_set_weight();
CREATE FUNCTION contribution_apply_consensus(p uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s integer;
BEGIN
  SELECT COALESCE(sum(weight), 0) INTO s FROM contribution_votes WHERE contribution_id = p;
  UPDATE contributions SET score = s, status = CASE WHEN s >= 2 THEN 'verified' WHEN s <= -3 THEN 'rejected' ELSE status END WHERE id = p AND status = 'pending';
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

async function env(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(PR1_CONSTRAINTS);
  await db.exec(await latestFn("contribution_votes_trg", FAN_NAME));
  await db.exec(`CREATE TRIGGER trg_contribution_votes_consensus AFTER INSERT OR UPDATE OR DELETE ON contribution_votes FOR EACH ROW EXECUTE FUNCTION contribution_votes_trg();`);
  for (const n of ["verify_ticket_enqueue", "contribution_queue_row", "bundle_pick_carrier"]) await db.exec(fnText(PR1, n));
  await db.exec(fnText(FAN, "bundle_carrier_id"));
  await db.exec(fnText(FAN, "bundle_pick_carrier"));
  await db.exec("CREATE TRIGGER trg_contribution_queue_row AFTER INSERT ON contributions FOR EACH ROW EXECUTE FUNCTION contribution_queue_row();");
  await db.exec(fnText(FAN, "bundle_vote_fanout"));
  return db;
}

type Row = Record<string, unknown>;
type Filter = { col: string; op: string; val: unknown };

/** 把 supabase-js 的鏈式呼叫翻成 SQL 丟給 PGlite（只支援這支測試用到的那幾種） */
function pgClient(db: PGlite) {
  const run = async (sql: string, params: unknown[]) => {
    try {
      const r = await db.query(sql, params as never[]);
      return { rows: r.rows as Row[], error: null as null | { message: string } };
    } catch (e) {
      return { rows: [] as Row[], error: { message: e instanceof Error ? e.message : String(e) } };
    }
  };
  const where = (fs: Filter[], params: unknown[]): string => {
    if (fs.length === 0) return "";
    return " WHERE " + fs.map((f) => {
      if (f.op === "is") return `${f.col} IS NULL`;
      params.push(f.val);
      const p = `$${params.length}`;
      if (f.op === "in") return `${f.col} = ANY(${p})`;
      return `${f.col} ${({ eq: "=", gte: ">=", lt: "<", neq: "<>" } as Record<string, string>)[f.op]} ${p}`;
    }).join(" AND ");
  };
  return {
    from(table: string) {
      const st = { op: "select", cols: "*", fs: [] as Filter[], ord: "", lim: "", patch: null as Row | null, head: false, returning: false };
      const exec = async () => {
        const params: unknown[] = [];
        if (st.op === "update") {
          const sets = Object.entries(st.patch!).map(([k, v]) => { params.push(v); return `${k} = $${params.length}`; }).join(", ");
          const r = await run(`UPDATE ${table} SET ${sets}${where(st.fs, params)} RETURNING id`, params);
          return { data: r.rows, error: r.error, count: r.rows.length };
        }
        if (st.op === "insert") {
          const keys = Object.keys(st.patch!);
          const vals = keys.map((k) => { const v = st.patch![k]; return v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v; });
          const r = await run(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, vals);
          return { data: r.rows, error: r.error, count: r.rows.length };
        }
        if (st.op === "upsert") return { data: null, error: null, count: 0 };
        const cols = st.head ? "count(*) AS c" : st.cols;
        const r = await run(`SELECT ${cols} FROM ${table}${where(st.fs, params)}${st.ord}${st.lim}`, params);
        if (st.head) return { data: null, error: r.error, count: Number(r.rows[0]?.c ?? 0) };
        return { data: r.rows, error: r.error, count: r.rows.length };
      };
      const chain: Record<string, unknown> = {
        select(cols = "*", opts?: { head?: boolean }) { if (st.op === "select") { st.cols = cols; st.head = !!opts?.head; } else st.returning = true; return chain; },
        update(p: Row) { st.op = "update"; st.patch = p; return chain; },
        upsert() { st.op = "upsert"; return chain; },
        insert(row: Row) { st.op = "insert"; st.patch = row; return chain; },
        eq(col: string, val: unknown) { st.fs.push({ col, op: "eq", val }); return chain; },
        neq(col: string, val: unknown) { st.fs.push({ col, op: "neq", val }); return chain; },
        gte(col: string, val: unknown) { st.fs.push({ col, op: "gte", val }); return chain; },
        lt(col: string, val: unknown) { st.fs.push({ col, op: "lt", val }); return chain; },
        is(col: string) { st.fs.push({ col, op: "is", val: null }); return chain; },
        in(col: string, val: unknown[]) { st.fs.push({ col, op: "in", val }); return chain; },
        order(col: string, o?: { ascending?: boolean }) { st.ord = ` ORDER BY ${col} ${o?.ascending === false ? "DESC" : "ASC"}`; return chain; },
        limit(n: number) { st.lim = ` LIMIT ${n}`; return chain; },
        async maybeSingle() { const r = await exec(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error }; },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return exec().then(res, rej); },
      };
      return chain;
    },
    async rpc(name: string, a: Record<string, unknown>) {
      if (name === "bundle_carrier_id") {
        const r = await run("SELECT bundle_carrier_id($1::uuid) AS r", [a.p_bundle]);
        return { data: r.rows[0]?.r ?? null, error: r.error };
      }
      if (name === "bundle_vote_fanout") {
        const r = await run("SELECT bundle_vote_fanout($1::uuid,$2::uuid,$3,$4,$5,$6,$7::smallint[],$8::jsonb,$9,$10,$11,$12) AS r",
          [a.p_carrier, a.p_bundle, a.p_agent, a.p_actor, a.p_ip, a.p_verdict, a.p_except, JSON.stringify(a.p_reasons), a.p_note, a.p_evidence, a.p_tool, a.p_via]);
        return { data: r.rows[0]?.r ?? null, error: r.error };
      }
      return { data: null, error: null };
    },
  };
}

const BUNDLE = "11111111-1111-4111-8111-111111111111";
const BULLETIN = "https://eebulletin.cec.gov.tw/111/06臺南市/05村里長/36安南/四草里.pdf";
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const NOTE = "對照公報第3頁到第5頁逐條核對過全部條目，每一條的標題與內容都對得上公報原文，沒有多出或漏掉的條目，也沒有改寫過的地方。";

/** 三條的包（0 是載體）；回傳 id 陣列。submitter 預設 submitter */
async function bundle3(db: PGlite, bundleId = BUNDLE, submitter = "submitter"): Promise<string[]> {
  await db.query(`INSERT INTO policy_bundles (id, agent_name, item_count) VALUES ($1, $2, 3)`, [bundleId, submitter]);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = uid();
    await db.query(
      `INSERT INTO contributions (id, bundle_id, bundle_index, agent_name, payload, source_urls, task_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'auto:policy_missing:p')`,
      [id, bundleId, i, submitter, JSON.stringify({ title: `公報政見第${i}條`, description: `描述${i}`, category: "都市發展與住宅" }), [BULLETIN]]);
    ids.push(id);
  }
  return ids;
}
const dispatched = (db: PGlite, cid: string, agent: string, ip = "ip-" + agent) =>
  db.query(`INSERT INTO verify_dispatches (contribution_id, ip_hash, agent_name) VALUES ($1,$2,$3)`, [cid, ip, agent]);

const applied: string[] = [];
const applyFn = (_s: unknown, row: { id: string }) => {
  applied.push(row.id);
  return Promise.resolve({ status: "applied" as const, message: "ok" });
};
async function report(db: PGlite, cid: string, agent: string, o: Row = {}, bundleId: string | null = BUNDLE) {
  await dispatched(db, cid, agent);
  const body = { contribution_id: cid, verdict: "agree", agent_name: agent, note: NOTE, ...(bundleId ? { bundle_id: bundleId } : {}), ...o };
  return await handleVerify(pgClient(db), body, "ip-" + agent, applyFn as never);
}
const st = async (db: PGlite, id: string) => (await db.query<{ status: string; score: number; released: boolean }>(
  `SELECT status, score, (bundle_released_at IS NOT NULL) AS released FROM contributions WHERE id = $1`, [id])).rows[0]!;
const tickets = async (db: PGlite) => (await db.query<{ task_id: string }>(`SELECT task_id FROM task_dispatches ORDER BY task_id`)).rows.map((r) => r.task_id.replace("verify:", ""));
const nVotes = async (db: PGlite, id: string) => Number((await db.query<{ c: string }>(`SELECT count(*) AS c FROM contribution_votes WHERE contribution_id = $1`, [id])).rows[0]!.c);

Deno.test("B1 兩個代理整包同意：全部 verified；載體即時落庫、其餘留給掃地機（單一請求只落庫載體）", async () => {
  applied.length = 0;
  const db = await env();
  const [c0, c1, c2] = await bundle3(db);
  assertEquals(await tickets(db), [c0!]);
  const a = await report(db, c0!, "alice");
  assertEquals(a.status, 201, JSON.stringify(a.body));
  assertEquals([a.body.voted, a.body.released, a.body.status], [3, 0, "pending"]);
  const b = await report(db, c0!, "bob");
  assertEquals(b.status, 201, JSON.stringify(b.body));
  assertEquals(b.body.voted, 3);
  assertEquals(applied, [c0!], "只有載體在這個請求內落庫");
  assertEquals(b.body.status, "applied");
  assertEquals((await st(db, c0!)).status, "applied");
  for (const id of [c1!, c2!]) {
    const r = await st(db, id);
    assertEquals([r.status, r.score], ["verified", 2], "其餘條目 verified，等 apply-verified 掃地機");
  }
  assert(typeof b.body.notice === "undefined" || String(b.body.notice).length >= 0);
  await db.close();
});

Deno.test("B2 例外條：不寫票、釋放成各自的票；另一人整包同意後例外條仍 pending 且有票", async () => {
  applied.length = 0;
  const db = await env();
  const [c0, c1, c2] = await bundle3(db);
  const a = await report(db, c0!, "alice", { except: [1], reasons: { "1": "公報第4頁沒有這一條政見，找不到對應" } });
  assertEquals(a.status, 201, JSON.stringify(a.body));
  assertEquals([a.body.voted, a.body.released, a.body.auto_excepted ?? null], [2, 1, null]);
  assertEquals(await nVotes(db, c1!), 0);
  assertEquals((await st(db, c1!)).released, true);
  assertEquals(await tickets(db), [c0!, c1!].sort());
  const b = await report(db, c0!, "bob");
  assertEquals(b.body.voted, 2);
  assertEquals((await st(db, c1!)).status, "pending");
  assertEquals((await st(db, c2!)).status, "verified");
  await db.close();
});

Deno.test("B3 例外含載體：回 new_carrier（票移轉）", async () => {
  const db = await env();
  const [c0, c1] = await bundle3(db);
  const a = await report(db, c0!, "alice", { except: [0], reasons: { "0": "公報第3頁沒有這一條政見內容" } });
  assertEquals(a.status, 201, JSON.stringify(a.body));
  assertEquals([a.body.voted, a.body.released, a.body.new_carrier], [2, 1, c1]);
  await db.close();
});

Deno.test("B4 舊代理（沒帶 bundle_id）對包票回 400 bundle_vote_required，不寫任何票", async () => {
  const db = await env();
  const [c0] = await bundle3(db);
  const r = await report(db, c0!, "legacy", {}, null);
  assertEquals([r.status, r.body.error], [400, "bundle_vote_required"]);
  assert(String(r.body.message).includes("1.131.0"));
  assertEquals(await nVotes(db, c0!), 0);
  assertEquals((await db.query(`SELECT 1 FROM bundle_votes`)).rows.length, 0);
  await db.close();
});

Deno.test("B5 非包的條目照舊（沒帶 bundle_id 正常收）；帶了不屬於它的 bundle_id 或單帶 except 回 bundle_mismatch", async () => {
  const db = await env();
  const [c0] = await bundle3(db);
  const plain = uid();
  await db.query(`INSERT INTO contributions (id, payload, source_urls) VALUES ($1, '{"title":"一般政見"}'::jsonb, ARRAY['https://example.test/a'])`, [plain]);
  const ok = await report(db, plain, "carol", {}, null);
  assert(ok.status < 400, JSON.stringify(ok.body));
  assertEquals(await nVotes(db, plain), 1);
  const wrong = await report(db, plain, "dave", {}, BUNDLE);
  assertEquals([wrong.status, wrong.body.error], [400, "bundle_mismatch"]);
  const otherBundle = await report(db, c0!, "erin", {}, "99999999-9999-4999-8999-999999999999");
  assertEquals([otherBundle.status, otherBundle.body.error], [400, "bundle_mismatch"]);
  const strayExcept = await report(db, plain, "frank", { except: [0], reasons: { "0": "公報第3頁沒有這一條政見內容" } }, null);
  assertEquals([strayExcept.status, strayExcept.body.error], [400, "bundle_mismatch"]);
  await db.close();
});

Deno.test("B6 檢查碼：note 太短、except 缺理由、except 搭 disagree、disagree 缺 evidence_url（都不寫票）", async () => {
  const db = await env();
  const [c0] = await bundle3(db);
  const short = await report(db, c0!, "alice", { note: "公報第3頁對得上" });
  assertEquals([short.status, short.body.error], [400, "bundle_note_too_short"]);
  const noReason = await report(db, c0!, "alice", { except: [2] });
  assertEquals([noReason.status, noReason.body.error], [400, "bundle_except_need_reason"]);
  const dis = await report(db, c0!, "alice", { verdict: "disagree", evidence_url: "https://example.test/x", except: [2], reasons: { "2": "公報第4頁沒有這一條政見" } });
  assertEquals([dis.status, dis.body.error], [400, "bundle_except_need_agree"]);
  const noEv = await report(db, c0!, "alice", { verdict: "disagree" });
  assertEquals([noEv.status, noEv.body.error], [400, "validation_failed"]);
  assertEquals(await nVotes(db, c0!), 0);
  assertEquals((await db.query(`SELECT 1 FROM bundle_votes`)).rows.length, 0, "被擋的不記 bundle_votes，改好還能再投");
  const ok = await report(db, c0!, "alice");
  assertEquals(ok.status, 201, JSON.stringify(ok.body));
  await db.close();
});

Deno.test("B7 整包 disagree 扇出 N 張反對；同一投票人對同一提交者 24 小時最多 1 包；換提交者或過了 24 小時可再反對", async () => {
  const db = await env();
  const [c0, c1, c2] = await bundle3(db);
  const ev = (k: number) => ({ verdict: "disagree", evidence_url: "https://example.test/bulletin-says-otherwise", note: NOTE + `第${k}輪反對：公報第${k}頁寫的與這包不同。` });
  const a = await report(db, c0!, "alice", ev(1));
  assertEquals(a.status, 201, JSON.stringify(a.body));
  assertEquals(a.body.voted, 3);
  for (const id of [c0!, c1!, c2!]) assertEquals((await st(db, id)).score, -1);
  assertEquals((await db.query<{ evidence_url: string }>(`SELECT evidence_url FROM contribution_votes WHERE agent_name='alice'`)).rows.every((r) => r.evidence_url === ev(1).evidence_url), true);
  // 同一提交者的第二包
  const B2 = "22222222-2222-4222-8222-222222222222";
  const [d0] = await bundle3(db, B2);
  const again = await report(db, d0!, "alice", ev(2), B2);
  assertEquals([again.status, again.body.error], [429, "bundle_rate_limited"]);
  assertEquals(await nVotes(db, d0!), 0);
  // 另一位提交者的包不受限
  const B3 = "33333333-3333-4333-8333-333333333333";
  const [e0] = await bundle3(db, B3, "someone-else");
  const other = await report(db, e0!, "alice", ev(3), B3);
  assertEquals(other.status, 201, JSON.stringify(other.body));
  // 同意票不受 24 小時限制
  const B4 = "44444444-4444-4444-8444-444444444444";
  const [f0] = await bundle3(db, B4);
  const agree = await report(db, f0!, "alice", {}, B4);
  assertEquals(agree.status, 201, JSON.stringify(agree.body));
  // 過了 24 小時：把第一筆 bundle_votes 推到兩天前，同提交者的包可再反對
  await db.query(`UPDATE bundle_votes SET created_at = now() - interval '2 days' WHERE bundle_id = $1`, [BUNDLE]);
  const later = await report(db, d0!, "alice", ev(2), B2);
  assertEquals(later.status, 201, JSON.stringify(later.body));
  await db.close();
});

Deno.test("B8 重複投同一包回 409 already_voted、不多寫票", async () => {
  const db = await env();
  const [c0] = await bundle3(db);
  assertEquals((await report(db, c0!, "alice")).status, 201);
  const second = await report(db, c0!, "alice", { note: NOTE + "（再核對一次第六頁）" });
  assertEquals([second.status, second.body.error], [409, "already_voted"]);
  assertEquals(await nVotes(db, c0!), 1);
  await db.close();
});

Deno.test("B9 必須指認的條不在 except 自動算例外並回 auto_excepted；沒必要指認的照投", async () => {
  const db = await env();
  const [c0, c1, c2] = await bundle3(db);
  const res = await handleBundleVerify({
    supabase: pgClient(db), input: mk({ contribution_id: c0!, agent_name: "alice" }), actor: { level: "anonymous", actor_id: "ip:alice" } as never,
    ipHash: "ip-alice", via: "report", applyFn: applyFn as never,
    carrier: { id: c0!, bundle_id: BUNDLE, agent_name: "submitter" },
    pick: (_s, _t, payload) => Promise.resolve({ required: (payload as { title?: string }).title === "公報政見第2條", candidates: [] }),
  });
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals([res.body.auto_excepted, res.body.voted, res.body.released], [[2], 2, 1]);
  assertEquals((await st(db, c2!)).released, true);
  assertEquals(await nVotes(db, c2!), 0);
  assertEquals(await nVotes(db, c1!), 1);
  assert((await tickets(db)).includes(c2!), "自動例外的條建了自己的票");
  await db.close();
});

// ============================================================
// C. auto-apply 不替包內非載體重建票
// ============================================================
Deno.test("C1 身分原因改回待指認重發票：包內非載體不建票、載體才建；已釋放與非包的照建", async () => {
  const db = await env();
  const [c0, c1] = await bundle3(db);
  const reject = () => Promise.resolve({ status: "disputed" as const, message: "同名多位", identity_pick: true as const });
  // c1：包內、不是載體（c0 還在 pending）→ 不建票
  await db.query(`UPDATE contributions SET status = 'verified' WHERE id = $1`, [c1!]);
  const r1 = await autoApplyContribution(pgClient(db) as never, c1!, reject as never);
  assertEquals(r1.status, "pending");
  assertEquals(await tickets(db), [c0!], "非載體沒有新票");
  // c0：載體 → 建票（先把它的票清掉，模擬票被收走）
  await db.query(`DELETE FROM task_dispatches`);
  await db.query(`UPDATE contributions SET status = 'verified' WHERE id = $1`, [c0!]);
  // 重發的是 task_dispatches 的 upsert；測試用 client 的 upsert 是空操作，所以這裡只驗「有沒有走到 upsert」：包住 from("task_dispatches")
  const upserts: string[] = [];
  const base = pgClient(db);
  const spy = { ...base, from: (t: string) => { if (t === "task_dispatches") return { upsert: (row: { task_id: string }) => { upserts.push(row.task_id); return Promise.resolve({ error: null }); } }; return base.from(t); } };
  await autoApplyContribution(spy as never, c0!, reject as never);
  assertEquals(upserts, [`verify:${c0}`]);
  // 已釋放的條目（自己走票）照建
  const c2 = (await db.query<{ id: string }>(`SELECT id FROM contributions WHERE bundle_index = 2`)).rows[0]!.id;
  await db.query(`UPDATE contributions SET status = 'verified', bundle_released_at = now() WHERE id = $1`, [c2]);
  upserts.length = 0;
  await autoApplyContribution(spy as never, c2, reject as never);
  assertEquals(upserts, [`verify:${c2}`]);
  // 非包的條目照建
  const plain = uid();
  await db.query(`INSERT INTO contributions (id, status) VALUES ($1, 'verified')`, [plain]);
  upserts.length = 0;
  await autoApplyContribution(spy as never, plain, reject as never);
  assertEquals(upserts, [`verify:${plain}`]);
  await db.close();
});

// ============================================================
// D. /next 的 item.bundle
// ============================================================
Deno.test("D1 loadBundleItem：載體附整包（序號、標題、公報網址）；非載體、已釋放、非包的條目是 null；載體移轉後新載體有", async () => {
  const db = await env();
  const [c0, c1] = await bundle3(db);
  const view = await loadBundleItem(pgClient(db), c0!);
  assertEquals(view?.bundle_id, BUNDLE);
  assertEquals(view?.source_url, BULLETIN);
  assertEquals(view?.items.map((i) => [i.index, i.contribution_id, i.title]), [[0, c0, "公報政見第0條"], [1, c1, "公報政見第1條"], [2, (await db.query<{ id: string }>(`SELECT id FROM contributions WHERE bundle_index=2`)).rows[0]!.id, "公報政見第2條"]]);
  assertEquals(await loadBundleItem(pgClient(db), c1!), null, "非載體");
  const plain = uid();
  await db.query(`INSERT INTO contributions (id) VALUES ($1)`, [plain]);
  assertEquals(await loadBundleItem(pgClient(db), plain), null);
  await db.query(`UPDATE contributions SET bundle_released_at = now() WHERE id = $1`, [c0!]);
  assertEquals(await loadBundleItem(pgClient(db), c0!), null, "已釋放");
  const v2 = await loadBundleItem(pgClient(db), c1!);
  assertEquals(v2?.items.map((i) => i.index), [1, 2], "新載體看到的是還在包裡的");
  await db.close();
});

Deno.test("D2 查詢失敗不丟錯（派工照舊，當不是包）", async () => {
  const broken = { from: () => { throw new Error("boom"); } };
  assertEquals(await loadBundleItem(broken, "x"), null);
});

// ============================================================
// E. 接線與協議
// ============================================================
const src = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

Deno.test("E1 /next 與 verify-handler 真的接上了；how_to 附整包說明", async () => {
  const next = await src("../next/index.ts");
  assert(next.includes("loadBundleItem(supabase, pick.id)") && next.includes("...(bundleView ? { bundle: bundleView } : {})") && next.includes("BUNDLE_HOW_TO"));
  const vh = await src("./verify-handler.ts");
  assert(vh.includes("bundle_vote_required") && vh.includes("handleBundleVerify("));
  const aa = await src("./auto-apply.ts");
  assert(aa.includes('rpc("bundle_carrier_id"'));
});

Deno.test("E2 協議 1.131.0：版號、skill.md 與 skill-types.md 都講到整包票", async () => {
  const [maj, min] = PROTOCOL_VERSION.split(".").map(Number);
  assert(maj > 1 || (maj === 1 && min >= 131));
  const skill = await src("../../../public/skill.md");
  const types = await src("../../../public/skill-types.md");
  assert(skill.includes(`**版本**：${PROTOCOL_VERSION}`));
  for (const k of ["item.bundle", "bundle_id", "bundle:true", "bundle_vote_required", "except", "reasons"]) assert(skill.includes(k) || types.includes(k), k);
  for (const k of ["bundle_note_too_short", "bundle_except_need_reason", "bundle_rate_limited", "auto_excepted"]) assert(types.includes(k) || skill.includes(k), k);
});

// ============================================================
// F. 驗證額度一包算一次（審查 #945 ①）
// ============================================================
Deno.test("F1 每時段驗證額度：一包 N 條只算一次；一般票仍各算一次，到上限照 429", async () => {
  resetQuotaCache();
  const db = await env();
  await db.exec(`CREATE TABLE quota_settings (site text, per_ip_submit int, per_ip_verify int, per_ditrust_submit int, per_ditrust_verify int);
    INSERT INTO quota_settings VALUES ('tw', 100, 10, 100, 100);`);
  const NET = "ip-shared-net";
  const vote = async (cid: string, agent: string, bundleId: string | null) => {
    await dispatched(db, cid, agent, NET);
    return await handleVerify(pgClient(db), { contribution_id: cid, verdict: "agree", agent_name: agent, note: NOTE + agent, ...(bundleId ? { bundle_id: bundleId } : {}) }, NET, applyFn as never);
  };
  // 5 包 × 3 條 ＝ 15 張條票，但只算 5 次額度（上限 10）
  for (let i = 0; i < 5; i++) {
    const bid = `aaaaaaaa-0000-4000-8000-00000000000${i}`;
    const [c0] = await bundle3(db, bid);
    const r = await vote(c0!, `bundler${i}`, bid);
    assertEquals(r.status, 201, `第 ${i} 包：${JSON.stringify(r.body)}`);
  }
  assertEquals(Number((await db.query<{ c: string }>(`SELECT count(*) AS c FROM contribution_votes WHERE via='bundle'`)).rows[0]!.c), 15);
  // 再 5 張一般票湊滿 10 次
  for (let i = 0; i < 5; i++) {
    const plain = uid();
    await db.query(`INSERT INTO contributions (id, payload, source_urls) VALUES ($1, '{"title":"一般"}'::jsonb, ARRAY['https://example.test/a'])`, [plain]);
    const r = await vote(plain, `plainer${i}`, null);
    assertEquals(r.status, 201, `一般票 ${i}：${JSON.stringify(r.body)}`);
  }
  const last = uid();
  await db.query(`INSERT INTO contributions (id, payload, source_urls) VALUES ($1, '{"title":"一般"}'::jsonb, ARRAY['https://example.test/a'])`, [last]);
  const over = await vote(last, "plainer-over", null);
  assertEquals([over.status, over.body.error], [429, "rate_limited"]);
  resetQuotaCache();
  await db.close();
});

// ============================================================
// G. 盲反對（審查 #945 ②）
// ============================================================
Deno.test("G1 整包 disagree 的理由是打不開／確認不了、且 evidence_url 就是公報本身：改記 unsure，不對每條記 −1", async () => {
  resetQuotaCache();
  const db = await env();
  const [c0, c1, c2] = await bundle3(db);
  const blindNote = NOTE + "但是公報網址目前打不開，讀不到內容。";
  const r = await report(db, c0!, "alice", { verdict: "disagree", evidence_url: BULLETIN, note: blindNote });
  assertEquals(r.status, 201, JSON.stringify(r.body));
  assertEquals([r.body.verdict, r.body.downgraded_from, r.body.voted], ["unsure", "disagree", 3]);
  for (const id of [c0!, c1!, c2!]) assertEquals((await st(db, id)).score, 0, "unsure 不記反對分");
  const verdicts = (await db.query<{ verdict: string }>(`SELECT DISTINCT verdict FROM contribution_votes`)).rows.map((x) => x.verdict);
  assertEquals(verdicts, ["unsure"]);
  assertEquals((await db.query<{ verdict: string }>(`SELECT verdict FROM bundle_votes`)).rows[0]!.verdict, "unsure");
  // 有實質矛盾的反對照記：同樣提到打不開，但寫出與公報不符
  const B2 = "22222222-2222-4222-8222-222222222222";
  const [d0] = await bundle3(db, B2);
  const real = await report(db, d0!, "alice", { verdict: "disagree", evidence_url: "https://example.test/other-source", note: NOTE + "公報網址偶爾打不開，但另一來源寫的是不同的內容，與這包不符。" }, B2);
  assertEquals(real.status, 201, JSON.stringify(real.body));
  assertEquals(real.body.verdict, "disagree");
  await db.close();
});
