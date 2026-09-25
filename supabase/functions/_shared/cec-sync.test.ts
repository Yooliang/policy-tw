import { assertEquals } from "jsr:@std/assert@1";
import {
  cecCandidateName,
  cecNameNorm,
  decodeCecEscapes,
  DISTRICT_REP_CITIES,
  ourElectionType,
  planUnits,
  toCecCandidateRow,
  votedElectionIds,
} from "./cec-sync.ts";

// ── ① 罕見字逸出碼解碼 ──────────────────────────────────────────
Deno.test("解碼中選會罕見字逸出碼 @十六進位碼位@", () => {
  assertEquals(decodeCecEscapes("林@2C9F7@昌"), "林" + String.fromCodePoint(0x2c9f7) + "昌");
  assertEquals(decodeCecEscapes("沒有逸出碼的姓名"), "沒有逸出碼的姓名");
  // 解不出來的壞碼位：原樣放回，不要炸掉整條姓名
  assertEquals(decodeCecEscapes("林@ZZZZ@昌"), "林@ZZZZ@昌");
});

Deno.test("cecCandidateName：只解回罕見字，其他原字（間隔號、附註拼音、臺／黄）都保留", () => {
  assertEquals(cecCandidateName("林@2C9F7@昌"), "林" + String.fromCodePoint(0x2c9f7) + "昌");
  assertEquals(cecCandidateName("谷辣斯．尤達卡 Kolas Yotaka"), "谷辣斯．尤達卡 Kolas Yotaka");
  assertEquals(cecCandidateName("  黄大牛  "), "黄大牛");
});

// ── name_norm：五個坑各一例 ──────────────────────────────────────
Deno.test("name_norm ①：罕見字逸出碼要先解碼才能比對", () => {
  assertEquals(cecNameNorm("林@2C9F7@昌"), cecNameNorm("林" + String.fromCodePoint(0x2c9f7) + "昌"));
});

Deno.test("name_norm ②：CJK 相容表意文字要 NFKC 收斂成一般統一表意文字", () => {
  // U+FA10（CJK 相容表意文字）NFKC 會正規化成 U+585A「塚」
  assertEquals(cecNameNorm("金@FA10@"), "金塚");
  assertEquals(cecNameNorm("金塚"), "金塚");
});

Deno.test("name_norm ③：中選會「黃」姓常寫成異體字「黄」", () => {
  assertEquals(cecNameNorm("黄大牛"), "黃大牛");
});

Deno.test("name_norm ④：原住民名的間隔號與附註英文拼音都要拿掉", () => {
  // ‧ U+2027（政府慣用的原住民姓名間隔點）與 · U+00B7（半形中點）都在移除清單裡，NFKC 不會動它們
  assertEquals(cecNameNorm("谷辣斯‧尤達卡 Kolas Yotaka"), "谷辣斯尤達卡");
  assertEquals(cecNameNorm("谷辣斯·尤達卡"), "谷辣斯尤達卡");
});

Deno.test("name_norm：全形句點「．」NFKC 後會變成半形句點，殘留的句點不會被清掉——跟 SQL 版一樣的已知行為", () => {
  // translate/regexp_replace 的移除清單裡也是全形「．」，NFKC 一律先跑，全形句點在那之前就已經變成半形「.」，
  // 兩邊（TS／SQL）都會留下這個殘留句點；只要兩邊行為一致，比對時就不會因為這個字元對不起來。
  assertEquals(cecNameNorm("谷辣斯．尤達卡"), "谷辣斯.尤達卡");
});

Deno.test("name_norm ⑤：臺→台", () => {
  assertEquals(cecNameNorm("陳臺生"), "陳台生");
});

Deno.test("name_norm 跟 SQL 函式 cec_name_norm 對齊：沒有拉丁附註時逐字相同", () => {
  // migrations/20260926000001_cec_candidates.sql 的 cec_name_norm：
  //   regexp_replace(translate(normalize(p, NFKC), '臺黄', '台黃'), '[\s·．・‧•]', '', 'g')
  const sqlEquivalent = (p: string) =>
    p.normalize("NFKC").replace(/臺/g, "台").replace(/黄/g, "黃").replace(/[\s·．・‧•]/g, "");
  for (const name of ["蔡英文", "林佳龍", "黄珊珊", "臺南市長候選人", "谷辣斯．尤達卡"]) {
    assertEquals(cecNameNorm(name), sqlEquivalent(name), name);
  }
});

// ── 選舉別對照：中選會直轄市長／議員要併成我們的縣市長／縣市議員 ──────
Deno.test("選舉別對照：直轄市長／直轄市議員併成縣市長／縣市議員", () => {
  assertEquals(ourElectionType("Mayor"), "縣市長");
  assertEquals(ourElectionType("CountyMayor"), "縣市長");
  assertEquals(ourElectionType("CouncilMember"), "縣市議員");
  assertEquals(ourElectionType("CountyCouncilMember"), "縣市議員");
  assertEquals(ourElectionType("President"), "總統副總統");
  assertEquals(ourElectionType("Village"), "村里長");
  assertEquals(ourElectionType("DistrictExecutive"), "直轄市山地原住民區長");
  assertEquals(ourElectionType("NoSuchType"), null);
});

