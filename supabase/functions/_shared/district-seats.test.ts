/**
 * 應選名額流程（#344，2026-10-06）的守門測試：任務型別 district_seats_missing、貢獻型別 district_seats、
 * cec-sync 順手記選舉區與投票率。
 *
 * SQL（派工臂）在 PGlite 上灌 10-06 唯讀資料實跑過（見 PR 說明）；這支守住「改壞了不會報錯」的幾件事：
 *   1. 選舉區寫法：交件、落庫、驗證三處用同一個正規化，而且跟中選會名單的寫法一致（不然補了名額對不上那一列）
 *   2. 名額只照公告：法律定死的不讓交件改、名額一樣的不重寫、代表的鄉鎮要真的在這個縣市
 *   3. 落庫一次改三欄（名額＋依據＋出處），還原也一次改回去（表的 CHECK 要求名額與依據同時有值）
 *   4. 四處清點：DB CHECK、TS 清單、skill.md、task-labels；派工臂接進 arms 而且沒有掉臂
 *   5. 投票率：多場加總、只算投票日當天那一場（重行選舉不算）
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import {
  DISTRICT_SEAT_TYPES,
  normalizeSeatDistrict,
  planDistrictSeats,
  seatDistrictTown,
} from "./district-seats.ts";
import { CONTRIBUTION_TYPES, TASK_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { PAYLOAD_SHAPE, TASK_GUIDANCE, buildReportTemplate } from "./task-guidance.ts";
import { applyContribution } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { executeRevert, groupRestores, planRevert } from "./edit-history.ts";
import { shapeVerifyCurrent } from "./task-context.ts";
import {
  AT_LARGE_ELECTION_TYPES,
  type CecFetchDeps,
  electionDistrictRows,
  headlineTurnout,
  turnoutFromProfiles,
} from "./cec-sync.ts";
import { POSITIONS } from "../../../lib/election-levels.ts";
import { turnoutText } from "../../../lib/election-list.ts";

const T = "district_seats_missing";
const C = "district_seats";
const NOTICE = "https://www.cec.gov.tw/central/cms/announce/2026-council.pdf";
const MIGRATIONS = new URL("../../migrations/", import.meta.url);

async function latestDefining(marker: string): Promise<{ name: string; sql: string }> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  let hit = { name: "", sql: "" };
  for (const n of names) {
    const text = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
    if (text.includes(marker)) hit = { name: n, sql: text };
  }
  return hit;
}

// ── 1. 選舉區寫法 ─────────────────────────────────────────────────
Deno.test("選舉區寫法：議員收成「第NN選舉區」；代表收成「<鄉鎮>第NN選舉區」（臺→台、單一選區寫「<鄉鎮>選舉區」）", () => {
  assertEquals(normalizeSeatDistrict("縣市議員", "第4選區"), "第04選舉區");
  assertEquals(normalizeSeatDistrict("縣市議員", "臺北市第七選舉區"), "第07選舉區");
  assertEquals(normalizeSeatDistrict("縣市議員", " 第 12 選舉區 "), "第12選舉區");
  assertEquals(normalizeSeatDistrict("鄉鎮市民代表", "麥寮鄉第4選舉區"), "麥寮鄉第04選舉區");
  assertEquals(normalizeSeatDistrict("鄉鎮市民代表", "臺西鄉第一選區"), "台西鄉第01選舉區");
  assertEquals(normalizeSeatDistrict("鄉鎮市民代表", "蘭嶼鄉選舉區"), "蘭嶼鄉選舉區");
  assertEquals(normalizeSeatDistrict("直轄市山地原住民區民代表", "那瑪夏區第2選舉區"), "那瑪夏區第02選舉區");
  // 認不出來的
  assertEquals(normalizeSeatDistrict("鄉鎮市民代表", "第4選舉區"), null, "代表要寫出鄉鎮");
  assertEquals(normalizeSeatDistrict("縣市議員", "中山大同區"), null);
  assertEquals(normalizeSeatDistrict("縣市長", "第01選舉區"), null, "首長不交名額");
  assertEquals(normalizeSeatDistrict("縣市議員", 4), null);
});

Deno.test("選舉區寫法跟中選會名單同一套：cec_candidates 的代表選區（台東市第01選舉區、那瑪夏區第01選舉區、蘭嶼鄉選舉區）原樣收", () => {
  for (const cec of ["台東市第01選舉區", "台西鄉第04選舉區", "那瑪夏區第01選舉區", "和平區第03選舉區", "蘭嶼鄉選舉區"]) {
    const type = /區第|區選/.test(cec) && !/鄉|鎮|市/.test(cec) ? "直轄市山地原住民區民代表" : "鄉鎮市民代表";
    assertEquals(normalizeSeatDistrict(type, cec), cec, `${cec} 正規化之後要跟中選會寫法一樣`);
  }
  assertEquals(seatDistrictTown("麥寮鄉第04選舉區"), "麥寮鄉");
  assertEquals(seatDistrictTown("那瑪夏區第02選舉區"), "那瑪夏區");
  assertEquals(seatDistrictTown("蘭嶼鄉選舉區"), "蘭嶼鄉");
  assertEquals(seatDistrictTown("第01選舉區"), null);
});

// ── 2. 交件驗證 ───────────────────────────────────────────────────
const goodPayload = {
  election_id: 2026, election_type: "縣市議員", region: "彰化縣",
  districts: [{ district: "第1選區", seats: 6 }, { district: "第09選舉區", seats: 1, kind: "indigenous_plain" }],
};

Deno.test("交件驗證：合格的過；選舉別、選舉區寫法、重複、名額、kind 不對的各自擋下", () => {
  const ok = validateContributionRequest({ agent_name: "tester", contribution_type: C, payload: goodPayload, source_urls: [NOTICE] });
  assertEquals(ok.errors, []);
  const bad = validateContributionRequest({
    agent_name: "tester", contribution_type: C,
    payload: {
      election_id: 2026, election_type: "縣市長", region: "彰化縣",
      districts: [{ district: "第01選舉區", seats: 0 }, { district: "第1選區", seats: 3 }, { district: "大村鄉", seats: 2, kind: "proportional" }],
    },
    source_urls: [NOTICE],
  });
  const paths = bad.errors.map((e) => e.path).sort();
  assert(paths.includes("payload.election_type"), "首長不交名額");
  assert(paths.includes("payload.districts[0].seats"), "名額 0 要擋");
  // 縣市長不在三種裡，選舉區正規化不出來——每一項都會報 district 認不出來（這裡只要確定有擋）
  assert(paths.some((p) => /^payload\.districts\[\d\]\.district$/.test(p)));
  assert(paths.includes("payload.districts[2].kind"));
  const dup = validateContributionRequest({
    agent_name: "tester", contribution_type: C,
    payload: { ...goodPayload, districts: [{ district: "第1選區", seats: 6 }, { district: "第01選舉區", seats: 6 }] },
    source_urls: [NOTICE],
  });
  assertEquals(dup.errors.map((e) => e.path), ["payload.districts[1].district"], "正規化之後同一區算重複");
  const empty = validateContributionRequest({ agent_name: "tester", contribution_type: C, payload: { ...goodPayload, districts: [] }, source_urls: [NOTICE] });
  assertEquals(empty.errors.map((e) => e.path), ["payload.districts"]);
});

// ── 3. 這筆交件會改哪幾列 ─────────────────────────────────────────
Deno.test("計畫：缺名額的更新、公告多出的新增、一樣的不重寫、法律定死的不改、沒交到的列出來", () => {
  const existing = [
    { id: 1, sub_region: "第01選舉區", district_kind: "district", seats: null, seats_basis: null, seats_source: null },
    { id: 2, sub_region: "第02選舉區", district_kind: "district", seats: 5, seats_basis: "cec_notice", seats_source: "https://a" },
    { id: 3, sub_region: "第03選舉區", district_kind: "district", seats: null, seats_basis: null, seats_source: null },
    { id: 4, sub_region: "第04選舉區", district_kind: "district", seats: 1, seats_basis: "law", seats_source: "法" },
  ];
  const plan = planDistrictSeats(existing, [
    { district: "第01選舉區", seats: 6 },
    { district: "第02選舉區", seats: 5 },
    { district: "第04選舉區", seats: 2 },
    { district: "第09選舉區", seats: 1, kind: "indigenous_plain" },
  ]);
  assertEquals(plan.updates.map((u) => [u.id, u.seats]), [[1, 6]]);
  assertEquals(plan.inserts, [{ district: "第09選舉區", seats: 1, kind: "indigenous_plain" }]);
  assertEquals(plan.unchanged, ["第02選舉區"]);
  assertEquals(plan.locked, ["第04選舉區"]);
  assertEquals(plan.still_missing, ["第03選舉區"]);
});

// ── 4. 落庫與還原 ─────────────────────────────────────────────────
function seedDistricts() {
  return {
    election_districts: [
      { id: 11, election_id: 2026, election_type: "縣市議員", region: "彰化縣", sub_region: "第01選舉區", village: null, district_kind: "district", seats: null, seats_basis: null, seats_source: null },
      { id: 12, election_id: 2026, election_type: "縣市議員", region: "彰化縣", sub_region: "第02選舉區", village: null, district_kind: "district", seats: null, seats_basis: null, seats_source: null },
      { id: 21, election_id: 2026, election_type: "鄉鎮市長", region: "雲林縣", sub_region: "麥寮鄉", village: null, district_kind: "at_large", seats: 1, seats_basis: "law", seats_source: "法" },
    ],
    edit_history: [] as Record<string, unknown>[],
  };
}
const row = (payload: Record<string, unknown>, id = "c-1") => ({
  id, contribution_type: C as typeof CONTRIBUTION_TYPES[number], payload, source_urls: [NOTICE], note: null, agent_name: "tester", contributor_url: null,
});

Deno.test("落庫：名額＋依據＋出處一次改；公告多出的選舉區新增；每欄各一筆 edit_history；訊息講還缺哪幾區", async () => {
  const fake = createFakeSupabase(seedDistricts());
  const out = await applyContribution(fake.client, row({ ...goodPayload, districts: [{ district: "第1選區", seats: 6 }, { district: "第09選舉區", seats: 1, kind: "indigenous_plain" }] }));
  assertEquals(out.status, "applied", out.message);
  const d11 = fake.db.election_districts.find((r) => r.id === 11)!;
  assertEquals([d11.seats, d11.seats_basis, d11.seats_source], [6, "cec_notice", NOTICE]);
  const updates = fake.log.filter((l) => l.table === "election_districts" && l.op === "update");
  assertEquals(updates.length, 1, "三欄要在同一次 UPDATE（表的 CHECK 要求名額與依據同時有值）");
  const added = fake.db.election_districts.find((r) => r.sub_region === "第09選舉區")!;
  assertEquals([added.district_kind, added.seats, added.seats_basis, added.region], ["indigenous_plain", 1, "cec_notice", "彰化縣"]);
  const edits = fake.db.edit_history.filter((e) => e.table_name === "election_districts");
  assertEquals(edits.filter((e) => e.record_id === "11").map((e) => e.field).sort(), ["seats", "seats_basis", "seats_source"]);
  assert(edits.some((e) => e.field === "*"), "新增的列要有整列 edit_history（還原時刪掉）");
  assertStringIncludes(out.message, "第02選舉區", "還沒名額的那一區要寫在訊息裡");

  // 同一份再交一次：現值一樣 → superseded，不重寫
  const again = await applyContribution(fake.client, row({ ...goodPayload, districts: [{ district: "第01選舉區", seats: 6 }] }, "c-2"));
  assertEquals(again.status, "superseded");
});

Deno.test("還原：同一列的三欄併成一次 UPDATE 改回空白；新增的那一列刪掉", async () => {
  // 這支 fake 的 eq 是嚴格相等，edit_history.record_id 存字串，種子的 id 也用字串（真的 PostgREST 會轉型）
  const seed = seedDistricts();
  seed.election_districts.forEach((r) => { (r as Record<string, unknown>).id = String(r.id); });
  const fake = createFakeSupabase(seed);
  await applyContribution(fake.client, row({ ...goodPayload, districts: [{ district: "第01選舉區", seats: 6 }, { district: "第09選舉區", seats: 1, kind: "indigenous_plain" }] }));
  // fake 的 edit_history 沒有自增 id，補上（真表是 bigserial）
  fake.db.edit_history.forEach((e, i) => { e.id = i + 1; });
  const steps = planRevert(fake.db.edit_history as never);
  const grouped = groupRestores(steps);
  assertEquals(grouped.get("election_districts#11"), { seats: null, seats_basis: null, seats_source: null });
  fake.log.length = 0;
  await executeRevert(fake.client, "c-1", "tester");
  const updates = fake.log.filter((l) => l.table === "election_districts" && l.op === "update");
  assertEquals(updates.length, 1, "還原也要一次改回三欄，不然中間那一步違反 CHECK");
  const d11 = fake.db.election_districts.find((r) => r.id === "11")!;
  assertEquals([d11.seats, d11.seats_basis, d11.seats_source], [null, null, null]);
  assert(!fake.db.election_districts.some((r) => r.sub_region === "第09選舉區"), "新增的那一區要刪掉");
});

Deno.test("落庫：代表的選舉區要落在這個縣市真的有的鄉鎮（看鄉鎮市長的選舉區），打錯字的整筆退件", async () => {
  const fake = createFakeSupabase(seedDistricts());
  const bad = await applyContribution(fake.client, row({ election_id: 2026, election_type: "鄉鎮市民代表", region: "雲林縣", districts: [{ district: "麥寮鄉第01選舉區", seats: 5 }, { district: "麥寮鎮第02選舉區", seats: 4 }] }));
  assertEquals(bad.status, "disputed");
  assertStringIncludes(bad.message, "麥寮鎮第02選舉區");
  const good = await applyContribution(fake.client, row({ election_id: 2026, election_type: "鄉鎮市民代表", region: "雲林縣", districts: [{ district: "麥寮鄉第1選舉區", seats: 5 }] }, "c-3"));
  assertEquals(good.status, "applied", good.message);
  assert(fake.db.election_districts.some((r) => r.election_type === "鄉鎮市民代表" && r.sub_region === "麥寮鄉第01選舉區" && r.seats === 5));
});

// ── 5. 驗證項 ─────────────────────────────────────────────────────
Deno.test("驗證項：逐區列出交的名額與現有名額、標出新增的區與沒交到的區；hint 講投 agree／disagree", () => {
  const cur = shapeVerifyCurrent(C, goodPayload, {
    districts: [
      { sub_region: "第01選舉區", seats: null }, { sub_region: "第02選舉區", seats: null },
    ],
  });
  const rows = cur.districts as Array<Record<string, unknown>>;
  assertEquals(rows.map((r) => [r.district, r.claimed_seats, r.db_seats, r.new_district]), [["第01選舉區", 6, null, false], ["第09選舉區", 1, null, true]]);
  assertEquals(cur.not_in_submission, ["第02選舉區"]);
  assertMatch(String(cur.hint), /agree/);
  assertMatch(String(cur.hint), /候選人數或當選人數/);
});

// ── 6. 派工臂（SQL） ──────────────────────────────────────────────
Deno.test("派工臂：task_id 是 auto:district_seats_missing:<屆別>:<縣市>:<選舉別>；三種選舉跟 TS 同一份；交了在等票的不再派", async () => {
  const { sql } = await latestDefining("CREATE OR REPLACE FUNCTION contribution_auto_tasks_district_seats");
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_district_seats"), sql.indexOf("COMMENT ON FUNCTION contribution_auto_tasks_district_seats"));
  assertMatch(fn, /'auto:district_seats_missing:' \|\| w\.election_id \|\| ':' \|\| w\.county \|\| ':' \|\| w\.election_type/);
  const typesInWant = [...fn.matchAll(/'([^']+)'::TEXT/g)].map((m) => m[1]);
  assertEquals(new Set(typesInWant), new Set(DISTRICT_SEAT_TYPES));
  const inHave = fn.match(/d\.election_type IN \(([^)]+)\)/)![1];
  assertEquals(new Set([...inHave.matchAll(/'([^']+)'/g)].map((m) => m[1])), new Set(DISTRICT_SEAT_TYPES));
  assertMatch(fn, /c\.contribution_type = 'district_seats' AND c\.status IN \('pending', 'verified'\)/);
  assertMatch(fn, /h\.districts IS NULL OR h\.with_seats < h\.districts/);
  assertStringIncludes(fn, "不要用候選人數或當選人數推");
});

Deno.test("派工臂接進最新的 contribution_auto_tasks_arms，而且前一版的臂一支都沒掉", async () => {
  const { sql } = await latestDefining("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()");
  const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()"), sql.indexOf("COMMENT ON FUNCTION contribution_auto_tasks_arms"));
  const arms = new Set([...body.matchAll(/FROM\s+(contribution_auto_tasks_[a-z_]+)\(\)/g)].map((m) => m[1]));
  for (const a of ["contribution_auto_tasks_raw", "contribution_auto_tasks_roster_cec_gap", "contribution_auto_tasks_region_gap", "contribution_auto_tasks_elected_missing", "contribution_auto_tasks_district_seats"]) {
    assert(arms.has(a), `arms 少了 ${a}`);
  }
});

// ── 7. 四處清點 ───────────────────────────────────────────────────
Deno.test("四處清點：DB CHECK、TASK_TYPES／CONTRIBUTION_TYPES／SUGGESTED_TYPE、task-labels（純中文）、skill.md；另加做法、payload 形狀、看板顏色", async () => {
  const { sql } = await latestDefining("CONSTRAINT contributions_contribution_type_check");
  assertStringIncludes(sql.slice(sql.lastIndexOf("CONSTRAINT contributions_contribution_type_check")), `'${C}'`);
  assert((CONTRIBUTION_TYPES as readonly string[]).includes(C));
  assert((TASK_TYPES as readonly string[]).includes(T));
  assertEquals(SUGGESTED_TYPE[T], C);
  const labels = await Deno.readTextFile(new URL("../../../lib/task-labels.ts", import.meta.url));
  const label = labels.match(new RegExp(`\\b${T}:\\s*'([^']*)'`))?.[1];
  assert(label && !/[A-Za-z]/.test(label), `lib/task-labels.ts 要有純中文名稱：${label}`);
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assertStringIncludes(skill, `\`${T}\``);
  assertStringIncludes(skill, `**\`${C}\`**`);
  const queue = await Deno.readTextFile(new URL("../../../pages/Queue.vue", import.meta.url));
  assert(new RegExp(`\\b${T}:\\s*'#[0-9a-f]{6}'`).test(queue), "Queue.vue 的任務顏色");
  assert(new RegExp(`\\b${C}:\\s*'#[0-9a-f]{6}'`).test(queue), "Queue.vue 的驗證顏色");
  assertStringIncludes(TASK_GUIDANCE[T], "選舉公告");
  assertStringIncludes(TASK_GUIDANCE[T], "不要用候選人數或當選人數推");
  assert(PAYLOAD_SHAPE[C]);
});

Deno.test("交件骨架：我們知道的選舉區先填好，代理只要對著公告填名額", () => {
  const tpl = buildReportTemplate(T, C, {
    election_id: 2026, election_type: "縣市議員", region: "彰化縣",
    known_districts: [{ district: "第01選舉區", kind: "district", seats: null }, { district: "第09選舉區", kind: "indigenous_plain", seats: null }],
  }, "auto:district_seats_missing:2026:彰化縣:縣市議員") as Record<string, unknown>;
  const payload = tpl.payload as Record<string, unknown>;
  assertEquals(payload.region, "彰化縣");
  const ds = payload.districts as Array<Record<string, unknown>>;
  assertEquals(ds.map((d) => d.district), ["第01選舉區", "第09選舉區"]);
  assertEquals(ds[1].kind, "indigenous_plain");
});

// ── 8. cec-sync：選舉區與投票率 ──────────────────────────────────
const cand = (over: Record<string, unknown>) => ({
  election_id: 2022, election_type: "", region: "台北市", sub_region: null, village: null, name: "某", name_norm: "某",
  birth_year: null, cand_no: 1, elected: false, cec_theme_id: "t", cec_cand_id: 1, ...over,
}) as never;

Deno.test("cec-sync 記選舉區：議員原住民選區標種類、首長一區一席寫法定名額、村里長缺鄉鎮的不收、議員名額不寫", () => {
  const council = electionDistrictRows(2022, "縣市議員", [
    { cecType: "CouncilMember", rows: [cand({ sub_region: "第01選舉區" }), cand({ sub_region: "第01選舉區" })] },
    { cecType: "CouncilMemberPlainIndigenous", rows: [cand({ sub_region: "第07選舉區" })] },
  ]);
  assertEquals(council.map((r) => [r.sub_region, r.district_kind, r.seats]), [["第01選舉區", "district", null], ["第07選舉區", "indigenous_plain", null]]);
  const villages = electionDistrictRows(2022, "村里長", [
    { cecType: "Village", rows: [cand({ sub_region: "中山區", village: "正守里" }), cand({ sub_region: null, village: "某里" })] },
  ]);
  assertEquals(villages.map((r) => [r.sub_region, r.village, r.district_kind, r.seats, r.seats_basis]), [["中山區", "正守里", "at_large", 1, "law"]]);
  const mayor = electionDistrictRows(2022, "縣市長", [{ cecType: "Mayor", rows: [cand({ sub_region: "某區" })] }]);
  assertEquals(mayor.map((r) => [r.region, r.sub_region, r.seats]), [["台北市", null, 1]], "縣市長一個縣市一區，sub_region 不收");
  const party = electionDistrictRows(2024, "立法委員", [{ cecType: "LegislatorParty", rows: [cand({ region: "全國", sub_region: "不分區" })] }]);
  assertEquals(party.map((r) => [r.district_kind, r.seats]), [["proportional", 34]]);
});

Deno.test("以整個行政區為一區的職位：cec-sync、election_districts 的 CHECK、選舉頁的首長同一份", async () => {
  const heads = POSITIONS.filter((p) => p.role === "head").map((p) => p.type as string);
  assertEquals(new Set(AT_LARGE_ELECTION_TYPES), new Set(heads));
  const { sql } = await latestDefining("CONSTRAINT election_districts_kind_matches_type");
  const check = sql.slice(sql.indexOf("CONSTRAINT election_districts_kind_matches_type"));
  const inCheck = check.slice(0, check.indexOf("= (district_kind = 'at_large')"));
  assertEquals(new Set([...inCheck.matchAll(/'([^']+)'/g)].map((m) => m[1])), new Set(AT_LARGE_ELECTION_TYPES));
});

Deno.test("投票率：多場加總（直轄市長＋縣市長）、兩位小數；缺數字回 null", () => {
  // 2022：直轄市長 7,945,571／13,273,346、縣市長 3,655,851／5,694,425（中選會投票概況，10-06 實抓）
  assertEquals(turnoutFromProfiles([
    { vote_ticket: 7945571, votable_population: 13273346 },
    { vote_ticket: 3655851, votable_population: 5694425 },
  ]), 61.16);
  assertEquals(turnoutFromProfiles([{ vote_ticket: 14048311, votable_population: 19548531 }]), 71.86);
  assertEquals(turnoutFromProfiles([]), null);
  assertEquals(turnoutFromProfiles([{ vote_ticket: 1, votable_population: 0 }]), null);
  assertEquals(turnoutFromProfiles([{ votable_population: 10 }]), null);
});

Deno.test("投票率：只算投票日當天那一場（嘉義市長 12-18 重行選舉不算進 11-26）；有總統的屆別用總統那一場", async () => {
  const lists: Record<string, unknown[]> = {
    Mayor: [{ themeId: "m22", themeName: "111年直轄市長選舉", voteDate: "2022-11-26", year: 2022 }],
    CountyMayor: [
      // 場次名稱不一定帶「重行選舉」（pickThemes 只靠名稱把它排後面）；擋住它的是投票日
      { themeId: "redo", themeName: "111年嘉義市長選舉", voteDate: "2022-12-18", year: 2022 },
      { themeId: "c22", themeName: "111年縣市長選舉", voteDate: "2022-11-26", year: 2022 },
    ],
    President: [{ themeId: "p24", themeName: "第16任總統副總統選舉", voteDate: "2024-01-13", year: 2024 }],
  };
  const profiles: Record<string, Record<string, number>> = {
    m22: { vote_ticket: 7945571, votable_population: 13273346 },
    c22: { vote_ticket: 3655851, votable_population: 5694425 },
    redo: { vote_ticket: 94188, votable_population: 214130 },
    p24: { vote_ticket: 14048311, votable_population: 19548531 },
  };
  const fetched: string[] = [];
  const deps: CecFetchDeps = {
    themes: async (cecType) => (lists[cecType] ?? []) as never,
    fetchJson: async (url) => {
      fetched.push(url);
      const id = Object.keys(profiles).find((k) => url.includes(`/${k}/`));
      return id ? { kind: "ok", rows: [profiles[id]] as never, url } : { kind: "nodata", url };
    },
  };
  assertEquals((await headlineTurnout(2022, deps))?.value, 61.16);
  assert(!fetched.some((u) => u.includes("/redo/")), "重行選舉那一場不抓");
  assert(fetched.every((u) => u.includes("/data/profiles/ELC/") && u.endsWith("/N/00_000_00_000_0000.json")));
  const p = await headlineTurnout(2024, deps);
  assertEquals([p?.value, p?.election_type], [71.86, "總統副總統"]);
  assertEquals(await headlineTurnout(2026, deps), null, "還沒有場次的屆別不寫");
});

Deno.test("投票率是首長選舉合計：欄位註解與 /elections 畫面都要寫明（主線 10-06，避免跟媒體只引直轄市長的數字混淆）", async () => {
  const { sql } = await latestDefining("COMMENT ON COLUMN elections.turnout");
  const comment = sql.slice(sql.lastIndexOf("COMMENT ON COLUMN elections.turnout"));
  assertStringIncludes(comment.slice(0, comment.indexOf("';") + 2), "首長選舉合計");
  assertStringIncludes(comment, "直轄市長＋縣市長");
  assertStringIncludes(turnoutText({ turnout: 61.16, types: ["縣市長"] }) ?? "", "首長選舉合計");
  // 畫面用的算法說明跟 cec-sync 實際加總的科目是同一組
  assertStringIncludes(turnoutText({ turnout: 61.16, types: ["縣市長"] }) ?? "", "直轄市長＋縣市長");
});
