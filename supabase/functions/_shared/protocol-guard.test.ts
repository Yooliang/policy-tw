/**
 * 守門測試：把「每次改完要記得同步的三個地方」變成會紅的燈。
 *
 * 這些規則原本靠人記得：門檻改了要同時改 SQL、TS 與 skill.md 的表格；
 * skill.md 不可以出現真實的紀錄 id；版本號寫在檔頭與檔尾兩處。
 * 只要有一處忘了，對外協議就會教錯規則，而且不會有任何東西變紅。
 *
 * 找 migration 一律用「掃目錄挑最新一支定義該函式的檔案」，不寫死檔名。
 * 寫死檔名的測試在新增 migration 之後會繼續守著舊數字——這個專案踩過。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { AGREE_THRESHOLDS, type RiskLevel } from "./consensus.ts";
import { TASK_CHECK_COOLDOWN_DAYS } from "./apply-contribution.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const SKILL_MD = new URL("../../../public/skill.md", import.meta.url);

/** 掃 migrations 目錄，回傳最後一支定義 p_fn 的檔案內容（檔名按字典序＝時間序） */
async function latestMigrationDefining(fn: string): Promise<{ name: string; sql: string }> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  }
  names.sort();
  for (const name of names.reverse()) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS));
    if (sql.includes(`FUNCTION ${fn}`)) return { name, sql };
  }
  throw new Error(`沒有任何 migration 定義 ${fn}`);
}

/** 掃 migrations，回傳最後一支包含 needle 的檔案（檔名字典序＝時間序） */
async function latestMigrationContaining(needle: string): Promise<{ name: string; sql: string }> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  }
  names.sort();
  for (const name of names.reverse()) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS));
    if (sql.includes(needle)) return { name, sql };
  }
  throw new Error(`沒有任何 migration 含有 ${needle}`);
}

function parseSqlMatrix(sql: string): Record<string, Record<string, number>> {
  const body = sql.slice(sql.lastIndexOf("FUNCTION contribution_required_agree"));
  const rowRe = /WHEN v_risk = '(\w+)' THEN CASE v_kind WHEN 'official' THEN (\d+) WHEN 'media' THEN (\d+) WHEN 'social' THEN (\d+) ELSE (\d+) END/g;
  const rows = Object.fromEntries(
    [...body.matchAll(rowRe)].map((m) => [m[1], { official: +m[2], media: +m[3], social: +m[4], other: +m[5] }]),
  );
  const fallback = body.match(/\n\s+ELSE (\d+)\n\s+END;/);
  assert(fallback, "裁決走最後的 ELSE");
  rows.adjudication = { official: +fallback![1], media: +fallback![1], social: +fallback![1], other: +fallback![1] };
  return rows;
}

Deno.test("門檻矩陣：最新 migration 的 SQL 與 AGREE_THRESHOLDS 逐格相同", async () => {
  const { name, sql } = await latestMigrationDefining("contribution_required_agree");
  const sqlRows = parseSqlMatrix(sql);
  const tsKeys = Object.keys(AGREE_THRESHOLDS).sort();
  assertEquals(Object.keys(sqlRows).sort(), tsKeys, `${name} 的風險等級與 TS 不一致`);
  for (const risk of tsKeys as RiskLevel[]) {
    assertEquals(sqlRows[risk], AGREE_THRESHOLDS[risk], `${name}：${risk} 這一列對不上`);
  }
});

Deno.test("門檻矩陣：skill.md 對外公布的表格與 AGREE_THRESHOLDS 相同", async () => {
  const md = await Deno.readTextFile(SKILL_MD);
  const header = md.indexOf("| 型別 | official | media | social | other |");
  assert(header > 0, "skill.md 找不到門檻表格");
  const table = md.slice(header).split("\n").slice(2).filter((l) => l.startsWith("|"));
  assert(table.length >= 4, "門檻表格至少要有四列");

  // 每一列的四個數字要能對到 AGREE_THRESHOLDS 裡的某一個風險等級；
  // 用「數字組合」比對而不是列的順序，這樣重排表格不會誤紅。
  const want = new Set(Object.values(AGREE_THRESHOLDS).map((r) => `${r.official},${r.media},${r.social},${r.other}`));
  const got = new Set<string>();
  for (const line of table) {
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    const nums = cells.slice(1, 5).map(Number);
    assert(nums.every((n) => Number.isInteger(n)), `這一列的票數不是整數：${line}`);
    got.add(nums.join(","));
  }
  for (const combo of want) {
    assert(got.has(combo), `skill.md 的表格少了票數組合 ${combo}；門檻改了但對外文件沒跟上`);
  }
});

