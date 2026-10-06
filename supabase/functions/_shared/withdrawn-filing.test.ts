/**
 * #345 後續兩項（主線 10-06 裁定；migration 20261006100000）的守門測試：
 *   1. 退選前有沒有登記（#380 未決 3）：退選而 withdrawn_after_filing 空的參選紀錄派任務（沿用 not_running_recheck，
 *      task_id 多一段 filing），代理用 correction 改那一欄（協議 1.55.0）；同一列原本的不參選重查改由新臂一起問
 *   2. 三支 SQL 派工臂的說明「candidate_status 填 confirmed」改成 qualified（#380 未決 1），其餘一字不改
 * 另外守住順手修的：不參選重查的章（verified）原本用 uuid 的樣子比對整數 id，一筆都蓋不到。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { applyContribution } from "./apply-contribution.ts";
import { handleContribute } from "./contribute-handler.ts";
import { CORRECTION_FIELDS, isTaskIdShape, validateContributionRequest } from "./contribution-schema.ts";
import { summarizeContribution } from "./contribution-summary.ts";
import { isWithdrawnFilingTask, shapeTaskCurrent, WITHDRAWN_FILING_HINT } from "./task-context.ts";
import { buildReportTemplate, rowIdFromTaskId, TASK_GUIDANCE } from "./task-guidance.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { ALL_REGIONS } from "./cec-city-codes.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const THIS = "20261006100000_withdrawn_filing_qualified_wording.sql";
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sql = lf(await Deno.readTextFile(new URL(THIS, MIGRATIONS)));

/** 一支 migration 裡某個函式的整段 CREATE（到收尾的 dollar tag 與分號） */
function definitionIn(text: string, fn: string): string | null {
  const start = text.lastIndexOf(`CREATE OR REPLACE FUNCTION ${fn}()`);
  if (start < 0) return null;
  const tag = /AS\s+(\$[A-Za-z_]*\$)/.exec(text.slice(start));
  assert(tag, `${fn} 找不到 dollar quote`);
  const bodyStart = start + tag.index + tag[0].length;
  const end = text.indexOf(tag[1], bodyStart);
  return text.slice(start, text.indexOf(";", end) + 1);
}

/** 這支之前最後一支定義 fn 的 migration 裡的定義（檔名字典序＝時間序） */
async function previousDefinition(fn: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql") && e.name < THIS) names.push(e.name);
  names.sort().reverse();
  for (const name of names) {
    const def = definitionIn(lf(await Deno.readTextFile(new URL(name, MIGRATIONS))), fn);
    if (def) return def;
  }
  throw new Error(`這支之前沒有 migration 定義 ${fn}`);
}

function ours(fn: string): string {
  const def = definitionIn(sql, fn);
  assert(def, `${THIS} 沒有重定義 ${fn}`);
  return def!;
}

function applyAll(text: string, pairs: ReadonlyArray<[string, string]>): string {
  let out = text;
  for (const [from, to] of pairs) {
    assertEquals(out.split(from).length - 1, 1, `上一版要剛好有一處「${from.slice(0, 40)}…」`);
    out = out.replace(from, to);
  }
  return out;
}

