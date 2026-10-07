/**
 * 派工時間窗 P2（一支臂一個 PR）改前改後的「逐件不變」守門（2026-10-08，docs/PLAN-task-activation.md）。
 *
 * P2 把各臂臂內的日期條件拿掉、改成規則。臂的新本體會多算窗口以外的屆別，再由總表依規則濾掉，
 * 所以要證明的是：新本體的輸出，濾掉「窗口以外的選舉」之後，跟正式庫現行（舊本體）逐件相同。做法（沿用 scripts/arms-parity.ts：正式庫唯讀快照灌 PGlite、全欄雜湊、負向對照）：
 *
 *   gen：   讀 scripts/arms-parity.sql（總表現行輸出與 28 個分支的真實輸出），再附上「這一步 migration 裡新臂本體」在正式庫上的輸出（branches_new；
 *           新本體以子查詢原樣放進去、唯讀執行，不建立任何物件）。一個 SELECT＝一個查詢快照，新舊輸出是同一個時間點。
 *   check： ① 舊分支輸出 + P0／P1 + 之前各步 = 正式庫現行總表（stub 沒走樣）
 *           ② 這一步的臂：新輸出比舊輸出「多的列」恰好是窗口以外的選舉的列，「少的列」是 0（兩個方向的 EXCEPT）；其他分支沒動
 *           ③ 新分支輸出 + P0／P1／各步：今天的總表（筆數、全欄雜湊、逐件 md5）＝正式庫現行總表
 *           ④ 假時鐘：投票日當天與隔天的筆數（起日型：11-28 不開、11-29 開；迄日型：11-28 還開、11-29 關）；舊選舉在每個日期都照常
 *           ⑤ 負向對照（還原驗證）：改壞這一步的 migration，上面的對應檢查必須紅；這組不紅，③④什麼都驗不出來
 *
 * 步驟（STEPS，依上線順序；「之前各步」假設已經上線——正式庫現行輸出已經反映它們，PGlite 套它們的規則）：
 *   election_results（起日型）、party_gap（起日型）；party_roster（迄日型）見該 PR 加的那一步。
 *
 * 已上線、不在 STEPS 裡的 #443（佇列優先層的欄位）與 #448（測試名人物隔離，總表多一道過濾）也會在回放環境裡套好（gen 會多抓測試名人物與他們的參選紀錄 id）。
 * election_results 是歷史步驟（#441 已上線，現行總表已經多了 #448 的過濾，直接 check 它會在 ① 對不上），之後的快照只用 party_gap 以後的步驟。
 *
 * 用法（不進 CI：要正式庫快照、要網路抓 PGlite）：
 *   deno run --allow-read --allow-write scripts/arms-parity-p2.ts gen <step> snapshot.sql
 *   npx supabase db query --linked -f snapshot.sql -o json > snapshot.json      （檔案第一行是 SET default_transaction_read_only = on）
 *   deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/arms-parity-p2.ts check <step> snapshot.json
 */
import { applyP2, ARM_BRANCHES, armsFingerprint, buildArmsDb, fnText, latestFn, P2_ER_MIG, P2_PG_MIG, readMig } from "../supabase/functions/_shared/arms-pglite.ts";

type Branch = (typeof ARM_BRANCHES)[number];
type Step = {
  id: string;
  mig: string;
  /** 這一步重新定義的臂（分支名） */
  arms: readonly Branch[];
  /** 這一步改的規則的活動名 */
  activities: string[];
  /** from＝起日型（投票日 +1 起，窗口以外＝投票日 +1 晚於今天）；until＝迄日型（到投票日當天為止，窗口以外＝投票日早於今天） */
  kind: "from" | "until";
  /** 「不改規則」那一刀的分界字串（migration 裡規則 UPDATE 那一節的標題） */
  ruleHeading: string;
  /** 規則偏移那一處的原文與改壞版 */
  offsetEdit: [string, string];
  /** 加迄日（起日型）／加起日（迄日型）的原文與改壞版 */
  extraEdit: [string, string];
};
const STEPS: Step[] = [
  {
    id: "election_results", mig: P2_ER_MIG, arms: ["raw", "election_results"], activities: ["election_results", "raw:election_result_missing"], kind: "from",
    ruleHeading: "-- 3. 規則", offsetEdit: ["from_offset = 1, until_kind = NULL", "from_offset = 0, until_kind = NULL"],
    extraEdit: ["from_offset = 1, until_kind = NULL, until_offset = 0", "from_offset = 1, until_kind = 'polling', until_offset = 30"],
  },
  {
    id: "party_gap", mig: P2_PG_MIG, arms: ["party_gap"], activities: ["party_gap"], kind: "from",
    ruleHeading: "-- 2. 規則", offsetEdit: ["from_offset = 1, until_kind = NULL", "from_offset = 0, until_kind = NULL"],
    extraEdit: ["from_offset = 1, until_kind = NULL, until_offset = 0", "from_offset = 1, until_kind = 'polling', until_offset = 30"],
  },
];

