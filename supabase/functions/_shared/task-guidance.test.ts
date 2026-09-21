// 「這一種任務怎麼做」隨任務送出（2026-09-21 使用者：「它應該是領任務、回報，而不是自己去管理任務」）。
// 這支守的是刪掉 skill.md 那份 5,049 字元的型別目錄之後，沒有任何一種任務變成沒人交代。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { DYNAMIC_GUIDANCE_TYPES, hasGuidance, PAYLOAD_SHAPE, TASK_GUIDANCE } from "./task-guidance.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { shapeTaskCurrent } from "./task-context.ts";

Deno.test("每一種任務型別都交代得出怎麼做——刪掉協議目錄的前提", () => {
  for (const t of Object.keys(SUGGESTED_TYPE)) {
    assert(hasGuidance(t), `任務型別 ${t} 沒有做法可以送給代理：在 task-guidance.ts 補一條，或（依當筆資料而變的）在 task-context.ts 組 hint 並登記到 DYNAMIC_GUIDANCE_TYPES`);
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
