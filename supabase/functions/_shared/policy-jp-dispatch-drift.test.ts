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

/**
 * 日本專屬の偏離（二つ目、20261010120000，policy-ops#60）：refresh_dispatch_blocked の冷卻計算に「roster_check の not_found は告示日で打ち切る」を一行足す。
 * 理由：冷卻は task_dispatches.cooling（/next が配るかどうか）を決めるので、臂の側（task_unavailable）だけ直しても告示日に配られない。
 * 正見に告示日という概念はなく、跟進しない。走樣比對は引き続き 130000 の版（PAIRS）を読み、ここで「偏離版 ＋ jpEdits ＝ 130000 の版」を守る。
 */
const KANA_MIG = "20261010120000_policy_jp_kana_optional.sql";
const KANA_SQL = await readMig(KANA_MIG);
const DEVIATED_KANA: Record<string, { prev: string; why: string; jpEdits: Edit[] }> = {
  refresh_dispatch_blocked: {
    prev: MIG_SQL,
    why: "roster_check の not_found の冷卻を min(14 日, 告示日の前日まで) にする（roster_not_found_released の一行）。正見に告示日の冷卻はない",
    jpEdits: [["      AND NOT policy_jp.roster_not_found_released(tc.task_id, tc.outcome, tc.checked_at)  -- 日本版：roster_check の not_found だけ告示日で冷卻を打ち切る\n", ""]],
  },
};

/**
 * 日本專屬の偏離（三つ目、20261011210000，policy-ops#95 C 期第 6 步）：contribution_needs_two_ips は 130000 の複本が正見の一句
 * （lineage_handover の handover_type=stop は 2 網段）だけ抜いてあった。日本にも脈絡ができたので、その一句を戻す＝正見の現行定義と逐字同じ本体。
 * 走樣比對は引き続き 130000 の版（PAIRS の edits 付き）を読み、ここで「偏離版 ＋ jpEdits ＝ 130000 の版」を守る。
 */
const LIN_MIG = "20261011210000_policy_jp_lineage.sql";
const LIN_SQL = await readMig(LIN_MIG);
const DEVIATED_LINEAGE: Record<string, { prev: string; why: string; jpEdits: Edit[] }> = {
  contribution_needs_two_ips: {
    prev: MIG_SQL,
    why: "lineage_handover の handover_type=stop（中止）は 2 網段（正見 20261006034900 の一句を戻す）。130000 の複本は日本に脈絡がなかったのでこの一句を抜いていた",
    jpEdits: [["'reassign_candidacy')\n      OR (p_type = 'lineage_handover' AND COALESCE(p_payload->>'handover_type', '') = 'stop')", "'reassign_candidacy')"]],
  },
};

/**
 * 派工排序改秒數（20261011360000，維護者 10-13「a b 都作吧」）：日本站跟上正見 20261011320000／20261011350000。
 * 下面幾支複本改讀這支 migration 的定義（SEC_FOLLOWED），走樣比對對正見的現行定義（不再取 320000 之前的版本）；
 * 新增的五支（SEC_NEW：排序鍵、規則的優先秒數、手動任務的插隊秒數、驗證沿用的秒數、觸發器）同樣是複本，登記在 PAIRS。
 * 日本版的 rebalance_queue、activity_priority、manual_front_at 在這支刪掉（正見 350000 也刪了），PAIRS 裡那三支仍比對 130000／150100 的歷史定義。
 */
const SEC_MIG = "20261011360000_policy_jp_queue_priority_seconds.sql";
const SEC_SQL = await readMig(SEC_MIG);
const SEC_NEW = ["task_queue_key", "activity_priority_seconds", "manual_front_seconds", "verify_inherited_priority_seconds", "task_dispatches_queue_key"];
const SEC_FOLLOWED = [...SEC_NEW, "refresh_dispatch_blocked", "seed_auto_task_queue", "manual_front_pull", "contribution_tasks_insert_dispatch"];

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
/** 2026-10-17 正見第二步（驗證票的排序跟著母任務、任務有交件在途就停放）：這支改了下面三支複本，日本站暫不跟（「日本站還沒跟」的登記偏離），比對讀這支之前的版本 */
const TW_VERIFY_TICKET = "20261017010000_verify_ticket_follows_task.sql";
/** 2026-10-17 正見「不確定」第 2 張起每張 −1（20261017020000）與投太多輪（20261017020100）：日本站暫不跟（登記偏離），contribution_apply_consensus 的比對讀 20261017020000 之前的版本 */
const TW_UNSURE = "20261017020000_unsure_penalty.sql";

const PAIRS: Pair[] = [
  { name: "activity_today" },
  { name: "activity_status_rank" },
  { name: "activity_audit" },
  { name: "activity_touch_updated_at" },
  { name: "activity_require_rule" },
  {
    name: "activity_open",
    note: "拿掉排除職位那一行（except_election_types 欄是村里長專用，日本版 activity_rules 沒有這欄）；拿掉 20261011030000 加的「查不到照開」那一段（正見政見進度專用，日本站不跟）",
    edits: [[
      "       AND (r.except_election_types IS NULL OR p_election_type IS NULL OR NOT (p_election_type = ANY (r.except_election_types)))  -- 排除職位：職位未知（NULL）時不排除，寧可開著也不無聲關掉\n",
      "",
    ], [
      "         -- 查不到屆別或職位時照開（規則 params.open_when_unknown，OPS #81；同 #470「職位未知時不排除」）：資料缺不該讓任務被收回，查不到的里程碑當作已到\n" +
        "         OR (COALESCE((r.params->>'open_when_unknown')::BOOLEAN, false)\n" +
        "             AND (p_election_id IS NULL OR p_election_type IS NULL)\n" +
        "             AND (r.from_kind IS NULL OR f.on_date IS NULL OR p_today >= f.on_date + r.from_offset)\n" +
        "             AND (r.until_kind IS NULL OR u.on_date IS NULL OR p_today <= u.on_date + r.until_offset))\n",
      "",
    ]],
  },
  { name: "activity_priority" },
  { name: "queue_now" },
  { name: "queue_slot" },
  { name: "task_dispatched" },
  { name: "contribution_queue_at" },
  {
    name: "refresh_dispatch_blocked",
    note: "冷卻天數換回日本站的兩個設定（task_cooldown_settings 與 task_check_cooldown_days_for 是台灣村里長進度專用）；roster_check 的 not_found 在告示日打斷冷卻（20261010120000 的偏離，秒數化時照帶）",
    edits: [["max(tc.checked_at + (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL) AS until", "max(tc.checked_at + (CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days')::INTERVAL) AS until"], ["    WHERE tc.checked_at > now() - (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL\n    -- 比任何一種冷卻都長的歷史紀錄不用逐筆問天數（task_checks 只會越積越多；agy 審查 #480）：上限是一個 InitPlan，只算一次\n      AND tc.checked_at > now() - make_interval(days => (SELECT task_cooldown_max_days()))\n", "    WHERE tc.checked_at > now() - (CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days')::INTERVAL\n      AND NOT roster_not_found_released(tc.task_id, tc.outcome, tc.checked_at)  -- 日本版：roster_check の not_found だけ告示日で冷卻を打ち切る\n"]],
  },
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
    before: TW_VERIFY_TICKET,
    note: "取驗證票跟著任務（20261017010000，日本站暫不跟：補驗證列不再呼叫 contribution_queue_at、最後多 refresh_verify_ticket_keys）之前的版本；拿掉流量提層兩段（traffic_boost_apply 與提層秒數，台灣專用）；換成日本專屬的「選舉鏈上沒有 polling 里程碑的缺口照日期定層」一段（20261009300000 的偏離，秒數化時照帶，秒數取那一層的秒數）",
    edits: [{"span": ["  -- >>> 流量提層：", "  -- <<< 流量提層\n"], "with": ""}, {"span": ["  -- >>> 優先秒數：流量提層的缺口", "  -- <<< 優先秒數\n"], "with": "  -- >>> 日本版：選舉發現的層\n  -- 鏈上的臂裡「還沒有選舉列＝沒有 polling 里程碑」的缺口（選舉發現；等團體落庫的選舉的團體任務），規則算不出秒數，改用 target 的日期\n  -- （election_date，沒有就 vote_window_from）定層：60 天內前段、180 天內中段、更遠後段（chain_date_tier），秒數取那一層的 task_priority_tiers.seconds。有 polling 里程碑的照上面規則算的\n  UPDATE _gaps g SET priority_seconds = (SELECT t.seconds FROM task_priority_tiers t WHERE t.id = chain_date_tier(chain_sort_date(g.task_id, g.target))), priority_rule_id = NULL\n   WHERE g.arm IN ('election_discovery', 'local_government_missing', 'regional_stats_missing')\n     AND NOT EXISTS (SELECT 1 FROM election_milestones_all m WHERE m.election_id = NULLIF(g.target->>'election_id', '') AND m.kind = 'polling');\n  -- <<< 日本版：選舉發現的層\n"}],
  },
  {
    name: "contribution_queue_tasks",
    // 2026-10-17（正見 20261017000301）合格條件全搬進 SQL（查無回報在等票、在途額滿、提問、裁決）；日本站暫不跟（jp-next 的同構問題另開），比對讀這支之前的版本
    before: "20261017000301_queue_tasks_eligibility_before_limit.sql",
    note: "取合格條件搬進 SQL（20261017000301，日本站暫不跟）之前的版本",
  },
  { name: "contribution_queue_task_counts" },
  { name: "contribution_auto_tasks", before: TW_VERIFY_TICKET, note: "取驗證票跟著任務（20261017010000，日本站暫不跟：多一段合格：任務停放）之前的版本" },
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
    // 2026-10-17（正見 20261017020000 不確定第 2 張起每張 −1、20261017020100 投太多輪的 disputed 守衛）；日本站暫不跟（主線會通知日本站執行緒），比對讀這兩支之前的版本
    before: TW_UNSURE,
    note: "取不確定第 2 張起每張 −1（20261017020000，日本站暫不跟）之前的版本；拿掉中選會名冊兩處（contribution_roster_matched 例外、batch_verified_by 整批驗證分支）",
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
  { name: "contribution_queue_row", before: TW_VERIFY_TICKET, note: "取驗證票跟著任務（20261017010000，日本站暫不跟：入列不再呼叫 contribution_queue_at 給 1970）之前的版本" },
  { name: "contribution_votes_trg" },
  { name: "contribution_votes_set_weight" },
  { name: "contribution_tasks_drop_dispatch" },
  { name: "contribution_tasks_insert_dispatch" },
  // 20261011360000 新增的複本（SEC_NEW）
  { name: "task_queue_key" },
  { name: "activity_priority_seconds" },
  { name: "manual_front_seconds" },
  { name: "verify_inherited_priority_seconds" },
  { name: "task_dispatches_queue_key", before: TW_VERIFY_TICKET, note: "取驗證票跟著任務（20261017010000，日本站暫不跟：驗證列改走 verify_queue_key、拿掉 1970／1980 年段）之前的版本" },
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

