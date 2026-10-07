/**
 * 補任期政見（term_policy_missing，協議 1.41.0；維護者 2026-10-02 同意）。
 *
 * 人物頁「過往政績」顯示「該候選人無過往追蹤紀錄」＝這個人沒有過去選舉的政見。線上量：2022 當選的縣市議員
 * 813 人中 742 人沒有 2022 的政見，2024 立委 73 缺 59。policy_missing 只對 2026 候選人、而且整個人零政見才派，
 * 已有 2026 政見的現任者、不選 2026 的現任者永遠不會被派去補任期政見。
 *
 * 這支測試守四件事：SQL 的條件、加新任務型別要清點的四處（加看板顏色）、查無守門涵蓋新型別、交件骨架的 status。
 * 2026-10-06 起推得出選舉公報的參選人（含落選、村里長、代表）也派這個型別，見 election-bulletin.test.ts。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { TASK_TYPES } from "./contribution-schema.ts";
import { handleContribute } from "./contribute-handler.ts";
import { NOT_FOUND_SEARCH_TASK_TYPES, notFoundSearchShortfall, SEARCH_KEYWORDS } from "./not-found-guard.ts";
import { SOURCE_TASK_TYPES, shapeTaskCurrent } from "./task-context.ts";
import { buildReportTemplate, TASK_GUIDANCE } from "./task-guidance.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { needsForTask } from "./verification-sources.ts";
import { MAX_POLICIES_PER_TASK } from "./dispatch.ts";

const T = "term_policy_missing";
const PID = "98b8b1ff-d085-4597-8384-a02461f773f6";
const MIGRATIONS = new URL("../../migrations/", import.meta.url);

/** 最後一支定義 fn 的 migration，切出那支函式本體（到下一個 COMMENT ON／CREATE 為止） */
async function latestFunctionBody(fn: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS));
    const from = sql.lastIndexOf(`FUNCTION ${fn}(`);
    if (from < 0 || !sql.slice(0, from).match(/CREATE OR REPLACE\s*$/)) continue;
    const ends = [sql.indexOf("COMMENT ON FUNCTION", from), sql.indexOf("CREATE OR REPLACE FUNCTION", from + 10)].filter((i) => i > from);
    return sql.slice(from, ends.length > 0 ? Math.min(...ends) : undefined);
  }
  throw new Error(`沒有任何 migration 定義 ${fn}`);
}

Deno.test("SQL：任務臂掛進 contribution_auto_tasks_arms()", async () => {
  const arms = await latestFunctionBody("contribution_auto_tasks_arms");
  assertStringIncludes(arms, "FROM contribution_auto_tasks_term_policies()");
  // 原本七支臂一支都不能少（CREATE OR REPLACE 整份重寫，漏抄一行就是靜默拿掉一種任務）
  for (const arm of ["raw", "dup", "legacy", "mismatch", "policy_dup", "not_running", "mayor_policies"]) {
    assertStringIncludes(arms, `FROM contribution_auto_tasks_${arm}()`, `arms 漏了 contribution_auto_tasks_${arm}`);
  }
});

