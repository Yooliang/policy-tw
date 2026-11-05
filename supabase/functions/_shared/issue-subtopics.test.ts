/**
 * 議題細項標籤 P1（policy-ops#173，小良哥 2026-11-02 核准流程與門檻 150 筆；migration 20261102010000_issue_subtopics.sql）。
 *
 * 守住：
 *   A. 偵測（PGlite 跑真的 migration 函式）：預設門檻 150、超過才開（> 不是 >=）、門檻可調（activity_rules.params）、
 *      task_id 形狀、target 帶承諾清單與全站已存在細項名、拆分後條件不再成立就不再出現（自動關閉）、等票中的不重複派
 *   B. 大類不受影響：加了細項之後，承諾仍在原大類（issues_summary 逐筆相同）、policies.tags 一個字沒動
 *      （主線 2026-11-02 提醒：細項若混進 tags，issue_tags_of 會讓承諾離開大類）
 *   C. 交件驗證與落庫：2～6 個細項、assignments 對得上 subtopics、範圍外略過、已有細項不覆蓋、系統不直接寫、不碰 policies
 *   D. 清點：貢獻型別／任務型別／DB CHECK／總表接上／臂名清單／規則種子／skill 說明
 *   E. 還原驗證：把被守的東西拿掉，對應測試必須紅
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, mutate } from "./arms-pglite.ts";
import { CONTRIBUTION_TYPES, isSubtopicName, TASK_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { hasGuidance, PAYLOAD_SHAPE } from "./task-guidance.ts";
import { applyContribution } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { readSkillWithTypes } from "./skill-text.ts";

const readMig = async (n: string) => (await Deno.readTextFile(new URL(`../../migrations/${n}`, import.meta.url))).replace(/\r\n/g, "\n");
const ISSUES_MIG = await readMig("20261031130000_issues_summary_page.sql");
const MIG_NAME = "20261102010000_issue_subtopics.sql";
const MIG = await readMig(MIG_NAME);

const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

// ── 最小資料庫：議題串聯的表＋這支 migration 會用到的 activity_rules／contributions ──
const SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated;
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politicians (id uuid PRIMARY KEY, name text, avatar_url text, party text);
CREATE TABLE parties (id bigint PRIMARY KEY, name text, short_name text);
CREATE TABLE politician_elections (politician_id uuid, election_id integer, election_type text, position text, cand_no integer, region_id integer, party_id bigint, PRIMARY KEY (politician_id, election_id, election_type, region_id));
CREATE TABLE policies (id uuid PRIMARY KEY, politician_id uuid, election_id integer, title text, category text, status text, proposed_date date, tags text[], lineage_id uuid, removed_at timestamptz);
CREATE TABLE activity_rules (id serial PRIMARY KEY, activity text, params jsonb, enabled boolean DEFAULT true);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, payload jsonb);
`;
// 高雄市 2026 的承諾：縣市長 1 位（交通）＋議員 N 位（交通 6、長照 2），台北另 1 筆（不同縣市）
const SEED = `
INSERT INTO regions VALUES (1,'高雄市',NULL,NULL),(5,'高雄市','第01選舉區',NULL),(4,'臺北市',NULL,NULL);
INSERT INTO politicians VALUES ('${u(1)}','王小明',NULL,NULL),('${u(2)}','李大華',NULL,NULL),('${u(6)}','北市長',NULL,NULL);
INSERT INTO politician_elections VALUES
 ('${u(1)}',2026,'縣市長','市長',3,1,NULL),('${u(2)}',2026,'縣市議員','議員',7,5,NULL),('${u(6)}',2026,'縣市長','市長',1,4,NULL);
INSERT INTO policies (id, politician_id, election_id, title, category, status, proposed_date, tags, lineage_id, removed_at) VALUES
 ('${u(101)}','${u(1)}',2026,'市長 托育補助','社會福利','Campaign Pledge','2026-06-01',NULL,NULL,NULL),
 ('${u(102)}','${u(2)}',2026,'議員 公托','社會福利','Campaign Pledge','2026-05-01',ARRAY['社會福利','托育'],NULL,NULL),
 ('${u(103)}','${u(2)}',2026,'議員 敬老卡','社會福利','Campaign Pledge','2026-04-01',NULL,NULL,NULL),
 ('${u(104)}','${u(2)}',2026,'議員 長照據點','社會福利','Campaign Pledge','2026-03-01',NULL,NULL,NULL),
 ('${u(105)}','${u(2)}',2026,'議員 生育津貼','社會福利','Campaign Pledge','2026-02-01',NULL,NULL,NULL),
 ('${u(106)}','${u(2)}',2026,'議員 弱勢救助','社會福利','Campaign Pledge','2026-01-01',NULL,NULL,NULL),
 ('${u(107)}','${u(2)}',2026,'議員 捷運','交通建設','Campaign Pledge','2026-01-02',NULL,NULL,NULL),
 ('${u(111)}','${u(6)}',2026,'台北 托育','社會福利','Campaign Pledge','2026-06-03',NULL,NULL,NULL);
`;
/** 這支 migration 裡跟偵測有關的段落：表、四支函式（threshold／election／scope／臂） */
const DETECT_SQL = (() => {
  const tbl = MIG.slice(MIG.indexOf("CREATE TABLE IF NOT EXISTS policy_subtopics"), MIG.indexOf(");", MIG.indexOf("CREATE TABLE IF NOT EXISTS policy_subtopics")) + 2);
  const fns = ["issue_too_broad_threshold", "issue_too_broad_election", "policy_subtopic_scope", "contribution_auto_tasks_issue_too_broad"];
  return [tbl, ...fns.map((f) => MIG.slice(MIG.indexOf(`CREATE OR REPLACE FUNCTION ${f}(`), MIG.indexOf(`CREATE OR REPLACE FUNCTION ${f}(`) + fnText(MIG, f).length))].join("\n");
})();

