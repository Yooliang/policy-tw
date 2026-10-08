/// <reference lib="deno.ns" />
/**
 * 守 SEO 呈現（#461）：
 *   1. 分享圖：只有公開的 https 網址才當 og:image，簽名網址、內網、svg、非 https 一律退回站內預設圖；中文路徑編碼一次、不重複編碼
 *   2. 摘要用資料組句：人數、政見數、狀態都來自傳進來的數字，沒有固定套話；政見本文不重複標題
 *   3. 結構化資料：每個欄位都在 schema.org 詞彙表裡（lib/seo-schema-props.json），日期格式合法，缺資料的欄位不放
 *   4. 頁面真的接了這些函式（接線守門）
 */
import { assert, assertEquals, assertMatch, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  candidateListItems,
  defaultShareImage,
  isoDate,
  itemListLd,
  levelCountsText,
  MAX_HEAD_NAMES,
  MAX_LIST_ITEMS,
  personShareImage,
  personTrackingText,
  policyBodyForSummary,
  policyDescription,
  policyLd,
  publicImageUrl,
  regionDescription,
  shareImageMeta,
} from "./seo.ts";

const SITE = "https://xn--2lw665d.tw";

/* ───────────── 分享圖 ───────────── */

Deno.test("公開的 https 照片網址原樣可用（資料庫裡實際出現的幾種來源）", () => {
  for (const ok of [
    "https://ws.moi.gov.tw/001/Upload/localofficial/urllink/e1c7120e-f423-492f-9011-ebafa9e9e0d6.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Example.jpg/330px-Example.jpg",
    "https://taiwangogo.tw/assets/faces/head/lin-shih-han.webp",
    "https://newpowerparty.tw/wp-content/uploads/2026/05/%E5%8A%89%E4%BB%B2%E6%9B%B8_%E5%80%99%E9%81%B8%E4%BA%BA%E7%85%A7-300x300.jpg",
  ]) assertEquals(publicImageUrl(ok, SITE), ok, ok);
});

Deno.test("路徑裡的中文與空白編碼一次，已編碼的不重複編碼", () => {
  assertEquals(
    publicImageUrl("https://www.tncc.gov.tw/warehouse/C032D0E4/施余興望.jpg", SITE),
    "https://www.tncc.gov.tw/warehouse/C032D0E4/%E6%96%BD%E4%BD%99%E8%88%88%E6%9C%9B.jpg",
  );
  const once = publicImageUrl("https://example.tw/a b/照片.png", SITE)!;
  assertEquals(publicImageUrl(once, SITE), once, "再丟一次結果不變（冪等）");
  assert(!/[^\x20-\x7e]/.test(once) && !once.includes(" "));
});

Deno.test("//host 補成 https；/路徑 是站內的、補上站名網域；去掉 # 片段", () => {
  assertEquals(publicImageUrl("//img.ltn.com.tw/a.jpg", SITE), "https://img.ltn.com.tw/a.jpg");
  assertEquals(publicImageUrl("/images/x.png", SITE), `${SITE}/images/x.png`);
  assertEquals(publicImageUrl("https://example.tw/a.jpg#frag", SITE), "https://example.tw/a.jpg");
});

Deno.test("不是公開的圖片網址一律不收", () => {
  const bad: unknown[] = [
    undefined, null, "", "   ", 42, {},
    "http://example.tw/a.jpg", // 不是 https
    "data:image/png;base64,AAAA", "javascript:alert(1)", "blob:https://example.tw/uuid", "ftp://example.tw/a.jpg",
    "https://localhost/a.jpg", "https://app.localhost/a.jpg", "https://printer.local/a.jpg", "https://db.internal/a.jpg",
    "https://192.168.1.5/a.jpg", "https://127.0.0.1/a.jpg", "https://8.8.8.8/a.jpg", "https://[::1]/a.jpg",
    "https://intranet/a.jpg", // 單一標籤主機名
    "https://user:pass@example.tw/a.jpg",
    "https://xyz.supabase.co/storage/v1/object/sign/avatars/a.jpg", // Supabase 簽名網址（路徑就是證據，不靠查詢字串）
    "https://xyz.supabase.co/storage/v1/object/sign/avatars/a.jpg?token=abc",
    "https://example.tw/a.jpg?token=abc", "https://example.tw/a.jpg?X-Amz-Signature=abc", "https://example.tw/a.jpg?Expires=1",
    "https://example.tw/logo.svg", "https://example.tw/a.pdf", "https://example.tw/a.html",
    `https://example.tw/${"a".repeat(2100)}.jpg`,
  ];
  for (const b of bad) assertEquals(publicImageUrl(b, SITE), undefined, String(b).slice(0, 80));
});

