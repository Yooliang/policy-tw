import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

/**
 * policy-ops#70：驗證池在 SQL、LIMIT 之前排除同代號（以前只有 TS 在取出前 CANDIDATE_POOL 筆之後才濾）。
 * 新定義 = 緊接在前那一版（20261009060000）做固定幾處機械替換，其餘一字不動；沒傳 p_agent_name（NULL）＝行為與前一版相同。
 */
const PREV = "20261009060000_verify_pool_legacy_hash.sql";
const NEXT = "20261010150000_verify_pool_exclude_agent.sql";

async function readSql(name: string): Promise<string> {
  return (await Deno.readTextFile(new URL(`../../migrations/${name}`, import.meta.url))).replace(/\r\n/g, "\n");
}
function poolOf(sql: string): string {
  const a = sql.indexOf("CREATE OR REPLACE FUNCTION contribution_verify_pool");
  assert(a >= 0, "找不到驗證池定義");
  return sql.slice(a, sql.indexOf("\n$$;", a));
}

Deno.test("SQL：新定義 = 緊接在前那一版做固定幾處機械替換，其餘一字不動", async () => {
  const replacements: Array<[string, string]> = [
    ["  p_legacy_ip_hash TEXT DEFAULT NULL\n)", "  p_legacy_ip_hash TEXT DEFAULT NULL,\n  p_agent_name TEXT DEFAULT NULL\n)"],
    [
      "    AND (p_legacy_ip_hash IS NULL OR c.contributor_ip_hash IS DISTINCT FROM p_legacy_ip_hash)\n",
      "    AND (p_legacy_ip_hash IS NULL OR c.contributor_ip_hash IS DISTINCT FROM p_legacy_ip_hash)\n    -- 同代號自己交的也不派給自己（policy-ops#70）：以前只有 TS 在 LIMIT 之後才濾，前段集中同代號時別的網段的同代號機器會拿不到\n    AND (p_agent_name IS NULL OR lower(c.agent_name) <> lower(p_agent_name))\n",
    ],
    [
      "            (o.contributor_ip_hash = p_ip_hash OR o.contributor_ip_hash = p_legacy_ip_hash)\n",
      "            (o.contributor_ip_hash = p_ip_hash OR o.contributor_ip_hash = p_legacy_ip_hash)\n            OR (p_agent_name IS NOT NULL AND lower(o.agent_name) = lower(p_agent_name))\n",
    ],
  ];
  let expected = poolOf(await readSql(PREV));
  for (const [from, to] of replacements) {
    assertEquals(expected.split(from).length - 1, 1, `前一版應恰好有一處：${from.trim()}`);
    expected = expected.replace(from, () => to);
  }
  assertEquals(poolOf(await readSql(NEXT)), expected);
});

Deno.test("SQL：舊的五參數版本要 DROP（否則只傳前幾個參數的 rpc 會同時符合兩個版本）；DROP 在 CREATE 之前；新參數有預設值", async () => {
  const sql = await readSql(NEXT);
  const drop = "DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER, TEXT, TEXT);";
  assertStringIncludes(sql, drop);
  assert(sql.indexOf(drop) < sql.indexOf("CREATE OR REPLACE FUNCTION contribution_verify_pool"));
  assertStringIncludes(sql, "p_agent_name TEXT DEFAULT NULL");
});

Deno.test("接線：/next 與 /verifications 都把代號傳給驗證池", async () => {
  const next = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assertStringIncludes(next, "p_limit: CANDIDATE_POOL, p_agent_name: agentName");
  const ver = await Deno.readTextFile(new URL("../verifications/index.ts", import.meta.url));
  assertStringIncludes(ver, "p_agent_name: agentName");
});
