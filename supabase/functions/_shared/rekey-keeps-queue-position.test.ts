/**
 * 帶清單指紋的派工臂換號時沿用排隊位置＋慢性停擺檢查（migration 20261019040000_rekey_keeps_queue_position.sql；#670 第 8、9 點）。
 *
 * 根因：lineage_candidate／lineage_link_candidate／duplicate_policy 的 task_id 末段是那一格內容的指紋，格子裡任何一條政見一動指紋就變，
 * seed 收回舊列、新列以新 task_id 出生＝進隊時間重算＝排回隊尾；正式庫佇列延遲約 14 天、這幾臂的列壽命中位數 12～21 小時，幾乎永遠輪不到。
 *
 *   A. 文字層：seed＝前一版（20261017010000）加 rekey-position-edits.ts 登記的幾處替換、activity_health＝前一版加一個分支、
 *      「task_id 末段是 .fp 的臂」每一支都登記在 task_rekey_arms（漏登記就紅，正見與日本站都掃）、不碰 lineage_candidate_scope 與臂本體、參數不寫死
 *   B. PGlite（真的 seed、真的觸發器 task_dispatches_queue_key 與 gap_events 三支觸發器；臂總表與周邊函式換成 stub）：
 *      B1 同一格換指紋：新列 queue_at 等於舊列（也就是不晚於）、進隊時間與派出次數沿用、舊列收回新列出生（gap_events closed／opened，opened_by 記 rekey_of）、連換三次 chain_opened_at 不變
 *      B2 前一列派出過：新列在「派出之後」的位置（回隊尾），不插回最前；派出時插隊歸零所以不繼承插隊；沒派出過就被插隊的，插隊跟著走
 *      B3 不同格不互相繼承（同一輪兩格各自換、第三格全新出生、別的格子消失不影響、同指紋尾巴的兩格不混）
 *      B4 沒有指紋的臂行為不變（一般臂、不在清單的臂、末段不像指紋的）；rekey_keep_position＝false 回到舊行為
 *      B5 慢性停擺：該列的列得出來、不該列的不列（有交件、壽命夠長、窗口關了的、做完了的、換號串夠長的、太少的），參數改了結果跟著變
 *      B6 activity_health 視圖（這支 migration 的原文，P0／P1 的環境上）建得起來、整張視圖每個分支都跑得動，慢性停擺那一列帶出類型、列數、壽命與佇列延遲
 *   C. 還原驗證：拿掉繼承（last_dispatched_at／插隊／穩定鍵）、拿掉慢性停擺的篩選，各自對應的劇本要翻面
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, migrationNames, mutate, readMig } from "./arms-pglite.ts";
import { applyRekeyEdits, HEALTH_BRANCH, REKEY_EDITS } from "./rekey-position-edits.ts";

const MIG_NAME = "20261019040000_rekey_keeps_queue_position.sql";
const MIG = await readMig(MIG_NAME);
const JP_MIG_NAME = "20261019040100_policy_jp_rekey_keeps_queue_position.sql";
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 seed：新定義＝20261017010000 的現行定義加 rekey-position-edits.ts 登記的替換，一字不差；它是 seed 的最新定義", async () => {
  const prevName = "20261017010000_verify_ticket_follows_task.sql";
  const prev = fnText(await readMig(prevName), "seed_auto_task_queue");
  const neu = fnText(MIG, "seed_auto_task_queue");
  assertEquals(neu, applyRekeyEdits(prev, REKEY_EDITS));
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION seed_auto_task_queue(")) defining.push(n);
  assertEquals(defining.slice(-2), [prevName, MIG_NAME], "seed 的前一版變了：要以最新的為底重做替換（rekey-position-edits.ts）");
  // 替換沒有碰到驗證票的那兩處（補驗證列、最後的 refresh_verify_ticket_keys）與在途停放、窗口／filled 的收回
  for (const keep of ["PERFORM refresh_verify_ticket_keys();", "SELECT 'verify:' || c.id, now(), now(), 0", "PERFORM set_config('gap.close_reason', 'window', true);",
    "(d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region)"]) {
    assert(neu.includes(keep), `seed 少了原本就有的：${keep}`);
  }
  // 沿用排隊位置只給「出生當下」的新列：既有列的 UPDATE（內容、優先秒數）沒有任何一處讀 _rekey_prev
  const ups = neu.split("\n").filter((l) => /^\s*UPDATE task_dispatches/.test(l));
  assertEquals(ups.length, 2);
  assertEquals(neu.split("_rekey_prev").length - 1, 3, "_rekey_prev 只出現三處：DROP、CREATE、新增那段的 LEFT JOIN");
});

Deno.test("A2 activity_health：新定義＝20261017000301 的現行定義加 dispatch_chronic_stall 一個分支（其餘一字不動）；它是 activity_health 的最新定義", async () => {
  const prevName = "20261017000301_queue_tasks_eligibility_before_limit.sql";
  const prevSql = await readMig(prevName);
  const grab = (sql: string) => {
    const a = sql.indexOf("CREATE OR REPLACE VIEW activity_health AS");
    assert(a >= 0);
    const tail = sql.indexOf("    FROM queue_head_stale() s", a);
    assert(tail > a);
    return sql.slice(a, tail + "    FROM queue_head_stale() s".length);
  };
  const neuSql = MIG.slice(MIG.indexOf("CREATE OR REPLACE VIEW activity_health AS"));
  const neuView = neuSql.slice(0, neuSql.indexOf(HEALTH_BRANCH) + HEALTH_BRANCH.length);
  assertEquals(neuView, grab(prevSql) + "\n" + HEALTH_BRANCH);
  const defining: string[] = [];
  for (const n of await migrationNames()) if (/CREATE OR REPLACE VIEW activity_health AS/.test(await readMig(n))) defining.push(n);
  assertEquals(defining.slice(-2), [prevName, MIG_NAME], "activity_health 的前一版變了：要以最新的為底重做（HEALTH_BRANCH 接在最後）");
});

/** 抓「task_id 末段是 <別名>.fp」的臂：SELECT 'auto:<臂>:' || … || ':' || x.fp（task_id 的串接那一行） */
function fpArms(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(/'auto:([a-z_]+):'\s*\|\|[^\n]*?\|\|\s*':'\s*\|\|\s*\w+\.fp\b/g)) out.add(m[1]!);
  return [...out].sort();
}
const armsOfFn = (sql: string, fn: string) => [...fnText(sql, fn).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();

Deno.test("A3 帶清單指紋的臂（task_id 末段是 .fp）全部登記在 task_rekey_arms（正見與日本站都掃），漏登記就紅；偵測器自己也驗", async () => {
  const registered = armsOfFn(MIG, "task_rekey_arms");
  assertEquals(registered, ["duplicate_policy", "lineage_candidate", "lineage_link_candidate"]);
  const found = new Set<string>();
  for (const n of await migrationNames()) for (const a of fpArms(await readMig(n))) found.add(a);
  // 掃得到這三臂（正見的 lineage／duplicate_policy 與日本站的 duplicate_policy），不是掃空了就過
  for (const a of registered) assert(found.has(a), `掃描沒有抓到 ${a}`);
  assertEquals([...found].sort(), registered, "有臂的 task_id 末段是 .fp 卻沒登記進 task_rekey_arms（換指紋就排回隊尾）：加進清單，或確認它的末段不是清單指紋");
  // 日本站的清單與正見同一份
  const jp = await readMig(JP_MIG_NAME);
  assertEquals(armsOfFn(jp, "policy_jp.task_rekey_arms"), registered);
  // 偵測器：假的臂抓得到，handover_missing 那種「指紋是交接本身的鍵」不算
  assertEquals(fpArms("SELECT 'auto:new_arm:' || x.id || ':' || x.fp, 'new_arm'"), ["new_arm"]);
  assertEquals(fpArms("SELECT 'auto:handover_missing:' || s.lineage_id || ':' || substr(md5(s.a), 1, 8)"), []);
});

Deno.test("A4 範圍：不碰 lineage_candidate_scope 與三支臂本體與 task_dispatches 觸發器、gap_events 觸發器；參數都在 queue_settings、函式裡沒有寫死的天數", () => {
  for (const [name, sql] of [["正見", MIG]] as const) {
    const c = code(sql);
    assert(!/lineage_candidate_scope/.test(c), `${name}：不碰 lineage_candidate_scope（#670 PR 2 在改）`);
    for (const f of ["contribution_auto_tasks_lineage_candidates", "contribution_auto_tasks_lineage_links", "contribution_auto_tasks_policy_dup", "task_dispatches_queue_key",
      "task_dispatches_gap_before_insert", "task_dispatches_gap_after_insert", "task_dispatches_gap_after_delete", "contribution_auto_tasks_arms"]) {
      assert(!c.includes(`CREATE OR REPLACE FUNCTION ${f}(`), `${name}：不重新定義 ${f}`);
    }
  }
  const stall = code(fnText(MIG, "dispatch_chronic_stall"));
  for (const col of ["stall_window_days", "stall_min_closed", "stall_max_contributions"]) assert(stall.includes(col), `慢性停擺讀 queue_settings.${col}`);
  assert(!/interval '\d|make_interval\(days => \d|>= \d{2}/i.test(stall), "慢性停擺函式裡沒有寫死的天數或門檻");
  assert(code(fnText(MIG, "dispatch_queue_delay_seconds")).includes("contribution_queue_tasks("), "佇列延遲取可派的隊頭（合格條件之後），跟 /next 同一個定義");
  // 三個參數的初值與下限寫在 ALTER（改值走一行 migration 的 UPDATE，進 edit_history）
  assert(MIG.includes("stall_window_days INTEGER NOT NULL DEFAULT 7"));
  assert(MIG.includes("stall_min_closed INTEGER NOT NULL DEFAULT 10"));
  assert(MIG.includes("stall_max_contributions INTEGER NOT NULL DEFAULT 0"));
  assert(MIG.includes("rekey_keep_position BOOLEAN NOT NULL DEFAULT true"));
});

Deno.test("A5 在途交件比對沒被破壞：兩支脈絡臂的「最新定義」仍用「含指紋的完整 task_id」比對 pending 交件（穩定鍵只用在 seed 沿用位置，不放寬臂的排除；臂本體可以被別的 PR 改，這條要守住）", async () => {
  for (const [fn, needle] of [
    ["contribution_auto_tasks_lineage_candidates", "AND c.task_id = 'auto:lineage_candidate:' || b.block_key || ':' || b.fp"],
    ["contribution_auto_tasks_lineage_links", "AND c.task_id = 'auto:lineage_link_candidate:' || g.lower_id || ':' || g.fp"],
  ] as const) {
    const latest = await latestFn(fn);
    assert(latest.includes(needle), `${fn} 的最新定義少了含指紋的在途比對：${needle}`);
    // 比對的是 pending／verified／apply_failed 的交件（等票中的先不派）
    assert(/c\.status IN \('pending', 'verified', 'apply_failed'\)/.test(latest), `${fn}：在途交件的狀態清單變了`);
  }
});

// ============================================================
// B. PGlite
// ============================================================
const SCHEMA = `
CREATE TABLE queue_settings (id smallint PRIMARY KEY, note text);
INSERT INTO queue_settings (id) VALUES (1);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz NOT NULL DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 1, refreshed_at timestamptz,
  queue_at timestamptz NOT NULL DEFAULT now(), task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb, what_we_need text, hint_sources text[], reward integer, region text,
  blocked boolean NOT NULL DEFAULT false, cooling boolean NOT NULL DEFAULT false, verify_target integer, priority_seconds integer NOT NULL DEFAULT 0,
  boost_seconds bigint NOT NULL DEFAULT 0, cool_until timestamptz, opened_at timestamptz, opened_by jsonb, verify_follows_task boolean NOT NULL DEFAULT true);
CREATE TABLE gap_events (id BIGSERIAL PRIMARY KEY, task_id TEXT NOT NULL, task_type TEXT, event TEXT NOT NULL CHECK (event IN ('opened', 'closed', 'reopened')),
  at TIMESTAMPTZ NOT NULL DEFAULT now(), rule_id BIGINT, election_id INTEGER, milestone_kind TEXT, milestone_on_date DATE,
  reason TEXT CHECK (reason IS NULL OR reason IN ('window', 'filled', 'override', 'rule_change')), detail JSONB);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'pending', contribution_type text, task_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE traffic_boost_settings (id smallint PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, boost_seconds integer NOT NULL DEFAULT 259200);
INSERT INTO traffic_boost_settings (id) VALUES (1);
-- 總表 stub：回放 _arms；優先秒數 stub：回放 _prio（沒有就 0）
CREATE TABLE _arms (task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text, arm text, opened_by jsonb);
CREATE TABLE _prio (arm text PRIMARY KEY, seconds integer NOT NULL);
CREATE FUNCTION contribution_auto_tasks_arms() RETURNS TABLE (task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text, arm text, opened_by jsonb)
  LANGUAGE sql STABLE AS $f$ SELECT * FROM _arms $f$;
CREATE FUNCTION activity_priority_seconds(p_activity text, p_election_id integer DEFAULT NULL, p_election_type text DEFAULT NULL, p_today date DEFAULT NULL)
  RETURNS TABLE (seconds integer, rule_id bigint) LANGUAGE sql STABLE AS $f$ SELECT COALESCE((SELECT p.seconds FROM _prio p WHERE p.arm = p_activity), 0), NULL::bigint $f$;
-- seed 周邊與缺口無關的東西：空殼（各自有自己的測試）
CREATE FUNCTION traffic_boost_apply() RETURNS integer LANGUAGE sql AS $f$ SELECT 0 $f$;
CREATE FUNCTION queue_slot(p text) RETURNS timestamptz LANGUAGE sql AS $f$ SELECT now() $f$;
CREATE FUNCTION manual_front_seconds(p_task_id text) RETURNS bigint LANGUAGE sql AS $f$ SELECT 0::bigint $f$;
CREATE FUNCTION refresh_dispatch_blocked() RETURNS integer LANGUAGE sql AS $f$ SELECT 0 $f$;
CREATE FUNCTION refresh_verify_targets() RETURNS integer LANGUAGE sql AS $f$ SELECT 0 $f$;
CREATE FUNCTION manual_front_pull() RETURNS integer LANGUAGE sql AS $f$ SELECT 0 $f$;
CREATE FUNCTION refresh_verify_ticket_keys() RETURNS integer LANGUAGE sql AS $f$ SELECT 0 $f$;
-- 慢性停擺的隊頭：照 queue_at 取非驗證列（真的合格條件有自己的測試 queue-eligibility）
CREATE FUNCTION contribution_queue_tasks(p_type text DEFAULT NULL, p_region text DEFAULT NULL, p_limit integer DEFAULT 20, p_seed text DEFAULT '', p_ip_hash text DEFAULT NULL, p_agent text DEFAULT NULL)
  RETURNS TABLE (task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, queue_at timestamptz) LANGUAGE sql STABLE AS $f$
  SELECT d.task_id, d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.queue_at FROM task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%' AND NOT d.blocked ORDER BY d.queue_at LIMIT p_limit $f$;
`;
const TRIGGERS = `
CREATE TRIGGER trg_task_dispatches_queue_key BEFORE INSERT OR UPDATE ON task_dispatches FOR EACH ROW EXECUTE FUNCTION task_dispatches_queue_key();
CREATE TRIGGER trg_task_dispatches_gap_before_insert BEFORE INSERT ON task_dispatches FOR EACH ROW WHEN (NEW.task_id LIKE 'auto:%') EXECUTE FUNCTION task_dispatches_gap_before_insert();
CREATE TRIGGER trg_task_dispatches_gap_after_insert AFTER INSERT ON task_dispatches FOR EACH ROW WHEN (NEW.task_id LIKE 'auto:%') EXECUTE FUNCTION task_dispatches_gap_after_insert();
CREATE TRIGGER trg_task_dispatches_gap_after_delete AFTER DELETE ON task_dispatches FOR EACH ROW WHEN (OLD.task_id LIKE 'auto:%') EXECUTE FUNCTION task_dispatches_gap_after_delete();
CREATE TRIGGER trg_gap_events_append_only BEFORE UPDATE OR DELETE ON gap_events FOR EACH ROW EXECUTE FUNCTION gap_events_append_only();
`;
/** 這支 migration 要在資料庫裡跑的部分：設定欄、穩定鍵、seed、慢性停擺函式（最後的 activity_health 視圖相依整個啟用時間窗，A2 守它的文字） */
const MIG_DB = MIG.slice(0, MIG.indexOf("-- 5. activity_health："));

async function env(mutateMig: (sql: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const n of ["task_queue_key", "task_dispatches_queue_key", "election_id_or_null", "task_dispatches_gap_before_insert", "task_dispatches_gap_after_insert",
    "task_dispatches_gap_after_delete", "gap_events_append_only"]) await db.exec(await latestFn(n));
  await db.exec(TRIGGERS);
  await db.exec(mutateMig(MIG_DB));
  return db;
}

const DAY = 86400;
const q = (s: string) => s.replaceAll("'", "''");
const hex = (n: number, len: number) => n.toString(16).padStart(len, "0");
/** 三種臂的 task_id（TW 的指紋 8 碼；duplicate_policy 的鍵是人物 id） */
const lc = (block: number, fp: number) => `auto:lineage_candidate:${hex(block, 12)}:${hex(fp, 8)}`;
const ll = (lower: number, fp: number) => `auto:lineage_link_candidate:00000000-0000-4000-8000-${hex(lower, 12)}:${hex(fp, 8)}`;
const dp = (person: number, fp: number) => `auto:duplicate_policy:00000000-0000-4000-9000-${hex(person, 12)}:${hex(fp, 8)}`;

async function setArms(db: PGlite, ids: string[], opts: { prio?: Record<string, number> } = {}) {
  await db.exec("DELETE FROM _arms; DELETE FROM _prio;");
  for (const [arm, s] of Object.entries(opts.prio ?? {})) await db.exec(`INSERT INTO _prio VALUES ('${arm}', ${s})`);
  for (const id of ids) {
    const kind = id.split(":")[1]!;
    await db.exec(`INSERT INTO _arms VALUES ('${q(id)}', '${kind}', '{"k":1}', '要做的事', ARRAY['h'], 1, NULL, '${kind}', '{"basis":"seed"}')`);
  }
}
const seed = (db: PGlite) => db.exec("SELECT seed_auto_task_queue()");
type Row = { task_id: string; lda: string; n: number; boost: string; qa: string; qsecs: number; ob: Record<string, unknown>; opened_at: string };
async function row(db: PGlite, id: string): Promise<Row | undefined> {
  return (await db.query<Row>(`SELECT task_id, last_dispatched_at::text AS lda, dispatch_count AS n, boost_seconds::text AS boost, queue_at::text AS qa,
    extract(epoch FROM now() - queue_at)::float AS qsecs, opened_by AS ob, opened_at::text AS opened_at FROM task_dispatches WHERE task_id = '${q(id)}'`)).rows[0];
}
const must = async (db: PGlite, id: string) => { const r = await row(db, id); assert(r, `派工列不存在：${id}`); return r; };
/** 把某列調成「很久以前就在排」：進隊時間（與出生時間）往前挪 days 天（觸發器重算 queue_at） */
const age = (db: PGlite, id: string, days: number) =>
  db.exec(`UPDATE task_dispatches SET last_dispatched_at = now() - interval '${days} days', opened_at = now() - interval '${days} days' WHERE task_id = '${q(id)}'`);
/** 模擬 /next 派出一次：派出次數加一、進隊時間＝派出時間（觸發器把插隊歸零並回隊尾）；agoHours＝多久以前派出的 */
const dispatch = (db: PGlite, id: string, agoHours = 0) =>
  db.exec(`UPDATE task_dispatches SET dispatch_count = dispatch_count + 1, last_dispatched_at = now() - interval '${agoHours} hours' WHERE task_id = '${q(id)}'`);
const near = (got: number, want: number, tol: number, msg: string) => assert(Math.abs(got - want) <= tol, `${msg}：得到 ${got.toFixed(1)}，應為 ${want}（±${tol}）`);
const events = async (db: PGlite, id: string) =>
  (await db.query<{ event: string; reason: string | null; detail: Record<string, unknown> }>(`SELECT event, reason, detail FROM gap_events WHERE task_id = '${q(id)}' ORDER BY id`)).rows;

// ---- 劇本（還原驗證要拿它們翻面，所以寫成函式） ----
async function scenarioSameBlockNewFp(db: PGlite) {
  let block = 0;
  for (const [mk, arm] of [[lc, "lineage_candidate"], [ll, "lineage_link_candidate"], [dp, "duplicate_policy"]] as const) {
    // (1) 內容變了、指紋換了，優先秒數也換了：沿用的是進隊時間，不是舊的 queue_at
    const [oldId, newId] = [mk(++block, 0xaaaa0001), mk(block, 0xaaaa0002)];
    await setArms(db, [oldId], { prio: { [arm]: 3 * DAY } });
    await seed(db);
    await age(db, oldId, 5);
    const old = await must(db, oldId);
    near(old.qsecs, 8 * DAY, 60, `${arm}：舊列的排序鍵＝5 天前進隊 − 3 天優先秒數`);
    await setArms(db, [newId], { prio: { [arm]: 1 * DAY } });
    await seed(db);
    assertEquals(await row(db, oldId), undefined, `${arm}：舊列收回`);
    const neu = await must(db, newId);
    assertEquals(neu.lda, old.lda, `${arm}：進隊時間沿用舊列的（不是出生當下）`);
    near(neu.qsecs, 6 * DAY, 60, `${arm}：新列的排序鍵＝沿用的進隊時間（5 天前）− 新的優先秒數 1 天`);
    assert(neu.qsecs > 4 * DAY, `${arm}：沒有被排回隊尾`);
    // gap_events 照舊：舊列 closed、新列 opened 各記一筆；新列的出生依據記接的是誰（rekey_of）
    const oldEv = await events(db, oldId);
    assertEquals(oldEv[oldEv.length - 1]!.event, "closed");
    assertEquals(oldEv[oldEv.length - 1]!.reason, "filled");
    const newEv = await events(db, newId);
    assertEquals(newEv.map((e) => e.event), ["opened"]);
    assertEquals(newEv[0]!.detail["rekey_of"], oldId, `${arm}：opened 的 detail 記 rekey_of`);
    // (2) 優先秒數沒變：queue_at 與舊列逐位相等（「不晚於」取等號）
    const [o2, n2] = [mk(++block, 0xbbbb0001), mk(block, 0xbbbb0002)];
    await setArms(db, [o2], { prio: { [arm]: 1 * DAY } });
    await seed(db);
    await age(db, o2, 5);
    const before = await must(db, o2);
    await setArms(db, [n2], { prio: { [arm]: 1 * DAY } });
    await seed(db);
    const after = await must(db, n2);
    assertEquals(after.qa, before.qa, `${arm}：queue_at 與舊列相等`);
    assert(new Date(after.qa) <= new Date(before.qa), `${arm}：新列不晚於舊列`);
  }
}

async function scenarioChain(db: PGlite) {
  const ids = [lc(7, 0x10000001), lc(7, 0x10000002), lc(7, 0x10000003)];
  await setArms(db, [ids[0]!]);
  await seed(db);
  await age(db, ids[0]!, 9);
  const first = await must(db, ids[0]!);
  for (const id of ids.slice(1)) { await setArms(db, [id]); await seed(db); }
  const last = await must(db, ids[2]!);
  assertEquals(last.lda, first.lda, "連換三次，進隊時間還是最早那一列的");
  assertEquals(last.ob["rekey_of"], ids[1]);
  const same = (await db.query<{ ok: boolean }>(`SELECT (opened_by->>'chain_opened_at')::timestamptz = '${first.opened_at}'::timestamptz AS ok FROM task_dispatches WHERE task_id = '${ids[2]}'`)).rows[0]!.ok;
  assert(same, "chain_opened_at＝整串換號的第一次出生時間");
  near(last.qsecs, 9 * DAY, 60, "排序鍵一直是 9 天前進隊那個位置");
}

async function scenarioDispatchedNoJump(db: PGlite) {
  // 舊列 10 天前出生、一小時前被派出過一次（沒交件）：新列在「一小時前」的位置，不是 10 天前的
  const a = lc(11, 0x20000001), b = lc(11, 0x20000002), peer = lc(12, 0x30000001);
  await setArms(db, [a, peer]);
  await seed(db);
  await age(db, a, 10);
  await age(db, peer, 2);
  await dispatch(db, a, 1);
  const old = await must(db, a);
  assertEquals(old.n, 1);
  near(old.qsecs, 3600, 60, "舊列派出後回隊尾（一小時前）");
  await setArms(db, [b, peer]);
  await seed(db);
  const neu = await must(db, b);
  assertEquals(neu.n, 1, "派出次數沿用");
  assertEquals(neu.lda, old.lda);
  assertEquals(neu.qa, old.qa, "queue_at 與舊列相等（派出後的位置）");
  near(neu.qsecs, 3600, 60, "不插回最前面（沒有回到 10 天前）");
  const p = await must(db, peer);
  assert(p.qsecs > neu.qsecs, "沒被派出過、排了兩天的別格，還是排在這一格前面");
}

async function scenarioBoost(db: PGlite) {
  // 沒被派出過就被插隊（/boost）：插隊跟著走；派出之後（插隊歸零）再換號不繼承
  const a = lc(21, 0x40000001), b = lc(21, 0x40000002), c = lc(21, 0x40000003);
  await setArms(db, [a]);
  await seed(db);
  await db.exec(`UPDATE task_dispatches SET boost_seconds = 157680000 WHERE task_id = '${a}'`);
  await setArms(db, [b]);
  await seed(db);
  const nb = await must(db, b);
  assertEquals(nb.boost, "157680000", "沒派出過的插隊跟著走");
  near(nb.qsecs, 157680000, 60, "仍在最前面");
  await dispatch(db, b);
  assertEquals((await must(db, b)).boost, "0", "派出時插隊歸零");
  await setArms(db, [c]);
  await seed(db);
  const nc = await must(db, c);
  assertEquals(nc.boost, "0", "派出過的不繼承插隊");
  assert(nc.qsecs < 60, "回隊尾（派出時間）");
}

async function scenarioNoCrossInherit(db: PGlite) {
  const a1 = lc(31, 0x50000001), a2 = lc(31, 0x50000002), b1 = lc(32, 0x50000001), b2 = lc(32, 0x50000002), gone = lc(33, 0x50000001), keep = dp(34, 0x50000001), fresh = lc(35, 0x50000009);
  await setArms(db, [a1, b1, gone, keep]);
  await seed(db);
  await age(db, a1, 5); await age(db, b1, 1); await age(db, gone, 8); await age(db, keep, 3);
  const refreshedKeep = (await db.query<{ r: string }>(`SELECT refreshed_at::text AS r FROM task_dispatches WHERE task_id = '${keep}'`)).rows[0]!.r;
  const oa = await must(db, a1), ob = await must(db, b1), ok = await must(db, keep);
  // 同一輪：a、b 兩格各換指紋（兩格的新指紋尾巴一樣），gone 那格消失（沒有新列），fresh 全新出生，keep 沒動
  await setArms(db, [a2, b2, keep, fresh]);
  await seed(db);
  assertEquals((await must(db, a2)).lda, oa.lda, "a 格接 a 格");
  assertEquals((await must(db, b2)).lda, ob.lda, "b 格接 b 格（指紋尾巴相同也不混）");
  assertEquals(await row(db, gone), undefined);
  const f = await must(db, fresh);
  near(f.qsecs, 0, 30, "全新的格子出生當下進隊（沒有人可以接）");
  assertEquals(f.n, 0);
  assertEquals(f.ob["rekey_of"], undefined);
  const k = await must(db, keep);
  assertEquals(k.qa, ok.qa, "沒動的列不動");
  assertEquals((await db.query<{ r: string }>(`SELECT refreshed_at::text AS r FROM task_dispatches WHERE task_id = '${keep}'`)).rows[0]!.r, refreshedKeep, "沒變的列不重寫");
}

async function scenarioNoFingerprintArms(db: PGlite) {
  // 一般臂（沒有指紋）：新 task_id 就是新缺口，不繼承；不在清單的臂就算末段長得像指紋也不繼承；末段太短不像指紋也不繼承
  const pairs: [string, string][] = [
    ["auto:profile_gap:00000000-0000-4000-8000-000000000001", "auto:profile_gap:00000000-0000-4000-8000-000000000002"],
    ["auto:policy_missing:abcdef012345:12345678", "auto:policy_missing:abcdef012345:12345679"],
    ["auto:lineage_candidate:abcdef012345:xyz", "auto:lineage_candidate:abcdef012345:xyw"],
  ];
  for (const [oldId, newId] of pairs) {
    await db.exec("DELETE FROM task_dispatches");
    await setArms(db, [oldId]);
    await seed(db);
    await age(db, oldId, 6);
    await setArms(db, [newId]);
    await seed(db);
    const neu = await must(db, newId);
    near(neu.qsecs, 0, 30, `${oldId.split(":")[1]}：新列出生當下進隊，不繼承`);
    assertEquals(neu.n, 0);
    assertEquals(neu.ob["rekey_of"], undefined);
    assertEquals(await row(db, oldId), undefined);
  }
}

async function scenarioSwitchOff(db: PGlite) {
  const a = lc(41, 0x60000001), b = lc(41, 0x60000002);
  await db.exec("UPDATE queue_settings SET rekey_keep_position = false WHERE id = 1");
  await setArms(db, [a]);
  await seed(db);
  await age(db, a, 5);
  await setArms(db, [b]);
  await seed(db);
  near((await must(db, b)).qsecs, 0, 30, "開關關掉：回到舊行為，新列出生當下進隊");
}

Deno.test("B1 同一格換指紋：新列 queue_at 等於舊列（不晚於）、進隊時間與派出次數沿用、舊列收回新列出生、opened_by 記 rekey_of（三種臂）", async () => {
  const db = await env();
  await scenarioSameBlockNewFp(db);
  await db.close();
});

Deno.test("B1b 連換三次：進隊時間與 chain_opened_at 一直是最早那一列的", async () => {
  const db = await env();
  await scenarioChain(db);
  await db.close();
});

Deno.test("B2 前一列派出過：新列在派出之後的位置（不插回最前）；派出時插隊歸零所以不繼承插隊；沒派出過就被插隊的，插隊跟著走", async () => {
  const db = await env();
  await scenarioDispatchedNoJump(db);
  await db.close();
  const db2 = await env();
  await scenarioBoost(db2);
  await db2.close();
});

Deno.test("B3 不同格不互相繼承：同一輪兩格各自換、第三格全新出生、別的格子消失不影響、沒動的列不重寫", async () => {
  const db = await env();
  await scenarioNoCrossInherit(db);
  await db.close();
});

Deno.test("B4 沒有指紋的臂行為不變；rekey_keep_position＝false 回到舊行為", async () => {
  const db = await env();
  await scenarioNoFingerprintArms(db);
  await db.close();
  const db2 = await env();
  await scenarioSwitchOff(db2);
  await db2.close();
});

Deno.test("B4b 穩定鍵函式：只對帶指紋的臂回傳、末段必須像指紋；三種臂的前後 task_id 穩定鍵相同", async () => {
  const db = await env();
  const key = async (id: string) => (await db.query<{ k: string | null }>(`SELECT task_rekey_stable_key('${q(id)}') AS k`)).rows[0]!.k;
  assertEquals(await key(lc(1, 0xaaaa0001)), `auto:lineage_candidate:${hex(1, 12)}`);
  assertEquals(await key(lc(1, 0xaaaa0001)), await key(lc(1, 0xaaaa0002)));
  assertEquals(await key(dp(3, 1)), `auto:duplicate_policy:00000000-0000-4000-9000-${hex(3, 12)}`);
  assertEquals(await key(ll(2, 1)), await key(ll(2, 2)));
  assert(await key(lc(1, 1)) !== await key(lc(2, 1)), "不同格的穩定鍵不同");
  assertEquals(await key("auto:profile_gap:00000000-0000-4000-8000-000000000001"), null);
  assertEquals(await key("auto:policy_missing:abcdef012345:12345678"), null, "不在清單的臂");
  assertEquals(await key("auto:lineage_candidate:abcdef012345"), null, "沒有末段");
  assertEquals(await key("auto:lineage_candidate:abcdef012345:zz"), null, "末段不像指紋");
  assertEquals(await key("00000000-0000-4000-8000-000000000001"), null, "手動任務");
  assertEquals(await key("verify:00000000-0000-4000-8000-000000000001"), null);
  await db.close();
});

// ---- B5 慢性停擺 ----
type Closed = { arm: string; n: number; lifeHours: number; reason?: string; via?: string; chainHours?: number };
async function addClosed(db: PGlite, c: Closed) {
  for (let i = 0; i < c.n; i++) {
    const id = `auto:${c.arm}:00000000-0000-4000-8000-${hex(Math.floor(Math.random() * 1e9), 12)}:${hex(i, 8)}`;
    const opened = `now() - interval '${c.lifeHours + 1} hours'`;
    const chain = c.chainHours === undefined ? "" : `, 'chain_opened_at', (now() - interval '${c.chainHours} hours')`;
    await db.exec(`INSERT INTO gap_events (task_id, event, at, reason, detail) VALUES ('${id}', 'closed', now() - interval '1 hours', '${c.reason ?? "filled"}',
      jsonb_build_object('opened_at', ${opened}, 'opened_by', jsonb_build_object('basis', 'seed'${chain})${c.via ? `, 'via', '${c.via}'` : ""}))`);
  }
}
const addContribution = (db: PGlite, arm: string, via: "task_id" | "payload", ageDays = 1) =>
  db.exec(`INSERT INTO contributions (contribution_type, task_id, payload, created_at) VALUES ('lineage', ${via === "task_id" ? `'auto:${arm}:x:1'` : "NULL"},
    ${via === "payload" ? `'{"task_id":"auto:${arm}:x:1"}'` : "'{}'"}, now() - interval '${ageDays} days')`);
const stalled = async (db: PGlite) =>
  (await db.query<{ arm: string; closed_rows: number; median_life_hours: string; queue_delay_hours: string; contributions: number; window_days: number }>(
    `SELECT * FROM dispatch_chronic_stall() ORDER BY arm`)).rows;

async function scenarioStall(db: PGlite) {
  // 佇列延遲 14 天：隊頭（非插隊）是 14 天前進隊的；插隊的列（5 年）不算
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, last_dispatched_at, dispatch_count, boost_seconds) VALUES
    ('auto:profile_gap:head', 'profile_gap', now() - interval '14 days', 0, 0), ('auto:profile_gap:boosted', 'profile_gap', now(), 0, 157680000),
    ('auto:profile_gap:later', 'profile_gap', now() - interval '3 days', 0, 0)`);
  const delay = Number((await db.query<{ s: string }>(`SELECT dispatch_queue_delay_seconds() AS s`)).rows[0]!.s);
  near(delay, 14 * DAY, 120, "佇列延遲＝可派隊頭（非插隊）的排序鍵距現在");
  // 每一類各有一個「為什麼列／不列」：
  await addClosed(db, { arm: "stalled_arm", n: 12, lifeHours: 20 });                                  // 該列：12 列、壽命 20 小時、沒交件
  await addClosed(db, { arm: "delivered_arm", n: 12, lifeHours: 20 }); await addContribution(db, "delivered_arm", "task_id"); // 有交件（task_id 欄）
  await addClosed(db, { arm: "payload_arm", n: 12, lifeHours: 20 }); await addContribution(db, "payload_arm", "payload");     // 有交件（只在 payload.task_id）
  await addClosed(db, { arm: "old_contrib_arm", n: 12, lifeHours: 20 }); await addContribution(db, "old_contrib_arm", "task_id", 20); // 交件在窗口之外＝這段期間沒交件，會列
  await addClosed(db, { arm: "long_life_arm", n: 12, lifeHours: 20 * 24 });                           // 壽命 20 天 ≥ 佇列延遲
  await addClosed(db, { arm: "window_arm", n: 12, lifeHours: 20, reason: "window" });                  // 窗口關了：不是被換掉
  await addClosed(db, { arm: "done_arm", n: 12, lifeHours: 20, via: "drop_applied" });                 // 做完收回：不是被換掉
  await addClosed(db, { arm: "chain_arm", n: 12, lifeHours: 20, chainHours: 20 * 24 });                // 整串換號合計 20 天：有被輪到的機會
  await addClosed(db, { arm: "few_arm", n: 3, lifeHours: 20 });                                        // 太少（< 10）
  const rows = await stalled(db);
  assertEquals(rows.map((r) => r.arm), ["old_contrib_arm", "stalled_arm"], "只有「沒交件、壽命短、夠多列」的兩類");
  const s = rows.find((r) => r.arm === "stalled_arm")!;
  assertEquals([s.closed_rows, s.contributions, s.window_days], [12, 0, 7]);
  near(Number(s.median_life_hours), 20, 0.5, "壽命中位數（小時）");
  near(Number(s.queue_delay_hours), 14 * 24, 1, "佇列延遲（小時）");
  // 參數不寫死：門檻、天數、容許交件數都在 queue_settings，改了結果跟著變
  await db.exec("UPDATE queue_settings SET stall_min_closed = 2 WHERE id = 1");
  assertEquals((await stalled(db)).map((r) => r.arm), ["few_arm", "old_contrib_arm", "stalled_arm"], "stall_min_closed 降到 2：少的也列");
  await db.exec("UPDATE queue_settings SET stall_min_closed = 10, stall_max_contributions = 1 WHERE id = 1");
  assertEquals((await stalled(db)).map((r) => r.arm), ["delivered_arm", "old_contrib_arm", "payload_arm", "stalled_arm"], "stall_max_contributions＝1：只有 1 件交件的也列");
  await db.exec("UPDATE queue_settings SET stall_max_contributions = 0, stall_window_days = 30 WHERE id = 1");
  const wide = (await stalled(db)).map((r) => r.arm);
  assert(!wide.includes("old_contrib_arm"), "窗口拉長到 30 天：20 天前的交件算進來，old_contrib_arm 不再停擺");
  assert(wide.includes("stalled_arm"));
  // 佇列延遲短於壽命：不列（隊頭只落後 10 小時，20 小時的壽命已經夠被輪到）
  await db.exec(`UPDATE queue_settings SET stall_window_days = 7 WHERE id = 1; UPDATE task_dispatches SET last_dispatched_at = now() - interval '10 hours' WHERE task_id IN ('auto:profile_gap:head', 'auto:profile_gap:later')`);
  assertEquals((await stalled(db)).map((r) => r.arm), [], "佇列延遲 10 小時：壽命 20 小時的不算慢性停擺");
}

Deno.test("B5 慢性停擺：該列的列得出來（壽命短於佇列延遲、沒交件）；有交件、壽命夠長、窗口關了、做完了、換號串夠長、太少的都不列；參數改了結果跟著變", async () => {
  const db = await env();
  await scenarioStall(db);
  await db.close();
});

// ---- B6 activity_health 視圖本身（整支 migration 的最後一段）在 PGlite 上跑得動、慢性停擺那一列出得來 ----
Deno.test("B6 activity_health 視圖（這支 migration 的原文）建得起來、整張視圖每個分支都能跑，慢性停擺列帶出類型、列數、壽命與佇列延遲", async () => {
  const pre = `
    ALTER TABLE elections ADD COLUMN bulletin_dir text;
    ${await latestFn("roster_scope_milestone_date")}
    CREATE VIEW ballot_number_anomalies AS SELECT NULL::integer AS election_id, NULL::text AS election_type, NULL::text AS kind WHERE false;
    CREATE FUNCTION system_vote_stall() RETURNS TABLE (last_at timestamptz, waiting integer) LANGUAGE sql STABLE AS $f$ SELECT NULL::timestamptz, NULL::integer WHERE false $f$;
    CREATE FUNCTION queue_head_stale_hours() RETURNS integer LANGUAGE sql IMMUTABLE AS $f$ SELECT 6 $f$;
    CREATE FUNCTION queue_head_stale() RETURNS TABLE (head_task_id text, head_task_type text, last_dispatch_at timestamptz) LANGUAGE sql STABLE AS $f$ SELECT NULL::text, NULL::text, NULL::timestamptz WHERE false $f$;
    ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS boost_seconds bigint NOT NULL DEFAULT 0;
    ALTER TABLE contributions ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
    CREATE TABLE queue_settings (id smallint PRIMARY KEY, note text);
    INSERT INTO queue_settings (id) VALUES (1);
    CREATE FUNCTION contribution_queue_tasks(p_type text DEFAULT NULL, p_region text DEFAULT NULL, p_limit integer DEFAULT 20, p_seed text DEFAULT '', p_ip_hash text DEFAULT NULL, p_agent text DEFAULT NULL)
      RETURNS TABLE (task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, queue_at timestamptz) LANGUAGE sql STABLE AS $f$
      SELECT d.task_id, d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.queue_at FROM task_dispatches d
       WHERE d.task_id NOT LIKE 'verify:%' ORDER BY d.queue_at LIMIT p_limit $f$;`;
  const { buildArmsDb } = await import("./arms-pglite.ts");
  const db = await buildArmsDb({ afterP1Sql: pre });
  await db.exec(MIG_DB);
  await db.exec(MIG.slice(MIG.indexOf("CREATE OR REPLACE VIEW activity_health AS")));
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, last_dispatched_at, dispatch_count, queue_at) VALUES ('auto:profile_gap:head', 'profile_gap', now() - interval '14 days', 0, now() - interval '14 days')`);
  await addClosed(db, { arm: "lineage_candidate", n: 12, lifeHours: 20 });
  const all = (await db.query<{ check_name: string; subject: string; detail: string }>(`SELECT check_name, subject, detail FROM activity_health`)).rows;
  const hit = all.filter((r) => r.check_name === "dispatch_chronic_stall");
  assertEquals(hit.length, 1, `視圖整張跑得動，慢性停擺一列：${JSON.stringify(all.map((r) => r.check_name))}`);
  assertEquals(hit[0]!.subject, "lineage_candidate");
  assert(hit[0]!.detail.includes("12 列") && hit[0]!.detail.includes("中位數只有 20") && hit[0]!.detail.includes("佇列延遲 336"), hit[0]!.detail);
  // 沒有停擺時視圖不出這一列（門檻拉高到 100 列）
  await db.exec("UPDATE queue_settings SET stall_min_closed = 100");
  assertEquals((await db.query(`SELECT 1 FROM activity_health WHERE check_name = 'dispatch_chronic_stall'`)).rows.length, 0);
  await db.close();
});

