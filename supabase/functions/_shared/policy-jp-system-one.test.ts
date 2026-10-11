/**
 * 日本站の系統票（migration 20261011110000）：候選清單 policy_jp.system_one_precheck_candidates と、系統票が入ったときの共識。
 * PGlite に _policy_jp_ の migration を全部当てた庫で試す（policy-jp-chain-db.ts）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { freshDb, one, rows } from "./policy-jp-chain-db.ts";
import { JP_PRECHECK_TYPES, JP_FETCH_ONLY_MODEL } from "./jp/system-one.ts";
import { systemVoteEligible } from "./jp/consensus.ts";

type Db = Awaited<ReturnType<typeof freshDb>>;
let n = 0;
async function contribution(db: Db, type: string, o: { status?: string; created?: string } = {}): Promise<string> {
  n++;
  const r = await one<{ id: string }>(db,
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash, status, created_at)
     VALUES ($1, $2, ARRAY['https://www.city.example.lg.jp/senkyo/${n}.html'], NULL, 'author', 'author-ip', $3, $4, $5) RETURNING id`,
    [type, JSON.stringify({ k: n }), `h-${n}`, o.status ?? "pending", o.created ?? new Date(Date.now() - (100 - n) * 60_000).toISOString()]);
  return r.id;
}
async function decision(db: Db, id: string, model: string, o: { choice?: string; p?: number; hoursAgo?: number } = {}) {
  const state: Record<string, unknown> = { n: Math.random() };
  await db.query(
    `INSERT INTO policy_jp.jev_decisions (subject_type, subject_id, question, choice, probability, model, state, asked_at)
     VALUES ('contribution', $1, 'source_support', $2, $3, $4, $5, now() - make_interval(hours => $6))`,
    [id, o.choice ?? "cannot_tell", o.p ?? 0, model, JSON.stringify(state), o.hoursAgo ?? 0]);
}

const candidates = async (db: Db) => (await rows<{ contribution_id: string }>(db, `SELECT contribution_id FROM policy_jp.system_one_precheck_candidates(50)`)).map((r) => r.contribution_id);

Deno.test("型別：SQL system_one_precheck_types() ＝ TS JP_PRECHECK_TYPES、どれも SQL と TS の両方で系統票の対象", async () => {
  const db = await freshDb();
  assertEquals((await one<{ t: string[] }>(db, `SELECT policy_jp.system_one_precheck_types() AS t`)).t, [...JP_PRECHECK_TYPES]);
  for (const t of JP_PRECHECK_TYPES) {
    assertEquals((await one<{ x: boolean }>(db, `SELECT policy_jp.system_vote_eligible($1) AS x`, [t])).x, true, t);
    assertEquals(systemVoteEligible(t), true, t);
  }
  await db.close();
});

Deno.test("候選：pending の candidacy／politician／policy だけ、古い順；election や verified は拾わない", async () => {
  const db = await freshDb();
  const a = await contribution(db, "candidacy");
  const b = await contribution(db, "politician");
  const c = await contribution(db, "policy");
  await contribution(db, "election");
  await contribution(db, "correction"); // system_vote_eligible だが宣稱の形が未定 → まだ聞かない
  await contribution(db, "candidacy", { status: "verified" });
  assertEquals(await candidates(db), [a, b, c]);
  await db.close();
});

Deno.test("候選：Jev が判定したら二度と聞かない；fetch-only は 24 時間後に再取得、未判定の後ろ、三回で打ち切り", async () => {
  const db = await freshDb();
  const judged = await contribution(db, "candidacy");
  const fresh = await contribution(db, "candidacy");
  const retry = await contribution(db, "candidacy");
  const tooMany = await contribution(db, "candidacy");
  const recent = await contribution(db, "candidacy");
  await decision(db, judged, "typesafe/jev-2026-10-01", { choice: "supported", p: 0.97 });
  await decision(db, retry, JP_FETCH_ONLY_MODEL, { hoursAgo: 25 });
  for (let i = 0; i < 3; i++) await decision(db, tooMany, JP_FETCH_ONLY_MODEL, { hoursAgo: 30 + i });
  await decision(db, recent, JP_FETCH_ONLY_MODEL, { hoursAgo: 1 });
  const got = await candidates(db);
  assertEquals(got, [fresh, retry]); // 未判定が先、再取得が後
  assert(!got.includes(judged) && !got.includes(tooMany) && !got.includes(recent));
  await db.close();
});

Deno.test("共識：系統票 supported（≥0.95）で candidacy の目標が 3→2、それでも異なる接続元 2 か所が要る", async () => {
  const db = await freshDb();
  const id = await contribution(db, "candidacy");
  const state = async () => one<{ status: string; target_score: number; score: number }>(db, `SELECT status, target_score, score FROM policy_jp.contributions WHERE id = $1`, [id]);
  await db.query(`SELECT policy_jp.contribution_apply_consensus($1)`, [id]);
  assertEquals((await state()).target_score, 3);
  await decision(db, id, "typesafe/jev-2026-10-01", { choice: "supported", p: 0.97 });
  await db.query(`SELECT policy_jp.contribution_apply_consensus($1)`, [id]);
  assertEquals((await state()).target_score, 2);
  // 同じ接続元から 2 票：接続元ごとに最新の 1 票だけ数えるので 1 点、pending のまま
  await db.query(`INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, agent_name, verifier_ip_hash) VALUES ($1, 'agree', 'v1', 'same-ip'), ($1, 'agree', 'v2', 'same-ip')`, [id]);
  await db.query(`SELECT policy_jp.contribution_apply_consensus($1)`, [id]);
  assertEquals([(await state()).score, (await state()).status], [1, "pending"]);
  // 別の接続元から 1 票：2 点・接続元 2 か所で verified（系統票がなければ目標 3 で届かない）
  await db.query(`INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, agent_name, verifier_ip_hash) VALUES ($1, 'agree', 'v3', 'other-ip')`, [id]);
  await db.query(`SELECT policy_jp.contribution_apply_consensus($1)`, [id]);
  const s = await state();
  assertEquals([s.score, s.target_score, s.status], [2, 2, "verified"]);
  // 確率が門檻未満の系統票は数えない（目標は表のまま）
  const low = await contribution(db, "politician");
  await decision(db, low, "typesafe/jev-2026-10-01", { choice: "supported", p: 0.9 });
  await db.query(`SELECT policy_jp.contribution_apply_consensus($1)`, [low]);
  assertEquals((await one<{ t: number }>(db, `SELECT target_score AS t FROM policy_jp.contributions WHERE id = $1`, [low])).t, 3);
  await db.close();
});

