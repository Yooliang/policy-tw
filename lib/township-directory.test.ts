/**
 * 名錄是預渲染縣市頁裡唯一通往村里長人物頁的連結（13,338 位，爬蟲只能從這裡走到）。
 * 所以這裡守的第一件事就是「不會吃掉任何人」——少一位就是少一個被收錄的頁面。
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  buildTownshipDirectory,
  directoryTotal,
  toDirectoryPerson,
  townshipOf,
  type DirectoryLevelSpec,
  type DirectoryPerson,
} from "./township-directory.ts";

const LEVELS: DirectoryLevelSpec[] = [
  { type: "鄉鎮市長", label: "鄉鎮市長" },
  { type: "直轄市山地原住民區長", label: "原住民區長" },
  { type: "鄉鎮市民代表", label: "鄉鎮市民代表" },
  { type: "直轄市山地原住民區民代表", label: "原住民區代表" },
  { type: "村里長", label: "村里長" },
];

const p = (
  politicianId: string,
  name: string,
  electionType: string,
  subRegion?: string | null,
  village?: string | null,
): DirectoryPerson => ({ politicianId, name, electionType, subRegion, village });

Deno.test("原住民區代表的選區歸到那個區底下", () => {
  assertEquals(townshipOf("那瑪夏區第01選舉區"), "那瑪夏區");
  assertEquals(townshipOf("桃源區第02選舉區"), "桃源區");
  assertEquals(townshipOf("大林鎮"), "大林鎮");
  assertEquals(townshipOf("北區"), "北區");
});

Deno.test("鄉鎮不明的人歸到「其他」，不是被丟掉", () => {
  assertEquals(townshipOf(null), "其他");
  assertEquals(townshipOf(undefined), "其他");
  assertEquals(townshipOf(""), "其他");
});

Deno.test("依鄉鎮分組，組內再依層級分，層級順序照 levels", () => {
  const dir = buildTownshipDirectory([
    p("1", "里長甲", "村里長", "大林鎮", "三村里"),
    p("2", "鎮長甲", "鄉鎮市長", "大林鎮"),
    p("3", "里長乙", "村里長", "大林鎮", "三和里"),
  ], LEVELS);
  assertEquals(dir.length, 1);
  assertEquals(dir[0].township, "大林鎮");
  assertEquals(dir[0].total, 3);
  // levels 把鄉鎮市長排在村里長前面，即使資料裡村里長先出現
  assertEquals(dir[0].groups.map((g) => g.label), ["鄉鎮市長", "村里長"]);
  assertEquals(dir[0].groups[1].people.map((x) => x.name), ["里長甲", "里長乙"]);
});

Deno.test("多個鄉鎮依地名排序（先字數再筆畫）", () => {
  const dir = buildTownshipDirectory([
    p("1", "a", "村里長", "阿里山鄉"),
    p("2", "b", "村里長", "大林鎮"),
    p("3", "c", "村里長", "民雄鄉"),
  ], LEVELS);
  // 三個字的在前，四個字的在最後
  assertEquals(dir[dir.length - 1].township, "阿里山鄉");
  assertEquals(dir.length, 3);
});

Deno.test("原住民區：區代表的兩個選區併到同一個區，跟里長同一組底下", () => {
  const dir = buildTownshipDirectory([
    p("1", "代表甲", "直轄市山地原住民區民代表", "那瑪夏區第01選舉區"),
    p("2", "代表乙", "直轄市山地原住民區民代表", "那瑪夏區第02選舉區"),
    p("3", "里長甲", "村里長", "那瑪夏區", "民權里"),
  ], LEVELS);
  assertEquals(dir.length, 1);
  assertEquals(dir[0].township, "那瑪夏區");
  assertEquals(dir[0].total, 3);
  assertEquals(dir[0].groups.map((g) => g.label), ["原住民區代表", "村里長"]);
});

// 這一條是這支函式的重點：名錄少一位，就是少一個爬蟲走得到的人物頁
Deno.test("不在 levels 裡的職位不進名錄，其餘一位都不少", () => {
  const people = [
    p("1", "縣市長", "縣市長"),          // 不是鄉鎮層級，不進名錄
    p("2", "議員", "縣市議員", "第01選舉區"), // 同上
    p("3", "鎮長", "鄉鎮市長", "大林鎮"),
    p("4", "里長", "村里長", "大林鎮", "三村里"),
    p("5", "沒鄉鎮的里長", "村里長", null, "某里"),
  ];
  const dir = buildTownshipDirectory(people, LEVELS);
  // 鄉鎮層級的 3 位全在，而且「沒鄉鎮」那位進了「其他」而不是消失
  assertEquals(directoryTotal(dir), 3);
  assertEquals(dir.some((t) => t.township === "其他"), true);
  const names = dir.flatMap((t) => t.groups.flatMap((g) => g.people.map((x) => x.name)));
  assertEquals(names.includes("沒鄉鎮的里長"), true);
  assertEquals(names.includes("縣市長"), false);
});

Deno.test("每一位都帶得出 politicianId——名錄的連結靠它", () => {
  const dir = buildTownshipDirectory([
    p("abc", "里長甲", "村里長", "大林鎮", "三村里"),
  ], LEVELS);
  assertEquals(dir[0].groups[0].people[0].politicianId, "abc");
});

Deno.test("沒有人就是空名錄，總數 0", () => {
  assertEquals(buildTownshipDirectory([], LEVELS), []);
  assertEquals(directoryTotal([]), 0);
});

Deno.test("總數等於各組人數相加", () => {
  const dir = buildTownshipDirectory([
    p("1", "a", "村里長", "大林鎮", "x里"),
    p("2", "b", "村里長", "民雄鄉", "y里"),
    p("3", "c", "鄉鎮市長", "民雄鄉"),
  ], LEVELS);
  assertEquals(directoryTotal(dir), 3);
  assertEquals(dir.reduce((n, t) => n + t.groups.reduce((m, g) => m + g.people.length, 0), 0), 3);
});

// PostgREST 對 many-to-one 的嵌入回單一物件，supabase-js 沒有產生型別時會推成陣列。
// 猜錯就是整份名錄變空，而空名錄跟「這個縣市沒有鄉鎮層級參選人」在畫面上一模一樣。
Deno.test("嵌入關聯是單一物件時轉得出來（PostgREST 實際的形狀）", () => {
  const got = toDirectoryPerson({
    politician_id: "p1",
    election_type: "村里長",
    politicians: { name: "里長甲" },
    regions: { sub_region: "大林鎮", village: "三村里" },
  });
  assertEquals(got, { politicianId: "p1", name: "里長甲", electionType: "村里長", subRegion: "大林鎮", village: "三村里" });
});

Deno.test("嵌入關聯是陣列時也轉得出來（supabase-js 推斷的形狀）", () => {
  const got = toDirectoryPerson({
    politician_id: "p2",
    election_type: "鄉鎮市長",
    politicians: [{ name: "鎮長甲" }],
    regions: [{ sub_region: "民雄鄉", village: null }],
  });
  assertEquals(got?.name, "鎮長甲");
  assertEquals(got?.subRegion, "民雄鄉");
  assertEquals(got?.village, null);
});

Deno.test("沒有姓名的列回 null——連結沒有字可以點", () => {
  assertEquals(toDirectoryPerson({ politician_id: "p3", election_type: "村里長", politicians: null, regions: null }), null);
  assertEquals(toDirectoryPerson({ politician_id: "p4", election_type: "村里長", politicians: [], regions: null }), null);
});

Deno.test("選區是空的照樣轉得出來，鄉鎮之後會歸到「其他」", () => {
  const got = toDirectoryPerson({ politician_id: "p5", election_type: "村里長", politicians: { name: "甲" }, regions: null });
  assertEquals(got?.subRegion, null);
  assertEquals(townshipOf(got?.subRegion), "其他");
});
