/**
 * 日本站：存檔網址（Wayback／archive.today／国立国会図書館 WARP）照原網址分級
 * （migration 20261011220000_policy_jp_source_archive.sql、工作單 Yooliang/policy-ops#95、正見 1.89.0 source_unwrap_archive の日本版、協議 0.22.0）
 *
 * 只要 --allow-read。
 *   a. 結構：新函式・source_kind_for_url は前の版に WARP 一行と unwrap の包みだけ足した・権限・協議版號・public／ditrust に触れない
 *   b. TS：unwrapJpArchiveUrl／jpSourceKind の各形（Wayback、archive.today 系、WARP、WARP の非公式サイトは other のまま、解けない WARP は other）
 *   c. SQL≡TS 対齊（同じ網址表を PGlite の source_kind_for_url／source_unwrap_archive に通す）
 *   d. 落庫 source_write：存檔の公式ページが primary になる／既存列の再計算（WARP の誤 official を直す・self 等は触らない）
 *   e. 交件の検査：discontinued／stop／official_record／local_government が存檔の公式ページで通り、存檔の報道では通らない
 *   f. 還原驗證：migration の各部品を壊すと表のどこかが赤くなる
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { migratedDb, mutate, readMig, rows, one, jpMigrationNames, freshDb, asRole } from "./policy-jp-chain-db.ts";
import { jpSourceKind, unwrapJpArchiveUrl } from "./jp/source-kind.ts";
import { validateContributionRequest } from "./jp/contribution-schema.ts";
import { JP_PROTOCOL_VERSION } from "./jp/protocol.ts";

const MIG_FILE = "20261011220000_policy_jp_source_archive.sql";
const MIG_SQL = await readMig(MIG_FILE);
const APPLY_SQL = await readMig("20261009210000_policy_jp_apply.sql");

const KOUHOU = "https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf";
const NEWS = "https://news.example.com/ichinomiya/1";
const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");

// 網址表：[url, 契約型別, 期待の等級, 期待の原網址（存檔でなければ trim しただけ）]
const CASES: Array<[string, string | null, string, string]> = [
  // 存檔でない（これまで通り）
  [KOUHOU, null, "official", KOUHOU],
  [NEWS, null, "other", NEWS],
  ["https://www.soumu.go.jp/denshijiti/code.html", "regional_stat", "statistics", "https://www.soumu.go.jp/denshijiti/code.html"],
  // Wayback
  [`https://web.archive.org/web/20261001000000/${KOUHOU}`, null, "official", KOUHOU],
  [`http://web.archive.org/web/20261001im_/${KOUHOU}`, null, "official", KOUHOU],
  [`https://web.archive.org/web/2026/www.city.ichinomiya.aichi.jp/senkyo/`, null, "official", "http://www.city.ichinomiya.aichi.jp/senkyo/"],
  [`https://web.archive.org/web/20261001000000/${NEWS}`, null, "other", NEWS],
  ["https://web.archive.org/web/20261001000000/https://www.e-stat.go.jp/x", null, "statistics", "https://www.e-stat.go.jp/x"],
  ["https://web.archive.org/web/20261001000000/https://www.soumu.go.jp/denshijiti/code.html", "regional_stat", "statistics", "https://www.soumu.go.jp/denshijiti/code.html"],
  ["https://web.archive.org/save/https://www.city.ichinomiya.aichi.jp/", null, "other", "https://web.archive.org/save/https://www.city.ichinomiya.aichi.jp/"],
  // archive.today 系
  [`https://archive.ph/20261001123456/${KOUHOU}`, null, "official", KOUHOU],
  [`https://archive.today/newest/${KOUHOU}`, null, "official", KOUHOU],
  [`https://archive.is/timegate/${KOUHOU}`, null, "official", KOUHOU],
  [`https://www.archive.li/o/AbC12/${KOUHOU}`, null, "official", KOUHOU],
  [`https://archive.ph/20261001123456/${NEWS}`, null, "other", NEWS],
  ["https://archive.ph/AbC12", null, "other", "https://archive.ph/AbC12"], // 短網址は原網址を持たない
  ["https://archive.example.com/20261001123456/https://www.city.ichinomiya.aichi.jp/", null, "other", "https://archive.example.com/20261001123456/https://www.city.ichinomiya.aichi.jp/"],
  // WARP（原網址に scheme がない）
  ["https://warp.ndl.go.jp/info:ndljp/pid/11500000/www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf", null, "official", "http://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf"],
  ["https://warp.da.ndl.go.jp/info:ndljp/pid/283156/www.pref.aichi.lg.jp/a/b.html", null, "official", "http://www.pref.aichi.lg.jp/a/b.html"],
  ["https://warp.ndl.go.jp/info:ndljp/pid/11500000/www.soumu.go.jp/denshijiti/code.html", "regional_stat", "statistics", "http://www.soumu.go.jp/denshijiti/code.html"],
  ["https://warp.ndl.go.jp/info:ndljp/pid/11500000/www.kantei.go.jp/jp/", null, "official", "http://www.kantei.go.jp/jp/"],
  // WARP の非公式サイトは .go.jp の保存庫に載っていても official にならない
  ["https://warp.ndl.go.jp/info:ndljp/pid/11500000/www.asahi.com/articles/x.html", null, "other", "http://www.asahi.com/articles/x.html"],
  ["https://warp.da.ndl.go.jp/info:ndljp/pid/11500000/blog.example.jp/city.aichi.jp/", null, "other", "http://blog.example.jp/city.aichi.jp/"],
  ["https://warp.ndl.go.jp/info:ndljp/pid/11500000/evil-stat.go.jp.example.com/", null, "other", "http://evil-stat.go.jp.example.com/"],
  // 解けない WARP（トップ、新しい waid 形、pid が数字でない）は保存庫自体を官方扱いしない
  ["https://warp.ndl.go.jp/", null, "other", "https://warp.ndl.go.jp/"],
  ["https://warp.ndl.go.jp/waid/12345/www.city.ichinomiya.aichi.jp/", null, "other", "https://warp.ndl.go.jp/waid/12345/www.city.ichinomiya.aichi.jp/"],
  ["https://warp.ndl.go.jp/info:ndljp/pid/abc/www.city.ichinomiya.aichi.jp/", null, "other", "https://warp.ndl.go.jp/info:ndljp/pid/abc/www.city.ichinomiya.aichi.jp/"],
  // 二重（Wayback の中に WARP）：二層まで
  ["https://web.archive.org/web/20261001000000/https://warp.ndl.go.jp/info:ndljp/pid/1/www.city.ichinomiya.aichi.jp/", null, "official", "https://warp.ndl.go.jp/info:ndljp/pid/1/www.city.ichinomiya.aichi.jp/"],
  ["https://web.archive.org/web/20261001000000/https://warp.ndl.go.jp/info:ndljp/pid/1/www.asahi.com/", null, "other", "https://warp.ndl.go.jp/info:ndljp/pid/1/www.asahi.com/"],
  // 見た目の紛らわしさ：ホスト名に archive を含むだけ／パスに埋めただけ
  ["https://www.city.ichinomiya.aichi.jp/web.archive.org/web/2026/https://example.com/", null, "official", "https://www.city.ichinomiya.aichi.jp/web.archive.org/web/2026/https://example.com/"],
  ["https://evil.example.com/warp.ndl.go.jp/info:ndljp/pid/1/www.city.ichinomiya.aichi.jp/", null, "other", "https://evil.example.com/warp.ndl.go.jp/info:ndljp/pid/1/www.city.ichinomiya.aichi.jp/"],
  ["https://example.com/?u=https://web.archive.org/web/2026/https://www.go.jp/", null, "other", "https://example.com/?u=https://web.archive.org/web/2026/https://www.go.jp/"],
  // 空白の trim、大文字、不正
  [`  https://WEB.ARCHIVE.ORG/WEB/20261001000000/${KOUHOU}  `, null, "official", KOUHOU],
  ["not a url", null, "other", "not a url"],
  ["", null, "other", ""],
];

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：新函式 source_unwrap_archive・source_kind_for_url の再定義・権限・public／ditrust に触れない", () => {
  const sql = stripComments(MIG_SQL);
  assert(/CREATE OR REPLACE FUNCTION policy_jp\.source_unwrap_archive\(p_url TEXT\) RETURNS TEXT\s+LANGUAGE sql IMMUTABLE/.test(sql));
  assert(/CREATE OR REPLACE FUNCTION policy_jp\.source_kind_for_url\(p_url TEXT, p_contribution_type TEXT DEFAULT NULL\) RETURNS TEXT/.test(sql));
  assert(/REVOKE EXECUTE ON FUNCTION policy_jp\.source_unwrap_archive\(TEXT\) FROM PUBLIC, anon, authenticated;/.test(sql));
  assert(/GRANT EXECUTE ON FUNCTION policy_jp\.source_unwrap_archive\(TEXT\) TO service_role;/.test(sql));
  assert(!/\b(public|ditrust)\./i.test(sql.replace(/policy_jp\./g, "")), "public／ditrust の物件に触れない");
  assert(!/CREATE (OR REPLACE )?FUNCTION (?!policy_jp\.)/.test(sql), "関数は全部 policy_jp.");
  assert(MIG_SQL.includes("search_path = policy_jp, pg_temp"), "SET search_path 付き");
});

Deno.test("結構：source_kind_for_url は 20261009210000 の版に『WARP 一行』と『unwrap の包み』を足しただけ（他の分支は一字も変えない）", () => {
  const body = (s: string) => /CREATE OR REPLACE FUNCTION policy_jp\.source_kind_for_url[\s\S]*?\$\$;?\s*\n/.exec(s.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n"))![0];
  const before = body(APPLY_SQL);
  const after = body(MIG_SQL);
  const removeAdded = after
    .replace(/\n\s*WHEN x\.h ~ '\^warp\(\\\.da\)\?\\\.ndl\\\.go\\\.jp\$' THEN 'other'\s*/, "\n")
    .replace("lower(policy_jp.source_unwrap_archive(policy_jp.source_unwrap_archive(p_url)))", "lower(p_url)");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  assertEquals(norm(removeAdded), norm(before));
});

