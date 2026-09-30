import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildNameIndex, buildNewsAsk, findNames, MAX_PEOPLE_PER_ITEM, MAX_POLICIES_PER_PERSON, newsTaskOf, pickPeople, type ScreenPerson, verdictOf } from "./news-screen.ts";
import { MIN_PROBABILITY, SUBJECT_TYPES } from "./system-one.ts";
import { NEWS_MIN_PROBABILITY } from "./news-screen.ts";
import { isNewsItemTask, shapeTaskCurrent } from "./task-context.ts";
import { describeManualTask, validateTaskInput } from "./task-admin.ts";
import { shouldCloseOnApplied } from "./task-fulfilment.ts";

// 名字與新聞都是 2026-09-29 本機試篩（22 個來源 753 則 × 1,891 人）時真的出現過的形狀
const P = (id: string, name: string, region: string | null = null): ScreenPerson => ({ id: `${id}-0000-4000-8000-000000000000`, name, region });
const people = [
  P("11111111", "蔣萬安", "台北市"),
  P("22222222", "沈伯洋", "台北市"),
  P("33333333", "張峻", "花蓮縣"),
  P("44444444", "李文", "新北市"),
  P("55555555", "林彥", "台中市"),
  P("66666666", "陳其邁", "高雄市"),
  P("77777777", "陳其", "屏東縣"),
  P("88888888", "卡伊．馬賴", "台東縣"),
  P("99999999", "黃偉哲", "台南市"),
  P("aaaaaaaa", "黃偉哲", "台北市"), // 同名不同人
  P("bbbbbbbb", "王"),               // 一個字：不收
];
const index = buildNameIndex(people);
const names = (text: string) => findNames(text, index).map((h) => h.name);

Deno.test("三字名直接命中，依出現順序；一個字的名字不收", () => {
  assertEquals(names("揭台北選情3關鍵 黃暐瀚：沈伯洋方略、蔣萬安連任條件"), ["沈伯洋", "蔣萬安"]);
  assertEquals(index.has("王"), false);
  assertEquals(names("王說今天天氣很好"), []);
});

Deno.test("兩字名：後面接別的中文字多半是別人的三字名，不算；接標點、空白或「提、表、的…」才算", () => {
  assertEquals(names("支持花蓮教師團體十大訴求 張峻提教育平權白皮書"), ["張峻"]);
  assertEquals(names("議員張峻、魏嘉賢出席"), ["張峻"]);
  // 試篩時被擋掉的都是別人
  assertEquals(names("市議員李文傑、澎科大李文熙校長出席"), []);
  assertEquals(names("生成」；林彥廷、林彥均拿銀牌"), []);
  // 空白要當邊界：normalizeName 會把空白刪掉，「訴求 張峻」黏成「訴求張峻」就看不到邊界了
  assertEquals(names("訴求 張峻 提白皮書"), ["張峻"]);
});

Deno.test("被長名字完全蓋住的短名字不算（陳其 在 陳其邁 裡）；各自出現就都算", () => {
  assertEquals(names("陳其邁宣布輕軌延伸"), ["陳其邁"]);
  assertEquals(names("陳其邁與陳其、會面"), ["陳其邁", "陳其"]);
});

Deno.test("間隔號與臺／台照 nameHit 的規則正規化", () => {
  assertEquals(names("卡伊‧馬賴宣布參選"), ["卡伊馬賴"]);
  assertEquals(names("卡伊·馬賴宣布參選"), ["卡伊馬賴"]);
});

Deno.test("同名的人：來源是縣市政府就用那個縣市；否則看新聞寫到哪個縣市；收斂不了就全留", () => {
  const hits = findNames("黃偉哲宣布台南市將推動綠能", index);
  assertEquals(pickPeople(hits, "黃偉哲宣布台南市將推動綠能", null).map((p) => p.region), ["台南市"]);
  assertEquals(pickPeople(hits, "黃偉哲表示", "臺北市").map((p) => p.region), ["台北市"], "臺北市政府的新聞稿，臺／台要算同一個");
  assertEquals(pickPeople(hits, "黃偉哲表示", null).length, 2);
});

Deno.test("一則最多帶三位去問 Jev，同一個人不重複", () => {
  const many = buildNameIndex([P("1", "甲甲甲"), P("2", "乙乙乙"), P("3", "丙丙丙"), P("4", "丁丁丁")]);
  const text = "甲甲甲、乙乙乙、丙丙丙、丁丁丁、甲甲甲";
  const picked = pickPeople(findNames(text, many), text, null);
  assertEquals(picked.length, MAX_PEOPLE_PER_ITEM);
  assertEquals(picked.map((p) => p.name), ["甲甲甲", "乙乙乙", "丙丙丙"]);
});

const item = { title: "蔣萬安：社子島開發明年動工", summary: "台北市長蔣萬安今天宣布…", source: "中央社 政治", url: "https://www.cna.com.tw/news/aipl/1.aspx" };
const policies = [
  { id: "a1aaaaaa-0000-4000-8000-000000000001", title: "社子島開發" },
  { id: "b2bbbbbb-0000-4000-8000-000000000002", title: "捷運環狀線北環段" },
];

