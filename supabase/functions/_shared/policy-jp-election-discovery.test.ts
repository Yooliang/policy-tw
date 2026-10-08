/**
 * 日本站「自動發現選舉」派工臂 election_discovery 的行為與守門測試
 * （policy-jp #41 ③、PR②；migration 20261009091000_policy_jp_election_discovery.sql＋20261009092000_policy_jp_term_expirations_r08.sql）。
 *
 * 只要 --allow-read。PGlite 上套 #479 的空 schema、tables migration、090000（派工）、091000（臂）、092000（總務省 3,571 列），
 * 資料庫裡沒有任何正見（public）物件。
 *
 *   a. 文字守門：091000 的總表＝090000 的版本剛好多一行 UNION 分支、activity_arm_names＝090000 的清單剛好多一個名字（機械替換比對＋還原驗證）；
 *      091000 只定義這三支函式、沒有 public. 引用、程式從不寫 elections
 *   b. 資料：3,571 列、一個出處；假時鐘 2026-10-09 跑 seed，正好 50 件（cap）、依満了日由早到晚、
 *      投票日一定落在 2027 年的最早五個團體是 2027-01-31 満了的那五個；seed 後 elections 仍是 0 列（程式不產生選舉資料）
 *   c. 有對應選舉就不是缺口：elections 有符合 lg_code＋職位＋日期落在 [満了日−120, 満了日+60] 的列（rejected 不算），下一輪 seed 收回（filled）；窗口兩端含頭含尾
 *   d. 規則開關與參數：停用規則→0 件、cap 改 10→10 件、include_uncertain=false、新的調查快照取代舊的
 *   e. 假時鐘：lead_days 兩端、満了日＋60 天的尾端；多個日期逐一跟 JS 獨立重算比對
 *   f. contributions 收 election 型別、擋 foo；election 的共識門檻（SQL 與 TS 對齊）：目標 3、退件 −3、不拿系統票
 *   g. term_expirations 的 CHECK、RLS 與權限；自我檢查（還原驗證）
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText } from "./arms-pglite.ts";
import { requiredAgree, rejectFloor, systemVoteEligible } from "./jp/consensus.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const SCHEMA_SQL = await read("20261008195000_policy_jp_schema.sql");
const TABLES_SQL = await read("20261009000000_policy_jp_tables.sql");
const MIG090 = await read("20261009090000_policy_jp_dispatch.sql");
const MIG091 = await read("20261009091000_policy_jp_election_discovery.sql");
const MIG092 = await read("20261009092000_policy_jp_term_expirations_r08.sql");

const ARM = "election_discovery";
const SOUMU_URL = "https://www.soumu.go.jp/main_content/001048082.xlsx";

function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 70)}`);
  return sql.replace(from, () => to);
}

async function freshDb(opts: { data?: boolean; mig091?: string } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
  await db.exec(SCHEMA_SQL);
  await db.exec(TABLES_SQL);
  await db.exec(MIG090);
  await db.exec(opts.mig091 ?? MIG091);
  if (opts.data !== false) await db.exec(MIG092);
  return db;
}

const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const count = async (db: PGlite, sql: string, params: unknown[] = []) => (await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM (${sql}) q`, params)).n;
async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}

// ---------------------------------------------------------------------------------------------
// 獨立重算：從 092000 的檔案文字解出 3,571 列，在 JS 裡照規則算一遍「今天該有哪些缺口」，跟 SQL 逐件比
// ---------------------------------------------------------------------------------------------
type Term = { lg: string; pref: string; name: string; kind: "head" | "assembly"; etype: string; end: string; head: string | null };
const ROW_RE = /^\s+\('(\d{6})', '([^']+)', '([^']+)', '(head|assembly)', '(\w+)', '(\d{4}-\d{2}-\d{2})', (NULL|'[^']*')\),?$/;
const TERMS: Term[] = MIG092.split("\n").flatMap((line) => {
  const m = ROW_RE.exec(line);
  return m ? [{ lg: m[1], pref: m[2], name: m[3], kind: m[4] as Term["kind"], etype: m[5], end: m[6], head: m[7] === "NULL" ? null : m[7].slice(1, -1) }] : [];
});

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const taskIdOf = (t: Term) => `auto:${ARM}:${t.end}:${t.lg}:${t.kind}`;
const byTerm = (a: Term, b: Term) => (a.end < b.end ? -1 : a.end > b.end ? 1 : a.lg < b.lg ? -1 : a.lg > b.lg ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);

type Params = { scopeFrom: string; lead: number; uncertain: boolean; cap: number; elections: Array<{ lg: string; etype: string; date: string }> };
const DEFAULTS: Params = { scopeFrom: "2027-01-01", lead: 180, uncertain: true, cap: 50, elections: [] };
function expectedGaps(today: string, o: Partial<Params> = {}, terms: Term[] = TERMS): Term[] {
  const p = { ...DEFAULTS, ...o };
  return terms
    .filter((t) =>
      addDays(t.end, -1) >= p.scopeFrom
      && (p.uncertain || addDays(t.end, -30) >= p.scopeFrom)
      && addDays(t.end, -p.lead) <= today
      && addDays(t.end, 60) >= today
      && !p.elections.some((e) => e.lg === t.lg && e.etype === t.etype && e.date >= addDays(t.end, -120) && e.date <= addDays(t.end, 60)))
    .sort(byTerm)
    .slice(0, p.cap);
}
const term = (pref: string, name: string, kind: Term["kind"]): Term => {
  const hits = TERMS.filter((t) => t.pref === pref && t.name === name && t.kind === kind);
  assertEquals(hits.length, 1, `${pref}${name} ${kind} 在資料裡應該剛好一列`);
  return hits[0];
};

/** 現在臂吐出來的 task_id（排序後） */
const armIds = async (db: PGlite): Promise<string[]> =>
  (await db.query<{ task_id: string }>(`SELECT task_id FROM policy_jp.contribution_auto_tasks_election_discovery() ORDER BY task_id`)).rows.map((r) => r.task_id);
