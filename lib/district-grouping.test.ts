/**
 * 守三件事：自然排序（第02 在 第10 前面）、選區沒填的人不會從畫面消失、
 * 以及快篩清單裡不要出現「選區待補」這種點不下去的東西（2026-10-05 前叫「未標示選舉區」）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { UNLABELED_DISTRICT, districtsOf, groupByDistrict, isFormalDistrict } from "./district-grouping.ts";

const p = (name: string, subRegion?: string | null) => ({ name, subRegion });

Deno.test("依選區分組，組內保持原順序", () => {
  const groups = groupByDistrict([
    p("甲", "第01選舉區"),
    p("乙", "第02選舉區"),
    p("丙", "第01選舉區"),
  ]);
  assertEquals(groups.length, 2);
  assertEquals(groups[0].district, "第01選舉區");
  assertEquals(groups[0].people.map((x) => x.name), ["甲", "丙"]);
  assertEquals(groups[1].people.map((x) => x.name), ["乙"]);
});

// 字串比較會把 第10 排到 第02 前面（字元 '1' < '2'），那樣分組順序整個亂掉
Deno.test("自然排序：第02選舉區 排在 第10選舉區 前面", () => {
  const groups = groupByDistrict([
    p("十", "第10選舉區"),
    p("二", "第02選舉區"),
    p("一", "第01選舉區"),
    p("九", "第09選舉區"),
  ]);
  assertEquals(groups.map((g) => g.district), ["第01選舉區", "第02選舉區", "第09選舉區", "第10選舉區"]);
});

Deno.test("原住民區代表的選區格式（XX區第NN選舉區）照樣分得開", () => {
  const groups = groupByDistrict([
    p("那一", "那瑪夏區第01選舉區"),
    p("桃一", "桃源區第01選舉區"),
    p("那二", "那瑪夏區第02選舉區"),
  ]);
  assertEquals(groups.map((g) => g.district), ["那瑪夏區第01選舉區", "那瑪夏區第02選舉區", "桃源區第01選舉區"]);
});

// 2022 的縣市議員有 41 筆 sub_region 是 NULL。舊寫法若只留「有選區」的人，這 41 位就從畫面上消失了。
Deno.test("選區沒填的人收進最後一組，不會從畫面消失", () => {
  const groups = groupByDistrict([
    p("甲", "第01選舉區"),
    p("沒填", null),
    p("空字串", ""),
    p("空白", "   "),
    p("未定義", undefined),
  ]);
  assertEquals(groups.length, 2);
  assertEquals(groups[0].district, "第01選舉區");
  assertEquals(groups[1].district, UNLABELED_DISTRICT);
  assertEquals(groups[1].people.map((x) => x.name), ["沒填", "空字串", "空白", "未定義"]);
});

Deno.test("全部都沒填選區時只有一組，而且總人數不少", () => {
  const groups = groupByDistrict([p("甲"), p("乙")]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].district, UNLABELED_DISTRICT);
  assertEquals(groups[0].people.length, 2);
});

Deno.test("沒有人就沒有組", () => {
  assertEquals(groupByDistrict([]), []);
});

Deno.test("分組不會吃掉任何人", () => {
  const people = [p("a", "第01選舉區"), p("b", null), p("c", "第02選舉區"), p("d", "第01選舉區"), p("e", "")];
  const total = groupByDistrict(people).reduce((n, g) => n + g.people.length, 0);
  assertEquals(total, people.length);
});

Deno.test("快篩清單是排好序的真選區，不含「選區待補」", () => {
  const list = districtsOf([
    p("十", "第10選舉區"),
    p("沒填", null),
    p("二", "第02選舉區"),
  ]);
  assertEquals(list, ["第02選舉區", "第10選舉區"]);
});

Deno.test("快篩清單不會有重複的選區", () => {
  const list = districtsOf([p("甲", "第01選舉區"), p("乙", "第01選舉區")]);
  assertEquals(list, ["第01選舉區"]);
});

/**
 * 2026-10-05：台中市議員的快篩清單混進「大雅區」「豐原區」「臺中市第03選區」——沒有選區的議員紀錄借了人物自己的地區。
 * 給了選舉別就只認那種選舉的正式選區寫法，其餘收進「選區待補」，不會冒出假選區、也不會讓人消失。
 */
