/**
 * seed_auto_task_queue／rebalance_queue「內容沒變不重寫」（#465，migration 20261009040000_seed_skip_unchanged.sql）
 * 對正式庫唯讀快照的 parity 與耗時（2026-10-09，docs/PLAN-task-activation.md 第 11 節）。
 *
 * 做法（沿用 scripts/arms-parity.ts：PGlite 灌正式庫唯讀快照）：
 *   快照（scripts/seed-skip-parity.sql，一個 SELECT＝一個查詢快照）含 29 個分支各自的真實輸出、task_dispatches 全表、open 的手動任務與公民提問、
 *   待驗證與答案貢獻。PGlite 裡 28＋1 個分支換成回放這些輸出的 stub，其餘（總表、優先層、真的 seed／rebalance／queue_slot／task_dispatched、
 *   手動任務臂、流量提層、這支 migration）跑真的。改前的 seed／rebalance 以 _old 留在同一個資料庫。
 *   ① parity：同一個交易、同一個起點，各跑一次改前與改後的 seed，比 task_dispatches（除 refreshed_at）與 gap_events（除 id、at）；
 *      第一輪是快照原樣（入列／收回／更新都會發生），之後幾輪每輪先模擬「領走一批、缺口內容被改、缺口消失與新增、待驗證貢獻增減」再比。
 *   ② 寫入量：每一輪改前、改後各 UPDATE 了幾列（含寫了但值一樣的）、內容真的變了幾列、queue_at 真的變了幾列。
 *   ③ 耗時：PGlite（WASM，比原生慢，只看比值）整支 seed 與 rebalance 改前改後的中位數；單獨量內容 UPDATE。
 *
 * 不進 CI（要正式庫快照）。用法：
 *   npx supabase db query --linked -f scripts/seed-skip-parity.sql -o json > snapshot.json
 *   deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/seed-skip-parity.ts snapshot.json [改壞的 migration 路徑]
 * 第二個參數：改壞的 migration 路徑——還原驗證用，對它必須是紅的（結束碼 1）。
 */
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { ARM_BRANCHES } from "../supabase/functions/_shared/arms-pglite.ts";
import { buildSeedEnv } from "../supabase/functions/_shared/seed-skip-env.ts";

const snapPath = Deno.args[0];
if (!snapPath) {
  console.error("用法：deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/seed-skip-parity.ts <snapshot.json> [改壞的 migration 路徑]");
  Deno.exit(2);
}
const raw = JSON.parse(Deno.readTextFileSync(snapPath).replace(/^﻿/, ""));
const rec = raw.rows ? raw.rows[0].j : raw;
const snap = typeof rec === "string" ? JSON.parse(rec) : rec;

