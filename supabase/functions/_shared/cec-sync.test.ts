import { assertEquals } from "jsr:@std/assert@1";
import {
  cecCandidateName,
  cecNameNorm,
  decodeCecEscapes,
  DISTRICT_REP_CITIES,
  ourElectionType,
  pickTheme,
  planUnits,
  toCecCandidateRow,
  electionAreaRegion,
  electionOurTypes,
  planElectionUnits,
  votedElections,
} from "./cec-sync.ts";
import { SUBJECT_MAP } from "./cec-static-fetch.ts";

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

Deno.test("name_norm：全形句點「．」NFKC 後變半形「.」，也要去掉（20260926000003 的 SQL 版同步）", () => {
  assertEquals(cecNameNorm("谷辣斯．尤達卡"), "谷辣斯尤達卡");
});

Deno.test("name_norm ⑤：臺→台", () => {
  assertEquals(cecNameNorm("陳臺生"), "陳台生");
});

Deno.test("name_norm 跟 SQL 函式 cec_name_norm 對齊：沒有拉丁附註時逐字相同", () => {
  // migrations/20260926000003_cec_name_norm_dot.sql 的 cec_name_norm：
  //   regexp_replace(translate(normalize(p, NFKC), '臺黄', '台黃'), '[\s·．.・‧•]', '', 'g')
  const sqlEquivalent = (p: string) =>
    p.normalize("NFKC").replace(/臺/g, "台").replace(/黄/g, "黃").replace(/[\s·．.・‧•]/g, "");
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

// ── 立委不只區域（2026-10-05，#332 第 2b 項：2024 不分區與原住民立委一位都沒進來） ──────
Deno.test("planUnits：立法委員＝22 縣市區域＋不分區、平地原住民、山地原住民三個全國單位，三個要用 sub_region 分開", () => {
  const units = planUnits("立法委員");
  assertEquals(units.length, 25);
  assertEquals(units.filter((u) => u.cecType === "Legislator").length, 22);
  const atLarge = units.filter((u) => u.region === "全國");
  assertEquals(atLarge.map((u) => [u.cecType, u.subRegion]), [
    ["LegislatorParty", "不分區"],
    ["LegislatorPlainIndigenous", "平地原住民"],
    ["LegislatorMountainIndigenous", "山地原住民"],
  ]);
  // 同步是「同一個範圍先刪再寫」：三個全國單位的範圍要彼此不同，否則後跑的會把先跑的刪掉
  assertEquals(new Set(atLarge.map((u) => `${u.region}|${u.subRegion}`)).size, 3);
  assertEquals(atLarge.every((u) => ourElectionType(u.cecType) === "立法委員"), true);
});

// 中選會 ELC_L0 清單實際長這樣（2026-10-05 抓的 2024 那四筆，欄位節錄）：同一屆、同一個投票日、四種立委
const L0_2024 = [
  { themeId: "9c96a2080bfc199c590ec54f3a2bda7b", themeName: "第11屆立法委員選舉", voteDate: "2024-01-13", year: 2024, legislatorTypeId: "L1" },
  { themeId: "9f382748c91a4096d8a4f203530a57ab", themeName: "第11屆立法委員選舉", voteDate: "2024-01-13", year: 2024, legislatorTypeId: "L2" },
  { themeId: "7fbfcdb409c14531893107df396133cb", themeName: "第11屆立法委員選舉", voteDate: "2024-01-13", year: 2024, legislatorTypeId: "L3" },
  { themeId: "e753a8e7a7bcc09fa51d1aea0024a843", themeName: "第11屆立法委員選舉", voteDate: "2024-01-13", year: 2024, legislatorTypeId: "L4" },
  { themeId: "be404784efb488c1004009663c892e18", themeName: "第10屆立法委員選舉", voteDate: "2020-01-11", year: 2020, legislatorTypeId: "L1" },
];

Deno.test("pickTheme：立委四種同在一份清單，要用 legislator_type_id 挑，不是挑第一筆", () => {
  assertEquals(pickTheme(L0_2024, "2024-01-13", SUBJECT_MAP.Legislator)?.themeId, "9c96a2080bfc199c590ec54f3a2bda7b");
  assertEquals(pickTheme(L0_2024, "2024-01-13", SUBJECT_MAP.LegislatorPlainIndigenous)?.themeId, "9f382748c91a4096d8a4f203530a57ab");
  assertEquals(pickTheme(L0_2024, "2024-01-13", SUBJECT_MAP.LegislatorMountainIndigenous)?.themeId, "7fbfcdb409c14531893107df396133cb");
  assertEquals(pickTheme(L0_2024, "2024-01-13", SUBJECT_MAP.LegislatorParty)?.themeId, "e753a8e7a7bcc09fa51d1aea0024a843");
  assertEquals(pickTheme(L0_2024, "2020-01-11", SUBJECT_MAP.LegislatorParty), undefined, "2020 清單裡只放了區域，不分區不能退回去拿區域那筆");
});

Deno.test("pickTheme：不是立委的科目照舊（不看 legislator_type_id）；場次用投票日對，同年的重行選舉是另一天、另一場選舉", () => {
  const themes = [
    { themeId: "redo", themeName: "嘉義市長重行選舉", voteDate: "2022-12-18", year: 2022 },
    { themeId: "main", themeName: "111年直轄市長選舉", voteDate: "2022-11-26", year: 2022 },
  ];
  assertEquals(pickTheme(themes, "2022-11-26", SUBJECT_MAP.Mayor)?.themeId, "main");
  assertEquals(pickTheme(themes, "2022-11-26")?.themeId, "main");
  assertEquals(pickTheme(themes, "2022-12-18")?.themeId, "redo", "重行選舉有自己的投票日，挑到自己的場次");
  assertEquals(pickTheme(themes, "2022-12-19"), undefined, "沒有這一天的場次就是沒有，不退回同年別的場次");
});

Deno.test("toCecCandidateRow：不分區立委 → region＝全國、sub_region＝不分區，候選人檔的當選記號照收", () => {
  // L4 的得票檔是逐黨不是逐人（沒有 cand_id），當選與否只在候選人檔
  const row = {
    cand_id: 908, cand_name: "韓國瑜", prv_code: "00", city_code: "000", area_code: "00",
    party_name: "中國國民黨", is_victor: "*", cand_birthday: "1957-06-17",
  };
  const out = toCecCandidateRow(row, undefined, { electionId: 2024, ourType: "立法委員", cecType: "LegislatorParty", themeId: "e753" });
  assertEquals(out?.region, "全國");
  assertEquals(out?.sub_region, "不分區");
  assertEquals(out?.elected, true);
  assertEquals(out?.election_type, "立法委員");
  const plain = toCecCandidateRow({ cand_id: 203565, cand_name: "陳瑩", prv_code: "00", city_code: "000", area_name: "全國" }, { cand_id: 203565, is_victor: "*" }, {
    electionId: 2024, ourType: "立法委員", cecType: "LegislatorPlainIndigenous", themeId: "9f38",
  });
  assertEquals([plain?.region, plain?.sub_region, plain?.elected], ["全國", "平地原住民", true]);
});

// ── 已投票的選舉（由 elections 表決定，#344 第二階段 A）──────────────────
const ELECTIONS = [
  { id: 2022, election_key: "2022-11-26_local", election_date: "2022-11-26", election_reason: "regular", election_types: ["縣市長", "縣市議員"] },
  { id: 4, election_key: "2022-12-18_rerun_10020", election_date: "2022-12-18", election_reason: "rerun", election_types: ["縣市長"] },
  { id: 2024, election_key: "2024-01-13_national", election_date: "2024-01-13", election_reason: "regular", election_types: ["總統副總統", "立法委員"] },
  { id: 2026, election_key: "2026-11-28_local", election_date: "2026-11-28", election_reason: "regular", election_types: ["縣市長"] },
  { id: 5, election_key: "2025-07-26_recall", election_date: "2025-07-26", election_reason: "recall", election_types: ["立法委員"] },
];

Deno.test("votedElections：2026 投票日之前只有 2022、重行選舉、2024（罷免投票不選人、不算）", () => {
  assertEquals(votedElections(ELECTIONS, new Date("2026-09-26T00:00:00Z")).map((e) => e.id), [2022, 4, 2024]);
  assertEquals(votedElections(ELECTIONS, new Date("2026-11-27T23:59:59Z")).map((e) => e.id), [2022, 4, 2024]);
  assertEquals(votedElections(ELECTIONS, new Date("2022-12-17T00:00:00Z")).map((e) => e.id), [2022], "重行選舉投票前不算");
});

Deno.test("votedElections：2026-11-28 投票日當天起算入 2026", () => {
  assertEquals(votedElections(ELECTIONS, new Date("2026-11-28T00:00:00Z")).map((e) => e.id), [2022, 4, 2024, 2026]);
  assertEquals(votedElections(ELECTIONS, new Date("2027-01-01T00:00:00Z")).map((e) => e.id), [2022, 4, 2024, 2026]);
});

Deno.test("electionAreaRegion：補選、重行選舉的 election_key 最後一段是行政區代碼；全國同日的沒有", () => {
  assertEquals(electionAreaRegion(ELECTIONS[1]), "嘉義市");
  assertEquals(electionAreaRegion({ election_key: "2027-03-06_by_66000" }), "台中市");
  assertEquals(electionAreaRegion({ election_key: "2027-03-06_by_09020" }), "金門縣", "金門 09020（中選會 09_020）");
  assertEquals(electionAreaRegion({ election_key: "2027-03-06_by_09007" }), "連江縣");
  assertEquals(electionAreaRegion(ELECTIONS[0]), null);
  assertEquals(electionAreaRegion(ELECTIONS[2]), null);
  assertEquals(electionAreaRegion({ election_key: "2027-03-06_by_99999" }), null, "對不到縣市的代碼不猜");
});

Deno.test("planElectionUnits：職位看 elections.election_types；重行選舉只同步它的那個縣市；沒有職位清單就全部", () => {
  const rerun = planElectionUnits(ELECTIONS[1]);
  assertEquals(rerun.map((u) => [u.ourType, u.plan.region, u.plan.cecType]), [["縣市長", "嘉義市", "CountyMayor"]]);
  const national = planElectionUnits(ELECTIONS[2]);
  assertEquals([...new Set(national.map((u) => u.ourType))], ["總統副總統", "立法委員"], "2024 不再去抓地方職位（以前這些單位都是『找不到場次』的失敗）");
  const local = planElectionUnits(ELECTIONS[0]);
  assertEquals([...new Set(local.map((u) => u.ourType))], ["縣市長", "縣市議員"]);
  assertEquals(local.filter((u) => u.ourType === "縣市長").length, 22);
  assertEquals(electionOurTypes({ election_types: [] }).length, 9, "沒有職位清單＝全部九種");
  assertEquals(planElectionUnits(ELECTIONS[0], ["縣市議員"]).every((u) => u.ourType === "縣市議員"), true, "--election_type 篩選");
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
    party_name: "中國國民黨",
  };
  const ticket = { cand_id: 12345, is_victor: "*", ticket_num: 88888, party_name: "中國國民黨" };
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
    party: "中國國民黨",
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