Deno.test("人物分享圖：有公開照片用照片（summary 小卡），否則站內預設圖（summary_large_image，1200×630）", () => {
  const photo = personShareImage("https://ws.moi.gov.tw/a.jpg", "王小明", SITE);
  assertEquals(photo, { url: "https://ws.moi.gov.tw/a.jpg", alt: "王小明的照片", card: "summary" });
  for (const none of [undefined, null, "", "http://x.tw/a.jpg", "https://x.tw/a.svg"]) {
    const img = personShareImage(none, "王小明", SITE);
    assertEquals(img, defaultShareImage(SITE));
    assertEquals(img.url, `${SITE}/brand/og-cover.png`);
    assertEquals([img.card, img.width, img.height], ["summary_large_image", 1200, 630]);
  }
});

Deno.test("分享圖的 <meta>：og:image 與 twitter:card／image 成套；尺寸只在已知時給", () => {
  const meta = (m: ReturnType<typeof shareImageMeta>) => Object.fromEntries(m.map((t) => [t.property ?? t.name, t.content]));
  const def = meta(shareImageMeta(defaultShareImage(SITE)));
  assertEquals(def["og:image"], `${SITE}/brand/og-cover.png`);
  assertEquals(def["twitter:image"], def["og:image"]);
  assertEquals(def["twitter:card"], "summary_large_image");
  assertEquals([def["og:image:width"], def["og:image:height"]], ["1200", "630"]);
  assertMatch(def["og:image:alt"], /正見/);
  const person = meta(shareImageMeta(personShareImage("https://ws.moi.gov.tw/a.jpg", "王小明", SITE)));
  assertEquals(person["twitter:card"], "summary");
  assertEquals(person["og:image:width"], undefined, "不知道尺寸就不猜");
  assertEquals(person["og:image:alt"], "王小明的照片");
  // 每個標籤二選一：property（og）或 name（twitter），不會兩個都沒有
  for (const t of shareImageMeta(defaultShareImage(SITE))) assert(Boolean(t.property) !== Boolean(t.name));
});

/* ───────────── 摘要 ───────────── */

Deno.test("縣市頁摘要：一個職位", () => {
  assertEquals(
    regionDescription({ year: 2026, place: "台中市", levels: [{ label: "縣市議員", n: 120 }, { label: "縣市長", n: 0 }], policyCount: 35 }),
    "2026 台中市縣市議員候選人 120 位，已收錄政見 35 項。",
  );
});

Deno.test("縣市頁摘要：多個職位列人數，首長候選人列姓名（太多就不列），沒有政見就老實說", () => {
  const levels = [{ label: "縣市長", n: 3 }, { label: "縣市議員", n: 120 }, { label: "立法委員", n: 0 }];
  assertEquals(
    regionDescription({ year: "2026", place: "台中市", levels, policyCount: 35, heads: { label: "縣市長", names: ["甲", "乙", "丙"] } }),
    "2026 台中市候選人 123 位：縣市長 3 位、縣市議員 120 位，已收錄政見 35 項。縣市長候選人：甲、乙、丙。",
  );
  const many = Array.from({ length: MAX_HEAD_NAMES + 1 }, (_, i) => `人${i}`);
  assert(!regionDescription({ year: 2026, place: "台中市", levels, policyCount: 0, heads: { label: "縣市長", names: many } }).includes("候選人：人0"));
  assertStringIncludes(regionDescription({ year: 2026, place: "台中市", levels, policyCount: 0 }), "尚未收錄政見");
  assert(!regionDescription({ year: 2026, place: "台中市", levels, policyCount: 0 }).includes("0 項"));
});

