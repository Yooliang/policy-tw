/**
 * cec-sync 抓齊議員、鄉鎮市民代表的原住民選區，與嘉義市 2022 縣市長重行選舉（2026-10-05）。
 *
 * 根因跟 #357 的立委同一種：中選會同一屆同一種選舉在清單裡不只一筆場次，
 *   - 議員（ELC_T1／ELC_T2）：T1 區域、T2 平地原住民、T3 山地原住民
 *   - 鄉鎮市民代表（ELC_R2）：R1 區域、R2 平地原住民
 *   - 縣市長（ELC_C2）：111年縣市長選舉、111年嘉義市長重行選舉（11-26 那筆的全國檔裡沒有嘉義市）
 * cec-sync 的 pickTheme 只取「該年第一筆」，所以 2022 議員原住民選區 153 人、代表平地原住民選區 134 人、
 * 嘉義市長 4 人一位都沒進 cec_candidates。
 *
 * 清單用中選會 10-05 的實際內容（fixtures/cec-theme-lists-2026-10-05.json，2018～2024 的場次節錄）。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { CecRow, FetchOutcome } from "./cec-static-fetch.ts";
import { SUBJECT_MAP } from "./cec-static-fetch.ts";
import {
  type CecFetchDeps,
  collectUnitRows,
  ourElectionType,
  pickThemes,
  planUnits,
  type ThemeInfo,
  themesFromList,
  toCecCandidateRow,
} from "./cec-sync.ts";

const LISTS = JSON.parse(await Deno.readTextFile(new URL("./fixtures/cec-theme-lists-2026-10-05.json", import.meta.url))) as Record<string, unknown[]>;
const themesOf = (subjectId: string): ThemeInfo[] => themesFromList(LISTS[subjectId] ?? []);
const D2022 = "2022-11-26";
const D2024 = "2024-01-13";
// 選舉：場次用投票日對、寫進 cec_candidates 的是 elections.id（#344 第二階段 A）。2022-12-18 嘉義市長重行選舉是自己的一場（id 4，不是年份）
const E2022 = { id: 2022, election_date: D2022 };
const E_RERUN = { id: 4, election_date: "2022-12-18" };
const themeIdFor = (cecType: string, voteDate: string) => pickThemes(themesOf(SUBJECT_MAP[cecType].subjectId), voteDate, SUBJECT_MAP[cecType])[0]?.themeId;

// ── 單位規劃 ─────────────────────────────────────────────────────
Deno.test("planUnits：縣市議員每個縣市都連平地、山地原住民選區一起抓（同一個同步範圍），而且都歸「縣市議員」", () => {
  const units = planUnits("縣市議員");
  assertEquals(units.length, 22);
  for (const u of units) {
    const extras = u.extraCecTypes ?? [];
    assertEquals(extras.length, 2, `${u.region} 少了原住民選區`);
    for (const t of [u.cecType, ...extras]) {
      assertEquals(ourElectionType(t), "縣市議員", t);
      // 同一個單位的科目要在同一份清單（直轄市 T1、縣市 T2），不然場次對不起來
      assertEquals(SUBJECT_MAP[t].subjectId, SUBJECT_MAP[u.cecType].subjectId, `${u.region} ${t}`);
    }
    assertEquals(new Set(extras.map((t) => SUBJECT_MAP[t].legisId)), new Set(["T2", "T3"]));
  }
  assertEquals(units.find((u) => u.region === "台北市")?.extraCecTypes, ["CouncilMemberPlainIndigenous", "CouncilMemberMountainIndigenous"]);
  assertEquals(units.find((u) => u.region === "花蓮縣")?.extraCecTypes, ["CountyCouncilMemberPlainIndigenous", "CountyCouncilMemberMountainIndigenous"]);
});

Deno.test("planUnits：鄉鎮市民代表連平地原住民選區一起抓；其他選舉別沒有多的科目", () => {
  for (const u of planUnits("鄉鎮市民代表")) {
    assertEquals(u.extraCecTypes, ["CityRepresentativesPlainIndigenous"]);
    assertEquals(ourElectionType("CityRepresentativesPlainIndigenous"), "鄉鎮市民代表");
    assertEquals(SUBJECT_MAP.CityRepresentativesPlainIndigenous.subjectId, SUBJECT_MAP[u.cecType].subjectId);
  }
  for (const t of ["總統副總統", "立法委員", "縣市長", "鄉鎮市長", "直轄市山地原住民區長", "直轄市山地原住民區民代表", "村里長"]) {
    assertEquals(planUnits(t).every((u) => !u.extraCecTypes?.length), true, t);
  }
});

// ── 挑場次：用中選會 10-05 的實際清單 ─────────────────────────────
Deno.test("pickThemes：議員、代表的區域與原住民選區同屆同日同一份清單，要用 legislator_type_id 挑（實際清單）", () => {
  assertEquals(themeIdFor("CouncilMember", D2022), "25e12c45f9f5641aab4193598d5aff6e"); // 111年直轄市議員選舉 區域
  assertEquals(themeIdFor("CouncilMemberPlainIndigenous", D2022), "44cf35b1708568b94bb3b4c38a3fc74c");
  assertEquals(themeIdFor("CouncilMemberMountainIndigenous", D2022), "699b1ece9739edf4ec4662cea25a0bb3");
  assertEquals(themeIdFor("CountyCouncilMember", D2022), "72976331a1ea6b85cfb1ed3380ae5f35"); // 111年縣市議員選舉 區域
  assertEquals(themeIdFor("CountyCouncilMemberPlainIndigenous", D2022), "c8f4dc82f282bed4ebcdf0f52552cf58");
  assertEquals(themeIdFor("CountyCouncilMemberMountainIndigenous", D2022), "4ad215cf6c4ef28b25278bd1a13bc7bf");
  assertEquals(themeIdFor("CityRepresentatives", D2022), "ca0467b0c2645f87fa3589a51eccc221");
  assertEquals(themeIdFor("CityRepresentativesPlainIndigenous", D2022), "17d56dd1b9d6a5cac41513c443ca1569");
  // 直轄市區民代表的清單只有一筆、種類寫 R3（科目的 legisId 也是 R3）
  assertEquals(themeIdFor("DistrictRepresentatives", D2022), "d2aa09058066659f5b69af53ed16ccfa");
});

Deno.test("pickThemes：已投票屆別的每一個同步單位、每一個科目，在實際清單裡都挑得到場次（科目代碼對不上清單會整個單位失敗）", () => {
  const byYear: Record<string, string[]> = {
    [D2022]: ["縣市長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區長", "鄉鎮市民代表", "直轄市山地原住民區民代表", "村里長"],
    [D2024]: ["總統副總統", "立法委員"],
  };
  for (const [year, types] of Object.entries(byYear)) {
    for (const ourType of types) {
      for (const u of planUnits(ourType)) {
        for (const cecType of [u.cecType, ...(u.extraCecTypes ?? [])]) {
          const picked = pickThemes(themesOf(SUBJECT_MAP[cecType].subjectId), year, SUBJECT_MAP[cecType]);
          assert(picked.length > 0, `${year} ${ourType} ${u.region} ${cecType} 挑不到場次`);
        }
      }
    }
  }
});

Deno.test("pickThemes：嘉義市 2022 縣市長——11-26 那場只挑到一般那筆，重行選舉（12-18）是另一場、挑到自己的那筆", () => {
  assertEquals(pickThemes(themesOf("C2"), D2022, SUBJECT_MAP.CountyMayor).map((t) => t.themeName), ["111年縣市長選舉"]);
  assertEquals(pickThemes(themesOf("C2"), "2022-12-18", SUBJECT_MAP.CountyMayor).map((t) => t.themeName), ["111年嘉義市長重行選舉"]);
});

// ── 抓一個單位：假的中選會 ────────────────────────────────────────
type Files = Record<string, CecRow[] | "error">;

/** 依網址回假資料：key 是網址裡「/candidates/ELC/...」之後那一段的開頭（科目/種類/場次/層級/範圍） */
function fakeDeps(files: Files): CecFetchDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    themes: (cecType) => Promise.resolve(themesOf(SUBJECT_MAP[cecType].subjectId)),
    fetchJson: (url): Promise<FetchOutcome> => {
      calls.push(url);
      const key = url.replace(/^.*\/data\//, "").replace(/\.json$/, "");
      const hit = files[key];
      if (hit === "error") return Promise.resolve({ kind: "error", url, message: "HTTP 500" });
      if (!hit) return Promise.resolve({ kind: "nodata", url });
      return Promise.resolve({ kind: "ok", url, rows: hit });
    },
  };
}

