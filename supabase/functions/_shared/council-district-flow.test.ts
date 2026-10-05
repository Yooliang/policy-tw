/**
 * 縣市議員選區錯亂的流程修正（2026-10-05，協議 1.47.0，migration 20261005004100）。
 *
 * 10-05 線上：2026 縣市議員已登記 105 筆沒有選區，103 筆是名單清查照中選會登記彙總表交的——名冊上有選區、代理沒抄；
 * 畫面再借人物自己的地區（里長那一筆的「大雅區 上雅里」、立委那一筆的「臺中市第03選區」）冒出假選區。
 * 這支守住流程的五個關口，每一個拿掉都會讓同一種錯資料再進來或再被顯示：
 *   1. 交件：縣市議員沒帶選區就退回（not_running／withdrawn 不問）
 *   2. 選區清單：2026 以中選會兩份登記彙總表為準，regions 要補的列跟它同一份
 *   3. 落庫：選區先正規化（臺、第4選區、只寫在 position），掛錯層級的改記到縣市
 *   4. 派工：補選區任務講清楚掛在哪、交件縣市不一致要講
 *   5. 顯示：縣市層級以上的選舉不借人物的鄉鎮村里
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import {
  COUNCIL_DISTRICT_COUNT_2026,
  councilDistrictKey,
  normalizeCandidacyDistrictField,
  officialCouncilDistricts,
  regionFitFor,
} from "./electoral-district.ts";
import { councilDistrictProblems } from "./council-district-guard.ts";
import { checkElectoralDistrict, resetDistrictRegistryCache } from "./district-registry.ts";
import { checkBatch, parseRoster } from "./cec-roster.ts";
import { handleContribute } from "./contribute-handler.ts";
import { TASK_TYPES } from "./contribution-schema.ts";
import { buildReportTemplate } from "./task-guidance.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const MIGRATION = "20261005004100_council_district_flow.sql";
const migration = await Deno.readTextFile(new URL(MIGRATION, MIGRATIONS));
const municipal = await Deno.readTextFile(new URL("./fixtures/cec-roster-2026-municipal-council.txt", import.meta.url));
const county = await Deno.readTextFile(new URL("./fixtures/cec-roster-2026-county-council.txt", import.meta.url));

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  return text.slice(i, j < 0 ? undefined : j);
}

// ── 2. 選區清單：常數＝名冊＝migration ─────────────────────────────────────

/** 名冊抽字檔裡每個縣市出現過的選舉區號碼 */
function rosterDistricts(text: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const m of text.replace(/選舉\s+區/g, "選舉區").matchAll(/([一-鿿]{2}[縣市])第\s*(\d+)\s*選舉區/g)) {
    const c = m[1].replace(/^臺/, "台");
    out.set(c, (out.get(c) ?? new Set()).add(Number(m[2])));
  }
  return out;
}

Deno.test("2026 選舉區數：跟中選會兩份登記彙總表逐縣市一致，而且每個縣市都是從第 1 號連續編下來", () => {
  const seen = new Map([...rosterDistricts(municipal), ...rosterDistricts(county)]);
  assertEquals([...seen.keys()].sort(), Object.keys(COUNCIL_DISTRICT_COUNT_2026).sort(), "22 個縣市都要有、也不能多");
  for (const [c, nums] of seen) {
    const n = COUNCIL_DISTRICT_COUNT_2026[c];
    assertEquals(Math.max(...nums), n, `${c} 名冊最大號是 ${Math.max(...nums)}，常數寫 ${n}`);
    assertEquals(nums.size, n, `${c} 名冊上的選舉區有缺號：${[...nums].sort((a, b) => a - b).join(",")}`);
  }
});

