/**
 * 同一件事，第二步（#521；工作單 Yooliang/policy-ops#24）：migration 20261009280100_policy_jp_same_claim_supersede.sql。
 *
 * PGlite 套日本站整條 migration＋280000，先放好「#531 上線前」的資料，再套 280100（照正式庫的順序）。
 *   a. 兩筆都在等票：後交的票搬到先交的（網段投過或就是先交那筆交件者的不搬），後交的交件者記成同意票，後交的改 superseded＋edit_history
 *   b. 一筆已落庫、後交的在等票：後交的改 superseded
 *   c. 兩筆都已落庫：不動
 *   d. 不收編的：宣告 differs:、同一屆但投票日不同（內容不同）、別的團體
 *   e. 上線後自動收編：之後一筆轉 applied，同一件事內容相同的等票提交改 superseded（觸發器）；統計與團體同樣
 *   f. 冪等：整支重跑不再搬、不再記
 *   g. 還原驗證：拿掉觸發器 → e 紅；拿掉一次性的合併 → a 紅
 *   h. 文字守門：不碰 public／ditrust、不寫正式資料表、函式釘 search_path、不給 anon
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const CHAIN = [
  "20261008195000_policy_jp_schema.sql", "20261009000000_policy_jp_tables.sql", "20261009130000_policy_jp_dispatch.sql",
  "20261009130100_policy_jp_election_discovery.sql", "20261009130200_policy_jp_term_expirations_r08.sql", "20261009150100_policy_jp_rebalance_anchor.sql",
  "20261009200000_policy_jp_public_stats.sql", "20261009210000_policy_jp_apply.sql", "20261009210100_policy_jp_gap_arms.sql",
  "20261009250000_policy_jp_lg_registry.sql", "20261009250100_policy_jp_lg_registry_data.sql", "20261009250200_policy_jp_stat_registry.sql",
  "20261009250300_policy_jp_stat_registry_data.sql", "20261009250400_policy_jp_election_chain.sql", "20261009265000_policy_jp_lg_seed.sql",
  "20261009280000_policy_jp_same_claim.sql",
];
const CHAIN_SQL = await Promise.all(CHAIN.map(read));
const MIG_SQL = await read("20261009280100_policy_jp_same_claim_supersede.sql");
const ROLES = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;

async function baseDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  for (const sql of CHAIN_SQL) await db.exec(sql);
  return db;
}
const one = async <T>(d: PGlite, sql: string, params: unknown[] = []) => (await d.query<T>(sql, params)).rows[0];
const all = async <T>(d: PGlite, sql: string, params: unknown[] = []) => (await d.query<T>(sql, params)).rows;

// 兩個任期満了調查裡有「首長」的團體（各自一列任期），選舉放在満了前 10 天
const probe = await baseDb();
const HEADS = await all<{ lg_code: string; term_end: string; election_type: string }>(probe,
  `SELECT te.lg_code, te.term_end::TEXT, te.election_type FROM policy_jp.term_expirations te
     JOIN policy_jp.local_governments g ON g.lg_code = te.lg_code
    WHERE te.office_kind = 'head' AND te.election_type = 'town_mayor'
      AND NOT EXISTS (SELECT 1 FROM policy_jp.term_expirations t2 WHERE t2.lg_code = te.lg_code AND t2.office_kind = 'head' AND t2.term_end <> te.term_end)
    ORDER BY te.lg_code LIMIT 6`);
await probe.close();
assertEquals(HEADS.length, 6, "測試用的團體找不到");
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const el = (h: (typeof HEADS)[number], o: Record<string, unknown> = {}) =>
  ({ lg_code: h.lg_code, election_type: h.election_type, election_reason: "regular", election_date: addDays(h.term_end, -10), resolved_claim: "new", ...o });

let seq = 0;
async function contribution(d: PGlite, type: string, payload: Record<string, unknown>, o: { status?: string; ip: string; at: string; agent?: string }): Promise<string> {
  seq++;
  return (await one<{ id: string }>(d,
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash, status, created_at)
     VALUES ($1, $2, ARRAY['https://www.town.example.lg.jp/a'], $3, $4, $5, $6, $7) RETURNING id`,
    [type, JSON.stringify(payload), o.agent ?? `agent-${o.ip}`, o.ip, `h${seq}`, o.status ?? "pending", o.at])).id;
}
async function vote(d: PGlite, cid: string, ip: string) {
  await d.query(`INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, agent_name, verifier_ip_hash) VALUES ($1, 'agree', $2, $2)`, [cid, ip]);
}
const status = async (d: PGlite, id: string) => (await one<{ status: string }>(d, `SELECT status FROM policy_jp.contributions WHERE id = $1`, [id])).status;
const voters = async (d: PGlite, id: string) =>
  (await all<{ ip: string }>(d, `SELECT verifier_ip_hash AS ip FROM policy_jp.contribution_votes WHERE contribution_id = $1 ORDER BY 1`, [id])).map((r) => r.ip);
const history = async (d: PGlite, id: string) =>
  await all<{ field: string; new_value: unknown; contribution_id: string; agent_name: string }>(d,
    `SELECT field, new_value, contribution_id, agent_name FROM policy_jp.edit_history WHERE table_name = 'contributions' AND record_id = $1`, [id]);

type Fixture = Record<string, string>;
/** 「#531 上線前」的正式庫：a～d 各一組 */
async function seedBefore(d: PGlite): Promise<Fixture> {
  const [h1, h2, h3, h4, h5, h6] = HEADS;
  const f: Fixture = {};
  // a. 兩筆都等票
  f.aFirst = await contribution(d, "election", el(h1), { ip: "ip-a", at: "2026-10-09T03:00:00Z" });
  f.aLater = await contribution(d, "election", el(h1), { ip: "ip-b", at: "2026-10-09T04:00:00Z" });
  await vote(d, f.aFirst, "ip-v1");
  await vote(d, f.aLater, "ip-v1"); // 已投過先交的：不搬
  await vote(d, f.aLater, "ip-v3"); // 搬
  await vote(d, f.aLater, "ip-a"); // 就是先交那筆的交件者：不搬
  // b. 一筆已落庫、後交的等票
  f.bApplied = await contribution(d, "election", el(h2), { ip: "ip-a", at: "2026-10-09T03:00:00Z", status: "applied" });
  f.bLater = await contribution(d, "election", el(h2), { ip: "ip-b", at: "2026-10-09T04:00:00Z" });
  // c. 兩筆都已落庫
  f.c1 = await contribution(d, "election", el(h3), { ip: "ip-a", at: "2026-10-09T03:00:00Z", status: "applied" });
  f.c2 = await contribution(d, "election", el(h3), { ip: "ip-b", at: "2026-10-09T04:00:00Z", status: "applied" });
  // d. 不收編的：differs、同一屆但投票日不同、別的團體
  f.dFirst = await contribution(d, "election", el(h4), { ip: "ip-a", at: "2026-10-09T03:00:00Z" });
  f.dDiffers = await contribution(d, "election", el(h4, { resolved_claim: `differs:${f.dFirst}` }), { ip: "ip-b", at: "2026-10-09T04:00:00Z" });
  f.dOtherDate = await contribution(d, "election", el(h4, { election_date: addDays(h4.term_end, -3) }), { ip: "ip-c", at: "2026-10-09T05:00:00Z" });
  f.dOtherLg = await contribution(d, "election", el(h5), { ip: "ip-b", at: "2026-10-09T04:00:00Z" });
  f.h6 = h6.lg_code;
  return f;
}

