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
import { AGREE_THRESHOLDS, riskLevel, type RiskLevel } from "./consensus.ts";
import { TASK_CHECK_COOLDOWN_DAYS } from "./apply-contribution.ts";
import { CONTRIBUTION_TYPES } from "./contribution-schema.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { KIND_TO_TASK_TYPE, REQUEST_KINDS } from "./request-task.ts";
import { CONTRIBUTE_DAILY_LIMIT_PER_IP } from "./contribute-handler.ts";
import { VERIFY_DAILY_LIMIT_PER_IP } from "./verify-handler.ts";

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
  // 行尾要吃 CRLF：這個 repo 在 Windows 上 checkout 會把 .sql 轉成 CRLF
  // （rebase 後整包重新 checkout 就會發生），寫死 \n 的話這支測試會在
  //  Windows 上紅、在 CI 的 Linux runner 上綠——比單純紅掉更糟。
  const fallback = body.match(/\r?\n\s*ELSE (\d+)\s*\r?\n\s*END;/);
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
  // 要找的是薄薄那一層 wrapper，不是 _raw。不帶括號會配到 contribution_auto_tasks_raw
  // 的定義檔（它沒有冷卻過濾也沒有 LIMIT），這支測試就會在完全正確的改動上變紅。
  const { sql: tasksSql } = await latestMigrationDefining("contribution_auto_tasks(");
  const body = tasksSql.slice(tasksSql.lastIndexOf("FUNCTION contribution_auto_tasks("));
  const filterAt = body.indexOf("task_checks");
  const limitAt = body.lastIndexOf("LIMIT");
  assert(filterAt > 0 && limitAt > filterAt, "冷卻過濾要寫在 LIMIT 之前");
});

Deno.test("每一種貢獻型別的風險等級：SQL 與 TypeScript 要一致", async () => {
  // 只比對門檻矩陣（風險 × 來源等級）抓不到「型別被分錯級」。2026-09-12 就是這樣漏掉
  // roster_check：TS 分 light（官方 1 票），SQL 那行沒寫它、掉進 ELSE 'normal'（2 票）。
  // 代理看到的 required_agree 走 TS，真正決定狀態的是 SQL，於是畫面顯示 1/1 卻永遠
  // 停在 pending，沒有任何錯誤。新增型別時這支測試會先紅。
  const { sql } = await latestMigrationDefining("contribution_required_agree");
  const body = sql.slice(sql.lastIndexOf("FUNCTION contribution_required_agree"));
  const from = body.indexOf("v_risk := CASE");
  assert(from > 0, "找不到 SQL 的風險分級 CASE");
  const caseBlock = body.slice(from, body.indexOf("END;", from));
  const branches = new Map<string, string>();
  for (const m of caseBlock.matchAll(/WHEN ([\s\S]*?) THEN '(\w+)'/g)) {
    branches.set(m[2], `${branches.get(m[2]) ?? ""} ${m[1]}`);
  }
  assert(branches.size > 0, "SQL 的風險分級 CASE 解析不出任何分支");

  // correction 的風險看 payload（改 candidate_status 才是 high），不能用型別名直接比
  const PAYLOAD_DEPENDENT = new Set<string>(["correction"]);
  for (const type of CONTRIBUTION_TYPES) {
    if (PAYLOAD_DEPENDENT.has(type)) continue;
    const risk = riskLevel(type, {});
    const quoted = new RegExp(`'${type}'`);
    if (risk === "normal") {
      // normal 是 ELSE 的結果，所以型別名不該出現在任何分支裡
      for (const [r, text] of branches) {
        assert(!quoted.test(text), `SQL 把 ${type} 分到 ${r}，TS 說是 normal`);
      }
    } else {
      assert(
        quoted.test(branches.get(risk) ?? ""),
        `SQL 沒有把 ${type} 分到 ${risk}（TS 是 ${risk}）——代理看到一個門檻、資料庫用另一個，貢獻會卡在 pending 沒有錯誤訊息`,
      );
    }
  }
  assert(/candidate_status/.test(branches.get("high") ?? ""), "correction 改 candidate_status 要算 high");
});

