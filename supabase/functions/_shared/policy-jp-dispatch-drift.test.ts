/**
 * 日本站派工 SQL 的走樣守門（policy-jp PR①a；migration 20261009130000_policy_jp_dispatch.sql）。
 *
 * 日本站的派工、啟用時間窗、計分共識、系統票 SQL 是正見（public）現行定義的「抄本」，只允許一份固定清單的機械式替換。
 * 這個測試把 policy_jp 的每支複本函式還原回 public 的樣子，跟 migrations 裡 public 的「最新定義」逐字比對；
 * 之後正見改了其中任何一支，這裡會紅，提醒日本站跟著改（CLAUDE.md：改計分合併後要通知日本站）。
 *
 * 還原用的白名單（只有這幾條，別處都不准）：
 *   R1  拿掉全部 `policy_jp.` 前綴（表、函式、視圖）
 *   R2  plpgsql 函式的 `SET search_path = policy_jp, pg_temp`：SECURITY DEFINER 的還原成 `SET search_path = public`（正見原樣），其餘整段拿掉（正見的 INVOKER 函式沒有這個子句）
 *   R3  'Asia/Tokyo' → 'Asia/Taipei'（activity_today 預設時區、固定時段插隊的時區）
 *   R4  選舉 id 型別 TEXT → INTEGER：`election_id TEXT` → `election_id INTEGER`、`'election_id')::TEXT` → `'election_id')::INTEGER`（日本站的 election id 是 election_key 字串）
 *   另外，每支函式各自的「拿掉台灣專用片段」寫在下面 PAIRS 的 edits（對 public 的定義做精確替換，找不到或找到兩處都算失敗），並附 note 說明為什麼。
 *   拿掉的整類東西：中選會名冊（contribution_roster_matched、batch_verified_by 整批驗證）、號次例外（cand_no）、村里長排除職位（except_election_types）、
 *   流量提層（traffic_boost_apply）、政策脈絡（lineage_handover）、來源等級分支（contribution_source_kind）、台灣專用的貢獻型別風險分級。
 *
 * 不是複本、不比對的（原因）：
 *   - contribution_auto_tasks_arms：總表骨架，只有手動任務臂兩個分支（正見 31 個分支、含測試名人物隔離、村里長流量開窗，整支搬過來沒有意義）；結構照抄，行為由 policy-jp-dispatch.test.ts 測。
 *     20261009130100 重新定義它＝這裡 130000 的版本剛好多一行 election_discovery 的 UNION 分支（機械替換比對在 policy-jp-election-discovery.test.ts）
 *   - contribution_auto_tasks_manual：手動任務臂本體，日本站沒有公民提問（citizen_questions），拿掉 stance_up 與「已收滿答案」排除
 *   - activity_arm_names：日本版只有兩個名字；20261009130100 重新定義它＝多 election_discovery 一個名字（同上）
 *   - contribution_auto_tasks_election_discovery（20261009130100）：日本站自己的新臂（任期満了快到、沒有對應選舉 → 派任務），正見沒有對應物；行為由 policy-jp-election-discovery.test.ts 測
 *   ※ 20261009130100 定義的三支函式由「走樣：選舉發現 migration」一條登記（NONCOPY_ED），新加函式不登記就紅
 *   - election_id_or_null：正見回 integer，日本版回 TEXT
 *   - activity_level／activity_jurisdiction：正見寫死台灣職位與 'tw'，日本版讀 policy_jp.election_level 與 elections.jurisdiction
 *   - 視圖 election_milestones_all／activity_health／gap_open_lateness：沒有 term_*、沒有台灣專用的健康檢查
 *   - 表、觸發器（CREATE TRIGGER）、RLS、權限：日本版自己的定義（表欄位 election_id 是 TEXT、貢獻型別只收三種…）
 *     其中派工紀錄清理的設定表 dispatch_records_settings 欄位、預設值、CHECK 照抄正見，但沒有 "Public read"／"Service role write" 兩條 policy（內部表慣例）；
 *     它的保留天數與排程由 dispatch-records-purge.test.ts 依 schema 分開守，函式 dispatch_records_purge 則是複本（見 PAIRS）
 *   ※ 以上每一項的存在由「migration 裡的函式＝PAIRS＋NONCOPY」一條守住，新加一支函式不登記就紅。
 *   ※ 後面的 policy_jp migration（落庫 20261009210000、缺口臂 20261009210100 等）不得重新定義任何已登記的複本——重新定義＝逃過上面的逐字比對
 *      （「後續 migration 不得重新定義已登記的複本」一條守住）。唯一的例外是登記在 FOLLOWED 的跟進版（正見改了、日本版跟進，逐字比對改讀它）。那兩支的函式登記與機械替換比對在 policy-jp-apply.test.ts。
 *
 * 日本專屬的偏離（DEVIATED，20261009300000，維護者 10-09「最近的選舉先派」）：rebalance_queue（層內排序鍵 queue_at → 步驟順位 → 日期 → queue_at）與
 * seed_auto_task_queue（選舉發現／等團體落庫的選舉沒有 polling 里程碑，多一段用 target 日期定層）在日本版多了標記的片段，台灣沒有選舉鏈、不跟。
 * 這兩支仍在 PAIRS（跟正見的逐字比對讀「緊接在前的那一版」），另由 DEVIATED 守「偏離版 ＋ 登記的 jpEdits ＝ 緊接在前的那一版，逐字」，偏離只能是登記的幾處。
 *
 * 日本專屬清單（JP_ONLY，檔尾；主線審查條件）：上面的 NONCOPY／NONCOPY_ED 只管 130000、130100 兩支 migration，之後的 migration（落庫、缺口臂、機器核對、選舉鏈…）
 * 新增的函式與視圖沒有人點名。所以掃描「所有」檔名帶 _policy_jp_ 的 migration（去掉 SQL 註解），每個 `CREATE [OR REPLACE] FUNCTION／VIEW policy_jp.<名>`
 * 都必須是下面兩種之一，否則整支測試紅：
 *   ① 複本——PAIRS（130000）、FOLLOWED（跟進版）、OTHER_COPIES（公開統計 200000，逐字比對在 policy-jp-public-stats.test.ts）；
 *   ② 日本專屬——登記在 JP_ONLY，附一行理由與「定義它的 migration 清單」（被後面的 migration 重新定義就要多寫一個，搬動或重定義會看得見）。
 * 兩邊不得重複；登記了卻再也沒有 migration 定義的名字（改名、刪除）也會紅。偵測器本身有還原驗證（假 migration 夾一支新函式／新視圖／漏前綴就抓得到）。
 * 選舉鏈（250400）的臂、總表、進度視圖逐一登記，不用「整支 migration 都放行」的寫法。
 */
