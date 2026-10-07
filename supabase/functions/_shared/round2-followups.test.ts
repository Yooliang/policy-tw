/**
 * #384、#386 未決的第二輪（主線 10-06 裁定；migration 20261006140000）的守門測試：
 *   1. 不參選重查的章照已落庫交件補蓋　2. 2026 缺政黨照登記彙總表派　3. 補縣市、補選區不叫代理照抄現在的政黨
 *   4. 政黨資訊派工（party_info_missing）　5. 測試資料：姓名守門三層、removal 開放 politicians、placeholder_politician 派工
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { applyContribution } from "./apply-contribution.ts";
import { precheckApplyTargets } from "./apply-precheck.ts";
import { REMOVAL_TABLES, TASK_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import { isPlaceholderName, PLACEHOLDER_NAME_LATIN, PLACEHOLDER_NAME_WORDS } from "./placeholder-name.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { PARTY_ROSTER_HINT, shapeTaskCurrent, shapeVerifyCurrent } from "./task-context.ts";
import { buildReportTemplate, hasGuidance, TASK_BRANCHES } from "./task-guidance.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { TASK_TYPE_LABEL } from "../../../lib/task-labels.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const THIS = "20261006140000_round2_followups.sql";
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sql = lf(await Deno.readTextFile(new URL(THIS, MIGRATIONS)));
type Row = Record<string, unknown>;

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
const ours = (fn: string) => { const d = definitionIn(sql, fn); assert(d, fn); return d!; };

// ── 1. 章補蓋 ─────────────────────────────────────────────────
Deno.test("不參選重查的章：照已落庫、outcome=confirmed 的交件補，每筆一列履歷指回那一筆交件；狀態被改過的不補；補完自己核一次", () => {
  const block = sql.slice(sql.indexOf("-- ── 1. 不參選重查的章"), sql.indexOf("-- ── 5a."));
  assert(block.includes("JOIN politician_elections pe ON c.task_id = 'auto:not_running_recheck:' || pe.id"), "task_id 是整數 id 的那個形狀");
  assert(block.includes("c.contribution_type = 'no_change' AND c.status = 'applied' AND c.payload->>'outcome' = 'confirmed'"));
  assert(/AND pe\.candidate_status = 'not_running'\n\s+ORDER BY pe\.id/.test(block),"那之後被改成不是不參選的不補（補的那一段，不是自我檢查那一段）");
  assert(block.includes("AND pe.verified IS NOT TRUE"));
  assert(block.includes("VALUES ('politician_elections', r.pe_id::TEXT, 'verified', 'false'::JSONB, 'true'::JSONB, r.contribution_id, r.agent_name"), "履歷要指回那一筆交件，才照交件還原得了");
  assert(block.includes("RAISE EXCEPTION '不參選重查的章還有沒補到的'"));
  assertEquals(/UPDATE politician_elections SET (?!verified = true WHERE id = r\.pe_id;)/.test(block), false, "只動 verified 這一欄");
});

// ── 2. 2026 缺政黨 ─────────────────────────────────────────────
const roster = ours("contribution_auto_tasks_party_roster");
Deno.test("2026 缺政黨：還沒投票、已登記、缺政黨的一筆一件，附登記彙總表；task_id 跟已投票那支同形狀、屆別不重疊", async () => {
  assert(roster.includes("JOIN elections e ON e.id = pe.election_id AND e.election_date >= CURRENT_DATE"));
  const gap = await previousDefinition("contribution_auto_tasks_party_gap");
  assert(gap.includes("JOIN elections e ON e.id = pe.election_id AND e.election_date < CURRENT_DATE"), "已投票那支照舊只看投完票的");
  assert(roster.includes("WHERE pe.party_basis IS NULL AND pe.candidacy_status = 'filed'"), "表態不參選、沒登記的名冊上沒有他");
  assert(roster.includes("'roster' = ANY (v.provides)") && roster.includes("g.election_type = ANY (v.election_types) AND g.county = ANY (v.regions)"));
  assert(/SELECT 'auto:candidacy_source_missing:party:' \|\| x\.pe_id,\s*'candidacy_source_missing'/.test(roster));
  assert(roster.includes("'kind', 'party_roster'"));
  assert(roster.includes("不要填他現在的政黨"));
});

Deno.test("2026 缺政黨：hint 與骨架（政黨照名冊、不預填現在的政黨）", () => {
  const target = { kind: "party_roster", politician_id: "00000000-0000-4000-8000-000000000001", name: "王小明", election_id: 2026, election_type: "縣市議員",
    region: "台中市", candidate_status: "registered", person_party: "台灣民眾黨", rosters: ["https://web.cec.gov.tw/api/file/x.pdf"] };
  const cur = shapeTaskCurrent("candidacy_source_missing", { politician: null, politician_election: null }, { task_id: "auto:candidacy_source_missing:party:9", target });
  assertEquals(cur.hint, PARTY_ROSTER_HINT);
  const p = (buildReportTemplate("candidacy_source_missing", "candidacy", target, "auto:candidacy_source_missing:party:9") as Row).payload as Row;
  assert(String(p.party).includes("推薦之政黨") && p.party !== target.person_party);
  assert("electoral_district" in p, "縣市議員要帶選舉區");
});

// ── 3. 補縣市、補鄉鎮 ───────────────────────────────────────────
Deno.test("補縣市、補鄉鎮：target 的 party 改名 person_party、說明改成照那一屆的名冊填，其餘一字不改", async () => {
  for (const fn of ["contribution_auto_tasks_region_gap", "contribution_auto_tasks_township_gap"]) {
    const now = ours(fn);
    const prev = await previousDefinition(fn);
    assertEquals(now.includes("原樣帶"), false, `${fn} 還叫代理照現有資料原樣帶`);
    assertEquals(/'party', [pxg]\.party/.test(now), false, `${fn} target 還把現在的政黨叫 party`);
    assert(now.includes("'person_party',") && now.includes("不要照抄他現在的政黨"));
    // 其餘一字不改：把這次的改動倒回去要等於上一版
    const RULE = "其餘欄位照那一屆的名冊填（party 填那一屆的推薦政黨，不要照抄他現在的政黨——人會換黨；查不到就不要帶 party）";
    let back = now.replace("'person_party', ", "'party', ");
    if (fn.endsWith("region_gap")) {
      back = back.replace(", 'cec_party', cec.party)", ")")
        .replace(`，${RULE}；'\n           || CASE WHEN cec.party IS NOT NULL THEN '中選會名單上他那一屆的推薦政黨是「' || cec.party || '」。' ELSE '' END`, "，其餘欄位照現有資料原樣帶；'")
        .replace(" END AS listed_as,\n             CASE WHEN count(*) = 1 THEN min(c.party) END AS party\n", " END AS listed_as\n");
    } else {
      back = back.replace(`、village 填村里名，candidate_status 照現況，${RULE}，'`, "、village 填村里名，其餘欄位（political_party、candidate_status 等）照現有資料原樣帶，'")
        .replace(`、sub_region 填鄉鎮市區，candidate_status 照現況，${RULE}，source_urls`, "、sub_region 填鄉鎮市區，其餘欄位照現有資料原樣帶，source_urls");
    }
    assertEquals(back, prev, fn);
  }
});

// ── 4. 政黨資訊派工 ────────────────────────────────────────────
const pinfo = ours("contribution_auto_tasks_party_info");
Deno.test("政黨資訊缺口：改名、名冊外、解散廢止三種；task_id 分得開；在等票的先不派", () => {
  for (const k of ["rename", "off_registry", "dissolved"]) assert(pinfo.includes(`'${k}'`));
  assert(/SELECT 'auto:party_info_missing:' \|\| g\.kind \|\| ':' \|\| g\.party_id,\s*'party_info_missing'/.test(pinfo));
  assert(pinfo.includes("WHERE p.moi_status IN ('自行解散', '廢止備案', '撤銷備案') AND p.valid_to IS NULL"));
  assert(pinfo.includes("WHERE p.moi_no IS NULL AND NOT EXISTS (SELECT 1 FROM parties c WHERE c.predecessor_id = p.id)"), "已經對到前身的名冊外政黨交給改名那一種");
  assert(pinfo.includes("WHERE c.contribution_type = 'party_info' AND c.status IN ('pending', 'verified')"));
  assert(pinfo.includes("查不到確切的日子就不要交那一欄"));
});

Deno.test("政黨資訊缺口的骨架：改名的那一種新舊兩筆都列，缺哪欄就留哪欄", () => {
  const target = { kind: "rename", party_id: 95, party_ids: [95, 10001], missing: ["valid_from", "valid_to"] };
  const p = (buildReportTemplate("party_info_missing", "party_info", target, "auto:party_info_missing:rename:95") as Row).payload as Row;
  const parties = p.parties as Row[];
  assertEquals(parties.map((x) => x.party_id), [95, 10001]);
  assert("valid_from" in parties[0] && "note" in p);
});

// ── 5. 測試資料 ───────────────────────────────────────────────
Deno.test("測試資料的姓名：TS 與 SQL 同一份字詞；英文要是完整的一個詞", () => {
  const fn = ours("politician_name_is_placeholder");
  assert(fn.includes(`(${PLACEHOLDER_NAME_WORDS.join("|")})|(^|[^A-Za-z])(${PLACEHOLDER_NAME_LATIN.join("|")})([^A-Za-z]|$)`), "SQL 的字詞跟 placeholder-name.ts 不一樣");
  for (const n of ["測試候選人ABC", "陳測試員", "巴奈．test", "test01", "範例人物"]) assert(isPlaceholderName(n), n);
  for (const n of ["王小明", "Testa Lin", "Kolas Yotaka", "Sampleton", "伍麗華 Saidhai．Tahovecahe", null]) assertEquals(isPlaceholderName(n), false, String(n));
  assert(sql.includes("BEFORE INSERT OR UPDATE OF name ON politicians"), "只擋新增與改名，那三筆現有資料改別的欄位照樣可以");
});

Deno.test("交件當下擋測試名（politician、candidacy）", () => {
  const base = { agent_name: "tester", source_urls: ["https://www.cna.com.tw/news/aipl/1.aspx"] };
  const bad = validateContributionRequest({ ...base, contribution_type: "politician", payload: { name: "測試", party: "無黨籍", region: "台北市" } });
  assertEquals(bad.ok, false);
  assert(bad.errors.some((e) => e.path === "payload.name"));
  const badC = validateContributionRequest({ ...base, contribution_type: "candidacy", payload: { name: "test", election_id: 2026, election_type: "縣市長", region: "台北市", candidate_status: "registered" } });
  assert(badC.errors.some((e) => e.path === "payload.name"));
});

Deno.test("建人物時拒建（落庫與派工 dry-run 共用的 ensurePolitician）", async () => {
  const src = lf(await Deno.readTextFile(new URL("./candidate-import.ts", import.meta.url)));
  const i = src.indexOf("if (isPlaceholderName(name)) throw new Error(");
  const j = src.indexOf('.from("politicians")\n    .insert({');
  assert(i > 0 && j > i, "拒建要在建人物之前");
});

// 移除人物
function makeDb(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let head = false;
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: (_c?: string, opts?: { head?: boolean }) => { head = !!opts?.head; return api; },
      eq: (col: string, val: unknown) => { filters.push((r) => String(r[col]) === String(val)); return api; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.map(String).includes(String(r[col]))); return api; },
      order: () => api, limit: () => api,
      maybeSingle: () => Promise.resolve({ data: (tables.get(table) ?? []).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      then: (res: (v: Row) => unknown) => {
        const rows = (tables.get(table) ?? []).filter((r) => filters.every((f) => f(r)));
        return res(head ? { data: null, count: rows.length, error: null } : { data: rows, error: null });
      },
      insert: (row: Row | Row[]) => { tables.set(table, [...(tables.get(table) ?? []), ...(Array.isArray(row) ? row : [row])]); return Promise.resolve({ error: null }); },
      delete: () => ({ eq: (col: string, val: unknown) => { tables.set(table, (tables.get(table) ?? []).filter((r) => String(r[col]) !== String(val))); return Promise.resolve({ error: null }); } }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    };
    return api;
  }
  // deno-lint-ignore no-explicit-any
  return { client: { from } as any, tables };
}
const PID = "00000000-0000-4000-8000-0000000000aa";
const removalRow = { id: "r1", contribution_type: "removal" as const, payload: { target_table: "politicians", target_id: PID, reason: "中選會選舉資料庫、選委會公告與媒體都查無此人，是測試資料" },
  source_urls: ["https://db.cec.gov.tw/x"], note: null, agent_name: "tester", contributor_url: null };

Deno.test("removal 開放 politicians：整個人連參選紀錄刪掉，履歷先記參選紀錄、最後記人物（還原時人物先回去）", async () => {
  assert((REMOVAL_TABLES as readonly string[]).includes("politicians"));
  const { client, tables } = makeDb({
    politicians: [{ id: PID, name: "測試候選人ABC", merged_into: null }],
    politician_elections: [{ id: 34401, politician_id: PID, election_id: 2024 }],
  });
  const out = await applyContribution(client, removalRow);
  assertEquals(out.status, "applied", String(out.message));
  assertEquals((tables.get("politicians") ?? []).length, 0);
  assertEquals((tables.get("politician_elections") ?? []).length, 0);
  const hist = (tables.get("edit_history") ?? []).map((h) => `${h.table_name}:${h.field}:${h.new_value === null ? "deleted" : "?"}`);
  assertEquals(hist, ["politician_elections:*:deleted", "politicians:*:deleted"]);
});

Deno.test("removal 人物：身上有政見、任期等真的內容就不刪（落庫 disputed、交件前置檢查擋）", async () => {
  const seed = () => ({ politicians: [{ id: PID, name: "某人", merged_into: null }], politician_elections: [], policies: [{ id: "p1", politician_id: PID }] });
  const { client, tables } = makeDb(seed());
  const out = await applyContribution(client, removalRow);
  assertEquals(out.status, "disputed");
  assertStringIncludes(String(out.message), "政見");
  assertEquals((tables.get("politicians") ?? []).length, 1);
  const problems = await precheckApplyTargets(makeDb(seed()).client, [{ contribution_type: "removal", payload: removalRow.payload }], new Set());
  assertEquals(problems.map((p) => p.code), ["apply_would_fail"]);
});

Deno.test("驗證移除人物：給這個人與他的參選紀錄，提示只該用在查無此人", () => {
  const cur = shapeVerifyCurrent("removal", { target_table: "politicians", target_id: PID }, { politicians: [{ id: PID, name: "測試候選人ABC" }], elections: [{ election_id: 2024 }] } as never);
  assertEquals((cur.politician as Row).name, "測試候選人ABC");
  assertEquals((cur.elections as Row[]).length, 1);
  assertStringIncludes(String(cur.hint), "查無此人");
});

const ph = ours("contribution_auto_tasks_placeholder_politicians");
Deno.test("測試資料派工：姓名命中、沒被合併、沒有人交了移除在等票的；骨架預填 politicians 與人物 id", () => {
  assert(ph.includes("WHERE p.merged_into IS NULL AND politician_name_is_placeholder(p.name)"));
  assert(ph.includes("c.payload->>'target_table' = 'politicians' AND c.payload->>'target_id' = p.id::TEXT"));
  const p = (buildReportTemplate("placeholder_politician", "removal", { politician_id: PID, name: "測試候選人ABC" }, `auto:placeholder_politician:${PID}`) as Row).payload as Row;
  assertEquals([p.target_table, p.target_id], ["politicians", PID]);
});

// ── 清點：新任務型別、arms、協議 ─────────────────────────────────
Deno.test("清點：兩個新任務型別都有 TS 清單、建議型別、做法、分支、中文名稱、看板顏色；三支新臂接進 arms、其餘照上一版", async () => {
  for (const [t, c] of [["placeholder_politician", "removal"], ["party_info_missing", "party_info"]]) {
    assert((TASK_TYPES as readonly string[]).includes(t));
    assertEquals(SUGGESTED_TYPE[t], c);
    assert(hasGuidance(t) && TASK_BRANCHES[t]?.includes(c) && TASK_BRANCHES[t]?.includes("no_change"));
    assert(TASK_TYPE_LABEL[t] && !/[A-Za-z]/.test(TASK_TYPE_LABEL[t]), `${t} 要有純中文名稱`);
    const queue = await Deno.readTextFile(new URL("../../../pages/Queue.vue", import.meta.url));
    assert(queue.includes(`  ${t}: '#`), `${t} 在 /queue 沒有顏色`);
  }
  const prev = await previousDefinition("contribution_auto_tasks_arms");
  const now = ours("contribution_auto_tasks_arms");
  const lines = ["  UNION ALL SELECT * FROM contribution_auto_tasks_party_roster()\n", "  UNION ALL SELECT * FROM contribution_auto_tasks_party_info()\n",
    "  UNION ALL SELECT * FROM contribution_auto_tasks_placeholder_politicians()\n"];
  let back = now;
  for (const l of lines) { assert(now.includes(l)); back = back.replace(l, ""); }
  assertEquals(back, prev);
});

Deno.test("協議：removal 收人物、測試名不收、party_roster 與 party_info_missing 寫進 skill.md；版號比 1.56.0 新", async () => {
  const [major, minor] = PROTOCOL_VERSION.split(".").map(Number);
  assert(major > 1 || (major === 1 && minor > 56), PROTOCOL_VERSION);
  const md = lf(await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url)));
  for (const s of ["**`politicians` 人物**", "**測試資料的姓名不收**", "`target.kind` 是 `party_roster`", "**`party_info_missing` 任務**", "**不要照抄 `target.person_party`**"]) {
    assertStringIncludes(md, s);
  }
  assertEquals(md.includes("其餘照現有資料原樣帶"), false);
});