async function build(detect: string = DETECT_SQL): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(ISSUES_MIG);
  await db.exec(detect);
  return db;
}
type Row = Record<string, unknown>;
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Row>(sql, params)).rows;
const setThreshold = async (db: PGlite, n: number) => {
  await db.exec(`DELETE FROM activity_rules; INSERT INTO activity_rules (activity, params) VALUES ('issue_too_broad', '{"threshold":${n},"election_id":2026}'::jsonb)`);
};
const tasks = async (db: PGlite) => await q(db, "SELECT * FROM contribution_auto_tasks_issue_too_broad() ORDER BY task_id");

// ============================================================
// A. 偵測
// ============================================================
Deno.test("A1 預設門檻是 150（規則列不存在時），種子規則也是 150", async () => {
  const db = await build();
  const [r] = await q(db, "SELECT issue_too_broad_threshold() AS t, issue_too_broad_election() AS e");
  assertEquals([r.t, r.e], [150, 2026]);
  assertStringIncludes(MIG, `'{"threshold":150,"election_id":2026}'::JSONB`);
  assertEquals((await tasks(db)).length, 0, "現況資料量遠低於 150，一張都不開");
});

Deno.test("A2 超過門檻才開（> 不是 >=），一個縣市×議題一張，task_id 與 target 形狀", async () => {
  const db = await build();
  await setThreshold(db, 5); // 高雄市「社會福利」有 101～106 共 6 筆 > 5
  const rows = await tasks(db);
  assertEquals(rows.length, 1, "社會福利 6 筆超過 5；交通建設 1 筆、台北市不同縣市都不開");
  const t = rows[0];
  assertEquals(t.task_id, "auto:issue_too_broad:2026:高雄市:社會福利");
  assert(/^auto:[a-z0-9_]+:\S+$/.test(t.task_id as string), "task_id 要符合 isTaskIdShape 的自動缺口形狀");
  assertEquals(t.task_type, "issue_too_broad");
  assertEquals(t.region, "高雄市");
  const target = t.target as Row;
  assertEquals([target.election_id, target.region, target.issue, target.total, target.threshold], [2026, "高雄市", "社會福利", 6, 5]);
  const pol = target.policies as Row[];
  assertEquals(pol.length, 6);
  assertEquals(pol[0].level, "縣市長", "縣市長排最前面");
  assertEquals(new Set(pol.map((x) => x.policy_id)).size, 6);
  assert(pol.every((x) => typeof x.title === "string" && typeof x.level === "string"));
  assertEquals(target.existing_subtopics, []);

  await setThreshold(db, 6);
  assertEquals((await tasks(db)).length, 0, "剛好 6 筆、門檻 6：不超過就不開");
});