// ── 同步單位規劃 ────────────────────────────────────────────────
Deno.test("planUnits：縣市長＝六都用 Mayor＋其餘 16 縣市用 CountyMayor，共 22", () => {
  const units = planUnits("縣市長");
  assertEquals(units.length, 22);
  const taipei = units.find((u) => u.region === "台北市");
  assertEquals(taipei?.cecType, "Mayor");
  const changhua = units.find((u) => u.region === "彰化縣");
  assertEquals(changhua?.cecType, "CountyMayor");
});

Deno.test("planUnits：縣市議員＝六都用 CouncilMember＋其餘用 CountyCouncilMember，共 22", () => {
  const units = planUnits("縣市議員");
  assertEquals(units.length, 22);
  assertEquals(units.find((u) => u.region === "高雄市")?.cecType, "CouncilMember");
  assertEquals(units.find((u) => u.region === "南投縣")?.cecType, "CountyCouncilMember");
});

Deno.test("planUnits：直轄市山地原住民區長／區民代表只在有山地原住民區的直轄市", () => {
  const exec = planUnits("直轄市山地原住民區長");
  assertEquals(exec.map((u) => u.region).sort(), [...DISTRICT_REP_CITIES].sort());
  assertEquals(exec.every((u) => u.cecType === "DistrictExecutive"), true);
  const rep = planUnits("直轄市山地原住民區民代表");
  assertEquals(rep.every((u) => u.cecType === "DistrictRepresentatives"), true);
});

Deno.test("planUnits：總統副總統只有全國一個單位；村里長是全部 22 縣市", () => {
  assertEquals(planUnits("總統副總統"), [{ region: "全國", cecType: "President" }]);
  assertEquals(planUnits("村里長").length, 22);
  assertEquals(planUnits("不存在的類型"), []);
});

// ── 已投票屆別 ──────────────────────────────────────────────────
Deno.test("votedElectionIds：2026 投票日之前只有 2022、2024", () => {
  assertEquals(votedElectionIds(new Date("2026-09-26T00:00:00Z")), [2022, 2024]);
  assertEquals(votedElectionIds(new Date("2026-11-27T23:59:59Z")), [2022, 2024]);
});

Deno.test("votedElectionIds：2026-11-28 投票日當天起算入 2026", () => {
  assertEquals(votedElectionIds(new Date("2026-11-28T00:00:00Z")), [2022, 2024, 2026]);
  assertEquals(votedElectionIds(new Date("2027-01-01T00:00:00Z")), [2022, 2024, 2026]);
});

// ── CEC 列 → cec_candidates 列 ───────────────────────────────────
Deno.test("toCecCandidateRow：候選人檔＋得票檔合併，得票檔的 is_victor 優先", () => {
  const row = {
    cand_id: 12345,
    cand_name: "黄大牛",
    cand_no: 3,
    cand_birthyear: "70",
    prv_code: "10",
    city_code: "007",
    area_name: "彰化縣第01選舉區",
  };
  const ticket = { cand_id: 12345, is_victor: "*", ticket_num: 88888 };
  const row2 = toCecCandidateRow(row, ticket, {
    electionId: 2022,
    ourType: "縣市議員",
    cecType: "CountyCouncilMember",
    themeId: "theme-abc",
    requestedRegion: "彰化縣",
  });
  assertEquals(row2, {
    election_id: 2022,
    election_type: "縣市議員",
    region: "彰化縣",
    sub_region: "彰化縣第01選舉區",
    village: null,
    name: "黄大牛",
    name_norm: "黃大牛",
    birth_year: 1981,
    cand_no: 3,
    elected: true,
    cec_theme_id: "theme-abc",
    cec_cand_id: 12345,
  });
});

Deno.test("toCecCandidateRow：姓名是空的回 null（呼叫端跳過）", () => {
  const out = toCecCandidateRow({ cand_id: 1 }, undefined, {
    electionId: 2022,
    ourType: "村里長",
    cecType: "Village",
    themeId: "t",
  });
  assertEquals(out, null);
});

Deno.test("toCecCandidateRow：村里長用 tickets 檔補的 dept_code 對出鄉鎮名", () => {
  const deptNames = new Map([["001", "彰化市"]]);
  const ticketRow = {
    cand_id: 99,
    cand_name: "林@2C9F7@昌",
    dept_code: "001",
    area_name: "光復里",
    prv_code: "10",
    city_code: "007",
    is_victor: "",
  };
  const out = toCecCandidateRow(ticketRow, ticketRow, {
    electionId: 2022,
    ourType: "村里長",
    cecType: "Village",
    themeId: "t2",
    requestedRegion: "彰化縣",
    deptNames,
  });
  assertEquals(out?.region, "彰化縣");
  assertEquals(out?.sub_region, "彰化市");
  assertEquals(out?.village, "光復里");
  assertEquals(out?.name, "林" + String.fromCodePoint(0x2c9f7) + "昌");
  assertEquals(out?.elected, false);
});
