/**
 * 派工臂總表（contribution_auto_tasks_arms）P1 改前改後的「逐件不變」守門（2026-10-08，docs/PLAN-task-activation.md P1）。
 *
 * 做法（沿用 scripts/term-policy-parity.ts：PGlite 灌正式庫唯讀快照、全欄雜湊三方相等、負向對照）：
 *   快照（scripts/arms-parity.sql，一個 SELECT＝一個查詢快照）含正式庫「現行總表」的筆數與全欄雜湊，以及 28 個分支各自的真實輸出。
 *   PGlite 裡 28 個分支換成回放這些輸出的 stub，其餘（前一版總表、P0／P1 migration、規則與里程碑）跑真的。
 *   ① 舊版總表（20261006141600 的本體）在 stub 上的筆數與雜湊必須＝正式庫（證明 stub 沒走樣）
 *   ② 套 P0、P1 兩支 migration 後，新版總表（去掉 arm、opened_by 兩個新欄）的筆數與雜湊必須＝正式庫，逐件 EXCEPT 兩個方向都是 0
 *   ③ 負向對照（還原驗證）：關掉某臂的規則／覆寫 closed／刪光規則／換成「投票日 +1」的窗口，輸出必須「剛好」少那些件；這組不紅，上面「差集為空」就什麼都驗不出來
 *   ④ 效能：PGlite 上相對比較新舊總表耗時（絕對值不代表正式庫，只看比值）
 *
 * 用法（不進 CI：要正式庫快照、要網路抓 PGlite）：
 *   npx supabase db query --linked -f scripts/arms-parity.sql -o json > snapshot.json
 *   deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/arms-parity.ts snapshot.json
 */
import { armsDiff, armsFingerprint, ARM_BRANCHES, buildArmsDb, P1_MIG, readMig } from "../supabase/functions/_shared/arms-pglite.ts";

const snapPath = Deno.args[0];
if (!snapPath) {
  console.error("用法：deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/arms-parity.ts <snapshot.json>");
  Deno.exit(2);
}
const raw = JSON.parse(Deno.readTextFileSync(snapPath).replace(/^﻿/, ""));
const rec = raw.rows ? raw.rows[0].j : raw;
const snap = typeof rec === "string" ? JSON.parse(rec) : rec;