// ============================================================
// C. 還原驗證
// ============================================================
/** 改壞的 migration 跑劇本，必須是「斷言翻面」（AssertionError）：SQL 跑不起來之類的錯不算（不然改壞到語法錯也會過） */
const rejects = async (mutateMig: (s: string) => string, scenario: (db: PGlite) => Promise<void>, msg: string) => {
  const db = await env(mutateMig);
  try {
    const e = await assertRejects(() => scenario(db), Error, undefined, msg);
    assertEquals(e.name, "AssertionError", `${msg}：丟的不是斷言錯誤而是 ${e.name}：${e.message.slice(0, 120)}`);
  } finally { await db.close(); }
};

Deno.test("C1 還原驗證：進隊時間不再沿用（last_dispatched_at 照舊 now()）→ B1／B1b／B2 的劇本翻面", async () => {
  const bad = (s: string) => mutate(s, "COALESCE(r.last_dispatched_at, now())", "now()");
  await rejects(bad, scenarioSameBlockNewFp, "拿掉進隊時間的沿用，同格換指紋的劇本要紅");
  await rejects(bad, scenarioChain, "連換三次的劇本要紅");
  await rejects(bad, scenarioDispatchedNoJump, "派出過的劇本要紅");
});

Deno.test("C2 還原驗證：不繼承派出次數／不繼承插隊／穩定鍵放寬到只看臂名 → 對應劇本翻面", async () => {
  await rejects((s) => mutate(s, "COALESCE(r.dispatch_count, 0),", "0,"), scenarioDispatchedNoJump, "派出次數沒沿用要紅");
  await rejects((s) => mutate(s, "ELSE COALESCE(r.boost_seconds, 0) END", "ELSE 0 END"), scenarioBoost, "沒派出過的插隊沒跟著走要紅");
  // 插隊歸零不是這支的責任（觸發器做的）：繼承時若把派出前的插隊一起帶，派出過的新列會帶著插隊——模擬成「永遠帶 5 年」
  await rejects((s) => mutate(s, "ELSE COALESCE(r.boost_seconds, 0) END", "ELSE (CASE WHEN r.skey IS NULL THEN 0 ELSE 157680000 END) END"), scenarioBoost, "派出過的新列帶著插隊要紅");
  await rejects((s) => mutate(s, "regexp_replace(p_task_id, ':[0-9a-f]{8,32}$', '')", "split_part(p_task_id, ':', 2)"), scenarioNoCrossInherit, "穩定鍵只看臂名（不同格互相繼承）要紅");
});

