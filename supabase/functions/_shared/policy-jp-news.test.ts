/**
 * 日本站の新聞線（migration 20261011250000_policy_jp_news.sql、工作単 Yooliang/policy-ops#95）
 *   表 news_sources／news_items／news_settings／news_election_leads、RPC news_lead_record／news_purge、
 *   派工臂 news_discovery（task_type=election_discovery、target.discovery=news）。
 *   篩い（news-screen.ts）と取り込み（news-run.ts）の單元測試は jp/news-screen.test.ts。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration、時鐘用 `SET app.activity_today`。
 *   a. 結構：臂名・総表（前の版に足しただけ）・規則・優先層・主控台・権限（anon に開かない）・種子の来源・RLS
 *   b. 線索：作成／併合／1 日の上限／ttl 失効／行政区と存在しない団体は skipped／入力の検査
 *   c. 派工臂：開く・target の形・前段・選挙が記録されたら收回・ttl 過ぎたら收回・cap・min_items・查無の冷卻・停用
 *   d. 協議：交件の検査（task_id と election）・同一件事の探査・news_purge
 *   e. 還原驗證
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, asRole, check, clock, count, dispatches, dispatchIds, events, freshDb, insertElection, insertLg, ICHI, AICHI, readMig, rows, seed, one,
} from "./policy-jp-chain-db.ts";
import { validateContributionRequest } from "./jp/contribution-schema.ts";
import { jpSameClaimProbe } from "./jp/same-claim-probe.ts";
import { JP_PROTOCOL_VERSION } from "./jp/protocol.ts";

const MIG_FILE = "20261011250000_policy_jp_news.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV = await readMig("20261011240000_policy_jp_consistency.sql");
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const D0 = "2026-10-13";
const ED = ["election_discovery"];
type Db = Awaited<ReturnType<typeof freshDb>>;

const ev = (url: string, title = "一宮市長が辞職の意向", signal = "resignation") =>
  JSON.stringify([{ news_item_id: 1, url, title, source: "NHK 政治", published_at: "2026-10-12T14:30:00Z", signal }]);
const record = async (db: Db, lg: string, kind: string, signal: string, url: string, seenOn: string | null = D0) =>
  (await one<{ r: Record<string, unknown> }>(db, `SELECT policy_jp.news_lead_record($1, $2, $3, $4::JSONB, $5::DATE) AS r`, [lg, kind, signal, ev(url, undefined, signal), seenOn])).r;
const news = (db: Db) => dispatches(db, ED).then((l) => l.filter((d) => d.target.discovery === "news"));

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：臂名・総表（前の版に足しただけ）・規則・優先層・主控台・権限・種子の来源・RLS", async () => {
  const db = await freshDb();
  const names = (await one<{ a: string[] }>(db, `SELECT policy_jp.activity_arm_names() AS a`)).a;
  assert(names.includes("news_discovery"));
  const total = fnText(MIG_SQL, TOTAL);
  assert(total.includes("UNION ALL SELECT 'news_discovery' AS arm, t.* FROM policy_jp.contribution_auto_tasks_news_discovery() t"));
  // 前の版に足しただけ：UNION 1 行・測試名人物の隔離（CTE ph と末尾の AND 1 行）以外は一字も変わっていない
  const stripped = total
    .replace("  UNION ALL SELECT 'news_discovery' AS arm, t.* FROM policy_jp.contribution_auto_tasks_news_discovery() t\n", "")
    .replace(/-- 姓名がテスト[\s\S]*?\n       tagged AS \(/, "tagged AS (")
    .replace(/     AND \(g\.arm = 'placeholder_politicians' OR NOT EXISTS[^\n]*\n/, "");
  assertEquals(stripped, fnText(PREV, TOTAL));
  assertEquals(
    fnText(MIG_SQL, "policy_jp.activity_arm_names").replace(",\n    'news_discovery'", ""),
    fnText(PREV, "policy_jp.activity_arm_names"));
  const rule = await one<Record<string, unknown>>(db, `SELECT window_kind, after_step, enabled, params FROM policy_jp.activity_rules WHERE activity = 'news_discovery' AND priority IS NULL`);
  assertEquals(rule, { window_kind: "always", after_step: null, enabled: true, params: { cap: 10, ttl_days: 60, min_items: 1 } });
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:news_discovery' AND priority = 1`), 1);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.console_arm_stage_map WHERE arm = 'news_discovery' AND stage = 1`), 1);
  assertEquals((await one<{ r: number }>(db, `SELECT policy_jp.chain_step_rank('auto:election_discovery:2026-10-13:232033:head', 'election_discovery') AS r`)).r, 1, "順位は動かない");
  // 権限：anon に表も内部関数も開かない；RLS は全部有効
  for (const t of ["news_sources", "news_items", "news_settings", "news_election_leads"]) {
    assertEquals((await one<{ x: boolean }>(db, `SELECT has_table_privilege('anon', 'policy_jp.${t}', 'SELECT') AS x`)).x, false, t);
    assertEquals((await one<{ x: boolean }>(db, `SELECT relrowsecurity AS x FROM pg_class WHERE oid = 'policy_jp.${t}'::regclass`)).x, true, `${t} RLS`);
  }
  for (const f of ["contribution_auto_tasks_news_discovery()", "news_lead_record(text,text,text,jsonb,date)", "news_purge()", "jp_news_cron_secret_ok(text)", "news_lead_election_type(text,text)"]) {
    assertEquals((await one<{ x: boolean }>(db, `SELECT has_function_privilege('anon', 'policy_jp.${f}', 'EXECUTE') AS x`)).x, false, f);
  }
  assertEquals(await asRole(db, "anon", `SELECT 1 AS x FROM pg_catalog.pg_tables WHERE tablename = 'news_items'`).then((r) => r.length), 1, "（カタログは見える）");
  // 来源：RSS は一律受け付けない（維護者 2026-10-13、20261011260000）。250000 の RSS 種子は全部止まっていて、enabled なのは html だけ
  const src = await rows<{ feed_url: string; enabled: boolean; format: string }>(db, `SELECT feed_url, enabled, format FROM policy_jp.news_sources ORDER BY id`);
  assert(src.length >= 3);
  for (const s of src) assert(s.feed_url.startsWith("https://"), s.feed_url);
  for (const s of src.filter((x) => x.format !== "html")) assertEquals(s.enabled, false, s.feed_url);
  assertEquals(src.filter((s) => s.enabled && s.format !== "html"), []);
  assertEquals(await one(db, `SELECT enabled, daily_lead_cap, max_age_days, keep_days FROM policy_jp.news_settings`), { enabled: true, daily_lead_cap: 10, max_age_days: 3, keep_days: 30 });
  // 設定表は 1 行だけ
  let threw = false;
  try { await db.exec(`INSERT INTO policy_jp.news_settings (id) VALUES (2)`); } catch { threw = true; }
  assert(threw, "id=1 の単列");
  // 団体の種類 → 選挙の種類
  const t = (k: string, o: string) => one<{ t: string | null }>(db, `SELECT policy_jp.news_lead_election_type($1, $2) AS t`, [k, o]).then((r) => r.t);
  assertEquals([await t("prefecture", "head"), await t("designated_city", "head"), await t("special_ward", "head"), await t("village", "head"), await t("prefecture", "assembly"), await t("city", "assembly"), await t("admin_ward", "head")],
    ["governor", "mayor", "ward_mayor", "town_mayor", "pref_assembly", "muni_assembly", null]);
});

// =============================================================================================
// b. 線索
// =============================================================================================
Deno.test("線索：作成・併合（証拠は新しい順に最大 5・URL 重複なし）・別の信号も併合・行政区と存在しない団体は skipped・入力の検査", async () => {
  const db = await freshDb();
  await clock(db, D0);
  await insertLg(db, ICHI);
  assertEquals((await record(db, ICHI, "head", "resignation", "https://n.test/1")).action, "created");
  assertEquals((await record(db, ICHI, "head", "resignation", "https://n.test/1")).action, "merged", "同じ URL は証拠に重ねない");
  assertEquals((await record(db, ICHI, "head", "death", "https://n.test/2")).action, "merged");
  for (const n of [3, 4, 5, 6, 7]) await record(db, ICHI, "head", "resignation", `https://n.test/${n}`);
  const lead = await one<{ item_count: number; signal: string; signals: string[]; n: number; first: string; signal_date: string; status: string }>(db,
    `SELECT item_count, signal, signals, jsonb_array_length(evidence) AS n, evidence->0->>'url' AS first, signal_date::TEXT AS signal_date, status FROM policy_jp.news_election_leads`);
  assertEquals(lead, { item_count: 7, signal: "resignation", signals: ["death", "resignation"], n: 5, first: "https://n.test/7", signal_date: D0, status: "open" });
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.news_election_leads`), 1, "団体×職の open は 1 件");
  // 職が違えば別の線索
  assertEquals((await record(db, ICHI, "assembly", "dissolution", "https://n.test/8")).action, "created");
  // 行政区・存在しない団体
  assertEquals((await record(db, "239999", "head", "death", "https://n.test/9")).action, "skipped");
  // 検査
  for (const args of [["232033", "mayor", "death"], ["232033", "head", "other"]]) {
    let threw = false;
    try { await record(db, args[0], args[1], args[2], "https://n.test/x"); } catch { threw = true; }
    assert(threw, args.join());
  }
  let empty = false;
  try { await db.query(`SELECT policy_jp.news_lead_record('232033', 'head', 'death', '[]'::JSONB, NULL)`); } catch { empty = true; }
  assert(empty, "証拠なしは不可");
  // seen_on は今日より先にならない（未来日付は今日に丸める）
  const f = await freshDb();
  await clock(f, D0);
  await insertLg(f, ICHI);
  await record(f, ICHI, "head", "death", "https://n.test/f", "2027-01-01");
  assertEquals((await one<{ d: string }>(f, `SELECT signal_date::TEXT AS d FROM policy_jp.news_election_leads`)).d, D0);
});

Deno.test("線索：1 日の新規上限（daily_lead_cap）は新規だけ数える／ttl を過ぎた線索は失効して新しいのが立つ／停止中は skipped", async () => {
  const db = await freshDb();
  await clock(db, D0);
  await insertLg(db, ICHI);
  await insertLg(db, "231002");
  await insertLg(db, AICHI);
  await db.exec(`UPDATE policy_jp.news_settings SET daily_lead_cap = 2`);
  assertEquals((await record(db, ICHI, "head", "death", "https://n.test/1")).action, "created");
  assertEquals((await record(db, "231002", "head", "death", "https://n.test/2")).action, "created");
  assertEquals((await record(db, AICHI, "head", "death", "https://n.test/3")).action, "capped");
  assertEquals((await record(db, ICHI, "head", "death", "https://n.test/4")).action, "merged", "併合は上限に数えない");
  // ttl（既定 60 日）：61 日後に同じ団体×職の記事 → 古いのは expired、新しいのが立つ
  await clock(db, addDays(D0, 61));
  await db.exec(`UPDATE policy_jp.news_settings SET daily_lead_cap = 10`);
  assertEquals((await record(db, ICHI, "head", "resignation", "https://n.test/5", addDays(D0, 61))).action, "created");
  assertEquals(await rows(db, `SELECT status, signal FROM policy_jp.news_election_leads WHERE lg_code = '232033' ORDER BY id`), [{ status: "expired", signal: "death" }, { status: "open", signal: "resignation" }]);
  await db.exec(`UPDATE policy_jp.news_settings SET enabled = false`);
  assertEquals((await record(db, AICHI, "head", "death", "https://n.test/6", addDays(D0, 61))).action, "skipped");
});

// =============================================================================================
// c. 派工臂
// =============================================================================================
Deno.test("news_discovery：線索 → election_discovery 任務（target.discovery=news）・前段・證拠と選管のヒント・opened_by", async () => {
  const db = await freshDb();
  await clock(db, D0);
  await insertLg(db, ICHI);
  await record(db, ICHI, "head", "resignation", "https://n.test/1");
  await record(db, ICHI, "head", "resignation", "https://n.test/2");
  await seed(db);
  const d = await news(db);
  assertEquals(d.map((x) => x.task_id), [`auto:election_discovery:${D0}:${ICHI}:head`]);
  const t = d[0];
  assertEquals(t.task_type, "election_discovery");
  assertEquals(t.priority, 1, "前段");
  assertEquals(t.opened_by?.arm, "news_discovery");
  assertEquals(t.region, "愛知県");
  const g = t.target as Record<string, unknown>;
  assertEquals({ ...g, news: undefined }, {
    discovery: "news", lg_code: ICHI, pref_name: "愛知県", lg_name: "一宮市", office_kind: "head", election_type: "mayor",
    signal: "resignation", signals: ["resignation"], signal_date: D0, item_count: 2, statutory_days: 50, lead_until: addDays(D0, 60), news: undefined,
  });
  assertEquals((g.news as Array<Record<string, string>>).map((n) => n.url), ["https://n.test/2", "https://n.test/1"], "新しい順");
  assert(t.what_we_need.includes("報道は手がかりであって出典ではありません"));
  assert(t.what_we_need.includes("election_type（mayor）"));
  assert(t.what_we_need.includes("https://n.test/2"));
  const hints = (await one<{ h: string[] }>(db, `SELECT hint_sources AS h FROM policy_jp.task_dispatches WHERE task_id = $1`, [t.task_id])).h;
  assert(hints.includes("愛知県選挙管理委員会") && hints.includes("一宮市選挙管理委員会") && hints.includes("https://n.test/1"));
  // 任期満了の臂とは別物：task_type が同じでも discovery=news で区別できる
  assertEquals((await one<{ r: number }>(db, `SELECT policy_jp.chain_step_rank($1, 'election_discovery') AS r`, [t.task_id])).r, 1);
});

Deno.test("news_discovery：議会解散の statutory_days は 40、リコールは null／election_type は団体の種類から", async () => {
  const db = await freshDb();
  await clock(db, D0);
  await insertLg(db, "231002");
  await insertLg(db, AICHI);
  await record(db, "231002", "assembly", "dissolution", "https://n.test/a");
  await record(db, AICHI, "head", "recall", "https://n.test/b");
  await seed(db);
  const by = Object.fromEntries((await news(db)).map((d) => [d.target.lg_code as string, d.target]));
  assertEquals([by["231002"].election_type, by["231002"].statutory_days, by["231002"].office_kind], ["muni_assembly", 40, "assembly"]);
  assertEquals([by[AICHI].election_type, by[AICHI].statutory_days], ["governor", null]);
});

Deno.test("news_discovery：選挙が記録された／ttl が過ぎた／min_items 未満／cap／查無の冷卻／規則の停用 → 開かない・收回", async () => {
  const db = await freshDb();
  await clock(db, D0);
  await insertLg(db, ICHI);
  await insertLg(db, "231002");
  await insertLg(db, AICHI);
  await record(db, ICHI, "head", "death", "https://n.test/1");
  await record(db, "231002", "head", "death", "https://n.test/2");
  await record(db, AICHI, "head", "death", "https://n.test/3");
  await seed(db);
  assertEquals((await news(db)).length, 3);
  // 1. 一宮市長の選挙が記録された（線索の日付から ttl＋60 日以内）→ 缺口ではない。別の団体の選挙は関係ない。assembly の選挙も関係ない
  await insertElection(db, "231002", addDays(D0, 30), { type: "muni_assembly" });
  await seed(db);
  assertEquals((await news(db)).length, 3, "職が違う選挙は缺口を閉じない");
  await insertElection(db, ICHI, addDays(D0, 45));
  await seed(db);
  assertEquals((await news(db)).map((d) => d.target.lg_code).sort(), [AICHI, "231002"].sort());
  assertEquals((await events(db, `auto:election_discovery:${D0}:${ICHI}:head`)).at(-1)?.event, "closed");
  // 2. 查無（not_found）→ 冷卻中は出ない
  await check(db, `auto:election_discovery:${D0}:231002:head`, "not_found");
  await seed(db);
  assertEquals((await news(db)).map((d) => d.target.lg_code), [AICHI]);
  // 3. min_items
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(params, '{min_items}', '2') WHERE activity = 'news_discovery' AND priority IS NULL`);
  await seed(db);
  assertEquals((await news(db)).length, 0);
  await record(db, AICHI, "head", "death", "https://n.test/4");
  await seed(db);
  assertEquals((await news(db)).map((d) => d.target.lg_code), [AICHI], "続報で item_count=2 になれば開く");
  // 4. ttl を過ぎる（clock 進める）→ 收回
  await clock(db, addDays(D0, 61));
  await seed(db);
  assertEquals((await news(db)).length, 0);
  // 5. cap と停用
  await clock(db, D0);
  await db.exec(`UPDATE policy_jp.activity_rules SET params = jsonb_set(jsonb_set(params, '{min_items}', '1'), '{cap}', '1') WHERE activity = 'news_discovery' AND priority IS NULL`);
  await seed(db);
  assertEquals((await news(db)).length, 1, "cap=1");
  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = false WHERE activity = 'news_discovery' AND priority IS NULL`);
  await seed(db);
  assertEquals((await news(db)).length, 0);
});

Deno.test("news_discovery：失効・却下の線索は出ない、団体の有効期間が終わった（valid_to）ものも出ない", async () => {
  const db = await freshDb();
  await clock(db, D0);
  await insertLg(db, ICHI);
  await record(db, ICHI, "head", "death", "https://n.test/1");
  await seed(db);
  assertEquals((await news(db)).length, 1);
  await db.exec(`UPDATE policy_jp.news_election_leads SET status = 'dismissed'`);
  await seed(db);
  assertEquals((await news(db)).length, 0, "dismissed");
  await db.exec(`UPDATE policy_jp.news_election_leads SET status = 'open'`);
  await seed(db);
  assertEquals((await news(db)).length, 1);
  await db.exec(`UPDATE policy_jp.local_governments SET valid_to = DATE '2026-04-01' WHERE lg_code = '${ICHI}'`);
  await seed(db);
  assertEquals((await news(db)).length, 0, "合併などで消えた団体");
});

// =============================================================================================
// d. 協議・同一件事・purge
// =============================================================================================
Deno.test("協議：news の任務 id は既存の election 交件の検査にそのまま通る（団体と職が一致、種類が職と合う）／同一件事の探査も動く／news_purge", async () => {
  const taskId = `auto:election_discovery:${D0}:${ICHI}:head`;
  const base = { agent_name: "jp-agent", agent_tool: "cli/test-agent", source_urls: ["https://www.city.ichinomiya.aichi.jp/senkyo/"] };
  const payload = { lg_code: ICHI, election_type: "mayor", election_reason: "resignation", election_date: "2026-11-29", notice_date: "2026-11-22", resolved_claim: "new" };
  const req = (p: Record<string, unknown>) => validateContributionRequest({ ...base, contribution_type: "election", task_id: taskId, payload: p });
  assertEquals(req(payload).errors, []);
  assert(req({ ...payload, lg_code: "231002" }).errors.some((e) => e.path === "payload.lg_code"), "別の団体は不可");
  assert(req({ ...payload, election_type: "muni_assembly" }).errors.some((e) => e.path === "payload.election_type"), "職と種類が合わない");
  assertEquals(jpSameClaimProbe(taskId), { type: "election", payload: { term_end: D0, lg_code: ICHI, office_kind: "head" } });
  assert(JP_PROTOCOL_VERSION.split(".").map(Number).reduce((a, n, i) => a + n * [1e6, 1e3, 1][i], 0) >= 25, "協議版號は 0.25.0 以上");

  const db = await freshDb();
  await clock(db, D0);
  await insertLg(db, ICHI);
  await record(db, ICHI, "head", "death", "https://n.test/1");
  await db.exec(`INSERT INTO policy_jp.news_sources (label, kind, feed_url, format, link_pattern) VALUES ('t', 'media', 'https://t.test/x', 'html', '^https://t\\.test/a/')`);
  const sid = (await one<{ id: number }>(db, `SELECT id::INT AS id FROM policy_jp.news_sources WHERE feed_url = 'https://t.test/x'`)).id;
  await db.query(`INSERT INTO policy_jp.news_items (source_id, url, title, fetched_at) VALUES ($1, 'https://t.test/old', 'old', now() - INTERVAL '31 days'), ($1, 'https://t.test/new', 'new', now())`, [sid]);
  assertEquals((await one<{ n: number }>(db, `SELECT policy_jp.news_purge() AS n`)).n, 1);
  assertEquals(await rows(db, `SELECT url FROM policy_jp.news_items WHERE source_id = $1`, [sid]), [{ url: "https://t.test/new" }]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.news_election_leads`), 1, "線索の証拠は記事を消しても残る");
});

Deno.test("来源は網頁だけ（20261011260000）：rss／atom は enabled にできない、html は link_pattern 必須、250000 の RSS 種子は止まっている", async () => {
  const db = await freshDb();
  const fails = async (sql: string) => { let t = false; try { await db.exec(sql); } catch { t = true; } return t; };
  assert(await fails(`INSERT INTO policy_jp.news_sources (label, kind, feed_url, format) VALUES ('r', 'media', 'https://r.test/x.xml', 'rss')`), "enabled な RSS は入らない");
  assert(await fails(`INSERT INTO policy_jp.news_sources (label, kind, feed_url, format, enabled) VALUES ('a', 'media', 'https://a.test/x.xml', 'atom', TRUE)`), "enabled な Atom も入らない");
  assert(await fails(`UPDATE policy_jp.news_sources SET enabled = TRUE WHERE format = 'rss'`), "止めた RSS を戻せない");
  assert(await fails(`INSERT INTO policy_jp.news_sources (label, kind, feed_url, format) VALUES ('h', 'media', 'https://h.test/', 'html')`), "link_pattern なしの html は入らない");
  assert(await fails(`INSERT INTO policy_jp.news_sources (label, kind, feed_url, format, link_pattern) VALUES ('h', 'media', 'https://h.test/', 'html', '  ')`), "空白だけの link_pattern も不可");
  await db.exec(`INSERT INTO policy_jp.news_sources (label, kind, feed_url, format, link_pattern) VALUES ('h', 'media', 'https://h.test/', 'html', '^https://h\\.test/n/')`);
  await db.exec(`INSERT INTO policy_jp.news_sources (label, kind, feed_url, format, enabled) VALUES ('r2', 'media', 'https://r2.test/x.xml', 'rss', FALSE)`);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.news_sources WHERE feed_url LIKE 'https://www3.nhk.or.jp/rss/%' AND NOT enabled`), 3, "NHK の RSS 3 本は止まった");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.news_sources WHERE enabled AND format <> 'html'`), 0);
});

// =============================================================================================
// e. 還原驗證
// =============================================================================================
Deno.test("還原驗證：臂の『選挙が記録されていたら缺口ではない』を外すと、選挙があっても任務が開き続ける（上のテストが守っている）", async () => {
  const broken = MIG_SQL.replace(/       AND NOT EXISTS \(\n         SELECT 1 FROM policy_jp\.elections e\n[\s\S]*?e\.election_date BETWEEN[^\n]*\n/, "");
  assert(broken !== MIG_SQL);
  const db = await freshDb();
  // 自我檢查は外して本体だけ流し直す。RSS の種子は 260000 の CHECK（enabled は html だけ）に触れるので止めた形で流す
  await db.exec(broken.replace(/DO \$\$\nBEGIN\n  IF NOT \('news_discovery'[\s\S]*$/, "").replaceAll("'rss', TRUE)", "'rss', FALSE)"));
  await clock(db, D0);
  await insertLg(db, ICHI);
  await record(db, ICHI, "head", "death", "https://n.test/1");
  await insertElection(db, ICHI, addDays(D0, 45));
  await seed(db);
  assertEquals((await news(db)).length, 1, "還原版では選挙があっても開く＝本物の版ではこれが 0 になる");
});