// source_kind_for_url を定義する migration の一覧
const defs: string[] = [];
for (const n of await jpMigrationNames()) if (/CREATE OR REPLACE FUNCTION policy_jp\.source_kind_for_url/.test(await readMig(n))) defs.push(n);
Deno.test("結構：source_kind_for_url の最新定義は この migration（後の migration が黙って上書きしていない）", () => {
  assertEquals(defs, ["20261009210000_policy_jp_apply.sql", MIG_FILE]);
});

Deno.test("協議：存檔の公式ページが official 要件を満たすようになるので JP_PROTOCOL_VERSION は 0.22.0 以上", () => {
  const n = (v: string) => v.split(".").reduce((a, x) => a * 1000 + Number(x), 0);
  assert(n(JP_PROTOCOL_VERSION) >= n("0.22.0"), JP_PROTOCOL_VERSION);
});

// =============================================================================================
// b. TS
// =============================================================================================
Deno.test("TS：unwrapJpArchiveUrl／jpSourceKind — Wayback・archive.today 系・WARP の各形、WARP の非公式サイトと解けない WARP は other", () => {
  for (const [url, type, kind, original] of CASES) {
    assertEquals(unwrapJpArchiveUrl(url), original, `unwrap ${JSON.stringify(url)}`);
    assertEquals(jpSourceKind(url, type ?? undefined), kind, `kind ${JSON.stringify(url)} (${type})`);
  }
  // 結論そのもの（表が両側で同じ間違いをしていないか）
  assertEquals(jpSourceKind("https://warp.ndl.go.jp/info:ndljp/pid/1/www.asahi.com/a"), "other");
  assertEquals(jpSourceKind("https://warp.ndl.go.jp/"), "other");
  assertEquals(jpSourceKind("https://warp.ndl.go.jp/info:ndljp/pid/1/www.city.nagoya.jp/"), "official");
  assertEquals(jpSourceKind("https://web.archive.org/web/2026/https://www.asahi.com/a"), "other");
});

