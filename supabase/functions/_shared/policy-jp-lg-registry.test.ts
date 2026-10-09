/**
 * 日本站自治體的機器核對（migration 20261009210200_policy_jp_lg_registry.sql＋210300 資料；照正見 cec-verify）。
 *
 * 只要 --allow-read。PGlite 上套日本站整條 migration（schema → tables → 130000 → 130100 → 130200 → 150100 → 200000 → 210000 → 210100）再加這兩支。
 *   a. 參考表的資料：1,965 列、檢查碼、縣碼、讀音全是ひらがな、種類分布、任期満了調查的團體都查得到；
 *      每一列照抄成交件，日本站的收件驗證（contribution-schema.ts）全收——機器核對得過的交件不會先在收件被擋
 *   b. 讀音轉換（kana.ts）：半角カナ→ひらがな，跟資料裡的 kana_raw→kana 一致
 *   c. 判斷：一致→apply、任一欄不同→reject（理由帶總務省的值）、不在表裡／只差市・中核市→skip
 *   d. 掃描：pending 的 local_government 一致的直接落庫（reviewed_by=soumu-auto）、都道府県還沒進來的維持 verified 等落庫掃地機、
 *      退件寫理由、skip 的不動、別的型別不碰；整條：都道府県與市一起交 → 兩輪排程後都在 local_governments、網址 slug 照規則；
 *      回歸：碼表查不到的團體碼（檢查碼正確但碼表沒有）的 pending 堆過 p_limit，後面一致的仍被排程處理（拿掉 EXISTS 濾網的還原驗證會失敗）
 *   e. 權限、排程、自我檢查（還原驗證）
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { hiraganaOf } from "./jp/kana.ts";
import { lgCodeValid, lgPrefCode } from "./jp/lg-code.ts";
import { validateContributionRequest } from "./jp/contribution-schema.ts";
import { JP_MACHINE_REVIEWERS, JP_MACHINE_VERIFIABLE_TYPES } from "./jp/machine-verify.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const CHAIN = [
  "20261008195000_policy_jp_schema.sql", "20261009000000_policy_jp_tables.sql", "20261009130000_policy_jp_dispatch.sql",
  "20261009130100_policy_jp_election_discovery.sql", "20261009130200_policy_jp_term_expirations_r08.sql", "20261009150100_policy_jp_rebalance_anchor.sql",
  "20261009200000_policy_jp_public_stats.sql", "20261009210000_policy_jp_apply.sql", "20261009210100_policy_jp_gap_arms.sql",
];
const CHAIN_SQL = await Promise.all(CHAIN.map(read));
const REG_FILE = "20261009210200_policy_jp_lg_registry.sql";
const DATA_FILE = "20261009210300_policy_jp_lg_registry_data.sql";
const REG_SQL = await read(REG_FILE);
const DATA_SQL = await read(DATA_FILE);
const TERM_SQL = CHAIN_SQL[4];

const ROLES = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;
/** pg_cron 的最小替身（cron.job 表＋schedule／unschedule） */
const FAKE_CRON = `CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobid SERIAL PRIMARY KEY, jobname TEXT UNIQUE, schedule TEXT, command TEXT);
  CREATE FUNCTION cron.schedule(n TEXT, s TEXT, c TEXT) RETURNS BIGINT LANGUAGE sql AS $$ INSERT INTO cron.job (jobname, schedule, command) VALUES (n, s, c) ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid $$;
  CREATE FUNCTION cron.unschedule(n TEXT) RETURNS BOOLEAN LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = n RETURNING true $$;`;

