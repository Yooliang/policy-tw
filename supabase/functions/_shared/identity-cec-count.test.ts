// 同名指認要附中選會筆數（協議 1.29.0，2026-09-23）。
// 金門重複建檔：兩票都讀資料庫裡標錯的縣市，一起指錯人——讀同一份錯資料的兩票等於一票。
// 出生年在 identity_candidates 裡抄得到；「中選會查這個姓名回幾筆」只有真的查過才知道，伺服器當場核。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { cecCountName, checkCecCount, countHits } from "./identity-cec-count.ts";
import { handleVerify } from "./verify-handler.ts";

// 實測 2026-09-23：查「林淑芬」會連「洪林淑芬」一起回——中選會是子字串比對
const LIST = [
  { cand_name: "林淑芬", cand_birthyear: "1972" },
  { cand_name: "林淑芬", cand_birthyear: "1972" },
  { cand_name: "林淑芬", cand_birthyear: "1965" },
  { cand_name: "洪林淑芬", cand_birthyear: "1958" },
];

Deno.test("N 有兩種數法：全部回傳筆數，或姓名完全相同的筆數；出生年只數完全同名的", () => {
  assertEquals(countHits("林淑芬", LIST), { all: 4, exact: 3, birthYears: 2 });
});

Deno.test("只有 politician／candidacy 的同意票帶了指認、payload 有姓名才要附", () => {
  assertEquals(cecCountName("candidacy", "agree", "new", { name: "林淑芬" }), "林淑芬");
  assertEquals(cecCountName("politician", "agree", "0cb8c5b8-4e6b-41b3-bde1-dd71ad1293cd", { name: "林淑芬" }), "林淑芬");
  assertEquals(cecCountName("candidacy", "agree", null, { name: "林淑芬" }), null, "沒指認就不用");
  assertEquals(cecCountName("candidacy", "unsure", "new", { name: "林淑芬" }), null, "不是同意票不會套用指認");
  assertEquals(cecCountName("policy", "agree", "new", { name: "林淑芬" }), null);
  assertEquals(cecCountName("candidacy", "agree", "new", { politician_id: "x" }), null, "只帶 id 沒有同名問題");
});

Deno.test("沒寫數字 → 退回補寫；兩種數法任一對上 → 收；都對不上 → 退回", () => {
  const hits = countHits("林淑芬", LIST);
  const missing = checkCecCount("林淑芬", { hits: 4 }, hits);
  assertEquals(missing.ok, false);
  if (!missing.ok) assertEquals(missing.error, "cec_count_required");
  assertEquals(checkCecCount("林淑芬", { hits: 4, people: 2 }, hits).ok, true);
  assertEquals(checkCecCount("林淑芬", { hits: 3, people: 2 }, hits).ok, true);
  const wrong = checkCecCount("林淑芬", { hits: 2, people: 2 }, hits);
  assertEquals(wrong.ok, false);
  if (!wrong.ok) {
    assertEquals(wrong.error, "cec_count_mismatch");
    assert(wrong.message.includes("4 筆") && wrong.message.includes("3 筆"), "要講系統查到幾筆，代理才知道差在哪");
  }
});

Deno.test("中選會查不到（掛了、逾時）不擋票，只在備註記未核——系統的問題不該讓代理白做", () => {
  const r = checkCecCount("林淑芬", { hits: 4, people: 2 }, null);
  assert(r.ok && r.noteSuffix.includes("未核"));
});

// ---- 接在投票端點上 ----
const CID = "11111111-2222-3333-4444-555555555555";

function fake() {
  const inserted: Array<Record<string, unknown>> = [];
  const contribution = {
    id: CID, status: "pending", contribution_type: "candidacy",
    payload: { name: "林淑芬", election_id: 2026 }, source_urls: ["https://example.test/a"],
    agent_name: "someone", contributor_ip_hash: "ip-other",
    agree_count: 0, disagree_count: 0, unsure_count: 0,
  };
  const client = {
    from(table: string) {
      const chain = {
        select() { return chain; }, eq() { return chain; }, gte() { return chain; }, order() { return chain; },
        limit() { return chain; }, in() { return chain; }, neq() { return chain; },
        maybeSingle() {
          if (table === "contributions") return Promise.resolve({ data: contribution, error: null });
          if (table === "verify_dispatches") return Promise.resolve({ data: { contribution_id: CID }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(res: (v: unknown) => unknown) { return Promise.resolve({ data: [], error: null, count: 0 }).then(res); },
        insert(row: Record<string, unknown>) { inserted.push({ table, ...row }); return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "v1" }, error: null }) }) }; },
        update() { return chain; },
        upsert() { return Promise.resolve({ error: null }); },
      };
      return chain;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { client, inserted };
}

const cec = (() => Promise.resolve(new Response(JSON.stringify({ total_pages: 1, cand_data_list: LIST })))) as typeof fetch;
const vote = { agent_name: "dave", contribution_id: CID, verdict: "agree", note: "中選會查林淑芬 4 筆，1972 年那位 2022 當選同選區，這次登記名冊第 3 列", resolved_politician_id: "new" };

Deno.test("端點：帶指認沒附數字 → 400、不寫票", async () => {
  const { client, inserted } = fake();
  const res = await handleVerify(client, vote, "ip-mine", undefined, "report", cec);
  assertEquals(res.status, 400);
  assertEquals(res.body.error, "cec_count_required");
  assertEquals(inserted.filter((r) => r.table === "contribution_votes").length, 0, "不寫票");
  // 2026-09-24：退回要留紀錄，否則這道守門在資料上跟「從未生效」分不出來
  const g = inserted.find((r) => r.table === "gate_rejections");
  assertEquals(g?.gate, "cec_count_required");
  assertEquals(g?.contribution_id, CID);
});

Deno.test("端點：數字對上 → 收票，備註附上系統核對結果", async () => {
  const { client, inserted } = fake();
  const res = await handleVerify(client, { ...vote, cec_hits: 4, cec_people: 2 }, "ip-mine", undefined, "report", cec);
  assert(res.status < 400, JSON.stringify(res.body).slice(0, 200));
  const row = inserted.find((r) => r.table === "contribution_votes");
  assert(String(row?.note).includes("系統核 4 筆"), "備註要留下系統核對的痕跡");
});

Deno.test("端點：數字對不上 → 400 cec_count_mismatch", async () => {
  const { client, inserted } = fake();
  const res = await handleVerify(client, { ...vote, cec_hits: 9, cec_people: 2 }, "ip-mine", undefined, "report", cec);
  assertEquals(res.body.error, "cec_count_mismatch");
  assertEquals(inserted.filter((r) => r.table === "contribution_votes").length, 0);
  assertEquals(inserted.find((r) => r.table === "gate_rejections")?.gate, "cec_count_mismatch");
});
