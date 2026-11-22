/**
 * 不確定票不扣分（維護者 2026-11-22：「unsure 將他改成不扣分」；migration 20261122170000）。
 * 2026-10-17～11-22 曾是「第 2 張起每張 −1」（20261017020000）；現在 unsure 一律 0 分，但仍計入驗證票「投太多輪」的張數。
 *
 *   - 計分：agree +1／disagree −1／judge_backed ±2／unsure 0；退件門檻（3，輕型別 2）、目標不變
 *   - 兩份計分（TS／SQL）要一致：下面的 PGlite 測試真的跑 SQL 函式，與 TS 的 unsurePenalty／scoreStatus 逐案比對
 *   - 不回頭改資料：migration 不 UPDATE 任何交件；退件備註不再印「第 2 張起每張 −1」
 *   還原驗證（人工做過）：把 SQL 或 TS 的罰則改回 GREATEST(n−1,0)／max(n−1,0)，這支就紅
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";
import { rejectFloor, scoreStatus, unsurePenalty, voteWeight, weightReason } from "./consensus.ts";

const MIG = "20261122170000_unsure_no_penalty.sql";
const SQL = await readMig(MIG);
const REJECT_SQL = await readMig("20260923000007_reject_floor.sql");
const SCORE_SQL = await readMig("20260921000021_score_consensus.sql");

Deno.test("TS：不確定不扣分，罰則恆 0；單票權重不變（unsure 仍是 0）", () => {
  assertEquals([0, 1, 2, 3, 4, 9].map(unsurePenalty), [0, 0, 0, 0, 0, 0]);
  assertEquals(voteWeight("unsure", false), 0);
  assertEquals(voteWeight("unsure", true), 0);
  assertEquals(voteWeight("agree", false), 1);
  assertEquals(voteWeight("disagree", true), -2);
});

Deno.test("TS：回給代理的理由講清楚不扣分、但算進票數", () => {
  for (const n of [0, 1, 3]) {
    const r = weightReason("unsure", false, false, n);
    assertStringIncludes(r, "不扣分");
    assertStringIncludes(r, "票數");
    assert(!r.includes("−1"), "不能再說第 2 張起 −1");
  }
});

Deno.test("SQL：migration 文字——罰則函式恆 0；退件備註不再提扣分；weight 欄沒被動；不回頭改資料", () => {
  assertStringIncludes(SQL, "  SELECT 0");
  assert(!SQL.includes("GREATEST(COALESCE(p_unsure"));
  assertStringIncludes(SQL, "IF v_score <= -v_reject THEN", "退件門檻仍是固定 v_reject");
  assert(!SQL.includes("第 2 張起每張 −1）'"), "備註不再印扣分說明");
  assert(!/CREATE OR REPLACE FUNCTION contribution_vote_weight/.test(SQL));
  assert(!/UPDATE contribution_votes/.test(SQL));
  assert(!/UPDATE contributions/.test(SQL.replace(/UPDATE contributions SET[\s\S]*?WHERE id = p_contribution_id;/, "")), "只有 apply_consensus 自己那段 UPDATE，沒有回頭改資料的語句");
});

// ── 真的跑 SQL（PGlite；依賴的函式用最小替身，權重表與退件門檻用 migration 的原文） ──
const ID = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function db(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, payload jsonb DEFAULT '{}', status text DEFAULT 'pending',
      agree_count int DEFAULT 0, disagree_count int DEFAULT 0, unsure_count int DEFAULT 0, score int DEFAULT 0, target_score int, voter_ips int DEFAULT 0,
      verified_at timestamptz, review_notes text, batch_verified_by text, created_at timestamptz DEFAULT now());
    CREATE TABLE contribution_votes (id serial PRIMARY KEY, contribution_id uuid, verifier_ip_hash text, agent_name text, actor_id text, verdict text, judge_backed boolean DEFAULT false,
      weight smallint, created_at timestamptz DEFAULT now());
    CREATE TABLE contribution_tasks (id uuid, task_type text, status text, created_by text, target jsonb);
    CREATE FUNCTION contribution_effective_agree(uuid) RETURNS int LANGUAGE sql AS 'SELECT 3';
    ${fnText(SCORE_SQL, "contribution_vote_weight")}
    ${fnText(REJECT_SQL, "contribution_reject_floor")}
    ${fnText(SQL, "contribution_unsure_penalty")}
    ${fnText(SQL, "contribution_apply_consensus")}
  `);
  return d;
}

/** 開一份交件、依序投票（verdict 或 [verdict, 投票人代號]），回 [狀態, 分數, unsure_count]。所有票都來自同一個網段 same-net：證明計票不看 IP */
async function score(d: PGlite, n: number, type: string, votes: Array<string | [string, string]>): Promise<[string, number, number]> {
  await d.query(`INSERT INTO contributions (id, contribution_type) VALUES ($1, $2)`, [ID(n), type]);
  let i = 0;
  for (const v of votes) {
    const [verdict, voter] = Array.isArray(v) ? v : [v, `voter-${++i}`];
    await d.query(`INSERT INTO contribution_votes (contribution_id, agent_name, verifier_ip_hash, verdict, weight, created_at) VALUES ($1, $2, 'same-net', $3, contribution_vote_weight($3, false), now() + $4 * interval '1 second')`,
      [ID(n), voter, verdict, ++i]);
  }
  await d.query(`SELECT contribution_apply_consensus($1)`, [ID(n)]);
  const r = (await d.query<{ status: string; score: number; unsure_count: number }>(`SELECT status, score, unsure_count FROM contributions WHERE id = $1`, [ID(n)])).rows[0];
  return [r.status, r.score, r.unsure_count];
}

