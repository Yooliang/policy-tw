/**
 * seed 重臂快取化（migration 20261126190000_seed_arm_cache.sql，2026-11-26）守門，文字層。
 *   · 三張表：RLS 開、不給 anon／authenticated 權限、沒有 policy；設定表單列、過期時限有下限
 *   · 四支重臂：改名 _live、原名換成薄函式；薄函式的回傳欄位與改名前的定義逐欄相同、快取就緒才讀快取、否則退回即時版
 *   · 總表與 seed 這支遷移一個字不動（兩支函式的歷史定義鏈由別的測試守著，這裡不准重新定義）
 *   · 刷新函式：每臂一個子交易、單臂失敗保留舊快取、帶兩個函式層級 SET、排程不在整十分鐘也不撞探針
 *   · 探針：重臂改量 _live，其餘各行與前一版逐行相同；排程降為每 6 小時
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const mig = await read("20261126190000_seed_arm_cache.sql");
const prev = await read("20261126150000_seed_arm_timings.sql");
const sql = noComments(mig);

const ARMS: Array<{ arm: string; fn: string; live: string; cols: string }> = [
  { arm: "mismatch", fn: "contribution_auto_tasks_mismatch", live: "contribution_auto_tasks_mismatch_live", cols: "task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT" },
  { arm: "issue_too_broad", fn: "contribution_auto_tasks_issue_too_broad", live: "contribution_auto_tasks_issue_too_broad_live", cols: "task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT" },
  { arm: "legacy", fn: "contribution_auto_tasks_legacy", live: "contribution_auto_tasks_legacy_live", cols: "task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT" },
  { arm: "roster_unit_findings", fn: "roster_unit_findings", live: "roster_unit_findings_live", cols: "task_id TEXT, arm TEXT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, unit TEXT, voted BOOLEAN,\n               items JSONB, items_count INTEGER, kinds JSONB, origin_task_ids TEXT[], target JSONB, what_we_need TEXT, hint_sources TEXT[]" },
];

/** 取一支函式 CREATE OR REPLACE 到下一個 $$; 為止的整段 */
function fnBlock(src: string, name: string): string {
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(start >= 0, `找不到 ${name} 定義`);
  const open = src.indexOf("$$", start);
  const close = src.indexOf("$$", open + 2);
  return src.slice(start, close + 2);
}