const applied = await baseDb();
const F = await seedBefore(applied);
await applied.exec(MIG_SQL);

Deno.test("a. 兩筆都在等票：後交的票與交件者那一票併進先交的，後交的 superseded＋edit_history", async () => {
  assertEquals(await status(applied, F.aLater), "superseded");
  assertEquals(await voters(applied, F.aFirst), ["ip-b", "ip-v1", "ip-v3"], "v3 搬過來、交件者 ip-b 記成同意票；v1 重複、ip-a 是自己，不搬");
  assertEquals(await voters(applied, F.aLater), ["ip-a", "ip-v1"], "沒搬的留在原處（歷史可查）");
  const h = await history(applied, F.aLater);
  assertEquals(h.map((x) => [x.field, x.new_value, x.contribution_id, x.agent_name]), [["status", "superseded", F.aFirst, "same-claim"]]);
  const merged = await one<{ note: string; via: string }>(applied, `SELECT note, via FROM policy_jp.contribution_votes WHERE contribution_id = $1 AND verifier_ip_hash = 'ip-b'`, [F.aFirst]);
  assertEquals(merged.via, "merge");
  assert(merged.note.includes(F.aLater), "票裡看得出是從哪一筆來的");
  assert(["pending", "verified"].includes(await status(applied, F.aFirst)), "先交的照常走共識");
});

Deno.test("b. 一筆已落庫、後交的在等票：後交的 superseded", async () => {
  assertEquals(await status(applied, F.bLater), "superseded");
  assertEquals((await history(applied, F.bLater)).map((x) => x.contribution_id), [F.bApplied]);
});

Deno.test("c. 兩筆都已落庫：不動", async () => {
  assertEquals([await status(applied, F.c1), await status(applied, F.c2)], ["applied", "applied"]);
  assertEquals((await history(applied, F.c2)).length, 0);
});

Deno.test("d. differs、投票日不同、別的團體：都不收編", async () => {
  for (const k of ["dFirst", "dDiffers", "dOtherDate", "dOtherLg"]) assertEquals(await status(applied, F[k]), "pending", k);
});

