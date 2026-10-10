/**
 * 日本站入口（jp-next／jp-report）の選舉鏈テスト（第 2～4 步の交件型別）：真的載入入口、用真的 Request 打進去，底下是有狀態的假 PostgREST（jp-entry-chain-db.ts）。
 * 重點：領任務（roster_check…）→ 帶憑證交件 201（目標 3 票）、提交者網段是領任務的網段、全程 policy_jp；欄位不合格 400 整批不收；
 * 任務與交件不符 400；得票數欄位 400；完成合圖 no_change；（第 3、4 步）同一件事 resolved_claim。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { callsTo, env, errorPaths, getNext, makeDb, N1, netHash, post, R, type Row, withEntries } from "./jp-entry-chain-db.ts";

const E1 = "2027-04-25_mayor_232033";
const ROSTER_TASK = `auto:roster_check:${E1}`;
const OFFICIAL = ["https://www.city.ichinomiya.aichi.jp/senkyo/"];
const AGENT = { agent_name: "dave", agent_tool: "claude-code/claude-sonnet-5" };

const rosterRow = {
  task_id: ROSTER_TASK, task_type: "roster_check",
  target: { election_id: E1, election_type: "mayor", lg_code: "232033", phase: "pre_notice", ours_count: 0, ours: [], chain_lg_code: "232033", chain_step: "roster" },
  what_we_need: "一宮市長選挙の立候補者名簿を確かめます。", hint_sources: ["一宮市 選挙管理委員会"], reward: 2, queue_at: "2026-10-01T00:00:00Z",
};
const CAND = {
  kind: "contribute", contribution_type: "candidacy", task_id: ROSTER_TASK, ...AGENT,
  payload: { name: "山田太郎", kana: "やまだたろう", election_id: E1, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large" },
  source_urls: OFFICIAL,
};

Deno.test("candidacy 一整圈：領 roster_check 任務、帶憑證交 candidacy 201（目標 3 票），提交者網段是領任務的網段；全程 policy_jp", async () => {
  const db = makeDb({ queue: [rosterRow] });
  await withEntries(db, env(), async ({ next, report }) => {
    const got = await getNext(next, N1);
    assertEquals(got.json.kind, "task");
    assertEquals((got.json.item as Row).task_type, "roster_check");
    const res = await post(report, R, { ...CAND, dispatch_token: got.json.dispatch_token });
    assertEquals(res.status, 201, JSON.stringify(res.json));
    assertEquals([res.json.contribution_type, res.json.status, res.json.required_agree], ["candidacy", "pending", 3]);
    assertEquals(db.contributions.length, 1);
    const saved = db.contributions[0];
    assertEquals(saved.contribution_type, "candidacy");
    assertEquals(saved.task_id, ROSTER_TASK);
    assertEquals(saved.contributor_ip_hash, await netHash(N1));
    assertEquals((saved.payload as Row).candidacy_status, "declared");
    assertEquals(saved.source_urls, OFFICIAL);
    // 全部の REST 請求が policy_jp の schema ヘッダ付き
    for (const c of report.calls) {
      const ro = c.method === "GET" || c.method === "HEAD";
      assertEquals(c.headers[ro ? "accept-profile" : "content-profile"], "policy_jp", `${c.method} ${c.target}`);
    }
    // candidacy は same_claim 登記表の型別ではない（resolved_claim を要求せず、same_claim_matches も呼ばない）
    assertEquals(callsTo(report.calls, "rpc/same_claim_matches").length, 0);
  });
});

Deno.test("candidacy：欄位が不合格なら整批 400（validation_failed）で何も書かない；得票數の欄位名・任務の選挙違い・知らない状態", async () => {
  const db = makeDb({ queue: [rosterRow] });
  await withEntries(db, env(), async ({ report }) => {
    const votes = await post(report, N1, { ...CAND, payload: { ...CAND.payload, votes: 12345 } });
    assertEquals([votes.status, votes.json.error], [400, "validation_failed"]);
    assertEquals(errorPaths(votes.json), ["payload.votes"]);
    assert(String((votes.json.errors as Array<{ message: string }>)[0].message).includes("得票"));
    const pct = await post(report, N1, { ...CAND, payload: { ...CAND.payload, vote_percentage: 51.2 } });
    assertEquals(errorPaths(pct.json), ["payload.vote_percentage"]);
    const other = await post(report, N1, { ...CAND, payload: { ...CAND.payload, election_id: "2027-04-25_mayor_231011" } });
    assertEquals(errorPaths(other.json), ["payload.election_id"]);
    const status = await post(report, N1, { ...CAND, payload: { ...CAND.payload, candidacy_status: "rumored" } });
    assertEquals(errorPaths(status.json), ["payload.candidacy_status"]);
    const bad = await post(report, N1, { ...CAND, payload: { ...CAND.payload, kana: "ヤマダ", status_date: "2027-02-30", district_kind: "all" } });
    assertEquals(errorPaths(bad.json), ["payload.district_kind", "payload.kana", "payload.status_date"]);
    const typeMismatch = await post(report, N1, { ...CAND, contribution_type: "regional_stat", payload: { lg_code: "232033", stat_key: "population", year: 2025, value: 1, unit: "人", resolved_claim: "new" } });
    assertEquals(errorPaths(typeMismatch.json), ["task_id"]);
    assertEquals(db.contributions.length, 0, "400 的請求不寫任何東西");
  });
});

Deno.test("roster_check の完成合圖：no_change（confirmed／not_found）は light で 2 票・task_id はこの任務；candidacy の task_id と合わなくても no_change は通る", async () => {
  const db = makeDb({ queue: [rosterRow] });
  await withEntries(db, env(), async ({ next, report }) => {
    const got = await getNext(next, N1);
    const nc = {
      kind: "contribute", contribution_type: "no_change", task_id: ROSTER_TASK, ...AGENT, dispatch_token: got.json.dispatch_token,
      payload: { task_id: ROSTER_TASK, outcome: "confirmed", checked_urls: OFFICIAL, finding: "立候補者名簿を開き、全員が登録済みであることを確認した" },
    };
    const res = await post(report, R, nc);
    assertEquals(res.status, 201, JSON.stringify(res.json));
    assertEquals([res.json.contribution_type, res.json.required_agree], ["no_change", 2]);
    assertEquals(db.contributions[0].task_id, ROSTER_TASK);
  });
});

Deno.test("協議版號：エンドポイントが返す版は 0.9.0 以上（選舉鏈第 2 步の交件型別 candidacy を受け付けるので手引きも 0.9.0）", async () => {
  const { JP_PROTOCOL_VERSION } = await import("./jp/protocol.ts");
  const [maj, min] = JP_PROTOCOL_VERSION.split(".").map(Number);
  assert(maj > 0 || min >= 9, JP_PROTOCOL_VERSION);
  const db = makeDb({ queue: [rosterRow] });
  await withEntries(db, env(), async ({ next }) => {
    const got = await getNext(next, N1);
    assertEquals(got.json.protocol_version, JP_PROTOCOL_VERSION);
  });
});
