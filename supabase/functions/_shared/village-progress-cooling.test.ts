/**
 * 村里長不主動追進度、有人看才追、查無公開進度冷卻遞增、政見標「查無公開進度」（#470，migration 20261009010000_village_chief_progress_cooling.sql）。
 *
 * 維護者 10-08 裁示四點，守門分三半，只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）：
 *
 *   A. 文字層（不開資料庫）
 *      1. 這支是 activity_open、contribution_auto_tasks_arms、refresh_dispatch_blocked、視圖 policies_with_logs 的最後一版，緊接在前一版後面
 *      2. 三支函式的新定義＝前一版的現行定義＋固定幾處機械式替換；視圖只在最後多一欄；沒碰臂本體、seed、rebalance、優先層
 *      3. 天數、人數、型別名單只在設定表（task_cooldown_settings）；函式與視圖裡沒有寫死的天數
 *      4. 前端只讀視圖多出來的那一欄、只放標籤「查無公開進度」、不放說明文字
 *   B. PGlite（行為層）：真的 P0／P1／優先層／P2×3／手動任務臂／流量提層／這支；多輪 seed
 *      村里長進度關窗（職位未知的不關、別的臂不受影響）、流量開窗（人物頁／政見頁、門檻、退了收回、過期、停用）、
 *      冷卻 14→30（第幾次照時間排、只數 not_found、其他型別與 outcome 不變、設定是資料）、與舊定義的 parity、標籤出現與消失
 *   C. 每條守門都做還原驗證：把 migration 改壞一處（精確改一處，改不到就失敗），對應的守門必須紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyContribution, PROGRESS_REPEAT_COOLDOWN_DAYS, TASK_CHECK_COOLDOWN_DAYS } from "./apply-contribution.ts";
import { applyP2, buildArmsDb, fnText, type GapRow, latestFn, migrationNames, mutate, P0_MIG, P2_ER_MIG, P2_PG_MIG, P2_PR_MIG, readMig } from "./arms-pglite.ts";

const MIG = "20261009010000_village_chief_progress_cooling.sql";
const MAN_MIG = "20261008165000_manual_tasks_as_arm.sql";
const TRAFFIC_MIG = "20261008190000_page_traffic_boost.sql";
const QP_MIG = "20261008090000_queue_priority_tiers.sql";
const RDB_MIG = "20261002000006_queue_pop_head.sql";
const VIEW_MIG = "20261007150000_sources_stage2b_drop_legacy.sql";
const MIG_SQL = await readMig(MIG);
const MAN_SQL = await readMig(MAN_MIG);
const QP_SQL = await readMig(QP_MIG);
const TRAFFIC_SQL = await readMig(TRAFFIC_MIG);
const P0_SQL = await readMig(P0_MIG);
const RDB_SQL = await readMig(RDB_MIG);
const VIEW_SQL = await readMig(VIEW_MIG);

// ============================================================
// A. 文字層
// ============================================================
const OLD_OPEN = fnText(P0_SQL, "activity_open");
const NEW_OPEN = fnText(MIG_SQL, "activity_open");
const OLD_ARMS = fnText(MAN_SQL, "contribution_auto_tasks_arms");
const NEW_ARMS = fnText(MIG_SQL, "contribution_auto_tasks_arms");
const OLD_RDB = fnText(RDB_SQL, "refresh_dispatch_blocked");
const NEW_RDB = fnText(MIG_SQL, "refresh_dispatch_blocked");
const once = (s: string, from: string, to: string) => mutate(s, from, to);

/** 機械式替換（遷移檔與守門各寫一遍：守門把「前一版」套同樣的替換，必須等於遷移檔的新定義） */
const OPEN_FROM = "       AND (r.election_types IS NULL OR p_election_type = ANY (r.election_types))\n";
const OPEN_TO = OPEN_FROM + "       AND (r.except_election_types IS NULL OR p_election_type IS NULL OR NOT (p_election_type = ANY (r.except_election_types)))  -- 排除職位：職位未知（NULL）時不排除，寧可開著也不無聲關掉\n";
const mechanicalOpen = (old: string) => once(old, OPEN_FROM, OPEN_TO);
const RDB_FROM = "    WHERE tc.checked_at > now() - (\n      CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days'\n    )::INTERVAL\n";
const RDB_TO = "    WHERE tc.checked_at > now() - (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL\n" +
  "    -- 比任何一種冷卻都長的歷史紀錄不用逐筆問天數（task_checks 只會越積越多；agy 審查 #480）：上限是一個 InitPlan，只算一次\n" +
  "      AND tc.checked_at > now() - make_interval(days => (SELECT task_cooldown_max_days()))\n";
const mechanicalRdb = (old: string) => once(old, RDB_FROM, RDB_TO);

/** 總表三處：keyed（職位補查）、opened（帶出 requires_traffic）、列層（流量條件）。標記區塊起訖：>>> 村里長進度、>>> 流量開窗 */
const KEYED_FROM = "       keyed AS (\n  SELECT g.*, election_id_or_null(g.target->>'election_id') AS eid, NULLIF(g.target->>'election_type', '') AS etype FROM tagged g\n       ),\n";
const OPENED_FROM = "  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on, o.open_until\n";
const FINAL_FROM = "'expected_open_on', o.expected_open_on, 'open_until', o.open_until)) END AS opened_by\n    FROM keyed g\n    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')\n   WHERE (o.source IS NOT NULL OR (SELECT current_setting('gap.arms_all', true) = 'on'))";
const MARK_A = /       -- >>> 村里長進度[^\n]*\n[\s\S]*?       -- <<< 村里長進度\n/;
const MARK_B = /    -- >>> 流量開窗[^\n]*\n[\s\S]*?    -- <<< 流量開窗\n/;
/** 把新總表還原成前一版：拿掉標記區塊、換回三處原文。還原得回來＝新定義只是前一版加這幾處 */
function revertArms(fn: string): string {
  let s = fn;
  s = s.replace(MARK_A, "");
  s = s.replace(MARK_B, "");
  // keyed：從 "keyed AS (" 到它的 "),\n"
  const k = s.indexOf("       keyed AS (\n");
  const kEnd = s.indexOf("       ),\n", k) + "       ),\n".length;
  s = s.slice(0, k) + KEYED_FROM + s.slice(kEnd);
  s = once(s, ",\n         COALESCE((SELECT r.requires_traffic FROM activity_rules r WHERE r.id = o.rule_id), false) AS requires_traffic  -- 這條規則要不要「該列的人物頁或政見頁在 page_traffic_hot」才算開\n", "\n");
  s = once(s, "         CASE WHEN w.ok THEN jsonb_strip_nulls(jsonb_build_object(\n", "         CASE WHEN o.source IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(\n");
  s = once(s, "'open_until', o.open_until,\n           'traffic_gate', CASE WHEN o.requires_traffic THEN true END)) END AS opened_by\n    FROM keyed g\n    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')\n   WHERE (w.ok OR (SELECT current_setting('gap.arms_all', true) = 'on'))",
    "'open_until', o.open_until)) END AS opened_by\n    FROM keyed g\n    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')\n   WHERE (o.source IS NOT NULL OR (SELECT current_setting('gap.arms_all', true) = 'on'))");
  return s;
}
const isMechanicalArms = (fn: string) => {
  try {
    return (fn.match(MARK_A) ?? []).length === 1 && (fn.match(MARK_B) ?? []).length === 1 && revertArms(fn) === OLD_ARMS;
  } catch {
    return false;
  }
};
const bodyOf = (fn: string) => fn.slice(fn.indexOf("$$\n") + 3, fn.lastIndexOf("$$;"));
const codeOf = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").replace(/'(?:[^']|'')*'/g, "''");
const numerals = (sql: string) => (codeOf(sql).replace(/\bid = 1\b/g, "").replace(/SELECT 1\b/g, "").replace(/\[1\]/g, "").match(/(?<![A-Za-z_])\d+(?![A-Za-z_])/g) ?? []).filter((n) => n !== "0");

const definers = async (needle: string | RegExp) => {
  const out: string[] = [];
  for (const n of await migrationNames()) {
    const sql = await readMig(n);
    if (typeof needle === "string" ? sql.includes(needle) : needle.test(sql)) out.push(n);
  }
  return out;
};

Deno.test("A1 這支是 activity_open、總表、refresh_dispatch_blocked、policies_with_logs 的最後一版，緊接著前一版；沒有重新定義臂本體、seed、rebalance、優先層", async () => {
  const last = async (needle: string | RegExp, prev: string, after: string[] = []) => {
    const d = await definers(needle);
    const i = d.indexOf(MIG);
    assert(i > 0, `${needle} 要在重新定義它的清單裡`);
    assertEquals(d[i - 1], prev, `${needle} 的前一版應該是 ${prev}；有人在中間改了，要以那一版為底重做機械式替換`);
    assertEquals(d.slice(i + 1), after, `${needle} 在這支之後又被重新定義：要以最新那版為底重做`);
  };
  await last("CREATE OR REPLACE FUNCTION activity_open(", P0_MIG);
  await last("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms(", MAN_MIG);
  await last("CREATE OR REPLACE FUNCTION refresh_dispatch_blocked(", RDB_MIG);
  // #349 第二階段 B（20261009220000）刪 related_policies 時 DROP＋CREATE 了這個視圖（只拿掉 related_policy_ids），是唯一允許排在後面的一版
  await last(/CREATE (OR REPLACE )?VIEW policies_with_logs AS/, VIEW_MIG, ["20261009220000_drop_related_policies.sql"]);
  const code = codeOf(MIG_SQL);
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.)?([a-z_]+)\(/g)].map((m) => m[1]);
  assertEquals(defined, ["activity_open", "contribution_auto_tasks_arms", "task_check_cooldown_days_for", "task_cooldown_max_days", "refresh_dispatch_blocked", "policy_no_public_progress"]);
  for (const untouched of ["seed_auto_task_queue", "rebalance_queue", "activity_priority", "contribution_auto_tasks_raw", "contribution_auto_tasks_deadline_due", "contribution_auto_tasks_term_policies", "task_dispatched", "queue_slot", "traffic_boost_apply", "activity_require_rule"]) {
    assert(!code.includes(`FUNCTION ${untouched}(`), `這支不改 ${untouched}`);
  }
  assert(!/DROP FUNCTION|DROP COLUMN|DROP TABLE|DROP VIEW/.test(code), "只加不刪");
  assert(!/(UPDATE|INSERT INTO|DELETE FROM)\s+(politicians|policies|politician_elections|contributions|task_checks|election_milestones|activity_overrides)\b/i.test(code), "不寫任何正式資料表、里程碑、覆寫（refresh_dispatch_blocked 本來就更新派工列的 blocked／cooling 欄，那是它的現行本體）");
});

