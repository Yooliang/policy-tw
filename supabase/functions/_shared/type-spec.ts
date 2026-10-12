/**
 * 各型別的做法與交件欄位，隨派工送出（協議 1.93.0，使用者 2026-10-12：「每次都讀整份 skill 太長、浪費 token，
 * 改成在任務上依類型給，skill 不用一直改，任務有調整也能立即跟上」）。
 *
 * 原文在 `public/skill-types.md`（一段一個 `<!-- spec task: … | contribution: … -->` 標記），
 * 由 `scripts/gen-type-spec.ts` 產生 `type-spec.gen.ts`——Edge Function 讀不到 public/，所以要產成程式碼。
 * `type-spec.test.ts` 比對原文與產物，沒重產就紅。
 *
 * 選段規則：
 *   - 任務：這種任務型別的段落 ＋ 它可能收尾的每一種交件型別（SUGGESTED_TYPE 與 TASK_BRANCHES）的段落
 *   - 驗證：被驗的那一種交件型別的段落
 * 同一段只出現一次、照原文順序。`no_change` 與 `outcome` 是每一件都可能用到的，留在 skill.md、不在這裡。
 */

export interface TypeSpecBlock {
  tasks: string[];
  contributions: string[];
  text: string;
}

const MARKER_RE = /^<!--\s*spec\s+(.+?)\s*-->\s*$/u;

/** 解析 skill-types.md：標記之前的檔頭不算任何一段 */
export function parseTypeSpec(md: string): TypeSpecBlock[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: TypeSpecBlock[] = [];
  let cur: TypeSpecBlock | null = null;
  const body: string[] = [];
  const flush = () => {
    if (cur) blocks.push({ ...cur, text: body.join("\n").trim() });
    body.length = 0;
  };
  for (const line of lines) {
    const m = MARKER_RE.exec(line);
    if (m) {
      flush();
      const tasks: string[] = [];
      const contributions: string[] = [];
      for (const part of m[1].split("|")) {
        const [k, v = ""] = part.split(":");
        const names = v.split(",").map((s) => s.trim()).filter(Boolean);
        if (k.trim() === "task") tasks.push(...names);
        else if (k.trim() === "contribution") contributions.push(...names);
        else throw new Error(`skill-types.md 標記認不得：${line}`);
      }
      cur = { tasks, contributions, text: "" };
      continue;
    }
    if (cur) body.push(line);
  }
  flush();
  return blocks;
}

/** 依任務型別與（可能的）交件型別挑段落，接成一份 markdown；一段都沒有回 null */
export function selectTypeSpec(
  blocks: ReadonlyArray<TypeSpecBlock>,
  opts: { taskType?: string | null; contributionTypes?: ReadonlyArray<string | null | undefined> },
): string | null {
  const ct = new Set((opts.contributionTypes ?? []).filter((x): x is string => typeof x === "string" && x !== ""));
  const picked = blocks.filter((b) =>
    (opts.taskType ? b.tasks.includes(opts.taskType) : false) || b.contributions.some((c) => ct.has(c))
  );
  return picked.length > 0 ? picked.map((b) => b.text).join("\n\n") : null;
}