const [mode, stepId, path] = Deno.args;
const step = STEPS.find((s) => s.id === stepId);
if (!mode || !step || !path || !["gen", "check"].includes(mode)) {
  console.error(`用法：arms-parity-p2.ts gen <step> <out.sql> ｜ arms-parity-p2.ts check <step> <snapshot.json>；step ∈ ${STEPS.map((s) => s.id).join("、")}`);
  Deno.exit(2);
}
const prior = STEPS.slice(0, STEPS.indexOf(step));
const NEW_ARMS = step.arms;
const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";
const fnBody = (fn: string) => {
  const m = /AS (\$[a-z]*\$)/.exec(fn)!;
  return fn.slice(fn.indexOf(m[0]) + m[0].length, fn.lastIndexOf(m[1])).trim();
};

if (mode === "gen") {
  const p2 = await readMig(step.mig);
  const base = Deno.readTextFileSync(new URL("./arms-parity.sql", import.meta.url)).replace(/\r\n/g, "\n");
  const tail = "\n  )\n) AS j;";
  if (!base.trimEnd().endsWith(tail.trim())) throw new Error("arms-parity.sql 的結尾變了，這支要跟著改");
  const parts = NEW_ARMS.map((n) => {
    const body = fnBody(fnText(p2, `contribution_auto_tasks_${n}`));
    return `    '${n}', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM (\n${body}\n) AS x(${COLS}))`;
  });
  const sql = base.trimEnd().slice(0, -tail.trim().length).trimEnd() + `\n  ),\n  -- P2 migration（${step.id}）裡新臂本體（子查詢原樣執行，唯讀、不建立任何物件）\n  'branches_new', json_build_object(\n${parts.join(",\n")}\n  ),\n  -- 測試名人物隔離（#448，20261008114000）已上線：總表把這些人物的非 placeholder 任務擋掉，回放環境要有同樣的人物與參選紀錄才對得上現行總表\n  'placeholder_people', (SELECT coalesce(json_agg(json_build_object('id', p.id, 'name', p.name)), '[]'::json) FROM politicians p WHERE politician_name_is_placeholder(p.name)),\n  'placeholder_pe_ids', (SELECT coalesce(json_agg(pe.id), '[]'::json) FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name))\n) AS j;\n`;
  Deno.writeTextFileSync(path, sql);
  console.log(`已寫出 ${path}（${sql.length} 字元）`);
  Deno.exit(0);
}