const dispatchedIds = async (db: PGlite): Promise<string[]> =>
  (await db.query<{ task_id: string }>(`SELECT task_id FROM policy_jp.task_dispatches WHERE task_id LIKE 'auto:${ARM}:%' ORDER BY task_id`)).rows.map((r) => r.task_id);
/** 健康檢查（假時鐘本身會讓 clock_overridden 出現，那是測試的副作用，不算） */
const health = async (db: PGlite) =>
  (await db.query<{ check_name: string; subject: string }>(`SELECT check_name, subject FROM policy_jp.activity_health WHERE check_name NOT IN ('clock_overridden', 'queue_clock_overridden') ORDER BY 1, 2`)).rows;
const clock = (db: PGlite, day: string) => db.exec(`SET app.activity_today = '${day}'`);
const seed = (db: PGlite) => db.query(`SELECT policy_jp.seed_auto_task_queue()`);

// 為了建 elections 列（FK lg_code → local_governments）：只放這幾個測試要用的團體，代碼都是真的（含檢查碼）
async function addLg(db: PGlite, ...codes: string[]) {
  const defs: Record<string, [string, string, string, string]> = {
    "230006": ["prefecture", "230006", "愛知県", "あいちけん"],
    "232033": ["city", "230006", "一宮市", "いちのみやし"],
    "200000": ["prefecture", "200000", "長野県", "ながのけん"],
    "202088": ["city", "200000", "小諸市", "こもろし"],
  };
  for (const c of codes) {
    const [kind, pref, name, kana] = defs[c];
    await db.query(`INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [c, kind, pref, name, kana, `lg-${c}`]);
  }
}
let electionSeq = 0;
async function addElection(db: PGlite, lg: string, etype: string, date: string, status = "pending"): Promise<string> {
  const id = `${date}_${etype}_${lg}`;
  const level = etype === "governor" || etype === "pref_assembly" ? "regional" : "local";
  await db.query(
    `INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code, review_status)
     VALUES ($1, $2, $3, $4, 'regular', $5, $6, $7)`, [id, `テスト選挙 ${++electionSeq}`, date, etype, level, lg, status]);
  return id;
}

// ---------------------------------------------------------------------------------------------
// a. 文字守門
// ---------------------------------------------------------------------------------------------
Deno.test("文字守門：總表＝090000 的版本剛好多一行 election_discovery 的 UNION 分支（機械替換比對＋還原驗證）", () => {
  const FN = "policy_jp.contribution_auto_tasks_arms";
  const before = fnText(MIG090, FN);
  const after = fnText(MIG091, FN);
  const LAST_BRANCH = "  UNION ALL SELECT 'manual_open' AS arm, t.* FROM policy_jp.contribution_auto_tasks_manual(false) t\n";
  const ADDED = "  UNION ALL SELECT 'election_discovery' AS arm, t.* FROM policy_jp.contribution_auto_tasks_election_discovery() t\n";
  const expected = mutate(before, LAST_BRANCH, LAST_BRANCH + ADDED);
  assertEquals(after, expected, "091000 的總表除了多一行分支，其餘必須一字不改");
  // 剛好一行不同
  const a = before.split("\n"), b = after.split("\n");
  assertEquals(b.length, a.length + 1);
  assertEquals(b.filter((l) => !a.includes(l)), [ADDED.trimEnd()]);
  assertEquals(a.filter((l) => !b.includes(l)), []);

  // 還原驗證：091000 的版本改一個字元、拿掉那一行、換臂名、UNION ALL 改成 UNION，比對都會紅
  assertNotEquals(after.replace("AS $$", "AS $$ "), expected);
  assertNotEquals(after.replace(ADDED, ""), expected);
  assertNotEquals(after.replace("'election_discovery' AS arm", "'election_discovery2' AS arm"), expected);
  assertNotEquals(after.replace("UNION ALL SELECT 'election_discovery'", "UNION SELECT 'election_discovery'"), expected);
  assertNotEquals(after.replace("contribution_auto_tasks_election_discovery() t", "contribution_auto_tasks_manual(false) t"), expected);
  // 090000 那邊改一個字元，期望值跟著變，比對也會紅（兩邊都不能悄悄漂）
  assertNotEquals(mutate(before.replace("AS $$", "AS $$ "), LAST_BRANCH, LAST_BRANCH + ADDED), after);
});

Deno.test("文字守門：activity_arm_names＝090000 的清單剛好多 election_discovery 一個名字（還原驗證）", () => {
  const FN = "policy_jp.activity_arm_names";
  const before = fnText(MIG090, FN);
  const after = fnText(MIG091, FN);
  const expected = mutate(before, "    'manual_open'\n  ]::TEXT[]", "    'manual_open',\n    'election_discovery'\n  ]::TEXT[]");
  assertEquals(after, expected);
  assertNotEquals(after.replace("'election_discovery'", "'election_discover'"), expected);
  assertNotEquals(after.replace("'manual_visitor'", "'manual_visitors'"), expected);
  assertNotEquals(after.replace("AS $$", "AS $$ "), expected);
});

Deno.test("文字守門：091000 只定義這三支函式；沒有 public. 引用；程式從不寫 elections／local_governments", () => {
  const defined = [...MIG091.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, ["activity_arm_names", "contribution_auto_tasks_arms", "contribution_auto_tasks_election_discovery"]);
  const code = MIG091.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(code), "091000 不能引用 public.");
  assert(!/search_path\s*=\s*public/i.test(code));
  // 「程式不產生選舉資料」：臂與整份 migration 都沒有對 elections（或團體表）的 INSERT／UPDATE／DELETE
  assert(!/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+policy_jp\.(elections|local_governments|election_districts|election_milestones)\b/i.test(code));
  // 新臂是 LANGUAGE sql STABLE（唯讀），釘 search_path
  const arm = fnText(MIG091, "policy_jp.contribution_auto_tasks_election_discovery");
  assert(/LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp/.test(arm));
  assert(!/\b(INSERT|UPDATE|DELETE)\b/.test(arm.replace(/--[^\n]*/g, "")), "臂本體不能寫任何東西");
  // 092000 只寫出處與任期満了表
  const data = MIG092.replace(/--[^\n]*/g, "");
  const writes = [...data.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(policy_jp\.\w+)/gi)].map((m) => m[1]).sort();
  assertEquals(writes, ["policy_jp.sources", "policy_jp.term_expirations"]);
  assert(!/\bpublic\./.test(data));
});

Deno.test("套用：三支 migration 依序套用，臂名清單有三個、每個都有規則、健康檢查是空的；091000 套兩次都成功", async () => {
  const db = await freshDb();
  await db.exec(MIG091); // 第二次
  assertEquals((await one<{ x: string[] }>(db, `SELECT policy_jp.activity_arm_names() AS x`)).x, ["manual_visitor", "manual_open", ARM]);
  const rules = await db.query<{ activity: string; window_kind: string; params: Record<string, unknown>; enabled: boolean; priority: number | null }>(
    `SELECT activity, window_kind, params, enabled, priority FROM policy_jp.activity_rules ORDER BY activity`);
  assertEquals(rules.rows.map((r) => r.activity), [ARM, "manual_open", "manual_visitor", "priority:manual_visitor"], "規則只種一條，重跑不重複");
  const r = rules.rows[0];
  assertEquals([r.window_kind, r.enabled, r.priority], ["always", true, null]);
  assertEquals(r.params, { cap: 50, lead_days: 180, scope_from: "2027-01-01", include_uncertain: true });
  assertEquals((await db.query(`SELECT * FROM policy_jp.activity_health`)).rows.length, 0, "健康檢查正常是空的");
  // 092000 也能套兩次（ON CONFLICT DO NOTHING）
  await db.exec(MIG092);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.term_expirations`), 3571);
  await db.close();
});

