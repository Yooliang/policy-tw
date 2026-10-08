/**
 * 日本站第一批資料表（policy-jp #39 ①；migration 20261009000000_policy_jp_tables.sql）。
 *
 * 只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）：PGlite 實跑 #479 的空 schema 與這支 migration，
 * Supabase 的三個角色（anon、authenticated、service_role＝BYPASSRLS）用 CREATE ROLE 模擬。
 *
 *   1. 檔名：policy_jp 的 migration 帶 _policy_jp_、時間戳從 20261009 起、整個資料夾沒有撞號
 *   2. 套用兩次都成功（IF NOT EXISTS／DROP … IF EXISTS），21 張表都開 RLS
 *   3. 權限：anon／authenticated 讀得到 published、讀不到 pending；寫不進任何表；健康檢查視圖讀不到；service_role 寫得進
 *   4. CHECK：每條規則各一組「該過／該擋」（團體代碼檢查碼、self 要根據、platform_verified 不收、卸任三欄、退選旗標、
 *      公約要掛參選與原句位置、要約 120 字、層級與職位、國政不掛団体、election id 格式、三要素…）
 *   5. 沒有得票數、得票率欄位
 *   6. 還原驗證：把 migration 改壞一處（拿掉一張表的 RLS、加一個 votes 欄、給 anon INSERT），migration 自己的檢查要讓它失敗
 *   7. source_refs_orphans 抓得到指向不存在資料列的引用
 *   8. agy 同儕審查（policy-tw#483）補的：reviews 只公開 published、衆院重複立候補兩列並存、
 *      選挙区看母選舉是否 published、lg_code_valid 遇到非數字／空字串／NULL 不報錯
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const MIG = "20261009000000_policy_jp_tables.sql";
const SCHEMA_MIG = "20261008195000_policy_jp_schema.sql";
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const MIG_SQL = await read(MIG);
const SCHEMA_SQL = await read(SCHEMA_MIG);

const TABLES = [
  "sources", "source_refs", "local_governments", "local_government_successions", "parties", "politicians",
  "politician_careers", "lineages", "elections", "election_districts", "politician_elections", "candidacy_endorsements",
  "assembly_factions", "politician_offices", "policies", "policy_elements", "tracking_logs", "lineage_participants",
  "lineage_links", "handovers", "reviews",
];

/** 精確改一處：改不到或改到兩處都算失敗（不然還原驗證可能什麼都沒改） */
function mutate(sql: string, from: string, to: string): string {
  const first = sql.indexOf(from);
  assert(first >= 0, `還原驗證：找不到要改的字串 ${from.slice(0, 60)}`);
  assert(sql.indexOf(from, first + 1) < 0, `還原驗證：要改的字串不唯一 ${from.slice(0, 60)}`);
  return sql.replace(from, to);
}

async function freshDb(migration = MIG_SQL): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  `);
  await db.exec(SCHEMA_SQL);
  await db.exec(migration);
  return db;
}

/** 以某個角色執行（交易內 SET LOCAL ROLE，結束就回到超級使用者） */
async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}

/** 最小的一組合法資料（東京都、千代田区、一場知事選、一個人、一筆參選），之後各測試在上面加 */
const BASE_ROWS = `
  INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES
    ('130001', 'prefecture', '130001', '東京都', 'とうきょうと', 'tokyo'),
    ('131016', 'special_ward', '130001', '千代田区', 'ちよだく', 'chiyoda');
  INSERT INTO policy_jp.parties (id, name, kana) VALUES ('party-a', '甲党', 'こうとう');
  INSERT INTO policy_jp.politicians (id, name, kana, birth_year, review_status) VALUES
    ('pol-1', '山田 太郎', 'やまだ たろう', 1970, 'published'),
    ('pol-2', '佐藤 花子', 'さとう はなこ', 1975, 'pending');
  INSERT INTO policy_jp.elections (id, name, election_date, notice_date, election_type, election_reason, level, lg_code, seats, review_status) VALUES
    ('2028-07-09_governor_130001', '東京都知事選挙', '2028-07-09', '2028-06-22', 'governor', 'regular', 'regional', '130001', 1, 'published');
  INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, party_id, party_basis, candidacy_status, status_date, district_kind, review_status) VALUES
    ('pe-1', 'pol-1', '2028-07-09_governor_130001', NULL, 'official_list', 'declared', '2028-05-01', 'at_large', 'published');
