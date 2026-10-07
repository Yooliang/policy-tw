/**
 * term_policy_missing 改成設定表驅動（2026-10-07，#332 選前必補第 2 項；migration 20261007225000）。
 *
 * 之前 contribution_auto_tasks_term_policies() 把 (2022：縣市長／縣市議員／鄉鎮市長)、(2024：立委) 與公報入口的說明字面寫死在函式裡，
 * 2026 與之後的屆別每次都要改函式。現在屆別、職位、公報民國年、有沒有開都在表 election_task_config。
 *
 * 守門的核心是「部署前後派工清單差集為空」：正式庫唯讀快照灌 PGlite、舊函式與新函式逐件比對
 * （scripts/term-policy-parity.ts，要網路與快照，不進 CI；結果見 PR 說明）。這支測試是 CI 裡的那一半，只用 --allow-read：
 *   1. 種子逐字等於舊函式原文（職位、兩段公報入口、結尾句、公報年）——不靠記憶抄、直接從 20261006220000 切出來比
 *   2. 新函式＝舊函式加上四處機械替換，其餘一字不差（說明文字、去重、村里長限量、task_id 都沒被順手動到）
 *   3. 2026 那一列預設關著；設定表的結構、RLS、職位白名單
 *   4. 函式裡不再有寫死的 2022／2024
 *   5. 協議與派工指引裡「2026 的新政見不是這一屆」的點名字樣改成不點名屆別（開啟 2026 之後這句才不會自相矛盾）
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { TASK_GUIDANCE } from "./task-guidance.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const OLD_SQL = await read("20261006220000_candidacy_read_side.sql");
const NEW_SQL = await read("20261007225000_election_task_config.sql");
const FN = "CREATE OR REPLACE FUNCTION contribution_auto_tasks_term_policies()";
const fnText = (sql: string) => {
  const a = sql.indexOf(FN);
  assert(a >= 0, "找不到函式定義");
  return sql.slice(a, sql.indexOf("$$;", a) + 3);
};
const OLD_FN = fnText(OLD_SQL);
const NEW_FN = fnText(NEW_SQL);
/** 只看 SQL 本體：去掉 -- 註解 */
const code = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// 舊函式原文裡的三段字面
const HINT_2022 = OLD_FN.match(/WHEN x\.election_id = 2022 THEN\n\s+ARRAY\[('https:\/\/eebulletin[^\n]*?'),\n/)?.[1];
const HINT_2024 = OLD_FN.match(/ELSE\n\s+ARRAY\[('https:\/\/bulletin\.cec\.gov\.tw[^\n]*?'),\n/)?.[1];
const SCOPE = "任內才宣布的施政、2026 的新政見不是這一屆的競選政見。";
const POS_2022 = OLD_FN.match(/pe\.election_id = 2022 AND pe\.election_type IN \(([^)]*)\)/)?.[1];
const POS_2024 = OLD_FN.match(/pe\.election_id = 2024 AND pe\.election_type = ('[^']*')/)?.[1];

Deno.test("舊函式原文裡的字面都抓得到（這支測試的前提）", () => {
  assert(HINT_2022 && HINT_2024 && POS_2022 && POS_2024, "舊函式原文的結構變了，這支測試要跟著看");
  assertStringIncludes(OLD_FN, SCOPE);
  assertEquals(POS_2022, "'縣市長', '縣市議員', '鄉鎮市長'");
  assertEquals(POS_2024, "'立法委員'");
});

Deno.test("種子：2022、2024 逐字等於舊函式原文——職位、公報入口、結尾句、公報年、開著", () => {
  const sql = code(NEW_SQL);
  const row = (id: number) => {
    const a = sql.indexOf(`(${id}, ARRAY[`);
    assert(a >= 0, `種子沒有 ${id} 那一列`);
    return sql.slice(a, sql.indexOf("\n  (", a + 5) > 0 ? sql.indexOf("\n  (", a + 5) : sql.indexOf("ON CONFLICT", a));
  };
  const r22 = row(2022), r24 = row(2024);
  assertStringIncludes(r22, `(2022, ARRAY[${POS_2022}], 111,`);
  assertStringIncludes(r22, HINT_2022!);
  assertStringIncludes(r22, `'${SCOPE}', true,`);
  assertStringIncludes(r24, `(2024, ARRAY[${POS_2024}], 113,`);
  assertStringIncludes(r24, HINT_2024!);
  assertStringIncludes(r24, `'${SCOPE}', true,`);
  // 舊函式只有這兩個字面、這兩屆：種子沒多出別的啟用中的列
  assertEquals((sql.match(/, true,\n/g) ?? []).length, 2, "啟用中的種子只有 2022、2024 兩列");
});

Deno.test("種子：2026 一列、預設關著，等 11-29 由 migration 或主線開啟；用通用文案（bulletin_hint、scope_note 空）", () => {
  const sql = code(NEW_SQL);
  assertStringIncludes(sql, "(2026, ARRAY['縣市長', '縣市議員', '鄉鎮市長'], 115, NULL, NULL, false,");
  assertStringIncludes(NEW_SQL, "UPDATE election_task_config SET enabled = true, updated_at = now() WHERE election_id = 2026");
  assertStringIncludes(sql, "ON CONFLICT (election_id) DO NOTHING");
});

Deno.test("新函式＝舊函式加四處機械替換，其餘一字不差（說明文字、去重、村里長限量、task_id 都沒被順手動到）", () => {
  let expected = OLD_FN;
  const rep = (a: string, b: string) => {
    assertEquals(expected.split(a).length - 1, 1, `舊函式裡 ${a.slice(0, 50)} 要剛好一處`);
    expected = expected.replace(a, () => b);
  };
  rep(
    `      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE p.merged_into IS NULL
       AND pe.candidacy_status = 'elected'
       AND ((pe.election_id = 2022 AND pe.election_type IN ('縣市長', '縣市議員', '鄉鎮市長'))
            OR (pe.election_id = 2024 AND pe.election_type = '立法委員'))
`,
    `      LEFT JOIN regions r ON r.id = pe.region_id
      JOIN election_task_config cfg ON cfg.election_id = pe.election_id AND cfg.enabled AND pe.election_type = ANY (cfg.positions)
     WHERE p.merged_into IS NULL
       AND pe.candidacy_status = 'elected'
`,
  );
  rep(
    `      FROM pb b
     ORDER BY b.politician_id, b.election_id, (b.election_type = '村里長'), b.election_type`,
    `      FROM pb b
      JOIN election_task_config cfg ON cfg.election_id = b.election_id AND cfg.enabled
     ORDER BY b.politician_id, b.election_id, (b.election_type = '村里長'), b.election_type`,
  );
  rep(`         1, x.region
    FROM picked x
$$;`, `         1, x.region
    FROM picked x
    JOIN election_task_config cfgx ON cfgx.election_id = x.election_id
$$;`);
  // hint_sources：2022／2024 兩段字面 → 一段讀設定表
  const i0 = expected.indexOf("         WHEN x.election_id = 2022 THEN");
  const i1 = expected.indexOf("         END,\n         1, x.region");
  assert(i0 > 0 && i1 > i0);
  const newTail = NEW_FN.slice(NEW_FN.indexOf("         ELSE\n           ARRAY[COALESCE(cfgx.bulletin_hint,"), NEW_FN.indexOf("         END,\n         1, x.region"));
  assert(newTail.startsWith("         ELSE"), "新函式的 hint_sources 尾段找不到");
  expected = expected.slice(0, i0) + newTail + expected.slice(i1);
  rep(
    `別人交了還在等票的不要再交；任內才宣布的施政、2026 的新政見不是這一屆的競選政見。',`,
    `別人交了還在等票的不要再交；' || COALESCE(cfgx.scope_note, '任內才宣布的施政、之後新提出的政見不是這一屆的競選政見。'),`,
  );
  assertEquals(NEW_FN, expected);
  // 那段 hint_sources 尾巴本身：只有第一條讀設定表，後三條與舊的一字不差
  for (const tailItem of ["'候選人當年的官網／臉書競選政見頁',", "'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見，用搜尋引擎找「姓名 READr」）',", "'cna.com.tw']"]) {
    assertStringIncludes(newTail, tailItem);
  }
});

Deno.test("新函式裡不再有寫死的 2022／2024 與公報入口；剩下的 2026 只有去重那一條（零政見的 2026 候選人留給 policy_missing）", () => {
  const body = code(NEW_FN);
  assert(!/\b2022\b/.test(body), "不能再寫死 2022");
  assert(!/\b2024\b/.test(body), "不能再寫死 2024");
  assert(!body.includes("dir=111") && !body.includes("113%E5"), "公報入口要在設定表，不在函式裡");
  const lines2026 = body.split("\n").filter((l) => /\b2026\b/.test(l));
  assertEquals(lines2026.length, 1, `只剩去重那一行：${lines2026.join(" | ")}`);
  assertStringIncludes(lines2026[0], "c.election_id = 2026 AND c.candidacy_status IS DISTINCT FROM 'withdrawn'");
  assertEquals(NEW_FN.split("election_task_config").length - 1, 3, "三處讀設定表：當選人、公報、說明與入口");
});

Deno.test("設定表：主鍵＝選舉 id（外鍵到 elections）、職位白名單＝九種、預設關著、開 RLS（公開讀、只有 service_role 寫）", () => {
  const sql = code(NEW_SQL).replace(/\s+/g, " ");
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS election_task_config (");
  assertStringIncludes(sql, "election_id INTEGER PRIMARY KEY REFERENCES elections(id)");
  assertStringIncludes(sql, "enabled BOOLEAN NOT NULL DEFAULT false");
  assertStringIncludes(sql, "bulletin_roc_year INTEGER NOT NULL");
  assertStringIncludes(sql, "bulletin_hint TEXT,");
  assertStringIncludes(sql, "scope_note TEXT,");
  for (const t of ["總統副總統", "立法委員", "縣市長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區長", "鄉鎮市民代表", "直轄市山地原住民區民代表", "村里長"]) {
    assertStringIncludes(sql, `'${t}'`, `職位白名單少了 ${t}`);
  }
  assertStringIncludes(sql, "CONSTRAINT election_task_config_positions_known CHECK ( positions <@ ARRAY[");
  assertStringIncludes(sql, "ALTER TABLE election_task_config ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(sql, 'CREATE POLICY "Public read" ON election_task_config FOR SELECT USING (true)');
  assertStringIncludes(sql, `CREATE POLICY "Service role write" ON election_task_config FOR ALL USING (auth.role() = 'service_role')`);
});

Deno.test("只加不刪：函式簽名不變（派工總表 contribution_auto_tasks_arms 不用重寫），沒有 DROP", () => {
  assertStringIncludes(NEW_FN, "RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)");
  assert(!/\bDROP\s+(TABLE|FUNCTION|VIEW|COLUMN)\b/i.test(code(NEW_SQL)));
  assert(!NEW_SQL.includes("FUNCTION contribution_auto_tasks_arms"), "不重寫派工總表（同時有別的 PR 在改）");
});

Deno.test("協議與派工指引：「2026 的新政見不是這一屆」改成不點名屆別（開啟 2026 之後不會自相矛盾）", async () => {
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assert(!skill.includes("2026 的新政見"), "skill.md 不能再點名 2026 的新政見");
  assertStringIncludes(skill, "任內才宣布的施政、其他屆別的政見不是這個任務要的");
  assert(!TASK_GUIDANCE.term_policy_missing.includes("2026 的新政見"));
  assertStringIncludes(TASK_GUIDANCE.term_policy_missing, "任內才宣布的施政、其他屆別的政見不是這一屆的競選政見");
  const [major, minor] = PROTOCOL_VERSION.split(".").map(Number);
  assert(major > 1 || (major === 1 && minor >= 71), `協議版號 ${PROTOCOL_VERSION} 要 ≥ 1.71.0（skill.md 改了文字）`);
});
