/**
 * #346 後續兩項（主線 10-06 裁定；migration 20261006100100、協議 1.56.0）的守門測試：
 *   1. 參選紀錄政黨缺口：cec-sync 把中選會名冊的推薦政黨存進 cec_candidates.party；新臂 contribution_auto_tasks_party_gap
 *      派「我們缺政黨、中選會有」的參選紀錄給代理照名冊補；中選會自動核對（cec-verify）多比推薦政黨（不新增計分規則）
 *   2. 政黨資訊交件型別 party_info：改名（前身、名稱起訖）、解散日、名冊外政黨的對應，附出處、驗證上線
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { applyContribution } from "./apply-contribution.ts";
import { precheckApplyTargets } from "./apply-precheck.ts";
import { cecPartyText, toCecCandidateRow } from "./cec-sync.ts";
import { decideByCec } from "./cec-verify.ts";
import type { CecCandidacy } from "./cec-candidate.ts";
import { CONTRIBUTION_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import { summarizeContribution } from "./contribution-summary.ts";
import { partyAliasKey, partyResolver, sameParty } from "./party-alias.ts";
import { missingAncestors, partyInfoProblems, type PartyRow, planPartyInfo } from "./party-info.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { isPartyGapTask, PARTY_GAP_HINT, PARTY_INFO_VERIFY_HINT, shapeTaskCurrent, shapeVerifyCurrent } from "./task-context.ts";
import { buildReportTemplate } from "./task-guidance.ts";
import { VOTE_DIMENSIONS } from "./vote-budget.ts";
import { partyAliasKey as frontendPartyAliasKey } from "../../../lib/parties.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const THIS = "20261006100100_party_followups.sql";
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sql = lf(await Deno.readTextFile(new URL(THIS, MIGRATIONS)));
type Row = Record<string, unknown>;

function definitionIn(text: string, marker: string): string | null {
  const start = text.lastIndexOf(marker);
  if (start < 0) return null;
  const tag = /AS\s+(\$[A-Za-z_]*\$)/.exec(text.slice(start));
  assert(tag, `${marker} 找不到 dollar quote`);
  const bodyStart = start + tag.index + tag[0].length;
  const end = text.indexOf(tag[1], bodyStart);
  return text.slice(start, text.indexOf(";", end) + 1);
}
async function previousDefinition(marker: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql") && e.name < THIS) names.push(e.name);
  names.sort().reverse();
  for (const name of names) {
    const def = definitionIn(lf(await Deno.readTextFile(new URL(name, MIGRATIONS))), marker);
    if (def) return def;
  }
  throw new Error(`這支之前沒有 migration 定義 ${marker}`);
}
const ours = (marker: string) => { const d = definitionIn(sql, marker); assert(d, `${THIS} 沒有 ${marker}`); return d!; };

// ── 1a. 中選會名冊的推薦政黨 ───────────────────────────────────────────
Deno.test("cec_candidates 加 party 欄位（只加不刪）；cec-sync 寫進名冊原字，罕見字解回、空的寫 null", () => {
  assert(sql.includes("ALTER TABLE cec_candidates ADD COLUMN IF NOT EXISTS party TEXT;"));
  assertEquals(/DROP COLUMN|ALTER COLUMN .* TYPE/.test(sql), false, "這支不刪、不改既有欄位");
  const ctx = { electionId: 2022, ourType: "縣市議員", cecType: "CountyCouncilMember", themeId: "t1", requestedRegion: "彰化縣" };
  const base = { cand_id: 1, cand_name: "王小明", prv_code: "10", city_code: "007", area_name: "彰化縣第01選舉區" };
  assertEquals(toCecCandidateRow({ ...base, party_name: "無黨籍及未經政黨推薦" }, undefined, ctx)?.party, "無黨籍及未經政黨推薦");
  assertEquals(toCecCandidateRow({ ...base }, { cand_id: 1, party_name: "民主進步黨" }, ctx)?.party, "民主進步黨", "候選人檔沒有就用得票檔的");
  assertEquals(toCecCandidateRow({ ...base, party_name: "  " }, undefined, ctx)?.party, null);
  assertEquals(cecPartyText("台灣@2C9F7@黨"), "台灣\u{2C9F7}黨");
});

Deno.test("party_alias_gaps 多看中選會名冊那一份，原本兩份照舊", async () => {
  const view = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW party_alias_gaps"), sql.indexOf("COMMENT ON VIEW party_alias_gaps"));
  assert(view.includes("FROM cec_candidates c") && view.includes("'cec_candidates'"));
  const prev = lf(await Deno.readTextFile(new URL("20261006073461_parties.sql", MIGRATIONS)));
  const prevView = prev.slice(prev.indexOf("CREATE OR REPLACE VIEW party_alias_gaps"), prev.indexOf("COMMENT ON VIEW party_alias_gaps"));
  for (const part of ["FROM politicians p WHERE p.merged_into IS NULL GROUP BY p.party", "WHERE c.contribution_type = 'candidacy' AND c.status = 'applied' AND party_alias_key(c.payload ->> 'party') IS NOT NULL",
    "WHERE NOT EXISTS (SELECT 1 FROM party_aliases a WHERE a.alias_key = party_alias_key(t.party_text))"]) {
    assert(prevView.includes(part) && view.includes(part), part);
  }
  assert(sql.includes("ALTER VIEW party_alias_gaps SET (security_invoker = on);"));
});

// ── 1b. 派工臂 ──────────────────────────────────────────────────
const arm = ours("CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_gap()");

Deno.test("新臂只派已投票屆別、我們缺政黨、中選會同名唯一而且寫法對得到的；已合併的人不派", () => {
  assert(arm.includes("WHERE pe.party_basis IS NULL"));
  assert(arm.includes("JOIN elections e ON e.id = pe.election_id AND e.election_date < CURRENT_DATE"));
  assert(arm.includes("JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL"));
  assert(/x\.name_norm = cec_name_key\(g\.name\)/.test(arm), "姓名用 cec_name_key（原住民姓名的拼音要去掉才對得上）");
  assert(arm.includes(") c ON c.n = 1"), "同名多位不派");
  assert(/\n\s+JOIN party_aliases a ON a\.alias_key = party_alias_key\(c\.party\)\n/.test(arm), "寫法對不到的不派（看 party_alias_gaps）：要是內連結");
  assertEquals(/(LEFT|FULL|RIGHT)\s+JOIN party_aliases/.test(arm), false, "外連結會把對不到的寫法也派出去，代理照抄了也落不了庫");
  assert(/c\.status IN \('pending', 'verified'\)/.test(arm), "等票中的不派");
});

Deno.test("沿用 candidacy_source_missing，task_id 多一段 party，不跟補縣市／補選區撞號；說明叫代理照名冊填、不要填現在的政黨", () => {
  const prefixes = [...arm.matchAll(/'auto:([a-z_]+):/g)].map((m) => m[1]);
  assertEquals([...new Set(prefixes)], ["candidacy_source_missing"]);
  assert(/SELECT 'auto:candidacy_source_missing:party:' \|\| x\.pe_id,\s*'candidacy_source_missing'/.test(arm));
  assert(arm.includes("'kind', 'party'") && arm.includes("'missing', jsonb_build_array('party')"));
  assert(arm.includes("（不要填他現在的政黨）"));
  // 縣市議員交件沒帶選舉區會被退回：地區欄位要給選舉區
  assert(arm.includes("WHEN m.election_type IN ('縣市議員', '立法委員')\n               THEN jsonb_build_object('region', m.county, 'electoral_district', m.cec_sub_region)"));
});

Deno.test("派工臂有接進 contribution_auto_tasks_arms，其餘每一支照上一版", async () => {
  const prev = await previousDefinition("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()");
  const now = ours("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()");
  const line = "  UNION ALL SELECT * FROM contribution_auto_tasks_party_gap()\n";
  assert(now.includes(line));
  assertEquals(now.replace(line, ""), prev);
});

// ── 1. 中選會自動核對多比推薦政黨 ──────────────────────────────────────
const ALIASES = partyResolver([
  { alias_key: "中國國民黨", party_id: 1, kind: "name" }, { alias_key: "國民黨", party_id: 1, kind: "short" },
  { alias_key: "民主進步黨", party_id: 16, kind: "name" },
  { alias_key: "無黨籍", party_id: null, kind: "independent" }, { alias_key: "無黨籍及未經政黨推薦", party_id: null, kind: "independent" },
]);
const cecRow = (party: string | null, result: "elected" | "not_elected" = "elected"): CecCandidacy => ({
  theme_id: "t", cand_id: 1, name: "王小明", election_name: "111年直轄市議員選舉", vote_date: "2022-11-26", election_id: 2022,
  birth_year: 1970, party, election_result: result, area: "臺中市第01選舉區", votes_received: null, vote_percentage: null,
});
const claim = (payload: Row) => ({ contribution_type: "candidacy", payload: { name: "王小明", election_id: 2022, ...payload }, politician: { name: "王小明", region: "台中市" } });

Deno.test("cec-verify：推薦政黨對得上（寫法不同照對照表）算一個可查欄位；對不上退件；對照表沒有的不比", () => {
  const ok = decideByCec(claim({ election_result: "elected", party: "國民黨" }), [cecRow("中國國民黨")], ALIASES);
  assertEquals(ok.action, "apply");
  assertEquals(ok.action === "apply" && ok.matched, ["election_result", "party"]);
  const indep = decideByCec(claim({ party: "無黨籍" }), [cecRow("無黨籍及未經政黨推薦")], ALIASES);
  assertEquals(indep.action === "apply" && indep.matched, ["party"], "只交政黨也查得到");
  const bad = decideByCec(claim({ election_result: "elected", party: "民主進步黨" }), [cecRow("中國國民黨")], ALIASES);
  assertEquals(bad.action, "reject");
  assertStringIncludes(bad.action === "reject" ? bad.reason : "", "推薦政黨對不上");
  const unknown = decideByCec(claim({ election_result: "elected", party: "某某新黨" }), [cecRow("中國國民黨")], ALIASES);
  assertEquals(unknown.action === "apply" && unknown.matched, ["election_result"], "對照表沒有的寫法不比、不擋");
  // 沒給對照表（讀不到）：跟以前一樣只比選舉結果
  const legacy = decideByCec(claim({ election_result: "elected", party: "民主進步黨" }), [cecRow("中國國民黨")]);
  assertEquals(legacy.action === "apply" && legacy.matched, ["election_result"]);
});

Deno.test("政黨寫法比對規則：Edge Function 這份跟前端、SQL 同一套", async () => {
  for (const t of ["中國國民黨", "臺灣 基進", "台灣基進", "　無黨籍　", "ＤＰＰ", "", null, "臺灣SoR無法黨"]) {
    assertEquals(partyAliasKey(t as string | null), frontendPartyAliasKey(t as string | null), String(t));
  }
  const parties = lf(await Deno.readTextFile(new URL("20261006073461_parties.sql", MIGRATIONS)));
  assert(parties.includes("SELECT nullif(replace(regexp_replace(normalize(coalesce(p_text, ''), NFKC), '\\s', '', 'g'), '臺', '台'), '')"), "SQL 的規則改了，這份要跟著改");
  assertEquals(sameParty({ kind: "independent" }, { kind: "party", partyId: 1 }), false);
  assertEquals(sameParty({ kind: "unknown" }, { kind: "party", partyId: 1 }), null);
});

// ── 2. party_info ───────────────────────────────────────────────
Deno.test("清點四處：DB CHECK（上一版每一種都留著再加 party_info）、TS 清單、skill.md、各處的中文名稱", async () => {
  assert((CONTRIBUTION_TYPES as readonly string[]).includes("party_info"));
  const listOf = (text: string) => new Set([...text.match(/CHECK \(contribution_type IN \(([^)]*)\)\)/)![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  const prevSql = lf(await Deno.readTextFile(new URL("20261006034900_policy_lineages.sql", MIGRATIONS)));
  const now = listOf(sql), prev = listOf(prevSql);
  for (const t of prev) assert(now.has(t), `CHECK 掉了 ${t}`);
  assertEquals([...now].filter((t) => !prev.has(t)), ["party_info"]);
  for (const f of ["../../../lib/model-quality.ts", "../../../pages/Contributions.vue", "../../../pages/Queue.vue", "../../../pages/UserProfile.vue"]) {
    const text = await Deno.readTextFile(new URL(f, import.meta.url));
    assert(/party_info: '政黨資訊'|key: 'party_info', label: '政黨資訊'/.test(text), `${f} 沒有 party_info 的中文名稱`);
  }
  assert(VOTE_DIMENSIONS.party_info.length > 0);
  const vb = ours("CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)");
  assert(vb.includes("'party_info'"));
});

Deno.test("交件格式：每個政黨一項、至少一欄、日期與 id 的形狀、起訖不顛倒、前身不是自己、不收名稱與狀態", () => {
  const ok = { parties: [{ party_id: 95, valid_from: "2019-05-01", predecessor_id: 10001 }, { party_id: 10001, valid_to: "2019-04-30" }], note: "內政部政黨資訊網記載改名" };
  assertEquals(partyInfoProblems(ok), []);
  const msgs = (p: Row) => partyInfoProblems(p).map((x) => `${x.path} ${x.message}`).join("\n");
  assertStringIncludes(msgs({ parties: [], note: "x".repeat(10) }), "parties 必填");
  assertStringIncludes(msgs({ parties: [{ party_id: 95 }], note: "x".repeat(10) }), "至少要給");
  assertStringIncludes(msgs({ parties: [{ party_id: 95, valid_to: "2019-02-30" }], note: "x".repeat(10) }), "YYYY-MM-DD");
  assertStringIncludes(msgs({ parties: [{ party_id: 95, valid_from: "2020-01-01", valid_to: "2019-01-01" }], note: "x".repeat(10) }), "不能早於");
  assertStringIncludes(msgs({ parties: [{ party_id: 95, predecessor_id: 95 }], note: "x".repeat(10) }), "前身不能是自己");
  assertStringIncludes(msgs({ parties: [{ party_id: 95, valid_to: "2019-01-01", name: "新名字" }], note: "x".repeat(10) }), "不認得的欄位");
  assertStringIncludes(msgs({ parties: [{ party_id: 95, valid_to: "2019-01-01" }, { party_id: 95, valid_from: "2018-01-01" }], note: "x".repeat(10) }), "重複");
  assertStringIncludes(msgs({ parties: [{ party_id: 95, valid_to: "2019-01-01" }] }), "note 必填");
  assertStringIncludes(msgs({ parties: Array.from({ length: 6 }, (_, i) => ({ party_id: i + 1, valid_to: "2019-01-01" })), note: "x".repeat(10) }), "1～5 項");
});

const body = (sources: string[], payload: Row = { parties: [{ party_id: 10001, valid_to: "2019-04-30" }], note: "內政部政黨資訊網記載改名日期" }) =>
  ({ agent_name: "tester", contribution_type: "party_info", payload, source_urls: sources });
Deno.test("交件：臉書、IG、Threads 讀不到不算出處；官方網址照收", () => {
  assertEquals(validateContributionRequest(body(["https://party.moi.gov.tw/PartyMainContent.aspx?n=16100&s=154"])).ok, true);
  const fb = validateContributionRequest(body(["https://party.moi.gov.tw/x", "https://www.facebook.com/tsu/posts/1"]));
  assertEquals(fb.ok, false);
  assert(fb.errors.some((e) => e.path === "source_urls[1]"));
});

const P = (id: number, name: string, extra: Partial<PartyRow> = {}): [number, PartyRow] =>
  [id, { id, name, valid_from: null, valid_to: null, predecessor_id: null, ...extra }];

Deno.test("落庫計畫：改名兩筆一起、值一樣的略過、找不到、前身繞圈、起訖顛倒都講清楚", () => {
  const rows = new Map([P(95, "台聯黨", { valid_from: null, predecessor_id: 10001 }), P(10001, "台灣團結聯盟", { valid_from: "2001-08-12" }), P(366, "臺灣SoR無法黨"), P(10003, "臺灣雙語無法黨")]);
  const plan = planPartyInfo(rows, [{ party_id: 95, valid_from: "2019-05-01", predecessor_id: 10001 }, { party_id: 10001, valid_to: "2019-04-30" }]);
  assertEquals(plan.problems, []);
  assertEquals(plan.updates.map((u) => [u.id, u.patch]), [[95, { valid_from: "2019-05-01" }], [10001, { valid_to: "2019-04-30" }]]);
  assertEquals(plan.unchanged, ["政黨 95 的 predecessor_id"]);
  assertStringIncludes(planPartyInfo(rows, [{ party_id: 999, valid_to: "2019-01-01" }]).problems.join(), "找不到政黨 999");
  assertStringIncludes(planPartyInfo(rows, [{ party_id: 10001, predecessor_id: 95 }]).problems.join(), "繞回自己");
  assertStringIncludes(planPartyInfo(rows, [{ party_id: 10001, valid_to: "2000-01-01" }]).problems.join(), "早於開始日");
  // 名冊外的對應：臺灣雙語無法黨是不是 SoR 無法黨改名前的名字（有出處才交）
  assertEquals(planPartyInfo(rows, [{ party_id: 366, predecessor_id: 10003 }]).updates[0].patch, { predecessor_id: 10003 });
  assertEquals(missingAncestors(new Map([P(95, "台聯黨", { predecessor_id: 10001 })])), [10001]);
});

function makeDb(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => { filters.push((r) => String(r[col]) === String(val)); return api; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.map(String).includes(String(r[col]))); return api; },
      order: () => api,
      limit: () => api,
      maybeSingle: () => Promise.resolve({ data: (tables.get(table) ?? []).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      then: (res: (v: { data: Row[]; error: null }) => unknown) => res({ data: (tables.get(table) ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
      insert: (row: Row | Row[]) => {
        tables.set(table, [...(tables.get(table) ?? []), ...(Array.isArray(row) ? row : [row])]);
        return Promise.resolve({ error: null });
      },
      update: (patch: Row) => ({
        eq: (col: string, val: unknown) => {
          for (const r of tables.get(table) ?? []) if (String(r[col]) === String(val)) Object.assign(r, patch);
          return Promise.resolve({ error: null });
        },
      }),
    };
    return api;
  }
  // deno-lint-ignore no-explicit-any
  return { client: { from } as any, tables };
}
const partyRow = (payload: Row) => ({ id: "k1", contribution_type: "party_info" as const, payload, source_urls: ["https://party.moi.gov.tw/x"], note: null, agent_name: "tester", contributor_url: null });
const seed = () => ({ parties: [{ id: 95, name: "台聯黨", valid_from: null, valid_to: null, predecessor_id: 10001 }, { id: 10001, name: "台灣團結聯盟", valid_from: "2001-08-12", valid_to: null, predecessor_id: null }] });

Deno.test("落庫：一個政黨一次 UPDATE、每一欄留履歷；落不了的整筆不寫；都一樣的記 superseded", async () => {
  const { client, tables } = makeDb(seed());
  const out = await applyContribution(client, partyRow({ parties: [{ party_id: 95, valid_from: "2019-05-01" }, { party_id: 10001, valid_to: "2019-04-30" }], note: "內政部政黨資訊網記載改名" }));
  assertEquals(out.status, "applied", String(out.message));
  const ps = tables.get("parties")!;
  assertEquals([ps[0].valid_from, ps[1].valid_to], ["2019-05-01", "2019-04-30"]);
  const hist = (tables.get("edit_history") ?? []).map((h) => `${h.table_name}:${h.record_id}:${h.field}`);
  assertEquals(hist.sort(), ["parties:10001:valid_to", "parties:95:valid_from"]);
  const loop = makeDb(seed());
  const bad = await applyContribution(loop.client, partyRow({ parties: [{ party_id: 10001, predecessor_id: 95 }], note: "x".repeat(10) }));
  assertEquals(bad.status, "disputed");
  assertEquals(loop.tables.get("parties")![1].predecessor_id, null);
  const same = await applyContribution(makeDb(seed()).client, partyRow({ parties: [{ party_id: 95, predecessor_id: 10001 }], note: "x".repeat(10) }));
  assertEquals(same.status, "superseded");
});

Deno.test("交件時的前置檢查：找不到政黨 → target_not_found；前身繞圈 → apply_would_fail", async () => {
  const { client } = makeDb(seed());
  const items = [
    { contribution_type: "party_info", payload: { parties: [{ party_id: 404, valid_to: "2019-01-01" }], note: "x".repeat(10) } },
    { contribution_type: "party_info", payload: { parties: [{ party_id: 10001, predecessor_id: 95 }], note: "x".repeat(10) } },
    { contribution_type: "party_info", payload: { parties: [{ party_id: 10001, valid_to: "2019-04-30" }], note: "x".repeat(10) } },
  ];
  const problems = await precheckApplyTargets(client, items, new Set());
  assertEquals(problems.map((p) => [p.index, p.code]), [[0, "target_not_found"], [1, "apply_would_fail"]]);
});

Deno.test("驗證現況：逐個政黨並排交上來的值與現值（含前身名稱）", () => {
  const cur = shapeVerifyCurrent("party_info", { parties: [{ party_id: 95, valid_from: "2019-05-01", predecessor_id: 10001 }] }, {
    parties: [{ id: 95, name: "台聯黨", moi_no: 95, moi_status: "一般", valid_from: null, valid_to: null, predecessor_id: 10001 }, { id: 10001, name: "台灣團結聯盟", moi_no: null }],
  } as never);
  const p0 = (cur.parties as Row[])[0];
  assertEquals((p0.claimed as Row).predecessor_name, "台灣團結聯盟");
  assertEquals((p0.db as Row).valid_from, null);
  assertEquals(cur.hint, PARTY_INFO_VERIFY_HINT);
});

Deno.test("貢獻摘要：講得出補了哪個政黨的哪一欄", () => {
  const s = summarizeContribution({ contribution_type: "party_info", payload: { parties: [{ party_id: 95, valid_from: "2019-05-01", predecessor_id: 10001 }] } });
  assertStringIncludes(s.summary, "政黨 95");
  assertStringIncludes(s.summary, "名稱起始日 2019-05-01");
  assertStringIncludes(s.summary, "前身是政黨 10001");
});

// ── 參選紀錄缺政黨那一種任務：hint 與骨架 ───────────────────────────────
const gapTarget = {
  kind: "party", politician_election_id: 9, politician_id: "00000000-0000-4000-8000-000000000001", name: "王小明", region: "台中市",
  election_id: 2022, election_type: "縣市議員", candidate_status: "confirmed", missing: ["party"], person_party: "台灣民眾黨",
  fill: { region: "台中市", electoral_district: "第01選舉區" },
  cec: { party: "中國國民黨", election_result: "elected", cand_no: 3 },
};
Deno.test("任務現況與骨架：party 那一種給專用 hint；骨架的政黨照名冊、地區照 fill、帶姓名（自動核對要用）", () => {
  assert(isPartyGapTask("candidacy_source_missing", gapTarget));
  const cur = shapeTaskCurrent("candidacy_source_missing", { politician: null, politician_election: null }, { task_id: "auto:candidacy_source_missing:party:9", target: gapTarget });
  assertEquals(cur.hint, PARTY_GAP_HINT);
  const tpl = buildReportTemplate("candidacy_source_missing", "candidacy", gapTarget, "auto:candidacy_source_missing:party:9") as Row;
  const p = tpl.payload as Row;
  assertEquals([p.party, p.election_result, p.electoral_district, p.name, p.candidate_status], ["中國國民黨", "elected", "第01選舉區", "王小明", "confirmed"]);
  assert(p.party !== gapTarget.person_party, "不能是他現在的政黨");
});

Deno.test("協議 1.56.0：party_info 一節、參選紀錄缺政黨的任務、candidacy 的 party 是那一次的政黨", async () => {
  const [major, minor] = PROTOCOL_VERSION.split(".").map(Number);
  assert(major > 1 || (major === 1 && minor >= 56), `協議版號 ${PROTOCOL_VERSION} 比 1.56.0 舊`);
  const md = lf(await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url)));
  for (const s of ["**`party_info`**（1.56.0）", "auto:candidacy_source_missing:party:", "**`party` 是那一次參選時的政黨**（1.56.0）", "**對不上會被退件**", "／`party_info` | 3 | 3 | 3 | 3 |"]) {
    assertStringIncludes(md, s);
  }
});

Deno.test("出處觸發器：落庫掛到改的政黨（讀不到的社群不算）、還原拿掉；出錯不擋", () => {
  const fn = ours("CREATE OR REPLACE FUNCTION party_info_attach_sources(");
  assert(fn.includes("WHERE career_source_readable(x.u)"), "跟學經歷同一份讀不到的清單");
  assert(fn.includes("v_origin TEXT := 'contribution:' || p_contribution_id;"));
  const trg = ours("CREATE OR REPLACE FUNCTION contribution_party_info_sources()");
  assert(trg.includes("DELETE FROM source_refs WHERE target_table = 'parties' AND origin = 'contribution:' || NEW.id;"));
  assert(trg.includes("EXCEPTION WHEN OTHERS THEN"));
  assert(sql.includes("FOR EACH ROW WHEN (NEW.contribution_type = 'party_info' AND NEW.status IN ('applied', 'reverted') AND OLD.status IS DISTINCT FROM NEW.status)"));
});