Deno.test("A2 三支函式的新定義＝前一版的現行定義＋固定幾處機械式替換；總表只多兩個標記區塊與三處換字", () => {
  assertEquals(NEW_OPEN, mechanicalOpen(OLD_OPEN));
  assertEquals(NEW_RDB, mechanicalRdb(OLD_RDB));
  assert(isMechanicalArms(NEW_ARMS));
  // 回傳型別、簽名一個字沒動（同簽名，不用分兩次上）
  for (const [a, b] of [[OLD_OPEN, NEW_OPEN], [OLD_ARMS, NEW_ARMS], [OLD_RDB, NEW_RDB]]) assertEquals(a.slice(0, a.indexOf("$$\n")), b.slice(0, b.indexOf("$$\n")));
  // 只加欄位：視圖前面的欄位來源一字不差（20261007150000 的現行視圖＋最後一欄）
  const viewOld = VIEW_SQL.slice(VIEW_SQL.indexOf("CREATE VIEW policies_with_logs AS"), VIEW_SQL.indexOf("ALTER VIEW policies_with_logs"));
  const viewNew = MIG_SQL.slice(MIG_SQL.indexOf("CREATE OR REPLACE VIEW policies_with_logs AS"), MIG_SQL.indexOf("ALTER VIEW policies_with_logs"));
  assertEquals(viewNew.replace("CREATE OR REPLACE VIEW", "CREATE VIEW").replace("  source_brief_list('policies', p.id::text) AS sources,\n  policy_no_public_progress(p.id) AS no_public_progress\n", "  source_brief_list('policies', p.id::text) AS sources\n"), viewOld);
});

Deno.test("A3 還原驗證（文字層）：偷改前一版的內容、少一個區塊、多一行，A2 都要紅", () => {
  assert(!isMechanicalArms(mutate(NEW_ARMS, "COALESCE(o.eid, -1) = COALESCE(g.eid, -1)", "COALESCE(o.eid, -1) <> COALESCE(g.eid, -1)")), "偷改 join");
  assert(!isMechanicalArms(mutate(NEW_ARMS, "    -- <<< 流量開窗\n", "")), "結束標記掉了");
  assert(!isMechanicalArms(NEW_ARMS.replace("       -- <<< 村里長進度\n", "       -- <<< 村里長進度\n       , dummy AS (SELECT 1)\n")), "區塊外多一段");
  assert(!isMechanicalArms(OLD_ARMS), "舊版本身不是新的");
  assert(mechanicalOpen(OLD_OPEN) !== OLD_OPEN && mechanicalRdb(OLD_RDB) !== OLD_RDB);
  assert(NEW_OPEN !== mutate(mechanicalOpen(OLD_OPEN), "p_election_type IS NULL OR NOT", "NOT"), "職位未知時的排除寫法被改壞");
});

Deno.test("A4 參數只在設定表：天數函式、標籤函式、視圖新欄位沒有寫死的天數；初值只在 CREATE TABLE", () => {
  const fn1 = fnText(MIG_SQL, "task_check_cooldown_days_for");
  const fn2 = fnText(MIG_SQL, "policy_no_public_progress");
  // 兩個 2 都不是可調的天數：split_part(task_id, ':', 2)＝任務型別在 task_id 的第二段、`>= 2`＝「第二次起」遞增的定義
  assertEquals(numerals(bodyOf(fn1)), ["2", "2"]);
  assertEquals(numerals(bodyOf(fn2)), []);
  assertEquals(numerals(bodyOf(NEW_RDB)), numerals(bodyOf(OLD_RDB)), "refresh_dispatch_blocked 沒有多出新的數字常數");
  const t = MIG_SQL.slice(MIG_SQL.indexOf("CREATE TABLE IF NOT EXISTS task_cooldown_settings"), MIG_SQL.indexOf("COMMENT ON TABLE task_cooldown_settings"));
  for (const frag of ["not_found_first_days  INTEGER NOT NULL DEFAULT 14", "not_found_repeat_days INTEGER NOT NULL DEFAULT 30", "task_types            TEXT[] NOT NULL DEFAULT ARRAY['progress_stale', 'deadline_due']"]) {
    assert(t.includes(frag), `設定表的初值：${frag}`);
  }
  for (const col of ["s.not_found_first_days", "s.not_found_repeat_days", "s.task_types", "s.enabled"]) assert(fn1.includes(col), `task_check_cooldown_days_for 要讀 ${col}`);
  assert(fn2.includes("s.task_types") && fn2.includes("task_check_cooldown_days_for("), "標籤函式讀型別名單、天數問同一支函式");
  // 單一真相：refresh_dispatch_blocked 與標籤用同一支天數函式
  assert(NEW_RDB.includes("task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id)"));
});

Deno.test("A5 還原驗證（文字層）：把天數寫死回函式，A4 的數字檢查要紅", () => {
  const fn1 = fnText(MIG_SQL, "task_check_cooldown_days_for");
  assert(numerals(bodyOf(mutate(fn1, "THEN s.not_found_repeat_days ELSE s.not_found_first_days END", "THEN 30 ELSE 14 END"))).length > 2);
  const fn2 = fnText(MIG_SQL, "policy_no_public_progress");
  assert(numerals(bodyOf(mutate(fn2, "task_check_cooldown_days_for(c.task_id, c.outcome, c.checked_at, c.id) || ' days'", "14 || ' days'"))).length > 0);
});

Deno.test("A6 寫入與權限：設定表開 RLS、公開唯讀、只有 service_role 寫、有審計與 updated_at；標籤函式與天數函式公開可呼叫（視圖是 security_invoker，匿名要讀得到）", () => {
  const code = codeOf(MIG_SQL);
  assert(code.includes("ALTER TABLE task_cooldown_settings ENABLE ROW LEVEL SECURITY;"));
  assert(MIG_SQL.includes('CREATE POLICY "Public read" ON task_cooldown_settings FOR SELECT USING (true);'));
  assert(MIG_SQL.includes(`CREATE POLICY "Service role write" ON task_cooldown_settings FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');`));
  assert(code.includes("trg_task_cooldown_settings_audit AFTER INSERT OR UPDATE OR DELETE ON task_cooldown_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();"));
  assert(code.includes("trg_task_cooldown_settings_touch BEFORE UPDATE ON task_cooldown_settings FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();"));
  assert(!/REVOKE[^;]*policy_no_public_progress|REVOKE[^;]*task_check_cooldown_days_for/i.test(code), "視圖讀得到這兩支函式");
  assert(code.includes("ALTER VIEW policies_with_logs SET (security_invoker = on);") && code.includes("GRANT SELECT ON policies_with_logs TO anon, authenticated;"));
});

const readSrc = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url)).then((s) => s.replace(/\r\n/g, "\n"));

Deno.test("A7 前端只讀視圖多出來的那一欄、只放標籤「查無公開進度」、不放說明文字；型別對得上", async () => {
  const types = await readSrc("../../../types.ts");
  assert(/no_public_progress\?:\s*boolean/.test(types) && /noPublicProgress\?:\s*boolean/.test(types));
  const map = await readSrc("../../../composables/useSupabase.ts");
  assert(map.includes("row.no_public_progress"), "mapPolicy 讀視圖欄位");
  for (const f of ["../../../pages/PolicyDetail.vue", "../../../components/PolicyCard.vue"]) {
    const src = await readSrc(f);
    assert(src.includes("noPublicProgress"), `${f} 讀 policy.noPublicProgress`);
    // 標籤文字出現在元素裡、而且那個元素只有這四個字
    const m = [...src.matchAll(/>\s*查無公開進度\s*</g)];
    assert(m.length >= 1, `${f} 有「查無公開進度」標籤`);
    assert(!/查無公開進度[^<\n]{1,}</.test(src.replace(/>\s*查無公開進度\s*</g, "><")), `${f} 不在標籤旁放說明文字`);
  }
  // 不另外查清單：前端沒有為了這個標籤去查 task_checks／task_dispatches／task_cooldown_settings
  for (const f of ["../../../pages/PolicyDetail.vue", "../../../components/PolicyCard.vue", "../../../pages/PoliticianProfile.vue", "../../../composables/useSupabase.ts"]) {
    assert(!/task_checks|task_dispatches|task_cooldown_settings/.test(await readSrc(f)), `${f} 不另外查冷卻清單`);
  }
});

Deno.test("A8 協議：skill.md 版號 1.80.0（#482 的 1.79.0 先合併）、說明村里長與遞增冷卻；CLAUDE.md、計畫第 11 節、DECISIONS 一起更新", async () => {
  const skill = await readSrc("../../../public/skill.md");
  // 1.80.0 起才有這段說明；之後的版本（例如 1.81.0 的派工憑證）只升不降，所以看「不低於 1.80.0」，不釘死等號
  const ver = /\*\*版本\*\*：(\d+)\.(\d+)\.(\d+)/.exec(skill);
  assert(ver && (Number(ver[1]) > 1 || Number(ver[2]) >= 80), "協議版號不低於 1.80.0");
  assert(skill.includes("term_policy_missing") && skill.includes("村里長不主動派"), "skill.md 寫了補該屆政見對村里長先停");
  assert(skill.includes("第二次起 30 天") && skill.includes("村里長"), "skill.md 寫了遞增冷卻與村里長");
  const claude = await readSrc("../../../CLAUDE.md");
  assert(claude.includes("task_cooldown_settings") && claude.includes("policy_no_public_progress") && claude.includes("except_election_types"));
  const plan = await readSrc("../../../docs/PLAN-task-activation.md");
  assert(plan.includes("20261009010000") && plan.includes("village-progress-cooling.test.ts"));
  const decisions = await readSrc("../../../docs/DECISIONS.md");
  assert(decisions.includes("村里長不主動追進度") && decisions.includes("20261009010000"));
});

