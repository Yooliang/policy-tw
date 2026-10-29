/**
 * 名單清查（roster_check）改讀名冊對帳結果（migration 20261019120000 第 7 段，#678 第一階段）：
 * 只在有「系統對不上」的單位才派，任務帶出那幾個人；沒有對帳資料的單位照舊派。
 *
 * 守門：
 *   1. 前一版是對的：raw 的前一版是 20261019110000、村里長臂的前一版是 20261011310000，而且新 migration 是兩支函式的最後一版；
 *   2. 新定義＝前一版加四處機械替換：反向替換回去逐字等於前一版（簽名、task_id、reward、hint_sources、其他臂與條件都沒動）；
 *   3. 行為：roster_check 那一段原文（raw）與整支村里長臂在 PGlite 上跑——有對不上的派（target.reconcile、說明帶出名字）、全對上／只剩系統會建的不派、
 *      沒有對帳資料的照舊派、其餘條件（嘗試冷卻、重查天數）照舊壓；
 *   4. 還原驗證：把閘門拿掉、把「沒資料照舊派」拿掉、把 needs_agent 反過來，指定的情境必須轉紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, migrationNames, mutate, readMig } from "./arms-pglite.ts";
import { buildReconcileDb, MIG_NAME } from "./roster-reconcile-pglite.ts";

const RAW = "contribution_auto_tasks_raw";
const VIL = "contribution_auto_tasks_roster_villages";
const PREV_RAW_MIG = "20261019110000_pledge_gap_2026.sql";
const PREV_VIL_MIG = "20261011310000_campaign_election_arms_2.sql";

const NEW_MIG = await readMig(MIG_NAME);
const NEW_RAW = fnText(NEW_MIG, RAW);
const NEW_VIL = fnText(NEW_MIG, VIL);
const PREV_RAW = fnText(await readMig(PREV_RAW_MIG), RAW);
const PREV_VIL = fnText(await readMig(PREV_VIL_MIG), VIL);

type Edit = [string, string];
const RAW_EDITS: Edit[] = [
  ["  LEFT JOIN filed_out fo ON fo.election_id = s.election_id AND fo.election_type = s.election_type AND fo.region = l.name\n",
    "  LEFT JOIN filed_out fo ON fo.election_id = s.election_id AND fo.election_type = s.election_type AND fo.region = l.name\n" +
    "  -- 名冊對帳（roster_reconcile_units；沒有資料＝NULL＝照舊派）\n" +
    "  LEFT JOIN LATERAL (SELECT roster_reconcile_unit(s.election_id, s.election_type, l.name) AS u) rr ON TRUE\n"],
  ["                            'official_list_published', CURRENT_DATE >= s.list_announced_on),\n         l.name || ' ' || s.election_id || ' ' || s.election_type\n",
    "                            'official_list_published', CURRENT_DATE >= s.list_announced_on,\n" +
    "                            'reconcile', rr.u),\n         l.name || ' ' || s.election_id || ' ' || s.election_type\n"],
  ["           || COALESCE(o.n, 0) || ' 筆。名單上有、我們沒有的，每一位用 candidacy 型別補一筆。'\n",
    "           || COALESCE(o.n, 0) || ' 筆。名單上有、我們沒有的，每一位用 candidacy 型別補一筆。'\n" +
    "           || roster_reconcile_text(rr.u)\n"],
  ["    AND (rc.last_attempt_without_count IS NULL\n         OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)\n  UNION ALL\n  SELECT 'auto:policy_election_missing:'",
    "    AND (rc.last_attempt_without_count IS NULL\n         OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)\n" +
    "    -- 名冊對帳：登記彙總表有的單位，只在有「系統對不上」的人時才派（唯一對上的由系統建）；沒有對帳資料的單位照舊派\n" +
    "    AND (rr.u IS NULL OR (rr.u->>'needs_agent')::BOOLEAN)\n" +
    "  UNION ALL\n  SELECT 'auto:policy_election_missing:'"],
];
const VIL_EDITS: Edit[] = [
  ["  LEFT JOIN ours o ON o.election_id = s.election_id AND o.county = t.county AND o.township = t.township\n",
    "  LEFT JOIN ours o ON o.election_id = s.election_id AND o.county = t.county AND o.township = t.township\n" +
    "  -- 名冊對帳（roster_reconcile_units；沒有資料＝NULL＝照舊派）\n" +
    "  LEFT JOIN LATERAL (SELECT roster_reconcile_unit(s.election_id, '村里長', t.county, t.township) AS u) rr ON TRUE\n"],
  ["                            'official_list_published', CURRENT_DATE >= s.list_announced_on),\n         t.county || t.township",
    "                            'official_list_published', CURRENT_DATE >= s.list_announced_on,\n" +
    "                            'reconcile', rr.u),\n         t.county || t.township"],
  ["           || COALESCE(o.n, 0) || ' 筆比對。名單上有、我們沒有的，每位用 candidacy 型別補一筆",
    "           || COALESCE(o.n, 0) || ' 筆比對。' || roster_reconcile_text(rr.u) || '名單上有、我們沒有的，每位用 candidacy 型別補一筆"],
  ["  WHERE (rc.last_checked IS NULL OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)\n",
    "  -- 名冊對帳：登記彙總表有的鄉鎮市區，只在有「系統對不上」的人時才派；沒有對帳資料的照舊派\n" +
    "  WHERE (rr.u IS NULL OR (rr.u->>'needs_agent')::BOOLEAN)\n" +
    "    AND (rc.last_checked IS NULL OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)\n"],
];
const reverse = (fn: string, edits: Edit[]) => edits.reduce((s, [from, to]) => mutate(s, to, from), fn);
const headerOf = (fn: string) => fn.slice(0, fn.indexOf("$function$") >= 0 ? fn.indexOf("$function$") : fn.indexOf("$$"));

// 村里長臂在 2026-10-29 又被 20261029030000 重定義（名冊批次上限 150 → 80，只換說明文字一句）：它成了村里長臂的最後一版，
// 本檔的 20261019120000 是它的前一版；raw 的最後一版仍是 20261019120000。
const VIL_CAP_MIG = "20261029030000_roster_batch_cap_80.sql";
const CAP_FROM = "一次最多 150 筆（整批都是 candidacy";
const CAP_TO = "一次最多 80 筆（整批都是 candidacy";

Deno.test("A1 前一版是對的：兩支臂的新定義緊接著現行版；raw 的最後一版是本 migration，村里長臂的最後一版是其後的 20261029030000（之後有人改了，要以最新那版為底重做）", async () => {
  for (const [fn, prev, last] of [[RAW, PREV_RAW_MIG, MIG_NAME], [VIL, PREV_VIL_MIG, VIL_CAP_MIG]] as const) {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}(`)) defining.push(n);
    assertEquals(defining.at(-1), last, `${fn} 的最後一版應該是 ${last}`);
    const i = defining.indexOf(MIG_NAME);
    assert(i > 0, `${MIG_NAME} 要在 ${fn} 的定義清單裡`);
    assertEquals(defining[i - 1], prev, `${fn} 的前一版應該是 ${prev}；有人在中間改了，要以那一版為底重做`);
  }
  // 村里長臂：本 migration 之後只允許 20261029030000 這一支
  const vilDefs: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${VIL}(`)) vilDefs.push(n);
  assertEquals(vilDefs.slice(vilDefs.indexOf(MIG_NAME) + 1), [VIL_CAP_MIG]);
});

Deno.test("A3 20261029030000 的村里長臂＝緊接在前的 20261019120000 定義，只有說明裡的批次上限一句（150 → 80）不同", async () => {
  const capFn = fnText(await readMig(VIL_CAP_MIG), VIL);
  assertEquals(headerOf(capFn), headerOf(NEW_VIL));
  assertEquals(NEW_VIL.split(CAP_FROM).length - 1, 1, "前一版應該恰好有一處「一次最多 150 筆」");
  assertEquals(capFn, NEW_VIL.replace(CAP_FROM, CAP_TO));
  // 整支 migration 除了註解與這個函式，沒有別的陳述式
  const rest = (await readMig(VIL_CAP_MIG)).replace(/^--.*$/gm, "").replace(capFn, "").trim();
  assertEquals(rest, "");
});

Deno.test("A2 新定義＝前一版＋四處機械替換：反向替換回去逐字等於前一版", () => {
  assertEquals(headerOf(NEW_RAW), headerOf(PREV_RAW));
  assertEquals(reverse(NEW_RAW, RAW_EDITS), PREV_RAW);
  assertEquals(headerOf(NEW_VIL), headerOf(PREV_VIL));
  assertEquals(reverse(NEW_VIL, VIL_EDITS), PREV_VIL);
  // task_id、reward、hint_sources 的文字一個字沒動（替換只碰四處，且都在 target／說明／條件）
  for (const s of ["'auto:roster_check:' || s.election_id || ':' || l.name || ':' || s.election_type", "         2, l.name\n"]) assert(NEW_RAW.includes(s), s);
  assert(NEW_VIL.includes("'auto:roster_check:' || s.election_id || ':' || t.county || t.township || ':村里長'"));
});

// ── 行為 ─────────────────────────────────────────────────────────────────────────
/** raw 本體裡的 ours／filed_out 兩個 CTE 與 roster_check 那一個 SELECT，原文抽出來組成可以單獨跑的查詢 */
function rosterSql(fn: string): string {
  const body = fn.slice(fn.indexOf("$function$") + "$function$".length, fn.lastIndexOf("$function$"));
  const a = body.indexOf("  ours AS (");
  const b = body.indexOf("  SELECT 'auto:policy_missing:'");
  const c = body.indexOf("  SELECT 'auto:roster_check:'");
  const d = body.indexOf("  UNION ALL\n  SELECT 'auto:policy_election_missing:'");
  assert(a > 0 && b > a && c > b && d > c, "找不到 ours 或 roster_check 那一段");
  return `WITH ${body.slice(a, b).trim()}\n${body.slice(c, d)}`;
}