Deno.test("migration 補的 regions 列跟常數是同一份（兩份真相要一起改）", () => {
  const block = between(migration, "FROM (VALUES", ") AS c(region, total)");
  const pairs = [...block.matchAll(/\('([^']+)',\s*(\d+)\)/g)].map((m) => [m[1], Number(m[2])] as const);
  assertEquals(Object.fromEntries(pairs), { ...COUNCIL_DISTRICT_COUNT_2026 });
  // 形狀跟線上既有的 177 列一樣：縣市用「台」、第NN選舉區、village 空
  assertStringIncludes(migration, "'第' || lpad(n::TEXT, 2, '0') || '選舉區', NULL");
  assertStringIncludes(migration, "WHERE NOT EXISTS");
  for (const [c] of pairs) assertEquals(c.startsWith("臺"), false, `${c}：regions 的縣市一律寫「台」`);
});

Deno.test("選區清單：台中市第 17、屏東縣第 16 選舉區是真的（以前一個被擋、一個落不了庫），第 17 屏東不是", async () => {
  resetDistrictRegistryCache();
  const noDb = { from: () => { throw new Error("2026 不該查資料庫"); } };
  assertEquals((await checkElectoralDistrict(noDb, 2026, "台中市", "第17選舉區")).status, "ok");
  assertEquals((await checkElectoralDistrict(noDb, 2026, "臺中市", "第17選舉區")).status, "ok", "縣市寫臺也認得");
  assertEquals((await checkElectoralDistrict(noDb, 2026, "屏東縣", "第16選舉區")).status, "ok");
  const bad = await checkElectoralDistrict(noDb, 2026, "屏東縣", "第17選舉區");
  assertEquals(bad.status, "unknown");
  assertEquals(bad.validDistricts?.length, 16, "附整份清單讓代理對照");
  assertEquals(officialCouncilDistricts(2022, "屏東縣"), null, "其他屆別沒有官方清單，照舊查 electoral_district_areas");
});

// ── 1. 交件：沒帶選區就退回 ──────────────────────────────────────────────

const POL = "8aa6ee40-231a-447a-a967-99bcf8b35d3f";
const council = (payload: Record<string, unknown>) => ({
  contribution_type: "candidacy",
  payload: { politician_id: POL, election_id: 2026, election_type: "縣市議員", region: "台中市", candidate_status: "registered", ...payload },
});

Deno.test("交件守門：縣市議員沒帶選區 → 擋；不參選、退選、其他選舉別不問", () => {
  assertEquals(councilDistrictProblems([council({})]).length, 1);
  assertEquals(councilDistrictProblems([council({ electoral_district: "大雅區" })]).length, 1, "鄉鎮名不是選區");
  assertEquals(councilDistrictProblems([council({ electoral_district: "第05選舉區" })]).length, 0);
  assertEquals(councilDistrictProblems([council({ candidate_status: "not_running" })]).length, 0);
  assertEquals(councilDistrictProblems([council({ candidate_status: "withdrawn" })]).length, 0);
  assertEquals(councilDistrictProblems([{ ...council({}), payload: { ...council({}).payload, election_type: "縣市長" } }]).length, 0);
  assertEquals(councilDistrictProblems([{ contribution_type: "policy", payload: { election_type: "縣市議員" } }]).length, 0);
  // 只寫在 position 的，交件端會先抽出來（normalizeCandidacyDistrictField），抽得出就不擋
  const fromPosition = council({ position: "高雄市第10選舉區" });
  normalizeCandidacyDistrictField(fromPosition.payload as Record<string, unknown>);
  assertEquals(councilDistrictProblems([fromPosition]).length, 0);
});

function fakeSupabase() {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      const result = { data: table === "politicians" ? [{ id: POL, merged_into: null }] : [], error: null, count: 0 };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, is: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: result.data[0] ?? null, error: null }),
        insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
          for (const r of Array.isArray(rows) ? rows : [rows]) inserted.push({ table, row: r });
          const arr = Array.isArray(rows) ? rows : [rows];
          return { select: () => ({ data: arr.map((r, i) => ({ id: `new-${i}`, payload_hash: (r as { payload_hash?: string }).payload_hash })), error: null }) };
        },
        delete: () => ({ in: () => ({ error: null }) }),
        then: (res: (v: typeof result) => unknown) => res(result),
      };
      return chain;
    },
  };
  return { client, inserted };
}
const noVote = () => Promise.resolve({ status: 403, body: { error: "self_vote" } });
const body = (payload: Record<string, unknown>) => ({
  agent_name: "tester",
  ...council(payload),
  source_urls: ["https://db.cec.gov.tw/test"],
});

Deno.test("交件端點：名單清查照名冊交了議員卻沒抄選區 → 400 electoral_district_required，不寫入、記一次守門", async () => {
  resetDistrictRegistryCache();
  const { client, inserted } = fakeSupabase();
  const res = await handleContribute(client, "https://x", body({ name: "陳映辰" }), "ip-1", noVote);
  assertEquals(res.status, 400, JSON.stringify(res.body).slice(0, 300));
  const b = res.body as { error?: string; errors?: Array<{ path: string; name: string | null }> };
  assertEquals(b.error, "electoral_district_required");
  assertEquals(b.errors?.[0]?.name, "陳映辰");
  assertEquals(inserted.filter((r) => r.table === "contributions").length, 0);
  assertEquals(inserted.filter((r) => r.table === "gate_rejections").map((r) => r.row.gate), ["electoral_district_required"]);
});

