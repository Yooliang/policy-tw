/**
 * 分層的兩條紅線：
 *   1. 要撈什麼不准問 wardKind（那要先有資料才判得出來），所以直轄市的區一律撈兩種原住民職位。
 *   2. 顯示的職位一定是「撈回來的」的子集——不然畫面上會有一個永遠空的區塊。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  DIRECTORY_POSITIONS,
  displayedPositions,
  electionPositionLabels,
  planLevels,
  POSITIONS,
  positionSpec,
  positionsToLoad,
  scopeOf,
  type PositionType,
  type WardKind,
} from "./election-levels.ts";

Deno.test("層級由網址上的縣市與鄉鎮決定", () => {
  assertEquals(scopeOf({ region: "All", subRegion: "All" }), "national");
  assertEquals(scopeOf({ region: "嘉義縣", subRegion: "All" }), "county");
  assertEquals(scopeOf({ region: "嘉義縣", subRegion: "大林鎮" }), "township");
  // 全台頁不會有鄉鎮，但萬一有（舊網址帶著 ?sub= 進來）還是全台
  assertEquals(scopeOf({ region: "All", subRegion: "大林鎮" }), "national");
});

Deno.test("全台頁：這一層是總統，下一層是各縣市長", () => {
  const plan = planLevels({ region: "All", subRegion: "All", isSpecialMunicipality: false, wardKind: "rural" });
  assertEquals(plan.scope, "national");
  assertEquals(plan.thisLevel, ["總統副總統"]);
  assertEquals(plan.nextLevel, ["縣市長"]);
});

// 這一條是刻意釘住的行為，不是漏寫：資料裡的立委全是區域立委（2024 那 312 筆都掛在
// 「XX第NN選區」底下），全國不分區與原住民立委一筆都沒有。區域立委屬縣市層。
Deno.test("全台頁不列立法委員——資料裡的立委全是綁縣市選區的區域立委", () => {
  const plan = planLevels({ region: "All", subRegion: "All", isSpecialMunicipality: false, wardKind: "rural" });
  assertEquals(displayedPositions(plan).includes("立法委員"), false);
  assertEquals(positionsToLoad({ region: "All", subRegion: "All", isSpecialMunicipality: false }).includes("立法委員"), false);
});

// 順序就是畫面上區塊的順序（2026-10-05 起頁面照 planLevels 畫）：縣市長、議員、立委——跟分層之前模板寫死的順序一樣
Deno.test("縣市頁（縣轄）：這一層是縣市長、議員、立委，下一層是鄉鎮市長", () => {
  const plan = planLevels({ region: "嘉義縣", subRegion: "All", isSpecialMunicipality: false, wardKind: "rural" });
  assertEquals(plan.scope, "county");
  assertEquals(plan.thisLevel, ["縣市長", "縣市議員", "立法委員"]);
  assertEquals(plan.nextLevel, ["鄉鎮市長"]);
});

Deno.test("縣市頁（直轄市）：下一層是原住民區長，不是鄉鎮市長——直轄市沒有鄉鎮市", () => {
  const plan = planLevels({ region: "高雄市", subRegion: "All", isSpecialMunicipality: true, wardKind: "rural" });
  assertEquals(plan.thisLevel, ["縣市長", "縣市議員", "立法委員"]);
  assertEquals(plan.nextLevel, ["直轄市山地原住民區長"]);
  assertEquals(displayedPositions(plan).includes("鄉鎮市長"), false);
});

Deno.test("縣轄鄉鎮市：這一層是鄉鎮市長與代表，下一層是村里長", () => {
  const plan = planLevels({ region: "嘉義縣", subRegion: "大林鎮", isSpecialMunicipality: false, wardKind: "rural" });
  assertEquals(plan.scope, "township");
  assertEquals(plan.thisLevel, ["鄉鎮市長", "鄉鎮市民代表"]);
  assertEquals(plan.nextLevel, ["村里長"]);
});

Deno.test("直轄市一般區：這一層是空的（區長官派），只有里長", () => {
  const plan = planLevels({ region: "台南市", subRegion: "北區", isSpecialMunicipality: true, wardKind: "plain" });
  assertEquals(plan.thisLevel, []);
  assertEquals(plan.nextLevel, ["村里長"]);
  assertEquals(displayedPositions(plan), ["村里長"]);
});

Deno.test("直轄市原住民區：這一層是區長與區代表，下一層是里長", () => {
  const plan = planLevels({ region: "高雄市", subRegion: "那瑪夏區", isSpecialMunicipality: true, wardKind: "indigenous" });
  assertEquals(plan.thisLevel, ["直轄市山地原住民區長", "直轄市山地原住民區民代表"]);
  assertEquals(plan.nextLevel, ["村里長"]);
});

// 這是分層的核心陷阱：是一般區還是原住民區，要看「有沒有原住民區長／區代表的候選人」，
// 而那要先把資料撈回來。所以撈的時候一律兩種都撈，顯示的時候才分。
Deno.test("直轄市的區：要撈什麼跟 wardKind 無關，三種 wardKind 撈的都一樣", () => {
  const expected: PositionType[] = ["直轄市山地原住民區長", "直轄市山地原住民區民代表", "村里長"];
  for (const wardKind of ["rural", "indigenous", "plain"] as WardKind[]) {
    // positionsToLoad 根本不接 wardKind，這裡用 planLevels 同樣的輸入去取，證明撈的清單不受它影響
    assertEquals(positionsToLoad({ region: "高雄市", subRegion: "那瑪夏區", isSpecialMunicipality: true }), expected);
    // 而顯示的清單確實會因為 wardKind 不同
    const shown = displayedPositions(planLevels({ region: "高雄市", subRegion: "那瑪夏區", isSpecialMunicipality: true, wardKind }));
    assertEquals(shown.every((p) => expected.includes(p)), true, `${wardKind} 顯示了沒撈的職位`);
  }
});

Deno.test("縣轄鄉鎮撈的是鄉鎮市長、代表、村里長，不含原住民區的職位", () => {
  assertEquals(
    positionsToLoad({ region: "嘉義縣", subRegion: "大林鎮", isSpecialMunicipality: false }),
    ["鄉鎮市長", "鄉鎮市民代表", "村里長"],
  );
});

Deno.test("縣市頁撈的職位含下一層，才有東西可以帶到下一站", () => {
  assertEquals(
    positionsToLoad({ region: "嘉義縣", subRegion: "All", isSpecialMunicipality: false }),
    ["縣市長", "縣市議員", "立法委員", "鄉鎮市長"],
  );
  assertEquals(
    positionsToLoad({ region: "高雄市", subRegion: "All", isSpecialMunicipality: true }),
    ["縣市長", "縣市議員", "立法委員", "直轄市山地原住民區長"],
  );
});

// 全部組合跑一遍，守住「顯示的一定撈得到」。少撈一個職位就是一個永遠空的區塊，
// 而空區塊在畫面上看起來跟「這一屆沒有人參選」一模一樣。
Deno.test("任何層級：顯示的職位一定是撈回來的子集", () => {
  const cases: Array<{ region: string; subRegion: string; isSpecialMunicipality: boolean }> = [
    { region: "All", subRegion: "All", isSpecialMunicipality: false },
    { region: "嘉義縣", subRegion: "All", isSpecialMunicipality: false },
    { region: "高雄市", subRegion: "All", isSpecialMunicipality: true },
    { region: "嘉義縣", subRegion: "大林鎮", isSpecialMunicipality: false },
    { region: "台南市", subRegion: "北區", isSpecialMunicipality: true },
    { region: "高雄市", subRegion: "那瑪夏區", isSpecialMunicipality: true },
  ];
  for (const c of cases) {
    const loaded = positionsToLoad(c);
    for (const wardKind of ["rural", "indigenous", "plain"] as WardKind[]) {
      for (const position of displayedPositions(planLevels({ ...c, wardKind }))) {
        assertEquals(loaded.includes(position), true, `${c.region}/${c.subRegion}/${wardKind}：顯示了 ${position} 但沒撈它`);
      }
    }
  }
});

Deno.test("撈的清單沒有重複職位——重複會讓 RPC 的型別篩選白做一次", () => {
  const cases = [
    { region: "All", subRegion: "All", isSpecialMunicipality: false },
    { region: "嘉義縣", subRegion: "All", isSpecialMunicipality: false },
    { region: "高雄市", subRegion: "那瑪夏區", isSpecialMunicipality: true },
  ];
  for (const c of cases) {
    const loaded = positionsToLoad(c);
    assertEquals(new Set(loaded).size, loaded.length, `${c.region}/${c.subRegion} 撈的清單有重複`);
  }
});

// ── 2026-10-05（#348）：分層收成設定（POSITIONS）之後的守門 ─────────────────────

/**
 * #342 寫死的版本，原樣凍結在這裡當對照組：收成設定之後，任何輸入算出來的職位集合都要跟它一樣。
 * 唯一刻意的差別是縣市層的順序（縣市長、議員、立委）——頁面現在照 planLevels 的順序畫，
 * 這個順序就是分層之前模板寫死的順序；以前 planLevels 沒有被頁面拿去畫，順序沒有意義。
 */
