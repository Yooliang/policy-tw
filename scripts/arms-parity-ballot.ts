/**
 * 補號次（新派工臂 ballot_numbers，migration 20261008150000）上線前的「今天輸出逐件不變」守門（2026-10-08，docs/PLAN-task-activation.md 第 11 節）。
 *
 * 這不是「搬一個日期條件」（scripts/arms-parity-p2.ts 那種），是新增一支臂：它的窗口在抽籤當天（draw +0）才開、投票日當天（polling +0）關，
 * 所以今天（抽籤前）總表的輸出必須跟正式庫現行逐件相同，而抽籤日起才多出這支臂的列。做法沿用 arms-parity-p2.ts（正式庫唯讀快照灌 PGlite、全欄雜湊、負向對照）：
 *
 *   gen：   讀 scripts/arms-parity.sql（總表現行輸出與 28 個分支的真實輸出），再附上「這支 migration 裡新臂本體」在正式庫上的輸出（branches_new；
 *           新本體以子查詢原樣放進去、唯讀執行，不建立任何物件）。一個 SELECT＝一個查詢快照，新舊輸出是同一個時間點。
 *   check： ① 舊分支輸出＋P0／P1＋之前各步（選舉結果、#448、party_gap、party_roster）＝正式庫現行總表（stub 沒走樣）
 *           ② 新臂本體在正式庫的輸出：每一列的 election_id／election_type，抽籤日（roster_check_scope.ballot_draw_on）還沒到＝窗口以外
 *           ③ 套這支 migration（新臂輸出灌進 stub）：今天的總表筆數、全欄雜湊、逐件 md5＝正式庫現行
 *           ④ 假時鐘：抽籤前一天 10-22 不開、10-23 開、11-28 當天仍開、11-29 關；開著的列數＝新臂輸出裡「那一天窗口開著的」列數，其他臂的列不變；
 *              2022、2024、重行選舉的列（沒有 draw 里程碑）在每一天都不開
 *           ⑤ 負向對照（還原驗證）：改壞 migration（起點 +1、迄點 -1、拿掉里程碑回填），④ 對應的檢查必須紅
 *
 * 用法（不進 CI：要正式庫快照、要網路抓 PGlite）：
 *   deno run --allow-read --allow-write scripts/arms-parity-ballot.ts gen snapshot.sql
 *   npx supabase db query --linked -f snapshot.sql -o json > snapshot.json      （檔案第一行是 SET default_transaction_read_only = on）
 *   deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/arms-parity-ballot.ts check snapshot.json
 */
import { applyP2, ARM_BRANCHES, armsFingerprint, BALLOT_MIG, buildArmsDb, fnText, latestFn, P2_ER_MIG, P2_PG_MIG, P2_PR_MIG, readMig } from "../supabase/functions/_shared/arms-pglite.ts";

const [mode, path] = Deno.args;
if (!mode || !path || !["gen", "check"].includes(mode)) {
  console.error("用法：arms-parity-ballot.ts gen <out.sql> ｜ arms-parity-ballot.ts check <snapshot.json>");
  Deno.exit(2);
}
const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";
/** 視圖的 SELECT 本體（CREATE OR REPLACE VIEW name AS … ; COMMENT 之間） */
const viewBody = (sql: string, name: string) => {
  const head = `CREATE OR REPLACE VIEW ${name} AS`;
  const a = sql.indexOf(head);
  return sql.slice(a + head.length, sql.indexOf(";\nCOMMENT ON VIEW", a));
};
/** 把 ballot_number_unit(a, b, c, d, e) 的呼叫換成函式本體的 CASE（唯讀快照不能建函式；正式庫還沒有這支函式） */
function inlineUnitFn(sql: string, fnSql: string): string {
  const body = fnSql.slice(fnSql.indexOf("SELECT CASE"), fnSql.lastIndexOf("\n$$"));
  const key = "ballot_number_unit(";
  let s = sql;
  while (s.includes(key)) {
    const i = s.indexOf(key);
    let j = i + key.length;
    let depth = 1;
    while (depth) {
      if (s[j] === "(") depth++;
      if (s[j] === ")") depth--;
      j++;
    }
    const args: string[] = [];
    let cur = "";
    let d = 0;
    for (const ch of s.slice(i + key.length, j - 1)) {
      if (ch === "(") d++;
      if (ch === ")") d--;
      if (ch === "," && d === 0) { args.push(cur.trim()); cur = ""; } else cur += ch;
    }
    args.push(cur.trim());
    let b = body;
    ["p_election_type", "p_county", "p_district", "p_town", "p_village"].forEach((n, k) => { b = b.replaceAll(n, `(${args[k]})`); });
    s = s.slice(0, i) + `(${b})` + s.slice(j);
  }
  return s;
}
const fnBody = (fn: string) => {
  const m = /AS (\$[a-z]*\$)/.exec(fn)!;
  return fn.slice(fn.indexOf(m[0]) + m[0].length, fn.lastIndexOf(m[1])).trim();
};

