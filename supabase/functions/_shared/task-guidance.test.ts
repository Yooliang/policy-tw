// 「這一種任務怎麼做」隨任務送出（2026-09-21 使用者：「它應該是領任務、回報，而不是自己去管理任務」）。
// 這支守的是刪掉 skill.md 那份 5,049 字元的型別目錄之後，沒有任何一種任務變成沒人交代。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildReportTemplate, DYNAMIC_GUIDANCE_TYPES, hasGuidance, PAYLOAD_SHAPE, rowIdFromTaskId, TASK_GUIDANCE } from "./task-guidance.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { shapeTaskCurrent } from "./task-context.ts";

// 這支原本查的是「有沒有登記在表裡」（hasGuidance），結果 not_running_recheck 登記在
// DYNAMIC_GUIDANCE_TYPES、卻沒有人真的組它的 hint——測試全綠，線上那一種任務沒有 hint。
// 跑任務的代理實測才發現（2026-09-21）。改成查實際輸出：註冊表不是事實，送出去的才是。
Deno.test("每一種任務型別都真的送得出做法——刪掉協議目錄的前提", () => {
  const empty = {} as Parameters<typeof shapeTaskCurrent>[1];
  for (const t of Object.keys(SUGGESTED_TYPE)) {
    assert(hasGuidance(t), `任務型別 ${t} 沒有登記做法：在 task-guidance.ts 補一條`);
    // 只問「送不送得出來」。長度門檻由上面那支管靜態表——依資料組的 hint 本來就可能短
    // （question 沒人答過時只有一句），短不是問題，空的才是。
    const hint = shapeTaskCurrent(t, empty).hint;
    assert(
      typeof hint === "string" && hint.trim().length > 0,
      `任務型別 ${t} 登記了卻送不出 hint（實際送出：${JSON.stringify(hint)}）——登記在 DYNAMIC_GUIDANCE_TYPES 卻沒有人組它，就是這種形狀`,
    );
  }
});

Deno.test("靜態表與動態組不重疊：同一種型別不該有兩份說法", () => {
  for (const t of DYNAMIC_GUIDANCE_TYPES) {
    assert(!(t in TASK_GUIDANCE), `${t} 的 hint 是依資料組的，不要在靜態表再寫一份——兩份會走鐘`);
  }
});

Deno.test("做法要講得夠具體，不能只有一句話", () => {
  for (const [t, text] of Object.entries(TASK_GUIDANCE)) {
    assert(text.length >= 40, `${t} 的說明只有 ${text.length} 字，太短了：要講清楚做什麼判斷、幾條路怎麼選`);
  }
});

// 使用者的原則：代理只做眼前這一筆，派工怎麼排是伺服器的事。
// 今天實測：一隻代理讀了協議對比例的說明，就連問四次「要不要先做 30 筆驗證來解鎖任務」，
// 一筆都沒做。給它方向盤它就會去轉。
Deno.test("做法裡不准出現派工管理的內容", () => {
  const FORBIDDEN = [
    ["3:1", "輪替比例"],
    ["輪替", "輪替比例"],
    ["解鎖", "派工節奏"],
    ["冷卻", "冷卻天數"],
    ["14 天", "冷卻天數"],
    ["額度", "每日額度"],
    ["排到後面", "派工排序"],
    ["排到隊伍", "派工排序"],
  ] as const;
  for (const [t, text] of Object.entries(TASK_GUIDANCE)) {
    for (const [word, why] of FORBIDDEN) {
      assert(!text.includes(word), `${t} 的說明提到「${word}」（${why}）——那是伺服器的事，代理知道了只會拿去算計`);
    }
  }
});

Deno.test("shapeTaskCurrent 會把做法附在任務上，而且不覆蓋依資料組的 hint", () => {
  const empty = {} as Parameters<typeof shapeTaskCurrent>[1];
  const gap = shapeTaskCurrent("profile_gap", empty);
  assertEquals(gap.hint, TASK_GUIDANCE.profile_gap, "靜態表的型別要拿到說明");
  assert(String(gap.hint).includes("120px"), "照片規格不能掉在地上——那是刪協議目錄時最容易漏的一段");

  const dup = shapeTaskCurrent("duplicate_policy", empty);
  assert(typeof dup.hint === "string" && dup.hint.length > 0, "依資料組的型別要有自己的 hint");
  assert(dup.hint !== TASK_GUIDANCE.duplicate_policy, "不該被靜態表覆蓋（靜態表根本不該有這一條）");

  assert("no_change_outcomes" in gap, "outcome 三選一仍然要附");
});

