/**
 * 守門（#492）：docs/DECISIONS.md 是索引，裁決本文一條一個檔在 docs/decisions/。
 *
 * 以前所有裁決寫在同一個檔的同一處，並行的 PR 每次都撞衝突。現在新增裁決＝新增一個檔；
 * 索引由 scripts/decisions-index.ts 產生。新增檔案卻沒重跑腳本，這裡就紅。
 * 修法：deno run --allow-read --allow-write scripts/decisions-index.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildIndex, DECISIONS_DIR, FILE_NAME_RE, INDEX_FILE, readEntries } from "../../../scripts/decisions-index.ts";

const lf = (s: string) => s.replace(/\r\n/g, "\n");

Deno.test("DECISIONS.md 索引與 docs/decisions/ 目錄一致（新增裁決檔後要重跑 scripts/decisions-index.ts）", async () => {
  const want = buildIndex(await readEntries(DECISIONS_DIR));
  const got = lf(await Deno.readTextFile(INDEX_FILE));
  assertEquals(got, want, "docs/DECISIONS.md 和目錄對不上：跑 deno run --allow-read --allow-write scripts/decisions-index.ts");
});

Deno.test("每個裁決檔：檔名合規、內容是條目（以「- 」開頭）、不是空檔", async () => {
  let n = 0;
  for await (const e of Deno.readDir(DECISIONS_DIR)) {
    n++;
    assert(e.isFile && FILE_NAME_RE.test(e.name), `${e.name}：檔名要是 YYYY-MM-DD-<slug>.md 或 pending-<slug>.md`);
    const text = lf(await Deno.readTextFile(new URL(e.name, DECISIONS_DIR)));
    assert(text.startsWith("- "), `${e.name}：內容要以條目「- **標題**｜…」開頭`);
  }
  assert(n >= 200, "目錄裡的裁決檔不該少（原本拆出 211 個）");
});

Deno.test("索引上的每一條連結都指到存在的檔", async () => {
  const index = lf(await Deno.readTextFile(INDEX_FILE));
  const links = [...index.matchAll(/\]\(decisions\/([^)]+)\)/g)].map((m) => m[1]);
  assert(links.length > 0);
  for (const f of links) await Deno.stat(new URL(f, DECISIONS_DIR));
});