async function armsDb(): Promise<PGlite> {
  const { db } = await buildReconcileDb();
  await db.exec(`
    CREATE TABLE locations (name text);
    CREATE TABLE elections (id int PRIMARY KEY, election_date date);
    INSERT INTO elections VALUES (2026, '2026-11-28');
    CREATE TABLE roster_check_scope (election_id int, election_type text, recheck_days int NOT NULL DEFAULT 7, enabled boolean NOT NULL DEFAULT true,
      list_announced_on date, registration_closed_on date, qualification_review_by date, ballot_draw_on date, municipal_mayor_list_on date);
    CREATE TABLE roster_checks (id bigserial PRIMARY KEY, election_id int, region text, election_type text, checked_at timestamptz, cec_count int);
    CREATE TABLE electoral_district_areas (region text, township text);
    CREATE FUNCTION roster_attempt_cooldown_days() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
    CREATE FUNCTION roster_schedule_text(date, date, date, date, date, date DEFAULT CURRENT_DATE) RETURNS text LANGUAGE sql AS $$ SELECT '' $$;
    CREATE FUNCTION election_year_text(int) RETURNS text LANGUAGE sql AS $$ SELECT '2026' $$;
    INSERT INTO roster_check_scope (election_id, election_type, list_announced_on, registration_closed_on) VALUES
      (2026, '縣市議員', '2026-11-17', '2026-09-04');
  `);
  return db;
}

