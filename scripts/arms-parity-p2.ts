/**
 * 派工時間窗 P2「選舉結果」這組（election_results、raw:election_result_missing）改前改後的「逐件不變」守門（2026-10-08，docs/PLAN-task-activation.md）。
 *
 * P2 把兩支臂臂內的 `election_date < CURRENT_DATE` 拿掉、改成規則「投票日 +1 起」。臂的新本體會多算投票日之前的屆別（2026），再由總表依規則濾掉，
 * 所以要證明的是：新本體的輸出，濾掉「窗口還沒到的選舉」之後，跟正式庫現行（舊本體）逐件相同。做法（沿用 scripts/arms-parity.ts：正式庫唯讀快照灌 PGlite、全欄雜湊、負向對照）：
 *
 *   gen：   讀 scripts/arms-parity.sql（總表現行輸出與 28 個分支的真實輸出），再附上「P2 migration 裡兩支新臂本體」在正式庫上的輸出（branches_new；
 *           新本體以子查詢原樣放進去、唯讀執行，不建立任何物件）。一個 SELECT＝一個查詢快照，新舊輸出是同一個時間點。
 *   check： ① 舊分支輸出 + P0／P1 的總表＝正式庫現行總表（stub 沒走樣）
 *           ② 兩支臂：新輸出比舊輸出「多的列」恰好是窗口還沒到的選舉（2026）的列，「少的列」是 0（兩個方向的 EXCEPT）；兩支臂以外的分支沒動
 *           ③ 新分支輸出 + P0／P1／P2：今天的總表（筆數、全欄雜湊、逐件 md5）＝正式庫現行總表
 *           ④ 假時鐘：2026-11-28 當天筆數＝今天（2026 還沒開）；11-29＝今天＋2026 那些列；舊選舉（2022、2024、重行）在每個日期都照常開
 *           ⑤ 負向對照（還原驗證）：改壞 P2 migration（偏移 +1→0、不改規則、加迄日），上面的對應檢查必須紅；這組不紅，③④什麼都驗不出來
 *
 * 用法（不進 CI：要正式庫快照、要網路抓 PGlite）：
 *   deno run --allow-read --allow-write scripts/arms-parity-p2.ts gen snapshot.sql
 *   npx supabase db query --linked -f snapshot.sql -o json > snapshot.json
 *   deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/arms-parity-p2.ts check snapshot.json
 */
import { applyP2, armsFingerprint, ARM_BRANCHES, buildArmsDb, fnText, P2_ER_MIG, readMig } from "../supabase/functions/_shared/arms-pglite.ts";

const [mode, path] = Deno.args;
if (!mode || !path || !["gen", "check"].includes(mode)) {
  console.error("用法：arms-parity-p2.ts gen <out.sql> ｜ arms-parity-p2.ts check <snapshot.json>");
  Deno.exit(2);
}

const NEW_ARMS = ["raw", "election_results"] as const;
const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";
const fnBody = (fn: string) => {
  const m = /AS (\$[a-z]*\$)/.exec(fn)!;
  return fn.slice(fn.indexOf(m[0]) + m[0].length, fn.lastIndexOf(m[1])).trim();
};