import { assert, assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert@1";
import { fnText, latestFn, migrationNames as listMigrations, readMig } from "./arms-pglite.ts";

const MIG = "20261009130000_policy_jp_dispatch.sql";
const MIG_SQL = await readMig(MIG);
const MIG_ED = "20261009130100_policy_jp_election_discovery.sql";
const ED_SQL = await readMig(MIG_ED);
/** 20261009130100 定義的函式（都不是複本：新臂，加上 130000 那兩支非複本的新版本） */
const NONCOPY_ED = ["activity_arm_names", "contribution_auto_tasks_arms", "contribution_auto_tasks_election_discovery"];

/** 130000 之後正見又改過、日本版跟進的複本：函式名 → 跟進的 migration（#490：rebalance_queue 零驗證列時起點退回 1.5 秒）。走樣比對改讀跟進版 */
const FOLLOW_MIG = "20261009150100_policy_jp_rebalance_anchor.sql";
const FOLLOW_SQL = await readMig(FOLLOW_MIG);
const FOLLOWED: Record<string, string> = { rebalance_queue: FOLLOW_SQL };

/**
 * 日本專屬的偏離（20261009300000，維護者 10-09「最近的選舉先派」）：rebalance_queue、seed_auto_task_queue 在日本版多了標記的片段，
 * 不再逐字等於正見（走樣比對仍讀它們「緊接在前的那一版」＝FOLLOWED／130000，所以跟正見的逐字比對不動）。
 * 這裡另外守：偏離版 ＋ 登記的 jpEdits（把日本專屬片段換回原樣）＝緊接在前的那一版，逐字。偏離只能是登記的這幾處，別處一個字都不准動。
 */
const DEV_MIG = "20261009300000_policy_jp_chain_priority.sql";
const DEV_SQL = await readMig(DEV_MIG);
const DEVIATED: Record<string, { prev: string; why: string; jpEdits: Edit[] }> = {
  rebalance_queue: {
    prev: FOLLOW_SQL,
    why: "層內排序鍵 queue_at → 步驟順位 → 日期 → queue_at（最近的選舉先派；手動任務步驟 0 仍排同層最前、照 queue_at）。台灣沒有選舉鏈，不跟",
    jpEdits: [
      [
        ",\n           policy_jp.chain_step_rank(d.task_id, d.task_type) AS srank, policy_jp.chain_sort_date(d.task_id, d.target) AS sdate  -- 日本版：層內排序鍵\n      FROM",
        "\n      FROM",
      ],
      [
        "ORDER BY w.srank, w.sdate NULLS LAST, w.queue_at, w.task_id) AS k FROM w  -- 日本版：同層內 步驟 → 日期 → 先進先出",
        "ORDER BY w.queue_at, w.task_id) AS k FROM w",
      ],
    ],
  },
  seed_auto_task_queue: {
    prev: MIG_SQL,
    why: "選舉發現的缺口沒有選舉列（沒有 polling 里程碑，規則算不出層），seed 多一段用 target 的 vote_window_from 定層（chain_date_tier）。台灣沒有這支臂",
    jpEdits: [{
      span: ["  -- >>> 日本版：選舉發現的層\n", "  -- <<< 日本版：選舉發現的層\n\n"],
      with: "",
    }],
  },
};

/** 不比對的函式（原因見檔頭） */
const NONCOPY = [
  "election_id_or_null", "activity_level", "activity_jurisdiction", "activity_arm_names", "contribution_auto_tasks_manual", "contribution_auto_tasks_arms",
];
const TABLES = [
  "task_priority_tiers", "contributions", "contribution_votes", "edit_history", "contribution_tasks", "contribution_task_leases", "contribution_task_skips",
  "verify_dispatches", "task_checks", "jev_decisions", "task_dispatches", "gap_events", "election_milestones_all", "election_milestones", "activity_rules",
  "activity_overrides", "elections", "dispatch_records_settings",
];

// ---- 對照表（產生器與這個測試共用同一份文字；edits 是對 public 定義的精確替換） ----
// 走樣守門與產生器共用的對照表（產生器在 scratchpad；測試檔內嵌同一份）
type Edit = [string, string] | { span: [string, string]; with: string };
type Pair = { name: string; before?: string; edits?: Edit[]; note?: string };

const VILLAGE = "20261009010000_village_chief_progress_cooling.sql";
const LEGACY = "20261009060000_verify_pool_legacy_hash.sql";

const PAIRS: Pair[] = [
  { name: "activity_today" },
  { name: "activity_status_rank" },
  { name: "activity_audit" },
  { name: "activity_touch_updated_at" },
  { name: "activity_require_rule" },
  {
    name: "activity_open",
    note: "拿掉排除職位那一行（except_election_types 欄是村里長專用，日本版 activity_rules 沒有這欄）",
    edits: [[
      "       AND (r.except_election_types IS NULL OR p_election_type IS NULL OR NOT (p_election_type = ANY (r.except_election_types)))  -- 排除職位：職位未知（NULL）時不排除，寧可開著也不無聲關掉\n",
      "",
    ]],
  },
  { name: "activity_priority" },
  { name: "queue_now" },
  { name: "queue_slot" },
  { name: "task_dispatched" },
  { name: "contribution_queue_at" },
  { name: "refresh_dispatch_blocked", before: VILLAGE, note: "取村里長進度冷卻（task_cooldown_settings，台灣專用）之前的版本（20261002000006 的冷卻寫法）" },
  { name: "refresh_verify_targets" },
  { name: "rebalance_queue" },
  { name: "visitor_front_slot_hours" },
  { name: "visitor_front_window_minutes" },
  { name: "visitor_front_at" },
  { name: "visitor_front_slot_start" },
  { name: "manual_task_is_visitor" },
  { name: "manual_front_at" },
  { name: "manual_front_pull" },
  { name: "manual_task_closes_on_applied" },
  {
    name: "seed_auto_task_queue",
    note: "拿掉流量提層一段（traffic_boost_apply，台灣專用）",
    edits: [{ span: ["  -- >>> 流量提層", "  -- <<< 流量提層\n\n"], with: "" }],
  },
  { name: "contribution_queue_tasks" },
  { name: "contribution_queue_task_counts" },
  { name: "contribution_auto_tasks" },
  { name: "contribution_verify_pool", before: LEGACY, note: "取加 p_legacy_ip_hash（#484，台灣 IP 雜湊過渡）之前的版本" },
  { name: "contribution_vote_weight" },
  { name: "contribution_reject_floor" },
  {
    name: "contribution_required_agree",
    note: "只留日本版的三個型別（no_change／task_suggestion→2，correction→3）：拿掉 contribution_source_kind、台灣專用的風險分級與回傳 CASE 的來源等級分支",
    edits: [
      ["  v_risk TEXT; v_kind TEXT;", "  v_risk TEXT;"],
      ["  v_kind := contribution_source_kind(p_source_urls);\n", ""],
      { span: ["    WHEN p_type = 'adjudication' THEN 'adjudication'\n", "'[{\"field\":\"candidate_status\"}]'::jsonb)) THEN 'high'\n"], with: "" },
      ["    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'", "    WHEN p_type IN ('task_suggestion', 'no_change') THEN 'light'"],
      {
        span: ["    WHEN v_risk = 'normal' THEN CASE", "    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END\n"],
        with: "    WHEN v_risk = 'normal' THEN 3\n    WHEN v_risk = 'light' THEN 2\n",
      },
    ],
  },
  {
    name: "contribution_needs_two_ips",
    note: "拿掉 lineage_handover 一句（政策脈絡是台灣專用）",
    edits: [["'reassign_candidacy')\n      OR (p_type = 'lineage_handover' AND COALESCE(p_payload->>'handover_type', '') = 'stop')", "'reassign_candidacy')"]],
  },
  { name: "system_one_min_probability" },
  { name: "system_vote_eligible" },
  { name: "contribution_system_vote" },
  {
    name: "contribution_effective_agree",
    // 2026-10-09（policy-ops#39）正見改成「多個獨立來源降 1～2」，日本站先不跟（主線裁定：日本站暫不做），所以比對 20261009320000 之前的版本
    before: "20261009320000_independent_sources_target.sql",
    note: "只拿掉中選會名冊那條路（contribution_roster_matched）；系統票調門檻的邏輯照抄。取多個獨立來源（20261009320000，日本站暫不跟）之前的版本",
    edits: [[
      "RETURN CASE WHEN v_sys = 'supported' AND contribution_roster_matched(p_contribution_id) THEN LEAST(v_need, 1)\n              WHEN v_sys = 'supported' THEN",
      "RETURN CASE WHEN v_sys = 'supported' THEN",
    ]],
  },
  {
    name: "contribution_apply_consensus",
    note: "拿掉中選會名冊兩處（contribution_roster_matched 例外、batch_verified_by 整批驗證分支）",
    edits: [
      [
        "      AND (NOT contribution_needs_two_ips(v_type, v_payload) OR v_ips >= 2 OR contribution_roster_matched(p_contribution_id)) THEN",
        "      AND (NOT contribution_needs_two_ips(v_type, v_payload) OR v_ips >= 2) THEN",
      ],
      { span: ["    ELSIF (SELECT batch_verified_by", "      v_new := 'verified';\n"], with: "" },
    ],
  },
  {
    name: "task_dispatches_drop_applied",
    note: "拿掉補號次（cand_no，台灣專用）的例外",
    edits: [{ span: ["       (NEW.task_id LIKE 'auto:%'\n", "cand_no%')\n"], with: "       (NEW.task_id LIKE 'auto:%')\n" }],
  },
  { name: "task_target_key" },
  { name: "task_check_cooldown_days" },
  { name: "task_unreachable_cooldown_days" },
  { name: "contribution_task_leases_purge" },
  { name: "dispatch_records_purge" },
  { name: "task_dispatches_gap_before_insert" },
  { name: "task_dispatches_gap_after_insert" },
  { name: "task_dispatches_gap_after_delete" },
  { name: "gap_events_append_only" },
  { name: "contribution_queue_row" },
  { name: "contribution_votes_trg" },
  { name: "contribution_votes_set_weight" },
  { name: "contribution_tasks_drop_dispatch" },
  { name: "contribution_tasks_insert_dispatch" },
];

/** 精確改一處（出現次數必須剛好一次）；span：從起點標記（唯一）到其後第一個終點標記，整段（含兩端）換成 with */
function applyEdits(src: string, edits: Edit[] = []): string {
  let s = src;
  for (const e of edits) {
    if (Array.isArray(e)) {
      const n = s.split(e[0]).length - 1;
      if (n !== 1) throw new Error(`要改的字串必須剛好出現一次（出現 ${n} 次）：${e[0].slice(0, 70)}`);
      s = s.replace(e[0], () => e[1]);
    } else {
      const [a, b] = e.span;
      const n = s.split(a).length - 1;
      if (n !== 1) throw new Error(`span 起點必須剛好出現一次（出現 ${n} 次）：${a.slice(0, 70)}`);
      const i = s.indexOf(a);
      const j2 = s.indexOf(b, i);
      if (j2 < 0) throw new Error(`span 終點找不到：${b.slice(0, 70)}`);
      s = s.slice(0, i) + e.with + s.slice(j2 + b.length);
    }
  }
  return s;
}

/** 還原：白名單 R1～R4 */
function reverse(jp: string): string {
  let s = jp;
  s = s.replaceAll(" SECURITY DEFINER SET search_path = policy_jp, pg_temp", " SECURITY DEFINER SET search_path = public"); // R2（DEFINER）
  s = s.replaceAll(" SET search_path = policy_jp, pg_temp", ""); // R2（INVOKER：正見沒有這個子句）
  s = s.replaceAll("policy_jp.", ""); // R1
  s = s.replaceAll("'Asia/Tokyo'", "'Asia/Taipei'"); // R3
  s = s.replaceAll("election_id TEXT", "election_id INTEGER").replaceAll("'election_id')::TEXT", "'election_id')::INTEGER"); // R4
  return s;
}

const jpBody = (name: string) => fnText(FOLLOWED[name] ?? MIG_SQL, `policy_jp.${name}`);

for (const p of PAIRS) {
  Deno.test(`走樣 ${p.name}：還原後＝public 的${p.before ? `（${p.before.slice(0, 14)} 之前的）` : "現行"}定義${p.edits?.length ? "（扣掉登記的台灣專用片段）" : ""}`, async () => {
    const expected = applyEdits(await latestFn(p.name, p.before), p.edits);
    assertEquals(reverse(jpBody(p.name)), expected);
    if (p.edits?.length) assert(p.note, `${p.name} 有拿掉片段，必須寫 note 說明為什麼`);
  });
}

for (const [name, v] of Object.entries(DEVIATED)) {
  Deno.test(`走樣（日本專屬偏離）${name}：偏離版 ＋ 登記的 jpEdits ＝ 緊接在前的那一版（逐字）；jpEdits 有效、不登記的偏離會紅`, () => {
    assert(PAIRS.some((p) => p.name === name), `${name} 要在複本清單 PAIRS 裡（偏離＝複本加登記的日本專屬片段）`);
    assert(v.why.length > 10 && v.jpEdits.length > 0);
    const dev = fnText(DEV_SQL, `policy_jp.${name}`);
    const prev = fnText(v.prev, `policy_jp.${name}`);
    assertEquals(applyEdits(dev, v.jpEdits), prev);
    assertNotEquals(dev, prev, "偏離版跟前一版一樣＝沒偏離，不用登記");
    // 還原驗證：偏離版悄悄多改一個字（登記外的偏離），或登記的片段被改掉，就對不上
    assertNotEquals(applyEdits(dev.replace("FROM _gaps g", "FROM _gaps g /* x */").replace("SELECT d.task_id", "SELECT d.task_id /* x */"), v.jpEdits), prev);
  });
}

Deno.test("走樣（日本專屬偏離）：20261009300000 定義的函式＝登記的偏離複本＋JP_ONLY 登記的日本專屬函式；偏離的複本不能是別的 migration 跟進版", () => {
  const defined = [...DEV_SQL.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]);
  const dev = Object.keys(DEVIATED);
  const copies = new Set(PAIRS.map((p) => p.name));
  for (const n of defined) {
    if (copies.has(n)) assert(dev.includes(n), `${n} 是複本，在 ${DEV_MIG} 重新定義要登記到 DEVIATED（附 jpEdits）`);
    else assert(JP_ONLY[n]?.mig.includes(T_PRIO), `${n} 要登記在 JP_ONLY，mig 含 ${T_PRIO}`);
    assert(fnText(DEV_SQL, `policy_jp.${n}`).includes("SET search_path = policy_jp, pg_temp"), `${n} 沒釘 search_path`);
  }
  for (const n of dev) assert(defined.includes(n), `${n} 登記了偏離卻沒有定義`);
  const stripped = DEV_SQL.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(stripped) && !/search_path\s*=\s*public/i.test(stripped), "不碰 public");
});