const fails: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "：" + detail : ""}`);
  if (!ok) fails.push(name);
}

// 分支輸出在快照裡是「文字」（見 arms-parity.sql），原樣交給 PGlite，不經 JS 的數字正規化
const branchRows = Object.fromEntries(ARM_BRANCHES.map((n) => [n, (snap.branches[n] as string | undefined) ?? "[]"]));
const total = Object.values(branchRows).reduce((n: number, r) => n + (JSON.parse(r as string) as unknown[]).length, 0);
console.log(`快照 ${snap.taken_at}：正式庫總表 ${snap.n} 件 ${snap.hash}；28 個分支共 ${total} 列（含被總表濾掉的）`);

// ── 環境：只到 P0（總表還是前一版）──────────────────────────────────
const db = await buildArmsDb({ elections: snap.elections, scope: snap.roster_check_scope, branches: branchRows, applyP1: false });

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function timeIt(fn: string, runs = 7): Promise<number> {
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await db.query(`SELECT count(*)::int FROM ${fn}()`);
    ts.push(performance.now() - t0);
  }
  return median(ts);
}

// ── ① stub 沒走樣：舊版總表＝正式庫 ───────────────────────────────────
const before = await armsFingerprint(db, "contribution_auto_tasks_arms");
check("stub 沒走樣：PGlite 跑舊版總表＝正式庫現行總表（筆數與全欄雜湊）", before.n === snap.n && before.h === snap.hash, `${before.n} 件 ${before.h}`);
const tOld: number[] = [];
const tNew: number[] = [];
for (let i = 0; i < 3; i++) tOld.push(await timeIt("contribution_auto_tasks_arms", 3));

// ── ② 套 P1：新版總表＝舊版 ─────────────────────────────────────────
await db.exec("SET app.activity_today = '2026-10-08'");
// 第二個參數（選填）：改壞的 P1 migration 路徑——還原驗證用，這個守門腳本對它必須是紅的
await db.exec(Deno.args[1] ? Deno.readTextFileSync(Deno.args[1]).replace(/\r\n/g, "\n") : await readMig(P1_MIG));
await db.exec("RESET app.activity_today");
const after = await armsFingerprint(db, "contribution_auto_tasks_arms");
const legacy = await armsFingerprint(db, "legacy_arms");
console.log(`正式庫 ${snap.n} 件 ${snap.hash}\n舊版   ${legacy.n} 件 ${legacy.h}\n新版   ${after.n} 件 ${after.h}`);
check("舊版（改名複本）在新環境仍＝正式庫", legacy.n === snap.n && legacy.h === snap.hash);
check("改前改後筆數相同", after.n === snap.n, `${snap.n} → ${after.n}`);
check("改前改後全欄雜湊相同（task_id、task_type、target、what_we_need、hint_sources、reward、region）", after.h === snap.hash);
const d0 = await armsDiff(db, "legacy_arms", "contribution_auto_tasks_arms");
check("改前改後差集為空（舊有新沒有 0 件、新有舊沒有 0 件）", d0.aOnly === 0 && d0.bOnly === 0, JSON.stringify(d0));
{
  // 逐件指紋（快照裡正式庫總表每一列的 md5）：全欄雜湊對不上時，這裡會指出是哪幾件
  const mine = new Map((await db.query<{ id: string; h: string }>(`SELECT task_id AS id, md5((to_jsonb(t) - 'arm' - 'opened_by')::text) AS h FROM contribution_auto_tasks_arms() t`)).rows.map((r) => [r.id, r.h]));
  let bad = 0, missing = 0;
  for (const [id, h] of snap.row_hashes as [string, string][]) {
    const m = mine.get(id);
    if (m === undefined) missing++;
    else if (m !== h) bad++;
  }
  check("逐件指紋：正式庫總表每一列的 md5 在新版都對得上（task_id 全部都在、整列內容相同）", bad === 0 && missing === 0 && mine.size === (snap.row_hashes as unknown[]).length, `走樣 ${bad}、缺 ${missing}、新版多 ${mine.size - (snap.row_hashes as unknown[]).length + missing}`);
}
const dupIds =(await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT task_id FROM contribution_auto_tasks_arms() GROUP BY 1 HAVING count(*) > 1) d`)).rows[0].n;
check("總表沒有重複的 task_id（臂名標籤沒讓同一件變兩列）", dupIds === 0);

const rules = (await db.query<{ n: number; on: number; always: number }>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE enabled)::int AS "on", count(*) FILTER (WHERE window_kind = 'always')::int AS always FROM activity_rules`)).rows[0];
check("36 個活動各一條永遠開的規則", rules.n === 36 && rules.on === 36 && rules.always === 36, JSON.stringify(rules));
const health = (await db.query<{ check_name: string }>(`SELECT check_name FROM activity_health`)).rows;
check("activity_health 是空的（每支臂至少一條規則）", health.length === 0, JSON.stringify(health));
const late = (await db.query(`SELECT 1 FROM gap_open_lateness`)).rows.length;
check("gap_open_lateness 是空的（P1 規則全是永遠開）", late === 0);
const shape = (await db.query<{ n: number; withRule: number; viaArm: number }>(
  `SELECT count(*)::int AS n, count(*) FILTER (WHERE (opened_by->>'rule_id') IS NOT NULL AND opened_by->>'basis' = 'rule')::int AS "withRule",
          count(*) FILTER (WHERE opened_by->>'arm' = arm)::int AS "viaArm" FROM contribution_auto_tasks_arms()`)).rows[0];
check("每一列都帶開窗的規則（opened_by.rule_id）與臂名", shape.n === shape.withRule && shape.n === shape.viaArm, JSON.stringify(shape));
const perArm = (await db.query<{ arm: string; n: number }>(`SELECT arm, count(*)::int AS n FROM contribution_auto_tasks_arms() GROUP BY 1 ORDER BY 1`)).rows;
console.log("  分臂：", perArm.map((r) => `${r.arm}=${r.n}`).join(" "));
const keys = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT DISTINCT arm, opened_by->>'election_id' AS e, target->>'election_type' AS t FROM contribution_auto_tasks_arms()) k`)).rows[0].n;
console.log(`  對 activity_open 問了 ${keys} 次（臂×選舉×職位）`);

