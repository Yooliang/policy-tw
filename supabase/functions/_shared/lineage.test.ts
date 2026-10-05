/**
 * 政策脈絡（#349 第一階段，2026-10-06；比照日本站 keifu 的 lineages／handovers）的守門測試。
 *
 * 一條脈絡＝一件事在某一層級、某一地方的來龍去脈。這裡守的是「改掉就會出錯、而且不會報錯」的幾件事：
 *   1. SQL 與 TS 同一組值（層級、角色、依據、交接型態、關聯型態、政見來源、字數上限）
 *   2. 「中止」交接要兩台機器：TS 的 needsTwoIps 與 SQL 的 contribution_needs_two_ips 同一條規則，
 *      而且計票、驗證池、佇列預覽三支都改用它（漏一支就是「分數到了卻永遠留在池外」或「一台機器就上線」）
 *   3. 交件守門：角色以官方紀錄為準（官方紀錄要官方網址）、本人自述只標本人宣稱、臉書讀不到不收
 *   4. 落庫：一條政見只屬於一條脈絡；重交＝覆蓋、每欄記履歷；拿掉角色整列記下可還原；候選清查查過就記結論
 *   5. 派工臂：範圍（同三要素：還沒投票看在選者、已投票看當選者）、地區只來自參選紀錄、首長才記交接、等票中不派
 *   6. migration 不寫任何一條脈絡（資料走流程）；policies_with_logs 前面的欄位原樣保留
 * SQL 本身另外在 PGlite（WASM Postgres）上實跑過，見 PR 說明；這裡沒有資料庫。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { CONTRIBUTION_TYPES, TASK_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import { applyContribution } from "./apply-contribution.ts";
import { precheckApplyTargets } from "./apply-precheck.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import {
  HANDOVER_TWO_IP_TYPES, HANDOVER_TYPES, isOfficialUrl, isUnreadableSocial, LINEAGE_LEVELS, LINEAGE_SUMMARY_MAX, LINEAGE_TITLE_MAX,
  LINEAGE_TITLE_MIN, linkLevelProblem, LINK_NOTE_MAX, LINK_NOTE_MIN, LINK_TYPES, LOCATOR_MAX, parseCandidateTaskId, PARTICIPANT_BASES,
  PARTICIPANT_ROLES, POLICY_ORIGINS,
} from "./lineage.ts";
import { needsTwoIps, riskLevel, SCORE_TWO_IP_TYPES, scoreStatus } from "./consensus.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { SINGLE_ANSWER_TASK_TYPES } from "./single-answer-guard.ts";
import { buildReportTemplate, PAYLOAD_SHAPE, TASK_GUIDANCE } from "./task-guidance.ts";
import { LINEAGE_VERIFY_HINT, shapeTaskCurrent, shapeVerifyCurrent } from "./task-context.ts";
import { soleSourceProblem } from "./sole-source-guard.ts";

type Obj = Record<string, unknown>;

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const P3 = "00000000-0000-4000-8000-000000000003";
const A = "aaaaaaaa-0000-4000-8000-000000000001"; // 人物
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const L1 = "11111111-0000-4000-8000-0000000000aa";
const L2 = "22222222-0000-4000-8000-0000000000bb";
const LY = "https://lis.ly.gov.tw/lylgmeetc/lgmeetkm?some-bill";
const CNA = "https://www.cna.com.tw/news/aipl/202610060001.aspx";
const LTN = "https://news.ltn.com.tw/news/politics/breakingnews/1";
const FB = "https://www.facebook.com/somebody/posts/1";
const BULLETIN = "https://bulletin.cec.gov.tw/2026/district.pdf";
const NOTE = "兩條政見都是台中捷運藍線：計畫名稱與路線相同，見公報第 2 頁。";

function submit(type: string, payload: Obj, sourceUrls: string[] = [BULLETIN], extra: Obj = {}) {
  return validateContributionRequest({ agent_name: "tester", contribution_type: type, payload, source_urls: sourceUrls, ...extra });
}
const paths = (r: ReturnType<typeof validateContributionRequest>) => r.errors.map((e) => e.path);

// ── 1. SQL 與 TS 同一組值 ─────────────────────────────────────────────────────

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
async function migrationWith(needle: string): Promise<{ name: string; sql: string }> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort().reverse()) {
    const text = await Deno.readTextFile(new URL(name, MIGRATIONS));
    if (text.includes(needle)) return { name, sql: text.replace(/\r/g, "") };
  }
  throw new Error(`沒有 migration 含 ${needle}`);
}
function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  return text.slice(i, j < 0 ? undefined : j);
}
const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const { name: MIG, sql } = await migrationWith("CREATE TABLE IF NOT EXISTS lineages (");
const lineagesTable = between(sql, "CREATE TABLE IF NOT EXISTS lineages (", "\n);");
const participantsTable = between(sql, "CREATE TABLE IF NOT EXISTS lineage_participants (", "\n);");
const handoversTable = between(sql, "CREATE TABLE IF NOT EXISTS handovers (", "\n);");
const linksTable = between(sql, "CREATE TABLE IF NOT EXISTS lineage_links (", "\n);");

Deno.test("脈絡值域：層級、角色、依據、交接型態、關聯型態、政見來源，SQL 的 CHECK 跟 TS 同一組", () => {
  assertEquals(quoted(lineagesTable.match(/level\s+TEXT NOT NULL CHECK \(level IN \(([^)]+)\)\)/)![1]), [...LINEAGE_LEVELS]);
  assertEquals(quoted(participantsTable.match(/role\s+TEXT NOT NULL CHECK \(role IN \(([^)]+)\)\)/)![1]), [...PARTICIPANT_ROLES]);
  assertEquals(quoted(participantsTable.match(/basis\s+TEXT NOT NULL CHECK \(basis IN \(([^)]+)\)\)/)![1]), [...PARTICIPANT_BASES]);
  assertEquals(quoted(handoversTable.match(/handover_type\s+TEXT NOT NULL CHECK \(handover_type IN \(([^)]+)\)\)/)![1]), [...HANDOVER_TYPES]);
  assertEquals(quoted(linksTable.match(/link_type\s+TEXT NOT NULL CHECK \(link_type IN \(([^)]+)\)\)/)![1]), [...LINK_TYPES]);
  assertEquals(quoted(sql.match(/CHECK \(origin IS NULL OR origin IN \(([^)]+)\)\)/)![1]), [...POLICY_ORIGINS]);
});

Deno.test("脈絡字數：標題、摘要、交接與關聯的說明、出處位置，SQL 跟 TS 同一組數字", () => {
  const title = lineagesTable.match(/char_length\(btrim\(title\)\) BETWEEN (\d+) AND (\d+)/)!;
  assertEquals([Number(title[1]), Number(title[2])], [LINEAGE_TITLE_MIN, LINEAGE_TITLE_MAX]);
  assertEquals(Number(lineagesTable.match(/char_length\(btrim\(summary\)\) BETWEEN 1 AND (\d+)/)![1]), LINEAGE_SUMMARY_MAX);
  for (const t of [handoversTable, linksTable]) {
    const note = t.match(/char_length\(btrim\(note\)\) BETWEEN (\d+) AND (\d+)/)!;
    assertEquals([Number(note[1]), Number(note[2])], [LINK_NOTE_MIN, LINK_NOTE_MAX]);
  }
  for (const t of [participantsTable, handoversTable, linksTable]) {
    assertEquals(Number(t.match(/char_length\(btrim\(source_locator\)\) BETWEEN 1 AND (\d+)/)![1]), LOCATOR_MAX);
  }
});

Deno.test("一條脈絡的地方：層級與縣市、鄉鎮、官方代碼要對得上（中央沒有地方、縣市 5 碼、鄉鎮 8 碼）", () => {
  assertStringIncludes(lineagesTable, "level = 'national' AND region IS NULL AND sub_region IS NULL AND admin_code IS NULL");
  assertStringIncludes(lineagesTable, "level = 'county'   AND region IS NOT NULL AND sub_region IS NULL AND admin_code IS NOT NULL AND admin_code ~ '^[0-9]{5}$'");
  assertStringIncludes(lineagesTable, "level = 'township' AND region IS NOT NULL AND sub_region IS NOT NULL AND admin_code IS NOT NULL AND admin_code ~ '^[0-9]{8}$'");
  assertStringIncludes(lineagesTable, "admin_code      TEXT REFERENCES admin_divisions(code)");
});

Deno.test("一個人一條脈絡：官方紀錄一個角色、本人宣稱一個角色；同一對任期一筆交接；同一對上下級一筆關聯", () => {
  assertStringIncludes(participantsTable, "UNIQUE (lineage_id, politician_id, basis)");
  assertStringIncludes(handoversTable, "UNIQUE NULLS NOT DISTINCT (lineage_id, from_politician_id, from_election_id, to_politician_id, to_election_id)");
  assertStringIncludes(handoversTable, "from_politician_id <> to_politician_id OR from_election_id IS DISTINCT FROM to_election_id");
  assertStringIncludes(linksTable, "UNIQUE (upper_lineage_id, lower_lineage_id)");
  assertStringIncludes(sql, "policies ADD COLUMN IF NOT EXISTS lineage_id UUID REFERENCES lineages(id) ON DELETE SET NULL");
});

Deno.test("交接對到任期表（#345）：任期編號由觸發器照人物＋那一屆填、剛好一列才填；任期表那支 migration 排在前面", async () => {
  assertStringIncludes(handoversTable, "from_office_id     BIGINT REFERENCES politician_offices(id) ON DELETE SET NULL");
  assertStringIncludes(handoversTable, "to_office_id       BIGINT REFERENCES politician_offices(id) ON DELETE SET NULL");
  const fn = between(sql, "CREATE OR REPLACE FUNCTION handover_office_of", "$$;");
  assertStringIncludes(fn, "CASE WHEN count(*) = 1 THEN min(o.id) END", "對到不只一列要留空，不能隨便挑一列");
  assertStringIncludes(fn, "p_election_id IS NOT NULL", "那一屆不在資料庫（2018 以前）就沒有任期可對");
  assertStringIncludes(sql, "BEFORE INSERT OR UPDATE OF from_politician_id, from_election_id, to_politician_id, to_election_id ON handovers");
  const offices = await migrationWith("CREATE TABLE IF NOT EXISTS politician_offices (");
  assert(offices.name < MIG, `任期表（${offices.name}）要比 ${MIG} 早建，外鍵才指得到`);
});

Deno.test("四張表公開讀、只有 service_role 寫；出處同步寫不進去就讓落庫失敗（不吞錯）", () => {
  for (const t of ["lineages", "lineage_participants", "handovers", "lineage_links", "lineage_candidate_reviews"]) {
    assertStringIncludes(sql, `CREATE POLICY "Public read" ON ${t} FOR SELECT USING (true)`);
    assertStringIncludes(sql, `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
  }
  const check = sql.match(/ADD CONSTRAINT source_refs_target_table_check\s+CHECK \(target_table IN \(([^)]+)\)\)/)![1];
  for (const t of ["policies", "tracking_logs", "policy_elements", "lineage_participants", "handovers", "lineage_links"]) assertStringIncludes(check, `'${t}'`);
  const sync = between(sql, "CREATE OR REPLACE FUNCTION lineage_rows_sync_source", "$$;");
  assert(!/EXCEPTION WHEN OTHERS/.test(sync), "角色、交接、關聯的出處是資料的一部分：寫不進去要讓落庫失敗、自動重試");
  assertStringIncludes(sync, "RAISE EXCEPTION");
  for (const t of ["lineage_participants", "handovers", "lineage_links"]) {
    assertStringIncludes(sql, `AFTER INSERT OR UPDATE OF source_url ON ${t}`);
    assertStringIncludes(sql, `AFTER DELETE ON ${t}`);
  }
});

Deno.test("資料走流程：migration 不寫任何一條脈絡；唯一的回填是 status 字面就是競選承諾的 origin", () => {
  for (const t of ["lineages", "lineage_participants", "handovers", "lineage_links", "lineage_candidate_reviews"]) {
    assert(!new RegExp(`INSERT INTO ${t}\\b`, "i").test(sql), `${MIG} 不可以直接寫 ${t}——要派任務、驗證後上線`);
  }
  assert(!/UPDATE policies SET lineage_id/i.test(sql), "政見歸入脈絡只能走 lineage 貢獻");
  const updates = [...sql.matchAll(/^UPDATE (\w+) SET (.+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
  assertEquals(updates, ["policies origin = 'pledge' WHERE origin IS NULL AND status::TEXT = 'Campaign Pledge';"], "回填只有這一條機械對應");
});

Deno.test("policies_with_logs 重建：前面的 p.*、logs、related_policy_ids、elements 跟 #364 那一版一字不差，lineage 接在最後，security_invoker 再設一次", async () => {
  const prev = (await Deno.readTextFile(new URL("20261005005640_policy_elements.sql", MIGRATIONS))).replace(/\r/g, "");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const oldCols = norm(between(prev, "CREATE OR REPLACE VIEW policies_with_logs AS", "FROM policies p;")).replace("CREATE OR REPLACE VIEW policies_with_logs AS", "").trim();
  const newBody = norm(between(sql, "CREATE VIEW policies_with_logs AS", "FROM policies p;")).replace("CREATE VIEW policies_with_logs AS", "").trim();
  assert(newBody.startsWith(`${oldCols}, (SELECT json_build_object('id', l.id`), "原本的欄位原樣保留，lineage 接在 elements 後面");
  assert(/AS elements,\s*\(SELECT json_build_object[\s\S]*AS lineage\s*FROM policies p;/.test(sql), "lineage 要是最後一欄");
  assertStringIncludes(sql, "DROP VIEW IF EXISTS policies_with_logs;");
  const after = sql.slice(sql.indexOf("CREATE VIEW policies_with_logs"));
  assert(/ALTER VIEW policies_with_logs SET \(security_invoker = on\)/.test(after), "重建後要再設 security_invoker，不然繞過 RLS");
  assertStringIncludes(after, "GRANT SELECT ON policies_with_logs TO anon, authenticated");
  assertStringIncludes(sql, "ALTER VIEW lineages_full SET (security_invoker = on)");
});

// ── 2. 「中止」交接要兩台機器（不動計分）──────────────────────────────────────

Deno.test("中止交接要兩台機器：TS needsTwoIps 跟 SQL contribution_needs_two_ips 同一條規則", () => {
  const fn = between(sql, "CREATE OR REPLACE FUNCTION contribution_needs_two_ips", "$$;");
  const list = fn.match(/p_type IN \(([^)]+)\)/)![1];
  assertEquals(quoted(list), [...SCORE_TWO_IP_TYPES], "既有的三種型別原樣保留");
  assertStringIncludes(fn, "p_type = 'lineage_handover' AND COALESCE(p_payload->>'handover_type', '') = 'stop'");
  assertEquals([...HANDOVER_TWO_IP_TYPES], ["stop"]);
  for (const t of SCORE_TWO_IP_TYPES) assert(needsTwoIps(t, {}), `${t} 照舊要兩台機器`);
  assert(needsTwoIps("lineage_handover", { handover_type: "stop" }), "中止要兩台機器");
  for (const t of ["keep", "pivot", "shrink", "resume"]) assert(!needsTwoIps("lineage_handover", { handover_type: t }), `${t} 走一般規則`);
  for (const t of ["lineage", "lineage_participants", "lineage_link", "policy"]) assert(!needsTwoIps(t, {}), `${t} 不用兩台機器`);
});

Deno.test("中止交接：分數到了但只有一台機器 → 還在等；兩台 → 上線。接手一台就上線（目標分數一樣是 3）", () => {
  const base = { target: 3, current: "pending", contributionType: "lineage_handover" };
  assertEquals(scoreStatus({ ...base, score: 3, distinctIps: 1, payload: { handover_type: "stop" } }), "pending");
  assertEquals(scoreStatus({ ...base, score: 3, distinctIps: 2, payload: { handover_type: "stop" } }), "verified");
  assertEquals(scoreStatus({ ...base, score: 3, distinctIps: 1, payload: { handover_type: "keep" } }), "verified");
  for (const t of ["lineage", "lineage_participants", "lineage_handover", "lineage_link"]) {
    assertEquals(riskLevel(t, { handover_type: "stop" }), "normal", `${t} 門檻照一般資料，不動計分`);
  }
});

Deno.test("計票、驗證池、佇列預覽三支都改看 contribution_needs_two_ips（漏一支：分數到了卻卡在池外，或一台機器就上線）", () => {
  const consensus = between(sql, "CREATE OR REPLACE FUNCTION contribution_apply_consensus", "$$;");
  assertStringIncludes(consensus, "NOT contribution_needs_two_ips(v_type, v_payload) OR v_ips >= 2 OR contribution_roster_matched(p_contribution_id)");
  assertStringIncludes(consensus, "SELECT status, contribution_type, payload INTO v_status, v_type, v_payload");
  const pool = between(sql, "CREATE OR REPLACE FUNCTION contribution_verify_pool", "$$;");
  assertEquals(pool.split("contribution_needs_two_ips(c.contribution_type, c.payload)").length - 1, 2, "驗證池兩處（還差一票的目標、可派條件）");
  const preview = between(sql, "CREATE OR REPLACE FUNCTION queue_preview", "$$;");
  assertStringIncludes(preview, "contribution_needs_two_ips(v.contribution_type, v.payload) AND v.voter_ips < 2");
  for (const body of [consensus, pool, preview]) {
    assert(!body.includes("IN ('merge_politician', 'candidacy', 'removal')"), "型別清單只留在 contribution_needs_two_ips 一處");
  }
  // 分數、目標、退件門檻都沒動
  assertStringIncludes(consensus, "v_target := COALESCE(contribution_effective_agree(p_contribution_id), 2);");
  assertStringIncludes(consensus, "v_reject := contribution_reject_floor(v_type);");
  assert(!/FUNCTION contribution_required_agree|FUNCTION contribution_effective_agree|FUNCTION contribution_vote_weight|FUNCTION contribution_reject_floor/.test(sql), "不動計分函式");
});

// ── 3. 交件守門 ──────────────────────────────────────────────────────────────

Deno.test("建脈絡：新脈絡帶兩條政見、note、地方對得上就收", () => {
  const r = submit("lineage", { new_lineage: { title: "台中捷運藍線", category: "交通建設", level: "county", region: "台中市" }, policy_ids: [P1, P2], note: NOTE });
  assertEquals(r.errors, []);
  const nat = submit("lineage", { new_lineage: { title: "國定假日法制化", category: "青年與勞工", level: "national" }, policy_ids: [P1], note: NOTE });
  assertEquals(nat.errors, [], "中央層級的法案一條政見就能建（其他人是共同提案或連署）");
});

Deno.test("建脈絡：lineage_id 與 new_lineage 二擇一；新脈絡縣市層級至少兩條政見；地方跟層級要對得上", () => {
  assert(paths(submit("lineage", { lineage_id: L1, new_lineage: { title: "台中捷運藍線", category: "交通建設", level: "county", region: "台中市" }, policy_ids: [P1, P2], note: NOTE })).includes("payload.lineage_id"));
  assert(paths(submit("lineage", { policy_ids: [P1, P2], note: NOTE })).includes("payload.lineage_id"));
  assert(paths(submit("lineage", { new_lineage: { title: "台中捷運藍線", category: "交通建設", level: "county", region: "台中市" }, policy_ids: [P1], note: NOTE })).includes("payload.policy_ids"), "只有一條政見不建縣市脈絡");
  assert(paths(submit("lineage", { new_lineage: { title: "台中捷運藍線", category: "交通建設", level: "county", region: "台中市", sub_region: "北屯區" }, policy_ids: [P1, P2], note: NOTE })).includes("payload.new_lineage.sub_region"));
  assert(paths(submit("lineage", { new_lineage: { title: "大雅公園", category: "體育休閒", level: "township", region: "台中市" }, policy_ids: [P1, P2], note: NOTE })).includes("payload.new_lineage.sub_region"));
  assert(paths(submit("lineage", { new_lineage: { title: "國定假日法制化", category: "青年與勞工", level: "national", region: "台北市" }, policy_ids: [P1], note: NOTE })).includes("payload.new_lineage.region"));
  assert(paths(submit("lineage", { new_lineage: { title: "台中捷運藍線", category: "捷運", level: "county", region: "台中市" }, policy_ids: [P1, P2], note: NOTE })).includes("payload.new_lineage.category"));
  assert(paths(submit("lineage", { new_lineage: { title: "藍線", category: "交通建設", level: "county", region: "台中市" }, policy_ids: [P1, P2], note: NOTE })).includes("payload.new_lineage.title"), "標題太短");
  assert(paths(submit("lineage", { new_lineage: { title: "台中捷運藍線", category: "交通建設", level: "county", region: "台中市" }, policy_ids: [P1, P2], note: "同一件事" })).includes("payload.note"), "note 要講得出依據");
});

Deno.test("歸入既有脈絡：要有動作；同一條政見不能同時歸入又拿掉；id 不能重複", () => {
  assertEquals(submit("lineage", { lineage_id: L1, policy_ids: [P3], note: NOTE }).errors, []);
  assertEquals(submit("lineage", { lineage_id: L1, title: "台中捷運藍線第一階段", note: NOTE }).errors, [], "只更正標題也算一個動作");
  assert(paths(submit("lineage", { lineage_id: L1, note: NOTE })).includes("payload.policy_ids"));
  assert(paths(submit("lineage", { lineage_id: L1, policy_ids: [P1], detach_policy_ids: [P1], note: NOTE })).includes("payload.detach_policy_ids"));
  assert(paths(submit("lineage", { lineage_id: L1, policy_ids: [P1, P1], note: NOTE })).includes("payload.policy_ids"));
});

Deno.test("標角色：官方紀錄要官方網址——新聞轉述、本人官網都不是官方紀錄", () => {
  const ok = submit("lineage_participants", { lineage_id: L1, participants: [{ politician_id: A, role: "co_proposer", basis: "official_record", source_locator: "議案 1234 關係文書" }] }, [LY]);
  assertEquals(ok.errors, []);
  const media = submit("lineage_participants", { lineage_id: L1, participants: [{ politician_id: A, role: "proposer", basis: "official_record", source_locator: "報導第二段" }] }, [CNA]);
  assert(media.errors.some((e) => e.message.includes("官方紀錄") && e.message.includes("self_claim")), "新聞不是官方紀錄，要改標本人宣稱");
  const claim = submit("lineage_participants", { lineage_id: L1, participants: [{ politician_id: A, role: "proposer", basis: "self_claim", source_locator: "答辯書第 3 頁" }] }, [CNA]);
  assertEquals(claim.errors, [], "本人宣稱可以附報導或本人官網");
  const own = submit("lineage_participants", { lineage_id: L1, participants: [{ politician_id: A, role: "co_proposer", basis: "official_record", source_locator: "議案", source_url: CNA }] }, [LY, CNA]);
  assert(own.errors.some((e) => e.path === "payload.participants[0].source_url"), "每一項看它自己的出處，不是整筆有一個官方網址就算");
  const unlisted = submit("lineage_participants", { lineage_id: L1, participants: [{ politician_id: A, role: "co_proposer", basis: "official_record", source_locator: "議案", source_url: "https://www.tccc.gov.tw/bill/9" }] }, [LY]);
  assert(unlisted.errors.some((e) => e.path === "payload.participants[0].source_url" && e.message.includes("source_urls")), "每一項的出處要是這筆 source_urls 之一（驗證者只會打開 source_urls）");
});

Deno.test("臉書、IG 讀不到不收：角色（含本人宣稱）與交接的出處都擋", () => {
  assert(isUnreadableSocial(FB) && isUnreadableSocial("https://m.facebook.com/x") && isUnreadableSocial("https://www.instagram.com/p/1") && isUnreadableSocial("https://www.threads.net/@x"));
  assert(!isUnreadableSocial(CNA) && !isUnreadableSocial("https://www.youtube.com/watch?v=1"));
  const claim = submit("lineage_participants", { lineage_id: L1, participants: [{ politician_id: A, role: "proposer", basis: "self_claim", source_locator: "貼文" }] }, [FB]);
  assert(claim.errors.some((e) => e.message.includes("臉書")), "本人在臉書說的也不收");
  const handover = submit("lineage_handover", { lineage_id: L1, from_politician_id: A, to_politician_id: B, handover_type: "keep", note: "後任在施政報告說延續前任的藍線綜合規劃。", source_locator: "貼文" }, [FB, CNA]);
  assert(handover.errors.some((e) => e.message.includes("臉書")), "交接的主要出處不能是臉書");
  assert(isOfficialUrl(LY) && isOfficialUrl("https://www.tccc.gov.tw/x") && !isOfficialUrl(CNA));
});

Deno.test("標角色：同一人同一種依據只能一項；拿掉不用填角色；角色、依據要在值域裡", () => {
  const dup = submit("lineage_participants", { lineage_id: L1, participants: [
    { politician_id: A, role: "proposer", basis: "official_record", source_locator: "議案" },
    { politician_id: A, role: "cosigner", basis: "official_record", source_locator: "議案" },
  ] }, [LY]);
  assert(dup.errors.some((e) => e.path === "payload.participants[1].politician_id"));
  assertEquals(submit("lineage_participants", { lineage_id: L1, participants: [{ politician_id: A, basis: "official_record", remove: true, source_locator: "議案名單沒有他" }] }, [LY]).errors, []);
  const bad = submit("lineage_participants", { lineage_id: L1, participants: [{ politician_id: A, role: "leader", basis: "news", source_locator: "x" }] }, [LY]);
  assert(paths(bad).includes("payload.participants[0].role") && paths(bad).includes("payload.participants[0].basis"));
});

Deno.test("記交接：同一人同一屆不是交接；型態要在值域；判定日期不能是未來；媒體不能當唯一出處", () => {
  const ok = submit("lineage_handover", { lineage_id: L1, from_politician_id: A, from_election_id: 2022, to_politician_id: B, to_election_id: 2026, handover_type: "stop", decided_on: "2026-01-15", note: "市府 2026 年度預算刪除藍線綜合規劃經費，議會決議停止。", source_locator: "議事錄 2026-01-15" }, ["https://www.tccc.gov.tw/minutes/1"]);
  assertEquals(ok.errors, []);
  assert(paths(submit("lineage_handover", { lineage_id: L1, from_politician_id: A, to_politician_id: A, handover_type: "keep", note: "同一人同一屆的兩筆紀錄，不是交接。", source_locator: "x" })).includes("payload.to_politician_id"));
  assertEquals(submit("lineage_handover", { lineage_id: L1, from_politician_id: A, from_election_id: 2022, to_politician_id: A, to_election_id: 2026, handover_type: "keep", note: "同一人連任，施政報告寫延續上一任的計畫。", source_locator: "施政報告第 3 頁" }).errors, [], "同一人連任的不同屆可以");
  assert(paths(submit("lineage_handover", { lineage_id: L1, from_politician_id: A, to_politician_id: B, handover_type: "cancel", note: "後任把這件事取消了，見市府新聞稿。", source_locator: "x" })).includes("payload.handover_type"));
  assert(paths(submit("lineage_handover", { lineage_id: L1, from_politician_id: A, to_politician_id: B, handover_type: "stop", decided_on: "2999-01-01", note: "後任宣布停止，見市府新聞稿第一段。", source_locator: "x" })).includes("payload.decided_on"));
  assert(soleSourceProblem(0, "lineage_handover", [CNA]) !== null, "只有一篇報導不收");
  assertEquals(soleSourceProblem(0, "lineage_handover", [CNA, LTN]), null, "兩個不同網站就收");
});

Deno.test("記關聯：上下級不能是同一條；型態要在值域；層級要是上一層（中央 → 縣市、縣市 → 同縣市的鄉鎮）", () => {
  assertEquals(submit("lineage_link", { upper_lineage_id: L1, lower_lineage_id: L2, link_type: "top_down", note: "中央前瞻軌道補助核定藍線第一階段，市府執行。", source_locator: "核定公文" }).errors, []);
  assert(paths(submit("lineage_link", { upper_lineage_id: L1, lower_lineage_id: L1, link_type: "top_down", note: "中央前瞻軌道補助核定藍線第一階段，市府執行。", source_locator: "x" })).includes("payload.lower_lineage_id"));
  assert(paths(submit("lineage_link", { upper_lineage_id: L1, lower_lineage_id: L2, link_type: "sideways", note: "中央前瞻軌道補助核定藍線第一階段，市府執行。", source_locator: "x" })).includes("payload.link_type"));
  assertEquals(linkLevelProblem({ level: "national" }, { level: "county", region: "台中市" }), null);
  assertEquals(linkLevelProblem({ level: "national" }, { level: "township", region: "台中市", sub_region: "大雅區" }), null);
  assertEquals(linkLevelProblem({ level: "county", region: "臺中市" }, { level: "township", region: "台中市" }), null, "台／臺 兩種寫法算同一個縣市");
  assert(linkLevelProblem({ level: "county", region: "台北市" }, { level: "township", region: "台中市" }) !== null);
  assert(linkLevelProblem({ level: "county", region: "台中市" }, { level: "county", region: "台中市" }) !== null);
  assert(linkLevelProblem({ level: "county", region: "台中市" }, { level: "national" }) !== null, "方向反了");
});

Deno.test("政見來源 origin：交件與更正都只收四個值", () => {
  const policy = (origin: unknown) => submit("policy", { politician_id: A, title: "台中捷運藍線", description: "推動台中捷運藍線綜合規劃，2030 年前動工。", category: "交通建設", origin });
  assertEquals(policy("assembly").errors, []);
  assert(paths(policy("campaign")).includes("payload.origin"));
  const fix = (v: unknown) => submit("correction", { target_table: "policies", target_id: P1, changes: [{ field: "origin", current_value: null, correct_value: v }], reason: "這條是議會提案，不是競選承諾。" });
  assertEquals(fix("budget").errors, []);
  assert(fix("pledged").errors.length > 0);
});

// ── 4. 落庫 ──────────────────────────────────────────────────────────────────

function row(type: string, payload: Obj, sourceUrls: string[] = [BULLETIN], taskId: string | null = null) {
  return { id: "99999999-0000-4000-8000-000000000001", contribution_type: type as never, payload, source_urls: sourceUrls, note: null, agent_name: "tester", contributor_url: null, task_id: taskId };
}
const REGIONS = [
  { id: 1, region: "台中市", sub_region: null, village: null, admin_code: "66000" },
  { id: 2, region: "台中市", sub_region: "大雅區", village: null, admin_code: "66000180" },
  { id: 3, region: "台中市", sub_region: "第01選舉區", village: null, admin_code: null },
];
const POLICIES = [
  { id: P1, title: "推動捷運藍線", removed_at: null, lineage_id: null },
  { id: P2, title: "藍線延伸到大坑", removed_at: null, lineage_id: null },
  { id: P3, title: "興建大雅運動中心", removed_at: null, lineage_id: L2 },
];
const BLOCK_TASK = "auto:lineage_candidate:0123456789ab:89abcdef";

Deno.test("落庫：建新脈絡——地方照網站寫法、補上官方代碼；政見掛上去；每一步記履歷；候選格記為看過", async () => {
  const fake = createFakeSupabase({ regions: REGIONS, policies: structuredClone(POLICIES), lineages: [], edit_history: [], lineage_candidate_reviews: [] });
  const out = await applyContribution(fake.client, row("lineage", {
    new_lineage: { title: "台中捷運藍線", category: "交通建設", level: "county", region: "臺中市", summary: "台中捷運第二條路線" },
    policy_ids: [P1, P2], note: NOTE,
  }, [BULLETIN], BLOCK_TASK));
  assertEquals(out.status, "applied", out.message);
  const lineage = fake.db.lineages[0];
  assertEquals([lineage.region, lineage.sub_region, lineage.admin_code, lineage.level], ["台中市", null, "66000", "county"]);
  assertEquals(fake.db.policies.filter((p) => p.lineage_id === lineage.id).length, 2);
  const hist = fake.db.edit_history;
  assert(hist.some((e) => e.table_name === "lineages" && e.field === "*"), "新脈絡整列記下（還原時刪掉）");
  assertEquals(hist.filter((e) => e.table_name === "policies" && e.field === "lineage_id").map((e) => e.old_value), [null, null], "政見的舊值記下（還原時倒回 NULL）");
  assertEquals(fake.db.lineage_candidate_reviews.map((r) => [r.review_key, r.fingerprint]), [["block:0123456789ab", "89abcdef"]]);
  assert(hist.some((e) => e.table_name === "lineage_candidate_reviews" && e.record_id === fake.db.lineage_candidate_reviews[0].id), "清查結論的履歷要記那一列的 id（executeRevert 用 id 刪）");
});

Deno.test("落庫：鄉鎮層級的脈絡對到那個鄉鎮的 8 碼代碼", async () => {
  const fake = createFakeSupabase({ regions: REGIONS, policies: structuredClone(POLICIES), lineages: [], edit_history: [] });
  const out = await applyContribution(fake.client, row("lineage", {
    new_lineage: { title: "大雅區公所運動中心", category: "體育休閒", level: "township", region: "台中市", sub_region: "大雅區" },
    policy_ids: [P1, P2], note: NOTE,
  }));
  assertEquals(out.status, "applied", out.message);
  const l = fake.db.lineages[0];
  assertEquals([l.level, l.region, l.sub_region, l.admin_code], ["township", "台中市", "大雅區", "66000180"]);
});

Deno.test("落庫：地方對不到內政部行政區（例如選舉區、拼錯的鄉鎮）→ failed，不建脈絡", async () => {
  const fake = createFakeSupabase({ regions: REGIONS, policies: structuredClone(POLICIES), lineages: [], edit_history: [] });
  const out = await applyContribution(fake.client, row("lineage", {
    new_lineage: { title: "大雅區公園", category: "體育休閒", level: "township", region: "台中市", sub_region: "第01選舉區" },
    policy_ids: [P1, P2], note: NOTE,
  }));
  assertEquals(out.status, "failed");
  assertEquals(fake.db.lineages.length, 0);
});

Deno.test("落庫：一條政見只屬於一條脈絡——已經在別條的不歸入（要先 detach），整筆不寫", async () => {
  const fake = createFakeSupabase({ regions: REGIONS, policies: structuredClone(POLICIES), lineages: [{ id: L1, title: "台中捷運藍線", level: "county", region: "台中市" }, { id: L2, title: "大雅運動中心", level: "township" }], edit_history: [] });
  const out = await applyContribution(fake.client, row("lineage", { lineage_id: L1, policy_ids: [P1, P3], note: NOTE }));
  assertEquals(out.status, "failed");
  assertStringIncludes(out.message, "detach_policy_ids");
  assertEquals(fake.db.policies.find((p) => p.id === P1)!.lineage_id, null, "一條擋下就整筆不寫");
  assertEquals(fake.db.edit_history.length, 0);
});

Deno.test("落庫：歸入、拿掉、更正標題；一樣的就 superseded（不寫假的履歷）", async () => {
  const pols = structuredClone(POLICIES);
  pols[0].lineage_id = L1 as never;
  const fake = createFakeSupabase({ regions: REGIONS, policies: pols, lineages: [{ id: L1, title: "藍線", summary: null, category: "交通建設", level: "county", region: "台中市" }], edit_history: [] });
  const out = await applyContribution(fake.client, row("lineage", { lineage_id: L1, policy_ids: [P2], detach_policy_ids: [P1], title: "台中捷運藍線", note: NOTE }));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.policies.find((p) => p.id === P2)!.lineage_id, L1);
  assertEquals(fake.db.policies.find((p) => p.id === P1)!.lineage_id, null);
  assertEquals(fake.db.lineages[0].title, "台中捷運藍線");
  assertEquals(fake.db.edit_history.find((e) => e.table_name === "lineages")!.old_value, "藍線");
  const again = await applyContribution(fake.client, row("lineage", { lineage_id: L1, policy_ids: [P2], title: "台中捷運藍線", note: NOTE }));
  assertEquals(again.status, "superseded");
  assertEquals(fake.db.edit_history.length, 3);
});

Deno.test("落庫：同一個地方已有同名的脈絡 → 不另建，叫代理歸入那一條", async () => {
  const fake = createFakeSupabase({ regions: REGIONS, policies: structuredClone(POLICIES), lineages: [{ id: L1, title: "台中捷運藍線", level: "county", region: "台中市", admin_code: "66000" }], edit_history: [] });
  const out = await applyContribution(fake.client, row("lineage", { new_lineage: { title: "台中捷運藍線", category: "交通建設", level: "county", region: "台中市" }, policy_ids: [P1, P2], note: NOTE }));
  assertEquals(out.status, "failed");
  assertStringIncludes(out.message, L1);
  assertEquals(fake.db.lineages.length, 1);
});

Deno.test("落庫：角色新增、改角色只記變了的欄位、拿掉整列記下可還原；被合併的人改指保留的那位", async () => {
  const fake = createFakeSupabase({
    lineages: [{ id: L1, title: "國定假日法制化" }],
    politicians: [{ id: A, name: "甲", merged_into: null }, { id: B, name: "乙（舊）", merged_into: C }, { id: C, name: "乙", merged_into: null }],
    lineage_participants: [{ id: "lp-1", lineage_id: L1, politician_id: A, role: "proposer", basis: "self_claim", source_url: CNA, source_locator: "答辯書", note: null }],
    edit_history: [],
  });
  const out = await applyContribution(fake.client, row("lineage_participants", { lineage_id: L1, participants: [
    { politician_id: A, role: "co_proposer", basis: "official_record", source_locator: "議案 1234" },
    { politician_id: B, role: "cosigner", basis: "official_record", source_locator: "議案 1234 連署名單" },
  ] }, [LY]));
  assertEquals(out.status, "applied", out.message);
  const rows = fake.db.lineage_participants;
  assertEquals(rows.length, 3, "甲的本人宣稱留著、官方紀錄另一列");
  assert(rows.some((r) => r.politician_id === C && r.role === "cosigner"), "被合併的人改指保留的那位");
  assert(rows.some((r) => r.politician_id === A && r.basis === "self_claim" && r.role === "proposer"), "本人宣稱跟官方紀錄並列，不互相蓋掉");

  const fix = await applyContribution(fake.client, row("lineage_participants", { lineage_id: L1, participants: [{ politician_id: A, role: "proposer", basis: "self_claim", source_locator: "答辯書第 2 頁" }] }, [CNA]));
  assertEquals(fix.status, "applied", fix.message);
  assertEquals(fake.db.edit_history.filter((e) => e.record_id === "lp-1").map((e) => e.field), ["source_locator"], "只記變了的那一欄");

  const drop = await applyContribution(fake.client, row("lineage_participants", { lineage_id: L1, participants: [{ politician_id: A, basis: "self_claim", remove: true, source_locator: "答辯書沒有" }] }, [CNA]));
  assertEquals(drop.status, "applied", drop.message);
  assertEquals(fake.db.lineage_participants.filter((r) => r.politician_id === A).length, 1);
  const removed = fake.db.edit_history.find((e) => e.record_id === "lp-1" && e.field === "*")!;
  assertEquals((removed.old_value as Obj).role, "proposer", "拿掉的整列記在 old_value：還原時放回去");
  assertEquals(removed.new_value, null);
});

Deno.test("落庫：交接新增；重交改型態＝覆蓋並記履歷；一樣的 superseded", async () => {
  const fake = createFakeSupabase({ lineages: [{ id: L1, title: "台中捷運藍線" }], politicians: [{ id: A, name: "甲", merged_into: null }, { id: B, name: "乙", merged_into: null }], handovers: [], edit_history: [] });
  const payload = { lineage_id: L1, from_politician_id: A, from_election_id: 2022, to_politician_id: B, to_election_id: 2026, handover_type: "keep", note: "後任在施政報告說延續前任的藍線綜合規劃。", source_locator: "施政報告第 3 頁" };
  const first = await applyContribution(fake.client, row("lineage_handover", payload));
  assertEquals(first.status, "applied", first.message);
  assertEquals(fake.db.handovers.length, 1);
  const second = await applyContribution(fake.client, row("lineage_handover", { ...payload, handover_type: "shrink", note: "後任只做第一階段，預算從 1,000 億縮到 600 億。" }));
  assertEquals(second.status, "applied", second.message);
  assertEquals(fake.db.handovers.length, 1, "同一對任期只有一筆");
  assertEquals(fake.db.handovers[0].handover_type, "shrink");
  assertEquals(fake.db.edit_history.filter((e) => e.table_name === "handovers" && e.field !== "*").map((e) => e.field).sort(), ["handover_type", "note"]);
  const third = await applyContribution(fake.client, row("lineage_handover", { ...payload, handover_type: "shrink", note: "後任只做第一階段，預算從 1,000 億縮到 600 億。" }));
  assertEquals(third.status, "superseded");
});

Deno.test("落庫：上下級層級不對 → failed；對的新增並記候選清查", async () => {
  const lineages = [
    { id: L1, title: "前瞻軌道建設", level: "national", region: null, sub_region: null },
    { id: L2, title: "台中捷運藍線", level: "county", region: "台中市", sub_region: null },
  ];
  const fake = createFakeSupabase({ lineages, lineage_links: [], edit_history: [], lineage_candidate_reviews: [] });
  const wrong = await applyContribution(fake.client, row("lineage_link", { upper_lineage_id: L2, lower_lineage_id: L1, link_type: "top_down", note: "中央前瞻軌道補助核定藍線第一階段，市府執行。", source_locator: "x" }));
  assertEquals(wrong.status, "failed");
  const ok = await applyContribution(fake.client, row("lineage_link", { upper_lineage_id: L1, lower_lineage_id: L2, link_type: "top_down", note: "中央前瞻軌道補助核定藍線第一階段，市府執行。", source_locator: "核定公文" },
    [BULLETIN], `auto:lineage_link_candidate:${L2}:0a1b2c3d`));
  assertEquals(ok.status, "applied", ok.message);
  assertEquals(fake.db.lineage_links.length, 1);
  assertEquals(fake.db.lineage_candidate_reviews.map((r) => r.review_key), [`link:${L2}`]);
});

Deno.test("無異動：候選格 confirmed 才記結論（清單沒變就不再派）；查無或打不開不鎖", async () => {
  const noChange = (outcome: string) => row("no_change", { task_id: BLOCK_TASK, outcome, finding: "逐組比對過這一格的政見，都是不同的標的。", checked_urls: [BULLETIN] });
  const fake = createFakeSupabase({ task_checks: [], edit_history: [], lineage_candidate_reviews: [] });
  const confirmed = await applyContribution(fake.client, noChange("confirmed"));
  assertEquals(confirmed.status, "applied");
  assertEquals(fake.db.lineage_candidate_reviews.length, 1);
  const other = createFakeSupabase({ task_checks: [], edit_history: [], lineage_candidate_reviews: [] });
  await applyContribution(other.client, noChange("not_found"));
  assertEquals(other.db.lineage_candidate_reviews.length, 0, "沒有真的比對完不鎖");
  assertEquals(parseCandidateTaskId("auto:lineage_candidate:0123456789AB:89ABCDEF")?.review_key, "block:0123456789ab");
  assertEquals(parseCandidateTaskId("auto:handover_missing:x:y"), null);
});

Deno.test("交件前置檢查：脈絡不存在、政見已在別條、地方對不到、上下級層級反了，都當場講", async () => {
  const fake = createFakeSupabase({
    regions: REGIONS,
    policies: structuredClone(POLICIES),
    lineages: [{ id: L1, title: "前瞻軌道建設", level: "national", region: null, sub_region: null }, { id: L2, title: "大雅運動中心", level: "township", region: "台中市", sub_region: "大雅區" }],
  });
  const items = [
    { contribution_type: "lineage", payload: { lineage_id: "33333333-0000-4000-8000-0000000000cc", policy_ids: [P1] } },
    { contribution_type: "lineage", payload: { lineage_id: L1, policy_ids: [P3] } },
    { contribution_type: "lineage", payload: { new_lineage: { level: "township", region: "台中市", sub_region: "不存在區" }, policy_ids: [P1, P2] } },
    { contribution_type: "lineage_link", payload: { upper_lineage_id: L2, lower_lineage_id: L1 } },
  ];
  const problems = await precheckApplyTargets(fake.client, items, new Set());
  assertEquals(problems.map((p) => [p.index, p.code]), [[0, "target_not_found"], [1, "apply_would_fail"], [2, "target_not_found"], [3, "apply_would_fail"]]);
});

// ── 5. 派工臂 ─────────────────────────────────────────────────────────────────

const scope = between(sql, "CREATE OR REPLACE FUNCTION lineage_candidate_scope()", "COMMENT ON FUNCTION lineage_candidate_scope");
const blockArm = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_lineage_candidates()", "COMMENT ON FUNCTION contribution_auto_tasks_lineage_candidates");
const handoverArm = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_handover_missing()", "COMMENT ON FUNCTION contribution_auto_tasks_handover_missing");
const rolesArm = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_lineage_roles()", "COMMENT ON FUNCTION contribution_auto_tasks_lineage_roles");
const linkArm = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_lineage_links()", "COMMENT ON FUNCTION contribution_auto_tasks_lineage_links");
const armsFn = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()", "COMMENT ON FUNCTION contribution_auto_tasks_arms");

Deno.test("派工臂：四支都接進 contribution_auto_tasks_arms，任務型別都登記了（TS 清單、建議回報型別、中文名）", async () => {
  for (const arm of ["lineage_candidates", "handover_missing", "lineage_roles", "lineage_links"]) {
    assertStringIncludes(armsFn, `FROM contribution_auto_tasks_${arm}()`);
  }
  // 前一版（#364）的每一行 UNION 都要原樣留著：region-gap.test 只比函式名稱，CTE（due）那一行它看不到
  const prev = (await Deno.readTextFile(new URL("20261005005640_policy_elements.sql", MIGRATIONS))).replace(/\r/g, "");
  const prevArms = between(prev, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()", "COMMENT ON FUNCTION contribution_auto_tasks_arms");
  for (const line of prevArms.split("\n").filter((l) => l.trim().startsWith("UNION ALL"))) {
    assertStringIncludes(armsFn, line.trim(), `前一版的「${line.trim()}」不見了`);
  }
  const want: Record<string, string> = { lineage_candidate: "lineage", handover_missing: "lineage_handover", lineage_roles_missing: "lineage_participants", lineage_link_candidate: "lineage_link" };
  const labels = await Deno.readTextFile(new URL("../../../lib/task-labels.ts", import.meta.url));
  for (const [task, contribution] of Object.entries(want)) {
    assert((TASK_TYPES as readonly string[]).includes(task), `TASK_TYPES 少了 ${task}`);
    assertEquals(SUGGESTED_TYPE[task], contribution);
    assert((CONTRIBUTION_TYPES as readonly string[]).includes(contribution));
    assert(new RegExp(`\\b${task}:\\s*'`).test(labels), `task-labels 少了 ${task}`);
    assert(TASK_GUIDANCE[task] && TASK_GUIDANCE[task].length >= 40, `${task} 要有做法`);
    assert(PAYLOAD_SHAPE[contribution], `${contribution} 要有 payload 形狀`);
  }
  assert(SINGLE_ANSWER_TASK_TYPES.has("handover_missing"), "一對前後任一個來源 IP 一份");
});

Deno.test("候選格的範圍：還沒投票看在選者、已投票看當選者；地區只來自參選紀錄（不借人物表的地區）", () => {
  assertStringIncludes(scope, "(e.election_date >= CURRENT_DATE AND x.candidate_status NOT IN ('not_running', 'withdrawn'))");
  assertStringIncludes(scope, "(e.election_date < CURRENT_DATE AND x.election_result = 'elected')");
  assertStringIncludes(scope, "replace(r.region, '臺', '台') AS county");
  assert(!/COALESCE\(r\.region, p\.region\)/.test(scope), "不可以借人物表的地區（10-05 裁決：假選區就是這樣來的）");
  assertStringIncludes(scope, "s.election_type IN ('總統副總統', '立法委員')");
  assertStringIncludes(scope, "pl.removed_at IS NULL");
});

Deno.test("候選格：指紋只看政見本身（不看歸入了哪條脈絡）；查過的清單、等票中的不派；跨人或跨屆才派", () => {
  const fp = blockArm.split("\n").find((l) => /\) AS fp,\s*$/.test(l));
  assert(fp && fp.includes("string_agg(s.policy_id::TEXT || ':' || s.content_md5"), "找不到指紋");
  assert(!/lineage_id/.test(fp!), "指紋不能含 lineage_id：交了脈絡之後同一份清單不該再派");
  assertStringIncludes(blockArm, "b.terms >= 2 AND b.loose >= 1");
  assertStringIncludes(blockArm, "rv.review_key = 'block:' || b.block_key AND rv.fingerprint = b.fp");
  assertStringIncludes(blockArm, "c.contribution_type = 'lineage' AND c.status IN ('pending', 'verified', 'apply_failed')");
  assert(!/'policy_id', b\./.test(blockArm) && !/jsonb_build_object\(\s*'policy_id'/.test(blockArm.slice(blockArm.indexOf("SELECT 'auto:lineage_candidate:'"))), "target 頂層不放 policy_id：租約會跟那條政見的其他任務撞在一起");
});

Deno.test("交接臂：只看首長、前任已卸任、換了人才派；已有交接或等票中的不派", () => {
  assertStringIncludes(handoverArm, "pe.election_type IN ('縣市長', '鄉鎮市長', '直轄市山地原住民區長')");
  assertStringIncludes(handoverArm, "x.from_term_end < CURRENT_DATE");
  assertStringIncludes(handoverArm, "s.to_id <> s.from_id");
  assertStringIncludes(handoverArm, "h.lineage_id = s.lineage_id AND h.from_politician_id = s.from_id AND h.to_politician_id = s.to_id");
  assertStringIncludes(handoverArm, "c.contribution_type = 'lineage_handover' AND c.status IN ('pending', 'verified', 'apply_failed')");
  assertStringIncludes(handoverArm, "office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, pe.election_type)");
});

Deno.test("角色臂：只問當過民意代表（投票日已過、當選）的人；已經有角色或等票中的不派。上下級臂：上一層、同類別、查過就不派", () => {
  assertStringIncludes(rolesArm, "pe.election_result = 'elected' AND e.election_date < CURRENT_DATE");
  assertStringIncludes(rolesArm, "pe.election_type IN ('立法委員', '縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表')");
  assertStringIncludes(rolesArm, "NOT EXISTS (SELECT 1 FROM lineage_participants lp WHERE lp.lineage_id = pl.lineage_id AND lp.politician_id = p.id)");
  assertStringIncludes(linkArm, "up.category = lo.category");
  assertStringIncludes(linkArm, "(lo.level = 'county' AND up.level = 'national')");
  assertStringIncludes(linkArm, "rv.review_key = 'link:' || g.lower_id AND rv.fingerprint = g.fp");
});

// ── 6. 送給代理的說明 ────────────────────────────────────────────────────────

Deno.test("任務現況：候選格給整份政見（說明開頭）與既有脈絡；骨架先填好層級、地方、類別", () => {
  const target = { level: "county", region: "台中市", category: "交通建設", policies: [{ policy_id: P1 }], existing_lineages: [{ lineage_id: L1, title: "台中捷運藍線" }] };
  const cur = shapeTaskCurrent("lineage_candidate", {
    lineage_policies: [{ id: P1, title: "推動捷運藍線", description: "很長的說明".repeat(80), politicians: { name: "甲" } }],
    related_lineages: [{ id: L1, title: "台中捷運藍線", participants: [], handovers: [], links: [], policy_ids: [P2] }],
  }, { task_id: BLOCK_TASK, target });
  const pols = cur.policies as Obj[];
  assertEquals(pols[0].name, "甲");
  assert(String(pols[0].description).length <= 201, "說明只取開頭");
  assertEquals((cur.existing_lineages as Obj[])[0].lineage_id, L1);
  assertStringIncludes(String(cur.hint), "同一件事");
  const tpl = buildReportTemplate("lineage_candidate", "lineage", target, BLOCK_TASK)!;
  const nl = (tpl.payload as Obj).new_lineage as Obj;
  assertEquals([nl.level, nl.region, nl.category], ["county", "台中市", "交通建設"]);
  assertEquals(tpl.task_id, BLOCK_TASK);
});

Deno.test("驗證說明：四種都講得出核什麼、投什麼；中止明講「後任沒提不算」", () => {
  for (const t of ["lineage", "lineage_participants", "lineage_handover", "lineage_link"]) {
    const hint = String(shapeVerifyCurrent(t, {}, {}).hint ?? "");
    assertEquals(hint, LINEAGE_VERIFY_HINT[t]);
    assert(/agree/.test(hint) && /disagree/.test(hint) && /unsure/.test(hint), `${t} 要講三種票`);
  }
  assertStringIncludes(LINEAGE_VERIFY_HINT.lineage_handover, "後任政見裡沒提就判中止");
  assertStringIncludes(LINEAGE_VERIFY_HINT.lineage_participants, "新聞轉述不是官方紀錄");
});

Deno.test("協議（skill.md）講了四種型別、中止要兩台機器、官方紀錄要官方網址、臉書不收", async () => {
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  for (const t of ["lineage", "lineage_participants", "lineage_handover", "lineage_link"]) assertStringIncludes(skill, `**\`${t}\`**（1.52.0）`);
  assertStringIncludes(skill, "`handover_type=stop` 的 `lineage_handover`（1.52.0）另外要求分數來自**至少 2 個不同來源 IP**");
  assertStringIncludes(skill, "出處**一定要是官方網址**");
  assertStringIncludes(skill, "**臉書、IG、Threads 讀不到，不收**");
  assertStringIncludes(skill, "**後任的政見清單裡沒有這件事，不等於中止**");
});
