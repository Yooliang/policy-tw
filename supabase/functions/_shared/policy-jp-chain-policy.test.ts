/**
 * 日本站「選舉鏈」第 4 步：這次的政見（migration 20261010060000_policy_jp_chain_policy.sql）。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts，照檔名排序，不寫死清單）；時鐘用 `SET app.activity_today`。
 *
 *   a. 結構：步驟清單八步、臂名・總表・規則三處一起加、規則 after_step=profile＋後備（告示日翌日）、優先層規則、chain_step_rank（6）、型別清單對齊、題名正規化 TS／SQL 對齊
 *   b. 鏈的三個情境（假時鐘＋seed）：1. 前一步（建檔）完成才開  2. 前一步卡住但後備（告示日翌日）到了照開  3. 已開的不收回
 *   c. 臂：對象（considering・退選は派さない）・公約が 1 件でもあれば消える・審議中の題名を渡す・冷卻・cap
 *   d. 進度視圖 policy：每一位對象都有政見（または查無で冷卻中）才 done
 *   e. 落庫 apply_policy：新增（origin=pledge、not_started）・同題名 unchanged・要約違い conflict・題名の正規化・字數の境界・日付・出處と履歴
 *   f. 同一件事：政見の鍵（参選＋題名の正規化）、探査、收編
 *   g. 文字守門：総表・apply_contribution・same_claim_same_content＝緊接在前一版剛好多的幾行；gate 行の行為還原驗證；自我檢查；冪等；權限
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import { JP_APPLY_TYPES } from "./jp/apply-contribution.ts";
import { JP_CONTRIBUTION_TYPES, jpTrim, policyTitleKey } from "./jp/contribution-schema.ts";
import { jpSameClaimProbe } from "./jp/same-claim-probe.ts";
import { JP_PROTOCOL_VERSION } from "./jp/protocol.ts";
import {
  addDays, applyOne, asRole, check, clock, count, dispatchIds, dispatches, events, expireCooling, freshDb, ELECTION_URL, ICHI, migratedDb,
  mutate, one, openElectionWithRegion, readMig, rows, seed, statusOf, stepsDone, submit, vote,
} from "./policy-jp-chain-db.ts";

const MIG_FILE = "20261010060000_policy_jp_chain_policy.sql";
const PREV_FILE = "20261010050000_policy_jp_chain_profile.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV_SQL = await readMig(PREV_FILE);
const POLLING = "2027-04-25";
const NOTICE = "2027-04-08";
const E1 = `${POLLING}_mayor_${ICHI}`;
const POLICY = ["policy_missing"];
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const KOUHOU = "https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf";

const shared = await freshDb();
type Db = Awaited<ReturnType<typeof freshDb>>;

async function addCand(db: Db, name: string, kana: string, status = "declared", o: Record<string, unknown> = {}): Promise<{ pid: string; peid: string }> {
  const payload = { election_id: E1, name, kana, candidacy_status: status, status_date: "2027-03-01", district_kind: "at_large", ...o };
  const id = await submit(db, "candidacy", payload, { status: "verified", urls: [ELECTION_URL] });
  const out = await applyOne(db, id);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pid = (await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id;
  return { pid, peid: out.record_id! };
}
/** 建檔を済ませる（生年＋学歴・出典つき）：進度視圖の profile が done になる */
async function profile(db: Db, pid: string) {
  const out = await applyOne(db, await submit(db, "politician", { politician_id: pid, birth_year: 1975, education: ["○○大学卒業"], resolved_claim: "new" }, { status: "verified", urls: ["https://www.pref.aichi.lg.jp/p/"] }));
  assertEquals(out.status, "applied", JSON.stringify(out));
}
const pol = (peid: string, o: Record<string, unknown> = {}) => ({
  politician_election_id: peid, title: "保育所の待機児童をなくす", description: "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。",
  category: "子育て", source_locator: "選挙公報 2 頁「子育て」", resolved_claim: "new", ...o,
});
const submitPolicy = (db: Db, payload: Record<string, unknown>, o: Parameters<typeof submit>[3] = {}) => submit(db, "policy", payload, { status: "verified", urls: [KOUHOU], ...o });

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：步驟清單八步；臂名・總表・規則三處一起加；規則 after_step=profile＋後備（告示日翌日）；優先層規則；步驟順位 6；型別清單 TS／SQL 對齊；協議版號 0.10.0 以上", async () => {
  assertEquals((await one<{ s: string[] }>(shared, `SELECT policy_jp.election_chain_steps() AS s`)).s,
    ["discovery", "local_government", "regional_stats", "region", "roster", "candidacy", "profile", "policy"]);
  assert((await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a.includes("policy_missing"));
  assert(fnText(MIG_SQL, TOTAL).includes("contribution_auto_tasks_policy_missing()"));
  const rule = await one<{ after_step: string; params: Record<string, unknown>; window_kind: string }>(shared,
    `SELECT after_step, params, window_kind FROM policy_jp.activity_rules WHERE activity = 'policy_missing' AND priority IS NULL`);
  assertEquals([rule.after_step, rule.window_kind], ["profile", "always"]);
  assertEquals(rule.params, { cap: 200, chain_fallback: { kind: "announced", offset: 1 } });
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:policy_missing' AND priority IN (1, 3)`), 2);
  const rank = (id: string, t: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, t]).then((x) => x.r);
  assertEquals(await rank("auto:policy_missing:x", "policy_missing"), 6);
  assertEquals(await rank("auto:profile_gap:x", "profile_gap"), 5, "前の步驟の順位は変わらない");
  assertEquals(await rank("auto:other:x", "other"), 9);
  assertEquals((await one<{ t: string[] }>(shared, `SELECT policy_jp.apply_types() AS t`)).t, [...JP_APPLY_TYPES]);
  const chk = (await one<{ d: string }>(shared, `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check'`)).d;
  assertEquals(new Set([...chk.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])), new Set(JP_CONTRIBUTION_TYPES), "DB CHECK＝TS の型別清單（漏了＝代理交件全被擋而測試全綠）");
  const [maj, min] = JP_PROTOCOL_VERSION.split(".").map(Number);
  assert(maj > 0 || min >= 10, `協議版號 ${JP_PROTOCOL_VERSION} 不低於 0.10.0（第 2 步が 0.9.0、第 4 步で 0.10.0）`);
});