Deno.test("名單清查：查不到官方名單不能算清查完成", async () => {
  // 缺口判斷「清查過了沒」必須只看 cec_count 有值的那些紀錄。
  // 少了這個 FILTER，一筆「我找不到名單」的回報就會把那個縣市壓住七天，
  // 跟真的把名單全部比對完一樣——2026-09-12 實際發生過。
  const { sql } = await latestMigrationContaining("auto:roster_check:");
  const body = sql.slice(sql.lastIndexOf("FUNCTION contribution_auto_tasks_raw("));
  assert(
    /MAX\(checked_at\)\s+FILTER\s+\(WHERE\s+cec_count\s+IS\s+NOT\s+NULL\)\s+AS\s+last_checked/.test(body),
    "last_checked 要只算 cec_count 有值的紀錄，否則查不到名單也會被當成清查完成",
  );
  // 找不到名單的嘗試要另外壓一小段時間，不然同一個縣市會被無限重派
  assert(body.includes("roster_attempt_cooldown_days()"), "查不到名單的嘗試要有自己的冷卻");
  const { sql: fnSql } = await latestMigrationDefining("roster_attempt_cooldown_days");
  const m = fnSql.match(/FUNCTION roster_attempt_cooldown_days\(\)[\s\S]*?SELECT\s+(\d+)/);
  assert(m, "找不到嘗試冷卻天數");
  const attemptDays = Number(m![1]);
  assert(attemptDays >= 1 && attemptDays < TASK_CHECK_COOLDOWN_DAYS, "嘗試冷卻要比無異動冷卻短：那是換人再試，不是結案");
});