function legacyPositionsToLoad(input: { region: string; subRegion: string; isSpecialMunicipality: boolean }): PositionType[] {
  const scope = scopeOf(input);
  if (scope === "national") return ["總統副總統", "縣市長"];
  if (scope === "county") {
    return input.isSpecialMunicipality
      ? ["縣市長", "立法委員", "縣市議員", "直轄市山地原住民區長"]
      : ["縣市長", "立法委員", "縣市議員", "鄉鎮市長"];
  }
  return input.isSpecialMunicipality
    ? ["直轄市山地原住民區長", "直轄市山地原住民區民代表", "村里長"]
    : ["鄉鎮市長", "鄉鎮市民代表", "村里長"];
}
function legacyPlanLevels(input: { region: string; subRegion: string; isSpecialMunicipality: boolean; wardKind: WardKind }) {
  const scope = scopeOf(input);
  if (scope === "national") return { scope, thisLevel: ["總統副總統"], nextLevel: ["縣市長"] };
  if (scope === "county") {
    return { scope, thisLevel: ["縣市長", "立法委員", "縣市議員"], nextLevel: input.isSpecialMunicipality ? ["直轄市山地原住民區長"] : ["鄉鎮市長"] };
  }
  if (!input.isSpecialMunicipality) return { scope, thisLevel: ["鄉鎮市長", "鄉鎮市民代表"], nextLevel: ["村里長"] };
  return { scope, thisLevel: input.wardKind === "indigenous" ? ["直轄市山地原住民區長", "直轄市山地原住民區民代表"] : [], nextLevel: ["村里長"] };
}
const sorted = (xs: readonly string[]) => [...xs].sort();

