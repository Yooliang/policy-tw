/**
 * 名冊逐位吻合的 candidacy 一次交件上限 20 → 150（2026-10-08，維護者裁示 B 案；協議 1.78.0）。只放寬這一種，其他型別維持 20。
 *
 * 兩道關：①結構（contribution-schema）：超過 20 筆時整批都要是 candidacy 而且 source_urls 引用中選會登記名冊 PDF，上限 150；
 * ②逐位吻合（contribute-handler → roster-batch-gate）：超過 20 筆的每一筆都跟名冊資料表對得上才收，有一筆對不上、
 * 或引用的名冊沒有解析成資料表，整批未收。這裡守的是「放寬的範圍沒有外溢」：別的型別、沒有名冊網址、混型別、151 筆都不行。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isRosterCandidacyBatch, MAX_BATCH, MAX_BATCH_ROSTER, validateContributionRequest } from "./contribution-schema.ts";
import { parseRoster } from "./cec-roster.ts";
import { ROSTER_SOURCES, toRegistrationRecords } from "./cec-registrations.ts";
import { rosterBatchProblems } from "./roster-batch-gate.ts";
import { fakeRosterSupabase } from "./roster-fake-supabase.ts";
import { readTownIndex } from "../../../scripts/cec-registrations-lib.ts";
import { ROSTER_GAP_LIMIT } from "./task-context.ts";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, mutate, readMig } from "./arms-pglite.ts";

const towns = await readTownIndex();
const VILLAGE = ROSTER_SOURCES.find((s) => s.election_type === "村里長")!;
const rows = parseRoster((await Deno.readTextFile(new URL(`./fixtures/${VILLAGE.fixture}`, import.meta.url))).replace(/\r\n/g, "\n"));
const records = toRegistrationRecords(VILLAGE, rows, towns).filter((r) => r.name);
const ROSTER_URL = VILLAGE.url;

const candidacyOf = (r: (typeof records)[number], over: Record<string, unknown> = {}) => ({
  contribution_type: "candidacy",
  payload: { name: r.name, party: r.party, region: r.region, sub_region: r.sub_region, village: r.village, election_id: 2026, election_type: "村里長", candidate_status: "registered", ...over },
  source_urls: [ROSTER_URL],
});
const batch = (n: number, over?: Record<string, unknown>) => ({ agent_name: "roster-batch-test", contributions: records.slice(0, n).map((r) => candidacyOf(r, over)) });

Deno.test("上限常數：一般 20、名冊逐位吻合的 candidacy 150；任務附的缺額名單一件最多也是 150", () => {
  assertEquals(MAX_BATCH, 20);
  assertEquals(MAX_BATCH_ROSTER, 150);
  assertEquals(ROSTER_GAP_LIMIT, 150);
});

Deno.test("結構：整批都是 candidacy 而且引用名冊 PDF → 21～150 筆收；151 筆不收", () => {
  for (const n of [20, 21, 100, 150]) {
    const r = validateContributionRequest(batch(n));
    assertEquals(r.ok, true, `${n} 筆應該收：${JSON.stringify(r.errors?.slice(0, 2))}`);
    assertEquals(r.ok && r.items.length, n);
  }
  const over = validateContributionRequest(batch(151));
  assertEquals(over.ok, false);
  assert(over.errors.some((e) => e.index === -1 && e.message.includes("最多 150 筆")));
});

Deno.test("結構：放寬的範圍沒有外溢——沒有名冊網址、混了別的型別、整批都是別的型別，超過 20 筆都不收", () => {
  const noRoster = { agent_name: "roster-batch-test", contributions: records.slice(0, 21).map((r) => ({ ...candidacyOf(r), source_urls: ["https://www.cna.com.tw/news/aipl/202609045002.aspx"] })) };
  assertEquals(validateContributionRequest(noRoster).ok, false);
  // 只有一筆沒引用名冊
  const oneMissing = batch(30);
  (oneMissing.contributions[7] as { source_urls: string[] }).source_urls = ["https://www.cna.com.tw/news/aipl/202609045002.aspx"];
  assertEquals(validateContributionRequest(oneMissing).ok, false);
  // 混了一筆別的型別
  const mixed = batch(30);
  (mixed.contributions[3] as { contribution_type: string }).contribution_type = "politician";
  assertEquals(validateContributionRequest(mixed).ok, false);
  // 別的型別即使引用名冊網址也不行（例：整批 correction／policy）
  const policies = { agent_name: "roster-batch-test", contributions: Array.from({ length: 21 }, (_, i) => ({ contribution_type: "policy", payload: { name: "某人", title: `政見${i}` }, source_urls: [ROSTER_URL] })) };
  const r = validateContributionRequest(policies);
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.index === -1 && e.message.includes("最多 20 筆")));
  // 20 筆以內不受影響
  assertEquals(validateContributionRequest({ ...noRoster, contributions: noRoster.contributions.slice(0, 20) }).ok, true);
  assertEquals(isRosterCandidacyBatch([]), false);
});

// ── 逐位吻合（查名冊資料表）──────────────────────────────────────────
function fakeClient(sourceRows: typeof records | null) {
  return fakeRosterSupabase({
    cec_registration_sources: sourceRows ? [{ source_url: ROSTER_URL, row_count: sourceRows.length }] : [],
    cec_registrations: (sourceRows ?? []).map((r) => ({ source_url: r.source_url, row_no: r.row_no, name: r.name, party: r.party, region: r.region, district: r.district, place: r.place, sub_region: r.sub_region })),
  }).client;
}
// 村里長 14,100 列都在表裡
const allRecords = toRegistrationRecords(VILLAGE, rows, towns);
const items = (n: number, over?: Record<string, unknown>) => records.slice(0, n).map((r) => candidacyOf(r, over)).map((c) => ({ ...c, source_urls: c.source_urls }));

Deno.test("逐位吻合：150 筆照名冊原樣 → 收；改一筆的政黨／鄉鎮／村里 → 整批未收，errors 逐筆寫原因", async () => {
  const db = fakeClient(allRecords);
  assertEquals(await rosterBatchProblems(db, items(150)), { ok: true });
  for (const [field, value, expect] of [["party", "不存在的政黨", "名冊上的政黨"], ["sub_region", "不存在區", "名冊上的地名"], ["village", "不存在里", "名冊上的地名"], ["region", "高雄市台北", "名冊上的縣市"]] as const) {
    const list = items(60);
    (list[12].payload as Record<string, unknown>)[field] = value;
    const r = await rosterBatchProblems(db, list);
    assertEquals(r.ok, false, `${field} 改掉應該整批未收`);
    if (!r.ok) {
      assertEquals(r.error, "roster_batch_mismatch");
      assertEquals(r.errors.map((e) => e.index), [12]);
      assert(r.errors[0].message.includes(expect), `${field}：${r.errors[0].message}`);
    }
  }
  // 名冊上沒有的姓名
  const list = items(40);
  (list[5].payload as Record<string, unknown>).name = "不在名冊上的人";
  const r = await rosterBatchProblems(db, list);
  assert(!r.ok && r.errors[0].message.includes("找不到"));
});

Deno.test("逐位吻合：引用的名冊沒有解析成資料表 → 整批未收（roster_batch_unavailable），不退回讀 PDF", async () => {
  const r = await rosterBatchProblems(fakeClient(null), items(30));
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.error, "roster_batch_unavailable");
    assertEquals(r.errors.length, 30);
  }
});

Deno.test("contribute-handler：只有超過 MAX_BATCH 筆才查名冊，而且在配額、去重、落庫之前", async () => {
  const src = await Deno.readTextFile(new URL("./contribute-handler.ts", import.meta.url));
  const at = src.indexOf("rosterBatchProblems(supabase, validation.items)");
  assert(at > 0);
  assert(src.slice(src.lastIndexOf("if (", at), at).includes("validation.items.length > MAX_BATCH"));
  assert(at < src.indexOf("const sq = submitQuotaFor("), "要在配額檢查之前");
  assert(at < src.indexOf('.from("contributions").insert('), "要在寫入之前");
  assert(src.includes("hashes.slice(i, i + 40)"), "150 個雜湊的去重查詢要分批（網址長度）");
});

// ── 還原驗證：把被守的東西拿掉，測試要紅 ──────────────────────────────
async function mutantModule(file: string, from: string, to: string) {
  const src = (await Deno.readTextFile(new URL(`./${file}`, import.meta.url))).replaceAll("\r\n", "\n");
  assertEquals(src.split(from).length - 1, 1, `標記字串必須剛好出現一次：${from.slice(0, 50)}`);
  const abs = src.replace(from, to).replace(/from "\.\/([^"]+)"/g, (_m, f) => `from "${new URL(`./${f}`, import.meta.url).href}"`);
  return await import(`data:application/typescript;base64,${btoa(unescape(encodeURIComponent(abs)))}`);
}
async function expectRed(label: string, body: () => Promise<void> | void) {
  let red = false;
  try { await body(); } catch { red = true; }
  assert(red, `還原驗證失敗：${label} 拿掉之後測試沒有變紅`);
}
/** 21 筆 policy（引用名冊網址也一樣）：必須因為「一次最多 20 筆」被擋，不是因為別的欄位錯 */
const policyBatchRejectedForSize = (validate: (b: unknown) => { errors: Array<{ index: number; message: string }> }) => {
  const policies = { agent_name: "roster-batch-test", contributions: Array.from({ length: 21 }, (_, i) => ({ contribution_type: "policy", payload: { name: "某人", title: `政見${i}` }, source_urls: [ROSTER_URL] })) };
  assert(validate(policies).errors.some((e) => e.index === -1 && e.message.includes("最多 20 筆")), "沒有被「一次最多 20 筆」擋下");
};

