/**
 * 投票不看 IP（維護者本人 2026-11-04 裁定，policy-ops#199；migration 20261104130000_vote_no_ip.sql）的守門。
 *
 * 一人一票的單位＝DiTrust 帳號按 actor_id、匿名按小寫代號（TS voterKey／SQL voter_key 同一條）；來源網段不參與自交、重投、計票、驗證池排除。
 *   1 文字層：新 migration 的計票函式（正見與日本站各一份）不再引用 verifier_ip_hash 做去重、不再引用 contribution_needs_two_ips／v_ips >= 2
 *   2 PGlite 真的跑 contribution_apply_consensus（正見）：同網段兩個代號各算一票、單一投票人高風險型別分數到了就 verified、
 *     同代號換 IP 只算一票、DiTrust 同 actor_id 換代號只算一票、DiTrust 與同名匿名分開；SQL 結果跟 TS tallyByVoter／scoreStatus 逐案一致
 *   3 contribution_needs_two_ips 恆為 FALSE（兩個 schema）
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";
import { scoreStatus, tallyByVoter, voteWeight } from "./consensus.ts";

const MIG = "20261104130000_vote_no_ip.sql";
const SQL = await readMig(MIG);
const SCORE_SQL = await readMig("20260921000021_score_consensus.sql");
const REJECT_SQL = await readMig("20260923000007_reject_floor.sql");
const PENALTY_SQL = await readMig("20261017020000_unsure_penalty.sql");

const strip = (s: string) => s.replace(/--[^\n]*/g, "");

Deno.test("文字層：兩個 schema 的計票函式不再用來源 IP 去重、不再有兩台機器條件", () => {
  for (const name of ["contribution_apply_consensus", "policy_jp.contribution_apply_consensus"]) {
    const body = strip(fnText(SQL, name));
    assert(!body.includes("verifier_ip_hash"), `${name} 不該再引用 verifier_ip_hash`);
    assert(!body.includes("contribution_needs_two_ips"), `${name} 不該再呼叫 contribution_needs_two_ips`);
    assert(!/v_ips\s*>=\s*2/.test(body), `${name} 不該再有 v_ips >= 2`);
    assert(!body.includes("contribution_roster_matched"), `${name} 不該再有名冊吻合免兩台機器的例外`);
    assert(body.includes("DISTINCT ON (voter_key)"), `${name} 每個投票人只算最新一票`);
    assert(body.includes("CASE WHEN actor_id LIKE 'ditrust:%' THEN actor_id ELSE lower(agent_name) END"), `${name} 投票人的鍵`);
    assert(body.includes("ELSIF v_score >= v_target THEN"), `${name} 分數到了就 verified`);
  }
});

Deno.test("文字層：兩個 schema 的 contribution_needs_two_ips 恆為 FALSE；驗證派工認領只擋同代號", () => {
  for (const name of ["contribution_needs_two_ips", "policy_jp.contribution_needs_two_ips"]) {
    assert(/AS \$\$ SELECT FALSE \$\$/.test(fnText(SQL, name)), `${name} 恆為 FALSE`);
  }
  for (const name of ["verify_dispatch_claim", "policy_jp.verify_dispatch_claim"]) {
    const body = strip(fnText(SQL, name));
    assert(body.includes("lower(vd.agent_name) IS DISTINCT FROM lower(EXCLUDED.agent_name)"), `${name} 同網段不同代號各自認領`);
  }
});

