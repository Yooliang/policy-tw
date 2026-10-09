/**
 * 選舉時程與公報入口參數化（盤點 #1、#2，2026-10-07 維護者同意；migration 20261008000001、20261008000002）。
 *
 * 起因：
 *   - 名單清查任務的說明寫死「資格審查 10-16 前完成、10-23 抽號次」，10-16 過了還會派到 11-17。
 *   - 公報入口有兩份真相（TS BULLETIN_YEAR_DIR、SQL 的 CASE election_year WHEN 2022…），而且都沒有 2026。
 *
 * 守的事：
 *   1. 派工函式「現行」那一版（掃所有 migration 取最後一次定義）裡沒有寫死的選舉日期或公報網址
 *   2. 日期欄位的回填值、過了日期不再出現的條件
 *   3. TS 後備（BULLETIN_YEAR_DIR）與 migration 回填對得上；matchBulletin 吃得進資料庫來的資料夾
 * SQL 另外在 PGlite 與正式庫唯讀實跑過（新舊兩版輸出的雜湊相同，見 PR 說明）。
 */
import { assert, assertEquals, assertMatch, assertNotMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { buildBulletinIndex, BULLETIN_YEAR_DIR, bulletinYearDirsFromElections, matchBulletin } from "./election-bulletin.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

async function allMigrations(): Promise<Array<{ name: string; sql: string }>> {
  const out: Array<{ name: string; sql: string }> = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (!e.isFile || !e.name.endsWith(".sql")) continue;
    out.push({ name: e.name, sql: (await Deno.readTextFile(new URL(e.name, MIGRATIONS))).replace(/\r/g, "") });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 某個函式「現行」的定義：掃所有 migration，取最後一次 CREATE OR REPLACE FUNCTION name( 到 $function$／$$ 結束 */
async function latestDef(name: string): Promise<{ file: string; def: string }> {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${name}\\(`);
  let found: { file: string; def: string } | null = null;
  for (const m of await allMigrations()) {
    const i = m.sql.search(re);
    if (i < 0) continue;
    const rest = m.sql.slice(i);
    const tag = /AS (\$[a-z]*\$)/.exec(rest);
    if (!tag) continue;
    const bodyStart = rest.indexOf(tag[0]) + tag[0].length;
    const end = rest.indexOf(tag[1], bodyStart);
    found = { file: m.name, def: rest.slice(0, end + tag[1].length) };
  }
  if (!found) throw new Error(`找不到 ${name} 的定義`);
  return found;
}

const MIG1 = "20261008000001_roster_schedule_dates.sql";
const MIG2 = "20261008000002_election_bulletin_columns.sql";
const read = async (f: string) => (await Deno.readTextFile(new URL(f, MIGRATIONS))).replace(/\r/g, "");

// ---- #1 名單清查的選舉時程 ----

Deno.test("#1 名單清查任務（現行版）不寫死選舉時程日期，日期都讀 roster_check_scope", async () => {
  const { file, def } = await latestDef("contribution_auto_tasks_raw");
  assert(file >= MIG1, `現行 contribution_auto_tasks_raw 在 ${file}，應該是 ${MIG1} 或更新`);
  assertNotMatch(def, /資格審查\s*\d/, "資格審查日期寫死");
  assertNotMatch(def, /\d{1,2}-\d{1,2}\s*抽號/, "抽號次日期寫死");
  assertNotMatch(def, /直轄市長是\s*\d/, "直轄市長名單日期寫死");
  assertNotMatch(def, /登記已於\s*\d{4}-\d{2}-\d{2}/, "登記截止日寫死");
  assertNotMatch(def, /2026-09-04/, "登記截止日寫死");
  const flat = def.replace(/\s+/g, " ");
  assertStringIncludes(flat, "roster_schedule_text(s.registration_closed_on, s.list_announced_on, s.municipal_mayor_list_on, s.qualification_review_by, s.ballot_draw_on)");
  // 號次：抽籤日（含當天）之前還沒有；抽完了就不再說「還沒有號次可填」
  assertStringIncludes(flat, "CASE WHEN s.ballot_draw_on IS NULL OR s.ballot_draw_on >= CURRENT_DATE THEN '，也還沒有號次可填' ELSE '' END");
});

Deno.test("#1 時程句：過了日期的不再出現（日期當天還在），日期欄 NULL 就不提", async () => {
  const sql = await read(MIG1);
  const fn = /CREATE OR REPLACE FUNCTION roster_schedule_text[\s\S]*?\$\$;/.exec(sql)?.[0] ?? "";
  assert(fn.length > 0, "找不到 roster_schedule_text");
  assertStringIncludes(fn, "WHEN mayor_list_on >= today THEN");
  assertStringIncludes(fn, "WHEN review_by >= today THEN");
  assertStringIncludes(fn, "WHEN draw_on >= today THEN");
  assertMatch(fn, /today DATE DEFAULT CURRENT_DATE/);
  // 三項都是日期欄來的，不是字面
  assertNotMatch(fn, /10-16|10-23|11-12|09-04/);
});

Deno.test("#1 回填：2026 九合一的三個日期，且只動 2026 的列", async () => {
  const sql = await read(MIG1);
  const upd = /UPDATE roster_check_scope\s+SET([\s\S]*?)WHERE election_id = 2026;/.exec(sql)?.[1] ?? "";
  assertStringIncludes(upd, "qualification_review_by = DATE '2026-10-16'");
  assertStringIncludes(upd, "ballot_draw_on = DATE '2026-10-23'");
  assertStringIncludes(upd, "municipal_mayor_list_on = DATE '2026-11-12'");
  for (const col of ["qualification_review_by", "ballot_draw_on", "municipal_mayor_list_on"]) {
    assertMatch(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${col} DATE`));
  }
});

