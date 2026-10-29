// 額度時段接線：限額數字、用量查詢下限、回應欄位。正見與日本站同一套。
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { CONTRIBUTE_DAILY_LIMIT_PER_DITRUST, CONTRIBUTE_DAILY_LIMIT_PER_IP } from "./contribute-handler.ts";
import { VERIFY_DAILY_LIMIT_PER_DITRUST, VERIFY_DAILY_LIMIT_PER_IP } from "./verify-handler.ts";
import * as jpC from "./jp/contribute-handler.ts";
import * as jpV from "./jp/verify-handler.ts";
import { quotaWindowStart } from "./quota-window.ts";
import { loadEntry, type RestCall } from "./entry-harness.ts";

Deno.test("限額（每時段）：提交 80／500、驗證 200／1000，日本站同數字", () => {
  assertEquals([CONTRIBUTE_DAILY_LIMIT_PER_IP, CONTRIBUTE_DAILY_LIMIT_PER_DITRUST], [80, 500]);
  assertEquals([VERIFY_DAILY_LIMIT_PER_IP, VERIFY_DAILY_LIMIT_PER_DITRUST], [200, 1000]);
  assertEquals([jpC.CONTRIBUTE_DAILY_LIMIT_PER_IP, jpC.CONTRIBUTE_DAILY_LIMIT_PER_DITRUST], [80, 500]);
  assertEquals([jpV.VERIFY_DAILY_LIMIT_PER_IP, jpV.VERIFY_DAILY_LIMIT_PER_DITRUST], [200, 1000]);
});

Deno.test("四支 handler 的用量下限都是時段起點，不再是 UTC 午夜", async () => {
  for (const f of ["contribute-handler.ts", "verify-handler.ts", "jp/contribute-handler.ts", "jp/verify-handler.ts"]) {
    const src = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
    assert(src.includes("quotaWindowStart()"), `${f} 要用 quotaWindowStart()`);
    assert(!/setUTCHours\(0, 0, 0, 0\)/.test(src), `${f} 不可以再用 UTC 午夜當用量下限`);
  }
  for (const f of ["../next/index.ts", "../jp-next/index.ts"]) {
    const src = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
    assert(src.includes("quotaWindowStart()") && !/setUTCHours\(0, 0, 0, 0\)/.test(src), `${f} 用量下限要是時段起點`);
  }
});

const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789", CONTRIBUTION_IP_SALT: "salt" };

for (const entryPath of ["../next/index.ts", "../jp-next/index.ts"]) {
  Deno.test(`${entryPath}：用量查詢下限＝時段起點；quota 帶 window_start／window_resets_at，舊欄位仍在`, async () => {
    const entry = await loadEntry(entryPath, env, (c: RestCall) => (c.method === "HEAD" ? { __count: 7 } : undefined));
    try {
      const before = quotaWindowStart();
      const res = await entry.call(new Request("https://x/next?agent_name=dave&agent_tool=claude-code/claude-sonnet-5", { headers: { "x-forwarded-for": "10.1.1.5" } }));
      const after = quotaWindowStart();
      assertEquals(res.status, 200);
      const quota = (await res.json()).quota;
      for (const k of ["scope", "submit", "verify"]) assert(k in quota, `舊欄位 ${k} 要留著`);
      assertEquals(quota.submit.used, 7);
      assertEquals(typeof quota.submit.limit, "number");
      assert([before.toISOString(), after.toISOString()].includes(quota.window_start));
      assertEquals(new Date(quota.window_resets_at).getTime() - new Date(quota.window_start).getTime(), 4 * 3_600_000);
      assertStringIncludes(quota.scope, "每 4 小時");
      const heads = entry.calls.filter((c) => c.method === "HEAD" && (c.target === "contributions" || c.target === "contribution_votes") && c.url.searchParams.get("created_at")?.startsWith("gte."));
      assert(heads.length >= 2, "提交與驗證的用量查詢都要帶 created_at 下限");
      for (const h of heads) {
        const lower = (h.url.searchParams.get("created_at") as string).slice(4);
        assert([before.toISOString(), after.toISOString()].includes(lower), `下限 ${lower} 不是時段起點`);
      }
    } finally {
      entry.restore();
    }
  });
}

// 批次大小不可大於單次時段額度：否則這種批次永遠交不出去（2026-10-29 名冊批次 150 > 提交額度 80 就出過這個事）。
import { MAX_BATCH, MAX_BATCH_ROSTER } from "./contribution-schema.ts";
import { ROSTER_GAP_LIMIT } from "./task-context.ts";

Deno.test("批次大小上限 ≤ 單次時段提交額度（正見匿名與日本站），之後調額度或批次都不會出現交不出去的批次", () => {
  const smallestQuota = Math.min(CONTRIBUTE_DAILY_LIMIT_PER_IP, CONTRIBUTE_DAILY_LIMIT_PER_DITRUST, jpC.CONTRIBUTE_DAILY_LIMIT_PER_IP, jpC.CONTRIBUTE_DAILY_LIMIT_PER_DITRUST);
  assert(MAX_BATCH <= smallestQuota, `MAX_BATCH ${MAX_BATCH} > 時段提交額度 ${smallestQuota}`);
  assert(MAX_BATCH_ROSTER <= smallestQuota, `MAX_BATCH_ROSTER ${MAX_BATCH_ROSTER} > 時段提交額度 ${smallestQuota}：名冊大批次會被 429 擋掉`);
  assert(ROSTER_GAP_LIMIT <= MAX_BATCH_ROSTER, "任務附的缺額名單一件不該比能一次交的還多");
});

Deno.test("派工臂文字的名冊批次上限＝MAX_BATCH_ROSTER（最新定義 20261029030000）", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261029030000_roster_batch_cap_80.sql", import.meta.url));
  assert(sql.includes(`一次最多 ${MAX_BATCH_ROSTER} 筆（整批都是 candidacy`));
});
