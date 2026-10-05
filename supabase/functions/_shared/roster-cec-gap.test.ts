/**
 * 已投票屆別的名單缺口臂（migration 20261005004010；2026-10-05）的守門測試。
 *
 * 台北市中山、中正、信義、大安四區 2022 里長我們 0 位（中選會 331 位），2022 鄉鎮市民代表 3,225 位一位都沒有——
 * 名單清查只有 2026、當選缺紀錄只派五種的當選人，「中選會有、我們沒有」的其他人沒有任何一支臂會派。
 * SQL 本身在 PGlite 上灌 10-05 線上唯讀資料實跑驗過（見 PR 說明）；這裡守住「改掉就會出錯、而且不會報錯」的條件：
 *   1. 只用既有任務型別 roster_check，task_id 跟 2026 村里長清查同一種形狀
 *   2. 姓名比對用 cec_name_key（不是 cec_name_norm），原住民姓名才對得上
 *   3. 當選而且是 elected_missing 那五種的人不列（兩支臂不搶同一個人，也不漏）；不分區立委不列
 *   4. 任務叫代理填的地區欄位，落庫（localRegionKey）真的認得——不然補完缺口永遠關不掉
 *   5. 交了 roster_check 之後要冷卻，不然對不上的姓名寫法會每 10 分鐘派一次
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { TASK_TYPES } from "./contribution-schema.ts";
import { localRegionKey } from "./apply-contribution.ts";
import { ROSTER_CEC_GAP_HINT, rosterOursScope, shapeTaskCurrent } from "./task-context.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const sql = await Deno.readTextFile(new URL("20261005004010_roster_cec_gap.sql", MIGRATIONS));
const prevSql = await Deno.readTextFile(new URL("20261005000400_region_district_gap.sql", MIGRATIONS));

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  return text.slice(i, j < 0 ? undefined : j);
}

const arm = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_roster_cec_gap()", "COMMENT ON FUNCTION contribution_auto_tasks_roster_cec_gap");

Deno.test("名單缺口臂有接進 contribution_auto_tasks_arms，只派既有的 roster_check", () => {
  const armsBody = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()", "COMMENT ON FUNCTION contribution_auto_tasks_arms");
  assert(/FROM\s+contribution_auto_tasks_roster_cec_gap\(\)/.test(armsBody));
  assert((TASK_TYPES as readonly string[]).includes("roster_check"));
  const prefixes = [...arm.matchAll(/'auto:([a-z_]+):/g)].map((m) => m[1]);
  assertEquals([...new Set(prefixes)], ["roster_check"]);
  assertMatch(arm, /'auto:roster_check:' \|\| x\.election_id \|\| ':' \|\| x\.unit \|\| ':' \|\| x\.election_type,\s*'roster_check'/);
});

Deno.test("task_id 跟 2026 村里長清查同一種形狀（auto:roster_check:<屆別>:<縣市＋鄉鎮>:<選舉別>），屆別不同不撞號", async () => {
  const villages = await Deno.readTextFile(new URL("20261004000003_roster_reps_and_village_chiefs.sql", MIGRATIONS));
  assertMatch(villages, /'auto:roster_check:' \|\| s\.election_id \|\| ':' \|\| t\.county \|\| t\.township \|\| ':村里長'/);
  // 這支的 unit 就是「縣市＋鄉鎮」
  assertMatch(arm, /u\.county \|\| u\.town AS unit/);
});

Deno.test("姓名比對用 cec_name_key，不用 cec_name_norm（原住民姓名的拉丁拼音要去掉才對得上）", () => {
  assert(arm.includes("cec_name_key(p.name)"));
  assertEquals(/cec_name_norm\(/.test(arm), false);
});

Deno.test("當選而且是 elected_missing 那幾種的人不列——兩支臂的選舉別清單要一模一樣（不搶人、也不漏人）", () => {
  const typesIn = (text: string) => text.match(/IN \(('[^)]+')\)/)![1].split(",").map((s) => s.trim().replace(/'/g, "")).sort();
  const electedMissing = between(prevSql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_elected_missing()", "COMMENT ON FUNCTION");
  const theirs = typesIn(between(electedMissing, "missing AS (", "same_name AS"));
  // 整句要是「當選 AND 這幾種」——只比清單的話，條件被改成永遠不成立也看不出來
  const covered = arm.match(/COALESCE\(c\.elected, false\) AND c\.election_type IN \(([^)]+)\) AS covered_elsewhere/);
  assert(covered, "covered_elsewhere 要是「當選而且是這幾種」");
  const ours = covered![1].split(",").map((s) => s.trim().replace(/'/g, "")).sort();
  assertEquals(ours, theirs);
  assert(/WHERE c\.elected\s+AND c\.election_type IN/.test(electedMissing), "elected_missing 那支派的是當選人（這裡排除的前提）");
  assert(/FILTER \(WHERE NOT m\.matched AND NOT m\.covered_elsewhere\) AS list_n/.test(arm), "列出來的人要排除 covered_elsewhere");
  assert(/WHERE u\.list_n > 0/.test(arm), "沒有要列的人就不派");
});

Deno.test("不分區立委（政黨名單）不列", () => {
  assert(/WHERE NOT \(c\.region = '全國' AND c\.sub_region = '不分區'\)/.test(arm));
});

Deno.test("門檻：我們 0 筆，或少 3 位以上而且少兩成以上", () => {
  assert(/u\.ours_n = 0 OR \(u\.missing_n >= 3 AND u\.missing_n \* 5 >= u\.cec_n\)/.test(arm));
});

Deno.test("已經派出去的單位補到一半、缺口掉到門檻以下也要繼續派（不然剩下的人永遠沒人補）", () => {
  // task_dispatches 的 task_id 要跟這支臂產生的 task_id 一模一樣，不然「已經派出去」永遠判不到
  const emitted = arm.match(/SELECT 'auto:roster_check:' \|\| x\.election_id \|\| ':' \|\| x\.unit \|\| ':' \|\| x\.election_type/);
  assert(emitted, "找不到這支臂產生 task_id 的寫法");
  assert(
    /EXISTS \(SELECT 1 FROM task_dispatches d\s+WHERE d\.task_id = 'auto:roster_check:' \|\| u\.election_id \|\| ':' \|\| u\.county \|\| u\.town \|\| ':' \|\| u\.election_type\)/.test(arm),
    "門檻要有「已經在 task_dispatches 裡」這條退路，而且 task_id 組法跟產生的一樣（unit＝county || town）",
  );
});

// ── 鄉鎮怎麼切、任務叫代理怎麼填，落庫要認得 ─────────────────────
const townRe = new RegExp(arm.match(/regexp_replace\(COALESCE\(c\.sub_region, ''\), '([^']+)', ''\)/)![1]);
const town = (sub: string) => sub.replace(townRe, "");
const TOWNSHIP_TYPES = arm.match(/WHEN c\.election_type IN \(([^)]+)\)\s*THEN COALESCE/)![1].split(",").map((s) => s.trim().replace(/'/g, ""));

Deno.test("以鄉鎮市區為單位的三種：中選會的選區寫法都切得回鄉鎮名（代表「南投市第01選舉區」「蘭嶼鄉選舉區」）", () => {
  assertEquals(TOWNSHIP_TYPES.sort(), ["村里長", "直轄市山地原住民區民代表", "鄉鎮市民代表"].sort());
  // cec_candidates 10-05 的實際寫法
  assertEquals(town("南投市第01選舉區"), "南投市");
  assertEquals(town("蘭嶼鄉選舉區"), "蘭嶼鄉");
  assertEquals(town("豐濱鄉第02選舉區"), "豐濱鄉"); // 平地原住民選區（cec-sync 補抓後）
  assertEquals(town("茂林區第01選舉區"), "茂林區");
  assertEquals(town("中山區"), "中山區"); // 村里長的 sub_region 本來就是鄉鎮
});

Deno.test("任務叫代理填的地區欄位，落庫的 localRegionKey 認得（補完缺口才會關）", () => {
  const how = between(arm, "AS unit,", "AS fields_how");
  // 村里長：sub_region＝鄉鎮、village＝村里
  assert(/WHEN u\.election_type = '村里長'\s*THEN 'region 填「' \|\| u\.county \|\| '」、sub_region 填「' \|\| u\.town \|\| '」、village 填/.test(how));
  assert(localRegionKey("村里長", { region: "台北市", sub_region: town("中山區"), village: "中山里" }));
  // 代表：sub_region＝鄉鎮名（不是選舉區；localRegionKey 看到「選舉區」就不認）
  assert(/'鄉鎮市民代表', '直轄市山地原住民區民代表'\)\s*THEN 'region 填「' \|\| u\.county \|\| '」、sub_region 填「' \|\| u\.town \|\| '」/.test(how));
  assert(localRegionKey("鄉鎮市民代表", { region: "南投縣", sub_region: town("南投市第01選舉區") }));
  assertEquals(localRegionKey("鄉鎮市民代表", { region: "南投縣", sub_region: "南投市第01選舉區" }), null, "照中選會原字填選舉區會落不下去，所以任務要叫代理填鄉鎮名");
  assert(localRegionKey("直轄市山地原住民區民代表", { region: "高雄市", sub_region: town("茂林區第01選舉區") }));
});

Deno.test("交了 roster_check 之後冷卻 30 天；只是試過沒查到的走 roster_attempt_cooldown_days", () => {
  assert(arm.includes("rc.last_checked < now() - INTERVAL '30 days'"));
  assert(arm.includes("roster_attempt_cooldown_days()"));
});

Deno.test("只派已投票的屆別：名單來源是 cec_candidates（cec-sync 只同步已投票的屆別），所以可以叫代理去 db.cec.gov.tw", () => {
  assert(/FROM cec_candidates c/.test(arm));
  assertEquals(/roster_check_scope/.test(arm), false, "不靠 roster_check_scope（那張表是 2026 登記階段在用的）");
  assert(arm.includes("db.cec.gov.tw"));
});

// ── 給代理的現況（task-context）────────────────────────────────
Deno.test("rosterOursScope：鄉鎮層級的清查用 county＋township，縣市層級只用 region", () => {
  assertEquals(rosterOursScope({ region: "台北市中山區", county: "台北市", township: "中山區" }), { county: "台北市", township: "中山區" });
  // 2026 村里長清查的 target 也帶 county／township（20261004000003）
  assertEquals(rosterOursScope({ region: "新北市板橋區", county: "新北市", township: "板橋區", election_type: "村里長" }), { county: "新北市", township: "板橋區" });
  assertEquals(rosterOursScope({ region: "彰化縣", election_type: "縣市議員" }), { county: "彰化縣", township: null });
  assertEquals(rosterOursScope({ region: "新北市", county: "新北市", township: null }), { county: "新北市", township: null });
  assertEquals(rosterOursScope({}), null);
});

Deno.test("roster_check 的現況：中選會名單缺口用自己的提示，ours 帶出鄉鎮與村里", () => {
  const rows = [{ candidate_status: "confirmed", position: null, regions: { region: "台北市", sub_region: "中山區", village: "中山里" }, politicians: { name: "王小明", party: "無黨籍" } }];
  const cec = shapeTaskCurrent("roster_check", { roster: { rows, history: [], region: "台北市中山區", list_source: "cec" } });
  assertEquals(cec.hint, ROSTER_CEC_GAP_HINT);
  const ours = cec.ours as Array<Record<string, unknown>>;
  assertEquals([ours[0].name, ours[0].sub_region, ours[0].village], ["王小明", "中山區", "中山里"]);
  // 2026 的清查照舊（登記階段那一套）
  const reg = shapeTaskCurrent("roster_check", { roster: { rows, history: [], region: "台北市" } });
  assert(String(reg.hint).includes("登記階段"));
});
