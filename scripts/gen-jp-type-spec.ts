/**
 * 由日本站（policy-jp）的 public/skill-types.md 產生 supabase/functions/_shared/jp/type-spec.gen.ts（日本協議 0.29.0，policy-ops#178 D）。
 *
 *     deno run --allow-read --allow-write scripts/gen-jp-type-spec.ts <policy-jp 的 public/skill-types.md 路徑>
 *
 * 原文在另一個 repo（policy-jp），所以這裡存的是產物＋來源的版本與 sha256；
 * 手引き改了 skill-types.md、升了版，就在這裡重產並同批上線（手引き先、jp-next 後）。
 * 守門 jp/type-spec.test.ts 檢查產物自身的結構、版本與 JP_PROTOCOL_VERSION 一致、每種任務／交件型別都附得到段落。
 */
import { parseTypeSpec } from "../supabase/functions/_shared/type-spec.ts";

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function specVersionOf(md: string): string {
  const m = /手引きの版：(\d+\.\d+\.\d+)/.exec(md);
  if (!m) throw new Error("skill-types.md 找不到「手引きの版：x.y.z」");
  return m[1];
}

export async function renderJpTypeSpecModule(md: string): Promise<string> {
  const normalized = md.replace(/\r\n/g, "\n");
  const blocks = parseTypeSpec(normalized);
  return [
    "// 由 scripts/gen-jp-type-spec.ts 從 policy-jp 的 public/skill-types.md 產生，不要手改。",
    'import type { TypeSpecBlock } from "../type-spec.ts";',
    "",
    `export const JP_TYPE_SPEC_VERSION = ${JSON.stringify(specVersionOf(normalized))};`,
    `export const JP_TYPE_SPEC_SOURCE_SHA256 = ${JSON.stringify(await sha256Hex(normalized))};`,
    `export const JP_TYPE_SPEC_BLOCKS: ReadonlyArray<TypeSpecBlock> = ${JSON.stringify(blocks, null, 1)};`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const src = Deno.args[0];
  if (!src) {
    console.error("用法：deno run --allow-read --allow-write scripts/gen-jp-type-spec.ts <skill-types.md>");
    Deno.exit(2);
  }
  const md = await Deno.readTextFile(src);
  await Deno.writeTextFile(new URL("../supabase/functions/_shared/jp/type-spec.gen.ts", import.meta.url), await renderJpTypeSpecModule(md));
  console.log("jp/type-spec.gen.ts 已重產");
}