Deno.test("收成設定之後，每一種輸入撈的與顯示的職位都跟 #342 寫死的版本一樣", () => {
  for (const region of ["All", "嘉義縣", "高雄市"]) {
    for (const subRegion of ["All", "大林鎮", "那瑪夏區"]) {
      for (const isSpecialMunicipality of [false, true]) {
        const input = { region, subRegion, isSpecialMunicipality };
        assertEquals(sorted(positionsToLoad(input)), sorted(legacyPositionsToLoad(input)), `撈：${JSON.stringify(input)}`);
        for (const wardKind of ["rural", "indigenous", "plain"] as WardKind[]) {
          const now = planLevels({ ...input, wardKind });
          const old = legacyPlanLevels({ ...input, wardKind });
          assertEquals(now.scope, old.scope);
          assertEquals(sorted(now.thisLevel), sorted(old.thisLevel), `這一層：${JSON.stringify({ ...input, wardKind })}`);
          // 下一層的順序也要一樣（直轄市縣市頁只有一個，其餘都是一個）
          assertEquals([...now.nextLevel], old.nextLevel, `下一層：${JSON.stringify({ ...input, wardKind })}`);
          // 縣市層以外的這一層連順序都一樣
          if (now.scope !== "county") assertEquals([...now.thisLevel], old.thisLevel);
        }
      }
    }
  }
});

Deno.test("設定表：每個職位剛好一列，鄉鎮層的職位都標了在哪種鄉鎮市區有，其他層不標", () => {
  const all: PositionType[] = ["總統副總統", "立法委員", "縣市長", "縣市議員", "鄉鎮市長", "鄉鎮市民代表", "村里長", "直轄市山地原住民區長", "直轄市山地原住民區民代表"];
  assertEquals(sorted(POSITIONS.map((p) => p.type)), sorted(all));
  for (const p of POSITIONS) {
    if (p.level === "township") assert(p.wards && p.wards.length > 0, `${p.type} 沒標 wards`);
    else assertEquals(p.wards, undefined, `${p.type} 不是鄉鎮層，不該標 wards`);
    assertEquals(positionSpec(p.type), p);
  }
  assertEquals(positionSpec("不存在的職位"), undefined);
  // 每一級至少有一個首長，「下一層」才帶得出東西
  for (const level of ["national", "county", "township", "village"]) {
    assert(POSITIONS.some((p) => p.level === level && p.role === "head"), `${level} 沒有首長`);
  }
});