// ── 2. 三支派工臂的說明：只換這幾句，其餘一字不改 ──────────────────────────
const WORDING: Record<string, ReadonlyArray<[string, string]>> = {
  contribution_auto_tasks_raw: [
    ["' 公告，請以公告名單為準：candidacy 的 candidate_status 填 confirmed，查得到號次就一起附上。'",
      "' 公告，請以公告名單為準：candidacy 的 candidate_status 填 qualified（名單上的人；confirmed 只表示表態參選），查得到號次就一起附上。'"],
    ["用 candidacy 型別補 election_result（elected 或 not_elected），查得到就一起補得票數與得票率。'",
      "用 candidacy 型別補 election_result（elected 或 not_elected；得票數、得票率不收，不用查）。'"],
  ],
  contribution_auto_tasks_elected_missing: [
    ["、candidate_status 填 confirmed、election_result 填 elected'",
      "、candidate_status 填 qualified（中選會名單上的人；confirmed 只表示表態參選）、election_result 填 elected'"],
    ["|| '，查得到就一起補得票數與得票率；cec_cand_id 填 '", "|| '（得票數、得票率不收，不用查）；cec_cand_id 填 '"],
  ],
  contribution_auto_tasks_roster_cec_gap: [
    ["'、candidate_status 填 confirmed、election_result 照中選會填 elected 或 not_elected（查得到號次 cand_no 與得票數就一起附），'",
      "'、candidate_status 填 qualified（中選會名單上的人；confirmed 只表示表態參選）、election_result 照中選會填 elected 或 not_elected（查得到號次 cand_no 就一起附；得票數不收），'"],
  ],
  contribution_auto_tasks_region_gap: [["WHEN 'confirmed' THEN '確定參選'", "WHEN 'confirmed' THEN '表態參選'"]],
};

for (const [fn, pairs] of Object.entries(WORDING)) {
  Deno.test(`${fn}：只換說明文字，其餘跟上一版一字不差`, async () => {
    assertEquals(ours(fn), applyAll(await previousDefinition(fn), pairs));
  });
}

Deno.test("名單公告後、已投票屆別的說明不再叫代理填 confirmed（#380：confirmed 只表示表態參選）", () => {
  for (const fn of Object.keys(WORDING)) {
    const def = ours(fn);
    assertEquals(/(?<!不要)填 confirmed/.test(def), false, `${fn} 還寫著填 confirmed`);
    assertEquals(/補得票數與得票率|與得票數就一起附/.test(def), false, `${fn} 還叫代理補得票數（1.51.0 起不收）`);
    assertEquals(def.includes("'確定參選'"), false, `${fn} 還有「確定參選」`);
  }
  // 登記階段那句「不要填 confirmed」是對的，要留著
  assertStringIncludes(ours("contribution_auto_tasks_raw"), "candidate_status 填 registered，不要填 confirmed");
});

// ── 1. 退選前有沒有登記：派工臂 ───────────────────────────────────────
const arm = ours("contribution_auto_tasks_withdrawn_filing");

Deno.test("新臂只派退選、而且看不出退選前有沒有登記的（照 #380 的欄位），已合併的人不派", () => {
  assert(/WHERE pe\.candidacy_status = 'withdrawn' AND pe\.withdrawn_after_filing IS NULL/.test(arm));
  assert(arm.includes("JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL"));
});