Deno.test("放寬不外溢：21 筆 policy（引用名冊網址）是被「一次最多 20 筆」擋下的", () => {
  policyBatchRejectedForSize((b) => validateContributionRequest(b));
});

Deno.test("還原驗證：放寬沒有限定型別與名冊網址（isRosterCandidacyBatch 永遠為真）→ 21 筆 policy 不再被大小擋下（測試要紅）", async () => {
  const mod = await mutantModule("contribution-schema.ts", "return list.length > 0 && list.every((raw) => {", "return true || list.every((raw) => {");
  await expectRed("isRosterCandidacyBatch", () => policyBatchRejectedForSize((b) => mod.validateContributionRequest(b)));
});

Deno.test("還原驗證：上限改回 20 → 100 筆名冊批次被擋（測試要紅）", async () => {
  const mod = await mutantModule("contribution-schema.ts", "export const MAX_BATCH_ROSTER = 150;", "export const MAX_BATCH_ROSTER = 20;");
  await expectRed("MAX_BATCH_ROSTER", () => assertEquals(mod.validateContributionRequest(batch(100)).ok, true));
});

Deno.test("還原驗證：逐位吻合的關永遠放行 → 對不上的批次收進來了（測試要紅）", async () => {
  const mod = await mutantModule("roster-batch-gate.ts", "if (errors.length === 0) return { ok: true };", "return { ok: true };");
  const list = items(30);
  (list[3].payload as Record<string, unknown>).party = "不存在的政黨";
  assertEquals((await rosterBatchProblems(fakeClient(allRecords), list)).ok, false);
  await expectRed("rosterBatchProblems", async () => assertEquals((await mod.rosterBatchProblems(fakeClient(allRecords), list)).ok, false));
});