`;

Deno.test("policy_jp 表：檔名帶 _policy_jp_、時間戳從 20261009 起、資料夾沒有撞號", async () => {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  const stamps = names.map((n) => n.slice(0, 14));
  assertEquals(new Set(stamps).size, stamps.length, `時間戳撞號：${stamps.filter((s, i) => stamps.indexOf(s) !== i).join(", ")}`);
  assert(/^\d{14}_policy_jp_[a-z0-9_]+\.sql$/.test(MIG), "檔名格式：時間戳_policy_jp_xxx.sql");
  assert(MIG.slice(0, 8) >= "20261009", "policy_jp 的 migration 時間戳從 20261009 起");
});

Deno.test("policy_jp 表：套用兩次都成功、21 張表都開 RLS", async () => {
  const db = await freshDb();
  await db.exec(MIG_SQL); // 第二次（重跑不能壞）
  const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'policy_jp' AND c.relkind = 'r' ORDER BY c.relname`,
  );
  assertEquals(rows.map((r) => r.relname), [...TABLES].sort());
  for (const r of rows) assert(r.relrowsecurity, `${r.relname} 沒開 RLS`);
  // public schema 一張表都沒多（不碰正見）
  const pub = await db.query<{ n: number }>(`SELECT count(*)::INT AS n FROM pg_tables WHERE schemaname = 'public'`);
  assertEquals(pub.rows[0].n, 0);
  await db.close();
});

