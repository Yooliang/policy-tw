/**
 * 政策脈絡「一件事的全貌」第一期（policy-tw#675；migration 20261120120000_lineage_stances_events.sql）。
 *
 * 維護者 2026-11-20：現在就蓋資料櫃、選後（2026-11-28 之後）才開任務。所以最重要的是 A5：
 * 第一期**沒有**任何貢獻型別、派工臂、排程——立場與事件現在派不出去、也收不進來。
 *
 *   A. 文字層：只加不刪、兩張新表的權限（RLS＋只有 SELECT）、lineages_full 前面欄一字不改、source_refs 清單、
 *      現在派不出收不進（A5）、SQL 列舉與字數＝TS 常數、merge_politician／空殼人物只多 #675 那幾段
 *   B. PGlite 實跑整支 migration（stub 表＋真的 CREATE TABLE）：約束、contains 層級地方矩陣與成環、子表蓋父脈絡 updated_at、
 *      出處同步、視圖形狀、涵蓋地方、search_terms、人物合併、空殼人物
 *   C. 還原驗證：把被守的東西拿掉，上面對應的測試要紅
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, migrationNames, mutate, readMig } from "./arms-pglite.ts";
import { isDateWithinElectedTerm } from "./elected-term.ts";
import { CONTRIBUTION_TYPES, TASK_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import {
  DATE_PRECISIONS, EVENT_DECIDED_BY_MAX, EVENT_DECIDED_BY_MIN, EVENT_DESCRIPTION_MAX, EVENT_DESCRIPTION_MIN, EVENT_INITIATOR_NOTE_MAX,
  EVENT_INITIATOR_NOTE_MIN, EVENT_TYPES, SEARCH_TERM_MAX, SEARCH_TERM_MIN, SEARCH_TERMS_MAX, STANCE_CONDITION_MAX, STANCE_CONDITION_MIN,
  STANCE_KINDS, STANCE_NOTE_MAX, STANCE_QUOTE_MAX, STANCE_QUOTE_MIN,
} from "./lineage.ts";

const MIG_NAME = "20261120120000_lineage_stances_events.sql";
const MIG = await readMig(MIG_NAME);
const PREV_STATUS = await readMig("20261105200000_lineage_status.sql");
const PREV_LINEAGE = await readMig("20261006034900_policy_lineages.sql");
const PREV_MERGE = await readMig("20261007020000_reassign_merge_followups.sql");
const PREV_ELECTED = await readMig("20261019020000_lineage_elected_only.sql");
const PREV_OFFICES = await readMig("20261004000005_politician_offices.sql");
const PREV_ELECTION_READ = await readMig("20261007030000_election_read_side.sql");
const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const code = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 migration 時間戳排在 main 最後一支之後；只加不刪：沒有 DROP TABLE／DROP COLUMN／DELETE／TRUNCATE，沒有任何 UPDATE", async () => {
  const names = await migrationNames();
  assertEquals(names[names.length - 1] >= MIG_NAME, true);
  assert(MIG_NAME > "20261120100000_contributions_payload_target_idx.sql");
  const c = code(MIG).replace(/'[^']*'/g, "''");
  assertFalse(/\bDROP\s+TABLE\b/i.test(c), "不刪表");
  assertFalse(/\bDROP\s+COLUMN\b/i.test(c), "不刪欄");
  assertFalse(/\bTRUNCATE\b/i.test(c), "不清表");
  assertFalse(/^DELETE\s+FROM\s/im.test(c), "不刪既有資料（頂層沒有 DELETE；函式本體搬人時的刪除不算）");
  const updates = [...c.matchAll(/^\s*UPDATE\s+([a-z_]+)\b/gim)].map((m) => m[1]);
  // 函式本體裡的 UPDATE（merge_politician 搬人、觸發器蓋時間）不算 migration 對既有資料的改動；頂層不准有 UPDATE
  const topLevel = c.split("\n").filter((l) => /^UPDATE\s/i.test(l)).map((l) => l.replace(/^UPDATE\s+(\S+).*/i, "$1"));
  assertEquals(topLevel, [], "頂層不准任何 UPDATE（包括 activity_rules）");
  assertFalse(/activity_rules/i.test(c), "不碰派工規則表（決定 3：既有三支臂開著不動）");
  assertFalse(/enabled\s*=\s*false/i.test(c), "不把任何規則設成停用");
  void updates;
  assertFalse(/INSERT\s+INTO\s+lineage_(stances|events)\b/i.test(c), "不灌任何立場或事件資料");
});

Deno.test("A2 lineages_full＝20261105200000 的現行定義只在尾端多欄（前面一個字不改）；新欄在 #675 標記區塊內", () => {
  const cut = (s: string) => s.slice(s.indexOf("CREATE OR REPLACE VIEW lineages_full AS"), s.indexOf("FROM lineages l;") + "FROM lineages l;".length);
  const prev = cut(PREV_STATUS), now = cut(MIG);
  const a = now.indexOf("    LIMIT 1) AS status,\n  -- <<< 現況\n  -- >>> #675 第一期");
  const b = now.indexOf("  -- <<< #675 第一期\n") + "  -- <<< #675 第一期\n".length;
  assert(a > 0 && b > a, "找不到 #675 區塊");
  assertEquals(now.slice(0, a) + "    LIMIT 1) AS status\n  -- <<< 現況\n" + now.slice(b), prev, "除了尾端新欄，視圖一個字不改");
  for (const col of ["AS coverage", "l.search_terms", "AS sources", "AS stances", "AS events", "AS status_count"]) assertStringIncludes(now.slice(a, b), col);
  assertStringIncludes(MIG, "ALTER VIEW lineages_full SET (security_invoker = on);");
  assertStringIncludes(MIG, "GRANT SELECT ON lineages_full TO anon, authenticated;");
});

