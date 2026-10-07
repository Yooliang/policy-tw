/**
 * 2026 開票結果的自動進入路徑（2026-10-07，#332 選前必補第 1 項；migration 20261007220000）。
 *
 * 缺口：cron 的 cec-sync 只排 2022、2024、補選與重行選舉，沒有 2026。結果（當選／落選）進來的路徑是
 * cec-sync → cec_candidates（含當選記號）→ 投票日隔天起 election_results_missing 派工 → 代理核對＋系統票 → candidacy_status，
 * 第一環沒排程，後面全空轉。
 *
 * 勘查（10-07 唯讀）：中選會場次清單最新一筆還是 111 年；場次 id 是雜湊、事先猜不到，但 cec-sync 本來就用「投票日」對場次
 * （pickThemes），elections 表也已經有 2026 那一列，所以不必另做設定表，缺的只有排程。
 *
 * 這支測試守四件事：
 *   1. 場次一出現在清單上就自動接上（2026 那一列、投票日 2026-11-28；id 不當年份用）；沒出現就整個單位失敗、不刪不寫
 *   2. min_interval_hours 的解析（開票夜每小時重抓、不能短到轟炸中選會）
 *   3. migration：三條排程都先過 cec_sync_phase（投票前一個請求都不送）、職位與場次靠 elections 表（沒寫死 2026）、頻率邊界
 *   4. cec-sync/index.ts 真的用這個解析、不再有寫死的 24 小時常數
 * 排程 SQL 另外在 PGlite 用假時鐘整支跑過（投票前／開票夜／第 4 天／第 28 天各送出什麼，見 PR 說明）。
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import type { CecRow, FetchOutcome } from "./cec-static-fetch.ts";
import { SUBJECT_MAP } from "./cec-static-fetch.ts";
import {
  type CecFetchDeps,
  collectUnitRows,
  DEFAULT_MIN_INTERVAL_HOURS,
  MIN_INTERVAL_HOURS_FLOOR,
  parseMinIntervalHours,
  planElectionUnits,
  type SyncElection,
  type ThemeInfo,
  votedElections,
} from "./cec-sync.ts";

// ── 1. 場次靠投票日自動接上 ──────────────────────────────────────
const ELECTION_2026: SyncElection = {
  id: 2026, election_key: "2026-11-28_local", election_date: "2026-11-28", election_reason: "regular",
  election_types: ["縣市長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區長", "鄉鎮市民代表", "直轄市山地原住民區民代表", "村里長"],
};
const OLD_THEME: ThemeInfo = { themeId: "05cc7b904c7a30cc7c88d5b10898c98e", themeName: "111年直轄市長選舉", voteDate: "2022-11-26", year: 2022, legislatorTypeId: "00" };
const NEW_THEME: ThemeInfo = { themeId: "2026aaaabbbbccccddddeeeeffff0000", themeName: "115年直轄市長選舉", voteDate: "2026-11-28", year: 2026, legislatorTypeId: "00" };

function deps(themes: ThemeInfo[], files: Record<string, CecRow[]>): CecFetchDeps {
  return {
    themes: () => Promise.resolve(themes),
    fetchJson: (url): Promise<FetchOutcome> => {
      const key = url.replace(/^.*\/data\//, "").replace(/\.json$/, "");
      const hit = files[key];
      return Promise.resolve(hit ? { kind: "ok", url, rows: hit } : { kind: "nodata", url });
    },
  };
}
const mayorPlan = () => planElectionUnits(ELECTION_2026, ["縣市長"]).find((u) => u.plan.region === "台北市")!.plan;
const tail = (themeId: string) => `ELC/${SUBJECT_MAP.Mayor.subjectId}/${SUBJECT_MAP.Mayor.legisId}/${themeId}/${SUBJECT_MAP.Mayor.defaultLevel}/00_000_00_000_0000`;

Deno.test("2026：清單上還沒有 115 年的場次（今天的實況）→ 整個單位丟錯、不寫不刪，呼叫端保留舊資料", async () => {
  await assertRejects(
    () => collectUnitRows(ELECTION_2026, "縣市長", mayorPlan(), deps([OLD_THEME], {})),
    Error,
    "找不到投票日 2026-11-28 的 theme（cecType=Mayor）",
  );
});

Deno.test("2026：場次一出現在清單（投票日 2026-11-28）就自動接上，名單寫在 2026 那一列的 id 底下，當選記號照收", async () => {
  const files = {
    [`candidates/${tail(NEW_THEME.themeId)}`]: [
      { cand_id: 1, cand_name: "甲", cand_no: 1, party_name: "無黨籍及未經政黨推薦", cand_birthyear: "1970", area_name: "臺北市", prv_code: "63", city_code: "000" },
      { cand_id: 2, cand_name: "乙", cand_no: 2, party_name: "某黨", cand_birthyear: "1975", area_name: "臺北市", prv_code: "63", city_code: "000" },
    ] as CecRow[],
    [`tickets/${tail(NEW_THEME.themeId)}`]: [
      { cand_id: 1, ticket_num: 100, is_victor: " ", area_name: "臺北市", prv_code: "63", city_code: "000" },
      { cand_id: 2, ticket_num: 300, is_victor: "*", area_name: "臺北市", prv_code: "63", city_code: "000" },
    ] as CecRow[],
  };
  const got = await collectUnitRows(ELECTION_2026, "縣市長", mayorPlan(), deps([OLD_THEME, NEW_THEME], files));
  assertEquals(got.rows.length, 2);
  assert(got.rows.every((r) => r.election_id === 2026 && r.election_type === "縣市長" && r.region === "台北市" && r.cec_theme_id === NEW_THEME.themeId));
  assertEquals(got.rows.map((r) => [r.name, r.elected]), [["甲", false], ["乙", true]]);
});

Deno.test("場次不看 id：非年份的 id（例如之後的補選、2028）一樣用投票日對場次", async () => {
  const e: SyncElection = { ...ELECTION_2026, id: 7, election_key: "2028-11-25_local", election_date: "2028-11-25" };
  const t: ThemeInfo = { ...NEW_THEME, themeId: "2028t", voteDate: "2028-11-25", year: 2028 };
  const plan = planElectionUnits(e, ["縣市長"]).find((u) => u.plan.region === "台北市")!.plan;
  const got = await collectUnitRows(e, "縣市長", plan, deps([t], { [`candidates/${tail("2028t")}`]: [{ cand_id: 9, cand_name: "丙", area_name: "臺北市", prv_code: "63", city_code: "000" }] as CecRow[] }));
  assertEquals(got.rows.map((r) => [r.election_id, r.cec_theme_id]), [[7, "2028t"]]);
});

Deno.test("votedElections：2026 投票日 UTC 00:00 起算入 2026（cec-sync 本身的擋法；排程另在 08:00 UTC 投票結束後才送）", () => {
  const all = [ELECTION_2026];
  assertEquals(votedElections(all, new Date("2026-11-27T23:59:59Z")).length, 0);
  assertEquals(votedElections(all, new Date("2026-11-28T00:00:00Z")).length, 1);
});

// ── 2. min_interval_hours ────────────────────────────────────────
Deno.test("parseMinIntervalHours：沒給＝24 小時；開票夜的 1、5 收；超出 0.25～24 或不是數字回錯誤，不靜默改回預設", () => {
  assertEquals(parseMinIntervalHours(undefined), { ok: true, hours: 24 });
  assertEquals(parseMinIntervalHours(null), { ok: true, hours: 24 });
  assertEquals(parseMinIntervalHours(""), { ok: true, hours: 24 });
  assertEquals(parseMinIntervalHours(1), { ok: true, hours: 1 });
  assertEquals(parseMinIntervalHours("5"), { ok: true, hours: 5 });
  assertEquals(parseMinIntervalHours("0.5"), { ok: true, hours: 0.5 });
  assertEquals(parseMinIntervalHours(MIN_INTERVAL_HOURS_FLOOR), { ok: true, hours: 0.25 });
  assertEquals(parseMinIntervalHours(DEFAULT_MIN_INTERVAL_HOURS), { ok: true, hours: 24 });
  for (const bad of [0, 0.1, -1, 25, 1000, "abc", "1h", "1e3", NaN, Infinity, true, {}, []]) {
    const r = parseMinIntervalHours(bad);
    assertEquals(r.ok, false, `${JSON.stringify(bad)} 不該收`);
  }
});

Deno.test("cec-sync/index.ts：min_interval_hours 走 parseMinIntervalHours、跳過檢查用它；不再有寫死的 24 小時常數", async () => {
  const src = await Deno.readTextFile(new URL("../cec-sync/index.ts", import.meta.url));
  assertStringIncludes(src, 'parseMinIntervalHours(qp("min_interval_hours"))');
  assertStringIncludes(src, "< minIntervalHours * 3600_000");
  assert(!/const MIN_INTERVAL_HOURS\s*=/.test(src), "寫死的 MIN_INTERVAL_HOURS 常數要拿掉，不然排程帶的值沒用");
  assert(!/\bMIN_INTERVAL_HOURS \* 3600_000/.test(src));
});

// ── 3. migration：排程 ───────────────────────────────────────────
const MIG = await Deno.readTextFile(new URL("../../migrations/20261007220000_cec_sync_2026_schedule.sql", import.meta.url));
/** 只看 SQL 本體：去掉 -- 註解（說明文字裡會提到 2022／2026） */
const SQL = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const jobBody = (name: string) => {
  const m = SQL.match(new RegExp(`cron\\.schedule\\('${name}',\\s*'([^']+)',\\s*\\$\\$([\\s\\S]*?)\\$\\$\\)`));
  assert(m, `找不到排程 ${name}`);
  return { schedule: m[1], body: m[2].replace(/\s+/g, " ") };
};

