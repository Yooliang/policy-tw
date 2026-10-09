/**
 * 同一件事（#521）SQL 那一半：policy_jp.same_claim_matches（migration 20261009280000_policy_jp_same_claim.sql）。
 *
 * 只要 --allow-read。PGlite 上套日本站整條 migration 再加這一支（照 policy-jp-election-chain.test.ts 的做法）。
 *   a. 選舉：同團體＋職位＋事由＋同一屆才算同一件事——投票日抄錯幾天照樣對上（10-09 那 4 對的情形）、任期窗外的下一屆不算、
 *      首長與議會分開、事由不同不算（出直し vs 任期満了）、非 regular 要同一天、查不到任期満了列時退回 ±180 天、國政沒有團體碼
 *   b. 審議中：pending／disputed／verified／apply_failed 算，applied／rejected／superseded 不算；p_exclude 排掉自己；
 *      your_network_voted＝這個網段交的或投過的
 *   c. 探查（jp-next 任務還沒有 payload）：election 只給團體＋職位＋任期満了日、統計與團體只給團體碼
 *   d. 統計與團體的精確鍵；沒登記的型別＝NULL；拿不到鍵＝空清單（不猜）
 *   e. 權限：anon／authenticated 不能呼叫，service_role 可以；函式唯讀（不寫任何表）
 *   f. 行為的還原驗證：把任期窗改成只比投票日，「抄錯幾天」那一題就會紅
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const CHAIN = [
  "20261008195000_policy_jp_schema.sql", "20261009000000_policy_jp_tables.sql", "20261009130000_policy_jp_dispatch.sql",
  "20261009130100_policy_jp_election_discovery.sql", "20261009130200_policy_jp_term_expirations_r08.sql", "20261009150100_policy_jp_rebalance_anchor.sql",
  "20261009200000_policy_jp_public_stats.sql", "20261009210000_policy_jp_apply.sql", "20261009210100_policy_jp_gap_arms.sql",
  "20261009250000_policy_jp_lg_registry.sql", "20261009250100_policy_jp_lg_registry_data.sql", "20261009250200_policy_jp_stat_registry.sql",
  "20261009250300_policy_jp_stat_registry_data.sql", "20261009250400_policy_jp_election_chain.sql", "20261009265000_policy_jp_lg_seed.sql",
];
const CHAIN_SQL = await Promise.all(CHAIN.map(read));
const MIG_FILE = "20261009280000_policy_jp_same_claim.sql";
const MIG_SQL = await read(MIG_FILE);
const ROLES = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;

async function freshDb(mig = MIG_SQL): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  for (const sql of CHAIN_SQL) await db.exec(sql);
  await db.exec(mig);
  return db;
}
const db = await freshDb();
const one = async <T>(d: PGlite, sql: string, params: unknown[] = []) => (await d.query<T>(sql, params)).rows[0];

// 任期満了調查裡真的有的團體：一個有「首長」任期列、另一個找一個沒有「議會」任期列的團體（退回 ±180 天那一條）
const HEAD = await one<{ lg_code: string; term_end: string; election_type: string }>(db,
  `SELECT te.lg_code, te.term_end::TEXT, te.election_type FROM policy_jp.term_expirations te
     JOIN policy_jp.local_governments g ON g.lg_code = te.lg_code
    WHERE te.office_kind = 'head' AND te.election_type = 'town_mayor'
      AND NOT EXISTS (SELECT 1 FROM policy_jp.term_expirations t2 WHERE t2.lg_code = te.lg_code AND t2.office_kind = 'head' AND t2.term_end <> te.term_end)
    ORDER BY te.lg_code LIMIT 1`);
const NOTE_ASM = await one<{ lg_code: string }>(db,
  `SELECT g.lg_code FROM policy_jp.local_governments g
    WHERE g.kind IN ('city', 'town', 'village', 'admin_ward') AND NOT EXISTS (SELECT 1 FROM policy_jp.term_expirations te WHERE te.lg_code = g.lg_code AND te.office_kind = 'assembly')
    ORDER BY g.lg_code LIMIT 1`);
assert(HEAD && NOTE_ASM, "測試用的團體找不到（任期満了調查或團體表的資料變了）");
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const TERM = HEAD.term_end;

let seq = 0;
async function contribution(d: PGlite, type: string, payload: Record<string, unknown>, o: { status?: string; ip?: string } = {}): Promise<string> {
  seq++;
  return (await one<{ id: string }>(d,
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash, status)
     VALUES ($1, $2, ARRAY['https://www.town.example.lg.jp/a'], 'tester', $3, $4, $5) RETURNING id`,
    [type, JSON.stringify(payload), o.ip ?? "ip-other", `h${seq}`, o.status ?? "pending"])).id;
}
async function election(d: PGlite, lg: string | null, type: string, date: string, reason = "regular"): Promise<string> {
  const id = `${date}_${type}_${lg ?? "national"}`;
  await d.query(`INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code, review_status)
                 VALUES ($1, $1, $2, $3, $4, policy_jp.election_level($3), $5, 'published')`, [id, date, type, reason, lg]);
  return id;
}
type Matches = { type: string; existing: Array<Record<string, unknown>>; pending: Array<Record<string, unknown>> };
async function matches(d: PGlite, type: string, payload: Record<string, unknown>, ip: string | null = null, exclude: string | null = null): Promise<Matches | null> {
  return (await one<{ m: Matches | null }>(d, `SELECT policy_jp.same_claim_matches($1, $2::JSONB, $3, $4::UUID) AS m`, [type, JSON.stringify(payload), ip, exclude])).m;
}
const ids = (m: Matches | null) => ({ existing: (m?.existing ?? []).map((x) => x.id), pending: (m?.pending ?? []).map((x) => x.contribution_id) });
const el = (date: string, o: Record<string, unknown> = {}) => ({ lg_code: HEAD.lg_code, election_type: HEAD.election_type, election_reason: "regular", election_date: date, ...o });

// 在庫：這一屆的町長選舉（任期満了日前 10 天）
const E_THIS = await election(db, HEAD.lg_code, HEAD.election_type, addDays(TERM, -10));

Deno.test("a. 投票日抄錯幾天照樣是同一件事（同一屆）；任期窗外的下一屆不算", async () => {
  assertEquals(ids(await matches(db, "election", el(addDays(TERM, -3)))).existing, [E_THIS], "抄錯一週");
  assertEquals(ids(await matches(db, "election", el(addDays(TERM, -170)))).existing, [E_THIS], "窗口前緣 −180 內");
  assertEquals(ids(await matches(db, "election", el(addDays(TERM, 55)))).existing, [E_THIS], "窗口後緣 +60 內");
  assertEquals(ids(await matches(db, "election", el(addDays(TERM, 4 * 365)))).existing, [], "四年後的下一屆");
  const m = await matches(db, "election", el(addDays(TERM, -3)));
  assertEquals(m?.existing[0].why, "同団体・同職位・同事由・同任期");
});

Deno.test("a. 首長與議會分開、事由不同不算、非 regular 要同一天", async () => {
  assertEquals(ids(await matches(db, "election", el(addDays(TERM, -10), { election_type: "muni_assembly" }))).existing, [], "議會不是首長");
  assertEquals(ids(await matches(db, "election", el(addDays(TERM, -10), { election_reason: "resignation" }))).existing, [], "出直し不是任期満了");
  const d = await freshDb();
  const r = await election(d, HEAD.lg_code, HEAD.election_type, addDays(TERM, -400), "resignation");
  assertEquals(ids(await matches(d, "election", el(addDays(TERM, -400), { election_reason: "resignation" }))).existing, [r]);
  assertEquals(ids(await matches(d, "election", el(addDays(TERM, -399), { election_reason: "resignation" }))).existing, [], "非 regular 差一天就是另一場");
  await d.close();
});

Deno.test("a. 查不到任期満了列：退回投票日差 ≤ 180 天；國政沒有團體碼", async () => {
  const d = await freshDb();
  const base = "2027-04-25";
  const a = await election(d, NOTE_ASM.lg_code, "muni_assembly", base);
  const q = (date: string) => matches(d, "election", { lg_code: NOTE_ASM.lg_code, election_type: "muni_assembly", election_reason: "regular", election_date: date });
  assertEquals(ids(await q(addDays(base, 180))).existing, [a]);
  assertEquals(ids(await q(addDays(base, 181))).existing, []);
  const n = await election(d, null, "national_upper", "2028-07-09");
  assertEquals(ids(await matches(d, "election", { election_type: "national_upper", election_reason: "regular", election_date: "2028-07-02" })).existing, [n]);
  assertEquals(ids(await matches(d, "election", { election_type: "national_lower", election_reason: "regular", election_date: "2028-07-02" })).existing, [], "衆院不是參院");
  await d.close();
});

Deno.test("b. 審議中：哪些狀態算、p_exclude、your_network_voted", async () => {
  const d = await freshDb();
  const date = addDays(TERM, -12);
  const live: Record<string, string> = {};
  for (const s of ["pending", "disputed", "verified", "apply_failed", "applied", "rejected", "superseded"]) live[s] = await contribution(d, "election", el(date), { status: s });
  const m = await matches(d, "election", el(addDays(TERM, -10)), "ip-me");
  assertEquals(ids(m).pending.sort(), [live.pending, live.disputed, live.verified, live.apply_failed].sort());
  assertEquals(ids(await matches(d, "election", el(date), null, live.pending)).pending.includes(live.pending), false, "排掉自己");
  assertEquals(m!.pending.every((p) => p.your_network_voted === false && p.yours === false), true);
  const mine = await contribution(d, "election", el(date), { ip: "ip-me" });
  await d.query(`INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, agent_name, verifier_ip_hash) VALUES ($1, 'agree', 'voter', 'ip-me')`, [live.pending]);
  const m2 = await matches(d, "election", el(date), "ip-me");
  const by = (id: string) => m2!.pending.find((p) => p.contribution_id === id)!;
  assertEquals([by(mine).yours, by(mine).your_network_voted], [true, true], "自己交的");
  assertEquals([by(live.pending).yours, by(live.pending).your_network_voted], [false, true], "投過的");
  assertEquals(by(live.disputed).your_network_voted, false);
  assertEquals((await matches(d, "election", el(date), null))!.pending.every((p) => p.your_network_voted === false), true, "沒給網段＝一律 false");
  await d.close();
});

Deno.test("c. 探查：選舉只給團體＋職位＋任期満了日；統計與團體只給團體碼", async () => {
  const d = await freshDb();
  const e = await election(d, HEAD.lg_code, HEAD.election_type, addDays(TERM, -10));
  const c = await contribution(d, "election", el(addDays(TERM, -20)));
  const probe = await matches(d, "election", { lg_code: HEAD.lg_code, office_kind: "head", term_end: TERM }, "ip-me");
  assertEquals(ids(probe), { existing: [e], pending: [c] });
  assertEquals(probe!.existing[0].why, "同団体・同職位・この任期");
  assertEquals(ids(await matches(d, "election", { lg_code: HEAD.lg_code, office_kind: "assembly", term_end: TERM })).existing, []);
  assertEquals(ids(await matches(d, "election", { lg_code: HEAD.lg_code, office_kind: "head", term_end: addDays(TERM, 4 * 365) })).existing, []);
  await d.close();
});

Deno.test("d. 統計與團體的精確鍵", async () => {
  const d = await freshDb();
  const src = (await one<{ id: number }>(d, `INSERT INTO policy_jp.sources (url, origin, source_kind) VALUES ('https://www.e-stat.go.jp/x', 'test', 'statistics') RETURNING id`)).id;
  const s = (await one<{ id: number }>(d, `INSERT INTO policy_jp.regional_stats (lg_code, stat_key, year, value, unit, source_id, review_status)
     VALUES ($1, 'population', 2025, 1234, policy_jp.regional_stat_unit('population'), $2, 'published') RETURNING id`, [HEAD.lg_code, src])).id;
  const st = (o: Record<string, unknown>) => matches(d, "regional_stat", { lg_code: HEAD.lg_code, stat_key: "population", year: 2025, ...o });
  assertEquals(ids(await st({})).existing, [String(s)]);
  assertEquals(ids(await st({ year: 2020 })).existing, [], "不同年");
  assertEquals(ids(await st({ stat_key: "area_km2" })).existing, [], "不同項目");
  const c = await contribution(d, "regional_stat", { lg_code: HEAD.lg_code, stat_key: "population", year: 2025, value: 1235, unit: "人" });
  assertEquals(ids(await st({})).pending, [c]);
  assertEquals(ids(await matches(d, "regional_stat", { lg_code: HEAD.lg_code })).existing, [String(s)], "探查：只給團體碼＝這個團體所有項目");
  // 團體：團體碼表已一次建入（265000），在庫一定有
  assertEquals(ids(await matches(d, "local_government", { lg_code: HEAD.lg_code })).existing, [HEAD.lg_code]);
  await d.close();
});

Deno.test("d. 沒登記的型別＝NULL；拿不到鍵＝空清單（不猜）", async () => {
  assertEquals(await matches(db, "no_change", { task_id: "x" }), null);
  assertEquals(await matches(db, "correction", {}), null);
  assertEquals(ids(await matches(db, "election", { lg_code: HEAD.lg_code, election_type: HEAD.election_type })), { existing: [], pending: [] }, "沒有投票日也沒有任期満了日");
  assertEquals(ids(await matches(db, "election", { lg_code: HEAD.lg_code, election_date: addDays(TERM, -10) })), { existing: [], pending: [] }, "沒有職位");
  assertEquals(ids(await matches(db, "regional_stat", {})), { existing: [], pending: [] });
  assertEquals(ids(await matches(db, "election", el("2026-02-30"))), { existing: [], pending: [] }, "日期不存在＝拿不到鍵");
});

Deno.test("e. 權限：anon／authenticated 不能呼叫，service_role 可以；函式不寫表", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assertRejects(() => db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE ${role}`);
      await tx.query(`SELECT policy_jp.same_claim_matches('election', '{}'::JSONB)`);
    }), Error, "permission denied", role);
  }
  const priv = await one<{ svc: boolean; anon: boolean }>(db,
    `SELECT has_function_privilege('service_role', 'policy_jp.same_claim_matches(text, jsonb, text, uuid)', 'EXECUTE') AS svc,
            has_function_privilege('anon', 'policy_jp.same_claim_matches(text, jsonb, text, uuid)', 'EXECUTE') AS anon`);
  assertEquals(priv, { svc: true, anon: false });
  const body = MIG_SQL.replace(/--[^\n]*/g, "");
  assert(!/\b(INSERT|UPDATE|DELETE)\b/i.test(body), "這支只讀");
  assert(!/\bpublic\.|ditrust/i.test(body), "不碰 public／ditrust");
  for (const fn of ["same_claim_office", "same_claim_same_term", "same_claim_matches"]) {
    assert(new RegExp(`FUNCTION policy_jp\\.${fn}\\([\\s\\S]*?SET search_path = policy_jp, pg_temp`).test(body), `${fn} 要釘 search_path`);
  }
});

