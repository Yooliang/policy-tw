/**
 * 收掉逐筆補開票結果 raw:election_result_missing，一律走整批版（migration 20261010170000；工作單 Yooliang/policy-ops#72）。
 *   - 整批版＝前一版拿掉「對不上的逐位派只派名下沒有政見的人」那一行（＋一行註解換掉）
 *   - contribution_auto_tasks_raw＝前一版拿掉 election_result_missing 那一整段 UNION 分支，其餘一字不動
 *   - activity_arm_names＝前一版拿掉一個名字；規則 13 與主控台段落那一列刪掉
 *   - 任務型別 election_result_missing 留著（整批版對不上名單的逐位件、elected_missing 還在用）
 *   還原驗證：把那一行限制放回整批版，跟這一版就對不上
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG = "20261010170000_retire_single_election_result.sql";
const SQL = await readMig(MIG);
const ER = "contribution_auto_tasks_election_results";
const RAW = "contribution_auto_tasks_raw";
const NAMES = "activity_arm_names";

const POLICY_GUARD = "     AND NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = m.politician_id AND pl.removed_at IS NULL)\n";
const OLD_NOTE = "  -- 名下有政見的那幾筆 contribution_auto_tasks_raw 原本就在派同一個 task_id，這裡不重複\n";
const NEW_NOTE = "  -- 名下有政見的也在這裡派（20261010170000 起逐筆版 raw:election_result_missing 收掉，OPS #72）\n";

Deno.test("整批版：只拿掉「名下沒有政見」那一行限制（對不上名單的逐位件，名下有政見的也派）", async () => {
  const prev = await latestFn(ER, MIG);
  assertEquals(prev.split(POLICY_GUARD).length - 1, 1);
  assertEquals(fnText(SQL, ER), prev.replace(POLICY_GUARD, "").replace(OLD_NOTE, NEW_NOTE));
});

Deno.test("還原驗證：把那一行限制放回去就不是這一版", async () => {
  const prev = await latestFn(ER, MIG);
  const now = fnText(SQL, ER);
  assert(!now.includes(POLICY_GUARD), "限制已拿掉");
  assert(now.replace(NEW_NOTE, OLD_NOTE) !== prev, "跟前一版不同（少了那一行限制）");
});

Deno.test("raw：只拿掉 election_result_missing 那一段分支，其餘一字不動", async () => {
  const prev = await latestFn(RAW, MIG);
  const now = fnText(SQL, RAW);
  const a = prev.indexOf("  UNION ALL\n  SELECT 'auto:election_result_missing:' || pe.id, 'election_result_missing',");
  assert(a > 0);
  const b = prev.indexOf("$function$", a);
  assertEquals(now, prev.slice(0, a) + prev.slice(b));
  assert(!now.includes("'auto:election_result_missing:'"), "raw 不再派逐筆補開票結果");
});

Deno.test("臂名清單少一個名字；規則與主控台段落刪掉；任務型別留著", async () => {
  const prev = await latestFn(NAMES, MIG);
  assertEquals(fnText(SQL, NAMES), prev.replace("    'raw:election_result_missing',\n", ""));
  assertStringIncludes(SQL, "DELETE FROM activity_rules WHERE id = 13 AND activity = 'raw:election_result_missing';");
  assertStringIncludes(SQL, "DELETE FROM console_arm_stage_map WHERE arm = 'raw:election_result_missing';");
  assertStringIncludes(fnText(SQL, ER), "'auto:election_result_missing:' || m.politician_election_id", "整批版對不上的逐位件還用這個型別");
});
