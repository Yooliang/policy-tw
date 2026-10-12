/**
 * 日本站の系統票（migration 20261011110000）：候選清單 policy_jp.system_one_precheck_candidates と、系統票が入ったときの共識。
 * PGlite に _policy_jp_ の migration を全部当てた庫で試す（policy-jp-chain-db.ts）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { freshDb, one, readMig, rows } from "./policy-jp-chain-db.ts";
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
async function decision(db: Db, id: string, model: string, o: { choice?: string; p?: number; hoursAgo?: number; claim?: Record<string, unknown> } = {}) {
  const state: Record<string, unknown> = { n: Math.random(), ...(o.claim ? { claim: o.claim } : {}) };
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

Deno.test("候選：宣稱の election に投票日が入っていた旧判定は一度だけ聞き直す（20261011130000）；新しい宣稱の判定が入れば二度と聞かない", async () => {
  const db = await freshDb();
  const old = await contribution(db, "candidacy");
  const fresh = await contribution(db, "candidacy");
  const redone = await contribution(db, "candidacy");
  const plain = await contribution(db, "politician");
  const oldClaim = { name: "山田太郎", election: "丸森町長選挙（投票日 2026-12-20）", candidacy_status: "立候補を表明した（出馬表明）" };
  const newClaim = { name: "山田太郎", election: "丸森町長選挙", candidacy_status: "立候補を表明した（出馬表明）" };
  await decision(db, old, "typesafe/jev-1.13.0", { choice: "supported", p: 0.52, claim: oldClaim });
  await decision(db, redone, "typesafe/jev-1.13.0", { choice: "supported", p: 0.52, claim: oldClaim, hoursAgo: 2 });
  await decision(db, redone, "typesafe/jev-1.13.0", { choice: "supported", p: 0.98, claim: newClaim });
  await decision(db, plain, "typesafe/jev-1.13.0", { choice: "supported", p: 0.6, claim: { name: "山田太郎", birth_year: 1965 } });
  assertEquals(await candidates(db), [fresh, old]); // 未判定が先、聞き直しは後ろ；聞き直し済み・投票日のない宣稱は拾わない
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


Deno.test("呼び出し憑證：Vault の jp_system_one_cron_secret と摘要で照合、短い・別の排程の密鑰・NULL は通さない、service_role だけ実行可", async () => {
  const db = await freshDb();
  // Vault と pgcrypto の替身（bulletin-watch-db.test.ts と同じ）：digest は原字串の位元組を返す
  await db.exec(`
    CREATE SCHEMA vault; CREATE SCHEMA extensions;
    CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
    CREATE FUNCTION extensions.digest(t text, a text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT convert_to(t, 'UTF8') $$;
    INSERT INTO vault.decrypted_secrets VALUES ('jp_system_one_cron_secret', 'jp-secret-jp-secret-jp-secret'), ('bulletin_watch_cron_secret', 'other-secret-other-secret');
  `);
  const ok = async (s: string | null) => (await one<{ ok: boolean }>(db, `SELECT policy_jp.jp_system_one_cron_secret_ok($1) AS ok`, [s])).ok;
  assertEquals(await ok("jp-secret-jp-secret-jp-secret"), true);
  assertEquals(await ok("other-secret-other-secret"), false);
  assertEquals(await ok("wrong-wrong-wrong-wrong"), false);
  assertEquals(await ok(null), false);
  await db.exec(`INSERT INTO vault.decrypted_secrets VALUES ('jp_system_one_cron_secret', 'tiny')`);
  assertEquals(await ok("tiny"), false);
  const grants = await rows<{ grantee: string }>(db,
    `SELECT grantee::text FROM information_schema.routine_privileges WHERE routine_schema = 'policy_jp' AND routine_name = 'jp_system_one_cron_secret_ok' ORDER BY 1`);
  assertEquals(grants.map((g) => g.grantee).filter((g) => ["anon", "authenticated", "PUBLIC", "service_role"].includes(g)), ["service_role"]);
  await db.close();
});

Deno.test("端點：cron は x-cron-secret を Vault から読んで付ける；関数は verifyCaller で照合してから動き、limit は 60 まで", async () => {
  const mig = await readMig("20261011110000_policy_jp_system_one_precheck.sql");
  assert(mig.includes(`'x-cron-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'jp_system_one_cron_secret' LIMIT 1), '')`));
  assert(mig.includes("jp-system-one?action=precheck&limit=60"));
  const src = await Deno.readTextFile(new URL("../jp-system-one/index.ts", import.meta.url));
  assert(src.includes(`rpc("jp_system_one_cron_secret_ok"`));
  assert(/const PRECHECK_MAX = 60;/.test(src));
  // 憑證の照合は jpClient を作る・Jev の金鑰を読む・候選を拾うより前
  const auth = src.indexOf("if (!check.ok) return");
  assert(auth > 0 && auth < src.indexOf("jevKeyFromEnv(") && auth < src.indexOf(`rpc("system_one_precheck_candidates"`));
});

Deno.test("密鑰：Vault がある環境では migration が一度だけ作る（重跑しても増えない・既存の値は変えない）", async () => {
  const db = await freshDb();
  await db.exec(`
    CREATE SCHEMA vault; CREATE SCHEMA extensions;
    CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
    CREATE FUNCTION extensions.gen_random_bytes(n integer) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(repeat('ab', n), 'hex') $$;
    CREATE FUNCTION vault.create_secret(new_secret text, new_name text, new_description text) RETURNS uuid LANGUAGE sql
      AS $$ INSERT INTO vault.decrypted_secrets VALUES (new_name, new_secret) RETURNING gen_random_uuid() $$;
  `);
  const mig = await readMig("20261011110000_policy_jp_system_one_precheck.sql");
  await db.exec(mig);
  const secrets = async () => await rows<{ s: string }>(db, `SELECT decrypted_secret AS s FROM vault.decrypted_secrets WHERE name = 'jp_system_one_cron_secret'`);
  assertEquals((await secrets()).map((r) => r.s), ["ab".repeat(32)]);
  await db.exec(`UPDATE vault.decrypted_secrets SET decrypted_secret = 'rotated-rotated-rotated' WHERE name = 'jp_system_one_cron_secret'`);
  await db.exec(mig);
  assertEquals((await secrets()).map((r) => r.s), ["rotated-rotated-rotated"]);
  await db.close();
});
