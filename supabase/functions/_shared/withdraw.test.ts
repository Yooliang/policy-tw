// 提交者撤回（2026-09-21 使用者裁決：「用修改流程的方式讓系統更能處理問題，而不是依賴 key 去作人工清除」）。
// 守的是三個允許條件與「不計入退件」這件事，外加 DB CHECK 與 TS 一致。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleWithdraw, validateWithdrawRequest, WITHDRAW_REASON_MIN } from "./withdraw-handler.ts";

const MINE = "ip-mine";
const OTHER = "ip-other";
const ID = "11111111-2222-3333-4444-555555555555";
const REASON = "來源打開後沒有提到這筆宣稱，我提交時沒有實際開啟";

/** 只夠這支測試用的假 supabase：一張 contributions。 */
function fakeDb(row: Record<string, unknown> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    from() {
      return {
        select() {
          return { eq() { return { maybeSingle: () => Promise.resolve({ data: row, error: null }) }; } };
        },
        update(patch: Record<string, unknown>) {
          updates.push(patch);
          return { eq() { return { eq: () => Promise.resolve({ error: null }) }; } };
        },
      };
    },
  };
  return { client, updates };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    status: "pending",
    contribution_type: "policy",
    contributor_ip_hash: MINE,
    agent_name: "dave",
    disagree_count: 0,
    task_id: "auto:policy_missing:abc",
    review_notes: null,
    ...over,
  };
}

const body = (over: Record<string, unknown> = {}) => ({ agent_name: "dave", contribution_id: ID, reason: REASON, ...over });

Deno.test("撤回的理由要說得出為什麼站不住，不能只寫「交錯了」", () => {
  assertEquals(validateWithdrawRequest({ contribution_id: ID, reason: REASON }).ok, true);
  const short = validateWithdrawRequest({ contribution_id: ID, reason: "交錯了" });
  assertEquals(short.ok, false);
  assertEquals(short.errors[0].path, "reason");
  assert(WITHDRAW_REASON_MIN >= 10, "理由下限不要低到可以用兩個字打發");
  assertEquals(validateWithdrawRequest({ contribution_id: "not-a-uuid", reason: REASON }).ok, false);
});

Deno.test("只有提交者本人能撤回：身份看來源 IP，不是自報代號", async () => {
  const { client, updates } = fakeDb(row());
  // 同一個代號、不同機器 → 不是提交者
  const res = await handleWithdraw(client, body(), OTHER);
  assertEquals(res.status, 403);
  assertEquals(res.body.error, "not_yours");
  assertEquals(updates.length, 0, "擋下來就不該寫任何東西");
});

Deno.test("已經有人投反對票就不准撤回——撤回不能當逃避爭議的後門", async () => {
  const { client, updates } = fakeDb(row({ disagree_count: 1 }));
  const res = await handleWithdraw(client, body(), MINE);
  assertEquals(res.status, 409);
  assertEquals(res.body.error, "already_disputed");
  assertEquals(updates.length, 0);
});

Deno.test("已落庫的不走撤回，要走更正／移除", async () => {
  for (const status of ["applied", "verified", "rejected", "superseded"]) {
    const { client, updates } = fakeDb(row({ status }));
    const res = await handleWithdraw(client, body(), MINE);
    assertEquals(res.status, 409, `${status} 不該可以撤回`);
    assertEquals(res.body.error, "not_pending");
    assertEquals(updates.length, 0);
  }
});

Deno.test("三個條件都成立 → 標 withdrawn、理由進 review_notes、明講不計入退件", async () => {
  const { client, updates } = fakeDb(row());
  const res = await handleWithdraw(client, body(), MINE);
  assertEquals(res.status, 200);
  assertEquals(res.body.success, true);
  assertEquals(res.body.status, "withdrawn");
  assertEquals(res.body.counts_as_rejection, false, "撤回是誠實回報，不是被否決；算成退件就沒有代理敢認錯");
  assertEquals(updates.length, 1);
  assertEquals(updates[0].status, "withdrawn");
  assert(String(updates[0].review_notes).includes(REASON), "理由要留在紀錄裡，別人才知道為什麼撤");
  assert(String(updates[0].review_notes).startsWith("[withdraw]"), "標記來源，跟維護者退件分得開");
});

Deno.test("撤回的回覆要讓代理知道缺口會回到池子裡，而不是以為事情結束了", async () => {
  const { client } = fakeDb(row());
  const res = await handleWithdraw(client, body(), MINE);
  assert(String(res.body.message).includes("任務池"), "帶 task_id 的要說缺口會回去，請重查後再交");
  const noTask = fakeDb(row({ task_id: null }));
  const res2 = await handleWithdraw(noTask.client, body(), MINE);
  assert(!String(res2.body.message).includes("任務池"), "沒有任務的不要亂講");
});

// 2026-09-20 的坑：型別／狀態進了 TS 卻沒進 DB 的 CHECK，代理交件全被擋而測試全綠。
Deno.test("DB 的 status CHECK 要包含 withdrawn", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  let found: string | null = null;
  for (const name of names.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    const at = sql.indexOf("CONSTRAINT contributions_status_check");
    if (at >= 0) { found = sql.slice(at); break; }
  }
  assert(found, "找不到定義 contributions_status_check 的 migration");
  for (const s of ["pending", "verified", "disputed", "rejected", "applied", "apply_failed", "reverted", "superseded", "withdrawn"]) {
    assert(found!.includes(`'${s}'`), `DB 的 status CHECK 少了 ${s}`);
  }
});

Deno.test("report 端點認得 withdraw，而且錯誤訊息講得出三種 kind", async () => {
  const src = await Deno.readTextFile(new URL("../report/index.ts", import.meta.url));
  assert(src.includes('kind === "withdraw"'), "report 要分派 withdraw");
  assert(src.includes("handleWithdraw"), "report 要呼叫 handleWithdraw");
  const bad = src.slice(src.indexOf('error: "kind 要是'));
  assert(bad.includes("withdraw"), "kind 不對時的訊息要告訴代理還有 withdraw 這條路");
});
