/**
 * 測試資料人物的任務隔離（2026-10-08，migration 20261008114000_placeholder_task_isolation.sql）。
 *
 * 起因：「測試候選人ABC／XYZ／QQQ」本來就被 politician_name_is_placeholder 認得、placeholder_politicians 臂也抓到了（ABC、XYZ 各一件任務，QQQ 已有 removal 在等票），
 * 但別的臂把這三個人當真候選人派出去（election_result_missing 三件），placeholder 任務自己排在幾百件之後從來沒被領走。這支 migration：
 *   1. 總表統一擋：target.politician_id 是測試名人物的任務，只留臂 placeholder_politicians 的；
 *   2. 優先層：priority:placeholder_politicians 永遠在前段。
 *
 * 守門分兩半，只要 --allow-read：
 *   A. 文字層：總表新定義＝P1 的定義加兩處機械替換（ph CTE、最後的 WHERE），簽名與 28 個分支一字不差；P1 之後只有這一支重新定義總表；沒有 DROP、沒有動別的函式與資料表
 *   B. PGlite：分支輸出回放（含測試人物的各種任務、真人、名字像但不是測試的人、target 沒有 politician_id、politician_id 不是 uuid），真的跑 P0／P1 與這支，
 *      改前改後逐件比：差集剛好是測試人物的非 placeholder 任務、新增 0 件；改名後任務回來；優先層解析（placeholder 在前段、別的臂不變）；重跑安全
 *   C. 還原驗證：改壞 migration 一處，對應的守門必須紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyP2, armsDiff, buildArmsDb, fnText, type GapRow, latestFn, migrationNames, mutate, P1_MIG, readMig } from "./arms-pglite.ts";

const MIG = "20261008114000_placeholder_task_isolation.sql";
const QP_MIG = "20261008090000_queue_priority_tiers.sql";
const MIG_SQL = await readMig(MIG);
const P1 = await readMig(P1_MIG);
const QP = await readMig(QP_MIG);

function between(sql: string, start: string, end: string): string {
  const a = sql.indexOf(start);
  assert(a >= 0, `找不到起點：${start.slice(0, 50)}`);
  const b = sql.indexOf(end, a);
  assert(b >= 0, `找不到終點：${end.slice(0, 50)}`);
  return sql.slice(a, b + end.length);
}

// ============================================================
// A. 文字層
// ============================================================
const bodyOf = (fn: string) => fn.slice(fn.indexOf("$$\n") + 3, fn.lastIndexOf("$$;"));
const OLD_ARMS = fnText(P1, "contribution_auto_tasks_arms");
const NEW_ARMS = fnText(MIG_SQL, "contribution_auto_tasks_arms");

const PH_CTE = "       -- 姓名看起來是測試資料的人物（2026-10-08）：他們的任務只走 placeholder_politician（見檔頭）\n       ph AS MATERIALIZED (SELECT p.id::TEXT AS pid FROM politicians p WHERE politician_name_is_placeholder(p.name)),\n       phe AS MATERIALIZED (SELECT pe.id AS peid FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name)),\n";
const WHERE_NEW = "   WHERE g.arm = 'placeholder_politicians'\n      OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)\n              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT))\n";

/** 新總表倒推回 P1 的總表：拿掉 ph CTE 與最後的 WHERE。結構不對就丟錯 */
function reverseArms(fn: string): string {
  let s = mutate(fn, PH_CTE, "");
  s = mutate(s, WHERE_NEW, "");
  return s;
}
const isMechanical = (fn: string) => {
  try {
    return reverseArms(fn) === OLD_ARMS;
  } catch {
    return false;
  }
};