// =============================================================================================
// c. SQL ≡ TS
// =============================================================================================
Deno.test("対齊：同じ網址表で SQL の source_kind_for_url／source_unwrap_archive と TS が一致し、表の期待値とも一致する", async () => {
  const db = await freshDb();
  for (const type of [null, "regional_stat", "local_government", "policy_progress"]) {
    const got = await rows<{ u: string; k: string; o: string }>(db,
      `SELECT u, policy_jp.source_kind_for_url(u, $2) AS k, policy_jp.source_unwrap_archive(u) AS o FROM unnest($1::TEXT[]) AS u`, [CASES.map((c) => c[0]), type]);
    assertEquals(got.length, CASES.length);
    for (const r of got) {
      assertEquals(jpSourceKind(r.u, type ?? undefined), r.k, `source_kind_for_url(${JSON.stringify(r.u)}, ${type}) TS≠SQL`);
      assertEquals(unwrapJpArchiveUrl(r.u), r.o, `source_unwrap_archive(${JSON.stringify(r.u)}) TS≠SQL`);
    }
  }
  for (const [url, type, kind, original] of CASES) {
    const r = await one<{ k: string; o: string }>(db, `SELECT policy_jp.source_kind_for_url($1, $2) AS k, policy_jp.source_unwrap_archive($1) AS o`, [url, type]);
    assertEquals(r.k, kind, `SQL kind ${JSON.stringify(url)}`);
    assertEquals(r.o, original, `SQL unwrap ${JSON.stringify(url)}`);
  }
  await db.close();
});