async function freshDb(o: { cron?: boolean; reg?: string; data?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  if (o.cron) await db.exec(FAKE_CRON);
  for (const sql of CHAIN_SQL) await db.exec(sql);
  await db.exec(o.reg ?? REG_SQL);
  if (o.data !== false) await db.exec(DATA_SQL);
  return db;
}
// 只套一次就好的唯讀檢查共用一個庫
const shared = await freshDb();

const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rows = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}
function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 70)}`);
  return sql.replace(from, () => to);
}

type Reg = { lg_code: string; pref_code: string; pref_name: string; name: string; kana: string; kana_raw: string; kind: string };
const REG: Reg[] = await rows<Reg>(shared, `SELECT lg_code, pref_code, pref_name, name, kana, kana_raw, kind FROM policy_jp.lg_code_registry ORDER BY lg_code`);
const reg = (code: string) => REG.find((r) => r.lg_code === code)!;
const payloadOf = (r: Reg) => ({ lg_code: r.lg_code, kind: r.kind, pref_code: r.pref_code, name: r.name, kana: r.kana });
const SOUMU = "https://www.soumu.go.jp/denshijiti/code.html";

let seq = 0;
async function submit(db: PGlite, type: string, payload: Record<string, unknown>): Promise<string> {
  const n = ++seq;
  return (await one<{ id: string }>(db,
    // created_at 照交件順序遞增（掃描照 created_at 排；同一毫秒內連交時不要靠 uuid 的隨機順序）
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash, created_at)
     VALUES ($1, $2::JSONB, $3, $4, $5, $6, TIMESTAMPTZ '2026-10-09 00:00:00+00' + make_interval(secs => $7)) RETURNING id`,
    [type, JSON.stringify(payload), [SOUMU], `author-${n}`, `author-ip-${n}`, `h-${n}`, n])).id;
}
type C = { status: string; reviewed_by: string | null; review_notes: string | null; verified_at: string | null };
const contribution = (db: PGlite, id: string) => one<C>(db, `SELECT status, reviewed_by, review_notes, verified_at FROM policy_jp.contributions WHERE id = $1`, [id]);
const runVerify = async (db: PGlite) =>
  (await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.lg_registry_verify_pending() AS r`)).r;
const decide = async (db: PGlite, p: Record<string, unknown>) =>
  (await one<{ d: { action: string; reason?: string; official?: Record<string, string> } }>(db, `SELECT policy_jp.lg_registry_decide($1::JSONB) AS d`, [JSON.stringify(p)])).d;

// =============================================================================================
// a. 參考表的資料
// =============================================================================================
Deno.test("參考表：1,965 列、檢查碼與縣碼都對、讀音全是ひらがな、種類分布、中核市 62、政令市 20、東京 23 区", () => {
  assertEquals(REG.length, 1965);
  for (const r of REG) {
    assert(lgCodeValid(r.lg_code), `${r.lg_code} 檢查碼`);
    assertEquals(r.pref_code, lgPrefCode(r.lg_code), `${r.lg_code} 縣碼`);
    assert(/^[ぁ-ゖー]+$/.test(r.kana), `${r.lg_code} ${r.name} 讀音 ${r.kana}`);
  }
  const tally: Record<string, number> = {};
  for (const r of REG) tally[r.kind] = (tally[r.kind] ?? 0) + 1;
  assertEquals(tally, { admin_ward: 171, city: 710, core_city: 62, designated_city: 20, prefecture: 47, special_ward: 23, town: 743, village: 189 });
  // 抽樣：結論本身對（不只是格式）
  assertEquals(payloadOf(reg("010006")), { lg_code: "010006", kind: "prefecture", pref_code: "010006", name: "北海道", kana: "ほっかいどう" });
  assertEquals(payloadOf(reg("011002")), { lg_code: "011002", kind: "designated_city", pref_code: "010006", name: "札幌市", kana: "さっぽろし" });
  assertEquals(payloadOf(reg("012025")), { lg_code: "012025", kind: "core_city", pref_code: "010006", name: "函館市", kana: "はこだてし" });
  assertEquals(payloadOf(reg("232033")), { lg_code: "232033", kind: "core_city", pref_code: "230006", name: "一宮市", kana: "いちのみやし" });
  assertEquals(payloadOf(reg("131130")), { lg_code: "131130", kind: "special_ward", pref_code: "130001", name: "渋谷区", kana: "しぶやく" });
  assertEquals(reg("011011").name, "札幌市中央区");
  assertEquals(reg("011011").kind, "admin_ward");
  assertEquals(reg("130001").kana, "とうきょうと");
});

Deno.test("參考表：讀音＝kana.ts 轉 kana_raw（半角カナ→ひらがな）；轉換本身：濁音・半濁音・促音・長音", () => {
  for (const r of REG) assertEquals(hiraganaOf(r.kana_raw), r.kana, `${r.lg_code} ${r.kana_raw}`);
  assertEquals(hiraganaOf("ｻｯﾎﾟﾛｼ"), "さっぽろし");
  assertEquals(hiraganaOf("ﾎｯｶｲﾄﾞｳ"), "ほっかいどう");
  assertEquals(hiraganaOf("ｳﾞｨ"), "ゔぃ");
  assertEquals(hiraganaOf(" ﾆｾｺﾁｮｳ "), "にせこちょう");
  assertEquals(hiraganaOf("ｰ"), "ー");
});

Deno.test("參考表：任期満了調查（term_expirations）的每個團體都查得到，名稱也一樣", () => {
  const re = /^\s+\('(\d{6})', '([^']+)', '([^']+)', '(head|assembly)'/;
  const terms = new Map<string, string>();
  for (const line of TERM_SQL.split("\n")) {
    const m = re.exec(line);
    if (m) terms.set(m[1], m[3]);
  }
  assert(terms.size > 1700, `任期満了調查 ${terms.size} 個團體`);
  const byCode = new Map(REG.map((r) => [r.lg_code, r]));
  const missing = [...terms.keys()].filter((c) => !byCode.has(c));
  assertEquals(missing, [], "任期満了調查裡的團體碼都要在團體碼表裡（不然 local_government_missing 開出的任務機器核對不了）");
  const renamed = [...terms].filter(([c, n]) => byCode.get(c)!.name !== n).map(([c, n]) => `${c} ${n}→${byCode.get(c)!.name}`);
  assertEquals(renamed, []);
});

Deno.test("參考表：每一列照抄成交件，日本站的收件驗證全收（機器核對得過的不會先在收件被擋）", () => {
  const rejected: string[] = [];
  for (const r of REG) {
    const v = validateContributionRequest({ agent_name: "tester", contribution_type: "local_government", payload: payloadOf(r), source_urls: [SOUMU] });
    if (!v.ok) rejected.push(`${r.lg_code} ${r.name}：${v.errors.map((e) => e.message).join(" / ")}`);
  }
  assertEquals(rejected, []);
});

// =============================================================================================
// c. 判斷
// =============================================================================================
Deno.test("判斷：一致→apply；名稱・讀音・種類・縣碼任一不同→reject（理由帶總務省的值）；不在表裡、只差市／中核市→skip", async () => {
  const db = shared;
  assertEquals((await decide(db, payloadOf(reg("230006")))).action, "apply");
  assertEquals((await decide(db, payloadOf(reg("232033")))).action, "apply");
  // 名稱
  const badName = await decide(db, { ...payloadOf(reg("232033")), name: "一ノ宮市" });
  assertEquals(badName.action, "reject");
  assert(badName.reason!.includes("一宮市") && badName.reason!.includes("一ノ宮市"), badName.reason);
  assertEquals(badName.official?.name, "一宮市");
  // 讀音（總務省的カナ也寫進理由）
  const badKana = await decide(db, { ...payloadOf(reg("232033")), kana: "いちみやし" });
  assertEquals(badKana.action, "reject");
  assert(badKana.reason!.includes("いちのみやし") && badKana.reason!.includes("ｲﾁﾉﾐﾔｼ"), badKana.reason);
  // 種類：政令市交成一般市、町交成村 → reject
  assertEquals((await decide(db, { ...payloadOf(reg("011002")), kind: "city" })).action, "reject");
  assertEquals((await decide(db, { ...payloadOf(reg("233021")), kind: "village" })).action, "reject");
  // 縣碼
  assertEquals((await decide(db, { ...payloadOf(reg("232033")), pref_code: "200000" })).action, "reject");
  // 兩欄都錯：理由兩條都寫
  const two = await decide(db, { ...payloadOf(reg("232033")), name: "x市", kana: "x" });
  assertEquals(two.reason!.split("；").length, 2);
  // 只差市／中核市：中核市一覧停在 R5.4.1，機器不判
  const coreAsCity = await decide(db, { ...payloadOf(reg("232033")), kind: "city" });
  assertEquals(coreAsCity.action, "skip");
  assert(coreAsCity.reason!.includes("2023-04-01"), coreAsCity.reason);
  assertEquals((await decide(db, { ...payloadOf(reg("012033")), kind: "core_city" })).action, "skip");
  // 只差市／中核市、但名稱也錯 → 還是 reject（錯的那欄要退）
  assertEquals((await decide(db, { ...payloadOf(reg("232033")), kind: "city", name: "一ノ宮市" })).action, "reject");
  // 不在表裡（檢查碼正確但沒有這個團體）
  const unknown = "999997";
  assert(lgCodeValid(unknown));
  assertEquals((await decide(db, { lg_code: unknown, kind: "city", pref_code: lgPrefCode(unknown), name: "某市", kana: "なにがしし" })).action, "skip");
  // 名稱前後空白不算錯（收件也是 trim 後比）
  assertEquals((await decide(db, { ...payloadOf(reg("232033")), name: " 一宮市 " })).action, "apply");
});

// =============================================================================================
// d. 掃描
// =============================================================================================
Deno.test("掃描：一致的直接落庫（reviewed_by=soumu-auto、留核對紀錄）；市比都道府県先到的 verified 等著，都道府県進來後落庫掃地機接手", async () => {
  const db = await freshDb();
  const ichi = await submit(db, "local_government", payloadOf(reg("232033")));
  const aichi = await submit(db, "local_government", payloadOf(reg("230006")));
  const out = await runVerify(db);
  // 掃描照交件順序：一宮市先（都道府県還不在 → waiting）、愛知県後（applied）
  assertEquals(out, { applied: 1, waiting: 1, rejected: 0, skipped: 0, other: 0 });
  const a = await contribution(db, aichi);
  assertEquals([a.status, a.reviewed_by], ["applied", "soumu-auto"]);
  assert(a.review_notes!.startsWith("[soumu-auto] 總務省團體碼表（2024-01-01 現在）自動核對通過") && a.review_notes!.includes("新增團體 愛知県"), a.review_notes!);
  const i = await contribution(db, ichi);
  assertEquals([i.status, i.reviewed_by], ["verified", "soumu-auto"]);
  assert(i.verified_at, "verified_at 要記");
  // 落庫掃地機（寬限 0 分）接手：一宮市進來
  await db.query(`SELECT policy_jp.apply_verified_pending(20, 0)`);
  assertEquals((await contribution(db, ichi)).status, "applied");
  assertEquals(await rows(db, `SELECT lg_code, kind, pref_code, name, kana, slug FROM policy_jp.local_governments ORDER BY lg_code`), [
    { lg_code: "230006", kind: "prefecture", pref_code: "230006", name: "愛知県", kana: "あいちけん", slug: "aichi" },
    { lg_code: "232033", kind: "core_city", pref_code: "230006", name: "一宮市", kana: "いちのみやし", slug: "232033" },
  ]);
  // 再掃一次：沒有 pending 了，什麼都不做
  assertEquals(await runVerify(db), { applied: 0, waiting: 0, rejected: 0, skipped: 0, other: 0 });
  await db.close();
});

Deno.test("掃描：不一致的退件（理由寫總務省的值）、判不了的不動、別的型別不碰；同一團體已經在庫裡的照落庫規則（一樣＝成功）", async () => {
  const db = await freshDb();
  const aichi = await submit(db, "local_government", payloadOf(reg("230006")));
  const wrong = await submit(db, "local_government", { ...payloadOf(reg("232033")), kana: "いちみやし" });
  const unsure = await submit(db, "local_government", { ...payloadOf(reg("232033")), kind: "city" });
  const election = await submit(db, "election", { lg_code: "232033", election_type: "mayor", election_reason: "regular", election_date: "2027-04-25" });
  assertEquals(await runVerify(db), { applied: 1, waiting: 0, rejected: 1, skipped: 1, other: 0 });
  assertEquals((await contribution(db, aichi)).status, "applied");
  const w = await contribution(db, wrong);
  assertEquals([w.status, w.reviewed_by], ["rejected", "soumu-auto"]);
  assert(w.review_notes!.includes("自動核對不通過") && w.review_notes!.includes("いちのみやし"), w.review_notes!);
  assertEquals((await contribution(db, unsure)).status, "pending", "只差市／中核市的留給同儕");
  assertEquals((await contribution(db, election)).status, "pending", "別的型別不碰");
  // 同一團體重交（庫裡已經有，一樣的）→ 成功（unchanged），不重複建
  const again = await submit(db, "local_government", payloadOf(reg("230006")));
  assertEquals((await runVerify(db)).applied, 1);
  assertEquals((await contribution(db, again)).status, "applied");
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.local_governments`)).n, 1);
  await db.close();
});

