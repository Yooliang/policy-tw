/**
 * 參選狀態合一欄 candidacy_status 的守門（#345 第一階段，migration 20261006034500）。
 *
 * SQL 另外在 PGlite（WASM Postgres）灌 10-06 線上唯讀快照實跑過（見 PR 說明）；這裡沒有資料庫，守住：
 *   1. SQL 的對應規則（candidacy_status_from_legacy）跟 TS 鏡像逐一一致——直接讀 migration 的 CASE 來算
 *   2. 不收傳聞：rumored 對到 NULL；六值裡沒有傳聞
 *   3. 先回填、再掛觸發器（反過來的話，回填會被觸發器當成「只改新欄位」、回頭改舊欄位）
 *   4. 觸發器：舊欄位有變以舊欄位為準；只有新欄位變才回寫舊欄位；清成 NULL 會重算
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { CANDIDACY_STATUS_LABELS, CANDIDACY_STATUSES, candidacyStatusFromLegacy, isListPublished, nextCandidacyStatus, protocolStatusFromCandidacy, resultOfCandidacyStatus, taipeiToday } from "./candidacy-status.ts";

const sql = await Deno.readTextFile(new URL("../../migrations/20261006034500_candidacy_status.sql", import.meta.url));
/** 去掉 SQL 註解（Windows 檢出是 CRLF，先切掉 \r） */
const code = (s: string) => s.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  assert(j >= 0, `找不到「${end}」`);
  return text.slice(i, j);
}
const body = code(sql);
const fromLegacy = between(body, "CREATE OR REPLACE FUNCTION candidacy_status_from_legacy(", "COMMENT ON FUNCTION candidacy_status_from_legacy");
const reverse = between(body, "CREATE OR REPLACE FUNCTION legacy_status_from_candidacy(", "COMMENT ON FUNCTION legacy_status_from_candidacy");
const trigger = between(body, "CREATE OR REPLACE FUNCTION sync_candidacy_status()", "COMMENT ON FUNCTION sync_candidacy_status");

