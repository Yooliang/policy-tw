import { assert, assertEquals } from "jsr:@std/assert@1";
import { recentVisiblePolicies, summarizePolicies } from "./policy-summary.ts";
import { PolicyStatus } from "../types.ts";

// #982：首頁、/tracking、/analysis 的預渲染資料不再嵌整份政見（14,003 筆、12.4 MB），首頁改讀建置時算好的摘要。

const mk = (id: string, status: PolicyStatus, over: Record<string, unknown> = {}) =>
  ({ id, politicianId: "a", status, origin: "term", proposedDate: "2026-01-01", lastUpdated: "2026-01-01", ...over }) as never;

Deno.test("summarizePolicies：各狀態筆數、競選承諾與任內政見加起來等於總數", () => {
  const s = summarizePolicies([
    mk("1", PolicyStatus.ACHIEVED),
    mk("2", PolicyStatus.IN_PROGRESS, { origin: "pledge" }),
    mk("3", PolicyStatus.IN_PROGRESS),
    mk("4", PolicyStatus.CAMPAIGN), // status＝Campaign Pledge 也算競選承諾
  ]);
  assertEquals(s.total, 4);
  assertEquals(s.byStatus["In Progress"], 2);
  assertEquals(s.byStatus["Achieved"], 1);
  assertEquals(s.byStatus["Stalled"], undefined);
  assertEquals(s.pledge, 2);
  assertEquals(s.term, 2);
});

Deno.test("recentVisiblePolicies：提出日新到舊取前 N 筆、落選的競選承諾不列、不改動原陣列", () => {
  const lost = { elections: [{ electionId: 1, candidacyStatus: "not_elected" as const }] };
  const list = [
    mk("old", PolicyStatus.IN_PROGRESS, { proposedDate: "2025-01-01" }),
    mk("lostNew", PolicyStatus.CAMPAIGN, { proposedDate: "2026-12-01", electionId: 1, politicianId: "lost" }),
    mk("new", PolicyStatus.IN_PROGRESS, { proposedDate: "2026-06-01" }),
    mk("mid", PolicyStatus.IN_PROGRESS, { proposedDate: "2026-01-01" }),
    mk("older", PolicyStatus.IN_PROGRESS, { proposedDate: "2024-01-01" }),
  ];
  const before = list.map((p: { id: string }) => p.id).join();
  const out = recentVisiblePolicies(list, (p: { politicianId: string }) => (p.politicianId === "lost" ? lost : undefined) as never, 3);
  assertEquals(out.map((p) => p.id), ["new", "mid", "old"]);
  assertEquals(list.map((p: { id: string }) => p.id).join(), before);
});

// 守門：這三個路由的預渲染切片不能再塞整份 full.policies（>10 MB 會讓每次造訪都下載整份）
Deno.test("page-data.ts：home／tracking／analysis 不帶整份政見、不標 policiesComplete", () => {
  const src = Deno.readTextFileSync(new URL("./ssg/page-data.ts", import.meta.url));
  for (const route of ["home", "tracking", "analysis"]) {
    const start = src.indexOf(`case '${route}'`);
    assert(start >= 0, `找不到 case '${route}'`);
    const end = src.indexOf("\n    case '", start + 10);
    const body = src.slice(start, end);
    assert(!/policies:\s*full\.policies\b/.test(body), `${route} 不該把整份 full.policies 放進切片`);
    assert(!/policiesComplete:\s*true/.test(body), `${route} 不該標 policiesComplete: true`);
  }
});
