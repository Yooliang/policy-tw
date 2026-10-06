/**
 * 學經歷帶出處、參選紀錄的政黨（#346 第一階段，2026-10-06）的守門測試。這裡沒有資料庫，守的是「改掉就會出錯、而且不會報錯」的幾件事：
 *   1. 讀不到的社群：SQL 的 career_source_readable 跟 TS 的 UNREADABLE_SOCIAL_HOSTS 同一份（臉書 #349 裁決：讀不到不收）
 *   2. 兩支 migration 只加不刪（CLAUDE.md：刪改欄位分兩次上）、不改人物的學經歷陣列與政黨文字
 *   3. 觸發器掛在對的時機：陣列變動、交件變成 applied（陣列沒變也要掛出處——補出處的代理是照原文重交）
 *   4. 派工臂：沿用 profile_detail_gap、接進 UNION 而且前一版的臂一支不少、任務編號拿得出人物、等票中不派
 *   5. 給代理看的 current 與說明、落庫回覆講得出出處掛不掛得上；協議版號與說明
 *   6. 參選紀錄的政黨：一人一屆一筆（主鍵），「只有一筆參選紀錄」這條只在回填用，不在落庫觸發器裡
 * SQL 本身另外在 PGlite（WASM Postgres）上灌 10-06 唯讀快照實跑過（27 條），見 PR 說明。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { UNREADABLE_SOCIAL_HOSTS, isUnreadableSocial } from "./lineage.ts";
import { careerItemCount, careerSourceNote, readableCareerSources } from "./politician-careers.ts";
import { politicianIdFromTask, withTaskPolitician } from "./task-politician.ts";
import { CAREER_SOURCES_HINT, shapeCareers, shapeTaskCurrent } from "./task-context.ts";
import { TASK_GUIDANCE } from "./task-guidance.ts";
import { TASK_TYPES } from "./contribution-schema.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { applyContribution } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const careersSql = (await Deno.readTextFile(new URL("20261006073460_politician_careers.sql", MIGRATIONS))).replace(/\r/g, "");
const partiesSql = (await Deno.readTextFile(new URL("20261006073461_parties.sql", MIGRATIONS))).replace(/\r/g, "");
function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  return text.slice(i, j < 0 ? undefined : j);
}
/** 去掉 SQL 註解（-- 到行尾），斷言只看程式本體 */
const code = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

const PID = "d9258d9f-20bd-4c50-91e4-84ff9c5bb563";

// ── 1. 讀不到的社群：SQL 與 TS 同一份 ───────────────────────────────────────

Deno.test("career_source_readable 擋的網域＝lineage.ts 的 UNREADABLE_SOCIAL_HOSTS（臉書、IG、Threads）", () => {
  const fn = between(careersSql, "CREATE OR REPLACE FUNCTION career_source_readable", "COMMENT ON FUNCTION career_source_readable");
  const m = /\(\^\|\\\.\)\(([^)]+)\)\$/.exec(fn);
  assert(m, "抓不到 SQL 的網域清單");
  const sqlHosts = m[1].split("|").map((h) => h.replace(/\\\./g, ".")).sort();
  assertEquals(sqlHosts, [...UNREADABLE_SOCIAL_HOSTS].sort());
  // TS 這邊同一條規則
  assertEquals(readableCareerSources(["https://www.facebook.com/x", "https://m.facebook.com/y", "https://fb.watch/z", "https://www.instagram.com/a",
    "https://www.threads.net/@b", "https://council.gov.tw/m/1", "ftp://x", "不是網址", "https://zh.wikipedia.org/wiki/x"]),
    ["https://council.gov.tw/m/1", "https://zh.wikipedia.org/wiki/x"]);
  assert(isUnreadableSocial("https://facebook.com/x"));
});

// ── 2. 只加不刪 ─────────────────────────────────────────────────────────────

Deno.test("兩支 migration 只加不刪：不刪欄位、不刪表、不改欄位型別、不動學經歷陣列與政黨文字", () => {
  for (const [name, sql] of [["學經歷", careersSql], ["政黨", partiesSql]] as const) {
    const body = code(sql);
    for (const bad of [/DROP\s+COLUMN/i, /DROP\s+TABLE/i, /ALTER\s+COLUMN[^;]*TYPE/i, /RENAME\s+(COLUMN|TO)/i, /DROP\s+VIEW/i, /DROP\s+FUNCTION/i]) {
      assert(!bad.test(body), `${name} migration 有 ${bad}`);
    }
    assert(!/UPDATE\s+politicians\s+SET\s+(education|experience|party)\s*=/i.test(body), `${name} migration 改了人物的學經歷陣列或政黨文字`);
  }
  // 政黨回填只寫 party_id 這一欄
  assert(/UPDATE politicians SET party_id = party_id_of\(party\) WHERE party_id IS DISTINCT FROM party_id_of\(party\);/.test(partiesSql));
});