const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "：" + detail : ""}`);
  if (!ok) fails.push(name);
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const branches: Record<string, string> = Object.fromEntries([...ARM_BRANCHES, "ballot_numbers"].map((n) => [n, (snap.branches[n] as string | undefined) ?? "[]"]));
const nGaps = Object.values(branches).reduce((n, r) => n + (JSON.parse(r) as unknown[]).length, 0);
const dispatches = (snap.task_dispatches as string[]).flatMap((c) => JSON.parse(c) as { task_id: string; queue_at: string }[]);
console.log(`快照 ${snap.taken_at}：派工列 ${dispatches.length}（auto ${dispatches.filter((d) => d.task_id.startsWith("auto:")).length}、verify ${dispatches.filter((d) => d.task_id.startsWith("verify:")).length}）；29 個分支共 ${nGaps} 列（含被總表濾掉的）；總表 ${snap.n} 件`);

const mutated = Deno.args[1] ? Deno.readTextFileSync(Deno.args[1]).replace(/\r\n/g, "\n") : undefined;

/** 派工列在快照裡已經分成每 1000 列一塊的「文字」（見 seed-skip-parity.sql），原樣交給 PGlite：不經 JS 解析，jsonb 裡的 0.90 不會變 0.9 */
async function freshDb(): Promise<PGlite> {
  const d = await buildSeedEnv({ branches, elections: snap.elections, scope: snap.roster_check_scope, mutateMig: mutated ? () => mutated : undefined });
  const loadText = async (table: string, chunks: string[]) => {
    const cols = (await d.query<{ c: string }>(`SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS c FROM information_schema.columns WHERE table_name = '${table}'`)).rows[0].c;
    for (const c of chunks) await d.query(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`, [c]);
  };
  // 灌快照：觸發器先關，否則灌進去就寫 gap_events、新任務即時入列
  await d.exec(`ALTER TABLE contribution_tasks DISABLE TRIGGER USER; ALTER TABLE task_dispatches DISABLE TRIGGER USER;`);
  // migration 跑完時（手動任務臂那支結尾）seed 已經用 stub 分支入列過一次：派工列清掉，換成正式庫的真實派工列（gap_events 只增不刪、不能 TRUNCATE，留著；改前改後都從同一份起算，比的是兩邊之後的差異）
  await d.exec(`TRUNCATE task_dispatches`);
  await loadText("contribution_tasks", [snap.contribution_tasks]);
  await loadText("citizen_questions", [snap.citizen_questions]);
  await loadText("contributions", [snap.contributions]);
  await loadText("task_dispatches", snap.task_dispatches as string[]);
  await d.exec(`ALTER TABLE contribution_tasks ENABLE TRIGGER USER; ALTER TABLE task_dispatches ENABLE TRIGGER USER;`);
  return d;
}
console.log("灌快照…");
const db = await freshDb();
const loaded = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM task_dispatches`)).rows[0].n;
check("快照灌進 PGlite：派工列筆數＝正式庫", loaded === dispatches.length, `${loaded}`);

// ── 量寫入用的計數觸發器 ───────────────────────────────────────────────
await db.exec(`
  CREATE TABLE _upd (task_id text, content boolean, qat boolean, refr boolean);
  CREATE FUNCTION _upd_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO _upd VALUES (NEW.task_id,
      (OLD.task_type, OLD.target, OLD.what_we_need, OLD.hint_sources, OLD.reward, OLD.region) IS DISTINCT FROM (NEW.task_type, NEW.target, NEW.what_we_need, NEW.hint_sources, NEW.reward, NEW.region),
      OLD.queue_at IS DISTINCT FROM NEW.queue_at, OLD.refreshed_at IS DISTINCT FROM NEW.refreshed_at);
    RETURN NEW; END $$;
  CREATE TRIGGER _upd_log AFTER UPDATE ON task_dispatches FOR EACH ROW EXECUTE FUNCTION _upd_log();`);

const stateSnap = async (): Promise<string> =>
  (await db.query<{ j: string }>(
    `SELECT md5((SELECT coalesce(jsonb_agg(to_jsonb(t) - 'refreshed_at' ORDER BY t.task_id), '[]') FROM task_dispatches t)::text
         || (SELECT coalesce(jsonb_agg(to_jsonb(e) - 'id' - 'at' ORDER BY e.task_id, e.event, coalesce(e.reason, ''), e.id), '[]') FROM gap_events e)::text) AS j`,
  )).rows[0].j;
/** 不一致時找出是哪幾列、哪幾欄不同（只在 parity 紅的時候用） */
const rowMap = async (): Promise<Map<string, Record<string, unknown>>> =>
  new Map((await db.query<{ task_id: string; j: Record<string, unknown> }>(`SELECT task_id, (SELECT jsonb_object_agg(e.k, md5(e.v::text)) FROM jsonb_each(to_jsonb(t) - 'refreshed_at') e(k, v)) AS j FROM task_dispatches t`)).rows.map((r) => [r.task_id, r.j]));
const diffMaps = (a: Map<string, Record<string, unknown>>, b: Map<string, Record<string, unknown>>): string => {
  const out: string[] = [];
  let n = 0;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb) { n++; if (out.length < 5) out.push(`${k} 只在改前`); continue; }
    const cols = Object.keys(va).filter((c) => JSON.stringify(va[c]) !== JSON.stringify(vb[c]));
    if (cols.length) { n++; if (out.length < 5) out.push(`${k} 欄位 ${cols.join(",")}`); }
  }
  for (const k of b.keys()) if (!a.has(k)) { n++; if (out.length < 5) out.push(`${k} 只在改後`); }
  return `${n} 列不同\n    ${out.join("\n    ")}`;
};
const counts = async () => (await db.query<{ n: number; auto: number; ver: number; ev: number }>(
  `SELECT count(*)::int AS n, count(*) FILTER (WHERE task_id LIKE 'auto:%')::int AS auto, count(*) FILTER (WHERE task_id LIKE 'verify:%')::int AS ver, (SELECT count(*)::int FROM gap_events) AS ev FROM task_dispatches`)).rows[0];

type W = { total: number; content: number; moved: number; queue: number };
async function measured<T>(f: () => Promise<T>): Promise<{ w: W; ms: number; value: T }> {
  await db.exec(`UPDATE task_dispatches SET refreshed_at = TIMESTAMPTZ '2026-10-01 00:00:00+00'; TRUNCATE _upd`);
  const t0 = performance.now();
  const value = await f();
  const ms = performance.now() - t0;
  const r = (await db.query<{ total: number; content: number; moved: number; queue: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE content)::int AS content, count(*) FILTER (WHERE refr)::int AS moved, count(*) FILTER (WHERE qat)::int AS queue FROM _upd`)).rows[0];
  return { w: r, ms, value };
}