Deno.test("題名の正規化：TS policyTitleKey と SQL policy_title_key が同じ結果（全角半角・大文字小文字・空白・全角空白・NFKC）", async () => {
  const samples = ["保育所の待機児童をなくす", "保育所の 待機児童を　なくす", "ＡＩ活用で窓口を効率化", "ai活用で窓口を効率化", "ﾊﾟｰｸ整備", "パーク整備", "  Ｃｉｔｙ  Plan  ", "①ゼロ", "1ゼロ", ""];
  for (const s of samples) {
    const sql = (await one<{ k: string }>(shared, `SELECT policy_jp.policy_title_key($1) AS k`, [s])).k;
    assertEquals(policyTitleKey(s), sql, JSON.stringify(s));
  }
  assertEquals(policyTitleKey("ＡＩ活用で窓口を効率化"), policyTitleKey("ai 活用で 窓口を効率化"));
});

Deno.test("DB CHECK 還原驗證：この migration の前の庫は policy を擋ぎ、套すと收める", async () => {
  const before = await migratedDb({ before: MIG_FILE });
  await assertRejects(() => submit(before, "policy", pol("x"), { urls: [KOUHOU] }), Error, "policy_jp_contributions_type_check");
  await before.close();
  const db = await freshDb();
  await submit(db, "policy", pol("x"), { urls: [KOUHOU] });
  await db.close();
});

// =============================================================================================
// b. 鏈の三個情境
// =============================================================================================
Deno.test("情境 1　前一步（建檔）完成才開：建檔が済んでいない間 policy_missing は擋ぐ（opened_by＝NULL）、済むと下一輪 seed で via=done で開く", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  await seed(db);
  assertEquals((await stepsDone(db, E1)).profile, false);
  assertEquals(await dispatchIds(db, POLICY), [], "建檔未了・後備（告示日翌日）もまだ");
  const blocked = await db.transaction(async (tx) => {
    await tx.exec(`SELECT set_config('gap.arms_all', 'on', true)`);
    return (await tx.query<{ task_id: string; opened_by: unknown }>(`SELECT task_id, opened_by FROM ${TOTAL}() WHERE arm = 'policy_missing'`)).rows;
  });
  assertEquals(blocked, [{ task_id: `auto:policy_missing:${a.peid}`, opened_by: null }]);
  await profile(db, a.pid);
  assertEquals((await stepsDone(db, E1)).profile, true);
  await seed(db);
  assertEquals(await dispatchIds(db, POLICY), [`auto:policy_missing:${a.peid}`]);
  const [d] = await dispatches(db, POLICY);
  assertEquals(d.opened_by?.chain_gate, { after_step: "profile", via: "done" });
  assertEquals(d.target.chain_step, "policy");
  assertEquals(d.target.chain_lg_code, ICHI);
  assertEquals((await events(db, d.task_id))[0].detail.chain_gate, { after_step: "profile", via: "done" });
  await db.close();
});