Deno.test("A3 source_refs 目標表＝20261105200000 的十一個值（一個不少、順序不變）再加 lineages、lineage_stances、lineage_events", () => {
  const list = (sql: string) => {
    const b = sql.indexOf("ADD CONSTRAINT source_refs_target_table_check");
    return [...sql.slice(b, sql.indexOf(";", b)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  };
  const prev = list(PREV_STATUS);
  assertEquals(prev.length, 11);
  assertEquals(list(MIG), [...prev, "lineages", "lineage_stances", "lineage_events"]);
});

Deno.test("A4 兩張新表的權限：RLS 開、公開讀、service_role 寫；anon／authenticated 只有 SELECT（沒有 GRANT ALL、沒有 TRUNCATE／TRIGGER／REFERENCES）", () => {
  for (const t of ["lineage_stances", "lineage_events"]) {
    assertStringIncludes(MIG, `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
    assertStringIncludes(MIG, `CREATE POLICY "Public read" ON ${t} FOR SELECT USING (removed_at IS NULL);`);
    assertStringIncludes(MIG, `CREATE POLICY "Service role write" ON ${t} FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');`);
    assertStringIncludes(MIG, `REVOKE ALL ON ${t} FROM PUBLIC, anon, authenticated;`);
    assertStringIncludes(MIG, `GRANT SELECT ON ${t} TO anon, authenticated;`);
    assertStringIncludes(MIG, `GRANT ALL ON ${t} TO service_role;`);
  }
  const grants = code(MIG).split("\n").filter((l) => /^\s*GRANT\b/i.test(l));
  for (const g of grants) {
    if (/\bTO\b.*\b(anon|authenticated|PUBLIC)\b/i.test(g)) assertStringIncludes(g.replace(/\s+/g, " "), "SELECT", `給 anon／authenticated 的授權只能是 SELECT：${g}`);
    assertFalse(/\bGRANT\s+ALL\b[^;]*\bTO\s+[^;]*\b(anon|authenticated|PUBLIC)\b/i.test(g), `不給 anon／authenticated 全部權限：${g}`);
  }
  for (const v of ["lineage_people", "lineage_terms", "lineages_list", "lineages_full"]) {
    assertStringIncludes(MIG, `ALTER VIEW ${v} SET (security_invoker = on);`);
    assertStringIncludes(MIG, `GRANT SELECT ON ${v} TO anon, authenticated;`);
  }
});

Deno.test("A5 選後才開任務：第一期沒有新貢獻型別、沒有新臂、沒有排程、沒有新任務型別；立場與事件現在派不出、收不進", async () => {
  const c = code(MIG);
  // migration 層：不碰型別 CHECK、臂名清單、總表、規則種子、排程、seed
  for (const bad of ["contributions_contribution_type_check", "FUNCTION activity_arm_names", "FUNCTION contribution_auto_tasks_arms", "INSERT INTO activity_rules", "cron.schedule", "FUNCTION seed_auto_task_queue", "console_arm_stage_map"]) {
    assertFalse(c.includes(bad), `第一期不應出現：${bad}`);
  }
  assertFalse(/FUNCTION\s+contribution_auto_tasks_lineage_(stance|event|expand)/i.test(c), "沒有新臂函式");
  // 全部 migration 疊起來的現行型別 CHECK 與臂名清單：沒有立場、事件
  let typeCheck = "", armNames = "";
  for (const n of await migrationNames()) {
    const sql = await readMig(n);
    const a = sql.lastIndexOf("ADD CONSTRAINT contributions_contribution_type_check");
    if (a >= 0) typeCheck = sql.slice(a, sql.indexOf(";", a));
    if (sql.includes("CREATE OR REPLACE FUNCTION activity_arm_names()")) armNames = fnText(sql, "activity_arm_names");
  }
  assertFalse(/lineage_(stance|event)/.test(typeCheck), "DB 型別 CHECK 沒有立場／事件");
  assertFalse(/stance|event|expand/.test(armNames), "臂名清單沒有立場／事件／往外擴");
  // TS 層：/report 收件白名單（CONTRIBUTION_TYPES）與任務型別（TASK_TYPES）都沒有
  assertFalse(CONTRIBUTION_TYPES.some((t) => /stance|event/.test(t)), "收件白名單沒有立場／事件");
  assertFalse(TASK_TYPES.some((t) => /stance|event|expand/.test(t)), "任務型別沒有立場／事件／往外擴");
  for (const t of ["lineage_stance", "lineage_stances", "lineage_event", "lineage_events"]) {
    const r = validateContributionRequest({ kind: "contribute", agent_name: "tester", agent_tool: "claude-code/test", contribution_type: t, payload: {}, source_urls: ["https://www.gov.tw/a"] });
    assertFalse(r.ok, `${t} 交件要被擋`);
  }
  // 落庫端：apply-contribution 沒有對應的分支
  const apply = await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url));
  assertFalse(/case "lineage_(stance|stances|event|events)"/.test(apply), "落庫沒有立場／事件分支");
});

Deno.test("A6 SQL 的列舉值與字數＝TS 常數（立場、事件、日期精度、search_terms）", () => {
  const tbl = (name: string) => {
    const a = MIG.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
    return MIG.slice(a, MIG.indexOf("\n);", a));
  };
  const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const stances = tbl("lineage_stances"), events = tbl("lineage_events");
  assertEquals(quoted(stances.match(/stance\s+TEXT NOT NULL CHECK \(stance IN \(([^)]+)\)\)/)![1]), [...STANCE_KINDS]);
  assertEquals(quoted(events.match(/event_type\s+TEXT NOT NULL CHECK \(event_type IN \(([^)]+)\)\)/)![1]), [...EVENT_TYPES]);
  for (const t of [stances, events]) assertEquals(quoted(t.match(/date_precision\s+TEXT NOT NULL DEFAULT 'day' CHECK \(date_precision IN \(([^)]+)\)\)/)![1]), [...DATE_PRECISIONS]);
  assertStringIncludes(stances, `char_length(btrim(condition_text)) BETWEEN ${STANCE_CONDITION_MIN} AND ${STANCE_CONDITION_MAX}`);
  assertStringIncludes(stances, `char_length(btrim(quote)) BETWEEN ${STANCE_QUOTE_MIN} AND ${STANCE_QUOTE_MAX}`);
  assertStringIncludes(stances, `char_length(btrim(note)) BETWEEN 1 AND ${STANCE_NOTE_MAX}`);
  assertStringIncludes(events, `char_length(btrim(decided_by)) BETWEEN ${EVENT_DECIDED_BY_MIN} AND ${EVENT_DECIDED_BY_MAX}`);
  assertStringIncludes(events, `char_length(btrim(description)) BETWEEN ${EVENT_DESCRIPTION_MIN} AND ${EVENT_DESCRIPTION_MAX}`);
  assertStringIncludes(events, `char_length(btrim(initiator_note)) BETWEEN ${EVENT_INITIATOR_NOTE_MIN} AND ${EVENT_INITIATOR_NOTE_MAX}`);
  const f = fnText(MIG, "lineage_terms_in_title");
  assertStringIncludes(f, `cardinality(p_terms) > ${SEARCH_TERMS_MAX}`);
  assertStringIncludes(f, `char_length(t.term) NOT BETWEEN ${SEARCH_TERM_MIN} AND ${SEARCH_TERM_MAX}`);
});

/** 拿掉 #675 標記區塊與兩個小改動後，要跟前一版一字不差 */
Deno.test("A7 merge_politician＝20261007020000 的現行定義只多 #675 區塊、兩個計數變數與兩個回傳鍵", () => {
  const prev = fnText(PREV_MERGE, "merge_politician");
  let now = fnText(MIG, "merge_politician");
  const a = now.indexOf("  -- >>> #675");
  const b = now.indexOf("  -- <<< #675\n\n") + "  -- <<< #675\n\n".length;
  assert(a > 0 && b > a);
  now = now.slice(0, a) + now.slice(b);
  now = now.replace(" v_stances INTEGER := 0; v_events INTEGER := 0;", "");
  now = now.replace(",\n                            'moved_stances', v_stances, 'moved_events', v_events);", ");");
  assertEquals(now, prev);
});

Deno.test("A8 空殼人物＝20261007020000 的現行定義只多 #675 的兩條 NOT EXISTS", () => {
  const prev = fnText(PREV_MERGE, "contribution_auto_tasks_placeholder_politicians");
  let now = fnText(MIG, "contribution_auto_tasks_placeholder_politicians");
  const a = now.indexOf("     -- >>> #675");
  const b = now.indexOf("     -- <<< #675\n") + "     -- <<< #675\n".length;
  assert(a > 0 && b > a);
  now = now.slice(0, a) + now.slice(b);
  assertEquals(now, prev);
});

Deno.test("A9 lineage_links 舊檢查函式沒動（回滾用）；三支既有派工臂規則跑完 migration 仍 enabled=true", async () => {
  assertFalse(MIG.includes("CREATE OR REPLACE FUNCTION lineage_links_check_levels()"), "舊函式一字不動");
  assertStringIncludes(PREV_LINEAGE, "CREATE OR REPLACE FUNCTION lineage_links_check_levels()");
  const db = await buildDb();
  const r = await rows<{ activity: string; enabled: boolean }>(db, `SELECT activity, enabled FROM activity_rules WHERE activity LIKE 'lineage\_%' ORDER BY 1`);
  assertEquals(r.map((x) => x.activity), ["lineage_candidates", "lineage_links", "lineage_roles", "lineage_status"]);
  assert(r.every((x) => x.enabled), "既有規則一條都不能被停用");
});

// ============================================================
// B. PGlite 實跑整支 migration
// ============================================================
const tableSql = (sql: string, name: string) => {
  const a = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  assert(a >= 0, `找不到表 ${name}`);
  return sql.slice(a, sql.indexOf("\n);", a) + 3);
};
const rows = async <T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;

