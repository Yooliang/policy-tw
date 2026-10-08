import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { excludeOwnAdjudications, filterVerifyCandidates, isMySource } from "./dispatch.ts";

/**
 * #482 遺留的過渡期小洞（#484 一併處理）：
 * 來源改看網段（1.79.0）之後，切換前交的貢獻存的是單一 IP 的舊雜湊。投票端（handleVerify）與 /next 的 my_votes 已經新舊都比，
 * 但「驗證池的自交排除」與 excludeOwnAdjudications 的「原貢獻是自己交的」只比新雜湊——
 * 切換前自己交的待驗證貢獻會被派給自己，做完整套查證才在 POST /report 吃到 403 self_vote，白做。
 * 修法：新舊一起比；SQL 照現行定義做機械替換（p_legacy_ip_hash 預設 NULL＝行為與現行相同）。
 */
const NEW = "net-hash";
const OLD = "ip-old-single";

const row = (id: string, contributor: string, extra: Record<string, unknown> = {}) => ({
  id, contribution_type: "policy", payload: {}, agent_name: `someone-${id}`, contributor_ip_hash: contributor,
  agree_count: 0, status: "pending", score: 0, target_score: 3, ...extra,
});

Deno.test("isMySource：新網段雜湊或過渡期舊雜湊都算自己；空值不算", () => {
  assert(isMySource(NEW, { ip_hash: NEW }));
  assert(isMySource(OLD, { ip_hash: NEW, legacy_ip_hash: OLD }));
  assert(!isMySource(OLD, { ip_hash: NEW }), "沒有舊雜湊（IP 認不得）就只比新的");
  assert(!isMySource("other", { ip_hash: NEW, legacy_ip_hash: OLD }));
  assert(!isMySource(null, { ip_hash: NEW, legacy_ip_hash: OLD }));
  assert(!isMySource(undefined, { ip_hash: "", legacy_ip_hash: "" }));
});

Deno.test("filterVerifyCandidates：切換前（舊雜湊）自己交的不派給自己；沒傳舊雜湊時行為不變", () => {
  const rows = [row("a", OLD), row("b", NEW), row("c", "someone-else")];
  const me = { agent_name: "dave", ip_hash: NEW, voted_ids: new Set<string>() };
  assertEquals(filterVerifyCandidates(rows, { ...me, legacy_ip_hash: OLD }).map((r) => r.id), ["c"]);
  assertEquals(filterVerifyCandidates(rows, me).map((r) => r.id), ["a", "c"], "沒傳舊雜湊＝照舊（a 會留下，這就是被修的洞）");
});

Deno.test("excludeOwnAdjudications：原貢獻是切換前（舊雜湊）自己交的 → 這筆裁決不派給自己", () => {
  const adj = (target: string) => ({
    contribution_type: "adjudication", payload: { contribution_id: target },
    id: `adj-${target}`, agent_name: "x", contributor_ip_hash: "y", source_urls: [], status: "pending", agree_count: 0,
  });
  const cands = [adj("A"), adj("B"), adj("C")];
  const originals = [
    { id: "A", agent_name: "other-name", contributor_ip_hash: OLD }, // 切換前我交的
    { id: "B", agent_name: "other-name", contributor_ip_hash: NEW }, // 切換後我交的
    { id: "C", agent_name: "other-name", contributor_ip_hash: "someone-else" },
  ];
  const me = { agent_name: "dave", ip_hash: NEW, voted_ids: new Set<string>() };
  // deno-lint-ignore no-explicit-any
  const kept = (m: any) => excludeOwnAdjudications(cands as any, originals, m).map((c) => (c.payload as Record<string, unknown>).contribution_id);
  assertEquals(kept({ ...me, legacy_ip_hash: OLD }), ["C"]);
  assertEquals(kept(me), ["A", "C"], "沒傳舊雜湊＝只擋新的（A 會漏，這就是被修的洞）");
});

// ── SQL：現行定義＋機械替換 ─────────────────────────────────────────────────

async function readSql(name: string): Promise<string> {
  return (await Deno.readTextFile(new URL(`../../migrations/${name}`, import.meta.url))).replace(/\r\n/g, "\n");
}
function poolOf(sql: string): string {
  const a = sql.indexOf("CREATE OR REPLACE FUNCTION contribution_verify_pool");
  assert(a >= 0, "找不到驗證池定義");
  const b = sql.indexOf("\n$$;", a);
  return sql.slice(a, b);
}

Deno.test("SQL：新定義 = 緊接在前那一版（20261006034900）做固定幾處機械替換，其餘一字不動", async () => {
  const prev = poolOf(await readSql("20261006034900_policy_lineages.sql"));
  const next = poolOf(await readSql("20261009060000_verify_pool_legacy_hash.sql"));
  const replacements: Array<[string, string]> = [
    ["  p_type TEXT DEFAULT NULL\n)", "  p_type TEXT DEFAULT NULL,\n  p_legacy_ip_hash TEXT DEFAULT NULL\n)"],
    [
      "    AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash\n",
      "    AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash\n    -- 過渡期（#484）：切換前自己交的（存單一 IP 的舊雜湊）也不派給自己\n    AND (p_legacy_ip_hash IS NULL OR c.contributor_ip_hash IS DISTINCT FROM p_legacy_ip_hash)\n",
    ],
    ["      WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash\n", "      WHERE v.contribution_id = c.id AND (v.verifier_ip_hash = p_ip_hash OR v.verifier_ip_hash = p_legacy_ip_hash)\n"],
    ["            o.contributor_ip_hash = p_ip_hash\n", "            (o.contributor_ip_hash = p_ip_hash OR o.contributor_ip_hash = p_legacy_ip_hash)\n"],
    ["              WHERE v2.contribution_id = o.id AND v2.verifier_ip_hash = p_ip_hash\n", "              WHERE v2.contribution_id = o.id AND (v2.verifier_ip_hash = p_ip_hash OR v2.verifier_ip_hash = p_legacy_ip_hash)\n"],
  ];
  let expected = prev;
  for (const [from, to] of replacements) {
    assertEquals(expected.split(from).length - 1, 1, `前一版應恰好有一處：${from.trim()}`);
    expected = expected.replace(from, () => to);
  }
  assertEquals(next, expected);
});

Deno.test("SQL：舊的四參數版本要 DROP（否則只傳 p_ip_hash 的 rpc 會同時符合兩個版本）；新參數有預設值", async () => {
  const sql = await readSql("20261009060000_verify_pool_legacy_hash.sql");
  assertStringIncludes(sql, "DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER, TEXT);");
  assert(sql.indexOf("DROP FUNCTION IF EXISTS contribution_verify_pool") < sql.indexOf("CREATE OR REPLACE FUNCTION contribution_verify_pool"));
  assertStringIncludes(sql, "p_legacy_ip_hash TEXT DEFAULT NULL");
});

// /next 把舊雜湊傳進驗證池的接線，改在 dispatch-token-entry.test.ts 用真的 /next 入口驗行為
