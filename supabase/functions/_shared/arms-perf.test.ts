/**
 * 派工總表的效能整理（2026-10-08，docs/PLAN-task-activation.md 第 11 節；migration 20261008180000_arms_perf.sql）。
 *
 * 目標：contribution_auto_tasks_arms() 一次約 4.6 秒、seed_auto_task_queue() 每 10 分鐘跑一次約 7 秒；在「輸出逐件不變」的前提下變快。
 * 這一支只重寫四支臂的本體（任務內容、順序、規則、優先層一個字不動），不動總表 arms()、seed、規則表，也不建索引：
 *   mayor_policies    — is_2026_mayor_candidate(p.id) 逐人呼叫（1.6 萬次）→ 原樣寫成 EXISTS（半連接）；等票數整張 contributions 掃一次（原本每位候選人各掃一次）
 *   roster_cec_gap    — ours／marked 加 MATERIALIZED：不加時 matched 的 EXISTS 被複製進四個聚合與一個過濾，ours（約 75 毫秒）被算了五次
 *   owner_mismatch    — 同名比對的姓名鍵全部人物算一次（pk，MATERIALIZED）；原本每筆缺口掃全部人物並重算兩次姓名鍵
 *   policy_elements   — cand 加 MATERIALIZED：缺的要素陣列與主要出處不再每個輸出欄位各算一次
 *
 * 只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。
 *   A. 文字層：每支新定義＝緊接在前的那一版（與正式庫 pg_get_functiondef 一字不差，2026-10-08 實測）加上固定幾處機械式替換
 *   B. PGlite（行為層）：mayor_policies、owner_mismatch 是真的改了寫法，用合成資料跑「舊定義 vs 新定義」逐件相等；另做還原驗證（改壞新定義，必須變紅）
 *
 * 正式庫快照版的「逐件不變」見 scripts/arms-perf-parity.ts（不進 CI：要連正式庫）；PR 說明附結果。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const MIG = "20261008180000_arms_perf.sql";
const SQL = await readMig(MIG);
const count = (s: string, sub: string) => s.split(sub).length - 1;

type Edit = [from: string, to: string];
const MAYOR = "contribution_auto_tasks_mayor_policies";
const CEC_GAP = "contribution_auto_tasks_roster_cec_gap";
const OWNER = "contribution_auto_tasks_owner_mismatch";
const ELEMENTS = "contribution_auto_tasks_policy_elements";

const EDITS: Record<string, Edit[]> = {
  [MAYOR]: [
    [
      "  WITH m AS (\n    SELECT p.id, p.name, p.party, p.region,",
      "  -- 等票中的 2026 政見提交數：整張 contributions 掃一次、依人物分組；原本每位候選人各掃一次（payload 沒有索引，每次約 3 毫秒）\n" +
        "  WITH queued_by AS MATERIALIZED (\n" +
        "    SELECT c.payload->>'politician_id' AS pid, COUNT(*) AS n FROM contributions c\n" +
        "     WHERE c.contribution_type = 'policy' AND c.status IN ('pending', 'verified')\n" +
        "       AND c.payload->>'politician_id' IS NOT NULL\n" +
        "       AND COALESCE(NULLIF(c.payload->>'election_id', ''), '2026') = '2026'\n" +
        "     GROUP BY 1\n" +
        "  ),\n" +
        "  m AS MATERIALIZED (\n    SELECT p.id, p.name, p.party, p.region,",
    ],
    [
      "           (SELECT COUNT(*) FROM contributions c\n             WHERE c.contribution_type = 'policy' AND c.status IN ('pending', 'verified')\n               AND c.payload->>'politician_id' = p.id::TEXT\n               AND COALESCE(NULLIF(c.payload->>'election_id', ''), '2026') = '2026') AS queued,\n",
      "           COALESCE((SELECT qb.n FROM queued_by qb WHERE qb.pid = p.id::TEXT), 0) AS queued,\n",
    ],
    [
      "    WHERE p.merged_into IS NULL AND is_2026_mayor_candidate(p.id)\n",
      "    WHERE p.merged_into IS NULL\n" +
        "      -- is_2026_mayor_candidate(p.id) 的本體原樣寫在這裡：當純量函式逐人呼叫要掃全部人物（約 1.6 萬次），寫成 EXISTS 才會變成半連接\n" +
        "      AND EXISTS (SELECT 1 FROM politician_elections pe\n" +
        "                   WHERE pe.politician_id = p.id\n" +
        "                     AND pe.election_id = 2026 AND pe.election_type = '縣市長'\n" +
        "                     AND pe.candidacy_status IN ('declared', 'filed'))\n",
    ],
  ],
  [CEC_GAP]: [
    ["  ours AS (\n    SELECT DISTINCT pe.election_id", "  ours AS MATERIALIZED (\n    SELECT DISTINCT pe.election_id"],
    ["  marked AS (\n    SELECT c.*,", "  marked AS MATERIALIZED (\n    SELECT c.*,"],
  ],
  [OWNER]: [
    [
      "     GROUP BY g.politician_election_id\n  )\n  SELECT 'auto:candidacy_owner_mismatch:' || pe.id,",
      "     GROUP BY g.politician_election_id\n  ),\n" +
        "  -- 同名比對用的姓名鍵：全部人物算一次放著；原本每一筆缺口都掃全部人物、每人重算兩次姓名鍵（約 1.6 萬次正規式 × 每筆）\n" +
        "  pk AS MATERIALIZED (\n" +
        "    SELECT q.id, q.name, q.birth_year, q.party, q.region, cec_name_key(q.name) AS nk FROM politicians q WHERE q.merged_into IS NULL\n" +
        "  )\n" +
        "  SELECT 'auto:candidacy_owner_mismatch:' || pe.id,",
    ],
    [
      "               FROM (SELECT q.* FROM politicians q\n                      WHERE q.merged_into IS NULL AND q.id <> p.id AND cec_name_key(q.name) = cec_name_key(p.name)\n",
      "               FROM (SELECT q.* FROM pk q\n                      WHERE q.id <> p.id AND q.nk = (SELECT cec_name_key(p.name))\n",
    ],
  ],
  [ELEMENTS]: [
    ["  cand AS (\n    SELECT pl.id AS policy_id, pl.title,", "  cand AS MATERIALIZED (\n    SELECT pl.id AS policy_id, pl.title,"],
  ],
};
/** 緊接在這支 migration 之前定義該函式的 migration（與正式庫 pg_get_functiondef 一字不差，2026-10-08 實測） */
const PREV_MIG: Record<string, string> = {
  [MAYOR]: "20260923000005_mayor_policies_2026.sql",
  [CEC_GAP]: "20261006100000_withdrawn_filing_qualified_wording.sql",
  [OWNER]: "20261006220000_candidacy_read_side.sql",
  [ELEMENTS]: "20261008000002_election_bulletin_columns.sql",
};
const NAMES = Object.keys(EDITS);

