import { assert, assertEquals } from "jsr:@std/assert@1";
import { cleanUrl, dueSources, FEED_FORMATS, parseFeed, parseFeedDate, tagText, toPlainText } from "./news-feed.ts";

// 假 XML 都是照 2026-09-29 實測的真實來源剪小的（每一段註明是哪一家的形狀）
const NOW = new Date("2026-09-29T02:00:00Z"); // 台灣時間 09-29 10:00

Deno.test("RSS：CDATA 標題、帶時區的 pubDate、description 去標籤（中央社／自由時報）", () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>中央社</title>
    <item><title><![CDATA[柯志恩被揪出手持「AI手板」]]></title>
      <description><![CDATA[<p>國民黨高雄市長參選人柯志恩&nbsp;近期…</p>]]></description>
      <link>https://news.ltn.com.tw/news/politics/breakingnews/5588961</link>
      <pubDate>Tue, 29 Sep 2026 07:24:43 +0800</pubDate></item>
  </channel></rss>`;
  const items = parseFeed(xml, "rss", { now: NOW });
  assertEquals(items.length, 1);
  assertEquals(items[0], {
    url: "https://news.ltn.com.tw/news/politics/breakingnews/5588961",
    title: "柯志恩被揪出手持「AI手板」",
    summary: "國民黨高雄市長參選人柯志恩 近期…",
    published_at: "2026-09-28T23:24:43.000Z",
  });
});

Deno.test("RSS：<link> 裡包換行＋CDATA、網址的 &amp; 要解開、小寫 pubdate 的民國日期（南投縣）", () => {
  const xml = `<rss><channel><item>
      <title>
        <![CDATA[日月潭文武廟祭孔大典隆重登場]]>
      </title>
      <link>
      <![CDATA[http://www.nantou.gov.tw/big5/news_content.php?dptid=376480000&cid=75&id=168749]]>
      </link>
      <pubdate>115-09-28</pubdate>
    </item><item>
      <title>臺南ROT案</title><link>https://www.tainan.gov.tw/News_Content.aspx?n=13370&amp;s=8838919</link>
      <pubDate>Mon, 28 Sep 2026 01:11:00 GMT</pubDate>
    </item></channel></rss>`;
  const items = parseFeed(xml, "rss", { now: NOW });
  assertEquals(items.map((i) => i.url), [
    "http://www.nantou.gov.tw/big5/news_content.php?dptid=376480000&cid=75&id=168749",
    "https://www.tainan.gov.tw/News_Content.aspx?n=13370&s=8838919",
  ]);
  assertEquals(items[0].title, "日月潭文武廟祭孔大典隆重登場");
  // 民國 115-09-28 ＝ 台灣時間 2026-09-28 00:00
  assertEquals(items[0].published_at, "2026-09-27T16:00:00.000Z");
});

Deno.test("日期：中文月份（彰化縣）、只有日期（新竹市）、沒帶時區的 ISO 都當台灣時間；讀不懂回 null", () => {
  assertEquals(parseFeedDate("週一, 28 九月 2026 00:00:00 +0800"), "2026-09-27T16:00:00.000Z");
  assertEquals(parseFeedDate("週三, 30 十二月 2026 13:05:00 GMT"), "2026-12-30T13:05:00.000Z");
  assertEquals(parseFeedDate("2026-09-28"), "2026-09-27T16:00:00.000Z");
  assertEquals(parseFeedDate("2026-09-28T10:00:00"), "2026-09-28T02:00:00.000Z");
  assertEquals(parseFeedDate("2026-09-23T04:44:00Z"), "2026-09-23T04:44:00.000Z");
  assertEquals(parseFeedDate("Mon, 28 Sep 2026 16:22:23 GMT"), "2026-09-28T16:22:23.000Z");
  assertEquals(parseFeedDate("下週一"), null);
  assertEquals(parseFeedDate(""), null);
  assertEquals(parseFeedDate(null), null);
});

Deno.test("RSS：被跳脫過一次的 HTML description 要解兩層（新竹縣）；自己關起來的 <description /> 不能吃到下一則（行政院）", () => {
  assertEquals(toPlainText("&lt;p style=\"x\"&gt;楊文科籲鄉親&lt;/p&gt;  &lt;p&gt;&amp;nbsp;&lt;/p&gt;"), "楊文科籲鄉親");
  const xml = `<rss><channel>
    <item><title><![CDATA[技能國手凱旋歸國]]></title><link>https://www.mol.gov.tw/1607/99204/</link><description /><pubDate>Mon, 28 Sep 2026 16:22:23 GMT</pubDate><dc:description> </dc:description></item>
    <item><title>第二則</title><link>https://www.ey.gov.tw/Page/2</link><description>第二則的摘要</description><pubDate>Mon, 28 Sep 2026 16:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = parseFeed(xml, "rss", { now: NOW });
  assertEquals(items.length, 2);
  assertEquals(items[0].summary, null, "空的 description 不能吃到第二則的摘要");
  assertEquals(items[1].summary, "第二則的摘要");
  // 同一段裡後面又出現同名標籤時，自己關起來的那個要回空字串，不能一路吃到後面那個的結尾
  assertEquals(tagText("<description />中間<description>別人的</description>", "description"), "");
});

Deno.test("RSS：<link> 缺就退回 guid（Yahoo 的 link 排在 guid 後面，缺的時候 guid 就是文章）", () => {
  const xml = `<rss><channel><item><title><![CDATA[尼加拉瓜斷交真相]]></title><pubDate>Mon, 28 Sep 2026 23:48:22 +0800</pubDate>
    <guid>https://tw.news.yahoo.com/abc-2348220.html</guid></item></channel></rss>`;
  assertEquals(parseFeed(xml, "rss", { now: NOW })[0].url, "https://tw.news.yahoo.com/abc-2348220.html");
});

Deno.test("Atom：<link rel=alternate href> 取文章網址，rel=self 不是（公視）", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><link href="https://news.pts.org.tw/xml/newsfeed.xml" rel="self"></link>
    <entry><title><![CDATA[機艙冒濃煙緊急降落]]></title>
      <link rel="self" href="https://news.pts.org.tw/xml/entry/829045" />
      <link rel="alternate" href="https://news.pts.org.tw/article/829045" />
      <summary type="html"><![CDATA[達美航空一架班機…]]></summary>
      <updated>2026-09-28T21:10:10+08:00</updated></entry></feed>`;
  const items = parseFeed(xml, "atom", { now: NOW });
  assertEquals(items, [{ url: "https://news.pts.org.tw/article/829045", title: "機艙冒濃煙緊急降落", summary: "達美航空一架班機…", published_at: "2026-09-28T13:10:10.000Z" }]);
});

Deno.test("Google 新聞 sitemap：loc＋news:title＋publication_date；path_filter 只留政治（TVBS）", () => {
  const xml = `<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
    <url><loc>https://news.tvbs.com.tw/entertainment/variety/4028831</loc><news:news>
      <news:publication><news:name>TVBS新聞網</news:name></news:publication>
      <news:publication_date>2026-09-29T07:58:32+08:00</news:publication_date><news:title>蔣友柏跨越家族魔咒</news:title></news:news></url>
    <url><loc>https://news.tvbs.com.tw/politics/4028604</loc><news:news>
      <news:publication><news:name>TVBS新聞網</news:name></news:publication>
      <news:publication_date>2026-09-28T22:01:00+08:00</news:publication_date><news:title>國旅卡該不該改？</news:title></news:news></url>
  </urlset>`;
  const items = parseFeed(xml, "sitemap_news", { now: NOW, pathFilter: "/politics/" });
  assertEquals(items, [{ url: "https://news.tvbs.com.tw/politics/4028604", title: "國旅卡該不該改？", summary: null, published_at: "2026-09-28T14:01:00.000Z" }]);
  // 標題是 news:title，不是 publication 裡的 news:name
  assertEquals(parseFeed(xml, "sitemap_news", { now: NOW }).map((i) => i.title), ["蔣友柏跨越家族魔咒", "國旅卡該不該改？"]);
});

Deno.test("只收近 3 天；沒日期的照收；同一份裡網址重複只留一則；缺網址或標題的不要", () => {
  const xml = `<rss><channel>
    <item><title>新的</title><link>https://a.tw/1</link><pubDate>Mon, 28 Sep 2026 10:00:00 +0800</pubDate></item>
    <item><title>舊的</title><link>https://a.tw/2</link><pubDate>Fri, 07 Aug 2026 09:23:00 GMT</pubDate></item>
    <item><title>沒日期</title><link>https://a.tw/3</link></item>
    <item><title>重複</title><link>https://a.tw/1</link><pubDate>Mon, 28 Sep 2026 10:00:00 +0800</pubDate></item>
    <item><title>沒網址</title><link>javascript:void(0)</link></item>
    <item><title></title><link>https://a.tw/5</link></item>
  </channel></rss>`;
  const items = parseFeed(xml, "rss", { now: NOW });
  assertEquals(items.map((i) => i.title), ["新的", "沒日期"]);
  assertEquals(items[1].published_at, null);
  assertEquals(parseFeed(xml, "rss", { now: NOW, maxItems: 1 }).length, 1);
});

Deno.test("tagText 不會把 <title2> 當 <title>、名稱不分大小寫；cleanUrl 只收 http(s)", () => {
  assertEquals(tagText("<title2>x</title2><TITLE>對</TITLE>", "title"), "對");
  assertEquals(tagText("<a>x</a>", "title"), null);
  assertEquals(cleanUrl(" <![CDATA[https://a.tw/?a=1&amp;b=2]]> "), "https://a.tw/?a=1&b=2");
  assertEquals(cleanUrl("ftp://a.tw/x"), null);
});

Deno.test("冷卻：30 分鐘內抓過的來源跳過；沒抓過、或關掉的另外處理", () => {
  const src = [
    { id: 1, enabled: true, last_fetched_at: null },
    { id: 2, enabled: true, last_fetched_at: "2026-09-29T01:40:00Z" }, // 20 分鐘前
    { id: 3, enabled: true, last_fetched_at: "2026-09-29T01:20:00Z" }, // 40 分鐘前
    { id: 4, enabled: false, last_fetched_at: null },
  ];
  assertEquals(dueSources(src, NOW).map((s) => s.id), [1, 3]);
});

Deno.test("格式清單跟 migration 的 CHECK 一致，種子資料的格式都在清單裡", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20260929000011_news_items.sql", import.meta.url));
  const check = /format\s+TEXT NOT NULL CHECK \(format IN \(([^)]*)\)\)/.exec(sql);
  assert(check, "找不到 news_sources.format 的 CHECK");
  assertEquals(check[1].split(",").map((s) => s.trim().replace(/'/g, "")).sort(), [...FEED_FORMATS].sort());
  const seeded = [...sql.matchAll(/'https?:\/\/[^']+',\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert(seeded.length >= 20, `種子資料只抓到 ${seeded.length} 列`);
  for (const f of seeded) assert((FEED_FORMATS as readonly string[]).includes(f), `種子資料用了不認得的格式 ${f}`);
});
