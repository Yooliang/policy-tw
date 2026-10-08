/**
 * 產生 docs/DECISIONS.md（索引）。裁決本文一條一個檔，放在 docs/decisions/。
 *
 * 為什麼拆檔（#492）：以前所有裁決寫在同一個檔的同一處，並行的 PR 每次都在那裡撞衝突。
 * 現在新增一條裁決＝新增一個檔 `docs/decisions/YYYY-MM-DD-<slug>.md`，不改別人的檔。
 * 索引是產物：新增檔後跑
 *
 *     deno run --allow-read --allow-write scripts/decisions-index.ts
 *
 * 就會重寫 docs/DECISIONS.md。rebase 時索引撞衝突，不用手解，直接重跑這支覆蓋。
 * 守門測試（supabase/functions/_shared/decisions-index.test.ts）會比對索引與目錄，不一致就紅。
 *
 * 檔名規則：`YYYY-MM-DD-<slug>.md`（有日期的裁決）或 `pending-<slug>.md`（暫緩：有結論但沒動）。
 * 檔案內容是原本的條目（`- **標題**｜裁決｜理由｜…`，可帶縮排的子條目），第一個 `**…**` 就是索引上的標題。
 */

export interface DecisionEntry {
  file: string; // 檔名（含 .md）
  group: string; // YYYY-MM-DD 或 pending
  title: string;
}

export const FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2}|pending)-.+\.md$/u;

export function titleOf(text: string): string {
  const first = text.replace(/\r\n/g, "\n").split("\n").find((l) => l.trim() !== "") ?? "";
  const bold = /\*\*(.+?)\*\*/u.exec(first)?.[1];
  const plain = first.replace(/^\s*-\s*/, "").replace(/~~/g, "").trim();
  return (bold ?? plain).replace(/\s+/g, " ").trim();
}

export async function readEntries(dir: URL): Promise<DecisionEntry[]> {
  const entries: DecisionEntry[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile) continue;
    if (!FILE_NAME_RE.test(e.name)) throw new Error(`docs/decisions/${e.name}：檔名要是 YYYY-MM-DD-<slug>.md 或 pending-<slug>.md`);
    const text = await Deno.readTextFile(new URL(e.name, dir));
    const group = e.name.startsWith("pending-") ? "pending" : e.name.slice(0, 10);
    entries.push({ file: e.name, group, title: titleOf(text) });
  }
  return entries;
}

/** 索引上的標題：截到 48 字、去掉會弄壞連結文字的方括號 */
export function shortTitle(title: string): string {
  const t = [...title.replace(/[\[\]]/g, "")];
  return t.length > 48 ? t.slice(0, 48).join("") + "…" : t.join("");
}

const HEADER =`# 裁決日誌（索引）

流程規則的「為什麼」都在這裡，一條一條、附日期。改規則前先讀，牴觸舊裁決要在這裡寫「更正」而不是默默覆蓋。
程式與 SQL 是規則的實作，這份是規則的來源；兩邊對不上以這份為準去修程式。

格式：\`日期｜裁決｜理由｜錯了的代價\`。

**這份檔是產物，不要手改。** 每條裁決一個檔，在 \`docs/decisions/YYYY-MM-DD-<slug>.md\`（暫緩的用 \`pending-<slug>.md\`）；
新增後跑 \`deno run --allow-read --allow-write scripts/decisions-index.ts\` 重寫這份索引（rebase 撞到這份時也是重跑，不用手解）。
守門測試會比對索引與目錄。條目本文就是原本的 \`- **標題**｜裁決｜理由｜錯了的代價\` 那一段。
`;

/** 索引內容：日期新到舊，同一天內依檔名；暫緩放最後。結尾有換行、一律 LF。 */
export function buildIndex(entries: DecisionEntry[]): string {
  const groups = new Map<string, DecisionEntry[]>();
  for (const e of entries) {
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group)!.push(e);
  }
  const dates = [...groups.keys()].filter((g) => g !== "pending").sort().reverse();
  const order = groups.has("pending") ? [...dates, "pending"] : dates;
  let out = HEADER;
  for (const g of order) {
    out += `\n## ${g === "pending" ? "暫緩（有結論但沒動）" : g}\n\n`;
    const list = groups.get(g)!.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    for (const e of list) out += `- [${shortTitle(e.title)}](decisions/${e.file})\n`;
  }
  return out;
}

export const DECISIONS_DIR = new URL("../docs/decisions/", import.meta.url);
export const INDEX_FILE = new URL("../docs/DECISIONS.md", import.meta.url);

if (import.meta.main) {
  const index = buildIndex(await readEntries(DECISIONS_DIR));
  await Deno.writeTextFile(INDEX_FILE, index);
  console.log(`docs/DECISIONS.md 已重寫（${index.split("\n").filter((l) => l.startsWith("- [")).length} 條）`);
}
