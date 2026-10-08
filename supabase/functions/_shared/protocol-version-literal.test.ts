/**
 * 守門（#492）：測試不得把「現行」協議版號寫死成字面值。
 *
 * 10-09 #499 升到 1.84.0 時，district-seats-sources.test.ts 寫死「目前版號 1.83.0」，CI 紅。
 * 每次升版都會踩到的測試，就是會讓並行 PR 互相卡住的測試。
 * 要驗「這個功能從哪一版起有」→ 寫「不低於某版」（ver(PROTOCOL_VERSION) >= ver("1.83.0")）；
 * 要驗「skill.md 與程式同步」→ 用常數插值（`**版本**：${PROTOCOL_VERSION}`），不要寫數字。
 *
 * 掃 supabase/functions 底下所有 *.test.ts（本檔除外），出現以下寫法就紅：
 *   - assertEquals(PROTOCOL_VERSION, "1.x.y")（或反過來、assertStrictEquals）
 *   - PROTOCOL_VERSION === "1.x.y"（或反過來）
 *   - 把版號行字面值寫進斷言：`**版本**：1.x.y`、`*協議版本 1.x.y`
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("../", import.meta.url);
const SELF = "protocol-version-literal.test.ts";
const LIT = String.raw`["'\x60]\s*\d+\.\d+\.\d+\s*["'\x60]`;

/** 回傳違規的行（空陣列＝乾淨）。獨立成函式，好讓還原驗證與自測餵假內容。 */
export function findHardcodedProtocolVersion(src: string): string[] {
  const rules = [
    new RegExp(String.raw`assert(?:Strict)?Equals\(\s*(?:\w+\.)?PROTOCOL_VERSION\s*,\s*${LIT}`),
    new RegExp(String.raw`assert(?:Strict)?Equals\(\s*${LIT}\s*,\s*(?:\w+\.)?PROTOCOL_VERSION\b`),
    new RegExp(String.raw`PROTOCOL_VERSION\s*[!=]==?\s*${LIT}`),
    new RegExp(String.raw`${LIT}\s*[!=]==?\s*PROTOCOL_VERSION\b`),
    // 版號行的字面值：「**版本**：1.84.0」「*協議版本 1.84.0」
    /\*\*版本\*\*：\d+\.\d+\.\d+/,
    /\*協議版本 \d+\.\d+\.\d+/,
  ];
  return src.split(/\r?\n/).filter((line) => rules.some((r) => r.test(line)));
}

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    if (e.name === "node_modules") continue;
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(u);
    else if (e.isFile && e.name.endsWith(".test.ts") && e.name !== SELF) yield u;
  }
}

Deno.test("測試不得把現行協議版號寫成等號比對（要寫「不低於某版」）", async () => {
  const bad: string[] = [];
  let scanned = 0;
  for await (const f of walk(ROOT)) {
    scanned++;
    for (const line of findHardcodedProtocolVersion(await Deno.readTextFile(f))) {
      bad.push(`${f.pathname.split("/supabase/functions/")[1]}：${line.trim().slice(0, 120)}`);
    }
  }
  assert(scanned > 50, "掃到的測試檔太少，掃描範圍壞了");
  assertEquals(bad, [], "這些測試把現行版號寫死，下次升版就紅；改成「不低於某版」或用 PROTOCOL_VERSION 插值");
});

Deno.test("守門自測：抓得到寫死的寫法，放得過「不低於某版」與常數插值", () => {
  const caught = [
    'assertEquals(PROTOCOL_VERSION, "1.84.0");',
    "assertEquals('1.84.0', PROTOCOL_VERSION);",
    'assertStrictEquals(PROTOCOL_VERSION, "1.84.0")',
    'assert(PROTOCOL_VERSION === "1.84.0");',
    'assert("1.84.0" == PROTOCOL_VERSION);',
    "assertStringIncludes(skill, `**版本**：1.84.0`);",
    'assert(md.includes("*協議版本 1.84.0"));',
  ];
  for (const s of caught) assert(findHardcodedProtocolVersion(s).length === 1, `應該要抓到：${s}`);
  const allowed = [
    'assert(ver(PROTOCOL_VERSION) >= ver("1.83.0"), "不低於 1.83.0");',
    "assertStringIncludes(skill, `**版本**：${PROTOCOL_VERSION}`);",
    'assert(md.includes("protocol_version"));',
    "const [major, minor] = PROTOCOL_VERSION.split('.').map(Number);",
  ];
  for (const s of allowed) assertEquals(findHardcodedProtocolVersion(s), [], `不該誤抓：${s}`);
});