Deno.test("A9 回給代理的那句話：進度追蹤類查無說明遞增冷卻，別的任務型別維持一律 14 天；TS 的天數與設定表初值同一個數字", async () => {
  assertEquals(TASK_CHECK_COOLDOWN_DAYS, Number(/not_found_first_days\s+INTEGER NOT NULL DEFAULT (\d+)/.exec(MIG_SQL)![1]));
  assertEquals(PROGRESS_REPEAT_COOLDOWN_DAYS, Number(/not_found_repeat_days INTEGER NOT NULL DEFAULT (\d+)/.exec(MIG_SQL)![1]));
  // TS 寫死的型別清單（apply-contribution.ts 的 PROGRESS_COOLDOWN_TASK_TYPES）要跟設定表的初值同一份
  const tsTypes = [...(/PROGRESS_COOLDOWN_TASK_TYPES = \[([^\]]*)\]/.exec(await readSrc("./apply-contribution.ts"))![1].matchAll(/"([a-z_]+)"/g))].map((m) => m[1]);
  const sqlTypes = [...(/task_types\s+TEXT\[\] NOT NULL DEFAULT ARRAY\[([^\]]+)\]/.exec(MIG_SQL)![1].matchAll(/'([a-z_]+)'/g))].map((m) => m[1]);
  assertEquals(tsTypes, sqlTypes);
  assert(!tsTypes.includes("term_policy_missing"), "term_policy_missing 不適用遞增冷卻（維持 14 天）");
  assert(!/auto:\(progress_stale\|deadline_due\)/.test(await readSrc("./apply-contribution.ts")), "型別名單只寫在常數裡，不在程式中間再寫一份正規式");
  const inserted: Array<Record<string, unknown>> = [];
  const fake = {
    from: (_table: string) => ({
      update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
      insert: (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; },
    }),
  };
  const say = async (taskId: string, outcome: string) => (await applyContribution(fake, {
    id: "c-1", contribution_type: "no_change", source_urls: ["https://example.org/a"], note: null, agent_name: "tester", contributor_url: null,
    payload: { task_id: taskId, outcome, checked_urls: ["https://example.org/a"], finding: "已查過幾個來源，沒有公開進度。" },
  })).message;
  const POLICY_ID = "0c9c1a5e-1111-4222-8333-444444444444";
  for (const t of ["progress_stale", "deadline_due"]) {
    const m = await say(`auto:${t}:${POLICY_ID}`, "not_found");
    assert(m.includes("查無公開進度") && m.includes(String(TASK_CHECK_COOLDOWN_DAYS)) && m.includes(String(PROGRESS_REPEAT_COOLDOWN_DAYS)), m);
  }
  // 別的型別、別的 outcome：話沒變（不提 30 天）
  for (const [t, o] of [["policy_missing", "not_found"], ["progress_stale", "confirmed"], ["deadline_due", "unreachable"]] as const) {
    const m = await say(`auto:${t}:${POLICY_ID}`, o);
    assert(!m.includes(String(PROGRESS_REPEAT_COOLDOWN_DAYS)), m);
  }
  assert(inserted.some((r) => r.task_id === `auto:progress_stale:${POLICY_ID}` && r.outcome === "not_found"), "仍然記一筆 task_checks（outcome 照填）");
});

// ============================================================
// B. PGlite
// ============================================================
type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];

// 人物
const PM = "aaaaaaaa-0000-4000-8000-000000000001"; // 縣市長（2022）
const PV1 = "bbbbbbbb-0000-4000-8000-000000000001"; // 村里長（2022）
const PV2 = "bbbbbbbb-0000-4000-8000-000000000002"; // 村里長（2022）
const PV3 = "bbbbbbbb-0000-4000-8000-000000000003"; // 村里長（2022），但他的政見沒標屆別
const PN = "cccccccc-0000-4000-8000-000000000001"; // 政見標了 2022 屆，但他那一屆沒有參選紀錄
// 政見
const POL_M = "11111111-0000-4000-8000-000000000001"; // PM 的政見：progress_stale
const POL_M2 = "11111111-0000-4000-8000-000000000002"; // PM 的政見：deadline_due
const POL_V1A = "22222222-0000-4000-8000-000000000001"; // PV1：progress_stale
const POL_V1B = "22222222-0000-4000-8000-000000000002"; // PV1：progress_stale
const POL_V1C = "22222222-0000-4000-8000-000000000003"; // PV1：deadline_due
const POL_V2 = "22222222-0000-4000-8000-000000000004"; // PV2：progress_stale
const POL_V3 = "22222222-0000-4000-8000-000000000005"; // PV3：progress_stale，election_id 空
const POL_N = "33333333-0000-4000-8000-000000000001"; // PN：progress_stale，那一屆沒有參選紀錄
const ALL_POLICIES = [POL_M, POL_M2, POL_V1A, POL_V1B, POL_V1C, POL_V2, POL_V3, POL_N];

const G = (id: string, type: string, target: Record<string, unknown> | null): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h"], reward: 1, region: "台北市" });
const prog = (policy: string, politician: string, election: number | null) =>
  G(`progress_stale:${policy}`, "progress_stale", { policy_id: policy, policy_title: "t", politician_id: politician, name: "n", region: "r", election_id: election });
const due = (policy: string, politician: string, election: number | null) =>
  G(`deadline_due:${policy}`, "deadline_due", { policy_id: policy, policy_title: "t", politician_id: politician, name: "n", region: "r", election_id: election });

const FIXTURE = {
  raw: [
    prog(POL_M, PM, 2022), prog(POL_V1A, PV1, 2022), prog(POL_V1B, PV1, 2022), prog(POL_V2, PV2, 2022), prog(POL_V3, PV3, null), prog(POL_N, PN, 2022),
    // 村里長的「收政見」「補基本資料」仍然開著：維護者說村里長只收政見與結果
    G(`policy_missing:${PV1}`, "policy_missing", { politician_id: PV1, name: "n", election_id: 2026, election_type: "村里長" }),
    G(`profile_gap:${PV1}`, "profile_gap", { politician_id: PV1, name: "n", election_id: 2026 }),
  ],
  deadline_due: [due(POL_M2, PM, 2022), due(POL_V1C, PV1, 2022)],
  // 補該屆政見：村里長的先停（維護者追加），別的職位照派；target 自己帶 election_type
  term_policies: [
    G(`term_policy_missing:${PV1}:2022`, "term_policy_missing", { politician_id: PV1, name: "n", election_id: 2022, election_type: "村里長" }),
    G(`term_policy_missing:${PM}:2022`, "term_policy_missing", { politician_id: PM, name: "n", election_id: 2022, election_type: "縣市長" }),
  ],
  election_results: [G(`election_results_missing:v`, "election_results_missing", { election_id: 2022, election_type: "村里長" })],
};
const TERM_V = `term_policy_missing:${PV1}:2022`;
const TERM_M = `term_policy_missing:${PM}:2022`;
const PROG_ALL = [TERM_V, TERM_M, `progress_stale:${POL_M}`, `progress_stale:${POL_V1A}`, `progress_stale:${POL_V1B}`, `progress_stale:${POL_V2}`, `progress_stale:${POL_V3}`, `progress_stale:${POL_N}`, `deadline_due:${POL_M2}`, `deadline_due:${POL_V1C}`];
const OTHERS = [`policy_missing:${PV1}`, `profile_gap:${PV1}`, `election_results_missing:v`];
/** 村里長（職位查得到）的進度追蹤與補該屆政見：沒有流量時關著 */
const VILLAGE_PROG = [TERM_V, `progress_stale:${POL_V1A}`, `progress_stale:${POL_V1B}`, `progress_stale:${POL_V2}`, `deadline_due:${POL_V1C}`];
/** 職位不是村里長、或查不到職位的：照舊開著 */
const OPEN_PROG = PROG_ALL.filter((k) => !VILLAGE_PROG.includes(k));

const RESTUB = ["raw", "election_results", "party_gap", "party_roster", "ballot_numbers"] as const;