Deno.test("題目：每條政見一個「進度」選項、每個人一個「新承諾」選項，外加 unrelated；事實放 state、選項放 criteria", () => {
  const { state, questions, keys } = buildNewsAsk(item, [{ person: people[0], policies }]);
  const q = questions.news_relevance;
  assertEquals(Object.keys(q.criteria).sort(), ["n:11111111", "p:a1aaaaaa", "p:b2bbbbbb", "unrelated"]);
  assertEquals(keys["p:a1aaaaaa"], { kind: "progress", policy_id: policies[0].id, politician_id: people[0].id });
  assertEquals(keys["n:11111111"], { kind: "new_pledge", politician_id: people[0].id });
  assertEquals((state.news as Record<string, unknown>).title, item.title);
  assert(String(q.instructions).includes("拿不準就選 unrelated"), "拿不準要往無關那邊倒：派錯一件任務比漏一則貴");
});

Deno.test("題目：每人最多 30 條政見；前 8 碼撞到的那條不給（不能讓兩條政見共用一個選項）", () => {
  const lots = Array.from({ length: MAX_POLICIES_PER_PERSON + 5 }, (_, i) => ({ id: `${String(i).padStart(8, "0")}-x`, title: `政見${i}` }));
  const { keys } = buildNewsAsk(item, [{ person: people[0], policies: lots }]);
  assertEquals(Object.keys(keys).filter((k) => k.startsWith("p:")).length, MAX_POLICIES_PER_PERSON);
  const clash = buildNewsAsk(item, [{ person: people[0], policies: [{ id: "samepref-1", title: "甲" }, { id: "samepref-2", title: "乙" }] }]);
  assertEquals(clash.keys["p:samepref"], { kind: "progress", policy_id: "samepref-1", politician_id: people[0].id });
});

Deno.test("答案→判定：過門檻才算有關；不到門檻記 low_confidence（照記機率、不派工）；unrelated 與不認得的選項都算無關", () => {
  const { keys } = buildNewsAsk(item, [{ person: people[0], policies }]);
  assertEquals(verdictOf({ choice: "p:a1aaaaaa", probabilities: { "p:a1aaaaaa": 0.97 } }, keys, MIN_PROBABILITY),
    { result: "progress", choice: "p:a1aaaaaa", probability: 0.97, politician_id: people[0].id, policy_id: policies[0].id });
  assertEquals(verdictOf({ choice: "n:11111111", probabilities: { "n:11111111": 0.96 } }, keys, MIN_PROBABILITY).result, "new_pledge");
  const low = verdictOf({ choice: "p:a1aaaaaa", probabilities: { "p:a1aaaaaa": 0.6 } }, keys, MIN_PROBABILITY);
  assertEquals([low.result, low.probability], ["low_confidence", 0.6]);
  assertEquals(verdictOf({ choice: "unrelated", probabilities: { unrelated: 0.99 } }, keys, MIN_PROBABILITY).result, "unrelated");
  assertEquals(verdictOf({ choice: "p:zzzzzzzz", probabilities: { "p:zzzzzzzz": 0.99 } }, keys, MIN_PROBABILITY).result, "unrelated");
  assertEquals(verdictOf(undefined, keys, MIN_PROBABILITY).result, "unrelated");
});

Deno.test("判定→任務：沿用 news_sweep（不新增型別），target 帶新聞與對應政見，hint_sources 放新聞網址", () => {
  const verdict = verdictOf({ choice: "p:a1aaaaaa", probabilities: { "p:a1aaaaaa": 0.97 } }, buildNewsAsk(item, [{ person: people[0], policies }]).keys, MIN_PROBABILITY);
  const t = newsTaskOf({ news_item_id: 42, url: item.url, title: item.title, source_label: item.source, published_at: "2026-09-29T01:00:00Z", person: people[0], policy: policies[0], verdict });
  assertEquals(t.task_type, "news_sweep");
  assertEquals(t.target_politician_id, people[0].id);
  assertEquals(t.target_policy_id, policies[0].id);
  assertEquals(t.region, "台北市");
  assertEquals(t.hint_sources, [item.url]);
  assertEquals(t.target_extra.kind, "news_item");
  assertEquals(t.target_extra.news_item_id, 42);
  assertEquals(t.target_extra.suggestion, "progress");
  assert(t.title.includes("社子島開發") && t.description.includes(item.url));
  // 走得過任務的輸入檢查（createTask 本身不檢查，但型別與欄位要合法）
  const v = validateTaskInput(t);
  assert(v.ok, JSON.stringify(v.errors));

  const pledge = newsTaskOf({ news_item_id: 43, url: item.url, title: item.title, source_label: item.source, published_at: null, person: people[0], policy: null,
    verdict: { result: "new_pledge", choice: "n:11111111", probability: 0.96, politician_id: people[0].id, policy_id: null } });
  assertEquals(pledge.target_policy_id, null);
  assertEquals(pledge.target_extra.suggestion, "new_pledge");
});

