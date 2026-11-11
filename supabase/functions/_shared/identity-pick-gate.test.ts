// 必須指認的件，同意票沒帶指認在投票當下就退回重投（協議 1.129.0，2026-11-11；廖文雄案）。
// 真的載入 verify-handler 跑：判定與落庫端同一份（resolvePolitician → ambiguous）。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { handleVerify } from "./verify-handler.ts";
import { identityPickRequired } from "./identity-pick-gate.ts";

const CID = "11111111-2222-3333-4444-555555555555";
const P1 = "24835ca6-0000-4000-8000-000000000001";
const NOTE = "中選會登記名冊第 3 列：廖文雄 1946 年生，彰化縣溪州鄉鄉民代表，與站上三位同名者的縣市與黨籍都不同";

// 站上同名一位、縣市與黨籍都對不上 → ambiguous（跟落庫端同一個判定）
const SAME_NAME = [{ id: P1, name: "廖文雄", party: "中國國民黨", region: "雲林縣", position: "縣市議員候選人", birth_year: 1960 }];

function setup(payload: Record<string, unknown>, politicians: Array<Record<string, unknown>>, type = "candidacy", taskId: string | null = null) {
  return createFakeSupabase({
    contributions: [{
      id: CID, status: "pending", contribution_type: type, task_id: taskId, payload, source_urls: ["https://example.test/a"],
      agent_name: "someone", contributor_ip_hash: "ip-other", agree_count: 0, disagree_count: 0, unsure_count: 0, score: 0,
    }],
    verify_dispatches: [{ contribution_id: CID, ip_hash: "ip-mine", agent_name: "dave", dispatched_at: new Date().toISOString() }],
    contribution_votes: [],
    politicians,
    politician_keys: [],
    politician_elections: [],
  });
}
const payload = { name: "廖文雄", party: "民主進步黨", region: "彰化縣", election_type: "鄉鎮市民代表", candidate_status: "registered", election_id: 2026, birth_year: 1946 };
const vote = { agent_name: "dave", contribution_id: CID, verdict: "agree", note: NOTE };
const cec = (() => Promise.resolve(new Response(JSON.stringify({ total_pages: 1, cand_data_list: [] })))) as typeof fetch;
const votes = (db: Record<string, unknown[]>) => (db.contribution_votes ?? []).length;
const errOf = (res: { body: unknown }) => (res.body as Record<string, unknown>).error;

Deno.test("identityPickRequired：只有 ambiguous 要指認", () => {
  assert(identityPickRequired({ decision: "ambiguous" }));
  assert(!identityPickRequired({ decision: "new" }));
  assert(!identityPickRequired({ decision: "matched" }));
  assert(!identityPickRequired(null));
});

Deno.test("必須指認＋agree 沒指認 → 400 identity_pick_required，附 candidates，不寫票", async () => {
  const f = setup(payload, SAME_NAME);
  const res = await handleVerify(f.client, vote, "ip-mine", undefined, "report", cec);
  assertEquals(res.status, 400);
  assertEquals(errOf(res), "identity_pick_required");
  const cands = (res.body as Record<string, unknown>).candidates as Array<Record<string, unknown>>;
  assertEquals(cands.map((c) => c.id), [P1]);
  assertEquals(cands[0].birth_year, 1960);
  assertEquals(cands[0].region, "雲林縣");
  assertEquals(cands[0].party, "中國國民黨");
  assertEquals(votes(f.db), 0, "不記為已投");
});

Deno.test("帶候選 id 或 \"new\" → 不被這道閘擋", async () => {
  for (const pick of [P1, "new"]) {
    const f = setup(payload, SAME_NAME);
    const res = await handleVerify(f.client, { ...vote, resolved_politician_id: pick, cec_hits: 0, cec_people: 0 }, "ip-mine", undefined, "report", cec);
    assert(errOf(res) !== "identity_pick_required", `pick=${pick}`);
  }
});

Deno.test("不須指認（站上沒有同名）→ 照舊收票", async () => {
  const f = setup(payload, []);
  const res = await handleVerify(f.client, vote, "ip-mine", undefined, "report", cec);
  assert(res.status < 400, JSON.stringify(res.body).slice(0, 200));
  assertEquals(votes(f.db), 1);
});

Deno.test("disagree／unsure 沒指認 → 不被這道閘擋", async () => {
  for (const v of [{ verdict: "disagree", evidence_url: "https://example.test/roster" }, { verdict: "unsure" }]) {
    const f = setup(payload, SAME_NAME);
    const res = await handleVerify(f.client, { ...vote, ...v }, "ip-mine", undefined, "report", cec);
    assert(errOf(res) !== "identity_pick_required", v.verdict);
  }
});

Deno.test("交件已指明是誰（payload.politician_id）→ 不擋", async () => {
  const f = setup({ ...payload, politician_id: P1 }, SAME_NAME, "politician");
  const res = await handleVerify(f.client, vote, "ip-mine", undefined, "report", cec);
  assert(errOf(res) !== "identity_pick_required");
});

Deno.test("落庫端的未指認退件仍在（最後防線），閘接在 verify-handler 與 /next 上", async () => {
  const apply = await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url));
  assert(apply.includes("驗證者未指認 resolved_politician_id"));
  const src = await Deno.readTextFile(new URL("./verify-handler.ts", import.meta.url));
  assert(src.includes("checkIdentityPick(") && src.includes('"identity_pick_required"'));
  const next = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assert(next.includes("identity_pick_required: true"));
});