Deno.test("A3 拆分通過後條件不再成立→任務不再出現（自動關閉）；剩下仍超過門檻就再開一張並帶上已存在細項名", async () => {
  const db = await build();
  await setThreshold(db, 5);
  assertEquals((await tasks(db)).length, 1);
  // 6 筆全部歸進「托育」「敬老」→ 沒有還沒拆的了
  await db.exec(`INSERT INTO policy_subtopics (policy_id, issue, subtopic) VALUES
    ('${u(101)}','社會福利','托育'),('${u(102)}','社會福利','托育'),('${u(103)}','社會福利','敬老'),
    ('${u(104)}','社會福利','敬老'),('${u(105)}','社會福利','敬老'),('${u(106)}','社會福利','敬老')`);
  assertEquals((await tasks(db)).length, 0, "全部拆完，任務由 seed 收回");
  // 只拆一部分：剩 3 筆，門檻降到 2 → 再開，清單只列沒拆的，existing_subtopics 帶已存在細項名（多的排前）
  await db.exec(`DELETE FROM policy_subtopics WHERE policy_id IN ('${u(103)}','${u(104)}','${u(105)}')`);
  await setThreshold(db, 2);
  const [t] = await tasks(db);
  const target = t.target as Row;
  assertEquals(target.total, 3);
  assertEquals((target.policies as Row[]).map((x) => String(x.policy_id).slice(-3)).sort(), ["103", "104", "105"]);
  assertEquals(target.existing_subtopics, ["托育", "敬老"], "已存在的細項名（托育 2 筆、敬老 1 筆，多的排前）");
});

Deno.test("A4 已經有人交了這個縣市×議題、還在等票的不重複派", async () => {
  const db = await build();
  await setThreshold(db, 5);
  await db.exec(`INSERT INTO contributions (contribution_type, status, payload) VALUES ('policy_subtopics', 'pending', '{"region":"高雄市","issue":"社會福利"}'::jsonb)`);
  assertEquals((await tasks(db)).length, 0);
  await db.exec(`UPDATE contributions SET status = 'rejected'`);
  assertEquals((await tasks(db)).length, 1, "被退件就回到缺口");
});

Deno.test("A5 policy_subtopic_scope：只回該縣市、該議題範圍內的承諾", async () => {
  const db = await build();
  const ids = [u(101), u(107), u(111), u(999)];
  const rows = await q(db, "SELECT policy_id::text FROM policy_subtopic_scope(2026, '高雄市', '社會福利', $1::uuid[])", [ids]);
  assertEquals(rows.map((r) => r.policy_id), [u(101)], "107 是交通建設、111 是台北、999 不存在");
});

