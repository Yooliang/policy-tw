// 空操作的更正（2026-09-21，兩隻跑任務的代理各自獨立回報同一件事）：
//   「db_current 已經是 2024、correct_value 也是 2024——這筆改完等於沒改」
//   「我用 REST 重讀發現 election_id 本來就已經是 2024，提交者卻寫 claimed_current=null」
// 這種提交照樣佔一個驗證名額、要好幾票、通過還寫一筆 edit_history，
// 而驗證票是最稀缺的資源。擋在提交端。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkNoOp, sameValue } from "./correction.ts";

Deno.test("值相不相同：2024 與 \"2024\" 算同一個，空字串與 null 算同一個", () => {
  assert(sameValue(2024, "2024"), "數字與字串的同一個值不該被當成不同");
  assert(sameValue(null, ""), "空字串與 null 都是「沒有值」");
  assert(sameValue(" 台北市 ", "台北市"), "前後空白不算差異");
  assert(!sameValue(2024, 2026));
  assert(!sameValue(null, "台北市"));
});

Deno.test("每一欄都跟現值一樣＝空操作", () => {
  const db = { election_id: 2024, status: "Achieved" };
  const all = checkNoOp({ target_table: "policies", target_id: "p1", changes: [
    { field: "election_id", current_value: null, correct_value: 2024 },
  ] }, db);
  assertEquals(all.allNoOp, true, "改成 2024 而現值就是 2024——等於沒改");
  assertEquals(all.fields[0].db_current, 2024, "要把現值一起回報，代理才知道為什麼被擋");
});

Deno.test("只要有一欄真的會變，就不是空操作——不能因為一欄沒變就整筆擋掉", () => {
  const db = { election_id: 2024, status: "Campaign Pledge" };
  const mixed = checkNoOp({ target_table: "policies", target_id: "p1", changes: [
    { field: "election_id", correct_value: 2024 },
    { field: "status", correct_value: "Achieved" },
  ] }, db);
  assertEquals(mixed.allNoOp, false);
  assertEquals(mixed.fields.filter((f) => f.same).length, 1);
});

Deno.test("查不到那一列就不擋——寧可讓它走驗證，也不要擋掉可能是對的提交", () => {
  assertEquals(checkNoOp({ changes: [{ field: "x", correct_value: 1 }] }, null).allNoOp, false);
  assertEquals(checkNoOp({ changes: [] }, { x: 1 }).allNoOp, false, "沒有 changes 不算空操作");
});

Deno.test("提交端真的會擋，而且訊息要講清楚不是代理做錯", async () => {
  const src = await Deno.readTextFile(new URL("./contribute-handler.ts", import.meta.url));
  assert(src.includes("no_op_correction"), "contribute 要擋空操作的更正");
  assert(src.includes("這不算你做錯"), "訊息要講清楚成因是資料新鮮度，不是罵它——不然代理會不敢再提");
  assert(src.includes("checkNoOp"), "要真的呼叫檢查，不是只留註解");
});