/** 設定表 dispatch_records_settings 的建表敘述（CREATE TABLE … ( … );）：欄位、預設值、CHECK 範圍 */
const settingsDdl = (sql: string, name: string): string => {
  const a = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  assert(a >= 0, `找不到 ${name} 的建表`);
  return sql.slice(a, sql.indexOf("\n);", a) + 3);
};

Deno.test("走樣：派工紀錄清理的設定表 dispatch_records_settings（欄位、預設、CHECK）還原後＝正見建表（保留天數與下限不能悄悄各走各的）", async () => {
  const pub = settingsDdl(await readMig("20261009080000_dispatch_records_purge.sql"), "dispatch_records_settings");
  const jp = settingsDdl(MIG_SQL, "policy_jp.dispatch_records_settings");
  assertEquals(reverse(jp), pub);
  // 還原驗證：預設值或 CHECK 下限改一個數字就紅
  assertNotEquals(reverse(jp.replace("DEFAULT 14 CHECK (verify_dispatches_days BETWEEN 8 AND 365)", "DEFAULT 14 CHECK (verify_dispatches_days BETWEEN 2 AND 365)")), pub);
  assertNotEquals(reverse(jp.replace("task_skips_days        INTEGER NOT NULL DEFAULT 7 ", "task_skips_days        INTEGER NOT NULL DEFAULT 3 ")), pub);
});

Deno.test("走樣：migration 裡的 policy_jp 函式＝登記的複本＋登記的非複本（新加函式不登記就紅）", () => {
  const defined = [...MIG_SQL.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]).sort();
  const registered = [...PAIRS.map((p) => p.name), ...NONCOPY].sort();
  assertEquals(defined, registered);
  assertEquals(new Set(registered).size, registered.length, "登記重複");
});