Deno.test("鄉鎮頁摘要：帶附註；沒有候選人也不編造", () => {
  assertEquals(
    regionDescription({ year: 2022, place: "嘉義縣大林鎮", levels: [{ label: "鄉鎮市長", n: 2 }, { label: "村里長", n: 20 }], policyCount: 4 }),
    "2022 嘉義縣大林鎮候選人 22 位：鄉鎮市長 2 位、村里長 20 位，已收錄政見 4 項。",
  );
  assertEquals(
    regionDescription({ year: 2026, place: "台北市信義區", levels: [{ label: "村里長", n: 0 }], policyCount: 0, note: "區長由市政府指派，不是選舉產生。" }),
    "2026 台北市信義區：目前沒有候選人資料。區長由市政府指派，不是選舉產生。",
  );
  assertEquals(levelCountsText([{ label: "縣市長", n: 0 }]), "");
});

Deno.test("摘要沒有固定套話：不同縣市、不同數字，句子就不同", () => {
  const a = regionDescription({ year: 2026, place: "台中市", levels: [{ label: "縣市長", n: 3 }], policyCount: 5 });
  const b = regionDescription({ year: 2026, place: "高雄市", levels: [{ label: "縣市長", n: 4 }], policyCount: 9 });
  assertNotEquals(a, b);
  for (const s of [a, b]) assert(!/可依|逐項比較|篩選/.test(s), "舊版每頁都一樣的尾巴不能回來");
});

Deno.test("政見摘要：誰、哪一屆、類別、狀態與進度、本文", () => {
  assertEquals(
    policyDescription({ title: "增設托嬰中心", body: "每個行政區至少一處公共托嬰中心。", personName: "王小明", party: "無黨籍", electionLabel: "2026 九合一", category: "社會福利", isPledge: true, statusLabel: "競選承諾", progress: 0 }),
    "王小明（無黨籍）競選承諾「增設托嬰中心」，類別：社會福利，2026 九合一。每個行政區至少一處公共托嬰中心。",
  );
  const done = policyDescription({ title: "開闢公園", body: "", personName: "李大華", category: "環境", isPledge: false, statusLabel: "進行中", progress: 40 });
  assertEquals(done, "李大華政見「開闢公園」，類別：環境，進行中，進度 40%。");
});

Deno.test("非競選承諾進度是 0 也不寫「進度 0%」", () => {
  assertEquals(policyDescription({ title: "T", isPledge: false, statusLabel: "提出", progress: 0, personName: "甲" }), "甲政見「T」，提出。");
});

Deno.test("人物頁摘要結尾：兩種都是 0 就不寫，不再是一萬多頁同一句", () => {
  assertEquals(personTrackingText(0, 0), "");
  assertEquals(personTrackingText(3, 0), "正見已收錄其競選承諾 3 項。");
  assertEquals(personTrackingText(0, 2), "正見已收錄其過往政績 2 項。");
  assertEquals(personTrackingText(3, 2), "正見已收錄其競選承諾 3 項、過往政績 2 項。");
});

Deno.test("競選承諾不寫「進度 0%」，缺的資料整段省略、不留空括號", () => {
  const s = policyDescription({ title: "T", isPledge: true, statusLabel: "競選承諾", progress: 0 });
  assertEquals(s, "競選承諾「T」。");
  assert(!s.includes("進度") && !s.includes("（）") && !s.includes("類別"));
});

Deno.test("政見本文重複標題的開頭不重複寫", () => {
  assertEquals(policyBodyForSummary("增設托嬰中心", "增設托嬰中心"), "", "本文就是標題");
  assertEquals(policyBodyForSummary("增設托嬰中心", "  增設托嬰中心。 "), "", "只差標點空白");
  assertEquals(policyBodyForSummary("增設托嬰中心", "增設托嬰中心：每區一處，三年內完成。"), "每區一處，三年內完成。");
  assertEquals(policyBodyForSummary("增設托嬰中心", "每區一處。\n\n三年內完成。"), "每區一處。 三年內完成。");
  assertEquals(policyBodyForSummary("T", undefined), "");
});

/* ───────────── 日期 ───────────── */