const jpBody = (name: string) => fnText(SEC_FOLLOWED.includes(name) ? SEC_SQL : FOLLOWED[name] ?? MIG_SQL, `policy_jp.${name}`);

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

for (const [name, v] of Object.entries(DEVIATED_KANA)) {
  Deno.test(`走樣（日本專屬偏離・告示日）${name}：偏離版 ＋ 登記的 jpEdits ＝ 130000 の版（逐字）；偏離は一行だけ、登記外の変更は紅`, () => {
    assert(PAIRS.some((p) => p.name === name), `${name} 要在複本清單 PAIRS 裡`);
    assert(v.why.length > 10 && v.jpEdits.length > 0);
    const dev = fnText(KANA_SQL, `policy_jp.${name}`);
    const prev = fnText(v.prev, `policy_jp.${name}`);
    assertEquals(applyEdits(dev, v.jpEdits), prev);
    assertNotEquals(dev, prev, "偏離版と前の版が同じ＝偏離していない");
    // 還原驗證：登記外の一字の変更、登記した行の削除（偏離が消えた版）はどちらも対応が崩れる
    assertNotEquals(applyEdits(dev.replace("RETURNS INTEGER", "RETURNS INTEGER /* x */"), v.jpEdits), prev);
    assertEquals(dev.split("roster_not_found_released").length - 1, 1, "偏離は roster_not_found_released の一か所だけ");
  });
}

Deno.test("走樣（日本專屬偏離・告示日）：20261010120000 が複本を定義するのは登記した偏離だけ", () => {
  const copies = new Set(PAIRS.map((p) => p.name));
  const defined = [...KANA_SQL.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]);
  for (const n of defined) if (copies.has(n)) assert(n in DEVIATED_KANA, `${n} は複本。${KANA_MIG} で再定義するなら DEVIATED_KANA に登記（jpEdits つき）`);
  for (const n of Object.keys(DEVIATED_KANA)) assert(defined.includes(n), `${n} を偏離として登記したが定義がない`);
  for (const n of defined) assert(fnText(KANA_SQL, `policy_jp.${n}`).includes("SET search_path = policy_jp, pg_temp"), `${n} の search_path が釘付けされていない`);
  const stripped = KANA_SQL.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(stripped) && !/search_path\s*=\s*public/i.test(stripped), "不碰 public");
});

for (const [name, v] of Object.entries(DEVIATED_LINEAGE)) {
  Deno.test(`走樣（日本專屬偏離・脈絡）${name}：偏離版 ＋ 登記の jpEdits ＝ 130000 の版（逐字）；登記外の変更は紅`, () => {
    assert(PAIRS.some((p) => p.name === name), `${name} 要在複本清單 PAIRS 裡`);
    assert(v.why.length > 10 && v.jpEdits.length > 0);
    const dev = fnText(LIN_SQL, `policy_jp.${name}`);
    const prev = fnText(v.prev, `policy_jp.${name}`);
    assertEquals(applyEdits(dev, v.jpEdits), prev);
    assertNotEquals(dev, prev, "偏離版と前の版が同じ＝偏離していない");
    // 還原驗證：登記外の一字の変更、登記した一句の削除（偏離が消えた版）はどちらも対応が崩れる
    assertNotEquals(applyEdits(dev.replace("IMMUTABLE", "IMMUTABLE /* x */"), v.jpEdits), prev);
    assertEquals(dev.split("lineage_handover").length - 1, 1, "偏離は lineage_handover の一句だけ");
    // 正見の現行定義（PAIRS を通した複本）と同じ本体：stop の一句が付いている
    assert(dev.includes("handover_type"));
  });
}

Deno.test("走樣（日本專屬偏離・脈絡）：20261011210000 が複本を定義するのは登記した偏離だけ；不碰 public", () => {
  const copies = new Set(PAIRS.map((p) => p.name));
  const defined = [...LIN_SQL.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]);
  for (const n of defined) if (copies.has(n)) assert(n in DEVIATED_LINEAGE, `${n} は複本。${LIN_MIG} で再定義するなら DEVIATED_LINEAGE に登記（jpEdits つき）`);
  for (const n of Object.keys(DEVIATED_LINEAGE)) assert(defined.includes(n), `${n} を偏離として登記したが定義がない`);
  const stripped = LIN_SQL.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(stripped) && !/search_path\s*=\s*public/i.test(stripped), "不碰 public");
});

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