// ============================================================
// B. 大類不受影響
// ============================================================
Deno.test("B1 加了細項之後承諾仍在原大類：issues_summary／issues_scoped 逐筆相同，policies.tags 一個字沒動", async () => {
  const db = await build();
  const summary = () => q(db, "SELECT issue, total::int, by_level, samples FROM issues_summary(2026, '高雄市')");
  const scoped = () => q(db, "SELECT policy_id::text, issue FROM issues_scoped(2026, '高雄市') ORDER BY policy_id, issue");
  const tags = () => q(db, "SELECT id::text, tags, category FROM policies ORDER BY id");
  const [s0, c0, t0] = [await summary(), await scoped(), await tags()];
  assert(c0.some((r) => r.policy_id === u(101) && r.issue === "社會福利"));
  await db.exec(`INSERT INTO policy_subtopics (policy_id, issue, subtopic) VALUES ('${u(101)}','社會福利','托育'),('${u(102)}','社會福利','托育')`);
  assertEquals(await summary(), s0, "議題總數與各層級小計不變");
  assertEquals(await scoped(), c0, "每筆承諾所屬的大類不變（沒有因為細項而離開大類）");
  assertEquals(await tags(), t0, "policies.tags／category 一個字沒動");
});

Deno.test("B2 靜態：migration 與落庫程式都不寫 policies、不重定義大類判定", async () => {
  assertFalse(/UPDATE\s+policies\b/i.test(MIG), "migration 不改 policies");
  assertFalse(/INSERT\s+INTO\s+policies\b/i.test(MIG));
  for (const f of ["issue_tags_of", "issue_tag_is_junk", "issues_scoped", "issues_summary", "issues_page"]) {
    assertFalse(MIG.includes(`CREATE OR REPLACE FUNCTION ${f}(`), `${f} 不能在這支 migration 被改`);
  }
  const apply = (await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const fn = apply.slice(apply.indexOf("async function applyPolicySubtopics"), apply.indexOf("// ── 政策脈絡（#349"));
  assertFalse(/from\("policies"\)/.test(fn), "落庫不碰 policies 表");
  assert(fn.includes('from("policy_subtopics")'));
});

// ============================================================
// C. 交件驗證與落庫
// ============================================================
const SRC = "https://policy-tw.web.app/election/2026/高雄市?view=issues";
const good = (over: Record<string, unknown> = {}) => ({
  election_id: 2026, region: "高雄市", issue: "社會福利",
  subtopics: ["托育", "敬老"],
  assignments: [{ policy_id: u(101), subtopic: "托育" }, { policy_id: u(103), subtopic: "敬老" }],
  ...over,
});
const check = (payload: Record<string, unknown>) =>
  validateContributionRequest({ agent_name: "tester", contributions: [{ contribution_type: "policy_subtopics", payload, source_urls: [SRC] }] }).errors;

Deno.test("C1 交件驗證：合法的過", () => {
  assertEquals(check(good()), []);
  assertEquals(check(good({ task_id: "auto:issue_too_broad:2026:高雄市:社會福利", note: "備註" })), []);
});

Deno.test("C2 交件驗證：細項數量、名稱、對得上、沒用到的細項、重複的承諾都擋", () => {
  const bad = (over: Record<string, unknown>, path: string) => assert(check(good(over)).some((e) => e.path.startsWith(path)), `${path}：${JSON.stringify(over)}`);
  bad({ subtopics: ["托育"], assignments: [{ policy_id: u(101), subtopic: "托育" }] }, "payload.subtopics"); // 少於 2 個
  const seven = ["甲甲", "乙乙", "丙丙", "丁丁", "戊戊", "己己", "庚庚"];
  bad({ subtopics: seven, assignments: seven.map((s, i) => ({ policy_id: u(200 + i), subtopic: s })) }, "payload.subtopics"); // 多於 6 個
  bad({ subtopics: ["托育", "托育"] }, "payload.subtopics"); // 重複
  bad({ subtopics: ["托育", "社會福利"], assignments: [{ policy_id: u(101), subtopic: "托育" }, { policy_id: u(103), subtopic: "社會福利" }] }, "payload.subtopics"); // 跟大類同名
  bad({ subtopics: ["托育", "敬、老"] }, "payload.subtopics"); // 含頓號
  bad({ assignments: [{ policy_id: u(101), subtopic: "托育" }, { policy_id: u(103), subtopic: "不存在" }] }, "payload.assignments"); // 對不上 subtopics
  bad({ assignments: [{ policy_id: u(101), subtopic: "托育" }, { policy_id: u(101), subtopic: "敬老" }] }, "payload.assignments"); // 同一筆承諾兩次
  bad({ assignments: [{ policy_id: "not-uuid", subtopic: "托育" }, { policy_id: u(103), subtopic: "敬老" }] }, "payload.assignments");
  bad({ assignments: [] }, "payload.assignments");
  bad({ assignments: [{ policy_id: u(101), subtopic: "托育" }] }, "payload.subtopics"); // 「敬老」沒有任何承諾歸進去
  bad({ election_id: 1999 }, "payload.election_id");
  bad({ region: "" }, "payload.region");
  bad({ issue: "" }, "payload.issue");
  assert(!isSubtopicName("a") && !isSubtopicName("十三個字的細項名稱超過上限啦啦啦") && isSubtopicName("敬老津貼"));
});

const row = (payload: Record<string, unknown>, id = "c-1") => ({
  id, contribution_type: "policy_subtopics" as (typeof CONTRIBUTION_TYPES)[number], payload, source_urls: [SRC], note: null, agent_name: "tester", contributor_url: null,
});
const scopeRpc = (inScope: string[]) => ({ policy_subtopic_scope: (args: Row) => (args.p_ids as string[]).filter((i) => inScope.includes(i)).map((i) => ({ policy_id: i })) });

Deno.test("C3 落庫：新增、記 edit_history、不碰 policies（tags 原封不動）", async () => {
  const fake = createFakeSupabase(
    { policy_subtopics: [], edit_history: [], policies: [{ id: u(101), tags: ["社會福利"], category: "社會福利" }] },
    scopeRpc([u(101), u(103)]),
  );
  const out = await applyContribution(fake.client, row(good()));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.policy_subtopics.length, 2);
  assertEquals(fake.db.policy_subtopics.map((r) => [r.policy_id, r.issue, r.subtopic, r.contribution_id]).sort(), [
    [u(101), "社會福利", "托育", "c-1"], [u(103), "社會福利", "敬老", "c-1"],
  ]);
  assert(fake.db.edit_history.some((e) => e.table_name === "policy_subtopics" && e.field === "*"));
  assertEquals(fake.db.policies[0].tags, ["社會福利"], "大類 tags 保留，沒有被細項取代");
  assertEquals(fake.db.policies[0].category, "社會福利");
});

