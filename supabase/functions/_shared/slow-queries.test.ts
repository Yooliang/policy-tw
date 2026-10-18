/**
 * 三個慢查詢（policy-ops#136，migration 20261019010000）：純效能，結果不變。
 *
 *   (a) contribution_verify_pool：投票排除拆三個 NOT EXISTS＋表達式索引；字串對 uuid 的比較改走 uuid_if_canonical（能用主鍵）
 *   (b) 前端：人物頁／政見頁／深度分析／我的關注不再撈整份政見清單；整份清單在伺服器端濾 removed_at
 *   (c) candidacy_owner_mismatch_signals ① 改整批連接（不再把 1.6 萬個 id 丟進 election_result_cec_matches）；ROWS 估計
 *
 * 做法：舊定義（緊接在前那一版）與新定義放進同一個 PGlite、同一份合成資料，輸出逐筆比對；再把新定義改壞，比對必須變紅（還原驗證）。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const MIG = "20261019010000_slow_queries.sql";
const SQL = await readMig(MIG);
const ROOT = new URL("../../../", import.meta.url);
const readRepo = async (p: string) => (await Deno.readTextFile(new URL(p, ROOT))).replace(/\r\n/g, "\n");

// ============================================================
// 文字層
// ============================================================
Deno.test("S1 這支是 contribution_verify_pool／candidacy_owner_mismatch_signals 的最後一版，簽名沒變、不 DROP", async () => {
  const names = await migrationNames();
  assertEquals(names[names.length - 1] >= MIG, true);
  for (const fn of ["contribution_verify_pool", "candidacy_owner_mismatch_signals"]) {
    const later: string[] = [];
    for (const n of names) if (n > MIG && (await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}(`)) later.push(n);
    assertEquals(later, [], `${fn} 在這支之後又有人改了，這裡抄的底就過期`);
  }
  assert(!/DROP\s+FUNCTION/i.test(SQL), "簽名沒變，不必 DROP");
  assert(!SQL.replace(/--[^\n]*/g, "").includes("CONCURRENTLY"), "migration 在交易裡跑，CONCURRENTLY 會失敗");
  assertStringIncludes(SQL, "CREATE INDEX IF NOT EXISTS idx_contribution_votes_lower_agent ON contribution_votes (contribution_id, lower(agent_name));");
});

Deno.test("S2 驗證池新定義＝緊接在前那一版（20261017020100）做四處機械替換，其餘一字不動", async () => {
  const prev = await latestFn("contribution_verify_pool", MIG);
  const cur = fnText(SQL, "contribution_verify_pool");
  const votesOld = prev.slice(prev.indexOf("    AND NOT EXISTS (\n      SELECT 1 FROM contribution_votes v"), prev.indexOf("    -- 剛派給這台機器的不要再派"));
  const votesNew = cur.slice(cur.indexOf("    -- 投過票的排除（20261019010000"), cur.indexOf("    -- 剛派給這台機器的不要再派"));
  assert(votesOld.length > 100 && votesNew.length > 100);
  let expected = prev.replace(votesOld, () => votesNew);
  expected = mutate(expected, "t.id::TEXT = c.task_id AND t.source", "t.id = uuid_if_canonical(c.task_id) AND t.source");
  expected = mutate(expected, "WHERE o.id::TEXT = c.payload->>'contribution_id'", "WHERE o.id = uuid_if_canonical(c.payload->>'contribution_id')");
  assertEquals(cur, expected);
});