Deno.test("#1 沒動計分／門檻：roster_check 臂的篩選條件、冷卻、派工分數照舊（重查條件 2026-10-08 起多一條缺口，recheck_days 與嘗試冷卻仍在）", async () => {
  const { def } = await latestDef("contribution_auto_tasks_raw");
  // 2026-10-08（缺口盤點 R2，migration 20261008112000）：重查條件從「沒清查過 OR 過了 recheck_days」變成
  // 「沒清查過 OR 缺口還在（最近一次回報的 cec_count > 我們的名冊內人數）OR 過了 recheck_days」；細節與情境見 roster-check-gap.test.ts
  // 2026-10-09（#466，migration 20261009230000）：缺口那一行先扣掉登記後退選的人（cec_count − filed_out）再比 n_listed；細節見 roster-filed-withdrawn.test.ts
  assertStringIncludes(def, "AND (rc.last_checked IS NULL\n");
  assertStringIncludes(def, "         OR COALESCE(rc.last_cec_count, 0) - COALESCE(fo.n_filed_out, 0) > COALESCE(o.n_listed, 0)\n         OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)");
  assertStringIncludes(def, "rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL");
  assertStringIncludes(def, "         2, l.name\n  FROM roster_check_scope s");
});

// ---- #2 公報入口 ----

Deno.test("#2 政見三要素任務（現行版）不寫死公報網址，改讀 elections.bulletin_hint", async () => {
  const { file, def } = await latestDef("contribution_auto_tasks_policy_elements");
  assert(file >= MIG2, `現行 contribution_auto_tasks_policy_elements 在 ${file}，應該是 ${MIG2} 或更新`);
  assertNotMatch(def, /eebulletin\.cec\.gov\.tw\/\?dir=/);
  assertNotMatch(def, /bulletin\.cec\.gov\.tw\/\?dir=/);
  assertNotMatch(def, /WHEN 202[246] THEN/);
  assertStringIncludes(def, "e.bulletin_hint, e.bulletin_published_on");
  // 上架日之前不給（還沒上架的網址是死連結）；沒填就退回原本那句
  assertStringIncludes(def, "c.bulletin_hint IS NOT NULL AND (c.bulletin_published_on IS NULL OR c.bulletin_published_on <= CURRENT_DATE)");
  assertStringIncludes(def, "中選會選舉公報（投票前約兩週才出版；出版前看候選人官網、競選臉書的政見頁）");
});

interface Backfill { id: number; dir: string; hint: string; publishedOn: string | null }

async function bulletinBackfill(): Promise<Backfill[]> {
  const sql = await read(MIG2);
  return [...sql.matchAll(/UPDATE elections SET bulletin_dir = '(\d+)', bulletin_hint = '([^']*)'(?:, bulletin_published_on = DATE '([\d-]+)')? WHERE id = (\d+);/g)]
    .map((m) => ({ id: Number(m[4]), dir: m[1], hint: m[2], publishedOn: m[3] ?? null }));
}