Deno.test("情境 2　前一步が卡住でも後備（告示日の翌日＝選挙公報）が来れば開く：前日は擋、当日は via=fallback", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared"); // 建檔しない
  await clock(db, NOTICE);
  await seed(db);
  assertEquals(await dispatchIds(db, POLICY), [], "告示日当日はまだ（後備は告示日の翌日）");
  await clock(db, addDays(NOTICE, 1));
  await seed(db);
  assertEquals(await dispatchIds(db, POLICY), [`auto:policy_missing:${a.peid}`]);
  assertEquals((await dispatches(db, POLICY))[0].opened_by?.chain_gate, { after_step: "profile", via: "fallback" });
  assertEquals((await stepsDone(db, E1)).profile, false);
  await db.close();
});

Deno.test("情境 3　前一步が未完了に戻っても、開いた政見任務は收回しない（sticky）：建檔済み → 開く → 生年が消える（profile 未完了）→ 任務は残る", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  await profile(db, a.pid);
  await seed(db);
  assertEquals(await dispatchIds(db, POLICY), [`auto:policy_missing:${a.peid}`]);
  await db.exec(`UPDATE policy_jp.politicians SET birth_year = NULL WHERE id = '${a.pid}'`);
  assertEquals((await stepsDone(db, E1)).profile, false);
  await seed(db);
  await seed(db);
  assertEquals(await dispatchIds(db, POLICY), [`auto:policy_missing:${a.peid}`], "既に開いたものは收回しない");
  assertEquals((await events(db, `auto:policy_missing:${a.peid}`)).map((e) => e.event), ["opened"]);
  assertEquals((await dispatches(db, POLICY))[0].opened_by?.chain_gate, { after_step: "profile", via: "done" }, "派工列の記録は開いた時のまま（seed は内容が同じなら書き直さない）");
  await db.close();
});