Deno.test("isoDate：只放合法的 ISO 8601，空白分隔的 timestamptz 換成 T，純日期不被當成時區", () => {
  assertEquals(isoDate("2026-10-08"), "2026-10-08");
  assertEquals(isoDate("2026-10-08T12:34:56.123456+00:00"), "2026-10-08T12:34:56.123456+00:00");
  assertEquals(isoDate("2026-10-08 12:34:56.123456+00"), "2026-10-08T12:34:56.123456+00:00");
  assertEquals(isoDate("2026-10-08T12:34:56Z"), "2026-10-08T12:34:56Z");
  for (const bad of [undefined, null, "", "2026", "2026/10/08", "10-08-2026", "2026-13-40", "昨天", "2026-10-08T25:00", 20261008]) assertEquals(isoDate(bad), undefined, String(bad));
});

/* ───────────── 候選人清單（ItemList） ───────────── */

const cands = [
  { id: "c", name: "丙", rank: 1, candNo: 2 },
  { id: "a", name: "甲", rank: 0, candNo: undefined },
  { id: "b", name: "乙", rank: 1, candNo: 1 },
  { id: "d", name: "丁", rank: 1, candNo: undefined },
  { id: "e", name: "戊", rank: 0, candNo: 3 },
];

Deno.test("候選人清單：職位在前、同職位號次在前（沒有號次的排後）、再依姓名；輸入順序不影響結果", () => {
  const expected = ["戊", "甲", "乙", "丙", "丁"];
  assertEquals(candidateListItems(cands, { siteUrl: SITE }).map((i) => i.name), expected);
  assertEquals(candidateListItems([...cands].reverse(), { siteUrl: SITE }).map((i) => i.name), expected);
  assertEquals(candidateListItems(cands, { siteUrl: SITE })[0].url, `${SITE}/politician/e`);
});

Deno.test("候選人清單最多 100 位，完整人數用 numberOfItems 講", () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `id${String(i).padStart(3, "0")}`, name: `人${i}`, rank: 1, candNo: i + 1 }));
  const items = candidateListItems(many, { siteUrl: SITE });
  assertEquals(items.length, MAX_LIST_ITEMS);
  const ld = itemListLd({ name: "n", url: `${SITE}/election/2026/台中市`, items, total: many.length }) as any;
  assertEquals(ld["@type"], "ItemList");
  assertEquals(ld.numberOfItems, 250);
  assertEquals(ld.itemListElement.length, 100);
  assertEquals(ld.itemListElement[0], { "@type": "ListItem", position: 1, name: "人0", url: `${SITE}/politician/id000` });
  assertEquals(ld.itemListElement[99].position, 100);
});

/* ───────────── 政見的 schema.org ───────────── */

const person = { id: "11111111-1111-1111-1111-111111111111", name: "王小明", party: "無黨籍" };
const basePolicy = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "增設托嬰中心",
  description: "每個行政區至少一處公共托嬰中心。",
  category: "社會福利",
  isPledge: true,
  statusLabel: "競選承諾",
  proposedDate: "2026-03-05",
  updatedAt: "2026-10-08 06:00:00.5+00",
  lastUpdated: "2026-10-07",
  sourceUrl: "https://example.tw/src",
  electionYear: "2026",
  person,
};

Deno.test("政見 JSON-LD：CreativeWork，提出者放 author 與 about，日期用提出日與更新時間", () => {
  const ld = policyLd(basePolicy, SITE) as any;
  assertEquals(ld["@type"], "CreativeWork");
  assertEquals(ld.url, `${SITE}/policy/${basePolicy.id}`);
  assertEquals(ld.author, { "@type": "Person", name: "王小明", url: `${SITE}/politician/${person.id}`, affiliation: { "@type": "Organization", name: "無黨籍" } });
  assertEquals(ld.about, ld.author);
  assertEquals(ld.datePublished, "2026-03-05");
  assertEquals(ld.dateModified, "2026-10-08T06:00:00.5+00:00", "用 updatedAt，不是只有日期的 lastUpdated");
  assertEquals(ld.temporalCoverage, "2026");
  assertEquals(ld.citation, "https://example.tw/src");
});