Deno.test("policy_jp 表：anon 只讀得到 published、寫不進任何表；service_role 寫得進", async () => {
  const db = await freshDb();
  await db.exec(BASE_ROWS);
  for (const role of ["anon", "authenticated"]) {
    const people = await asRole<{ id: string }>(db, role, `SELECT id FROM policy_jp.politicians ORDER BY id`);
    assertEquals(people.map((p) => p.id), ["pol-1"], `${role} 只看得到 published`);
    const lgs = await asRole<{ n: number }>(db, role, `SELECT count(*)::INT AS n FROM policy_jp.local_governments`);
    assertEquals(lgs[0].n, 2, `${role} 讀得到參照表`);
    for (const t of TABLES) {
      await assertRejects(
        () => asRole(db, role, `INSERT INTO policy_jp.${t} DEFAULT VALUES`),
        Error,
        "permission denied",
        `${role} 不該能寫 ${t}`,
      );
    }
    await assertRejects(() => asRole(db, role, `UPDATE policy_jp.politicians SET name = 'x'`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `DELETE FROM policy_jp.politicians`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT * FROM policy_jp.source_refs_orphans`), Error, "permission denied");
  }
  // service_role：#479 的預設權限＋BYPASSRLS
  await asRole(db, "service_role", `INSERT INTO policy_jp.sources (url, source_kind, origin) VALUES ('https://www.soumu.go.jp/x', 'statistics', 'test')`);
  const pending = await asRole<{ n: number }>(db, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.politicians`);
  assertEquals(pending[0].n, 2, "service_role 看得到 pending");
  await db.close();
});

Deno.test("policy_jp 表：CHECK 規則（該過的過、該擋的擋）", async () => {
  const db = await freshDb();
  await db.exec(BASE_ROWS);
  const cases: [string, string, boolean][] = [
    // [說明, SQL, 該成功?]
    ["団体コード檢查碼對", `INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ('131024', 'special_ward', '130001', '中央区', 'ちゅうおうく', 'chuo')`, true],
    ["団体コード檢查碼錯", `INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ('131025', 'special_ward', '130001', '中央区', 'ちゅうおうく', 'chuo2')`, false],
    ["都道府県的 pref_code 要是自己", `INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ('010006', 'prefecture', '130001', '北海道', 'ほっかいどう', 'hokkaido')`, false],
    ["self 要有認定根據", `INSERT INTO policy_jp.sources (url, source_kind, origin) VALUES ('https://example.jp/a', 'self', 't')`, false],
    ["self＋mutual_link 可以", `INSERT INTO policy_jp.sources (url, source_kind, self_evidence, origin) VALUES ('https://example.jp/b', 'self', 'mutual_link', 't')`, true],
    ["platform_verified 不收", `INSERT INTO policy_jp.sources (url, source_kind, self_evidence, origin) VALUES ('https://example.jp/c', 'self', 'platform_verified', 't')`, false],
    ["有根據卻不是 self", `INSERT INTO policy_jp.sources (url, source_kind, self_evidence, origin) VALUES ('https://example.jp/d', 'media', 'mutual_link', 't')`, false],
    ["url 重複", `INSERT INTO policy_jp.sources (url, origin) VALUES ('https://example.jp/b', 't')`, false],
    ["fetched_at 可空、assembly 等級可用", `INSERT INTO policy_jp.sources (url, source_kind, origin) VALUES ('https://example.jp/e', 'assembly', 't')`, true],
    ["election id 格式錯", `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code) VALUES ('tokyo-2028', 'x', '2028-07-09', 'governor', 'regular', 'regional', '130001')`, false],
    ["層級跟職位對不上", `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code) VALUES ('2028-07-10_governor_130001', 'x', '2028-07-10', 'governor', 'regular', 'local', '130001')`, false],
    ["國政不掛団体", `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code) VALUES ('2028-07-09_national_upper_national', 'x', '2028-07-09', 'national_upper', 'regular', 'national', '130001')`, false],
    ["國政 lg_code 空可以", `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level) VALUES ('2028-07-09_national_upper_national', '参議院議員通常選挙', '2028-07-09', 'national_upper', 'regular', 'national')`, true],
    ["rerun 可以", `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code) VALUES ('2028-08-01_ward_mayor_131016', '千代田区長再選挙', '2028-08-01', 'ward_mayor', 'rerun', 'local', '131016')`, true],
    ["首長選不能是補欠", `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code) VALUES ('2028-09-01_ward_mayor_131016', 'x', '2028-09-01', 'ward_mayor', 'by_election', 'local', '131016')`, false],
    ["jurisdiction 只能是 jp", `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code, jurisdiction) VALUES ('2028-10-01_ward_mayor_131016', 'x', '2028-10-01', 'ward_mayor', 'regular', 'local', '131016', 'tw')`, false],
    ["at_large 不能有選挙区名", `INSERT INTO policy_jp.election_districts (election_id, district_kind, district_name) VALUES ('2028-07-09_governor_130001', 'at_large', '第1区')`, false],
    ["定數要有依據", `INSERT INTO policy_jp.election_districts (election_id, district_kind, seats) VALUES ('2028-07-09_governor_130001', 'at_large', 1)`, false],
    ["定數＋law、無投票", `INSERT INTO policy_jp.election_districts (election_id, district_kind, seats, seats_basis, is_uncontested) VALUES ('2028-07-09_governor_130001', 'at_large', 1, 'law', false)`, true],
    ["退選旗標只給 withdrawn", `UPDATE policy_jp.politician_elections SET withdrawn_after_filing = true WHERE id = 'pe-1'`, false],
    ["退選＋届出後に辞退", `UPDATE policy_jp.politician_elections SET candidacy_status = 'withdrawn', withdrawn_after_filing = true WHERE id = 'pe-1'`, true],
    ["有黨卻沒有根據", `INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, party_id, candidacy_status, status_date, district_kind) VALUES ('pe-2', 'pol-2', '2028-07-09_governor_130001', 'party-a', 'declared', '2028-05-01', 'at_large')`, false],
    ["舊狀態值 candidate_status 的寫法不收", `INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, status_date, district_kind) VALUES ('pe-3', 'pol-2', '2028-07-09_governor_130001', 'rumored', '2028-05-01', 'at_large')`, false],
    ["名簿順位只給比例", `INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, status_date, district_kind, list_rank) VALUES ('pe-4', 'pol-2', '2028-07-09_governor_130001', 'declared', '2028-05-01', 'at_large', 1)`, false],
    ["卸任要有原因與依據", `INSERT INTO policy_jp.politician_offices (id, politician_id, position, lg_code, term_no, start_date, scheduled_end_date, end_date) VALUES ('of-x', 'pol-1', 'governor', '130001', 1, '2024-07-31', '2028-07-30', '2026-01-01')`, false],
    ["卸任三欄齊", `INSERT INTO policy_jp.politician_offices (id, politician_id, position, lg_code, term_no, start_date, scheduled_end_date, end_date, end_reason, end_basis, politician_election_id) VALUES ('of-1', 'pol-1', 'governor', '130001', 1, '2024-07-31', '2028-07-30', '2026-01-01', 'resigned', 'source', 'pe-1')`, true],
    ["首長要掛団体", `INSERT INTO policy_jp.politician_offices (id, politician_id, position, term_no, start_date, scheduled_end_date) VALUES ('of-2', 'pol-1', 'governor', 1, '2024-07-31', '2028-07-30')`, false],
    ["公約要掛參選", `INSERT INTO policy_jp.policies (id, title, description, category, origin, source_locator, status) VALUES ('po-x', 't', '要約', 'c', 'pledge', 'p.3', 'not_started')`, false],
    ["公約要有原句位置", `INSERT INTO policy_jp.policies (id, title, description, category, origin, politician_election_id, status) VALUES ('po-y', 't', '要約', 'c', 'pledge', 'pe-1', 'not_started')`, false],
    ["要約超過 120 字", `INSERT INTO policy_jp.policies (id, title, description, category, origin, status) VALUES ('po-z', 't', repeat('あ', 121), 'c', 'budget', 'not_started')`, false],
    ["unfulfilled 只給公約", `INSERT INTO policy_jp.policies (id, title, description, category, origin, status) VALUES ('po-w', 't', '要約', 'c', 'budget', 'unfulfilled')`, false],
    ["公約齊全", `INSERT INTO policy_jp.policies (id, title, description, category, origin, source_locator, politician_election_id, status) VALUES ('po-1', '待機児童ゼロ', '保育所を増やす', '子育て', 'pledge', '選挙公報 p.2', 'pe-1', 'not_started')`, true],
    ["三要素：沒寫（未説明）不能有文字", `INSERT INTO policy_jp.policy_elements (id, policy_id, element, stated, text) VALUES ('el-x', 'po-1', 'target', false, '1000人')`, false],
    ["三要素：未説明", `INSERT INTO policy_jp.policy_elements (id, policy_id, element, stated) VALUES ('el-1', 'po-1', 'funding', false)`, true],
    ["三要素：同政見同要素只一列", `INSERT INTO policy_jp.policy_elements (id, policy_id, element, stated) VALUES ('el-2', 'po-1', 'funding', false)`, false],
    ["期限日只給 deadline", `INSERT INTO policy_jp.policy_elements (id, policy_id, element, stated, text, deadline_date) VALUES ('el-3', 'po-1', 'target', true, '1000人', '2029-03-31')`, false],
    ["學經歷同文字不重複", `INSERT INTO policy_jp.politician_careers (politician_id, kind, text) VALUES ('pol-1', 'career', '都庁職員'), ('pol-1', 'career', '都庁職員')`, false],
    ["國政系譜不掛団体", `INSERT INTO policy_jp.lineages (id, title, level, lg_code) VALUES ('ln-x', 't', 'national', '130001')`, false],
    ["地方系譜", `INSERT INTO policy_jp.lineages (id, title, level, lg_code) VALUES ('ln-1', '待機児童', 'regional', '130001'), ('ln-2', '保育', 'local', '131016')`, true],
    ["系譜連結不能連自己", `INSERT INTO policy_jp.lineage_links (id, upper_lineage_id, lower_lineage_id, link_type, note, source_locator) VALUES ('lk-x', 'ln-1', 'ln-1', 'top_down', repeat('説明', 10), 'p.1')`, false],
    ["系譜連結", `INSERT INTO policy_jp.lineage_links (id, upper_lineage_id, lower_lineage_id, link_type, note, source_locator) VALUES ('lk-1', 'ln-1', 'ln-2', 'top_down', repeat('説明', 10), 'p.1')`, true],
    ["查無要附查過的網址", `INSERT INTO policy_jp.reviews (target_table, target_id, review_status, reviewer_kind, reviewer) VALUES ('policies', 'po-1', 'not_found', 'agent', 'claude-x')`, false],
    ["出處引用的 target_table 要在清單內", `INSERT INTO policy_jp.source_refs (source_id, target_table, target_id, origin) SELECT id, 'votes', 'x', 't' FROM policy_jp.sources LIMIT 1`, false],
  ];
  for (const [label, sql, ok] of cases) {
    let err: unknown = null;
    try {
      await db.exec(`BEGIN; ${sql}; COMMIT;`);
    } catch (e) {
      err = e;
      await db.exec("ROLLBACK");
    }
    assertEquals(err === null, ok, `${label}：${ok ? "應該成功卻失敗" : "應該被擋卻成功"}${err ? `（${(err as Error).message}）` : ""}`);
  }
  await db.close();
});

Deno.test("policy_jp 表：沒有得票數、得票率欄位", async () => {
  const db = await freshDb();
  const { rows } = await db.query<{ col: string }>(
    `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
      WHERE table_schema = 'policy_jp' AND column_name ~* '(vote|ballot_count|tokuhyo|得票|share)'`,
  );
  assertEquals(rows, []);
  await db.close();
});

Deno.test("policy_jp 表：還原驗證——改壞一處，migration 自己的檢查要讓它失敗", async () => {
  // (a) 拿掉一張表的 RLS（把 reviews 從 published 清單移掉＝那張表沒開 RLS）
  const noRls = mutate(MIG_SQL, `'lineage_participants', 'lineage_links', 'handovers', 'reviews'] LOOP`, `'lineage_participants', 'lineage_links', 'handovers'] LOOP`);
  await assertRejects(() => freshDb(noRls), Error, "沒開 RLS");
  // (b) 偷加一個票數欄
  const withVotes = mutate(MIG_SQL, `  is_priority_list       BOOLEAN NOT NULL DEFAULT false,`, `  is_priority_list       BOOLEAN NOT NULL DEFAULT false,\n  votes                  INTEGER,`);
  await assertRejects(() => freshDb(withVotes), Error, "不存得票數");
  // (c) 給 anon 寫入權限
  const withInsert = MIG_SQL + `\nGRANT INSERT ON policy_jp.politicians TO anon;\n` +
    MIG_SQL.slice(MIG_SQL.indexOf("-- 13. 自我檢查"));
  await assertRejects(() => freshDb(withInsert), Error, "不該有寫入權限");
});

Deno.test("policy_jp 表：source_refs_orphans 抓得到指向不存在資料列的引用", async () => {
  const db = await freshDb();
  await db.exec(BASE_ROWS);
  await db.exec(`
    INSERT INTO policy_jp.sources (url, source_kind, origin) VALUES ('https://www.senkyo.metro.tokyo.lg.jp/x', 'official', 't');
    INSERT INTO policy_jp.source_refs (source_id, target_table, target_id, origin)
      SELECT id, 'politician_election_status', 'pe-1', 't' FROM policy_jp.sources;
    INSERT INTO policy_jp.source_refs (source_id, target_table, target_id, origin)
      SELECT id, 'politicians', 'pol-404', 't' FROM policy_jp.sources;
  `);
  const { rows } = await db.query<{ target_table: string; target_id: string }>(`SELECT target_table, target_id FROM policy_jp.source_refs_orphans`);
  assertEquals(rows, [{ target_table: "politicians", target_id: "pol-404" }]);
  await db.close();
});

Deno.test("policy_jp 表：reviews 只公開 published（pending 的備註與查核者不外洩）", async () => {
  const db = await freshDb();
  await db.exec(BASE_ROWS);
  await db.exec(`
    INSERT INTO policy_jp.reviews (target_table, target_id, review_status, reviewer_kind, reviewer, note) VALUES
      ('politicians', 'pol-1', 'published', 'human', '査核者A', '公開'),
      ('politicians', 'pol-2', 'pending', 'agent', 'claude-x', '未發布資料的備註');
  `);
  for (const role of ["anon", "authenticated"]) {
    const rows = await asRole<{ target_id: string }>(db, role, `SELECT target_id FROM policy_jp.reviews ORDER BY target_id`);
    assertEquals(rows.map((r) => r.target_id), ["pol-1"], `${role} 讀不到 pending 的 reviews`);
  }
  await assertRejects(
    () => db.exec(`INSERT INTO policy_jp.reviews (target_table, target_id, review_status, reviewer_kind, reviewer) VALUES ('election_districts', '1', 'published', 'human', 'x')`),
    Error,
    "reviews_target_table_check",
    "election_districts 沒有 review_status，不在 reviews 的對象清單",
  );
  await db.close();
});

Deno.test("policy_jp 表：衆院選の重複立候補（同人同場、小選挙区＋比例代表兩列並存）", async () => {
  const db = await freshDb();
  await db.exec(BASE_ROWS);
  await db.exec(`
    INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level) VALUES
      ('2028-10-01_national_lower_national', '衆議院議員総選挙', '2028-10-01', 'national_lower', 'dissolution', 'national');
    INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, status_date, district_kind, district_name, district_lg_code) VALUES
      ('pe-d', 'pol-1', '2028-10-01_national_lower_national', 'filed', '2028-09-20', 'district', '東京都第1区', '130001');
    INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, status_date, district_kind, district_name, list_rank) VALUES
      ('pe-p', 'pol-1', '2028-10-01_national_lower_national', 'filed', '2028-09-20', 'proportional', '東京ブロック', 1);
  `);
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::INT AS n FROM policy_jp.politician_elections WHERE politician_id = 'pol-1' AND election_id = '2028-10-01_national_lower_national'`);
  assertEquals(rows[0].n, 2);
  await assertRejects(
    () => db.exec(`INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, status_date, district_kind, district_name) VALUES
      ('pe-d2', 'pol-1', '2028-10-01_national_lower_national', 'filed', '2028-09-20', 'district', '東京都第2区')`),
    Error,
    "politician_elections_unique",
    "同人同場同 district_kind 仍然只能一列",
  );
  await db.close();
});

Deno.test("policy_jp 表：選挙区看母選舉——母選舉沒 published 就讀不到", async () => {
  const db = await freshDb();
  await db.exec(BASE_ROWS);
  await db.exec(`
    INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code, review_status) VALUES
      ('2028-11-01_ward_mayor_131016', '千代田区長選挙', '2028-11-01', 'ward_mayor', 'regular', 'local', '131016', 'pending');
    INSERT INTO policy_jp.election_districts (election_id, district_kind, seats, seats_basis) VALUES
      ('2028-07-09_governor_130001', 'at_large', 1, 'law'),
      ('2028-11-01_ward_mayor_131016', 'at_large', 1, 'law');
  `);
  for (const role of ["anon", "authenticated"]) {
    const rows = await asRole<{ election_id: string }>(db, role, `SELECT election_id FROM policy_jp.election_districts ORDER BY election_id`);
    assertEquals(rows.map((r) => r.election_id), ["2028-07-09_governor_130001"], `${role} 只讀得到 published 選舉的選挙区`);
  }
  const all = await asRole<{ n: number }>(db, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.election_districts`);
  assertEquals(all[0].n, 2);
  await db.close();
});

