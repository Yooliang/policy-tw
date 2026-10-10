/**
 * 補出處の死鎖（#556 審查）の端到端：career_sources 任務 → /jp-report（handleContribute＋same_claim）→ 落庫 → 出處が掛かる → profile 步驟 done → 任務收回。
 *
 * 入口（jp-report）は有狀態の假 PostgREST（jp-entry-chain-db.ts）、同一件事の比對（rpc same_claim_matches）の答えは
 * 本物の SQL（PGlite に全 migration を適用）に聞いて入口に渡す。落庫も PGlite の policy_jp.apply_contribution。
 * 修正前（出處のない項目も『既存の事実』に数える）では、new が 409 duplicate_claim になり、補出處が永遠に掛からない（還原驗證で赤くなる）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { env, makeDb, N1, post, type Row, withEntries } from "./jp-entry-chain-db.ts";
import {
  applyOne, clock, dispatchIds, freshDb, ELECTION_URL, ICHI, migratedDb, mutate, one, openElectionWithRegion, readMig, rows, seed, stepsDone, submit,
} from "./policy-jp-chain-db.ts";

const MIG_FILE = "20261010050000_policy_jp_chain_profile.sql";
const POLLING = "2027-04-25";
const E1 = `${POLLING}_mayor_${ICHI}`;
type Db = Awaited<ReturnType<typeof freshDb>>;

async function scenario(db: Db) {
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  // 候補者（生年あり）＋出處のない経歴 1 項目（手で入れた）→ career_sources の缺口だけが残る
  const cid = await submit(db, "candidacy", { election_id: E1, name: "佐藤花子", kana: "さとうはなこ", candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large", birth_year: 1975 },
    { status: "verified", urls: [ELECTION_URL] });
  assertEquals((await applyOne(db, cid)).status, "applied");
  const pid = (await one<{ id: string }>(db, `SELECT id FROM policy_jp.politicians`)).id;
  await db.query(`INSERT INTO policy_jp.politician_careers (politician_id, kind, text, sort_order, review_status) VALUES ($1, 'education', '○○大学卒業', 1, 'published')`, [pid]);
  await seed(db);
  const task = `auto:profile_detail_gap:sources:${pid}`;
  const ids = await dispatchIds(db, ["profile_detail_gap"]);
  assertEquals(ids, [task]);
  assertEquals((await stepsDone(db, E1)).profile, false);

  // 代理が出處を掛ける提出（education に在庫と同じ文字、resolved_claim=new）。同一件事の答えは本物の SQL から
  const payload = { politician_id: pid, education: ["○○大学卒業"], resolved_claim: "new" };
  const sql = (await one<{ r: { existing: Row[]; pending: Row[] } }>(db, `SELECT policy_jp.same_claim_matches('politician', $1::JSONB) AS r`, [JSON.stringify(payload)])).r;
  const fake = makeDb({ sameClaims: { politician: sql } });
  const sourceUrl = "https://www.pref.aichi.lg.jp/profile/";
  let status = 0;
  let error: unknown;
  await withEntries(fake, env(), async ({ report }) => {
    const res = await post(report, N1, {
      kind: "contribute", contribution_type: "politician", task_id: task, agent_name: "dave", agent_tool: "claude-code/claude-sonnet-5", payload, source_urls: [sourceUrl],
    });
    status = res.status;
    error = res.json.error;
  });
  return { pid, task, status, error, matches: sql, payload, sourceUrl };
}

Deno.test("補出處：在庫だが出處のない項目は『既存の事実』ではない → new で 201 → 落庫で出處が掛かり、profile 步驟 done、任務が收回される", async () => {
  const db = await freshDb();
  const s = await scenario(db);
  assertEquals(s.matches.existing, [], "出處のない項目は existing に出ない");
  assertEquals([s.status, s.error], [201, undefined]);
  // 入口が受けた提出を PGlite に入れて落庫（verified＝3 票通過の後）
  const id = await submit(db, "politician", s.payload, { status: "verified", urls: [s.sourceUrl], task: s.task });
  const out = await applyOne(db, id);
  assertEquals([out.status, out.outcome], ["applied", "applied"]);
  assertEquals((await rows(db, `SELECT 1 FROM policy_jp.source_refs r JOIN policy_jp.politician_careers c ON r.target_table = 'politician_careers' AND r.target_id = c.id::TEXT WHERE c.politician_id = '${s.pid}'`)).length, 1, "出處が掛かった");
  assertEquals((await stepsDone(db, E1)).profile, true);
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_detail_gap"]), [], "任務は收回され、再び派されない");
  // 出處がついた項目は、以後は『既存の事実』（同じものを new で出すと重複）
  const again = (await one<{ r: { existing: Row[] } }>(db, `SELECT policy_jp.same_claim_matches('politician', $1::JSONB) AS r`, [JSON.stringify(s.payload)])).r;
  assertEquals(again.existing.length, 1);
  await db.close();
});

Deno.test("還原驗證：修正（出處のある項目だけ既存）を外すと、同じ提出が 409 duplicate_claim になり、出處が掛からず profile が done にならない", async () => {
  const db = await migratedDb({ before: MIG_FILE });
  const sql = await readMig(MIG_FILE);
  await db.exec(mutate(sql, "       AND EXISTS (SELECT 1 FROM policy_jp.source_refs r WHERE r.target_table = 'politician_careers' AND r.target_id = pc.id::TEXT)\n", ""));
  const s = await scenario(db);
  assert(s.matches.existing.length > 0, "出處のない項目が existing に出てしまう");
  assertEquals([s.status, s.error], [409, "duplicate_claim"]);
  assertEquals((await stepsDone(db, E1)).profile, false);
  await db.close();
});

Deno.test("profile_gap（生年）には同類の死鎖がない：生年が空の人にだけ任務が出て、生年の既存判定は『庫に生年がある』だけ → new で通り、落庫で埋まって任務が收回される", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const cid = await submit(db, "candidacy", { election_id: E1, name: "鈴木一郎", kana: "すずきいちろう", candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large" },
    { status: "verified", urls: [ELECTION_URL] });
  await applyOne(db, cid);
  const pid = (await one<{ id: string }>(db, `SELECT id FROM policy_jp.politicians`)).id;
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), [`auto:profile_gap:${pid}`]);
  const payload = { politician_id: pid, birth_year: 1980, resolved_claim: "new" };
  const m = (await one<{ r: { existing: Row[] } }>(db, `SELECT policy_jp.same_claim_matches('politician', $1::JSONB) AS r`, [JSON.stringify(payload)])).r;
  assertEquals(m.existing, [], "生年が空＝既存の事実なし");
  const out = await applyOne(db, await submit(db, "politician", payload, { status: "verified", urls: ["https://www.pref.aichi.lg.jp/p/"], task: `auto:profile_gap:${pid}` }));
  assertEquals(out.status, "applied");
  await seed(db);
  assertEquals(await dispatchIds(db, ["profile_gap"]), []);
  await db.close();
});