Deno.test("C4 落庫：範圍外略過、已有細項不覆蓋；全部已有 → superseded；全部範圍外 → failed", async () => {
  const fake = createFakeSupabase(
    { policy_subtopics: [{ id: "s-1", policy_id: u(101), issue: "社會福利", subtopic: "生育補助" }], edit_history: [] },
    scopeRpc([u(101), u(103)]), // 103 在範圍內、101 在範圍內但已有細項
  );
  const out = await applyContribution(fake.client, row(good({ assignments: [{ policy_id: u(101), subtopic: "托育" }, { policy_id: u(103), subtopic: "敬老" }, { policy_id: u(104), subtopic: "敬老" }] })));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.policy_subtopics.length, 2, "只新增 103；101 已有不覆蓋，104 範圍外略過");
  assertEquals(fake.db.policy_subtopics.find((r) => r.policy_id === u(101))?.subtopic, "生育補助", "先到先得，不覆蓋");

  const again = await applyContribution(fake.client, row(good({ assignments: [{ policy_id: u(101), subtopic: "托育" }, { policy_id: u(103), subtopic: "敬老" }] }), "c-2"));
  assertEquals(again.status, "superseded");

  const none = createFakeSupabase({ policy_subtopics: [], edit_history: [] }, scopeRpc([]));
  assertEquals((await applyContribution(none.client, row(good()))).status, "failed");
  assertEquals(none.db.policy_subtopics.length, 0);
});

