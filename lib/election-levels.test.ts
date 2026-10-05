/**
 * 分層的兩條紅線：
 *   1. 要撈什麼不准問 wardKind（那要先有資料才判得出來），所以直轄市的區一律撈兩種原住民職位。
 *   2. 顯示的職位一定是「撈回來的」的子集——不然畫面上會有一個永遠空的區塊。
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  displayedPositions,
  planLevels,
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

Deno.test("縣市頁（縣轄）：這一層是縣市長、立委、議員，下一層是鄉鎮市長", () => {
  const plan = planLevels({ region: "嘉義縣", subRegion: "All", isSpecialMunicipality: false, wardKind: "rural" });
  assertEquals(plan.scope, "county");
  assertEquals(plan.thisLevel, ["縣市長", "立法委員", "縣市議員"]);
  assertEquals(plan.nextLevel, ["鄉鎮市長"]);
});

Deno.test("縣市頁（直轄市）：下一層是原住民區長，不是鄉鎮市長——直轄市沒有鄉鎮市", () => {
  const plan = planLevels({ region: "高雄市", subRegion: "All", isSpecialMunicipality: true, wardKind: "rural" });
  assertEquals(plan.thisLevel, ["縣市長", "立法委員", "縣市議員"]);
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
    ["縣市長", "立法委員", "縣市議員", "鄉鎮市長"],
  );
  assertEquals(
    positionsToLoad({ region: "高雄市", subRegion: "All", isSpecialMunicipality: true }),
    ["縣市長", "立法委員", "縣市議員", "直轄市山地原住民區長"],
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
