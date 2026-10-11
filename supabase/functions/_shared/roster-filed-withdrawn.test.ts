/**
 * 名單清查重查判準：登記後才退選的人，名冊人數要扣掉（#466 雜項，#449 留下的殘留不一致；migration 20261009230000）。
 *
 * 問題：roster_check 的判準是「最近一次回報的 cec_count > 我們的名冊內人數 n_listed 就繼續派」，n_listed 不算退選的。
 * 登記後才退選的人（withdrawn_after_filing 為真）在中選會名冊上，狀態卻是對的、不該改：
 * 正式庫 2026-10-09 唯讀：台南市議員名冊 88 位、n_listed 86、另有 2 位登記後退選（蔡育輝、謝秉舟，都在名冊上）→ 88 > 86 每 10 分鐘派一次。
 *
 * 守的事：
 *   1. 新定義＝20261008162000 的現行版＋三處機械替換（反向替換回去逐字相同）；而且是 raw 的最後一版
 *   2. 行為（PGlite 跑 raw 本體裡的 ours／filed_out／roster_check 原文）：扣掉登記後退選的人之後才比；只扣 withdrawn_after_filing 為真的、
 *      只扣同一屆同一種選舉同一個縣市的；代理自己已經減掉的舊回報不誤派；真的還缺人照派
 *   3. 還原驗證：把判準改壞，指定的情境必須轉紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const MIG = "20261009230000_roster_check_filed_withdrawn.sql";
const PREV_MIG = "20261008162000_activity_windows_p2_candidate_status_stale.sql";
const FN = "contribution_auto_tasks_raw";

const bodyOf = (fn: string) => fn.slice(fn.indexOf("$function$") + "$function$".length, fn.lastIndexOf("$function$"));
const headerOf = (fn: string) => fn.slice(0, fn.indexOf("$function$") + "$function$".length);

const EDITS: Array<[string, string]> = [
  ["    GROUP BY 1, 2, 3\n  )\n  SELECT 'auto:policy_missing:'",
    "    GROUP BY 1, 2, 3\n  ),\n" +
    "  -- 登記後才退選的人（withdrawn_after_filing 為真）：他們在中選會登記名冊上，但 ours 不收退選的，名冊人數比我們的名冊內人數多出這幾位\n" +
    "  filed_out AS (\n" +
    "    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n_filed_out\n" +
    "    FROM politician_elections pe\n" +
    "    JOIN politicians p ON p.id = pe.politician_id\n" +
    "    LEFT JOIN regions r ON r.id = pe.region_id\n" +
    "    WHERE pe.candidacy_status = 'withdrawn' AND pe.withdrawn_after_filing IS TRUE\n" +
    "    GROUP BY 1, 2, 3\n" +
    "  )\n  SELECT 'auto:policy_missing:'"],
  ["  LEFT JOIN ours o ON o.election_id = s.election_id AND o.election_type = s.election_type AND o.region = l.name\n",
    "  LEFT JOIN ours o ON o.election_id = s.election_id AND o.election_type = s.election_type AND o.region = l.name\n" +
    "  LEFT JOIN filed_out fo ON fo.election_id = s.election_id AND fo.election_type = s.election_type AND fo.region = l.name\n"],
  ["         OR COALESCE(rc.last_cec_count, 0) > COALESCE(o.n_listed, 0)\n",
    "         -- 登記後才退選的人在名冊上、不在我們的名冊內人數裡：回報的名冊人數先扣掉他們再比（不扣，名冊 88 位、我們 86 位加 2 位登記後退選，會永遠派下去）\n" +
    "         OR COALESCE(rc.last_cec_count, 0) - COALESCE(fo.n_filed_out, 0) > COALESCE(o.n_listed, 0)\n"],
];
const reverse = (body: string) => EDITS.reduce((s, [from, to]) => mutate(s, to, from), body);

const NEW_FN = fnText(await readMig(MIG), FN);
const PREV_FN = fnText(await readMig(PREV_MIG), FN);
const NEW_BODY = bodyOf(NEW_FN);

Deno.test("FW-1 新定義緊接著 20261008162000，而且是 raw 的最後一版（之後有人改了，抄的底就過期）", async () => {
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${FN}(`)) defining.push(n);
  const i = defining.indexOf(MIG);
  assert(i > 0, "新 migration 要在重新定義 raw 的清單裡");
  assertEquals(defining[i - 1], PREV_MIG, `raw 的前一版應該是 ${PREV_MIG}；有人在中間改了，要以那一版為底重做`);
  // 20261010170000（OPS #72）只拿掉 election_result_missing 分支，其餘一字不動（retire-single-result.test.ts 逐字守）
  assertEquals(defining.slice(i + 1), ["20261010170000_retire_single_election_result.sql"], "新 migration 之後又有人改了 raw：請以最新那版為底，把這三處替換套上去");
});

Deno.test("FW-2 新定義＝現行定義＋三處機械替換：反向替換回去逐字等於前一版（簽名、其他臂、roster_check 的 target／說明／reward 都沒動）", () => {
  assertEquals(headerOf(NEW_FN), headerOf(PREV_FN), "函式簽名與屬性不能動（STABLE、回傳欄位）");
  assertEquals(reverse(NEW_BODY), bodyOf(PREV_FN));
});

function rosterSql(body: string): string {
  const a = body.indexOf("  ours AS (");
  const b = body.indexOf("  SELECT 'auto:policy_missing:'");
  const c = body.indexOf("  SELECT 'auto:roster_check:'");
  const d = body.indexOf("  UNION ALL\n  SELECT 'auto:policy_election_missing:'");
  assert(a > 0 && b > a && c > b && d > c, "找不到 ours 或 roster_check 那一段");
  return `WITH ${body.slice(a, b).trim()}\n${body.slice(c, d)}`;
}

type Scenario = {
  name: string;
  /** [幾天前, cec_count] */
  reports: Array<[number, number | null]>;
  filed?: number;
  /** 退選且 withdrawn_after_filing 為真／空／假的人數（同一屆、同一種選舉、同一個縣市） */
  wafTrue?: number; wafNull?: number; wafFalse?: number;
  /** 登記後退選但屆別不同（2022）／選舉別不同（縣市長）的人數：不能被扣 */
  otherElection?: number; otherType?: number;
  want: boolean;
  why: string;
};
const SCENARIOS: Scenario[] = [
  { name: "f01_tainan", reports: [[1, 88]], filed: 86, wafTrue: 2, want: false, why: "台南市議員實例：名冊 88、n_listed 86、2 位登記後退選 → 扣掉後 86，沒有缺口，不再派" },
  { name: "f02_one_really_missing", reports: [[1, 88]], filed: 86, wafTrue: 1, want: true, why: "名冊 88、n_listed 86、只有 1 位登記後退選 → 扣掉後 87 > 86，還缺 1 位，照派" },
  { name: "f03_unknown_not_deducted", reports: [[1, 88]], filed: 86, wafNull: 2, want: true, why: "退選但看不出有沒有登記過（空的）不扣：那是 withdrawn_filing 臂要查的，查清楚之前不能先當成登記過" },
  { name: "f04_not_filed_not_deducted", reports: [[1, 88]], filed: 86, wafFalse: 2, want: true, why: "表態不參選（沒登記過，false）不在名冊上，不扣" },
  { name: "f05_agent_already_subtracted", reports: [[1, 86]], filed: 86, wafTrue: 2, want: false, why: "舊提示叫代理自己減：回報 86、扣掉後 84，沒有缺口，不能因為扣了兩次而誤派" },
  { name: "f06_small_unit", reports: [[1, 5]], filed: 3, wafTrue: 2, want: false, why: "名冊 5、n_listed 3、2 位登記後退選 → 扣掉後 3，沒有缺口" },
  { name: "f07_other_election", reports: [[1, 88]], filed: 86, otherElection: 2, want: true, why: "2022 年登記後退選的人不能拿來扣 2026 的名冊人數（比對要連屆別）" },
  { name: "f08_other_type", reports: [[1, 88]], filed: 86, otherType: 2, want: true, why: "縣市長登記後退選的人不能拿來扣縣市議員的名冊人數（比對要連選舉別）" },
  { name: "f09_old_report_still_rechecked", reports: [[8, 86]], filed: 86, wafTrue: 2, want: true, why: "沒有缺口、但 8 天前清查的：過了 recheck_days 照舊再派（這支只動缺口那一行）" },
  { name: "f10_no_withdrawn_unchanged", reports: [[1, 5]], filed: 3, want: true, why: "沒有登記後退選的人：行為跟以前一樣，名冊 5 > 我們 3 照派" },
  { name: "f11_equal_unchanged", reports: [[1, 3]], filed: 3, want: false, why: "沒有登記後退選的人、人數相同：照舊壓 7 天" },
];

