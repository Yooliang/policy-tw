/**
 * 政黨資訊派工（party_info_missing）只派網站上有人用到的政黨（維護者 10-06；migration 20261007010000）的守門。
 *
 * 行為在 PGlite 上灌假資料實跑過（見 PR 說明：改前 8 件、改後 4 件，被併走的人掛的、沒人掛的都不派）；
 * 這支守住「改壞了不會報錯」的事：三種缺口每一種都要過「用到」這一關，而且除了這幾行篩選，派工臂跟上一版一字不差。
 * 還原驗證：拿掉任何一條 `IN (SELECT party_id FROM used)` 或 used 的「沒被併走」條件，對應那條轉紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const THIS = "20261007010000_party_info_used_only.sql";
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const mine = lf(await Deno.readTextFile(new URL(THIS, MIGRATIONS)));

function definitionIn(text: string, fn: string): string | null {
  const start = text.lastIndexOf(`CREATE OR REPLACE FUNCTION ${fn}(`);
  if (start < 0) return null;
  const tag = /AS\s+(\$[A-Za-z_]*\$)/.exec(text.slice(start));
  assert(tag);
  const bodyStart = start + tag.index + tag[0].length;
  const end = text.indexOf(tag[1], bodyStart);
  return text.slice(start, text.indexOf(";", end) + 1);
}

async function previousDefinition(fn: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql") && e.name < THIS) names.push(e.name);
  names.sort().reverse();
  for (const n of names) {
    const d = definitionIn(lf(await Deno.readTextFile(new URL(n, MIGRATIONS))), fn);
    if (d) return d;
  }
  throw new Error(fn);
}

const FN = "contribution_auto_tasks_party_info";
const now = definitionIn(mine, FN);
assert(now, "新 migration 要有這支函式");

Deno.test("三種缺口（改名、名冊外、解散廢止）每一種都要過「用到」這一關", () => {
  const gaps = now.slice(now.indexOf("gaps AS ("), now.indexOf("SELECT 'auto:party_info_missing:'"));
  const arms = gaps.split("UNION ALL");
  assertEquals(arms.length, 3);
  assert(/n\.id IN \(SELECT party_id FROM used\) OR o\.id IN \(SELECT party_id FROM used\)/.test(arms[0]), "rename：新舊任何一端有人用到就派");
  assert(arms[1].includes("p.id IN (SELECT party_id FROM used)"), "off_registry 沒過用到");
  assert(arms[2].includes("p.id IN (SELECT party_id FROM used)"), "dissolved 沒過用到");
});

Deno.test("「用到」＝沒被併走的人現在掛的、或他某一次參選掛的；被併走的人不算", () => {
  const used = now.slice(now.indexOf("WITH used AS ("), now.indexOf("queued AS ("));
  assert(used.includes("FROM politicians p WHERE p.party_id IS NOT NULL AND p.merged_into IS NULL"));
  assert(used.includes("FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id"));
  assert(/pe\.party_id IS NOT NULL AND p\.merged_into IS NULL/.test(used));
});

Deno.test("除了「用到」的篩選，派工臂跟上一版一字不差（任務編號、說明、提示來源、等票先不派都沒動）", async () => {
  const prev = await previousDefinition(FN);
  const back = now
    .replace(/  WITH used AS \([\s\S]*?\n  \),\n  queued AS \(/, "  WITH queued AS (")
    .replace(/\n\s+AND p\.id IN \(SELECT party_id FROM used\)/g, "")
    .replace("WHERE (n.valid_from IS NULL OR o.valid_to IS NULL)\n       AND (n.id IN (SELECT party_id FROM used) OR o.id IN (SELECT party_id FROM used))", "WHERE n.valid_from IS NULL OR o.valid_to IS NULL")
    .replace("；新舊任何一端有人用到就派", "");
  assertEquals(back, prev);
});