// ---------------------------------------------------------------------------------------------
// b. 資料與 seed
// ---------------------------------------------------------------------------------------------
Deno.test("資料：3,571 列、as_of 2025-11-01、掛同一個出處；JS 解析的列跟資料庫逐列一致", async () => {
  assertEquals(TERMS.length, 3571, "JS 解析要抓到全部 3,571 列（少了＝正規式漏接，如名稱裡有單引號）");
  const db = await freshDb();
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.term_expirations`), 3571);
  assertEquals((await db.query(`SELECT DISTINCT as_of::TEXT AS d FROM policy_jp.term_expirations`)).rows, [{ d: "2025-11-01" }]);
  const src = await db.query<{ url: string; n: number }>(
    `SELECT s.url, count(*)::INT AS n FROM policy_jp.term_expirations t JOIN policy_jp.sources s ON s.id = t.source_id GROUP BY s.url`);
  assertEquals(src.rows, [{ url: SOUMU_URL, n: 3571 }]);
  const sourceRow = await one<{ source_kind: string; publisher: string; archive_url: string | null }>(db, `SELECT source_kind, publisher, archive_url FROM policy_jp.sources WHERE url = $1`, [SOUMU_URL]);
  assertEquals(sourceRow, { source_kind: "statistics", publisher: "総務省", archive_url: null });
  // 逐列比對（含 head_name）
  const db_ = (await db.query<{ lg_code: string; office_kind: string; election_type: string; term_end: string; head_name: string | null; lg_name: string; pref_name: string }>(
    `SELECT lg_code, office_kind, election_type, term_end::TEXT, head_name, lg_name, pref_name FROM policy_jp.term_expirations ORDER BY term_end, lg_code, office_kind`)).rows;
  const js = [...TERMS].sort(byTerm);
  assertEquals(db_.map((r) => `${r.term_end}|${r.lg_code}|${r.office_kind}|${r.election_type}|${r.head_name ?? ""}|${r.lg_name}|${r.pref_name}`),
    js.map((t) => `${t.end}|${t.lg}|${t.kind}|${t.etype}|${t.head ?? ""}|${t.name}|${t.pref}`));
  await db.close();
});

Deno.test("seed（假時鐘 2026-10-09）：election_discovery 正好 50 件（cap）、満了日由早到晚、前五個確定在範圍內的是 2027-01-31 満了那五個；elections 仍是 0 列", async () => {
  const db = await freshDb();
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.elections`), 0);
  await clock(db, "2026-10-09");
  await seed(db);

  const want = expectedGaps("2026-10-09");
  assertEquals(want.length, 50);
  assert(expectedGaps("2026-10-09", { cap: 100000 }).length > 50, "cap 要真的有擋到東西，不然這個測試什麼都沒證明");
  const got = await dispatchedIds(db);
  assertEquals(got.length, 50, "cap 50");
  assertEquals(got, want.map(taskIdOf).sort(), "派出的 50 件＝依満了日、代碼、種類排序的前 50 件");
  // task_id 的文字排序＝満了日排序（task_id 把満了日放在前面）
  assertEquals([...got], [...want].sort(byTerm).map(taskIdOf));

  const rows = await db.query<{ task_id: string; task_type: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[]; reward: number; region: string; opened_by: Record<string, unknown>; priority: number }>(
    `SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region, opened_by, priority FROM policy_jp.task_dispatches WHERE task_id LIKE 'auto:${ARM}:%' ORDER BY task_id`);
  for (const r of rows.rows) {
    assertEquals(r.task_type, ARM);
    assertEquals(r.reward, 2);
    assertEquals(r.opened_by.arm, ARM);
    assertEquals(r.priority, 2, "沒有選舉的臂＝預設層（中段）");
    assert(r.what_we_need.includes("選挙管理委員会"));
    assertEquals(r.hint_sources.length, 3);
    assertEquals(r.hint_sources[2], "総務省 任期満了に関する調");
  }
  // 最早満了日在前面
  const ends = rows.rows.map((r) => r.target.term_end as string);
  assertEquals([...ends].sort(), ends, "満了日單調遞增");
  assertEquals(ends[0], want[0].end);
  assert(ends[0] >= "2027-01-02", "T−1 要在 2027-01-01 之後");

  // 「確定在範圍」＝投票日窗口 [満了日−30, 満了日−1] 整段都在 2027-01-01 以後：満了日 ≥ 2027-01-31
  const certain = rows.rows.filter((r) => r.target.certainly_in_scope === true).map((r) => r.target);
  assert(certain.length >= 5);
  const first = certain.slice(0, 5);
  assert(first.every((t) => t.term_end === "2027-01-31"), "最早確定在範圍內的満了日是 2027-01-31");
  assert(certain[5].term_end !== "2027-01-31" && (certain[5].term_end as string) > "2027-01-31", "2027-01-31 満了的剛好五個");
  const FIVE = [
    term("北海道", "西興部村", "head"), term("長野県", "小諸市", "assembly"), term("愛知県", "一宮市", "head"),
    term("福岡県", "筑紫野市", "head"), term("福岡県", "筑前町", "assembly"),
  ];
  assertEquals(FIVE.map((t) => t.end), Array(5).fill("2027-01-31"));
  assertEquals(TERMS.filter((t) => t.end === "2027-01-31").length, 5, "資料裡 2027-01-31 満了的就這五個");
  assertEquals(first.map((t) => `${t.lg_code}:${t.office_kind}`).sort(), FIVE.map((t) => `${t.lg}:${t.kind}`).sort());
  assertEquals(FIVE.map((t) => t.lg).sort(), ["015628", "202088", "232033", "402176", "404471"]);
  // 不確定的（満了日 < 2027-01-31，投票日可能在 2026 年）也開了，標 certainly_in_scope=false
  const uncertain = rows.rows.filter((r) => r.target.certainly_in_scope === false);
  assert(uncertain.length > 0 && uncertain.length + certain.length === 50);
  assert(uncertain.every((r) => (r.target.term_end as string) < "2027-01-31"));

  // 一宮市長：內容抽查
  const ichi = rows.rows.find((r) => r.task_id === `auto:${ARM}:2027-01-31:232033:head`)!;
  assertEquals(ichi.region, "愛知県");
  assertEquals(ichi.target, {
    lg_code: "232033", pref_name: "愛知県", lg_name: "一宮市", office_kind: "head", election_type: "mayor", term_end: "2027-01-31",
    vote_window_from: "2027-01-01", vote_window_until: "2027-01-30", certainly_in_scope: true, scope_from: "2027-01-01",
    term_source_id: (await one<{ id: number }>(db, `SELECT id::INT AS id FROM policy_jp.sources WHERE url = $1`, [SOUMU_URL])).id, term_as_of: "2025-11-01",
  });
  assert(ichi.what_we_need.includes("一宮市の長の任期は 2027-01-31 に満了します"));
  assert(ichi.what_we_need.includes("contribution_type=election") && ichi.what_we_need.includes("outcome=not_found"));
  // 議會那一筆
  const komoro = rows.rows.find((r) => r.task_id === `auto:${ARM}:2027-01-31:202088:assembly`)!;
  assertEquals(komoro.target.election_type, "muni_assembly");
  assert(komoro.what_we_need.includes("小諸市の議会議員の任期は"));

  // 程式不產生選舉資料：seed 之後 elections 仍是 0 列，其他選舉表也沒動
  for (const t of ["elections", "local_governments", "election_districts", "election_milestones"]) {
    assertEquals(await count(db, `SELECT 1 FROM policy_jp.${t}`), 0, `${t} 應該還是空的`);
  }
  // 出生紀錄：50 件 opened，沒有 closed
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.gap_events WHERE task_id LIKE 'auto:${ARM}:%' AND event = 'opened'`)).n, 50);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.gap_events WHERE task_id LIKE 'auto:${ARM}:%' AND event <> 'opened'`)).n, 0);
  // 可重跑：派工列不增不減
  await seed(db);
  assertEquals((await dispatchedIds(db)).length, 50);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.gap_events WHERE task_id LIKE 'auto:${ARM}:%'`)).n, 50);
  // 公開的 /next 讀得到（contribution_auto_tasks 只回 auto: 列）
  const pub = await db.query<{ task_id: string }>(`SELECT task_id FROM policy_jp.contribution_auto_tasks(NULL, NULL, 100, '') WHERE task_type = '${ARM}'`);
  assertEquals(pub.rows.length, 50);
  await db.close();
});

// ---------------------------------------------------------------------------------------------
// c. 有對應選舉＝不是缺口
// ---------------------------------------------------------------------------------------------
Deno.test("對應的選舉進來（elections 一列）→ 下一輪 seed 收回該缺口（filled）、第 51 名遞補；rejected 不算；改回 rejected 缺口回來（reopened）", async () => {
  const db = await freshDb();
  await addLg(db, "230006", "232033", "200000", "202088");
  await clock(db, "2026-10-09");
  await seed(db);
  const ICHI = `auto:${ARM}:2027-01-31:232033:head`;
  const base = await dispatchedIds(db);
  assert(base.includes(ICHI));

  const eid = await addElection(db, "232033", "mayor", "2027-01-24");
  // 選舉進來的當下派工列還在（seed 才對帳）
  assert((await dispatchedIds(db)).includes(ICHI));
  await seed(db);
  const after = await dispatchedIds(db);
  assert(!after.includes(ICHI), "一宮市長的缺口收回");
  assertEquals(after.length, 50, "cap 空出來的位置由第 51 名遞補");
  const fifty1 = expectedGaps("2026-10-09", { elections: [{ lg: "232033", etype: "mayor", date: "2027-01-24" }] });
  assertEquals(after, fifty1.map(taskIdOf).sort());
  const closed = await one<{ reason: string }>(db, `SELECT reason FROM policy_jp.gap_events WHERE task_id = $1 AND event = 'closed'`, [ICHI]);
  assertEquals(closed.reason, "filled", "臂已經算不出來＝filled");
  // （長與議會各算各的：種類不同不互相收，見下一個測試）
  // 程式沒有因此改 elections（還是只有我們插的那一列）
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.elections`), 1);

  // rejected 的選舉不算數 → 缺口回來
  await db.query(`UPDATE policy_jp.elections SET review_status = 'rejected' WHERE id = $1`, [eid]);
  await seed(db);
  assert((await dispatchedIds(db)).includes(ICHI), "被退件的選舉不算有選舉");
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.gap_events WHERE task_id = $1 AND event = 'reopened'`, [ICHI])).n, 1);
  assertEquals((await dispatchedIds(db)).length, 50);
  // published 也算數
  await db.query(`UPDATE policy_jp.elections SET review_status = 'published' WHERE id = $1`, [eid]);
  await seed(db);
  assert(!(await dispatchedIds(db)).includes(ICHI));
  await db.close();
});

Deno.test("對應選舉的比對：種類要一致（長與議會各算各的）、lg_code 要一致、日期窗口 [満了日−120, 満了日+60] 含頭含尾", async () => {
  const db = await freshDb();
  await addLg(db, "230006", "232033", "200000", "202088");
  await clock(db, "2026-10-09");
  const ICHI = `auto:${ARM}:2027-01-31:232033:head`;
  const KOMORO = `auto:${ARM}:2027-01-31:202088:assembly`;
  const lo = addDays("2027-01-31", -120); // 2026-10-03
  const hi = addDays("2027-01-31", 60); // 2027-04-01
  assertEquals([lo, hi], ["2026-10-03", "2027-04-01"]);
  const has = async (id: string) => (await armIds(db)).includes(id);
  const withElection = async (lg: string, etype: string, date: string, status: string, fn: () => Promise<void>) => {
    const id = await addElection(db, lg, etype, date, status);
    try { await fn(); } finally { await db.query(`DELETE FROM policy_jp.elections WHERE id = $1`, [id]); }
  };
  assert(await has(ICHI) && await has(KOMORO), "起點：兩個缺口都在");

  // 日期窗口
  for (const [date, closes] of [[addDays(lo, -1), false], [lo, true], ["2027-01-24", true], [hi, true], [addDays(hi, 1), false]] as const) {
    await withElection("232033", "mayor", date, "pending", async () => {
      assertEquals(!(await has(ICHI)), closes, `選舉日 ${date}：${closes ? "收回" : "不收回"}`);
    });
  }
  // 種類：一宮市的市長選舉不會收掉議會缺口，反之亦然（小諸市：議會缺口 muni_assembly）
  await withElection("202088", "mayor", "2027-01-24", "pending", async () => {
    assert(await has(KOMORO), "小諸市長選舉不收小諸市議會缺口");
  });
  await withElection("202088", "muni_assembly", "2027-01-24", "pending", async () => {
    assert(!(await has(KOMORO)), "小諸市議會選舉收掉小諸市議會缺口");
  });
  // lg_code：別的團體的同種類選舉、同一個縣的知事選舉都不算
  await withElection("230006", "governor", "2027-01-24", "pending", async () => {
    assert(await has(ICHI), "愛知県知事選挙不收一宮市長缺口");
  });
  await withElection("202088", "mayor", "2027-01-24", "pending", async () => {
    assert(await has(ICHI), "小諸市長選挙不收一宮市長缺口");
  });
  await withElection("232033", "mayor", "2027-01-24", "rejected", async () => {
    assert(await has(ICHI), "rejected 不算");
  });
  await db.close();
});

// ---------------------------------------------------------------------------------------------
// d. 規則開關與參數
// ---------------------------------------------------------------------------------------------
Deno.test("規則：停用→seed 後 0 件（全部收回）；重新啟用→回來；cap 改 10→10 件（最早的 10 件）；改回 50→50 件", async () => {
  const db = await freshDb();
  await clock(db, "2026-10-09");
  await seed(db);
  assertEquals((await dispatchedIds(db)).length, 50);

  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = false WHERE activity = '${ARM}'`);
  assertEquals((await armIds(db)).length, 0, "停用的規則＝臂不吐東西");
  await seed(db);
  assertEquals(await dispatchedIds(db), [], "停用後沒有 election_discovery 任務");
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.gap_events WHERE task_id LIKE 'auto:${ARM}:%' AND event = 'closed'`)).n, 50);
  // 規則在、只是停用：不是『沒有規則』，但健康檢查會提醒「全部停用＝整類不派」（要停就用覆寫 closed 留下理由）
  assertEquals(await health(db), [{ check_name: "activity_all_rules_disabled", subject: ARM }]);
  // 總表不會丟錯（規則存在但停用是正常的關）
  await db.query(`SELECT count(*) FROM policy_jp.contribution_auto_tasks_arms()`);

  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = true WHERE activity = '${ARM}'`);
  await seed(db);
  assertEquals((await dispatchedIds(db)).length, 50);

  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{cap}', '10') WHERE activity = '${ARM}'`);
  await seed(db);
  const ten = await dispatchedIds(db);
  assertEquals(ten.length, 10);
  assertEquals(ten, expectedGaps("2026-10-09", { cap: 10 }).map(taskIdOf).sort(), "最早満了的 10 件");

  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{cap}', '50') WHERE activity = '${ARM}'`);
  await seed(db);
  assertEquals((await dispatchedIds(db)).length, 50);
  await db.close();
});