Deno.test("f. 還原驗證：任期窗拿掉、只比投票日，「抄錯幾天」就對不上", async () => {
  const from = "    RETURN p_other = p_ref;\n  END IF;\n";
  assertEquals(MIG_SQL.split(from).length - 1, 1, "替換點要剛好出現一次");
  const broken = MIG_SQL.replace(from, "    RETURN p_other = p_ref;\n  END IF;\n  RETURN p_other = p_ref;\n");
  const d = await freshDb(broken);
  const e = await election(d, HEAD.lg_code, HEAD.election_type, addDays(TERM, -10));
  assertEquals(ids(await matches(d, "election", el(addDays(TERM, -3)))).existing, [], "壞掉的版本對不上");
  assertEquals(ids(await matches(d, "election", el(addDays(TERM, -10)))).existing, [e]);
  await d.close();
});

// ---- 主線審查（#531）退回的兩點：任期窗要對稱、事由空值＝regular（探查也一樣）；各附還原驗證 ----
const SYM_FROM = "AND (p_ref BETWEEN te.term_end - 180 AND te.term_end + 60 OR p_other BETWEEN te.term_end - 180 AND te.term_end + 60)";
const SYM_OLD = "AND p_ref BETWEEN te.term_end - 180 AND te.term_end + 60";
const REASON_FROM = "v_reason := COALESCE(NULLIF(p->>'election_reason', ''), 'regular');";
const REASON_OLD = "v_reason := COALESCE(NULLIF(p->>'election_reason', ''), CASE WHEN p ? 'election_type' THEN 'regular' END);";