if (mode === "gen") {
  const mig = await readMig(BALLOT_MIG);
  const base = Deno.readTextFileSync(new URL("./arms-parity.sql", import.meta.url)).replace(/\r\n/g, "\n");
  const tail = "\n  )\n) AS j;";
  if (!base.trimEnd().endsWith(tail.trim())) throw new Error("arms-parity.sql 的結尾變了，這支要跟著改");
  const body = fnBody(fnText(mig, "contribution_auto_tasks_ballot_numbers"));
  const part = `    'ballot_numbers', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM (\n${body}\n) AS x(${COLS}))`;
  // 新臂本體讀視圖 ballot_number_anomalies（正式庫還沒有）：快照的最外層先用 CTE 把兩個視圖（函式呼叫就地展開）定義出來，唯讀、不建立任何物件
  const unitFn = fnText(mig, "ballot_number_unit");
  const ctes = `WITH ballot_number_units AS (${inlineUnitFn(viewBody(mig, "ballot_number_units"), unitFn)}),\n     ballot_number_anomalies AS (${viewBody(mig, "ballot_number_anomalies")})\n`;
  const sel = base.indexOf("SELECT json_build_object(");
  if (sel < 0) throw new Error("arms-parity.sql 找不到最外層的 SELECT json_build_object(");
  const withCtes = base.slice(0, sel) + ctes + base.slice(sel);
  const sql = withCtes.trimEnd().slice(0, -tail.trim().length).trimEnd() + `\n  ),\n  -- 補號次 migration 裡新臂本體（子查詢原樣執行，唯讀、不建立任何物件）\n  'branches_new', json_build_object(\n${part}\n  ),\n  -- 測試名人物隔離（#448，20261008114000）已上線：回放環境要有同樣的人物與參選紀錄才對得上現行總表\n  'placeholder_people', (SELECT coalesce(json_agg(json_build_object('id', p.id, 'name', p.name)), '[]'::json) FROM politicians p WHERE politician_name_is_placeholder(p.name)),\n  'placeholder_pe_ids', (SELECT coalesce(json_agg(pe.id), '[]'::json) FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name))\n) AS j;\n`;
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
const newRows = JSON.parse(snap.branches_new.ballot_numbers as string) as Array<{ task_id: string; target: { election_id: number; election_type: string; items_count?: number; units_count?: number; kind: string } }>;
const MIG = await readMig(BALLOT_MIG);

// 之前各步（選舉結果、#448、party_gap、party_roster）與 #443 的欄位：跟 arms-parity-p2.ts 同一套回放環境
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
  // 補號次 migration 的視圖要能建起來：參選紀錄、地區、貢獻的欄位（回放環境只放最小替身）
  "ALTER TABLE elections ADD COLUMN bulletin_dir text",
  "ALTER TABLE politicians ADD COLUMN region text",
  "ALTER TABLE politician_elections ADD COLUMN election_id integer, ADD COLUMN election_type text, ADD COLUMN region_id integer, ADD COLUMN candidacy_status text, ADD COLUMN cand_no integer",
  "CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text)",
  "ALTER TABLE contributions ADD COLUMN payload jsonb, ADD COLUMN source_urls text[]",
  between(QP_SQL, "CREATE TABLE IF NOT EXISTS task_priority_tiers (", "ON CONFLICT (id) DO NOTHING;").replace(/;$/, ""),
  between(QP_SQL, "ALTER TABLE activity_rules ADD COLUMN IF NOT EXISTS priority", "CHECK ((activity LIKE 'priority:%') = (priority IS NOT NULL));").replace(/;$/, ""),
].join(";\n") + ";";
const PRIOR = { migs: [{ name: P2_ER_MIG }, { name: PH_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }], restub: ["raw", "election_results", "party_gap", "party_roster"] as string[] };
const env = { elections: snap.elections, scope: snap.roster_check_scope, afterP1Sql: PRE_SQL, extraBranches: ["ballot_numbers"] as const };