// =============================================================================================
// d. 落庫・既存列の再計算
// =============================================================================================
Deno.test("落庫：source_write — 存檔の公式ページが primary、WARP の非公式サイトは primary にならない（other のまま）", async () => {
  const db = await freshDb();
  const wb = `https://web.archive.org/web/20261001000000/${KOUHOU}`;
  const warpNews = "https://warp.ndl.go.jp/info:ndljp/pid/1/www.asahi.com/a.html";
  const id1 = (await one<{ id: number }>(db, `SELECT policy_jp.source_write(NULL, NULL, ARRAY[$1, $2], 'policy_progress') AS id`, [NEWS, wb])).id;
  const k = await rows<{ url: string; source_kind: string }>(db, `SELECT url, source_kind FROM policy_jp.sources WHERE id = $1 OR url IN ($2, $3) ORDER BY url`, [id1, NEWS, wb]);
  assertEquals(Object.fromEntries(k.map((r) => [r.url, r.source_kind])), { [NEWS]: "other", [wb]: "official" });
  assertEquals((await one<{ url: string }>(db, `SELECT url FROM policy_jp.sources WHERE id = $1`, [id1])).url, wb, "存檔の公式ページが主要出處");
  const id2 = (await one<{ id: number }>(db, `SELECT policy_jp.source_write(NULL, NULL, ARRAY[$1], 'policy_progress') AS id`, [warpNews])).id;
  assertEquals((await one<{ source_kind: string }>(db, `SELECT source_kind FROM policy_jp.sources WHERE id = $1`, [id2])).source_kind, "other");
  await db.close();
});

Deno.test("既存列の再計算：存檔形の official／statistics／other だけ直す（WARP の誤 official は下げる）；self・media・assembly と通常の網址は触らない", async () => {
  const db = await migratedDb({ before: MIG_FILE });
  const wb = `https://web.archive.org/web/20261001000000/${KOUHOU}`;
  const warpBad = "https://warp.ndl.go.jp/info:ndljp/pid/1/www.asahi.com/a.html";
  const warpOk = "https://warp.ndl.go.jp/info:ndljp/pid/1/www.city.ichinomiya.aichi.jp/a.html";
  const ph = `https://archive.ph/20261001123456/${KOUHOU}`;
  const ins = (url: string, kind: string, ev: string | null = null) =>
    db.query(`INSERT INTO policy_jp.sources (url, source_kind, self_evidence, origin) VALUES ($1, $2, $3, 'test')`, [url, kind, ev]);
  await ins(wb, "other"); await ins(warpBad, "official"); await ins(warpOk, "official"); await ins(ph, "other");
  await ins("https://web.archive.org/web/20261001000000/https://self.example.jp/", "self", "mutual_link");
  await ins("https://web.archive.org/web/20261001000000/https://www.city.ichinomiya.aichi.jp/media-like", "media");
  await ins("https://warp.ndl.go.jp/info:ndljp/pid/2/www.city.ichinomiya.aichi.jp/minutes", "assembly");
  await ins(NEWS, "other"); await ins(KOUHOU, "official");
  const snapshot = async () => Object.fromEntries((await rows<{ url: string; source_kind: string }>(db, `SELECT url, source_kind FROM policy_jp.sources`)).map((r) => [r.url, r.source_kind]));
  const before = await snapshot();
  await db.exec(MIG_SQL);
  const after = await snapshot();
  assertEquals(after[wb], "official");
  assertEquals(after[warpBad], "other");
  assertEquals(after[warpOk], "official");
  assertEquals(after[ph], "official");
  for (const u of Object.keys(before)) if (![wb, warpBad, ph].includes(u)) assertEquals(after[u], before[u], `${u} は変わらない`);
  await db.exec(MIG_SQL); // 冪等
  assertEquals(await snapshot(), after);
  await db.close();
});

Deno.test("権限：source_unwrap_archive は service_role だけ（anon／authenticated は実行できない）", async () => {
  const db = await freshDb();
  for (const role of ["anon", "authenticated"]) await assertRejects(() => asRole(db, role, `SELECT policy_jp.source_unwrap_archive('x')`), Error, "permission denied");
  assertEquals((await asRole<{ o: string }>(db, "service_role", `SELECT policy_jp.source_unwrap_archive('x') AS o`))[0].o, "x");
  await db.close();
});

