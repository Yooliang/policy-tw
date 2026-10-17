/**
 * 「不確定」第 2 張起每張 −1（維護者 2026-10-17；補充 09-19「我看不到不是我反對」；migration 20261017020000）。
 *
 *   - 同一份交件的第 1 張 unsure 0 分，第 2 張起每張 −1；agree／disagree 權重、系統票、目標、退件門檻（3，不動正式資料的型別 2）不變
 *   - 做法：扣在 contribution_apply_consensus（SQL）與 unsurePenalty（TS 鏡像）的計分這一步，不寫進 contribution_votes.weight；
 *     罰則只看「每個來源 IP 最新一票是 unsure 的張數」，與順序無關
 *   - 兩份計分（TS／SQL）要一致：下面的 PGlite 測試真的跑 SQL 函式，與 TS 的 unsurePenalty／scoreStatus 逐案比對
 *   還原驗證（人工做過，見 PR 說明）：把 SQL 的 `v_score := v_score - contribution_unsure_penalty(v_unsure)` 拿掉、
 *   或把 unsurePenalty 的 `- 1` 改成 `- 0`，這支就紅
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";
import { rejectFloor, scoreStatus, unsurePenalty, voteWeight, weightReason } from "./consensus.ts";

const MIG = "20261017020000_unsure_penalty.sql";
const SQL = await readMig(MIG);
const REJECT_SQL = await readMig("20260923000007_reject_floor.sql");
const SCORE_SQL = await readMig("20260921000021_score_consensus.sql");

Deno.test("TS：不確定的罰則＝max(n−1, 0)；單票權重不變（unsure 仍是 0）", () => {
  assertEquals([0, 1, 2, 3, 4, 9].map(unsurePenalty), [0, 0, 1, 2, 3, 8]);
  assertEquals(voteWeight("unsure", false), 0);
  assertEquals(voteWeight("unsure", true), 0);
  assertEquals(voteWeight("agree", false), 1);
  assertEquals(voteWeight("disagree", true), -2);
});

Deno.test("TS：回給代理的理由講清楚第 2 張起 −1", () => {
  assertStringIncludes(weightReason("unsure", false), "第 1 張");
  assertStringIncludes(weightReason("unsure", false), "−1");
  assertStringIncludes(weightReason("unsure", false, false, 3), "第 3 張");
  assertStringIncludes(weightReason("unsure", false, false, 3), "−1");
});

Deno.test("SQL：migration 文字——罰則函式與計分那一步都在，weight 欄沒被動", () => {
  assertStringIncludes(SQL, "SELECT GREATEST(COALESCE(p_unsure, 0) - 1, 0)");
  assertStringIncludes(SQL, "v_score := v_score - contribution_unsure_penalty(v_unsure);");
  assertStringIncludes(SQL, "IF v_score <= -v_reject THEN", "退件門檻仍是固定 v_reject");
  // 不寫進 weight：這支沒有動 contribution_vote_weight、觸發器、也沒有 UPDATE contribution_votes
  assert(!/CREATE OR REPLACE FUNCTION contribution_vote_weight/.test(SQL));
  assert(!/UPDATE contribution_votes/.test(SQL));
  // 既有等票的交件在 migration 裡用同一支函式重算
  assertStringIncludes(SQL, "WHERE status = 'pending' AND unsure_count >= 2");
  assertStringIncludes(SQL, "PERFORM contribution_apply_consensus(r.id);");
});

// ── 真的跑 SQL（PGlite；依賴的函式用最小替身，權重表與退件門檻用 migration 的原文） ──
const ID = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function db(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, payload jsonb DEFAULT '{}', status text DEFAULT 'pending',
      agree_count int DEFAULT 0, disagree_count int DEFAULT 0, unsure_count int DEFAULT 0, score int DEFAULT 0, target_score int, voter_ips int DEFAULT 0,
      verified_at timestamptz, review_notes text, batch_verified_by text, created_at timestamptz DEFAULT now());
    CREATE TABLE contribution_votes (id serial PRIMARY KEY, contribution_id uuid, verifier_ip_hash text, verdict text, judge_backed boolean DEFAULT false,
      weight smallint, created_at timestamptz DEFAULT now());
    CREATE FUNCTION contribution_effective_agree(uuid) RETURNS int LANGUAGE sql AS 'SELECT 3';
    CREATE FUNCTION contribution_needs_two_ips(text, jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT false';
    CREATE FUNCTION contribution_roster_matched(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
    ${fnText(SCORE_SQL, "contribution_vote_weight")}
    ${fnText(REJECT_SQL, "contribution_reject_floor")}
    ${fnText(SQL, "contribution_unsure_penalty")}
    ${fnText(SQL, "contribution_apply_consensus")}
  `);
  return d;
}

/** 開一份交件、依序投票（verdict 或 [verdict, ip]），回 [狀態, 分數, unsure_count] */
async function score(d: PGlite, n: number, type: string, votes: Array<string | [string, string]>): Promise<[string, number, number]> {
  await d.query(`INSERT INTO contributions (id, contribution_type) VALUES ($1, $2)`, [ID(n), type]);
  let i = 0;
  for (const v of votes) {
    const [verdict, ip] = Array.isArray(v) ? v : [v, `ip-${++i}`];
    await d.query(`INSERT INTO contribution_votes (contribution_id, verifier_ip_hash, verdict, weight, created_at) VALUES ($1, $2, $3, contribution_vote_weight($3, false), now() + $4 * interval '1 second')`,
      [ID(n), ip, verdict, ++i]);
  }
  await d.query(`SELECT contribution_apply_consensus($1)`, [ID(n)]);
  const r = (await d.query<{ status: string; score: number; unsure_count: number }>(`SELECT status, score, unsure_count FROM contributions WHERE id = $1`, [ID(n)])).rows[0];
  return [r.status, r.score, r.unsure_count];
}