Deno.test("S3 驗證池不再有拖垮規劃的寫法：投票條件不混在一個 OR 裡、沒有 id::TEXT 轉型、沒有新增任務脈絡查詢", async () => {
  const cur = fnText(SQL, "contribution_verify_pool");
  assert(!/verifier_ip_hash = p_ip_hash OR v\.verifier_ip_hash = p_legacy_ip_hash/.test(cur), "網段與舊網段條件要拆開");
  assert(!/OR \(p_agent_name IS NOT NULL AND lower\(v\.agent_name\)/.test(cur), "代號條件不能再 OR 在同一個子查詢");
  assert(!/\.id::TEXT\s*=/.test(cur), "id::TEXT = … 會讓主鍵索引失效");
  assertEquals(cur.split("NOT EXISTS").length - 1, 6, "投票 3 + 派出 1 + 裁決 1 + 裁決內的投票 EXISTS 不算：共 5 個 NOT EXISTS 加 1 個註解字樣");
  for (const bad of ["task_context", "contribution_queue_tasks", "task_checks", "tracking_logs"]) assert(!cur.includes(bad), `裁決 #233／#234：驗證池不加 ${bad}`);
});

Deno.test("S4 election_result_cec_matches 本體沒動：只有 ALTER FUNCTION … ROWS", () => {
  assert(!SQL.includes("CREATE OR REPLACE FUNCTION election_result_cec_matches"));
  assertStringIncludes(SQL, "ALTER FUNCTION election_result_cec_matches(INTEGER[]) ROWS 16000;");
});

Deno.test("S5 前端：整份政見清單在伺服器端濾 removed_at；人物頁、政見頁、深度分析、我的關注不再撈整份", async () => {
  const sup = await readRepo("composables/useSupabase.ts");
  assertStringIncludes(sup, "fetchAllRows<RawPolicy>('policies_with_logs', '*', 'id', { notRemoved: true })");
  assertStringIncludes(sup, "supabase.from(tableName).select(selectStr).is('removed_at', null)");
  for (const fn of ["loadPoliciesByPolitician", "loadPoliciesByIds"]) {
    const a = sup.indexOf(`async function ${fn}(`);
    assert(a > 0, fn);
    assertStringIncludes(sup.slice(a, a + 1400), ".is('removed_at', null)");
  }
  const need: Record<string, string> = {
    "pages/PolicyDetail.vue": "loadPolicyContext(",
    "pages/PolicyDeepAnalysis.vue": "loadPolicyContext(",
    "pages/PoliticianProfile.vue": "loadPoliciesByPolitician(",
    "pages/UserProfile.vue": "loadPoliciesByIds(",
  };
  for (const [f, call] of Object.entries(need)) {
    const src = await readRepo(f);
    assert(!/\bensurePolicies\b/.test(src.replace(/\/\/.*$/gm, "")), `${f} 不該再叫 ensurePolicies（整份約 70 次分頁請求）`);
    assertStringIncludes(src, call);
  }
});

// ============================================================
// (a) 驗證池：舊 vs 新，合成資料逐筆相同
// ============================================================
const U = (n: number, p = "a") => `${p}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WEB_TASK = "abcdefab-1111-4111-8111-11111111111a"; // 要有字母，大寫版才和小寫版不同
const asOld = (fn: string, name: string, to: string) => fn.replace(`CREATE OR REPLACE FUNCTION ${name}(`, `CREATE OR REPLACE FUNCTION ${to}(`);

async function poolDb(editPool: (s: string) => string = (s) => s, editHelper: (s: string) => string = (s) => s): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, source text);
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, payload jsonb DEFAULT '{}', source_urls text[], note text,
      task_id text, agent_name text, contributor_ip_hash text, status text, agree_count int DEFAULT 0, disagree_count int DEFAULT 0,
      unsure_count int DEFAULT 0, created_at timestamptz DEFAULT now(), score int DEFAULT 0, target_score int, voter_ips int DEFAULT 0);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz, queue_at timestamptz, dispatch_count int DEFAULT 0, verify_target int);
    CREATE TABLE contribution_votes (contribution_id uuid, agent_name text, verifier_ip_hash text);
    CREATE TABLE verify_dispatches (contribution_id uuid, ip_hash text, dispatched_at timestamptz);
    CREATE FUNCTION contribution_effective_agree(uuid) RETURNS int LANGUAGE sql AS 'SELECT 3';
    CREATE FUNCTION contribution_needs_two_ips(text, jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT false';
    CREATE FUNCTION contribution_overvoted_stop_votes() RETURNS numeric LANGUAGE sql AS 'SELECT 1000000';
    INSERT INTO contribution_tasks VALUES ('${WEB_TASK}', 'web_request');
  `);
  await d.exec(editHelper(fnText(SQL, "uuid_if_canonical")));
  await d.exec(asOld(await latestFn("contribution_verify_pool", MIG), "contribution_verify_pool", "old_pool"));
  await d.exec(asOld(editPool(fnText(SQL, "contribution_verify_pool")), "contribution_verify_pool", "new_pool"));

  const C = (n: number, type: string, o: { task?: string | null; payload?: unknown; agent?: string; ip?: string; status?: string } = {}) =>
    `INSERT INTO contributions (id, contribution_type, task_id, payload, agent_name, contributor_ip_hash, status, score, target_score) VALUES
      ('${U(n)}', '${type}', ${o.task ? `'${o.task}'` : "NULL"}, '${JSON.stringify(o.payload ?? {})}'::jsonb, '${o.agent ?? "other"}', '${o.ip ?? "net-x"}', '${o.status ?? "pending"}', 0, 3);`;
  const Q = (n: number, sec: number) => `INSERT INTO task_dispatches (task_id, queue_at) VALUES ('verify:${U(n)}', '2026-01-01'::timestamptz + interval '${sec} seconds');`;
  const V = (n: number, agent: string, ip: string) => `INSERT INTO contribution_votes VALUES ('${U(n)}', '${agent}', '${ip}');`;
  const lines = [
    C(1, "policy"), Q(1, 1),                                              // 一般
    C(2, "policy"), Q(2, 2), V(2, "x2", "net-me"),                        // 我的網段投過
    C(3, "policy"), Q(3, 3), V(3, "x3", "net-leg"),                       // 舊網段投過
    C(4, "policy"), Q(4, 4), V(4, "Me", "net-elsewhere"),                 // 同代號別網段投過（大小寫不同）
    C(5, "policy"), Q(5, 5), V(5, "someone", "net-other"),                // 別人投過：照派
    // 裁決：原貢獻 11..16 都不在佇列
    C(11, "policy", { ip: "net-me", status: "applied" }),
    C(12, "policy", { status: "applied" }), V(12, "y", "net-me"),
    C(13, "policy", { agent: "ME", status: "applied" }),
    C(14, "policy", { ip: "net-me", status: "applied" }),
    C(15, "policy", { ip: "net-leg", status: "applied" }),
    C(16, "policy", { status: "applied" }), V(16, "z", "net-leg"),
    C(21, "adjudication", { payload: { contribution_id: U(11) } }), Q(21, 21),   // 原貢獻是我的網段 → 排除
    C(22, "adjudication", { payload: { contribution_id: U(12) } }), Q(22, 22),   // 我的網段投過原貢獻 → 排除
    C(23, "adjudication", { payload: { contribution_id: U(13) } }), Q(23, 23),   // 原貢獻是同代號 → 排除（有代號時）
    C(24, "adjudication", { payload: { contribution_id: U(15) } }), Q(24, 24),   // 舊網段的原貢獻
    C(25, "adjudication", { payload: { contribution_id: U(16) } }), Q(25, 25),   // 舊網段投過原貢獻
    C(26, "adjudication", { payload: { contribution_id: U(14).toUpperCase() } }), Q(26, 26), // 大寫 uuid：舊寫法（id::TEXT = …）比不到 → 不排除
    C(27, "adjudication", { payload: { contribution_id: "not-a-uuid" } }), Q(27, 27),       // 不是 uuid → 不排除
    C(28, "adjudication", { payload: {} }), Q(28, 28),                                       // 沒有欄位 → 不排除
    C(29, "adjudication", { payload: { contribution_id: 12345 } }), Q(29, 29),               // 數字 → 不排除
    C(30, "adjudication", { payload: { contribution_id: U(99) } }), Q(30, 30),               // 原貢獻不存在 → 不排除
    // 網站請求（visitor_facing）
    C(41, "policy", { task: WEB_TASK }), Q(41, 41),
    C(42, "policy", { task: WEB_TASK.toUpperCase() }), Q(42, 42),                            // 大寫：舊寫法比不到 → false
    C(43, "policy", { task: "auto:policy_missing:x" }), Q(43, 43),
    C(44, "question_answer"), Q(44, 44),
  ];
  await d.exec(lines.join("\n"));
  return d;
}

const COMBOS: Array<[string, string | null, string | null]> = [
  ["net-me", null, null], ["net-me", "me", null], ["net-me", "ME", "net-leg"], ["net-other", "me", "net-leg"],
  ["net-fresh", null, "net-leg"], ["net-fresh", "nobody", null], ["net-leg", "Me", "net-me"],
];
async function pool(d: PGlite, fn: string, c: [string, string | null, string | null]) {
  return (await d.query<{ id: string; visitor_facing: boolean; queue_at: string }>(
    `SELECT id, visitor_facing, queue_at::text AS queue_at FROM ${fn}($1, NULL, 200, NULL, $3, $2)`, [c[0], c[1], c[2]])).rows;
}
async function poolDiffs(d: PGlite) {
  const out: string[] = [];
  for (const c of COMBOS) {
    const o = await pool(d, "old_pool", c), n = await pool(d, "new_pool", c);
    if (JSON.stringify(o) !== JSON.stringify(n)) out.push(JSON.stringify(c));
  }
  return out;
}

Deno.test("S6 驗證池：舊定義與新定義在合成資料上逐筆（含順序、visitor_facing）相同", async () => {
  const d = await poolDb();
  assertEquals(await poolDiffs(d), []);
  // 合成資料要夠狠：各組參數的結果不全相同、也不是空的
  const sizes = new Set<number>();
  for (const c of COMBOS) sizes.add((await pool(d, "old_pool", c)).length);
  assert(sizes.size >= 3 && !sizes.has(0), `參數組合的結果應有多種大小，實際 ${[...sizes]}`);
  const [me] = [await pool(d, "old_pool", COMBOS[1])];
  const ids = me.map((r) => r.id);
  assert(!ids.includes(U(2)) && !ids.includes(U(4)) && !ids.includes(U(21)) && !ids.includes(U(22)) && !ids.includes(U(23)), "該排除的要排除");
  assert(ids.includes(U(5)) && ids.includes(U(26)) && ids.includes(U(27)) && ids.includes(U(28)) && ids.includes(U(29)) && ids.includes(U(30)), "不是標準 uuid／不存在的裁決原貢獻不排除（舊行為）");
  assertEquals(me.find((r) => r.id === U(41))?.visitor_facing, true);
  assertEquals(me.find((r) => r.id === U(42))?.visitor_facing, false, "大寫 task_id 舊寫法就比不到");
  await d.close();
});

Deno.test("S7 驗證池還原驗證：把新定義改壞一處，S6 的比對必須變紅", async () => {
  const pairs: Array<[string, (s: string) => string, ((s: string) => string)?]> = [
    ["拿掉舊網段的 NOT EXISTS", (s) => mutate(s, "WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_legacy_ip_hash", "WHERE false")],
    ["拿掉網段的 NOT EXISTS", (s) => mutate(s, "WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash\n", "WHERE false\n")],
    ["代號比對不分大小寫失效", (s) => mutate(s, "lower(v.agent_name) = lower(p_agent_name)", "v.agent_name = p_agent_name")],
    ["拿掉代號的 NOT EXISTS", (s) => mutate(s, "AND (p_agent_name IS NULL OR NOT EXISTS (", "AND (true OR NOT EXISTS (")],
    ["裁決原貢獻改成不比對", (s) => mutate(s, "WHERE o.id = uuid_if_canonical(c.payload->>'contribution_id')", "WHERE false")],
    ["網站請求判斷失效", (s) => mutate(s, "t.id = uuid_if_canonical(c.task_id)", "false")],
    ["uuid_if_canonical 改成連大寫都認", (s) => s, (h) => mutate(h, "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")],
    ["uuid_if_canonical 改成不檢查格式（非 uuid 字串直接 cast 會丟錯）", (s) => s, (h) => mutate(h, "WHEN p_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN", "WHEN true THEN")],
  ];
  for (const [label, editPool, editHelper] of pairs) {
    let red = false;
    try {
      const d = await poolDb(editPool, editHelper);
      red = (await poolDiffs(d)).length > 0;
      await d.close();
    } catch {
      red = true; // 丟錯也算紅
    }
    assert(red, `改壞（${label}）後比對應該紅`);
  }
});

Deno.test("S8 uuid_if_canonical 與 `id::TEXT = x` 同義：只有小寫標準寫法有值，其他全是 NULL", async () => {
  const d = new PGlite();
  await d.exec(fnText(SQL, "uuid_if_canonical"));
  const ok = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const samples = [ok, ok.toUpperCase(), `{${ok}}`, ok.replaceAll("-", ""), ` ${ok}`, `${ok} `, "", "abc", "12345", "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4", `${ok}0`, "gggggggg-gggg-gggg-gggg-gggggggggggg"];
  for (const s of samples) {
    const [r] = (await d.query<{ h: string | null }>(`SELECT uuid_if_canonical($1)::text AS h`, [s])).rows;
    let castTextEqual = false;
    try {
      const [c] = (await d.query<{ t: string }>(`SELECT $1::uuid::text AS t`, [s])).rows;
      castTextEqual = c.t === s; // 舊寫法：uuid 的文字輸出等於這個字串
    } catch { /* 不是 uuid */ }
    assertEquals(r.h, castTextEqual ? s : null, `輸入 ${JSON.stringify(s)}`);
  }
  assertEquals((await d.query(`SELECT uuid_if_canonical(NULL) IS NULL AS n`)).rows[0], { n: true });
  await d.close();
});

// ============================================================
// (c) candidacy_owner_mismatch_signals：舊 vs 新
// ============================================================
async function sigDb(editNew: (s: string) => string = (s) => s): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, birth_year integer, region text, sub_region text, village text, merged_into uuid);
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL, election_id integer NOT NULL, election_type text, region_id integer, candidacy_status text);
    CREATE TABLE cec_candidates (id integer PRIMARY KEY, election_id integer, election_type text, region text, sub_region text, village text, birth_year integer, elected boolean, cec_theme_id text, cec_cand_id integer, name_norm text);
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, applied_politician_id uuid, payload jsonb, task_id text, note text);
    CREATE TABLE contribution_votes (contribution_id uuid, note text);
  `);
  await d.exec(await latestFn("cec_name_norm"));
  await d.exec(await latestFn("cec_name_key"));
  await d.exec(await latestFn("election_result_cec_matches"));
  const prev = await latestFn("candidacy_owner_mismatch_signals", MIG);
  await d.exec(asOld(prev, "candidacy_owner_mismatch_signals", "old_sig"));
  await d.exec(asOld(editNew(fnText(SQL, "candidacy_owner_mismatch_signals")), "candidacy_owner_mismatch_signals", "new_sig"));

  const P = (n: number, name: string, o: { birth?: number | null; region?: string; sub?: string; village?: string; merged?: boolean } = {}) =>
    `INSERT INTO politicians (id, name, birth_year, region, sub_region, village, merged_into) VALUES ('${U(n, "b")}', '${name}', ${o.birth === undefined ? 1970 : o.birth ?? "NULL"}, ${o.region ? `'${o.region}'` : "NULL"}, ${o.sub ? `'${o.sub}'` : "NULL"}, ${o.village ? `'${o.village}'` : "NULL"}, ${o.merged ? `'${U(1, "b")}'` : "NULL"});`;
  const R = (id: number, region: string, sub: string | null, village: string | null) => `INSERT INTO regions VALUES (${id}, '${region}', ${sub ? `'${sub}'` : "NULL"}, ${village ? `'${village}'` : "NULL"});`;
  const E = (id: number, n: number, type: string, region?: number, election = 2022) =>
    `INSERT INTO politician_elections VALUES (${id}, '${U(n, "b")}', ${election}, '${type}', ${region ?? "NULL"}, 'elected');`;
  let cid = 0;
  const CC = (name: string, type: string, region: string, birth: number | null, o: { sub?: string; village?: string; election?: number } = {}) =>
    `INSERT INTO cec_candidates (id, election_id, election_type, region, sub_region, village, birth_year, name_norm) VALUES (${++cid}, ${o.election ?? 2022}, '${type}', '${region}', ${o.sub ? `'${o.sub}'` : "NULL"}, ${o.village ? `'${o.village}'` : "NULL"}, ${birth ?? "NULL"}, cec_name_key('${name}'));`;
  await d.exec([
    `INSERT INTO elections VALUES (2022, '2022-11-26'), (2026, '2026-11-28'), (2018, '2018-11-24');`,
    R(1, "台北市", null, null), R(2, "彰化縣", "北區", null), R(3, "彰化縣", "北區", "A里"), R(4, "雲林縣", "麥寮鄉第01選舉區", null), R(5, "台北市", "第01選舉區", null),
    // 1 唯一對上、出生年不同 → 訊號
    P(1, "王一", { birth: 1970 }), E(101, 1, "縣市長", 1), CC("王一", "縣市長", "台北市", 1971),
    // 2 唯一對上、出生年相同 → 無
    P(2, "王二", { birth: 1970 }), E(102, 2, "縣市長", 1), CC("王二", "縣市長", "台北市", 1970),
    // 3 同名兩筆 → 不算唯一，無
    P(3, "王三", { birth: 1960 }), E(103, 3, "縣市長", 1), CC("王三", "縣市長", "台北市", 1971), CC("王三", "縣市長", "台北市", 1972),
    // 4 沒有出生年 → 無
    P(4, "王四", { birth: null }), E(104, 4, "縣市長", 1), CC("王四", "縣市長", "台北市", 1971),
    // 5 已合併 → 無
    P(5, "王五", { birth: 1970, merged: true }), E(105, 5, "縣市長", 1), CC("王五", "縣市長", "台北市", 1971),
    // 6 鄉鎮市長：北區、中區各一位同名 → 靠鄉鎮分出唯一 → 訊號
    P(6, "王六", { birth: 1970 }), E(106, 6, "鄉鎮市長", 2), CC("王六", "鄉鎮市長", "彰化縣", 1980, { sub: "北區" }), CC("王六", "鄉鎮市長", "彰化縣", 1981, { sub: "中區" }),
    // 7 村里長：兩個里同名 → 靠村里分出唯一 → 訊號
    P(7, "王七", { birth: 1970 }), E(107, 7, "村里長", 3), CC("王七", "村里長", "彰化縣", 1990, { sub: "北區", village: "A里" }), CC("王七", "村里長", "彰化縣", 1991, { sub: "北區", village: "B里" }),
    // 8 臺／台、沒有 regions 列、用人物自己的縣市 → 訊號
    P(8, "王八", { birth: 1970, region: "臺北市" }), E(108, 8, "縣市長"), CC("王八", "縣市長", "台北市", 1975),
    // 9 縣市不同 → 無
    P(9, "王九", { birth: 1970 }), E(109, 9, "縣市長", 1), CC("王九", "縣市長", "新北市", 1975),
    // 10 縣市議員：不套鄉鎮條件，兩個選舉區各一位同名 → 兩筆 → 無
    P(10, "王十", { birth: 1970 }), E(110, 10, "縣市議員", 5), CC("王十", "縣市議員", "台北市", 1975, { sub: "第01選舉區" }), CC("王十", "縣市議員", "台北市", 1976, { sub: "第02選舉區" }),
    // 11 鄉鎮市民代表：「麥寮鄉第01選舉區」去掉選舉區只比鄉鎮 → 名冊「麥寮鄉第02選舉區」也對上 → 訊號
    P(11, "王甲", { birth: 1970 }), E(111, 11, "鄉鎮市民代表", 4), CC("王甲", "鄉鎮市民代表", "雲林縣", 1985, { sub: "麥寮鄉第02選舉區" }),
    // 12 尾端拉丁拼音：人物寫「伍麗華Saidhai」、名冊 name_norm 是「伍麗華」 → 訊號
    P(12, "伍麗華Saidhai", { birth: 1970 }), E(112, 12, "縣市長", 1), CC("伍麗華", "縣市長", "台北市", 1975),
    // 13 這一屆名冊裡根本沒有這屆的資料 → 無
    P(13, "王丙", { birth: 1970 }), E(113, 13, "縣市長", 1, 2018),
    // 14 同一個人在別屆同名但屆別不同 → 無
    P(14, "王丁", { birth: 1970 }), E(114, 14, "縣市長", 1), CC("王丁", "縣市長", "台北市", 1975, { election: 2026 }),
    // 15 選舉種類不同 → 無
    P(15, "王戊", { birth: 1970 }), E(115, 15, "縣市長", 1), CC("王戊", "縣市議員", "台北市", 1975),
  ].join("\n"));
  return d;
}
const sigDiff = async (d: PGlite) => {
  const [r] = (await d.query<{ n: string; a: string; b: string }>(`SELECT (SELECT count(*) FROM old_sig()) AS n,
    (SELECT count(*) FROM (SELECT * FROM old_sig() EXCEPT ALL SELECT * FROM new_sig()) x) AS a,
    (SELECT count(*) FROM (SELECT * FROM new_sig() EXCEPT ALL SELECT * FROM old_sig()) y) AS b`)).rows;
  return { n: Number(r.n), oldOnly: Number(r.a), newOnly: Number(r.b) };
};

Deno.test("S9 signals：新定義只換訊號 ① 的寫法（其餘四個訊號與最後的 SELECT 一字不動）", async () => {
  const prev = await latestFn("candidacy_owner_mismatch_signals", MIG);
  const cur = fnText(SQL, "candidacy_owner_mismatch_signals");
  const cutPrev = prev.indexOf("  cec AS (");
  const cutCur = cur.indexOf("  -- 20261019010000");
  const tailPrev = prev.slice(prev.indexOf("  SELECT x.id, 'cec_birth_year'"));
  const tailCur = cur.slice(cur.indexOf("  SELECT x.id, 'cec_birth_year'"));
  assertEquals(prev.slice(0, cutPrev), cur.slice(0, cutCur));
  assertEquals(tailPrev, tailCur);
  assert(!cur.replace(/--[^\n]*/g, "").includes("election_result_cec_matches("), "訊號 ① 不再呼叫 election_result_cec_matches");
});

Deno.test("S10 signals：舊定義（呼叫 election_result_cec_matches）與新定義（整批連接）在合成資料上逐筆相同", async () => {
  const d = await sigDb();
  const r = await sigDiff(d);
  assertEquals(r, { n: 6, oldOnly: 0, newOnly: 0 }, "訊號 ① 應有 1、6、7、8、11、12 共六筆");
  const ids = (await d.query<{ politician_election_id: number }>(`SELECT politician_election_id FROM old_sig() ORDER BY 1`)).rows.map((x) => x.politician_election_id);
  assertEquals(ids, [101, 106, 107, 108, 111, 112]);
  await d.close();
});

Deno.test("S11 signals 還原驗證：把新定義改壞一處，S10 的比對必須變紅", async () => {
  const bad: Array<[string, (s: string) => string]> = [
    ["拿掉『唯一對上』", (s) => mutate(s, "    HAVING count(*) = 1\n", "")],
    ["拿掉鄉鎮條件", (s) => mutate(s, "AND (x.town IS NULL OR regexp_replace(COALESCE(cc.sub_region, ''), '(第[0-9]+)?選舉區$', '') = x.town)", "")],
    ["拿掉村里條件", (s) => mutate(s, "AND (x.village IS NULL OR cc.village = x.village)", "")],
    ["不比縣市", (s) => mutate(s, "AND cc.region = x.county AND cc.name_norm = x.nn", "AND cc.name_norm = x.nn")],
    ["不比選舉種類", (s) => mutate(s, "cc.election_id = x.election_id AND cc.election_type = x.election_type", "cc.election_id = x.election_id")],
    ["不比屆別", (s) => mutate(s, "cc.election_id = x.election_id AND cc.election_type = x.election_type", "cc.election_type = x.election_type")],
    ["姓名鍵不做正規化", (s) => mutate(s, "cec_name_key(p.name) AS nn", "p.name AS nn")],
    ["縣市不做臺→台", (s) => mutate(s, "replace(COALESCE(r.region, p.region), '臺', '台') AS county,\n               cec_name_key", "COALESCE(r.region, p.region) AS county,\n               cec_name_key")],
  ];
  for (const [label, edit] of bad) {
    const d = await sigDb(edit);
    const r = await sigDiff(d);
    assert(r.oldOnly > 0 || r.newOnly > 0, `改壞（${label}）後比對應該紅，實際 ${JSON.stringify(r)}`);
    await d.close();
  }
});