Deno.test("每一種自動缺口的 task_type 都要有對應的貢獻型別建議", async () => {
  // 新增缺口時最容易忘的一步：SQL 長出新的 task_type，next 端點的 SUGGESTED_TYPE 沒跟上，
  // 代理拿到的 suggested_contribution_type 就是 null——它得自己猜要用哪一種型別回報。
  // 這個專案已經三次因為「新型別、兩邊沒對上」靜默出錯，所以這裡不比對單一字面，
  // 而是從 SQL 把所有 task_type 撈出來逐一檢查。
  const { sql } = await latestMigrationDefining("contribution_auto_tasks_raw(");
  const body = sql.slice(sql.lastIndexOf("FUNCTION contribution_auto_tasks_raw("));
  const sqlTypes = [...body.matchAll(/'auto:[a-z_]+:'[^,]*,\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert(sqlTypes.length >= 7, `只從 SQL 撈到 ${sqlTypes.length} 種 task_type，正則可能失效了`);

  for (const t of new Set(sqlTypes)) {
    assert(SUGGESTED_TYPE[t], `缺口 ${t} 沒有登記在 _shared/task-types.ts 的 SUGGESTED_TYPE，代理會收到 suggested_contribution_type: null`);
  }
  // 兩個端點都要用同一份，不可以再各抄一份（/tasks 那份曾經停在六種，漏四種沒人發現）
  for (const f of ["../next/index.ts", "../tasks/index.ts"]) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    assert(src.includes('from "../_shared/task-types.ts"'), `${f} 要 import 共用的 SUGGESTED_TYPE`);
    assert(!src.includes("const SUGGESTED_TYPE"), `${f} 不可以自己再宣告一份 SUGGESTED_TYPE`);
  }

  // skill.md 也要講得出這種任務是什麼，否則外部代理只拿到一個沒解釋的字串
  const skill = await Deno.readTextFile(SKILL_MD);
  for (const t of new Set(sqlTypes)) {
    assert(skill.includes("`" + t + "`"), `skill.md 沒有說明 ${t} 這種任務要做什麼`);
  }

  // 網站按鈕建出來的任務型別（request-task 的 KIND_TO_TASK_TYPE）同樣要登記與說明。
  // 這些不在 SQL 裡（不是自動缺口），所以上面那圈掃不到——2026-09-13 加 policy_validity
  // 時補的：新增一顆按鈕就是新增一種任務型別，同一個坑。
  for (const [kind, t] of Object.entries(KIND_TO_TASK_TYPE)) {
    if (t !== "audit") assert(SUGGESTED_TYPE[t], `按鈕 kind=${kind} 建的任務型別 ${t} 沒有登記在 _shared/task-types.ts`);
    assert(skill.includes("`" + t + "`"), `skill.md 沒有說明 ${t} 這種任務要做什麼`);
  }
  // 前端的 kind 清單與後端要是同一組，否則按鈕送出的 kind 會被後端以 400 擋掉
  const front = await Deno.readTextFile(new URL("../../../lib/request-task.ts", import.meta.url));
  const frontKinds = (front.match(/export type RequestKind = ([^\n]*)/)?.[1] ?? "")
    .split("|").map((x) => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  assertEquals(frontKinds.sort(), [...REQUEST_KINDS].sort(), "lib/request-task.ts 的 RequestKind 要跟 _shared/request-task.ts 的 REQUEST_KINDS 一致");
});

Deno.test("競選承諾：還沒投票的屆別不可以被問「進度如何」", async () => {
  // 2026-09-13 量到：progress_stale 的 219 個缺口裡只有 27 個問對了問題。
  // 其餘是競選承諾——2026 的投票日是 11-28，還沒選，不可能有執行進度；
  // 屆別空著的連是哪一場選舉都不知道。代理只能回 no_change，14 天後再被派一次。
  // 這支測試守著兩個條件：承諾要等投票日過了才問，落選／退選的不再問。
  const { sql } = await latestMigrationDefining("contribution_auto_tasks_raw(");
  const body = sql.slice(sql.lastIndexOf("FUNCTION contribution_auto_tasks_raw("));
  const branch = body.slice(body.indexOf("'auto:progress_stale:'"));
  const stale = branch.slice(0, branch.indexOf("UNION ALL"));

  assert(
    /e\.election_date\s+IS\s+NOT\s+NULL[\s\S]*?AND\s+e\.election_date\s*<\s*CURRENT_DATE/.test(stale),
    "投票日條件不見了：競選承諾必須等所屬選舉的投票日過了才派 progress_stale（屆別空的也會被這個條件排掉）",
  );
  assert(
    /election_result\s+IN\s*\(\s*'not_elected'\s*,\s*'withdrawn'\s*\)/.test(stale),
    "落選／退選者的承諾永遠不會有進度，要排掉，否則每 14 天重派一次",
  );
  // 施政類不受影響：那一支問法本來就是對的，不要被一起排掉
  assert(
    /pl\.status::TEXT\s*<>\s*'Campaign Pledge'/.test(stale),
    "施政類（非競選承諾）要維持原本的「90 天沒進度」問法",
  );
});
Deno.test("名單清查：不可以叫代理去查投票後才更新的來源", async () => {
  // 2026-09-13 查到的：43 個 roster_check 缺口，last_checked 全是空的——一次都沒成功過。
  // 原因是 hint_sources 把 db.cec.gov.tw（選舉「結果」資料庫，頁面自己標明「投票後 7 日內
  // 更新」）跟選舉公報（接近投票日才出版）列在最前面，兩個都回答不了進行中的選舉。
  // 這跟 progress_stale 問還沒投票的承諾「進度如何」是同一類 bug：問題答不出來。
  const { sql } = await latestMigrationDefining("contribution_auto_tasks_raw(");
  const body = sql.slice(sql.lastIndexOf("FUNCTION contribution_auto_tasks_raw("));
  const branch = body.slice(body.indexOf("'auto:roster_check:'"));
  const roster = branch.slice(0, branch.indexOf("UNION ALL"));

  // 公告日之前那一支的來源清單裡不可以有這兩個
  const beforeArm = roster.slice(roster.indexOf("ELSE ARRAY["), roster.indexOf("2, l.name"));
  assert(!beforeArm.includes("db.cec.gov.tw"), "登記階段的 hint_sources 不可以指向 db.cec.gov.tw——那是投票後才更新的結果資料庫");
  assert(!beforeArm.includes("bulletin.cec.gov.tw"), "登記階段的 hint_sources 不可以指向選舉公報——要接近投票日才出版");

  // 兩個階段要分開：任務必須依公告日決定該補 registered 還是 confirmed
  assert(roster.includes("s.list_announced_on"), "任務要依 roster_check_scope.list_announced_on 判斷現在是登記階段還是審定階段");
  assert(/registered/.test(roster) && /confirmed/.test(roster), "任務要明講這個階段該填哪一種 candidate_status");

  // 公告日存在 scope 表上而且不可為空：新增一屆就必須填，否則任務會講錯階段
  const { sql: colSql } = await latestMigrationContaining("list_announced_on");
  assert(
    /ALTER COLUMN list_announced_on SET NOT NULL/.test(colSql),
    "list_announced_on 要是 NOT NULL，不然新增一屆選舉時忘了填，任務會一直用登記階段的說法",
  );
});
Deno.test("每日額度：skill.md 不可以寫死數字，也不可以跟程式碼對不上", async () => {
  // 2026-09-14 小良哥把額度從 50／200 調到 200／800，同一個數字散在 5 個地方：
  // 兩個 TS 常數，加 skill.md 的說明、quota 範例、daily_quota 範例。手動同步五處
  // 就是下一次漏掉一處的原因——而且文件是對外協議，寫錯等於教錯外部代理。
  //
  // 作法是文件不寫數字，只說「看 /next 回應的 quota」。這支測試守住那個決定。
  const skill = await Deno.readTextFile(SKILL_MD);

  // 1. JSON 範例裡不可以出現寫死的 limit
  const hardCoded = [...skill.matchAll(/"(?:limit|daily_limit)"\s*:\s*(\d+)/g)].map((m) => m[1]);
  assertEquals(hardCoded, [], `skill.md 的範例寫死了額度數字；請改成 <今日提交上限> 這類佔位，真值看 /next 的 quota`);

  // 2. 說明文字裡也不可以寫死（「提交 200 筆、驗證 800 筆」那種）
  const prose = [...skill.matchAll(/(?:提交|驗證|每日最多)\s*(\d+)\s*(?:筆|題|次)/g)].map((m) => m[0]);
  assertEquals(prose, [], `skill.md 的說明寫死了額度；上限會調整，文件要指向 /next 的 quota`);

  // 3. 但文件還是得講得出去哪裡看，否則代理只會撞 429
  assert(skill.includes("quota"), "skill.md 要說明 quota 這個欄位在哪裡看");

  // 4. 額度本身仍然只有一個定義處：兩個常數都要是正整數，且驗證的上限不低於提交
  assert(Number.isInteger(CONTRIBUTE_DAILY_LIMIT_PER_IP) && CONTRIBUTE_DAILY_LIMIT_PER_IP > 0, "提交額度要是正整數");
  assert(Number.isInteger(VERIFY_DAILY_LIMIT_PER_IP) && VERIFY_DAILY_LIMIT_PER_IP > 0, "驗證額度要是正整數");
  assert(VERIFY_DAILY_LIMIT_PER_IP >= CONTRIBUTE_DAILY_LIMIT_PER_IP, "驗證額度不該比提交低");
});
Deno.test("協議只有一份：根目錄 SKILL.md 不可以是 public/skill.md 的複本", async () => {
  // 2026-09-13 踩到：根目錄放了 public/skill.md 的複本，停在 1.4.1、還寫著
  // 「這份文件就是唯一的協議」，而網址那份已經 1.4.4，兩份差 29 行。
  // 外部代理讀網址、看 repo 的人讀根目錄，說法不同時沒有任何東西會變紅。
  // 這支測試讓「複本回來」這件事直接紅燈。
  const root = new URL("../../../SKILL.md", import.meta.url);
  let rootText = "";
  try {
    rootText = await Deno.readTextFile(root);
  } catch {
    return; // 根目錄沒有這個檔也可以，指路檔是選配
  }
  assert(
    /policy-tw\.web\.app\/skill\.md/.test(rootText),
    "根目錄 SKILL.md 要指向 https://policy-tw.web.app/skill.md",
  );
  // 協議本文的特徵：檔頭的版本行、以及鐵律那一節。有這些就是複本不是指路。
  assert(
    !/\*\*版本\*\*：\d+\.\d+\.\d+/.test(rootText),
    "根目錄 SKILL.md 出現版本號＝又變成協議複本了；協議只留 public/skill.md 一份",
  );
  assert(
    !rootText.includes("## 2. 鐵律"),
    "根目錄 SKILL.md 出現協議本文章節＝又變成複本了",
  );
  const real = await Deno.readTextFile(SKILL_MD);
  assert(real.length > rootText.length * 3, "根目錄那份長度接近本文，八成又是複本");
});