Deno.test("掃描：47 都道府県＋任期満了調查裡的市區町村一次全交 → 兩輪（核對＋落庫掃地機）後全部進 local_governments，自治體缺口收完", async () => {
  const db = await freshDb();
  const terms = new Set<string>();
  for (const line of TERM_SQL.split("\n")) {
    const m = /^\s+\('(\d{6})'/.exec(line);
    if (m) terms.add(m[1]);
  }
  const targets = REG.filter((r) => r.kind === "prefecture" || terms.has(r.lg_code));
  // 市先交、都道府県後交（最壞的順序）
  for (const r of [...targets].sort((a, b) => (a.kind === "prefecture" ? 1 : 0) - (b.kind === "prefecture" ? 1 : 0))) {
    await submit(db, "local_government", payloadOf(r));
  }
  // 市區町村全部排在都道府県前面：第一輪市區町村都在等（waiting），都道府県 47 個落庫
  assertEquals(await runVerify(db), { applied: 47, waiting: targets.length - 47, rejected: 0, skipped: 0, other: 0 });
  await db.query(`SELECT policy_jp.apply_verified_pending(100, 0)`);
  for (let i = 0; i < 30; i++) {
    const left = (await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.contributions WHERE status = 'verified'`)).n;
    if (left === 0) break;
    await db.query(`SELECT policy_jp.apply_verified_pending(100, 0)`);
  }
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.local_governments`)).n, targets.length);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.contributions WHERE status <> 'applied'`)).n, 0);
  // 都道府県的網址是羅馬字、市區町村是團體碼
  assertEquals((await one<{ slug: string }>(db, `SELECT slug FROM policy_jp.local_governments WHERE lg_code = '130001'`)).slug, "tokyo");
  assertEquals((await one<{ slug: string }>(db, `SELECT slug FROM policy_jp.local_governments WHERE lg_code = '131130'`)).slug, "131130");
  // 自治體缺口臂收完
  await db.exec(`SET app.activity_today = '2026-10-09'`);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_local_government_missing()`)).n, 0);
  await db.close();
});