Deno.test("migration：三條排程都在，頻率對（開票夜 10 分鐘、之後 6 小時、再之後週六 19:00 起每 5 分鐘接續）", () => {
  assertEquals(jobBody("cec-sync-live-10min").schedule, "*/10 * * * *");
  assertEquals(jobBody("cec-sync-settle-6h").schedule, "20 */6 * * *");
  assertEquals(jobBody("cec-sync-weekly").schedule, "0,5,10,15,20 19 * * 6");
});

Deno.test("migration：每條排程都先過 cec_sync_phase——投票前一個請求都不送；而且各自只接自己那一層", () => {
  assertStringIncludes(jobBody("cec-sync-live-10min").body, "WHERE cec_sync_phase(e.election_date, e.election_reason) = 'live'");
  assertStringIncludes(jobBody("cec-sync-settle-6h").body, "WHERE cec_sync_phase(e.election_date, e.election_reason) = 'settle'");
  const weekly = jobBody("cec-sync-weekly").body;
  assertStringIncludes(weekly, "cec_sync_phase(e.election_date, e.election_reason) = 'weekly'");
  // 2022、2024 有自己的既有週排程（硬寫屆別）、補選重行選舉有 cec-sync-offcycle-weekly；這條只接 2026 年以後的定期選舉，不然會跟它們同時打同一批單位
  assertStringIncludes(weekly, "e.election_reason = 'regular' AND e.election_date >= DATE '2026-01-01'");
});