Deno.test("政見 JSON-LD：沒有提出日就不放 datePublished；更新時間缺或壞了退回 lastUpdated；都沒有就不放", () => {
  const noDate = policyLd({ ...basePolicy, proposedDate: null }, SITE) as any;
  assert(!("datePublished" in noDate));
  assertEquals((policyLd({ ...basePolicy, updatedAt: "壞掉" }, SITE) as any).dateModified, "2026-10-07");
  const none = policyLd({ ...basePolicy, updatedAt: null, lastUpdated: undefined, proposedDate: "亂寫" }, SITE) as any;
  assert(!("dateModified" in none) && !("datePublished" in none));
  const bare = policyLd({ id: "x", title: "T", isPledge: false, person: { id: "p", name: "甲" } }, SITE) as any;
  for (const k of ["description", "genre", "creativeWorkStatus", "citation", "isBasedOn", "temporalCoverage"]) assert(!(k in bare), k);
  assertEquals(bare.additionalType, "政見");
  assertEquals(bare.author.affiliation, undefined);
});

/* ───────────── schema.org 詞彙表（不放不存在的欄位） ───────────── */

const vocab: { types: Record<string, string[]> } = JSON.parse(await Deno.readTextFile(new URL("./seo-schema-props.json", import.meta.url)));

/** 走過整棵 JSON-LD：每個有 @type 的節點，欄位都要在詞彙表裡；回傳走過的型別 */
function checkVocabulary(node: unknown, path = "$", seen = new Set<string>()): Set<string> {
  if (Array.isArray(node)) { node.forEach((n, i) => checkVocabulary(n, `${path}[${i}]`, seen)); return seen; }
  if (!node || typeof node !== "object") return seen;
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  if (typeof type === "string") {
    const allowed = vocab.types[type];
    assert(allowed, `${path}: 詞彙表裡沒收 ${type}（新型別要重新產生 seo-schema-props.json）`);
    seen.add(type);
    for (const key of Object.keys(obj)) {
      if (key.startsWith("@")) continue;
      assert(allowed.includes(key), `${path}: ${type} 沒有 ${key} 這個屬性（schema.org）`);
    }
  }
  for (const [k, v] of Object.entries(obj)) checkVocabulary(v, `${path}.${k}`, seen);
  return seen;
}

Deno.test("縣市頁 ItemList 與政見 CreativeWork 的每個欄位都在 schema.org 詞彙表裡", () => {
  const list = itemListLd({ name: "2026 台中市 候選人", url: `${SITE}/election/2026/%E5%8F%B0%E4%B8%AD%E5%B8%82`, items: candidateListItems(cands, { siteUrl: SITE }), total: 5 });
  assertEquals([...checkVocabulary(list)].sort(), ["ItemList", "ListItem"]);
  const policy = policyLd(basePolicy, SITE);
  assertEquals([...checkVocabulary(policy)].sort(), ["CreativeWork", "Organization", "Person"]);
});

Deno.test("詞彙表檢查本身有效：亂寫的欄位會被抓到（還原驗證）", () => {
  let caught = false;
  try { checkVocabulary({ "@type": "CreativeWork", dateModifed: "2026-10-08" }); } catch { caught = true; }
  assert(caught);
  caught = false;
  try { checkVocabulary({ "@type": "ItemList", itemListElement: [{ "@type": "ListItem", position: 1, candidateName: "甲" }] }); } catch { caught = true; }
  assert(caught);
});

/* ───────────── 接線守門 ───────────── */

async function source(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../${rel}`, import.meta.url));
}

Deno.test("接線：usePageHead 一律輸出分享圖；人物頁、政見頁給照片；縣市頁用資料組句＋ItemList", async () => {
  const head = await source("composables/usePageHead.ts");
  assertStringIncludes(head, "...shareImageMeta(toValue(options.image) ?? defaultShareImage())");
  const profile = await source("pages/PoliticianProfile.vue");
  assertStringIncludes(profile, "personShareImage(politician.value.avatarUrl");
  assertStringIncludes(profile, "publicImageUrl(politician.value.avatarUrl)");
  assertStringIncludes(profile, "personTrackingText(campaignPledges.value.length, historicalPolicies.value.length)");
  const policy = await source("pages/PolicyDetail.vue");
  assertStringIncludes(policy, "personShareImage(politician.value.avatarUrl");
  assertStringIncludes(policy, "policyLd({");
  assertStringIncludes(policy, "policyDescription({");
  const election = await source("pages/ElectionPage.vue");
  assertStringIncludes(election, "regionDescription({");
  assertStringIncludes(election, "itemListLd({");
});