Deno.test("A1 這支是總表的最後一版，緊接著 P1（中間或之後有人改了，抄的底就過期）", async () => {
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms(")) defining.push(n);
  const i = defining.indexOf(MIG);
  assert(i > 0, "這支要在重新定義總表的清單裡");
  assertEquals(defining[i - 1], P1_MIG, "總表的前一版應該是 P1；有人在中間改了，要以那一版為底重做");
  // 這支之後只允許 party_roster 那支 P2（20261008121000：總表多回傳被規則濾掉的列，這支的測試名人物過濾整段保留，守門在 activity-party-roster.test.ts）
  assertEquals(defining.slice(i + 1), ["20261008121000_activity_windows_p2_party_roster.sql"], "這支之後又有人改了總表：要以最新那版為底重做");
});

Deno.test("A2 總表新定義＝P1 的定義＋兩處機械替換（ph CTE、最後的 WHERE），簽名與 28 個分支一字不差", () => {
  assert(isMechanical(NEW_ARMS));
  assertEquals(reverseArms(NEW_ARMS), OLD_ARMS);
  // 回傳型別沒變（9 欄）：CREATE OR REPLACE 就夠，不用 DROP
  assertEquals(NEW_ARMS.split("\n").slice(0, 3).join("\n"), OLD_ARMS.split("\n").slice(0, 3).join("\n"));
  assert(bodyOf(NEW_ARMS).includes("UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM contribution_auto_tasks_placeholder_politicians() t"));
});

Deno.test("A2b 兩個 CTE 都是 MATERIALIZED（過濾是 strpos 不是等號，沒有它每一列都重掃 politicians 的姓名正則，正式庫實測撞 statement timeout）", () => {
  assert(NEW_ARMS.includes("ph AS MATERIALIZED (") && NEW_ARMS.includes("phe AS MATERIALIZED ("));
  assert(!isMechanical(NEW_ARMS.replace("ph AS MATERIALIZED (", "ph AS (")), "拿掉 MATERIALIZED 就不是約定的機械替換");
});

Deno.test("A3 這支只動總表與一條優先規則：不 DROP、不刪表欄、不碰別的函式、不寫 politicians／政見／參選紀錄（測試資料走 removal，不直接刪）", () => {
  const code = MIG_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/DROP /i.test(code), "沒有任何 DROP");
  assertEquals([...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]), ["contribution_auto_tasks_arms"], "只重寫總表");
  assert(!/\b(DELETE FROM|TRUNCATE)\b/i.test(code));
  assert(!/\b(UPDATE|INSERT INTO)\s+(politicians|politician_elections|policies|tracking_logs|politician_keys|elections)\b/i.test(code), "不寫任何正式資料表");
  assertEquals((code.match(/INSERT INTO activity_rules/g) ?? []).length, 1, "只種一條優先規則");
  assert(code.includes("'priority:placeholder_politicians', 'always', 1"), "層 1＝前段，永遠開");
});

Deno.test("A4 還原驗證（文字層）：多改一個字、少一處替換、拿掉臂的豁免，A2 都要紅", () => {
  assert(!isMechanical(mutate(NEW_ARMS, "FROM politicians p WHERE politician_name_is_placeholder(p.name)),", "FROM politicians p WHERE politician_name_is_placeholder(p.name) AND p.merged_into IS NULL),")));
  assert(!isMechanical(mutate(NEW_ARMS, "    FROM keyed g\n", "    FROM keyed g\n    /* 多一句 */\n")));
  assert(!isMechanical(mutate(NEW_ARMS, PH_CTE, "")), "少 CTE（reverse 也會丟錯）");
  assert(!isMechanical(mutate(NEW_ARMS, "   WHERE g.arm = 'placeholder_politicians'\n      OR NOT (EXISTS", "   WHERE NOT (EXISTS")), "拿掉臂的豁免");
  assert(!isMechanical(OLD_ARMS), "P1 的原版不是「機械替換之後」的樣子");
});

// ============================================================
// B. PGlite
// ============================================================
const ABC = "cbc0bf95-5d9e-4050-b647-5a5346e75127";
const XYZ = "700eaebe-3105-4484-b8f3-25c6685ee8b2";
const QQQ = "98abab74-2e5c-4e11-9c8e-5f3f432f6ec4";
const REAL = "11111111-1111-1111-1111-111111111111";
const LATIN = "22222222-2222-2222-2222-222222222222"; // 名字像但不是測試：Testa Sampleton
const TESTEN = "33333333-3333-3333-3333-333333333333"; // Mr. Test
const NAMES: Record<string, string> = { [ABC]: "測試候選人ABC", [XYZ]: "測試候選人XYZ", [QQQ]: "測試候選人QQQ", [REAL]: "王小明", [LATIN]: "Testa Sampleton", [TESTEN]: "Mr. Test" };

