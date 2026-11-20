/**
 * 公報未填政見（2026-11-20，migration 20261120180000_bulletin_no_policies.sql）。
 *
 * 案例：2026 台南市長 1 號蕭燐洪，公報政見欄只有一句「我都八十四歲了，只求正寢，沒有政見」，站上 0 條政見，
 * 補政見任務永遠派不完、「已抄／應有」永遠少 1。
 *
 *   B1. 交件形狀：finding_kind 只收 bulletin_no_policies，要 confirmed、checked_urls 要有公報網址；沒帶就跟以前一樣。
 *   B2. 落庫：補政見卡＋標記通過 → 參選紀錄寫入欄位與出處、留 edit_history；不是補政見卡、沒帶標記、已有政見都不寫。
 *   B3. 派工：兩支補政見臂的新定義＝前一版加機械式替換（標了就不產卡），倒回去一字不差。
 *   B4. 報表口徑：「已抄」＝有政見 或 標了公報未填政見（PGlite 跑真的視圖與 CHECK）。
 *   B5. 人物頁：只有標了的那一屆有那一句。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { validateContributionRequest } from "./contribution-schema.ts";
import { applyContribution } from "./apply-contribution.ts";
import { BULLETIN_NO_POLICIES, firstBulletinUrl, parseBulletinCard } from "./bulletin-no-policies.ts";
import { noPoliciesNoteOf } from "../../../lib/bulletin-no-policies.ts";
import { fnText, latestFn, migrationNames, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261120180000_bulletin_no_policies.sql";
const MIG = await readMig(MIG_NAME);
const POL = "c37f07b3-00b4-4b94-8442-c9018886a9ac";
const BULLETIN = "https://eebulletin.cec.gov.tw/115/06臺南市/01市長/蕭燐洪.pdf";
const NEWS = "https://news.ltn.com.tw/x";

const noChange = (extra: Record<string, unknown>, task_id = `auto:policy_missing:${POL}`) => validateContributionRequest({
  agent_name: "tester", contribution_type: "no_change",
  payload: { task_id, outcome: "confirmed", checked_urls: [BULLETIN, NEWS], finding: "公報政見欄是一張圖，寫著「我都八十四歲了，只求正寢，沒有政見」，沒有任何政策條目。", ...extra },
});

// ---- B1 ----
Deno.test("B1 交件形狀：標記要 confirmed＋公報網址；亂填值被擋；沒帶標記照舊", () => {
  assertEquals(noChange({ finding_kind: BULLETIN_NO_POLICIES }).errors, []);
  assertEquals(noChange({}).errors, [], "沒帶標記跟以前一樣");
  assertEquals(noChange({ finding_kind: "no_policy" }).errors.map((e) => e.path), ["payload.finding_kind"]);
  assertEquals(noChange({ finding_kind: BULLETIN_NO_POLICIES, outcome: "not_found" }).errors.map((e) => e.path), ["payload.outcome"]);
  assertEquals(noChange({ finding_kind: BULLETIN_NO_POLICIES, checked_urls: [NEWS] }).errors.map((e) => e.path), ["payload.checked_urls"]);
  // 公報網址要看網域，不是看字串裡有沒有 bulletin
  assertEquals(firstBulletinUrl(["https://evil.example/eebulletin.cec.gov.tw/x.pdf"]), null);
  assertEquals(firstBulletinUrl([NEWS, BULLETIN]), BULLETIN);
  assertEquals(firstBulletinUrl(["https://bulletin.cec.gov.tw/01選舉公報/x.pdf"]), "https://bulletin.cec.gov.tw/01選舉公報/x.pdf");
});

Deno.test("B1 補政見卡的 task_id 解析：當屆卡沒帶屆別、任期卡帶屆別，其他卡 null", () => {
  assertEquals(parseBulletinCard(`auto:policy_missing:${POL}`), { politician_id: POL, election_id: null });
  assertEquals(parseBulletinCard(`auto:term_policy_missing:${POL}:2022`), { politician_id: POL, election_id: 2022 });
  assertEquals(parseBulletinCard(`auto:progress_stale:${POL}`), null);
  assertEquals(parseBulletinCard("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), null);
});

// ---- B2 ----
type Call = { table: string; op: string; arg?: unknown };
function fakeDb(o: { pes?: Array<Record<string, unknown>>; hasPolicy?: boolean } = {}) {
  const calls: Call[] = [];
  const result = (table: string): unknown => {
    if (table === "politician_elections") return o.pes ?? [{ id: 777, no_policies_at: null, candidacy_status: "filed" }];
    if (table === "policies") return o.hasPolicy ? [{ id: "p1" }] : [];
    return [];
  };
  const chain = (table: string): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get: (_t, k) => {
        if (k === "then") return (res: (v: unknown) => void) => res({ data: result(table), error: null });
        if (k === "maybeSingle") return async () => ({ data: null, error: null });
        return (...a: unknown[]) => { calls.push({ table, op: String(k), arg: a[0] }); return p; };
      },
    });
    return p;
  };
  return {
    calls,
    from: (table: string) => ({
      select: (...a: unknown[]) => { calls.push({ table, op: "select", arg: a[0] }); return chain(table); },
      update: (patch: unknown) => { calls.push({ table, op: "update", arg: patch }); return chain(table); },
      insert: (row: unknown) => { calls.push({ table, op: "insert", arg: row }); return { error: null }; },
    }),
    rpc: async (fn: string) => { calls.push({ table: "rpc", op: fn }); return { data: 2026, error: null }; },
  };
}
const row = (payload: Record<string, unknown>) => ({
  id: "c-1", contribution_type: "no_change" as const, source_urls: [BULLETIN], note: null, agent_name: "tester", contributor_url: null, payload,
});
const markPayload = (task_id: string, extra: Record<string, unknown> = {}) => ({
  task_id, outcome: "confirmed", checked_urls: [NEWS, BULLETIN], finding: "公報政見欄只有一句沒有政見，沒有任何政策條目。", finding_kind: BULLETIN_NO_POLICIES, ...extra,
});
const marks = (db: ReturnType<typeof fakeDb>) => db.calls.filter((c) => c.table === "politician_elections" && c.op === "update");

Deno.test("B2 當屆補政見卡＋標記：寫入時間與第一個公報網址、留 edit_history", async () => {
  const db = fakeDb();
  const out = await applyContribution(db, row(markPayload(`auto:policy_missing:${POL}`)));
  assertEquals(out.status, "applied");
  assertStringIncludes(out.message, "公報未填政見");
  const m = marks(db);
  assertEquals(m.length, 1);
  const patch = m[0].arg as { no_policies_at: string; no_policies_source_url: string };
  assertEquals(patch.no_policies_source_url, BULLETIN, "出處是 checked_urls 裡第一個公報網址，不是第一個網址");
  assert(!Number.isNaN(Date.parse(patch.no_policies_at)));
  const hist = db.calls.filter((c) => c.table === "edit_history" && c.op === "insert").map((c) => (c.arg as { table_name: string; field: string }));
  const mine = hist.filter((h) => h.table_name === "politician_elections").map((h) => h.field).sort();
  assertEquals(mine, ["no_policies_at", "no_policies_source_url"]);
  assert(db.calls.some((c) => c.op === "campaign_election_id"), "當屆卡的屆別由 campaign_election_id() 決定");
});

Deno.test("B2 任期補政見卡：屆別取自 task_id，不問當屆", async () => {
  const db = fakeDb();
  const out = await applyContribution(db, row(markPayload(`auto:term_policy_missing:${POL}:2022`)));
  assertEquals(out.status, "applied");
  assertEquals(marks(db).length, 1);
  assert(!db.calls.some((c) => c.op === "campaign_election_id"));
});

Deno.test("B2 不是補政見卡的 no_change 帶標記：行為不變，只記 task_checks，不寫參選紀錄", async () => {
  for (const id of [`auto:progress_stale:${POL}`, `auto:profile_gap:${POL}`]) {
    const db = fakeDb();
    const out = await applyContribution(db, row(markPayload(id)));
    assertEquals(out.status, "applied");
    assertEquals(marks(db).length, 0, id);
    assert(db.calls.some((c) => c.table === "task_checks" && c.op === "insert"));
  }
});

Deno.test("B2 補政見卡但沒帶標記（一般查無／確認）：照舊，不寫參選紀錄", async () => {
  const db = fakeDb();
  const p = markPayload(`auto:policy_missing:${POL}`);
  delete (p as Record<string, unknown>).finding_kind;
  await applyContribution(db, row(p));
  assertEquals(marks(db).length, 0);
});

Deno.test("B2 這一屆已經有政見、或已經標過、或找不到參選紀錄：不重標", async () => {
  const has = fakeDb({ hasPolicy: true });
  const o1 = await applyContribution(has, row(markPayload(`auto:policy_missing:${POL}`)));
  assertEquals(o1.status, "applied");
  assertEquals(marks(has).length, 0);
  const done = fakeDb({ pes: [{ id: 5, no_policies_at: "2026-11-20T00:00:00Z", candidacy_status: "filed" }] });
  await applyContribution(done, row(markPayload(`auto:policy_missing:${POL}`)));
  assertEquals(marks(done).length, 0, "標過的保留原本的時間與出處");
  const gone = fakeDb({ pes: [{ id: 6, no_policies_at: null, candidacy_status: "withdrawn" }] });
  const o3 = await applyContribution(gone, row(markPayload(`auto:policy_missing:${POL}`)));
  assertEquals(o3.status, "superseded");
  assertEquals(marks(gone).length, 0);
});

// ---- B3 ----
type Rep = [string, string, number];
const RAW_ADD =
  "    -- 公報未填政見（2026-11-20）：這個人這一屆的參選紀錄標了 no_policies_at＝公報政見欄沒有任何條目，不再派補政見\n" +
  "    AND NOT EXISTS (SELECT 1 FROM politician_elections pn WHERE pn.politician_id = c.id AND pn.election_id = c.eid\n" +
  "                      AND pn.election_type = c.election_type AND pn.no_policies_at IS NOT NULL)\n";
const TERM_ADD =
  "       -- 公報未填政見（2026-11-20）：這一屆的參選紀錄標了 no_policies_at 就不再派\n" +
  "       AND NOT EXISTS (SELECT 1 FROM politician_elections pn WHERE pn.politician_id = i0.politician_id AND pn.election_id = i0.election_id\n" +
  "                         AND pn.election_type = i0.election_type AND pn.no_policies_at IS NOT NULL)\n";
const TERM_TEXT =
  "                || '**公報那一欄確實沒有任何政策條目（空白，或只寫「沒有政見」這類話）**：改回 no_change＋outcome=confirmed＋finding_kind=bulletin_no_policies，checked_urls 第一個放這份公報，finding 寫那一欄的原文大意；同儕驗證通過後這一屆標為「公報未填政見」、不再派。'\n";
const RAW_ANCHOR = "                      AND pl.election_id = c.eid AND is_campaign_pledge(pl.status::TEXT, pl.origin))\n";
const TERM_ANCHOR = "     WHERE NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = i0.politician_id AND pl.election_id = i0.election_id AND pl.removed_at IS NULL)\n";
const ARMS: [string, string, Rep[]][] = [
  ["contribution_auto_tasks_raw", "20261115010000_profile_gap_hint_ipdb.sql", [[RAW_ANCHOR + RAW_ADD, RAW_ANCHOR, 1]]],
  ["contribution_auto_tasks_term_policies", "20261011310000_campaign_election_arms_2.sql", [[TERM_ANCHOR + TERM_ADD, TERM_ANCHOR, 1], [TERM_TEXT, "", 1]]],
];
for (const [arm, prevMig, reps] of ARMS) {
  Deno.test(`B3 ${arm}：前一版是 ${prevMig}，中間沒有人插一版`, async () => {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${arm}(`)) defining.push(n);
    const i = defining.indexOf(MIG_NAME);
    assert(i > 0);
    assertEquals(defining[i - 1], prevMig, "前一版變了：要以最新的為底重做替換");
  });
  Deno.test(`B3 ${arm}：新定義＝前一版加機械式替換，倒回去一字不差；標了就不產卡`, async () => {
    const prev = await latestFn(arm, MIG_NAME);
    const neu = fnText(MIG, arm);
    const body = (f: string) => f.slice(f.search(/AS \$[a-z]*\$/));
    let s = body(neu);
    for (const [from, to, n] of [...reps].reverse()) {
      assertEquals(s.split(from).length - 1, n, `「${from.slice(0, 40)}」應出現 ${n} 次`);
      s = s.replaceAll(from, to);
    }
    assertEquals(s, body(prev));
    assertStringIncludes(neu, "pn.no_policies_at IS NOT NULL");
  });
}

// ---- B4 ----
Deno.test("B4 報表口徑：有政見或標了公報未填政見＝已抄；兩欄要一起有；退選不算", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE politician_elections (id serial PRIMARY KEY, politician_id uuid, election_id int, election_type text, candidacy_status text);
    CREATE TABLE policies (id serial PRIMARY KEY, politician_id uuid, election_id int, status text, removed_at timestamptz);
  `);
  // 只跑 migration 的 ①（加欄＋CHECK）、④（視圖）與計數視圖；其餘段落引用 PGlite 沒有的東西
  await db.exec(MIG.slice(MIG.indexOf("ALTER TABLE politician_elections\n  ADD COLUMN"), MIG.indexOf("-- ② 派工臂")));
  await db.exec(await readMig("20261118120000_politician_election_policy_counts.sql"));
  await db.exec(MIG.slice(MIG.indexOf("CREATE OR REPLACE VIEW politician_election_transcribed"), MIG.indexOf("NOTIFY pgrst")));
  const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
  const C = "00000000-0000-4000-8000-00000000000c", D = "00000000-0000-4000-8000-00000000000d";
  await db.exec(`
    INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, no_policies_at, no_policies_source_url) VALUES
      ('${A}', 2026, '縣市長', 'filed', NULL, NULL),
      ('${B}', 2026, '縣市長', 'filed', now(), '${BULLETIN}'),
      ('${C}', 2026, '縣市長', 'filed', NULL, NULL),
      ('${D}', 2026, '縣市長', 'withdrawn', NULL, NULL);
    INSERT INTO policies (politician_id, election_id, status) VALUES ('${C}', 2026, 'Campaign Pledge');
  `);
  const r = await db.query<{ politician_id: string; transcribed: boolean; policy_count: number }>(
    "SELECT politician_id, transcribed, policy_count FROM politician_election_transcribed ORDER BY politician_id");
  assertEquals(r.rows.map((x) => [x.politician_id, x.transcribed]), [[A, false], [B, true], [C, true]]);
  assertEquals(r.rows.find((x) => x.politician_id === B)!.policy_count, 0, "標記不會變成假政見：政見數仍是 0");
  let threw = false;
  try { await db.exec(`UPDATE politician_elections SET no_policies_at = now() WHERE politician_id = '${A}'`); } catch { threw = true; }
  assert(threw, "只有時間沒有出處要被 CHECK 擋下");
});

Deno.test("B4 人物頁視圖 politicians_with_elections：比前一版只多兩個鍵", async () => {
  const prev = await readMig("20261111170000_identity_auto_resolve.sql");
  const a = prev.slice(prev.indexOf("CREATE OR REPLACE VIEW politicians_with_elections AS"), prev.indexOf("ALTER VIEW politicians_with_elections"));
  const b = MIG.slice(MIG.indexOf("CREATE OR REPLACE VIEW politicians_with_elections AS"), MIG.indexOf("ALTER VIEW politicians_with_elections"));
  const added = " 'noPoliciesAt', pe.no_policies_at, 'noPoliciesSourceUrl', pe.no_policies_source_url,";
  assertEquals(b.split(added).length - 1, 1);
  assertEquals(b.replace(added, ""), a);
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE VIEW politicians_with_elections AS")) defining.push(n);
  assertEquals(defining.slice(-2), ["20261111170000_identity_auto_resolve.sql", MIG_NAME], "前一版變了：要以最新的為底重做");
});

// ---- B5 ----
Deno.test("B5 人物頁：標了的那一屆才有那一句，出處只收 http(s)", () => {
  const els = [
    { electionId: 2026, noPoliciesAt: "2026-11-20T00:00:00Z", noPoliciesSourceUrl: BULLETIN },
    { electionId: 2022 },
  ];
  assertEquals(noPoliciesNoteOf(els, 2026), { url: BULLETIN });
  assertEquals(noPoliciesNoteOf(els, 2022), null);
  assertEquals(noPoliciesNoteOf(els, null), null);
  assertEquals(noPoliciesNoteOf(undefined, 2026), null);
  assertEquals(noPoliciesNoteOf([{ electionId: 2026, noPoliciesAt: "x", noPoliciesSourceUrl: "javascript:alert(1)" }], 2026), { url: null });
});
