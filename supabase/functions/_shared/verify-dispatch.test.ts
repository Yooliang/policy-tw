// 派發即綁定（2026-09-21 使用者裁示：「這是任務派發的問題，不是投票的問題」）。
//
// 跑任務的伙伴示範過怎麼繞過：/verifications 一次列 50 筆自己挑，用同一份官方 PDF
// 對 16 筆投同樣的票。而 contributions-feed 是公開的、id 拿得到，所以光關端點擋不住。
// 執行點在投票時要求「這一筆是不是 /next 派給你的」。
//
// 寫這支的另一個理由：加了這道閘之後 343 支測試毫無變化——因為**沒有任何測試呼叫過
// handleVerify**。投票這條主路徑一直只靠線上實測在驗。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleVerify } from "./verify-handler.ts";

const CID = "11111111-2222-3333-4444-555555555555";
const MINE = "ip-mine";

/** 只夠這支用的假 supabase：記得哪些表被查了什麼。 */
function fake(opts: { dispatched: boolean }) {
  const inserted: Array<Record<string, unknown>> = [];
  const contribution = {
    id: CID, status: "pending", contribution_type: "policy",
    payload: { title: "測試政見" }, source_urls: ["https://example.test/a"],
    agent_name: "someone", contributor_ip_hash: "ip-other",
    agree_count: 0, disagree_count: 0, unsure_count: 0,
  };
  const client = {
    from(table: string) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        gte() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        in() { return chain; },
        neq() { return chain; },
        maybeSingle() {
          if (table === "contributions") return Promise.resolve({ data: contribution, error: null });
          if (table === "verify_dispatches") return Promise.resolve({ data: opts.dispatched ? { contribution_id: CID } : null, error: null });
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

const body = { agent_name: "dave", contribution_id: CID, verdict: "agree", note: "打開來源逐欄核對，標題與內容都對得上" };

Deno.test("沒有被派到這一筆就不能投——代理不能自己挑題目", async () => {
  const { client, inserted } = fake({ dispatched: false });
  const res = await handleVerify(client, body, MINE);
  assertEquals(res.status, 409);
  assertEquals(res.body.error, "not_dispatched");
  assert(String(res.body.message).includes("/next"), "訊息要告訴它工作從哪裡來，不然它不知道怎麼辦");
  assertEquals(inserted.length, 0, "擋下來就不該寫任何票");
});

Deno.test("被派到了就照常收，而且票要真的寫進去", async () => {
  const { client, inserted } = fake({ dispatched: true });
  const res = await handleVerify(client, body, MINE);
  assert(res.status < 400, `被派到的票不該被擋（實際 ${res.status}：${JSON.stringify(res.body).slice(0, 200)}）`);
  assert(inserted.some((r) => r.table === "contribution_votes"), "票要寫進 contribution_votes");
});


// 2026-09-21：派發閘上線後把「重複提交＝同意票」安靜關了 10 小時——併票那一票不是代理挑的題目，閘要放行。
Deno.test("via merge（重複提交配對成的票）沒被派發也要收——派發閘不得擋下併票", async () => {
  const { client, inserted } = fake({ dispatched: false });
  const res = await handleVerify(client, body, MINE, undefined, "merge");
  assert(res.status < 400, `併票不該被派發閘擋（實際 ${res.status}：${JSON.stringify(res.body).slice(0, 200)}）`);
  assert(inserted.some((r) => r.table === "contribution_votes"), "票要寫進 contribution_votes");
  assertEquals(inserted.find((r) => r.table === "contribution_votes")?.via, "merge");
});
