/**
 * 參選狀態合一欄 candidacy_status 的守門（#345 第一階段 migration 20261006034500；第二階段 B 20261007140000 刪了舊兩欄與雙向同步）。
 *
 * 第二階段 B 之前這支還守「SQL 的舊兩欄對應規則跟 TS 鏡像逐一一致」「先回填、再掛觸發器」「雙向同步觸發器」——
 * 那些規則隨舊欄位一起刪了（candidacyStatusFromLegacy 與 SQL candidacy_status_from_legacy／legacy_status_from_candidacy 都不在了），
 * 對應的測試也一併拿掉；刪除本身由 candidacy-drop-legacy.test.ts 守。這裡留下還活著的：
 *   1. 不收傳聞：六值裡沒有傳聞
 *   2. CHECK 只收六值，跟 TS 清單一致
 *   3. nextCandidacyStatus：落庫端把協議的詞換成新欄位值
 *   4. protocolStatusFromCandidacy 跟 SQL candidacy_protocol_status 逐項一致
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { CANDIDACY_STATUS_LABELS, CANDIDACY_STATUSES, isListPublished, nextCandidacyStatus, protocolStatusFromCandidacy, resultOfCandidacyStatus, taipeiToday } from "./candidacy-status.ts";

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

Deno.test("不收傳聞：六值裡沒有傳聞", () => {
  assertEquals(CANDIDACY_STATUSES.some((s) => /rumo/.test(s)), false);
  assertEquals(Object.values(CANDIDACY_STATUS_LABELS).some((l) => l.includes("傳聞")), false);
});

Deno.test("名單公告日來自名單清查設定表；已投票也算（candidacy_list_published）", () => {
  const listed = between(body, "CREATE OR REPLACE FUNCTION candidacy_list_published(", "COMMENT ON FUNCTION candidacy_list_published");
  assertMatch(listed, /e\.election_date <= p_on/);
  assertMatch(listed, /s\.list_announced_on <= p_on/);
});

Deno.test("CHECK 只收六值，跟 TS 清單一致", () => {
  const m = body.match(/CHECK \(candidacy_status IS NULL OR candidacy_status IN \(([^)]*)\)\)/);
  assert(m, "找不到 candidacy_status 的 CHECK");
  assertEquals(m![1].split(",").map((v) => v.trim().replace(/'/g, "")), [...CANDIDACY_STATUSES]);
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
