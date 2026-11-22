/**
 * 守門：政見性質 pledge_kind（2026-11-22 維護者裁示，協議 1.142.0）。
 * 公報政見欄上的口號型政見也要交，標成 principle（原則宣示）；沒標＝specific（具體承諾）。
 * 日本站 policy_jp 不跟。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { validateContributionRequest } from "./contribution-schema.ts";
import { checkPolicyLikeness, policyLikenessNotice } from "./policy-likeness.ts";
import { POLICY_PLEDGE_KINDS } from "./lineage.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { readSkillWithTypes } from "./skill-text.ts";
import { buildPolicyAsk } from "./system-one.ts";

const CEC = "https://eebulletin.cec.gov.tw/";
const SLOGAN = { title: "熱心服務、實在做事", description: "熱心服務、實在做事（選舉公報政見欄原文）" };

const policy = (extra: Record<string, unknown>) => validateContributionRequest({
  agent_name: "tester",
  contribution_type: "policy",
  payload: {
    name: "王小明", election_id: 2022, category: "政府治理與公共參與", ...SLOGAN, ...extra,
  },
  source_urls: [CEC],
});

const ver = (v: string) => v.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0);

Deno.test("pledge_kind：只收 specific／principle，缺＝合法", () => {
  assertEquals([...POLICY_PLEDGE_KINDS], ["specific", "principle"]);
  assertEquals(policy({}).errors.some((e) => e.path === "payload.pledge_kind"), false);
  assertEquals(policy({ pledge_kind: "specific" }).errors.some((e) => e.path === "payload.pledge_kind"), false);
  assertEquals(policy({ pledge_kind: "principle" }).errors.some((e) => e.path === "payload.pledge_kind"), false);
});

Deno.test("pledge_kind：非法值被擋（400 的來源）", () => {
  for (const bad of ["slogan", "", "Principle", 1, null, true]) {
    const r = policy({ pledge_kind: bad });
    assertEquals(r.ok, false, `${String(bad)} 該被擋`);
    assert(r.errors.some((e) => e.path === "payload.pledge_kind"), `${String(bad)}：缺 payload.pledge_kind 的錯`);
  }
});

Deno.test("correction：政見的 pledge_kind 可改、值要合法", () => {
  const mk = (v: unknown) => validateContributionRequest({
    agent_name: "tester",
    contribution_type: "correction",
    payload: {
      target_table: "policies", target_id: "00000000-0000-4000-8000-000000000001",
      changes: [{ field: "pledge_kind", current_value: "specific", correct_value: v }],
      reason: "公報上這條只有口號，沒有具體做法，性質應為原則宣示。",
    },
    source_urls: [CEC],
  });
  assertEquals(mk("principle").ok, true, JSON.stringify(mk("principle").errors));
  assertEquals(mk("bogus").ok, false);
});

Deno.test("口號型政見標成 principle：不再被標「疑似不是政見」；沒標照舊標", () => {
  assert(checkPolicyLikeness(SLOGAN.title, SLOGAN.description).suspect);
  assertEquals(checkPolicyLikeness(SLOGAN.title, SLOGAN.description, "principle").suspect, false);
  assertEquals(policyLikenessNotice(SLOGAN.title, SLOGAN.description, "principle"), null);
  assert((policyLikenessNotice(SLOGAN.title, SLOGAN.description, "specific") ?? "").includes("疑似不是政見"));
});

Deno.test("Jev：principle 的政見把性質帶進題目、題目講明口號算政見；一般政見的 state 不變", () => {
  const principle = buildPolicyAsk({ id: "a", title: SLOGAN.title, description: SLOGAN.description, election_id: 2022, pledge_kind: "principle" }, [], []);
  assertEquals((principle.state.target as Record<string, unknown>).pledge_kind, "principle");
  assertStringIncludes(principle.questions.is_policy.instructions, "principle");
  const plain = buildPolicyAsk({ id: "b", title: "新生兒補助10萬元", description: "每名新生兒發放生育補助 10 萬元。", election_id: 2022 }, [], []);
  assertEquals("pledge_kind" in (plain.state.target as Record<string, unknown>), false);
});

Deno.test("落庫：交件有給 pledge_kind 才寫進 policies，沒給交給資料庫預設", async () => {
  const apply = await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url));
  assertStringIncludes(apply, "...(str(p.pledge_kind) ? { pledge_kind: str(p.pledge_kind) } : {})");
});

Deno.test("migration：policies.pledge_kind NOT NULL DEFAULT specific＋CHECK 兩值＋有中文註解", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  let sql = "";
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.endsWith(".sql")) continue;
    const t = await Deno.readTextFile(new URL(e.name, dir));
    if (t.includes("ADD COLUMN IF NOT EXISTS pledge_kind")) sql = t;
  }
  assert(sql, "找不到加 pledge_kind 欄位的 migration");
  assertStringIncludes(sql, "pledge_kind text NOT NULL DEFAULT 'specific'");
  assertStringIncludes(sql, "CHECK (pledge_kind IN ('specific', 'principle'))");
  assertStringIncludes(sql, "COMMENT ON COLUMN public.policies.pledge_kind");
});

Deno.test("協議：1.142.0 起公報口號型政見要交（標 principle），舊的「沒有具體內容不交」說法已移除", async () => {
  assert(ver(PROTOCOL_VERSION) >= ver("1.142.0"));
  const text = await readSkillWithTypes();
  assertStringIncludes(text, "pledge_kind");
  assertStringIncludes(text, "原則宣示");
  assertStringIncludes(text, "公報政見欄的內容一律要交");
  assert(!text.includes("這種沒有具體內容的不交"), "舊規則字樣還在");
  assert(!text.includes("確實是空白或只有口號，才回"), "舊的查無條件還在");
});