Deno.test("縣市議員：鄉鎮名、立委選區不是選區，收進「選區待補」，快篩清單只剩正式選區", () => {
  const people = [
    p("劉", "第01選舉區"),
    p("陳映辰", "大雅區"),
    p("連佳振", "豐原區"),
    p("張烱春", "臺中市第03選區"),
    p("鍾", "第05選舉區"),
    p("沒填", null),
  ];
  const groups = groupByDistrict(people, "縣市議員");
  assertEquals(groups.map((g) => g.district), ["第01選舉區", "第05選舉區", UNLABELED_DISTRICT]);
  assertEquals(groups[2].people.map((x) => x.name), ["陳映辰", "連佳振", "張烱春", "沒填"]);
  assertEquals(districtsOf(people, "縣市議員"), ["第01選舉區", "第05選舉區"]);
  assertEquals(groups.reduce((n, g) => n + g.people.length, 0), people.length, "不會吃掉任何人");
  assertEquals(UNLABELED_DISTRICT, "選區待補");
});

Deno.test("原住民區代表：<區>第NN選舉區 才算；議員式的第NN選舉區與區名不算", () => {
  const groups = groupByDistrict([p("那一", "那瑪夏區第01選舉區"), p("議員式", "第01選舉區"), p("區名", "那瑪夏區")], "直轄市山地原住民區民代表");
  assertEquals(groups.map((g) => g.district), ["那瑪夏區第01選舉區", UNLABELED_DISTRICT]);
});

Deno.test("isFormalDistrict：立委選區與全國三種；其他選舉別沒有選區", () => {
  assertEquals(isFormalDistrict("臺中市第03選區", "立法委員"), true);
  assertEquals(isFormalDistrict("不分區", "立法委員"), true);
  assertEquals(isFormalDistrict("第03選舉區", "立法委員"), false);
  assertEquals(isFormalDistrict("臺中市第03選區", "縣市議員"), false);
  assertEquals(isFormalDistrict("大雅區", "村里長"), false);
});

// ── 地區／分組的選擇只在右側面板（2026-10-06 小良哥：列表上方不放 chips）──

Deno.test("參選人列表上方沒有選擇列：分組元件只畫分組；選舉區在右側面板（議員、區代表），村里在右側面板的「村里」", () => {
  const page = Deno.readTextFileSync(new URL("../pages/ElectionPage.vue", import.meta.url));
  const groups = Deno.readTextFileSync(new URL("../pages/election/ChipFilteredGroups.vue", import.meta.url));
  const template = groups.slice(groups.indexOf("<template>"));
  assert(!template.includes("<button") && !/v-for="chip/.test(template), "分組元件沒有 chip 按鈕");
  assert(!/chips|selected/.test(groups.slice(groups.indexOf("defineProps"), groups.indexOf("</script>"))), "分組元件不收 chips／selected");
  assertEquals(page.match(/<ChipFilteredGroups[^>]*:chips=/g)?.length ?? 0, 0);
  assert(!/<ChipFilteredGroups(?:\s+[^>\s]+)*\s+:selected=/.test(page));
  // 右側面板：選舉區（標題「○○選舉區」）在鄉鎮市區之後、村里之前；只在候選人頁籤，其他頁籤用不到
  const sub = page.indexOf("<span class=\"text-sm font-bold text-slate-700\">鄉鎮市區</span>");
  const dist = page.indexOf('data-testid="district-panel"');
  const village = page.indexOf("<!-- 村里篩選 -->");
  assert(sub > 0 && dist > sub && village > dist, "順序：鄉鎮市區、選舉區、村里");
  assert(/const districtPanels = computed\(\(\) => viewMode\.value !== 'politicians' \? \[\]/.test(page));
  assert(page.includes("`${sec.spec.label}選舉區`"), "標題是「縣市議員選舉區」這種寫法");
  assert(/@click="toggleDistrictChip\(district\)"/.test(page) && /@click="selectedDistrict = 'All'"/.test(page));
});
