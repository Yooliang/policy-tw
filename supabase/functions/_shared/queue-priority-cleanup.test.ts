/**
 * 派工排序秒數化的第二支：收掉不再影響排序的舊東西（migration 20261011350000_queue_priority_cleanup.sql，2026-10-13 維護者「a b 都作吧」）。
 *
 *   A1 改到的三支函式（seed、手動任務入列、流量提層）是最後一版，前一版是對的
 *   A2 新定義＝前一版加機械式替換（倒回去一字不差）：拿掉算層、寫層；流量提層改看優先秒數
 *   A3 刪掉的函式與欄位，正見（public、shared）沒有任何最後一版的函式或 Edge Function 還在讀
 *   A4 行為層由既有守門跑最新定義：queue-priority-seconds（B1–B7）、page-traffic-boost（提層、暫停、視圖）
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fnText, migrationNames, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261011350000_queue_priority_cleanup.sql";
const MIG = await readMig(MIG_NAME);
type Rep = [string, string, number];

const SEED_PREV = "20261011320000_queue_priority_seconds.sql";
const INS_PREV = "20261011320000_queue_priority_seconds.sql";
const TB_PREV = "20261008190000_page_traffic_boost.sql";

function cut(s: string, from: string, to: string): string {
  const i = s.indexOf(from);
  assert(i >= 0, `找不到：${from}`);
  const j = s.indexOf(to, i);
  assert(j >= 0, `找不到：${to}`);
  return s.slice(0, i) + s.slice(j + to.length);
}
function rep(s: string, reps: Rep[]): string {
  for (const [a, b, n] of reps) {
    assertEquals(s.split(a).length - 1, n, `替換的原文出現次數不對：${a.slice(0, 60)}`);
    s = s.split(a).join(b);
  }
  return s;
}

function expectedSeed(prev: string): string {
  let s = cut(prev, "  -- >>> 優先層：每個缺口現在在哪一層", "  -- <<< 優先層\n\n");
  s = rep(s, [
    ["  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER;\n  UPDATE _gaps g SET priority_seconds = p.seconds\n    FROM (SELECT k.arm, k.eid, k.etype, x.seconds\n",
     "  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER, ADD COLUMN priority_rule_id BIGINT;\n  UPDATE _gaps g SET priority_seconds = p.seconds, priority_rule_id = p.rule_id\n    FROM (SELECT k.arm, k.eid, k.etype, x.seconds, x.rule_id\n", 1],
    ["（每組「臂×選舉×職位」問一次；多條規則相符取最小，跟優先層「取最後面那層」同一個方向）",
     "（每組「臂×選舉×職位」問一次；多條規則相符取最小；20261011350000 起相符的規則 id 也從這裡記，不再另算層）", 1],
    ["名下缺口的層壓到 boost_tier；", "名下缺口標 opened_by.traffic_boost（下一段給秒數）；", 1],
  ]);
  s = cut(s, "  -- >>> 優先層：既有的派工列跟著規則換層", "  -- <<< 優先層\n");
  return rep(s, [
    ["opened_at, opened_by, priority, priority_seconds, boost_seconds)", "opened_at, opened_by, priority_seconds, boost_seconds)", 1],
    ["jsonb_build_object('priority', g.priority, 'priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds)), g.priority,",
     "jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds)),", 1],
  ]);
}
function expectedIns(prev: string): string {
  return rep(prev, [
    ["opened_at, priority, priority_seconds, boost_seconds)", "opened_at, priority_seconds, boost_seconds)", 1],
    ["         (SELECT x.priority FROM activity_priority(CASE WHEN manual_task_is_visitor(NEW.source, NEW.task_type) THEN 'manual_visitor' ELSE 'manual_open' END, NULL, NULL) x LIMIT 1),\n", "", 1],
  ]);
}
function expectedTb(prev: string): string {
  return rep(prev, [
    ["DECLARE s traffic_boost_settings%ROWTYPE; v_lifted INTEGER := 0; v_default SMALLINT;", "DECLARE s traffic_boost_settings%ROWTYPE; v_lifted INTEGER := 0;", 1],
    ["  SELECT t.id INTO v_default FROM task_priority_tiers t WHERE t.is_default;  -- _gaps.priority 還沒算出來（NULL）的，當預設層\n", "", 1],
    ["COALESCE(g.priority, v_default) > s.boost_tier", "COALESCE(g.priority_seconds, 0) < s.boost_seconds", 3],
    ["  -- 每個可提層的缺口（現在的層比 boost_tier 靠後）", "  -- 每個可提層的缺口（現在的優先秒數比 boost_seconds 小）", 1],
    ["  -- g. 提層：沒暫停的達標頁名下的缺口，層壓到 boost_tier（新缺口出生時 opened_by 帶 traffic_boost）\n  UPDATE _gaps g SET priority = s.boost_tier, opened_by",
     "  -- g. 提層：沒暫停的達標頁名下的缺口標 opened_by.traffic_boost（秒數由 seed 下一段給到 boost_seconds；新缺口出生時 opened_by 帶著這個旗標）\n  UPDATE _gaps g SET opened_by", 1],
  ]);
}

const FNS: [string, string, (s: string) => string][] = [
  ["seed_auto_task_queue", SEED_PREV, expectedSeed],
  ["contribution_tasks_insert_dispatch", INS_PREV, expectedIns],
  ["traffic_boost_apply", TB_PREV, expectedTb],
];

Deno.test("A1 改到的三支函式是最後一版，前一版是對的（正見那一份，日本站的複本不算）", async () => {
  for (const [fn, prev] of FNS) {
    const defining: string[] = [];
    for (const n of await migrationNames()) {
      if (/_policy_jp_|_jp_/.test(n)) continue;
      if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}(`)) defining.push(n);
    }
    // 之後只允許第二步（20261017010000：seed 多兩個標記區塊，守門在 verify-ticket-follows-task.test.ts）；其餘兩支仍是最後一版
    const later = fn === "seed_auto_task_queue" ? ["20261017010000_verify_ticket_follows_task.sql", "20261019040000_rekey_keeps_queue_position.sql" /* 換號沿用排隊位置，守門在 rekey-keeps-queue-position.test.ts */] : [];
    assertEquals(defining.slice(-(2 + later.length)), [prev, MIG_NAME, ...later], `${fn}：前一版要是 ${prev}、這支之後只能有 ${later.join("、") || "（沒有）"}（之後有人改，以最新那版為底重做）`);
  }
});