// payload 形狀是手寫的精簡版，必須跟 contribution-schema.ts 的必填清單對帳，
// 否則它就是第二份會走鐘的拷貝——而這次改動的整個目的就是消滅重複的真相。
async function requiredFieldsFromSchema(): Promise<Record<string, string[]>> {
  const src = await Deno.readTextFile(new URL("./contribution-schema.ts", import.meta.url));
  const out: Record<string, string[]> = {};
  for (const block of src.split('\n    case "').slice(1)) {
    const type = block.slice(0, block.indexOf('"'));
    const fields = [...new Set([...block.matchAll(/push\("payload\.([a-z_0-9]+)"/g)].map((m) => m[1]))];
    if (fields.length > 0) out[type] = fields;
  }
  return out;
}

Deno.test("每一種會被建議的貢獻型別，都要說得出 payload 長什麼樣", () => {
  for (const [taskType, contributionType] of Object.entries(SUGGESTED_TYPE)) {
    assert(
      PAYLOAD_SHAPE[contributionType],
      `任務 ${taskType} 建議用 ${contributionType} 回報，但沒有 payload 形狀可以送給代理——代理只能回頭翻協議或用猜的`,
    );
  }
});

/** 該型別的 case 區塊裡出現過的所有 payload 欄位（含選填，那些只有 p.xxx 沒有 push）。 */
async function allFieldsFromSchema(): Promise<Record<string, Set<string>>> {
  const src = await Deno.readTextFile(new URL("./contribution-schema.ts", import.meta.url));
  const out: Record<string, Set<string>> = {};
  for (const block of src.split(String.fromCharCode(10) + '    case "').slice(1)) {
    const type = block.slice(0, block.indexOf('"'));
    const direct = [...block.matchAll(/[^a-z]p[.]([a-z][a-z_0-9]*)/g)].map((m) => m[1]);
    // 選填欄位常寫成陣列再用 p[k] 取（const optional = ["position", "current_position", …]），
    // 只抓 p.xxx 會看不到它們。這裡不用正則，直接掃陣列字面值裡的字串。
    const viaArrays: string[] = [];
    for (const marker of ["const optional = [", "for (const k of ["]) {
      let at = block.indexOf(marker);
      while (at >= 0) {
        const close = block.indexOf("]", at);
        if (close < 0) break;
        for (const m of block.slice(at, close).matchAll(/"([a-z][a-z_0-9]*)"/g)) viaArrays.push(m[1]);
        at = block.indexOf(marker, close);
      }
    }
    out[type] = new Set([...direct, ...viaArrays]);
  }
  return out;
}

Deno.test("payload 形狀提到的欄位，schema 裡要真的有（拼錯的欄位名比沒寫更糟）", async () => {
  const all = await allFieldsFromSchema();
  assert(Object.keys(all).length >= 10, "從 schema 撈到的型別太少，正則可能失效了");
  // 不屬於 payload、但會出現在說明文字裡的詞
  // 值（outcome 的三選一、verdict 的兩選一）與 changes[] 的子欄位長得跟欄位名一樣，但不是 payload 的欄位
  const NOT_PAYLOAD = new Set([
    "source_urls", "current_value", "correct_value", "policies_total", "not_found",
  ]);
  for (const [type, shape] of Object.entries(PAYLOAD_SHAPE)) {
    const known = all[type];
    if (!known || known.size === 0) continue;
    for (const token of new Set(shape.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) ?? [])) {
      if (NOT_PAYLOAD.has(token)) continue;
      assert(
        known.has(token),
        `${type} 的 payload 形狀寫了 ${token}，但 contribution-schema.ts 的 ${type} 區塊沒有這個欄位——代理照著送會被忽略或擋下`,
      );
    }
  }
});

Deno.test("schema 的必填欄位，payload 形狀不可以漏講", async () => {
  const required = await requiredFieldsFromSchema();
  // 這些是「條件式必填」或「其一即可」，不強制每一個都寫進精簡版
  const OPTIONAL_IN_SHAPE: Record<string, string[]> = {
    candidacy: ["election_result", "votes_received", "vote_percentage", "cand_no", "position", "name"],
    policy: ["name"],
    politician: ["avatar_url"],
    adjudication: ["resolved_politician_id"],
    task_suggestion: ["target_policy_id", "target_politician_id", "hint_sources"],
    roster_check: ["note"],
    policy_progress: ["note", "date"],
  };
  for (const [type, fields] of Object.entries(required)) {
    const shape = PAYLOAD_SHAPE[type];
    if (!shape) continue;
    const skip = new Set(OPTIONAL_IN_SHAPE[type] ?? []);
    for (const f of fields) {
      if (skip.has(f)) continue;
      assert(shape.includes(f), `${type} 的必填欄位 ${f} 沒有寫進 payload 形狀——代理照形狀送會被 400 擋下`);
    }
  }
});