async function buildDb(mutateMig: (s: string) => string = (s) => s, applyMine = true): Promise<Db> {
  const pre = `
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL);
    CREATE TABLE policies (id uuid PRIMARY KEY, politician_id uuid NOT NULL);
    ${await latestFn("politician_name_is_placeholder")}
    ALTER TABLE elections ADD COLUMN bulletin_published_on date, ADD COLUMN bulletin_dir text;
    ALTER TABLE politicians ADD COLUMN region text, ADD COLUMN avatar_url text;
    ALTER TABLE politician_elections ADD COLUMN election_id integer, ADD COLUMN election_type text;
    ${await latestFn("roster_scope_milestone_date")}
    CREATE VIEW ballot_number_anomalies AS SELECT NULL::integer AS election_id, NULL::text AS election_type, NULL::text AS kind WHERE false;
    CREATE FUNCTION contribution_subject_politician(p jsonb) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::uuid $$;
    ${await latestFn("uuid_or_null")}
    UPDATE elections SET bulletin_published_on = DATE '2026-11-18' WHERE id = 2026;
    ALTER TABLE contributions ADD COLUMN contributor_ip_hash text, ADD COLUMN agent_name text, ADD COLUMN payload jsonb;
    CREATE TABLE contribution_task_leases (task_id text, target_key text, leased_until timestamptz, agent_name text);
    ${await latestFn("task_target_key")}
    DROP FUNCTION queue_slot(text);
    ${await latestFn("queue_slot")}
    ${await latestFn("contribution_auto_tasks")}
    ${await latestFn("contribution_auto_task_counts")}
    ${await latestFn("task_dispatched")}
    CREATE TABLE contribution_tasks (
      id uuid PRIMARY KEY, title text NOT NULL, description text, task_type text NOT NULL, target jsonb NOT NULL DEFAULT '{}'::jsonb, region text,
      priority integer NOT NULL DEFAULT 1, reward integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'open', source text NOT NULL DEFAULT 'manual',
      suggested_by text, hint_sources text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE citizen_questions (id uuid PRIMARY KEY, stance_up integer NOT NULL DEFAULT 0, answer_count integer NOT NULL DEFAULT 0);
    CREATE OR REPLACE FUNCTION contribution_queue_at(t text, k text, c timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT queue_slot('verify') $$;
    ${QP_SQL}
    -- 冷卻：task_checks 與兩支天數函式、前一版的 refresh_dispatch_blocked（取代 stub，這樣「前一版」是真的）
    CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), agent_name text, note text, contribution_id uuid, outcome text);
    CREATE INDEX task_checks_task_idx ON task_checks (task_id, checked_at DESC);
    ${await latestFn("task_check_cooldown_days")}
    ${await latestFn("task_unreachable_cooldown_days")}
    ${await latestFn("refresh_dispatch_blocked", MIG)}
    -- policies_with_logs 的前一版（#347 第二階段 B-2 的現行視圖）與它依賴的表：欄位照正式庫
    ALTER TABLE policies ADD COLUMN title text, ADD COLUMN description text, ADD COLUMN category text, ADD COLUMN status text, ADD COLUMN proposed_date date, ADD COLUMN last_updated date,
      ADD COLUMN progress integer, ADD COLUMN tags text[], ADD COLUMN ai_analysis text, ADD COLUMN support_count integer, ADD COLUMN election_id integer, ADD COLUMN ai_extracted boolean,
      ADD COLUMN ai_confidence numeric(3,2), ADD COLUMN removed_at timestamptz, ADD COLUMN removed_reason text, ADD COLUMN removed_by uuid, ADD COLUMN stance_support integer,
      ADD COLUMN stance_oppose integer, ADD COLUMN stance_priority integer, ADD COLUMN updated_at timestamptz, ADD COLUMN lineage_id uuid, ADD COLUMN origin text;
    CREATE TABLE tracking_logs (id bigserial PRIMARY KEY, date date, event text, description text, policy_id uuid, ai_extracted boolean);
    CREATE TABLE related_policies (policy_id uuid, related_policy_id uuid);
    CREATE TABLE policy_elements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), policy_id uuid, element text, stated boolean, text text, deadline_date date, source_locator text, source_url text, updated_at timestamptz);
    CREATE TABLE source_refs (target_table text, target_id text, source_id bigint, role text);
    ALTER TABLE sources ADD COLUMN title text, ADD COLUMN publisher text, ADD COLUMN source_kind text, ADD COLUMN archive_url text;
    CREATE TABLE lineages (id uuid PRIMARY KEY, title text, level text, region text, sub_region text, category text, summary text);
    CREATE FUNCTION source_brief_list(t text, i text) RETURNS json LANGUAGE sql STABLE AS $$ SELECT '[]'::json $$;
    ${VIEW_SQL.slice(VIEW_SQL.indexOf("CREATE VIEW policies_with_logs AS"), VIEW_SQL.indexOf("ALTER VIEW policies_with_logs"))};
    ALTER VIEW policies_with_logs SET (security_invoker = on);
    GRANT SELECT ON policies_with_logs TO anon, authenticated;`;
  const db = await buildArmsDb({
    branches: FIXTURE,
    extraBranches: ["ballot_numbers"],
    afterP1Sql: pre,
    p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }, { name: MAN_MIG }], restub: RESTUB },
  });
  await applyP2(db, TRAFFIC_SQL, RESTUB);
  await db.exec(`
    INSERT INTO politicians VALUES ('${PM}', '縣', NULL), ('${PV1}', '里一', NULL), ('${PV2}', '里二', NULL), ('${PV3}', '里三', NULL), ('${PN}', '無', NULL);
    INSERT INTO politician_elections (id, politician_id, election_id, election_type) VALUES (1, '${PM}', 2022, '縣市長'), (2, '${PV1}', 2022, '村里長'), (3, '${PV2}', 2022, '村里長'), (4, '${PV3}', 2022, '村里長'), (5, '${PV1}', 2026, '村里長');
    INSERT INTO policies (id, politician_id, title, status, election_id, progress) VALUES
      ('${POL_M}', '${PM}', '政見M', 'In Progress', 2022, 10), ('${POL_M2}', '${PM}', '政見M2', 'In Progress', 2022, 10),
      ('${POL_V1A}', '${PV1}', '政見V1A', 'In Progress', 2022, 10), ('${POL_V1B}', '${PV1}', '政見V1B', 'In Progress', 2022, 10), ('${POL_V1C}', '${PV1}', '政見V1C', 'In Progress', 2022, 10),
      ('${POL_V2}', '${PV2}', '政見V2', 'In Progress', 2022, 10), ('${POL_V3}', '${PV3}', '政見V3', 'In Progress', NULL, 10), ('${POL_N}', '${PN}', '政見N', 'In Progress', 2022, 10);
    SET app.activity_today = '2026-10-08';`);
  if (applyMine) await applyP2(db, mutateMig(MIG_SQL), RESTUB);
  return db;
}

const seed = (db: Db) => db.exec(`SELECT seed_auto_task_queue()`);
const armIds = async (db: Db) => new Set((await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_arms()`)).map((r) => r.task_id.replace(/^auto:/, "")));
const dispatchIds = async (db: Db) => new Set((await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id LIKE 'auto:%'`)).map((r) => r.task_id.replace(/^auto:/, "")));
const has = (s: Set<string>, ids: string[]) => ids.every((i) => s.has(i));
const none = (s: Set<string>, ids: string[]) => ids.every((i) => !s.has(i));
const traffic = (db: Db, rs: Array<{ kind: string; target_id: string; users: number }>, window = 7) =>
  db.query(`SELECT replace_page_traffic($1::jsonb, $2)`, [JSON.stringify(rs.map((r) => ({ views: r.users, ...r }))), window]);
const hotP = (id: string, users = 5) => ({ kind: "politician", target_id: id, users });
const hotPol = (id: string, users = 5) => ({ kind: "policy", target_id: id, users });
const check = (db: Db, taskId: string, outcome: string | null, daysAgo: number) =>
  db.query(`INSERT INTO task_checks (task_id, outcome, checked_at) VALUES ($1, $2, now() - ($3 || ' days')::interval)`, [`auto:${taskId}`, outcome, String(daysAgo)]);
const cooling = async (db: Db, taskId: string) => (await one<{ cooling: boolean } | undefined>(db, `SELECT cooling FROM task_dispatches WHERE task_id = $1`, [`auto:${taskId}`]))?.cooling;
const label = async (db: Db, policyId: string) => (await one<{ v: boolean }>(db, `SELECT no_public_progress AS v FROM policies_with_logs WHERE id = $1`, [policyId])).v;
const gapReason = async (db: Db, taskId: string) =>
  (await rows<{ reason: string }>(db, `SELECT reason FROM gap_events WHERE task_id = $1 AND event = 'closed' ORDER BY id DESC LIMIT 1`, [`auto:${taskId}`]))[0]?.reason;

type Verdicts = Record<string, boolean>;
async function guard(out: Verdicts, db: Db, name: string, f: () => Promise<boolean>) {
  await db.exec("BEGIN");
  try {
    out[name] = await f();
  } catch (e) {
    console.error(`[${name}]`, (e as Error).message);
    out[name] = false;
  } finally {
    try {
      await db.exec("ROLLBACK");
    } catch { /* 已經回滾 */ }
  }
}

const GUARDS = [
  "baseline_village_progress_closed", "baseline_others_open", "unknown_position_stays_open", "activity_open_exclusion", "exclusion_is_data", "other_arms_group_unchanged",
  "dispatch_recalled_window", "traffic_opens_person", "traffic_opens_policy", "traffic_threshold", "traffic_cools_recalled", "traffic_stale_closes", "traffic_disabled_closes",
  "traffic_opened_by", "traffic_opens_when_exclusion_disabled", "non_village_unaffected_by_traffic", "traffic_rule_is_data", "arms_all_flag_keeps_closed",
  "first_not_found_14", "second_not_found_30", "third_stays_30", "deadline_due_escalates", "per_task_ordinal", "other_types_flat_14", "only_not_found_counts",
  "unreachable_2_days_unchanged", "cooldown_settings_are_data", "cooldown_disabled_flat", "task_types_are_data", "cooling_parity_unaffected_types", "cooling_diff_only_repeat_progress", "cool_bound_covers_settings",
  "label_on_when_cooling", "label_off_after_first_cooldown", "label_30_on_second", "label_off_when_gap_gone", "label_only_not_found", "label_per_policy", "label_deadline_due",
  "label_follows_settings", "label_view_shape", "label_fn_public", "rule_constraints", "settings_audit_and_rls",
] as const;