Deno.test("#2 回填：2022、2024 是原本寫死的值，2026 預先填好、到上架日才給", async () => {
  const b = await bulletinBackfill();
  assertEquals(b.map((x) => x.id), [2022, 2024, 2026]);
  const by = Object.fromEntries(b.map((x) => [x.id, x]));
  assertEquals(by[2022].hint, "https://eebulletin.cec.gov.tw/?dir=111 ← 中選會 2022（111 年）地方選舉公報：點縣市 → 選舉別 → 選舉區 PDF，候選人登記的政見原文在上面");
  assertEquals(
    by[2024].hint,
    "https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1%2F02%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1%2F113%E5%B9%B4%E7%AC%AC11%E5%B1%86 ← 中選會 2024（113 年）第 11 屆立委選舉公報",
  );
  assertEquals(by[2022].publishedOn, null, "已上架的不設上架日（行為不變）");
  assertEquals(by[2024].publishedOn, null);
  assertEquals(by[2026].publishedOn, "2026-11-18", "2026 公報投票前十日上架");
  assertStringIncludes(by[2026].hint, "?dir=115");
});

Deno.test("#2 同一列裡 bulletin_dir 與 bulletin_hint 對得上（hint 裡的資料夾就是 dir）", async () => {
  for (const b of await bulletinBackfill()) {
    assertMatch(b.dir, /^\d{3}$/);
    // 地方公報：?dir=111；立委公報：…113%E5%B9%B4（113年）
    assert(b.hint.includes(`?dir=${b.dir}`) || b.hint.includes(`${b.dir}%E5%B9%B4`), `${b.id}：hint 沒有 ${b.dir}`);
  }
});

Deno.test("#2 兩份真相收成一份：TS 後備 BULLETIN_YEAR_DIR 與 migration 回填一致（選舉 id → 民國年資料夾）", async () => {
  for (const b of await bulletinBackfill()) {
    assertEquals(BULLETIN_YEAR_DIR[b.id], b.dir, `選舉 ${b.id}`);
  }
  // 歷史兩屆 elections 表沒有，只在後備
  assertEquals(BULLETIN_YEAR_DIR[2014], "103");
  assertEquals(BULLETIN_YEAR_DIR[2018], "107");
});

Deno.test("#2 bulletinYearDirsFromElections：表上有填的蓋過後備，沒填或寫法不對的沿用後備", () => {
  const dirs = bulletinYearDirsFromElections([
    { id: 2026, bulletin_dir: "115" },
    { id: 2030, bulletin_dir: "119" },
    { id: 2022, bulletin_dir: null },
    { id: 2024, bulletin_dir: "13" },
    { id: 4 },
  ]);
  assertEquals(dirs[2026], "115");
  assertEquals(dirs[2030], "119", "新一屆只要在 elections 填 bulletin_dir 就認得，不用改程式");
  assertEquals(dirs[2022], "111");
  assertEquals(dirs[2024], "113", "不是三位數的民國年不收");
  assertEquals(dirs[4], undefined);
  assertEquals(dirs[2014], "103");
});

Deno.test("#2 matchBulletin 吃資料庫來的資料夾：2026（115）有清單就對得到，沒填的屆別回原因", () => {
  const index = buildBulletinIndex(["115/06臺南市/01市長/市長.pdf", "111/06臺南市/01市長/市長.pdf"]);
  const unit = { election_type: "縣市長", region: "台南市", sub_region: "", village: "" };
  const dirs = bulletinYearDirsFromElections([{ id: 2026, bulletin_dir: "115" }, { id: 2030, bulletin_dir: "119" }]);
  const m = matchBulletin(unit, index, 2026, dirs);
  assert(m.ok && m.paths[0] === "115/06臺南市/01市長/市長.pdf");
  assertEquals(matchBulletin(unit, index, 2022).ok, true, "沒傳 yearDirs 沿用後備，原本的呼叫不變");
  const none = matchBulletin(unit, index, 2030, dirs);
  assert(!none.ok && /不在 eebulletin/.test(none.reason) === false, "2030 有資料夾但清單裡沒有檔案 → 對不到");
  const unknown = matchBulletin(unit, index, 2099, dirs);
  assert(!unknown.ok && unknown.reason.includes("2099"));
});