Deno.test("SQL 行為：第 1 張不確定 0 分、第 2 張起每張 −1；agree／disagree 不變", async () => {
  const d = await db();
  assertEquals(await score(d, 1, "policy", ["unsure"]), ["pending", 0, 1]);
  assertEquals(await score(d, 2, "policy", ["unsure", "unsure"]), ["pending", -1, 2]);
  assertEquals(await score(d, 3, "policy", ["agree", "unsure", "unsure", "unsure"]), ["pending", -1, 3]); // +1 −2
  assertEquals(await score(d, 4, "policy", ["agree", "agree", "unsure"]), ["pending", 2, 1]); // 單張不確定不扣
  assertEquals(await score(d, 5, "policy", ["disagree", "unsure", "unsure"]), ["pending", -2, 2]); // −1 −1
  await d.close();
});

Deno.test("SQL 行為：退件門檻不變（3，輕型別 2）；不確定把它推過線就退件，含有同意票的也一樣", async () => {
  const d = await db();
  assertEquals(await score(d, 10, "policy", ["unsure", "unsure", "unsure"]), ["pending", -2, 3]);
  assertEquals((await score(d, 11, "policy", ["unsure", "unsure", "unsure", "unsure"]))[0], "rejected"); // −3
  const [st, sc] = await score(d, 12, "policy", ["agree", "unsure", "unsure", "unsure", "unsure", "unsure"]); // +1 −4 = −3
  assertEquals([st, sc], ["rejected", -3]);
  assertEquals(await score(d, 13, "no_change", ["unsure", "unsure", "unsure"]), ["rejected", -2, 3]); // 輕型別門檻 2
  assertEquals((await score(d, 14, "no_change", ["unsure", "unsure"]))[0], "pending");
  const notes = (await d.query<{ review_notes: string }>(`SELECT review_notes FROM contributions WHERE id = $1`, [ID(12)])).rows[0].review_notes;
  assertStringIncludes(notes, "含不確定 5 張");
  await d.close();
});

Deno.test("SQL 行為：只看張數不看順序；同一個來源 IP 只算最新一票；重算永遠一致", async () => {
  const d = await db();
  // 同一 IP 先 unsure 再改 agree：只剩 agree，沒有不確定
  assertEquals(await score(d, 20, "policy", [["unsure", "ip-x"], ["agree", "ip-x"]]), ["pending", 1, 0]);
  // 同一 IP 兩次 unsure 只算一張
  assertEquals(await score(d, 21, "policy", [["unsure", "ip-y"], ["unsure", "ip-y"], "unsure"]), ["pending", -1, 2]);
  // 順序無關：unsure 排在 agree 前或後，分數相同
  const a = await score(d, 22, "policy", ["unsure", "unsure", "agree"]);
  const b = await score(d, 23, "policy", ["agree", "unsure", "unsure"]);
  assertEquals(a, b);
  // 重算冪等
  await d.query(`SELECT contribution_apply_consensus($1)`, [ID(22)]);
  await d.query(`SELECT contribution_apply_consensus($1)`, [ID(22)]);
  assertEquals((await d.query<{ score: number }>(`SELECT score FROM contributions WHERE id = $1`, [ID(22)])).rows[0].score, 0);
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