const T1_MAIN = "25e12c45f9f5641aab4193598d5aff6e";
const T1_PLAIN = "44cf35b1708568b94bb3b4c38a3fc74c";
const T1_MOUNTAIN = "699b1ece9739edf4ec4662cea25a0bb3";

Deno.test("collectUnitRows：台北市議員＝區域＋平地＋山地原住民選區一次寫齊，選區號碼原樣進 sub_region、選舉別都是縣市議員", async () => {
  const deps = fakeDeps({
    [`candidates/ELC/T1/T1/${T1_MAIN}/A/63_000_00_000_0000`]: [
      { cand_id: 1, cand_name: "林延鳳", area_name: "第01選舉區", prv_code: "63", city_code: "000", is_victor: "*" },
    ],
    [`tickets/ELC/T1/T1/${T1_MAIN}/A/63_000_00_000_0000`]: [{ cand_id: 1, is_victor: "*" }],
    [`candidates/ELC/T1/T2/${T1_PLAIN}/A/63_000_00_000_0000`]: [
      { cand_id: 164433, cand_name: "吳郁瑾 Sawmah Kawlo", area_name: "第07選舉區", prv_code: "63", city_code: "000", is_victor: " " },
      { cand_id: 164434, cand_name: "李芳儒", area_name: "第07選舉區", prv_code: "63", city_code: "000", is_victor: "*" },
    ],
    [`candidates/ELC/T1/T3/${T1_MOUNTAIN}/A/63_000_00_000_0000`]: [
      { cand_id: 164403, cand_name: "李傅中武", area_name: "第08選舉區", prv_code: "63", city_code: "000", is_victor: "*" },
    ],
  });
  const plan = planUnits("縣市議員").find((u) => u.region === "台北市")!;
  const got = await collectUnitRows(E2022, "縣市議員", plan, deps);
  assertEquals(got.rows.map((r) => [r.sub_region, r.name_norm, r.elected, r.election_type, r.cec_theme_id]), [
    ["第01選舉區", "林延鳳", true, "縣市議員", T1_MAIN],
    ["第07選舉區", "吳郁瑾", false, "縣市議員", T1_PLAIN],
    ["第07選舉區", "李芳儒", true, "縣市議員", T1_PLAIN],
    ["第08選舉區", "李傅中武", true, "縣市議員", T1_MOUNTAIN],
  ]);
  assertEquals(got.rows.every((r) => r.region === "台北市"), true);
  assertEquals(got.parts.map((p) => p.cecType), ["CouncilMember", "CouncilMemberPlainIndigenous", "CouncilMemberMountainIndigenous"]);
});