// ① stub 沒走樣
const db0 = await buildArmsDb({ ...env, branches: oldBranches, p2: PRIOR });
const f0 = await armsFingerprint(db0, "contribution_auto_tasks_arms");
check("① 舊分支輸出＋P0／P1／之前各步＝正式庫現行總表（筆數與全欄雜湊）", f0.n === snap.n && f0.h === snap.hash, `${f0.n} 件 ${f0.h}`);
const DAYS = ["2026-10-08", "2026-10-22", "2026-10-23", "2026-11-28", "2026-11-29"];
const base: Record<string, number> = {};
for (const d of DAYS) {
  await db0.exec(`SET app.activity_today = '${d}'`);
  base[d] = (await armsFingerprint(db0, "contribution_auto_tasks_arms")).n;
}
await db0.close();

// ② 新臂本體在正式庫的輸出
const byElection = new Map<string, number>();
for (const r of newRows) byElection.set(`${r.target.election_id} ${r.target.election_type}`, (byElection.get(`${r.target.election_id} ${r.target.election_type}`) ?? 0) + 1);
const main = newRows.filter((r) => r.target.kind === "cand_no");
const recheck = newRows.filter((r) => r.target.kind === "cand_no_recheck");
const main26 = main.filter((r) => r.target.election_id === 2026);
console.log(`新臂本體在正式庫輸出 ${newRows.length} 件：補號次 ${main.length} 件（2026 屆 ${main26.length} 件、${main26.reduce((s, r) => s + (r.target.items_count ?? 0), 0)} 位）、重查 ${recheck.length} 件（${recheck.reduce((s, r) => s + (r.target.units_count ?? 0), 0)} 個號次單位，2026 屆 ${recheck.filter((r) => r.target.election_id === 2026).length} 件）：${[...byElection].map(([k, v]) => `${k}=${v}`).join("、")}`);
check("② 新臂的每一件都是 target.kind＝cand_no 或 cand_no_recheck、帶 election_id 與 election_type", newRows.every((r) => (r.target.kind === "cand_no" || r.target.kind === "cand_no_recheck") && Number.isInteger(r.target.election_id) && typeof r.target.election_type === "string"));
check("② task_id 沒有重複、也不跟現行總表的任何 task_id 撞號", new Set(newRows.map((r) => r.task_id)).size === newRows.length && newRows.every((r) => !(snap.row_hashes as [string, string][]).some(([id]) => id === r.task_id)));
const scope = snap.roster_check_scope as Array<{ election_id: number; election_type: string; ballot_draw_on: string | null }>;
const drawOf = (r: (typeof newRows)[number]) => scope.find((s) => s.election_id === r.target.election_id && s.election_type === r.target.election_type)?.ballot_draw_on ?? null;
const elDate = (id: number) => (snap.elections as Array<{ id: number; election_date: string }>).find((e) => e.id === id)?.election_date ?? null;
const openOn = (r: (typeof newRows)[number], day: string) => {
  const d = drawOf(r);
  const e = elDate(r.target.election_id);
  return d !== null && e !== null && d <= day && day <= e;
};
check(`② 今天（${taipeiDay}）新臂的列全在窗口以外（抽籤日還沒到、或那一屆沒有 draw 里程碑）`, newRows.every((r) => !openOn(r, taipeiDay)), `${newRows.length} 件`);