// ── 3. 觸發器時機 ───────────────────────────────────────────────────────────

Deno.test("學經歷觸發器：人物新增或陣列變動才同步；交件變成 applied 就掛出處（不看陣列有沒有變）", () => {
  assertStringIncludes(careersSql, "AFTER INSERT OR UPDATE OF education, experience ON politicians");
  const t = between(careersSql, "CREATE TRIGGER trg_contribution_applied_career_sources", ";");
  assertStringIncludes(t, "AFTER UPDATE OF status ON contributions");
  assertStringIncludes(t, "WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied')");
  const fn = between(careersSql, "CREATE OR REPLACE FUNCTION contribution_applied_career_sources", "DROP TRIGGER");
  assertStringIncludes(fn, "NEW.contribution_type = 'politician'");
  assertStringIncludes(fn, "politician_careers_attach_sources(NEW.applied_politician_id");
  // 掛出處只看這筆交件，不跟舊值比（補出處的代理照原文重交，陣列與 payload 都可能跟上次一樣）
  assert(!/\bOLD\./.test(code(fn)), "掛出處不能看舊值");
  assertStringIncludes(code(fn), "IF NEW.contribution_type = 'politician' AND NEW.applied_politician_id IS NOT NULL\n     AND (jsonb_typeof(NEW.payload -> 'education') = 'array' OR jsonb_typeof(NEW.payload -> 'experience') = 'array') THEN");
  // 觸發器出錯不擋寫入（跟 #347 出處同步同一個做法），但要記警告
  for (const f of [fn, between(careersSql, "CREATE OR REPLACE FUNCTION politician_careers_sync_trg", "DROP TRIGGER")]) {
    assertStringIncludes(f, "EXCEPTION WHEN OTHERS THEN");
    assertStringIncludes(f, "RAISE WARNING");
  }
  // 回填之後才掛觸發器（回填自己跑 sync）
  assert(careersSql.indexOf("PERFORM politician_careers_sync(r.id, 'backfill:array')") < careersSql.indexOf("CREATE TRIGGER trg_politician_careers_sync"));
  // 回填與觸發器用同一支掛出處的函式
  assertStringIncludes(between(careersSql, "-- 已落庫的 politician 交件", "-- 6. 同步觸發器"), "politician_careers_attach_sources(r.applied_politician_id");
  // 自我檢查：回填完陣列與表要一致
  assertStringIncludes(careersSql, "SELECT count(*) INTO v_drift FROM politician_careers_drift");
});