async function symmetryCase(d: PGlite): Promise<{ inThenOut: unknown[]; outThenIn: unknown[] }> {
  // 一方在任期窗內（満了前 10 天）、另一方在窗外（満了後 100 天，差 110 天 ≤ 180）：不是同一屆，兩個方向都不該對上
  const inside = addDays(TERM, -10), outside = addDays(TERM, 100);
  const e = await election(d, HEAD.lg_code, HEAD.election_type, inside);
  const inThenOut = ids(await matches(d, "election", el(outside))).existing;
  await d.query(`DELETE FROM policy_jp.elections WHERE id = $1`, [e]);
  await election(d, HEAD.lg_code, HEAD.election_type, outside);
  const outThenIn = ids(await matches(d, "election", el(inside))).existing;
  return { inThenOut, outThenIn };
}

Deno.test("g. 任期窗對稱：任一方在窗內就要兩方同窗（窗外 +100 天不會被當成同一屆）；還原驗證", async () => {
  assertEquals(MIG_SQL.split(SYM_FROM).length - 1, 1, "替換點要剛好出現一次");
  const d = await freshDb();
  assertEquals(await symmetryCase(d), { inThenOut: [], outThenIn: [] });
  await d.close();
  const old = await freshDb(MIG_SQL.replace(SYM_FROM, SYM_OLD));
  const r = await symmetryCase(old);
  assert(r.inThenOut.length + r.outThenIn.length > 0, `舊寫法會把窗外判成同一屆：${JSON.stringify(r)}`);
  await old.close();
});