// ── 派工臂 what_we_need 的「一次最多 20 筆」→ 名冊批次 150（現行定義＋一處機械替換）─────────────────────

const OLD_MIG = "20261004000003_roster_reps_and_village_chiefs.sql";
const NEW_MIG = "20261008170000_roster_villages_batch_text.sql";
const FN = "contribution_auto_tasks_roster_villages";
const FROM_SENTENCE = "一次最多 20 筆，可分多次交。";
const TO_SENTENCE = "一次最多 150 筆（整批都是 candidacy、source_urls 放這份名冊、每一筆都跟名冊逐位吻合才收；其他型別一次最多 20 筆），可分多次交。";

Deno.test("臂文字：新定義＝現行定義（20261004000003，這支臂只定義過這一次）＋一處機械替換，沒有別的改動", async () => {
  const oldFn = fnText(await readMig(OLD_MIG), FN);
  const newFn = fnText(await readMig(NEW_MIG), FN);
  assertEquals(oldFn.split(FROM_SENTENCE).length - 1, 1);
  assertEquals(newFn, oldFn.replace(FROM_SENTENCE, TO_SENTENCE));
  // 現行定義確實只有一份（之後沒有別的 migration 重新定義過）
  let defs = 0;
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) {
    if (e.isFile && e.name.endsWith(".sql") && e.name < NEW_MIG && (await readMig(e.name)).includes(`CREATE OR REPLACE FUNCTION ${FN}(`)) defs++;
  }
  assertEquals(defs, 1);
  // 整支 migration 除了註解與這個函式，沒有別的陳述式
  const rest = (await readMig(NEW_MIG)).replace(/^--.*$/gm, "").replace(newFn, "").trim();
  assertEquals(rest, "");
  // 已投票屆別的缺口臂（引用的是中選會選舉資料庫、不是名冊 PDF）不在這次範圍
  assert(!(await readMig(NEW_MIG)).includes("roster_cec_gap()"));
});

