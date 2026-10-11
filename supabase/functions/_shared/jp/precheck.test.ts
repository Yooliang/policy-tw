import { assert, assertEquals } from "jsr:@std/assert@1";
import { type AskFn, precheckOne } from "./precheck.ts";
import { JP_FETCH_ONLY_MODEL } from "./system-one.ts";

/** policy_jp の偽物：from(t).select().eq().maybeSingle()、from("jev_decisions").upsert().select()、rpc() だけ */
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const inserted: Array<Record<string, unknown>> = [];
  const rpcs: Array<[string, unknown]> = [];
  const db = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        maybeSingle: () => Promise.resolve({ data: (tables[table] ?? []).find((r) => filters.every(([k, v]) => r[k] === v)) ?? null, error: null }),
        upsert: (rows: Array<Record<string, unknown>>) => { inserted.push(...rows); return { select: () => Promise.resolve({ data: rows, error: null }) }; },
      };
      return q;
    },
    rpc: (name: string, args: unknown) => { rpcs.push([name, args]); return Promise.resolve({ data: "pending", error: null }); },
  };
  return { db, inserted, rpcs };
}

const TABLES = {
  politicians: [{ id: "p1", name: "山田太郎" }],
  elections: [{ id: "2026-10-25_muni_assembly_472123", name: "豊見城市議会議員一般選挙", election_date: "2026-10-25" }],
  politician_elections: [{ id: "p1:2026-10-25_muni_assembly_472123:at_large", politician_id: "p1", election_id: "2026-10-25_muni_assembly_472123" }],
};
const CAND = {
  contribution_id: "c1", contribution_type: "candidacy", source_urls: ["https://www.city.tomigusuku.lg.jp/senkyo/1.html"],
  payload: { politician_id: "p1", election_id: "2026-10-25_muni_assembly_472123", candidacy_status: "filed", status_date: "2026-10-18", district_kind: "at_large" },
};

Deno.test("一件：庫から名前と選挙名を引いて聞き、supported を一列書いて共識を計算し直す", async () => {
  const { db, inserted, rpcs } = fakeDb(TABLES);
  let seen: Record<string, unknown> = {};
  const ask: AskFn = (state, questions) => {
    seen = structuredClone(state); // 聞いた時点の state
    return Promise.resolve({ model: "typesafe/jev-2026-10-01", usage: { cost: 0.0002 }, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "choice", choice: "confirmed", probabilities: { confirmed: 0.98 } }])) });
  };
  const out = await precheckOne(db, CAND, ask, () => Promise.resolve({ kind: "html", text: "豊見城市議会議員一般選挙 立候補者一覧 山田 太郎 無所属", note: "" }));
  assertEquals([out.choice, out.probability, out.asked], ["supported", 0.98, true]);
  assertEquals((seen.claim as Record<string, unknown>).name, "山田太郎");
  assertEquals(inserted.length, 1);
  assertEquals([inserted[0].subject_id, inserted[0].question, inserted[0].choice, inserted[0].model], ["c1", "source_support", "supported", "typesafe/jev-2026-10-01"]);
  assertEquals(rpcs, [["contribution_apply_consensus", { p_contribution_id: "c1" }]]);
});

Deno.test("一件：本文に主人公の名前がない／取れない → Jev に聞かず fetch-only の棄權を書く", async () => {
  const neverAsk: AskFn = () => { throw new Error("聞いてはいけない"); };
  for (const page of [{ kind: "html" as const, text: "豊見城市議会議員一般選挙 立候補者一覧 高橋花子 無所属", note: "" }, { kind: "error" as const, text: "", note: "http 404" }]) {
    const { db, inserted, rpcs } = fakeDb(TABLES);
    const out = await precheckOne(db, CAND, neverAsk, () => Promise.resolve(page));
    assertEquals([out.choice, out.probability, out.asked], ["cannot_tell", 0, false]);
    assertEquals([inserted[0].model, inserted[0].choice, inserted[0].probability], [JP_FETCH_ONLY_MODEL, "cannot_tell", 0]);
    assert(out.key.startsWith("fetch:"));
    assertEquals(rpcs.length, 1);
  }
});

Deno.test("一件（policy）：参選紀錄 id から人名を引く", async () => {
  const { db } = fakeDb(TABLES);
  let claim: Record<string, unknown> = {};
  const ask: AskFn = (state) => { claim = state.claim as Record<string, unknown>; return Promise.resolve({ model: "m-2026-10-01", usage: { cost: 0 }, answers: {} }); };
  const out = await precheckOne(db, {
    contribution_id: "c2", contribution_type: "policy", source_urls: ["https://example.jp/koho.pdf"],
    payload: { politician_election_id: "p1:2026-10-25_muni_assembly_472123:at_large", title: "子ども医療費の無償化", description: "高校生まで医療費を無償にする", category: "子育て", source_locator: "公報" },
  }, ask, () => Promise.resolve({ kind: "html", text: "山田太郎 選挙公報 公約 子ども医療費の無償化 高校生まで", note: "" }));
  assertEquals(claim.politician_name, "山田太郎");
  assertEquals(out.choice, "cannot_tell"); // 答えが空＝棄權
});