const row = (task_id: string, task_type: string, target: Record<string, unknown> | null, region: string | null = "台東縣"): GapRow => ({
  task_id, task_type, target, what_we_need: `需求 ${task_id}`, hint_sources: ["https://example.test/x"], reward: 1, region,
});
const cand = (pid: string, peId: number) => ({ politician_id: pid, name: NAMES[pid], election_id: 2024, election_type: "立法委員", pe_id: peId });

// 回放的分支輸出：測試人物被各種臂派出去、真人與名字像的人照常、沒有 politician_id 的、politician_id 不是 uuid 的
const BRANCHES = {
  raw: [
    row("auto:election_result_missing:34401", "election_result_missing", cand(ABC, 34401)),
    row("auto:election_result_missing:34402", "election_result_missing", cand(XYZ, 34402)),
    row("auto:election_result_missing:34403", "election_result_missing", cand(QQQ, 34403)),
    row("auto:election_result_missing:50001", "election_result_missing", cand(REAL, 50001)),
    row("auto:election_result_missing:50002", "election_result_missing", cand(LATIN, 50002)),
    row("auto:progress_stale:t1", "progress_stale", { policy_id: "p-t1", politician_id: TESTEN, election_id: 2026, election_type: "縣市長" }),
    row("auto:policy_missing:no-person", "policy_missing", { election_id: 2026, election_type: "縣市長", name: "沒有 politician_id" }),
  ],
  elected_missing: [
    row("auto:elected_missing:abc", "election_result_missing", cand(ABC, 1)),
    row("auto:elected_missing:real", "election_result_missing", cand(REAL, 2)),
  ],
  policy_elements: [
    row("auto:policy_elements_missing:abc", "policy_elements_missing", { policy_id: "p-abc", politician_id: ABC, election_id: 2026, election_type: "縣市長" }),
    row("auto:policy_elements_missing:real", "policy_elements_missing", { policy_id: "p-real", politician_id: REAL, election_id: 2026, election_type: "縣市長" }),
  ],
  career_sources: [row("auto:profile_detail_gap:testen", "profile_detail_gap", { politician_id: TESTEN, kind: "career_sources" })],
  // 人物不放在頂層 politician_id 的各種 target 形狀（整份 target 文字含測試人物 id 就擋）
  dup: [
    row("auto:duplicate_politician:abc-real", "duplicate_politician", { a: { id: ABC, name: NAMES[ABC] }, b: { id: REAL, name: NAMES[REAL] } }), // a.id／b.id 巢狀
    row("auto:duplicate_politician:real-latin", "duplicate_politician", { a: { id: REAL }, b: { id: LATIN } }), // 兩邊都是真人：不動
  ],
  handover_missing: [
    row("auto:handover_missing:from-testen", "handover_missing", { from_politician_id: TESTEN, to_politician_id: REAL, lineage_id: "l1" }), // from_／to_politician_id
    row("auto:handover_missing:to-xyz", "handover_missing", { from_politician_id: REAL, to_politician_id: XYZ, lineage_id: "l2" }),
    row("auto:handover_missing:real", "handover_missing", { from_politician_id: REAL, to_politician_id: LATIN, lineage_id: "l3" }),
  ],
  lineage_roles: [
    row("auto:lineage_roles_missing:abc", "lineage_roles_missing", { lineage_id: "l4", people: [{ politician_id: REAL, name: NAMES[REAL] }, { politician_id: ABC, name: NAMES[ABC] }] }), // people 陣列
    row("auto:lineage_roles_missing:real", "lineage_roles_missing", { lineage_id: "l5", people: [{ politician_id: REAL, name: NAMES[REAL] }] }),
  ],
  election_results: [
    // 批次任務放的是參選紀錄 id（陣列），不是人物 id：含測試人物的參選紀錄 id 就擋
    row("auto:election_results_missing:batch-test", "election_results_missing", { election_id: 2024, election_type: "立法委員", region: "台東縣", politician_election_ids: [50001, 34402, 50002] }),
    row("auto:election_results_missing:batch-real", "election_results_missing", { election_id: 2024, election_type: "立法委員", region: "花蓮縣", politician_election_ids: [50001, 50002] }),
    // 數字只是「長得像」：134401、3440 含有 34401／3440 的字串，但不是同一個 id，不能誤擋（不做文字子字串比對）
    row("auto:election_results_missing:batch-lookalike", "election_results_missing", { election_id: 2024, election_type: "立法委員", region: "宜蘭縣", politician_election_ids: [134401, 3440, 344010] }),
  ],
  withdrawn_filing: [
    row("auto:not_running_recheck:single-pe", "not_running_recheck", { politician_election_id: 34403, election_id: 2026, election_type: "縣市長" }), // 單一 politician_election_id
    row("auto:not_running_recheck:single-pe-real", "not_running_recheck", { politician_election_id: 50001, election_id: 2026, election_type: "縣市長" }),
  ],
  party_info: [row("auto:party_info_missing:null-target", "party_info_missing", null)], // target 是 NULL：留著，不能被 NULL 比對吃掉
  mismatch: [row("auto:policy_election_mismatch:bad", "policy_election_mismatch", { politician_id: "not-a-uuid", election_id: 2026, election_type: "縣市長" })], // 不是 uuid 的字串：不能丟轉型錯誤
  placeholder_politicians: [
    row("auto:placeholder_politician:" + ABC, "placeholder_politician", { kind: "name", politician_id: ABC, name: NAMES[ABC] }),
    row("auto:placeholder_politician:" + XYZ, "placeholder_politician", { kind: "name", politician_id: XYZ, name: NAMES[XYZ] }),
    row("auto:placeholder_politician:" + REAL, "placeholder_politician", { kind: "orphan", politician_id: REAL, name: NAMES[REAL] }), // 空殼那一種：真人，臂本來就會派
  ],
};
/** 測試人物的非 placeholder 任務（新總表該少掉的） */
const EXCLUDED = [
  "auto:election_result_missing:34401", "auto:election_result_missing:34402", "auto:election_result_missing:34403",
  "auto:elected_missing:abc", "auto:policy_elements_missing:abc", "auto:profile_detail_gap:testen", "auto:progress_stale:t1",
  // 非頂層鍵的形狀
  "auto:duplicate_politician:abc-real", "auto:handover_missing:from-testen", "auto:handover_missing:to-xyz", "auto:lineage_roles_missing:abc",
  "auto:election_results_missing:batch-test", "auto:not_running_recheck:single-pe",
].sort();
/** 同一批形狀裡不該被擋的（真人、數字長得像、NULL） */
const KEPT_SHAPES = [
  "auto:duplicate_politician:real-latin", "auto:handover_missing:real", "auto:lineage_roles_missing:real", "auto:election_results_missing:batch-real",
  "auto:election_results_missing:batch-lookalike", "auto:not_running_recheck:single-pe-real", "auto:party_info_missing:null-target",
];
const KEPT_PLACEHOLDER = [`auto:placeholder_politician:${ABC}`, `auto:placeholder_politician:${XYZ}`, `auto:placeholder_politician:${REAL}`].sort();