/** 環境：stub 掉別的功能的表，lineages／lineage_links／lineage_statuses／lineage_settings 用真的 CREATE TABLE，然後跑整支 migration */
async function buildDb(mig: string = MIG): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$;
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT '2026-11-20'::date $$;
    CREATE TABLE categories (name text PRIMARY KEY);
    INSERT INTO categories VALUES ('交通建設');
    CREATE TABLE admin_divisions (code text PRIMARY KEY);
    INSERT INTO admin_divisions VALUES ('64000'), ('63000'), ('63000020'), ('64000010');
    CREATE TABLE politicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, region text, party text, merged_into uuid);
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, payload jsonb);
    CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text, record_id text, field text, old_value jsonb, new_value jsonb, contribution_id uuid, agent_name text, reverted_at timestamptz);
    CREATE TABLE sources (id bigserial PRIMARY KEY, url text UNIQUE, title text, publisher text, source_kind text, archive_url text);
    CREATE TABLE source_refs (source_id bigint NOT NULL REFERENCES sources(id) ON DELETE CASCADE, target_table text NOT NULL, target_id text NOT NULL,
      role text NOT NULL DEFAULT 'primary', origin text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (target_table, target_id, source_id));
    CREATE FUNCTION source_upsert(p_url text, p_origin text, a text, b text, c text, d timestamptz) RETURNS bigint LANGUAGE plpgsql AS $$
      DECLARE v bigint; BEGIN INSERT INTO sources (url) VALUES (p_url) ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url RETURNING id INTO v; RETURN v; END $$;
    CREATE TABLE elections (id int PRIMARY KEY, election_date date, election_reason text);
    CREATE TABLE regions (id int PRIMARY KEY, region text, sub_region text);
    CREATE TABLE politician_elections (id serial PRIMARY KEY, politician_id uuid, election_id int, election_type text, candidacy_status text, region_id int, source_note text);
    CREATE TABLE policies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lineage_id uuid, politician_id uuid, election_id int, title text, description text, proposed_date date, removed_at timestamptz);
    CREATE TABLE politician_offices (id bigserial PRIMARY KEY, politician_id uuid, election_type text, region_id int, start_date date, scheduled_end_date date, end_date date);
    CREATE TABLE politician_careers (id bigserial PRIMARY KEY, politician_id uuid);
    CREATE TABLE politician_keys (id bigserial PRIMARY KEY, politician_id uuid, key_type text, key_value text);
    CREATE TABLE citizen_questions (id bigserial PRIMARY KEY, politician_id uuid);
    CREATE TABLE contribution_votes (id bigserial PRIMARY KEY, resolved_politician_id text);
    CREATE TABLE politician_identity_reviews (id bigserial PRIMARY KEY, resolved_politician_id uuid);
    CREATE TABLE politician_pair_resolutions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pair_key text, a uuid, b uuid, resolution text, contribution_id uuid);
    CREATE FUNCTION politician_pair_key(a uuid, b uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT LEAST(a, b)::text || ':' || GREATEST(a, b)::text $$;
    CREATE FUNCTION politician_name_is_placeholder(n text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT n LIKE '測試%' $$;
    CREATE TABLE activity_rules (activity text PRIMARY KEY, window_kind text DEFAULT 'always', enabled boolean DEFAULT true, note text);
    INSERT INTO activity_rules (activity) VALUES ('lineage_candidates'), ('lineage_links'), ('lineage_roles'), ('lineage_status');
    ${fnText(PREV_ELECTED, "policy_is_elected_term")}
    ${fnText(PREV_OFFICES, "office_term_start")}
    ${fnText(PREV_OFFICES, "office_term_end")}
    ${fnText(PREV_ELECTION_READ, "election_term_start")}
    ${fnText(PREV_ELECTION_READ, "election_term_end")}
    ${tableSql(PREV_LINEAGE, "lineages")}
    CREATE UNIQUE INDEX lineages_same_title_same_place ON lineages (level, COALESCE(admin_code, ''), lower(btrim(title)));
    ${fnText(PREV_LINEAGE, "lineage_touch_updated_at")}
    ${tableSql(PREV_LINEAGE, "lineage_links")}
    ${fnText(PREV_LINEAGE, "lineage_links_check_levels")}
    CREATE TRIGGER trg_lineage_links_levels BEFORE INSERT OR UPDATE OF upper_lineage_id, lower_lineage_id ON lineage_links FOR EACH ROW EXECUTE FUNCTION lineage_links_check_levels();
    CREATE TABLE lineage_participants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lineage_id uuid NOT NULL REFERENCES lineages(id) ON DELETE CASCADE, politician_id uuid NOT NULL,
      role text, basis text, source_url text, source_locator text, note text, created_at timestamptz DEFAULT now());
    CREATE TABLE handovers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lineage_id uuid NOT NULL REFERENCES lineages(id) ON DELETE CASCADE,
      from_politician_id uuid, from_election_id int, to_politician_id uuid, to_election_id int, from_office_id bigint, to_office_id bigint,
      handover_type text, decided_on date, note text, source_url text, source_locator text, created_at timestamptz DEFAULT now());
    ${fnText(PREV_LINEAGE, "source_brief")}
    ${fnText(PREV_LINEAGE, "lineage_rows_sync_source")}
    ${fnText(PREV_LINEAGE, "lineage_rows_drop_refs")}
    ${tableSql(PREV_STATUS, "lineage_settings")}
    INSERT INTO lineage_settings (id) VALUES (1);
    ${tableSql(PREV_STATUS, "lineage_statuses")}
    ${fnText(PREV_STATUS, "lineage_touch_parent")}
    CREATE TRIGGER trg_lineage_statuses_touch_parent AFTER INSERT OR UPDATE OR DELETE ON lineage_statuses FOR EACH ROW EXECUTE FUNCTION lineage_touch_parent();
    ${PREV_STATUS.slice(PREV_STATUS.indexOf("DROP TRIGGER IF EXISTS trg_lineage_statuses_sync_source"), PREV_STATUS.indexOf("-- 4. 貢獻型別"))
      .replace(/-- -+\n$/, "")}
  `);
  await db.exec(mig);
  return db;
}

const P = { pol: (n: number) => u(100 + n), lin: (n: number) => u(n) };
/** 屆別：2018、2022 兩屆地方公職（投票日都早於測試的「今天」2026-11-20）；任期 2018-12-25～2022-12-24、2022-12-25～2026-12-24 */
async function addElections(db: PGlite) {
  await db.exec(`INSERT INTO elections (id, election_date) VALUES (2018, '2018-11-24'), (2022, '2022-11-26') ON CONFLICT DO NOTHING`);
}
/** 人物＋一個當選任期（2022 屆：2022-12-25～2026-12-24）：立場與事件的日期要落在當選任期內才插得進去。也放一列 politician_offices（空殼人物判斷看它） */
async function addPol(db: PGlite, n: number, name = `人物${n}`, mergedInto: string | null = null, electionYear = 2022) {
  await addElections(db);
  await db.query(`INSERT INTO politicians (id, name, merged_into) VALUES ($1, $2, $3)`, [P.pol(n), name, mergedInto]);
  await db.query(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status) VALUES ($1, $2, '縣市議員', 'elected')`, [P.pol(n), electionYear]);
  await db.query(`INSERT INTO politician_offices (politician_id, election_type, region_id, start_date, scheduled_end_date) VALUES ($1, '立法委員', NULL, '2022-12-25', '2026-12-24')`, [P.pol(n)]);
}
/** 沒有推動者的事件要有「涉及這條脈絡的人」當基準：放一位 2018 屆當選的交接前任（參與者不計） */
async function basis(db: PGlite, lin: number) {
  if ((await rows(db, `SELECT 1 FROM politicians WHERE id = $1`, [P.pol(98)])).length === 0) {
    await addPol(db, 98, "基準人物", null, 2018);
    await db.query(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status) VALUES ($1, 2022, '縣市議員', 'elected')`, [P.pol(98)]);
  }
  await db.query(`INSERT INTO handovers (lineage_id, from_politician_id) VALUES ($1, $2)`, [P.lin(lin), P.pol(98)]);
}
async function addLineage(db: PGlite, n: number, level: "national" | "county" | "township", region: string | null, sub: string | null, admin: string | null, title = `脈絡標題${n}`) {
  await db.query(`INSERT INTO lineages (id, title, level, region, sub_region, admin_code, category) VALUES ($1, $2, $3, $4, $5, $6, '交通建設')`, [P.lin(n), title, level, region, sub, admin]);
}
const rejects = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return e instanceof Error ? e.message : String(e); }
  return "";
};
const stanceSql = `INSERT INTO lineage_stances (lineage_id, politician_id, stance, condition_text, stated_on, quote, source_url, source_locator) VALUES ($1, $2, $3, $4, $5, '這是一段八個字以上的原文摘句', 'https://www.gov.tw/a', '第 1 頁')`;
const eventSql = `INSERT INTO lineage_events (lineage_id, event_type, occurred_on, level, region, sub_region, admin_code, decided_by, description, initiator_politician_id, initiator_note, source_url, source_locator)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, '縣議會', '縣議會三讀通過這件事的預算案。', $8, $9, 'https://www.gov.tw/b', '會議紀錄')`;

Deno.test("B0 整支 migration 在 stub 環境跑得過（語法、引用的欄位與函式都對）；兩張表與視圖都在", async () => {
  const db = await buildDb();
  const t = await rows<{ n: string }>(db, `SELECT table_name AS n FROM information_schema.tables WHERE table_name IN ('lineage_stances', 'lineage_events', 'lineage_people', 'lineage_terms', 'lineages_list', 'lineages_full') ORDER BY 1`);
  assertEquals(t.map((r) => r.n), ["lineage_events", "lineage_people", "lineage_stances", "lineage_terms", "lineages_full", "lineages_list"]);
  const cols = await rows<{ c: string }>(db, `SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'lineages_full' ORDER BY ordinal_position`);
  assertEquals(cols.map((r) => r.c), [
    "id", "title", "summary", "category", "level", "region", "sub_region", "admin_code", "created_at", "updated_at",
    "policy_ids", "participants", "handovers", "links", "status", "coverage", "search_terms", "sources", "stances", "events", "status_count",
  ]);
  const s = await rows<{ search_terms: string[] }>(db, `SELECT search_terms FROM lineages_full`);
  assertEquals(s.length, 0);
});

Deno.test("B1 立場：約束與唯一鍵（有條件要有條件、其他必空、同人同日一筆、外鍵要有人物）", async () => {
  const db = await buildDb();
  await addLineage(db, 1, "county", "高雄市", null, "64000");
  await addPol(db, 1);
  await db.query(stanceSql, [P.lin(1), P.pol(1), "support", null, "2026-03-01"]);
  await db.query(stanceSql, [P.lin(1), P.pol(1), "support", null, "2026-04-01"]); // 同一人不同天＝立場變過，看全部列
  await db.query(stanceSql, [P.lin(1), P.pol(1), "conditional", "只有在環評通過之後才支持", "2026-05-01"]);
  assert(await rejects(db.query(stanceSql, [P.lin(1), P.pol(1), "oppose", null, "2026-03-01"])), "同一人同一天同一句原文要撞鍵");
  await db.query(`INSERT INTO lineage_stances (lineage_id, politician_id, stance, stated_on, quote, source_url, source_locator) VALUES ($1, $2, 'oppose', '2026-03-01', '同一天另一句完全不同的原文摘句', 'https://www.gov.tw/a', '第 2 頁')`, [P.lin(1), P.pol(1)]);
  assert(await rejects(db.query(stanceSql, [P.lin(1), P.pol(1), "conditional", null, "2026-06-01"])), "有條件沒填條件要被擋");
  assert(await rejects(db.query(stanceSql, [P.lin(1), P.pol(1), "support", "不該有條件的支持", "2026-06-02"])), "不是有條件卻填了條件要被擋");
  assert(await rejects(db.query(stanceSql, [P.lin(1), P.pol(1), "maybe", null, "2026-06-03"])), "未知立場要被擋");
  assert(await rejects(db.query(stanceSql, [P.lin(1), P.pol(99), "support", null, "2026-06-04"])), "沒有這個人物要被擋");
  assert(await rejects(db.query(`UPDATE lineage_stances SET quote = '太短' WHERE politician_id = $1`, [P.pol(1)])), "原文摘句太短要被擋");
  assert(await rejects(db.query(`UPDATE lineage_stances SET source_url = 'ftp://x' WHERE politician_id = $1`, [P.pol(1)])), "出處網址格式要被擋");
  assert(await rejects(db.query(`UPDATE lineage_stances SET date_precision = 'week' WHERE politician_id = $1`, [P.pol(1)])), "日期精度未知值要被擋");
  assertEquals((await rows(db, `SELECT 1 FROM lineage_stances`)).length, 4, "同日多次表態不互相覆蓋");
  await db.query(`DELETE FROM lineages WHERE id = $1`, [P.lin(1)]);
  assertEquals((await rows(db, `SELECT 1 FROM lineage_stances`)).length, 0, "脈絡刪掉，立場跟著走（ON DELETE CASCADE）");
});


Deno.test("B2 事件：地方規則同 lineages_place、同日同機關同型態撞鍵、推動者短註要有推動者", async () => {
  const db = await buildDb();
  await addLineage(db, 1, "county", "高雄市", null, "64000");
  await addPol(db, 1);
  await basis(db, 1);
  await db.query(eventSql, [P.lin(1), "approved", "2026-02-01", "county", "高雄市", null, "64000", P.pol(1), "縣府提案"]);
  assert(await rejects(db.query(eventSql, [P.lin(1), "approved", "2026-02-01", "national", null, null, null, null, null])), "同脈絡同型態同日同機關要撞鍵");
  await db.query(eventSql, [P.lin(1), "approved", "2026-02-02", "national", null, null, null, null, null]);
  await db.query(eventSql, [P.lin(1), "budget_cut", "2026-02-01", "township", "高雄市", "前鎮區", "64000010", null, null]);
  assert(await rejects(db.query(eventSql, [P.lin(1), "other", "2026-03-01", "county", null, null, null, null, null])), "縣市層級沒有縣市要被擋");
  assert(await rejects(db.query(eventSql, [P.lin(1), "other", "2026-03-01", "national", "高雄市", null, null, null, null])), "中央層級帶地方要被擋");
  assert(await rejects(db.query(eventSql, [P.lin(1), "other", "2026-03-01", "township", "高雄市", "前鎮區", "64000", null, null])), "鄉鎮碼要 8 碼");
  assert(await rejects(db.query(eventSql, [P.lin(1), "other", "2026-03-01", "national", null, null, null, null, "縣府提案"])), "沒有推動者不能填短註");
  assert(await rejects(db.query(eventSql, [P.lin(1), "weird", "2026-03-01", "national", null, null, null, null, null])), "未知事件型態要被擋");
  assert(await rejects(db.query(eventSql, [P.lin(1), "other", "2026-03-01", "county", "高雄市", null, "99999", null, null])), "行政區代碼要在 admin_divisions");
});

// ---- contains 的層級與地方矩陣、不成環 ----
async function linksDb(mig: string = MIG): Promise<PGlite> {
  const db = await buildDb(mig);
  await addLineage(db, 1, "national", null, null, null); // 中央大計畫
  await addLineage(db, 2, "county", "高雄市", null, "64000"); // 高雄市大計畫
  await addLineage(db, 3, "county", "台中市", null, "63000"); // 台中市
  await addLineage(db, 4, "township", "高雄市", "前鎮區", "64000010"); // 高雄前鎮區
  await addLineage(db, 5, "township", "台中市", "大雅區", "63000020");
  for (const n of [1, 2, 3, 4, 5]) await basis(db, n);
  return db;
}
const link = (db: PGlite, up: number, lo: number, type = "contains") =>
  db.query(`INSERT INTO lineage_links (upper_lineage_id, lower_lineage_id, link_type, note, source_url, source_locator) VALUES ($1, $2, $3, '這是二十個字以上的說明文字，用來滿足 CHECK。', 'https://www.gov.tw/x', '第 1 頁')`, [P.lin(up), P.lin(lo), type]);

/** 回傳每一格「該不該過」的實際結果與期望 */
async function containsMatrix(mig: string = MIG): Promise<{ name: string; ok: boolean; want: boolean }[]> {
  const out: { name: string; ok: boolean; want: boolean }[] = [];
  const cases: [string, number, number, boolean][] = [
    ["中央→縣市", 1, 2, true], ["中央→鄉鎮", 1, 4, true],
    ["縣市→同縣市鄉鎮", 2, 4, true], ["縣市→不同縣市鄉鎮", 2, 5, false], ["縣市→另一縣市縣市", 2, 3, false],
    ["縣市→中央", 2, 1, false], ["鄉鎮→縣市", 4, 2, false], ["鄉鎮→不同鄉鎮", 4, 5, false],
  ];
  for (const [name, up, lo, want] of cases) {
    const db = await linksDb(mig);
    const err = await rejects(link(db, up, lo));
    out.push({ name, ok: err === "", want });
  }
  return out;
}

Deno.test("B3 contains 的層級與地方矩陣逐格（縣市大計畫包含不同縣市的鄉鎮項目要擋）", async () => {
  for (const r of await containsMatrix()) assertEquals(r.ok, r.want, r.name);
});

Deno.test("B4 contains 不成環（自連、直接、間接）；舊值照舊走舊檢查", async () => {
  const db = await linksDb();
  await link(db, 1, 2); // 中央 ⊃ 高雄市
  await link(db, 2, 4); // 高雄市 ⊃ 前鎮區
  assert(await rejects(link(db, 4, 1)), "鄉鎮不能包含中央（層級就擋）");
  const db2 = await linksDb();
  await addLineage(db2, 6, "national", null, null, null);
  await link(db2, 1, 6);
  assert(await rejects(link(db2, 6, 1)), "直接成環要擋");
  await addLineage(db2, 7, "national", null, null, null);
  await link(db2, 6, 7);
  assert(await rejects(link(db2, 7, 1)), "間接成環要擋");
  // 舊值：中央→縣市 top_down 可、縣市→縣市（舊規則不收）擋
  const db3 = await linksDb();
  await link(db3, 1, 2, "top_down");
  assert(await rejects(link(db3, 2, 3, "top_down")), "舊值走舊檢查：縣市→縣市要擋");
  assert(await rejects(link(db3, 1, 3, "weird")), "未知 link_type 要擋");
});

Deno.test("B5 子表一變，父脈絡 updated_at 跟著動（參與者、交接、關聯兩邊、立場、事件、現況）；刪除也算", async () => {
  const db = await linksDb();
  await addPol(db, 1);
  await addPol(db, 2);
  const old = "2020-01-01T00:00:00Z";
  const reset = () => db.exec(`UPDATE lineages SET updated_at = '${old}'`);
  const moved = async (id: number) => (await rows<{ m: boolean }>(db, `SELECT updated_at > '${old}' AS m FROM lineages WHERE id = $1`, [P.lin(id)]))[0].m;
  await reset();
  await db.query(`INSERT INTO lineage_participants (lineage_id, politician_id) VALUES ($1, $2)`, [P.lin(2), P.pol(1)]);
  assert(await moved(2), "參與者");
  assertFalse(await moved(3), "別條脈絡不動");
  await reset();
  await db.query(`INSERT INTO handovers (lineage_id, from_politician_id, to_politician_id) VALUES ($1, $2, $3)`, [P.lin(2), P.pol(1), P.pol(2)]);
  assert(await moved(2), "交接");
  await reset();
  await link(db, 2, 4);
  assert(await moved(2) && await moved(4), "關聯兩邊都蓋");
  assertFalse(await moved(3));
  await reset();
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-03-01"]);
  assert(await moved(2), "立場");
  await reset();
  await db.query(`DELETE FROM lineage_stances`);
  assert(await moved(2), "刪立場也蓋");
  await reset();
  await db.query(eventSql, [P.lin(2), "decided", "2026-03-01", "national", null, null, null, null, null]);
  assert(await moved(2), "事件");
  await reset();
  await db.query(`INSERT INTO lineage_statuses (lineage_id, phase, text, as_of, source_url, source_locator) VALUES ($1, 'planning', '現況一句話，長度夠。', '2026-03-01', 'https://www.gov.tw/a', '第 1 點')`, [P.lin(2)]);
  assert(await moved(2), "現況（20261105200000 已掛，確認沒被弄丟）");
});

Deno.test("B6 出處同步：立場與事件寫入就有 source_refs（目標表正確）、改網址換主要出處、刪除清掉；source_refs 接受新目標表", async () => {
  const db = await linksDb();
  await addPol(db, 1);
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-03-01"]);
  await db.query(eventSql, [P.lin(2), "decided", "2026-03-01", "national", null, null, null, null, null]);
  const refs = await rows<{ t: string; n: number }>(db, `SELECT target_table AS t, count(*)::int AS n FROM source_refs GROUP BY 1 ORDER BY 1`);
  assertEquals(refs, [{ t: "lineage_events", n: 1 }, { t: "lineage_stances", n: 1 }]);
  await db.query(`UPDATE lineage_stances SET source_url = 'https://www.gov.tw/new'`);
  assertEquals((await rows(db, `SELECT 1 FROM source_refs WHERE target_table = 'lineage_stances'`)).length, 1, "換網址仍只有一個主要出處");
  await db.query(`DELETE FROM lineage_events`);
  assertEquals((await rows(db, `SELECT 1 FROM source_refs WHERE target_table = 'lineage_events'`)).length, 0);
  const s = await rows<{ id: string }>(db, `INSERT INTO sources (url) VALUES ('https://www.gov.tw/l') RETURNING id::text AS id`);
  await db.query(`INSERT INTO source_refs (source_id, target_table, target_id, origin) VALUES ($1, 'lineages', $2, 'test')`, [s[0].id, P.lin(2)]);
  assert(await rejects(db.query(`INSERT INTO source_refs (source_id, target_table, target_id, origin) VALUES ($1, 'nonsense', 'x', 'test')`, [s[0].id])), "未知目標表仍被擋");
});

Deno.test("B7 search_terms：空陣列可寫、子字串／字數／個數規則；既有列不被擋；改標題要同步改詞", async () => {
  const db = await linksDb();
  assertEquals((await rows<{ n: number }>(db, `SELECT cardinality(search_terms)::int AS n FROM lineages WHERE id = $1`, [P.lin(1)]))[0].n, 0);
  const set = (terms: string[], id = 1) => db.query(`UPDATE lineages SET search_terms = $1 WHERE id = $2`, [terms, P.lin(id)]);
  await db.query(`UPDATE lineages SET title = '台中捷運藍線第一期工程' WHERE id = $1`, [P.lin(1)]);
  await set(["藍線", "台中捷運"]);
  assert(await rejects(set(["綠線"])), "不是標題子字串");
  assert(await rejects(set(["藍"])), "1 字太短");
  assert(await rejects(set(["台中捷運藍線第一期工程啊啊"])), "13 字太長（也不是子字串）");
  assert(await rejects(set(["台中", "捷運", "藍線", "第一期", "工程", "台中捷運"])), "超過 5 個");
  assert(await rejects(db.query(`UPDATE lineages SET title = '完全不同的標題名稱' WHERE id = $1`, [P.lin(1)])), "改標題要同步改詞");
  await set([]);
  await db.query(`UPDATE lineages SET title = '完全不同的標題名稱' WHERE id = $1`, [P.lin(1)]);
  const f = async (title: string, terms: string[]) => (await rows<{ v: boolean }>(db, `SELECT lineage_terms_in_title($1, $2::text[]) AS v`, [title, terms]))[0].v;
  assertEquals(await f("標題文字", []), true);
  assertEquals(await f("標題文字", ["標題"]), true);
  assertEquals(await f("標題文字", ["標題", "文字", "標題文字", "題文", "字"]), false, "含 1 字詞");
  assertEquals(await f("標題文字", ["標題", "文字", "標題文字", "題文", "標題文"]), true, "剛好 5 個");
});

// ---- 政見地方、涵蓋、視圖形狀、人物合併、空殼 ----
async function seedPolicies(db: PGlite) {
  await db.exec(`
    INSERT INTO elections (id, election_date) VALUES (2022, '2022-11-26'), (2026, '2026-11-28') ON CONFLICT DO NOTHING;
    INSERT INTO regions VALUES (1, '高雄市', NULL), (2, '臺中市', NULL), (3, '高雄市', '前鎮區'), (4, '全國', NULL);
  `);
  const pe = (n: number, et: string, st: string, region: number, el = 2022) =>
    db.query(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) VALUES ($1, $2, $3, $4, $5)`, [P.pol(n), el, et, st, region]);
  const pol = (n: number, lin: number, el = 2022, removed = false) =>
    db.query(`INSERT INTO policies (id, lineage_id, politician_id, election_id, title, description, removed_at) VALUES ($1, $2, $3, $4, $5, '說明', $6)`,
      [u(5000 + n), P.lin(lin), P.pol(n), el, `政見${n}`, removed ? "2025-01-01" : null]);
  await pe(1, "縣市長", "elected", 1); await pol(1, 2); // 高雄市長 → 縣市
  await pe(2, "立法委員", "elected", 2); await pol(2, 2); // 立委台中 → 只放台中（縣市），不放中央
  await pe(3, "立法委員", "elected", 4); await pol(3, 2); // 立委全國（不分區）→ 中央
  await pe(4, "總統副總統", "elected", 4); await pol(4, 2); // 總統 → 中央
  await pe(5, "鄉鎮市長", "elected", 3); await pol(5, 2); // 前鎮區長 → 鄉鎮
  await pe(6, "縣市長", "not_elected", 1); await pol(6, 2); // 落選 → 不算
  await pe(7, "縣市長", "elected", 1, 2026); await pol(7, 2, 2026); // 2026 還沒投票 → 不算
  await pe(8, "縣市議員", "elected", 1); await pol(8, 2, 2022, true); // 已移除 → 不算
  // addPol 在後面放：它附的當選紀錄 id 較大，lineage_policy_place 取同屆第一列時仍取上面這些
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await addPol(db, n);
  await db.exec(`DELETE FROM politician_elections WHERE politician_id = '${P.pol(6)}' AND candidacy_status = 'elected'`); // 人物 6 要「落選」：拿掉 addPol 附的當選紀錄
}
Deno.test("B8 政見地方與涵蓋：一條政見一列（立委只放自己縣市）、落選／未投票／已移除不算；臺→台", async () => {
  const db = await linksDb();
  await seedPolicies(db);
  const place = async (n: number) => await rows(db, `SELECT level, region, sub_region FROM lineage_policy_place($1)`, [u(5000 + n)]);
  assertEquals(await place(1), [{ level: "county", region: "高雄市", sub_region: null }]);
  assertEquals(await place(2), [{ level: "county", region: "台中市", sub_region: null }], "立委台中：只一列、臺換台");
  assertEquals(await place(3), [{ level: "national", region: null, sub_region: null }]);
  assertEquals(await place(4), [{ level: "national", region: null, sub_region: null }]);
  assertEquals(await place(5), [{ level: "township", region: "高雄市", sub_region: "前鎮區" }]);
  const cov = (await rows<{ c: unknown }>(db, `SELECT lineage_coverage($1) AS c`, [P.lin(2)]))[0].c;
  assertEquals(cov, [
    { level: "national", region: null, sub_region: null, policy_count: 2 },
    { level: "county", region: "台中市", sub_region: null, policy_count: 1 },
    { level: "county", region: "高雄市", sub_region: null, policy_count: 1 },
    { level: "township", region: "高雄市", sub_region: "前鎮區", policy_count: 1 },
  ]);
  assertEquals((await rows<{ c: unknown }>(db, `SELECT lineage_coverage($1) AS c`, [P.lin(3)]))[0].c, []);
  assertEquals((await rows<{ n: number }>(db, `SELECT policy_count AS n FROM lineages_list WHERE id = $1`, [P.lin(2)]))[0].n, 5);
});