Deno.test("規則參數：include_uncertain=false 只留確定在範圍內的；lead_days、scope_from 可調", async () => {
  const db = await freshDb();
  await clock(db, "2026-10-09");
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{include_uncertain}', 'false') WHERE activity = '${ARM}'`);
  const ids = await armIds(db);
  assertEquals(ids, expectedGaps("2026-10-09", { uncertain: false }).map(taskIdOf).sort());
  assert(ids.length > 0 && ids.length <= 50);
  const certain = await db.query<{ c: boolean }>(`SELECT (target->>'certainly_in_scope')::BOOLEAN AS c FROM policy_jp.contribution_auto_tasks_election_discovery()`);
  assert(certain.rows.every((r) => r.c === true));
  assert(expectedGaps("2026-10-09", { uncertain: true }).some((t) => t.end < "2027-01-31"), "include_uncertain=true 時確實有不確定的，這個比較才有意義");

  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(jsonb_set(params, '{include_uncertain}', 'true'), '{lead_days}', '30') WHERE activity = '${ARM}'`);
  assertEquals(await armIds(db), expectedGaps("2026-10-09", { lead: 30 }).map(taskIdOf).sort());
  await clock(db, "2027-01-01");
  assertEquals(await armIds(db), expectedGaps("2027-01-01", { lead: 30 }).map(taskIdOf).sort());

  // scope_from 往後挪一年（範圍改成 2028 年以後投票）：2027 年満了的全都不算
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(jsonb_set(params, '{lead_days}', '180'), '{scope_from}', '"2028-01-01"') WHERE activity = '${ARM}'`);
  await clock(db, "2027-08-01");
  assertEquals(await armIds(db), expectedGaps("2027-08-01", { scopeFrom: "2028-01-01" }).map(taskIdOf).sort());
  assert(expectedGaps("2027-08-01", { scopeFrom: "2028-01-01" }).every((t) => t.end >= "2028-01-02"));
  await db.close();
});

