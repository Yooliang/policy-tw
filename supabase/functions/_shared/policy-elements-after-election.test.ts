/**
 * 政見三要素選後 50 天自動開、只派當選者（migration 20261115050000；維護者 2026-11-15，群組 #778；取代同日暫停 20261115030000）。
 *   A. 文字層：臂本體＝緊接在前的那一版（20261010100000）加一處機械式替換（WHERE 改成「已投票且當選」）
 *   B. PGlite（臂）：落選者、撤回者、選前在選的人、已達成的都不派；當選者照派
 *   C. PGlite（規則＋總表）：投票日 +50 之前窗口關、之後開（台北日界）；opened_by 帶規則與里程碑
 *   還原驗證：把限定當選者拿掉、把偏移改小，對應的守門必須紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { buildArmsDb, fnText, type GapRow, latestFn, mutate, readMig } from "./arms-pglite.ts";

const MIG = "20261115050000_policy_elements_after_election.sql";
const SQL = await readMig(MIG);
const ARM = "contribution_auto_tasks_policy_elements";
const NEW = fnText(SQL, ARM);
const PREV = await latestFn(ARM, MIG);

const OLD_COND = `       AND (
         -- 還沒投票：在選的人（選前要能並排比較）
         (e.election_date >= CURRENT_DATE AND x.candidacy_status IS DISTINCT FROM 'withdrawn')
         -- 已投票：當選者、而且還沒達成也沒跳票（期限要接得上追蹤）
         OR (e.election_date < CURRENT_DATE AND x.candidacy_status = 'elected' AND pl.status::TEXT NOT IN ('Achieved', 'Failed'))
       )
`;
const NEW_COND = `       -- 只派當選者（維護者 2026-11-15）：投票之後、當選、而且還沒達成也沒跳票（期限要接得上追蹤）；選前在選的人不再派。何時開由規則 33 的窗口決定（投票日 +50）
       AND e.election_date < CURRENT_DATE AND x.candidacy_status = 'elected' AND pl.status::TEXT NOT IN ('Achieved', 'Failed')
`;

Deno.test("A1 前一版是 20261010100000（中間沒有人插一版）", async () => {
  assert(PREV.includes(OLD_COND));
  assert((await readMig("20261010100000_policy_elements_config.sql")).includes(PREV));
});

Deno.test("A2 臂本體＝前一版加一處機械式替換，其餘一字不差", () => {
  assertEquals(mutate(PREV, OLD_COND, NEW_COND), NEW);
  assertEquals(NEW.split("\n").slice(0, 5).join("\n"), PREV.split("\n").slice(0, 5).join("\n"));
});

Deno.test("A3 migration 只動這支臂與規則 33（params、職位不動）", () => {
  const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]);
  assertEquals(defined, [ARM]);
  assertEquals(code.split("UPDATE activity_rules").length - 1, 1);
  assert(code.includes("WHERE id = 33 AND activity = 'policy_elements'"));
  assert(code.includes("window_kind = 'event', from_kind = 'polling', from_offset = 50, until_kind = NULL"));
  const setPart = code.split("UPDATE activity_rules")[1].split("WHERE id = 33")[0];
  assert(!/(params|election_types)\s*=/.test(setPart));
});

// ---------------- B. 臂 ----------------
const PA = "00000000-0000-4000-8000-00000000000a"; // 當選
const PB = "00000000-0000-4000-8000-00000000000b"; // 落選
const PC = "00000000-0000-4000-8000-00000000000c"; // 撤回
const PD = "00000000-0000-4000-8000-00000000000d"; // 當選但已達成
const PE = "00000000-0000-4000-8000-00000000000e"; // 選前（2030，在選）
const PEOPLE = ["a", "b", "c", "d", "e"].map((x) => `10000000-0000-4000-8000-00000000000${x}`);

async function armDb(armDef: string): Promise<PGlite> {
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
    INSERT INTO activity_rules (id, activity, priority, params, enabled) VALUES (33, 'policy_elements', NULL, '{"elements":["target"],"election_ids":[2026,2030]}', true);
    INSERT INTO elections VALUES (2026, CURRENT_DATE - 60, NULL, NULL), (2030, CURRENT_DATE + 30, NULL, NULL);
  `);
  for (const [i, id] of PEOPLE.entries()) await d.query(`INSERT INTO politicians VALUES ($1, $2, '無', '臺北市', NULL)`, [id, `人${i}`]);
  const ins = (p: string, el: number, st: string) =>
    d.query(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status) VALUES ($1, $2, '縣市長', $3)`, [p, el, st]);
  await ins(PEOPLE[0], 2026, "elected");
  await ins(PEOPLE[1], 2026, "not_elected");
  await ins(PEOPLE[2], 2026, "withdrawn");
  await ins(PEOPLE[3], 2026, "elected");
  await ins(PEOPLE[4], 2030, "filed");
  const pol = (id: string, who: number, el: number, st = "Not Started") => d.query(`INSERT INTO policies VALUES ($1, '政見', $2, $3, $4, NULL)`, [id, st, el, PEOPLE[who]]);
  await pol(PA, 0, 2026);
  await pol(PB, 1, 2026);
  await pol(PC, 2, 2026);
  await pol(PD, 3, 2026, "Achieved");
  await pol(PE, 4, 2030);
  await d.exec(armDef);
  return d;
}
const armOut = async (d: PGlite) => (await d.query<{ target: { policy_id: string } }>(`SELECT target FROM ${ARM}()`)).rows.map((r) => r.target.policy_id).sort();

Deno.test("B1 只派當選者：落選、撤回、選前在選、已達成都不派", async () => {
  const d = await armDb(NEW);
  assertEquals(await armOut(d), [PA]);
  await d.close();
});

Deno.test("B2 對照：前一版會派選前在選的 2030（新版不派）", async () => {
  const d = await armDb(PREV);
  assertEquals(await armOut(d), [PA, PE]);
  await d.close();
});

Deno.test("B3 還原驗證：拿掉當選限定，落選者與撤回者就派出去了", async () => {
  const broken = NEW.replace("AND x.candidacy_status = 'elected' ", "");
  assert(broken !== NEW);
  const d = await armDb(broken);
  const o = await armOut(d);
  assert(o.includes(PB) && o.includes(PC));
  await d.close();
});

// ---------------- C. 規則窗口（真的總表＋activity_open，臂換成回放 stub） ----------------
const ROW: GapRow = {
  task_id: "auto:policy_elements_missing:" + PA, task_type: "policy_elements_missing",
  target: { policy_id: PA, election_id: 2026, election_type: "縣市長", missing: ["target"] }, what_we_need: "x", hint_sources: [], reward: 1, region: "臺北市",
};
const open = async (d: PGlite, day: string) => {
  await d.exec(`SET app.activity_today = '${day}'`);
  return (await d.query(`SELECT task_id, opened_by FROM contribution_auto_tasks_arms() WHERE arm = 'policy_elements'`)).rows as Array<{ task_id: string; opened_by: Record<string, unknown> }>;
};
// 投票日 2026-11-28 + 50 天 = 2027-01-17
const LAST_CLOSED = "2027-01-16";
const FIRST_OPEN = "2027-01-17";

async function ruleDb(mut: (s: string) => string = (s) => s): Promise<PGlite> {
  // 測試環境的規則編號不一定是 33：把 migration 的 id 換成真正的那一條
  const probe = await buildArmsDb({ branches: { policy_elements: [ROW] } });
  const id = (await probe.query<{ id: number }>(`SELECT id FROM activity_rules WHERE activity = 'policy_elements'`)).rows[0].id;
  await probe.close();
  return buildArmsDb({
    branches: { policy_elements: [ROW] },
    p2: { migs: [{ name: MIG, mutate: (s) => mut(s.replaceAll("id = 33", `id = ${id}`)) }], restub: ["policy_elements"] },
  });
}

Deno.test("C1 投票日 +50 之前窗口關、之後開，opened_by 帶規則與里程碑", async () => {
  const d = await ruleDb();
  for (const day of ["2026-10-08", "2026-11-28", "2026-12-29", LAST_CLOSED]) assertEquals((await open(d, day)).length, 0, day);
  for (const day of [FIRST_OPEN, "2027-06-01"]) {
    const r = await open(d, day);
    assertEquals(r.length, 1, day);
    assertEquals(r[0].opened_by.basis, "rule");
    assertEquals(r[0].opened_by.milestone_kind, "polling");
    assertEquals(r[0].opened_by.election_id, 2026);
  }
  const { rows } = await d.query(`SELECT enabled, window_kind, from_kind, from_offset, until_kind FROM activity_rules WHERE activity = 'policy_elements'`);
  assertEquals(rows, [{ enabled: true, window_kind: "event", from_kind: "polling", from_offset: 50, until_kind: null }]);
  await d.close();
});

Deno.test("C2 還原驗證：偏移改成 0，投票日 +49 就開了（守門會抓到）", async () => {
  const d = await ruleDb((s) => mutate(s, "from_offset = 50, until_kind", "from_offset = 0, until_kind").replace("r.from_offset IS DISTINCT FROM 50", "r.from_offset IS DISTINCT FROM 0"));
  assertEquals((await open(d, LAST_CLOSED)).length, 1);
  await d.close();
});

Deno.test("C3 migration 自我檢查：規則不是預期形狀就整支停下", async () => {
  let threw = false;
  try {
    await ruleDb((s) => mutate(s, "AND r.from_offset IS DISTINCT FROM 50", "").replace("r.from_offset IS DISTINCT FROM 50", "r.from_offset IS DISTINCT FROM 50").replace("from_offset = 50, until_kind", "from_offset = 49, until_kind"));
  } catch {
    threw = true;
  }
  assert(threw);
});