Deno.test("B9 lineage_term_df 與 lineage_norm：正規化、排除自己的脈絡、排除指定政見", async () => {
  const db = await linksDb();
  await seedPolicies(db);
  await db.exec(`UPDATE policies SET title = '台中捷運藍線' WHERE id IN ('${u(5001)}', '${u(5002)}'); UPDATE policies SET description = '臺中　捷運' WHERE id = '${u(5003)}'`);
  assertEquals((await rows<{ n: string }>(db, `SELECT lineage_norm('臺中　ＡＢｃ') AS n`))[0].n, "台中abc");
  const df = async (t: string, ex: string | null = null, exp: string[] = []) =>
    (await rows<{ n: number }>(db, `SELECT lineage_term_df($1, $2::uuid, $3::uuid[]) AS n`, [t, ex, exp]))[0].n;
  assertEquals(await df("台中捷運"), 3, "標題與正規化後的說明都算");
  assertEquals(await df("台中捷運", P.lin(2)), 0, "排除自己脈絡的政見");
  assertEquals(await df("台中捷運", null, [u(5001)]), 2, "排除指定政見");
  assertEquals(await df(" "), 0, "空詞不算");
});

Deno.test("B10 視圖形狀：lineages_full 尾端欄、立場／事件 JSON、合併人物對到保留者；lineages_list 與 lineage_terms", async () => {
  const db = await linksDb();
  await seedPolicies(db);
  await db.query(`UPDATE politicians SET merged_into = $1 WHERE id = $2`, [P.pol(1), P.pol(2)]);
  await db.query(stanceSql, [P.lin(2), P.pol(2), "conditional", "只有在環評通過之後才支持", "2026-03-01"]);
  await db.query(eventSql, [P.lin(2), "approved", "2026-02-01", "county", "高雄市", null, "64000", P.pol(2), "縣府提案"]);
  const f = (await rows<Record<string, any>>(db, `SELECT * FROM lineages_full WHERE id = $1`, [P.lin(2)]))[0];
  assertEquals(f.stances.length, 1);
  assertEquals(f.stances[0].politician_id, P.pol(1), "合併後指向保留者");
  assertEquals(f.stances[0].name, "人物1");
  assertEquals(f.stances[0].condition, "只有在環評通過之後才支持");
  assertEquals(f.stances[0].stance, "conditional");
  assertEquals(f.events[0].initiator, { politician_id: P.pol(1), name: "人物1", note: "縣府提案" });
  assertEquals(f.events[0].decided_by, "縣議會");
  assertEquals(f.status_count, 0);
  assertEquals(f.sources, []);
  assertEquals(f.search_terms, []);
  assertEquals(f.status, null);
  const l = (await rows<Record<string, any>>(db, `SELECT * FROM lineages_list WHERE id = $1`, [P.lin(2)]))[0];
  assertEquals([l.stance_count, l.event_count, l.handover_count], [1, 1, 1], "交接 1 筆是 linksDb 放的基準人物");
  assertEquals(l.status_phase, null);
  const none = (await rows<Record<string, any>>(db, `SELECT * FROM lineages_full WHERE id = $1`, [P.lin(3)]))[0];
  assertEquals([none.stances, none.events, none.coverage], [[], [], []], "空脈絡不報錯");
  // 任期：高雄市長（涉及的人 1）、前任與後任（沒涉及）都要在；議員只列涉及的人
  await db.exec(`
    INSERT INTO politician_offices (politician_id, election_type, region_id, start_date, scheduled_end_date) VALUES
      ('${P.pol(1)}', '縣市長', 1, '2022-12-25', '2026-12-24'),
      ('${P.pol(6)}', '縣市長', 1, '2018-12-25', '2022-12-24'),
      ('${P.pol(7)}', '縣市長', 1, '2026-12-25', '2030-12-24'),
      ('${P.pol(8)}', '縣市議員', 1, '2022-12-25', '2026-12-24');
  `);
  const t = await rows<{ name: string; involved: boolean }>(db, `SELECT name, involved FROM lineage_terms WHERE lineage_id = $1 AND election_type = '縣市長' ORDER BY start_date`, [P.lin(2)]);
  assertEquals(t, [{ name: "人物6", involved: false }, { name: "人物1", involved: true }, { name: "人物7", involved: false }],
    "前任（落選）與後任（還沒投票）補進泳道但不算涉及");
  const t2 = await rows<{ name: string; involved: boolean }>(db, `SELECT name, involved FROM lineage_terms WHERE lineage_id = $1 AND election_type = '縣市議員'`, [P.lin(2)]);
  assertEquals(t2, [], "議員 8 的政見已移除、不涉及，議員不補歷任");
});