async function runSuite(db: Db): Promise<Verdicts> {
  const v: Verdicts = {};
  const g = (name: string, f: () => Promise<boolean>) => guard(v, db, name, f);
  // 上線當下的世界：這支 migration 之前，村里長的進度缺口已經在派工列裡（前面的 migration 套用時回填過）；第一輪 seed 把它們收回。守門從這個狀態開始
  await seed(db);

  await g("baseline_village_progress_closed", async () => {
    const a = await armIds(db);
    await seed(db);
    const d = await dispatchIds(db);
    return none(a, VILLAGE_PROG) && none(d, VILLAGE_PROG) && has(a, OPEN_PROG) && has(d, OPEN_PROG);
  });

  await g("baseline_others_open", async () => {
    // 村里長的「補 2026 政見」「補基本資料」「選舉結果」：維持開著（補該屆政見 term_policy_missing 維護者追加後也先停，見 VILLAGE_PROG）
    await seed(db);
    return has(await armIds(db), OTHERS) && has(await dispatchIds(db), OTHERS);
  });

  await g("unknown_position_stays_open", async () => {
    // 政見沒標屆別（POL_V3，他其實是村里長）、他那一屆沒有參選紀錄（POL_N）：查不到職位，不排除、照舊開著
    const a = await armIds(db);
    return a.has(`progress_stale:${POL_V3}`) && a.has(`progress_stale:${POL_N}`);
  });

  await g("activity_open_exclusion", async () => {
    const q = (act: string, et: string | null) => rows<{ rule_id: number }>(db, `SELECT rule_id FROM activity_open($1, 2022, $2)`, [act, et]);
    const rules = await rows<{ id: number; activity: string; except_election_types: string[] | null; requires_traffic: boolean; election_types: string[] | null }>(db,
      `SELECT id, activity, except_election_types, requires_traffic, election_types FROM activity_rules WHERE activity IN ('raw:progress_stale', 'deadline_due', 'term_policies') ORDER BY id`);
    const excl = rules.filter((r) => r.except_election_types !== null);
    const gate = rules.filter((r) => r.requires_traffic);
    if (excl.length !== 3 || gate.length !== 3 || rules.length !== 6) return false;
    let ok = true;
    for (const act of ["raw:progress_stale", "deadline_due", "term_policies"]) {
      const ex = excl.find((r) => r.activity === act)!;
      const gt = gate.find((r) => r.activity === act)!;
      // 村里長：只有「要流量」那條開；縣市長與職位未知：只有「永遠開、排除村里長」那條開
      ok = ok && JSON.stringify((await q(act, "村里長")).map((r) => Number(r.rule_id))) === JSON.stringify([Number(gt.id)]);
      ok = ok && JSON.stringify((await q(act, "縣市長")).map((r) => Number(r.rule_id))) === JSON.stringify([Number(ex.id)]);
      ok = ok && JSON.stringify((await q(act, null)).map((r) => Number(r.rule_id))) === JSON.stringify([Number(ex.id)]);
      ok = ok && JSON.stringify(ex.except_election_types) === JSON.stringify(["村里長"]) && JSON.stringify(gt.election_types) === JSON.stringify(["村里長"]);
    }
    // P1 種子的 rule_id 沒變（原地更新）：兩條「排除」規則就是 P1 種的那兩條
    const p1 = await rows<{ id: number }>(db, `SELECT id FROM activity_rules WHERE activity IN ('raw:progress_stale', 'deadline_due', 'term_policies') AND note LIKE '#470：永遠開%' ORDER BY id`);
    return ok && p1.length === 3 && p1.every((r) => Number(r.id) <= 40);
  });

  await g("exclusion_is_data", async () => {
    // 規則是資料：停用兩條排除規則，村里長的進度追蹤又開了（不用改任何函式）
    await db.exec(`UPDATE activity_rules SET except_election_types = NULL WHERE activity IN ('raw:progress_stale', 'deadline_due', 'term_policies') AND except_election_types IS NOT NULL`);
    return has(await armIds(db), VILLAGE_PROG);
  });

  await g("other_arms_group_unchanged", async () => {
    // 職位補查只做在「有規則要看職位」的臂：別的臂（profile_gap 的 target 也有 politician_id、election_id，沒有 election_type）的分組不變、opened_by 沒有多出流量旗標。
    // 證據：給 profile_gap 在 2026 年村里長設一個「closed」覆寫。這個人在 2026 有村里長的參選紀錄——如果職位被補查，覆寫就會關掉他的 profile_gap；職位沒補查（target 沒有職位＝未知），覆寫比對不到，照舊開著
    await db.exec(`INSERT INTO activity_overrides (activity, election_id, election_type, "force", reason) VALUES ('raw:profile_gap', 2026, '村里長', 'closed', 'test')`);
    await db.exec(`SELECT set_config('gap.arms_all', 'on', true)`);
    const r = await rows<{ task_id: string; opened_by: Record<string, unknown> | null }>(db, `SELECT task_id, opened_by FROM contribution_auto_tasks_arms() WHERE task_id IN ('auto:profile_gap:${PV1}', 'auto:policy_missing:${PV1}')`);
    return r.length === 2 && r.every((x) => x.opened_by !== null && !("traffic_gate" in x.opened_by) && x.opened_by.basis === "rule");
  });

  await g("dispatch_recalled_window", async () => {
    // 已經在派工列裡的村里長進度缺口（這支上線之前派出去的）：下一輪 seed 收回，原因記 window（臂還算得出來、規則窗口關了）
    await db.exec(`UPDATE activity_rules SET except_election_types = NULL WHERE except_election_types IS NOT NULL`); // 先讓它們進派工列
    await seed(db);
    const had = has(await dispatchIds(db), VILLAGE_PROG);
    await db.exec(`UPDATE activity_rules SET except_election_types = ARRAY['村里長'] WHERE activity IN ('raw:progress_stale', 'deadline_due', 'term_policies') AND window_kind = 'always' AND election_types IS NULL`);
    await seed(db);
    const gone = none(await dispatchIds(db), VILLAGE_PROG);
    const reasons = await Promise.all(VILLAGE_PROG.map((k) => gapReason(db, k)));
    return had && gone && reasons.every((r) => r === "window") && has(await dispatchIds(db), OPEN_PROG);
  });

  await g("traffic_opens_person", async () => {
    await traffic(db, [hotP(PV1)]);
    await seed(db);
    const d = await dispatchIds(db);
    // PV1 的人物頁熱門：他名下的進度追蹤開（兩種活動都開）；PV2 不熱門、維持關
    return has(d, [TERM_V, `progress_stale:${POL_V1A}`, `progress_stale:${POL_V1B}`, `deadline_due:${POL_V1C}`]) && none(d, [`progress_stale:${POL_V2}`]) && has(d, OPEN_PROG);
  });

  await g("traffic_opens_policy", async () => {
    await traffic(db, [hotPol(POL_V2)]);
    await seed(db);
    const d = await dispatchIds(db);
    // 政見頁熱門：只開這一條，同一個人的其他政見、其他人都不動
    return d.has(`progress_stale:${POL_V2}`) && none(d, [`progress_stale:${POL_V1A}`, `progress_stale:${POL_V1B}`, `deadline_due:${POL_V1C}`]);
  });

  await g("traffic_threshold", async () => {
    await traffic(db, [hotP(PV1, 4)]); // 門檻 5（traffic_boost_settings）：差一人不開
    await seed(db);
    const below = none(await dispatchIds(db), VILLAGE_PROG);
    await traffic(db, [hotP(PV1, 5)]);
    await seed(db);
    return below && has(await dispatchIds(db), [`progress_stale:${POL_V1A}`]);
  });

  await g("traffic_cools_recalled", async () => {
    await traffic(db, [hotP(PV1)]);
    await seed(db);
    const up = has(await dispatchIds(db), [`progress_stale:${POL_V1A}`, `deadline_due:${POL_V1C}`]);
    await traffic(db, [hotP(PV1, 1)]); // 流量退了
    await seed(db);
    const d = await dispatchIds(db);
    return up && none(d, VILLAGE_PROG) && (await gapReason(db, `progress_stale:${POL_V1A}`)) === "window" && (await gapReason(db, `deadline_due:${POL_V1C}`)) === "window";
  });

  await g("traffic_stale_closes", async () => {
    await traffic(db, [hotP(PV1)]);
    await seed(db);
    const up = has(await dispatchIds(db), [`progress_stale:${POL_V1A}`]);
    await db.exec(`UPDATE page_traffic SET updated_at = now() - interval '25 hours'`); // 資料比 24 小時舊（GA 抓失敗）
    await seed(db);
    return up && none(await dispatchIds(db), VILLAGE_PROG);
  });

  await g("traffic_disabled_closes", async () => {
    await traffic(db, [hotP(PV1)]);
    await db.exec(`UPDATE traffic_boost_settings SET enabled = false WHERE id = 1`); // 整個流量功能停用：page_traffic_hot 是空的
    await seed(db);
    return none(await dispatchIds(db), VILLAGE_PROG);
  });

  await g("traffic_opened_by", async () => {
    await traffic(db, [hotP(PV1)]);
    await seed(db);
    const r = await one<{ opened_by: Record<string, unknown> }>(db, `SELECT opened_by FROM task_dispatches WHERE task_id = $1`, [`auto:progress_stale:${POL_V1A}`]);
    const plain = await one<{ opened_by: Record<string, unknown> }>(db, `SELECT opened_by FROM task_dispatches WHERE task_id = $1`, [`auto:progress_stale:${POL_M}`]);
    const ev = await one<{ detail: Record<string, unknown> }>(db, `SELECT detail FROM gap_events WHERE task_id = $1 AND event IN ('opened', 'reopened') ORDER BY id DESC LIMIT 1`, [`auto:progress_stale:${POL_V1A}`]);
    return r.opened_by.traffic_gate === true && r.opened_by.basis === "rule" && !("traffic_gate" in plain.opened_by) && JSON.stringify(ev.detail).includes("traffic_gate");
  });

  await g("traffic_opens_when_exclusion_disabled", async () => {
    // agy 審查 #480：排除規則被停用時，職位補查不能跟著停（正向的「村里長、要流量」規則還要靠職位才比對得到）。
    // 停用兩條排除規則：沒流量的村里長頁仍然關著；熱門的村里長頁照樣開窗，而且帶流量旗標
    await db.exec(`UPDATE activity_rules SET enabled = false WHERE except_election_types IS NOT NULL`);
    await seed(db);
    const cold = none(await dispatchIds(db), VILLAGE_PROG);
    await traffic(db, [hotP(PV1, 50)]);
    await seed(db);
    const d = await dispatchIds(db);
    const r = await one<{ opened_by: Record<string, unknown> } | undefined>(db, `SELECT opened_by FROM task_dispatches WHERE task_id = $1`, [`auto:progress_stale:${POL_V1A}`]);
    return cold && has(d, [TERM_V, `progress_stale:${POL_V1A}`, `progress_stale:${POL_V1B}`, `deadline_due:${POL_V1C}`]) && none(d, [`progress_stale:${POL_V2}`]) && r?.opened_by.traffic_gate === true;
  });

  await g("non_village_unaffected_by_traffic", async () => {
    // 縣市長的人物頁熱門與否，它的進度追蹤都開著（流量只打開被排除的職位，不改別人）；opened_by 不帶流量旗標
    const before = await armIds(db);
    await traffic(db, [hotP(PM, 50), hotPol(POL_M, 50)]);
    const after = await armIds(db);
    const r = await one<{ opened_by: Record<string, unknown> }>(db, `SELECT opened_by FROM contribution_auto_tasks_arms() WHERE task_id = $1`, [`auto:progress_stale:${POL_M}`]);
    return JSON.stringify([...before].sort()) === JSON.stringify([...after].sort()) && !("traffic_gate" in r.opened_by);
  });

  await g("traffic_rule_is_data", async () => {
    await db.exec(`UPDATE activity_rules SET enabled = false WHERE requires_traffic`); // 停用「要流量」的規則：熱門也不開
    await traffic(db, [hotP(PV1, 50)]);
    await seed(db);
    return none(await dispatchIds(db), VILLAGE_PROG);
  });

  await g("arms_all_flag_keeps_closed", async () => {
    // seed 開 gap.arms_all 時，關著的村里長列留在完整輸出裡（opened_by 是 NULL），這樣收回才分得出「窗口關了」；預設（旗標沒開）不回傳
    const off = await armIds(db);
    await db.exec(`SELECT set_config('gap.arms_all', 'on', true)`);
    const r = await rows<{ task_id: string; opened_by: unknown }>(db, `SELECT task_id, opened_by FROM contribution_auto_tasks_arms()`);
    const closed = r.filter((x) => x.opened_by === null).map((x) => x.task_id.replace(/^auto:/, ""));
    return none(off, VILLAGE_PROG) && VILLAGE_PROG.every((k) => closed.includes(k)) && r.filter((x) => x.opened_by !== null).length === off.size;
  });

  // ── 冷卻 ──
  const P = `progress_stale:${POL_M}`; // 非村里長的進度追蹤：開著，有派工列
  const D = `deadline_due:${POL_M2}`;
  const PMISS = `policy_missing:${PV1}`; // 別的任務型別（村里長的補政見）

  await g("first_not_found_14", async () => {
    await check(db, P, "not_found", 13);
    await seed(db);
    const a = await cooling(db, P);
    await db.exec(`DELETE FROM task_checks`);
    await check(db, P, "not_found", 15);
    await seed(db);
    return a === true && (await cooling(db, P)) === false;
  });

  await g("second_not_found_30", async () => {
    await check(db, P, "not_found", 45);
    await check(db, P, "not_found", 20);
    await seed(db);
    const a = await cooling(db, P); // 第二次查無 20 天前：30 天還沒到
    await db.exec(`UPDATE task_checks SET checked_at = now() - interval '31 days' WHERE checked_at > now() - interval '30 days'`);
    await seed(db);
    return a === true && (await cooling(db, P)) === false;
  });

  await g("third_stays_30", async () => {
    await check(db, P, "not_found", 80);
    await check(db, P, "not_found", 50);
    await check(db, P, "not_found", 20);
    await seed(db);
    const a = await cooling(db, P);
    await db.exec(`UPDATE task_checks SET checked_at = now() - interval '31 days' WHERE checked_at > now() - interval '30 days'`);
    await seed(db);
    return a === true && (await cooling(db, P)) === false;
  });

  await g("deadline_due_escalates", async () => {
    await check(db, D, "not_found", 45);
    await check(db, D, "not_found", 20);
    await seed(db);
    return (await cooling(db, D)) === true;
  });

  await g("per_task_ordinal", async () => {
    // 次數是「同一個任務」的：A 有兩次查無（20 天前是第二次）仍在冷卻；B 只有一次（20 天前是第一次）已經過了 14 天
    await check(db, P, "not_found", 45);
    await check(db, P, "not_found", 20);
    await check(db, D, "not_found", 20);
    await seed(db);
    return (await cooling(db, P)) === true && (await cooling(db, D)) === false;
  });

  await g("other_types_flat_14", async () => {
    // 別的任務型別不遞增：同樣兩次查無，20 天前那次已經過了 14 天
    await check(db, PMISS, "not_found", 45);
    await check(db, PMISS, "not_found", 20);
    await seed(db);
    const a = await cooling(db, PMISS);
    await check(db, PMISS, "not_found", 10);
    await seed(db);
    return a === false && (await cooling(db, PMISS)) === true;
  });

  await g("only_not_found_counts", async () => {
    // confirmed（進度沒變）、unreachable（打不開）、NULL（2026-09-21 之前沒有 outcome 的舊資料）都不算查無、不累計：20 天前這次 not_found 是第一次 → 14 天，過了
    await check(db, P, "confirmed", 50);
    await check(db, P, "unreachable", 40);
    await check(db, P, null, 30);
    await check(db, P, "not_found", 20);
    await seed(db);
    const a = await cooling(db, P);
    // confirmed 自己照舊 14 天：10 天前一筆 confirmed → 冷卻
    await check(db, P, "confirmed", 10);
    await seed(db);
    return a === false && (await cooling(db, P)) === true;
  });

  await g("unreachable_2_days_unchanged", async () => {
    await check(db, P, "unreachable", 1);
    await seed(db);
    const a = await cooling(db, P);
    await db.exec(`DELETE FROM task_checks`);
    await check(db, P, "unreachable", 3);
    await seed(db);
    return a === true && (await cooling(db, P)) === false;
  });

  await g("cooldown_settings_are_data", async () => {
    await check(db, P, "not_found", 45);
    await check(db, P, "not_found", 40);
    await seed(db);
    const base = await cooling(db, P); // 第二次 40 天前：30 天已過
    await db.exec(`UPDATE task_cooldown_settings SET not_found_repeat_days = 60 WHERE id = 1`);
    await seed(db);
    const longer = await cooling(db, P);
    await db.exec(`UPDATE task_cooldown_settings SET not_found_repeat_days = 30, not_found_first_days = 50 WHERE id = 1`);
    await db.exec(`DELETE FROM task_checks`);
    await check(db, P, "not_found", 40);
    await seed(db);
    const first50 = await cooling(db, P); // 第一次改 50 天：40 天前仍在冷卻
    return base === false && longer === true && first50 === true;
  });

  await g("cooldown_disabled_flat", async () => {
    await db.exec(`UPDATE task_cooldown_settings SET enabled = false WHERE id = 1`);
    await check(db, P, "not_found", 45);
    await check(db, P, "not_found", 20);
    await seed(db);
    const flat = await cooling(db, P); // 回到一律 14 天：20 天前已經過
    await check(db, P, "not_found", 10);
    await seed(db);
    return flat === false && (await cooling(db, P)) === true;
  });

  await g("task_types_are_data", async () => {
    await db.exec(`UPDATE task_cooldown_settings SET task_types = ARRAY['policy_missing'] WHERE id = 1`);
    await check(db, PMISS, "not_found", 45);
    await check(db, PMISS, "not_found", 20);
    await check(db, P, "not_found", 45);
    await check(db, P, "not_found", 20);
    await seed(db);
    // policy_missing 加進名單就遞增（第二次 20 天前仍在冷卻）；progress_stale 被移出名單就回到 14 天
    return (await cooling(db, PMISS)) === true && (await cooling(db, P)) === false;
  });

  await g("cooling_parity_unaffected_types", async () => {
    // 隨機（確定性）的查核紀錄：除了「進度追蹤類第二次起的 not_found」之外，新舊兩種算法的冷卻集合必須逐件相同
    await db.exec(`
      INSERT INTO task_checks (task_id, outcome, checked_at)
      SELECT 'auto:' || (ARRAY['policy_missing','legacy_audit','profile_gap','not_running_recheck','progress_stale','deadline_due','term_policy_missing'])[1 + (i % 7)] || ':t' || (i % 40),
             (ARRAY['confirmed','not_found','unreachable','not_found',NULL])[1 + (i % 5)],
             now() - ((i * 7) % 50 || ' days')::interval - ((i * 13) % 24 || ' hours')::interval
        FROM generate_series(1, 400) AS i`);
    const diff = await rows<{ task_id: string }>(db, `
      WITH o AS (SELECT DISTINCT tc.task_id FROM task_checks tc
                  WHERE tc.checked_at > now() - (CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days')::interval),
           n AS (SELECT DISTINCT tc.task_id FROM task_checks tc
                  WHERE tc.checked_at > now() - (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::interval)
      SELECT task_id FROM ((SELECT * FROM o EXCEPT SELECT * FROM n) UNION ALL (SELECT * FROM n EXCEPT SELECT * FROM o)) x`);
    const total = await one<{ n: number }>(db, `SELECT count(DISTINCT task_id)::int AS n FROM task_checks`);
    // 差異只可能出在進度追蹤類（progress_stale、deadline_due）
    return total.n > 60 && diff.every((r) => /^auto:(progress_stale|deadline_due):/.test(r.task_id));
  });

  await g("cooling_diff_only_repeat_progress", async () => {
    // 進度追蹤類：只有一次 not_found 的、或沒有 not_found 的，新舊相同；有第二次 not_found 的才變長（而且只會變長）
    await check(db, "progress_stale:one", "not_found", 10);
    await check(db, "progress_stale:conf", "confirmed", 10);
    await check(db, "progress_stale:two", "not_found", 40);
    await check(db, "progress_stale:two", "not_found", 20);
    const r = await rows<{ task_id: string; o: boolean; n: boolean }>(db, `
      SELECT t.task_id,
             EXISTS (SELECT 1 FROM task_checks tc WHERE tc.task_id = t.task_id AND tc.checked_at > now() - (CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days')::interval) AS o,
             EXISTS (SELECT 1 FROM task_checks tc WHERE tc.task_id = t.task_id AND tc.checked_at > now() - (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::interval) AS n
        FROM (SELECT DISTINCT task_id FROM task_checks) t ORDER BY t.task_id`);
    const m = Object.fromEntries(r.map((x) => [x.task_id.replace(/^auto:progress_stale:/, ""), x]));
    return m.one.o && m.one.n && m.conf.o && m.conf.n && !m.two.o && m.two.n;
  });

  await g("cool_bound_covers_settings", async () => {
    // 先濾掉太舊的紀錄只是省效能，不能改結果：很舊的紀錄不冷卻；設定把天數調長，上限跟著變長（第二次 150 天前、遞增天數 200 → 仍在冷卻）
    await check(db, P, "not_found", 400);
    await check(db, P, "not_found", 380);
    await seed(db);
    const old = (await cooling(db, P)) === false;
    await db.exec(`UPDATE task_cooldown_settings SET not_found_repeat_days = 200 WHERE id = 1`);
    await db.exec(`DELETE FROM task_checks`);
    await check(db, P, "not_found", 300);
    await check(db, P, "not_found", 150);
    await seed(db);
    const long = (await cooling(db, P)) === true;
    const max = (await one<{ d: number }>(db, `SELECT task_cooldown_max_days() AS d`)).d;
    return old && long && max === 200;
  });

  // ── 標籤 ──
  await g("label_on_when_cooling", async () => {
    await check(db, P, "not_found", 5);
    await seed(db);
    return (await label(db, POL_M)) === true;
  });

  await g("label_off_after_first_cooldown", async () => {
    await check(db, P, "not_found", 15); // 第一次 14 天：過了
    await seed(db);
    const off = (await label(db, POL_M)) === false;
    await db.exec(`DELETE FROM task_checks`);
    await check(db, P, "not_found", 13);
    await seed(db);
    return off && (await label(db, POL_M)) === true;
  });

  await g("label_30_on_second", async () => {
    await check(db, P, "not_found", 45);
    await check(db, P, "not_found", 20); // 第二次：30 天，20 天前仍在
    await seed(db);
    const on = (await label(db, POL_M)) === true;
    await db.exec(`UPDATE task_checks SET checked_at = now() - interval '31 days' WHERE checked_at > now() - interval '30 days'`);
    await seed(db);
    return on && (await label(db, POL_M)) === false;
  });

  await g("label_off_when_gap_gone", async () => {
    await check(db, P, "not_found", 5);
    await seed(db);
    const on = (await label(db, POL_M)) === true;
    // 新進度上線：缺口消失（臂不再算它），seed 收回派工列，標籤跟著消失（冷卻還沒結束也一樣）
    await db.exec(`DELETE FROM _b_raw WHERE task_id = 'auto:${P}'`);
    await seed(db);
    return on && (await label(db, POL_M)) === false && (await cooling(db, P)) === undefined;
  });

  await g("label_only_not_found", async () => {
    await check(db, P, "confirmed", 1);
    await check(db, D, "unreachable", 1);
    await seed(db);
    return (await label(db, POL_M)) === false && (await label(db, POL_M2)) === false && (await cooling(db, P)) === true; // 冷卻照舊 14 天，但不是「查無」
  });

  await g("label_per_policy", async () => {
    await check(db, P, "not_found", 5);
    await seed(db);
    const labels = await rows<{ id: string; v: boolean }>(db, `SELECT id, no_public_progress AS v FROM policies_with_logs ORDER BY id`);
    return labels.filter((x) => x.v).map((x) => x.id).join() === POL_M && labels.length === ALL_POLICIES.length;
  });

  await g("label_deadline_due", async () => {
    await check(db, D, "not_found", 5);
    await seed(db);
    return (await label(db, POL_M2)) === true && (await label(db, POL_M)) === false;
  });

  await g("label_follows_settings", async () => {
    await check(db, P, "not_found", 5);
    await seed(db);
    const on = (await label(db, POL_M)) === true;
    await db.exec(`UPDATE task_cooldown_settings SET task_types = ARRAY['deadline_due'] WHERE id = 1`); // 進度追蹤不在名單裡：沒有標籤的依據（即使 5 天前剛查無）
    const out = (await label(db, POL_M)) === false;
    await db.exec(`UPDATE task_cooldown_settings SET task_types = ARRAY['progress_stale', 'deadline_due'], enabled = false WHERE id = 1`);
    await db.exec(`DELETE FROM task_checks`);
    await check(db, P, "not_found", 45);
    await check(db, P, "not_found", 20);
    const flat = (await label(db, POL_M)) === false; // 關閉遞增：回到 14 天，20 天前已過
    return on && out && flat;
  });

  await g("label_view_shape", async () => {
    const cols = await rows<{ column_name: string; ordinal_position: number }>(db, `SELECT column_name, ordinal_position FROM information_schema.columns WHERE table_name = 'policies_with_logs' ORDER BY ordinal_position`);
    const names = cols.map((c) => c.column_name);
    const polCols = (await rows<{ column_name: string }>(db, `SELECT column_name FROM information_schema.columns WHERE table_name = 'policies' ORDER BY ordinal_position`)).map((c) => c.column_name);
    const opt = await one<{ o: string[] | null }>(db, `SELECT reloptions AS o FROM pg_class WHERE relname = 'policies_with_logs'`);
    return names.at(-1) === "no_public_progress" && names.at(-2) === "sources" && JSON.stringify(names.slice(0, polCols.length)) === JSON.stringify(polCols) &&
      names.slice(polCols.length, -1).join() === "logs,related_policy_ids,elements,lineage,sources" && !!opt.o?.includes("security_invoker=on");
  });

  await g("label_fn_public", async () => {
    const can = async (role: string, fn: string) => (await one<{ ok: boolean }>(db, `SELECT has_function_privilege('${role}', '${fn}'::regprocedure, 'EXECUTE') AS ok`)).ok;
    return (await can("anon", "policy_no_public_progress(uuid)")) && (await can("anon", "task_check_cooldown_days_for(text, text, timestamptz, bigint)")) &&
      (await one<{ ok: boolean }>(db, `SELECT has_table_privilege('anon', 'policies_with_logs', 'SELECT') AS ok`)).ok;
  });

  await g("rule_constraints", async () => {
    const bad = async (sql: string) => {
      await db.exec("SAVEPOINT s");
      try {
        await db.exec(sql);
        await db.exec("ROLLBACK TO s");
        return false;
      } catch {
        await db.exec("ROLLBACK TO s");
        return true;
      }
    };
    return (await bad(`INSERT INTO activity_rules (activity, window_kind, election_types, except_election_types) VALUES ('x', 'always', ARRAY['村里長'], ARRAY['縣市長'])`)) && // 二選一
      (await bad(`INSERT INTO activity_rules (activity, window_kind, except_election_types) VALUES ('x', 'always', ARRAY['不是職位'])`)) &&
      (await bad(`INSERT INTO activity_rules (activity, window_kind, except_election_types) VALUES ('x', 'always', ARRAY[]::text[])`)) &&
      (await bad(`INSERT INTO activity_rules (activity, window_kind, requires_traffic, priority) VALUES ('priority:x', 'always', true, 1)`));
  });

  await g("settings_audit_and_rls", async () => {
    await db.exec(`UPDATE task_cooldown_settings SET not_found_repeat_days = 45 WHERE id = 1`);
    const a = await rows(db, `SELECT 1 FROM edit_history WHERE table_name = 'task_cooldown_settings'`);
    const rls = await rows<{ polname: string }>(db, `SELECT polname FROM pg_policy WHERE polrelid = 'task_cooldown_settings'::regclass ORDER BY polname`);
    const on = await one<{ r: boolean }>(db, `SELECT relrowsecurity AS r FROM pg_class WHERE relname = 'task_cooldown_settings'`);
    return a.length > 0 && on.r && rls.map((r) => r.polname).join() === "Public read,Service role write";
  });

  return v;
}