// ── ① parity ＋ ② 寫入量 ───────────────────────────────────────────────
await db.exec("BEGIN");
const before0 = await counts();
const rounds: [string, string][] = [
  ["0 快照原樣（入列、收回、更新都會發生）", ""],
  ["1 緊接著再來一輪（穩態：什麼都沒變）", ""],
  // 模擬 10 分鐘後：領走 60 筆、50 個缺口內容被改（what_we_need 與 region）、40 個缺口消失、20 個新缺口、待驗證貢獻 +30 −30
  ["2 領走 60 筆＋改 50 件內容＋消失 40 件＋新增 20 件＋驗證列增減", `
    SELECT task_dispatched(task_id) FROM (SELECT task_id FROM task_dispatches WHERE task_id LIKE 'auto:%' ORDER BY queue_at, task_id LIMIT 60) h;
    UPDATE _b_raw SET what_we_need = what_we_need || '（改）' WHERE task_id IN (SELECT task_id FROM _b_raw ORDER BY task_id LIMIT 25);
    UPDATE _b_dup SET region = NULL WHERE task_id IN (SELECT task_id FROM _b_dup ORDER BY task_id LIMIT 25);
    DELETE FROM _b_raw WHERE task_id IN (SELECT task_id FROM _b_raw ORDER BY task_id DESC LIMIT 40);
    INSERT INTO _b_policy_elements SELECT 'auto:zz' || g, 'policy_element_missing', jsonb_build_object('policy_id', 'zz' || g), '新缺口 ' || g, ARRAY['h'], 1, '台北市' FROM generate_series(1, 20) g;
    INSERT INTO contributions (id, status, contribution_type, task_id, created_at) SELECT gen_random_uuid(), 'pending', 'correction', NULL, now() FROM generate_series(1, 30);
    UPDATE contributions SET status = 'verified' WHERE id IN (SELECT id FROM contributions WHERE status = 'pending' ORDER BY id LIMIT 30)`],
  ["3 再來一輪（穩態）", ""],
];
const sizes: string[] = [];
const results: { label: string; o: W; n: W }[] = [];
for (const [label, setup] of rounds) {
  console.log(`跑第 ${label}…`);
  if (setup) await db.exec(setup);
  await db.exec("SAVEPOINT r");
  const o = await measured(async () => {
    const ret = (await db.query<{ v: number }>(`SELECT seed_auto_task_queue_old() AS v`)).rows[0].v;
    return { ret, snap: await stateSnap(), rows: await rowMap() };
  });
  await db.exec("ROLLBACK TO r");
  const n = await measured(async () => {
    const ret = (await db.query<{ v: number }>(`SELECT seed_auto_task_queue() AS v`)).rows[0].v;
    return { ret, snap: await stateSnap(), rows: await rowMap() };
  });
  const c = await counts();
  if (o.value.snap !== n.value.snap) console.log("   差異：" + diffMaps(o.value.rows, n.value.rows));
  check(`第 ${label}：改前改後結果相同（派工列、queue_at、gap_events）`, o.value.snap === n.value.snap, `${c.n} 列（auto ${c.auto}／verify ${c.ver}）、gap_events ${c.ev}`);
  check(`第 ${label}：seed 回傳值相同`, o.value.ret === n.value.ret, `${n.value.ret}`);
  results.push({ label, o: o.w, n: n.w });
  sizes.push(`第 ${label}\n      寫入（UPDATE 列數，含值一樣的）　改前 ${o.w.total}　改後 ${n.w.total}\n      其中內容真的變了　　　　　　　　 改前 ${o.w.content}　改後 ${n.w.content}\n      其中 queue_at 真的變了　　　　　　改前 ${o.w.queue}　改後 ${n.w.queue}\n      refreshed_at 被動到　　　　　　　 改前 ${o.w.moved}　改後 ${n.w.moved}\n      耗時（PGlite 單次）　　　　　　　 改前 ${o.ms.toFixed(0)} ms　改後 ${n.ms.toFixed(0)} ms`);
}
console.log("\n寫入量：");
for (const s of sizes) console.log("  " + s);
const after = await counts();
console.log(`\n派工列 ${before0.n} → ${after.n}`);

await db.exec("ROLLBACK");