// ============================================================
// D. 清點
// ============================================================
Deno.test("D1 型別清點：CONTRIBUTION_TYPES／TASK_TYPES／SUGGESTED_TYPE／做法／標籤（純中文）／skill 說明", async () => {
  assert((CONTRIBUTION_TYPES as readonly string[]).includes("policy_subtopics"));
  assert((TASK_TYPES as readonly string[]).includes("issue_too_broad"));
  assertEquals(SUGGESTED_TYPE.issue_too_broad, "policy_subtopics");
  assert(hasGuidance("issue_too_broad"));
  assert(PAYLOAD_SHAPE.policy_subtopics);
  const labels = await Deno.readTextFile(new URL("../../../lib/task-labels.ts", import.meta.url));
  const label = labels.match(/issue_too_broad:\s*'([^']*)'/)?.[1] ?? "";
  assert(label && !/[A-Za-z]/.test(label), "任務看板的中文名稱要有且不夾英文字母");
  const skill = await readSkillWithTypes();
  assertStringIncludes(skill, "`policy_subtopics`");
  assertStringIncludes(skill, "issue_too_broad");
  assertStringIncludes(skill, "優先沿用", "skill 要教代理優先沿用已存在的細項名");
});

Deno.test("D2 migration 清點：CHECK 收新型別與全部既有型別、臂名清單、總表接上、規則種子、不動計分函式", () => {
  const a = MIG.indexOf("ADD CONSTRAINT contributions_contribution_type_check");
  const chk = MIG.slice(a, MIG.indexOf(";", a));
  for (const t of CONTRIBUTION_TYPES.filter((x) => x !== "lineage_status")) assertStringIncludes(chk, `'${t}'`, `CHECK 漏了 ${t}`); // lineage_status 由 20261105200000 加進 CHECK
  assertStringIncludes(fnText(MIG, "activity_arm_names"), "'issue_too_broad'");
  assertStringIncludes(fnText(MIG, "contribution_auto_tasks_arms"), "UNION ALL SELECT 'issue_too_broad' AS arm, t.* FROM contribution_auto_tasks_issue_too_broad() t");
  assertStringIncludes(MIG, "INSERT INTO activity_rules (activity, window_kind, params, note)");
  assertStringIncludes(fnText(MIG, "system_one_vote_budget_candidates"), "'policy_subtopics'");
  assertStringIncludes(MIG, "('issue_too_broad', 1,");
  assertFalse(MIG.includes("FUNCTION contribution_required_agree("), "沒有動計分：新型別走預設的 normal 目標分數 3");
});

Deno.test("D3 總表其餘分支與前一版一字不差（只多一行 UNION）", async () => {
  const prev = fnText(await readMig("20261101020000_roster_check_unify.sql"), "contribution_auto_tasks_arms");
  const now = fnText(MIG, "contribution_auto_tasks_arms");
  const added = "  UNION ALL SELECT 'issue_too_broad' AS arm, t.* FROM contribution_auto_tasks_issue_too_broad() t\n";
  assertEquals(now.replace(added, ""), prev);
});

// ============================================================
// E. 還原驗證：被守的東西拿掉，測試必須紅
// ============================================================
Deno.test("E1 還原：門檻改成 >= → A2 的邊界斷言會紅", async () => {
  const bad = DETECT_SQL.replace("HAVING count(DISTINCT sc.policy_id) > p.threshold", "HAVING count(DISTINCT sc.policy_id) >= p.threshold");
  assert(bad !== DETECT_SQL);
  const db = await build(bad);
  await setThreshold(db, 6);
  assertEquals((await tasks(db)).length, 1, "壞版本在剛好等於門檻時開了任務；好版本的 A2 斷言 0 張，所以會紅");
});