Deno.test("A1 三張表：RLS 開、不給 anon／authenticated、沒有 policy；設定表單列且過期時限有下限", () => {
  for (const t of ["seed_arm_cache", "seed_arm_cache_arms", "seed_arm_cache_settings"]) {
    assert(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`).test(sql), `缺表 ${t}`);
    assert(new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).test(sql), `${t} 沒開 RLS`);
    assert(new RegExp(`REVOKE ALL ON TABLE ${t} FROM PUBLIC, anon, authenticated`).test(sql), `${t} 沒收權限`);
    assert(!new RegExp(`CREATE POLICY[\\s\\S]{0,80}${t}`).test(sql), `${t} 不建 policy`);
    assert(!new RegExp(`GRANT[^;]*ON TABLE ${t}`, "i").test(sql), `${t} 不給表權限`);
  }
  assert(/id\s+INTEGER PRIMARY KEY CHECK \(id = 1\)/.test(sql));
  assert(/max_age_minutes INTEGER NOT NULL DEFAULT 180 CHECK \(max_age_minutes >= 10\)/.test(sql));
  assert(/PRIMARY KEY \(arm, row_no\)/.test(sql));
});

Deno.test("A2 重臂清單＝四支，live_fn 都有對應的改名", () => {
  const ins = sql.slice(sql.indexOf("INSERT INTO seed_arm_cache_arms"), sql.indexOf("ON CONFLICT (arm) DO NOTHING"));
  const rows = [...ins.matchAll(/\('([a-z_]+)',\s+'([a-z_]+)'\)/g)].map((m) => [m[1], m[2]]);
  assertEquals(rows, ARMS.map((a) => [a.arm, a.live]));
  for (const a of ARMS) {
    assert(new RegExp(`ALTER FUNCTION ${a.fn}\\(\\) RENAME TO ${a.live};`).test(sql), `${a.fn} 沒改名成 ${a.live}`);
  }
});

Deno.test("A3 薄函式：欄位與改名前逐欄相同、快取就緒才讀快取、否則退回即時版", () => {
  for (const a of ARMS) {
    const b = fnBlock(sql, a.fn);
    assert(b.includes(`RETURNS TABLE (${a.cols})`), `${a.fn} 回傳欄位與原定義不同`);
    assert(b.includes(`jsonb_to_record(c.p) AS r(${a.cols.replace(/\n\s+/g, "\n" + " ".repeat(43))})`) || b.includes(`AS r(${a.cols.replace(/\n\s+/g, " ")})`) || b.includes(`AS r(${a.cols.replace(/\n\s+/g, "\n" + " ".repeat(43))})`), `${a.fn} 的 jsonb_to_record 欄位對不上`);
    assert(b.includes(`seed_arm_cache_rows('${a.arm}')`), `${a.fn} 沒讀 ${a.arm} 的快取`);
    assert(b.includes(`FROM ${a.live}() l WHERE NOT seed_arm_cache_ready('${a.arm}')`), `${a.fn} 沒有「快取不可用就即時算」的退路`);
    assert(/UNION ALL/.test(b) && /LANGUAGE sql STABLE/.test(b));
    assert(!/SECURITY DEFINER/.test(b), "薄函式本身維持 invoker，臂的權限語意不變");
  }
});

Deno.test("A4 讀快取的兩支小工具是 SECURITY DEFINER 且鎖 search_path，只開給三個角色", () => {
  for (const f of ["seed_arm_cache_ready", "seed_arm_cache_rows"]) {
    const b = fnBlock(sql, f);
    assert(/SECURITY DEFINER SET search_path = public, pg_temp/.test(b), `${f} 要 SECURITY DEFINER＋固定 search_path`);
  }
  assert(/GRANT EXECUTE ON FUNCTION seed_arm_cache_ready\(TEXT\), seed_arm_cache_rows\(TEXT\) TO anon, authenticated, service_role;/.test(sql));
  const ready = fnBlock(sql, "seed_arm_cache_ready");
  for (const k of ["s.enabled", "a.enabled", "a.refreshed_at IS NOT NULL", "max_age_minutes"]) assert(ready.includes(k), `就緒判斷漏了 ${k}`);
});

Deno.test("A5 刷新函式：每臂子交易、單臂失敗保留舊快取、兩個 SET、不開放給 anon", () => {
  const b = fnBlock(sql, "seed_arm_cache_refresh");
  assert(/SET statement_timeout = '280s'/.test(b) && /SET work_mem = '16MB'/.test(b));
  assert(b.includes("pg_advisory_xact_lock"));
  assert(/BEGIN\s+DELETE FROM seed_arm_cache WHERE arm = r\.arm;/.test(b), "DELETE 與 INSERT 要在同一個子交易");
  assert(/EXCEPTION WHEN OTHERS THEN\s+UPDATE seed_arm_cache_arms SET last_error/.test(b), "失敗只記 last_error");
  const exc = b.slice(b.indexOf("EXCEPTION WHEN OTHERS"));
  assert(!/DELETE FROM seed_arm_cache/.test(exc) && !/refreshed_at\s*=/.test(exc), "失敗路徑不能動快取列與 refreshed_at");
  assert(b.includes("%I() t"), "即時函式名要用 %I 引用");
  assert(/REVOKE ALL ON FUNCTION seed_arm_cache_refresh\(TEXT\[\]\) FROM PUBLIC, anon, authenticated/.test(sql));
});

Deno.test("A6 總表與 seed 這支遷移不碰（歷史定義鏈由別的測試守著）", () => {
  assert(!/FUNCTION contribution_auto_tasks_arms\(/.test(sql), "不重新定義總表");
  assert(!/FUNCTION seed_auto_task_queue\(/.test(sql), "不重新定義 seed");
  assert(!/FUNCTION contribution_auto_tasks_raw\(/.test(sql));
});

Deno.test("A7 探針：重臂改量 _live，其餘各行與前一版逐行相同", () => {
  const probeOf = (s: string) => {
    const b = fnBlock(s, "seed_arm_timing_probe");
    return b.split("\n").filter((l) => /^\s+\('[a-z_]+', '/.test(l));
  };
  const before = probeOf(prev);
  const after = probeOf(sql);
  assertEquals(after.length, before.length);
  const liveOf = new Map(ARMS.map((a) => [a.arm, a.live]));
  let changed = 0;
  before.forEach((line, i) => {
    const arm = /\('([a-z_]+)'/.exec(line)![1];
    if (liveOf.has(arm)) {
      changed++;
      assertEquals(after[i], line.replace(/'([a-z_]+)\(\)'/, `'${liveOf.get(arm)}()'`), `${arm} 只換呼叫的函式名`);
    } else {
      assertEquals(after[i], line, `${arm} 不該變`);
    }
  });
  assertEquals(changed, ARMS.length);
  const b = fnBlock(sql, "seed_arm_timing_probe");
  assert(/SET statement_timeout = '280s'/.test(b) && /SET work_mem = '16MB'/.test(b));
});

Deno.test("A8 排程：刷新每小時一次、不在整十分鐘、不撞 :35 探針；探針降為每 6 小時", () => {
  const m = /cron\.schedule\('seed-arm-cache-refresh-heavy', '(\d+) \* \* \* \*'/.exec(sql);
  assert(m, "找不到刷新排程");
  const min = Number(m![1]);
  assert(min % 10 !== 0 && min !== 35, `刷新分鐘 ${min} 不能在整十分鐘或 :35`);
  assert(/SELECT seed_arm_cache_refresh\(\);/.test(sql));
  assert(/\('seed-arm-timing-probe-hourly', '35 \*\/6 \* \* \*'\)/.test(sql), "探針要改成每 6 小時");
  assert(/to_regnamespace\('cron'\) IS NULL/.test(sql), "沒有 cron 的環境要能跑");
});
