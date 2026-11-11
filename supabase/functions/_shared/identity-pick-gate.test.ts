// 必須指認的件，同意票沒帶指認在投票當下就退回重投（協議 1.129.0，2026-11-11；廖文雄案）。
// 真的載入 verify-handler 跑：判定與落庫端同一份（resolvePolitician → ambiguous）。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { handleVerify } from "./verify-handler.ts";
import { checkIdentityPick, identityPickRequired } from "./identity-pick-gate.ts";
import { applyContribution } from "./apply-contribution.ts";

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
const payload = { name: "廖文雄", party: "民主進步黨", region: "彰化縣", election_type: "鄉鎮市民代表", candidate_status: "registered", election_id: 2026 };   // 不帶生年：真模糊才要指認（1.130.0：帶生年且同名者缺生年會先建新人物）
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

// ---- 審查補強（#920）----
Deno.test("已有一張同意票帶了指認 → 後來的 agree 沒帶不擋", async () => {
  const f = setup(payload, SAME_NAME);
  f.db.contribution_votes.push({ id: "v0", contribution_id: CID, verdict: "agree", agent_name: "other", resolved_politician_id: P1 });
  const res = await handleVerify(f.client, vote, "ip-mine", undefined, "report", cec);
  assert(errOf(res) !== "identity_pick_required", JSON.stringify(res.body).slice(0, 200));
});

Deno.test("已有的票只是 disagree 帶指認、或指認為空 → 仍要擋", async () => {
  const f = setup(payload, SAME_NAME);
  f.db.contribution_votes.push({ id: "v0", contribution_id: CID, verdict: "disagree", agent_name: "other", resolved_politician_id: P1 });
  f.db.contribution_votes.push({ id: "v1", contribution_id: CID, verdict: "agree", agent_name: "other2", resolved_politician_id: null });
  const res = await handleVerify(f.client, vote, "ip-mine", undefined, "report", cec);
  assertEquals(errOf(res), "identity_pick_required");
});

Deno.test("revise 路徑：自己那張票帶的指認不算「已有指認」；別人的才算", async () => {
  const mine = { id: "v-mine", contribution_id: CID, verdict: "agree", agent_name: "dave", resolved_politician_id: P1, verifier_ip_hash: "ip-mine", note: "舊的核對內容" };
  const f1 = setup(payload, SAME_NAME);
  f1.db.contribution_votes.push(mine);
  const r1 = await handleVerify(f1.client, { ...vote, revise: true }, "ip-mine", undefined, "report", cec);
  assertEquals(errOf(r1), "identity_pick_required", "改掉自己的指認後就沒有指認了");
  const f2 = setup(payload, SAME_NAME);
  f2.db.contribution_votes.push(mine, { id: "v-other", contribution_id: CID, verdict: "agree", agent_name: "other", resolved_politician_id: "new" });
  const r2 = await handleVerify(f2.client, { ...vote, revise: true }, "ip-mine", undefined, "report", cec);
  assert(errOf(r2) !== "identity_pick_required");
});

Deno.test("profile_gap 任務（任務編號指明是誰）→ 豁免", async () => {
  const f = setup(payload, SAME_NAME, "politician", `auto:profile_gap:${P1}`);
  const res = await handleVerify(f.client, vote, "ip-mine", undefined, "report", cec);
  assert(errOf(res) !== "identity_pick_required");
});

Deno.test("via merge（系統併票）→ 不擋", async () => {
  const f = setup(payload, SAME_NAME);
  const res = await handleVerify(f.client, vote, "ip-mine", undefined, "merge", cec);
  assert(errOf(res) !== "identity_pick_required");
});

Deno.test("候選清單不列已併入別人的人物殼", async () => {
  const MERGED = "24835ca6-0000-4000-8000-000000000002";
  const f = setup(payload, [...SAME_NAME, { id: MERGED, name: "廖文雄", party: "無黨籍", region: "彰化縣", merged_into: P1 }]);
  const res = await handleVerify(f.client, vote, "ip-mine", undefined, "report", cec);
  const ids = ((res.body as Record<string, unknown>).candidates as Array<{ id: string }>).map((c) => c.id);
  assertEquals(ids, [P1]);
});

Deno.test("fail-open：比對拋例外 → 放行收票，並記 gate_rejections(identity_gate_error)", async () => {
  const f = setup(payload, SAME_NAME);
  const realFrom = f.client.from.bind(f.client);
  f.client.from = (t: string) => {
    if (t === "politicians") throw new Error("boom");
    return realFrom(t);
  };
  const quiet = console.error;
  console.error = () => {};
  let res;
  try {
    res = await handleVerify(f.client, vote, "ip-mine", undefined, "report", cec);
  } finally {
    console.error = quiet;
  }
  assert(errOf(res) !== "identity_pick_required");
  assert((f.db.gate_rejections ?? []).some((r) => r.gate === "identity_gate_error" && r.contribution_id === CID), "放行要留可觀察的紀錄");
  assertEquals(votes(f.db), 1);
});

Deno.test("對照：同一份 payload 丟進閘門與落庫端，「要不要指認」結論一致", async () => {
  const cases: Array<{ label: string; politicians: Array<Record<string, unknown>> }> = [
    { label: "同名一位、縣市黨籍都不同", politicians: SAME_NAME },
    { label: "同名兩位", politicians: [...SAME_NAME, { id: "24835ca6-0000-4000-8000-000000000003", name: "廖文雄", party: "無黨籍", region: "南投縣", position: "村里長候選人" }] },
  ];
  const row = (type: "candidacy" | "politician") => ({
    id: CID, contribution_type: type, payload, source_urls: ["https://example.test/a"], note: null, agent_name: "someone", contributor_url: null,
  });
  for (const type of ["candidacy", "politician"] as const) {
    for (const c of cases) {
      const f = setup(payload, c.politicians, type);
      const gate = await checkIdentityPick(f.client, type, payload, null);
      const outcome = await applyContribution(f.client, row(type)).catch((e) => ({ status: "failed", message: String(e) }));
      const applyAskedForPick = outcome.status === "disputed" && String(outcome.message).includes("未指認 resolved_politician_id");
      assertEquals(gate.required, applyAskedForPick, `${type}／${c.label}：閘門 ${gate.required}、落庫端 ${outcome.status} ${outcome.message}`);
      assert(gate.required, `${c.label} 應為必須指認`);
    }
  }
  // 站上沒有同名：兩邊都不要求指認
  const f = setup(payload, [], "candidacy");
  const gate = await checkIdentityPick(f.client, "candidacy", payload, null);
  const outcome = await applyContribution(f.client, row("candidacy")).catch((e) => ({ status: "failed", message: String(e) }));
  assertEquals(gate.required, false);
  assert(!String(outcome.message).includes("未指認 resolved_politician_id"));
});