Deno.test("調查快照：同一個團體有新的 as_of 就以新的為準（舊的満了日不再出現）", async () => {
  const db = await freshDb();
  await clock(db, "2026-10-09");
  const ICHI = `auto:${ARM}:2027-01-31:232033:head`;
  assert((await armIds(db)).includes(ICHI));
  const sid = (await one<{ id: number }>(db, `SELECT id::INT AS id FROM policy_jp.sources WHERE url = $1`, [SOUMU_URL])).id;
  // 一宮市長 2026-11-01 現在：辭職、改成 2027-03-15 満了（新快照）
  await db.query(
    `INSERT INTO policy_jp.term_expirations (lg_code, pref_name, lg_name, office_kind, election_type, term_end, head_name, as_of, source_id)
     VALUES ('232033', '愛知県', '一宮市', 'head', 'mayor', '2027-03-15', '新任 太郎', '2026-11-01', $1)`, [sid]);
  const ids = await armIds(db);
  assert(!ids.includes(ICHI), "舊快照的満了日不再用");
  // 同一個快照內同團體同種類只能一列
  await assertRejects(() => db.query(
    `INSERT INTO policy_jp.term_expirations (lg_code, pref_name, lg_name, office_kind, election_type, term_end, head_name, as_of, source_id)
     VALUES ('232033', '愛知県', '一宮市', 'head', 'mayor', '2027-04-01', NULL, '2026-11-01', $1)`, [sid]), Error, "term_expirations_one_per_snapshot");
  // 取新快照的值當期望：把 JS 資料換成新快照再比一次
  const swapped = TERMS.map((t) => (t.lg === "232033" && t.kind === "head" ? { ...t, end: "2027-03-15", head: "新任 太郎" } : t));
  assertEquals(ids, expectedGaps("2026-10-09", {}, swapped).map(taskIdOf).sort());
  await db.close();
});