Deno.test("E2 還原：拿掉「已有細項的承諾不算」→ A3 的自動關閉會紅", async () => {
  const bad = mutate(DETECT_SQL, "WHERE NOT EXISTS (SELECT 1 FROM policy_subtopics t WHERE t.policy_id = s.policy_id AND t.issue = s.issue)", "WHERE true");
  const db = await build(bad);
  await setThreshold(db, 5);
  await db.exec(`INSERT INTO policy_subtopics (policy_id, issue, subtopic) SELECT id, '社會福利', '托育' FROM policies WHERE category = '社會福利' AND politician_id <> '${u(6)}'`);
  assertEquals((await tasks(db)).length, 1, "壞版本拆完仍開著任務；好版本應為 0（A3）");
});

Deno.test("E3 還原：把細項塞回 tags（舊作法）→ B1 的守門會紅", async () => {
  const db = await build();
  const before = await q(db, "SELECT issue FROM issues_scoped(2026, '高雄市') WHERE policy_id = $1", [u(101)]);
  assertEquals(before.map((r) => r.issue), ["社會福利"]);
  // 舊作法：細項直接進 tags → 大類被細項取代，承諾離開「社會福利」
  await db.exec(`UPDATE policies SET tags = ARRAY['托育'] WHERE id = '${u(101)}'`);
  const after = await q(db, "SELECT issue FROM issues_scoped(2026, '高雄市') WHERE policy_id = $1", [u(101)]);
  assertEquals(after.map((r) => r.issue), ["托育"], "證明陷阱真實存在：這樣做承諾就不在社會福利了，B1 會抓到");
});

Deno.test("E4 還原：落庫改成覆蓋已有細項 → C4 會紅（程式碼層級）", async () => {
  const src = (await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assertStringIncludes(src, "const toInsert = [...scoped].filter((id) => !had.has(id))");
  assertStringIncludes(src, 'rpc("policy_subtopic_scope"');
});

// ============================================================
// F. P1b：新承諾交件可帶選填 subtopic（20261102020000_policy_subtopic_issue.sql）
// ============================================================
const MIG_B_NAME = "20261102020000_policy_subtopic_issue.sql";
const MIG_B = await readMig(MIG_B_NAME);
const POLICY_BASE = { politician_id: u(2), title: "公托再增設十處", description: "任期內在議員選區增設十處公共托育中心並延長開放時間。", category: "社會福利", election_id: 2026 };
const checkPolicy = (payload: Record<string, unknown>) =>
  validateContributionRequest({ agent_name: "tester", contributions: [{ contribution_type: "policy", payload, source_urls: ["https://example.gov.tw/a"] }] }).errors;

Deno.test("F1 policy 交件：subtopic 選填；有填要是合法細項名", () => {
  assertFalse(checkPolicy({ ...POLICY_BASE }).some((e) => e.path === "payload.subtopic"), "不帶照舊過");
  assertFalse(checkPolicy({ ...POLICY_BASE, subtopic: "托育" }).some((e) => e.path === "payload.subtopic"));
  for (const bad of ["a", "托、育", "十三個字的細項名稱超過上限啦啦啦", " 托育", ""]) {
    assert(checkPolicy({ ...POLICY_BASE, subtopic: bad }).some((e) => e.path === "payload.subtopic"), `應擋：${JSON.stringify(bad)}`);
  }
});

Deno.test("F2 policy_subtopic_issue（PGlite）：大類優先取 category，其次字母序；沒有議題回 NULL", async () => {
  const db = await build();
  await db.exec(MIG_B.replace(/REVOKE[^;]*;|GRANT[^;]*;|COMMENT[^;]*;|NOTIFY[^;]*;/g, ""));
  const issue = async (id: string) => (await q(db, "SELECT policy_subtopic_issue($1::uuid) AS i", [id]))[0].i;
  assertEquals(await issue(u(101)), "社會福利");
  await db.exec(`UPDATE policies SET tags = ARRAY['交通建設','社會福利'] WHERE id = '${u(101)}'`);
  assertEquals(await issue(u(101)), "社會福利", "category 在議題之中就用它");
  await db.exec(`UPDATE policies SET category = '其他', tags = ARRAY['交通建設','社會福利'] WHERE id = '${u(101)}'`);
  assertEquals(await issue(u(101)), "交通建設", "否則字母序第一個");
  await db.exec(`UPDATE policies SET category = '其他', tags = NULL WHERE id = '${u(101)}'`);
  assertEquals(await issue(u(101)), null, "沒有議題回 NULL");
});

const policyRow = (payload: Record<string, unknown>) => ({
  id: "c-p1", contribution_type: "policy" as (typeof CONTRIBUTION_TYPES)[number], payload, source_urls: ["https://example.gov.tw/a"], note: null, agent_name: "tester", contributor_url: null,
});
const seedPol = () => ({ politicians: [{ id: u(2), name: "李大華" }], policies: [], policy_subtopics: [], edit_history: [] });

Deno.test("F3 落庫：帶 subtopic 的新承諾 → 寫進 policy_subtopics（大類由函式決定），tags 不動", async () => {
  const fake = createFakeSupabase(seedPol(), { policy_subtopic_issue: () => "社會福利" });
  const out = await applyContribution(fake.client, policyRow({ ...POLICY_BASE, subtopic: "托育", tags: ["社會福利"] }));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.policies.length, 1);
  assertEquals(fake.db.policies[0].tags, ["社會福利"], "tags 照交件原樣，沒有被細項動到");
  assertEquals(fake.db.policy_subtopics.map((r) => [r.policy_id, r.issue, r.subtopic, r.contribution_id]), [[fake.db.policies[0].id, "社會福利", "托育", "c-p1"]]);
  assert(fake.db.edit_history.some((e) => e.table_name === "policy_subtopics"));
});

