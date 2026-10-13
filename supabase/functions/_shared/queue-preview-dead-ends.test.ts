/**
 * /queue 預覽不列「等查無回報」的任務、/next 拿掉每台機器 2:1（2026-10-13，migration 20261011330000_queue_preview_dead_ends.sql）。
 *
 * 小良回報：照片二選一一直排在 /queue 前面卻沒人做。正式庫查：那些任務都有一張查無回報（no_change）在等票，
 * /next 一律跳過（filterReportedDeadEnds），預覽卻照列。這支讓預覽跟 /next 用同一條件。
 * 同時 /next 的每台機器 2:1 拿掉（20261011320000 已取消全站 2:1；那一段的插隊判斷看 2000 年以前，秒數化後也認不得插隊了）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fnText, migrationNames, readMig } from "./arms-pglite.ts";

const MIG = "20261011330000_queue_preview_dead_ends.sql";
const PREV = "20261008165000_manual_tasks_as_arm.sql";
const BLOCK = /\n     -- >>> 等查無回報[\s\S]*?-- <<< 等查無回報\n/;

Deno.test("queue_preview＝前一版＋一段 WHERE（等查無回報），其餘一字不差；而且是最後一版", async () => {
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION queue_preview(")) defining.push(n);
  assertEquals(defining.slice(-2), [PREV, MIG], "queue_preview 的前一版要是 manual_tasks_as_arm、這支要是最後一版");
  const now = fnText(await readMig(MIG), "queue_preview");
  assert(BLOCK.test(now));
  assertEquals(now.replace(BLOCK, "\n"), fnText(await readMig(PREV), "queue_preview"));
  const block = now.match(BLOCK)![0];
  // 跟 /next 的 deadEnd 查詢同一條件：no_change、pending 或 verified、payload.task_id
  assert(block.includes("n.contribution_type = 'no_change' AND n.status IN ('pending', 'verified')"));
  assert(block.includes("n.payload->>'task_id' = g.task_id"));
  const next = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assert(next.includes(`.eq("contribution_type", "no_change")`) && next.includes(`.in("status", ["pending", "verified"]).in("payload->>task_id", candidateTaskIds)`), "/next 的查無條件改了，預覽要跟著改");
});

Deno.test("/next 不再有每台機器 2:1：驗證與任務只照 queue_at 先後", async () => {
  const next = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  for (const gone of ["machineOwesVerify", "machineOwesVerifyDuringBoost", "isFrontQueueAt", "MACHINE_LOOKBACK_HOURS"]) {
    assert(!next.includes(gone), `/next 不該再用 ${gone}`);
  }
  assert(/if \(head === "verify"\) return await serveVerify\(\);/.test(next), "隊頭是驗證就派驗證");
});