// payload 骨架（2026-09-21）：兩隻代理獨立實測都說「講得清做什麼、講不清怎麼交」。
// 用線上真的長相當樣本。第一版這裡寫的是自己編的 uuid，測試全綠，
// 但實際上 politician_elections.id 是整數（auto:candidate_status_stale:10009），
// 正則只認 uuid 所以解不出來——最該被填好的那一種反而填不出來。
Deno.test("candidate_status_stale 的骨架要填好 politician_elections 的 row id——代理不該猜複合鍵", () => {
  const tpl = buildReportTemplate("candidate_status_stale", "correction", {
    politician_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    election_id: 2026,
    election_type: "縣市長",
  }, "auto:candidate_status_stale:10009");
  assert(tpl, "要有骨架");
  assertEquals((tpl!.payload as Record<string, unknown>).target_table, "politician_elections");
  assertEquals((tpl!.payload as Record<string, unknown>).target_id, "10009", "參選紀錄的 id 是整數，但一律以字串送（schema 收字串）");
  assert(Array.isArray((tpl!.payload as Record<string, unknown>).changes), "correction 要有 changes 陣列");
});

Deno.test("政見類的 correction 指到 policies，而且用 target 裡的 policy_id", () => {
  const tpl = buildReportTemplate("policy_election_mismatch", "correction", { policy_id: "pol-1" }, "auto:policy_election_mismatch:pol-1");
  assertEquals((tpl!.payload as Record<string, unknown>).target_table, "policies");
  assertEquals((tpl!.payload as Record<string, unknown>).target_id, "pol-1");
});

Deno.test("no_change 的骨架帶著 task_id 與三選一的 outcome", () => {
  const tpl = buildReportTemplate("legacy_audit", "no_change", {}, "auto:legacy_audit:abc");
  assertEquals((tpl!.payload as Record<string, unknown>).task_id, "auto:legacy_audit:abc");
  assert(String((tpl!.payload as Record<string, unknown>).outcome).includes("unreachable"), "三個值都要列出來，代理才知道有哪些路");
});

Deno.test("shapeTaskCurrent 帶了 task 才給骨架，沒帶就不給（不要送半成品）", () => {
  const empty = {} as Parameters<typeof shapeTaskCurrent>[1];
  assert(!("report_template" in shapeTaskCurrent("candidate_status_stale", empty)));
  const withTask = shapeTaskCurrent("candidate_status_stale", empty, {
    task_id: "auto:candidate_status_stale:38d16e30-26e3-4c50-9a71-4168116b5f1c",
    target: { politician_id: "p" },
  });
  assert("report_template" in withTask, "帶了 task 就要給骨架");
});

Deno.test("rowIdFromTaskId 認 uuid 也認整數，但不亂解不是單一列的", () => {
  // policies 是 uuid
  assertEquals(rowIdFromTaskId("auto:legacy_audit:38d16e30-26e3-4c50-9a71-4168116b5f1c"), "38d16e30-26e3-4c50-9a71-4168116b5f1c");
  // politician_elections 是整數（線上實測）
  assertEquals(rowIdFromTaskId("auto:candidate_status_stale:10009"), "10009");
  // 多段的指的是一對，不是單一列——填進 target_id 會是錯的
  assertEquals(rowIdFromTaskId("auto:duplicate_policy:46b9a63f-e5ec-4a7b-b9dc-3624235780e0:6df0e0f3"), null);
  assertEquals(rowIdFromTaskId("auto:legacy_audit:not-an-id"), null);
  assertEquals(rowIdFromTaskId("38d16e30-26e3-4c50-9a71-4168116b5f1c"), null, "手動任務的 id 不是這個格式");
  assertEquals(rowIdFromTaskId(null), null);
});

// 2026-09-21 對照實驗：三筆照第一版骨架填完，全部被同一個 400 擋下
// （source_urls 必填，至少一個可打開的來源網址）；同樣的內容只把 source_urls
// 移到頂層就全部 201。骨架給了信裡的內容卻沒給信封。
Deno.test("骨架是整個 request，而且 source_urls 在頂層不在 payload 裡", () => {
  for (const [taskType, ctype] of [
    ["candidate_status_stale", "correction"],
    ["policy_missing", "policy"],
    ["legacy_audit", "no_change"],
  ] as const) {
    const tpl = buildReportTemplate(taskType, ctype, { politician_id: "p", policy_id: "pl" }, `auto:${taskType}:10009`);
    assert(tpl, `${taskType} 要有骨架`);
    assert(Array.isArray(tpl!.source_urls), `${taskType} 的骨架要有頂層 source_urls——這是實測最常被擋下的一欄`);
    assert(!("source_urls" in (tpl!.payload as Record<string, unknown>)), `${taskType} 的 source_urls 不可以放進 payload 裡，位置錯了一樣被擋`);
    assertEquals(tpl!.contribution_type, ctype);
    assertEquals(tpl!.kind, "contribute", "代理要知道這是往 /report 送的哪一種");
    assert("agent_name" in tpl!, "信封要提醒帶代號");
  }
});

Deno.test("參選狀態的合法值要在骨架裡，不能只留在散文", () => {
  const tpl = buildReportTemplate("candidacy_source_missing", "candidacy", { region: "台北市" }, "abc");
  const status = String((tpl!.payload as Record<string, unknown>).candidate_status);
  for (const v of ["registered", "not_running", "qualified"]) {
    assert(status.includes(v), `合法值 ${v} 沒有出現在骨架裡`);
  }
});