async function autoSupersedeCase(d: PGlite): Promise<{ election: string; stat: string; lg: string; differs: string }> {
  const h = HEADS.find((x) => x.lg_code === F.h6)!;
  const p = await contribution(d, "election", el(h), { ip: "ip-p", at: "2026-10-09T12:00:00Z" });
  const q = await contribution(d, "election", el(h), { ip: "ip-q", at: "2026-10-09T12:05:00Z" });
  const qd = await contribution(d, "election", el(h, { resolved_claim: `differs:${p}` }), { ip: "ip-r", at: "2026-10-09T12:06:00Z" });
  const st = { lg_code: h.lg_code, stat_key: "population", year: 2025, value: 1234, unit: "人", resolved_claim: "new" };
  const s1 = await contribution(d, "regional_stat", st, { ip: "ip-p", at: "2026-10-09T12:00:00Z" });
  const s2 = await contribution(d, "regional_stat", st, { ip: "ip-q", at: "2026-10-09T12:05:00Z" });
  const lg = { lg_code: h.lg_code, kind: "town", pref_code: "x", name: "某町", kana: "なにがしちょう", resolved_claim: "new" };
  const g1 = await contribution(d, "local_government", lg, { ip: "ip-p", at: "2026-10-09T12:00:00Z" });
  const g2 = await contribution(d, "local_government", lg, { ip: "ip-q", at: "2026-10-09T12:05:00Z" });
  await d.query(`UPDATE policy_jp.contributions SET status = 'applied', applied_at = now() WHERE id IN ($1, $2, $3)`, [p, s1, g1]);
  return { election: await status(d, q), stat: await status(d, s2), lg: await status(d, g2), differs: await status(d, qd) };
}

Deno.test("e. 上線後自動收編：同一件事內容相同的等票提交 superseded（選舉、統計、團體）；differs 不收", async () => {
  assertEquals(await autoSupersedeCase(applied), { election: "superseded", stat: "superseded", lg: "superseded", differs: "pending" });
});

Deno.test("f. 冪等：整支重跑，不再搬票、不再記履歷", async () => {
  const before = await one<{ v: number; h: number }>(applied,
    `SELECT (SELECT count(*) FROM policy_jp.contribution_votes)::INT AS v, (SELECT count(*) FROM policy_jp.edit_history)::INT AS h`);
  await applied.exec(MIG_SQL);
  const after = await one<{ v: number; h: number }>(applied,
    `SELECT (SELECT count(*) FROM policy_jp.contribution_votes)::INT AS v, (SELECT count(*) FROM policy_jp.edit_history)::INT AS h`);
  assertEquals(after, before);
});

Deno.test("g. 還原驗證：拿掉觸發器 → 不會自動收編；拿掉一次性合併 → 兩筆都等票的不會併", async () => {
  const TRIGGER = /CREATE TRIGGER contributions_same_claim_supersede[\s\S]*?EXECUTE FUNCTION policy_jp\.same_claim_supersede_trg\(\);/;
  assert(TRIGGER.test(MIG_SQL));
  const noTrigger = await baseDb();
  await seedBefore(noTrigger);
  await noTrigger.exec(MIG_SQL.replace(TRIGGER, ""));
  assertEquals((await autoSupersedeCase(noTrigger)).election, "pending");
  await noTrigger.close();

  const MERGE = "v_merged := policy_jp.same_claim_merge_pending();";
  assertEquals(MIG_SQL.split(MERGE).length - 1, 1);
  const noMerge = await baseDb();
  const f = await seedBefore(noMerge);
  await noMerge.exec(MIG_SQL.replace(MERGE, "v_merged := 0;"));
  assert(await status(noMerge, f.aLater) !== "superseded", "沒合併就不會收編");
  await noMerge.close();
});

Deno.test("h. 文字守門：不碰 public／ditrust、不寫正式資料表、釘 search_path、不給 anon", async () => {
  const body = MIG_SQL.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\.|ditrust/i.test(body));
  assert(!/(INSERT INTO|UPDATE|DELETE FROM)\s+policy_jp\.(elections|local_governments|regional_stats|sources|source_refs)\b/i.test(body), "不寫正式資料表");
  for (const fn of ["same_claim_same_content", "same_claim_supersede", "same_claim_supersede_trg", "same_claim_merge_pending"]) {
    assert(new RegExp(`FUNCTION policy_jp\\.${fn}\\([\\s\\S]*?SET search_path = policy_jp, pg_temp`).test(body), `${fn} 要釘 search_path`);
    const p = await one<{ a: boolean }>(applied, `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS a FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'policy_jp' AND p.proname = $1`, [fn]);
    assertEquals(p.a, false, fn);
  }
});