Deno.test("B11 merge_politician：搬立場（撞同脈絡同日整列記履歷再刪）、搬事件推動者、回傳計數", async () => {
  const db = await linksDb();
  await addPol(db, 1);
  await addPol(db, 2);
  await db.query(stanceSql, [P.lin(2), P.pol(2), "support", null, "2026-03-01"]); // 會搬
  await db.query(stanceSql, [P.lin(2), P.pol(2), "oppose", null, "2026-04-01"]); // 撞保留者同日
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-04-01"]);
  await db.query(eventSql, [P.lin(2), "decided", "2026-03-01", "national", null, null, null, P.pol(2), "立委爭取"]);
  const r = (await rows<{ r: Record<string, number> }>(db, `SELECT merge_politician($1, $2, NULL, 'tester') AS r`, [P.pol(1), P.pol(2)]))[0].r;
  assertEquals([r.moved_stances, r.moved_events], [2, 1]);
  const st = await rows<{ p: string; d: string }>(db, `SELECT politician_id::text AS p, stated_on::text AS d FROM lineage_stances ORDER BY stated_on`);
  assertEquals(st, [{ p: P.pol(1), d: "2026-03-01" }, { p: P.pol(1), d: "2026-04-01" }]);
  assertEquals((await rows(db, `SELECT 1 FROM lineage_events WHERE initiator_politician_id = $1`, [P.pol(1)])).length, 1);
  const h = await rows<{ f: string; o: unknown }>(db, `SELECT field AS f, old_value AS o FROM edit_history WHERE table_name IN ('lineage_stances', 'lineage_events') ORDER BY id`);
  assertEquals(h.map((x) => x.f).sort(), ["*", "initiator_politician_id", "politician_id"].sort());
  assert(h.find((x) => x.f === "*")!.o !== null, "整列記進履歷");
});

