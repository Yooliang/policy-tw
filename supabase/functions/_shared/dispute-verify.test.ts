/**
 * 爭點驗證（維護者 2026-10-18；migration 20261017040000；協議 1.96.0）。
 *
 * 驗證票票數超過「平均 × overvoted_flag_multiplier」（與主控台 console_queue_state().overvoted 同一個定義）：
 *   - /next 派出時附 item.dispute（前面每一票的 verdict／agent／note／evidence_url／at ＋ 指示），how_to 改成針對爭點
 *   - /report（verify）不收 unsure，回 400 dispute_no_unsure；沒超過線照收
 *   - 門檻只有一份：SQL 函式 contribution_dispute_votes／contribution_dispute_context 用 contribution_overvoted_flag_votes()
 *   還原驗證（人工做過，見 PR 說明）：拿掉 /next 的 fetchDisputeContext 展開、拿掉 verify-handler 的擋票、把 SQL 的門檻換成寫死數字，
 *   各自對應的測試會紅
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";
import { loadEntry, type LoadedEntry, type RestCall } from "./entry-harness.ts";
import { ipHashOf } from "./contribute-handler.ts";
import { signDispatchToken } from "./dispatch-token.ts";
import { DISPUTE_NOTE_MAX, DISPUTE_PRIOR_MAX, disputeInstruction, shapeDispute } from "./dispute-verify.ts";

const MIG = "20261017040000_dispute_focused_verify.sql";
const SQL = await readMig(MIG);
const OV = await readMig("20261017020100_overvoted_votes.sql");
const ID = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ── SQL：超過線才有爭點資料，門檻是共用函式 ─────────────────────────────────────
async function db(sql = SQL): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, payload jsonb DEFAULT '{}', status text DEFAULT 'pending',
      agree_count int DEFAULT 0, disagree_count int DEFAULT 0, unsure_count int DEFAULT 0, created_at timestamptz DEFAULT now());
    CREATE TABLE contribution_votes (id serial PRIMARY KEY, contribution_id uuid, verifier_ip_hash text, agent_name text, verdict text,
      note text, evidence_url text, created_at timestamptz DEFAULT now());
    CREATE TABLE queue_settings (id smallint PRIMARY KEY, overvoted_flag_multiplier numeric DEFAULT 2, overvoted_stop_multiplier numeric DEFAULT 3);
    INSERT INTO queue_settings VALUES (1, 2, 3);
    CREATE TABLE vote_baseline (id smallint PRIMARY KEY, baseline numeric, sample int, computed_at timestamptz NOT NULL DEFAULT now());
    ${["contribution_vote_baseline_compute", "contribution_vote_baseline", "contribution_overvoted_flag_votes"].map((n) => fnText(OV, n)).join("\n")}
    ${["contribution_dispute_votes", "contribution_dispute_context"].map((n) => fnText(sql, n)).join("\n")}
    INSERT INTO vote_baseline VALUES (1, 2.5, 10, now());
  `);
  return d;
}
async function seed(d: PGlite, n: number, o: { status?: string; type?: string; votes?: number } = {}) {
  // 票數寫在計數欄（同線上計票結果），逐票的理由另外寫進 contribution_votes
  const v = o.votes ?? 0;
  await d.query(`INSERT INTO contributions (id, contribution_type, status, agree_count, disagree_count, unsure_count) VALUES ($1, $2, $3, $4, 0, $5)`,
    [ID(n), o.type ?? "policy", o.status ?? "pending", Math.ceil(v / 2), Math.floor(v / 2)]);
}
const one = async (d: PGlite, q: string, n: number) => (await d.query<{ r: unknown }>(q, [ID(n)])).rows[0].r;

Deno.test("SQL：票數 > 基準 × 標出倍數（2.5×2＝5）才是爭點驗證；5 票不是、6 票是（> 不是 ≥）", async () => {
  const d = await db();
  await seed(d, 1, { votes: 5 }); await seed(d, 2, { votes: 6 }); await seed(d, 3, { votes: 1 });
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 1), null);
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 2), 6);
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 3), null);
  assertEquals(await one(d, `SELECT contribution_dispute_context($1) AS r`, 1), null, "沒超過線：沒有爭點資料");
  assertEquals(await one(d, `SELECT contribution_dispute_context($1) AS r`, 3), null);
  await d.close();
});

Deno.test("SQL：門檻來自共用函式——改 overvoted_flag_multiplier 或基準，爭點驗證立刻跟著變", async () => {
  const d = await db();
  await seed(d, 1, { votes: 6 });
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 1), 6);
  await d.query(`UPDATE queue_settings SET overvoted_flag_multiplier = 3`); // 線＝7.5
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 1), null);
  await d.query(`UPDATE queue_settings SET overvoted_flag_multiplier = 2`);
  await d.query(`UPDATE vote_baseline SET baseline = 4`); // 線＝8
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 1), null);
  await d.query(`UPDATE vote_baseline SET baseline = 1`); // 線＝2
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 1), 6);
  await d.close();
});

Deno.test("SQL：裁決型別不適用、非等票狀態不算；沒有基準時不標（同主控台）", async () => {
  const d = await db();
  await seed(d, 1, { votes: 20, type: "adjudication" });
  await seed(d, 2, { votes: 20, status: "applied" });
  await seed(d, 3, { votes: 20, status: "disputed" });
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 1), null);
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 2), null);
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 3), 20);
  await d.exec(`DELETE FROM vote_baseline; DELETE FROM contributions WHERE id <> '${ID(3)}'`);
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 3), null, "沒有已結案交件＝沒有基準＝不標不擋");
  await d.close();
});

Deno.test("SQL：爭點資料＝每一票的 verdict／agent／note／evidence_url／時間，照時間；理由截 300 字；最多最近 30 筆", async () => {
  const d = await db();
  await seed(d, 1, { votes: 40 });
  await d.query(`INSERT INTO contribution_votes (contribution_id, verifier_ip_hash, agent_name, verdict, note, evidence_url, created_at) VALUES
    ($1, 'a', 'qa-1', 'agree', '資料在網頁原始碼裡', 'https://example.test/src', now() - interval '3 hour'),
    ($1, 'b', 'qa-2', 'disagree', $2, NULL, now() - interval '2 hour'),
    ($1, 'c', 'qa-3', 'unsure', NULL, NULL, now() - interval '1 hour')`, [ID(1), "長".repeat(500)]);
  const r = await one(d, `SELECT contribution_dispute_context($1) AS r`, 1) as { votes: number; flag: number; baseline: number; shown: number; prior: Array<Record<string, unknown>> };
  assertEquals([r.votes, r.baseline, r.flag, r.shown], [40, 2.5, 5, 3]);
  assertEquals(r.prior.map((p) => [p.verdict, p.agent]), [["agree", "qa-1"], ["disagree", "qa-2"], ["unsure", "qa-3"]]);
  assertEquals(r.prior[0].evidence_url, "https://example.test/src");
  assertEquals((r.prior[1].note as string).length, 300);
  assertEquals(r.prior[2].note, null);
  // 超過 30 筆：取最近 30 筆，仍照時間
  for (let i = 0; i < 40; i++) {
    await d.query(`INSERT INTO contribution_votes (contribution_id, verifier_ip_hash, agent_name, verdict, note, created_at) VALUES ($1, $2, $3, 'agree', $4, now() + $5 * interval '1 second')`, [ID(1), `x${i}`, `bulk-${i}`, `n${i}`, i]);
  }
  const big = await one(d, `SELECT contribution_dispute_context($1) AS r`, 1) as { shown: number; prior: Array<Record<string, unknown>> };
  assertEquals(big.shown, 30);
  assertEquals([big.prior[0].agent, big.prior[29].agent], ["bulk-10", "bulk-39"]);
  await d.close();
});

Deno.test("SQL 守門：兩支函式的門檻只用 contribution_overvoted_flag_votes()，與主控台 overvoted 同一個運算式；沒有自己的倍數或基準", () => {
  const votes = fnText(SQL, "contribution_dispute_votes");
  const ctx = fnText(SQL, "contribution_dispute_context");
  assertStringIncludes(votes, "agree_count + c.disagree_count + c.unsure_count > contribution_overvoted_flag_votes()");
  assertStringIncludes(ctx, "contribution_dispute_votes(p_contribution_id)");
  for (const t of [votes, ctx]) {
    assert(!/overvoted_flag_multiplier|FROM vote_baseline|queue_settings/.test(t), "不得在這裡重新定義門檻");
  }
  // 主控台標出的運算式與它相同（兩邊一起改）
  assertStringIncludes(OV, "c.agree_count + c.disagree_count + c.unsure_count > (SELECT flag FROM ov)");
  assertStringIncludes(OV, "contribution_overvoted_flag_votes() AS flag");
});

Deno.test("還原驗證（程式化）：把 SQL 的門檻換成寫死的數字，倍數改了就不再跟著變——上面的測試會紅", async () => {
  const bad = SQL.replaceAll("> contribution_overvoted_flag_votes()", "> 5");
  assert(bad !== SQL);
  const d = await db(bad);
  await seed(d, 1, { votes: 6 });
  await d.query(`UPDATE queue_settings SET overvoted_flag_multiplier = 3`);
  assertEquals(await one(d, `SELECT contribution_dispute_votes($1) AS r`, 1), 6, "寫死的門檻不會隨倍數變：正確版本此處應為 null");
  await d.close();
});

// ── TS：整理與指示 ─────────────────────────────────────────────────────────────
Deno.test("shapeDispute：非爭點（null／缺票數）回 null；理由截 300、最多 30 筆、附純中文指示", () => {
  assertEquals(shapeDispute(null), null);
  assertEquals(shapeDispute({}), null);
  const prior = Array.from({ length: 45 }, (_, i) => ({ verdict: "agree", agent: `a${i}`, note: "字".repeat(1000), evidence_url: null, at: "2026-10-18T00:00:00Z" }));
  const s = shapeDispute({ votes: 45, baseline: 2.5, flag: 5, prior })!;
  assertEquals(s.prior.length, DISPUTE_PRIOR_MAX);
  assertEquals(s.prior[0].note!.length, DISPUTE_NOTE_MAX);
  assertEquals(s.votes, 45);
  assertStringIncludes(s.instruction, "這筆已經驗了 45 票還沒定案");
  assertStringIncludes(s.instruction, "這一輪不收「不確定」，請選同意或反對，理由要回應前面的爭點。");
  assert(!/[A-Za-z]{3,}/.test(disputeInstruction(7)), "給代理的指示不夾英文");
});

// ── 入口：/next 派出附爭點資料、/report 擋 unsure ──────────────────────────────────
const SALT = "test-salt";
const SERVICE_KEY = "service-role-key-0123456789";
const CID = "11111111-2222-3333-4444-555555555555";
const FLAG = 5; // 假資料庫的標出線（真正的門檻由上面的 SQL 測試負責；這裡只驗接線）
const env = () => ({ SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, CONTRIBUTION_IP_SALT: SALT });
const at = (ip: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string> ?? {}), "x-forwarded-for": ip } });
type Row = Record<string, unknown>;
const N1 = "10.1.1.5";

function makeDb(votesTotal: number) {
  const votes: Row[] = [];
  const priorVotes = [
    { agent: "qa-1", verdict: "agree", note: "資料在網頁原始碼裡", evidence_url: "https://example.test/src", at: "2026-10-17T01:00:00Z" },
    { agent: "qa-2", verdict: "disagree", note: "頁面上看不到", evidence_url: null, at: "2026-10-17T02:00:00Z" },
  ];
  const candidate: Row = {
    id: CID, contribution_type: "policy", payload: { title: "測試政見" }, source_urls: ["https://example.test/a"], note: null, task_id: null,
    agent_name: "someone", contributor_ip_hash: "someone-else", status: "pending", agree_count: Math.ceil(votesTotal / 2), disagree_count: Math.floor(votesTotal / 2), unsure_count: 0,
    created_at: "2026-10-01T00:00:00Z", queue_at: "2026-10-01T00:00:00Z", score: 0, target_score: 3, effective_required: 3,
  };
  const over = () => votesTotal > FLAG;
  const router = (c: RestCall): unknown => {
    const t = c.target;
    if (t === "rpc/contribution_verify_pool") return [candidate];
    if (t === "rpc/contribution_queue_tasks") return [];
    if (t === "rpc/contribution_effective_agree") return 3;
    if (t === "rpc/contribution_dispute_votes") return over() ? votesTotal : null;
    if (t === "rpc/contribution_dispute_context") return over() ? { votes: votesTotal, baseline: 2.5, flag: FLAG, shown: 2, prior: priorVotes } : null;
    if (t === "contributions") return c.url.searchParams.get("id") === `eq.${CID}` ? [candidate] : undefined;
    if (t === "contribution_votes") {
      if (c.method === "POST") { const row = { ...(c.body as Row), id: `vote-${votes.length + 1}` }; votes.push(row); return [row]; }
      return [];
    }
    return undefined;
  };
  return { votes, router };
}
async function withEntries<T>(d: ReturnType<typeof makeDb>, fn: (x: { next: LoadedEntry; report: LoadedEntry }) => Promise<T>): Promise<T> {
  const next = await loadEntry("../next/index.ts", env(), d.router);
  const report = await loadEntry("../report/index.ts", env(), d.router);
  try { return await fn({ next, report }); } finally { report.restore(); next.restore(); }
}
const getNext = async (next: LoadedEntry) => {
  const res = await next.call(new Request("https://x/next?agent_name=dave&agent_tool=claude-code/claude-sonnet-5", at(N1)));
  return await res.json() as Row;
};
const vote = async (report: LoadedEntry, token: string, verdict: string, extra: Row = {}) => {
  const body = {
    kind: "verify", contribution_id: CID, verdict, agent_name: "dave", agent_tool: "claude-code/claude-sonnet-5", dispatch_token: token,
    note: "打開來源逐欄核對，標題與內容都對得上；網頁原始碼第 120 行有這段資料", ...extra,
  };
  const res = await report.call(new Request("https://x/report", at(N1, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })));
  return { status: res.status, json: await res.json() as Row };
};
const tokenFor = async () => await signDispatchToken(SERVICE_KEY, { t: `verify:${CID}`, a: "dave", i: Date.now(), e: Date.now() + 60_000, h: await ipHashOf(new Request("https://x/", at(N1)), SALT) });

Deno.test("/next：超過線的驗證票附 item.dispute（每票 verdict／agent／note／evidence_url）與指示，how_to 改成針對爭點、不收 unsure", async () => {
  await withEntries(makeDb(7), async ({ next }) => {
    const got = await getNext(next);
    assertEquals(got.kind, "verify");
    const item = got.item as Row;
    const dispute = item.dispute as { votes: number; prior: Row[]; instruction: string };
    assertEquals(dispute.votes, 7);
    assertEquals(dispute.prior.map((p) => [p.agent, p.verdict, p.note, p.evidence_url]),
      [["qa-1", "agree", "資料在網頁原始碼裡", "https://example.test/src"], ["qa-2", "disagree", "頁面上看不到", null]]);
    assertStringIncludes(dispute.instruction, "這筆已經驗了 7 票還沒定案");
    assertStringIncludes(String(got.how_to), "這筆已經驗了 7 票還沒定案");
    assertStringIncludes(String(got.how_to), "不收 unsure");
    assert(!String(got.how_to).includes("不確定投 unsure"), "爭點驗證不能同時叫人投 unsure");
  });
});

Deno.test("/next：沒超過線的驗證票沒有 item.dispute，how_to 與原本一樣（可投 unsure）", async () => {
  await withEntries(makeDb(5), async ({ next }) => {
    const got = await getNext(next);
    assertEquals(got.kind, "verify");
    assertEquals("dispute" in (got.item as Row), false);
    assertStringIncludes(String(got.how_to), "不確定投 unsure");
    assert(!String(got.how_to).includes("爭點驗證"));
  });
});

Deno.test("/report：超過線的驗證票投 unsure 回 400 dispute_no_unsure（純中文、說明不是罰則、不寫票）；同意照收", async () => {
  const d = makeDb(7);
  await withEntries(d, async ({ report }) => {
    const bad = await vote(report, await tokenFor(), "unsure", { note: "來源打不開" });
    assertEquals(bad.status, 400);
    assertEquals(bad.json.error, "dispute_no_unsure");
    const msg = String(bad.json.message);
    for (const k of ["爭點驗證", "不收不確定", "請選同意或反對並回應前面的爭點", "不是罰則"]) assertStringIncludes(msg, k);
    assertEquals(d.votes.length, 0, "擋下不寫票");
    // 盲反對（備註只有打不開）會被改記 unsure，爭點驗證一併擋
    const blind = await vote(report, await tokenFor(), "disagree", { evidence_url: "https://example.test/x", note: "打不開，無法確認" });
    assertEquals([blind.status, blind.json.error], [400, "dispute_no_unsure"]);
    assertEquals(d.votes.length, 0);
    const ok = await vote(report, await tokenFor(), "agree");
    assertEquals(ok.status, 201);
    assertEquals(d.votes.length, 1);
  });
});

Deno.test("/report：沒超過線的驗證票 unsure 照收（行為不變）", async () => {
  const d = makeDb(5);
  await withEntries(d, async ({ report }) => {
    const r = await vote(report, await tokenFor(), "unsure", { note: "來源打不開，試過加瀏覽器標頭與存檔都不行" });
    assertEquals(r.status, 201);
    assertEquals(d.votes.map((v) => v.verdict), ["unsure"]);
  });
});

Deno.test("接線守門：/next 展開 dispute、verify-handler 在寫票前擋 unsure（merge 不經這裡）、擋票記進 gate_rejections", async () => {
  const next = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assertStringIncludes(next, "fetchDisputeContext(supabase, pick.id)");
  assertStringIncludes(next, "...(dispute ? { dispute } : {})");
  const h = (await Deno.readTextFile(new URL("./verify-handler.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const gate = h.indexOf('via !== "merge" && (blind || input.verdict === "unsure")');
  assert(gate > 0, "verify-handler 要有爭點擋票");
  assert(gate < h.indexOf(".insert(voteRow)"), "擋票要在寫票之前");
  assertStringIncludes(h, '"dispute_no_unsure"]');
});