Deno.test("走樣：跟進 migration（20261009150100）只定義登記的跟進複本，每支都在複本清單裡、前綴與 search_path 照 130000 的慣例，沒有 public. 引用", () => {
  const defined = [...FOLLOW_SQL.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, Object.keys(FOLLOWED).sort());
  const copies = new Set(PAIRS.map((p) => p.name));
  for (const n of defined) {
    assert(copies.has(n), `${n} 要在複本清單裡`);
    assert(fnText(FOLLOW_SQL, `policy_jp.${n}`).includes("SET search_path = policy_jp, pg_temp"), `${n} 沒釘 search_path`);
  }
  const stripped = FOLLOW_SQL.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(stripped) && !/search_path\s*=\s*public/i.test(stripped));
  assert(!/\b(ALTER|GRANT|REVOKE|CREATE (OR REPLACE )?(VIEW|TRIGGER)|DROP (FUNCTION|VIEW|TRIGGER|TABLE (?!IF EXISTS _)))\b/i.test(stripped), "跟進只換函式本體，權限沿用 130000 的");
});

Deno.test("走樣：選舉發現 migration（20261009130100）定義的函式＝登記的三支非複本（新加函式不登記就紅）；它們都不在複本清單裡", () => {
  const defined = [...ED_SQL.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, [...NONCOPY_ED].sort());
  const copies = new Set(PAIRS.map((p) => p.name));
  for (const n of NONCOPY_ED) assert(!copies.has(n), `${n} 是非複本，不能同時登記成複本`);
  // 其中兩支（總表、臂名清單）130000 就有一版，登記的非複本（NONCOPY）也要包含
  for (const n of ["activity_arm_names", "contribution_auto_tasks_arms"]) assert(NONCOPY.includes(n));
});

Deno.test("獨立：選舉發現 migration 的函式、表都沒有 public. 引用，也沒有不帶前綴的表引用", () => {
  const stripped = ED_SQL.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(stripped), "migration 不能引用 public.");
  assert(!/search_path\s*=\s*public/i.test(stripped), "不能有 search_path = public");
  for (const p of NONCOPY_ED) {
    const t = fnText(ED_SQL, `policy_jp.${p}`).replace(/--[^\n]*/g, "");
    const bare = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(?:${[...TABLES, "term_expirations"].join("|")})\\b`, "i").exec(t);
    assertEquals(bare, null, `${p}：有不帶 policy_jp. 前綴的表引用 ${bare?.[0]}`);
    // 熱路徑函式都是 LANGUAGE sql，釘 search_path 的方式跟 130000 一致（總表不加 SET、臂與臂名清單加）
    if (p !== "contribution_auto_tasks_arms") assert(t.includes("SET search_path = policy_jp, pg_temp"), `${p} 沒釘 search_path`);
    else assert(!/SET search_path/.test(t), "總表（LANGUAGE sql 熱路徑）不加 SET，跟 130000 一致");
  }
});

Deno.test("走樣：refresh_dispatch_blocked／contribution_verify_pool 取的是較早的版本（有明確登記），而且 public 確實有更新的版本", async () => {
  for (const p of PAIRS.filter((x) => x.before)) {
    const later = await latestFn(p.name);
    const earlier = await latestFn(p.name, p.before);
    assertNotEquals(later, earlier, `${p.name}：public 沒有更新的版本了，before 登記可以拿掉`);
    assert(p.note, `${p.name} 的 before 要寫 note`);
  }
});

Deno.test("獨立：複本與非複本的函式、視圖、觸發器、表都沒有 public. 引用；也沒有不帶前綴的表引用", () => {
  const body = MIG_SQL.slice(0, MIG_SQL.indexOf("-- 自我檢查：做錯就讓這支 migration 失敗")); // 自我檢查那段會「提到」public. 這個字樣
  const stripped = body.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(stripped), "migration 不能引用 public.");
  assert(!/search_path\s*=\s*public/i.test(stripped), "不能有 search_path = public");
  for (const p of [...PAIRS.map((x) => x.name), ...NONCOPY]) {
    const t = jpBody(p).replace(/--[^\n]*/g, "");
    const bare = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(?:${TABLES.join("|")})\\b`, "i").exec(t);
    assertEquals(bare, null, `${p}：有不帶 policy_jp. 前綴的表引用 ${bare?.[0]}`);
  }
});

Deno.test("走樣：plpgsql 函式一律釘 search_path = policy_jp, pg_temp；SECURITY DEFINER 的只有正見原本就是的", async () => {
  for (const p of PAIRS) {
    const pub = await latestFn(p.name, p.before);
    const jp = jpBody(p.name);
    if (/LANGUAGE plpgsql/.test(jp)) assert(jp.includes("SET search_path = policy_jp, pg_temp"), `${p.name} 沒釘 search_path`);
    else assert(!/SET search_path/.test(jp), `${p.name}：LANGUAGE sql 的熱路徑函式不加 SET（每個引用都帶前綴）`);
    assertEquals(/SECURITY DEFINER/.test(jp), /SECURITY DEFINER/.test(pub), `${p.name}：SECURITY DEFINER 要跟正見一樣`);
  }
});

Deno.test("還原驗證：函式本體改一個字，走樣比對就會紅（每支複本都試）", async () => {
  let n = 0;
  for (const p of PAIRS) {
    const expected = applyEdits(await latestFn(p.name, p.before), p.edits);
    const jp = jpBody(p.name);
    const bent = jp.replace("AS $$", "AS $$ "); // 一個字元
    assertNotEquals(bent, jp, `${p.name}：還原驗證沒改到東西`);
    assertNotEquals(reverse(bent), expected, `${p.name}：改了一個字元卻沒被抓到`);
    n++;
  }
  assertEquals(n, PAIRS.length);
  // 語意上的改動也抓得到
  const open = jpBody("activity_open");
  const edits: [string, string][] = [
    ["p_today >= f.on_date + r.from_offset", "p_today > f.on_date + r.from_offset"],
    ["policy_jp.activity_status_rank(", "policy_jp.activity_level("],
  ];
  const exp = applyEdits(await latestFn("activity_open"), PAIRS.find((x) => x.name === "activity_open")!.edits);
  for (const [a, b] of edits) assertNotEquals(reverse(open.replace(a, b)), exp);
  // 白名單以外的替換也抓得到：時區寫成別的、型別少換一處
  const today = jpBody("activity_today");
  assertNotEquals(reverse(today.replace("'Asia/Tokyo'", "'Asia/Seoul'")), await latestFn("activity_today"));
  assertNotEquals(reverse(open.replace("p_election_id TEXT", "p_election_id BIGINT")), exp, "型別換成白名單以外的值要被抓到");
});

Deno.test("edits 本身有守門：找不到或找到兩處都會丟錯（登記的片段跟 public 現行定義對不上就紅）", () => {
  let threw = 0;
  for (const bad of [[["不存在的字串", ""]] as Edit[], [["SELECT", ""]] as Edit[], [{ span: ["不存在", "也不存在"], with: "" }] as Edit[]]) {
    try { applyEdits("SELECT 1 SELECT 2", bad); } catch { threw++; }
  }
  assertEquals(threw, 3);
});

Deno.test("走樣：後續的 policy_jp migration 不得重新定義已登記的複本（重新定義＝逃過逐字比對）；非複本（臂名清單、總表）才能被後面的 migration 重新定義", async () => {
  const { migrationNames } = await import("./arms-pglite.ts");
  const copies = new Set(PAIRS.map((p) => p.name));
  const later = (await migrationNames()).filter((n) => n.includes("_policy_jp_") && n !== MIG && n !== MIG_ED);
  assert(later.includes("20261009210000_policy_jp_apply.sql") && later.includes("20261009210100_policy_jp_gap_arms.sql"), "抓得到後續的 policy_jp migration");
  const offenders: string[] = [];
  for (const name of later) {
    const sql = await readMig(name);
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)) {
      // 例外只有登記過的跟進版（FOLLOWED：那個檔的定義就是逐字比對讀的那一份）
      if (copies.has(m[1]) && !(name === FOLLOW_MIG && m[1] in FOLLOWED) && !(name === DEV_MIG && m[1] in DEVIATED)) offenders.push(`${name}：${m[1]}`);
    }
  }
  assertEquals(offenders, [], "已登記的複本要改，就去改走樣守門的登記（PAIRS 加 edits／before，或照 FOLLOWED 登記跟進版），不要在後面的 migration 悄悄重新定義");
  assert(later.includes(FOLLOW_MIG), "跟進版也在掃描範圍裡（放行靠登記，不是靠沒掃到）");
  // 偵測器自己也驗一次：把一個複本函式名放進假的檔案文字，抓得到
  const fake = "CREATE OR REPLACE FUNCTION policy_jp.contribution_required_agree(p_type TEXT) RETURNS INTEGER";
  assertEquals([...fake.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]).filter((n) => copies.has(n)), ["contribution_required_agree"]);
});

