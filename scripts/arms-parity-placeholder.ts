/**
 * 測試資料人物的任務隔離（migration 20261008114000_placeholder_task_isolation.sql）改前改後的比對（2026-10-08）。
 *
 * 要證明的事：總表加了「target.politician_id 是測試名人物的任務只留 placeholder 臂的」之後，
 *   ① 新總表比現行總表「多」的任務是 0 件；
 *   ② 「少」的任務剛好是測試名人物的非 placeholder 任務——而且是「target 裡任何地方出現這些人物 id」的那批任務扣掉 placeholder 臂的，不多不少
 *      （不是只看 politician_id 這個鍵：萬一別的臂把測試人物放在別的鍵，這一條會紅）；
 *   ③ 其餘每一件逐件相同（全欄 md5）；
 *   ④ 負向對照（還原驗證）：拿掉過濾→少 0 件；測試名集合改成所有人→少很多件；這組不紅，②什麼都驗不出來。
 * 做法沿用 scripts/arms-parity.ts：正式庫唯讀快照灌 PGlite（28 個分支回放真實輸出，總表、啟用時間窗、P0／P1／P2 跑真的）。
 * 正式庫現行總表＝P1 的定義（P2 只動兩支臂的本體，已在快照的分支輸出裡），所以「改前」直接用 P1 的總表複本。
 *
 * 用法（不進 CI：要正式庫快照、要網路抓 PGlite）：
 *   deno run --allow-read --allow-write scripts/arms-parity-placeholder.ts gen snapshot.sql
 *   npx supabase db query --linked -f snapshot.sql -o json > snapshot.json
 *   deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/arms-parity-placeholder.ts check snapshot.json
 */
import { applyP2, armsDiff, armsFingerprint, ARM_BRANCHES, buildArmsDb, fnText, latestFn, mutate, P1_MIG, P2_ER_MIG, readMig } from "../supabase/functions/_shared/arms-pglite.ts";

const MIG = "20261008114000_placeholder_task_isolation.sql";
const QP_MIG = "20261008090000_queue_priority_tiers.sql";
const [mode, path] = Deno.args;
if (!mode || !path || !["gen", "check"].includes(mode)) {
  console.error("用法：arms-parity-placeholder.ts gen <out.sql> ｜ arms-parity-placeholder.ts check <snapshot.json>");
  Deno.exit(2);
}

if (mode === "gen") {
  const base = Deno.readTextFileSync(new URL("./arms-parity.sql", import.meta.url)).replace(/\r\n/g, "\n");
  const tail = "\n  )\n) AS j;";
  if (!base.trimEnd().endsWith(tail.trim())) throw new Error("arms-parity.sql 的結尾變了，這支要跟著改");
  const sql = base.trimEnd().slice(0, -tail.trim().length).trimEnd() +
    `\n  ),\n  -- 姓名看起來是測試資料的人物（politician_name_is_placeholder；唯讀）\n  'placeholder_people', (SELECT coalesce(json_agg(json_build_object('id', p.id, 'name', p.name, 'merged_into', p.merged_into)), '[]'::json) FROM politicians p WHERE politician_name_is_placeholder(p.name)),\n  -- 他們的參選紀錄 id（election_results 批次任務放的是參選紀錄 id）\n  'placeholder_pe_ids', (SELECT coalesce(json_agg(pe.id), '[]'::json) FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name))\n) AS j;\n`;
  Deno.writeTextFileSync(path, sql);
  console.log(`已寫出 ${path}（${sql.length} 字元）`);
  Deno.exit(0);
}