// ---------------------------------------------------------------------------------------------
// e. 假時鐘
// ---------------------------------------------------------------------------------------------
Deno.test("假時鐘 2026-06-01：lead_days 180 還沒到任何 2027 年満了的團體 → 0 件（seed 也是 0）", async () => {
  const db = await freshDb();
  await clock(db, "2026-06-01");
  assertEquals(await armIds(db), []);
  assertEquals(expectedGaps("2026-06-01"), [], "JS 獨立重算也是 0：満了日 ≤ 2026-11-28 的都在範圍外（T−1 < 2027-01-01），範圍內的都還沒到 180 天");
  await seed(db);
  assertEquals(await dispatchedIds(db), []);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.gap_events WHERE task_id LIKE 'auto:${ARM}:%'`), 0);
  await db.close();
});

Deno.test("假時鐘邊界：最早的範圍內満了日在 満了日−180 當天才出現、満了日+60 的隔天消失", async () => {
  const db = await freshDb();
  const inScope = TERMS.filter((t) => addDays(t.end, -1) >= "2027-01-01").sort(byTerm);
  const first = inScope[0];
  assertEquals(first.end, "2027-01-07", "資料裡範圍內最早的満了日（改資料時這裡會提醒重看）");
  const id = taskIdOf(first);
  const has = async (day: string) => { await clock(db, day); return (await armIds(db)).includes(id); };
  assertEquals(await has(addDays(first.end, -181)), false, "180 天還沒到");
  assertEquals(await has(addDays(first.end, -180)), true, "第 180 天當天就開（含頭）");
  assertEquals(await has(first.end), true);
  assertEquals(await has(addDays(first.end, 60)), true, "満了日+60 當天還在（含尾）");
  assertEquals(await has(addDays(first.end, 61)), false, "満了日+60 的隔天消失");
  // 範圍外的（満了日 −1 在 2027-01-01 之前）不管哪一天都不出現
  const outScope = TERMS.filter((t) => addDays(t.end, -1) < "2027-01-01");
  assert(outScope.length > 0);
  const sample = outScope.sort(byTerm).at(-1)!; // 範圍外最晚的一個：2027-01-01 満了（含 T−1 = 2026-12-31）或更早
  for (const day of [addDays(sample.end, -180), addDays(sample.end, -30), sample.end]) {
    await clock(db, day);
    assert(!(await armIds(db)).includes(taskIdOf(sample)), `${sample.end} 満了的在範圍外（${day}）`);
  }
  await db.close();
});

Deno.test("假時鐘：跨多個日期，臂的輸出逐件等於 JS 獨立重算（含 cap、排序、満了日+60 出清）", async () => {
  const db = await freshDb();
  const days = ["2026-07-11", "2026-10-09", "2026-12-31", "2027-01-15", "2027-01-31", "2027-03-08", "2027-03-09", "2027-06-30", "2027-12-01", "2028-06-01", "2029-02-01", "2030-01-01"];
  let nonEmpty = 0;
  for (const day of days) {
    await clock(db, day);
    const want = expectedGaps(day).map(taskIdOf).sort();
    assertEquals(await armIds(db), want, `假時鐘 ${day}`);
    if (want.length > 0) nonEmpty++;
    assert(want.length <= 50);
  }
  assert(nonEmpty >= 8, "多數日期都該有缺口，不然這個比較太空");
  // 之後再也沒有了：最晚的満了日 +60 天之後
  const last = [...TERMS].sort(byTerm).at(-1)!;
  await clock(db, addDays(last.end, 61));
  assertEquals(await armIds(db), []);
  await db.close();
});

// ---------------------------------------------------------------------------------------------
// f. 交件型別 election 與共識
// ---------------------------------------------------------------------------------------------
Deno.test("contributions 收 election、擋 foo；原有三種照收", async () => {
  const db = await freshDb({ data: false });
  const ins = (type: string, n: number) => db.query(
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash)
     VALUES ($1, '{}', ARRAY['https://example.jp/a'], 'agent-' || $2::TEXT, 'ip-' || $2::TEXT, 'h' || $2::TEXT)`, [type, n]);
  let n = 0;
  for (const t of ["no_change", "task_suggestion", "correction", "election"]) await ins(t, ++n);
  await assertRejects(() => ins("foo", ++n), Error, "contributions_contribution_type_check");
  await assertRejects(() => ins("candidacy", ++n), Error, "contributions_contribution_type_check");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contributions`), 4);
  // 約束名字沒變、只有一條
  const cons = await db.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'policy_jp.contributions'::regclass AND contype = 'c' AND conname LIKE '%contribution_type%'`);
  assertEquals(cons.rows.map((r) => r.conname), ["contributions_contribution_type_check"]);
  await db.close();
});