// =====================================================================================================================
// 日本專屬清單（JP_ONLY）：所有 policy_jp migration 定義的函式與視圖，不是複本就一定要在這裡點名（檔頭最後一段）
// =====================================================================================================================
/** migration 檔名 → 14 碼時間戳（清單裡一律寫時間戳，檔名太長） */
const ID = (file: string) => file.slice(0, 14);
const T_TABLES = "20261009000000"; // 20261009000000_policy_jp_tables.sql
const T_DISPATCH = ID(MIG); // 130000
const T_ED = ID(MIG_ED); // 130100
const T_STATS = "20261009200000"; // 公開統計
const T_APPLY = "20261009210000";
const T_ARMS = "20261009210100";
const T_LGR = "20261009250000";
const T_STR = "20261009250200";
const T_CHAIN = "20261009250400";
const T_SAME = "20261009280000"; // 同一件事（#521）
const T_PRIO = "20261009300000"; // 選舉鏈依投票日遠近派工（層＋層內順序）
const T_SAME2 = "20261009280100"; // 同一件事第二步：收編（#521，policy-ops#24）
const T_CONSOLE = "20261010010000"; // 主控台日本站（#518 第二步）

type JpOnly = { mig: string[]; why: string };

/**
 * 公開統計 migration（T_STATS）的複本：逐字比對在 policy-jp-public-stats.test.ts 的 PAIRS，這裡只登記名字（不重複比對）。
 * contribution_leaderboard 有兩個多載（天數版、區間版），用名字登記。下面另有檢查：這些名字只在 T_STATS 定義、而且那支測試真的登記了它們。
 */
const OTHER_COPY_GUARD = "policy-jp-public-stats.test.ts";
const OTHER_COPIES = [
  "model_display_name", "contribution_leaderboard", "contribution_feed_summary", "contribution_activity", "model_contribution_stats", "model_vote_stats",
  "contribution_auto_task_counts", "pipeline_take_snapshot",
];

/**
 * 不是正見複本的函式與視圖：名字 → { mig：定義它的 migration（被後面的 migration 重新定義就要多寫一個）, why：一行理由 }。
 * （視圖）標在理由開頭。130000／130100 的非複本函式也登記在這裡（跟檔頭的 NONCOPY／NONCOPY_ED 互相對照，見下面的測試）。
 */