// ③④ 套這支 migration
const newBranches: Record<string, string> = { ...oldBranches, ballot_numbers: snap.branches_new.ballot_numbers as string };
const db = await buildArmsDb({ ...env, branches: newBranches, p2: PRIOR });
const noGuard = (s: string) => s.replace(/\nDO \$\$\nBEGIN\n  IF \(SELECT count\(\*\) FROM activity_rules r WHERE r\.activity = 'ballot_numbers'[\s\S]*?\n\$\$;\n/, "\n");
const edit = (s: string, from: string, to: string) => {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`要改的字串必須剛好出現一次（${n} 次）：${from.slice(0, 40)}`);
  return s.replace(from, () => to);
};
const q = async <T>(sql: string) => (await db.query<T>(sql)).rows;
async function evaluate(sql: string) {
  await db.exec("BEGIN");
  try {
    await db.exec(`SET app.activity_today = '${taipeiDay}'`);
    await applyP2(db, sql, [...PRIOR.restub, "ballot_numbers"]);
    const today = await armsFingerprint(db, "contribution_auto_tasks_arms");
    const mine = new Map((await q<{ id: string; h: string }>(`SELECT task_id AS id, md5((to_jsonb(t) - 'arm' - 'opened_by')::text) AS h FROM contribution_auto_tasks_arms() t`)).map((r) => [r.id, r.h]));
    const rowsOk = (snap.row_hashes as [string, string][]).every(([id, h]) => mine.get(id) === h) && mine.size === (snap.row_hashes as unknown[]).length;
    const open: Record<string, number> = {};
    const pastOpen: Record<string, number> = {};
    for (const d of DAYS) {
      await db.exec(`SET app.activity_today = '${d}'`);
      open[d] = (await armsFingerprint(db, "contribution_auto_tasks_arms")).n;
      pastOpen[d] = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM contribution_auto_tasks_arms() WHERE arm = 'ballot_numbers' AND (target->>'election_id')::int <> 2026`))[0].n;
    }
    return { today, rowsOk, open, pastOpen };
  } finally {
    await db.exec("ROLLBACK");
  }
}
const expected = (d: string) => base[d] + newRows.filter((r) => openOn(r, d)).length;
const good = await evaluate(MIG);
check("③ 套這支 migration 後今天的總表筆數＝正式庫現行", good.today.n === snap.n, `${good.today.n} 件（正式庫 ${snap.n}）`);
check("③ 套這支 migration 後今天的總表全欄雜湊＝正式庫現行", good.today.h === snap.hash, `${good.today.h}`);
check("③ 逐件指紋：正式庫總表每一列的 md5 都對得上、沒有多的", good.rowsOk);
for (const d of DAYS) check(`④ ${d}：總表筆數＝這支還沒套時的筆數＋新臂窗口開著的列（${expected(d) - base[d]} 件）`, good.open[d] === expected(d), `${good.open[d]}（預期 ${expected(d)}，基準 ${base[d]}）`);
check("④ 抽籤前一天（10-22）不開、抽籤當天（10-23）開、投票日當天（11-28）仍開、隔天（11-29）關", good.open["2026-10-22"] === base["2026-10-22"] && good.open["2026-10-23"] > base["2026-10-23"] && good.open["2026-11-28"] > base["2026-11-28"] && good.open["2026-11-29"] === base["2026-11-29"]);
check("④ 舊選舉（2022、2024、重行選舉）的列在每一個日期都不開（沒有 draw 里程碑）", DAYS.every((d) => good.pastOpen[d] === 0));

// ⑤ 負向對照
const RULE = "'ballot_numbers', 'event', 'draw', 0, 'polling', 0, 'announced', true";
const nOpen = newRows.filter((r) => openOn(r, "2026-10-23")).length;
if (nOpen > 0) {
  const b1 = await evaluate(edit(noGuard(MIG), RULE, "'ballot_numbers', 'event', 'draw', 1, 'polling', 0, 'announced', true"));
  check("⑤ 起點改成 +1（抽籤隔天才開）→ 10-23 當天沒開，檢查 ④ 會紅", b1.open["2026-10-23"] === base["2026-10-23"] && b1.open["2026-10-23"] !== expected("2026-10-23"), `${b1.open["2026-10-23"]}`);
  const b2 = await evaluate(edit(noGuard(MIG), RULE, "'ballot_numbers', 'event', 'draw', 0, 'polling', -1, 'announced', true"));
  check("⑤ 迄點改成 -1（投票日當天就關）→ 11-28 沒開，檢查 ④ 會紅", b2.open["2026-11-28"] === base["2026-11-28"] && b2.open["2026-11-28"] !== expected("2026-11-28"), `${b2.open["2026-11-28"]}`);
  const b3 = await evaluate(edit(MIG, " WHERE s.ballot_draw_on IS NOT NULL\nON CONFLICT", " WHERE false\nON CONFLICT"));
  check("⑤ 拿掉 draw 里程碑回填 → 窗口永遠開不起來，檢查 ④ 會紅", b3.open["2026-11-28"] === base["2026-11-28"] && b3.open["2026-11-28"] !== expected("2026-11-28"), `${b3.open["2026-11-28"]}`);
  const b4 = await evaluate(MIG.slice(0, MIG.indexOf("-- 2. 規則")));
  check("⑤ 不種規則也不換總表（只到里程碑）→ 新臂完全接不進來，檢查 ④ 會紅", b4.open["2026-11-28"] === base["2026-11-28"] && b4.open["2026-11-28"] !== expected("2026-11-28"), `${b4.open["2026-11-28"]}`);
} else console.log("！ 新臂在正式庫沒有任何 2026 的列：⑤ 負向對照略過（CI 的合成資料測試會驗）");

console.log(fails.length === 0 ? "\n全部通過" : `\n失敗 ${fails.length} 項：${fails.join("、")}`);
await db.close();
if (fails.length) Deno.exit(1);
