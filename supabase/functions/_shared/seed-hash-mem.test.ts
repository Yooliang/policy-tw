/**
 * seed 與總表的 hash_mem_multiplier＝1（migration 20261128010000_seed_hash_mem_multiplier.sql，2026-11-28）守門。
 *   A. 文字層：migration 只有兩句 ALTER FUNCTION（加自檢）、work_mem 字面沒被動；
 *      依時間戳走完全部 migration，seed_auto_task_queue()／contribution_auto_tasks_arms() 的「最後狀態」
 *      必須帶 hash_mem_multiplier＝1（最新一次 CREATE OR REPLACE 的本體帶 SET，或其後有 ALTER … SET）。
 *      CREATE OR REPLACE 會洗掉全部函式設定，所以後來的 PR 重定義這兩支卻沒帶，這裡會紅。
 *   B. PGlite：兩支函式先帶 work_mem＝16MB，套用 migration 後 pg_proc.proconfig 兩個設定都在；RESET 回滾只清該 key。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const MIG = "20261128010000_seed_hash_mem_multiplier.sql";
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const noComment = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const mig = norm(await Deno.readTextFile(new URL(MIG, MIGRATIONS)));
const FNS = ["seed_auto_task_queue", "contribution_auto_tasks_arms"] as const;

Deno.test("A1 migration 只有兩句 ALTER FUNCTION SET hash_mem_multiplier＝1，不動 work_mem 字面", () => {
  const code = noComment(mig);
  for (const fn of FNS) {
    assert(new RegExp(`ALTER FUNCTION public\\.${fn}\\(\\) SET hash_mem_multiplier = '1';`).test(code), fn);
  }
  assertEquals((code.match(/ALTER FUNCTION/g) ?? []).length, 2);
  assert(!/work_mem\s*=/.test(code.replace(/'work_mem=16MB'/g, "")), "不重設 work_mem");
  assert(!/CREATE OR REPLACE/.test(code), "不重貼函式本體");
});

Deno.test("A2 全部 migration 走完，兩支函式最後狀態仍帶 hash_mem_multiplier＝1", async () => {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  for (const fn of FNS) {
    let ok = false;
    let lastDef = "（沒有）";
    const defRe = new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${fn}\\(\\)([\\s\\S]*?)\\$(\\w*)\\$`, "g");
    const setRe = new RegExp(`ALTER FUNCTION (?:public\\.)?${fn}\\(\\)\\s+SET hash_mem_multiplier\\s*=\\s*'?1(?:\\.0)?'?\\s*;`, "g");
    const resetRe = new RegExp(`ALTER FUNCTION (?:public\\.)?${fn}\\(\\)\\s+(?:RESET hash_mem_multiplier|RESET ALL)\\s*;`, "g");
    for (const n of names) {
      const sql = noComment(norm(await Deno.readTextFile(new URL(n, MIGRATIONS))));
      const events: Array<[number, boolean, string]> = [];
      for (const m of sql.matchAll(defRe)) {
        events.push([m.index!, /SET hash_mem_multiplier\s*=\s*'?1(?:\.0)?'?/.test(m[1]), n]);
      }
      for (const m of sql.matchAll(setRe)) events.push([m.index!, true, ""]);
      for (const m of sql.matchAll(resetRe)) events.push([m.index!, false, ""]);
      events.sort((a, b) => a[0] - b[0]);
      for (const [, state, def] of events) {
        ok = state;
        if (def) lastDef = def;
      }
    }
    assert(ok, `${fn} 最後一次定義（${lastDef}）之後沒有帶 SET hash_mem_multiplier＝1：重定義時本體要帶，或其後再 ALTER FUNCTION … SET hash_mem_multiplier = '1'`);
  }
});

// ---------------- B. PGlite ----------------
async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE FUNCTION public.seed_auto_task_queue() RETURNS void LANGUAGE plpgsql SET statement_timeout = '280s' SET work_mem = '16MB' AS $f$ BEGIN NULL; END $f$;
    CREATE FUNCTION public.contribution_auto_tasks_arms() RETURNS integer LANGUAGE plpgsql SET work_mem = '16MB' AS $f$ BEGIN RETURN 1; END $f$;`);
  return db;
}
const cfg = async (db: PGlite, fn: string): Promise<string[]> =>
  (await db.query<{ c: string[] | null }>(`SELECT proconfig AS c FROM pg_proc WHERE proname = '${fn}' AND pronamespace = 'public'::regnamespace`)).rows[0].c ?? [];

Deno.test("B1 套用 migration 後兩支函式的 proconfig 含 hash_mem_multiplier=1，work_mem 與 statement_timeout 仍在", async () => {
  const db = await setup();
  await db.exec(mig);
  for (const fn of FNS) {
    const c = await cfg(db, fn);
    assert(c.includes("hash_mem_multiplier=1"), `${fn}: ${c.join(",")}`);
    assert(c.includes("work_mem=16MB"), `${fn} work_mem: ${c.join(",")}`);
  }
  assert((await cfg(db, "seed_auto_task_queue")).includes("statement_timeout=280s"));
});

Deno.test("B2 自檢：work_mem 被洗掉時 migration 要丟例外", async () => {
  const db = await setup();
  await db.exec(`CREATE OR REPLACE FUNCTION public.contribution_auto_tasks_arms() RETURNS integer LANGUAGE plpgsql AS $f$ BEGIN RETURN 1; END $f$;`);
  let failed = false;
  try {
    await db.exec(mig);
  } catch {
    failed = true;
  }
  assert(failed, "work_mem 不在時自檢應該失敗");
});

Deno.test("B3 回滾：RESET hash_mem_multiplier 只清該 key", async () => {
  const db = await setup();
  await db.exec(mig);
  await db.exec(`ALTER FUNCTION public.seed_auto_task_queue() RESET hash_mem_multiplier;`);
  const c = await cfg(db, "seed_auto_task_queue");
  assert(!c.some((x) => x.startsWith("hash_mem_multiplier")));
  assert(c.includes("work_mem=16MB") && c.includes("statement_timeout=280s"));
});
