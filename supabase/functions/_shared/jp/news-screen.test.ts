/**
 * 新聞線の便宜篩（_shared/jp/news-screen.ts）と取り込み本体（news-run.ts、偽の store／偽の fetch）の單元測試。純函式、網路なし。
 *   a. 篩い：首長の辞職／死去、議会解散、リコール → 線索；勧告・要求・前市長・親族・議長・同名団体・行政区・別名の一部 → 線索にしない
 *   b. 取り込み：来源の取得 → 記事の保存 → 篩い → 線索の記録、失敗の隔離、冷却、無効化、上限（capped）
 *   c. 還原驗證：禁止語の除外を外すと a の該当ケースが赤くなる
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildLgIndex, jstDate, type LgEntry, screenItem } from "./news-screen.ts";
import { type LeadEvidence, type LeadResult, type NewsStore, runNews, type SourceRow, type StoredItem } from "./news-run.ts";
import type { FeedItem } from "../news-feed.ts";

const LGS: LgEntry[] = [
  { lg_code: "230006", name: "愛知県", kind: "prefecture", pref_name: "愛知県" },
  { lg_code: "232033", name: "一宮市", kind: "city", pref_name: "愛知県" },
  { lg_code: "231002", name: "名古屋市", kind: "designated_city", pref_name: "愛知県" },
  { lg_code: "131016", name: "千代田区", kind: "special_ward", pref_name: "東京都" },
  { lg_code: "131130", name: "北区", kind: "special_ward", pref_name: "東京都" },
  { lg_code: "261041", name: "北区", kind: "admin_ward", pref_name: "京都府" }, // 行政区：索引に入れない
  { lg_code: "262013", name: "京都市", kind: "designated_city", pref_name: "京都府" },
  { lg_code: "011002", name: "札幌市", kind: "designated_city", pref_name: "北海道" },
  { lg_code: "013641", name: "中央町", kind: "town", pref_name: "北海道" },
  { lg_code: "093009", name: "中央町", kind: "town", pref_name: "栃木県" }, // 同名（北海道／栃木）
  { lg_code: "010006", name: "北海道", kind: "prefecture", pref_name: "北海道" },
];
const idx = buildLgIndex(LGS);
const leads = (title: string, summary: string | null = null) => screenItem({ title, summary }, idx).leads.map((l) => `${l.lg_code}:${l.office_kind}:${l.signal}`);
const result = (title: string, summary: string | null = null) => screenItem({ title, summary }, idx).result;

Deno.test("篩い：首長の辞職・死去 → head の線索", () => {
  assertEquals(leads("一宮市長が辞職の意向 任期途中で"), ["232033:head:resignation"]);
  assertEquals(leads("愛知県知事が辞職願を提出"), ["230006:head:resignation"]);
  assertEquals(leads("名古屋市長が急逝 69歳"), ["231002:head:death"]);
  assertEquals(leads("千代田区長が死去"), ["131016:head:death"]);
  assertEquals(leads("辞職を表明した一宮市長、後任選びへ"), ["232033:head:resignation"], "語が団体の前にあってもよい（15 字以内）");
  assertEquals(leads("北海道知事が失職"), ["010006:head:resignation"]);
  // 見出しに無くて要約にある
  assertEquals(leads("一宮市で会見", "一宮市長は記者会見で、辞職する意向を明らかにした。"), ["232033:head:resignation"]);
});

Deno.test("篩い：議会解散・リコール", () => {
  assertEquals(leads("一宮市議会が解散 市議選へ"), ["232033:assembly:dissolution"]);
  assertEquals(leads("名古屋市長、市議会を解散"), ["231002:assembly:dissolution"], "首長が議会を解散する文も議会の選挙");
  assertEquals(leads("名古屋市でリコール署名開始"), [], "リコールは団体＋職が隣り合っていないと拾わない");
  assertEquals(leads("名古屋市長のリコール、住民投票へ"), ["231002:head:recall"]);
  assertEquals(leads("一宮市議会の解散請求 署名が集まる"), ["232033:assembly:recall"], "解散請求は recall");
  assertEquals(leads("名古屋市長への解職請求が成立"), ["231002:head:recall"]);
  assertEquals(leads("衆院解散へ"), [], "国政の解散は団体がない");
});

Deno.test("篩い：線索にしないもの（勧告・要求・前職・親族・議長・別の名前の一部・行政区）", () => {
  assertEquals(leads("一宮市長に辞職勧告決議案"), []);
  assertEquals(leads("市議団が一宮市長の辞職を求める"), []);
  assertEquals(leads("一宮市長は辞職しない考えを示した"), []);
  assertEquals(leads("前一宮市長が死去"), [], "前職");
  assertEquals(leads("元名古屋市長が死去 80歳"), [], "元職");
  assertEquals(leads("一宮市長の父が死去"), [], "親族");
  assertEquals(leads("一宮市議会議長が辞職"), [], "議長の辞職は首長選挙を要しない");
  assertEquals(leads("一宮市議が辞職"), []);
  assertEquals(leads("京都市長が辞職"), ["262013:head:resignation"]);
  // 「京都市北区長」は東京の北区にも行政区にも当たらない（左に漢字が続く）
  assertEquals(leads("京都市北区長が死去"), []);
  assertEquals(leads("東京都北区長が死去"), ["131130:head:death"], "直前が所属の都道府県名ならよい");
  assertEquals(leads("一宮市の市長選に3人が立候補"), [], "選挙の記事そのものは辞職の語がなければ拾わない");
  assertEquals(leads("一宮市長が会見で新年度予算を説明"), []);
  assertEquals(leads("一宮市長がマラソン大会で解散式に出席"), []);
});

Deno.test("篩い：同名の団体は記事の都道府県名で絞る、絞れなければ捨てる（ambiguous）", () => {
  assertEquals(leads("北海道の中央町長が辞職"), ["013641:head:resignation"]);
  assertEquals(leads("栃木県中央町長が死去"), ["093009:head:death"]);
  assertEquals(result("中央町長が辞職"), "ambiguous");
  assertEquals(leads("中央町長が辞職"), []);
});

Deno.test("篩い：結果の区分と最大 2 件", () => {
  assertEquals(result("きょうの天気"), "no_entity");
  assertEquals(result("一宮市長が新年度予算を発表"), "no_signal");
  assertEquals(result("一宮市長が辞職の意向"), "lead");
  const r = screenItem({ title: "一宮市長が辞職の意向、市議会は解散へ", summary: "名古屋市長も死去" }, idx);
  assert(r.leads.length <= 2);
});

Deno.test("jstDate：UTC 15 時台は日本では翌日", () => {
  assertEquals(jstDate("2026-10-12T15:30:00Z", new Date("2000-01-01T00:00:00Z")), "2026-10-13");
  assertEquals(jstDate(null, new Date("2026-10-13T00:00:00Z")), "2026-10-13");
});

// =============================================================================================
// b. 取り込み本体（偽の store／fetch）
// =============================================================================================
const NOW = new Date("2026-10-13T03:23:00Z");
const rss = (items: Array<{ title: string; url: string; date?: string; desc?: string }>) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items.map((i) =>
    `<item><title>${i.title}</title><link>${i.url}</link><description>${i.desc ?? ""}</description><pubDate>${i.date ?? "Tue, 13 Oct 2026 10:00:00 +0900"}</pubDate></item>`).join("")}</channel></rss>`;

function fakeStore(o: { sources?: SourceRow[]; enabled?: boolean; cap?: number } = {}) {
  const sources = o.sources ?? [{ id: 1, label: "NHK 政治", feed_url: "https://example.test/a.xml", format: "rss" as const, enabled: true, last_fetched_at: null }];
  const items: StoredItem[] = [];
  const screened = new Map<number, Record<string, unknown>>();
  const recorded: Array<{ lg: string; kind: string; signal: string; ev: LeadEvidence[]; seenOn: string }> = [];
  const errors = new Map<number, string | null>();
  let newLeads = 0;
  const store: NewsStore = {
    settings: () => Promise.resolve({ enabled: o.enabled ?? true, max_age_days: 3 }),
    listSources: () => Promise.resolve(sources),
    claimSource: (id, cutoff) => {
      const s = sources.find((x) => x.id === id)!;
      if (s.last_fetched_at && s.last_fetched_at > cutoff) return Promise.resolve(false);
      s.last_fetched_at = NOW.toISOString();
      return Promise.resolve(true);
    },
    setSourceError: (id, e) => { errors.set(id, e); return Promise.resolve(); },
    insertItems: (sourceId, list: readonly FeedItem[]) => {
      const out: StoredItem[] = [];
      for (const it of list) {
        if (items.some((x) => x.url === it.url)) continue;
        const row = { id: items.length + 1, source_id: sourceId, url: it.url, title: it.title, summary: it.summary, published_at: it.published_at };
        items.push(row); out.push(row);
      }
      return Promise.resolve(out);
    },
    listLgs: () => Promise.resolve(LGS),
    listUnscreened: (limit) => Promise.resolve(items.filter((x) => !screened.has(x.id)).slice(0, limit)),
    markScreened: (id, screen) => { screened.set(id, screen); return Promise.resolve(); },
    recordLead: (lead, ev, seenOn): Promise<LeadResult> => {
      recorded.push({ lg: lead.lg_code, kind: lead.office_kind, signal: lead.signal, ev, seenOn });
      if (o.cap !== undefined && newLeads >= o.cap) return Promise.resolve({ action: "capped" });
      newLeads++;
      return Promise.resolve({ action: "created", lead_id: newLeads });
    },
  };
  return { store, items, screened, recorded, errors, sources };
}
const deps = (xml: string | Error) => ({ now: () => NOW, fetchText: (_u: string) => xml instanceof Error ? Promise.reject(xml) : Promise.resolve(xml) });

Deno.test("取り込み：記事を保存 → 篩い → 線索（証拠に出典名・URL・見出し・日本時間の日付）", async () => {
  const f = fakeStore();
  const rep = await runNews(f.store, deps(rss([
    { title: "一宮市長が辞職の意向", url: "https://example.test/1", date: "Mon, 12 Oct 2026 23:30:00 +0900" },
    { title: "きょうの天気", url: "https://example.test/2" },
    { title: "一宮市長が予算を説明", url: "https://example.test/3" },
  ])));
  assertEquals(rep.sources, [{ id: 1, label: "NHK 政治", parsed: 3, inserted: 3 }]);
  assertEquals(rep.screened, 3);
  assertEquals(rep.tally, { lead: 1, no_entity: 1, no_signal: 1 });
  assertEquals(f.recorded.length, 1);
  assertEquals(f.recorded[0].seenOn, "2026-10-12", "23:30 JST は 12 日");
  assertEquals(f.recorded[0].ev[0], { news_item_id: 1, url: "https://example.test/1", title: "一宮市長が辞職の意向", source: "NHK 政治", published_at: "2026-10-12T14:30:00.000Z", signal: "resignation" });
  assertEquals(f.errors.get(1), null);
  // 2 回目：冷却中で飽和、記事は増えない
  const rep2 = await runNews(f.store, deps(rss([])));
  assertEquals(rep2.sources, []);
  assertEquals(rep2.screened, 0);
});

Deno.test("取り込み：来源の失敗は隔離（last_error に残り、他の来源は続く）、1 つも記事が無い応答はエラー", async () => {
  const f = fakeStore({ sources: [
    { id: 1, label: "A", feed_url: "https://a.test/x", format: "rss", enabled: true, last_fetched_at: null },
    { id: 2, label: "B", feed_url: "https://b.test/x", format: "rss", enabled: true, last_fetched_at: null },
  ] });
  const rep = await runNews(f.store, {
    now: () => NOW,
    fetchText: (u) => u.startsWith("https://a.test") ? Promise.reject(new Error("HTTP 503")) : Promise.resolve(rss([{ title: "一宮市長が死去", url: "https://b.test/1" }])),
  });
  assertEquals(rep.sources.find((s) => s.id === 1)?.error, "HTTP 503");
  assertEquals(f.errors.get(1), "HTTP 503");
  assertEquals(rep.sources.find((s) => s.id === 2)?.inserted, 1);
  assertEquals(rep.tally, { lead: 1 });
  const g = fakeStore();
  const rep3 = await runNews(g.store, deps("<html>moved</html>"));
  assert(rep3.sources[0].error?.includes("記事が 1 つもない"));
});

Deno.test("取り込み：無効（news_settings.enabled=false）は何もしない、上限で capped、同じ記事は 2 度篩わない", async () => {
  const off = fakeStore({ enabled: false });
  assertEquals((await runNews(off.store, deps(rss([{ title: "一宮市長が死去", url: "https://x.test/1" }])))).disabled, true);
  assertEquals(off.items.length, 0);

  const f = fakeStore({ cap: 0 });
  const rep = await runNews(f.store, deps(rss([{ title: "一宮市長が死去", url: "https://x.test/1" }])));
  assertEquals(rep.tally, { capped: 1 });
  assertEquals(f.screened.get(1)?.result, "capped");
  f.sources[0].last_fetched_at = null;
  const again = await runNews(f.store, deps(rss([{ title: "一宮市長が死去", url: "https://x.test/1" }])));
  assertEquals(again.screened, 0, "URL が同じ記事は入らない＝篩い直さない");
});

Deno.test("取り込み：線索の記録が失敗した記事は screened にしない（次の回に再試行）", async () => {
  const f = fakeStore();
  f.store.recordLead = () => Promise.reject(new Error("rpc down"));
  const rep = await runNews(f.store, deps(rss([{ title: "一宮市長が死去", url: "https://x.test/1" }])));
  assertEquals(rep.screened, 0);
  assertEquals(rep.failures.length, 1);
  assertEquals(f.screened.size, 0);
});

// =============================================================================================
// c. 還原驗證：除外語を外した版では「辞職勧告」「親族」が線索になってしまう（＝上のテストが守っている）
// =============================================================================================
Deno.test("還原驗證：news-screen.ts の除外（NEGATIVE_AFTER／FAMILY_BETWEEN）を空にすると a の該当ケースが赤くなる", async () => {
  const src = await Deno.readTextFile(new URL("./news-screen.ts", import.meta.url));
  assert(src.includes("const NEGATIVE_AFTER = /^.{0,10}?(勧告"));
  const broken = src.replace(/const NEGATIVE_AFTER = .*\n/, "const NEGATIVE_AFTER = /^(?!)/;\n").replace(/const FAMILY_BETWEEN = .*\n/, "const FAMILY_BETWEEN = /^(?!)/;\n");
  assert(broken !== src);
  const m = await import(`data:text/typescript;base64,${btoa(unescape(encodeURIComponent(broken)))}`);
  const i2 = m.buildLgIndex(LGS);
  const l = (t: string) => m.screenItem({ title: t }, i2).leads.length;
  assertEquals(l("一宮市長に辞職勧告決議案"), 1, "除外を外すと勧告が線索になる");
  assertEquals(l("一宮市長の父が死去"), 1, "除外を外すと親族の死去が線索になる");
});
