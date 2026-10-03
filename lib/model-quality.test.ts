/// <reference lib="deno.ns" />
import { assert, assertEquals } from "jsr:@std/assert@1";
import { formatPct, MIN_TYPE_N, summarizeContributions, summarizeVotes, type ContribStatsRow, type VoteStatsRow } from "./model-quality.ts";

function row(model: string, type: string | null, s: Partial<ContribStatsRow>): ContribStatsRow {
  return {
    model, contribution_type: type, submitted: 0, applied: 0, rejected: 0, pending: 0, verified: 0, disputed: 0,
    superseded: 0, withdrawn: 0, other_status: 0, no_change: 0, no_change_missing: 0, data_decided: 0, data_rejected: 0, raw_tools: null, ...s,
  };
}

// 線上近 30 天實際的一列（2026-10-03 唯讀查詢）：50 件＝applied 23、withdrawn 19、superseded 5、rejected 2、pending 1
const DEEPSEEK_PRO = row("DeepSeek V4 Pro", null, { submitted: 50, applied: 23, rejected: 2, pending: 1, superseded: 5, withdrawn: 19, data_decided: 16, data_rejected: 1, no_change: 2 });

Deno.test("上線率、退件率只以 applied＋rejected 當分母：撤回與被取代跟品質無關", () => {
  const [m] = summarizeContributions([DEEPSEEK_PRO]).models;
  assertEquals(m.applied, { num: 23, den: 25 });
  assertEquals(formatPct(m.applied), "92%", "23/25，不是 23/50");
  assertEquals(m.rejected, { num: 2, den: 25 });
  assertEquals(m.waiting, 1);
  assertEquals(m.superseded, 5);
  assertEquals(m.withdrawn, 19);
  assertEquals(m.applied.num + m.rejected.num + m.waiting + m.superseded + m.withdrawn + m.other, m.submitted, "分欄加總要等於交件數");
});

Deno.test("等票中＝pending＋verified＋disputed", () => {
  const [m] = summarizeContributions([row("X", null, { submitted: 6, pending: 3, verified: 2, disputed: 1 })]).models;
  assertEquals(m.waiting, 6);
});

Deno.test("無異動查無率與資料型退件率各用自己的分母", () => {
  const [m] = summarizeContributions([row("Claude Haiku（未標版本）", null, { submitted: 5140, no_change: 3181, no_change_missing: 2461, data_decided: 1081, data_rejected: 169 })]).models;
  assertEquals(formatPct(m.noChangeMissing), "77%");
  assertEquals(m.noChangeMissing.den, 3181);
  assertEquals(formatPct(m.dataRejected), "16%");
});

Deno.test("模型×型別細表：n 未達門檻的不列", () => {
  const out = summarizeContributions([
    row("A", null, { submitted: 30 }),
    row("A", "candidacy", { submitted: MIN_TYPE_N, applied: 5, rejected: 5 }),
    row("A", "policy", { submitted: MIN_TYPE_N - 1, applied: 9 }),
  ]);
  assertEquals(out.byType.get("A")?.map((t) => t.type), ["candidacy"]);
});

Deno.test("模型依交件數排序；未填與其他排最後", () => {
  const out = summarizeContributions([
    row("其他", null, { submitted: 900 }),
    row("B", null, { submitted: 10 }),
    row("A", null, { submitted: 100 }),
    row("未填", null, { submitted: 1000 }),
  ]);
  assertEquals(out.models.map((m) => m.model), ["A", "B", "其他", "未填"]);
});

Deno.test("投票：錯誤率分母是同意＋反對，不確定不算對錯；系統票另放", () => {
  const rows: VoteStatsRow[] = [
    { model: "系統票（Jev）", votes: 6, agree: 3, disagree: 0, unsure: 3, wrong: 2, raw_tools: null },
    { model: "Claude Haiku（未標版本）", votes: 9814, agree: 7594, disagree: 1240, unsure: 980, wrong: 185, raw_tools: null },
  ];
  const out = summarizeVotes(rows);
  assertEquals(out.models.map((m) => m.model), ["Claude Haiku（未標版本）"]);
  assertEquals(out.system?.model, "系統票（Jev）");
  const [h] = out.models;
  assertEquals(h.wrong, { num: 185, den: 7594 + 1240 });
  assertEquals(formatPct(h.wrong), "2.1%", "10% 以下留一位小數");
  assertEquals(h.agree.den, 9814);
  assertEquals(formatPct(h.unsure), "10%");
});

Deno.test("分母為 0 顯示破折號；PostgREST 回字串的數字也吃得下", () => {
  assertEquals(formatPct({ num: 0, den: 0 }), "—");
  const [m] = summarizeContributions([row("A", null, { submitted: "3" as unknown as number, applied: "3" as unknown as number })]).models;
  assertEquals(m.applied, { num: 3, den: 3 });
  assert(m.submitted === 3);
});