// ── check ─────────────────────────────────────────────────────────
const raw = JSON.parse(Deno.readTextFileSync(path).replace(/^﻿/, ""));
const rec = raw.rows ? raw.rows[0].j : raw;
const snap = typeof rec === "string" ? JSON.parse(rec) : rec;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "：" + detail : ""}`);
  if (!ok) fails.push(name);
}
const taipeiDay = new Date(Date.parse(snap.taken_at) + 8 * 3600_000).toISOString().slice(0, 10);
console.log(`步驟 ${step.id}；快照 ${snap.taken_at}（台北 ${taipeiDay}）：正式庫總表 ${snap.n} 件 ${snap.hash}`);

const oldBranches = Object.fromEntries(ARM_BRANCHES.map((n) => [n, (snap.branches[n] as string | undefined) ?? "[]"]));
const newBranches: Record<string, string> = { ...oldBranches };
for (const n of NEW_ARMS) newBranches[n] = snap.branches_new[n] as string;
const P2_SQL = await readMig(step.mig);
// 之前各步：假設已經上線（正式庫的現行輸出已經反映它們），PGlite 一樣先套它們的規則
// 已上線、不在 STEPS 裡的兩支：佇列優先層 #443（只要它加的欄位與表，讓 #448 的優先層規則插得進去）與測試名人物隔離 #448（總表多一道過濾）。
// #448 排在選舉結果之後（時間戳 114000）；回放環境補上快照裡的測試名人物與他們的參選紀錄 id，總表才對得上現行
const PH_MIG = "20261008114000_placeholder_task_isolation.sql";
const QP_SQL = await readMig("20261008090000_queue_priority_tiers.sql");
const between = (sql: string, a: string, b: string) => sql.slice(sql.indexOf(a), sql.indexOf(b, sql.indexOf(a)) + b.length);
const people = (snap.placeholder_people ?? []) as Array<{ id: string; name: string }>;
const peIds = (snap.placeholder_pe_ids ?? []) as number[];
const PRE_SQL = [
  "CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid)",
  await latestFn("politician_name_is_placeholder"),
  ...people.map((p) => `INSERT INTO politicians (id, name) VALUES ('${p.id}', '${p.name.replaceAll("'", "''")}')`),
  "CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL)",
  ...(people.length ? peIds.map((id) => `INSERT INTO politician_elections (id, politician_id) VALUES (${id}, '${people[0].id}')`) : []),
  between(QP_SQL, "CREATE TABLE IF NOT EXISTS task_priority_tiers (", "ON CONFLICT (id) DO NOTHING;").replace(/;$/, ""),
  between(QP_SQL, "ALTER TABLE activity_rules ADD COLUMN IF NOT EXISTS priority", "CHECK ((activity LIKE 'priority:%') = (priority IS NOT NULL));").replace(/;$/, ""),
].join(";\n") + ";";
const priorMigs = prior.flatMap((s) => [{ name: s.mig }, ...(s.mig === P2_ER_MIG ? [{ name: PH_MIG }] : [])]);
const priorP2 = { migs: priorMigs, restub: prior.flatMap((s) => s.arms) as Branch[] };
const env = { elections: snap.elections, scope: snap.roster_check_scope, afterP1Sql: PRE_SQL, p2: priorP2.migs.length ? priorP2 : undefined };

// ① stub 沒走樣
const db0 = await buildArmsDb({ ...env, branches: oldBranches });
const f0 = await armsFingerprint(db0, "contribution_auto_tasks_arms");
check("① 舊分支輸出＋P0／P1／之前各步＝正式庫現行總表（筆數與全欄雜湊）", f0.n === snap.n && f0.h === snap.hash, `${f0.n} 件 ${f0.h}`);
// 之前各步造成的基準：假時鐘下、這一步還沒動（舊分支輸出）的總表筆數。這一步的預期筆數＝基準＋這一步多出的列（之前各步的窗口也會隨時鐘開關，不能拿「今天」的筆數當基準）
const baseAt = async (day: string) => {
  await db0.exec(`SET app.activity_today = '${day}'`);
  return (await armsFingerprint(db0, "contribution_auto_tasks_arms")).n;
};
const base1128 = await baseAt("2026-11-28");
const base1129 = await baseAt("2026-11-29");
await db0.close();