Deno.test("走樣（秒數化）：20261011360000 定義的函式＝登記的複本（SEC_FOLLOWED）＋插隊兩支（JP_ONLY）；不碰 public；plpgsql 釘 search_path；舊的排序函式與欄位刪掉", () => {
  const defined = [...SEC_SQL.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, [...SEC_FOLLOWED, "task_boost", "task_boost_remaining"].sort());
  const copies = new Set(PAIRS.map((p) => p.name));
  for (const n of SEC_FOLLOWED) assert(copies.has(n), `${n} 要在複本清單 PAIRS 裡`);
  for (const n of defined) {
    const t = fnText(SEC_SQL, `policy_jp.${n}`);
    if (/LANGUAGE plpgsql/.test(t)) assert(t.includes("SET search_path = policy_jp, pg_temp"), `${n} 沒釘 search_path`);
  }
  const stripped = SEC_SQL.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(stripped) && !/search_path\s*=\s*public/i.test(stripped), "不碰 public");
  assert(!/\bshared\./.test(stripped), "shared.dispatch_plan 在另一支（日本站的測試環境只載 policy_jp 的 migration）");
  for (const d of [
    "DROP FUNCTION IF EXISTS policy_jp.rebalance_queue();",
    "DROP FUNCTION IF EXISTS policy_jp.activity_priority(TEXT, TEXT, TEXT, DATE);",
    "DROP FUNCTION IF EXISTS policy_jp.manual_front_at(TEXT);",
    "ALTER TABLE policy_jp.task_dispatches DROP COLUMN IF EXISTS priority;",
    "ALTER TABLE policy_jp.task_priority_tiers DROP COLUMN IF EXISTS weight;",
  ]) assert(SEC_SQL.includes(d), `少了：${d}`);
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
  const registered = [...PAIRS.map((p) => p.name).filter((n) => !SEC_NEW.includes(n)), ...NONCOPY].sort();
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
      if (copies.has(m[1]) && !(name === FOLLOW_MIG && m[1] in FOLLOWED) && !(name === DEV_MIG && m[1] in DEVIATED) && !(name === KANA_MIG && m[1] in DEVIATED_KANA) && !(name === LIN_MIG && m[1] in DEVIATED_LINEAGE) && !(name === SEC_MIG && SEC_FOLLOWED.includes(m[1]))) offenders.push(`${name}：${m[1]}`);
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
const T_BOOST = "20261010030000"; // 插隊 jp-boost（正見 single_queue_boosts 的日本版，篩選詞彙不同）
const T_CAND = "20261010040000"; // 選舉鏈第 2 步：參選人有誰（roster_check＋candidacy）
const T_PROFILE = "20261010050000"; // 選舉鏈第 3 步：參選人建檔（profile_gap／profile_detail_gap＋politician）
const T_POLICY = "20261010060000"; // 選舉鏈第 4 步：這次的政見（policy_missing＋policy）
const T_KANA = "20261010120000"; // 告示前の読み（kana）は選填＋roster_check の not_found 冷卻を告示日で打ち切る（policy-ops#60）
const T_TIMELINE = "20261010110100"; // 主控台派工開關的選舉時間軸（policy-ops #63；正見版在 20261010110000）
const T_PER_ELECTION = "20261010140100"; // 時間軸日常與當屆選舉拆開（policy-ops #69；正見版在 20261010140000）
const T_SET_BASED = "20261010200100"; // 件數改成一次集合查詢（#569 上線後 console_timeline 逾時；正見版在 20261010200000）
const T_PASSIVE = "20261010230100"; // 主控台派工頁「被動」段（policy-ops #78；正見版在 20261010230000）
const T_A1 = "20261011070000"; // 派工臂對齊正見 A 期第一支：candidate_status_stale／not_running／withdrawn_filing／candidacy_source_missing（policy-ops#95）
const T_B = "20261011090000"; // 派工臂對齊正見 B 期：開票結果（election_results／elected_missing）＋新任期（politician_offices 同期）（policy-ops#95）
const T_PE = "20261011140000"; // 派工臂對齊正見 2a：政見三要素 policy_elements_missing（規則預設關，policy-ops#95）
const T_DUP = "20261011180000"; // 派工臂對齊正見 2c：重複政見 duplicate_policy（規則預設關）＋交件型別 removal（policy-ops#95）
const T_PROG = "20261011200000"; // 派工臂對齊正見 C 期第 4b 步：政見進度 progress_stale／期限到了 deadline_due＋交件型別 policy_progress（policy-ops#95）
const T_LIN = "20261011210000"; // 派工臂對齊正見 C 期第 6 步：政策の継承 lineage_candidates／handover_missing／lineage_roles／lineage_links＋交件型別 lineage／lineage_participants／lineage_handover／lineage_link（policy-ops#95）
const T_ARCH = "20261011220000"; // 存檔網址（Wayback／archive.today／WARP）照原網址分級（正見 1.89.0 source_unwrap_archive 的日本版，policy-ops#95）
const T_CLAIM = "20261011370100"; // 驗證派工的原子認領（正見 20261011370000 的日本版；兩支本體只差 schema，逐字比對在 verify-claim.test.ts）
const T_NEWS = "20261011250000"; // 新聞線 news_discovery（突発の選挙）＋測試名人物の入力拒否・総表での隔離（policy-ops#95）
const T_CONS = "20261011240000"; // 派工臂對齊正見 D 期：資料一致性 placeholder_politicians／policy_validity／mismatch＋removal 加 target_table=politicians（policy-ops#95）
const T_PARTY = "20261011230000"; // 派工臂對齊正見 D 期：政党名簿 party_roster／party_gap／party_info＋交件型別 party_info＋party_aliases（policy-ops#95）
const T_TERM = "20261011190000"; // 派工臂對齊正見 C 期第 4 步：現職首長の公約 mayor_policies／term_policies（規則 enabled、新しい交件型別なし，policy-ops#95）
const T_DS = "20261011170000"; // 派工臂對齊正見 2b：議員定数 district_seats_missing（規則最初から開く，policy-ops#95）
const T_SYSONE = "20261011110000"; // 系統票の投票端 jp-system-one?action=precheck の候選清單（PLAN-arms-parity「系統票」）
const T_SYSONE_REASK = "20261011130000"; // 系統票：宣稱に投票日が入っていた candidacy の旧判定を一度だけ聞き直す

const T_SEC = ID(SEC_MIG); // 派工排序改秒數（正見 20261011320000／350000 的日本版）

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
  election_milestones_all: { mig: [T_DISPATCH, T_CAND], why: "（視圖）規則讀的里程碑全貌（存的里程碑＋投票日）；沒有 term_* 任期里程碑（日本站的任期要從 politician_offices 來，還沒做）" },
  activity_health: { mig: [T_DISPATCH], why: "（視圖）派工時間窗的健康檢查，正常是空的；只有通用幾項，沒有 roster／公報／號次／村里長的台灣專用檢查" },
  gap_open_lateness: { mig: [T_DISPATCH], why: "（視圖）缺口出生對帳（規則說該開的日子 vs 實際出生差超過 1 天），日界用 Asia/Tokyo" },
  activity_arm_names: { mig: [T_DISPATCH, T_ED, T_ARMS, T_CAND, T_PROFILE, T_POLICY, T_A1, T_B, T_PE, T_DS, T_DUP, T_TERM, T_PROG, T_LIN, T_PARTY, T_CONS, T_NEWS], why: "臂名清單，日本站只有自己的臂（正見 36 個）；130100 加 election_discovery、210100 加 local_government_missing／regional_stats_missing" },
  contribution_auto_tasks_arms: { mig: [T_DISPATCH, T_ED, T_ARMS, T_CHAIN, T_CAND, T_PROFILE, T_POLICY, T_A1, T_B, T_PE, T_DS, T_DUP, T_TERM, T_PROG, T_LIN, T_PARTY, T_CONS, T_NEWS], why: "派工總表骨架（正見 31 個分支）：130000 只有兩支手動任務臂，130100 加 election_discovery，210100 加兩支缺口臂，250400 加選舉鏈 gate 一段（>>> 選舉鏈 … <<<）" },

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
  apply_types: { mig: [T_APPLY, T_CAND, T_PROFILE, T_POLICY, T_PE, T_DS, T_DUP, T_PROG, T_LIN, T_PARTY], why: "日本站會落庫的貢獻型別清單（local_government／regional_stat／election／no_change）" },
  source_kind_for_url: { mig: [T_APPLY, T_ARCH], why: "出處網址的等級（依網域，日本六種來源等級）；TS 版 _shared/jp/source-kind.ts 有對齊測試；T_ARCH 在最前面加一層還原存檔網址（source_unwrap_archive）、WARP 還原不了算 other，其餘分支不動" },
  source_unwrap_archive: { mig: [T_ARCH], why: "存檔網址 → 原網址（Wayback、archive.today 系、国立国会図書館 WARP）；正見同名函式只認 Wayback（public.source_unwrap_archive），日本版多兩種、WARP 原網址沒有 scheme 補 http://；TS 版 unwrapJpArchiveUrl 有對齊測試" },
  election_default_name: { mig: [T_APPLY], why: "選舉預設名稱（交件沒給 name 時：<団体名>＋長／知事／議会議員＋選挙）" },
  source_write: { mig: [T_APPLY], why: "登記 sources、掛 source_refs；正見同名 source_write() 的日本版，簽名與回傳都不同（網址陣列、回主要出處 id），不是複本、沒有逐字比對" },
  apply_blocker: { mig: [T_APPLY], why: "落庫的等待條件：外鍵指到的團體還沒進 local_governments 就回等待原因（不繞過外鍵，#503 c）" },
  apply_local_government: { mig: [T_APPLY], why: "local_government 交件落庫（寫 local_governments、出處、履歷）；日本專屬型別" },
  apply_regional_stat: { mig: [T_APPLY], why: "regional_stat 交件落庫（寫 regional_stats）；日本專屬型別" },
  apply_election: { mig: [T_APPLY], why: "election 交件落庫（寫 elections）；日本專屬型別" },
  apply_no_change: { mig: [T_APPLY], why: "no_change 落庫＝記一筆 task_checks（冷卻），不動正式資料（#503）" },
  apply_contribution: { mig: [T_APPLY, T_CAND, T_PROFILE, T_POLICY, T_PE, T_DS, T_DUP, T_PROG, T_LIN, T_PARTY], why: "落庫主函式：verified（或到期的 apply_failed）→ applied／rejected／apply_failed／waiting；重試規則照正見，實作是 SQL 不是 TS" },
  apply_verified_pending: { mig: [T_APPLY], why: "落庫排程掃地機（policy-jp-apply-verified）：撿行內落庫漏掉的 verified 與到期的 apply_failed，只挑不再被擋的列" },
  apply_waiting: { mig: [T_APPLY], why: "（視圖）通過驗證、等團體落庫的交件清單（少數是正常，久了才是問題）；service_role 用" },

  // ---- 20261009210100 gap_arms：兩支新缺口臂＋#503 ----
  task_unavailable: { mig: [T_ARMS, T_KANA], why: "任務現在能不能派（飽和／no_change 等票或已通過／冷卻中／資料型交件通過等落庫），臂在 LIMIT cap 之前用它排除（#503）；前三項與 refresh_dispatch_blocked 同定義，有行為對照測試" },
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
  election_chain_steps: { mig: [T_CHAIN, T_CAND, T_PROFILE, T_POLICY, T_B], why: "選舉鏈的步驟清單（discovery／local_government／regional_stats／region），activity_rules.after_step 的 CHECK 對它" },
  date_or_null: { mig: [T_CHAIN], why: "交件 payload 的日期文字 → DATE，格式不對＝NULL（視圖不能因一筆壞資料整支丟例外）" },
  activity_chain_scope: { mig: [T_CHAIN], why: "派工列的範圍鍵（日本＝團體碼：target.chain_lg_code，沒有就用 lg_code）；總表的 gate 只透過它取，站別鍵名不寫進總表" },
  activity_chain_escape: { mig: [T_CHAIN], why: "選舉鏈逃生門：前一步沒完成時，後備里程碑到了（fallback）或這個任務開過（sticky）就照開" },
  chain_regional_stats_missing: { mig: [T_CHAIN], why: "團體缺的統計（臂與 election_chain_progress 共用同一個判準）；齊了、規則停用、行政区＝NULL" },
  chain_open_elections: { mig: [T_CHAIN], why: "（視圖）選舉鏈「開著的選舉」：已上線的地方選舉＋通過驗證、只在等團體落庫的選舉交件，投票日後 chain_close_after_days（90）天內" },
  chain_step_rank: { mig: [T_PRIO, T_CAND, T_PROFILE, T_POLICY, T_A1, T_B, T_PE, T_DS, T_DUP, T_TERM, T_PROG, T_LIN, T_PARTY, T_CONS], why: "層內排序用的步驟順位（手動 0、選舉發現 1、團體 2、統計 3、其他 auto 9；之後候選人／政見／政黨在這裡多一行）；rebalance_queue 的日本專屬排序鍵" },
  chain_sort_date: { mig: [T_PRIO], why: "層內排序用的日期（target.election_date → vote_window_from → term_end；非 auto: 的列 NULL）；rebalance_queue 與 seed 共用" },
  chain_date_tier: { mig: [T_PRIO], why: "日期 → 優先層（<=60 天前段、<=180 天中段、更遠後段）；選舉發現沒有選舉列，seed 靠它定層，鏈上兩支臂靠 activity_rules 的規則（同一組天數）" },
  election_chain_progress: { mig: [T_CHAIN, T_CAND, T_PROFILE, T_POLICY, T_B], why: "（視圖）選舉鏈進度：開著的選舉×團體×步驟一列一個 done；總表的 chain_gate 在 seed 時讀它（MATERIALIZED）" },

  // ---- 20261009280000 same_claim：同一件事只能有一筆（#521，日本站試點；正見九合一之後才接，所以不是複本） ----
  same_claim_office: { mig: [T_SAME], why: "選舉種類 → 比對用的職位（head／assembly；國政＝種類本身），同 term_expirations.office_kind" },
  same_claim_same_term: { mig: [T_SAME], why: "選舉的「同一屆」：regular＝同一列任期満了的 [−180, +60] 窗口（查不到就差 ≤ 180 天）、其他事由＝同一天" },
  same_claim_matches: { mig: [T_SAME, T_PROFILE, T_POLICY, T_PE, T_DS], why: "登記表的 SQL 那一半：型別＋payload → 在庫列與審議中提交（附 your_network_voted）；jp-report 交件擋 resolved_claim、jp-next 附 same_claims" },
  same_claim_same_content: { mig: [T_SAME2, T_PROFILE, T_POLICY, T_KANA, T_PE, T_DS], why: "同一件事的兩筆內容是否相同（收編用：選舉＝投票日・種類・事由、統計＝值・單位、團體＝名稱・讀音・種類）" },
  same_claim_supersede: { mig: [T_SAME2], why: "上線後收編（照正見 2026-09-21 supersedeDuplicates，正見是 TS、日本站是 SQL）：已落庫那筆 → 同一件事內容相同的等票提交 superseded＋edit_history" },
  same_claim_supersede_trg: { mig: [T_SAME2], why: "觸發器函式：election／regional_stat／local_government 轉 applied 時呼叫 same_claim_supersede" },
  same_claim_merge_pending: { mig: [T_SAME2], why: "一次性收編 #531 上線前的重複：兩筆都等票的，後交的票與交件者那一票併進先交的、後交的 superseded" },

  // ---- 20261010010000 console_admin：主控台日本站（#518 第二步；正見版在 20261009260000，參數型別與表都不同所以不是複本） ----
  console_arm_status: { mig: [T_CONSOLE, T_PER_ELECTION, T_SET_BASED], why: "每支臂今天開／關與佇列件數（SECURITY DEFINER，anon 可讀）；正見版讀 activity_open_now 視圖，日本站沒有那張，targets 展開寫在函式裡，election_id 是 TEXT；#69 起沒有臂名的舊列照任務型別歸回臂" },
  console_active_overrides: { mig: [T_CONSOLE], why: "（視圖）目前有效的覆寫；擁有者權限的視圖＋明確 GRANT SELECT（日本站內部表不對 anon 開，正見版是 security_invoker）" },
  console_election_milestones: { mig: [T_CONSOLE], why: "（視圖）每場選舉×里程碑一列，給主控台改日期；擁有者權限的視圖＋明確 GRANT SELECT" },
  console_admin_override_create: { mig: [T_CONSOLE], why: "主控台新增覆寫（service_role 專用）；election_id 是 TEXT，釘 search_path = policy_jp, pg_temp" },
  console_admin_override_revoke: { mig: [T_CONSOLE], why: "主控台撤銷覆寫（service_role 專用）：expires_at 設今天 -1、撤銷原因併進 reason" },
  console_admin_milestone_set: { mig: [T_CONSOLE], why: "主控台改里程碑（service_role 專用）；kind 白名單照日本站八種 CHECK（沒有 qualification_review）" },
  // ---- 20261010110100 主控台時間軸（policy-ops #63；正見版 20261010110000，表的欄位與選舉 id 型別不同，不是複本） ----
  console_stage_of_kind: { mig: [T_TIMELINE], why: "里程碑＋偏移 → 7 段；日本站告示日（立候補受付）起算第 3 段，正見的 announced 算第 2 段" },
  console_arm_stages: { mig: [T_TIMELINE], why: "每支臂的時期：有日期規則照 activity_rules 自動算、否則查 console_arm_stage_map（SECURITY DEFINER，anon 可讀）" },
  console_timeline_elections: { mig: [T_TIMELINE], why: "主控台時間軸的選舉下拉選單：離今天最近 300 場，退件與查無的不列；election_id 是 TEXT" },
  console_timeline: { mig: [T_TIMELINE, T_PER_ELECTION, T_SET_BASED], why: "一場選舉的時間軸 jsonb（里程碑、各臂的段、今天開關、覆寫標記、規則區間；#69 起多這一屆／日常件數與過段標記）；一場選舉一個職位、沒有任期里程碑" },
  console_dispatch_election: { mig: [T_PER_ELECTION], why: "派工列 target → 選舉（election_id、參選紀錄），沒有＝日常；只給主控台算件數，不 GRANT 給 anon；20261010200100 刪掉（改由 console_dispatch_rows 一次算）" },
  console_arm_election_counts: { mig: [T_PER_ELECTION, T_SET_BASED], why: "每支臂 × 每場選舉 × 職位的佇列件數（空＝日常），一次掃 task_dispatches；職位沒寫就用那場選舉的職位；公開唯讀" },
  console_dispatch_arm: { mig: [T_PER_ELECTION], why: "派工列 → 臂（opened_by.arm，沒有就照 task_id 的任務型別歸回）；日本站的任務型別名就是臂名，不在臂清單的不算；只給主控台算件數；20261010200100 刪掉（改由 console_dispatch_rows 一次算）" },
  console_dispatch_rows: { mig: [T_SET_BASED], why: "每一筆自動缺口派工列 → 臂、選舉、職位，一次集合查詢（取代逐列的 console_dispatch_arm／_election）；只給 service_role" },
  console_passive: { mig: [T_PASSIVE], why: "主控台派工頁「被動」段：等驗證交件依來源（web_request／adjudication／agent）；日本站沒有新聞收錄與公民提問，news_* 為空；公開唯讀" },
  console_stage_end: { mig: [T_PER_ELECTION], why: "一場選舉某一段的結束日（告示日、投票日、投票日 +30）；日本站沒有任期里程碑，5～7 段不會過段" },
  // ---- 20261010030000 插隊：正見 20260921000030～32／20261008165000 的 task_boost 系列的日本版。骨架（1980 減 n 分鐘、一次性、LEAST、TRUNCATE 暫存表）同正見，
  //      但 task_boost_matches 的篩選詞彙全換（pref_codes／lg_codes／task_types／kinds／election_before，沒有人物、頭像、縣市、屆別），不是逐字複本，所以登記為日本專屬；行為由 policy-jp-boost.test.ts 守 ----
  task_boost_matches: { mig: [T_BOOST], why: "插隊條件 → 符合的佇列鍵；篩選詞彙是日本專屬（正見的 regions／election_id／election_types／missing_avatar／politician_ids 全拿掉）" },
  task_boost: { mig: [T_BOOST, T_SEC], why: "插隊（驗證列 1980 減 n 分鐘、LEAST；任務列加插隊秒數，20261011360000 起同正見 20261011320000）；骨架同正見 20260921000032，改叫 policy_jp 的表與 task_boost_matches" },
  task_boost_remaining: { mig: [T_BOOST, T_SEC], why: "一筆插隊還剩多少沒領（任務列看插隊秒數，20261011360000 起）；同正見 20260921000030，改叫 policy_jp 的表" },
  verify_dispatch_claim: { mig: [T_CLAIM], why: "驗證派工的原子認領（同網段並行的 /next 不再領到同一筆）；正見 20261011370000 verify_dispatch_claim 的日本版，只換 schema 與 search_path，逐字比對在 verify-claim.test.ts" },

  // ---- 20261010040000 chain_candidacy：選舉鏈第 2 步（參選人有誰）；被重新定義的函式與視圖已在上面各自的 mig 清單裡加了這一支 ----
  chain_task_checked: { mig: [T_CAND, T_KANA], why: "選舉鏈進度用：這個任務有人回報查過（confirmed／not_found）而且還在冷卻中的最近時間；roster 步驟的 done 靠它" },
  candidacy_match_politicians: { mig: [T_CAND, T_KANA], why: "candidacy 落庫的同一人判定（SCHEMA.md：kana＋地區＋birth_year）：同名同讀音、生年不衝突、同團體有參選或任期的人" },
  candidacy_status_rank: { mig: [T_CAND], why: "參選狀態的先後（considering < declared < filed < withdrawn／elected／not_elected）；落庫只准往後走" },
  apply_candidacy: { mig: [T_CAND, T_KANA, T_A1], why: "candidacy 交件落庫（寫 politician_elections，新人才建 politicians；不存得票數）；日本專屬型別" },
  contribution_auto_tasks_roster_check: { mig: [T_CAND, T_KANA], why: "臂：開著的、已上線的選舉的立候補者名簿 → roster_check（正見 raw 臂裡 roster_check 一段的日本版：沒有中選會名冊，完成合図是 no_change）" },

  // ---- 20261010050000 chain_profile：選舉鏈第 3 步（參選人建檔）；被重新定義的函式與視圖已在上面各自的 mig 清單裡加了這一支 ----
  chain_profile_missing: { mig: [T_PROFILE, T_KANA], why: "人物建檔的缺口（birth_year／careers／career_sources）；齊了＝NULL。profile_gap・profile_detail_gap 臂與 election_chain_progress 的 profile 共用同一個判準" },
  chain_profile_done: { mig: [T_PROFILE, T_KANA], why: "人物建檔是否已完成：缺口沒有，或缺口各自被回報查無（no_change not_found）而且還在冷卻中；人物不存在＝false" },
  chain_profile_subjects: { mig: [T_PROFILE], why: "建檔的對象：開著的、已上線的選舉裡有參選紀錄（上線、非退選）的人；多場選舉掛在投票日最早的那一場" },
  apply_politician: { mig: [T_PROFILE, T_KANA], why: "politician 交件落庫（既存的人補生年、學歷・經歷；只補空欄位、違うなら conflict）；日本專屬型別" },
  contribution_auto_tasks_profile_gap: { mig: [T_PROFILE, T_KANA], why: "臂：開著的選舉的參選人生年未登錄 → profile_gap（正見 raw 臂 profile_gap 一段的日本版：日本站人物表只有 name／kana／birth_year）" },
  contribution_auto_tasks_profile_detail_gap: { mig: [T_PROFILE, T_KANA], why: "臂：參選人沒有學歷・經歷，或有項目沒有出處 → profile_detail_gap（正見 profile_details／career_sources 兩支臂的日本版，一支臂兩種 kind）" },
  same_claim_matches_politician: { mig: [T_PROFILE, T_KANA], why: "同一件事（politician）的比對本體：人物 id ＋ 事實（生年・學歷・經歷各項）；same_claim_matches 分派器呼叫" },

  // ---- 20261010120000 kana_optional（policy-ops#60）：既存の関数の再定義（上の各 mig 清單に T_KANA を足した）と新しい三つの小さな関数 ----
  election_notice_date: { mig: [T_KANA], why: "選挙の告示日（election_milestones_all の announced・整場。里程碑表の列が優先、無ければ elections.notice_date）；記録がなければ NULL" },
  candidacy_kana_required: { mig: [T_KANA], why: "candidacy に kana が要るか＝告示日以降か。告示日の記録がない選挙は告示前扱い。apply_candidacy と jp-report の入口（contribute-handler）が同じ関数を見る" },
  roster_not_found_released: { mig: [T_KANA], why: "roster_check の not_found を、告示日が来たので冷卻に数えないか（冷卻＝min(14 日, 告示日の前日まで)）。refresh_dispatch_blocked・task_unavailable・chain_task_checked が共有する一つの判定" },

  // ---- 20261010060000 chain_policy：選舉鏈第 4 步（這次的政見）；被重新定義的函式與視圖已在上面各自的 mig 清單裡加了這一支 ----
  chain_policy_subjects: { mig: [T_POLICY], why: "公約的對象：開著的、已上線的選舉裡 declared／filed／elected／not_elected 的上線參選紀錄（considering 與退選不派）" },
  chain_policy_exists: { mig: [T_POLICY], why: "這筆參選有沒有上線的政見；policy_missing 臂與 election_chain_progress 的 policy 共用" },
  policy_trim: { mig: [T_POLICY], why: "前後の空白（全角空白も）を落とす（政見の題名・要約・分野・原文位置の字數判定）；TS の jpTrim と同じ集合（對齊テスト）" },
  policy_title_key: { mig: [T_POLICY], why: "政見題名的正規化（NFKC・小文字・空白除去）＝同一件事的鍵；TS 版 policyTitleKey 有對齊測試" },
  apply_policy: { mig: [T_POLICY], why: "policy 交件落庫（公約 origin=pledge 掛在參選上；同參選同題名＝unchanged／要約不同＝conflict）；日本專屬型別" },
  contribution_auto_tasks_policy_missing: { mig: [T_POLICY, T_KANA], why: "臂：開著的選舉的候選人（declared 以上）沒有任何公約 → policy_missing（正見 raw 臂 policy_missing 一段的日本版；term_policy_missing 屬於往回補，這一步不做）" },
  // ---- 20261011140000 政見三要素（policy_elements、規則預設關；正見 20261010100000 的日本版） ----
  contribution_auto_tasks_policy_elements: { mig: [T_PE], why: "政見三要素缺口臂（policy_elements_missing）：日本版走選舉鏈（chain_open_elections）、不照搬正見的選前／選後條件；cap／要素／選舉由規則 params 決定" },
  apply_policy_elements: { mig: [T_PE], why: "policy_elements 交件落庫（SQL 版；正見是 TS applyPolicyElements）：衝突不覆蓋已發布列、同內容只補出處" },
  policy_element_normalize: { mig: [T_PE], why: "policy_elements 一個要素的正規化與驗證（與 TS contribution-schema 同規則）" },
  policy_elements_signature: { mig: [T_PE], why: "policy_elements 內容簽章（同一件事比對與收編用）" },
  same_claim_matches_policy_elements: { mig: [T_PE], why: "同一件事（policy_elements）的比對本體：政見 id ＋ 要素種類；same_claim_matches 分派器呼叫" },
  // ---- 20261011170000 議員定数（district_seats、規則は最初から開く；正見 district_seats_missing の日本版） ----
  contribution_auto_tasks_district_seats: { mig: [T_DS], why: "議員定数缺口臂（district_seats_missing）：開いている議会議員選挙で elections.seats 空／選挙区行なし／seats 空の行あり → 1 選挙 1 件；正見の cec 名簿・告示 PDF ではなく条例・選管の告示を案内" },
  apply_district_seats: { mig: [T_DS], why: "district_seats 交件落庫（SQL 版；正見は TS applyDistrictSeats）：elections.seats と election_districts を書く、違う値・別種類・提出外の行は全体 conflict" },
  district_seats_normalize: { mig: [T_DS], why: "district_seats 交件の正規化と検査（at_large／district 混在不可、合計一致；TS contribution-schema と同規則）" },
  district_seats_signature: { mig: [T_DS], why: "district_seats 内容簽章（同一件事の収編用）" },
  // ---- 20261011180000 重複政見（duplicate_policy、規則は預設關）＋交件型別 removal；正見 duplicate_policy／removal の日本版 ----
  contribution_auto_tasks_duplicate_policy: { mig: [T_DUP], why: "重複政見の清査臂（duplicate_policy）：開いている選挙の公開済みの参選で公開済み公約 2 件以上 → 1 参選 1 件、指紋＝[id,title,description] の md5；正見は一人単位・policy_dupe_reviews、日本は参選単位・task_checks confirmed が永久" },
  apply_removal: { mig: [T_DUP, T_CONS], why: "removal 交件落庫（SQL 版；正見は TS applyRemoval）：政見だけ、軟移除は review_status='rejected'（policies に removed_at がない）、edit_history に旧行・新行" },
  // ---- 20261011230000 政党名簿（party_roster／party_gap／party_info，policy-ops#95 D 期；正見 20261006100100／20261007010000／20261008120000／20261008121000 の日本版）----
  party_text_key: { mig: [T_PARTY], why: "政党の書き方 → 照合用の鍵（NFKC・小文字・空白と中黒を除く）。正見の party_alias_key（public、台湾の政党表記）とは別物" },
  party_missing_subjects: { mig: [T_PARTY], why: "所属政党が分からない参選（party_basis も party_text も空・declared 以上・開いている選挙）。party_roster／party_gap の共有素材；正見は cec_candidates 名冊と突き合わせるが日本には機械照合できる名簿がない" },
  party_known_list: { mig: [T_PARTY], why: "任務 target に載せる名簿の政党（選挙の日に存続していたもの最大 60）。代理が party_id を選べるように" },
  party_missing_tasks: { mig: [T_PARTY], why: "party_roster／party_gap の共通本体（臂名で規則を引く）。task_type=party_missing、task_id=auto:party_missing:<参選 id>。正見は candidacy_source_missing の kind=party/party_roster だが、日本の candidacy_source_missing は official 出典を足す任務で衝突するため別型別" },
  contribution_auto_tasks_party_roster: { mig: [T_PARTY], why: "臂 party_roster（投票日 +0 まで）：party_missing_tasks の薄い包み。FOLLOWED 正見 party_roster の窓；DEVIATED 型別は party_missing" },
  contribution_auto_tasks_party_gap: { mig: [T_PARTY], why: "臂 party_gap（投票日 +1 から）：party_missing_tasks の薄い包み。FOLLOWED 正見 party_gap の窓；DEVIATED 型別は party_missing" },
  contribution_auto_tasks_party_info: { mig: [T_PARTY], why: "臂 party_info（task_type=party_info_missing）：参選に書かれた政党の書き方が party_aliases に当たらない → 書き方の鍵ごと一件。正見 party_info_missing の前半だけ（改名・解散日の派工は未移植）" },
  apply_party_info: { mig: [T_PARTY], why: "party_info 交件落庫（正見 applyPartyInfo の日本版＋新規作成）：name＋kana で作る／既存は空欄だけ補完／alias を足す（奪わない）／書き方が当たった参選へ party_id を反映" },
  apply_candidacy_with_party: { mig: [T_PARTY], why: "candidacy 落庫の入口：party／party_id があれば所属の衝突判定→apply_candidacy（不変）→party_basis 空の参選にだけ所属を書く薄い包み" },
  // ---- 20261011240000 資料一致性（placeholder_politicians／policy_validity／mismatch，policy-ops#95 D 期；正見 20261007020000／20261010170000／20261007110000 の日本版）----
  politician_name_is_placeholder: { mig: [T_CONS], why: "名前（と読み）がテスト用のデータに見えるか。正見 public.politician_name_is_placeholder（測試・範例・示範・假資料）の日本版（テスト・ダミー・サンプル・架空・てすと…、英語は単語として）；臂が検出する。入力を拒む触発器は 20261011250000 で追加" },
  politician_attached: { mig: [T_CONS], why: "人物に付いている内容の件数（政見・任期・学歴職歴・政策の継承の役割）。placeholder 任務の target.attached と apply_politician_removal の拒否が共有；正見 politicianRemovalBlockers（TS）の日本版" },
  apply_politician_removal: { mig: [T_CONS], why: "removal（target_table=politicians）の落庫：人物とその人の参選を軟移除（review_status='rejected'）、付いている内容があれば invalid；正見 applyPoliticianRemoval は DELETE（日本は軟移除）" },
  contribution_auto_tasks_placeholder_politicians: { mig: [T_CONS], why: "臂 placeholder_politicians（task_type=placeholder_politician）：テスト名に見える公開済みの人物 → 実在するか調べ removal。正見の『空殼』（orphan）は改掛 reassign_candidacy が前提で搬さない；隔離（他の任務を止める）も搬さない" },
  contribution_auto_tasks_policy_validity: { mig: [T_CONS], why: "臂 policy_validity（正見 raw:policy_validity）：primary の出典がない公開済みの公約 → removal／出典を付けた policy／no_change。正見の correction(source_url) は日本の correction が落庫しないので使わない" },
  contribution_auto_tasks_mismatch: { mig: [T_CONS], why: "臂 mismatch（task_type=policy_election_mismatch）：公約の proposed_date が参選の選挙の投票日より後。正見の Jev 判定と当選者の例外は日本站にない（公約と任期中の施政は origin で分ける）" },

  // ---- 20261011250000 新聞線（news_discovery，policy-ops#95；正見 news-fetch／system-one news_screen の日本版）＋測試名人物の入力拒否 ----
  news_lead_election_type: { mig: [T_NEWS], why: "団体の種類×職（head／assembly）→ 選挙の種類（governor／mayor／ward_mayor／town_mayor／pref_assembly／muni_assembly）。日本の団体種別に固有、行政区は NULL（正見にない）" },
  news_lead_record: { mig: [T_NEWS], why: "新聞の線索を団体×職ごとに作る／併合する（ttl、1 日の新規上限）。正見は新聞から人物×政見の任務を直接開く（news_items.task_id）が、日本版は団体×職の線索表を挟む；jp-news-fetch が service_role で呼ぶ" },
  news_purge: { mig: [T_NEWS], why: "keep_days より古い新聞記事を消す（pg_cron policy-jp-news-purge-daily）。正見は news_items を消さない" },
  jp_news_cron_secret_ok: { mig: [T_NEWS], why: "jp-news-fetch の呼び出し憑證（x-cron-secret）を Vault の jp_news_cron_secret と照合する。jp_system_one_cron_secret_ok と同じ形（正見 bulletin_watch_cron_secret_ok 系）。正見 news-fetch は憑證なしで冷却だけに頼るが、日本版は主線審査 10-11 の流儀に揃えた" },
  contribution_auto_tasks_news_discovery: { mig: [T_NEWS], why: "臂 news_discovery（task_type=election_discovery、target.discovery=news）：新聞の線索 → 突発の選挙の日程を確かめる任務。正見の news_sweep 臂（人物×政見）とは別物で、任期満了ではなく辞職・死去・解散・リコールが起点" },
  politicians_reject_placeholder_name: { mig: [T_NEWS], why: "人物の名前（と読み）がテスト用に見えたら INSERT／UPDATE OF name,kana を拒む触発器関数。正見 politicians_reject_placeholder_name（20261006140000）の日本版（判定は politician_name_is_placeholder(名前, 読み)）" },
  // ---- 20261011210000 政策の継承（lineage／handover，policy-ops#95 C 期第 6 步；正見 20261006034900 の日本版）----
  lineage_level_of: { mig: [T_LIN], why: "団体コード → 脈絡の層級（NULL＝national、kind=prefecture＝regional、他＝local）。正見は region／sub_region の三つ組で county／township を決める、日本は lg_code 一本" },
  lineage_link_level_ok: { mig: [T_LIN], why: "上下級の関連が成り立つか（国→都道府県・市区町村、都道府県→その都道府県内の市区町村）。正見 linkLevelProblem（TS）の日本版、落庫と lineage_links 臂が共有" },
  lineage_candidate_scope: { mig: [T_LIN], why: "lineage_candidates 臂の対象政策（公開済み・人物が引ける・公約は当選済み／届出済み・表明済みの人のもの）。正見は臂の中に直書き（立法委員の政見を県市の格にも入れる一段は日本版では入れない）" },
  lineage_block_key: { mig: [T_LIN], why: "格（層・団体・分野）の鍵の md5 前 12 字（task_id に空白は入れられない）。正見は region/sub_region/category を task_id にそのまま使う" },
  contribution_auto_tasks_lineage_candidates: { mig: [T_LIN], why: "臂 lineage_candidates：格に複数任期にまたがる政策があり脈絡に入っていないものがあれば 1 件（task_id=auto:lineage_candidate:<格の鍵>:<清單指紋>）。FOLLOWED 正見 20261006034900 の task_type・target 形・confirmed は永久；DEVIATED：lineage_candidate_reviews 表を持たず task_checks confirmed（duplicate_policy と同じ）、cap は規則 params" },
  contribution_auto_tasks_handover_missing: { mig: [T_LIN], why: "臂 handover_missing：首長の任期が終わり後任が就いているのに交接の記録がない → task_id=auto:handover_missing:<脈絡 id>:<交接の指紋>。FOLLOWED 正見の task_type・同一人の再選は出さない；DEVIATED：人物×選挙でなく任期（politician_offices）から任期へ、from/to_policy_ids は落庫で自動" },
  contribution_auto_tasks_lineage_roles: { mig: [T_LIN], why: "臂 lineage_roles：脈絡に議員の政策があり役割の記録がない → task_id=auto:lineage_roles_missing:<脈絡 id>。FOLLOWED 正見の task_type・民意代表の範囲；DEVIATED：議員任期の判定は日本の職位（pref_assembly_member 等）" },
  contribution_auto_tasks_lineage_links: { mig: [T_LIN], why: "臂 lineage_links：同じ分野で一つ上の層の脈絡との関連がまだない → task_id=auto:lineage_link_candidate:<下級の脈絡 id>:<指紋>。FOLLOWED 正見の task_type・confirmed は永久；DEVIATED：層は national／regional／local（pref_code で結ぶ）、task_checks で見た記録" },
  apply_lineage: { mig: [T_LIN], why: "lineage 交件落庫（SQL 版；正見は TS applyLineage）：脈絡を建てる／政策を掛け外し／題名等を直す。同名の脈絡・別の脈絡に入った政策は conflict" },
  apply_lineage_participants: { mig: [T_LIN], why: "lineage_participants 交件落庫（正見 applyLineageParticipants の日本版）：一人の一つの根拠に役割は一つ、重交＝上書き、remove で外す。検査を先に全部終える" },
  apply_lineage_handover: { mig: [T_LIN], why: "lineage_handover 交件落庫（正見 applyLineageHandover の日本版）：任期から任期へ、同じ脈絡・同じ一対は 1 件。stop は official 等級の出典。from/to_policy_ids は自動" },
  apply_lineage_link: { mig: [T_LIN], why: "lineage_link 交件落庫（正見 applyLineageLink の日本版）：一対の脈絡で 1 件、上級は下級の一つ上の層" },
  progress_subjects: { mig: [T_PROG], why: "進度追跡の対象政策（progress_stale の素材）：公開済み・終わっていない・公約は当選済みの参選のみ。正見は raw 臂の中に直書き、日本は helper に出して deadline_due と共用" },
  deadline_due_subjects: { mig: [T_PROG], why: "達成期限が過ぎた政策（deadline_due の素材）：policy_elements の期限が過ぎ、期限より後の経過の記録がない。progress_stale の除外判断にも使う" },
  contribution_auto_tasks_progress_stale: { mig: [T_PROG], why: "政策の進捗追跡臂（progress_stale）：stale_days 日動きのない政策 → 1 政策 1 件、task_id=auto:progress_stale:<policy id>；deadline_due の対象は出さない。正見は raw:progress_stale、冷却の段階的延長は移植していない" },
  contribution_auto_tasks_deadline_due: { mig: [T_PROG], why: "達成期限が過ぎた政策の確認臂（deadline_due）：task_id=auto:deadline_due:<policy id>、期限が早い順" },
  apply_policy_progress: { mig: [T_PROG], why: "policy_progress 交件落庫（SQL 版；正見は TS applyPolicyProgress）：status 更新＋tracking_logs 追記＋出典、古い日付の事象は記録だけ" },
  policy_status_label: { mig: [T_PROG], why: "政策の状態の日本語ラベル（追跡記録の本文に使う）" },
  // ---- 20261011190000 現職首長の公約（mayor_policies／term_policies、規則 enabled）；新しい交件型別はなく policy で答える ----
  contribution_auto_tasks_mayor_policies: { mig: [T_TERM], why: "首長候補の公約補充臂（mayor_policies）：開いている首長選挙の declared／filed で、公開済みの公約が 1 件以上 max_policies 件未満 → policy_missing 任務（task_id は policy_missing 臂と同じ）；正見は縣市長 2026 固定の is_2026_mayor_candidate、日本は chain_policy_subjects と規則の election_types" },
  contribution_auto_tasks_term_policies: { mig: [T_TERM], why: "過去の任期の公約の往回補臂（term_policies）：公開済みの任期（politician_offices）の元になった当選の参選に公約が 1 件もなく、同じ団体・職位に開いている選挙がある → term_policy_missing 任務；正見は election_task_config の屆別開關、日本は lookback_years／deep_kinds の params" },
  same_claim_matches_district_seats: { mig: [T_DS], why: "同一件事（district_seats）の比對本體：選挙 id；same_claim_matches 分派器呼叫" },
  same_claim_matches_policy: { mig: [T_POLICY], why: "同一件事（policy）的比對本體：參選紀錄 id ＋ 題名正規化；same_claim_matches 分派器呼叫" },

  // ---- 20261011070000 arms_candidacy_status（policy-ops#95，派工臂對齊正見 A 期第一支）：被重新定義的函式已在上面各自的 mig 清單裡加了這一支 ----
  // 四支臂不是正見的逐字複本（正見的臂是 contribution_auto_tasks_raw 裡的一段、讀中選會名冊與台灣的表，無法逐字比對）。每一條的 why 寫 FOLLOWED（照搬的部分＝正見現行的哪一版）與 DEVIATED（日本站走樣的部分與理由），
  // 正見改了這幾支臂（任務型別、task_id 形狀、文案的判斷分支、窗口規則），要在這裡決定日本版跟不跟。
  chain_candidacy_records: { mig: [T_A1], why: "四支臂共用的對象清單：開著的、已上線選舉的上線參選紀錄（不分狀態）。正見沒有對應物（正見臂各自 JOIN roster_check_scope／regions）；DEVIATED：日本站一個選舉一個職位、沒有名冊表" },
  candidacy_has_official_source: { mig: [T_A1], why: "這筆參選有沒有 official 等級的出典（source_refs 的 politician_elections／politician_election_status × sources.source_kind）。正見 candidacy_source_missing 看 source_note 有無網址；DEVIATED：日本站出處在獨立的 sources 表，判準改成『有 official 等級』（計畫：只有報導的要補選管公表）" },
  contribution_auto_tasks_candidate_status_stale: { mig: [T_A1], why: "臂：告示後仍 considering／declared 的參選 → candidate_status_stale。FOLLOWED 正見 20261010170000 raw:candidate_status_stale（task_id、task_type、reward 1、一人一件、日期條件寫在規則 announced +0～polling +0）；DEVIATED：正見只看 considering（rumored/likely→登記/不參選），日本站沒有傳聞、告示日＝届出日，所以 considering＋declared 都要推進成 filed／withdrawn；不讀 roster_check_scope、不附中選會名冊" },
  contribution_auto_tasks_not_running: { mig: [T_A1], why: "臂：withdrawn＋withdrawn_after_filing=false、沒對過選管一覽的參選 → not_running_recheck。FOLLOWED 正見 20261008161000 not_running（task_id auto:not_running_recheck:<參選 id>、reward 2、排除 withdrawn_after_filing 空／true 與已有欄位變更履歷的）；DEVIATED：沒有 politician_elections.verified 欄，改看 no_change confirmed 的 task_checks；答案 correction（記錄誤、實際有届出的訂正）日本站放不下參選 id（target_id 上限 64 字）也不自動落庫，改 task_suggestion，說明文照實寫" },
  contribution_auto_tasks_withdrawn_filing: { mig: [T_A1], why: "臂：withdrawn＋withdrawn_after_filing 空的參選 → not_running_recheck（kind=withdrawn_filing）。FOLLOWED 正見 20261006220000 withdrawn_filing（task_id auto:not_running_recheck:filing:<參選 id>、reward 2、審議中的答案不重派）；DEVIATED：交件用 candidacy 不是 correction（日本站 correction 不自動落庫、target_id 上限 64 字放不下參選 id，任務會關不掉），apply_candidacy 加空欄位補完分支；不附中選會名冊／已投票屆別的 cec_candidates 線索" },
  contribution_auto_tasks_candidacy_source_missing: { mig: [T_A1], why: "臂：filed 但沒有 official 等級出典的參選 → candidacy_source_missing。FOLLOWED 正見 raw:candidacy_source_missing『參選紀錄沒有可查證的網址』那一種（task_id auto:candidacy_source_missing:<參選 id>、reward 1）；DEVIATED：正見這個型別另有缺縣市／選區／號次／政黨等台灣專屬子類，日本站不搬；判準由 source_note 有無網址改成 sources.source_kind；declared 以下不派（先走 candidate_status_stale）" },

  // ---- 20261011090000 results_terms（policy-ops#95，派工臂對齊正見 B 期）：被重新定義的函式已在上面各自的 mig 清單裡加了這一支 ----
  // 兩支臂與任期同期都不是正見的逐字複本（正見讀中選會名單與台灣的表）。why 寫 FOLLOWED／DEVIATED；正見改了這幾支（任務型別、task_id 形狀、任期的建立與卸任規則），要在這裡決定日本版跟不跟。
  contribution_auto_tasks_election_results: { mig: [T_B], why: "臂：投票日後仍 considering／declared／filed 的參選 → election_result_missing（kind=result）。FOLLOWED 正見 20261010170000 election_results 的任務型別、『已當落／退選的不派』、日期條件寫在規則（投票日 +1 起）；DEVIATED：正見一單位一件、整批 election_results 型＋中選會名單系統票，日本站沒有機械可讀的開票名單也沒有系統票，一人一件交 candidacy（elected／not_elected／withdrawn）" },
  election_seats_needed: { mig: [T_B], why: "選舉的定數（首長 1、議會 elections.seats）。正見沒有對應物（正見照中選會當選名單逐人派）；elected_missing 用它判斷當選者夠不夠" },
  contribution_auto_tasks_elected_missing: { mig: [T_B], why: "臂：當選者少於定數或定數不明的選舉 → election_result_missing（kind=elected_missing、record_missing=true）。FOLLOWED 正見 20261006100000 elected_missing 的任務型別與 record_missing、交 candidacy（elected）、不收票數；DEVIATED：正見照中選會當選名單一人一件，日本站沒有名單，一選舉一件（auto:election_result_missing:elected:<選舉 id>），no_change confirmed 才算照過、一題多份（contributions_drop_dispatch 的 WHEN 排除）" },
  office_position_for: { mig: [T_B], why: "選舉種類 → politician_offices.position（地方 6 種；國政 NULL）。正見 politician_offices 直接存選舉別，沒有對應物" },
  office_term_for: { mig: [T_B], why: "任期的就任日・滿了日（法定）。FOLLOWED 正見 office_term_start／office_term_end 的角色；DEVIATED：台灣全國同一天就任（12-25 等固定日），日本照地方自治法・公職選舉法：定期＝term_expirations 前任滿了日的翌日（滿了在投票前則投票日）、辭職等＝投票日、補欠＝議會滿了日為止；再選舉・國政・查不到滿了日不算" },
  office_id_for: { mig: [T_B], why: "自動建的任期 id（office:<參選 id>）。正見用序號＋politician_election_id 唯一索引；日本站 id 是 TEXT，用前綴標出同期管理的列" },
  politician_offices_sync: { mig: [T_B], why: "任期同期（建・刪・期數・卸任・出典）。FOLLOWED 正見 20261006034510 sync_politician_office_from_election＋politician_offices_close_ended（當選建列、當選取消刪列並留全列履歷、屆滿 term_expired、轉任 took_other_office、只寫已經發生的卸任、edit_history agent office-sync）；DEVIATED：日本站『現職＝end_date 為空』（顯示端不看就任日），所以就任日到了才建列；首長後任就任時前任記 other（inferred）；term_no 是記錄上的回數（正見沒有這欄）" },
  politician_elections_office_sync: { mig: [T_B], why: "觸發器函式：參選的狀態・人物・選舉・公開狀態變了就同期那一筆。FOLLOWED 正見 trg_sync_politician_office（AFTER INSERT OR UPDATE OF …）；DEVIATED：欄位是日本站的 candidacy_status／review_status" },
  politician_offices_pending: { mig: [T_B], why: "（視圖）當選了但還沒有任期的參選：not_started（等就任日）／term_unknown（算不出任期，人確認）／national。正見的 politician_offices_gap 比的是中選會名單，台灣專用、不搬" },

  // ---- 20261011110000 system_one_precheck（系統票の投票端）----
  system_one_precheck_types: { mig: [T_SYSONE], why: "jp-system-one が出典を確かめて系統票を入れる交件型別（candidacy／politician／policy）。正見にない：正見は system_vote_eligible のうち cec_only 以外を全部聞く；日本站は宣稱の形が決まった型だけ（TS JP_PRECHECK_TYPES と対齊、policy-jp-system-one.test.ts）" },
  system_one_precheck_candidates: { mig: [T_SYSONE, T_SYSONE_REASK], why: "系統票の候選。FOLLOWED 正見 20261006141500 system_one_precheck_candidates（pending・出典あり・Jev が判定済みは二度と聞かない・fetch-only は 24 時間後に再取得で最多三次・未判定が先）；DEVIATED：型別を system_one_precheck_types() に絞る、system_vote_cec_only なし、fetch-only の model 名 policy-jp/fetch-only；T_SYSONE_REASK で宣稱の election に投票日が入っていた旧判定は判定済みとみなさない（一度だけ聞き直す）" },
  jp_system_one_cron_secret_ok: { mig: [T_SYSONE], why: "jp-system-one の呼び出し憑證（x-cron-secret）を Vault の jp_system_one_cron_secret と照合する。正見の bulletin_watch_cron_secret_ok／console_fetch_cron_secret_ok と同じ形の日本站版（正見 system-one にはない：主線審查 10-11、有料の Jev を公開で叩かせない）" },
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
/** 公開統計複本的跟進版（正見改了、日本版跟進）：函式名 → 跟進的 migration；public-stats 測試的 STATS_FOLLOWED 逐字比對改讀它 */
const OTHER_COPIES_FOLLOWED: Record<string, string> = { contribution_activity: "20261016000002" };
/** OTHER_COPIES 只准在 T_STATS（＋登記的跟進版）定義（後面的 migration 重新定義＝逃過 public-stats 測試的逐字比對） */
const otherCopiesElsewhere = (scan: Scan) =>
  OTHER_COPIES.filter((n) => scan.defined.get(n)?.join() !== [T_STATS, ...(OTHER_COPIES_FOLLOWED[n] ? [OTHER_COPIES_FOLLOWED[n]] : [])].join());

async function readJpMigrations(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const n of await listMigrations()) if (n.includes("_policy_jp_")) out[n] = await readMig(n);
  return out;
}