const PRIORITY_BITS = [
  between(QP, "CREATE TABLE IF NOT EXISTS task_priority_tiers (", "ON CONFLICT (id) DO NOTHING;"),
  between(QP, "ALTER TABLE activity_rules ADD COLUMN IF NOT EXISTS priority", "CHECK ((activity LIKE 'priority:%') = (priority IS NOT NULL));"),
  between(QP, "INSERT INTO activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, election_types, priority, note)", "WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.priority IS NOT NULL);"),
  fnText(QP, "activity_priority"),
].join("\n");
const P1_COPY = OLD_ARMS.replace("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()", "CREATE OR REPLACE FUNCTION p1_arms()");

type Built = { db: PGlite; prio: Record<string, number | null> };
const PRIO_PROBES: Array<[string, number | null, string | null]> = [
  ["placeholder_politicians", null, null],
  ["raw:election_result_missing", 2024, "立法委員"],
  ["raw:policy_missing", 2026, "縣市長"],
  ["dup", null, null],
  ["policy_elements", 2026, "縣市長"],
];
const prioOf = async (db: PGlite): Promise<Record<string, number | null>> => {
  const out: Record<string, number | null> = {};
  for (const [arm, eid, et] of PRIO_PROBES) {
    out[`${arm}|${eid}|${et}`] = (await db.query<{ priority: number }>(`SELECT priority::int AS priority FROM activity_priority($1, $2::int, $3::text, DATE '2026-10-08')`, [arm, eid, et])).rows[0]?.priority ?? null;
  }
  return out;
};