/** 照 SQL 的 CASE 一條一條比（第一條成立的算數），算出 SQL 會給的值 */
type Rule = { col: "p_election_result" | "p_candidate_status"; values: string[]; then: string | { listed: string; unlisted: string } };
function sqlRules(): Rule[] {
  const re = /WHEN (p_election_result|p_candidate_status) (?:= '(\w+)'|IN \(([^)]*)\)) THEN (?:'(\w+)'|CASE WHEN COALESCE\(p_list_published, false\) THEN '(\w+)' ELSE '(\w+)' END)/g;
  const rules: Rule[] = [];
  for (const m of fromLegacy.matchAll(re)) {
    const values = m[2] ? [m[2]] : m[3].split(",").map((v) => v.trim().replace(/'/g, ""));
    rules.push({ col: m[1] as Rule["col"], values, then: m[4] ?? { listed: m[5], unlisted: m[6] } });
  }
  return rules;
}
function sqlEval(rules: Rule[], cs: string | null, er: string | null, listed: boolean): string | null {
  for (const r of rules) {
    const v = r.col === "p_election_result" ? er : cs;
    if (v !== null && r.values.includes(v)) return typeof r.then === "string" ? r.then : listed ? r.then.listed : r.then.unlisted;
  }
  return null;
}

const CANDIDATE_STATUSES_ALL = ["rumored", "likely", "confirmed", "registered", "qualified", "not_running", "elected", "defeated", null];
const ELECTION_RESULTS_ALL = ["elected", "not_elected", "withdrawn", "pending", null];

Deno.test("SQL 與 TS 的對應規則逐一一致（舊兩欄所有組合 × 名單公告與否）", () => {
  const rules = sqlRules();
  assert(rules.length >= 9, `SQL 的 CASE 只抓到 ${rules.length} 條，寫法變了要跟著改這支測試`);
  assertMatch(fromLegacy, /ELSE NULL\s+END/, "SQL 對不上的要回 NULL");
  for (const listed of [false, true]) {
    for (const cs of CANDIDATE_STATUSES_ALL) {
      for (const er of ELECTION_RESULTS_ALL) {
        assertEquals(candidacyStatusFromLegacy(cs, er, listed), sqlEval(rules, cs, er, listed), `${cs}／${er}／名單${listed ? "已" : "未"}公告`);
      }
    }
  }
});

Deno.test("不收傳聞：rumored 對到 NULL，六值裡沒有傳聞", () => {
  assertEquals(candidacyStatusFromLegacy("rumored", null, false), null);
  assertEquals(candidacyStatusFromLegacy("rumored", null, true), null);
  assertEquals(CANDIDACY_STATUSES.some((s) => /rumo/.test(s)), false);
  assertEquals(Object.values(CANDIDACY_STATUS_LABELS).some((l) => l.includes("傳聞")), false);
  // 但已經有選舉結果的，結果照算（結果是事實，不是傳聞）
  assertEquals(candidacyStatusFromLegacy("rumored", "elected", false), "elected");
});

Deno.test("confirmed 看名單公告了沒：公告前是表明參選，公告後（或已投票）是已登記", () => {
  assertEquals(candidacyStatusFromLegacy("confirmed", null, false), "declared");
  assertEquals(candidacyStatusFromLegacy("confirmed", null, true), "filed");
  // 名單公告日來自名單清查設定表；已投票也算
  const listed = between(body, "CREATE OR REPLACE FUNCTION candidacy_list_published(", "COMMENT ON FUNCTION candidacy_list_published");
  assertMatch(listed, /e\.election_date <= p_on/);
  assertMatch(listed, /s\.list_announced_on <= p_on/);
});

Deno.test("CHECK 只收六值，跟 TS 清單一致", () => {
  const m = body.match(/CHECK \(candidacy_status IS NULL OR candidacy_status IN \(([^)]*)\)\)/);
  assert(m, "找不到 candidacy_status 的 CHECK");
  assertEquals(m![1].split(",").map((v) => v.trim().replace(/'/g, "")), [...CANDIDACY_STATUSES]);
});

Deno.test("先回填、再掛觸發器", () => {
  const backfill = body.indexOf("SET candidacy_status = candidacy_status_from_legacy(");
  const createTrigger = body.indexOf("CREATE TRIGGER trg_sync_candidacy_status");
  assert(backfill > 0 && createTrigger > 0);
  assert(backfill < createTrigger, "回填要在掛觸發器之前");
  // 回填後自己核一次，對不上整支退回
  assertMatch(body, /RAISE EXCEPTION '#345 candidacy_status 回填後還有 % 筆跟規則對不上'/);
});

Deno.test("觸發器：舊欄位有變以舊欄位為準；只有新欄位變才回寫舊欄位；清成 NULL 會重算", () => {
  assertMatch(body, /BEFORE INSERT OR UPDATE OF candidate_status, election_result, candidacy_status ON politician_elections/);
  // 判斷完「誰變了」之後的第一個分支就是舊欄位那條，回寫舊欄位是 ELSIF
  assertMatch(trigger, /END IF;\s+IF v_legacy_changed OR \(v_new_changed AND NEW\.candidacy_status IS NULL\) THEN\s+NEW\.candidacy_status := candidacy_status_from_legacy\(NEW\.candidate_status, NEW\.election_result, v_listed\);\s+ELSIF v_new_changed THEN/, "舊欄位那條要先判斷");
  assertMatch(trigger, /NEW\.candidate_status IS DISTINCT FROM OLD\.candidate_status\s+OR NEW\.election_result IS DISTINCT FROM OLD\.election_result/);
  // 新增時沒給新欄位＝現在的寫入端，照舊欄位算
  assertMatch(trigger, /v_new_changed := NEW\.candidacy_status IS NOT NULL;\s+v_legacy_changed := NOT v_new_changed;/);
});

Deno.test("回寫舊欄位：本來就對得上的不動（qualified 不會被改成 registered）", () => {
  assertMatch(reverse, /candidacy_status_from_legacy\(p_candidate_status, p_election_result, p_list_published\) IS NOT DISTINCT FROM p_candidacy_status THEN\s+RETURN;/);
  assertMatch(reverse, /p_candidate_status NOT IN \('registered', 'qualified'\) THEN\s+candidate_status := 'registered';/);
  // 退選＝表態不參選（apply 端早就把 withdrawn 落成 not_running）
  assertMatch(reverse, /WHEN 'withdrawn' THEN\s+election_result := NULL;\s+candidate_status := 'not_running';/);
});

Deno.test("新→舊→新：六值在名單未公告時都回到原值（TS 規則模擬 SQL 的回寫）", () => {
  // 回寫規則照 migration：elected/not_elected → 結果欄；withdrawn → not_running；filed → registered；declared → confirmed；considering → likely
  const back: Record<string, [string, string | null]> = {
    elected: ["confirmed", "elected"], not_elected: ["confirmed", "not_elected"], withdrawn: ["not_running", null],
    filed: ["registered", null], declared: ["confirmed", null], considering: ["likely", null],
  };
  for (const s of CANDIDACY_STATUSES) {
    const [cs, er] = back[s];
    assertEquals(candidacyStatusFromLegacy(cs, er, false), s, s);
    assertMatch(reverse, new RegExp(`'${cs}'`), `回寫 ${s} 要寫 ${cs}`);
  }
});

// ── #345 第二階段 A：落庫端把協議的詞換成新欄位 ──
Deno.test("nextCandidacyStatus：協議的詞 → 新欄位六值；傳聞與空值不收（回 null）", () => {
  const next = (candidateStatus: string | null, listPublished = false, existing: string | null = null, electionResult: string | null = null) =>
    nextCandidacyStatus({ candidateStatus, electionResult, listPublished, existing }).status;
  assertEquals(next("registered"), "filed");
  assertEquals(next("qualified"), "filed");
  assertEquals(next("not_running"), "withdrawn");
  assertEquals(next("withdrawn"), "withdrawn");
  assertEquals(next("likely"), "considering");
  assertEquals(next("elected"), "elected");
  assertEquals(next("defeated"), "not_elected");
  assertEquals(next("rumored"), null, "不收傳聞");
  assertEquals(next(null), null);
  assertEquals(next("亂寫的"), null);
});

Deno.test("nextCandidacyStatus：confirmed 只表示表態參選；名單公告後在名單上的記成已登記；原本就是表態參選的原樣重交不改", () => {
  assertEquals(nextCandidacyStatus({ candidateStatus: "confirmed", listPublished: false }), { status: "declared", converted: false });
  assertEquals(nextCandidacyStatus({ candidateStatus: "confirmed", listPublished: true }), { status: "filed", converted: true });
  assertEquals(nextCandidacyStatus({ candidateStatus: "confirmed", listPublished: true, existing: "considering" }), { status: "filed", converted: true });
  // 早期匯入、公告前寫的表態參選：補選區任務叫代理「照現況填」，不能因為一件不相干的任務把它改掉
  assertEquals(nextCandidacyStatus({ candidateStatus: "confirmed", listPublished: true, existing: "declared" }), { status: "declared", converted: false });
  // 已經是已登記（早期匯入的 confirmed 在名單公告後就讀成已登記）：值沒變，也不用講「換成」
  assertEquals(nextCandidacyStatus({ candidateStatus: "confirmed", listPublished: true, existing: "filed" }), { status: "filed", converted: false });
  // 其他狀態不受名單公告影響
  for (const s of ["registered", "qualified", "not_running", "withdrawn"]) {
    assertEquals(nextCandidacyStatus({ candidateStatus: s, listPublished: true }).converted, false, s);
  }
});

Deno.test("nextCandidacyStatus：結果比登記階段與不參選都大——有給結果就是結果；原本已有結果、這次沒給結果就維持", () => {
  assertEquals(nextCandidacyStatus({ candidateStatus: "qualified", electionResult: "elected", listPublished: true }).status, "elected");
  assertEquals(nextCandidacyStatus({ candidateStatus: "confirmed", electionResult: "not_elected", listPublished: true, existing: "filed" }).status, "not_elected");
  // 改結果：給新結果就改（原本當選、這次交落選）
  assertEquals(nextCandidacyStatus({ candidateStatus: "qualified", electionResult: "not_elected", listPublished: true, existing: "elected" }).status, "not_elected");
  // 沒給結果：「照現況填 registered」「改成 confirmed」「改成 not_running」都不能把已經標好的結果蓋掉（舊兩欄就是這樣：election_result 優先）
  for (const cs of ["registered", "qualified", "confirmed", "not_running", "likely"]) {
    assertEquals(nextCandidacyStatus({ candidateStatus: cs, listPublished: true, existing: "elected" }).status, "elected", cs);
    assertEquals(nextCandidacyStatus({ candidateStatus: cs, listPublished: false, existing: "not_elected" }).status, "not_elected", cs);
  }
});

Deno.test("nextCandidacyStatus 跟舊的雙向規則一致：新欄位寫下去之後，舊兩欄的對應不會把它讀成別的", () => {
  // 協議的詞 + 結果 → 新欄位 → 觸發器回寫舊兩欄 → 再讀回來，要是同一個值（名單未公告時；confirmed 公告後本來就換成 filed）
  for (const cs of ["confirmed", "registered", "qualified", "not_running", "likely"]) {
    for (const er of [null, "elected", "not_elected"]) {
      const written = nextCandidacyStatus({ candidateStatus: cs, electionResult: er, listPublished: false }).status;
      assertEquals(written, candidacyStatusFromLegacy(cs, er, false), `${cs}／${er}`);
    }
  }
});

Deno.test("protocolStatusFromCandidacy：新欄位 → 協議的詞（派工說明「candidate_status 照現況填」）；SQL 同名函式逐項一致", async () => {
  assertEquals(protocolStatusFromCandidacy("withdrawn", false), "not_running");
  assertEquals(protocolStatusFromCandidacy("declared", true), "confirmed");
  assertEquals(protocolStatusFromCandidacy("filed", false), "registered", "名單公告前填 registered");
  assertEquals(protocolStatusFromCandidacy("filed", true), "qualified", "名單公告後填 qualified（confirmed 只表示表態參選）");
  assertEquals(protocolStatusFromCandidacy("elected", false), "qualified");
  assertEquals(protocolStatusFromCandidacy("not_elected", true), "qualified");
  assertEquals(protocolStatusFromCandidacy("considering", false), "likely");
  assertEquals(protocolStatusFromCandidacy(null, false), "rumored", "空值是現況的描述，不是可以交的值");
  // SQL 那一支（migration 20261006220000）：每個 WHEN 的對應都要跟 TS 一樣
  const mig = (await Deno.readTextFile(new URL("../../migrations/20261006220000_candidacy_read_side.sql", import.meta.url))).replaceAll("\r\n", "\n");
  const fn = code(between(mig, "CREATE OR REPLACE FUNCTION candidacy_protocol_status(", "COMMENT ON FUNCTION candidacy_protocol_status"));
  for (const [status, listed, want] of [
    ["withdrawn", false, "not_running"], ["declared", false, "confirmed"], ["filed", false, "registered"], ["filed", true, "qualified"],
    ["elected", false, "qualified"], ["not_elected", false, "qualified"], ["considering", false, "likely"],
  ] as const) {
    assertEquals(protocolStatusFromCandidacy(status, listed), want);
    assertMatch(fn, new RegExp(`WHEN '${status}' THEN .*'${want}'`), `SQL 的 ${status} 要對到 ${want}`);
  }
  assertMatch(fn, /WHEN 'filed' THEN CASE WHEN COALESCE\(p_list_published, false\) THEN 'qualified' ELSE 'registered' END/);
  assertMatch(fn, /ELSE 'rumored'/);
});

Deno.test("resultOfCandidacyStatus：只有當選、落選算結果", () => {
  assertEquals(resultOfCandidacyStatus("elected"), "elected");
  assertEquals(resultOfCandidacyStatus("not_elected"), "not_elected");
  for (const s of ["filed", "declared", "considering", "withdrawn", null, undefined]) assertEquals(resultOfCandidacyStatus(s), null);
});

Deno.test("isListPublished：問 SQL 的 candidacy_list_published；查不到一律當沒公告", async () => {
  const calls: unknown[] = [];
  const yes = { rpc: (n: string, a: unknown) => { calls.push([n, a]); return Promise.resolve({ data: true, error: null }); } };
  assertEquals(await isListPublished(yes, 2026, "縣市議員", "2026-11-17"), true);
  assertEquals(calls[0], ["candidacy_list_published", { p_election_id: 2026, p_election_type: "縣市議員", p_on: "2026-11-17" }]);
  assertEquals(await isListPublished({ rpc: () => Promise.resolve({ data: null, error: { message: "x" } }) }, 2026, "縣市議員"), false);
  assertEquals(await isListPublished({ rpc: () => Promise.reject(new Error("down")) }, 2026, "縣市議員"), false);
  assertEquals(await isListPublished({}, 2026, "縣市議員"), false);
  assertEquals(await isListPublished(yes, 2026, null), false);
  assertEquals(taipeiToday(new Date("2026-11-16T16:30:00Z")), "2026-11-17", "台灣日期：UTC 16:30 已經是隔天");
});
