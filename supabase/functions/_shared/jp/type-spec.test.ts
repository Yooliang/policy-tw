/**
 * 日本站型別規格隨派工送出（日本協議 0.29.0，policy-ops#178 D）的守門。
 * 原文在 policy-jp 的 public/skill-types.md，這裡只有產物，所以不比對原文；守的是：
 *   - 產物記的手引き版 ＝ JP_PROTOCOL_VERSION（兩邊同批上線，版本對不上就紅）
 *   - 標記只用真的任務型別（JP_TASK_ARMS）與交件型別（JP_CONTRIBUTION_TYPES）
 *   - 每一種交件型別（no_change 除外）都有段落；每一種自動任務型別都附得到至少一段，且附得到它答案型別的段落
 *   - 驗證附被驗的那一型；jp-next 三處回應都有 type_spec
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { JP_TYPE_SPEC_BLOCKS, JP_TYPE_SPEC_VERSION } from "./type-spec.gen.ts";
import { typeSpecForJpTask, typeSpecForJpVerify } from "./type-spec-for.ts";
import { JP_CONTRIBUTION_TYPES, JP_TASK_ALSO, JP_TASK_ARMS } from "./contribution-schema.ts";
import { JP_PROTOCOL_VERSION } from "./protocol.ts";
import { renderJpTypeSpecModule, specVersionOf } from "../../../../scripts/gen-jp-type-spec.ts";
import { parseTypeSpec } from "../type-spec.ts";

const TASKS = Object.keys(JP_TASK_ARMS);

Deno.test("產物記的手引き版 ＝ JP_PROTOCOL_VERSION（手引き先、jp-next 後，同批升版）", () => {
  assertEquals(JP_TYPE_SPEC_VERSION, JP_PROTOCOL_VERSION);
});

Deno.test("標記只用真的型別，每段至少一個鍵、內容不空", () => {
  for (const b of JP_TYPE_SPEC_BLOCKS) {
    assert(b.tasks.length + b.contributions.length > 0, b.text.slice(0, 40));
    assert(b.text.length > 0);
    for (const t of b.tasks) assert(TASKS.includes(t), `任務型別不存在：${t}`);
    for (const c of b.contributions) assert((JP_CONTRIBUTION_TYPES as readonly string[]).includes(c), `交件型別不存在：${c}`);
  }
});

Deno.test("每一種交件型別都有段落（no_change 在 skill.md）", () => {
  for (const c of JP_CONTRIBUTION_TYPES) {
    if (c === "no_change") continue;
    assert(JP_TYPE_SPEC_BLOCKS.some((b) => b.contributions.includes(c)), `${c} 沒有段落`);
  }
});

Deno.test("每一種自動任務型別都附得到段落，並含它答案型別的欄位說明", () => {
  for (const t of TASKS) {
    const spec = typeSpecForJpTask(t);
    assert(spec !== null, `${t} 附不到任何段落`);
    const answer = (JP_TASK_ARMS as Record<string, string>)[t];
    const expected = selectBlocks(answer);
    assert(expected.length > 0, `${answer} 沒有段落`);
    for (const text of expected) assertStringIncludes(spec!, text);
    for (const also of JP_TASK_ALSO[t] ?? []) for (const text of selectBlocks(also)) assertStringIncludes(spec!, text);
  }
});

function selectBlocks(contribution: string): string[] {
  return JP_TYPE_SPEC_BLOCKS.filter((b) => b.contributions.includes(contribution)).map((b) => b.text);
}

Deno.test("任務只附自己用得到的：政策任務不帶 candidacy 欄位表，名簿任務帶", () => {
  const policy = typeSpecForJpTask("policy_missing")!;
  assertStringIncludes(policy, "**`policy`**（公約）");
  assert(!policy.includes("**`candidacy`**（立候補者"));
  const roster = typeSpecForJpTask("roster_check")!;
  assertStringIncludes(roster, "**`candidacy`**（立候補者");
  assertStringIncludes(roster, "### 8.13 任務 `roster_check`");
  assertEquals(typeSpecForJpTask(null), null);
  assertEquals(typeSpecForJpTask("some_manual_free_type"), null);
});

Deno.test("驗證附被驗的那一型；no_change 不附", () => {
  assertStringIncludes(typeSpecForJpVerify("politician_avatar")!, "avatar_missing");
  assertStringIncludes(typeSpecForJpVerify("lineage_handover")!, "lineage_handover");
  assertEquals(typeSpecForJpVerify("no_change"), null);
  assertEquals(typeSpecForJpVerify(null), null);
});

Deno.test("產生器：版本與標記解析、缺版號就拒絕", async () => {
  const md = "手引きの版：9.9.9\n\n<!-- spec task: policy_missing -->\n本文\n";
  assertEquals(specVersionOf(md), "9.9.9");
  const out = await renderJpTypeSpecModule(md);
  assertStringIncludes(out, 'JP_TYPE_SPEC_VERSION = "9.9.9"');
  assertEquals(parseTypeSpec(md).length, 1);
  let threw = false;
  try { specVersionOf("沒有版號"); } catch { threw = true; }
  assert(threw);
});

Deno.test("jp-next 三處回應（驗證、手動任務、自動任務）都帶 type_spec", async () => {
  const src = await Deno.readTextFile(new URL("../../jp-next/index.ts", import.meta.url));
  assertEquals((src.match(/type_spec: typeSpecForJp(Task|Verify)\(/g) ?? []).length, 3);
});