Deno.test("election 的共識：SQL 目標 3、退件 −3、不拿系統票、不要兩個網段（跟 TS 對齊）；三票同意→verified（停在 verified，不落庫）", async () => {
  const db = await freshDb({ data: false });
  const sql = async (q: string) => Object.values((await one<Record<string, unknown>>(db, q)))[0];
  assertEquals(await sql(`SELECT policy_jp.contribution_required_agree('election', '{}', ARRAY['https://example.jp/a']) AS x`), requiredAgree("election"));
  assertEquals(await sql(`SELECT policy_jp.contribution_required_agree('election', '{}', ARRAY['https://example.jp/a']) AS x`), 3);
  assertEquals(await sql(`SELECT policy_jp.contribution_reject_floor('election') AS x`), rejectFloor("election"));
  assertEquals(await sql(`SELECT policy_jp.contribution_reject_floor('election') AS x`), 3);
  assertEquals(await sql(`SELECT policy_jp.system_vote_eligible('election') AS x`), systemVoteEligible("election"));
  assertEquals(await sql(`SELECT policy_jp.system_vote_eligible('election') AS x`), false);
  assertEquals(await sql(`SELECT policy_jp.contribution_needs_two_ips('election', '{}') AS x`), false);
  // 其他型別一起對一遍，確認 TS 與 SQL 沒有各說各話
  for (const t of ["no_change", "task_suggestion", "correction", "election"]) {
    assertEquals(await sql(`SELECT policy_jp.contribution_required_agree('${t}', '{}', ARRAY[]::TEXT[]) AS x`), requiredAgree(t), `required_agree(${t})`);
    assertEquals(await sql(`SELECT policy_jp.contribution_reject_floor('${t}') AS x`), rejectFloor(t), `reject_floor(${t})`);
    assertEquals(await sql(`SELECT policy_jp.system_vote_eligible('${t}') AS x`), systemVoteEligible(t), `system_vote_eligible(${t})`);
  }

  const c = (await one<{ id: string }>(db,
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash)
     VALUES ('election', '{"lg_code":"232033","election_type":"mayor","election_reason":"regular","election_date":"2027-01-24"}', ARRAY['https://example.jp/a'],
             'auto:${ARM}:2027-01-31:232033:head', 'author', 'author-ip', 'h-election') RETURNING id`)).id;
  // Jev 的 supported 系統票不調它的門檻（election 不在 system_vote_eligible 裡）
  await db.query(`INSERT INTO policy_jp.jev_decisions (subject_type, subject_id, question, choice, probability, model, state)
    VALUES ('contribution', $1, 'source_support', 'supported', 0.99, 'typesafe/jev-1.13-20260917', '{}')`, [c]);
  assertEquals((await one<{ n: number }>(db, `SELECT policy_jp.contribution_effective_agree($1) AS n`, [c])).n, 3, "系統票不調 election 的門檻");
  const vote = (who: string) => db.query(`INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, agent_name, verifier_ip_hash) VALUES ($1, 'agree', $2, 'ip-' || $2)`, [c, who]);
  const st = async () => (await one<{ status: string; score: number; target_score: number }>(db, `SELECT status, score, target_score FROM policy_jp.contributions WHERE id = $1`, [c]));
  await vote("v1"); await vote("v2");
  assertEquals((await st()).status, "pending", "兩票不夠（跟 no_change 不一樣）");
  await vote("v3");
  const done = await st();
  assertEquals([done.status, done.score, done.target_score], ["verified", 3, 3]);
  // 通過後不落庫：applied 之前停在 verified，elections 沒有任何列
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.elections`), 0);
  await db.close();
});