Deno.test("SQL 行為：不確定 0 分，不論幾張；agree／disagree 不變", async () => {
  const d = await db();
  assertEquals(await score(d, 1, "policy", ["unsure", "unsure", "unsure"]), ["pending", 0, 3]); // 3 張 unsure＋0 反對：0 分不退件
  assertEquals(await score(d, 2, "policy", ["agree", "agree", "unsure", "unsure"]), ["pending", 2, 2]);
  assertEquals(await score(d, 3, "policy", ["agree", "unsure", "unsure", "unsure"]), ["pending", 1, 3]);
  assertEquals(await score(d, 4, "policy", ["disagree", "unsure", "unsure"]), ["pending", -1, 2]);
  await d.close();
});

Deno.test("SQL 行為：退件門檻不變（3，輕型別 2）；unsure 推不過線，只有 disagree 能退件", async () => {
  const d = await db();
  assertEquals((await score(d, 10, "policy", ["unsure", "unsure", "unsure", "unsure", "unsure"]))[0], "pending");
  assertEquals((await score(d, 11, "no_change", ["unsure", "unsure", "unsure"]))[0], "pending");
  const [st, sc] = await score(d, 12, "policy", ["disagree", "disagree", "disagree", "unsure", "unsure"]); // −3
  assertEquals([st, sc], ["rejected", -3]);
  const notes = (await d.query<{ review_notes: string }>(`SELECT review_notes FROM contributions WHERE id = $1`, [ID(12)])).rows[0].review_notes;
  assertStringIncludes(notes, "依分數制退件");
  assert(!notes.includes("第 2 張起每張"), "備註不再印扣分說明");
  assertEquals(await score(d, 13, "no_change", ["disagree", "disagree"]), ["rejected", -2, 0]); // 輕型別門檻 2
  await d.close();
});

Deno.test("SQL 行為：只看張數不看順序；同一個投票人（代號，不分大小寫）只算最新一票；重算永遠一致", async () => {
  const d = await db();
  // 同一投票人先 unsure 再改 agree：只剩 agree，沒有不確定（大小寫不分）
  assertEquals(await score(d, 20, "policy", [["unsure", "ip-x"], ["agree", "IP-X"]]), ["pending", 1, 0]);
  // 同一投票人兩次 unsure 只算一張
  assertEquals(await score(d, 21, "policy", [["unsure", "ip-y"], ["unsure", "ip-y"], "unsure"]), ["pending", 0, 2]);
  // 順序無關：unsure 排在 agree 前或後，分數相同
  const a = await score(d, 22, "policy", ["unsure", "unsure", "agree"]);
  const b = await score(d, 23, "policy", ["agree", "unsure", "unsure"]);
  assertEquals(a, b);
  // 重算冪等
  await d.query(`SELECT contribution_apply_consensus($1)`, [ID(22)]);
  await d.query(`SELECT contribution_apply_consensus($1)`, [ID(22)]);
  assertEquals((await d.query<{ score: number }>(`SELECT score FROM contributions WHERE id = $1`, [ID(22)])).rows[0].score, 1);
  await d.close();
});

Deno.test("SQL 與 TS 逐案一致：score → 狀態（scoreStatus）與罰則（unsurePenalty）", async () => {
  const d = await db();
  const cases: Array<{ type: string; votes: string[] }> = [
    { type: "policy", votes: ["unsure", "unsure", "unsure", "unsure"] },
    { type: "policy", votes: ["agree", "agree", "unsure", "unsure"] },
    { type: "no_change", votes: ["unsure", "unsure", "unsure"] },
    { type: "correction", votes: ["disagree", "disagree", "unsure", "unsure", "unsure"] },
    { type: "policy", votes: ["agree", "agree", "agree", "unsure", "unsure"] },
  ];
  let n = 100;
  for (const c of cases) {
    const [status, sc, uc] = await score(d, ++n, c.type, c.votes);
    const base = c.votes.reduce((s, v) => s + voteWeight(v, false), 0);
    const expectScore = base - unsurePenalty(c.votes.filter((v) => v === "unsure").length);
    assertEquals(sc, expectScore, `分數：${c.type} ${c.votes.join(",")}`);
    assertEquals(uc, c.votes.filter((v) => v === "unsure").length);
    assertEquals(status, scoreStatus({ score: expectScore, target: 3, distinctIps: 3, contributionType: c.type, current: "pending" }), `狀態：${c.type} ${c.votes.join(",")}`);
    assertEquals(rejectFloor(c.type) === 2, c.type === "no_change");
  }
  await d.close();
});