const unit = (county: string, town: string, over: Record<string, unknown> = {}) => ({
  election_id: 2026, election_type: "縣市議員", county, town, total: 10, both_n: 8, creatable_n: 2, ambiguous_n: 0, extra_n: 0, status_mismatch_n: 0, needs_agent: false, people: [], ...over,
});
async function putUnit(db: PGlite, u: ReturnType<typeof unit>) {
  await db.query(
    `INSERT INTO roster_reconcile_units (election_id, election_type, county, town, total, both_n, creatable_n, ambiguous_n, extra_n, status_mismatch_n, needs_agent, people)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [u.election_id, u.election_type, u.county, u.town, u.total, u.both_n, u.creatable_n, u.ambiguous_n, u.extra_n, u.status_mismatch_n, u.needs_agent, JSON.stringify(u.people)]);
}
const PEOPLE = [{ name: "陳四", category: "missing_ambiguous", reason: "person_unclear", sub_region: null, village: null, district: "第01選舉區", row_no: 4 }];

type Disp = Map<string, { target: Record<string, unknown>; what: string }>;
async function dispatched(db: PGlite, sql: string, keyIdx = 3): Promise<Disp> {
  const r = await db.query<unknown[]>(sql, [], { rowMode: "array" });
  return new Map(r.rows.map((x) => [String(x[0]).split(":")[keyIdx], { target: x[2] as Record<string, unknown>, what: String(x[3]) }]));
}

async function rawScenario(): Promise<PGlite> {
  const db = await armsDb();
  for (const n of ["台北市", "台中市", "高雄市", "新北市", "桃園市"]) await db.query(`INSERT INTO locations VALUES ($1)`, [n]);
  await putUnit(db, unit("台北市", "", { creatable_n: 1, ambiguous_n: 1, needs_agent: true, people: PEOPLE }));   // 有對不上的
  await putUnit(db, unit("台中市", "", { creatable_n: 2, needs_agent: false }));                                  // 全對上，只剩系統會建的
  // 高雄市沒有對帳資料 → 照舊派
  await putUnit(db, unit("新北市", "", { ambiguous_n: 1, needs_agent: true, people: PEOPLE }));                    // 有對不上的，但 6 小時前有人回報「查不到」
  await db.query(`INSERT INTO roster_checks (election_id, region, election_type, checked_at, cec_count) VALUES (2026, '新北市', '縣市議員', now() - interval '6 hours', NULL)`);
  await putUnit(db, unit("桃園市", "", { ambiguous_n: 1, needs_agent: true, people: PEOPLE }));                    // 有對不上的，但昨天清查過、人數一樣
  await db.query(`INSERT INTO roster_checks (election_id, region, election_type, checked_at, cec_count) VALUES (2026, '桃園市', '縣市議員', now() - interval '1 day', 0)`);
  return db;
}

Deno.test("A3 raw 的 roster_check：有對不上的才派；全對上／只剩系統會建的不派；沒有對帳資料照舊派；嘗試冷卻與重查天數照舊壓", async () => {
  const db = await rawScenario();
  const got = await dispatched(db, rosterSql(NEW_RAW));
  assertEquals([...got.keys()].sort(), ["台北市", "高雄市"], "台中市（只剩系統會建的）不派；新北市（嘗試冷卻）、桃園市（昨天清查過）照舊壓");
  // 前一版（沒有對帳）：從沒清查過的三個縣市都派 → 新版只少了台中市
  const old = await dispatched(db, rosterSql(PREV_RAW));
  assertEquals([...old.keys()].sort(), ["台中市", "台北市", "高雄市"]);
  const tp = got.get("台北市")!;
  const reconcile = tp.target.reconcile as { needs_agent: boolean; total: number; people: Array<{ name: string }> };
  assertEquals([reconcile.needs_agent, reconcile.total, reconcile.people.map((p) => p.name)], [true, 10, ["陳四"]]);
  assert(tp.what.includes("【名冊對帳】") && tp.what.includes("陳四") && tp.what.includes("由系統自己建"), tp.what);
  // 沒有對帳資料的單位：target.reconcile 是 null、說明沒有那一段，其餘跟前一版一樣
  const kh = got.get("高雄市")!;
  assertEquals(kh.target.reconcile, null);
  assertEquals(kh.what, old.get("高雄市")!.what);
  // 其他欄位沒動：把新增的 reconcile 拿掉，target 逐鍵等於前一版
  const { reconcile: _r, ...rest } = tp.target;
  assertEquals(rest, old.get("台北市")!.target);
  await db.close();
});

Deno.test("A4 村里長臂：同樣的規則（單位＝縣市＋鄉鎮市區）", async () => {
  const db = await armsDb();
  await db.exec(`INSERT INTO roster_check_scope (election_id, election_type, list_announced_on, registration_closed_on) VALUES (2026, '村里長', '2026-11-17', '2026-09-04')`);
  await db.exec(`INSERT INTO electoral_district_areas VALUES ('台北市', '大安區'), ('台北市', '信義區'), ('台北市', '中山區')`);
  await db.exec(NEW_VIL);
  await putUnit(db, unit("台北市", "大安區", { election_type: "村里長", ambiguous_n: 1, needs_agent: true, people: PEOPLE }));   // 有對不上
  await putUnit(db, unit("台北市", "信義區", { election_type: "村里長", creatable_n: 3, needs_agent: false }));                     // 只剩系統會建
  // 中山區沒有對帳資料 → 照舊派
  const { rows } = await db.query<{ task_id: string; target: Record<string, unknown>; what_we_need: string }>(`SELECT task_id, target, what_we_need FROM ${VIL}()`);
  assertEquals(rows.map((r) => r.task_id.split(":")[3]).sort(), ["台北市中山區", "台北市大安區"]);
  const da = rows.find((r) => r.task_id.includes("大安區"))!;
  assert(da.what_we_need.includes("【名冊對帳】") && da.what_we_need.includes("陳四"));
  assertEquals((da.target.reconcile as { needs_agent: boolean }).needs_agent, true);
  assertEquals(rows.find((r) => r.task_id.includes("中山區"))!.target.reconcile, null);
  // 重查天數照舊：大安區昨天清查過 → 不派
  await db.query(`INSERT INTO roster_checks (election_id, region, election_type, checked_at, cec_count) VALUES (2026, '台北市大安區', '村里長', now() - interval '1 day', 5)`);
  const again = await db.query<{ task_id: string }>(`SELECT task_id FROM ${VIL}()`);
  assertEquals(again.rows.map((r) => r.task_id.split(":")[3]), ["台北市中山區"]);
  await db.close();
});

Deno.test("A5 還原驗證：拿掉閘門、拿掉「沒資料照舊派」、把 needs_agent 反過來、拿掉 reconcile 的說明，指定的情境必須轉紅", async () => {
  const db = await rawScenario();
  const want = ["台北市", "高雄市"];
  const GATE = "    AND (rr.u IS NULL OR (rr.u->>'needs_agent')::BOOLEAN)\n";
  const MUTATIONS: Array<{ name: string; edit: (f: string) => string; check: (got: Disp) => boolean }> = [
    { name: "拿掉閘門（全部照舊派）", edit: (f) => mutate(f, GATE, ""), check: (g) => g.has("台中市") },
    { name: "沒有對帳資料的單位也不派", edit: (f) => mutate(f, GATE, "    AND (rr.u->>'needs_agent')::BOOLEAN\n"), check: (g) => !g.has("高雄市") },
    { name: "needs_agent 反過來", edit: (f) => mutate(f, GATE, "    AND (rr.u IS NULL OR NOT (rr.u->>'needs_agent')::BOOLEAN)\n"), check: (g) => !g.has("台北市") && g.has("台中市") },
    { name: "target 不帶 reconcile", edit: (f) => mutate(f, "'reconcile', rr.u)", "'reconcile', NULL::jsonb)"), check: (g) => g.get("台北市")?.target.reconcile == null },
    { name: "說明不帶名冊對帳那一段", edit: (f) => mutate(f, "           || roster_reconcile_text(rr.u)\n", ""), check: (g) => !g.get("台北市")!.what.includes("【名冊對帳】") },
    { name: "LATERAL 拿掉（單位對錯縣市）", edit: (f) => mutate(f, "roster_reconcile_unit(s.election_id, s.election_type, l.name)", "roster_reconcile_unit(s.election_id, s.election_type, '不存在的縣市')"), check: (g) => g.has("台中市") },
  ];
  assertEquals([...(await dispatched(db, rosterSql(NEW_RAW))).keys()].sort(), want, "基準先是綠的");
  for (const m of MUTATIONS) {
    const got = await dispatched(db, rosterSql(m.edit(NEW_RAW)));
    assert(m.check(got), `還原驗證「${m.name}」：指定的情境應該轉紅，實際派出 [${[...got.keys()].join(", ")}]`);
  }
  await db.close();
});