Deno.test("policy_jp 表：lg_code_valid 遇到非數字、空字串、NULL 不報錯", async () => {
  const db = await freshDb();
  const { rows } = await db.query<{ input: string | null; ok: boolean | null }>(`
    SELECT x AS input, policy_jp.lg_code_valid(x) AS ok
      FROM (VALUES ('ABCDEF'), (''), (NULL::TEXT), ('13101'), ('1310160'), ('13101A'), ('131016'), ('131017')) AS v(x)`);
  const got = Object.fromEntries(rows.map((r) => [String(r.input), r.ok]));
  assertEquals(got["ABCDEF"], false);
  assertEquals(got[""], false);
  assert(got["null"] === null || got["null"] === false, "NULL 回 NULL 或 false");
  assertEquals(got["13101"], false);
  assertEquals(got["1310160"], false);
  assertEquals(got["13101A"], false);
  assertEquals(got["131016"], true, "千代田区 131016 是對的");
  assertEquals(got["131017"], false, "檢查碼錯");
  // 非數字的 lg_code 寫入被 CHECK 擋（不是 ::INT 的轉型錯誤）
  await assertRejects(
    () => db.exec(`INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ('ABCDEF', 'prefecture', 'ABCDEF', 'x', 'x', 'x')`),
    Error,
    "local_governments_lg_code_check",
  );
  await db.close();
});

Deno.test("policy_jp 表：會派刪掉時任期的 faction_id 變空（ON DELETE SET NULL）", async () => {
  const db = await freshDb();
  await db.exec(BASE_ROWS);
  await db.exec(`
    INSERT INTO policy_jp.assembly_factions (id, lg_code, name) VALUES ('fa-1', '130001', '甲会派');
    INSERT INTO policy_jp.politician_offices (id, politician_id, position, lg_code, term_no, start_date, scheduled_end_date, faction_id) VALUES
      ('of-m', 'pol-1', 'pref_assembly_member', '130001', 1, '2025-07-23', '2029-07-22', 'fa-1');
    DELETE FROM policy_jp.assembly_factions WHERE id = 'fa-1';
  `);
  const { rows } = await db.query<{ faction_id: string | null }>(`SELECT faction_id FROM policy_jp.politician_offices WHERE id = 'of-m'`);
  assertEquals(rows[0].faction_id, null);
  await db.close();
});