Deno.test("走樣：所有 policy_jp migration 定義的函式與視圖＝複本（PAIRS／FOLLOWED／公開統計）＋日本專屬清單 JP_ONLY（新加的不登記就紅、登記了卻沒人定義也紅）；偵測器有還原驗證", async () => {
  const files = await readJpMigrations();
  const ids = Object.keys(files).map(ID);
  for (const t of [T_TABLES, T_DISPATCH, T_ED, ID(FOLLOW_MIG), T_STATS, T_APPLY, T_ARMS, T_LGR, T_STR, T_CHAIN, T_PRIO, "20261008195000", "20261009130200", "20261009250100", "20261009250300", T_BOOST]) {
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
  for (const [n, t] of Object.entries(OTHER_COPIES_FOLLOWED)) assert(guard.includes(`${n}: "${t}_`), `${OTHER_COPY_GUARD} 的 STATS_FOLLOWED 沒有登記 ${n} 的跟進版 ${t}`);
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
  // （選舉鏈は第 2 步以降の migration が election_chain_steps／election_chain_progress を重新定義するので、1 つの migration にしか出てこないものでやる）
  d = bite({ [CHAIN_FILE]: files[CHAIN_FILE].replace("CREATE OR REPLACE FUNCTION policy_jp.date_or_null(", "CREATE OR REPLACE FUNCTION policy_jp.date_or_null_v2(") });
  assertEquals(d.stale, ["date_or_null"]);
  assertEquals(d.unregistered, ["date_or_null_v2"]);
  assertThrows(() => assertNoDrift(d));
  d = bite({ [CHAIN_FILE]: files[CHAIN_FILE].replace("CREATE OR REPLACE VIEW policy_jp.chain_open_elections ", "CREATE OR REPLACE VIEW policy_jp.chain_open_elections_v2 ") });
  assertEquals(d.stale, ["chain_open_elections"]);
  assertThrows(() => assertNoDrift(d));
  // 複本也一樣：PAIRS 登記的名字沒人定義了
  d = registryDrift(scan, new Set([...copies, "ghost_copy"]), JP_ONLY);
  assertEquals(d.stale, ["ghost_copy"]);
  assertThrows(() => assertNoDrift(d));

  // 五、JP_ONLY 的函式被後面的 migration 重新定義（或從 mig 清單漏寫）紅
  d = bite({ [FAKE]: fn("lg_pref_code") });
  assertEquals(d.misplaced, [`lg_pref_code：登記 ${T_APPLY}，實際 ${T_APPLY}、${ID(FAKE)}`]);
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