Deno.test("collectUnitRows：沒有原住民選區的縣市（兩個檔都 404）→ 只寫區域選區，不算失敗", async () => {
  const main = themeIdFor("CountyCouncilMember", D2022);
  const deps = fakeDeps({
    [`candidates/ELC/T2/T1/${main}/A/10_016_00_000_0000`]: [
      { cand_id: 5, cand_name: "澎湖甲", area_name: "第01選舉區", prv_code: "10", city_code: "016", is_victor: "*" },
    ],
  });
  const plan = planUnits("縣市議員").find((u) => u.region === "澎湖縣")!;
  const got = await collectUnitRows(E2022, "縣市議員", plan, deps);
  assertEquals(got.rows.length, 1);
  assertEquals(got.parts.map((p) => p.rows.length), [1, 0, 0]);
});

Deno.test("collectUnitRows：原住民選區的檔抓失敗（不是 404）→ 整個單位丟錯，呼叫端保留舊資料、不先刪", async () => {
  const deps = fakeDeps({
    [`candidates/ELC/T1/T1/${T1_MAIN}/A/63_000_00_000_0000`]: [
      { cand_id: 1, cand_name: "林延鳳", area_name: "第01選舉區", prv_code: "63", city_code: "000", is_victor: "*" },
    ],
    [`candidates/ELC/T1/T2/${T1_PLAIN}/A/63_000_00_000_0000`]: "error",
  });
  const plan = planUnits("縣市議員").find((u) => u.region === "台北市")!;
  await assertRejects(() => collectUnitRows(E2022, "縣市議員", plan, deps), Error, "candidates");
});