const JP_ONLY: Record<string, JpOnly> = {
  // ---- 20261009000000 tables：建表用的共用函式與健康檢查視圖 ----
  touch_updated_at: { mig: [T_TABLES], why: "各表共用的 updated_at 觸發器函式（建表用）" },
  lg_code_valid: { mig: [T_TABLES], why: "全国地方公共団体コード 6 碼的檢查碼驗證（團體碼欄位的 CHECK 用）；TS 版 _shared/jp/lg-code.ts 有對齊測試" },
  election_level: { mig: [T_TABLES], why: "選舉種類 → 層級（national／regional／local）的單一真相；正見的 activity_level 寫死台灣職位，日本版的 activity_level 改讀它" },
  source_refs_orphans: { mig: [T_TABLES], why: "（視圖）出處引用指到不存在資料列的健康檢查，正常是空的；target_table 清單是日本站的表" },
  source_archive_missing: { mig: [T_TABLES], why: "（視圖）選挙公報・選管公告類還沒有 archive_url 的出處，正常是空的；排程存檔補上" },

  // ---- 20261009130000 dispatch：派工骨架裡不是複本的部分（原因見檔頭「不是複本、不比對的」） ----
  election_id_or_null: { mig: [T_DISPATCH], why: "派工 target 的 election_id 轉 TEXT（空字串＝沒有）；日本站選舉 id 是 election_key 字串，正見同名函式回 integer" },
  activity_level: { mig: [T_DISPATCH], why: "層級改讀 election_level；正見版寫死台灣職位" },
  activity_jurisdiction: { mig: [T_DISPATCH], why: "管轄改讀 elections.jurisdiction（CHECK 固定 'jp'）；正見版寫死 'tw'" },
  contribution_auto_tasks_manual: { mig: [T_DISPATCH], why: "手動任務臂本體；日本站沒有公民提問，拿掉 stance_up 與「已收滿答案」排除（正見版的簡化）" },
  election_milestones_all: { mig: [T_DISPATCH], why: "（視圖）規則讀的里程碑全貌（存的里程碑＋投票日）；沒有 term_* 任期里程碑（日本站的任期要從 politician_offices 來，還沒做）" },
  activity_health: { mig: [T_DISPATCH], why: "（視圖）派工時間窗的健康檢查，正常是空的；只有通用幾項，沒有 roster／公報／號次／村里長的台灣專用檢查" },
  gap_open_lateness: { mig: [T_DISPATCH], why: "（視圖）缺口出生對帳（規則說該開的日子 vs 實際出生差超過 1 天），日界用 Asia/Tokyo" },
  activity_arm_names: { mig: [T_DISPATCH, T_ED, T_ARMS], why: "臂名清單，日本站只有自己的臂（正見 36 個）；130100 加 election_discovery、210100 加 local_government_missing／regional_stats_missing" },
  contribution_auto_tasks_arms: { mig: [T_DISPATCH, T_ED, T_ARMS, T_CHAIN], why: "派工總表骨架（正見 31 個分支）：130000 只有兩支手動任務臂，130100 加 election_discovery，210100 加兩支缺口臂，250400 加選舉鏈 gate 一段（>>> 選舉鏈 … <<<）" },

  // ---- 20261009130100 election_discovery：日本站自己的新臂 ----
  contribution_auto_tasks_election_discovery: { mig: [T_ED, T_ARMS], why: "臂：任期満了快到、沒有對應選舉的團體 → 派 election_discovery（正見沒有對應物）；210100 加 task_unavailable 排除（#503，cap 套在可派的缺口上）" },

  // ---- 20261009200000 public_stats：唯一不是複本的一支 ----
  pipeline_snapshots_since: { mig: [T_STATS], why: "管線快照的公開讀取（下界 90 天、上限 1000 筆）；正見把 pipeline_snapshots 開成 Public read 表，日本站不對 anon 開表，改由這支 SECURITY DEFINER 函式代讀（public-stats 測試的 NONCOPY）" },

  // ---- 20261009210000 apply：落庫（SQL 函式，一個交易；正見的落庫是 TS 版 apply-contribution.ts） ----
  lg_pref_code: { mig: [T_APPLY], why: "團體碼 → 所屬都道府県碼（前 2 碼＋000＋檢查碼）；TS 版 _shared/jp/lg-code.ts 有對齊測試" },
  local_government_slug: { mig: [T_APPLY], why: "團體的網址 slug：市區町村用團體碼、47 都道府県用固定羅馬字（與 policy-jp prefectures.ts 同一份）" },
  regional_stat_unit: { mig: [T_APPLY], why: "地域統計 stat_key → 唯一單位（人／km2／千円／%），交件與落庫都對這張表" },
  apply_max_retries: { mig: [T_APPLY], why: "落庫重試次數（3），對齊正見 consensus.ts 的 APPLY_MAX_RETRIES（測試對齊）" },
  apply_retry_delay_minutes: { mig: [T_APPLY], why: "落庫重試間隔（10 分鐘），對齊正見 consensus.ts 的 APPLY_RETRY_DELAY_MINUTES（測試對齊）" },
  apply_types: { mig: [T_APPLY], why: "日本站會落庫的貢獻型別清單（local_government／regional_stat／election／no_change）" },
  source_kind_for_url: { mig: [T_APPLY], why: "出處網址的等級（依網域，日本六種來源等級）；TS 版 _shared/jp/source-kind.ts 有對齊測試" },
  election_default_name: { mig: [T_APPLY], why: "選舉預設名稱（交件沒給 name 時：<団体名>＋長／知事／議会議員＋選挙）" },
  source_write: { mig: [T_APPLY], why: "登記 sources、掛 source_refs；正見同名 source_write() 的日本版，簽名與回傳都不同（網址陣列、回主要出處 id），不是複本、沒有逐字比對" },
  apply_blocker: { mig: [T_APPLY], why: "落庫的等待條件：外鍵指到的團體還沒進 local_governments 就回等待原因（不繞過外鍵，#503 c）" },
  apply_local_government: { mig: [T_APPLY], why: "local_government 交件落庫（寫 local_governments、出處、履歷）；日本專屬型別" },
  apply_regional_stat: { mig: [T_APPLY], why: "regional_stat 交件落庫（寫 regional_stats）；日本專屬型別" },
  apply_election: { mig: [T_APPLY], why: "election 交件落庫（寫 elections）；日本專屬型別" },
  apply_no_change: { mig: [T_APPLY], why: "no_change 落庫＝記一筆 task_checks（冷卻），不動正式資料（#503）" },
  apply_contribution: { mig: [T_APPLY], why: "落庫主函式：verified（或到期的 apply_failed）→ applied／rejected／apply_failed／waiting；重試規則照正見，實作是 SQL 不是 TS" },
  apply_verified_pending: { mig: [T_APPLY], why: "落庫排程掃地機（policy-jp-apply-verified）：撿行內落庫漏掉的 verified 與到期的 apply_failed，只挑不再被擋的列" },
  apply_waiting: { mig: [T_APPLY], why: "（視圖）通過驗證、等團體落庫的交件清單（少數是正常，久了才是問題）；service_role 用" },

  // ---- 20261009210100 gap_arms：兩支新缺口臂＋#503 ----
  task_unavailable: { mig: [T_ARMS], why: "任務現在能不能派（飽和／no_change 等票或已通過／冷卻中／資料型交件通過等落庫），臂在 LIMIT cap 之前用它排除（#503）；前三項與 refresh_dispatch_blocked 同定義，有行為對照測試" },
  regional_stat_label: { mig: [T_ARMS], why: "統計項目的日文名（任務描述用）" },
  contribution_auto_tasks_local_government_missing: { mig: [T_ARMS, T_CHAIN, T_PRIO], why: "臂：任期満了調查裡出現卻不在 local_governments 的團體（都道府県先）；250400 改成選舉鏈第 1 步（只做開著的選舉的團體與所屬都道府県）" },
  contribution_auto_tasks_regional_stats_missing: { mig: [T_ARMS, T_CHAIN, T_PRIO], why: "臂：local_governments 裡統計（人口・面積・歳出・高齢化率）不齊的團體，一團體一件；250400 改成選舉鏈第 1 步（只做開著的選舉的團體）" },

  // ---- 20261009250000 lg_registry：自治體（local_government）機器核對，照正見 cec-verify ----
  kana_fold: { mig: [T_LGR], why: "讀音比對用：小寫假名摺成大寫（總務省團體碼表的拗音・促音大小寫不一致，照正確讀音交的不該被退件）" },
  lg_registry_decide: { mig: [T_LGR], why: "local_government 機器核對的判斷：payload 對總務省團體碼表 lg_code_registry → apply／reject／skip" },
  lg_registry_verify_pending: { mig: [T_LGR], why: "掃 pending 的 local_government：對得上 → verified＋落庫（reviewed_by soumu-auto），對不上 → 退件；排程 policy-jp-lg-registry-verify 與 jp-report 交件當下呼叫" },

  // ---- 20261009250200 stat_registry：地域統計（regional_stat）機器核對，同一個做法 ----
  stat_registry_tolerance: { mig: [T_STR], why: "地域統計機器核對的容許差（人口一致、面積 0.005、高齢化率 0.05）" },
  stat_registry_decide: { mig: [T_STR], why: "regional_stat 機器核對的判斷：payload 對 e-Stat 國勢調査表 stat_registry → apply／reject／skip" },
  stat_registry_verify_pending: { mig: [T_STR], why: "掃 pending 的 regional_stat（同 lg_registry_verify_pending，reviewed_by estat-auto）；排程 policy-jp-stat-registry-verify" },

  // ---- 20261009250400 election_chain：選舉鏈第 1 步（鏈上的臂、總表、進度視圖逐一登記；總表的 contribution_auto_tasks_arms 與兩支臂的重新定義已在上面各自的 mig 清單裡） ----
  election_chain_steps: { mig: [T_CHAIN], why: "選舉鏈的步驟清單（discovery／local_government／regional_stats／region），activity_rules.after_step 的 CHECK 對它" },
  date_or_null: { mig: [T_CHAIN], why: "交件 payload 的日期文字 → DATE，格式不對＝NULL（視圖不能因一筆壞資料整支丟例外）" },
  activity_chain_scope: { mig: [T_CHAIN], why: "派工列的範圍鍵（日本＝團體碼：target.chain_lg_code，沒有就用 lg_code）；總表的 gate 只透過它取，站別鍵名不寫進總表" },
  activity_chain_escape: { mig: [T_CHAIN], why: "選舉鏈逃生門：前一步沒完成時，後備里程碑到了（fallback）或這個任務開過（sticky）就照開" },
  chain_regional_stats_missing: { mig: [T_CHAIN], why: "團體缺的統計（臂與 election_chain_progress 共用同一個判準）；齊了、規則停用、行政区＝NULL" },
  chain_open_elections: { mig: [T_CHAIN], why: "（視圖）選舉鏈「開著的選舉」：已上線的地方選舉＋通過驗證、只在等團體落庫的選舉交件，投票日後 chain_close_after_days（90）天內" },
  chain_step_rank: { mig: [T_PRIO], why: "層內排序用的步驟順位（手動 0、選舉發現 1、團體 2、統計 3、其他 auto 9；之後候選人／政見／政黨在這裡多一行）；rebalance_queue 的日本專屬排序鍵" },
  chain_sort_date: { mig: [T_PRIO], why: "層內排序用的日期（target.election_date → vote_window_from → term_end；非 auto: 的列 NULL）；rebalance_queue 與 seed 共用" },
  chain_date_tier: { mig: [T_PRIO], why: "日期 → 優先層（<=60 天前段、<=180 天中段、更遠後段）；選舉發現沒有選舉列，seed 靠它定層，鏈上兩支臂靠 activity_rules 的規則（同一組天數）" },
  election_chain_progress: { mig: [T_CHAIN], why: "（視圖）選舉鏈進度：開著的選舉×團體×步驟一列一個 done；總表的 chain_gate 在 seed 時讀它（MATERIALIZED）" },

  // ---- 20261009280000 same_claim：同一件事只能有一筆（#521，日本站試點；正見九合一之後才接，所以不是複本） ----
  same_claim_office: { mig: [T_SAME], why: "選舉種類 → 比對用的職位（head／assembly；國政＝種類本身），同 term_expirations.office_kind" },
  same_claim_same_term: { mig: [T_SAME], why: "選舉的「同一屆」：regular＝同一列任期満了的 [−180, +60] 窗口（查不到就差 ≤ 180 天）、其他事由＝同一天" },
  same_claim_matches: { mig: [T_SAME], why: "登記表的 SQL 那一半：型別＋payload → 在庫列與審議中提交（附 your_network_voted）；jp-report 交件擋 resolved_claim、jp-next 附 same_claims" },
  same_claim_same_content: { mig: [T_SAME2], why: "同一件事的兩筆內容是否相同（收編用：選舉＝投票日・種類・事由、統計＝值・單位、團體＝名稱・讀音・種類）" },
  same_claim_supersede: { mig: [T_SAME2], why: "上線後收編（照正見 2026-09-21 supersedeDuplicates，正見是 TS、日本站是 SQL）：已落庫那筆 → 同一件事內容相同的等票提交 superseded＋edit_history" },
  same_claim_supersede_trg: { mig: [T_SAME2], why: "觸發器函式：election／regional_stat／local_government 轉 applied 時呼叫 same_claim_supersede" },
  same_claim_merge_pending: { mig: [T_SAME2], why: "一次性收編 #531 上線前的重複：兩筆都等票的，後交的票與交件者那一票併進先交的、後交的 superseded" },

  // ---- 20261010010000 console_admin：主控台日本站（#518 第二步；正見版在 20261009260000，參數型別與表都不同所以不是複本） ----
  console_arm_status: { mig: [T_CONSOLE], why: "每支臂今天開／關與佇列件數（SECURITY DEFINER，anon 可讀）；正見版讀 activity_open_now 視圖，日本站沒有那張，targets 展開寫在函式裡，election_id 是 TEXT" },
  console_active_overrides: { mig: [T_CONSOLE], why: "（視圖）目前有效的覆寫；擁有者權限的視圖＋明確 GRANT SELECT（日本站內部表不對 anon 開，正見版是 security_invoker）" },
  console_election_milestones: { mig: [T_CONSOLE], why: "（視圖）每場選舉×里程碑一列，給主控台改日期；擁有者權限的視圖＋明確 GRANT SELECT" },
  console_admin_override_create: { mig: [T_CONSOLE], why: "主控台新增覆寫（service_role 專用）；election_id 是 TEXT，釘 search_path = policy_jp, pg_temp" },
  console_admin_override_revoke: { mig: [T_CONSOLE], why: "主控台撤銷覆寫（service_role 專用）：expires_at 設今天 -1、撤銷原因併進 reason" },
  console_admin_milestone_set: { mig: [T_CONSOLE], why: "主控台改里程碑（service_role 專用）；kind 白名單照日本站八種 CHECK（沒有 qualification_review）" },
};