// ② 這一步的臂：新輸出 vs 舊輸出（只多窗口以外的選舉的列）
const db = await buildArmsDb({ ...env, branches: newBranches });
for (const n of NEW_ARMS) {
  await db.exec(`CREATE TABLE _o_${n} (LIKE _b_${n}); INSERT INTO _o_${n} SELECT * FROM jsonb_populate_recordset(NULL::_o_${n}, '${(oldBranches[n] as string).replaceAll("'", "''")}'::jsonb)`);
}
const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
// 窗口以外：起日型＝該列的選舉投票日 +1 晚於快照當天；迄日型＝投票日早於快照當天（沒有選舉的列＝沒有里程碑＝也算窗口以外，但這些臂的列都有 election_id）
const outside = step.kind === "from" ? `e.election_date + 1 > DATE '${taipeiDay}'` : `e.election_date < DATE '${taipeiDay}'`;
const gated = `(SELECT ${outside} FROM elections e WHERE e.id = NULLIF(t.target->>'election_id', '')::int)`;
let early = 0;
let oldTotal = 0;
for (const n of NEW_ARMS) {
  const [{ oldN }] = await q<{ oldN: number }>(`SELECT count(*)::int AS "oldN" FROM _o_${n}`);
  const [{ newN }] = await q<{ newN: number }>(`SELECT count(*)::int AS "newN" FROM _b_${n}`);
  const [{ lost }] = await q<{ lost: number }>(`SELECT count(*)::int AS lost FROM (SELECT to_jsonb(o) FROM _o_${n} o EXCEPT SELECT to_jsonb(b) FROM _b_${n} b) d`);
  const extra = await q<{ id: string | null; ty: string; n: number; g: boolean | null }>(
    `SELECT t.target->>'election_id' AS id, t.task_type AS ty, count(*)::int AS n, bool_and(${gated}) AS g
       FROM (SELECT b.* FROM _b_${n} b WHERE md5(to_jsonb(b)::text) NOT IN (SELECT md5(to_jsonb(o)::text) FROM _o_${n} o)) t GROUP BY 1, 2 ORDER BY 1, 2`);
  const extraN = extra.reduce((s, r) => s + r.n, 0);
  early += extraN;
  oldTotal += oldN;
  check(`② ${n}：舊輸出的每一列新輸出都還在（少 0 件）`, lost === 0, `舊 ${oldN} 件、新 ${newN} 件`);
  check(`② ${n}：新輸出多出來的 ${extraN} 列全是窗口以外的選舉（${step.kind === "from" ? `投票日 +1 晚於 ${taipeiDay}` : `投票日早於 ${taipeiDay}`}）`, extra.every((r) => r.g === true) && newN - oldN === extraN,
    extra.map((r) => `${r.ty}@${r.id}=${r.n}`).join(" ") || "無");
}
for (const n of ARM_BRANCHES) {
  if ((NEW_ARMS as readonly string[]).includes(n)) continue;
  if (oldBranches[n] !== newBranches[n]) throw new Error(`${n} 的輸入不該變`);
}
check(`② 其他 ${ARM_BRANCHES.length - NEW_ARMS.length} 個分支輸入相同（沒動）`, true);
// 新輸出沒有多出任何列時（例：新本體要靠中選會名冊對得上才出列，而 2026 還沒有名冊），今天輸出不變是「空對空」成立；正向的窗口行為由 CI 的合成資料測試守（見 PR 說明）
if (early === 0) console.log("！ 這次快照裡新輸出沒有多出窗口以外的列：③④ 的「濾掉」與「開窗後多出」兩項是空對空，只證明了「今天不變」；窗口行為由 CI 的合成資料測試守");
else check("② 這次快照確實有窗口以外的列可驗（沒有的話後面的 ③④ 驗不出東西）", early > 0, `${early} 列`);

// ③ 套這一步：今天的總表＝正式庫現行
const base0 = await armsFingerprint(db, "contribution_auto_tasks_arms"); // 還沒套這一步：規則是永遠開，窗口以外的列會露出來
if (early > 0) check("③ 還沒套這一步（規則是永遠開）：新臂輸出多露出窗口以外的列，總表比正式庫多（證明規則是必要的）", base0.n === snap.n + early && base0.h !== snap.hash, `${base0.n} 件`);

