/**
 * 地方基本統計（issue #508）：縣市與鄉鎮市區的人口、面積、總預算歲出、65 歲以上比例。
 * 一個地區一個指標一個年度一值，走代理交件 → 同儕驗證 → 落庫（migration 20261009240000／240100）。
 *
 * 守住：交件驗證（admin_code 形狀、stat_key、unit 對應、value 範圍）、落庫（新增／冪等／衝突退件）、
 * 四處清點（DB CHECK、TASK_TYPES／CONTRIBUTION_TYPES／SUGGESTED_TYPE、task-labels 純中文、skill.md）、
 * 派工臂接進 contribution_auto_tasks_arms 而且沒有掉臂、SQL 與 TS 的單位對照一致。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  CONTRIBUTION_TYPES,
  isRegionalStatAdminCode,
  REGIONAL_STAT_KEYS,
  REGIONAL_STAT_UNIT,
  TASK_TYPES,
  validateContributionRequest,
} from "./contribution-schema.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { hasGuidance, PAYLOAD_SHAPE } from "./task-guidance.ts";
import { applyContribution } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const C = "regional_stat" as const;
const T = "regional_stat_missing";
const SRC = "https://www.ris.gov.tw/app/portal/346";

async function readMigration(name: string): Promise<string> {
  return (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
}

// ── 1. admin_code 形狀 ─────────────────────────────────────────────
Deno.test("isRegionalStatAdminCode：縣市 5 碼、鄉鎮市區 8 碼過；村里 11 碼、非數字、空字串不過", () => {
  assert(isRegionalStatAdminCode("63000040")); // 鄉鎮市區 8 碼
  assert(isRegionalStatAdminCode("65000"));    // 縣市 5 碼
  assert(!isRegionalStatAdminCode("65000010010")); // 村里 11 碼
  assert(!isRegionalStatAdminCode("abc12"));
  assert(!isRegionalStatAdminCode(""));
  assert(!isRegionalStatAdminCode(undefined));
});

// ── 2. 交件驗證 ─────────────────────────────────────────────────
function goodPayload(overrides: Record<string, unknown> = {}) {
  return { admin_code: "65000", stat_key: "population", year: 2024, value: 2800000, unit: "人", ...overrides };
}

Deno.test("regional_stat 交件：合法的過", () => {
  const result = validateContributionRequest({
    agent_name: "tester",
    contributions: [{ contribution_type: C, payload: goodPayload(), source_urls: [SRC] }],
  });
  assertEquals(result.errors, []);
});

Deno.test("regional_stat 交件：admin_code 不是縣市或鄉鎮市區代碼 → 擋", () => {
  const result = validateContributionRequest({
    agent_name: "tester",
    contributions: [{ contribution_type: C, payload: goodPayload({ admin_code: "65000010010" }), source_urls: [SRC] }],
  });
  assert(result.errors.some((e) => e.path === "payload.admin_code"));
});

Deno.test("regional_stat 交件：stat_key 不認得 → 擋", () => {
  const result = validateContributionRequest({
    agent_name: "tester",
    contributions: [{ contribution_type: C, payload: goodPayload({ stat_key: "gdp" }), source_urls: [SRC] }],
  });
  assert(result.errors.some((e) => e.path === "payload.stat_key"));
});

Deno.test("regional_stat 交件：unit 跟 stat_key 對不上 → 擋（area_km2 要是平方公里，不是 km2 或人）", () => {
  const result = validateContributionRequest({
    agent_name: "tester",
    contributions: [{ contribution_type: C, payload: goodPayload({ stat_key: "area_km2", unit: "km2", value: 10 }), source_urls: [SRC] }],
  });
  assert(result.errors.some((e) => e.path === "payload.unit"));
});

Deno.test("regional_stat 交件：65 歲以上比例超過 100、面積不是正數 → 擋", () => {
  const over100 = validateContributionRequest({
    agent_name: "tester",
    contributions: [{ contribution_type: C, payload: goodPayload({ stat_key: "aging_rate", unit: "%", value: 120 }), source_urls: [SRC] }],
  });
  assert(over100.errors.some((e) => e.path === "payload.value"));
  const zeroArea = validateContributionRequest({
    agent_name: "tester",
    contributions: [{ contribution_type: C, payload: goodPayload({ stat_key: "area_km2", unit: "平方公里", value: 0 }), source_urls: [SRC] }],
  });
  assert(zeroArea.errors.some((e) => e.path === "payload.value"));
});

Deno.test("regional_stat 交件：as_of 給了要是真的日期", () => {
  const result = validateContributionRequest({
    agent_name: "tester",
    contributions: [{ contribution_type: C, payload: goodPayload({ as_of: "2022-13-40" }), source_urls: [SRC] }],
  });
  assert(result.errors.some((e) => e.path === "payload.as_of"));
});

// ── 3. 落庫 ─────────────────────────────────────────────────────
const row = (payload: Record<string, unknown>, id = "c-1") => ({
  id, contribution_type: C as typeof CONTRIBUTION_TYPES[number], payload, source_urls: [SRC], note: null, agent_name: "tester", contributor_url: null,
});

Deno.test("落庫：新增一筆，回 applied 並記 edit_history", async () => {
  const fake = createFakeSupabase({ regional_stats: [], edit_history: [] });
  const out = await applyContribution(fake.client, row(goodPayload()));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.regional_stats.length, 1);
  const inserted = fake.db.regional_stats[0];
  assertEquals([inserted.admin_code, inserted.stat_key, inserted.year, inserted.value, inserted.unit, inserted.source_url], ["65000", "population", 2024, 2800000, "人", SRC]);
  assert(fake.db.edit_history.some((e) => e.table_name === "regional_stats" && e.field === "*"));
});

Deno.test("落庫：已有一樣的數值 → superseded，不重寫", async () => {
  const fake = createFakeSupabase({
    regional_stats: [{ id: "s-1", admin_code: "65000", stat_key: "population", year: 2024, value: 2800000, unit: "人" }],
    edit_history: [],
  });
  const out = await applyContribution(fake.client, row(goodPayload()));
  assertEquals(out.status, "superseded");
  assertEquals(fake.db.regional_stats.length, 1);
});

Deno.test("落庫：已有不一樣的數值 → disputed，不覆蓋", async () => {
  const fake = createFakeSupabase({
    regional_stats: [{ id: "s-1", admin_code: "65000", stat_key: "population", year: 2024, value: 2700000, unit: "人" }],
    edit_history: [],
  });
  const out = await applyContribution(fake.client, row(goodPayload()));
  assertEquals(out.status, "disputed");
  assertEquals(fake.db.regional_stats[0].value, 2700000, "原值不能被改掉");
});

// ── 4. 四處清點 ───────────────────────────────────────────────────
Deno.test("四處清點：CONTRIBUTION_TYPES／TASK_TYPES／SUGGESTED_TYPE／task-labels（純中文）都登記了", async () => {
  assert((CONTRIBUTION_TYPES as readonly string[]).includes(C));
  assert((TASK_TYPES as readonly string[]).includes(T));
  assertEquals(SUGGESTED_TYPE[T], C);
  assert(hasGuidance(T), `${T} 沒有做法可以送給代理`);
  assert(PAYLOAD_SHAPE[C], `${C} 沒有回報的 payload 形狀說明`);

  const labels = await Deno.readTextFile(new URL("../../../lib/task-labels.ts", import.meta.url));
  assert(new RegExp(`\\b${T}:\\s*'[^']*'`).test(labels), "task-labels.ts 要有中文名稱");
  const labelLine = labels.match(new RegExp(`${T}:\\s*'([^']*)'`))?.[1] ?? "";
  assert(!/[A-Za-z]/.test(labelLine), "任務看板的中文名稱不該夾雜英文字母（UI 文字純中文）");

  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assertStringIncludes(skill, "`regional_stat`", "skill.md 要有這個型別的說明段落");
  assertStringIncludes(skill, T, "skill.md 要提到對應的任務型別");
});

Deno.test("DB CHECK：contributions_contribution_type_check 收 regional_stat（漏了的話代理交件全被擋而測試全綠）", async () => {
  const mig = await readMigration("20261009240000_regional_stats.sql");
  assertStringIncludes(mig, "ADD CONSTRAINT contributions_contribution_type_check");
  const chk = mig.slice(mig.indexOf("ADD CONSTRAINT contributions_contribution_type_check"), mig.indexOf(";", mig.indexOf("ADD CONSTRAINT contributions_contribution_type_check")));
  assertStringIncludes(chk, "'regional_stat'");
  for (const t of CONTRIBUTION_TYPES) assertStringIncludes(chk, `'${t}'`, `CHECK 漏了既有型別 ${t}`);
});

// ── 5. 派工臂接進總表、沒有掉臂 ──────────────────────────────────────
Deno.test("派工臂：regional_stats_missing 接進最新的 contribution_auto_tasks_arms，而且前一版的臂一支都沒掉", async () => {
  const prev = await readMigration("20261009010000_village_chief_progress_cooling.sql");
  const mine = await readMigration("20261009240100_regional_stats_arm.sql");
  const armNameOf = (sql: string): string[] => {
    const t = sql.slice(sql.lastIndexOf("CREATE OR REPLACE FUNCTION activity_arm_names"));
    return [...t.slice(t.indexOf("SELECT ARRAY["), t.indexOf("]::TEXT[]")).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };
  const prevNames = armNameOf(prev);
  const mineNames = armNameOf(mine);
  for (const n of prevNames) assert(mineNames.includes(n), `前一版的臂 ${n} 不見了`);
  assert(mineNames.includes("regional_stats_missing"), "新臂沒有登記進 activity_arm_names()");

  const arms = mine.slice(mine.lastIndexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms"));
  assert(arms.includes("UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM contribution_auto_tasks_regional_stats_missing() t"), "總表沒有新臂的 UNION 分支");
  assert(mine.includes("'auto:regional_stat_missing:'"), "臂本體的 task_id 前綴要是 auto:regional_stat_missing:");
  assert(/activity_rules.*WHERE r\.activity = 'regional_stats_missing'/.test(mine.replace(/\s+/g, " ")), "沒有種規則");
});

// ── 6. SQL 與 TS 的單位對照一致 ───────────────────────────────────
Deno.test("單位對照：SQL regional_stat_unit() 與 TS REGIONAL_STAT_UNIT 一致", async () => {
  const mig = await readMigration("20261009240000_regional_stats.sql");
  const fn = mig.slice(mig.indexOf("CREATE OR REPLACE FUNCTION regional_stat_unit"));
  const body = fn.slice(0, fn.indexOf("$$;"));
  for (const key of REGIONAL_STAT_KEYS) {
    const m = new RegExp(`WHEN '${key}' THEN '([^']*)'`).exec(body);
    assert(m, `SQL regional_stat_unit 沒有處理 ${key}`);
    assertEquals(m![1], REGIONAL_STAT_UNIT[key], `${key} 的單位 SQL 與 TS 不一致`);
  }
});

Deno.test("表的值範圍 CHECK：population／budget_expenditure ≥0、area_km2 >0、aging_rate ≤100，跟 TS 驗證同一套", async () => {
  const mig = await readMigration("20261009240000_regional_stats.sql");
  assertStringIncludes(mig, "regional_stats_value_range");
  assertStringIncludes(mig, "stat_key <> 'aging_rate' OR value <= 100");
  assertStringIncludes(mig, "stat_key <> 'area_km2' OR value > 0");
});