// =============================================================================================
// c. 臂
// =============================================================================================
Deno.test("臂：対象は declared／filed／elected／not_elected の上線済み参選だけ（considering・退選は派さない）；公約が 1 件でもあれば消える；審議中の題名を target.queued_policies で渡す", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, addDays(NOTICE, 2));
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  const b = await addCand(db, "鈴木一郎", "すずきいちろう", "filed", { status_date: NOTICE });
  const c = await addCand(db, "田中次郎", "たなかじろう", "considering", { status_date: "2027-02-20" });
  const w = await addCand(db, "渡辺三郎", "わたなべさぶろう", "declared");
  await db.exec(`UPDATE policy_jp.politician_elections SET candidacy_status = 'withdrawn', withdrawn_after_filing = false WHERE politician_id = '${w.pid}'`);
  await seed(db);
  assertEquals(await dispatchIds(db, POLICY), [`auto:policy_missing:${a.peid}`, `auto:policy_missing:${b.peid}`].sort());
  assert(!(await dispatchIds(db, POLICY)).some((t) => t.includes(c.peid) || t.includes(w.peid)));
  // 審議中の公約（A の分）
  await submit(db, "policy", pol(a.peid), { status: "pending", urls: [KOUHOU] });
  await seed(db);
  const ta = (await dispatches(db, POLICY)).find((d) => d.task_id.endsWith(a.peid))!;
  assertEquals(ta.target.queued_policies, ["保育所の待機児童をなくす"]);
  assertEquals([ta.target.name, ta.target.kana, ta.target.candidacy_status, ta.target.election_id, ta.target.notice_date, ta.target.lg_code], ["佐藤花子", "さとうはなこ", "declared", E1, NOTICE, ICHI]);
  assert(ta.what_we_need.includes(a.peid) && ta.what_we_need.includes("policy") && ta.what_we_need.includes("source_locator") && ta.what_we_need.includes("保育所の待機児童をなくす"));
  assertEquals(ta.region, "愛知県");
  // 公約を落庫 → A の任務は消える
  const out = await applyOne(db, await submitPolicy(db, pol(a.peid, { title: "別の公約です", description: "道路の舗装を 5 年で 20 キロ更新する。" }), { task: `auto:policy_missing:${a.peid}` }));
  assertEquals(out.status, "applied");
  await seed(db);
  assertEquals(await dispatchIds(db, POLICY), [`auto:policy_missing:${b.peid}`]);
  // 冷卻：B が『公約は見つからない』と回報 → 派さない
  await check(db, `auto:policy_missing:${b.peid}`, "not_found");
  await seed(db);
  assertEquals(await dispatchIds(db, POLICY), []);
  await expireCooling(db);
  await seed(db);
  assertEquals(await dispatchIds(db, POLICY), [`auto:policy_missing:${b.peid}`], "冷卻が過ぎればまた派される");
  // cap
  await db.exec(`UPDATE policy_jp.activity_rules SET params = params || '{"cap":0}'::JSONB WHERE activity = 'policy_missing' AND priority IS NULL`);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_policy_missing()`), 0);
  await db.close();
});

// =============================================================================================
// d. 進度視圖 policy
// =============================================================================================
Deno.test("進度視圖 policy：対象が 1 人以上いて全員に公約がある（または policy_missing が查無で冷卻中）＝done；considering・退選は数えない；冷卻が過ぎれば戻る", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  assertEquals((await stepsDone(db, E1)).policy, false, "対象がいない＝done ではない");
  const c = await addCand(db, "田中次郎", "たなかじろう", "considering", { status_date: "2027-02-20" });
  assertEquals((await stepsDone(db, E1)).policy, false, "considering だけでは対象がいない");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  assertEquals((await stepsDone(db, E1)).policy, false);
  await applyOne(db, await submitPolicy(db, pol(a.peid)));
  assertEquals((await stepsDone(db, E1)).policy, true);
  const b = await addCand(db, "鈴木一郎", "すずきいちろう", "declared");
  assertEquals((await stepsDone(db, E1)).policy, false);
  await check(db, `auto:policy_missing:${b.peid}`, "not_found");
  assertEquals((await stepsDone(db, E1)).policy, true, "查無で冷卻中も済んだ扱い");
  await expireCooling(db);
  assertEquals((await stepsDone(db, E1)).policy, false);
  void c;
  await db.close();
});

// =============================================================================================
// e. 落庫 apply_policy
// =============================================================================================
Deno.test("落庫：公約を 1 件足す（origin=pledge・status=not_started・団体は選挙の団体・review_status=published）、出処・履歴・applied_policy_id を残す", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  const c = await submitPolicy(db, pol(a.peid, { proposed_date: "2027-02-10" }), { task: `auto:policy_missing:${a.peid}` });
  const out = await applyOne(db, c);
  assertEquals([out.status, out.outcome, out.table_name], ["applied", "applied", "policies"]);
  const p = await one<Record<string, unknown>>(db, `SELECT * FROM policy_jp.policies`);
  assertEquals([p.origin, p.status, p.lg_code, p.review_status, p.politician_election_id, p.category, p.source_locator],
    ["pledge", "not_started", ICHI, "published", a.peid, "子育て", "選挙公報 2 頁「子育て」"]);
  assertEquals(String(p.proposed_date instanceof Date ? (p.proposed_date as Date).toISOString().slice(0, 10) : p.proposed_date), "2027-02-10");
  assertEquals(p.id, out.record_id);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'policies' AND target_id = '${p.id}' AND role = 'primary'`), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE contribution_id = '${c}' AND table_name = 'policies' AND field = '*'`), 1);
  assertEquals((await one<{ applied_policy_id: string; applied_politician_id: string }>(db, `SELECT applied_policy_id, applied_politician_id FROM policy_jp.contributions WHERE id = '${c}'`)),
    { applied_policy_id: String(p.id), applied_politician_id: a.pid });
  await db.close();
});

Deno.test("落庫：同参選・同題名（正規化）で要約が同じ＝unchanged（二重に作らない）、要約が違う＝conflict で退件（庫は変わらない）", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  await applyOne(db, await submitPolicy(db, pol(a.peid, { title: "ＡＩ活用で窓口を効率化" })));
  const same = await applyOne(db, await submitPolicy(db, pol(a.peid, { title: "ai 活用で　窓口を効率化" })));
  assertEquals([same.status, same.outcome], ["applied", "unchanged"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.policies`), 1);
  const diff = await applyOne(db, await submitPolicy(db, pol(a.peid, { title: "AI活用で窓口を効率化", description: "窓口の待ち時間を半分にする。" })));
  assertEquals([diff.status, diff.outcome], ["rejected", "conflict"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.policies`), 1);
  // 別の題名は別の公約
  const other = await applyOne(db, await submitPolicy(db, pol(a.peid, { title: "道路の舗装を更新する", description: "道路の舗装を 5 年で 20 キロ更新する。" })));
  assertEquals(other.outcome, "applied");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.policies`), 2);
  await db.close();
});