// ---- 掃描與比對（純函式，還原驗證也用它們） ----
/** 去掉 SQL 註解（-- 到行尾、塊註解）；字串字面值原樣保留（字串裡的 -- 不是註解），所以 EXECUTE '…CREATE FUNCTION…' 這種動態建立也抓得到 */
function stripSqlComments(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? m : ""));
}
/** CREATE [OR REPLACE] FUNCTION／PROCEDURE／[RECURSIVE|MATERIALIZED] VIEW <名字>：名字不限前綴，沒帶 policy_jp. 的另外記成 foreign */
const DEFINE_RE = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|(?:RECURSIVE\s+|MATERIALIZED\s+)?VIEW)\s+([^\s(]+)/gi;

type Scan = { defined: Map<string, string[]>; foreign: string[] };
/** files：檔名 → SQL。defined：名字 → 定義它的 migration 時間戳（排序、不重複）；foreign：沒有 policy_jp. 前綴的定義（會落在別的 schema，逃過這份登記） */
function scanDefinitions(files: Record<string, string>): Scan {
  const defined = new Map<string, Set<string>>();
  const foreign: string[] = [];
  for (const [file, sql] of Object.entries(files)) {
    for (const m of stripSqlComments(sql).matchAll(DEFINE_RE)) {
      const q = m[1].replaceAll('"', "");
      const own = /^policy_jp\.(\w+)$/.exec(q);
      if (!own) { foreign.push(`${ID(file)}：${q}`); continue; }
      if (!defined.has(own[1])) defined.set(own[1], new Set());
      defined.get(own[1])!.add(ID(file));
    }
  }
  return { defined: new Map([...defined].map(([k, v]) => [k, [...v].sort()])), foreign };
}

function registryDrift(scan: Scan, copies: ReadonlySet<string>, jpOnly: Record<string, JpOnly>) {
  const registered = new Set([...copies, ...Object.keys(jpOnly)]);
  return {
    foreign: scan.foreign,
    unregistered: [...scan.defined.keys()].filter((n) => !registered.has(n)).sort(),
    stale: [...registered].filter((n) => !scan.defined.has(n)).sort(),
    overlap: [...copies].filter((n) => n in jpOnly).sort(),
    misplaced: Object.entries(jpOnly)
      .filter(([n, v]) => scan.defined.has(n) && scan.defined.get(n)!.join() !== [...v.mig].sort().join())
      .map(([n, v]) => `${n}：登記 ${v.mig.join("、")}，實際 ${scan.defined.get(n)!.join("、")}`).sort(),
  };
}
function assertNoDrift(d: ReturnType<typeof registryDrift>) {
  assertEquals(d.foreign, [], "policy_jp migration 裡有沒帶 policy_jp. 前綴的函式／視圖（會建到別的 schema，逃過登記）");
  assertEquals(d.unregistered, [], "新加的函式／視圖沒登記：是正見的複本就進 PAIRS（或 OTHER_COPIES），日本專屬就進 JP_ONLY（附理由）");
  assertEquals(d.stale, [], "登記了卻再也沒有 policy_jp migration 定義的名字（改名或刪掉了？）：把登記拿掉或改名");
  assertEquals(d.overlap, [], "同一個名字不能同時是複本又是日本專屬");
  assertEquals(d.misplaced, [], "JP_ONLY 的 mig 清單跟實際定義它的 migration 對不上（被搬走或被重新定義了）：更新登記");
}
/** OTHER_COPIES 只准在 T_STATS 定義（後面的 migration 重新定義＝逃過 public-stats 測試的逐字比對） */
const otherCopiesElsewhere = (scan: Scan) => OTHER_COPIES.filter((n) => scan.defined.get(n)?.join() !== T_STATS);

async function readJpMigrations(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const n of await listMigrations()) if (n.includes("_policy_jp_")) out[n] = await readMig(n);
  return out;
}

