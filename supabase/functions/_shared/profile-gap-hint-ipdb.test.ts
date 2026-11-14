/**
 * profile_gap 的 hint_sources 加 ipdb.tw（migration 20261115010000_profile_gap_hint_ipdb.sql，2026-11-15）。
 *
 *   A. 文字層：新定義拿掉 ★ 那段，必須一字不差回到前一版（20261019120000 的 contribution_auto_tasks_raw）；
 *      ipdb.tw 只出現一次、且在 profile_gap 那一臂裡。
 *   B. PGlite：把 migration 裡那段 CASE 原文拿去執行——當屆村里長帶 ipdb.tw；縣市長、非當屆的村里長不帶，原三條不變。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261115010000_profile_gap_hint_ipdb.sql";
const PREV_MIG = "20261019120000_roster_reconcile.sql";
const FN = "contribution_auto_tasks_raw";
const NEW = fnText(await readMig(MIG_NAME), FN);
const PREV = await latestFn(FN, MIG_NAME);

const MARK_START = "\n         -- ★ ipdb.tw：";

function stripStar(fn: string): string {
  const a = fn.indexOf(MARK_START);
  assert(a > 0, "找不到 ★ 標記");
  const endTag = "ELSE ARRAY[]::TEXT[] END, 1, c.region";
  const b = fn.indexOf(endTag, a);
  assert(b > a, "找不到 ★ 段結尾");
  return fn.slice(0, a) + ", 1, c.region" + fn.slice(b + endTag.length);
}

Deno.test("A. 拿掉 ★ 段回到前一版（前一版＝20261019120000 的定義）", () => {
  assert(PREV.includes("auto:profile_gap:") && !PREV.includes("ipdb.tw"), "前一版應是 " + PREV_MIG + " 的定義");
  assertEquals(stripStar(NEW), PREV);
});

Deno.test("A. ipdb.tw 只在 profile_gap 那一臂（註解一次、陣列一次）", () => {
  assertEquals(NEW.split("ipdb.tw").length - 1, 2); // 註解一次、陣列一次
  const arm = NEW.slice(NEW.indexOf("'auto:profile_gap:'"), NEW.indexOf("'auto:policy_validity:'"));
  assert(arm.includes("ARRAY['ipdb.tw（政精選"));
  assertEquals(NEW.slice(0, NEW.indexOf("'auto:profile_gap:'")).includes("ipdb.tw"), false);
  assertEquals(NEW.slice(NEW.indexOf("'auto:policy_validity:'")).includes("ipdb.tw"), false);
});

const ex = /(ARRAY\['POST \/functions\/v1\/fetch-cec-data[\s\S]*?)(?:, 1, c\.region)/.exec(NEW);
assert(ex, "找不到 profile_gap 的 hint_sources 運算式");
const EXPR = ex[1].replaceAll("c.eid", "$1::INTEGER").replaceAll("c.election_type", "$2::TEXT");

async function hints(eid: number, type: string): Promise<string[]> {
  const db = new PGlite();
  try {
    const r = await db.query<{ h: string[] }>(`SELECT (${EXPR}) AS h`, [eid, type]);
    return r.rows[0].h;
  } finally {
    await db.close();
  }
}

Deno.test("B. 2026 村里長：原三條之外多一條 ipdb.tw", async () => {
  const h = await hints(2026, "村里長");
  assertEquals(h.length, 4);
  assertEquals(h[3], "ipdb.tw（政精選，2026 候選人照片／號次）");
  assert(h[1].startsWith("所屬機關官網") && h[2] === "ly.gov.tw 立委個人頁");
});

Deno.test("B. 縣市長（2026）與非當屆的村里長：維持原三條，不帶 ipdb.tw", async () => {
  for (const [eid, type] of [[2026, "縣市長"], [2022, "村里長"], [2026, "縣市議員"]] as const) {
    const h = await hints(eid, type);
    assertEquals(h.length, 3, `${eid} ${type}`);
    assertEquals(h.some((x) => x.includes("ipdb")), false);
  }
});

Deno.test("B. 鄉鎮市民代表、直轄市山地原住民區民代表（2026）也帶", async () => {
  for (const type of ["鄉鎮市民代表", "直轄市山地原住民區民代表"]) {
    assertEquals((await hints(2026, type)).length, 4, type);
  }
});
