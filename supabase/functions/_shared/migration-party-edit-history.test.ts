// 20261018020000：補政黨的觸發器函式要寫 edit_history。文字層守門：新版本體＝舊版（20261006073461）加上 edit_history 那段，其他一字不動。
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const read = (n: string) => Deno.readTextFile(new URL(`../../migrations/${n}`, import.meta.url)).then((t) => t.replace(/\r/g, ""));
const NEW_FILE = "20261018020000_party_from_candidacy_edit_history.sql";

function bodyOf(sql: string, fn: string): string {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION ${fn}(`);
  assert(i >= 0, `找不到 ${fn}`);
  const rest = sql.slice(i);
  const start = rest.indexOf("$$;") >= 0 ? rest.indexOf("AS $$") + "AS $$".length : -1;
  const end = rest.indexOf("\n$$;");
  assert(start > 0 && end > start, `${fn} 的本體切不出來`);
  return rest.slice(start, end);
}

const ADDED_DECLARE = "  v_old_party BIGINT;\n  v_old_basis TEXT;\n";
const ADDED_SELECT = "  SELECT pe.party_id, pe.party_basis INTO v_old_party, v_old_basis FROM politician_elections pe WHERE pe.id = v_pe;\n";

function stripAdded(body: string): string {
  const i = body.indexOf("  IF v_n > 0 THEN\n");
  const j = body.indexOf("  RETURN v_n;");
  assert(i >= 0 && j > i, "找不到 edit_history 那一段");
  return (body.slice(0, i) + body.slice(j)).replace(ADDED_DECLARE, "").replace(ADDED_SELECT, "");
}

Deno.test("補政黨函式：新版本體＝舊版加上 edit_history 那段，其他一字不動", async () => {
  const oldBody = bodyOf(await read("20261006073461_parties.sql"), "politician_election_party_from_candidacy");
  const newBody = bodyOf(await read(NEW_FILE), "politician_election_party_from_candidacy");
  assertEquals(stripAdded(newBody), oldBody);
});

Deno.test("補政黨函式：party_id、party_basis 有變的欄位各寫一筆 edit_history，帶 contribution_id 與 agent_name", async () => {
  const body = bodyOf(await read(NEW_FILE), "politician_election_party_from_candidacy");
  assertStringIncludes(body, "IF v_old_party IS DISTINCT FROM v_alias.party_id THEN");
  assertStringIncludes(body, "IF v_old_basis IS DISTINCT FROM 'contribution' THEN");
  assertStringIncludes(body, "VALUES ('politician_elections', v_pe::TEXT, 'party_id', to_jsonb(v_old_party), to_jsonb(v_alias.party_id), p_contribution_id, p_agent_name)");
  assertStringIncludes(body, "VALUES ('politician_elections', v_pe::TEXT, 'party_basis', to_jsonb(v_old_basis), to_jsonb('contribution'::TEXT), p_contribution_id, p_agent_name)");
  // 只在 UPDATE 真的改到列時才寫
  assert(body.indexOf("GET DIAGNOSTICS v_n = ROW_COUNT;") < body.indexOf("IF v_n > 0 THEN"));
});

Deno.test("補政黨函式：觸發器改叫四參數版、舊的兩參數版 DROP、新版收回公開執行權", async () => {
  const sql = await read(NEW_FILE);
  assertStringIncludes(bodyOf(sql, "contribution_applied_candidacy_party"), "politician_election_party_from_candidacy(NEW.applied_politician_id, NEW.payload, NEW.id, NEW.agent_name)");
  assertStringIncludes(sql, "DROP FUNCTION IF EXISTS politician_election_party_from_candidacy(UUID, JSONB);");
  assertStringIncludes(sql, "REVOKE EXECUTE ON FUNCTION politician_election_party_from_candidacy(UUID, JSONB, UUID, TEXT) FROM PUBLIC, anon, authenticated;");
});

Deno.test("補政黨函式：之後的 migration 不能再用兩參數呼叫（舊簽名已刪）", async () => {
  const names: string[] = [];
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) if (e.name.endsWith(".sql") && e.name > NEW_FILE) names.push(e.name);
  for (const n of names) {
    const sql = await read(n);
    assert(!/politician_election_party_from_candidacy\(\s*[^,()]+,\s*[^,()]+\)/.test(sql), `${n} 用兩參數呼叫補政黨函式`);
  }
});