Deno.test("交件當下核對（p_ids）：只看指定的那幾筆，其他 pending 的留給排程", async () => {
  const db = await freshDb();
  const a = await submit(db, "local_government", payloadOf(reg("230006")));
  const b = await submit(db, "local_government", payloadOf(reg("200000")));
  assertEquals((await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.lg_registry_verify_pending(10, $1::UUID[]) AS r`, [[b]])).r,
    { applied: 1, waiting: 0, rejected: 0, skipped: 0, other: 0 });
  assertEquals((await contribution(db, a)).status, "pending");
  assertEquals((await contribution(db, b)).status, "applied");
  assertEquals((await runVerify(db)).applied, 1, "排程把剩下的掃掉");
  await db.close();
});

/** 碼表查不到的 pending 堆在前面、最後來一筆對得上的：交件當下（p_ids）與排程（預設 p_limit、沒有 p_ids）各會處理到幾筆 */
async function starvationScenario(db: PGlite) {
  // 團體碼檢查碼正確、但總務省的表裡沒有 → 一定是 skip，會一直停在 pending 等同儕：先堆 2,100 筆比較舊的
  await db.exec(`INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash, created_at)
    SELECT 'local_government',
           jsonb_build_object('lg_code', c.code, 'kind', 'city', 'pref_code', policy_jp.lg_pref_code(c.code), 'name', '某' || c.n || '市', 'kana', 'なにがしし'),
           ARRAY['${SOUMU}'], 'backlog-agent', 'backlog-ip-' || c.n, 'backlog-' || c.n, TIMESTAMPTZ '2026-09-01 00:00:00+00' + make_interval(secs => c.n)
      FROM (SELECT p AS n, lpad(p::TEXT, 5, '0') || d::TEXT AS code FROM generate_series(90001, 92100) p, generate_series(0, 9) d
             WHERE policy_jp.lg_code_valid(lpad(p::TEXT, 5, '0') || d::TEXT)) c
     WHERE NOT EXISTS (SELECT 1 FROM policy_jp.lg_code_registry r WHERE r.lg_code = c.code)`);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.contributions WHERE agent_name = 'backlog-agent'`)).n, 2100);
  const fresh = await submit(db, "local_government", payloadOf(reg("230006")));
  const viaIds = (await one<{ r: Record<string, number> }>(db, `SELECT policy_jp.lg_registry_verify_pending(10, $1::UUID[]) AS r`, [[fresh]])).r;
  const fresh2 = await submit(db, "local_government", payloadOf(reg("010006")));
  const sweep = await runVerify(db);
  const left = (await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.contributions WHERE status = 'pending' AND agent_name = 'backlog-agent'`)).n;
  return { viaIds, sweep, left, fresh2: (await contribution(db, fresh2)).status };
}

Deno.test("掃描（回歸）：碼表查不到的團體碼堆過 p_limit，後面一致的仍被排程處理；舊的不計數、原封不動", async () => {
  const db = await freshDb();
  const r = await starvationScenario(db);
  assertEquals(r.viaIds, { applied: 1, waiting: 0, rejected: 0, skipped: 0, other: 0 }, "交件當下（p_ids）本來就不受堆積影響");
  assertEquals(r.sweep, { applied: 1, waiting: 0, rejected: 0, skipped: 0, other: 0 }, "排程（預設 p_limit 2000）不被 2,100 筆查不到的佔滿名額，也不把它們算進 skipped");
  assertEquals(r.fresh2, "applied");
  assertEquals(r.left, 2100, "查不到的 2,100 筆都還在 pending 等同儕");
  await db.close();
});

Deno.test("掃描（還原驗證）：拿掉掃描 SQL 的「只掃碼表查得到的」濾網，同一個情境排程就餓死（applied 0、skipped 2000）", async () => {
  const noFilter = mutate(REG_SQL, "AND EXISTS (SELECT 1 FROM policy_jp.lg_code_registry r WHERE r.lg_code = payload->>'lg_code')", "");
  const db = await freshDb({ reg: noFilter });
  const r = await starvationScenario(db);
  assertEquals(r.viaIds, { applied: 1, waiting: 0, rejected: 0, skipped: 0, other: 0 }, "p_ids 的路沒有濾網也沒事");
  assertEquals(r.sweep, { applied: 0, waiting: 0, rejected: 0, skipped: 2000, other: 0 }, "沒有濾網：前 2,000 筆全是碼表查不到的，後面一致的輪不到");
  assertEquals(r.fresh2, "pending");
  assertEquals(r.left, 2100);
  await db.close();
});

Deno.test("機器核對的審核者與型別：TS 清單跟 SQL 寫的一致", () => {
  assertEquals([...JP_MACHINE_REVIEWERS], ["soumu-auto", "estat-auto"]);
  assertEquals([...JP_MACHINE_VERIFIABLE_TYPES], ["local_government", "regional_stat"]);
  assert(REG_SQL.includes("reviewed_by = 'soumu-auto'"));
  assert(REG_SQL.includes("contribution_type = 'local_government'"));
});

// =============================================================================================
// e. 權限、排程、自我檢查
// =============================================================================================
Deno.test("權限：anon 只能讀參考表、不能寫；兩支函式只給 service_role", async () => {
  const db = shared;
  assertEquals((await asRole<{ n: number }>(db, "anon", `SELECT count(*)::INT AS n FROM policy_jp.lg_code_registry`))[0].n, 1965);
  await assertRejects(() => asRole(db, "anon", `INSERT INTO policy_jp.lg_code_registry (lg_code) VALUES ('010006')`));
  await assertRejects(() => asRole(db, "anon", `SELECT policy_jp.lg_registry_verify_pending()`));
  await assertRejects(() => asRole(db, "anon", `SELECT policy_jp.lg_registry_decide('{}'::JSONB)`));
  await assertRejects(() => asRole(db, "authenticated", `SELECT policy_jp.lg_registry_verify_pending()`));
  assertEquals((await asRole<{ r: Record<string, number> }>(db, "service_role", `SELECT policy_jp.lg_registry_verify_pending() AS r`))[0].r.applied, 0);
});

Deno.test("排程：有 pg_cron 就排（重跑只留一條），沒有就略過", async () => {
  const db = await freshDb({ cron: true });
  await db.exec(REG_SQL);
  assertEquals(await rows(db, `SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'policy-jp-lg-registry-verify'`),
    [{ jobname: "policy-jp-lg-registry-verify", schedule: "2,12,22,32,42,52 * * * *", command: "SELECT policy_jp.lg_registry_verify_pending();" }]);
  await db.close();
  const noCron = await freshDb({ data: false });
  assertEquals((await one<{ x: string | null }>(noCron, `SELECT to_regnamespace('cron')::TEXT AS x`)).x, null);
  await noCron.close();
});

Deno.test("自我檢查（還原驗證）：沒開 RLS、給 anon 寫入、給 anon 執行、資料少灌，重跑都會失敗；資料 migration 重跑冪等", async () => {
  const noRls = mutate(REG_SQL, "ALTER TABLE policy_jp.lg_code_registry ENABLE ROW LEVEL SECURITY;", "");
  await assertRejects(() => freshDb({ reg: noRls, data: false }), Error, "沒開 RLS");
  const anonWrite = mutate(REG_SQL, "GRANT SELECT ON policy_jp.lg_code_registry TO anon, authenticated;", "GRANT SELECT, INSERT ON policy_jp.lg_code_registry TO anon, authenticated;");
  await assertRejects(() => freshDb({ reg: anonWrite, data: false }), Error, "只能讀");
  const anonExec = mutate(REG_SQL, "GRANT EXECUTE ON FUNCTION policy_jp.lg_registry_decide(JSONB), policy_jp.lg_registry_verify_pending(INTEGER, UUID[]) TO service_role;",
    "GRANT EXECUTE ON FUNCTION policy_jp.lg_registry_decide(JSONB), policy_jp.lg_registry_verify_pending(INTEGER, UUID[]) TO service_role, anon;");
  await assertRejects(() => freshDb({ reg: anonExec, data: false }), Error, "不該給 anon 執行");
  // 資料少一列 → 分布不對
  const firstRow = DATA_SQL.split("\n").find((l) => l.startsWith("    ('010006'"))!;
  const fewer = mutate(DATA_SQL, `${firstRow}\n`, "");
  const db = await freshDb({ data: false });
  await assertRejects(() => db.exec(fewer), Error, "分布不對");
  await db.exec(DATA_SQL);
  await db.exec(DATA_SQL); // 重跑：ON CONFLICT DO NOTHING，自我檢查照樣過
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.lg_code_registry`)).n, 1965);
  await db.close();
});

Deno.test("文字守門：這兩支只在 policy_jp 動手，不碰 public；不從參考表建正式列（沒有寫 local_governments 的語句）", () => {
  for (const [name, sql] of [[REG_FILE, REG_SQL], [DATA_FILE, DATA_SQL]] as const) {
    const code = sql.replace(/--[^\n]*/g, "");
    assert(!/\bpublic\./.test(code), `${name} 提到 public.`);
    assert(!/INSERT\s+INTO\s+policy_jp\.local_governments/i.test(code), `${name} 直接寫 local_governments`);
    assert(!/UPDATE\s+policy_jp\.local_governments/i.test(code), `${name} 直接改 local_governments`);
  }
  // 落庫只經 apply_contribution（跟同儕驗證同一條路）
  assert(REG_SQL.includes("policy_jp.apply_contribution(c.id, false)"));
});
