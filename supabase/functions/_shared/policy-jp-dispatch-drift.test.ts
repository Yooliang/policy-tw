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
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

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
    note: "只拿掉中選會名冊那條路（contribution_roster_matched）；系統票調門檻的邏輯照抄",
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
      if (copies.has(m[1]) && !(name === FOLLOW_MIG && m[1] in FOLLOWED)) offenders.push(`${name}：${m[1]}`);
    }
  }
  assertEquals(offenders, [], "已登記的複本要改，就去改走樣守門的登記（PAIRS 加 edits／before，或照 FOLLOWED 登記跟進版），不要在後面的 migration 悄悄重新定義");
  assert(later.includes(FOLLOW_MIG), "跟進版也在掃描範圍裡（放行靠登記，不是靠沒掃到）");
  // 偵測器自己也驗一次：把一個複本函式名放進假的檔案文字，抓得到
  const fake = "CREATE OR REPLACE FUNCTION policy_jp.contribution_required_agree(p_type TEXT) RETURNS INTEGER";
  assertEquals([...fake.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]).filter((n) => copies.has(n)), ["contribution_required_agree"]);
});