Deno.test("SQL：對象＝設定表 election_task_config 開著的屆別裡、職位在 positions 的當選者（種子是 2022 縣市長／縣市議員／鄉鎮市長、2024 立委）；條件＝沒有該屆、未移除的政見", async () => {
  const body = await latestFunctionBody("contribution_auto_tasks_term_policies");
  const flat = body.replace(/\s+/g, " ");
  assertStringIncludes(flat, `'auto:${T}:'`);
  assertStringIncludes(flat, "pe.candidacy_status = 'elected'");
  // 2026-10-07：屆別與職位不再寫死在函式裡，讀 election_task_config（election-task-config.test.ts 守種子與逐字相同）
  assertStringIncludes(flat, "JOIN election_task_config cfg ON cfg.election_id = pe.election_id AND cfg.enabled AND pe.election_type = ANY (cfg.positions)");
  assert(!/pe\.election_id = 20\d\d/.test(flat), "當選人那一段不能再寫死屆別");
  // 缺口：沒有「該人、該屆、未移除」的政見——補上一筆就從 _gaps 消失，seed_auto_task_queue 收回號碼牌
  assert(/NOT EXISTS \( ?SELECT 1 FROM policies pl WHERE pl\.politician_id = \w+\.politician_id AND pl\.election_id = \w+\.election_id AND pl\.removed_at IS NULL ?\)/.test(flat),
    "缺口條件要是：policies 沒有該人、該 election_id、removed_at IS NULL 的政見");
  assert(!flat.includes("總統"), "不含總統");
  // 2026-10-06 起村里長也派，但只派推得出公報的（politician_bulletins），而且一次最多 term_policy_village_cap() 件
  // （election-bulletin.test.ts 守住細節）；當選人那一段只看設定表的 positions（種子不含村里長）
  assertStringIncludes(flat, "JOIN election_task_config cfg ON cfg.election_id = b.election_id AND cfg.enabled");
  assertStringIncludes(flat, "term_policy_village_cap()");
  assertStringIncludes(flat, "merged_into IS NULL", "被合併掉的人物不派");
  // 去重：2026 候選人而且整個人零政見的，只走 policy_missing（條件跟 raw 臂的 c2026 一致）
  assert(/NOT EXISTS \( ?SELECT 1 FROM politician_elections c WHERE c\.politician_id = \w+\.politician_id AND c\.election_id = 2026 AND c\.candidacy_status IS DISTINCT FROM 'withdrawn' ?\) OR EXISTS \( ?SELECT 1 FROM policies pl WHERE pl\.politician_id = \w+\.politician_id AND pl\.removed_at IS NULL ?\)/.test(flat),
    "去重條件：不是 2026 候選人，或已經有任何政見（零政見的 2026 候選人留給 policy_missing）");
  // task_id 帶屆別：同一人可能 2022 選上議員、2024 選上立委，兩屆各一件
  assert(/'auto:term_policy_missing:' \|\| \w+\.politician_id \|\| ':' \|\| \w+\.election_id/.test(flat), "task_id 要是 auto:term_policy_missing:<人物>:<屆別>");
});

Deno.test("SQL：任務說明——那一屆的競選政見、最多 5 筆、首選選舉公報、status 填 Campaign Pledge；hint_sources 是公報實際入口", async () => {
  const body = await latestFunctionBody("contribution_auto_tasks_term_policies");
  assertStringIncludes(body, `最多 ${MAX_POLICIES_PER_TASK} 筆`);
  assertStringIncludes(body, "選舉公報");
  assertStringIncludes(body, "Campaign Pledge");
  assertStringIncludes(body, "不要為了湊數");
  assertStringIncludes(body, "標語");
  // 公報的實際查找入口（2022 地方選舉公報 111 年、2024 立委選舉公報 113 年第 11 屆）2026-10-07 起放在設定表種子（election_task_config.bulletin_hint），
  // 函式本身只讀它；沒填的屆別用公報站首頁加民國年的通用寫法
  assertStringIncludes(body, "COALESCE(cfgx.bulletin_hint,");
  assertStringIncludes(body, "cfgx.bulletin_roc_year");
  const config = await Deno.readTextFile(new URL("../../migrations/20261007225000_election_task_config.sql", import.meta.url));
  assertStringIncludes(config, "https://eebulletin.cec.gov.tw/?dir=111");
  assertStringIncludes(config, "https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1%2F02%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1%2F113%E5%B9%B4%E7%AC%AC11%E5%B1%86");
});