if (mode === "gen") {
  const p2 = await readMig(P2_ER_MIG);
  const base = Deno.readTextFileSync(new URL("./arms-parity.sql", import.meta.url)).replace(/\r\n/g, "\n");
  const tail = "\n  )\n) AS j;";
  if (!base.trimEnd().endsWith(tail.trim())) throw new Error("arms-parity.sql 的結尾變了，這支要跟著改");
  const parts = NEW_ARMS.map((n) => {
    const body = fnBody(fnText(p2, `contribution_auto_tasks_${n}`));
    return `    '${n}', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM (\n${body}\n) AS x(${COLS}))`;
  });
  const sql = base.trimEnd().slice(0, -tail.trim().length).trimEnd() + `\n  ),\n  -- P2 migration 裡兩支新臂本體（子查詢原樣執行，唯讀、不建立任何物件）\n  'branches_new', json_build_object(\n${parts.join(",\n")}\n  )\n) AS j;\n`;
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
console.log(`快照 ${snap.taken_at}（台北 ${taipeiDay}）：正式庫總表 ${snap.n} 件 ${snap.hash}`);

const oldBranches = Object.fromEntries(ARM_BRANCHES.map((n) => [n, (snap.branches[n] as string | undefined) ?? "[]"]));
const newBranches = { ...oldBranches, raw: snap.branches_new.raw as string, election_results: snap.branches_new.election_results as string };
const P2_SQL = await readMig(P2_ER_MIG);
const env = { elections: snap.elections, scope: snap.roster_check_scope };

// ① stub 沒走樣
const db0 = await buildArmsDb({ ...env, branches: oldBranches });
const f0 = await armsFingerprint(db0, "contribution_auto_tasks_arms");
check("① 舊分支輸出＋P0／P1 總表＝正式庫現行總表（筆數與全欄雜湊）", f0.n === snap.n && f0.h === snap.hash, `${f0.n} 件 ${f0.h}`);
await db0.close();

// ② 兩支臂：新輸出 vs 舊輸出（只多窗口還沒到的選舉的列）
const db = await buildArmsDb({ ...env, branches: newBranches });
for (const n of NEW_ARMS) {
  await db.exec(`CREATE TABLE _o_${n} (LIKE _b_${n}); INSERT INTO _o_${n} SELECT * FROM jsonb_populate_recordset(NULL::_o_${n}, '${(oldBranches[n] as string).replaceAll("'", "''")}'::jsonb)`);
}
const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
// 窗口還沒到：該列的選舉投票日 +1 晚於快照當天（沒有選舉的列＝沒有里程碑＝也算還沒到，但這兩支臂的列都有 election_id）
const gated = `(SELECT e.election_date + 1 > DATE '${taipeiDay}' FROM elections e WHERE e.id = NULLIF(t.target->>'election_id', '')::int)`;
let early = 0;
for (const n of NEW_ARMS) {
  const [{ oldN }] = await q<{ oldN: number }>(`SELECT count(*)::int AS "oldN" FROM _o_${n}`);
  const [{ newN }] = await q<{ newN: number }>(`SELECT count(*)::int AS "newN" FROM _b_${n}`);
  const [{ lost }] = await q<{ lost: number }>(`SELECT count(*)::int AS lost FROM (SELECT to_jsonb(o) FROM _o_${n} o EXCEPT SELECT to_jsonb(b) FROM _b_${n} b) d`);
  const extra = await q<{ id: string | null; ty: string; n: number; g: boolean | null }>(
    `SELECT t.target->>'election_id' AS id, t.task_type AS ty, count(*)::int AS n, bool_and(${gated}) AS g
       FROM (SELECT b.* FROM _b_${n} b WHERE md5(to_jsonb(b)::text) NOT IN (SELECT md5(to_jsonb(o)::text) FROM _o_${n} o)) t GROUP BY 1, 2 ORDER BY 1, 2`);
  const extraN = extra.reduce((s, r) => s + r.n, 0);
  early += extraN;
  check(`② ${n}：舊輸出的每一列新輸出都還在（少 0 件）`, lost === 0, `舊 ${oldN} 件、新 ${newN} 件`);
  check(`② ${n}：新輸出多出來的 ${extraN} 列全是窗口還沒到的選舉（投票日 +1 晚於 ${taipeiDay}）`, extra.every((r) => r.g === true) && newN - oldN === extraN,
    extra.map((r) => `${r.ty}@${r.id}=${r.n}`).join(" ") || "無");
}
for (const n of ARM_BRANCHES) {
  if ((NEW_ARMS as readonly string[]).includes(n)) continue;
  if (oldBranches[n] !== newBranches[n]) throw new Error(`${n} 的輸入不該變`);
}
check("② 其他 26 個分支輸入相同（沒動）", true);
check("② 這次快照確實有「投票日之前」的列可驗（沒有的話後面的 ③④ 驗不出東西）", early > 0, `${early} 列`);

// ③ 套 P2：今天的總表＝正式庫現行
const base0 = await armsFingerprint(db, "contribution_auto_tasks_arms"); // 還沒套 P2：規則全是永遠開，2026 的列會露出來
check("③ 還沒套 P2（規則全是永遠開）：新臂輸出多露出 2026 的列，總表比正式庫多（證明規則是必要的）", base0.n === snap.n + early && base0.h !== snap.hash, `${base0.n} 件`);

type Eval = { today: { n: number; h: string | null }; d1128: number; d1129: number; rowsOk: boolean; opened: Record<string, unknown> | null };
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
    const [opened] = await q<{ ob: Record<string, unknown> }>(`SELECT opened_by AS ob FROM contribution_auto_tasks_arms() WHERE arm IN ('election_results', 'raw:election_result_missing') AND opened_by->>'election_id' = '2026' LIMIT 1`);
    return { today, d1128, d1129, rowsOk, opened: opened?.ob ?? null };
  } finally {
    await db.exec("ROLLBACK");
  }
}
const good = await evaluate(P2_SQL);
check("③ 套 P2 後今天的總表筆數＝正式庫現行", good.today.n === snap.n, `${good.today.n} 件（正式庫 ${snap.n}）`);
check("③ 套 P2 後今天的總表全欄雜湊＝正式庫現行", good.today.h === snap.hash, `${good.today.h}`);
check("③ 逐件指紋：正式庫總表每一列的 md5 都對得上、沒有多的", good.rowsOk);
check("④ 2026-11-28 當天不開：筆數＝今天（2026 的列還在窗口外）", good.d1128 === snap.n, `${good.d1128}`);
check("④ 2026-11-29 開：筆數＝今天＋2026 的列", good.d1129 === snap.n + early, `${good.d1129}（預期 ${snap.n}＋${early}）`);
check("④ 開窗的列帶規則與里程碑（polling 2026-11-28、expected_open_on 2026-11-29）", good.opened !== null && good.opened.milestone_kind === "polling" && good.opened.milestone_on_date === "2026-11-28" && good.opened.expected_open_on === "2026-11-29", JSON.stringify(good.opened));

