/**
 * 型別規格隨派工送出（協議 1.93.0）的守門：
 *   - skill-types.md 與產物 type-spec.gen.ts 一致（改了原文沒重產就紅）
 *   - 標記只用得到真的型別；每一種會落庫的交件型別都有自己的段落
 *   - 搬走的段落不再留在 skill.md（兩份會走鐘）
 *   - 任務附得到它可能收尾的每一種型別、驗證附得到被驗的那一型
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { parseTypeSpec } from "./type-spec.ts";
import { TYPE_SPEC_BLOCKS } from "./type-spec.gen.ts";
import { typeSpecForTask, typeSpecForVerify } from "./type-spec-for.ts";
import { CONTRIBUTION_TYPES, TASK_TYPES } from "./contribution-schema.ts";
import { renderTypeSpecModule } from "../../../scripts/gen-type-spec.ts";

const typesMd = await Deno.readTextFile(new URL("../../../public/skill-types.md", import.meta.url));
const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
const gen = await Deno.readTextFile(new URL("./type-spec.gen.ts", import.meta.url));

Deno.test("產物與原文一致：改了 public/skill-types.md 要跑 scripts/gen-type-spec.ts", () => {
  assertEquals(gen, renderTypeSpecModule(typesMd));
  assertEquals(TYPE_SPEC_BLOCKS.length, parseTypeSpec(typesMd).length);
});

Deno.test("標記只用真的型別，每段至少一個鍵、內容不空", () => {
  for (const b of TYPE_SPEC_BLOCKS) {
    assert(b.tasks.length + b.contributions.length > 0, b.text.slice(0, 40));
    assert(b.text.length > 0);
    for (const t of b.tasks) assert((TASK_TYPES as readonly string[]).includes(t), `任務型別不存在：${t}`);
    for (const c of b.contributions) assert((CONTRIBUTION_TYPES as readonly string[]).includes(c), `交件型別不存在：${c}`);
  }
});

Deno.test("每一種交件型別都有段落（no_change 在 skill.md、adjudication 已退場）", () => {
  for (const c of CONTRIBUTION_TYPES) {
    if (c === "no_change" || c === "adjudication") continue;
    assert(TYPE_SPEC_BLOCKS.some((b) => b.contributions.includes(c)), `${c} 沒有段落`);
  }
});

Deno.test("搬走的段落不留在 skill.md；skill.md 講得出 type_spec 與總表在哪", () => {
  for (const b of TYPE_SPEC_BLOCKS) {
    const head = b.text.split("\n")[0];
    assert(!skill.includes(head), `skill.md 還有：${head.slice(0, 60)}`);
  }
  assertStringIncludes(skill, "item.type_spec");
  assertStringIncludes(skill, "skill-types.md");
  // no_change 與 outcome 每一件都可能用到，留在共通規則
  assertStringIncludes(skill, "**`no_change`**");
  assertStringIncludes(skill, "**`outcome` 三選一");
});

Deno.test("任務附這種任務的做法＋可能收尾的型別；驗證附被驗的那一型", () => {
  const policy = typeSpecForTask("policy_missing")!;
  assertStringIncludes(policy, "**`policy`**");
  assert(!policy.includes("**`candidacy`**"));
  const roster = typeSpecForTask("roster_check")!;
  assertStringIncludes(roster, "### 清查某縣市的候選人名單");
  assertStringIncludes(roster, "**`candidacy`**");
  const avatar = typeSpecForTask("avatar_choice")!;
  assertStringIncludes(avatar, "### 照片二選一");
  assertStringIncludes(avatar, "**`correction`**");
  assertStringIncludes(typeSpecForVerify("correction")!, "**`correction`**");
  assertStringIncludes(typeSpecForVerify("lineage_handover")!, "**政策脈絡");
  assertEquals(typeSpecForVerify("no_change"), null);
});

Deno.test("每一種任務型別都附得到至少一段（other 例外：收尾型別不定）", () => {
  for (const t of TASK_TYPES) {
    if (t === "other" || t === "adjudicate") continue;
    assert(typeSpecForTask(t) !== null, `${t} 附不到任何段落`);
  }
});
