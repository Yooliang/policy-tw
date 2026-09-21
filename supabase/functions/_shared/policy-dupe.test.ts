/**
 * 政見重複清查（duplicate_policy）：系統排程、代理判斷。
 *
 * 為什麼任務的單位是「一個人」而不是「一對政見」：中文政見的字面相似度分不開
 * 「同一個承諾換句話說」與「同主題不同標的」。實測李四川那組——
 *   真重複：「加速都市更新、改善危老建築與居住安全」vs「都更5夠力…」 2-gram Jaccard 0.021
 *   不重複：「興建淡海新市鎮醫院…」vs「協助恩主公醫院擴建…」        2-gram Jaccard 0.026
 * 假配對比真重複還高，所以任何門檻都是先送假的、後漏真的。這幾支測試守著
 * 「不要退回去用相似度配對」與「清單指紋這條回路不要斷」。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { MAX_POLICY_DUPE_LIST, POLICY_DUPE_DESC_LIMIT, shapeTaskCurrent } from "./task-context.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

async function latestMigrationDefining(fn: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  }
  names.sort();
  for (const name of names.reverse()) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS));
    if (sql.includes(`FUNCTION ${fn}`)) return sql;
  }
  throw new Error(`沒有任何 migration 定義 ${fn}`);
}

Deno.test("current 要給整份清單，不是系統挑出來的配對", () => {
  const out = shapeTaskCurrent("duplicate_policy", {
    politician: { id: "p1", name: "李四川", region: "新北市" },
    policies: [
      { id: "a", title: "加速都市更新、改善危老建築與居住安全", description: "依自由時報報導…", category: "都市發展與住宅", election_id: 2026, proposed_date: "2026-07-23", source_url: "https://example.test/1" },
      { id: "b", title: "發表「都更5夠力」：成立府級都更推動委員會、危險建築重建容積最高2倍", description: "x".repeat(POLICY_DUPE_DESC_LIMIT + 50), category: "都市發展與住宅", election_id: 2026, proposed_date: "2026-08-19", source_url: "https://example.test/2" },
    ],
    policies_total: 24,
  });
  const list = out.policies as Array<Record<string, unknown>>;
  assertEquals(list.length, 2);
  // 判重複要看得到出處與日期：同一場發表拆出來的 N 筆不是重複，靠這兩欄才分得出來
  for (const row of list) {
    for (const f of ["id", "title", "description", "category", "election_id", "proposed_date", "source_url"]) {
      assert(f in row, `清單少了 ${f}，代理沒辦法判斷是不是同一個承諾`);
    }
  }
  assertEquals(out.policies_total, 24, "清單被截短時要讓代理知道總共有幾筆");
  assertEquals((list[1].description as string).length, POLICY_DUPE_DESC_LIMIT);
  assertEquals(list[1].truncated, true);
  assertEquals(list[0].truncated, undefined, "沒截短就不要加 truncated");
  const hint = String(out.hint);
  assert(hint.includes("removal") && hint.includes("no_change"), "兩條出路都要講");
  assert(hint.includes("no_change") && hint.includes("比對過哪幾組"), "no_change 要求列出比對過的組別，否則掃過去就回報等於沒查");
});

Deno.test("清單長到上限也不會漏掉總數", () => {
  const many = Array.from({ length: MAX_POLICY_DUPE_LIST + 10 }, (_, i) => ({ id: `p${i}`, title: `政見 ${i}`, description: null }));
  const out = shapeTaskCurrent("duplicate_policy", { politician: { id: "p1" }, policies: many, policies_total: many.length });
  assertEquals((out.policies as unknown[]).length, MAX_POLICY_DUPE_LIST);
  assertEquals(out.policies_total, MAX_POLICY_DUPE_LIST + 10);
});

Deno.test("任務條件：≥2 筆、排除已移除與已合併、清單沒變就不再派", async () => {
  const sql = await latestMigrationDefining("contribution_auto_tasks_policy_dup(");
  const body = sql.slice(sql.lastIndexOf("FUNCTION contribution_auto_tasks_policy_dup("));
  const fn = body.slice(0, body.indexOf("COMMENT ON FUNCTION"));

  assert(/HAVING COUNT\(pl\.id\) >= 2/.test(fn), "只有 1 筆政見的人沒有東西可以互比，不該派");
  assert(/pl\.removed_at IS NULL/.test(fn), "已移除的政見不算數，否則退掉一筆之後還會一直被問同一組");
  assert(/p\.merged_into IS NULL/.test(fn), "已被合併的人物不該再派任務");
  assert(
    /NOT EXISTS[\s\S]*policy_dupe_reviews r WHERE r\.politician_id = o\.id AND r\.fingerprint = o\.fp/.test(fn),
    "查過的那份清單（指紋相同）不可以再派——同一份清單再問一次還是同一個答案",
  );
  // 指紋要進 task_id：清單一變 task_id 就變，冷卻與認領都跟著換一份，任務自己重新出現
  assert(/'auto:duplicate_policy:' \|\| o\.id \|\| ':' \|\| o\.fp/.test(fn), "task_id 要帶清單指紋");
});

Deno.test("指紋：任何一筆政見的增刪改都要讓它變，而且只認未移除的", async () => {
  const sql = await latestMigrationDefining("policy_list_fingerprint(");
  const body = sql.slice(sql.lastIndexOf("FUNCTION policy_list_fingerprint("));
  const fn = body.slice(0, body.indexOf("COMMENT ON FUNCTION"));
  assert(/string_agg/.test(fn) && /ORDER BY pl\.id/.test(fn), "指紋要對清單排序後彙總，否則同一份清單每次算出來不一樣");
  assert(/pl\.title/.test(fn) && /pl\.description/.test(fn), "標題或描述被改掉就是不同的清單，要重新清查");
  assert(/removed_at IS NULL/.test(fn), "移除一筆之後指紋要變，剩下的組合才會被重新比對一次");
  assert(/substr\(md5\([\s\S]*\), 1, 8\)/.test(fn), "指紋長度要跟 applyNoChange 的正則對得上（8 碼十六進位）");
});

Deno.test("落庫端的 task_id 正則吃得下 SQL 產生的 task_id", async () => {
  // 這兩邊在不同檔案、不同語言，錯開了不會有任何東西壞掉——只是 no_change 永遠不寫
  // policy_dupe_reviews，於是同一份清單每 14 天被重派一次，沒有人會發現。
  const src = await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url));
  const m = src.match(/\/\^auto:duplicate_policy:([^/]+)\/i/);
  assert(m, "apply-contribution.ts 找不到 duplicate_policy 的 task_id 正則");
  const re = new RegExp(`^auto:duplicate_policy:${m![1]}`, "i");

  const taskId = "auto:duplicate_policy:98b8b1ff-d085-4597-8384-a02461f773f6:0a1b2c3d";
  const hit = re.exec(taskId);
  assert(hit, `SQL 產生的 task_id 對不上落庫端的正則：${taskId}`);
  assertEquals(hit![1], "98b8b1ff-d085-4597-8384-a02461f773f6");
  assertEquals(hit![2], "0a1b2c3d");
  // 別種任務不可以誤入這條路
  assertEquals(re.exec("auto:legacy_audit:98b8b1ff-d085-4597-8384-a02461f773f6"), null);
});