Deno.test("派給代理時：單則新聞的 current 帶新聞與政見、hint 換成單則的做法、骨架依初篩給 policy_progress", () => {
  const target = { kind: "news_item", url: item.url, title: item.title, source_label: item.source, suggestion: "progress", politician_id: people[0].id, policy_id: policies[0].id };
  assert(isNewsItemTask("news_sweep", target));
  assert(!isNewsItemTask("news_sweep", { feed_url: "https://feeds.feedburner.com/rsscna/politics" }), "舊的整份 RSS 任務走原本那套");
  const cur = shapeTaskCurrent("news_sweep", { politician: { id: people[0].id, name: "蔣萬安" }, policy: { id: policies[0].id, title: "社子島開發" }, policies: [] }, { task_id: "t1", target });
  assertEquals((cur.news as Record<string, unknown>).url, item.url);
  assertEquals((cur.policy as Record<string, unknown>).id, policies[0].id);
  assert(String(cur.hint).includes("policy_progress") && String(cur.hint).includes("not_found"), "要講清楚三條路：進度、新承諾、判錯了回 no_change");
  assert(String(cur.hint).includes("Proposed"), "任內施政承諾填 Proposed 這條不能掉");
  const tpl = cur.report_template as Record<string, unknown>;
  assertEquals(tpl.contribution_type, "policy_progress");
  assertEquals((tpl.payload as Record<string, unknown>).policy_id, policies[0].id, "政見 id 已經附好，代理不用猜");
  assert("report_templates_by_type" in cur, "新承諾與 no_change 的骨架也要送");
  // 舊的整份 RSS 任務照舊
  const legacy = shapeTaskCurrent("news_sweep", {}, { task_id: "t2", target: { feed_url: "https://x.test/rss" } });
  assert(String(legacy.hint).includes("RSS"));
  // item.source_url 就是那則新聞
  assertEquals(describeManualTask({ title: "x", description: null, task_type: "news_sweep", target }).source_url, item.url);
});

Deno.test("單則新聞任務：那則的進度或承諾上線就算做完（不再是週期性的整份 RSS）", () => {
  assertEquals(shouldCloseOnApplied("news_sweep", "policy_progress"), true);
  assertEquals(shouldCloseOnApplied("news_sweep", "policy"), true);
});

Deno.test("news_item 要在 TS 的 SUBJECT_TYPES 與 DB 的 CHECK 裡（最新一支定義 CHECK 的 migration）", async () => {
  assert((SUBJECT_TYPES as readonly string[]).includes("news_item"));
  const dir = new URL("../../migrations/", import.meta.url);
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  let found: string | null = null;
  for (const name of files.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    const at = sql.indexOf("ADD CONSTRAINT jev_decisions_subject_type_check");
    if (at >= 0) { found = sql.slice(at, sql.indexOf(";", at)); break; }
  }
  assert(found, "找不到定義 jev_decisions_subject_type_check 的 migration");
  for (const t of SUBJECT_TYPES) assert(found!.includes(`'${t}'`), `DB 的 CHECK 少了 ${t}`);
});

// 2026-09-29 首輪：0.95 把 0.69～0.84 的明確新承諾全丟了。這裡只決定要不要派人看，不是定案。
Deno.test("新聞初篩門檻：0.84 的新承諾要派出去（不能沿用全站 0.95）", () => {
  const { keys } = buildNewsAsk(item, [{ person: people[0], policies }]);
  assertEquals(verdictOf({ choice: "n:11111111", probabilities: { "n:11111111": 0.84 } }, keys, NEWS_MIN_PROBABILITY).result, "new_pledge");
});

// 2026-09-29 維護者：資源不多時要能放慢。只有「初篩→開任務」這一段可調，收錄照常每小時
import { isScreenDue, remainingCap, taipeiDayStart } from "./news-screen.ts";
Deno.test("可調設定：幾小時篩一次（留 10 分鐘寬限）、台灣日界、每日上限", () => {
  const now = new Date("2026-09-29T12:05:00Z");
  assertEquals(isScreenDue(null, 3, now), true, "沒篩過就篩");
  assertEquals(isScreenDue("2026-09-29T11:05:00Z", 1, now), true, "每小時：一小時前篩過就該篩");
  assertEquals(isScreenDue("2026-09-29T11:05:00Z", 3, now), false, "每 3 小時：一小時前篩過不篩");
  assertEquals(isScreenDue("2026-09-29T09:10:00Z", 3, now), true, "差 5 分鐘也算到（排程抖動）");
  assertEquals(taipeiDayStart(new Date("2026-09-29T17:00:00Z")).toISOString(), "2026-09-29T16:00:00.000Z", "台灣 01:00 已經是隔天");
  assertEquals(taipeiDayStart(new Date("2026-09-29T15:59:00Z")).toISOString(), "2026-09-28T16:00:00.000Z");
  assertEquals(remainingCap(10, 12), 0);
  assertEquals(remainingCap(10, 3), 7);
});