type Eval = { today: { n: number; h: string | null }; d1128: number; d1129: number; rowsOk: boolean; opened: Record<string, unknown> | null };
const ACT_SQL = step.activities.map((a) => `'${a}'`).join(", ");
async function evaluate(p2sql: string): Promise<Eval> {
  await db.exec("BEGIN");
  try {
    await db.exec(`SET app.activity_today = '${taipeiDay}'`);
    await applyP2(db, p2sql, NEW_ARMS);
    const today = await armsFingerprint(db, "contribution_auto_tasks_arms");
    const mine = new Map((await q<{ id: string; h: string }>(`SELECT task_id AS id, md5((to_jsonb(t) - 'arm' - 'opened_by')::text) AS h FROM contribution_auto_tasks_arms() t`)).map((r) => [r.id, r.h]));
    const rowsOk = (snap.row_hashes as [string, string][]).every(([id, h]) => mine.get(id) === h) && mine.size === (snap.row_hashes as unknown[]).length;
    await db.exec("SET app.activity_today = '2026-11-28'");
    const d1128 = (await armsFingerprint(db, "contribution_auto_tasks_arms")).n;
    await db.exec("SET app.activity_today = '2026-11-29'");
    const d1129 = (await armsFingerprint(db, "contribution_auto_tasks_arms")).n;
    const [opened] = await q<{ ob: Record<string, unknown> }>(`SELECT opened_by AS ob FROM contribution_auto_tasks_arms() WHERE arm IN (${ACT_SQL}) AND opened_by->>'election_id' = '2026' LIMIT 1`);
    return { today, d1128, d1129, rowsOk, opened: opened?.ob ?? null };
  } finally {
    await db.exec("ROLLBACK");
  }
}
const good = await evaluate(P2_SQL);
check("③ 套這一步後今天的總表筆數＝正式庫現行", good.today.n === snap.n, `${good.today.n} 件（正式庫 ${snap.n}）`);
check("③ 套這一步後今天的總表全欄雜湊＝正式庫現行", good.today.h === snap.hash, `${good.today.h}`);
check("③ 逐件指紋：正式庫總表每一列的 md5 都對得上、沒有多的", good.rowsOk);
if (step.kind === "from") {
  check("④ 2026-11-28 當天不開：筆數＝這一步還沒動時的 11-28 筆數（2026 的列還在窗口外）", good.d1128 === base1128, `${good.d1128}（基準 ${base1128}）`);
  check("④ 2026-11-29 開：筆數＝這一步還沒動時的 11-29 筆數＋2026 的列", good.d1129 === base1129 + early, `${good.d1129}（預期 ${base1129}＋${early}）`);
  if (early > 0) check("④ 開窗的列帶規則與里程碑（polling 2026-11-28、expected_open_on 2026-11-29）", good.opened !== null && good.opened.milestone_kind === "polling" && good.opened.milestone_on_date === "2026-11-28" && good.opened.expected_open_on === "2026-11-29", JSON.stringify(good.opened));
}

// ⑤ 負向對照：改壞這一步的 migration，對應的檢查必須紅
const edit = (s: string, from: string, to: string) => {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`要改的字串必須剛好出現一次（${n} 次）：${from.slice(0, 40)}`);
  return s.replace(from, () => to);
};
// 去掉 migration 自己的 DO 檢查（它會擋下改壞的規則——那是另一層保險，CI 測試驗它；這裡要驗的是「比對腳本本身」對壞規則是紅的）
const noGuard = (s: string) => s.slice(0, s.indexOf("\nDO $$"));
if (step.kind === "from") {
  if (early > 0) {
    const bad1 = await evaluate(edit(noGuard(P2_SQL), ...step.offsetEdit));
    check("⑤ 偏移改成 0（投票日當天就開）→ 11-28 當天就開了，檢查 ④ 會紅", bad1.d1128 === base1128 + early && bad1.d1128 !== base1128, `${bad1.d1128}`);
    const bad2 = await evaluate(P2_SQL.slice(0, P2_SQL.indexOf(step.ruleHeading)));
    check("⑤ 規則沒改成窗口（還是永遠開）→ 今天就多出窗口以外的列，檢查 ③ 會紅", bad2.today.n === snap.n + early && bad2.today.h !== snap.hash, `${bad2.today.n}`);
  }
  if (oldTotal > 0) {
    const bad3 = await evaluate(edit(noGuard(P2_SQL), ...step.extraEdit));
    check("⑤ 加迄日（投票日 +30）→ 舊選舉的列被濾掉，今天的總表變少，檢查 ③ 會紅", bad3.today.n < snap.n, `${bad3.today.n}（正式庫 ${snap.n}）`);
  } else console.log("！ 這一步的臂在正式庫現行輸出是 0 件：「加迄日」那一刀沒有東西可濾，略過（CI 的合成資料測試會驗）");
}

console.log(fails.length === 0 ? "\n全部通過" : `\n失敗 ${fails.length} 項：${fails.join("、")}`);
await db.close();
if (fails.length) Deno.exit(1);