// ---------------------------------------------------------------------------------------------
// g. term_expirations 的約束與權限、自我檢查
// ---------------------------------------------------------------------------------------------
Deno.test("term_expirations：CHECK（種類對應、head_name 只給長、代碼檢查碼、出處必填）與 RLS／權限", async () => {
  const db = await freshDb({ data: false });
  const sid = (await one<{ id: number }>(db, `INSERT INTO policy_jp.sources (url, origin) VALUES ('https://www.soumu.go.jp/x.xlsx', 'test') RETURNING id::INT AS id`)).id;
  const ins = (o: Partial<Record<string, unknown>>) => {
    const r = { lg: "232033", kind: "head", etype: "mayor", end: "2027-01-31", head: "田中", asof: "2025-11-01", sid, ...o };
    return db.query(
      `INSERT INTO policy_jp.term_expirations (lg_code, pref_name, lg_name, office_kind, election_type, term_end, head_name, as_of, source_id)
       VALUES ($1, '愛知県', '一宮市', $2, $3, $4, $5, $6, $7)`, [r.lg, r.kind, r.etype, r.end, r.head, r.asof, r.sid]);
  };
  await ins({}); // ok
  await ins({ kind: "assembly", etype: "muni_assembly", head: null }); // ok
  await assertRejects(() => ins({ lg: "232034" }), Error, "term_expirations_lg_code_check"); // 檢查碼不對（正確是 3）
  await assertRejects(() => ins({ kind: "assembly", etype: "muni_assembly", head: "誰", asof: "2026-11-01" }), Error, "term_expirations_head_name");
  await assertRejects(() => ins({ kind: "head", etype: "muni_assembly", asof: "2026-11-01" }), Error, "term_expirations_kind_type");
  await assertRejects(() => ins({ kind: "assembly", etype: "mayor", head: null, asof: "2026-11-01" }), Error, "term_expirations_kind_type");
  await assertRejects(() => ins({ etype: "national_lower", asof: "2026-11-01" }), Error, "term_expirations_election_type_check");
  await assertRejects(() => ins({ sid: null, asof: "2026-11-01" }), Error, "source_id");
  await assertRejects(() => ins({ sid: 999999, asof: "2026-11-01" }), Error, "violates foreign key");
  await assertRejects(() => ins({ end: null, asof: "2026-11-01" }), Error, "term_end");

  // RLS 開著；anon／authenticated 只能讀、不能寫、不能執行臂；service_role 全權
  assert((await one<{ r: boolean }>(db, `SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'policy_jp.term_expirations'::regclass`)).r);
  for (const role of ["anon", "authenticated"]) {
    assertEquals((await asRole<{ n: number }>(db, role, `SELECT count(*)::INT AS n FROM policy_jp.term_expirations`))[0].n, 2, `${role} 讀得到`);
    await assertRejects(() => asRole(db, role, `DELETE FROM policy_jp.term_expirations`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `INSERT INTO policy_jp.term_expirations (lg_code, pref_name, lg_name, office_kind, election_type, term_end, as_of, source_id) VALUES ('232033','a','b','head','mayor','2027-01-31','2026-01-01',${sid})`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT * FROM policy_jp.contribution_auto_tasks_election_discovery()`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT * FROM policy_jp.contribution_auto_tasks_arms()`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT policy_jp.activity_arm_names()`), Error, "permission denied");
  }
  await clock(db, "2026-10-09");
  assertEquals((await asRole<{ n: number }>(db, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_election_discovery()`))[0].n, 2, "service_role 能執行臂（上面插的兩列満了日 2027-01-31，都在窗口內）");
  await db.close();
});

Deno.test("自我檢查（還原驗證）：規則缺 cap、規則被刪、拿掉 RLS、給 anon 執行權限，重跑 091000 都會失敗", async () => {
  // 規則缺 cap：臂會整支回 0 列（無聲消失）→ 重跑 migration 時自我檢查要擋
  let db = await freshDb({ data: false });
  await db.exec(`UPDATE policy_jp.activity_rules SET params = params - 'cap' WHERE activity = '${ARM}'`);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_election_discovery()`)).n, 0);
  await assertRejects(() => db.exec(MIG091), Error, "election_discovery 的規則缺");
  await db.close();

  // 規則被刪：這支臂的參數就存在規則裡，所以規則一沒有、臂就整支不吐東西（不會像一般臂那樣由總表 RAISE：沒有列就沒有東西可以問規則）。
  // 守在 activity_health 的 arm_without_rule；重跑 091000 會把規則種回來。
  db = await freshDb();
  await clock(db, "2026-10-09");
  assertEquals((await armIds(db)).length, 50);
  await db.exec(`DELETE FROM policy_jp.activity_rules WHERE activity = '${ARM}'`);
  assertEquals(await armIds(db), []);
  assertEquals(await health(db), [{ check_name: "arm_without_rule", subject: ARM }]);
  await db.exec(MIG091);
  assertEquals((await armIds(db)).length, 50, "重跑 migration 把規則種回來");
  assertEquals(await health(db), []);
  await db.close();

  // 拿掉 RLS（重跑原檔會重新 ENABLE，所以把 migration 裡那行拿掉再跑）
  db = new PGlite();
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
  await db.exec(SCHEMA_SQL); await db.exec(TABLES_SQL); await db.exec(MIG090);
  const noRls = mutate(MIG091, "ALTER TABLE policy_jp.term_expirations ENABLE ROW LEVEL SECURITY;\n", "");
  await assertRejects(() => db.exec(noRls), Error, "沒開 RLS");
  await db.close();

  // 給 anon 執行權限（schema 的預設權限已經對 PUBLIC 收回了，所以不是「拿掉 REVOKE」，而是把那行換成 GRANT 給 anon）
  db = new PGlite();
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
  await db.exec(SCHEMA_SQL); await db.exec(TABLES_SQL); await db.exec(MIG090);
  const grantAnon = mutate(MIG091, "REVOKE EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_election_discovery() FROM PUBLIC, anon, authenticated;\n",
    "GRANT EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_election_discovery() TO anon;\n");
  await assertRejects(() => db.exec(grantAnon), Error, "派工臂不該給 anon 執行");
  await db.close();
});