Deno.test("落庫：不備は invalid で退件（参選なし・未公開・題名・要約の字數の境界 10／120・category・source_locator・proposed_date・出典 URL）", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  const bad = async (o: Record<string, unknown>, why: string, urls = [KOUHOU], peid = a.peid) => {
    const out = await applyOne(db, await submitPolicy(db, pol(peid, o), { urls }));
    assertEquals([out.status, out.outcome], ["rejected", "invalid"], why);
    assert(out.message && out.message.length > 5, why);
  };
  await bad({ politician_election_id: "no-such" }, "参選が存在しない", [KOUHOU], "no-such");
  await bad({ title: "短い" }, "題名が短い");
  await bad({ title: "あ".repeat(101) }, "題名が長い");
  await bad({ description: "短い要約" }, "要約が 10 字未満");
  await bad({ description: "あ".repeat(121) }, "要約が 121 字");
  await bad({ category: "" }, "category なし");
  await bad({ category: "あ".repeat(31) }, "category が長い");
  await bad({ source_locator: "" }, "source_locator なし");
  await bad({ proposed_date: "2027-13-01" }, "存在しない日付");
  await bad({ proposed_date: "2027-03-02" }, "今日より後");
  await bad({ proposed_date: "1946-12-31" }, "1947 年より前");
  await bad({}, "出典 URL が使えない", ["not a url"]);
  await db.exec(`UPDATE policy_jp.politician_elections SET review_status = 'pending' WHERE id = '${a.peid}'`);
  await bad({}, "参選が未公開");
  await db.exec(`UPDATE policy_jp.politician_elections SET review_status = 'published' WHERE id = '${a.peid}'`);
  // 字數の境界：要約ちょうど 120 字・10 字は通る
  const ok120 = await applyOne(db, await submitPolicy(db, pol(a.peid, { title: "百二十字の公約", description: "あ".repeat(120) })));
  assertEquals(ok120.outcome, "applied");
  const ok10 = await applyOne(db, await submitPolicy(db, pol(a.peid, { title: "十字の公約です", description: "い".repeat(10) })));
  assertEquals(ok10.outcome, "applied");
  // 投票日より後の proposed_date は、今日が投票日より後でも通らない
  await clock(db, addDays(POLLING, 5));
  await bad({ title: "別の題名の公約", proposed_date: addDays(POLLING, 1) }, "投票日より後");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.policies`), 2);
  await db.close();
});

Deno.test("共識：policy は目標 3・退件 −3・2 つの接続元は要らない", async () => {
  const db = await freshDb();
  assertEquals(await one(db, `SELECT policy_jp.contribution_required_agree('policy', '{}'::JSONB, ARRAY[]::TEXT[]) AS n, policy_jp.contribution_reject_floor('policy') AS r, policy_jp.contribution_needs_two_ips('policy', '{}'::JSONB) AS t`), { n: 3, r: 3, t: false });
  const c = await submit(db, "policy", pol("pe-x"), { urls: [KOUHOU] });
  assertEquals(await vote(db, c, "net-a"), "pending");
  assertEquals(await vote(db, c, "net-b"), "pending");
  assertEquals(await vote(db, c, "net-c"), "verified");
  await db.close();
});

// =============================================================================================
// f. 同一件事
// =============================================================================================
Deno.test("同一件事（policy）：鍵＝参選＋題名の正規化。題名を書かない探査は参選の公約と審議中の提出を全部返す；自分の接続元；他の型別の分派は変わらない", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  const m = (p: Record<string, unknown>, ip: string | null = null) =>
    one<{ r: { type: string; existing: Array<Record<string, unknown>>; pending: Array<Record<string, unknown>> } }>(db, `SELECT policy_jp.same_claim_matches('policy', $1::JSONB, $2) AS r`, [JSON.stringify(p), ip]).then((x) => x.r);
  assertEquals((await m({ politician_election_id: a.peid, title: "保育所の待機児童をなくす" })).existing, []);
  await applyOne(db, await submitPolicy(db, pol(a.peid)));
  await applyOne(db, await submitPolicy(db, pol(a.peid, { title: "道路の舗装を更新する", description: "道路の舗装を 5 年で 20 キロ更新する。" })));
  const hit = await m({ politician_election_id: a.peid, title: "保育所の　待機児童を なくす" });
  assertEquals(hit.existing.map((e) => e.title), ["保育所の待機児童をなくす"], "空白の違いは同じ題名");
  assertEquals((await m({ politician_election_id: a.peid, title: "全然別の題名" })).existing, []);
  assertEquals((await m({ politician_election_id: a.peid })).existing.length, 2, "探査＝この参選の公約を全部");
  assertEquals((await m({ politician_election_id: "other-pe" })).existing, []);
  const pend = await submit(db, "policy", pol(a.peid, { title: "子育て支援の拡充" }), { status: "pending", urls: [KOUHOU], ip: "ip-owner" });
  const other = await m({ politician_election_id: a.peid, title: "子育て支援の拡充" }, "ip-x");
  assertEquals(other.pending.map((p) => p.contribution_id), [pend]);
  assertEquals([other.pending[0].yours, other.pending[0].your_network_voted], [false, false]);
  const mine = await m({ politician_election_id: a.peid }, "ip-owner");
  assertEquals([mine.pending[0].yours, mine.pending[0].your_network_voted], [true, true]);
  assertEquals((await m({ politician_election_id: a.peid, title: "別の題名" })).pending, [], "題名が違えば同じこととは見ない");
  // 他の型別
  assertEquals((await one<{ r: unknown }>(db, `SELECT policy_jp.same_claim_matches('candidacy', '{}'::JSONB) AS r`)).r, null);
  assert((await one<{ r: unknown }>(db, `SELECT policy_jp.same_claim_matches('election', '{}'::JSONB) AS r`)).r !== null);
  assert((await one<{ r: unknown }>(db, `SELECT policy_jp.same_claim_matches('politician', '{}'::JSONB) AS r`)).r !== null);
  assertEquals(jpSameClaimProbe(`auto:policy_missing:${a.peid}`), { type: "policy", payload: { politician_election_id: a.peid } });
  await db.close();
});

Deno.test("同一件事（policy）の収編：落庫した公約と要約が同じ等票の提出は superseded（edit_history つき）、要約が違う・differs は残る", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  const same = await submit(db, "policy", pol(a.peid, { title: "保育所の　待機児童をなくす" }), { status: "pending", urls: [KOUHOU] });
  const diff = await submit(db, "policy", pol(a.peid, { description: "待機児童対策として保育士の給与を引き上げる。" }), { status: "pending", urls: [KOUHOU] });
  const differs = await submit(db, "policy", pol(a.peid, { resolved_claim: "differs:abc" }), { status: "pending", urls: [KOUHOU] });
  const winner = await submitPolicy(db, pol(a.peid));
  assertEquals((await applyOne(db, winner)).status, "applied");
  assertEquals(await statusOf(db, same), "superseded");
  assertEquals(await statusOf(db, diff), "pending");
  assertEquals(await statusOf(db, differs), "pending");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'contributions' AND record_id = '${same}' AND agent_name = 'same-claim'`), 1);
  assertEquals((await one<{ s: boolean }>(db, `SELECT policy_jp.same_claim_same_content('policy', '{"description":""}'::JSONB, '{"description":""}'::JSONB) AS s`)).s, false, "空の要約は同じとみなさない");
  assertEquals((await one<{ s: boolean }>(db, `SELECT policy_jp.same_claim_same_content('politician', '{"birth_year":1970}'::JSONB, '{"birth_year":1970}'::JSONB) AS s`)).s, true, "前の型別は従来どおり");
  await db.close();
});

