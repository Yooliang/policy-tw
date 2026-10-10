/**
 * 日本站入口（jp-next／jp-report）の選舉鏈テスト（第 2～4 步の交件型別）：真的載入入口、用真的 Request 打進去，底下是有狀態的假 PostgREST（jp-entry-chain-db.ts）。
 * 重點：領任務（roster_check…）→ 帶憑證交件 201（目標 3 票）、提交者網段是領任務的網段、全程 policy_jp；欄位不合格 400 整批不收；
 * 任務與交件不符 400；得票數欄位 400；完成合圖 no_change；（第 3、4 步）同一件事 resolved_claim。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { BATCH_SAME_CLAIM, sameClaimInBatch } from "./jp/contribute-handler.ts";
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

// ---------------------------------------------------------------------------------------------
// politician（選舉鏈第 3 步）
// ---------------------------------------------------------------------------------------------
const PID = "5f0c8d6e-1111-4222-8333-444444444444";
const PROFILE_TASK = `auto:profile_gap:${PID}`;
const profileRow = {
  task_id: PROFILE_TASK, task_type: "profile_gap",
  target: { politician_id: PID, name: "山田太郎", kana: "やまだたろう", election_id: E1, lg_code: "232033", missing: ["birth_year"], chain_lg_code: "232033", chain_step: "profile" },
  what_we_need: "生年が未登録です。", hint_sources: ["公式サイト"], reward: 1, queue_at: "2026-10-01T00:00:00Z",
};
const POL = {
  kind: "contribute", contribution_type: "politician", task_id: PROFILE_TASK, ...AGENT,
  payload: { politician_id: PID, birth_year: 1970, resolved_claim: "new" }, source_urls: ["https://www.city.ichinomiya.aichi.jp/gikai/"],
};

Deno.test("politician 一整圈：領 profile_gap 任務（item.current.same_claims が付く）→ resolved_claim=new で 201（目標 3 票）；全程 policy_jp", async () => {
  const db = makeDb({ queue: [profileRow], sameClaims: { politician: { existing: [], pending: [] } } });
  await withEntries(db, env(), async ({ next, report }) => {
    const got = await getNext(next, N1);
    assertEquals((got.json.item as Row).task_type, "profile_gap");
    assertEquals(((got.json.item as Row).current as Row).same_claims, { existing: [], pending: [] });
    const probe = callsTo(report.calls, "rpc/same_claim_matches")[0];
    assertEquals((probe.body as Row).p_type, "politician");
    assertEquals((probe.body as Row).p_payload, { politician_id: PID });
    const res = await post(report, R, { ...POL, dispatch_token: got.json.dispatch_token });
    assertEquals(res.status, 201, JSON.stringify(res.json));
    assertEquals([res.json.contribution_type, res.json.status, res.json.required_agree], ["politician", "pending", 3]);
    assertEquals(db.contributions[0].contributor_ip_hash, await netHash(N1));
    for (const c of report.calls) {
      const ro = c.method === "GET" || c.method === "HEAD";
      assertEquals(c.headers[ro ? "accept-profile" : "content-profile"], "policy_jp", `${c.method} ${c.target}`);
    }
  });
});

Deno.test("politician：resolved_claim がない・事実なし・別の人の task は 400；既に庫にある事実を new で出すと 409 duplicate_claim で何も書かない", async () => {
  const db = makeDb({ queue: [profileRow], sameClaims: { politician: { existing: [{ id: PID, fact: "birth_year" }], pending: [] } } });
  await withEntries(db, env(), async ({ report }) => {
    const noClaim = await post(report, N1, { ...POL, payload: { politician_id: PID, birth_year: 1970 } });
    assertEquals([noClaim.status, errorPaths(noClaim.json)], [400, ["payload.resolved_claim"]]);
    const noFact = await post(report, N1, { ...POL, payload: { politician_id: PID, resolved_claim: "new" } });
    assertEquals(errorPaths(noFact.json), ["payload.birth_year"]);
    const other = await post(report, N1, { ...POL, payload: { politician_id: "someone-else", birth_year: 1970, resolved_claim: "new" } });
    assertEquals(errorPaths(other.json), ["payload.politician_id"]);
    assertEquals(db.contributions.length, 0);
    const dup = await post(report, N1, POL);
    assertEquals(dup.status, 409, JSON.stringify(dup.json));
    assertEquals(dup.json.error, "duplicate_claim");
    assertEquals(db.contributions.length, 0, "409 は何も書かない");
  });
});

// ---------------------------------------------------------------------------------------------
// policy（選舉鏈第 4 步）
// ---------------------------------------------------------------------------------------------
const PEID = `${PID}:${E1}:at_large`;
const POLICY_TASK = `auto:policy_missing:${PEID}`;
const policyRow = {
  task_id: POLICY_TASK, task_type: "policy_missing",
  target: { politician_election_id: PEID, politician_id: PID, name: "山田太郎", election_id: E1, lg_code: "232033", queued_policies: [], chain_lg_code: "232033", chain_step: "policy" },
  what_we_need: "公約がまだ 1 件も登録されていません。", hint_sources: ["選挙公報"], reward: 2, queue_at: "2026-10-01T00:00:00Z",
};
const POLICY = {
  kind: "contribute", contribution_type: "policy", task_id: POLICY_TASK, ...AGENT,
  payload: {
    politician_election_id: PEID, title: "保育所の待機児童をなくす", description: "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。",
    category: "子育て", source_locator: "選挙公報 2 頁", resolved_claim: "new",
  },
  source_urls: ["https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf"],
};

Deno.test("policy 一整圈：領 policy_missing 任務（同一件事の探査が政見の鍵で呼ばれる）→ 帶憑證交 policy 201（目標 3 票）；全程 policy_jp", async () => {
  const db = makeDb({ queue: [policyRow], sameClaims: { policy: { existing: [], pending: [] } } });
  await withEntries(db, env(), async ({ next, report }) => {
    const got = await getNext(next, N1);
    assertEquals((got.json.item as Row).task_type, "policy_missing");
    const probe = callsTo(report.calls, "rpc/same_claim_matches")[0];
    assertEquals([(probe.body as Row).p_type, (probe.body as Row).p_payload], ["policy", { politician_election_id: PEID }]);
    const res = await post(report, R, { ...POLICY, dispatch_token: got.json.dispatch_token });
    assertEquals(res.status, 201, JSON.stringify(res.json));
    assertEquals([res.json.contribution_type, res.json.status, res.json.required_agree], ["policy", "pending", 3]);
    assertEquals(db.contributions[0].contributor_ip_hash, await netHash(N1));
    for (const c of report.calls) {
      const ro = c.method === "GET" || c.method === "HEAD";
      assertEquals(c.headers[ro ? "accept-profile" : "content-profile"], "policy_jp", `${c.method} ${c.target}`);
    }
  });
});

Deno.test("policy：400（resolved_claim なし・要約が長すぎる・別の参選の task・origin 指定）、審議中の同じ題名を new で出すと 409 duplicate_claim、指す id が違うと 409 claim_mismatch；何も書かない", async () => {
  const pending = { contribution_id: "00000000-0000-4000-8000-0000000000aa", status: "pending", title: "保育所の待機児童をなくす" };
  const db = makeDb({ queue: [policyRow], sameClaims: { policy: { existing: [], pending: [pending] } } });
  await withEntries(db, env(), async ({ report }) => {
    const noClaim = await post(report, N1, { ...POLICY, payload: { ...POLICY.payload, resolved_claim: undefined } });
    assertEquals([noClaim.status, errorPaths(noClaim.json)], [400, ["payload.resolved_claim"]]);
    const long = await post(report, N1, { ...POLICY, payload: { ...POLICY.payload, description: "あ".repeat(121) } });
    assertEquals(errorPaths(long.json), ["payload.description"]);
    const other = await post(report, N1, { ...POLICY, payload: { ...POLICY.payload, politician_election_id: "x:y:at_large" } });
    assertEquals(errorPaths(other.json), ["payload.politician_election_id"]);
    const origin = await post(report, N1, { ...POLICY, payload: { ...POLICY.payload, origin: "budget" } });
    assertEquals(errorPaths(origin.json), ["payload.origin"]);
    assertEquals(db.contributions.length, 0);
    const dup = await post(report, N1, POLICY);
    assertEquals([dup.status, dup.json.error], [409, "duplicate_claim"]);
    const mismatch = await post(report, N1, { ...POLICY, payload: { ...POLICY.payload, resolved_claim: "00000000-0000-4000-8000-0000000000bb" } });
    assertEquals([mismatch.status, mismatch.json.error], [409, "claim_mismatch"]);
    assertEquals(db.contributions.length, 0, "409 は何も書かない");
  });
});

Deno.test("協議版號：エンドポイントが返す版は 0.10.0 以上（第 4 步の政見まで受け付けた版）", async () => {
  const { JP_PROTOCOL_VERSION } = await import("./jp/protocol.ts");
  const [maj, min] = JP_PROTOCOL_VERSION.split(".").map(Number);
  assert(maj > 0 || min >= 10, JP_PROTOCOL_VERSION);
  const db = makeDb({ queue: [policyRow] });
  await withEntries(db, env(), async ({ next }) => {
    const got = await getNext(next, N1);
    assertEquals(got.json.protocol_version, JP_PROTOCOL_VERSION);
  });
});

// ---------------------------------------------------------------------------------------------
// #557 審査：一つの任務に多份の公約（同一批の重複と別題名）
// ---------------------------------------------------------------------------------------------
const policyItem = (title: string, description: string) => ({
  contribution_type: "policy", task_id: POLICY_TASK,
  payload: { ...POLICY.payload, title, description },
  source_urls: POLICY.source_urls,
});

Deno.test("同じ task_id に別の題名の公約が多份＝全部入庫（一題多份）。一批に同じ題名の new が 2 件＝最初の 1 件だけ入り、2 件目は duplicate_claim で止まる", async () => {
  const db = makeDb({ queue: [policyRow], sameClaims: { policy: { existing: [], pending: [] } } });
  await withEntries(db, env(), async ({ report }) => {
    const many = await post(report, N1, {
      kind: "contribute", ...AGENT,
      contributions: [policyItem("保育所の待機児童をなくす", "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。"),
        policyItem("道路の舗装を更新する", "道路の舗装を 5 年で 20 キロ更新する。"),
        policyItem("防災無線を全戸に整える", "防災無線の戸別受信機を 2 年で全戸に配る。")],
    });
    assertEquals(many.status, 201, JSON.stringify(many.json));
    assertEquals(db.contributions.length, 3, "別題名は 3 件とも入庫");
    assertEquals(new Set(db.contributions.map((c) => c.task_id)), new Set([POLICY_TASK]));
  });
  const db2 = makeDb({ queue: [policyRow], sameClaims: { policy: { existing: [], pending: [] } } });
  await withEntries(db2, env(), async ({ report }) => {
    const dup = await post(report, N1, {
      kind: "contribute", ...AGENT,
      contributions: [policyItem("保育所の待機児童をなくす", "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。"),
        policyItem("保育所の　待機児童を なくす", "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。")],
    });
    assertEquals(db2.contributions.length, 1, JSON.stringify(dup.json));
    const results = (dup.json.results ?? []) as Array<Row>;
    assertEquals(results[1].status, "not_accepted");
    assertEquals(results[1].error, "duplicate_claim");
  });
});

Deno.test("sameClaimInBatch の policy 分岐：同じ参選＋空白・全半角違いの題名＝同じ件、題名違い・参選違い＝別（還原驗證：分岐を消したコピーは同じ件と判定できない）", async () => {
  const mk = (peid: string, title: string) => ({ contribution_type: "policy", payload: { politician_election_id: peid, title } });
  assert(sameClaimInBatch(mk("pe1", "保育所の待機児童をなくす"), mk("pe1", "保育所の　待機児童を なくす")));
  assert(!sameClaimInBatch(mk("pe1", "保育所の待機児童をなくす"), mk("pe1", "別の公約です")));
  assert(!sameClaimInBatch(mk("pe1", "保育所の待機児童をなくす"), mk("pe2", "保育所の待機児童をなくす")));
  // 還原：policy の判定を外した表を渡すと、同じ題名でも同じ件と判定できない（ファイルは書かない。CI は --allow-read だけ）
  const { policy: _drop, ...withoutPolicy } = BATCH_SAME_CLAIM;
  assert(!sameClaimInBatch(mk("pe1", "保育所の待機児童をなくす"), mk("pe1", "保育所の待機児童をなくす"), withoutPolicy), "分岐がなければ同じ件と判定されない＝一批の重複を止められない");
  assertEquals(Object.keys(withoutPolicy).length, Object.keys(BATCH_SAME_CLAIM).length - 1);
});