Deno.test("A2 新定義＝前一版加機械式替換，其餘一字不差", async () => {
  for (const [fn, prev, expected] of FNS) {
    assertEquals(fnText(MIG, fn), expected(fnText(await readMig(prev), fn)), `${fn} 的新定義跟前一版對不上`);
  }
});

Deno.test("A2 還原驗證：替換清單少一處、多改一個字，A2 都要紅", async () => {
  const prev = fnText(await readMig(SEED_PREV), "seed_auto_task_queue");
  const now = fnText(MIG, "seed_auto_task_queue");
  assert(now !== prev);
  assert(now.replace("'priority_rule_id', g.priority_rule_id", "'priority_rule_id', NULL") !== expectedSeed(prev));
  const tb = fnText(await readMig(TB_PREV), "traffic_boost_apply");
  assert(expectedTb(tb).replace("< s.boost_seconds", "<= s.boost_seconds") !== fnText(MIG, "traffic_boost_apply"));
});

Deno.test("A3 刪掉的函式與欄位：正見最後一版的函式、視圖、Edge Function 都不再讀", async () => {
  for (const drop of [
    "DROP FUNCTION IF EXISTS rebalance_queue();",
    "DROP FUNCTION IF EXISTS activity_priority(TEXT, INTEGER, TEXT, DATE);",
    "DROP FUNCTION IF EXISTS manual_front_at(TEXT);",
    "ALTER TABLE task_dispatches DROP COLUMN IF EXISTS priority;",
    "ALTER TABLE task_priority_tiers DROP COLUMN IF EXISTS weight;",
    "ALTER TABLE traffic_boost_settings DROP COLUMN IF EXISTS boost_tier;",
  ]) assert(MIG.includes(drop), `少了：${drop}`);

  // 正見每支函式的最後一版（日本站的複本在 policy_jp，有自己的同名函式，不算）
  const latest = new Map<string, string>();
  const names = (await migrationNames()).filter((n) => !/_policy_jp_|_jp_/.test(n));
  for (const n of names) {
    const sql = await readMig(n);
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.|shared\.)?([a-z_0-9]+)\(/g)) {
      // fnText 認不得的寫法（$function$ 之類）退回「到下一個 CREATE 為止」
      let body: string;
      try { body = fnText(sql, m[1]); } catch { body = sql.slice(m.index!, sql.indexOf("\nCREATE ", m.index! + 1) >>> 0 || undefined); }
      latest.set(m[1], body);
    }
  }
  for (const dropped of ["rebalance_queue", "activity_priority", "manual_front_at"]) latest.delete(dropped);
  const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const [fn, body] of latest) {
    assert(!/\b(rebalance_queue|activity_priority|manual_front_at)\(/.test(code(body)), `${fn} 還在呼叫已刪掉的函式`);
    assert(!/boost_tier/.test(code(body)), `${fn} 還在讀 traffic_boost_settings.boost_tier`);
    assert(!/\bd\.priority\b|task_priority_tiers\b[^;]*\bweight\b/.test(code(body)), `${fn} 還在讀 task_dispatches.priority 或層的權重`);
  }
  assert(/CREATE VIEW page_traffic_boosted_tasks AS[\s\S]*d\.priority_seconds >= s\.boost_seconds;/.test(MIG), "視圖改看優先秒數");

  // Edge Function（正見的；jp-* 有自己的 policy_jp）
  for await (const e of Deno.readDir(new URL("../", import.meta.url))) {
    if (!e.isDirectory || e.name.startsWith("jp-") || e.name === "_shared") continue;
    let src = "";
    try { src = await Deno.readTextFile(new URL(`../${e.name}/index.ts`, import.meta.url)); } catch { continue; }
    assert(!/rebalance_queue|activity_priority"|task_priority_tiers|boost_tier/.test(src), `${e.name} 還在讀刪掉的東西`);
  }
});
