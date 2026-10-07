/**
 * 名單清查重查判準（migration 20261008080000）對正式庫唯讀快照的逐件比對（2026-10-08，10-08 缺口盤點 R2）。
 * 沿用 scripts/arms-parity.ts 的做法（正式庫唯讀快照＋PGlite 回放各臂輸出＋全欄雜湊），改的是 raw 這一支，
 * 所以快照多帶一份「新定義在正式庫真實資料上的輸出」：
 *   快照 SQL＝scripts/arms-parity.sql ＋ raw_new（把新 migration 的函式本體原文當成子查詢跑）＋ roster_state（逐縣市的清查現況，
 *   用另一種寫法〔純量子查詢，不用 array_agg〕算出，給下面第 ③ 項獨立重算用）。全部在同一個 SELECT＝同一個查詢快照，只讀。
 *
 *   ① raw 層：正式庫現行 raw 的輸出（branches.raw）與新 raw 的輸出（raw_new）逐件比：少 0 件、變 0 件、多的都是 roster_check
 *   ② 總表層：PGlite 回放 28 個分支（raw 先放現行、再換成新的），新舊總表（去掉 arm、opened_by）逐件比：少 0 件、變 0 件；
 *      stub 沒走樣：回放現行輸出的總表筆數與全欄雜湊＝正式庫現行總表
 *   ③ 獨立重算：只用 roster_state 在 JS 裡算「照舊判準」與「照新判準」該派哪幾個縣市，必須等於 ① 兩個版本實際派出的 roster_check
 *      （期望值不呼叫被測的 SQL，也不用被測的欄位）
 *   ④ 列出實際新增的 task_id 與原因（最近一次回報的 cec_count、我們 filed＋declared、上次清查）
 *
 * 用法（不進 CI：要連正式庫＋網路抓 PGlite；只讀，SQL 第一行 SET default_transaction_read_only = on）：
 *   deno run --node-modules-dir=none --allow-read --allow-write --allow-run --allow-net --allow-env scripts/raw-roster-parity.ts
 *   第一個參數（選填）：改壞的 migration 路徑——還原驗證用，這個守門腳本對它必須是紅的；
 *   第二個參數（選填）：已經存好的快照 json（不連正式庫）。
 */
import { armsFingerprint, buildArmsDb, ARM_BRANCHES, fnText } from "../supabase/functions/_shared/arms-pglite.ts";

const GAP_MIG = new URL("../supabase/migrations/20261008080000_roster_check_gap_dispatch.sql", import.meta.url);
const migPath = Deno.args[0] && Deno.args[0] !== "-" ? Deno.args[0] : null;
const snapArg = Deno.args[1];

const migSql = (migPath ? Deno.readTextFileSync(migPath) : Deno.readTextFileSync(GAP_MIG)).replace(/\r\n/g, "\n");
const fn = fnText(migSql, "contribution_auto_tasks_raw");
const newBody = fn.slice(fn.indexOf("$function$") + "$function$".length, fn.lastIndexOf("$function$"));

const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";
const baseSql = Deno.readTextFileSync(new URL("./arms-parity.sql", import.meta.url)).replace(/\r\n/g, "\n");
// 正式庫現行總表已經是 P1 的 9 欄（多 arm、opened_by；opened_by 裡有規則 id，PGlite 的序號不會一樣），
// 所以快照裡原有的 hash（9 欄）不能直接比；這裡另外取「去掉 arm、opened_by 的 7 欄」雜湊，PGlite 回放的總表跟它比
const inject = `  'total7_hash', (SELECT md5(string_agg((to_jsonb(t) - 'arm' - 'opened_by')::text, '' ORDER BY t.task_id COLLATE "C")) FROM contribution_auto_tasks_arms() t),
  'raw_new',(SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM (${newBody}) AS x(${COLS})),
  -- 逐縣市的清查現況（獨立重算用）：純量子查詢取「最近一次有數字的回報」，不用被測函式的 array_agg 寫法
  'roster_state', (SELECT json_agg(row_to_json(z)) FROM (
    SELECT s.election_id, s.election_type, l.name AS region, s.enabled, s.recheck_days, now() AS now_at, roster_attempt_cooldown_days() AS cooldown_days,
           (SELECT MAX(x.checked_at) FROM roster_checks x WHERE x.election_id = s.election_id AND x.region = l.name AND x.election_type = s.election_type AND x.cec_count IS NOT NULL) AS last_checked,
           (SELECT MAX(x.checked_at) FROM roster_checks x WHERE x.election_id = s.election_id AND x.region = l.name AND x.election_type = s.election_type AND x.cec_count IS NULL) AS last_attempt,
           (SELECT x.cec_count FROM roster_checks x WHERE x.election_id = s.election_id AND x.region = l.name AND x.election_type = s.election_type AND x.cec_count IS NOT NULL
             ORDER BY x.checked_at DESC, x.id DESC LIMIT 1) AS last_cec_count,
           (SELECT count(*) FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id LEFT JOIN regions r ON r.id = pe.region_id
             WHERE pe.election_id = s.election_id AND pe.election_type = s.election_type AND COALESCE(r.region, p.region) = l.name
               AND pe.candidacy_status IN ('filed', 'declared'))::int AS n_listed
      FROM roster_check_scope s CROSS JOIN locations l) z),
`;
const marker = "  'branches', json_build_object(";
if (baseSql.split(marker).length !== 2) throw new Error("arms-parity.sql 的 branches 標記不是唯一一處，快照 SQL 沒法接新欄位");
const sql = baseSql.replace(marker, () => inject + marker);