Deno.test("設定表：分組排法只給選區是「第NN選舉區」的職位與村里長", () => {
  const byDisplay = (d: string) => POSITIONS.filter((p) => p.display === d).map((p) => p.type);
  assertEquals(sorted(byDisplay("district")), sorted(["縣市議員", "直轄市山地原住民區民代表"]));
  assertEquals(byDisplay("village"), ["村里長"]);
});

Deno.test("名錄的職位從設定推，跟分層之前手寫的清單一字不差（順序與名稱）", () => {
  assertEquals(DIRECTORY_POSITIONS.map((p) => ({ type: p.type, label: p.label })), [
    { type: "鄉鎮市長", label: "鄉鎮市長" },
    { type: "直轄市山地原住民區長", label: "原住民區長" },
    { type: "鄉鎮市民代表", label: "鄉鎮市民代表" },
    { type: "直轄市山地原住民區民代表", label: "原住民區代表" },
    { type: "村里長", label: "村里長" },
  ]);
});

Deno.test("區塊標題跟分層之前模板寫死的一樣（「〔名稱〕參選人」）", () => {
  const titles = Object.fromEntries(POSITIONS.filter((p) => p.display === "grid").map((p) => [p.type, `${p.label}參選人`]));
  assertEquals(titles, {
    "總統副總統": "總統副總統參選人",
    "縣市長": "縣市長參選人",
    "立法委員": "立法委員參選人",
    "鄉鎮市長": "鄉鎮市長參選人",
    "鄉鎮市民代表": "鄉鎮市民代表參選人",
    "直轄市山地原住民區長": "原住民區長參選人",
  });
});

Deno.test("選舉頁照設定畫：設定用到的圖示都有註冊，模板不再寫死各職位的區塊", async () => {
  const page = await Deno.readTextFile(new URL("../pages/ElectionPage.vue", import.meta.url));
  const icons = page.match(/const LEVEL_ICONS: Record<string, Component> = \{([^}]*)\}/);
  assert(icons, "ElectionPage.vue 找不到 LEVEL_ICONS");
  const registered = icons[1].split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of POSITIONS) assert(registered.includes(p.icon), `${p.type} 的圖示 ${p.icon} 沒有註冊——區塊會沒有圖示`);
  // 區塊由設定產生：模板裡不該再出現寫死的「…參選人」標題或各職位專用的名單
  assert(page.includes('v-for="section in thisLevelSections"') && page.includes('v-for="section in nextLevelSections"'));
  assertEquals(page.match(/title="[^"]*參選人"/g), null, "模板裡又寫死了區塊標題");
});

Deno.test("選舉一覽的職位標籤：地方選舉列中選會的九種名稱，縣市長與直轄市長連到同一個錨點", () => {
  const types = ["縣市長", "縣市議員", "鄉鎮市長", "鄉鎮市民代表", "直轄市山地原住民區長", "直轄市山地原住民區民代表", "村里長"];
  const labels = electionPositionLabels(types);
  assertEquals(labels.map((l) => l.label), [
    "直轄市長", "縣市長", "直轄市議員", "縣市議員", "鄉鎮市長", "鄉鎮市民代表",
    "直轄市山地原住民區長", "直轄市山地原住民區民代表", "村里長",
  ]);
  // 全台頁真的有的區塊只有縣市長（下一層）：直轄市長與縣市長是同一個區塊；其他的區塊在縣市頁以下，不給錨點
  assertEquals(labels.filter((l) => l.anchor).map((l) => [l.label, l.anchor]), [["直轄市長", "縣市長"], ["縣市長", "縣市長"]]);
});

Deno.test("選舉一覽的職位標籤：總統大選照它自己的職位列，總統副總統連到全台頁的區塊", () => {
  const labels = electionPositionLabels(["立法委員", "總統副總統"]);
  assertEquals(labels, [{ label: "總統副總統", anchor: "總統副總統" }, { label: "立法委員", anchor: undefined }]);
});

Deno.test("選舉一覽的職位標籤：錨點一定是全台頁會畫出來的區塊（displayedPositions）的 sectionAnchor", () => {
  const onPage = new Set<string>(displayedPositions(planLevels({ region: "All", subRegion: "All", isSpecialMunicipality: false, wardKind: "rural" })));
  for (const spec of POSITIONS) {
    const [first] = electionPositionLabels([spec.type]);
    assertEquals(first.anchor !== undefined, onPage.has(spec.type), spec.type);
  }
});

Deno.test("選舉一覽的職位標籤：站內職位表沒有的職位照原名列在最後", () => {
  assertEquals(electionPositionLabels(["村里長", "新職位"]).map((l) => l.label), ["村里長", "新職位"]);
});
