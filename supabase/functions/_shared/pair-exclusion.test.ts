/**
 * 同名人物那一對：讓它「不再被看見」的兩條路，都不該是永久且不可還原的。
 *
 * 合併是全站唯一沒有回頭路的動作，所以這一對要不要繼續給人看，判錯的代價特別高：
 *   - politician_pair_resolutions 的 different 章：代理一筆貢獻就寫下去，之前沒有查核履歷，
 *     planRevert 救不回來——那會是全站唯一「判錯了連還原都沒有」的動作。
 *   - Jev 的 diff 判定：原本永久、而且看的是「任何一筆」而不是最新一筆，
 *     所以後來改判 same 也壓不掉舊的 diff。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyContribution } from "./apply-contribution.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const RESOLUTION_ID = "33333333-3333-4333-8333-333333333333";
const MIGRATIONS = new URL("../../migrations/", import.meta.url);

async function latestMigrationDefining(fn: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  for (const name of names.reverse()) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS));
    if (sql.includes(`FUNCTION ${fn}`)) return sql;
  }
  throw new Error(`沒有任何 migration 定義 ${fn}`);
}

Deno.test("「不同人」的結論要留查核履歷，而且 record_id 是那一列的 id", async () => {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const db = {
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>) => ({
        select: () => ({ maybeSingle: async () => ({ data: { id: RESOLUTION_ID, ...row }, error: null }) }),
      }),
      insert: (row: Record<string, unknown>) => { inserted.push({ table, row }); return { error: null }; },
    }),
  };
  const out = await applyContribution(db, {
    id: "c-1", contribution_type: "merge_politician" as const, source_urls: ["https://db.cec.gov.tw/x"],
    note: null, agent_name: "tester", contributor_url: null,
    payload: { keep_id: A, remove_id: B, same_person: false, reason: "中選會歷屆參選查詢顯示兩人出生年不同、選區也不同，確認不是同一人。" },
  });
  assertEquals(out.status, "applied");

  const history = inserted.filter((i) => i.table === "edit_history");
  assertEquals(history.length, 1, "沒有履歷就不可還原——這是全站唯一連 revert 都沒有的動作");
  assertEquals(history[0].row.table_name, "politician_pair_resolutions");
  assertEquals(
    history[0].row.record_id,
    RESOLUTION_ID,
    "record_id 要是那一列的 id（UUID），不是 pair_key：executeRevert 的 delete 寫死 .eq(\"id\", record_id)",
  );
  assertEquals(history[0].row.field, "*", "整列紀錄，planRevert 才會走 delete 那條");
  assert(out.message.includes("還原"), "回覆要讓代理知道判錯救得回來");
});

Deno.test("Jev 的「不同人」判定：只認最新一筆，而且有時間窗", async () => {
  const sql = await latestMigrationDefining("contribution_auto_tasks_dup(");
  const fn = sql.slice(sql.lastIndexOf("FUNCTION contribution_auto_tasks_dup("));

  assert(/ORDER BY j\.asked_at DESC\s*\n?\s*LIMIT 1/.test(fn), "要只看最新一筆判定，否則後來改判 same 也壓不掉舊的 diff");
  assert(/jev_pair_exclusion_days\(\)/.test(fn), "要有時間窗，不可以永久排除");
  assert(/latest\.choice = 'diff'/.test(fn), "只有判「不同人」才排除；判 same 的反而該排前面");
});

Deno.test("任務窗要大於 precheck 的快取窗，否則代理會白跑", async () => {
  const sql = await latestMigrationDefining("jev_pair_exclusion_days");
  const m = sql.match(/FUNCTION jev_pair_exclusion_days\(\)[\s\S]*?SELECT\s+(\d+)/);
  assert(m, "找不到排除天數");
  const days = Number(m![1]);

  // precheck 重用舊判定的窗（system-one/index.ts）：任務窗一旦比它短，
  // 任務會在「Jev 還會回同一筆舊判定」的期間就派出去，代理查完得到一樣的結論。
  const src = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  // 幾種等價寫法都要認得（86400_000、86_400_000、24*60*60*1000、具名常數），
  // 只認一種的話，之後有人換寫法這支測試會在完全正確的程式上變紅
  const cache = src.match(/(\d+)\s*\*\s*86_?400_?000/) ??
    src.match(/(\d+)\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/) ??
    src.match(/(?:RECENT_DAYS|PRECHECK_CACHE_DAYS)\s*=\s*(\d+)/);
  assert(cache, "找不到 precheck 的快取天數，改版式了就要一起更新這支測試");
  assert(
    days > Number(cache![1]),
    `任務排除窗（${days} 天）要大於 precheck 的快取窗（${cache![1]} 天）：短於它的話，任務派出來時 precheck 只會回同一筆舊判定`,
  );
});