const apply = (prev: string, edits: Edit[]) => edits.reduce((s, [a, b]) => mutate(s, a, b), prev);
const PREV: Record<string, string> = {};
const NEW: Record<string, string> = {};
for (const n of NAMES) {
  PREV[n] = await latestFn(n, MIG);
  NEW[n] = fnText(SQL, n);
}
const isMechanical = (n: string, fn: string) => {
  try {
    return apply(PREV[n], EDITS[n]) === fn;
  } catch {
    return false;
  }
};

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 前一版是對的：緊接在這支之前的定義各是預期的那支 migration，這支是最後一版（中間有人插一版，抄的底就過期）", async () => {
  for (const n of NAMES) {
    const defining: string[] = [];
    for (const f of await migrationNames()) if ((await readMig(f)).includes(`CREATE OR REPLACE FUNCTION ${n}(`)) defining.push(f);
    const i = defining.indexOf(MIG);
    assert(i > 0, `${n}：這支要在重新定義的清單裡`);
    assertEquals(defining[i - 1], PREV_MIG[n], `${n}：前一版變了——要以最新的為底重做機械式替換`);
    assertEquals(defining.at(-1), MIG, `${n}：這支之後有人再定義了，這支就不是現行版`);
  }
});

Deno.test("A2 每支新定義＝前一版加固定幾處機械式替換，其餘一字不差（簽名、回傳型別、語言、穩定度都不動）", () => {
  for (const n of NAMES) {
    assert(isMechanical(n, NEW[n]), `${n} 不是前一版的機械式替換`);
    assertEquals(NEW[n].split("\n").slice(0, 3).join("\n"), PREV[n].split("\n").slice(0, 3).join("\n"), `${n} 簽名變了`);
    for (const [a] of EDITS[n]) assertEquals(count(PREV[n], a), 1, `${n}：要替換的字串在前一版必須剛好出現一次`);
  }
});