Deno.test("C3 還原驗證：沒有指紋的臂也被繼承、開關失效 → B4 翻面", async () => {
  await rejects((s) => mutate(s, "AND split_part(p_task_id, ':', 2) = ANY (task_rekey_arms())", ""), scenarioNoFingerprintArms, "臂清單不篩要紅");
  await rejects((s) => mutate(s, "AND COALESCE((SELECT q.rekey_keep_position FROM queue_settings q WHERE q.id = 1), true)", ""), scenarioSwitchOff, "開關不讀要紅");
});

Deno.test("C4 還原驗證：慢性停擺把窗口關了與做完收回的也算、不看整串換號、不看交件 → B5 翻面", async () => {
  await rejects((s) => mutate(s, "e.event = 'closed' AND e.reason = 'filled' AND", "e.event = 'closed' AND"), scenarioStall, "window 也算被換掉要紅");
  await rejects((s) => mutate(s, " AND COALESCE(e.detail->>'via', '') <> 'drop_applied'", ""), scenarioStall, "做完收回也算要紅");
  await rejects((s) => mutate(s, "COALESCE((e.detail->'opened_by'->>'chain_opened_at')::TIMESTAMPTZ, (e.detail->>'opened_at')::TIMESTAMPTZ)", "(e.detail->>'opened_at')::TIMESTAMPTZ"), scenarioStall, "不看整串換號要紅");
  await rejects((s) => mutate(s, "AND COALESCE(c.n, 0) <= s.mx", ""), scenarioStall, "不看交件要紅");
});