Deno.test("skill.md 不可以出現真實的紀錄 id，範例一律用預留的假 uuid", async () => {
  const md = await Deno.readTextFile(SKILL_MD);
  const uuids = md.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  const leaked = uuids.filter((u) => !/^00000000-0000-4000-8000-0000000000[0-9a-f]{2}$/i.test(u));
  assertEquals(leaked, [], "這些是真實資料的 id，貼進對外協議等於把線上紀錄寫死在文件裡");
});

Deno.test("skill.md 檔頭與檔尾的版本號要一致", async () => {
  const md = await Deno.readTextFile(SKILL_MD);
  const head = md.match(/\*\*版本\*\*：(\d+\.\d+\.\d+)/);
  const foot = md.match(/\*協議版本 (\d+\.\d+\.\d+)/);
  assert(head, "找不到檔頭的版本號");
  assert(foot, "找不到檔尾的版本號");
  assertEquals(head![1], foot![1], "檔頭改了、檔尾忘了改");
});

Deno.test("管線快照：採樣函式與排程都在最新的 migration 裡，欄位與前端讀的對得上", async () => {
  const { sql } = await latestMigrationDefining("pipeline_take_snapshot");
  // 採樣頻率改了，前端「多久一筆」的文案與 SAMPLE_INTERVAL_HOURS 也要一起改，
  // 否則畫面會告訴讀者錯的等待時間。這支測試就是為了逼出那個連動。
  // 排程可能不在定義函式的那一支 migration 裡（改頻率只會新增一支 cron.schedule），
  // 所以找的是「最後一支設定這個排程的檔案」。
  const cron = await latestMigrationContaining("cron.schedule('pipeline-snapshot");
  const sched = cron.sql.match(/cron\.schedule\('(pipeline-snapshot[^']*)',\s*'([^']+)'/);
  assert(sched, "找不到 cron.schedule");
  assertEquals(sched![2], "0 * * * *", "排程要是每小時整點");
  assert(sched![1].length > 0, "排程要有固定名稱，重跑 migration 才不會排兩份");

  // 圖表讀這幾個欄位，少一個就畫不出來
  for (const col of ["tasks_open", "tasks_by_type", "pending", "applied", "votes_total", "voters", "taken_at"]) {
    assert(sql.includes(col), `快照表少了 ${col}`);
  }
  // 政見數要排除軟移除的，否則移除一筆之後圖表上的數字不會動
  assert(sql.includes("FROM policies WHERE removed_at IS NULL"), "政見數要排除已移除的");
  // 對外要能讀，不然網站上的圖表拿不到資料
  assert(sql.includes('CREATE POLICY "Public read" ON pipeline_snapshots'), "快照要公開可讀");
});

Deno.test("無異動的冷卻天數：SQL 與 TypeScript 要是同一個數字", async () => {
  const { sql } = await latestMigrationDefining("task_check_cooldown_days");
  const m = sql.match(/FUNCTION task_check_cooldown_days\(\)[\s\S]*?SELECT\s+(\d+)/);
  assert(m, "找不到 SQL 的冷卻天數");
  assertEquals(Number(m![1]), TASK_CHECK_COOLDOWN_DAYS, "SQL 與 TS 的冷卻天數不一致；改一邊一定要改另一邊");

  // 冷卻過濾必須在 LIMIT 之前，否則要 12 筆濾掉 3 筆就只回 9 筆，
  // 甚至在還有幾百筆可派時回空。
  const { sql: tasksSql } = await latestMigrationDefining("contribution_auto_tasks");
  const body = tasksSql.slice(tasksSql.lastIndexOf("FUNCTION contribution_auto_tasks("));
  const filterAt = body.indexOf("task_checks");
  const limitAt = body.lastIndexOf("LIMIT");
  assert(filterAt > 0 && limitAt > filterAt, "冷卻過濾要寫在 LIMIT 之前");
});