Deno.test("A3 這一支只重寫這四支臂：不動總表、seed、raw、規則表，也不建表、不建索引、不寫資料", () => {
  const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_0-9]+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, [...NAMES].sort());
  assert(!/CREATE (UNIQUE )?INDEX|CREATE TABLE|ALTER TABLE|\bDROP |INSERT INTO|\bUPDATE |DELETE FROM|\bTRUNCATE\b/.test(code), "沒有索引、沒有結構變更、沒有資料寫入");
  assert(!/contribution_auto_tasks_arms|seed_auto_task_queue|rebalance_queue|activity_rules|election_result_cec_matches\s*\(|candidacy_owner_mismatch_signals\s*\(\)\s*(RETURNS|LANGUAGE)/.test(code.replace(/FROM candidacy_owner_mismatch_signals\(\) g/, "")), "不重寫總表、seed、規則表與兩支共用函式");
});

Deno.test("A4 還原驗證（文字層）：偷改一處、少一處替換、換成別的寫法，A2 的判斷都要紅", () => {
  // 每一處替換各自還原：少了任何一處都不是「前一版＋這幾處」
  for (const n of NAMES) {
    EDITS[n].forEach(([a, b], i) => assert(!isMechanical(n, mutate(NEW[n], b, a)), `${n} 第 ${i + 1} 處還原後應該不再等於「前一版＋全部替換」`));
  }
  assert(!isMechanical(MAYOR, mutate(NEW[MAYOR], "pe.candidacy_status IN ('declared', 'filed')", "pe.candidacy_status IN ('declared', 'filed', 'elected')")), "偷改候選人狀態");
  assert(!isMechanical(MAYOR, mutate(NEW[MAYOR], "AND pe.election_id = 2026", "AND pe.election_id = 2022")), "偷改屆別");
  assert(!isMechanical(MAYOR, mutate(NEW[MAYOR], "COALESCE((SELECT qb.n FROM queued_by qb WHERE qb.pid = p.id::TEXT), 0) AS queued", "(SELECT qb.n FROM queued_by qb WHERE qb.pid = p.id::TEXT) AS queued")), "漏掉 COALESCE");
  assert(!isMechanical(OWNER, mutate(NEW[OWNER], "q.nk = (SELECT cec_name_key(p.name))", "q.nk = cec_name_key(q.name)")), "偷改同名條件");
  assert(!isMechanical(CEC_GAP, NEW[CEC_GAP].replace("ours AS MATERIALIZED", "ours AS")), "拿掉 MATERIALIZED");
  assert(!isMechanical(ELEMENTS, NEW[ELEMENTS].replace("cand AS MATERIALIZED", "cand AS")), "拿掉 MATERIALIZED");
});

Deno.test("A5 寫進臂裡的 is_2026_mayor_candidate 本體，跟函式現行定義是同一個條件（函式改了，這裡要跟著改）", async () => {
  const f = await latestFn("is_2026_mayor_candidate");
  for (const frag of ["pe.politician_id = p_politician_id", "pe.election_id = 2026 AND pe.election_type = '縣市長'", "pe.candidacy_status IN ('declared', 'filed')"]) {
    assert(f.includes(frag), `is_2026_mayor_candidate 的條件變了：${frag}`);
  }
  for (const frag of ["pe.politician_id = p.id", "pe.election_id = 2026 AND pe.election_type = '縣市長'", "pe.candidacy_status IN ('declared', 'filed')"]) {
    assert(NEW[MAYOR].includes(frag), `mayor_policies 裡的條件不見了：${frag}`);
  }
});

Deno.test("A6 MATERIALIZED 是必要的：沒有它們，四處效能整理就退回原樣（逐一拿掉都要被抓到）", () => {
  assertEquals(count(NEW[MAYOR], "AS MATERIALIZED ("), 2);
  assertEquals(count(NEW[CEC_GAP], "AS MATERIALIZED ("), 2);
  assertEquals(count(NEW[OWNER], "AS MATERIALIZED ("), 1);
  assertEquals(count(NEW[ELEMENTS], "AS MATERIALIZED ("), 1);
  const mayorCode = NEW[MAYOR].split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!mayorCode.includes("is_2026_mayor_candidate("), "mayor_policies 不再逐人呼叫函式");
});

// ============================================================
// B. PGlite（行為層）：mayor_policies、owner_mismatch 真的改了寫法 → 舊定義 vs 新定義，合成資料逐件相等
// ============================================================
const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const asOld = (fn: string, name: string, to: string) => fn.replace(`CREATE OR REPLACE FUNCTION ${name}(`, `CREATE OR REPLACE FUNCTION ${to}(`);
const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";