Deno.test("F4 落庫：沒帶 subtopic 不寫；沒有大類議題或跟大類同名只略過細項、承諾照建", async () => {
  const none = createFakeSupabase(seedPol(), { policy_subtopic_issue: () => "社會福利" });
  assertEquals((await applyContribution(none.client, policyRow({ ...POLICY_BASE }))).status, "applied");
  assertEquals(none.db.policy_subtopics.length, 0);

  const noIssue = createFakeSupabase(seedPol(), { policy_subtopic_issue: () => null });
  const o1 = await applyContribution(noIssue.client, policyRow({ ...POLICY_BASE, subtopic: "托育" }));
  assertEquals([o1.status, noIssue.db.policies.length, noIssue.db.policy_subtopics.length], ["applied", 1, 0]);
  assertStringIncludes(o1.message, "細項未寫入");

  const same = createFakeSupabase(seedPol(), { policy_subtopic_issue: () => "托育" });
  const o2 = await applyContribution(same.client, policyRow({ ...POLICY_BASE, subtopic: "托育" }));
  assertEquals([o2.status, same.db.policy_subtopics.length], ["applied", 0]);
});

Deno.test("F5 清點：協議版號、skill-types 有 subtopic 說明（優先沿用）、不叫代理把細項寫進 tags", async () => {
  const skill = await readSkillWithTypes();
  assertStringIncludes(skill, "`subtopic`（選填");
  assertStringIncludes(skill, "不要把細項放進 `tags`");
  assertFalse(skill.includes("要給到細項層級"), "P1 時決定不叫代理把細項寫進 tags");
  assert(MIG_B.includes("CREATE OR REPLACE FUNCTION policy_subtopic_issue(p_policy_id uuid)"));
  assertFalse(/UPDATE\s+policies\b|INSERT\s+INTO\s+policies\b/i.test(MIG_B));
});

Deno.test("F6 還原：落庫拿掉 subtopic 處理 → F3 會紅；拿掉 validator → F1 會紅（程式碼層級）", async () => {
  const apply = (await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assertStringIncludes(apply, "writeNewPolicySubtopic(supabase, ctx, row.id, inserted.id, subtopic)");
  const schema = (await Deno.readTextFile(new URL("./contribution-schema.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assertStringIncludes(schema, 'push("payload.subtopic"');
});