// =============================================================================================
// g. 文字守門ほか
// =============================================================================================
Deno.test("文字守門：総表＝緊接在前一版（20261010050000）に UNION が 1 行増えただけ、apply_contribution＝WHEN が 1 行、臂名＝末尾に 1 つ（機械置換＋還原驗證）", () => {
  const union = "  UNION ALL SELECT 'policy_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_policy_missing() t\n";
  const prev = fnText(PREV_SQL, TOTAL);
  const now = fnText(MIG_SQL, TOTAL);
  assertEquals(mutate(now, union, ""), prev);
  assertNotEquals(mutate(mutate(now, "'chain_gate', CASE WHEN o.after_step IS NOT NULL", "'chain_gatex', CASE WHEN o.after_step IS NOT NULL"), union, ""), prev);
  const w = "               WHEN 'policy' THEN policy_jp.apply_policy(c)\n";
  assertEquals(mutate(fnText(MIG_SQL, "policy_jp.apply_contribution"), w, ""), fnText(PREV_SQL, "policy_jp.apply_contribution"));
  const names = (sql: string) => [...fnText(sql, "policy_jp.activity_arm_names").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(names(MIG_SQL), [...names(PREV_SQL), "policy_missing"]);
  const code = MIG_SQL.replace(/--[^\n]*/g, "");
  assert(!/public\./.test(code) && !/ditrust/.test(code));
  for (const arm of ["policy_jp.contribution_auto_tasks_policy_missing", "policy_jp.chain_policy_subjects"]) assert(!/\b(INSERT|UPDATE|DELETE)\b/.test(fnText(MIG_SQL, arm)), `${arm} は唯讀`);
  for (const fn of ["policy_jp.chain_policy_subjects", "policy_jp.chain_policy_exists", "policy_jp.policy_title_key", "policy_jp.apply_policy",
    "policy_jp.contribution_auto_tasks_policy_missing", "policy_jp.same_claim_matches_policy", "policy_jp.same_claim_matches"]) {
    assert(fnText(MIG_SQL, fn).includes("SET search_path = policy_jp, pg_temp"), `${fn} は search_path を釘付けにする`);
  }
});

async function gateProbe(db: Db) {
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, "2027-03-01");
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  await seed(db);
  const blocked = (await dispatchIds(db, POLICY)).length === 0;
  await profile(db, a.pid);
  await seed(db);
  return { blocked, openedByDone: (await dispatchIds(db, POLICY)).length === 1 };
}
async function fallbackProbe(db: Db) {
  await openElectionWithRegion(db, ICHI, POLLING);
  await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  await clock(db, addDays(NOTICE, 1));
  await seed(db);
  return (await dispatchIds(db, POLICY)).length === 1;
}
Deno.test("行為の還原驗證（gate の鍵になる行）：『前一步 done』・gate 全体・後備を 1 つずつ壊すと対応する情境が赤くなる（本物は通る）", async () => {
  const run = async <T>(patch: (sql: string) => string, probe: (db: Db) => Promise<T>) => {
    const db = await migratedDb({ before: MIG_FILE });
    await db.exec(patch(MIG_SQL));
    const r = await probe(db);
    await db.close();
    return r;
  };
  assertEquals(await run((s) => s, gateProbe), { blocked: true, openedByDone: true });
  assertEquals(await run((s) => s, fallbackProbe), true);
  assertEquals((await run((s) => mutate(s, "AND c.step = o.after_step) THEN 'done'", "AND c.step = o.after_step AND false) THEN 'done'"), gateProbe)).openedByDone, false);
  assertEquals((await run((s) => mutate(s, "WHEN o.after_step IS NULL THEN 'none'", "WHEN true THEN 'none'"), gateProbe)).blocked, false);
  assertEquals(await run((s) => mutate(s, "ELSE policy_jp.activity_chain_escape(o.chain_fallback, g.eid, g.etype, g.task_id) END AS via", "ELSE NULL END AS via"), fallbackProbe), false);
});