Deno.test("B1 行為層：村里長進度關窗、流量開窗、冷卻 14→30、parity、標籤（每條都要綠）", async () => {
  const db = await buildDb();
  const v = await runSuite(db);
  const bad = GUARDS.filter((n) => v[n] !== true);
  assertEquals(bad, [], `不綠的守門：${bad.join("、")}`);
  assertEquals(Object.keys(v).sort(), [...GUARDS].sort(), "GUARDS 清單與實際跑的守門一致");
});

// ============================================================
// C. 還原驗證：把 migration 改壞一處，對應的守門必須紅
// ============================================================
type G = (typeof GUARDS)[number];
const MUTATIONS: { why: string; from: string; to: string; also?: [string, string]; red: G[] }[] = [
  { why: "activity_open 不排除職位", from: "       AND (r.except_election_types IS NULL OR p_election_type IS NULL OR NOT (p_election_type = ANY (r.except_election_types)))  -- 排除職位：職位未知（NULL）時不排除，寧可開著也不無聲關掉\n", to: "", red: ["baseline_village_progress_closed", "activity_open_exclusion", "dispatch_recalled_window"] },
  { why: "排除時把職位未知的也關掉（NULL 不安全）", from: "(r.except_election_types IS NULL OR p_election_type IS NULL OR NOT (p_election_type = ANY (r.except_election_types)))", to: "(r.except_election_types IS NULL OR NOT (p_election_type = ANY (r.except_election_types)))", red: ["unknown_position_stays_open", "activity_open_exclusion"] },
  { why: "排除名單寫成縣市長（沒排除村里長）", from: "   SET except_election_types = ARRAY['村里長'],", to: "   SET except_election_types = ARRAY['縣市長'],", also: ["AND r.except_election_types = ARRAY['村里長'] AND r.enabled;\n  IF v_n <> 3 THEN RAISE EXCEPTION '村里長進度：預期 raw:progress_stale", "AND r.except_election_types = ARRAY['縣市長'] AND r.enabled;\n  IF v_n <> 3 THEN RAISE EXCEPTION '村里長進度：預期 raw:progress_stale"], red: ["baseline_village_progress_closed", "activity_open_exclusion"] },
  { why: "補該屆政見（term_policies）沒有種排除村里長的規則", from: " WHERE activity IN ('raw:progress_stale', 'deadline_due', 'term_policies')\n   AND window_kind = 'always'", to: " WHERE activity IN ('raw:progress_stale', 'deadline_due')\n   AND window_kind = 'always'", also: ["IF v_n <> 3 THEN RAISE EXCEPTION '村里長進度：預期 raw:progress_stale、deadline_due、term_policies 各有一條「永遠開、排除村里長」", "IF v_n <> 2 THEN RAISE EXCEPTION '村里長進度：預期 raw:progress_stale、deadline_due、term_policies 各有一條「永遠開、排除村里長」"], red: ["baseline_village_progress_closed", "activity_open_exclusion"] },
  { why: "補該屆政見沒有種「村里長、要流量」的規則（熱門也不開）", from: "(VALUES ('raw:progress_stale'), ('deadline_due'), ('term_policies')) AS a(activity)", to: "(VALUES ('raw:progress_stale'), ('deadline_due')) AS a(activity)", also: ["IF v_n <> 3 THEN RAISE EXCEPTION '村里長進度：預期三個活動各有一條", "IF v_n <> 2 THEN RAISE EXCEPTION '村里長進度：預期三個活動各有一條"], red: ["traffic_opens_person", "activity_open_exclusion"] },
  { why: "總表不補職位（keyed 只看 target）", from: "                  CASE WHEN g.arm IN (SELECT n.activity FROM needs_etype n)\n", to: "                  CASE WHEN false\n", red: ["baseline_village_progress_closed", "dispatch_recalled_window", "traffic_opens_person"] },
  { why: "職位補查只看排除清單（漏了正向清單 election_types）", from: "(r.except_election_types IS NOT NULL OR r.election_types IS NOT NULL)", to: "r.except_election_types IS NOT NULL", red: ["traffic_opens_when_exclusion_disabled"] },
  { why: "職位補查對所有臂都做（不只有規則要看職位的臂）", from: "                  CASE WHEN g.arm IN (SELECT n.activity FROM needs_etype n)\n", to: "                  CASE WHEN true\n", red: ["other_arms_group_unchanged"] },
  { why: "職位補查取錯屆別（寫死 2026）", from: "AND pe.election_id = election_id_or_null(g.target->>'election_id')\n", to: "AND pe.election_id = 2026\n", red: ["baseline_village_progress_closed"] },
  { why: "總表忽略 requires_traffic（村里長永遠開）", from: "SELECT o.source IS NOT NULL AND (NOT o.requires_traffic OR EXISTS (", to: "SELECT o.source IS NOT NULL AND (true OR EXISTS (", red: ["traffic_threshold", "traffic_opens_policy", "traffic_cools_recalled"] },
  { why: "流量只看人物頁（不看政見頁）", from: " OR (h.kind = 'policy' AND h.target_id = g.target->>'policy_id')", to: "", red: ["traffic_opens_policy"] },
  { why: "流量只看政見頁（不看人物頁）", from: "(h.kind = 'politician' AND h.target_id = g.target->>'politician_id') OR ", to: "", red: ["traffic_opens_person", "traffic_threshold", "traffic_cools_recalled"] },
  { why: "流量規則不標在 opened_by", from: "           'traffic_gate', CASE WHEN o.requires_traffic THEN true END)) END AS opened_by", to: "           'traffic_gate', NULL)) END AS opened_by", red: ["traffic_opened_by"] },
  { why: "旗標開著時不留下關著的列", from: "   WHERE (w.ok OR (SELECT current_setting('gap.arms_all', true) = 'on'))", to: "   WHERE w.ok", red: ["arms_all_flag_keeps_closed", "dispatch_recalled_window", "traffic_cools_recalled"] },
  { why: "opened 不帶 requires_traffic（規則的流量旗標讀不到）", from: "COALESCE((SELECT r.requires_traffic FROM activity_rules r WHERE r.id = o.rule_id), false) AS requires_traffic", to: "false AS requires_traffic", red: ["traffic_threshold", "traffic_opens_policy"] },
  { why: "冷卻不問新函式（refresh_dispatch_blocked 還是舊的 CASE）", from: "    WHERE tc.checked_at > now() - (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL\n", to: "    WHERE tc.checked_at > now() - (\n      CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days'\n    )::INTERVAL\n", red: ["second_not_found_30", "third_stays_30", "deadline_due_escalates", "per_task_ordinal"] },
  { why: "第二次起不遞增（永遠第一次）", from: "THEN s.not_found_repeat_days ELSE s.not_found_first_days END", to: "THEN s.not_found_first_days ELSE s.not_found_first_days END", red: ["second_not_found_30", "third_stays_30", "deadline_due_escalates", "per_task_ordinal", "label_30_on_second"] },
  { why: "第三次才遞增（>= 3）", from: "(x.checked_at, x.id) <= (p_checked_at, p_id)) >= 2", to: "(x.checked_at, x.id) <= (p_checked_at, p_id)) >= 3", red: ["second_not_found_30", "per_task_ordinal", "label_30_on_second"] },
  { why: "累計把所有 outcome 都算進去（不只 not_found）", from: "WHERE x.task_id = p_task_id AND x.outcome = 'not_found' AND (x.checked_at, x.id)", to: "WHERE x.task_id = p_task_id AND (x.checked_at, x.id)", red: ["only_not_found_counts"] },
  { why: "累計不分任務（整張表數）", from: "WHERE x.task_id = p_task_id AND x.outcome = 'not_found' AND (x.checked_at, x.id)", to: "WHERE x.outcome = 'not_found' AND (x.checked_at, x.id)", red: ["per_task_ordinal"] },
  { why: "對所有任務型別都遞增（不看 task_types）", from: "WHEN p_outcome = 'not_found' AND s.enabled AND split_part(p_task_id, ':', 2) = ANY (s.task_types)", to: "WHEN p_outcome = 'not_found' AND s.enabled", red: ["other_types_flat_14", "task_types_are_data", "cooling_parity_unaffected_types"] },
  { why: "unreachable 不再是 2 天", from: "WHEN p_outcome = 'unreachable' THEN task_unreachable_cooldown_days()", to: "WHEN p_outcome = 'unreachable' THEN task_check_cooldown_days()", red: ["unreachable_2_days_unchanged", "cooling_parity_unaffected_types"] },
  { why: "設定開關不管用", from: "WHEN p_outcome = 'not_found' AND s.enabled AND split_part", to: "WHEN p_outcome = 'not_found' AND true AND split_part", red: ["cooldown_disabled_flat"] },
  { why: "歷史紀錄的上限沒算設定表的遞增天數", from: "COALESCE(s.not_found_first_days, 0), COALESCE(s.not_found_repeat_days, 0))", to: "COALESCE(s.not_found_first_days, 0), 0)", red: ["cool_bound_covers_settings"] },
  { why: "歷史紀錄的上限太小（只看 1 天）", from: "make_interval(days => (SELECT task_cooldown_max_days()))", to: "make_interval(days => 1)", red: ["first_not_found_14", "second_not_found_30"] },
  { why: "第一次的天數寫死 14", from: "THEN s.not_found_repeat_days ELSE s.not_found_first_days END", to: "THEN s.not_found_repeat_days ELSE 14 END", red: ["cooldown_settings_are_data"] },
  { why: "遞增的天數寫死 30", from: "THEN s.not_found_repeat_days ELSE s.not_found_first_days END", to: "THEN 30 ELSE s.not_found_first_days END", red: ["cooldown_settings_are_data"] },
  { why: "標籤不看缺口還在不在（只看查核紀錄）", from: "      JOIN task_dispatches d ON d.task_id = 'auto:' || t.task_type || ':' || p_policy_id::TEXT\n      JOIN task_checks c ON c.task_id = d.task_id AND c.outcome = 'not_found'\n", to: "      JOIN task_checks c ON c.task_id = 'auto:' || t.task_type || ':' || p_policy_id::TEXT AND c.outcome = 'not_found'\n", red: ["label_off_when_gap_gone"] },
  { why: "標籤不分 outcome", from: "JOIN task_checks c ON c.task_id = d.task_id AND c.outcome = 'not_found'", to: "JOIN task_checks c ON c.task_id = d.task_id", red: ["label_only_not_found"] },
  { why: "標籤不看冷卻是否結束", from: "       AND c.checked_at > now() - (task_check_cooldown_days_for(c.task_id, c.outcome, c.checked_at, c.id) || ' days')::INTERVAL\n", to: "", red: ["label_off_after_first_cooldown", "label_30_on_second"] },
  { why: "標籤的冷卻天數固定第一次的天數", from: "       AND c.checked_at > now() - (task_check_cooldown_days_for(c.task_id, c.outcome, c.checked_at, c.id) || ' days')::INTERVAL\n", to: "       AND c.checked_at > now() - (s.not_found_first_days || ' days')::INTERVAL\n", red: ["label_30_on_second"] },
  { why: "標籤的型別不讀設定表（只認進度追蹤）", from: "JOIN task_dispatches d ON d.task_id = 'auto:' || t.task_type || ':' || p_policy_id::TEXT", to: "JOIN task_dispatches d ON d.task_id = 'auto:progress_stale:' || p_policy_id::TEXT", red: ["label_deadline_due", "label_follows_settings"] },
  { why: "視圖的標籤欄不是函式的結果（恆為 false）", from: "  policy_no_public_progress(p.id) AS no_public_progress\n", to: "  false AS no_public_progress\n", red: ["label_on_when_cooling", "label_30_on_second", "label_deadline_due"] },
  { why: "設定表沒有審計", from: "CREATE TRIGGER trg_task_cooldown_settings_audit AFTER INSERT OR UPDATE OR DELETE ON task_cooldown_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();", to: "", red: ["settings_audit_and_rls"] },
  { why: "排除與正向清單可以同時用", from: "    AND election_types IS NULL)  -- 正向清單與排除清單二選一，不同時用\n", to: "    )\n", red: ["rule_constraints"] },
  { why: "優先層規則也可以要流量", from: "CHECK (NOT requires_traffic OR activity NOT LIKE 'priority:%');", to: "CHECK (true);", red: ["rule_constraints"] },
];

for (const [i, m] of MUTATIONS.entries()) {
  Deno.test(`C${i + 1} 還原驗證：${m.why}`, async () => {
    const db = await buildDb((s) => (m.also ? mutate(mutate(s, m.from, m.to), m.also[0], m.also[1]) : mutate(s, m.from, m.to)));
    const v = await runSuite(db);
    for (const name of m.red) assert(v[name] === false, `改壞「${m.why}」之後守門 ${name} 必須紅，實際是 ${v[name]}`);
  });
}

Deno.test("C0 沒套這支 migration 時守門跑不出全綠（測的是這支的東西）", async () => {
  // 前一版的世界：沒有新欄位、新函式、新表。守門本來就會因缺東西而報錯（false），這裡只確認「全綠」不是自動成立的
  const db = await buildDb((s) => s, false);
  const v = await runSuite(db);
  assert(v.baseline_village_progress_closed === false && v.second_not_found_30 === false && v.label_on_when_cooling === false);
});