async function db(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, payload jsonb DEFAULT '{}', status text DEFAULT 'pending',
      agree_count int DEFAULT 0, disagree_count int DEFAULT 0, unsure_count int DEFAULT 0, score int DEFAULT 0, target_score int, voter_ips int DEFAULT 0,
      verified_at timestamptz, review_notes text, batch_verified_by text, created_at timestamptz DEFAULT now());
    CREATE TABLE contribution_votes (id serial PRIMARY KEY, contribution_id uuid, verifier_ip_hash text, agent_name text, actor_id text, verdict text,
      judge_backed boolean DEFAULT false, weight smallint, created_at timestamptz DEFAULT now());
    CREATE TABLE contribution_tasks (id uuid, task_type text, status text, created_by text, target jsonb);
    CREATE FUNCTION contribution_effective_agree(uuid) RETURNS int LANGUAGE sql AS 'SELECT 3';
    ${fnText(SCORE_SQL, "contribution_vote_weight")}
    ${fnText(REJECT_SQL, "contribution_reject_floor")}
    ${fnText(PENALTY_SQL, "contribution_unsure_penalty")}
    ${fnText(SQL, "contribution_apply_consensus")}
  `);
  return d;
}

type V = { agent: string; actor?: string | null; ip: string; verdict: "agree" | "disagree" | "unsure" };
const ID = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function run(d: PGlite, n: number, type: string, votes: V[]): Promise<{ status: string; score: number; agree: number; ips: number }> {
  await d.query(`INSERT INTO contributions (id, contribution_type) VALUES ($1, $2)`, [ID(n), type]);
  let i = 0;
  for (const v of votes) {
    await d.query(
      `INSERT INTO contribution_votes (contribution_id, verifier_ip_hash, agent_name, actor_id, verdict, weight, created_at)
       VALUES ($1, $2, $3, $4, $5, contribution_vote_weight($5, false), now() + $6 * interval '1 second')`,
      [ID(n), v.ip, v.agent, v.actor ?? null, v.verdict, ++i],
    );
  }
  await d.query(`SELECT contribution_apply_consensus($1)`, [ID(n)]);
  const r = (await d.query<{ status: string; score: number; agree_count: number; voter_ips: number }>(
    `SELECT status, score, agree_count, voter_ips FROM contributions WHERE id = $1`, [ID(n)])).rows[0];
  return { status: r.status, score: r.score, agree: r.agree_count, ips: r.voter_ips };
}
const agree = (agent: string, ip = "net-1", actor?: string): V => ({ agent, ip, actor, verdict: "agree" });

Deno.test("SQL 行為：同網段三個代號各算一票（目標 3 → verified）；同代號換三個 IP 只算一票", async () => {
  const d = await db();
  const sameNet = await run(d, 1, "candidacy", [agree("a"), agree("b"), agree("c")]);
  assertEquals([sameNet.status, sameNet.score, sameNet.agree], ["verified", 3, 3]);
  const oneVoter = await run(d, 2, "candidacy", [agree("a", "ip-1"), agree("A", "ip-2"), agree("a", "ip-3")]);
  assertEquals([oneVoter.status, oneVoter.score, oneVoter.agree], ["pending", 1, 1]);
  await d.close();
});

Deno.test("SQL 行為：高風險型別（以前要兩個不同 IP）單一網段分數到了就 verified；分數沒到不過", async () => {
  const d = await db();
  let n = 10;
  for (const t of ["candidacy", "merge_politician", "removal", "reassign_candidacy", "lineage_handover", "correction"]) {
    const ok = await run(d, ++n, t, [agree("a"), agree("b"), agree("c")]);
    assertEquals(ok.status, "verified", `${t} 三票同網段`);
    assertEquals(ok.status, scoreStatus({ score: ok.score, target: 3, distinctIps: 1, contributionType: t, current: "pending" }), `${t} 跟 TS 一致`);
    const no = await run(d, ++n, t, [agree("a"), agree("b")]);
    assertEquals(no.status, "pending", `${t} 兩票不夠`);
  }
  await d.close();
});

Deno.test("SQL 行為：DiTrust 同 actor_id 換代號只算一票；DiTrust 與同名匿名分開；SQL 與 TS tallyByVoter 逐案一致", async () => {
  const d = await db();
  const dtSame: V[] = [agree("alice", "ip-1", "ditrust:u1"), agree("alice-new", "ip-2", "ditrust:u1")];
  const r1 = await run(d, 30, "policy", dtSame);
  assertEquals(r1.agree, 1);
  const mixed: V[] = [agree("alice", "net-1", "ditrust:u1"), agree("Alice", "net-1")]; // 正式表有 UNIQUE(貢獻, agent_name)（區分大小寫）：DiTrust 顯示名與匿名只可能差大小寫，鍵仍分開（現狀：兩票；DiTrust 與匿名互轉可投兩票，已知限制）
  const r2 = await run(d, 31, "policy", mixed);
  assertEquals(r2.agree, 2, "DiTrust 與同名匿名是兩個投票人");
  // 匿名票的 actor_id 是網段雜湊，不當身份
  const anonNetActor: V[] = [agree("p", "net-1", "net-hash"), agree("q", "net-1", "net-hash")];
  const r3 = await run(d, 32, "policy", anonNetActor);
  assertEquals(r3.agree, 2, "匿名的 actor_id（網段雜湊）不拿來去重");
  for (const [votes, res] of [[dtSame, r1], [mixed, r2], [anonNetActor, r3]] as const) {
    const ts = tallyByVoter(votes.map((v) => ({ verdict: v.verdict, agent_name: v.agent, actor_id: v.actor })));
    assertEquals(res.agree, ts.agree);
    assertEquals(res.score, ts.agree * voteWeight("agree", false));
  }
  await d.close();
});

Deno.test("SQL 行為：同一個投票人的最新一票為準（agree 改成 disagree）", async () => {
  const d = await db();
  const r = await run(d, 40, "policy", [agree("a", "ip-1"), { agent: "A", ip: "ip-2", verdict: "disagree" }]);
  assertEquals([r.agree, r.score], [0, -1]);
  await d.close();
});