Deno.test("自我檢查（還原驗證）：規則の after_step／cap が欠ける・CHECK から policy を落とす・apply_types から落とす・分派器が壊れる・anon に渡すと migration が失敗する", async () => {
  const pre = await migratedDb({ before: MIG_FILE });
  const bad = async (from: string, to: string, why: string) => {
    await assertRejects(() => pre.exec(mutate(MIG_SQL, from, to)), Error, undefined, why);
  };
  await bad(`'policy_missing', 'always', 'announced', 'profile', '{"cap":200`, `'policy_missing', 'always', 'announced', NULL, '{"cap":200`, "after_step なし");
  await bad(`'profile', '{"cap":200,"chain_fallback":{"kind":"announced","offset":1}}'::JSONB`, `'profile', '{"chain_fallback":{"kind":"announced","offset":1}}'::JSONB`, "cap なし");
  await bad(`'candidacy', 'politician', 'policy'));`, `'candidacy', 'politician'));`, "CHECK から policy");
  await bad(`'candidacy', 'politician', 'policy', 'no_change']`, `'candidacy', 'politician', 'no_change']`, "apply_types から policy");
  await bad(`  IF p_type NOT IN ('election', 'regional_stat', 'local_government', 'politician', 'policy') THEN`, `  IF p_type NOT IN ('election', 'regional_stat', 'local_government', 'politician') THEN`, "分派器が policy を知らない");
  await bad(`policy_jp.contribution_auto_tasks_policy_missing(), policy_jp.same_claim_matches_policy(JSONB, TEXT, UUID)
  TO service_role;`, `policy_jp.contribution_auto_tasks_policy_missing(), policy_jp.same_claim_matches_policy(JSONB, TEXT, UUID)
  TO service_role, anon;`, "anon に渡す");
  await pre.exec(MIG_SQL);
  await pre.close();
});