Deno.test("B12 空殼人物：名下只剩一筆立場、或是某事件推動者，不算空殼；兩條都拿掉才會當空殼", async () => {
  const db = await linksDb();
  await addPol(db, 1);
  await addPol(db, 2);
  await addPol(db, 3);
  const rc = (await rows<{ id: string }>(db, `INSERT INTO contributions (contribution_type, status) VALUES ('reassign_candidacy', 'applied') RETURNING id::text AS id`))[0].id;
  for (const n of [1, 2, 3]) {
    await db.query(`INSERT INTO edit_history (table_name, record_id, field, old_value, contribution_id) VALUES ('politician_elections', $1, 'politician_id', to_jsonb($2::text), $3)`, [`pe${n}`, P.pol(n), rc]);
  }
  const orphans = async () => (await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_placeholder_politicians() ORDER BY 1`)).map((x) => x.task_id.split(":").pop());
  const clear = (ids: number[]) => db.exec(`DELETE FROM politician_offices WHERE politician_id IN (${ids.map((n) => `'${P.pol(n)}'`).join(", ")}); DELETE FROM politician_elections WHERE politician_id IN (${ids.map((n) => `'${P.pol(n)}'`).join(", ")})`);
  await clear([1, 2, 3]); // 空殼＝名下沒有參選紀錄也沒有任期
  assertEquals(await orphans(), [P.pol(1), P.pol(2), P.pol(3)]);
  await db.exec(`INSERT INTO politician_offices (politician_id, election_type, start_date, scheduled_end_date) VALUES ('${P.pol(1)}', '立委', '2022-12-25', '2026-12-24'), ('${P.pol(2)}', '立委', '2022-12-25', '2026-12-24');
    INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status) VALUES ('${P.pol(1)}', 2022, '縣市議員', 'elected'), ('${P.pol(2)}', 2022, '縣市議員', 'elected')`); // 立場與事件要有當選任期才收得進去
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-03-01"]);
  await db.query(eventSql, [P.lin(2), "decided", "2026-03-01", "national", null, null, null, P.pol(2), null]);
  await clear([1, 2]);
  assertEquals(await orphans(), [P.pol(3)]);
});

// ============================================================
// C. 還原驗證：把被守的東西拿掉，對應的檢查要紅
// ============================================================
Deno.test("C1 還原驗證：contains 退回「只看層級高低」→ 矩陣測試會紅", async () => {
  const bad = mutate(MIG, "OR (u.level = 'county'   AND d.level IN ('county', 'township') AND d.region IS NOT DISTINCT FROM u.region)",
    "OR (u.level = 'county'   AND d.level IN ('county', 'township'))");
  const res = await containsMatrix(bad);
  assert(res.some((r) => r.ok !== r.want), "壞版本必須被矩陣抓到");
});

Deno.test("C2 還原驗證：拿掉成環檢查 → 成環會寫進去", async () => {
  const a = MIG.indexOf("  IF EXISTS (\n    WITH RECURSIVE down(id)");
  const b = MIG.indexOf("  RETURN NEW;", a);
  assert(a > 0 && b > a);
  const bad = MIG.slice(0, a) + MIG.slice(b);
  const db = await linksDb(bad);
  await addLineage(db, 6, "national", null, null, null);
  await link(db, 1, 6);
  assertEquals(await rejects(link(db, 6, 1)), "", "壞版本讓成環通過（證明 B4 的守門有用）");
});

Deno.test("C3 還原驗證：拿掉立場的 touch_parent 觸發器 → 父脈絡 updated_at 不動", async () => {
  const bad = mutate(MIG, "DROP TRIGGER IF EXISTS trg_lineage_stances_touch_parent ON lineage_stances;\nCREATE TRIGGER trg_lineage_stances_touch_parent AFTER INSERT OR UPDATE OR DELETE ON lineage_stances\n  FOR EACH ROW EXECUTE FUNCTION lineage_touch_parents_on_content();\n", "");
  const db = await linksDb(bad);
  await addPol(db, 1);
  await db.exec(`UPDATE lineages SET updated_at = '2020-01-01T00:00:00Z'`);
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-03-01"]);
  assertFalse((await rows<{ m: boolean }>(db, `SELECT updated_at > '2020-01-02' AS m FROM lineages WHERE id = $1`, [P.lin(2)]))[0].m);
});

Deno.test("C4 還原驗證：拿掉 merge_politician 搬立場那段 → 立場還掛在被合併的人身上", async () => {
  const a = MIG.indexOf("  -- >>> #675：政策脈絡的立場");
  const b = MIG.indexOf("  -- 政策脈絡事件的推動者");
  assert(a > 0 && b > a);
  const bad = MIG.slice(0, a) + MIG.slice(b);
  const db = await linksDb(bad);
  await addPol(db, 1);
  await addPol(db, 2);
  await db.query(stanceSql, [P.lin(2), P.pol(2), "support", null, "2026-03-01"]);
  await db.exec(`SELECT merge_politician('${P.pol(1)}', '${P.pol(2)}', NULL, 'tester')`).catch(() => {});
  assertEquals((await rows(db, `SELECT 1 FROM lineage_stances WHERE politician_id = '${P.pol(2)}'`)).length, 1, "壞版本沒搬（B11 會紅）");
});

Deno.test("C5 還原驗證：空殼人物拿掉立場條件 → 只剩一筆立場的人會被當空殼", async () => {
  const bad = mutate(MIG, "     AND NOT EXISTS (SELECT 1 FROM lineage_stances x WHERE x.politician_id = p.id)\n", "");
  const db = await linksDb(bad);
  await addPol(db, 1);
  const rc = (await rows<{ id: string }>(db, `INSERT INTO contributions (contribution_type, status) VALUES ('reassign_candidacy', 'applied') RETURNING id::text AS id`))[0].id;
  await db.query(`INSERT INTO edit_history (table_name, record_id, field, old_value, contribution_id) VALUES ('politician_elections', 'pe1', 'politician_id', to_jsonb($1::text), $2)`, [P.pol(1), rc]);
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-03-01"]);
  await db.exec(`DELETE FROM politician_offices WHERE politician_id = '${P.pol(1)}'; DELETE FROM politician_elections WHERE politician_id = '${P.pol(1)}'`);
  assertEquals((await rows(db, `SELECT 1 FROM contribution_auto_tasks_placeholder_politicians()`)).length, 1, "壞版本把有立場的人當空殼");
});

Deno.test("C6 還原驗證：權限守門抓得到 GRANT ALL 給 anon 的壞版本", () => {
  const bad = MIG.replace("GRANT SELECT ON lineage_stances TO anon, authenticated;", "GRANT ALL ON lineage_stances TO anon, authenticated;");
  assert(bad !== MIG);
  const grants = code(bad).split("\n").filter((l) => /^\s*GRANT\b/i.test(l));
  assert(grants.some((g) => /\bGRANT\s+ALL\b[^;]*\bTO\s+[^;]*\b(anon|authenticated)\b/i.test(g)), "A4 的檢查規則要抓得到它");
});

// ============================================================
// D. 一期補充裁定（主線 11-20）：政見追溯、軟刪除、爭議旗標、同日多次表態、任期防線、起跑日、只在內容異動時蓋父脈絡
// ============================================================
Deno.test("D1 任期防線：選前（任期外）的表態日與決定日插不進去；任期內可以；只換人（合併）不重判", async () => {
  const db = await linksDb();
  await addPol(db, 1);
  assert(await rejects(db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2020-01-01"])), "選前表態要被拒");
  assert(await rejects(db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-12-25"])), "任期結束後也要被拒");
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2022-12-25"]);
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-12-24"]);
  assert(await rejects(db.query(`UPDATE lineage_stances SET stated_on = '2020-01-01' WHERE stated_on = '2022-12-25'`)), "改日期也要重判");
  // 事件：有推動者看推動者的任期；沒有推動者看政見持有人與交接雙方的任期（基準人物是政見持有人／交接前任、2018 與 2022 兩屆當選，涵蓋 2018-12-25～2026-12-24）
  assert(await rejects(db.query(eventSql, [P.lin(2), "approved", "2020-01-01", "national", null, null, null, P.pol(1), null])), "推動者還沒就任");
  await db.query(eventSql, [P.lin(2), "approved", "2023-01-01", "national", null, null, null, P.pol(1), null]);
  assert(await rejects(db.query(eventSql, [P.lin(2), "decided", "2017-01-01", "national", null, null, null, null, null])), "早於涉及的人最早任期");
  await db.query(eventSql, [P.lin(2), "decided", "2019-01-01", "national", null, null, null, null, null]);
  const empty = await buildDb();
  await addLineage(empty, 1, "national", null, null, null);
  assert(await rejects(empty.query(eventSql, [P.lin(1), "decided", "2026-01-01", "national", null, null, null, null, null])), "沒有任何涉及的人（空脈絡）不收事件");
  // 合併：被併的人的立場日期只在他自己的任期內，搬給保留者不重判
  const m = await linksDb();
  await addPol(m, 1);
  await addPol(m, 2);
  await m.exec(`UPDATE politician_elections SET election_id = 2018 WHERE politician_id = '${P.pol(2)}'`);
  await m.query(stanceSql, [P.lin(2), P.pol(2), "support", null, "2020-05-05"]);
  await m.exec(`SELECT merge_politician('${P.pol(1)}', '${P.pol(2)}', NULL, 'tester')`);
  assertEquals((await rows(m, `SELECT 1 FROM lineage_stances WHERE politician_id = '${P.pol(1)}' AND stated_on = '2020-05-05'`)).length, 1);
});

Deno.test("D2 軟刪除與爭議旗標：removed_at 不佔唯一鍵位、視圖與人數濾掉；爭議欄成對；RLS 只讓公開讀到沒撤下的", async () => {
  const db = await linksDb();
  await addPol(db, 1);
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-03-01"]);
  await db.query(eventSql, [P.lin(2), "decided", "2026-03-01", "national", null, null, null, P.pol(1), null]);
  const shown = async () => (await rows<{ s: number; e: number; ls: number; le: number }>(db,
    `SELECT json_array_length(stances)::int AS s, json_array_length(events)::int AS e,
            (SELECT stance_count FROM lineages_list WHERE id = lineages_full.id) AS ls, (SELECT event_count FROM lineages_list WHERE id = lineages_full.id) AS le
       FROM lineages_full WHERE id = $1`, [P.lin(2)]))[0];
  assertEquals(await shown(), { s: 1, e: 1, ls: 1, le: 1 });
  await db.exec(`UPDATE lineage_stances SET removed_at = now(); UPDATE lineage_events SET removed_at = now()`);
  assertEquals(await shown(), { s: 0, e: 0, ls: 0, le: 0 }, "撤下的不顯示也不算筆數");
  assertEquals((await rows(db, `SELECT 1 FROM lineage_people lp WHERE lp.lineage_id = $1 AND lp.politician_id = $2`, [P.lin(2), P.pol(1)])).length, 0, "撤下的立場與推動者不算涉及的人");
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-03-01"]); // 同一句撤下後可以重收
  await db.query(eventSql, [P.lin(2), "decided", "2026-03-01", "national", null, null, null, P.pol(1), null]);
  assertEquals(await shown(), { s: 1, e: 1, ls: 1, le: 1 });
  // 爭議旗標：兩欄同有同無、公開仍可見並帶出旗標
  assert(await rejects(db.exec(`UPDATE lineage_stances SET disputed_at = now() WHERE removed_at IS NULL`)), "只有時間沒有說明要被擋");
  assert(await rejects(db.exec(`UPDATE lineage_events SET dispute_note = '有人質疑這筆決定的日期' WHERE removed_at IS NULL`)), "只有說明沒有時間要被擋");
  await db.exec(`UPDATE lineage_stances SET disputed_at = now(), dispute_note = '原文出處有人質疑' WHERE removed_at IS NULL`);
  const f = (await rows<{ st: Array<{ dispute_note: string }> }>(db, `SELECT stances AS st FROM lineages_full WHERE id = $1`, [P.lin(2)]))[0].st;
  assertEquals(f[0].dispute_note, "原文出處有人質疑");
  // RLS：anon 只看得到沒撤下的、不能寫
  await db.exec(`GRANT USAGE ON SCHEMA public TO anon`);
  await db.exec(`SET ROLE anon`);
  try {
    assertEquals((await rows(db, `SELECT 1 FROM lineage_stances`)).length, 1, "公開讀不到撤下的");
    assert(await rejects(db.exec(`INSERT INTO lineage_stances (lineage_id, politician_id, stance, stated_on, quote, source_url, source_locator) VALUES ('${P.lin(2)}', '${P.pol(1)}', 'support', '2026-03-02', '匿名不能寫的一段原文摘句', 'https://a.tw', 'x')`)), "anon 不能寫");
    assert(await rejects(db.exec(`UPDATE lineage_events SET removed_at = NULL`)), "anon 不能改");
    assert(await rejects(db.exec(`TRUNCATE lineage_stances`)), "anon 不能清表");
  } finally {
    await db.exec(`RESET ROLE`);
  }
});

Deno.test("D3 立場可掛政見（policy_id）；政見刪掉只清空不連坐", async () => {
  const db = await linksDb();
  await seedPolicies(db);
  await db.query(`INSERT INTO lineage_stances (lineage_id, politician_id, policy_id, stance, stated_on, quote, source_url, source_locator) VALUES ($1, $2, $3, 'support', '2026-03-01', '這是一段八個字以上的原文摘句', 'https://a.tw', 'p')`, [P.lin(2), P.pol(1), u(5001)]);
  assertEquals((await rows<{ p: string }>(db, `SELECT policy_id::text AS p FROM lineage_stances`))[0].p, u(5001));
  assert(await rejects(db.query(`INSERT INTO lineage_stances (lineage_id, politician_id, policy_id, stance, stated_on, quote, source_url, source_locator) VALUES ($1, $2, $3, 'support', '2026-03-02', '這是一段八個字以上的原文摘句', 'https://a.tw', 'p')`, [P.lin(2), P.pol(1), u(9999)])), "不存在的政見要被擋");
  await db.query(`DELETE FROM policies WHERE id = $1`, [u(5001)]);
  assertEquals((await rows<{ p: string | null }>(db, `SELECT policy_id::text AS p FROM lineage_stances`))[0].p, null);
  const f = (await rows<{ st: Array<{ policy_id: string | null }> }>(db, `SELECT stances AS st FROM lineages_full WHERE id = $1`, [P.lin(2)]))[0].st;
  assertEquals(f.length, 1);
});

Deno.test("D4 起跑日 dispatch_start_on 預設 2026-11-29（只加欄、沒有函式讀它）", async () => {
  const db = await buildDb();
  assertEquals((await rows<{ d: string }>(db, `SELECT dispatch_start_on::text AS d FROM lineage_settings WHERE id = 1`))[0].d, "2026-11-29");
  for (const n of await migrationNames()) {
    if (n === MIG_NAME) continue;
    assertFalse((await readMig(n)).includes("dispatch_start_on"), `${n} 不該讀 dispatch_start_on（一期只加欄）`);
  }
  assertFalse(code(MIG).replace(/ALTER TABLE lineage_settings[^;]*;/g, "").replace(/COMMENT ON COLUMN lineage_settings\.dispatch_start_on IS '[^']*';/g, "").replace(/'[^']*'/g, "").includes("dispatch_start_on"), "migration 本身只有 ADD COLUMN");
});

Deno.test("D5 父脈絡 updated_at 只在內容異動時蓋：沒變的 UPDATE、只蓋時間戳或 contribution_id 不動；內容改了才動", async () => {
  const db = await linksDb();
  await addPol(db, 1);
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-03-01"]);
  const old = "2020-01-01T00:00:00Z";
  const moved = async () => (await rows<{ m: boolean }>(db, `SELECT updated_at > '${old}' AS m FROM lineages WHERE id = $1`, [P.lin(2)]))[0].m;
  await db.exec(`UPDATE lineages SET updated_at = '${old}'`);
  await db.exec(`UPDATE lineage_stances SET quote = quote`);
  assertFalse(await moved(), "沒變的 UPDATE 不蓋");
  await db.exec(`UPDATE lineage_stances SET contribution_id = NULL, updated_at = now()`);
  assertFalse(await moved(), "只蓋時間戳不蓋");
  await db.exec(`UPDATE lineage_stances SET note = '補一句備註'`);
  assert(await moved(), "內容變了才蓋");
  await db.exec(`UPDATE lineages SET updated_at = '${old}'`);
  await db.exec(`UPDATE lineage_participants SET note = note`);
  assertFalse(await moved(), "參與者沒變的 UPDATE 也不蓋");
});

Deno.test("C7 還原驗證：拿掉任期防線觸發器 → 選前日期插得進去", async () => {
  const bad = mutate(MIG, "DROP TRIGGER IF EXISTS trg_lineage_stances_check_term ON lineage_stances;\nCREATE TRIGGER trg_lineage_stances_check_term BEFORE INSERT OR UPDATE OF stated_on, politician_id ON lineage_stances\n  FOR EACH ROW EXECUTE FUNCTION lineage_stances_check_term();\n", "");
  const db = await linksDb(bad);
  await addPol(db, 1);
  assertEquals(await rejects(db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2020-01-01"])), "", "壞版本讓選前日期通過（D1 會紅）");
});

Deno.test("C8 還原驗證：立場唯一鍵退回不含原文 → 同日第二句會撞鍵", async () => {
  const bad = mutate(MIG, "(lineage_id, politician_id, stated_on, quote_hash)", "(lineage_id, politician_id, stated_on)");
  const db = await linksDb(bad);
  await addPol(db, 1);
  await db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2026-03-01"]);
  assert(await rejects(db.query(`INSERT INTO lineage_stances (lineage_id, politician_id, stance, stated_on, quote, source_url, source_locator) VALUES ($1, $2, 'oppose', '2026-03-01', '同一天另一句完全不同的原文摘句', 'https://a.tw', 'x')`, [P.lin(2), P.pol(1)])), "壞版本互相覆蓋（B1 會紅）");
});

Deno.test("D6 任期防線 SQL 與 TS 逐案比對：投票日當天算未投票、任期起迄當天都算在內、落選與還沒投票都擋、合併過的人看保留者；參與者不算涉及的人", async () => {
  const db = await linksDb();
  await addPol(db, 1);
  await db.exec(`INSERT INTO elections (id, election_date) VALUES (2026, '2026-11-20')`); // 今天就是投票日
  await db.query(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status) VALUES ($1, 2026, '縣市議員', 'elected')`, [P.pol(1)]);
  await addPol(db, 2);
  await db.exec(`UPDATE politician_elections SET candidacy_status = 'not_elected' WHERE politician_id = '${P.pol(2)}'`);
  const win = (election_date: string, candidacy_status: string, term_start: string, term_end: string | null) => ({ election_date, candidacy_status, term_start, term_end });
  const cases: Array<[number, ReturnType<typeof win>[], string]> = [];
  for (const d of ["2018-12-25", "2022-12-24", "2022-12-25", "2026-12-24", "2026-12-25", "2030-01-01"]) {
    cases.push([1, [win("2022-11-26", "elected", "2022-12-25", "2026-12-24"), win("2026-11-20", "elected", "2026-12-25", "2030-12-24")], d]);
    cases.push([2, [win("2022-11-26", "not_elected", "2022-12-25", "2026-12-24")], d]);
  }
  for (const [n, windows, d] of cases) {
    const sql = (await rows<{ ok: boolean }>(db, `SELECT lineage_stance_within_elected_term($1, $2::date, '2026-11-20') AS ok`, [P.pol(n), d]))[0].ok;
    // 2026 屆今天是投票日＝還沒投票，所以 2026-12-25 之後只有 SQL 的資料沒有那一屆時也一樣不收：TS 這邊同樣把它當未投票
    assertEquals(sql, isDateWithinElectedTerm(windows, d, "2026-11-20"), `人物${n} ${d}`);
  }
  assertEquals(isDateWithinElectedTerm([win("2026-11-20", "elected", "2026-12-25", null)], "2027-01-01", "2026-11-20"), false, "投票日當天算還沒投票");
  assertEquals(isDateWithinElectedTerm([win("2026-11-20", "elected", "2026-12-25", null)], "2027-01-01", "2026-11-21"), true, "隔天起算已投票，沒有迄日也過");
  // 事件沒有推動者：參與者不算「涉及的人」，只有政見持有人與交接雙方算
  await addLineage(db, 20, "national", null, null, null);
  await db.query(`INSERT INTO lineage_participants (lineage_id, politician_id) VALUES ($1, $2)`, [P.lin(20), P.pol(1)]);
  assertEquals((await rows<{ ok: boolean }>(db, `SELECT lineage_event_within_elected_term($1, NULL, '2024-01-01') AS ok`, [P.lin(20)]))[0].ok, false, "只有參與者＝沒有涉及的人");
  await db.query(`INSERT INTO handovers (lineage_id, to_politician_id) VALUES ($1, $2)`, [P.lin(20), P.pol(1)]);
  assertEquals((await rows<{ ok: boolean }>(db, `SELECT lineage_event_within_elected_term($1, NULL, '2024-01-01') AS ok`, [P.lin(20)]))[0].ok, true, "交接的一方算");
  assertEquals((await rows<{ ok: boolean }>(db, `SELECT lineage_event_within_elected_term($1, NULL, '2019-01-01') AS ok`, [P.lin(20)]))[0].ok, false, "選前日期擋");
});

Deno.test("C9 還原驗證：任期函式改成恆真 → 選前日期插得進去", async () => {
  const bad = mutate(MIG, "  SELECT EXISTS (\n    SELECT 1\n      FROM politician_elections q", "  SELECT true OR EXISTS (\n    SELECT 1\n      FROM politician_elections q");
  const db = await linksDb(bad);
  await addPol(db, 1);
  assertEquals(await rejects(db.query(stanceSql, [P.lin(2), P.pol(1), "support", null, "2020-01-01"])), "", "壞版本讓選前日期通過");
});