Deno.test("collectUnitRows：原住民選區在清單裡找不到場次 → 整個單位丟錯（不能當成沒有人）", async () => {
  const deps = fakeDeps({});
  // 清單只剩區域那筆
  deps.themes = () => Promise.resolve(themesOf("T1").filter((t) => t.legislatorTypeId === "T1"));
  const plan = planUnits("縣市議員").find((u) => u.region === "台北市")!;
  await assertRejects(() => collectUnitRows(E2022, "縣市議員", plan, deps), Error, "找不到投票日 2022-11-26 的 theme（cecType=CouncilMemberPlainIndigenous）");
});

Deno.test("collectUnitRows：嘉義市 2022 縣市長重行選舉（id 4、12-18）用自己的場次，名單寫在它自己的 election_id 底下", async () => {
  const main = themeIdFor("CountyMayor", D2022)!;
  const redo = themeIdFor("CountyMayor", "2022-12-18")!;
  assert(main !== redo);
  const deps = fakeDeps({
    [`candidates/ELC/C2/00/${main}/C/00_000_00_000_0000`]: [
      { cand_id: 10, cand_name: "王惠美", area_name: "彰化縣", prv_code: "10", city_code: "007", is_victor: "*" },
    ],
    [`candidates/ELC/C2/00/${redo}/C/00_000_00_000_0000`]: [
      { cand_id: 181862, cand_name: "黃敏惠", area_name: "嘉義市", prv_code: "10", city_code: "020", is_victor: "*" },
      { cand_id: 181863, cand_name: "李俊俋", area_name: "嘉義市", prv_code: "10", city_code: "020", is_victor: " " },
    ],
  });
  const chiayi = planUnits("縣市長").find((u) => u.region === "嘉義市")!;
  const got = await collectUnitRows(E_RERUN, "縣市長", chiayi, deps);
  assertEquals(got.rows.map((r) => [r.region, r.name, r.elected, r.cec_theme_id, r.election_id]), [
    ["嘉義市", "黃敏惠", true, redo, 4],
    ["嘉義市", "李俊俋", false, redo, 4],
  ]);
  assertEquals(deps.calls.some((u) => u.includes(main)), false, "不碰 11-26 那一場");
  // 11-26 那一場（2022）：其他縣市照舊，場次是一般那筆；嘉義市在那一場的檔裡本來就沒有人
  const changhua = planUnits("縣市長").find((u) => u.region === "彰化縣")!;
  const deps2 = fakeDeps({
    [`candidates/ELC/C2/00/${main}/C/00_000_00_000_0000`]: [
      { cand_id: 10, cand_name: "王惠美", area_name: "彰化縣", prv_code: "10", city_code: "007", is_victor: "*" },
    ],
  });
  const got2 = await collectUnitRows(E2022, "縣市長", changhua, deps2);
  assertEquals(got2.rows.map((r) => [r.cec_theme_id, r.election_id]), [[main, 2022]]);
  assertEquals(deps2.calls.some((u) => u.includes(redo)), false);
});

Deno.test("toCecCandidateRow：代表的平地原住民選區只有得票檔，選區名照原樣（豐濱鄉第02選舉區），縣市由代碼來", () => {
  const ticket = { cand_id: 162738, cand_name: "吳素英", area_name: "豐濱鄉第02選舉區", prv_code: "10", city_code: "015", is_victor: "*" };
  const out = toCecCandidateRow(ticket, ticket, {
    electionId: 2022, ourType: "鄉鎮市民代表", cecType: "CityRepresentativesPlainIndigenous", themeId: "17d5", requestedRegion: "花蓮縣",
  });
  assertEquals([out?.region, out?.sub_region, out?.election_type, out?.elected], ["花蓮縣", "豐濱鄉第02選舉區", "鄉鎮市民代表", true]);
});