// ── ③ 負向對照：關掉的東西，輸出必須「剛好」少那些件 ─────────────────────
async function expectLoss(name: string, sql: string, expectGone: number, expectNew = 0) {
  await db.exec("BEGIN");
  await db.exec(sql);
  const d = await armsDiff(db, "legacy_arms", "contribution_auto_tasks_arms");
  await db.exec("ROLLBACK");
  check(`負向對照：${name} → 少 ${expectGone} 件${expectNew ? `、多 ${expectNew} 件` : ""}`, d.aOnly === expectGone && d.bOnly === expectNew, JSON.stringify(d));
}
const armN = Object.fromEntries(perArm.map((r) => [r.arm, r.n]));
for (const a of ["term_policies", "election_results", "policy_elements", "raw:roster_check", "raw:progress_stale"]) {
  await expectLoss(`關掉「${a}」的規則`, `UPDATE activity_rules SET enabled = false WHERE activity = '${a}'`, armN[a]);
}
await expectLoss("停用「roster_villages」的所有規則（規則存在但關著＝關）", `UPDATE activity_rules SET enabled = false WHERE activity = 'roster_villages'`, armN["roster_villages"]);
await expectLoss("對「mayor_policies」下 closed 覆寫", `INSERT INTO activity_overrides (activity, "force", reason) VALUES ('mayor_policies', 'closed', '還原驗證')`, armN["mayor_policies"]);
await expectLoss("停用所有規則", `UPDATE activity_rules SET enabled = false`, after.n);
{
  // 臂在 activity_rules 連一列規則都沒有（新分支漏登記）：總表要丟錯、訊息寫明臂名，不是無聲濾掉
  await db.exec("BEGIN");
  await db.exec(`DELETE FROM activity_rules WHERE activity = 'roster_villages'`);
  let msg = "";
  try {
    await db.query(`SELECT count(*) FROM contribution_auto_tasks_arms()`);
  } catch (e) {
    msg = String((e as Error).message);
  }
  await db.exec("ROLLBACK");
  check("負向對照：刪光「roster_villages」的規則（沒有任何規則）→ 總表丟錯並寫明臂名", msg.includes("「roster_villages」"), msg.slice(0, 60));
}
{
  // 窗口：把某臂的規則換成「投票日 +1 起」（每場選舉各自算窗口）。各日期下開著的件數，要等於「該臂在永遠開時、屬於已過窗口的選舉的件數」——
  // 期望值只用永遠開時的分組件數與快照裡的投票日在 JS 裡算，不呼叫 activity_open。target 沒有選舉的列（缺里程碑）永遠關。
  const polling = new Map<number, string>((snap.elections as { id: number; election_date: string }[]).map((e) => [e.id, e.election_date]));
  const plusOne = (d: string) => new Date(Date.parse(d + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  for (const arm of ["raw:progress_stale", "raw:profile_gap", "election_results", "policy_elements"]) {
    const groups = (await db.query<{ e: string | null; n: number }>(`SELECT opened_by->>'election_id' AS e, count(*)::int AS n FROM contribution_auto_tasks_arms() WHERE arm = $1 GROUP BY 1`, [arm])).rows;
    await db.exec("BEGIN");
    await db.exec(`UPDATE activity_rules SET window_kind = 'event', from_kind = 'polling', from_offset = 1 WHERE activity = '${arm}'`);
    const out: string[] = [];
    let ok = true;
    for (const day of ["2022-11-26", "2022-11-27", "2024-01-14", "2026-10-08", "2026-11-28", "2026-11-29"]) {
      await db.exec(`SET app.activity_today = '${day}'`);
      const got = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM contribution_auto_tasks_arms() WHERE arm = $1`, [arm])).rows[0].n;
      const want = groups.reduce((s, g) => s + (g.e !== null && polling.has(Number(g.e)) && plusOne(polling.get(Number(g.e))!) <= day ? g.n : 0), 0);
      if (got !== want) ok = false;
      out.push(`${day.slice(2)}:${got}/${want}`);
    }
    await db.exec("SET app.activity_today = '2026-11-29'");
    const ob = (await db.query<{ k: string | null; d: string | null; e: string | null }>(
      `SELECT opened_by->>'milestone_kind' AS k, opened_by->>'milestone_on_date' AS d, opened_by->>'expected_open_on' AS e FROM contribution_auto_tasks_arms() WHERE arm = $1 AND opened_by->>'election_id' = '2026' LIMIT 1`, [arm])).rows[0];
    await db.exec("RESET app.activity_today");
    await db.exec("ROLLBACK");
    const hasNull = groups.some((g) => g.e === null);
    const all = groups.reduce((s, g) => s + g.n, 0);
    const bornOk = !ob || (ob.k === "polling" && ob.d === "2026-11-28" && ob.e === "2026-11-29");
    check(`窗口「投票日 +1」：${arm}（${all} 件，${groups.length} 組選舉${hasNull ? "，含沒有選舉的列" : ""}）各日期開著的件數＝依投票日算的預期（實際/預期）`, ok && bornOk, out.join(" ") + (ob ? ` opened_by＝${JSON.stringify(ob)}` : ""));
  }
}
const reCheck = await armsDiff(db, "legacy_arms", "contribution_auto_tasks_arms");
check("還原後（ROLLBACK）差集回到空", reCheck.aOnly === 0 && reCheck.bOnly === 0, JSON.stringify(reCheck));

// ── ④ 效能（PGlite 相對比較）─────────────────────────────────────────
for (let i = 0; i < 3; i++) tNew.push(await timeIt("contribution_auto_tasks_arms", 3));
const tLegacy = await timeIt("legacy_arms", 7);
const tOldMed = median(tOld);
const tNewMed = median(tNew);
// 注意：PGlite 裡 28 個分支是 stub（只是掃一張表），所以「舊版」只剩 UNION 與 raw 那段過濾的成本（個位數毫秒）——
// 正式庫那 1.5 秒是各臂內部的查詢，PGlite 上不存在，所以兩者的「比值」沒有意義；看的是「新版多出來的絕對時間」（規則過濾那一段）。
// PGlite（WASM）比原生 PostgreSQL 慢數倍，這個數字是高估；拿它跟正式庫總表實測約 4 秒比（2026-10-08 唯讀 EXPLAIN ANALYZE 三次 3.9／4.5／3.9 秒；函式註解寫的 1.5 秒是舊數字）。
const added = tNewMed - tOldMed;
console.log(`耗時（PGlite、${snap.n} 件、各 9 次的中位數，毫秒）：舊版（P0 後、P1 前）${tOldMed.toFixed(0)}　改名複本 ${tLegacy.toFixed(0)}　新版 ${tNewMed.toFixed(0)}　新版多出 ${added.toFixed(0)}（${keys} 次 activity_open）`);
check("規則過濾多出來的時間（PGlite 上，高估）不到 500 毫秒（正式庫總表實測約 4 秒）", added < 500, `${added.toFixed(0)} ms`);

console.log(fails.length === 0 ? "\n全部通過" : `\n失敗 ${fails.length} 項：${fails.join("、")}`);
await db.close();
if (fails.length) Deno.exit(1);