Deno.test("交件端點：帶了選區（或寫在 position）照常收", async () => {
  resetDistrictRegistryCache();
  for (const extra of [{ electoral_district: "第5選區" }, { position: "臺中市第5選舉區議員候選人" }]) {
    const { client, inserted } = fakeSupabase();
    const res = await handleContribute(client, "https://x", body(extra), "ip-1", noVote);
    assertEquals(res.status, 201, JSON.stringify(res.body).slice(0, 300));
    const saved = inserted.find((r) => r.table === "contributions")?.row.payload as Record<string, unknown>;
    assertEquals(saved.electoral_district, "第05選舉區");
  }
});

Deno.test("協議與任務骨架：skill.md 寫出錯誤代碼；名單清查補議員的骨架就帶 electoral_district", async () => {
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assertStringIncludes(skill, "400 electoral_district_required");
  const tpl = buildReportTemplate("roster_check", "candidacy", { region: "台中市", election_id: 2026, election_type: "縣市議員" }, "auto:roster_check:2026:台中市:縣市議員");
  assert("electoral_district" in (tpl!.payload as Record<string, unknown>), "名單清查交的議員沒有選區，就是這次 103 筆的來源");
  const mayor = buildReportTemplate("roster_check", "candidacy", { region: "台中市", election_id: 2026, election_type: "縣市長" }, "auto:roster_check:2026:台中市:縣市長");
  assertEquals("electoral_district" in (mayor!.payload as Record<string, unknown>), false);
});

// ── 名冊逐位核對連選區一起比 ──────────────────────────────────────────────

Deno.test("名冊核對：選舉區也要對（簡嘉佑在名冊上是台中市第9選舉區）；交件沒給選區的照舊只比姓名縣市政黨", () => {
  const rows = parseRoster(municipal);
  const hit = rows.find((r) => r.name === "簡嘉佑");
  assertEquals(hit?.district, "第09選舉區", "解析名冊時要留下每一列的選舉區");
  const r = checkBatch(rows, [
    { id: "ok", name: "簡嘉佑", party: "民主進步黨", region: "台中市", district: "第09選舉區" },
    { id: "loose", name: "簡嘉佑", party: "民主進步黨", region: "台中市", district: "第9選區" },
    { id: "wrong", name: "簡嘉佑", party: "民主進步黨", region: "台中市", district: "第05選舉區" },
    { id: "none", name: "陳映辰", party: "民主進步黨", region: "台中市" },
  ]);
  assertEquals(r.passed.sort(), ["loose", "none", "ok"]);
  assertEquals(r.failed.map((f) => f.id), ["wrong"]);
  assertStringIncludes(r.failed[0].reason, "第09選舉區");
});

// ── 3. 落庫：選區正規化、掛錯層級 ────────────────────────────────────────

Deno.test("議員選區鍵：臺、第4選區、只寫在 position 都認得；文字裡的縣市跟 region 不同就不猜", () => {
  assertEquals(councilDistrictKey("臺中市", "第5選區"), { region: "台中市", sub_region: "第05選舉區" });
  assertEquals(councilDistrictKey("高雄市", null, "高雄市第10選舉區"), { region: "高雄市", sub_region: "第10選舉區" });
  assertEquals(councilDistrictKey(null, "臺北市第6選區(大安文山)"), { region: "台北市", sub_region: "第06選舉區" });
  assertEquals(councilDistrictKey("台中市", "高雄市第10選舉區"), null, "縣市互相矛盾");
  assertEquals(councilDistrictKey("台中市", "大雅區", "台中市第05選舉區"), null, "有給選區但看不懂時不偷看 position");
  assertEquals(councilDistrictKey("台中市", null, "縣市議員候選人"), null);
  assertEquals(councilDistrictKey("火星市", "第01選舉區"), null);
});

