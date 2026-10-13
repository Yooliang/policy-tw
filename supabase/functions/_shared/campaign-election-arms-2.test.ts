/**
 * 拿掉派工臂寫死的年份（第二批：region_gap、township_gap、roster_villages、term_policies；
 * migration 20261011310000_campaign_election_arms_2.sql，2026-10-13 維護者「A B C」的 A）。
 *
 *   A1. 前一版就是記下的那一支 migration，中間沒有人插一版。
 *   A2. 新定義＝前一版加一串機械式替換，把替換倒回去必須一字不差回到前一版。
 *   A3. 新定義的程式（註解除外）不再有寫死的選舉年份（2026）或民國年（115）。
 *
 * 當屆與年份函式的行為由 campaign-election-arms.test.ts 守；正式庫「今天輸出逐件不變」見 scripts/arms-parity-campaign.ts（不進 CI；PR 說明附結果）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fnText, latestFn, migrationNames, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261011310000_campaign_election_arms_2.sql";
const MIG = await readMig(MIG_NAME);
type Rep = [string, string, number];
const ARMS: [string, string, Rep[]][] = [
  ["contribution_auto_tasks_region_gap", "20261009070000_rep_district_ballot_unit.sql", [
  ["    SELECT g.*,\n           -- 縣市長掛錯層級", "    SELECT g.*,\n           -- 這一屆有中選會登記彙總表（cec_registration_sources）：任務說明指去名冊，原本寫死 election_id = 2026\n           EXISTS (SELECT 1 FROM cec_registration_sources rs WHERE rs.election_id = g.election_id) AS has_registry,\n           -- 縣市長掛錯層級", 1],
  ["WHEN x.election_id = 2026 AND x.candidate_status <> 'not_running'", "WHEN x.has_registry AND x.candidate_status <> 'not_running'", 1],
  ["THEN '2026 的縣市與選區", "THEN election_year_text(x.election_id) || ' 的縣市與選區", 1],
  ["WHEN x.election_id = 2026\n", "WHEN x.has_registry\n", 1],
  ]],
  ["contribution_auto_tasks_township_gap", "20261006220000_candidacy_read_side.sql", [
  ["  WHERE pe.election_id = 2026\n", "  WHERE pe.election_id = (SELECT campaign_election_id())  -- 當屆（原本寫死 2026）\n", 1],
  ]],
  ["contribution_auto_tasks_roster_villages", "20261008170000_roster_villages_batch_text.sql", [
  ["    SELECT * FROM roster_check_scope WHERE election_type = '村里長' AND enabled\n", "    -- roc_year：名冊標題的民國年（原本寫死 115）\n    SELECT sc.*, (EXTRACT(YEAR FROM e.election_date)::INTEGER - 1911) AS roc_year\n      FROM roster_check_scope sc JOIN elections e ON e.id = sc.election_id\n     WHERE sc.election_type = '村里長' AND sc.enabled\n", 1],
  ["    SELECT per.region AS county, per.sub_region AS township, COUNT(*) AS n\n", "    SELECT pe.election_id, per.region AS county, per.sub_region AS township, COUNT(*) AS n\n", 1],
  ["    WHERE pe.election_id = 2026 AND pe.election_type::TEXT = '村里長'\n    GROUP BY 1, 2\n", "    WHERE pe.election_id IN (SELECT s.election_id FROM s) AND pe.election_type::TEXT = '村里長'  -- 清查範圍那幾屆（原本寫死 2026）\n    GROUP BY 1, 2, 3\n", 1],
  ["LEFT JOIN ours o ON o.county = t.county", "LEFT JOIN ours o ON o.election_id = s.election_id AND o.county = t.county", 1],
  ["（中選會「115 年村里長選舉候選人登記彙總表」PDF", "（中選會「' || s.roc_year || ' 年村里長選舉候選人登記彙總表」PDF", 1],
  ["ARRAY['web.cec.gov.tw 115 年村里長選舉候選人登記彙總表'", "ARRAY['web.cec.gov.tw ' || s.roc_year || ' 年村里長選舉候選人登記彙總表'", 1],
  ]],
  ["contribution_auto_tasks_term_policies", "20261011030000_arm_windows_13.sql", [
  ["c.election_id = 2026 AND ce.election_date >= activity_today()", "c.election_id = (SELECT campaign_election_id()) AND ce.election_date >= activity_today()", 1],
  ]],
];

/** 新定義倒推回前一版：每一組替換倒過來做，次數要對 */
function undo(fn: string, reps: Rep[]): string {
  let s = fn;
  for (const [from, to, n] of [...reps].reverse()) {
    assertEquals(s.split(to).length - 1, n, `「${to.slice(0, 40)}」應出現 ${n} 次`);
    s = s.replaceAll(to, from);
  }
  return s;
}
/** 去掉註解（整行與行尾的 --；字串裡沒有 --） */
const code = (fn: string) => fn.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

for (const [arm, prevMig, reps] of ARMS) {
  Deno.test(`A1 ${arm}：前一版是 ${prevMig}，中間沒有人插一版`, async () => {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${arm}(`)) defining.push(n);
    const i = defining.indexOf(MIG_NAME);
    assert(i > 0);
    assertEquals(defining[i - 1], prevMig, "前一版變了：要以最新的為底重做替換");
  });

  Deno.test(`A2 ${arm}：新定義＝前一版加機械式替換，倒回去一字不差`, async () => {
    const prev = await latestFn(arm, MIG_NAME);
    const neu = fnText(MIG, arm);
    const body = (f: string) => f.slice(f.search(/AS \$[a-z]*\$/));
    assertEquals(undo(body(neu), reps), body(prev));
  });

  Deno.test(`A3 ${arm}：程式裡沒有寫死的選舉年份或民國年`, () => {
    const c = code(fnText(MIG, arm));
    assertEquals([...c.matchAll(/\b(2026|115)\b/g)].map((m) => m[0]), [], "年份要從 elections 來");
  });
}