Deno.test("走樣：所有 policy_jp migration 定義的函式與視圖＝複本（PAIRS／FOLLOWED／公開統計）＋日本專屬清單 JP_ONLY（新加的不登記就紅、登記了卻沒人定義也紅）；偵測器有還原驗證", async () => {
  const files = await readJpMigrations();
  const ids = Object.keys(files).map(ID);
  for (const t of [T_TABLES, T_DISPATCH, T_ED, ID(FOLLOW_MIG), T_STATS, T_APPLY, T_ARMS, T_LGR, T_STR, T_CHAIN, T_PRIO, "20261008195000", "20261009130200", "20261009250100", "20261009250300"]) {
    assert(ids.includes(t), `掃描範圍要包含 ${t}（放行靠登記，不是靠沒掃到）`);
  }
  const scan = scanDefinitions(files);
  for (const n of ["activity_today", "contribution_leaderboard", "apply_contribution", "election_chain_progress", "source_archive_missing"]) {
    assert(scan.defined.has(n), `偵測器沒抓到 ${n}（偵測器壞了？）`);
  }

  // ---- 登記本身的整齊度 ----
  assertEquals(new Set(OTHER_COPIES).size, OTHER_COPIES.length, "OTHER_COPIES 重複登記");
  const pairNames = new Set(PAIRS.map((p) => p.name));
  for (const n of OTHER_COPIES) assert(!pairNames.has(n), `${n} 已經在 PAIRS，不用再登記成公開統計的複本`);
  for (const [n, v] of Object.entries(JP_ONLY)) {
    assert(v.why.trim().length > 0, `${n} 要寫一行理由`);
    assert(v.mig.length > 0 && new Set(v.mig).size === v.mig.length, `${n} 的 mig 清單不能空、不能重複`);
    assertEquals(v.mig, [...v.mig].sort(), `${n} 的 mig 清單要照時間戳排序`);
    for (const t of v.mig) assert(ids.includes(t), `${n} 登記的 migration ${t} 不存在`);
  }

  // ---- 主要比對：定義的＝複本 ∪ 日本專屬 ----
  const copies = new Set([...PAIRS.map((p) => p.name), ...Object.keys(FOLLOWED), ...OTHER_COPIES]);
  assertNoDrift(registryDrift(scan, copies, JP_ONLY));

  // ---- 跟檔頭既有清單互相對照：130000／130100 的非複本都在 JP_ONLY 且 mig 含自己 ----
  for (const n of NONCOPY) assert(JP_ONLY[n]?.mig.includes(T_DISPATCH), `${n}（NONCOPY）要登記在 JP_ONLY，mig 含 ${T_DISPATCH}`);
  for (const n of NONCOPY_ED) assert(JP_ONLY[n]?.mig.includes(T_ED), `${n}（NONCOPY_ED）要登記在 JP_ONLY，mig 含 ${T_ED}`);
  // 反過來：JP_ONLY 裡掛 130000／130100 的，也都在那兩份清單裡（視圖除外，視圖只在 JP_ONLY）
  const viewsOnlyHere = new Set(["election_milestones_all", "activity_health", "gap_open_lateness"]);
  for (const [n, v] of Object.entries(JP_ONLY)) {
    if (v.mig.includes(T_DISPATCH) && !viewsOnlyHere.has(n)) assert(NONCOPY.includes(n), `${n} 掛在 130000，卻不在 NONCOPY（檔頭「不是複本」那份清單要同步）`);
    if (v.mig.includes(T_ED)) assert(NONCOPY_ED.includes(n), `${n} 掛在 130100，卻不在 NONCOPY_ED`);
  }

  // ---- 公開統計的複本：只在 T_STATS 定義，而且 public-stats 測試真的登記了它們 ----
  assertEquals(otherCopiesElsewhere(scan), [], "公開統計的複本被別的 migration 重新定義（逃過 public-stats 測試的逐字比對）");
  const guard = await Deno.readTextFile(new URL(`./${OTHER_COPY_GUARD}`, import.meta.url));
  for (const n of OTHER_COPIES) assert(guard.includes(`name: "${n}"`), `${OTHER_COPY_GUARD} 的 PAIRS 沒有登記 ${n}`);
  assert(guard.includes(`const NONCOPY = ["pipeline_snapshots_since"]`), `${OTHER_COPY_GUARD} 的 NONCOPY 變了：pipeline_snapshots_since 的登記要同步`);

  // ---- 還原驗證：偵測器真的會咬（假 migration 夾一支新的、漏前綴、改名、重新定義…都抓得到） ----
  const FAKE = "20261231000000_policy_jp_fake.sql";
  const CHAIN_FILE = Object.keys(files).find((n) => ID(n) === T_CHAIN)!;
  const fn = (name: string) => `CREATE OR REPLACE FUNCTION policy_jp.${name}() RETURNS INTEGER LANGUAGE sql AS $$ SELECT 1 $$;`;
  const bite = (extra: Record<string, string>, reg: Record<string, JpOnly> = JP_ONLY) => registryDrift(scanDefinitions({ ...files, ...extra }), copies, reg);
  const biteScan = (extra: Record<string, string>) => scanDefinitions({ ...files, ...extra });

  // 一、新函式、新視圖（兩種寫法，大小寫不拘）、藏在既有 migration 檔尾的，沒登記一律紅
  let d = bite({ [FAKE]: fn("some_new_fn") });
  assertEquals(d.unregistered, ["some_new_fn"]);
  assertThrows(() => assertNoDrift(d));
  d = bite({ [FAKE]: "CREATE VIEW policy_jp.some_new_view AS SELECT 1;\ncreate or replace view policy_jp.some_new_view2 AS SELECT 1;\nCREATE MATERIALIZED VIEW policy_jp.some_new_mv AS SELECT 1;" });
  assertEquals(d.unregistered, ["some_new_mv", "some_new_view", "some_new_view2"]);
  assertThrows(() => assertNoDrift(d));
  d = bite({ [MIG]: files[MIG] + "\n" + fn("sneaky_in_old_migration") });
  assertEquals(d.unregistered, ["sneaky_in_old_migration"]);
  assertThrows(() => assertNoDrift(d));
  d = bite({ [FAKE]: `DO $$ BEGIN EXECUTE 'CREATE FUNCTION policy_jp.made_by_execute() RETURNS INT LANGUAGE sql AS ''SELECT 1'''; END $$;` });
  assertEquals(d.unregistered, ["made_by_execute"]);
  assertThrows(() => assertNoDrift(d));

  // 二、註解裡提到的不算（行註解、塊註解）；字串裡的 -- 不是註解
  assertNoDrift(bite({ [FAKE]: "-- CREATE OR REPLACE FUNCTION policy_jp.in_line_comment()\n/* CREATE VIEW policy_jp.in_block_comment AS SELECT 1; */\nSELECT 1;" }));
  d = bite({ [FAKE]: `SELECT '--'; ${fn("after_dashes_in_string")}` });
  assertEquals(d.unregistered, ["after_dashes_in_string"]);

  // 三、漏前綴（會建到別的 schema）紅
  d = bite({ [FAKE]: "CREATE FUNCTION public.leaks_into_public() RETURNS INT LANGUAGE sql AS $$ SELECT 1 $$;\nCREATE OR REPLACE VIEW bare_view AS SELECT 1;" });
  assertEquals(d.foreign, [`${ID(FAKE)}：public.leaks_into_public`, `${ID(FAKE)}：bare_view`]);
  assertThrows(() => assertNoDrift(d));

  // 四、登記了卻沒人定義（改名、刪除）紅：選舉鏈的函式與視圖各試一次
  d = bite({ [CHAIN_FILE]: files[CHAIN_FILE].replace("CREATE OR REPLACE FUNCTION policy_jp.election_chain_steps(", "CREATE OR REPLACE FUNCTION policy_jp.election_chain_steps_v2(") });
  assertEquals(d.stale, ["election_chain_steps"]);
  assertEquals(d.unregistered, ["election_chain_steps_v2"]);
  assertThrows(() => assertNoDrift(d));
  d = bite({ [CHAIN_FILE]: files[CHAIN_FILE].replace("CREATE OR REPLACE VIEW policy_jp.election_chain_progress ", "CREATE OR REPLACE VIEW policy_jp.election_chain_progress_v2 ") });
  assertEquals(d.stale, ["election_chain_progress"]);
  assertThrows(() => assertNoDrift(d));
  // 複本也一樣：PAIRS 登記的名字沒人定義了
  d = registryDrift(scan, new Set([...copies, "ghost_copy"]), JP_ONLY);
  assertEquals(d.stale, ["ghost_copy"]);
  assertThrows(() => assertNoDrift(d));

  // 五、JP_ONLY 的函式被後面的 migration 重新定義（或從 mig 清單漏寫）紅
  d = bite({ [FAKE]: fn("task_unavailable") });
  assertEquals(d.misplaced, [`task_unavailable：登記 ${T_ARMS}，實際 ${T_ARMS}、${ID(FAKE)}`]);
  assertThrows(() => assertNoDrift(d));
  d = bite({}, { ...JP_ONLY, contribution_auto_tasks_arms: { ...JP_ONLY.contribution_auto_tasks_arms, mig: [T_DISPATCH, T_ED, T_ARMS] } });
  assertEquals(d.misplaced.length, 1);
  assertThrows(() => assertNoDrift(d));

  // 六、複本與日本專屬同名紅
  d = registryDrift(scan, copies, { ...JP_ONLY, contribution_vote_weight: { mig: [T_DISPATCH], why: "假的" } });
  assertEquals(d.overlap, ["contribution_vote_weight"]);
  assertThrows(() => assertNoDrift(d));

  // 七、公開統計的複本被後面的 migration 重新定義紅
  assertEquals(otherCopiesElsewhere(biteScan({ [FAKE]: fn("model_vote_stats") })), ["model_vote_stats"]);
});
