/**
 * 號次整批交件：一個單位一份交件、一張驗證票（issue #781，維護者 2026-10-30 批准；migration 20261030130000／20261030130100）。
 *
 * 守住：
 *   1. 一份交件＝一筆貢獻（一張驗證票）：schema 收整批 items、不收一人一份以外的鍵；風險等級 cand_no（目標 1、免兩台機器）
 *   2. 逐列標錯：agree 票的 bad_items 標到的列不寫、其餘照過；沒標的列不受影響；bad_items 只准 cand_numbers 的 agree 票
 *   3. 號次重複檢查對整批每一列生效（SQL cand_no_batch_conflicts 真的灌進 PGlite；落庫時衝突的列不寫、其餘照過）
 *   4. 單人舊的帶號次 candidacy 不受影響（風險等級、免兩台、驗證提示照舊）
 *   5. 補號次臂：等票中的 cand_numbers 涵蓋的人不重複派；退件後再派（還原驗證：拿掉排除條件會紅）
 *   6. 四處清點與協議（DB CHECK、TS 清單、skill-types 規格、版號）
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { BALLOT_MIG, fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";
import { applyContribution } from "./apply-contribution.ts";
import { BAD_ROW_THRESHOLD, candNoItems, flaggedRows, MAX_CAND_NUMBERS_PER_SUBMISSION, planCandNumbers } from "./cand-numbers.ts";
import { hasCandNo, needsTwoIps, requiredAgree, riskLevel } from "./consensus.ts";
import { CONTRIBUTION_TYPES, validateContributionRequest, validateVerifyRequest } from "./contribution-schema.ts";
import { handleVerify } from "./verify-handler.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { readSkillWithTypes } from "./skill-text.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { summarizeContribution } from "./contribution-summary.ts";
import { buildReportTemplate } from "./task-guidance.ts";
import { isBallotNumbersTask, shapeVerifyCurrent } from "./task-context.ts";
import { typeSpecForTask, typeSpecForVerify } from "./type-spec-for.ts";

const M1 = await readMig("20261030130000_cand_numbers.sql");
const M2 = await readMig("20261030130100_ballot_numbers_cand_numbers.sql");
// 20261031090000：號次重複檢查改 set-based（修逾時）、補號次臂排除同單位同名不同人、同名人物配對多一個來源、進度多兩欄。函式以這支為最新定義
const M3 = await readMig("20261031090000_cand_no_dupcheck_timeout.sql");
const N = await readMig("20261009070000_rep_district_ballot_unit.sql");
const B = await readMig(BALLOT_MIG);

const SRC = ["https://web.cec.gov.tw/tyec/article/37003"];
const PAYLOAD = {
  election_id: 2026, election_type: "縣市長", region: "台北市",
  items: [{ politician_election_id: 101, cand_no: 1 }, { politician_election_id: 102, cand_no: 2 }, { politician_election_id: 103, cand_no: 3 }],
};
const request = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  agent_name: "tester", contributions: [{ contribution_type: "cand_numbers", task_id: "auto:candidacy_source_missing:cand_no:2026:縣市長:台北市", payload, source_urls: SRC, ...extra }],
});
const errPaths = (payload: Record<string, unknown>) => validateContributionRequest(request(payload), []).errors.map((e) => e.path);

// ── 1. 交件形狀與計分 ─────────────────────────────────────────────
Deno.test("交件：整批 items 收；一列一人、號次正整數、不重複；上限 150；多餘的鍵擋", () => {
  const ok = validateContributionRequest(request(PAYLOAD), []);
  assertEquals(ok.errors, []);
  assertEquals(ok.items.length, 1, "整批是一筆貢獻，不是一人一筆");
  assert(CONTRIBUTION_TYPES.includes("cand_numbers" as never));
  assert(errPaths({ ...PAYLOAD, items: [] }).includes("payload.items"));
  assert(errPaths({ ...PAYLOAD, items: undefined }).includes("payload.items"));
  assert(errPaths({ ...PAYLOAD, items: Array.from({ length: MAX_CAND_NUMBERS_PER_SUBMISSION + 1 }, (_, i) => ({ politician_election_id: i + 1, cand_no: 1 })) }).includes("payload.items"));
  assertEquals(MAX_CAND_NUMBERS_PER_SUBMISSION, 150);
  assert(errPaths({ ...PAYLOAD, items: [{ politician_election_id: 1, cand_no: 0 }] }).includes("payload.items[0].cand_no"));
  assert(errPaths({ ...PAYLOAD, items: [{ politician_election_id: 1, cand_no: "3" }] }).includes("payload.items[0].cand_no"));
  assert(errPaths({ ...PAYLOAD, items: [{ politician_election_id: 1, cand_no: 1 }, { politician_election_id: 1, cand_no: 2 }] }).includes("payload.items[1].politician_election_id"));
  assert(errPaths({ ...PAYLOAD, items: [{ politician_election_id: 1, cand_no: 1, name: "甲" }] }).includes("payload.items[0].name"));
  assert(errPaths({ ...PAYLOAD, region: undefined }).includes("payload.region"));
});

Deno.test("計分：cand_numbers 風險等級 cand_no、目標 1、免兩台機器；單人帶號次 candidacy 照舊", () => {
  assertEquals(riskLevel("cand_numbers", PAYLOAD), "cand_no");
  assertEquals(requiredAgree("cand_numbers", PAYLOAD, SRC), 1);
  assertEquals(needsTwoIps("cand_numbers", PAYLOAD), false);
  // 單人舊交件不受影響
  const single = { politician_id: "x", election_id: 2026, election_type: "縣市長", region: "台北市", cand_no: 3 };
  assert(hasCandNo(single));
  assertEquals(riskLevel("candidacy", single), "cand_no");
  assertEquals(requiredAgree("candidacy", single, SRC), 1);
  assertEquals(needsTwoIps("candidacy", single), false);
  assertEquals(riskLevel("candidacy", { ...single, cand_no: undefined }), "high");
  assertEquals(needsTwoIps("candidacy", { ...single, cand_no: undefined }), true);
});

Deno.test("SQL 計分鏡像：contribution_required_agree 認得 cand_numbers → cand_no 級（目標 1）", () => {
  const fn = fnText(M1, "contribution_required_agree");
  assertStringIncludes(fn, "WHEN p_type = 'cand_numbers' THEN 'cand_no'");
  assert(!fn.includes("'cand_numbers' THEN 'batch_result'"));
  // 還原驗證：拿掉就沒有這一行
  assert(!mutate(fn, "    WHEN p_type = 'cand_numbers' THEN 'cand_no'\n", "").includes("'cand_numbers'"));
  // needs_two_ips 的清單本來就不含它，這裡確認沒人把它加進去
  assert(!(M1 + M2).includes("contribution_needs_two_ips"), "這一批不動兩台機器的函式");
});

// ── 2. 逐列標錯 ───────────────────────────────────────────────────
Deno.test("flaggedRows：只算 agree 票的 bad_items；達門檻才算；去重；亂格式略過", () => {
  assertEquals(BAD_ROW_THRESHOLD, 1);
  assertEquals([...flaggedRows([{ verdict: "agree", bad_items: [102, 102, "x", -1, 0] }, { verdict: "disagree", bad_items: [101] }, { verdict: "agree" }])], [102]);
  assertEquals([...flaggedRows([{ verdict: "agree", bad_items: [101] }, { verdict: "agree", bad_items: [101, 102] }], 2)], [101]);
  assertEquals([...flaggedRows([{ verdict: "agree", bad_items: "101" }])], []);
});

Deno.test("驗證請求：bad_items 要正整數陣列、附 note（≥10 字）；沒帶不影響", () => {
  const base = { contribution_id: "00000000-0000-4000-8000-000000000001", verdict: "agree", agent_name: "tester", note: "公告第 3 頁逐列核對，其餘 2 列對得上" };
  assertEquals(validateVerifyRequest(base).ok, true);
  const good = validateVerifyRequest({ ...base, bad_items: [102, 102], note: "公告第 3 頁：102 是 5 號不是 2 號" });
  assertEquals(good.input?.bad_items, [102]);
  assertEquals(validateVerifyRequest({ ...base, bad_items: [] }).input?.bad_items, undefined);
  assertEquals(validateVerifyRequest({ ...base, bad_items: ["a"] }).ok, false);
  assertEquals(validateVerifyRequest({ ...base, bad_items: [0] }).ok, false);
  assertEquals(validateVerifyRequest({ ...base, bad_items: [102], note: "太短" }).ok, false);
  assertEquals(validateVerifyRequest({ ...base, bad_items: Array.from({ length: 151 }, (_, i) => i + 1) }).ok, false);
});

const CID = "00000000-0000-4000-8000-0000000000c1";
function seed(extraVotes: Array<Record<string, unknown>> = []) {
  return {
    politician_elections: [
      { id: 101, election_id: 2026, election_type: "縣市長", cand_no: null, politician_id: "p1" },
      { id: 102, election_id: 2026, election_type: "縣市長", cand_no: null, politician_id: "p2" },
      { id: 103, election_id: 2026, election_type: "縣市長", cand_no: null, politician_id: "p3" },
      { id: 104, election_id: 2026, election_type: "縣市長", cand_no: 9, politician_id: "p4" },
      { id: 105, election_id: 2022, election_type: "縣市長", cand_no: null, politician_id: "p5" },
    ],
    contribution_votes: extraVotes.map((v) => ({ contribution_id: "c-1", ...v })),
    edit_history: [],
  };
}
const row = (payload: unknown, id = "c-1") => ({ id, contribution_type: "cand_numbers" as never, payload: payload as Record<string, unknown>, source_urls: SRC, note: null, agent_name: "tester", contributor_url: null });
const noConflict = { cand_no_batch_conflicts: () => [] };

Deno.test("落庫：整批沒人標錯 → 每列各寫一次、每列一筆 edit_history、不覆蓋已有號次", async () => {
  const fake = createFakeSupabase(seed([{ verdict: "agree" }]), noConflict);
  const out = await applyContribution(fake.client, row({ ...PAYLOAD, items: [...PAYLOAD.items, { politician_election_id: 104, cand_no: 4 }] }));
  assertEquals(out.status, "applied", out.message);
  const no = (id: number) => fake.db.politician_elections.find((r) => r.id === id)!.cand_no;
  assertEquals([no(101), no(102), no(103), no(104)], [1, 2, 3, 9], "104 本來就有不同的號次，不覆蓋");
  assertEquals(fake.db.edit_history.filter((e) => e.field === "cand_no").map((e) => [e.record_id, e.old_value, e.new_value]).sort(), [["101", null, 1], ["102", null, 2], ["103", null, 3]]);
  assertStringIncludes(out.message, "已補 3 位");
  assertStringIncludes(out.message, "104", "沒覆蓋的列要講出來");
});

Deno.test("落庫：驗證者標錯的列只退那幾列，其餘照過（逐列標錯）", async () => {
  const fake = createFakeSupabase(seed([{ verdict: "agree", bad_items: [102] }]), noConflict);
  const out = await applyContribution(fake.client, row(PAYLOAD));
  assertEquals(out.status, "applied", out.message);
  const no = (id: number) => fake.db.politician_elections.find((r) => r.id === id)!.cand_no;
  assertEquals([no(101), no(102), no(103)], [1, null, 3], "只有被標的 102 沒寫，缺口還在（臂會重派）");
  assertStringIncludes(out.message, "1 位被驗證者標錯");
  assertStringIncludes(out.message, "102");
  // disagree 票上的 bad_items 不算（只有 agree 票能標）
  const fake2 = createFakeSupabase(seed([{ verdict: "disagree", bad_items: [101, 102, 103] }, { verdict: "agree" }]), noConflict);
  const out2 = await applyContribution(fake2.client, row(PAYLOAD));
  assertEquals(out2.status, "applied");
  assertEquals(fake2.db.politician_elections.filter((r) => [101, 102, 103].includes(r.id as number)).map((r) => r.cand_no), [1, 2, 3]);
});

Deno.test("落庫：號次重複的列（SQL 逐列檢查）不寫、其餘照過；全部被擋時退件、缺口回佇列", async () => {
  const conflict = { cand_no_batch_conflicts: () => [{ politician_election_id: 103, cand_no: 3, reason: "已上線的「某某」已經是 3 號" }] };
  const fake = createFakeSupabase(seed([{ verdict: "agree" }]), conflict);
  const out = await applyContribution(fake.client, row(PAYLOAD));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.politician_elections.filter((r) => [101, 102, 103].includes(r.id as number)).map((r) => r.cand_no), [1, 2, null]);
  assertStringIncludes(out.message, "號次重複");
  const all = { cand_no_batch_conflicts: () => PAYLOAD.items.map((i) => ({ ...i, reason: "同批同號" })) };
  const fake3 = createFakeSupabase(seed([{ verdict: "agree" }]), all);
  const out3 = await applyContribution(fake3.client, row(PAYLOAD));
  assertEquals(out3.status, "disputed", "一列都沒寫且是被標錯／同號 → 退件（contributionStatusFor 轉 rejected），缺口回佇列");
  assertStringIncludes(out3.message, "缺口回到任務佇列");
});

Deno.test("落庫：都已經補過了 → superseded；參選紀錄不是這一屆的略過", async () => {
  const fake = createFakeSupabase(seed([{ verdict: "agree" }]), noConflict);
  fake.db.politician_elections.forEach((r) => { if ([101, 102, 103].includes(r.id as number)) r.cand_no = r.id === 101 ? 1 : r.id === 102 ? 2 : 3; });
  const again = await applyContribution(fake.client, row(PAYLOAD));
  assertEquals(again.status, "superseded");
  const stray = await applyContribution(createFakeSupabase(seed([{ verdict: "agree" }]), noConflict).client, row({ ...PAYLOAD, items: [{ politician_election_id: 105, cand_no: 1 }, { politician_election_id: 101, cand_no: 1 }] }));
  assertEquals(stray.status, "applied");
  assertStringIncludes(stray.message, "不是這一屆這種選舉");
});

Deno.test("planCandNumbers：各種列的去向", () => {
  const plan = planCandNumbers([
    { id: 1, election_id: 2026, election_type: "縣市長", cand_no: null },
    { id: 2, election_id: 2026, election_type: "縣市長", cand_no: 2 },
    { id: 3, election_id: 2026, election_type: "縣市長", cand_no: 7 },
    { id: 4, election_id: 2022, election_type: "縣市長", cand_no: null },
    { id: 5, election_id: 2026, election_type: "縣市長", cand_no: null },
    { id: 6, election_id: 2026, election_type: "縣市長", cand_no: null },
  ], [1, 2, 3, 4, 5, 6, 7].map((id) => ({ politician_election_id: id, cand_no: id })).concat([{ politician_election_id: 1, cand_no: 99 }]),
  2026, "縣市長", new Set([5]), new Map([[6, "同號"]]));
  assertEquals(plan.writes.map((w) => w.politician_election_id), [1]);
  assertEquals(plan.unchanged, [2]);
  assertEquals(plan.occupied.map((o) => o.id), [3]);
  assertEquals(plan.stray, [4, 7]);
  assertEquals(plan.flagged, [5]);
  assertEquals(plan.conflicted.map((c) => c.id), [6]);
});

Deno.test("verify-handler：bad_items 只收 cand_numbers 的 agree、id 要在 items 裡；存進票；修訂時清掉", async () => {
  const run = async (type: string, verdict: string, bad: number[], payload: Record<string, unknown> = PAYLOAD) => {
    const fake = createFakeSupabase({
      contributions: [{ id: CID, status: "pending", contribution_type: type, payload, source_urls: SRC, agent_name: "someone-else", contributor_ip_hash: "other", agree_count: 0, disagree_count: 0, unsure_count: 0, score: 0 }],
      contribution_votes: [], edit_history: [], quota_settings: [],
      verify_dispatches: [{ contribution_id: CID, ip_hash: "ip-hash-1", dispatched_at: new Date().toISOString() }],
    });
    const body: Record<string, unknown> = { contribution_id: CID, verdict, agent_name: "tester", note: "公告第 3 頁：102 是 5 號，其餘 2 列逐列對過" };
    if (verdict === "disagree") body.evidence_url = "https://web.cec.gov.tw/tyec/article/37003";
    if (bad.length) body.bad_items = bad;
    const res = await handleVerify(fake.client, body, "ip-hash-1");
    return { res, fake };
  };
  const ok = await run("cand_numbers", "agree", [102]);
  assertEquals(ok.res.status, 201, JSON.stringify(ok.res.body));
  assertEquals(ok.fake.db.contribution_votes.map((v) => v.bad_items), [[102]]);
  const clean = await run("cand_numbers", "agree", []);
  assertEquals(clean.res.status, 201, JSON.stringify(clean.res.body));
  assertEquals(clean.fake.db.contribution_votes.map((v) => v.bad_items), [null]);
  const wrongType = await run("candidacy", "agree", [102], { politician_id: "p", name: "甲", election_id: 2026, election_type: "縣市長", region: "台北市", cand_no: 3 });
  assertEquals(wrongType.res.status, 400);
  assertEquals((wrongType.res.body as { error: string }).error, "bad_items_unsupported");
  const notAgree = await run("cand_numbers", "disagree", [102]);
  assertEquals((notAgree.res.body as { error: string }).error, "bad_items_need_agree");
  const stray = await run("cand_numbers", "agree", [999]);
  assertEquals((stray.res.body as { error: string }).error, "bad_items_not_in_items");
});

// ── 3. 驗證項、骨架、摘要 ─────────────────────────────────────────
Deno.test("驗證項：逐列給 claimed／current／系統預檢的同號，hint 教 bad_items；骨架把 target.items 每一位列出", () => {
  const cur = shapeVerifyCurrent("cand_numbers", PAYLOAD, {
    cand_rows: [{ id: 101, cand_no: null, politicians: { name: "甲" }, regions: { region: "台北市" } }, { id: 102, cand_no: 5, politicians: { name: "乙" }, regions: null }],
    cand_conflicts: [{ politician_election_id: 102, cand_no: 2, reason: "同批同號" }],
  } as never);
  const items = cur.items as Array<Record<string, unknown>>;
  assertEquals(items.map((i) => [i.politician_election_id, i.name, i.claimed_cand_no, i.current_cand_no]), [[101, "甲", 1, null], [102, "乙", 2, 5], [103, null, 3, null]]);
  assertEquals(items[1].server_conflict, "同批同號");
  assertEquals(cur.server_conflict_count, 1);
  assertStringIncludes(String(cur.hint), "bad_items");
  const tpl = buildReportTemplate("candidacy_source_missing", "cand_numbers", { kind: "cand_no", election_id: 2026, election_type: "縣市長", region: "台北市", items: [{ politician_election_id: 7 }, { politician_election_id: 8 }] }, "auto:x")!;
  const p = tpl.payload as Record<string, unknown>;
  assertEquals((p.items as Array<Record<string, unknown>>).map((i) => i.politician_election_id), [7, 8]);
  assert((p.items as Array<Record<string, unknown>>).every((i) => typeof i.cand_no === "string"), "號次不預填");
  assertEquals(summarizeContribution({ contribution_type: "cand_numbers", payload: PAYLOAD } as never).summary.includes("3 位"), true);
  assertEquals(candNoItems(PAYLOAD).length, 3);
});

Deno.test("/next：補號次任務建議交 cand_numbers，type_spec 帶整批規格；其他 candidacy_source_missing 不受影響", () => {
  assert(isBallotNumbersTask("candidacy_source_missing", { kind: "cand_no" }));
  assert(!isBallotNumbersTask("candidacy_source_missing", { kind: "party_roster" }));
  assertStringIncludes(typeSpecForTask("candidacy_source_missing", "cand_numbers") ?? "", "**`cand_numbers`**");
  assert(!(typeSpecForTask("candidacy_source_missing") ?? "").includes("**`cand_numbers`**"));
  assertStringIncludes(typeSpecForVerify("cand_numbers") ?? "", "bad_items");
});

// ── 4. 號次重複檢查（SQL 真的跑）─────────────────────────────────────
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function conflictDb(mutateM1?: (s: string) => string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text, region text, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, election_id integer, politician_id uuid, election_type text, region_id integer, candidacy_status text, cand_no integer);
    ${fnText(N, "ballot_number_unit")}
    ${fnText(mutateM1 ? mutateM1(M3) : M3, "cand_no_batch_conflicts")}`);
  await db.exec(`INSERT INTO regions VALUES (1, '台北市', '第01選舉區', NULL), (2, '台北市', '第02選舉區', NULL), (3, '台北市', '中山區', '新生里'), (4, '台北市', '中山區', '長安里')`);
  const people = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛"];
  for (const [i, n] of people.entries()) await db.query(`INSERT INTO politicians VALUES ($1, $2, '台北市', NULL)`, [U(i + 1), n]);
  // pe: 1 甲 議員1區 空、2 乙 議員1區 空、3 丙 議員2區 空、4 丁 議員1區 已上線 5 號、5 戊 村里長 新生里 空、6 己 村里長 長安里 空、7 庚 村里長 新生里 已上線 2 號、8 辛 縣市長 空
  await db.exec(`INSERT INTO politician_elections VALUES
    (1, 2026, '${U(1)}', '縣市議員', 1, 'filed', NULL), (2, 2026, '${U(2)}', '縣市議員', 1, 'filed', NULL), (3, 2026, '${U(3)}', '縣市議員', 2, 'filed', NULL),
    (4, 2026, '${U(4)}', '縣市議員', 1, 'filed', 5), (5, 2026, '${U(5)}', '村里長', 3, 'filed', NULL), (6, 2026, '${U(6)}', '村里長', 4, 'filed', NULL),
    (7, 2026, '${U(7)}', '村里長', 3, 'filed', 2), (8, 2026, '${U(8)}', '縣市長', NULL, 'filed', NULL)`);
  return db;
}
const conflicts = async (db: PGlite, items: Array<[number, number]>) =>
  (await db.query<{ politician_election_id: number; cand_no: number; reason: string }>(
    `SELECT * FROM cand_no_batch_conflicts($1::jsonb) ORDER BY politician_election_id`, [JSON.stringify(items.map(([politician_election_id, cand_no]) => ({ politician_election_id, cand_no })))])).rows;

Deno.test("SQL 逐列檢查：同批同號、與已上線他人同號的列回傳；別的選舉區／村里同號、其餘列不受影響", async () => {
  const db = await conflictDb();
  const r = await conflicts(db, [[1, 3], [2, 3], [3, 3], [4, 5], [5, 2], [6, 2], [8, 1]]);
  // 1、2 同批同選舉區同號 → 兩邊都回；3 在別的選舉區同號 → 不回；4 自己（已上線 5 號）重交同號 → 不回；
  // 5 與已上線的庚（新生里 2 號）同號 → 回；6 在別的村里 → 不回；8 縣市長沒衝突
  assertEquals(r.map((x) => x.politician_election_id), [1, 2, 5]);
  assertStringIncludes(r[0].reason, "同一批");
  assertStringIncludes(r[2].reason, "已上線");
  assertStringIncludes(r[2].reason, "庚");
  const clean = await conflicts(db, [[1, 1], [2, 2], [3, 1], [5, 3], [6, 2], [8, 1]]);
  assertEquals(clean, [], "沒衝突回空");
  // 與已上線的丁（議員 1 區 5 號）同號 → 回
  assertEquals((await conflicts(db, [[1, 5]])).map((x) => x.politician_election_id), [1]);
  await db.close();
});

Deno.test("SQL 逐列檢查的還原驗證：拿掉『同批』或『已上線』任一半都會紅", async () => {
  const noIntra = await conflictDb((s) => mutate(s, "      JOIN me b ON b.pe_id <> a.pe_id AND", "      JOIN me b ON false AND b.pe_id <> a.pe_id AND"));
  assertEquals((await conflicts(noIntra, [[1, 3], [2, 3]])).length, 0, "拿掉同批檢查，同批同號就漏了");
  await noIntra.close();
  const noRecs = await conflictDb((s) => mutate(s, "      JOIN politician_elections pe2 ON pe2.election_id", "      JOIN politician_elections pe2 ON false AND pe2.election_id"));
  assertEquals((await conflicts(noRecs, [[5, 2]])).length, 0, "拿掉已上線檢查，與他人同號就漏了");
  await noRecs.close();
  assertEquals((await conflicts(await conflictDb(), [[5, 2]])).length, 1);
});

// ── 5. 補號次臂：等票中的 cand_numbers 不重複派 ────────────────────────
async function armDb(mutateM2?: (s: string) => string): Promise<PGlite> {
  const db = new PGlite();
  const dupViews = (sql: string, name: string) => {
    const a = sql.indexOf(`CREATE OR REPLACE VIEW ${name} AS`);
    assert(a >= 0, `找不到視圖 ${name}`);
    return sql.slice(a, sql.indexOf(";\nCOMMENT ON VIEW", a) + 1);
  };
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date);
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text, region text, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, election_id integer, politician_id uuid, election_type text, region_id integer, candidacy_status text, cand_no integer);
    CREATE TABLE contributions (id serial PRIMARY KEY, contribution_type text, status text, payload jsonb);
    CREATE TABLE election_milestones_all (election_id integer, kind text, election_type text, on_date date, status text);
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT date '2026-10-23' $$;
    CREATE FUNCTION candidacy_list_published(p_election_id integer, p_election_type text, p_on date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    ${await latestFn("candidacy_protocol_status")}
    ${fnText(N, "ballot_number_unit")}
    ${fnText(B, "ballot_number_dups")}
    ${fnText(B, "ballot_number_missing")}
    ${dupViews(N, "ballot_number_units")}
    ${dupViews(B, "ballot_number_anomalies")}
    ${fnText(mutateM2 ? mutateM2(M3) : M3, "contribution_auto_tasks_ballot_numbers")}`);
  await db.exec(`INSERT INTO elections VALUES (2026, '2026-11-28')`);
  await db.exec(`INSERT INTO election_milestones_all VALUES (2026, 'draw', NULL, '2026-10-23', 'announced')`);
  for (let i = 1; i <= 4; i++) {
    await db.query(`INSERT INTO politicians VALUES ($1, $2, '台北市', NULL)`, [U(i), `人${i}`]);
    await db.query(`INSERT INTO politician_elections VALUES ($1, 2026, $2, '縣市長', NULL, 'filed', NULL)`, [i, U(i)]);
  }
  return db;
}
const armItems = async (db: PGlite) => (await db.query<{ target: { items: Array<{ politician_election_id: number }> } }>(`SELECT target FROM contribution_auto_tasks_ballot_numbers() WHERE target->>'kind' = 'cand_no'`)).rows
  .flatMap((r) => r.target.items.map((i) => i.politician_election_id)).sort();

Deno.test("補號次臂：沒有等票中的整批 → 4 位都派；pending／verified 的 cand_numbers 涵蓋的不派；退件／已落庫的再派", async () => {
  const db = await armDb();
  assertEquals(await armItems(db), [1, 2, 3, 4]);
  const ins = (status: string, ids: number[], eid = 2026) => db.query(`INSERT INTO contributions (contribution_type, status, payload) VALUES ('cand_numbers', $1, $2::jsonb)`,
    [status, JSON.stringify({ election_id: eid, election_type: "縣市長", region: "台北市", items: ids.map((id) => ({ politician_election_id: id, cand_no: id })) })]);
  await ins("pending", [1, 2]);
  assertEquals(await armItems(db), [3, 4]);
  await ins("verified", [3]);
  assertEquals(await armItems(db), [4]);
  await ins("rejected", [4]);
  await ins("applied", [4]);
  assertEquals(await armItems(db), [4], "退件與已落庫（缺口還在就是沒寫成）不擋");
  await ins("pending", [4], 2022);
  assertEquals(await armItems(db), [4], "別屆的整批不擋這一屆");
  await db.close();
});

Deno.test("補號次臂的還原驗證：拿掉排除條件，等票中的人會被重派", async () => {
  const db = await armDb((s) => mutate(s, "WHERE cb.contribution_type = 'cand_numbers' AND cb.status IN ('pending', 'verified')", "WHERE false AND cb.contribution_type = 'cand_numbers' AND cb.status IN ('pending', 'verified')"));
  await db.query(`INSERT INTO contributions (contribution_type, status, payload) VALUES ('cand_numbers', 'pending', $1::jsonb)`, [JSON.stringify({ election_id: 2026, items: [{ politician_election_id: 1, cand_no: 1 }] })]);
  assertEquals((await armItems(db)).includes(1), true, "沒有排除條件，1 號就會被重派");
  await db.close();
});

Deno.test("補號次臂：任務說明教代理整個任務交一份 cand_numbers，不再說一人一份 candidacy", async () => {
  const db = await armDb();
  const r = await db.query<{ what_we_need: string; task_id: string; target: { items_count: number } }>(`SELECT what_we_need, task_id, target FROM contribution_auto_tasks_ballot_numbers() WHERE target->>'kind' = 'cand_no'`);
  assertEquals(r.rows.length, 1);
  assertStringIncludes(r.rows[0].what_we_need, "一份** cand_numbers");
  assertStringIncludes(r.rows[0].what_we_need, "politician_election_id");
  assert(!r.rows[0].what_we_need.includes("用 candidacy 重交同一人同一屆"));
  assertEquals(r.rows[0].task_id, "auto:candidacy_source_missing:cand_no:2026:縣市長:台北市", "task_id 不變");
  await db.close();
});

// ── 6. 四處清點與協議 ───────────────────────────────────────────────
Deno.test("四處清點：DB CHECK 含 cand_numbers、contribution_votes.bad_items 欄位、協議版號與規格", async () => {
  assertStringIncludes(M1, "'regional_stat', 'cand_numbers'))");
  assertStringIncludes(M1, "ALTER TABLE contribution_votes ADD COLUMN IF NOT EXISTS bad_items JSONB");
  const [major, minor] = PROTOCOL_VERSION.split(".").map(Number);
  assert(major > 1 || (major === 1 && minor >= 107), PROTOCOL_VERSION);
  const skill = await readSkillWithTypes();
  assertStringIncludes(skill, "**`cand_numbers`**");
  assertStringIncludes(skill, "bad_items");
  assertStringIncludes(skill, "整個任務交一份 `cand_numbers`");
  assertEquals(PROTOCOL_VERSION >= "1.107.0", true);
});

// ── 7. 重複檢查逾時修正（20261031090000）──────────────────────────────
Deno.test("落庫：重複檢查本身出錯（逾時）→ 暫緩重試（defer），不退件、不寫任何列、不消耗重試次數", async () => {
  const fake = createFakeSupabase(seed([{ verdict: "agree" }]), noConflict);
  const broken = { ...fake.client, rpc: async () => ({ data: null, error: { message: "canceling statement due to statement timeout" } }) };
  const out = await applyContribution(broken as never, row(PAYLOAD));
  assertEquals(out.status, "failed");
  assertEquals(out.defer, true, "defer＝auto-apply 不當失敗、不退件，貢獻留在 verified 下一輪再撿");
  assertStringIncludes(out.message, "暫時出錯");
  assertEquals(fake.db.politician_elections.filter((r) => [101, 102, 103].includes(r.id as number)).map((r) => r.cand_no), [null, null, null], "無法確認有沒有重複，一列都不寫");
  assertEquals(fake.db.edit_history.length, 0);
});

Deno.test("SQL 檢查走 set-based：已上線那側只依號次取一次；索引存在且不用 CONCURRENTLY（migration 在交易裡跑）", () => {
  const body = fnText(M3, "cand_no_batch_conflicts");
  assertStringIncludes(body, "live AS MATERIALIZED");
  assert(!/JOIN politician_elections pe2 ON pe2\.election_id = a\.election_id/.test(body), "不能回到對每個 item 各撈一次全國同號紀錄");
  assertStringIncludes(M3, "CREATE INDEX IF NOT EXISTS idx_politician_elections_cand_no ON politician_elections (election_id, election_type, cand_no) WHERE cand_no IS NOT NULL");
  assert(!/CREATE INDEX CONCURRENTLY/i.test(M3));
});

Deno.test("SQL 檢查：同號次大量已上線時結果仍正確（30 筆已上線 1 號，只有同村的算衝突）", async () => {
  const db = await conflictDb();
  for (let i = 0; i < 30; i++) {
    const id = 100 + i;
    await db.query(`INSERT INTO politicians VALUES ($1, $2, '台北市', NULL)`, [U(id), `路人${i}`]);
    await db.query(`INSERT INTO politician_elections VALUES ($1, 2026, $2, '村里長', $3, 'filed', 1)`, [id, U(id), i % 2 ? 3 : 4]);
  }
  const r = await conflicts(db, [[5, 1], [6, 1]]);
  assertEquals(r.map((x) => x.politician_election_id), [5, 6], "新生里（5）與長安里（6）各有已上線的 1 號");
  assert(r.every((x) => x.reason.includes("路人")));
  assertEquals(await conflicts(db, [[5, 9], [6, 9]]), []);
  await db.close();
});

Deno.test("補號次臂：同選舉同單位同名不同人、對方已有號次的列不派（其餘照派）；還原驗證：拿掉條件會被派", async () => {
  async function run(mutateM?: (s: string) => string) {
    const db = await armDb(mutateM);
    await db.exec(`INSERT INTO regions VALUES (1, '台北市', '中山區', '新生里'), (2, '台北市', '中山區', '長安里')`);
    for (const [pid, name] of [[11, "王小明"], [12, "王小明"], [13, "王小明"], [14, "李大同"]] as const) await db.query(`INSERT INTO politicians VALUES ($1, $2, '台北市', NULL)`, [U(pid), name]);
    // 11 新生里 沒號次（被擋）、12 新生里 已有 1 號、13 長安里 沒號次（別的村里，照派）、14 新生里 沒號次（不同名，照派）
    await db.exec(`INSERT INTO politician_elections VALUES
      (11, 2026, '${U(11)}', '村里長', 1, 'filed', NULL), (12, 2026, '${U(12)}', '村里長', 1, 'filed', 1),
      (13, 2026, '${U(13)}', '村里長', 2, 'filed', NULL), (14, 2026, '${U(14)}', '村里長', 1, 'filed', NULL)`);
    const ids = (await armItems(db)).map(Number).sort((x, y) => x - y);
    await db.close();
    return ids;
  }
  assertEquals(await run(), [1, 2, 3, 4, 13, 14], "11 被擋；12 本來就有號次；13、14 照派");
  const without = await run((s) => mutate(s, "AND o.cand_no IS NOT NULL AND o.politician_id <> rk.politician_id AND rk.unit IS NOT NULL", "AND false"));
  assert(without.includes(11), "拿掉排除條件，11 會被派（還原驗證）");
});

Deno.test("同名人物配對：同單位同名、一邊有號次一邊沒有 → 派 duplicate_politician（縣市不同也派），帶 cand_no_gap；其餘配對規則不變；還原驗證", async () => {
  async function run(mutateM?: (s: string) => string) {
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE elections (id integer PRIMARY KEY, election_date date);
      CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
      CREATE TABLE politicians (id uuid PRIMARY KEY, name text, party text, region text, birth_year integer, current_position text, merged_into uuid);
      CREATE TABLE politician_elections (id integer PRIMARY KEY, election_id integer, politician_id uuid, election_type text, region_id integer, candidacy_status text, cand_no integer);
      CREATE TABLE politician_pair_resolutions (pair_key text);
      CREATE TABLE jev_decisions (subject_type text, question text, subject_id text, choice text, probability numeric, asked_at timestamptz);
      CREATE TABLE contributions (id serial PRIMARY KEY, contribution_type text, status text, payload jsonb);
      CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT date '2026-10-31' $$;
      CREATE FUNCTION system_one_min_probability() RETURNS numeric LANGUAGE sql AS $$ SELECT 0.8 $$;
      CREATE FUNCTION jev_pair_exclusion_days() RETURNS integer LANGUAGE sql AS $$ SELECT 90 $$;
      CREATE FUNCTION politician_pair_key(a uuid, b uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT LEAST(a, b)::text || '|' || GREATEST(a, b)::text $$;
      ${fnText(N, "ballot_number_unit")}
      ${fnText(mutateM ? mutateM(M3) : M3, "contribution_auto_tasks_dup")}`);
    await db.exec(`INSERT INTO elections VALUES (2026, '2026-11-28')`);
    await db.exec(`INSERT INTO regions VALUES (1, '新竹市', '香山區', '鹽水里'), (2, '新竹市', '香山區', '朝山里'), (3, '台北市', '中山區', '新生里')`);
    // 21／22：同名、縣市不同（台北市／新竹市）、同村（鹽水里）、22 有 1 號 → 要派；23／24：同名不同縣市、不同村 → 不派；25／26：同名同縣市、都沒號次 → 照舊派（沒有 cand_no_gap）
    const people: Array<[number, string, string]> = [[21, "陳文榮", "台北市"], [22, "陳文榮", "新竹市"], [23, "張三", "台北市"], [24, "張三", "新竹市"], [25, "李四", "新竹市"], [26, "李四", "新竹市"]];
    for (const [i, name, region] of people) await db.query(`INSERT INTO politicians VALUES ($1, $2, NULL, $3, NULL, NULL, NULL)`, [U(i), name, region]);
    await db.exec(`INSERT INTO politician_elections VALUES
      (21, 2026, '${U(21)}', '村里長', 1, 'filed', NULL), (22, 2026, '${U(22)}', '村里長', 1, 'filed', 1),
      (23, 2026, '${U(23)}', '村里長', 3, 'filed', NULL), (24, 2026, '${U(24)}', '村里長', 2, 'filed', 2),
      (25, 2026, '${U(25)}', '村里長', 2, 'filed', NULL), (26, 2026, '${U(26)}', '村里長', 2, 'filed', NULL)`);
    const rows = (await db.query<{ task_id: string; target: Record<string, unknown> }>(`SELECT task_id, target FROM contribution_auto_tasks_dup() ORDER BY task_id`)).rows;
    await db.close();
    return rows;
  }
  const rows = await run();
  const gap = rows.filter((r) => r.target.cand_no_gap === true);
  assertEquals(gap.map((r) => r.task_id), [`auto:duplicate_politician:${U(21)}|${U(22)}`]);
  assertEquals(gap[0].target.cand_no_unit, "新竹市 香山區 鹽水里");
  assertEquals(rows.map((r) => r.task_id).sort(), [`auto:duplicate_politician:${U(21)}|${U(22)}`, `auto:duplicate_politician:${U(25)}|${U(26)}`].sort(), "不同縣市又不同村的張三不派；同縣市的李四照舊派");
  assertEquals(rows.find((r) => r.task_id.endsWith(`${U(25)}|${U(26)}`))!.target.cand_no_gap, undefined);
  const without = await run((s) => mutate(s, "OR up.a_id IS NOT NULL)", ")"));
  assertEquals(without.some((r) => r.target.cand_no_gap === true), false, "拿掉這個來源，跨縣市的那一對就配不到（還原驗證）");
  assertEquals(without.length, 1);
});

Deno.test("cand_no_front_pull：擋住號次缺口的合併任務（target.cand_no_gap）拉到最前（3 ×）", () => {
  assertStringIncludes(fnText(M3, "cand_no_front_pull"), "d2.target->>'cand_no_gap' = 'true' THEN v_top");
});

Deno.test("cand_no_progress：多兩欄＝今天因逾時／號次重複退件的整批數，只回數字", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE contributions (id serial PRIMARY KEY, contribution_type text, status text, payload jsonb, review_notes text, created_at timestamptz DEFAULT now());
    CREATE TABLE contribution_votes (id serial PRIMARY KEY, contribution_id integer, created_at timestamptz DEFAULT now());
    CREATE TABLE task_dispatches (task_id text, target jsonb, boost_seconds bigint DEFAULT 0);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, election_id integer, candidacy_status text, cand_no integer);
    ${fnText(M3, "public.cand_no_progress")}`);
  const ins = (type: string, status: string, notes: string | null, ago = "0 days") => db.query(`INSERT INTO contributions (contribution_type, status, payload, review_notes, created_at) VALUES ($1, $2, '{}'::jsonb, $3, now() - $4::interval)`, [type, status, notes, ago]);
  const timeout = "[auto] 落庫連續 3 次失敗，退件：cand_no_batch_conflicts: canceling statement due to statement timeout。這筆不落庫";
  await ins("cand_numbers", "rejected", timeout);
  await ins("cand_numbers", "rejected", timeout);
  await ins("cand_numbers", "rejected", "[auto] 新竹市香山區 2026 村里長 這一份沒有可寫的列：1 位號次重複、沒寫");
  await ins("cand_numbers", "rejected", "[auto] 這一份沒有可寫的列：1 位號次重複", "3 days");
  await ins("cand_numbers", "rejected", "[auto] 別的原因");
  await ins("cand_numbers", "apply_failed", "[auto] 落庫失敗：statement timeout");
  const j = (await db.query<{ j: Record<string, unknown> }>(`SELECT public.cand_no_progress() AS j`)).rows[0].j;
  assertEquals(j.batch_timeout_rejected_today, 2, "只算已退件（apply_failed 還在重試不算）");
  assertEquals(j.batch_dup_rejected_today, 1, "3 天前的、逾時的、其他原因的都不算");
  assertEquals(Object.values(j).every((v) => typeof v === "number" || typeof v === "string"), true, "只回數字（與 as_of 時間戳）");
  await db.close();
});