// ⑤ 負向對照：改壞 P2 migration，對應的檢查必須紅
const edit = (s: string, from: string, to: string) => {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`要改的字串必須剛好出現一次（${n} 次）：${from.slice(0, 40)}`);
  return s.replace(from, () => to);
};
// 去掉 migration 自己的 DO 檢查（它會擋下改壞的規則——那是另一層保險，CI 測試驗它；這裡要驗的是「比對腳本本身」對壞規則是紅的）
const noGuard = (s: string) => s.slice(0, s.indexOf("\nDO $$"));
const bad1 = await evaluate(edit(noGuard(P2_SQL), "from_offset = 1, until_kind = NULL", "from_offset = 0, until_kind = NULL"));
check("⑤ 偏移改成 0（投票日當天就開）→ 11-28 當天就開了，檢查 ④ 會紅", bad1.d1128 === snap.n + early && bad1.d1128 !== snap.n, `${bad1.d1128}`);
const bad2 = await evaluate(P2_SQL.slice(0, P2_SQL.indexOf("-- 3. 規則")));
check("⑤ 規則沒改成窗口（還是永遠開）→ 今天就多出 2026 的列，檢查 ③ 會紅", bad2.today.n === snap.n + early && bad2.today.h !== snap.hash, `${bad2.today.n}`);
const bad3 = await evaluate(edit(noGuard(P2_SQL), "from_offset = 1, until_kind = NULL, until_offset = 0", "from_offset = 1, until_kind = 'polling', until_offset = 30"));
check("⑤ 加迄日（投票日 +30）→ 舊選舉的列被濾掉，今天的總表變少，檢查 ③ 會紅", bad3.today.n < snap.n, `${bad3.today.n}（正式庫 ${snap.n}）`);

console.log(fails.length === 0 ? "\n全部通過" : `\n失敗 ${fails.length} 項：${fails.join("、")}`);
await db.close();
if (fails.length) Deno.exit(1);
