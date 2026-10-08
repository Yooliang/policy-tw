/// <reference lib="deno.ns" />
/**
 * 網站地圖的內容規則（#466，2026-10-08）。守四件事：
 *   1. 人物頁政見數 ≥ 門檻（具名常數 SITEMAP_MIN_POLICIES_FOR_PERSON＝6）才進 sitemap-politicians.xml；5 筆不進、6 筆進
 *   2. lastmod 是各頁實際的最後更新時間（政見＝自己的 updated_at、人物＝名下政見最晚的、脈絡＝自己的），不是建置當天
 *   3. 沒有可靠時間的不寫（時間缺、不合法），不拿別的時間頂替
 *   4. 建置端（server-data.ts）與 postbuild 真的接上這些函式——不接的話上面三條全是空話（接線守門）
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  buildSitemapMeta,
  isSitemapPerson,
  latestLastmod,
  policyStatsByPolitician,
  SITEMAP_MIN_POLICIES_FOR_PERSON,
  toLastmod,
} from "./sitemap.ts";

const pol = (id: string, politicianId: string, updatedAt?: string | null) => ({ id, politicianId, updatedAt });
const many = (politicianId: string, n: number, updatedAt = "2026-10-01T00:00:00Z") =>
  Array.from({ length: n }, (_, i) => pol(`${politicianId}-p${i}`, politicianId, updatedAt));

Deno.test("門檻是 6：5 筆不進、6 筆進（政見數＝名下未移除的全部政見，不分屆別）", () => {
  assertEquals(SITEMAP_MIN_POLICIES_FOR_PERSON, 6);
  assertEquals(isSitemapPerson(5), false);
  assertEquals(isSitemapPerson(6), true);
  assertEquals(isSitemapPerson(0), false);
  const meta = buildSitemapMeta({
    politicianIds: ["five", "six", "none"],
    policies: [...many("five", 5), ...many("six", 6)],
    lineages: [],
  });
  assertEquals(meta.skip.sort(), ["/politician/five", "/politician/none"]);
  assertEquals(Object.keys(meta.lastmod).filter((k) => k.startsWith("/politician/")), ["/politician/six"]);
});

Deno.test("政見數按人分開算，id 型別不同（數字／字串）也是同一個人", () => {
  const stats = policyStatsByPolitician([{ politicianId: 7 }, { politicianId: "7" }, { politicianId: "8" }]);
  assertEquals(stats.get("7")?.count, 2);
  assertEquals(stats.get("8")?.count, 1);
});

Deno.test("人物 lastmod＝名下政見 updated_at 最晚的；政見、脈絡用自己的", () => {
  const policies = [
    ...many("a", 5, "2026-09-01T00:00:00Z"),
    pol("newest", "a", "2026-10-05T08:00:02.123Z"),
    pol("other", "b", "2026-12-31T00:00:00Z"),
  ];
  const meta = buildSitemapMeta({
    politicianIds: ["a"],
    policies,
    lineages: [{ id: "L1", updatedAt: "2026-10-06T03:00:00+00:00" }, { id: "L2", updatedAt: null }],
    analysisPolicyIds: ["newest"],
  });
  assertEquals(meta.lastmod["/politician/a"], "2026-10-05T08:00:02Z");
  assertEquals(meta.lastmod["/policy/newest"], "2026-10-05T08:00:02Z");
  assertEquals(meta.lastmod["/analysis/newest"], "2026-10-05T08:00:02Z");
  assertEquals(meta.lastmod["/policy/other"], "2026-12-31T00:00:00Z");
  assertEquals(meta.lastmod["/lineage/L1"], "2026-10-06T03:00:00Z");
  // 沒有可靠時間的不寫，也不拿別的時間頂替
  assertEquals("/lineage/L2" in meta.lastmod, false);
});

Deno.test("時間缺或不合法 → 不寫 lastmod", () => {
  assertEquals(toLastmod(undefined), null);
  assertEquals(toLastmod(null), null);
  assertEquals(toLastmod(""), null);
  assertEquals(toLastmod("not a date"), null);
  assertEquals(toLastmod("2026-10-04 08:00:02.289+00"), "2026-10-04T08:00:02Z"); // PostgREST 的 timestamptz 寫法
  assertEquals(latestLastmod([null, "bad", undefined]), null);
  assertEquals(latestLastmod([null, "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"]), "2026-03-01T00:00:00Z");
  const meta = buildSitemapMeta({ politicianIds: ["a"], policies: many("a", 6, "garbage"), lineages: [] });
  assertEquals(meta.skip, []); // 政見夠多，進網站地圖
  assertEquals("/politician/a" in meta.lastmod, false); // 但時間不可靠，不寫
});

Deno.test("接線：server-data 用 buildSitemapMeta 寫 .sitemap-meta.json，postbuild 讀它並用 sitemap-xml.js，不再寫建置當天", async () => {
  const serverData = await Deno.readTextFile(new URL("./ssg/server-data.ts", import.meta.url));
  assertEquals(/buildSitemapMeta\(\{/.test(serverData), true);
  assertEquals(/writeSitemapMeta\(sitemapMeta\)/.test(serverData), true);
  const postbuild = await Deno.readTextFile(new URL("../scripts/postbuild-ssg.mjs", import.meta.url));
  assertEquals(/\.sitemap-meta\.json/.test(postbuild), true);
  assertEquals(/sitemapSkip\.has\(r\)/.test(postbuild), true);
  assertEquals(/sitemap-xml\.js/.test(postbuild), true);
  assertEquals(/taipeiDate|<lastmod>\$\{lastmod\}/.test(postbuild), false);
});