const raw = JSON.parse(Deno.readTextFileSync(path).replace(/^﻿/, ""));
const rec = raw.rows ? raw.rows[0].j : raw;
const snap = typeof rec === "string" ? JSON.parse(rec) : rec;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "：" + detail : ""}`);
  if (!ok) fails.push(name);
}
const taipeiDay = new Date(Date.parse(snap.taken_at) + 8 * 3600_000).toISOString().slice(0, 10);
const people = snap.placeholder_people as Array<{ id: string; name: string; merged_into: string | null }>;
const peIds = (snap.placeholder_pe_ids ?? []) as number[];
console.log(`快照 ${snap.taken_at}（台北 ${taipeiDay}）：正式庫總表 ${snap.n} 件 ${snap.hash}；測試名人物 ${people.length} 位：${people.map((p) => p.name).join("、")}`);

const branches = Object.fromEntries(ARM_BRANCHES.map((n) => [n, (snap.branches[n] as string | undefined) ?? "[]"]));
const MIG_SQL = await readMig(MIG);
const QP = await readMig(QP_MIG);
const P1 = await readMig(P1_MIG);
const between = (sql: string, a: string, b: string) => sql.slice(sql.indexOf(a), sql.indexOf(b, sql.indexOf(a)) + b.length);
const PRIORITY_COL = [
  between(QP, "CREATE TABLE IF NOT EXISTS task_priority_tiers (", "ON CONFLICT (id) DO NOTHING;"),
  between(QP, "ALTER TABLE activity_rules ADD COLUMN IF NOT EXISTS priority", "CHECK ((activity LIKE 'priority:%') = (priority IS NOT NULL));"),
].join("\n");
const CUR = fnText(P1, "contribution_auto_tasks_arms").replace("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()", "CREATE OR REPLACE FUNCTION cur_arms()");

async function evaluate(mig: string) {
  // P0／P1／P2 跑真的（P2 的規則窗口讓正式庫現在的總表長那樣），28 個分支回放；之後的假「今天」＝快照當天
  const db = await buildArmsDb({
    elections: snap.elections, scope: snap.roster_check_scope, branches,
    p2: { migs: [{ name: P2_ER_MIG }], restub: ["raw", "election_results"] },
  });
  await db.exec(`SET app.activity_today = '${taipeiDay}'`);
  await db.exec("CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid)");
  await db.exec(await latestFn("politician_name_is_placeholder"));
  for (const p of people) await db.query("INSERT INTO politicians (id, name) VALUES ($1, $2)", [p.id, p.name]);
  // 參選紀錄：快照只帶了測試人物的 id，人物對應不重要（總表只用「是不是測試人物的參選紀錄」），掛到第一位
  await db.exec("CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL)");
  for (const id of peIds) await db.query("INSERT INTO politician_elections (id, politician_id) VALUES ($1, $2)", [id, people[0].id]);
  await db.exec(PRIORITY_COL);
  await db.exec(CUR);
  const before = await armsFingerprint(db, "cur_arms");
  await applyP2(db, mig, []);
  return { db, before };
}

const good = await evaluate(MIG_SQL);
// ① stub 沒走樣
check("① 回放＋P0／P1／P2 的總表（改前）＝正式庫現行總表（筆數與全欄雜湊）", good.before.n === snap.n && good.before.h === snap.hash, `${good.before.n} 件 ${good.before.h}`);
const db = good.db;
const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

// ② 改前改後
const d = await armsDiff(db, "cur_arms", "contribution_auto_tasks_arms");
check("② 新總表比現行總表「多」的任務：0 件", d.bOnly === 0, `${d.bOnly}`);
const idsList = people.map((p) => p.id);
const likeAny = [...idsList.map((_, i) => `target::text LIKE $${i + 1}`), ...peIds.map((id) => `(target->'politician_election_ids' @> to_jsonb(${id}) OR target->>'politician_election_id' = '${id}')`)].join(" OR ");
const referencing = (await q<{ task_id: string }>(`SELECT task_id FROM cur_arms() WHERE arm <> 'placeholder_politicians' AND (${likeAny || "false"})`, idsList.map((id) => `%${id}%`))).map((r) => r.task_id).sort();
const dropped = (await q<{ task_id: string }>(`SELECT task_id FROM cur_arms() c WHERE NOT EXISTS (SELECT 1 FROM contribution_auto_tasks_arms() n WHERE n.task_id = c.task_id)`)).map((r) => r.task_id).sort();
check("② 新總表比現行總表「少」的任務＝target 任何地方出現測試名人物 id 的非 placeholder 任務（不多不少）", JSON.stringify(dropped) === JSON.stringify(referencing) && dropped.length === d.aOnly, `少 ${d.aOnly} 件：${dropped.join("、") || "（無）"}`);
const byType = await q<{ arm: string; task_type: string; n: number }>(`SELECT c.arm, c.task_type, count(*)::int AS n FROM cur_arms() c WHERE NOT EXISTS (SELECT 1 FROM contribution_auto_tasks_arms() n WHERE n.task_id = c.task_id) GROUP BY 1, 2 ORDER BY 1, 2`);
console.log("   少掉的任務分布：" + (byType.map((r) => `${r.arm}/${r.task_type}×${r.n}`).join("、") || "（無）"));
const keptPh = await q<{ n: number }>(`SELECT count(*)::int AS n FROM contribution_auto_tasks_arms() WHERE arm = 'placeholder_politicians'`);
const curPh = await q<{ n: number }>(`SELECT count(*)::int AS n FROM cur_arms() WHERE arm = 'placeholder_politicians'`);
check("② placeholder 臂自己的任務一件不少", keptPh[0].n === curPh[0].n, `${keptPh[0].n} 件`);
// ③ 其餘逐件相同
const rowHash = (fn: string, where = "true") => `SELECT task_id, md5((to_jsonb(t) - 'arm' - 'opened_by')::text) AS h FROM ${fn}() t WHERE ${where}`;
const restA = await q<{ n: number }>(`SELECT count(*)::int AS n FROM (${rowHash("cur_arms", "task_id <> ALL ($1::text[])")} EXCEPT ${rowHash("contribution_auto_tasks_arms")}) x`, [dropped]);
const restB = await q<{ n: number }>(`SELECT count(*)::int AS n FROM (${rowHash("contribution_auto_tasks_arms")} EXCEPT ${rowHash("cur_arms", "task_id <> ALL ($1::text[])")}) x`, [dropped]);
check("③ 沒少的任務逐件相同（全欄 md5，兩個方向 EXCEPT）", restA[0].n === 0 && restB[0].n === 0 && d.aN - d.aOnly === d.bN, `改前 ${d.aN} 件、改後 ${d.bN} 件`);
// 假時鐘：不同日期結論一樣（總表過濾跟日期無關）
for (const day of ["2026-11-28", "2026-11-29"]) {
  await db.exec(`SET app.activity_today = '${day}'`);
  const dd = await armsDiff(db, "cur_arms", "contribution_auto_tasks_arms");
  check(`③ 假時鐘 ${day}：新總表仍然沒有多出任務`, dd.bOnly === 0, `少 ${dd.aOnly} 件`);
}
await db.exec(`SET app.activity_today = '${taipeiDay}'`);
check("② 這次快照確實有測試名人物的非 placeholder 任務可驗（沒有的話負向對照就沒有意義）", dropped.length > 0, `${dropped.length} 件`);
await db.close();

// ④ 負向對照
const noFilter = await evaluate(mutate(MIG_SQL, "   WHERE g.arm = 'placeholder_politicians'\n      OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)\n              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT))\n", ""));
const dNo = await armsDiff(noFilter.db, "cur_arms", "contribution_auto_tasks_arms");
check("④ 拿掉過濾 → 少 0 件（②「少」的檢查會紅）", dNo.aOnly === 0 && dNo.aOnly !== dropped.length, `${dNo.aOnly}`);
await noFilter.db.close();
const wrongKey = await evaluate(mutate(MIG_SQL, "strpos(g.target::TEXT, ph.pid) > 0", "strpos(g.target::TEXT, ph.pid) < 0"));
const dKey = await armsDiff(wrongKey.db, "cur_arms", "contribution_auto_tasks_arms");
check("④ id 比對永遠不成立 → 少 0 件（②「少」的檢查會紅）", dKey.aOnly === 0 && dKey.aOnly !== dropped.length, `${dKey.aOnly}`);
await wrongKey.db.close();
const noExempt = await evaluate(mutate(MIG_SQL, "   WHERE g.arm = 'placeholder_politicians'\n      OR NOT (EXISTS", "   WHERE NOT (EXISTS"));
const dEx = await armsDiff(noExempt.db, "cur_arms", "contribution_auto_tasks_arms");
check("④ 拿掉 placeholder 臂的豁免 → 連它自己的任務也被擋（②「placeholder 臂一件不少」的檢查會紅）", dEx.aOnly > dropped.length, `少 ${dEx.aOnly} 件（正確是 ${dropped.length}）`);
await noExempt.db.close();

console.log(fails.length === 0 ? "\n全部通過" : `\n失敗 ${fails.length} 項：${fails.join("、")}`);
if (fails.length) Deno.exit(1);