async function probeCase(d: PGlite): Promise<unknown[]> {
  // 任期窗內有一場出直し選舉；任務探查（沒有事由）不該列出它——交件端事由空值＝regular，列出來代理照抄 id 只會 claim_mismatch
  await election(d, HEAD.lg_code, HEAD.election_type, addDays(TERM, -40), "resignation");
  return ids(await matches(d, "election", { lg_code: HEAD.lg_code, office_kind: "head", term_end: TERM })).existing;
}

Deno.test("h. 事由空值＝regular，探查也一樣（不列出出直し選舉）；還原驗證", async () => {
  assertEquals(MIG_SQL.split(REASON_FROM).length - 1, 1, "替換點要剛好出現一次");
  const d = await freshDb();
  assertEquals(await probeCase(d), []);
  const reg = await election(d, HEAD.lg_code, HEAD.election_type, addDays(TERM, -10));
  assertEquals(ids(await matches(d, "election", { lg_code: HEAD.lg_code, office_kind: "head", term_end: TERM })).existing, [reg]);
  assertEquals(ids(await matches(d, "election", el(addDays(TERM, -10), { election_reason: "" }))).existing, [reg], "payload 事由空字串也當 regular");
  await d.close();
  const old = await freshDb(MIG_SQL.replace(REASON_FROM, REASON_OLD));
  assertEquals((await probeCase(old)).length, 1, "舊寫法探查會列出出直し選舉");
  await old.close();
});