async function villagesDb(newBody: string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE roster_check_scope (election_id integer NOT NULL, election_type text NOT NULL, recheck_days integer NOT NULL DEFAULT 7, enabled boolean NOT NULL DEFAULT true,
      list_announced_on date NOT NULL, registration_closed_on date NOT NULL, regions text[], PRIMARY KEY (election_id, election_type));
    CREATE TABLE electoral_district_areas (id serial PRIMARY KEY, region text, township text, election_id integer);
    CREATE TABLE regions (id serial PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE politician_elections (id serial PRIMARY KEY, election_id integer, election_type text, region_id integer);
    CREATE TABLE roster_checks (id bigserial PRIMARY KEY, election_id integer, region text, election_type text, checked_at timestamptz, cec_count integer);
    CREATE FUNCTION roster_attempt_cooldown_days() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
    INSERT INTO roster_check_scope VALUES (2026, '村里長', 7, true, '2026-11-17', '2026-09-04', '{}');
    INSERT INTO electoral_district_areas (region, township, election_id) VALUES
      ('新北市', '板橋區', 2026), ('新北市', '三重區', 2026), ('臺北市', '大安區', 2026), ('台北市', '中山區', 2022), ('彰化縣', '彰化市', 2026), ('雲林縣', '臺西鄉', 2026), ('雲林縣', '', 2026);
    INSERT INTO regions (region, sub_region, village) VALUES ('新北市', '板橋區', '赤松里'), ('新北市', '板橋區', '留侯里'), ('彰化縣', '彰化市', '中山里');
    INSERT INTO politician_elections (election_id, election_type, region_id) VALUES (2026, '村里長', 1), (2026, '村里長', 2), (2026, '村里長', 3), (2022, '村里長', 1);
    INSERT INTO roster_checks (election_id, region, election_type, checked_at, cec_count) VALUES
      (2026, '新北市三重區', '村里長', now() - interval '1 day', 40), (2026, '彰化縣彰化市', '村里長', now() - interval '30 days', 10), (2026, '台北市大安區', '村里長', now() - interval '2 hours', NULL);
  `);
  await db.exec(fnText(await readMig(OLD_MIG), FN).replace(`${FN}()`, "roster_villages_old()"));
  await db.exec(newBody);
  return db;
}
type Row = { task_id: string; task_type: string; target: unknown; what_we_need: string; hint_sources: string[]; reward: number; region: string };
const run = async (db: PGlite, fn: string) => (await db.query<Row>(`SELECT * FROM ${fn}() ORDER BY task_id`)).rows;

async function compareOldNew(newBody: string) {
  const db = await villagesDb(newBody);
  const oldRows = await run(db, "roster_villages_old");
  const newRows = await run(db, FN);
  assert(oldRows.length >= 4, `情境太少：${oldRows.length}`);
  assertEquals(newRows.length, oldRows.length);
  for (let i = 0; i < oldRows.length; i++) {
    const o = oldRows[i], n = newRows[i];
    assertEquals({ ...n, what_we_need: "" }, { ...o, what_we_need: "" }, `${o.task_id}：說明以外的欄位不該變`);
    assertEquals(n.what_we_need, o.what_we_need.replace(FROM_SENTENCE, TO_SENTENCE), `${o.task_id}：說明只差那一句`);
    assert(n.what_we_need.includes("一次最多 150 筆") && !n.what_we_need.includes(FROM_SENTENCE));
  }
}

Deno.test("臂輸出 parity（PGlite 實跑，含冷卻中與最近回報的鄉鎮）：新舊逐件相同，說明只差那一句", async () => {
  await compareOldNew(fnText(await readMig(NEW_MIG), FN));
});

Deno.test("還原驗證：替換沒套上 → 說明沒變；多改了別的欄位（reward）→ parity 都要紅", async () => {
  const good = fnText(await readMig(NEW_MIG), FN);
  await expectRed("替換沒套上", () => compareOldNew(good.replace(TO_SENTENCE, FROM_SENTENCE)));
  await expectRed("多改 reward", () => compareOldNew(mutate(good, "         2, t.county\n", "         3, t.county\n")));
});
