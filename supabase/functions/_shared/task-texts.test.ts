import { assert } from "jsr:@std/assert@1";
import { MAX_POLICIES_PER_TASK } from "./dispatch.ts";
import { buildRequestTaskText } from "./request-task.ts";
import { TASK_TYPES } from "./contribution-schema.ts";

// 任務文字散在 SQL（自動缺口）與 TS（網站按鈕）兩處。數字與規則一漂開，
// 代理拿到的指示就跟派工的實際行為對不上，而且不會有人發現。（2026-09-18）

/** 最新一支定義 contribution_auto_tasks_raw 的 migration（同一支函式被重定義過很多次，以最後一支為準） */
async function latestAutoTasksSql(): Promise<string> {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    if (sql.includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_raw")) return sql;
  }
  throw new Error("找不到定義 contribution_auto_tasks_raw 的 migration");
}

Deno.test("政見缺漏：自動缺口與網站按鈕都寫「最多 N 筆」，N 跟派工的在途上限同一個數字", async () => {
  const sql = await latestAutoTasksSql();
  assert(sql.includes(`最多 ${MAX_POLICIES_PER_TASK} 筆`), `自動缺口的 policy_missing 文字要寫「最多 ${MAX_POLICIES_PER_TASK} 筆」`);
  const button = buildRequestTaskText({ kind: "policy", politician_id: null, policy_id: null, politician_name: "某人" });
  assert(button.description.includes(`最多 ${MAX_POLICIES_PER_TASK} 筆`), "網站按鈕「查政見」也要寫同一個上限");
  assert(button.description.includes("不要為了湊數"), "要寫明不要湊數——給數字容易引來口號與願景");
  // 協議文件是代理實際讀的那份，也要同一個數字
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assert(skill.includes(`最多 ${MAX_POLICIES_PER_TASK} 筆`), `public/skill.md 的 policy_missing 也要寫「最多 ${MAX_POLICIES_PER_TASK} 筆」`);
});

Deno.test("名單清查：登記截止後 rumored 與 likely 都要處理（跟 candidate_status_stale 的條件一致）", async () => {
  const sql = await latestAutoTasksSql();
  assert(sql.includes("likely（可能參選）"), "roster_check 的文字漏了 likely（可能參選）");
});

Deno.test("網站按鈕「查進度」先判斷是不是政見、還沒投票的承諾不追進度；「這不是政見？」沒有出處時補 source_url", () => {
  const progress = buildRequestTaskText({ kind: "progress", politician_id: null, policy_id: null, politician_name: "某人", policy_title: "某政見" }).description;
  assert(progress.includes("是不是政見") && progress.includes("還沒投票"), "查進度少了兩個前置判斷");
  const validity = buildRequestTaskText({ kind: "validity", politician_id: null, policy_id: null, politician_name: "某人", policy_title: "某政見" }).description;
  assert(validity.includes("source_url"), "沒有出處時要叫代理用 correction 補 source_url，不是回 no_change");
});

Deno.test("自動缺口會派的每一種型別，task_suggestion 都要能提議（清單不能落後）", async () => {
  const sql = await latestAutoTasksSql();
  const autoTypes = [...new Set([...sql.matchAll(/'auto:([a-z_]+):'/g)].map((m) => m[1]))];
  assert(autoTypes.length >= 5, `從 SQL 抓到的自動缺口型別太少（${autoTypes.length}），抓法可能壞了`);
  const missing = autoTypes.filter((t) => !(TASK_TYPES as readonly string[]).includes(t));
  assert(missing.length === 0, `TASK_TYPES 少了：${missing.join("、")}`);
});