for (const r of results.filter((x) => x.label.includes("穩態"))) check(`第 ${r.label}：改後整支 seed（內容 UPDATE＋rebalance）一列都不寫`, r.n.total === 0, `改前 ${r.o.total} 列 → 改後 ${r.n.total} 列`);
for (const r of results.filter((x) => !x.label.includes("穩態"))) check(`第 ${r.label}：改後寫的內容列＝內容真的變了的列（refreshed_at 只動那些）`, r.n.moved === r.o.content && r.n.content === r.o.content, `內容變了 ${r.o.content} 列、refreshed_at 改前動 ${r.o.moved} 列 → 改後動 ${r.n.moved} 列`);
await db.close();

if (mutated) {
  // 還原驗證模式：只比 parity 與寫入量，不量耗時
  console.log(fails.length === 0 ? "\n全部通過（對改壞的 migration 應該要紅，結果卻綠了）" : `\n失敗 ${fails.length} 項：${fails.join("、")}`);
  Deno.exit(fails.length ? 1 : 0);
}

// ── ③ 耗時：改前、改後各用一個全新的資料庫（同一份快照），先跑兩輪讓狀態穩定，再各量 RUNS 次取中位數 ─────────
// 不共用一個資料庫：改前每輪寫 2 萬多列、ROLLBACK 之後留下的死列會拖慢後面的掃描，排在後面的改後版會被冤枉；也不掛計數觸發器（每列多一次觸發器呼叫）
const RUNS = 5;
async function timeVariant(variant: "old" | "new") {
  const d = await freshDb();
  const sfx = variant === "old" ? "_old" : "";
  await d.exec(`SELECT seed_auto_task_queue${sfx}()`); // 第一輪：入列、重排
  await d.exec(`SELECT seed_auto_task_queue${sfx}()`); // 第二輪：穩態
  const time = async (sql: string): Promise<number> => {
    const ts: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      await d.exec("BEGIN");
      const t0 = performance.now();
      await d.exec(sql);
      ts.push(performance.now() - t0);
      await d.exec("ROLLBACK");
    }
    return median(ts);
  };
  const seed = await time(`SELECT seed_auto_task_queue${sfx}()`);
  const reb = await time(`SELECT rebalance_queue${sfx}()`);
  // 內容 UPDATE 單獨量：把 seed 開頭算出的 _gaps 用同一個查詢重做，只量這一句
  await d.exec("BEGIN");
  await d.exec(`DROP TABLE IF EXISTS _gaps`);
  await d.exec(`CREATE TEMP TABLE _gaps AS SELECT DISTINCT ON (g.task_id) g.* FROM contribution_auto_tasks_arms() g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id`);
  const cond = variant === "old" ? "" : `AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region)`;
  const ts: number[] = [];
  let n = 0;
  for (let i = 0; i < RUNS; i++) {
    await d.exec("SAVEPOINT u");
    const t0 = performance.now();
    n = (await d.query(`UPDATE task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need, hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
      FROM _gaps g WHERE g.task_id = d.task_id ${cond}`)).affectedRows ?? 0;
    ts.push(performance.now() - t0);
    await d.exec("ROLLBACK TO u");
  }
  await d.exec("ROLLBACK");
  await d.close();
  return { seed, reb, upd: median(ts), updRows: n };
}
const tOld = await timeVariant("old");
const tNew = await timeVariant("new");
const pct = (a: number, b: number) => `${((1 - b / a) * 100).toFixed(0)}%`;
console.log(`\n耗時（PGlite、穩態、${RUNS} 次中位數；WASM 比原生慢數倍，只看差值與比例，不代表正式庫的絕對時間）：`);
console.log(`  整支 seed　　　　　改前 ${tOld.seed.toFixed(0)} ms　改後 ${tNew.seed.toFixed(0)} ms　省 ${(tOld.seed - tNew.seed).toFixed(0)} ms（${pct(tOld.seed, tNew.seed)}）`);
console.log(`  　其中 rebalance　 改前 ${tOld.reb.toFixed(0)} ms　改後 ${tNew.reb.toFixed(0)} ms　省 ${(tOld.reb - tNew.reb).toFixed(0)} ms（${pct(tOld.reb, tNew.reb)}）`);
console.log(`  　內容 UPDATE 一句　改前 ${tOld.upd.toFixed(0)} ms（${tOld.updRows} 列）　改後 ${tNew.upd.toFixed(0)} ms（${tNew.updRows} 列）　省 ${(tOld.upd - tNew.upd).toFixed(0)} ms（${pct(tOld.upd, tNew.upd)}）`);

console.log(fails.length === 0 ? "\n全部通過" : `\n失敗 ${fails.length} 項：${fails.join("、")}`);
if (fails.length) Deno.exit(1);