async function newDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, party text, region text, birth_year integer, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL, election_id integer NOT NULL, election_type text, region_id integer, candidacy_status text);
    CREATE TABLE policies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), politician_id uuid NOT NULL, removed_at timestamptz, election_id integer, category text);
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, payload jsonb);
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE cec_candidates (id integer PRIMARY KEY, election_id integer, election_type text, region text, sub_region text, village text, birth_year integer, elected boolean, name_norm text);
    CREATE TABLE task_checks (task_id text, outcome text);
    CREATE TABLE _sig (politician_election_id integer, signal text, detail text);
    CREATE FUNCTION candidacy_owner_mismatch_signals() RETURNS TABLE(politician_election_id integer, signal text, detail text) LANGUAGE sql STABLE AS $$ SELECT * FROM _sig $$;
  `);
  await db.exec(await latestFn("cec_name_norm"));
  await db.exec(await latestFn("cec_name_key"));
  await db.exec(await latestFn("is_2026_mayor_candidate"));
  return db;
}
const rows = async (db: PGlite, sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;

/** 舊、新兩支函式（舊的改名成 old_x）在同一份資料上的輸出：逐件雙向 EXCEPT 都是 0 */
async function diff(db: PGlite, oldFn: string, newFn: string): Promise<{ n: number; oldOnly: number; newOnly: number }> {
  const [r] = await rows(db, `SELECT (SELECT count(*) FROM ${oldFn}()) AS n,
    (SELECT count(*) FROM (SELECT * FROM ${oldFn}() EXCEPT ALL SELECT * FROM ${newFn}()) a) AS old_only,
    (SELECT count(*) FROM (SELECT * FROM ${newFn}() EXCEPT ALL SELECT * FROM ${oldFn}()) b) AS new_only`);
  return { n: Number(r.n), oldOnly: Number(r.old_only), newOnly: Number(r.new_only) };
}

async function mayorDb(mutateNew?: (s: string) => string): Promise<PGlite> {
  const db = await newDb();
  await db.exec(asOld(PREV[MAYOR], MAYOR, "old_mayor"));
  await db.exec(asOld((mutateNew ?? ((s) => s))(NEW[MAYOR]), MAYOR, "new_mayor"));
  const P = (n: number, name: string, extra = "NULL") => `INSERT INTO politicians (id, name, party, region, merged_into) VALUES ('${U(n)}', '${name}', '黨', '台北市', ${extra});`;
  const PE = (id: number, n: number, type: string, status: string) => `INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status) VALUES (${id}, '${U(n)}', 2026, '${type}', '${status}');`;
  const POL = (n: number, election: number | "NULL", k: number, cat = "'交通'", removed = "NULL") =>
    Array.from({ length: k }, () => `INSERT INTO policies (politician_id, election_id, category, removed_at) VALUES ('${U(n)}', ${election}, ${cat}, ${removed});`).join("\n");
  const C = (n: number | null, status: string, election: string | null, type = "policy") =>
    `INSERT INTO contributions (contribution_type, status, payload) VALUES ('${type}', '${status}', '${JSON.stringify({ ...(n === null ? {} : { politician_id: U(n) }), ...(election === null ? {} : { election_id: election }) })}'::jsonb);`;
  await db.exec([
    P(1, "甲"), PE(1, 1, "縣市長", "declared"), POL(1, 2026, 2), POL(1, 2022, 1), C(1, "pending", "2026"),
    P(2, "乙"), PE(2, 2, "縣市長", "filed"), POL(2, 2026, 5), // 滿 5 筆：不派
    P(3, "丙"), PE(3, 3, "縣市長", "filed"), POL(3, 2026, 2),
    C(3, "verified", ""), C(3, "pending", "2026"), C(3, "pending", "2022"), C(3, "rejected", "2026"), C(3, "pending", "2026", "correction"), // 只有前兩筆算等票
    P(4, "丁"), PE(4, 4, "縣市長", "declared"), // 沒有任何政見：raw 臂派，這支不派
    P(5, "戊"), PE(5, 5, "縣市長", "considering"), POL(5, 2026, 1), // 不是候選人狀態
    P(6, "己", `'${U(1)}'`), PE(6, 6, "縣市長", "filed"), POL(6, 2026, 1), // 已合併
    P(7, "庚"), PE(7, 7, "縣市議員", "filed"), POL(7, 2026, 1), // 不是縣市長
    P(8, "辛"), PE(8, 8, "縣市長", "filed"), POL(8, 2022, 2), POL(8, 2026, 2, "'交通'", "now()"), // 只有舊屆與已移除的 2026
    P(9, "壬"), PE(9, 9, "縣市長", "filed"), POL(9, 2026, 1, "'教育'"), POL(9, 2026, 1, "'交通'"), C(null, "pending", "2026"), C(2, "pending", "2026"),
  ].join("\n"));
  return db;
}

Deno.test("B1 mayor_policies：舊定義與新定義在合成資料上逐件相同（含等票數的各種邊界）", async () => {
  const db = await mayorDb();
  const d = await diff(db, "old_mayor", "new_mayor");
  // 派的人：甲(2 筆＋1 筆等票)、丙(2 筆＋2 筆等票：verified 的空字串屆別與 pending 的 2026 算，2022／rejected／別的型別不算)、辛(2026 的已移除，只有舊屆)、壬(2 筆)
  assertEquals(d.n, 4, "合成資料要真的派出四位，不然比對是空對空");
  assertEquals(d, { n: 4, oldOnly: 0, newOnly: 0 });
  const [row] = await rows(db, `SELECT (target->>'queued')::int AS queued, target->>'policies_now' AS now FROM new_mayor() WHERE task_id = 'auto:policy_missing:${U(3)}'`);
  assertEquals([row.queued, row.now], [2, "2"]);
  await db.close();
});

Deno.test("B2 mayor_policies 還原驗證：把新定義改壞一處，B1 的比對必須變紅", async () => {
  const bad: Array<[string, (s: string) => string]> = [
    ["候選人狀態多放一種", (s) => mutate(s, "pe.candidacy_status IN ('declared', 'filed')", "pe.candidacy_status IN ('declared', 'filed', 'considering')")],
    ["等票漏掉 verified", (s) => mutate(s, "AND c.status IN ('pending', 'verified')\n       AND c.payload->>'politician_id' IS NOT NULL", "AND c.status IN ('pending')\n       AND c.payload->>'politician_id' IS NOT NULL")],
    ["空字串屆別不當 2026", (s) => mutate(s, "COALESCE(NULLIF(c.payload->>'election_id', ''), '2026') = '2026'\n     GROUP BY", "COALESCE(c.payload->>'election_id', '2026') = '2026'\n     GROUP BY")],
    ["沒有等票的人 queued 變 NULL（漏 COALESCE）", (s) => mutate(s, "COALESCE((SELECT qb.n FROM queued_by qb WHERE qb.pid = p.id::TEXT), 0) AS queued", "(SELECT qb.n FROM queued_by qb WHERE qb.pid = p.id::TEXT) AS queued")],
    ["漏掉已合併的排除", (s) => mutate(s, "    WHERE p.merged_into IS NULL\n      -- is_2026", "    WHERE true\n      -- is_2026")],
  ];
  for (const [label, edit] of bad) {
    const db = await mayorDb(edit);
    const d = await diff(db, "old_mayor", "new_mayor");
    assert(d.oldOnly > 0 || d.newOnly > 0, `改壞（${label}）後比對應該紅，實際 ${JSON.stringify(d)}`);
    await db.close();
  }
});

async function ownerDb(mutateNew?: (s: string) => string): Promise<PGlite> {
  const db = await newDb();
  await db.exec(asOld(PREV[OWNER], OWNER, "old_owner"));
  await db.exec(asOld((mutateNew ?? ((s) => s))(NEW[OWNER]), OWNER, "new_owner"));
  const P = (n: number, name: string, birth: string, merged = "NULL") => `INSERT INTO politicians (id, name, party, region, birth_year, merged_into) VALUES ('${U(n)}', '${name}', '黨${n}', '台北市', ${birth}, ${merged});`;
  await db.exec([
    // 王小明四位同名（含空白寫法、出生年空白）、一位已合併的同名（不能出現）、一位拼音尾巴不同的不算
    P(1, "王小明", "1980"), P(2, "王小明", "1975"), P(3, "王小明", "NULL"), P(4, "王 小明", "1990"), P(5, "王小明", "1960", `'${U(1)}'`),
    P(6, "李大華", "1970"), P(7, "李大華", "1971"), P(8, "趙四", "1950"), P(9, "Alice Chen", "1985"), P(10, "alice  chen", "1986"),
    `INSERT INTO regions (id, region, sub_region, village) VALUES (1, '臺北市', '大安區', NULL);`,
    `INSERT INTO politician_elections (id, politician_id, election_id, election_type, region_id, candidacy_status) VALUES
       (101, '${U(1)}', 2022, '縣市議員', 1, 'elected'), (102, '${U(1)}', 2026, '縣市議員', 1, 'filed'),
       (103, '${U(6)}', 2024, '立法委員', NULL, 'not_elected'), (104, '${U(8)}', 2026, '縣市長', 1, 'filed'),
       (105, '${U(9)}', 2022, '縣市議員', 1, 'elected'), (106, '${U(3)}', 2026, '縣市長', 1, 'filed');`,
    `INSERT INTO cec_candidates (id, election_id, election_type, region, sub_region, village, birth_year, elected, name_norm) VALUES
       (1, 2022, '縣市議員', '台北市', '第01選舉區', NULL, 1979, true, '王小明'), (2, 2022, '縣市議員', '台北市', '第02選舉區', NULL, 1981, false, '王小明'),
       (3, 2024, '立法委員', '台北市', '第01選區', NULL, 1971, false, '李大華');`,
    `INSERT INTO _sig VALUES (101, 'cec_birth_year', '中選會名冊出生年不同'), (101, 'county_jump', '換縣市'), (102, 'county_jump', '換縣市'),
       (103, 'cec_birth_year', '中選會名冊出生年不同'), (104, 'submitted_region', '交件縣市不符'), (105, 'county_jump', '換縣市'), (106, 'county_jump', '換縣市');`,
    // 已經有人交了改掛、已確認是同一人的不派
    `INSERT INTO contributions (contribution_type, status, payload) VALUES ('reassign_candidacy', 'pending', '{"politician_election_id": "102"}'::jsonb);`,
    `INSERT INTO task_checks VALUES ('auto:candidacy_owner_mismatch:105', 'confirmed');`,
  ].join("\n"));
  return db;
}

Deno.test("B3 owner_mismatch：舊定義與新定義在合成資料上逐件相同（含 same_name 的排序、已合併者排除、空白與大小寫寫法）", async () => {
  const db = await ownerDb();
  const d = await diff(db, "old_owner", "new_owner");
  assertEquals(d.n, 4, "合成資料要真的派出四筆（102 已有人交改掛、105 已確認是同一人，不派）");
  assertEquals(d, { n: 4, oldOnly: 0, newOnly: 0 });
  const [r] = await rows(db, `SELECT jsonb_array_length(target->'same_name') AS n, target->'same_name'->0->>'birth_year' AS first, target->'same_name'->2->>'birth_year' AS last
                                FROM new_owner() WHERE task_id = 'auto:candidacy_owner_mismatch:101'`);
  // 王小明(1) 的同名：1975、1990、出生年空白排最後；已合併的 1960 不出現
  assertEquals([Number(r.n), r.first, r.last], [3, "1975", null]);
  await db.close();
});

Deno.test("B4 owner_mismatch 還原驗證：把新定義改壞一處，B3 的比對必須變紅", async () => {
  const bad: Array<[string, (s: string) => string]> = [
    ["同名比對忘了排除自己", (s) => mutate(s, "WHERE q.id <> p.id AND q.nk", "WHERE q.nk")],
    ["已合併的人物也列入同名", (s) => mutate(s, "FROM politicians q WHERE q.merged_into IS NULL\n  )", "FROM politicians q\n  )")],
    ["排序改成出生年大的在前", (s) => mutate(s, "ORDER BY q.birth_year NULLS LAST LIMIT 10", "ORDER BY q.birth_year DESC NULLS LAST LIMIT 10")],
    ["姓名鍵不做正規化", (s) => mutate(s, "cec_name_key(q.name) AS nk", "q.name AS nk")],
  ];
  for (const [label, edit] of bad) {
    const db = await ownerDb(edit);
    const d = await diff(db, "old_owner", "new_owner");
    assert(d.oldOnly > 0 || d.newOnly > 0, `改壞（${label}）後比對應該紅，實際 ${JSON.stringify(d)}`);
    await db.close();
  }
});

Deno.test("B5 合成資料自己要夠狠：舊定義在 B1／B3 的資料上不是空輸出（不然上面的比對什麼都驗不出來）", async () => {
  const m = await mayorDb();
  assert((await rows(m, `SELECT 1 FROM old_mayor()`)).length >= 3);
  await m.close();
  const o = await ownerDb();
  assert((await rows(o, `SELECT 1 FROM old_owner() WHERE jsonb_array_length(target->'same_name') > 0`)).length >= 2);
  await o.close();
  void COLS;
});