Deno.test("冪等：この migration を 2 回流しても失敗せず、規則が増えない", async () => {
  const db = await freshDb();
  const before = await count(db, `SELECT 1 FROM policy_jp.activity_rules`);
  await db.exec(MIG_SQL);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.activity_rules`), before);
  await db.close();
});

Deno.test("権限：新しい関数は anon／authenticated が呼べない（service_role は呼べる）", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const q of [`SELECT * FROM policy_jp.contribution_auto_tasks_policy_missing()`, `SELECT * FROM policy_jp.chain_policy_subjects()`,
      `SELECT policy_jp.chain_policy_exists('x')`, `SELECT policy_jp.policy_title_key('x')`, `SELECT policy_jp.same_claim_matches('policy', '{}'::JSONB)`]) {
      await assertRejects(() => asRole(shared, role, q), Error, "permission denied", `${role}: ${q}`);
    }
  }
  assertEquals((await asRole<{ n: number }>(shared, "service_role", `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_policy_missing()`))[0].n, 0);
});

void rows;

// ---------------------------------------------------------------------------------------------
// #557 審査：未公開の同題名の列／字數と空白の口徑（TS と SQL をそろえる）
// ---------------------------------------------------------------------------------------------
Deno.test("未公開（published でない）の同題名の政見は『既存』にも unchanged／conflict の相手にもならない：same_claim_matches・apply_policy・臂・chain_policy_exists が同じ判準（published だけ）", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  await clock(db, addDays(NOTICE, 2));
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  await db.query(
    `INSERT INTO policy_jp.policies (id, title, description, category, origin, source_locator, politician_election_id, lg_code, status, review_status)
     VALUES ('legacy-1', '保育所の待機児童をなくす', '別の要約です。別の要約です。', '子育て', 'pledge', '公報', $1, $2, 'not_started', 'pending')`, [a.peid, ICHI]);
  assertEquals((await one<{ r: { existing: unknown[] } }>(db, `SELECT policy_jp.same_claim_matches('policy', $1::JSONB) AS r`,
    [JSON.stringify({ politician_election_id: a.peid, title: "保育所の待機児童をなくす" })])).r.existing, [], "pending の列は existing に出ない");
  assertEquals((await one<{ r: { existing: unknown[] } }>(db, `SELECT policy_jp.same_claim_matches('policy', $1::JSONB) AS r`, [JSON.stringify({ politician_election_id: a.peid })])).r.existing, [], "探査でも出ない");
  assertEquals((await one<{ e: boolean }>(db, `SELECT policy_jp.chain_policy_exists($1) AS e`, [a.peid])).e, false);
  await seed(db);
  assertEquals(await dispatchIds(db, POLICY), [`auto:policy_missing:${a.peid}`], "臂は published がないので出す");
  // 落庫：pending の同題名があっても conflict／unchanged にならず、新しく入る → 臂が消える（循環しない）
  const out = await applyOne(db, await submitPolicy(db, pol(a.peid)));
  assertEquals([out.status, out.outcome], ["applied", "applied"]);
  await seed(db);
  assertEquals(await dispatchIds(db, POLICY), []);
  await db.close();
});

Deno.test("字數と空白：SQL policy_trim と TS jpTrim が同じ（全角空白 U+3000 も落とす）；前後が全角空白の 9 字の要約は 10 字未満で invalid、10 字なら通る", async () => {
  const samples = ["  あ  ", "　　題名　", "\t改行\n", "中　間　は残る", "", "　"];
  for (const s of samples) {
    assertEquals((await one<{ t: string }>(shared, `SELECT policy_jp.policy_trim($1) AS t`, [s])).t, jpTrim(s), JSON.stringify(s));
  }
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const a = await addCand(db, "佐藤花子", "さとうはなこ", "declared");
  const nine = await applyOne(db, await submitPolicy(db, pol(a.peid, { description: "　　" + "あ".repeat(9) + "　" })));
  assertEquals([nine.status, nine.outcome], ["rejected", "invalid"]);
  const ten = await applyOne(db, await submitPolicy(db, pol(a.peid, { title: "　四文字題名　", description: "　　" + "あ".repeat(10) + "　" })));
  assertEquals(ten.outcome, "applied");
  assertEquals((await one<{ title: string; description: string }>(db, `SELECT title, description FROM policy_jp.policies`)).title, "四文字題名", "前後の空白は保存しない");
  await db.close();
});
