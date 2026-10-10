/**
 * 政見三要素派工可設定（migration 20261010100000；工作單 Yooliang/policy-ops#61）。
 *   A. 文字層：臂本體＝緊接在前的那一版（20261008180000）加四處機械式替換
 *   B. PGlite：規則 params 的 elements／election_ids 改了，派工輸出跟著改；沒設＝三個要素、每一屆都派（跟改前一樣）
 *      還原驗證：拿掉要素過濾就會派出沒設定的要素
 *   C. 規則 33：打開、只派數值目標、2026、職位縣市長；參數形狀錯就整支停下
 *   D. 任務現況：current.missing_elements 只列 target.missing 有的
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";
import { shapeTaskCurrent } from "./task-context.ts";

const MIG = "20261010100000_policy_elements_config.sql";
const SQL = await readMig(MIG);
const ARM = "contribution_auto_tasks_policy_elements";
const NEW = fnText(SQL, ARM);
const PREV = await latestFn(ARM, MIG);

const EDITS: Array<[string, string]> = [
  ["  WITH inflight AS (\n", "  inflight AS (\n"],
  [
    "                  WHERE NOT EXISTS (SELECT 1 FROM policy_elements pe WHERE pe.policy_id = pl.id AND pe.element = u.k)\n",
    "                  WHERE u.k = ANY ((SELECT cfg.elements FROM cfg)::TEXT[])\n                    AND NOT EXISTS (SELECT 1 FROM policy_elements pe WHERE pe.policy_id = pl.id AND pe.element = u.k)\n",
  ],
  ["     WHERE pl.removed_at IS NULL\n", "     WHERE pl.removed_at IS NULL\n       AND ((SELECT cfg.election_ids FROM cfg) IS NULL OR pl.election_id = ANY ((SELECT cfg.election_ids FROM cfg)::INTEGER[]))\n"],
  [
    "           || '逐一看原文有沒有寫：數值目標（做到多少、做到什麼程度）、達成期限（什麼時候之前）、財源（錢從哪裡來）。'\n",
    "           || '只看上面列的要素（這一站目前只派這幾個；沒列的不用查、不用交），逐一看原文有沒有寫——數值目標＝做到多少、做到什麼程度；達成期限＝什麼時候之前；財源＝錢從哪裡來。'\n",
  ],
];

Deno.test("文字層：臂本體＝前一版加四處替換（cfg 那一段只加在最前面）", () => {
  let want = PREV;
  for (const [a, b] of EDITS) {
    assertEquals(want.split(a).length - 1, 1, a);
    want = want.replace(a, b);
  }
  const cfgStart = NEW.indexOf("  -- 派哪些要素、哪幾屆");
  const cfgEnd = NEW.indexOf("  inflight AS (\n");
  assert(cfgStart > 0 && cfgEnd > cfgStart);
  assertEquals(NEW.slice(0, cfgStart) + NEW.slice(cfgEnd), want);
});

const P26 = "00000000-0000-4000-8000-000000000026";
const P22 = "00000000-0000-4000-8000-000000000022";
const P26_HAS_TARGET = "00000000-0000-4000-8000-000000000027";

async function db(armDef = NEW, params: unknown = {}): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contributions (contribution_type text, status text, payload jsonb);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text, party text, region text, merged_into uuid);
    CREATE TABLE elections (id int PRIMARY KEY, election_date date, bulletin_hint text, bulletin_published_on date);
    CREATE TABLE policies (id uuid PRIMARY KEY, title text, status text, election_id int, politician_id uuid, removed_at timestamptz);
    CREATE TABLE politician_elections (id serial, politician_id uuid, election_id int, election_type text, candidacy_status text, region_id int);
    CREATE TABLE regions (id int PRIMARY KEY, region text);
    CREATE TABLE policy_elements (policy_id uuid, element text);
    CREATE TABLE activity_rules (id bigint PRIMARY KEY, activity text, priority smallint, params jsonb DEFAULT '{}', enabled boolean, election_types text[], note text);
    CREATE FUNCTION policy_primary_url(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'https://example.org/p' $$;
    CREATE FUNCTION office_term_end(int, text) RETURNS date LANGUAGE sql AS $$ SELECT make_date($1 + 4, 12, 24) $$;
    INSERT INTO politicians VALUES ('10000000-0000-4000-8000-000000000001', '甲', '無', '臺北市', NULL);
    INSERT INTO elections VALUES (2022, '2022-11-26', NULL, NULL), (2026, CURRENT_DATE + 30, NULL, NULL);
    INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status) VALUES
      ('10000000-0000-4000-8000-000000000001', 2022, '縣市長', 'elected'),
      ('10000000-0000-4000-8000-000000000001', 2026, '縣市長', 'filed');
    INSERT INTO policies VALUES
      ('${P26}', '政見26', 'Not Started', 2026, '10000000-0000-4000-8000-000000000001', NULL),
      ('${P26_HAS_TARGET}', '政見26b', 'Not Started', 2026, '10000000-0000-4000-8000-000000000001', NULL),
      ('${P22}', '政見22', 'In Progress', 2022, '10000000-0000-4000-8000-000000000001', NULL);
    INSERT INTO policy_elements VALUES ('${P26_HAS_TARGET}', 'target');
  `);
  await d.query(`INSERT INTO activity_rules (id, activity, priority, params, enabled) VALUES (33, 'policy_elements', NULL, $1, true)`, [JSON.stringify(params)]);
  await d.exec(armDef);
  return d;
}

async function out(d: PGlite): Promise<Record<string, string[]>> {
  const { rows } = await d.query<{ target: { policy_id: string; missing: string[] } }>(`SELECT target FROM ${ARM}()`);
  return Object.fromEntries(rows.map((r) => [r.target.policy_id, r.target.missing]).sort());
}

Deno.test("沒設參數：三個要素、每一屆都派（跟改前一樣）", async () => {
  const d = await db();
  assertEquals(await out(d), {
    [P22]: ["target", "deadline", "funding"],
    [P26]: ["target", "deadline", "funding"],
    [P26_HAS_TARGET]: ["deadline", "funding"],
  });
  const prev = await db(PREV);
  assertEquals(await out(prev), await out(d), "沒設參數時新舊臂輸出相同");
  await d.close();
  await prev.close();
});

Deno.test("只派數值目標、2026：其他要素不列、已經有數值目標的不派、2022 不派", async () => {
  const d = await db(NEW, { elements: ["target"], election_ids: [2026] });
  assertEquals(await out(d), { [P26]: ["target"] });
  await d.close();
});

Deno.test("改參數就改輸出：只派期限與財源、每一屆", async () => {
  const d = await db(NEW, { elements: ["deadline", "funding"] });
  assertEquals(await out(d), {
    [P22]: ["deadline", "funding"],
    [P26]: ["deadline", "funding"],
    [P26_HAS_TARGET]: ["deadline", "funding"],
  });
  await d.close();
});

Deno.test("還原驗證：拿掉要素過濾，沒設定的要素就派出去了", async () => {
  const broken = NEW.replace("                  WHERE u.k = ANY ((SELECT cfg.elements FROM cfg)::TEXT[])\n                    AND NOT EXISTS", "                  WHERE NOT EXISTS");
  assert(broken !== NEW);
  const d = await db(broken, { elements: ["target"], election_ids: [2026] });
  assertEquals((await out(d))[P26], ["target", "deadline", "funding"]);
  await d.close();
});

const RULE_PART = SQL.slice(SQL.indexOf("\nUPDATE activity_rules") + 1);

async function ruleDb(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE elections (id int PRIMARY KEY);
    INSERT INTO elections VALUES (2022), (2024), (2026);
    CREATE TABLE activity_rules (id bigint PRIMARY KEY, activity text, priority smallint, params jsonb NOT NULL DEFAULT '{}', enabled boolean, election_types text[], note text);
    INSERT INTO activity_rules (id, activity, enabled, note) VALUES (33, 'policy_elements', false, '暫緩');
  `);
  return d;
}

Deno.test("規則 33：打開、只派數值目標、2026、職位縣市長", async () => {
  const d = await ruleDb();
  await d.exec(RULE_PART);
  const { rows } = await d.query<{ enabled: boolean; election_types: string[]; params: { elements: string[]; election_ids: number[] } }>(
    `SELECT enabled, election_types, params FROM activity_rules WHERE id = 33`,
  );
  assertEquals(rows[0].enabled, true);
  assertEquals(rows[0].election_types, ["縣市長"]);
  assertEquals(rows[0].params, { elements: ["target"], election_ids: [2026] });
  await d.close();
});

Deno.test("參數形狀錯就整支停下：要素名稱打錯、選舉不存在", async () => {
  for (const [from, to] of [["jsonb_build_array('target')", "jsonb_build_array('targets')"], ["jsonb_build_array(2026)", "jsonb_build_array(2099)"]]) {
    const d = await ruleDb();
    const bad = RULE_PART.replace(from, to);
    assert(bad !== RULE_PART);
    await assertRejects(() => d.exec(bad));
    await d.close();
  }
});

Deno.test("任務現況：current.missing_elements 只列 target.missing 有的（沒派的要素不叫代理查）", () => {
  const data = { policy: { id: P26, title: "x" }, politician: { id: "p", name: "甲" }, elements: [] } as never;
  const cur = shapeTaskCurrent("policy_elements_missing", data, { task_id: `auto:policy_elements_missing:${P26}`, target: { policy_id: P26, missing: ["target"] } });
  assertEquals(cur.missing_elements, ["target"]);
  const all = shapeTaskCurrent("policy_elements_missing", data, { task_id: `auto:policy_elements_missing:${P26}`, target: { policy_id: P26 } });
  assertEquals(all.missing_elements, ["target", "deadline", "funding"], "target 沒帶 missing 時照舊");
});