Deno.test("沿用 not_running_recheck，task_id 多一段 filing，不跟原本那種撞號；任務編號格式交件收得下", () => {
  const prefixes = [...arm.matchAll(/'auto:([a-z_]+):/g)].map((m) => m[1]);
  assertEquals([...new Set(prefixes)], ["not_running_recheck"]);
  assert(/SELECT 'auto:not_running_recheck:filing:' \|\| x\.pe_id,\s*'not_running_recheck'/.test(arm));
  assertEquals(SUGGESTED_TYPE.not_running_recheck, "correction");
  assert(isTaskIdShape("auto:not_running_recheck:filing:35043"));
  // 拆不出單一列 id（多一段）：骨架改從 target.politician_election_id 拿
  assertEquals(rowIdFromTaskId("auto:not_running_recheck:filing:35043"), null);
  assert(arm.includes("'politician_election_id', x.pe_id"));
  assert(arm.includes("'kind', 'withdrawn_filing'"));
});

Deno.test("同一列不派兩件：原本的不參選重查排除新臂那幾筆（條件一模一樣）、登記後退選的、已照名冊補過那一欄的，其餘一字不差", async () => {
  const prev = await previousDefinition("contribution_auto_tasks_not_running");
  const now = ours("contribution_auto_tasks_not_running");
  const conditions = [
    // 新臂派的那幾筆：條件要跟新臂的 WHERE 一模一樣，不然會漏派或一個人派兩件
    "    AND NOT (pe.candidacy_status = 'withdrawn' AND pe.withdrawn_after_filing IS NULL)\n",
    // 登記後退選的本來就在名冊上：問「在不在名冊上」會被改回已登記，把退選這件事抹掉
    "    AND pe.withdrawn_after_filing IS NOT TRUE\n",
    // 代理已照名冊交更正補上這一欄（還原了就不算）
    "    AND NOT EXISTS (SELECT 1 FROM edit_history h\n" +
      "                     WHERE h.table_name = 'politician_elections' AND h.record_id = pe.id::TEXT\n" +
      "                       AND h.field = 'withdrawn_after_filing' AND h.reverted_at IS NULL)\n",
  ];
  for (const c of conditions) assert(now.includes(c), `少了：${c}`);
  assert(arm.includes("WHERE pe.candidacy_status = 'withdrawn' AND pe.withdrawn_after_filing IS NULL"), "兩支的條件要同一句");
  let stripped = now.replace(/    -- 退選前有沒有登記（#345 後續[^\n]*\n    -- 登記後退選的本來就在名冊上[^\n]*\n/, "");
  for (const c of conditions) stripped = stripped.replace(c, "");
  assertEquals(stripped, prev);
});

Deno.test("等票中的同一欄更正先不派；線索：還沒投票看登記名冊、已投票看中選會名單、以前重查過的附上", () => {
  assert(arm.includes(`c.payload->'changes' @> '[{"field":"withdrawn_after_filing"}]'::jsonb`));
  assert(/c\.status IN \('pending', 'verified'\)/.test(arm));
  assert(arm.includes("'roster' = ANY (v.provides)") && arm.includes("w.election_type = ANY (v.election_types)"));
  assert(arm.includes("FROM cec_candidates c") && arm.includes("c.name_norm = cec_name_key(x.name)"));
  assert(arm.includes("c.task_id = 'auto:not_running_recheck:' || w.pe_id"));
  assert(/c\.payload->>'outcome' = 'confirmed'/.test(arm));
});

Deno.test("派工臂有接進 contribution_auto_tasks_arms，其餘每一支照上一版", async () => {
  const prev = await previousDefinition("contribution_auto_tasks_arms");
  const now = ours("contribution_auto_tasks_arms");
  const line = "  UNION ALL SELECT * FROM contribution_auto_tasks_withdrawn_filing()\n";
  assert(now.includes(line));
  assertEquals(now.replace(line, ""), prev);
});

Deno.test("查證來源補 2026 直轄市長、縣市長的登記名冊：兩份加起來剛好 22 縣市各一次", () => {
  const inserts = sql.slice(sql.indexOf("INSERT INTO verification_sources"), sql.indexOf("ON CONFLICT (name) DO NOTHING"));
  const regionLists = [...inserts.matchAll(/ARRAY\[('[^\]]+')\],\s*\n\s*ARRAY\['縣市長'\]/g)].map((m) => m[1].split(",").map((x) => x.trim().replace(/'/g, "")));
  assertEquals(regionLists.length, 2);
  const all = regionLists.flat().sort();
  assertEquals(all, [...ALL_REGIONS].sort());
  assertEquals(new Set(all).size, all.length);
  assertEquals((inserts.match(/ARRAY\['candidacy', 'roster'\]/g) ?? []).length, 2);
  assertEquals((inserts.match(/https:\/\/web\.cec\.gov\.tw\/api\/file\/[0-9a-f-]+\.pdf/g) ?? []).length, 2);
});

// ── 交件：correction 開放 withdrawn_after_filing（協議 1.55.0） ─────────────────
const correctionBody = (changes: unknown[]) => ({
  agent_name: "tester",
  contribution_type: "correction",
  task_id: "auto:not_running_recheck:filing:35043",
  payload: { target_table: "politician_elections", target_id: "35043", reason: "吳怡農不在中選會 115 年直轄市長登記彙總表上", changes },
  source_urls: ["https://web.cec.gov.tw/api/file/bb9a8d7a-9b8a-41ec-8e23-33efd009385a.pdf"],
});

Deno.test("correction 可以改 withdrawn_after_filing：true／false 收，字串、空值不收，不能跟 candidate_status 同一筆", () => {
  assert(CORRECTION_FIELDS.politician_elections.includes("withdrawn_after_filing"));
  for (const v of [true, false]) {
    const r = validateContributionRequest(correctionBody([{ field: "withdrawn_after_filing", current_value: null, correct_value: v }]));
    assertEquals(r.ok, true, JSON.stringify(r.errors));
  }
  for (const v of ["false", "true", 0, null]) {
    const r = validateContributionRequest(correctionBody([{ field: "withdrawn_after_filing", current_value: null, correct_value: v }]));
    assertEquals(r.ok, false, `correct_value=${JSON.stringify(v)} 不該收`);
  }
  const both = validateContributionRequest(correctionBody([
    { field: "withdrawn_after_filing", current_value: null, correct_value: false },
    { field: "candidate_status", current_value: "not_running", correct_value: "registered" },
  ]));
  assertEquals(both.ok, false);
  assert(both.errors.some((e) => e.message.includes("不能跟 candidate_status 同一筆改")));
});

// ── 落庫 ─────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
function makeDb(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const updates: Array<{ table: string; patch: Row }> = [];
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => { filters.push((r) => String(r[col]) === String(val)); return api; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return api; },
      order: () => api,
      limit: () => api,
      maybeSingle: () => Promise.resolve({ data: (tables.get(table) ?? []).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      then: (res: (v: { data: Row[]; error: null }) => unknown) => res({ data: (tables.get(table) ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
      insert: (row: Row | Row[]) => {
        const arr = Array.isArray(row) ? row : [row];
        tables.set(table, [...(tables.get(table) ?? []), ...arr]);
        // deno-lint-ignore no-explicit-any
        const done: any = Promise.resolve({ error: null });
        done.select = () => ({ maybeSingle: () => Promise.resolve({ data: arr[0], error: null }) });
        return done;
      },
      upsert: () => Promise.resolve({ error: null }),
      update: (patch: Row) => ({
        eq: (col: string, val: unknown) => {
          updates.push({ table, patch });
          for (const r of tables.get(table) ?? []) if (String(r[col]) === String(val)) Object.assign(r, patch);
          return Promise.resolve({ error: null });
        },
      }),
    };
    return api;
  }
  // deno-lint-ignore no-explicit-any
  const client: any = { from, rpc: () => Promise.resolve({ data: null, error: null }) };
  return { client, tables, updates };
}

const base = { note: null, agent_name: "tester", contributor_url: null, source_urls: ["https://web.cec.gov.tw/api/file/bb9a8d7a-9b8a-41ec-8e23-33efd009385a.pdf"] };
const correctionRow = (correct_value: unknown) => ({
  ...base, id: "k1", contribution_type: "correction" as const, task_id: "auto:not_running_recheck:filing:35043",
  payload: { target_table: "politician_elections", target_id: "35043", reason: "吳怡農不在登記彙總表上",
             changes: [{ field: "withdrawn_after_filing", current_value: null, correct_value }] },
});

Deno.test("落庫：退選的那一列寫進 withdrawn_after_filing、留履歷可還原", async () => {
  const { client, tables } = makeDb({
    politician_elections: [{ id: 35043, election_id: 2026, election_type: "縣市長", candidate_status: "not_running", candidacy_status: "withdrawn", withdrawn_after_filing: null }],
  });
  const out = await applyContribution(client, correctionRow(false));
  assertEquals(out.status, "applied", String(out.message));
  assertEquals((tables.get("politician_elections") ?? [])[0].withdrawn_after_filing, false);
  const hist = (tables.get("edit_history") ?? []).filter((h) => h.field === "withdrawn_after_filing");
  assertEquals(hist.length, 1, "沒有履歷就不能還原");
});

Deno.test("落庫：等票期間這一列已經不是退選（有人補成已登記）→ superseded，不寫（不讓資料庫 CHECK 炸成一直重試）", async () => {
  const { client, tables, updates } = makeDb({
    politician_elections: [{ id: 35043, election_id: 2026, election_type: "縣市長", candidate_status: "registered", candidacy_status: "filed", withdrawn_after_filing: null }],
  });
  const out = await applyContribution(client, correctionRow(true));
  assertEquals(out.status, "superseded");
  assertEquals(updates.filter((u) => u.table === "politician_elections").length, 0);
  assertEquals((tables.get("politician_elections") ?? [])[0].withdrawn_after_filing, null);
});

Deno.test("不參選重查的章：整數 id 的任務 confirmed 才蓋；filing 那一種不蓋這個章", async () => {
  const noChange = (taskId: string) => ({
    ...base, id: "n1", contribution_type: "no_change" as const, task_id: taskId,
    payload: { task_id: taskId, outcome: "confirmed", finding: "對過中選會登記彙總表，沒有他", checked_urls: base.source_urls },
  });
  const a = makeDb({ politician_elections: [{ id: 35043, verified: false }], contribution_tasks: [] });
  const stamped = await applyContribution(a.client, noChange("auto:not_running_recheck:35043"));
  assertEquals(stamped.status, "applied", String(stamped.message));
  assertEquals((a.tables.get("politician_elections") ?? [])[0].verified, true);

  const b = makeDb({ politician_elections: [{ id: 35043, verified: false }], contribution_tasks: [] });
  await applyContribution(b.client, noChange("auto:not_running_recheck:filing:35043"));
  assertEquals(b.updates.filter((u) => u.table === "politician_elections" && u.patch.verified === true).length, 0);
});

// ── 任務現況與骨架 ───────────────────────────────────────────────────
const filingTarget = { kind: "withdrawn_filing", politician_election_id: 35043, politician_id: "00000000-0000-4000-8000-000000000001", name: "吳怡農", election_id: 2026, election_type: "縣市長" };

Deno.test("現況：filing 那一種給專用的 hint 與那一列參選紀錄；原本那種照舊", () => {
  const pe = { id: 35043, election_id: 2026, election_type: "縣市長", candidate_status: "not_running", candidacy_status: "withdrawn", withdrawn_after_filing: null, verified: false, source_note: "AI", region_id: 9 };
  const cur = shapeTaskCurrent("not_running_recheck", { politician: null, politician_election: pe }, { task_id: "auto:not_running_recheck:filing:35043", target: filingTarget });
  assertEquals(cur.hint, WITHDRAWN_FILING_HINT);
  assertEquals((cur.politician_election as Row).withdrawn_after_filing, null);
  assertEquals((cur.politician_election as Row).region_id, undefined, "只給看得懂的那幾欄");
  const plain = shapeTaskCurrent("not_running_recheck", { politician: null, politician_election: pe }, { task_id: "auto:not_running_recheck:35043", target: { politician_election_id: 35043 } });
  assertEquals(plain.hint, TASK_GUIDANCE.not_running_recheck);
  assert(isWithdrawnFilingTask("not_running_recheck", filingTarget));
  assertEquals(isWithdrawnFilingTask("candidacy_source_missing", filingTarget), false);
});

Deno.test("骨架：filing 那一種的 correction 預先填好要改的欄位與那一列 id", () => {
  const tpl = buildReportTemplate("not_running_recheck", "correction", filingTarget, "auto:not_running_recheck:filing:35043") as Row;
  const payload = tpl.payload as Row;
  assertEquals(payload.target_table, "politician_elections");
  assertEquals(payload.target_id, "35043");
  assertEquals(((payload.changes as Row[])[0]).field, "withdrawn_after_filing");
  assertStringIncludes(String(payload.reason), "吳怡農");
  // 原本那一種照舊是「要改的欄位」留白
  const plain = buildReportTemplate("not_running_recheck", "correction", { politician_election_id: 35043 }, "auto:not_running_recheck:35043") as Row;
  assertEquals(((plain.payload as Row).changes as Row[])[0].field, "（要改的欄位）");
});

Deno.test("貢獻摘要：退選前有沒有登記翻成網站上的說法", () => {
  const s = summarizeContribution({ contribution_type: "correction", payload: { target_table: "politician_elections", target_id: "35043", target_label: "吳怡農 2026 縣市長", changes: [{ field: "withdrawn_after_filing", correct_value: false }] } });
  assertStringIncludes(s.summary, "退選前有沒有登記");
  assertStringIncludes(s.summary, "表態不參選");
});

Deno.test("協議 1.55.0：correction 可改退選前有沒有登記、不參選重查的 filing 那一種寫進 skill.md", async () => {
  const [major, minor] = PROTOCOL_VERSION.split(".").map(Number);
  assert(major > 1 || (major === 1 && minor >= 55), `協議版號 ${PROTOCOL_VERSION} 比 1.55.0 舊`);
  const md = lf(await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url)));
  for (const s of ["politician_elections→candidate_status／position／election_type／withdrawn_after_filing", "**`withdrawn_after_filing`＝退選前有沒有登記過**（1.55.0）",
                   "auto:not_running_recheck:filing:", "不能跟 `candidate_status` 同一筆改", "`not_running_recheck`（1.55.0）給該筆參選紀錄"]) {
    assertStringIncludes(md, s);
  }
});

// ── 交件端：不是退選的那一列當場擋（不算被拒），是退選的照收 ───────────────────
function fakeSupabase(tables: Record<string, { data?: unknown[] }>) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      const result = { data: tables[table]?.data ?? [], error: null, count: 0 };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, is: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: (result.data as Array<Record<string, unknown>>)[0] ?? null, error: null }),
        insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
          const arr = Array.isArray(rows) ? rows : [rows];
          for (const r of arr) inserted.push({ table, row: r });
          return { select: () => ({ data: arr.map((r, i) => ({ id: `new-${i}`, payload_hash: (r as { payload_hash?: string }).payload_hash })), error: null }) };
        },
        delete: () => ({ in: () => ({ error: null }) }),
        then: (res: (v: typeof result) => unknown) => res(result),
      };
      return chain;
    },
  };
  return { client, inserted };
}
const noVote = () => Promise.resolve({ status: 403, body: { error: "self_vote" } });

Deno.test("交件：這一列不是退選 → 400 not_withdrawn（不算被拒）；是退選就照收", async () => {
  const req = correctionBody([{ field: "withdrawn_after_filing", current_value: null, correct_value: false }]);
  const filed = { politician_elections: { data: [{ id: 35043, election_id: 2026, candidacy_status: "filed", politicians: { name: "吳怡農" } }] } };
  const bad = await handleContribute(fakeSupabase(filed).client, "https://x", req, "ip-1", noVote);
  assertEquals(bad.status, 400, JSON.stringify(bad.body));
  assertEquals((bad.body as Record<string, unknown>).error, "not_withdrawn");
  const withdrawn = { politician_elections: { data: [{ id: 35043, election_id: 2026, candidacy_status: "withdrawn", politicians: { name: "吳怡農" } }] } };
  const { client, inserted } = fakeSupabase(withdrawn);
  const good = await handleContribute(client, "https://x", req, "ip-1", noVote);
  assertEquals(good.status, 201, JSON.stringify(good.body));
  assert(inserted.some((r) => r.table === "contributions"));
});