Deno.test("參選紀錄指的那一列對這種選舉是哪一層：議員掛村里、鄉鎮、立委選區都算掛錯", () => {
  const v = { region: "台中市", sub_region: "大雅區", village: "上雅里" };
  assertEquals(regionFitFor("縣市議員", v), "wrong");
  // 只要指到村里就是掛錯，即使那一列的 sub_region 長得像選區（村里層級沒有任何一種選區）
  assertEquals(regionFitFor("縣市議員", { region: "台中市", sub_region: "第05選舉區", village: "上雅里" }), "wrong");
  assertEquals(regionFitFor("縣市議員", { region: "台中市", sub_region: "豐原區" }), "wrong");
  assertEquals(regionFitFor("縣市議員", { region: "台中市", sub_region: "臺中市第03選區" }), "wrong");
  assertEquals(regionFitFor("縣市議員", { region: "台中市", sub_region: "第05選舉區" }), "district");
  assertEquals(regionFitFor("縣市議員", { region: "台中市", sub_region: null }), "county");
  assertEquals(regionFitFor("縣市長", { region: "屏東縣", sub_region: "東勢區", village: "隆興里" }), "wrong");
  assertEquals(regionFitFor("縣市長", { region: "屏東縣" }), "county");
  assertEquals(regionFitFor("立法委員", { region: "台中市", sub_region: "臺中市第03選區" }), "district");
  assertEquals(regionFitFor("立法委員", { region: "全國", sub_region: "不分區" }), "district");
  assertEquals(regionFitFor("立法委員", { region: "全國" }), "county", "全國但沒分出不分區／原住民：要補選區，不是掛錯");
  assertEquals(regionFitFor("縣市長", { region: "全國" }), "wrong");
});

// ── 4. 派工：補選區任務 ─────────────────────────────────────────────────

const gap = between(migration, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_region_gap", "COMMENT ON FUNCTION contribution_auto_tasks_region_gap");

Deno.test("補選區任務：掛在村里、鄉鎮、別種選舉的選區也派，而且說明講出掛在哪（不再一律寫「只記到縣市」）", () => {
  assertMatch(gap, /r\.village IS NOT NULL\s+OR \(r\.sub_region IS NOT NULL AND NOT region_is_electoral_district\(pe\.election_type, r\.region, r\.sub_region\)\)\) AS wrong_level/);
  assertStringIncludes(gap, "WHERE g.no_region OR g.no_district OR g.wrong_level");
  assertStringIncludes(gap, "'attached_to', CASE WHEN x.wrong_level");
  assertMatch(gap, /WHEN x\.wrong_level\s+THEN '掛在「'/);
  // 縣市長掛錯層級當成缺縣市派（以前縣市長完全不看層級）
  assertStringIncludes(gap, "g.no_region OR (g.wrong_level AND g.election_type = '縣市長') AS need_region");
});

Deno.test("補選區任務：建立這筆的交件縣市跟現在不同要講出來，現在根本沒縣市的不算", () => {
  assertStringIncludes(gap, "eh.table_name = 'politician_elections' AND eh.record_id = x.pe_id::TEXT AND eh.field = '*'");
  assertStringIncludes(gap, "WHERE x.county IS NOT NULL");
  assertStringIncludes(gap, "'submitted_region', sub.submitted_region");
  assertStringIncludes(gap, "【先確認是不是同一個人】");
  assertStringIncludes(gap, "不是同一個人就不要交 candidacy");
});

Deno.test("補選區任務：只用既有任務型別、同名同簽名重定義（arms 不必重寫）", () => {
  for (const m of migration.matchAll(/'auto:([a-z_]+):/g)) assert((TASK_TYPES as readonly string[]).includes(m[1]), m[1]);
  assertEquals(migration.includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms"), false);
  assertStringIncludes(gap, "RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)");
});

// ── 5. 顯示：視圖不借人物的鄉鎮村里 ──────────────────────────────────────

Deno.test("視圖：縣市長、議員、立委、總統那一屆的 subRegion／village 只看參選紀錄自己那一列", () => {
  const view = between(migration, "CREATE OR REPLACE VIEW politicians_with_elections AS", "ALTER VIEW politicians_with_elections");
  for (const key of ["subRegion", "village"]) {
    const col = key === "subRegion" ? "sub_region" : "village";
    const re = new RegExp(
      `'${key}', CASE WHEN COALESCE\\(pe\\.election_type::TEXT, p\\.election_type::TEXT\\) IN \\('總統副總統', '縣市長', '縣市議員', '立法委員'\\)\\s+THEN per\\.${col} ELSE COALESCE\\(per\\.${col}, r\\.${col}, p\\.${col}\\) END`,
    );
    assertMatch(view, re, `${key} 要分開處理`);
  }
  // CREATE OR REPLACE VIEW 會清掉 reloptions，security_invoker 一定要補回來
  assertStringIncludes(migration, "ALTER VIEW politicians_with_elections SET (security_invoker = on);");
});