async function seed(db: PGlite) {
  await db.exec(`
    CREATE TABLE locations (name text);
    CREATE TABLE roster_check_scope (election_id int, election_type text, recheck_days int NOT NULL DEFAULT 7, enabled boolean NOT NULL DEFAULT true,
      list_announced_on date, registration_closed_on date, qualification_review_by date, ballot_draw_on date, municipal_mayor_list_on date);
    CREATE TABLE roster_checks (id bigserial PRIMARY KEY, election_id int, region text, election_type text, checked_at timestamptz, cec_count int);
    CREATE TABLE politicians (id int PRIMARY KEY, region text);
    CREATE TABLE regions (id int PRIMARY KEY, region text);
    CREATE TABLE politician_elections (id serial PRIMARY KEY, politician_id int, election_id int, election_type text, region_id int, candidacy_status text, withdrawn_after_filing boolean);
    CREATE FUNCTION roster_attempt_cooldown_days() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
    CREATE FUNCTION roster_schedule_text(date, date, date, date, date, date DEFAULT CURRENT_DATE) RETURNS text LANGUAGE sql AS $$ SELECT '' $$;
    INSERT INTO roster_check_scope (election_id, election_type, list_announced_on, registration_closed_on) VALUES (2026, '縣市議員', '2026-11-17', '2026-09-04');
  `);
  let pid = 0;
  const add = async (region: string, eid: number, type: string, status: string, waf: boolean | null, n: number) => {
    for (let i = 0; i < n; i++) {
      pid++;
      await db.query(`INSERT INTO politicians VALUES ($1, $2)`, [pid, region]);
      await db.query(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, withdrawn_after_filing) VALUES ($1, $2, $3, $4, $5)`, [pid, eid, type, status, waf]);
    }
  };
  for (const s of SCENARIOS) {
    await db.query(`INSERT INTO locations VALUES ($1)`, [s.name]);
    for (const [d, c] of s.reports) await db.query(`INSERT INTO roster_checks (election_id, region, election_type, checked_at, cec_count) VALUES (2026, $1, '縣市議員', now() - ($2 || ' days')::interval, $3)`, [s.name, d, c]);
    await add(s.name, 2026, "縣市議員", "filed", null, s.filed ?? 0);
    await add(s.name, 2026, "縣市議員", "withdrawn", true, s.wafTrue ?? 0);
    await add(s.name, 2026, "縣市議員", "withdrawn", null, s.wafNull ?? 0);
    await add(s.name, 2026, "縣市議員", "withdrawn", false, s.wafFalse ?? 0);
    await add(s.name, 2022, "縣市議員", "withdrawn", true, s.otherElection ?? 0);
    await add(s.name, 2026, "縣市長", "withdrawn", true, s.otherType ?? 0);
  }
}

async function dispatched(db: PGlite, sql: string): Promise<Set<string>> {
  const r = await db.query<string[]>(sql, [], { rowMode: "array" });
  return new Set(r.rows.map((x) => x[0].split(":")[3]));
}

const db = new PGlite();
await seed(db);
const BASE = rosterSql(NEW_BODY);

Deno.test("FW-3 情境：名冊人數先扣掉登記後退選的人再比 n_listed；只扣 withdrawn_after_filing 為真、同屆同選舉同縣市的", async () => {
  const got = await dispatched(db, BASE);
  for (const s of SCENARIOS) assertEquals(got.has(s.name), s.want, `${s.name}：${s.why}`);
  // 對照：前一版（沒扣）在 f01、f06 會一直派——這就是要修的事；其餘情境新舊相同
  const old = await dispatched(db, rosterSql(bodyOf(PREV_FN)));
  assertEquals(old.has("f01_tainan"), true, "舊判準：台南市議員實例 88 > 86 會一直派");
  assertEquals(old.has("f06_small_unit"), true);
  const changed = SCENARIOS.filter((s) => old.has(s.name) !== got.has(s.name)).map((s) => s.name).sort();
  assertEquals(changed, ["f01_tainan", "f06_small_unit"], "新舊判準只在「扣掉後沒有缺口」的那兩件不同");
});

Deno.test("FW-4 還原驗證：把判準改壞（5 種），指定的情境必須轉紅", async () => {
  const COND = "COALESCE(rc.last_cec_count, 0) - COALESCE(fo.n_filed_out, 0) > COALESCE(o.n_listed, 0)";
  const MUTATIONS: Array<{ name: string; edit: (b: string) => string; breaks: string[] }> = [
    { name: "不扣（回到前一版判準）", edit: (b) => mutate(b, COND, "COALESCE(rc.last_cec_count, 0) > COALESCE(o.n_listed, 0)"), breaks: ["f01_tainan", "f06_small_unit"] },
    { name: "減號改加號", edit: (b) => mutate(b, "COALESCE(rc.last_cec_count, 0) - COALESCE(fo.n_filed_out, 0)", "COALESCE(rc.last_cec_count, 0) + COALESCE(fo.n_filed_out, 0)"), breaks: ["f01_tainan", "f06_small_unit"] },
    { name: "withdrawn_after_filing 為空、為假的也扣", edit: (b) => mutate(b, "pe.withdrawn_after_filing IS TRUE", "pe.withdrawn_after_filing IS NOT NULL OR pe.withdrawn_after_filing IS NULL"), breaks: ["f03_unknown_not_deducted", "f04_not_filed_not_deducted"] },
    { name: "扣的時候不比屆別", edit: (b) => mutate(b, "fo.election_id = s.election_id AND ", ""), breaks: ["f07_other_election"] },
    { name: "扣的時候不比選舉別", edit: (b) => mutate(b, " AND fo.election_type = s.election_type", ""), breaks: ["f08_other_type"] },
  ];
  for (const m of MUTATIONS) {
    const edited = m.edit(NEW_BODY);
    assert(edited !== NEW_BODY, `還原驗證「${m.name}」：替換沒套上，這條驗證是空的`);
    const got = await dispatched(db, rosterSql(edited));
    const red = SCENARIOS.filter((s) => got.has(s.name) !== s.want).map((s) => s.name);
    for (const must of m.breaks) assert(red.includes(must), `還原驗證「${m.name}」：${must} 應該轉紅，實際轉紅的是 [${red.join(", ")}]`);
  }
});

Deno.test("FW-5 文字同步：提示與協議不再叫代理自己減（task-context、skill.md 都改成「cec_count 填 registered，系統自己扣」）", async () => {
  const tc = await Deno.readTextFile(new URL("./task-context.ts", import.meta.url));
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  for (const [name, t] of [["task-context.ts", tc], ["skill.md", skill]] as const) {
    assert(!/registered\s*減掉/.test(t) && !t.includes("registered` 減掉"), `${name} 還叫代理把 registered 減掉登記後退選的人`);
    assert(!t.includes("除了③") && !t.includes("除了上面那種登記後退選的"), `${name} 的「兩組都做完才交」還留著「除了登記後退選」的例外`);
  }
  assert(tc.includes("系統扣"), "task-context.ts 要說明登記後退選的人由系統自己扣");
  assert(skill.includes("系統會自己扣"), "skill.md 要說明登記後退選的人由系統自己扣");
});
