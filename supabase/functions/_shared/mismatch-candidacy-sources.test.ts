/**
 * 臂 mismatch 20261011380000 ＝ 20261011340000 的版本＋四處替換（多 by_no_candidacy、by_not_elected 兩個來源、kind、說明、LEFT JOIN）。
 * 其他地方被動到就紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const dir = new URL("../../migrations/", import.meta.url);
const fnOf = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_mismatch()"));
const prev = fnOf(await Deno.readTextFile(new URL("20261011340000_mismatch_in_office_future.sql", dir)));
const next = fnOf(await Deno.readTextFile(new URL("20261011380000_mismatch_candidacy_sources.sql", dir)));

function cut(s: string, start: string, end: string): string {
  const a = s.indexOf(start);
  assert(a >= 0, `找不到：${start}`);
  const b = s.indexOf(end, a);
  assert(b >= 0, `找不到：${end}`);
  return s.slice(0, a) + s.slice(b);
}

Deno.test("mismatch 臂：只多兩個來源與對應的 kind、說明", () => {
  let back = next;
  back = cut(back, "  -- 2026-10-14：屆別跟參選紀錄對不上", "  ids AS (");
  back = back.replace(" UNION SELECT id FROM by_no_candidacy UNION SELECT id FROM by_not_elected)", ")");
  back = cut(back, "\n                   WHEN nc.id IS NOT NULL THEN jsonb_build_object", "\n                   ELSE '{}'::jsonb END AS target,");
  back = back.replace("THEN jsonb_build_object('kind', 'in_office_future')\n                   ELSE '{}'::jsonb END AS target,", "THEN jsonb_build_object('kind', 'in_office_future') ELSE '{}'::jsonb END AS target,");
  back = cut(back, "         WHEN nc.id IS NOT NULL THEN\n", "         ELSE\n");
  back = back.replace("\n  LEFT JOIN by_no_candidacy nc ON nc.id = pl.id\n  LEFT JOIN by_not_elected ne ON ne.id = pl.id", "");
  assertEquals(back.trimEnd(), prev.trimEnd());
});

Deno.test("新來源：競選承諾沒有那一屆參選紀錄；任內施政沒有在那一屆當選（已投票）", () => {
  assert(next.includes("pl.status = 'Campaign Pledge'") && next.includes("pe.politician_id = pl.politician_id AND pe.election_id = pl.election_id)"));
  assert(next.includes("e.election_date <= activity_today()") && next.includes("pe.candidacy_status = 'elected')"));
  for (const k of ["pledge_no_candidacy", "in_office_not_elected"]) assert(next.includes(`'kind', '${k}'`));
});
