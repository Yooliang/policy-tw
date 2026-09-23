import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { validateContributionRequest } from "./contribution-schema.ts";
import { TASK_GUIDANCE } from "./task-guidance.ts";

// 2026-09-23 小良哥：賴清德 2024 當選、2026 宣布普發一萬——不是競選承諾，是任內施政承諾，也要追蹤（協議 1.28.0）

function policy(extra: Record<string, unknown>) {
  return validateContributionRequest({
    agent_name: "tester",
    contribution_type: "policy",
    payload: { name: "賴清德", title: "2026 年普發現金一萬元", description: "行政院宣布 2026 年普發全民現金每人一萬元，年底前發放完畢", category: "社會福利", ...extra },
    source_urls: ["https://www.cna.com.tw/news/aipl/202609230001.aspx"],
  });
}

Deno.test("任內施政承諾：status Proposed、屆別 2024、提出日期 2026 → 收", () => {
  const r = policy({ status: "Proposed", election_id: 2024, proposed_date: "2026-09-20" });
  assertEquals(r.errors, [], JSON.stringify(r.errors));
  assertEquals(r.ok, true);
});

Deno.test("競選承諾照舊擋：屆別 2024、提出日期 2026 → 退，訊息指路到 Proposed", () => {
  const r = policy({ election_id: 2024, proposed_date: "2026-09-20" });
  const e = r.errors.find((x) => x.path.includes("proposed_date"));
  assert(e, "競選承諾（預設 status）的提出日期晚於屆別要擋");
  assertStringIncludes(e!.message, "Proposed");
});

Deno.test("更正：把屆別改 2024＋日期 2026 時，同一筆把 status 改 Proposed 就不擋", () => {
  const base = { target_table: "policies", target_id: "11111111-1111-4111-8111-111111111111", reason: "這是總統任內宣布的施政，不是競選承諾" };
  const ok = validateContributionRequest({ agent_name: "tester", contribution_type: "correction", payload: { ...base, changes: [
    { field: "election_id", correct_value: 2024 }, { field: "proposed_date", correct_value: "2026-09-20" }, { field: "status", correct_value: "Proposed" },
  ] }, source_urls: ["https://www.cna.com.tw/x"] });
  assertEquals(ok.errors, [], JSON.stringify(ok.errors));
  const bad = validateContributionRequest({ agent_name: "tester", contribution_type: "correction", payload: { ...base, changes: [
    { field: "election_id", correct_value: 2024 }, { field: "proposed_date", correct_value: "2026-09-20" },
  ] }, source_urls: ["https://www.cna.com.tw/x"] });
  assert(bad.errors.some((e) => e.message.includes("Proposed")), "沒改 status 就擋，並告訴它可以改成 Proposed");
});

Deno.test("三種任務的做法都講到任內施政承諾；協議本文也有", async () => {
  for (const t of ["news_sweep", "policy_election_missing", "policy_election_mismatch"]) {
    assertStringIncludes(TASK_GUIDANCE[t], "Proposed", `${t} 要講任內施政承諾填 Proposed`);
  }
  const md = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assertStringIncludes(md, "任內施政承諾");
  const sql = await Deno.readTextFile(new URL("../../migrations/20260923000010_news_sweep_in_term.sql", import.meta.url));
  assertStringIncludes(sql, "status 填 Proposed");
});
