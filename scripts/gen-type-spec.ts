/**
 * 由 public/skill-types.md 產生 supabase/functions/_shared/type-spec.gen.ts（協議 1.93.0）。
 *
 *     deno run --allow-read --allow-write scripts/gen-type-spec.ts
 *
 * 改了 skill-types.md 就重跑；守門 type-spec.test.ts 會比對兩邊。
 */
import { parseTypeSpec } from "../supabase/functions/_shared/type-spec.ts";

export function renderTypeSpecModule(md: string): string {
  const blocks = parseTypeSpec(md);
  return [
    "// 由 scripts/gen-type-spec.ts 從 public/skill-types.md 產生，不要手改。",
    'import type { TypeSpecBlock } from "./type-spec.ts";',
    "",
    `export const TYPE_SPEC_BLOCKS: ReadonlyArray<TypeSpecBlock> = ${JSON.stringify(blocks, null, 1)};`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const md = await Deno.readTextFile(new URL("../public/skill-types.md", import.meta.url));
  await Deno.writeTextFile(new URL("../supabase/functions/_shared/type-spec.gen.ts", import.meta.url), renderTypeSpecModule(md));
  console.log("type-spec.gen.ts 已重產");
}