async function build(mutateMig: (sql: string) => string = (s) => s, names: Record<string, string> = NAMES): Promise<Built> {
  const db = await buildArmsDb({ branches: BRANCHES });
  await db.exec("CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid)");
  await db.exec("CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL)");
  for (const [peId, pid] of [[34401, ABC], [34402, XYZ], [34403, QQQ], [50001, REAL], [50002, LATIN]] as const) await db.query("INSERT INTO politician_elections (id, politician_id) VALUES ($1, $2)", [peId, pid]);
  await db.exec(await latestFn("politician_name_is_placeholder"));
  for (const [id, name] of Object.entries(names)) await db.query("INSERT INTO politicians (id, name) VALUES ($1, $2)", [id, name]);
  await db.exec(PRIORITY_BITS);
  await db.exec(P1_COPY); // 套之前的總表（P1）複本，改前改後逐件比用
  const before = await prioOf(db);
  await applyP2(db, mutateMig(MIG_SQL), []);
  return { db, prio: before };
}

type Verdicts = Record<string, boolean>;
async function guard(out: Verdicts, name: string, f: () => Promise<boolean>) {
  try {
    out[name] = await f();
  } catch {
    out[name] = false;
  }
}
const ids = async (db: PGlite, fn: string, where = "true") => (await db.query<{ task_id: string }>(`SELECT task_id FROM ${fn}() WHERE ${where}`)).rows.map((r) => r.task_id).sort();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function runSuite({ db, prio: prioBefore }: Built): Promise<Verdicts> {
  const v: Verdicts = {};
  const oldIds = await ids(db, "p1_arms");
  let newIds: string[] = []; // 總表丟錯（例如過濾寫成會轉型失敗）也要變成「守門紅」，不是整支測試炸掉
  let evalError = false;
  try {
    newIds = await ids(db, "contribution_auto_tasks_arms");
  } catch {
    evalError = true;
  }

  await guard(v, "excluded_exactly_test_people_non_placeholder", async () => {
    // 改前改後逐件比：舊有新沒有＝測試人物的非 placeholder 任務；新有舊沒有＝0
    const d = await armsDiff(db, "p1_arms", "contribution_auto_tasks_arms");
    const gone = oldIds.filter((x) => !newIds.includes(x)).sort();
    return d.bOnly === 0 && d.aOnly === EXCLUDED.length && same(gone, EXCLUDED) && d.aN === oldIds.length && d.bN === newIds.length;
  });
  await guard(v, "placeholder_arm_kept", async () => same(await ids(db, "contribution_auto_tasks_arms", "arm = 'placeholder_politicians'"), KEPT_PLACEHOLDER));
  await guard(v, "real_and_lookalike_people_kept", async () => {
    const keep = ["auto:election_result_missing:50001", "auto:election_result_missing:50002", "auto:elected_missing:real", "auto:policy_elements_missing:real"];
    return keep.every((k) => newIds.includes(k));
  });
  await guard(v, "same_shapes_kept_for_real_people", async () => !evalError && KEPT_SHAPES.every((k) => newIds.includes(k)));
  await guard(v, "nested_shapes_all_excluded", async () => {
    // 逐一確認：非頂層鍵的每一種形狀都擋到（EXCLUDED 的比對是整體集合，這條把形狀分開講，紅了看得出是哪一種漏）
    const shapes = ["auto:duplicate_politician:abc-real", "auto:handover_missing:from-testen", "auto:handover_missing:to-xyz", "auto:lineage_roles_missing:abc", "auto:election_results_missing:batch-test", "auto:not_running_recheck:single-pe"];
    return !evalError && shapes.every((k) => oldIds.includes(k) && !newIds.includes(k));
  });
  await guard(v, "rows_without_person_key_kept", async () => {
    // target 沒有 politician_id（NULL）、politician_id 不是 uuid 的字串：都留著，也不能丟錯（NOT IN 遇到 NULL 會把整列吃掉、轉型 uuid 會炸）
    return !evalError && ["auto:policy_missing:no-person", "auto:policy_election_mismatch:bad"].every((k) => newIds.includes(k));
  });
  await guard(v, "output_shape_unchanged", async () => {
    const cols = (await db.query(`SELECT * FROM contribution_auto_tasks_arms() LIMIT 0`)).fields.map((f) => f.name);
    const colsOld = (await db.query(`SELECT * FROM p1_arms() LIMIT 0`)).fields.map((f) => f.name);
    return same(cols, colsOld) && cols.length === 9;
  });
  await guard(v, "lookalike_names_not_flagged", async () => {
    const r = await db.query<{ id: string; ph: boolean }>(`SELECT id::text, politician_name_is_placeholder(name) AS ph FROM politicians ORDER BY id`);
    const flagged = r.rows.filter((x) => x.ph).map((x) => x.id).sort();
    return same(flagged, [ABC, XYZ, QQQ, TESTEN].sort()); // Testa Sampleton 不算（英文字要是完整的詞）
  });

  // 隨資料變：測試名人物改成正常名字，他的任務就回來；測試名一加回去又擋
  await guard(v, "follows_the_data", async () => {
    await db.query(`UPDATE politicians SET name = '王大明' WHERE id = $1`, [ABC]);
    const back = await ids(db, "contribution_auto_tasks_arms", "task_id IN ('auto:election_result_missing:34401', 'auto:elected_missing:abc', 'auto:policy_elements_missing:abc')");
    await db.query(`UPDATE politicians SET name = '測試候選人ABC' WHERE id = $1`, [ABC]);
    const again = await ids(db, "contribution_auto_tasks_arms", "task_id IN ('auto:election_result_missing:34401', 'auto:elected_missing:abc', 'auto:policy_elements_missing:abc')");
    return back.length === 3 && again.length === 0;
  });
  await guard(v, "removed_person_leaves_no_trace", async () => {
    // 人物被 removal 移除（列刪掉）之後，他的任務在 p1 總表也不會有 politician 可查——但分支回放仍在；這裡只確認「人物不在了，總表不會因此出錯」
    await db.query(`DELETE FROM politicians WHERE id = $1`, [QQQ]);
    const ok = (await ids(db, "contribution_auto_tasks_arms")).length > 0;
    await db.query(`INSERT INTO politicians (id, name) VALUES ($1, '測試候選人QQQ')`, [QQQ]);
    return ok;
  });

  // ---- 優先層 ----
  await guard(v, "placeholder_in_front_tier", async () => {
    const r = await db.query<{ priority: number; rule_id: number | null }>(`SELECT priority::int, rule_id::int FROM activity_priority('placeholder_politicians', NULL, NULL, DATE '2026-10-08')`);
    const rule = await db.query<{ id: number }>(`SELECT id::int FROM activity_rules WHERE activity = 'priority:placeholder_politicians'`);
    return r.rows.length === 1 && r.rows[0].priority === 1 && rule.rows.length === 1 && r.rows[0].rule_id === rule.rows[0].id;
  });
  await guard(v, "other_arms_priority_unchanged", async () => {
    const after = await prioOf(db);
    const keys = Object.keys(after).filter((k) => !k.startsWith("placeholder_politicians|"));
    return keys.length === PRIO_PROBES.length - 1 && keys.every((k) => after[k] === prioBefore[k]) && prioBefore["placeholder_politicians|null|null"] === 2;
  });

  // 已知限制（見 migration 檔頭與計畫第 11 節）：activity_priority() 取號碼最大的規則；若測試人物任務的 target 帶上 election_id，選舉通則（2024 投票日後 181 天起＝後段 3）蓋掉這條規則。
  // 這條把「現在是這樣」釘住：之後有人改 activity_priority()（讓規則可以釘層）或讓臂帶 election_id，這裡會紅，提醒同步改文件。
  await guard(v, "known_limitation_election_id_overrides_front_tier", async () => {
    const r = await db.query<{ priority: number }>(`SELECT priority::int FROM activity_priority('placeholder_politicians', 2024, '立法委員', DATE '2026-10-08')`);
    return r.rows.length === 1 && r.rows[0].priority === 3;
  });

  // ---- 重跑安全 ----
  await guard(v, "rerun_is_safe", async () => {
    const before = await ids(db, "contribution_auto_tasks_arms");
    await applyP2(db, MIG_SQL_FOR_RERUN.v, []);
    const rules = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM activity_rules WHERE activity = 'priority:placeholder_politicians'`);
    return same(before, await ids(db, "contribution_auto_tasks_arms")) && rules.rows[0].n === 1;
  });
  return v;
}
const MIG_SQL_FOR_RERUN = { v: MIG_SQL };

Deno.test("B 測試人物的任務隔離（PGlite 跑 P0／P1／這支）：全部守門通過", async () => {
  MIG_SQL_FOR_RERUN.v = MIG_SQL;
  const v = await runSuite(await build());
  const red = Object.entries(v).filter(([, ok]) => !ok).map(([k]) => k);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
  assert(Object.keys(v).length >= 10, "守門數不該變少");
});

// ============================================================
// C. 還原驗證
// ============================================================
type Pair = [from: string, to: string];
const REVERT: Array<[label: string, pairs: Pair[], mustBeRed: string[]]> = [
  ["拿掉總表的過濾（測試人物又被別的臂派出去）", [[WHERE_NEW, ""]], ["excluded_exactly_test_people_non_placeholder", "follows_the_data"]],
  ["連 placeholder 臂自己的任務也擋掉（拿掉臂的豁免）", [["   WHERE g.arm = 'placeholder_politicians'\n      OR NOT (EXISTS", "   WHERE NOT (EXISTS"]], ["placeholder_arm_kept", "excluded_exactly_test_people_non_placeholder"]],
  ["只看頂層 politician_id（巢狀、from_／to_、people 陣列、a／b 的形狀擋不到）", [["strpos(g.target::TEXT, ph.pid) > 0", "ph.pid = g.target->>'politician_id'"]],
    ["nested_shapes_all_excluded", "excluded_exactly_test_people_non_placeholder"]],
  ["比對寫成轉 uuid（非 uuid 字串會丟錯）", [["strpos(g.target::TEXT, ph.pid) > 0", "ph.pid::uuid = (g.target->>'politician_id')::uuid"]], ["rows_without_person_key_kept", "excluded_exactly_test_people_non_placeholder"]],
  ["拿掉參選紀錄 id 的比對（election_results 批次與單一 politician_election_id 擋不到）", [["              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT))", "              )"]],
    ["nested_shapes_all_excluded", "excluded_exactly_test_people_non_placeholder"]],
  ["參選紀錄 id 改成文字子字串比對（134401 這種長得像的批次被誤擋）", [["g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT", "strpos(g.target::TEXT, phe.peid::TEXT) > 0"]],
    ["same_shapes_kept_for_real_people"]],
  ["NOT (EXISTS …) 寫成 NOT IN（target 為 NULL 的列被吃掉）", [["OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)", "OR g.target::TEXT NOT IN (SELECT pid FROM ph) AND NOT (false"]], ["same_shapes_kept_for_real_people"]],  ["測試名人物集合多擋真人（所有人都當測試）", [["FROM politicians p WHERE politician_name_is_placeholder(p.name)),", "FROM politicians p WHERE true),"]], ["real_and_lookalike_people_kept", "excluded_exactly_test_people_non_placeholder"]],
  ["優先層放中段", [["'priority:placeholder_politicians', 'always', 1,", "'priority:placeholder_politicians', 'always', 2,"]], ["placeholder_in_front_tier"]],
  ["優先規則的活動名寫錯（對不到臂）", [["'priority:placeholder_politicians', 'always', 1,", "'priority:placeholder_politician', 'always', 1,"]], ["placeholder_in_front_tier"]],
  ["優先規則每次重跑都再種一條", [[" WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'priority:placeholder_politicians');", ";"]], ["rerun_is_safe"]],
];
for (const [label, pairs, mustBeRed] of REVERT) {
  Deno.test(`C 還原驗證：${label} → ${mustBeRed.join("、")} 要紅`, async () => {
    const mut = (sql: string) => pairs.reduce((s, [from, to]) => mutate(s, from, to), sql);
    MIG_SQL_FOR_RERUN.v = mut(MIG_SQL);
    try {
      const v = await runSuite(await build(mut));
      for (const name of mustBeRed) assertEquals(v[name], false, `改壞「${label}」之後，守門 ${name} 還是綠的（它沒有守住這件事）`);
    } finally {
      MIG_SQL_FOR_RERUN.v = MIG_SQL;
    }
  });
}
