/**
 * #344 第二階段 A：交件允許的選舉、election_key、政見提出日期、登記截止日，都以資料庫的 elections／roster_check_scope 為準，
 * 不再寫死 2022／2024／2026，也不再把 election_id 當年份。
 *
 * 執行：cd supabase/functions && deno test --allow-read _shared/elections.test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type ElectionRef, FALLBACK_ELECTIONS, validateContributionRequest } from "./contribution-schema.ts";
import {
  clearElectionCaches,
  deadlinesFromScope,
  electionLabel,
  loadElections,
  loadRegistrationDeadlines,
  registrationDeadlineOf,
  withElectionKey,
} from "./elections.ts";
import { registrationEvidenceOk } from "./candidacy-guards.ts";

const AGENT = "xiaoliang-test";
const CNA = "https://www.cna.com.tw/news/aipl/202609045002.aspx";
// 線上現況：三屆＋2022-12-18 嘉義市長重行選舉（id 4，不是年份）＋一場假想的 2027 補選（id 5）
const ELECTIONS: ElectionRef[] = [
  { id: 4, election_key: "2022-12-18_rerun_10020", election_date: "2022-12-18" },
  { id: 5, election_key: "2027-03-06_by_66000", election_date: "2027-03-06" },
  ...FALLBACK_ELECTIONS,
];
const candidacy = (electionFields: Record<string, unknown>) => ({
  agent_name: AGENT,
  contribution_type: "candidacy",
  payload: { name: "李俊俋", party: "民主進步黨", region: "嘉義市", election_type: "縣市長", candidate_status: "registered", ...electionFields },
  source_urls: [CNA],
});
const paths = (r: { errors: Array<{ path: string }> }) => r.errors.map((e) => e.path);

Deno.test("允許的選舉 id 以傳進來的 elections 為準：新增的選舉（id 4、5 不是年份）收得下；清單外的擋下", () => {
  assertEquals(validateContributionRequest(candidacy({ election_id: 4 }), ELECTIONS).errors.length, 0);
  assertEquals(validateContributionRequest(candidacy({ election_id: 5 }), ELECTIONS).errors.length, 0);
  assertEquals(validateContributionRequest(candidacy({ election_id: 2026 }), ELECTIONS).errors.length, 0);
  const bad = validateContributionRequest(candidacy({ election_id: 6 }), ELECTIONS);
  assertEquals(paths(bad), ["payload.election_id"]);
  assert(bad.errors[0].message.includes("election_key"), "訊息教代理改用 election_key");
  assert(bad.errors[0].message.includes("2022-12-18_rerun_10020"), "列出現有的 election_key");
  // 沒傳清單（離線、單元測試）退回舊三屆：4 不認得
  assertEquals(paths(validateContributionRequest(candidacy({ election_id: 4 }))), ["payload.election_id"]);
  assertEquals(validateContributionRequest(candidacy({ election_id: 2022 })).errors.length, 0);
});

Deno.test("election_key：換成 election_id 再驗；兩個都給要一致；不認得的 key 擋下；驗證完還原（不跨請求殘留）", () => {
  const ok = validateContributionRequest(candidacy({ election_key: "2022-12-18_rerun_10020" }), ELECTIONS);
  assertEquals(ok.errors.length, 0);
  assertEquals((ok.items[0].payload as Record<string, unknown>).election_id, 4);
  assertEquals("election_key" in (ok.items[0].payload as Record<string, unknown>), false, "落庫與去重只認整數 id，key 不留在 payload");

  assertEquals(validateContributionRequest(candidacy({ election_key: "2022-12-18_rerun_10020", election_id: 4 }), ELECTIONS).errors.length, 0);
  const mismatch = validateContributionRequest(candidacy({ election_key: "2022-12-18_rerun_10020", election_id: 2022 }), ELECTIONS);
  assertEquals(paths(mismatch), ["payload.election_key"]);
  assert(mismatch.errors[0].message.includes("不一致"));

  const unknown = validateContributionRequest(candidacy({ election_key: "2030-01-01_local" }), ELECTIONS);
  assert(paths(unknown).includes("payload.election_key"));

  // 驗證完還原：下一個沒帶清單的呼叫不能還認得上一次傳進來的 id 5
  assertEquals(paths(validateContributionRequest(candidacy({ election_id: 5 }))), ["payload.election_id"]);
});

Deno.test("election_key 也能用在 policy、roster_check、correction 改 policies.election_id、交接的 from／to", () => {
  const policy = validateContributionRequest({
    agent_name: AGENT, contribution_type: "policy", source_urls: [CNA],
    payload: { name: "李俊俋", title: "增設公托設施", description: "增設公共托育設施，減輕雙薪家庭育兒負擔，嘉義市每個行政區至少一處。", category: "社會福利", election_key: "2022-12-18_rerun_10020" },
  }, ELECTIONS);
  assertEquals(policy.errors.length, 0);
  assertEquals((policy.items[0].payload as Record<string, unknown>).election_id, 4);

  const correction = validateContributionRequest({
    agent_name: AGENT, contribution_type: "correction", source_urls: [CNA],
    payload: {
      target_table: "policies", target_id: "00000000-0000-4000-8000-000000000001", reason: "這條政見是重行選舉時提出的",
      changes: [{ field: "election_id", correct_value: "2022-12-18_rerun_10020" }],
    },
  }, ELECTIONS);
  assertEquals(correction.errors.length, 0, JSON.stringify(correction.errors));
  assertEquals((correction.items[0].payload as { changes: Array<{ correct_value: unknown }> }).changes[0].correct_value, 4);
});

Deno.test("政見提出日期：屆別年份看投票日（election_date），不把 election_id 當年份", () => {
  const policy = (electionFields: Record<string, unknown>, proposed_date: string, status?: string) => validateContributionRequest({
    agent_name: AGENT, contribution_type: "policy", source_urls: [CNA],
    payload: { name: "李俊俋", title: "增設公托設施", description: "增設公共托育設施，減輕雙薪家庭育兒負擔，嘉義市每個行政區至少一處。", category: "社會福利", proposed_date, ...(status ? { status } : {}), ...electionFields },
  }, ELECTIONS);
  // id 4 若被當成年份，2022-12 的提出日期會被判成「晚於 4 年」擋下；實際上重行選舉在 2022-12-18 投票，同年的日期放行
  assertEquals(policy({ election_id: 4 }, "2022-12-01").errors.length, 0);
  // 2023 年才提出的競選承諾，不可能是 2022 年投票的那場選舉的
  assertEquals(paths(policy({ election_id: 4 }, "2023-02-01")), ["payload.proposed_date"]);
  // 補選（2027-03-06）：還沒投票、提出日期在投票年之前的放行；任內施政承諾（status 非 Campaign Pledge）不受限
  assertEquals(policy({ election_id: 5 }, "2026-09-01").errors.length, 0);
  assertEquals(policy({ election_id: 4 }, "2023-02-01", "Proposed").errors.length, 0);
  // 三屆照舊
  assertEquals(paths(policy({ election_id: 2024 }, "2026-09-11")), ["payload.proposed_date"]);
  assertEquals(policy({ election_id: 2024 }, "2023-12-01").errors.length, 0);
});

Deno.test("登記截止日：由 roster_check_scope 算出來，沒有就不擋；職位有單獨的截止日就用它", () => {
  const d = deadlinesFromScope([
    { election_id: 2026, election_type: "縣市長", registration_closed_on: "2026-09-04" },
    { election_id: 2026, election_type: "縣市議員", registration_closed_on: "2026-09-04" },
    { election_id: 2026, election_type: "村里長", registration_closed_on: "2026-09-10" },
    { election_id: 2022, election_type: "縣市長", registration_closed_on: null },
  ]);
  assertEquals(registrationDeadlineOf(d, 2026, "縣市長"), "2026-09-04");
  assertEquals(registrationDeadlineOf(d, 2026, "村里長"), "2026-09-10", "職位單獨的截止日");
  assertEquals(registrationDeadlineOf(d, 2026, "鄉鎮市長"), "2026-09-04", "這個職位沒列就用整屆最早的那天");
  assertEquals(registrationDeadlineOf(d, 2026), "2026-09-04");
  assertEquals(registrationDeadlineOf(d, 2022, "縣市長"), undefined, "沒有截止日的屆別不擋");
  assertEquals(registrationDeadlineOf(d, null), undefined);
  assertEquals(registrationEvidenceOk(["https://x.example/a"], registrationDeadlineOf(d, 2022, "縣市長"), "2026-10-01"), true);
  assertEquals(registrationEvidenceOk(["https://x.example/a"], registrationDeadlineOf(d, 2026, "縣市長"), "2026-10-01"), false);
});

Deno.test("loadElections：查 elections 表、快取一分鐘；查不到退回舊三屆（不讓端點掛掉）", async () => {
  clearElectionCaches();
  let calls = 0;
  const ok = {
    from: (_t: string) => ({
      select: () => ({
        order: () => ({
          limit: async () => {
            calls++;
            return { data: [{ id: 4, election_key: "2022-12-18_rerun_10020", election_date: "2022-12-18", short_name: "2022 嘉義市長重行選舉" }, { id: 2022, election_key: "2022-11-26_local", election_date: "2022-11-26", short_name: "2022 九合一選舉" }], error: null };
          },
        }),
      }),
    }),
  };
  const first = await loadElections(ok);
  assertEquals(first.map((e) => e.id), [4, 2022]);
  await loadElections(ok);
  assertEquals(calls, 1, "一分鐘內不重查");
  assertEquals(electionLabel(first, 4), "2022 嘉義市長重行選舉");
  assertEquals(electionLabel(first, 99), "選舉 99", "不認得的不印成年份");
  assertEquals(electionLabel(first, null), "（未指定選舉）");

  clearElectionCaches();
  const broken = { from: () => { throw new Error("boom"); } };
  const fallback = await loadElections(broken);
  assertEquals(fallback.map((e) => e.id), [2022, 2024, 2026]);
  clearElectionCaches();
});

Deno.test("loadRegistrationDeadlines：查不到退回舊的後備（2026-09-04），不讓守門整個失效", async () => {
  clearElectionCaches();
  const broken = { from: () => { throw new Error("boom"); } };
  const d = await loadRegistrationDeadlines(broken);
  assertEquals(registrationDeadlineOf(d, 2026, "縣市長"), "2026-09-04");
  clearElectionCaches();
  const empty = { from: () => ({ select: () => ({ not: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) };
  assertEquals(registrationDeadlineOf(await loadRegistrationDeadlines(empty), 2026), undefined, "表是空的就是沒有截止日（不是出錯）");
  clearElectionCaches();
});

Deno.test("withElectionKey：任務 target 帶 election_id 就補上 election_key（只補給代理看的那份，不動原物件）", () => {
  const target = { election_id: 4, region: "嘉義市" };
  const out = withElectionKey(target, ELECTIONS) as Record<string, unknown>;
  assertEquals(out.election_key, "2022-12-18_rerun_10020");
  assertEquals("election_key" in target, false);
  assertEquals(withElectionKey({ election_id: 2026 }, ELECTIONS), { election_id: 2026, election_key: "2026-11-28_local" });
  assertEquals(withElectionKey({ election_id: 99 }, ELECTIONS), { election_id: 99 }, "查不到不補");
  assertEquals(withElectionKey({ region: "嘉義市" }, ELECTIONS), { region: "嘉義市" });
  assertEquals(withElectionKey(null, ELECTIONS), null);
  assertEquals(withElectionKey({ election_id: 4, election_key: "x" }, ELECTIONS), { election_id: 4, election_key: "x" }, "已經有的不覆蓋");
});