Deno.test("migration：選舉與職位由 elections 表驅動，排程本體沒有寫死 2026（之後的選舉不用再加排程）", () => {
  for (const name of ["cec-sync-live-10min", "cec-sync-settle-6h", "cec-sync-weekly"]) {
    const { body } = jobBody(name);
    assertStringIncludes(body, "FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t");
    assertStringIncludes(body, "jsonb_build_object('election_id', e.id, 'election_type', t");
    assert(!/\b(2022|2024|2026)\b/.test(body.replace("DATE '2026-01-01'", "")), `${name} 不能寫死屆別`);
  }
});

Deno.test("migration：開票夜每小時重抓、之後每 5 小時；週排程維持預設 24 小時（不帶 min_interval_hours）", () => {
  assertStringIncludes(jobBody("cec-sync-live-10min").body, "'min_interval_hours', 1)");
  assertStringIncludes(jobBody("cec-sync-settle-6h").body, "'min_interval_hours', 5)");
  assert(!jobBody("cec-sync-weekly").body.includes("min_interval_hours"));
});

Deno.test("migration：cec_sync_phase 的邊界＝投票日 08:00 UTC（台灣 16:00 投票結束）起 3 天 live、到第 14 天 settle、之後 weekly；罷免不選人", () => {
  const f = SQL.replace(/\s+/g, " ");
  assertStringIncludes(f, "((p_election_date + TIME '08:00') AT TIME ZONE 'UTC')");
  assertStringIncludes(f, "WHEN p_election_date IS NULL OR p_reason = 'recall' THEN NULL");
  assertStringIncludes(f, "WHEN p_now < x.polls_close THEN NULL");
  assertStringIncludes(f, "WHEN p_now < x.polls_close + INTERVAL '3 days' THEN 'live'");
  assertStringIncludes(f, "WHEN p_now < x.polls_close + INTERVAL '14 days' THEN 'settle'");
  assertStringIncludes(f, "ELSE 'weekly'");
});

Deno.test("migration：重跑安全（先 unschedule 同名排程）；沒有碰既有的 2022／2024／補選排程", () => {
  assertStringIncludes(SQL, "SELECT cron.unschedule(j) FROM unnest(ARRAY['cec-sync-live-10min', 'cec-sync-settle-6h', 'cec-sync-weekly']) j");
  for (const existing of ["cec-sync-2022-weekly", "cec-sync-2024-weekly", "cec-sync-2022-rest", "cec-sync-2022-village-rest", "cec-sync-offcycle-weekly", "cec-reconcile-weekly"]) {
    assert(!SQL.includes(existing), `不該動既有排程 ${existing}`);
  }
});

Deno.test("migration：檢查視圖 cec_sync_status 開給 anon／authenticated 讀、用 invoker 權限", () => {
  assertStringIncludes(SQL, "ALTER VIEW cec_sync_status SET (security_invoker = on)");
  assertStringIncludes(SQL, "GRANT SELECT ON cec_sync_status TO anon, authenticated");
});