// =============================================================================================
// e. 交件の検査（TS、SQL の落庫と同じ判定）
// =============================================================================================
const PID = "5f0c8d6e-1111-4222-8333-444444444444";
const req = (type: string, payload: Record<string, unknown>, urls: string[]) => validateContributionRequest({
  agent_name: "jp-agent", agent_tool: "claude-code/claude-sonnet-5", contribution_type: type, payload, source_urls: urls,
});
Deno.test("TS：discontinued は存檔の公式ページ（Wayback／archive.today／WARP）で通り、存檔の報道・WARP の非公式サイトでは通らない", () => {
  const dis = { policy_id: PID, status: "discontinued", date: "2026-06-01", note: "議会が事業の中止を決議した（令和 8 年 12 月議会）" };
  for (const u of [`https://web.archive.org/web/20261001000000/${KOUHOU}`, `https://archive.ph/20261001123456/${KOUHOU}`, "https://warp.ndl.go.jp/info:ndljp/pid/1/www.city.ichinomiya.aichi.jp/a.html"]) {
    assert(req("policy_progress", dis, [u]).ok, u);
  }
  for (const u of [`https://web.archive.org/web/20261001000000/${NEWS}`, "https://warp.ndl.go.jp/info:ndljp/pid/1/www.asahi.com/a.html", "https://warp.ndl.go.jp/"]) {
    const r = req("policy_progress", dis, [u]);
    assert(r.errors.some((e) => e.path === "source_urls" && e.message.includes("公的")), `${u}: ${JSON.stringify(r.errors)}`);
  }
});

Deno.test("TS：local_government の公的な出典要件も存檔の公式ページで満たす（WARP の非公式サイトは不可）", () => {
  const lg = { kind: "city", lg_code: "232033", name: "一宮市", kana: "いちのみやし", pref_code: "230006" };
  const okReq = req("local_government", lg, ["https://warp.ndl.go.jp/info:ndljp/pid/1/www.soumu.go.jp/denshijiti/code.html"]);
  assert(!okReq.errors.some((e) => e.path === "source_urls"), JSON.stringify(okReq.errors));
  const bad = req("local_government", lg, ["https://warp.ndl.go.jp/info:ndljp/pid/1/www.asahi.com/a.html"]);
  assert(bad.errors.some((e) => e.path === "source_urls"), JSON.stringify(bad.errors));
});

// =============================================================================================
// f. 還原驗證
// =============================================================================================
Deno.test("自我檢查（還原驗證）：unwrap の三つの形・WARP の other 一行・二重包み・正規表現を壊すと、網址表のどこかが SQL で食い違う", async () => {
  const urls = CASES.map((c) => c[0]);
  const ref = await freshDb();
  const want = await rows<{ u: string; k: string }>(ref, `SELECT u, policy_jp.source_kind_for_url(u) AS k FROM unnest($1::TEXT[]) AS u`, [urls]);
  await ref.close();
  assertEquals(want.filter((r) => jpSourceKind(r.u) !== r.k).length, 0);
  const mutants: Array<[string, string, string]> = [
    ["WARP の other 一行を消す", "WHEN x.h ~ '^warp(\\.da)?\\.ndl\\.go\\.jp$' THEN 'other'", "WHEN FALSE THEN 'other'"],
    ["二重包みを一重に", "policy_jp.source_unwrap_archive(policy_jp.source_unwrap_archive(p_url))", "policy_jp.source_unwrap_archive(p_url)"],
    ["Wayback を見ない", "web\\.archive\\.org/web/[0-9]", "web\\.archive\\.invalid/web/[0-9]"],
    ["archive.today 系を見ない", "archive\\.(?:today|ph|is|li|md|vn|fo)", "archive\\.(?:none)"],
    ["WARP を見ない", "info:ndljp/pid/[0-9]+/(.+)$', 'i') AS n", "info:none/pid/[0-9]+/(.+)$', 'i') AS n"],
    ["WARP の原網址に scheme を補わない", "WHEN n IS NOT NULL THEN CASE WHEN n[1] ~* '^https?://' THEN n[1] ELSE 'http://' || n[1] END", "WHEN n IS NOT NULL THEN n[1]"],
  ];
  for (const [why, from, to] of mutants) {
    const sql = mutate(MIG_SQL, from, to);
    const db = await migratedDb({ before: MIG_FILE });
    await db.exec(sql);
    const got = await rows<{ u: string; k: string; o: string }>(db, `SELECT u, policy_jp.source_kind_for_url(u) AS k, policy_jp.source_unwrap_archive(u) AS o FROM unnest($1::TEXT[]) AS u`, [urls]);
    await db.close();
    const diff = got.filter((r) => jpSourceKind(r.u) !== r.k || unwrapJpArchiveUrl(r.u) !== r.o);
    assert(diff.length > 0, `${why}: 食い違いが検出されない（網址表が足りない）`);
  }
});