let rawJson: string;
if (snapArg) {
  rawJson = Deno.readTextFileSync(snapArg);
} else {
  const f = await Deno.makeTempFile({ suffix: ".sql" });
  await Deno.writeTextFile(f, sql);
  const cmd = new Deno.Command(Deno.build.os === "windows" ? "npx.cmd" : "npx", { args: ["supabase", "db", "query", "--linked", "-f", f, "-o", "json"], stdout: "piped", stderr: "piped" });
  const out = await cmd.output();
  await Deno.remove(f);
  if (!out.success) {
    console.error(new TextDecoder().decode(out.stderr).slice(0, 2000));
    Deno.exit(2);
  }
  rawJson = new TextDecoder().decode(out.stdout);
}
const parsed = JSON.parse(rawJson.replace(/^﻿/, ""));
const rec = parsed.rows ? parsed.rows[0].j : parsed;
const snap = typeof rec === "string" ? JSON.parse(rec) : rec;

const fails: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "：" + detail : ""}`);
  if (!ok) fails.push(name);
}

type Row = Record<string, unknown> & { task_id: string; task_type: string };
const oldRaw = JSON.parse(snap.branches.raw as string) as Row[];
const newRaw = JSON.parse(snap.raw_new as string) as Row[];
const oldBy = new Map(oldRaw.map((r) => [r.task_id, JSON.stringify(r)]));
const newBy = new Map(newRaw.map((r) => [r.task_id, JSON.stringify(r)]));
console.log(`快照 ${snap.taken_at}：正式庫總表 ${snap.n} 件；raw 現行 ${oldRaw.length} 件、新定義 ${newRaw.length} 件`);

// ── ① raw 層 ─────────────────────────────────────────────────────────
const added = [...newBy.keys()].filter((k) => !oldBy.has(k)).sort();
const removed = [...oldBy.keys()].filter((k) => !newBy.has(k)).sort();
const changed = [...newBy.keys()].filter((k) => oldBy.has(k) && oldBy.get(k) !== newBy.get(k)).sort();
check("raw 層：舊有新沒有 0 件", removed.length === 0, removed.slice(0, 5).join(" "));
check("raw 層：同一個 task_id 內容走樣 0 件（target、說明、hint_sources、reward、region 全欄逐字相同）", changed.length === 0, changed.slice(0, 5).join(" "));
check("raw 層：新增的都是 roster_check", added.every((k) => k.startsWith("auto:roster_check:")), `${added.length} 件`);

// ── ③ 獨立重算（只用 roster_state）──────────────────────────────────────
type State = { election_id: number; election_type: string; region: string; enabled: boolean; recheck_days: number; now_at: string; cooldown_days: number;
  last_checked: string | null; last_attempt: string | null; last_cec_count: number | null; n_listed: number };
const states = snap.roster_state as State[];
const dayMs = 86400000;
function expectedIds(withGap: boolean): string[] {
  return states.filter((s) => {
    if (!s.enabled) return false;
    const now = Date.parse(s.now_at);
    const lc = s.last_checked ? Date.parse(s.last_checked) : null;
    const gap = (s.last_cec_count ?? 0) > s.n_listed;
    const recheck = lc === null || (withGap && gap) || lc < now - s.recheck_days * dayMs;
    const attemptOk = s.last_attempt === null || Date.parse(s.last_attempt) < now - s.cooldown_days * dayMs;
    return recheck && attemptOk;
  }).map((s) => `auto:roster_check:${s.election_id}:${s.region}:${s.election_type}`).sort();
}
const idsOf = (rows: Row[]) => rows.filter((r) => r.task_id.startsWith("auto:roster_check:")).map((r) => r.task_id).sort();
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
check("獨立重算：照舊判準（recheck_days 與嘗試冷卻）算出的縣市＝正式庫現行 raw 實際派的 roster_check", same(expectedIds(false), idsOf(oldRaw)), `${expectedIds(false).length} 件 vs ${idsOf(oldRaw).length} 件`);
check("獨立重算：照新判準（缺口＝最近一次 cec_count > filed＋declared）算出的縣市＝新定義實際派的 roster_check", same(expectedIds(true), idsOf(newRaw)), `${expectedIds(true).length} 件 vs ${idsOf(newRaw).length} 件`);

// ── ② 總表層（PGlite 回放）────────────────────────────────────────────
const branchRows = Object.fromEntries(ARM_BRANCHES.map((n) => [n, (snap.branches[n] as string | undefined) ?? "[]"]));
const db = await buildArmsDb({ elections: snap.elections, scope: snap.roster_check_scope, branches: branchRows });
const before = await armsFingerprint(db, "contribution_auto_tasks_arms");
check("stub 沒走樣：回放現行輸出的總表＝正式庫現行總表（筆數與去掉 arm、opened_by 的 7 欄全欄雜湊）", before.n === snap.n && before.h === snap.total7_hash, `${before.n} 件 ${before.h}`);
await db.exec(`CREATE TABLE _old_total AS SELECT task_id, (to_jsonb(t) - 'arm' - 'opened_by')::text AS j FROM contribution_auto_tasks_arms() t`);
await db.exec(`DELETE FROM _b_raw`);
if (newRaw.length) await db.query(`INSERT INTO _b_raw SELECT * FROM jsonb_populate_recordset(NULL::_b_raw, $1::jsonb)`, [snap.raw_new]);
await db.exec(`CREATE TABLE _new_total AS SELECT task_id, (to_jsonb(t) - 'arm' - 'opened_by')::text AS j FROM contribution_auto_tasks_arms() t`);
const q = async (s: string) => (await db.query<{ id: string }>(s)).rows.map((r) => r.id).sort();
const aOnly = await q(`SELECT task_id AS id FROM _old_total WHERE task_id NOT IN (SELECT task_id FROM _new_total)`);
const bOnly = await q(`SELECT task_id AS id FROM _new_total WHERE task_id NOT IN (SELECT task_id FROM _old_total)`);
const changedTotal = await q(`SELECT o.task_id AS id FROM _old_total o JOIN _new_total n USING (task_id) WHERE o.j <> n.j`);
const nTotal = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM _new_total`)).rows[0].n;
check("總表層：舊有新沒有 0 件", aOnly.length === 0, aOnly.slice(0, 5).join(" "));
check("總表層：同一個 task_id 內容走樣 0 件", changedTotal.length === 0, changedTotal.slice(0, 5).join(" "));
check("總表層：新增的都是 roster_check，而且都在 raw 層的新增清單裡（總表可能濾掉不在清查範圍的，不會多出別的）", bOnly.every((k) => added.includes(k)), `${bOnly.length} 件`);
console.log(`  總表 ${snap.n} → ${nTotal} 件（多 ${bOnly.length}）`);

// ── ④ 實際新增的 task_id 與原因 ────────────────────────────────────────
console.log("\n新增的 task_id（總表層，會真的派出去）與原因：");
const byId = new Map(states.map((s) => [`auto:roster_check:${s.election_id}:${s.region}:${s.election_type}`, s]));
for (const id of bOnly) {
  const s = byId.get(id);
  console.log(`  ${id}　最近一次回報 cec_count=${s?.last_cec_count}（${s?.last_checked?.slice(0, 10)}）、我們 filed＋declared=${s?.n_listed}、缺 ${(s?.last_cec_count ?? 0) - (s?.n_listed ?? 0)} 位；舊判準下 ${s?.recheck_days} 天內不會再派`);
}
const rawOnly = added.filter((k) => !bOnly.includes(k));
if (rawOnly.length) console.log(`raw 層新增但總表濾掉（不在 roster_check_scope 的範圍，與 activity 規則無關）：${rawOnly.join("、")}`);

console.log(fails.length === 0 ? "\n全部通過" : `\n失敗 ${fails.length} 項：${fails.join("、")}`);
await db.close();
if (fails.length) Deno.exit(1);