Deno.test("出處引用的 target_table 只加不刪：前一版的六種都在，加學經歷、政黨", async () => {
  const prev = (await Deno.readTextFile(new URL("20261006034900_policy_lineages.sql", MIGRATIONS))).replace(/\r/g, "");
  const list = (sql: string) => {
    const all = [...sql.matchAll(/source_refs_target_table_check\s+CHECK \(target_table IN \(([^)]*)\)\)/g)];
    return all[all.length - 1][1].split(",").map((s) => s.trim().replace(/'/g, ""));
  };
  const before = list(prev);
  for (const [sql, add] of [[careersSql, "politician_careers"], [partiesSql, "parties"]] as const) {
    const now = list(sql);
    for (const t of before) assert(now.includes(t), `少了 ${t}`);
    assert(now.includes(add));
  }
  assert(list(partiesSql).includes("politician_careers"), "政黨那支要保留學經歷");
});

// ── 4. 派工臂 ───────────────────────────────────────────────────────────────

Deno.test("派工臂：沿用 profile_detail_gap、接進 UNION 且前一版的臂一支不少、等票中不派、任務編號拿得出人物", async () => {
  const arm = between(careersSql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_career_sources()", "COMMENT ON FUNCTION contribution_auto_tasks_career_sources");
  assertStringIncludes(arm, "'auto:profile_detail_gap:sources:' || p.id, 'profile_detail_gap'");
  assert((TASK_TYPES as readonly string[]).includes("profile_detail_gap"), "沿用既有型別，不用加新型別");
  assertStringIncludes(arm, "c.status IN ('pending', 'verified', 'apply_failed')");
  assertStringIncludes(code(arm), "WHERE NOT EXISTS (SELECT 1 FROM inflight i WHERE i.pid = p.id::TEXT)", "等票中的要真的被排除");
  assertStringIncludes(arm, "p.merged_into IS NULL");
  assertStringIncludes(arm, "臉書、IG、Threads 讀不到，不算出處");
  const arms = between(careersSql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()", "COMMENT ON FUNCTION contribution_auto_tasks_arms");
  assertStringIncludes(arms, "UNION ALL SELECT * FROM contribution_auto_tasks_career_sources()");
  const prev = (await Deno.readTextFile(new URL("20261006034900_policy_lineages.sql", MIGRATIONS))).replace(/\r/g, "");
  const prevArms = between(prev, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()", "COMMENT ON FUNCTION contribution_auto_tasks_arms");
  // 前一版的函式本體（WITH／WHERE／每一行 UNION）原樣保留，只多一行
  const norm = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"));
  const now = norm(arms);
  for (const line of norm(prevArms)) assert(now.includes(line), `前一版的「${line}」不見了`);
  assertEquals(now.length, norm(prevArms).length + 1);

  assertEquals(politicianIdFromTask(`auto:profile_detail_gap:sources:${PID}`), PID);
  assertEquals(politicianIdFromTask(`auto:profile_detail_gap:${PID}`), PID);
  assertEquals(politicianIdFromTask(`auto:profile_gap:${PID}`), PID);
  assertEquals(politicianIdFromTask(`auto:profile_detail_gap:other:${PID}`), null);
  assertEquals(withTaskPolitician("politician", { name: "呂承祐", experience: ["x"] }, `auto:profile_detail_gap:sources:${PID}`),
    { name: "呂承祐", experience: ["x"], politician_id: PID });
});

// ── 5. 給代理看的、落庫回覆、協議 ─────────────────────────────────────────────

Deno.test("current：給每一項有沒有出處、還缺出處的原文；表還沒上線就不給", () => {
  const rows = [
    { kind: "career", text: "台北市議員", sort_order: 2, needs_source: false, sources: [{ url: "https://tcc.gov.tw/x", role: "primary", archive_url: null, title: "t" }] },
    { kind: "education", text: "甲大學", sort_order: 1, needs_source: true, sources: [] },
    { kind: "career", text: "某公司董事長", sort_order: 1, needs_source: true, sources: [] },
  ];
  const shaped = shapeCareers(rows);
  assertEquals(shaped.unsourced, { education: ["甲大學"], experience: ["某公司董事長"] });
  // 學歷在前、經歷在後，各自照陣列順序
  assertEquals(shaped.items.map((i) => i.text), ["甲大學", "某公司董事長", "台北市議員"]);
  assertEquals(shaped.items[2].sources, [{ url: "https://tcc.gov.tw/x", role: "primary", archive_url: null }]);
  const cur = shapeTaskCurrent("profile_detail_gap", { politician: { id: PID, name: "x", education: ["甲大學"], experience: ["台北市議員", "某公司董事長"] }, careers: rows });
  const inner = cur as Record<string, unknown>;
  assertEquals(inner.unsourced, { education: ["甲大學"], experience: ["某公司董事長"] });
  assertEquals(inner.career_sources_hint, CAREER_SOURCES_HINT);
  // 視圖還沒上線（careers 是 undefined）：形狀跟以前一樣，不多鍵
  const old = shapeTaskCurrent("profile_detail_gap", { politician: { id: PID, name: "x", education: null, experience: null } }) as Record<string, unknown>;
  assert(!("careers" in old) && !("unsourced" in old) && !("career_sources_hint" in old));
  // 全部都有出處就不給提示
  const done = shapeTaskCurrent("profile_detail_gap", { politician: { id: PID }, careers: [rows[0]] }) as Record<string, unknown>;
  assert(!("career_sources_hint" in done));
  assertStringIncludes(TASK_GUIDANCE.profile_detail_gap, "career_sources");
  assertStringIncludes(TASK_GUIDANCE.profile_detail_gap, "臉書、IG、Threads 讀不到，不算出處");
});

Deno.test("落庫回覆講得出學經歷的出處掛不掛得上（陣列沒變也會掛，不要讓代理以為白做）", async () => {
  assertEquals(careerSourceNote({ name: "x" }, ["https://a.gov.tw"]), "");
  assertEquals(careerItemCount({ education: ["甲", " ", 3], experience: "不是陣列" }), 1);
  assertStringIncludes(careerSourceNote({ experience: ["甲"] }, ["https://www.facebook.com/x"]), "沒有掛上出處");
  assertStringIncludes(careerSourceNote({ experience: ["甲"] }, ["https://www.facebook.com/x", "https://council.gov.tw/1"]), "會掛上這次的 source_urls");
  const fake = createFakeSupabase({
    politicians: [{ id: PID, name: "呂承祐", party: "台灣民眾黨", region: "基隆市", position: "縣市議員候選人", education: ["國防醫學院 碩士"], experience: ["宏安國際有限公司技術長"] }],
    politician_keys: [],
  });
  const row = {
    id: "22222222-2222-4222-8222-222222222222", contribution_type: "politician", status: "verified", agent_name: "a", contributor_ip_hash: "ip",
    contributor_url: null, note: null, retry_count: 0, source_urls: ["https://www.facebook.com/x"],
    task_id: `auto:profile_detail_gap:sources:${PID}`,
    payload: { name: "呂承祐", experience: ["宏安國際有限公司技術長"] },
  };
  // deno-lint-ignore no-explicit-any
  const out = await applyContribution(fake.client, row as any);
  assertEquals(out.status, "applied", JSON.stringify(out));
  assertStringIncludes(out.message ?? "", "無空欄位可補");
  assertStringIncludes(out.message ?? "", "學經歷沒有掛上出處");
  assertEquals(fake.db.politicians.length, 1, "照任務編號對到那一位，不建新人物");
});

Deno.test("協議 1.54.0：學經歷補出處、政黨與學經歷的唯讀欄位寫進 skill.md", async () => {
  assertEquals(PROTOCOL_VERSION, "1.54.0");
  const md = (await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url))).replace(/\r/g, "");
  for (const s of ["auto:profile_detail_gap:sources:", "career_sources", "`unsourced`", "臉書、IG、Threads 讀不到，不算出處", "`politician_careers_full`", "**`parties`**（1.54.0", "`party_basis`"]) {
    assertStringIncludes(md, s);
  }
});

// ── 6. 參選紀錄的政黨 ─────────────────────────────────────────────────────────

Deno.test("參選紀錄的政黨：落庫觸發器只寫交件的政黨；「只有一筆參選紀錄」只在回填用；寫法對不到不猜", () => {
  const fn = between(partiesSql, "CREATE OR REPLACE FUNCTION politician_election_party_from_candidacy", "REVOKE EXECUTE");
  // 一人一屆一筆（主鍵 politician_id＋election_id）
  assertStringIncludes(fn, "WHERE pe.politician_id = p_politician_id AND pe.election_id = v_eid");
  assertStringIncludes(fn, "IF NOT FOUND THEN RETURN 0; END IF;  -- 寫法還沒有對照");
  assertStringIncludes(fn, "party_basis = 'contribution'");
  assert(!fn.includes("person_single"));
  const trg = between(partiesSql, "CREATE OR REPLACE FUNCTION contribution_applied_candidacy_party", "DROP TRIGGER");
  assert(!trg.includes("person_single"), "person_single 不能出現在落庫觸發器");
  assertStringIncludes(trg, "NEW.contribution_type = 'candidacy'");
  assertStringIncludes(between(partiesSql, "CREATE TRIGGER trg_contribution_applied_candidacy_party", ";"), "WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied')");
  // person_single 的條件：只有一筆、人物政黨沒改過、文字有對照、還沒有根據
  const single = between(partiesSql, "-- 回填二", "-- 之後：candidacy 落庫就寫");
  for (const s of ["pe.party_basis IS NULL", "= 1", "h.field = 'party' AND h.reverted_at IS NULL", "JOIN party_aliases a ON a.alias_key = party_alias_key(p.party)"]) assertStringIncludes(single, s);
  // 有政黨就要有根據
  assertStringIncludes(partiesSql, "CHECK (party_id IS NULL OR party_basis IS NOT NULL)");
  // 人物的 party_id 觸發器在文字變動時重對
  assertStringIncludes(partiesSql, "BEFORE INSERT OR UPDATE OF party ON politicians");
});