Deno.test("四處清點：TASK_TYPES、SUGGESTED_TYPE、task-labels（純中文）、skill.md；另加做法、查證來源、看板顏色", async () => {
  assert((TASK_TYPES as readonly string[]).includes(T), "contribution-schema.ts 的 TASK_TYPES 要有");
  assertEquals(SUGGESTED_TYPE[T], "policy");
  const labels = await Deno.readTextFile(new URL("../../../lib/task-labels.ts", import.meta.url));
  const label = labels.match(new RegExp(`\\b${T}:\\s*'([^']*)'`))?.[1];
  assert(label, "lib/task-labels.ts 要有中文名稱");
  assert(!/[A-Za-z]/.test(label!), `中文名稱要純中文：${label}`);
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assertStringIncludes(skill, `\`${T}\``);
  const queue = await Deno.readTextFile(new URL("../../../pages/Queue.vue", import.meta.url));
  assert(new RegExp(`\\b${T}:\\s*'#[0-9a-f]{6}'`).test(queue), "pages/Queue.vue 的 BORDER 要有顏色");
  const g = TASK_GUIDANCE[T];
  assert(g, "task-guidance.ts 要有做法");
  assertStringIncludes(g, `最多 ${MAX_POLICIES_PER_TASK} 筆`);
  assertStringIncludes(g, "選舉公報");
  assertStringIncludes(g, "Campaign Pledge");
  assert(SOURCE_TASK_TYPES.has(T), "派工要附查證來源");
  assertEquals([...needsForTask(T)], ["policy"]);
});

Deno.test("查無守門涵蓋 term_policy_missing：少於 5 個網址 → 400，訊息提選舉公報", async () => {
  assert((NOT_FOUND_SEARCH_TASK_TYPES as readonly string[]).includes(T));
  assertStringIncludes(SEARCH_KEYWORDS[T as keyof typeof SEARCH_KEYWORDS], "選舉公報");
  const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://example${i}.tw/news/x`);
  const taskId = `auto:${T}:${PID}:2022`;
  assertEquals(notFoundSearchShortfall(taskId, { outcome: "not_found", checked_urls: urls(4) })?.task_type, T);
  assertEquals(notFoundSearchShortfall(taskId, { outcome: "not_found", checked_urls: urls(5) }), null);

  const client = {
    // deno-lint-ignore no-explicit-any
    from(): any {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, order: () => chain, limit: () => chain, neq: () => chain, is: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: () => ({ error: null, select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(res),
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  const res = await handleContribute(client, "https://x", {
    agent_name: "tester",
    contribution_type: "no_change",
    payload: { task_id: taskId, outcome: "not_found", checked_urls: urls(3), finding: "看了 2022 選舉公報與兩家地方新聞，都沒有這位議員的具體政見。" },
    source_urls: urls(3),
  }, "ip-1");
  assertEquals(res.status, 400);
  const b = res.body as Record<string, unknown>;
  assertEquals(b.error, "not_found_search_insufficient");
  assertStringIncludes(String(b.message), "選舉公報");
});

Deno.test("任務現況與交件骨架：給既有政見（含屆別）與等票中的；骨架 status 預填 Campaign Pledge、election_id 填該屆", () => {
  const cur = shapeTaskCurrent(T, {
    politician: { id: PID, name: "王小明", party: "無黨籍", region: "彰化縣", avatar_url: null },
    elections: [{ election_id: 2022, election_type: "縣市議員", candidate_status: "confirmed" }],
    policies: [{ id: "a", title: "托育", category: "社會福利", status: "Campaign Pledge", election_id: 2026 }],
    policies_total: 1,
    queued_policies: [],
  }, { task_id: `auto:${T}:${PID}:2022`, target: { politician_id: PID, election_id: 2022, election_type: "縣市議員" } });
  assertEquals((cur.existing_policies as Array<Record<string, unknown>>)[0].election_id, 2026, "既有政見要看得出是哪一屆的，別屆的不算這一屆");
  assert(Array.isArray(cur.queued_policies));
  assertStringIncludes(String(cur.hint), "選舉公報");

  const tpl = buildReportTemplate(T, "policy", { politician_id: PID, election_id: 2022 }, `auto:${T}:${PID}:2022`)!;
  const payload = tpl.payload as Record<string, unknown>;
  assertEquals(payload.status, "Campaign Pledge");
  assertEquals(payload.election_id, 2022);
});
