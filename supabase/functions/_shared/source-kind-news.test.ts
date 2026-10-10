/**
 * 出處分類：新聞網域被標成「其他」（migration 20261010080000；工作單 Yooliang/policy-ops#59）。
 *   - 媒體清單只有一份：source-priority.ts 的 SOURCE_PRIORITY；SQL contribution_source_kind 逐字等於它（thresholds.test.ts 也比）
 *   - independent-sources.ts 不再另列新聞網站（EXTRA_NEWS_SITES 併回媒體清單）
 *   - 自動分級（SQL source_auto_kind／TS autoSourceKind）web.archive.org 存檔看原網址；PGlite 實跑兩邊逐網址一致
 *   - 既有列只往上調 other → media／official，不動 self、official、media
 *   - 還原驗證：SQL 媒體清單拿掉一個網域，跟 TS 對不上
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { SOURCE_PRIORITY } from "./source-priority.ts";
import { autoSourceKind } from "./source-write.ts";
import * as independent from "./independent-sources.ts";

const MIG = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIG))).replace(/\r\n/g, "\n");
const SQL = await read("20261010080000_source_kind_news.sql");
const OLD = await read("20260912000009_zero_manual_points.sql");
const STAGE2A = await read("20261006210000_sources_stage2a.sql");

function fnOf(sql: string, name: string): string {
  const at = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(at >= 0, `找不到 ${name}`);
  const close = sql.indexOf("$$;", sql.indexOf("$$", at) + 2);
  return sql.slice(at, close + 3);
}

/** 本支 migration 的 contribution_source_kind 三組清單 */
function sqlLists(sql: string): string[][] {
  return [...fnOf(sql, "contribution_source_kind").matchAll(/ARRAY\[('[^\]]+)\]/g)].map((m) => m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")));
}

const byKind = (kind: string) => SOURCE_PRIORITY.filter((s) => s.kind === kind).map((s) => s.host);

async function db(mig = SQL): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(fnOf(OLD, "contribution_host_of") + "\n" + fnOf(OLD, "contribution_host_in"));
  await d.exec(`CREATE TABLE sources (id serial PRIMARY KEY, url text NOT NULL UNIQUE, source_kind text NOT NULL DEFAULT 'other');`);
  // source_self_eligible 呼叫 source_auto_kind：先放一個暫時的，migration 會換掉 source_auto_kind
  await d.exec(`CREATE FUNCTION source_auto_kind(p_url TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT 'other' $$;`);
  await d.exec(fnOf(STAGE2A, "source_self_eligible"));
  await d.exec(mig);
  return d;
}

Deno.test("媒體清單只有一份：SQL contribution_source_kind 三組＝SOURCE_PRIORITY", () => {
  const [official, media, social] = sqlLists(SQL);
  assertEquals(official, byKind("official"));
  assertEquals(media, byKind("media"));
  assertEquals(social, byKind("social"));
  assert(!("EXTRA_NEWS_SITES" in independent), "independent-sources.ts 不能再另列新聞網站");
});

Deno.test("還原驗證：SQL 媒體清單拿掉一個網域就對不上", () => {
  const broken = SQL.replace("'cnews.com.tw', ", "");
  assert(broken !== SQL);
  assert(JSON.stringify(sqlLists(broken)[1]) !== JSON.stringify(byKind("media")));
});

Deno.test("SQL source_auto_kind 與 TS autoSourceKind 逐網址一致（含存檔、子網域、清單外網站）", async () => {
  const d = await db();
  const urls = [
    ...SOURCE_PRIORITY.flatMap((s) => [`https://${s.host}/a`, `https://news.${s.host}/a`, `https://web.archive.org/web/20260101000000/https://www.${s.host}/a`]),
    "https://web.archive.org/web/2026id_/bulletin.cec.gov.tw/x.pdf",
    "https://scooptw.com/a", "https://zh.wikipedia.org/wiki/x", "https://www.tpp.org.tw/x", "https://candidate.tw/",
    "https://web.archive.org/web/20260101000000/https://scooptw.com/a", "https://notyahoo.com/x",
  ];
  for (const u of urls) {
    const { rows } = await d.query<{ k: string }>(`SELECT source_auto_kind($1) AS k`, [u]);
    assertEquals(rows[0].k, autoSourceKind(u), u);
  }
  assertEquals(autoSourceKind("https://web.archive.org/web/20260101000000/https://news.cnews.com.tw/a"), "media");
  assertEquals(autoSourceKind("https://web.archive.org/web/2026/https://bulletin.cec.gov.tw/x.pdf"), "official");
  assertEquals(autoSourceKind("https://scooptw.com/a"), "other", "內容農場維持 other");
  await d.close();
});

Deno.test("既有列只往上調：other → media／official，self、media、official 不動", async () => {
  const d = new PGlite();
  await d.exec(fnOf(OLD, "contribution_host_of") + "\n" + fnOf(OLD, "contribution_host_in"));
  await d.exec(`CREATE TABLE sources (id serial PRIMARY KEY, url text NOT NULL UNIQUE, source_kind text NOT NULL);
    CREATE FUNCTION source_auto_kind(p_url TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT 'other' $$;`);
  await d.exec(fnOf(STAGE2A, "source_self_eligible"));
  await d.exec(`INSERT INTO sources (url, source_kind) VALUES
    ('https://tw.news.yahoo.com/a', 'other'),
    ('https://web.archive.org/web/20260101000000/https://bulletin.cec.gov.tw/x', 'other'),
    ('https://scooptw.com/a', 'other'),
    ('https://candidate.tw/', 'self'),
    ('https://www.cna.com.tw/a', 'media')`);
  await d.exec(SQL);
  const { rows } = await d.query<{ url: string; source_kind: string }>(`SELECT url, source_kind FROM sources ORDER BY id`);
  assertEquals(rows.map((r) => r.source_kind), ["media", "official", "other", "self", "media"]);
  await d.close();
});

Deno.test("本人來源在新分級下不合格就整支停下（不讓既有列違反 sources_self_eligible）", async () => {
  const d = new PGlite();
  await d.exec(fnOf(OLD, "contribution_host_of") + "\n" + fnOf(OLD, "contribution_host_in"));
  await d.exec(`CREATE TABLE sources (id serial PRIMARY KEY, url text NOT NULL UNIQUE, source_kind text NOT NULL);
    CREATE FUNCTION source_auto_kind(p_url TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT 'other' $$;`);
  await d.exec(fnOf(STAGE2A, "source_self_eligible"));
  await d.exec(`INSERT INTO sources (url, source_kind) VALUES ('https://news.cnews.com.tw/a', 'self')`);
  let failed = false;
  try { await d.exec(SQL); } catch (e) { failed = String(e).includes("本人來源"); }
  assert(failed, "self 列落到新聞網域要擋");
  await d.close();
});

Deno.test("#544 分組：新加入的新聞網站各自一組；內容農場仍跟社群、本人官網併一組", () => {
  const { sourceGroupOf, SELF_OR_OTHER_GROUP } = independent;
  assertEquals(sourceGroupOf("https://news.cnews.com.tw/a"), "cnews.com.tw");
  assertEquals(sourceGroupOf("https://www.epochtimes.com/b5/a.htm"), "epochtimes.com");
  assertEquals(sourceGroupOf("https://tw.news.yahoo.com/x.html"), "yahoo.com", "原本 EXTRA 的照舊");
  assertEquals(sourceGroupOf("https://scooptw.com/a"), SELF_OR_OTHER_GROUP);
  assertEquals(sourceGroupOf("https://www.facebook.com/x"), SELF_OR_OTHER_GROUP);
});
