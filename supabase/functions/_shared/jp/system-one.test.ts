import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  aggregateJpFieldVerdicts, buildJpSourceSupportAsk, combineJpSources, detectCharset, jpClaimOf, jpCoreFields, jpFetchSource, jpNameHit, JP_PDF_MAX_BYTES, JP_STATUS_PHRASES,
} from "./system-one.ts";

const ans = (choice: string, p: number) => ({ type: "choice", choice, probabilities: { [choice]: p } });

Deno.test("宣稱（candidacy）：id は入れず頁面に出る字に換える；名前は庫から、状態は日本語、status_date は入れない", () => {
  const claim = jpClaimOf("candidacy", {
    politician_id: "p1", election_id: "2026-10-25_muni_assembly_472123", candidacy_status: "filed", status_date: "2026-10-18", district_kind: "at_large",
  }, { politicianName: "山田 太郎", electionName: "豊見城市議会議員一般選挙", electionDate: "2026-10-25" });
  assertEquals(claim, { name: "山田 太郎", election: "豊見城市議会議員一般選挙（投票日 2026-10-25）", candidacy_status: JP_STATUS_PHRASES.filed });
  assertEquals(jpCoreFields("candidacy", claim), ["name", "election", "candidacy_status"]);
  // payload の name が先、kana・選挙区・生年は核心外で入る
  const c2 = jpClaimOf("candidacy", { name: "高橋花子", kana: "たかはしはなこ", candidacy_status: "declared", district_name: "北区", birth_year: 1970 }, { politicianName: "別人" });
  assertEquals(c2, { name: "高橋花子", kana: "たかはしはなこ", candidacy_status: JP_STATUS_PHRASES.declared, district: "北区", birth_year: 1970 });
  assertEquals(jpCoreFields("candidacy", c2), ["name", "candidacy_status"]);
});

Deno.test("宣稱（politician／policy）：politician は補う事実が核心、policy は人名と題名が核心、category は入れない", () => {
  const p = jpClaimOf("politician", { politician_id: "p1", birth_year: 1965, career: ["市議会議員（2期）"], education: [] }, { politicianName: "山田太郎" });
  assertEquals(p, { name: "山田太郎", birth_year: 1965, career: ["市議会議員（2期）"] });
  assertEquals(jpCoreFields("politician", p), ["birth_year", "career"]);
  const q = jpClaimOf("policy", { politician_election_id: "x", title: "子ども医療費の無償化", description: "高校生まで医療費を無償にする", category: "子育て", source_locator: "公報" }, { politicianName: "山田太郎" });
  assertEquals(q, { politician_name: "山田太郎", title: "子ども医療費の無償化", description: "高校生まで医療費を無償にする" });
  assertEquals(jpCoreFields("policy", q), ["politician_name", "title"]);
  assertEquals(jpClaimOf("correction", { changes: [] }), {});
});

Deno.test("問い：欄ごとに一問、説明は日本語（台湾の同義語は入っていない）", () => {
  const { questions, state } = buildJpSourceSupportAsk({ name: "山田太郎", candidacy_status: "当選した" }, "https://www.city.example.lg.jp/", "本文");
  assertEquals(Object.keys(questions), ["field:name", "field:candidacy_status"]);
  assert(questions["field:name"].instructions.includes("立候補者一覧"));
  assert(!questions["field:name"].instructions.includes("中選會"));
  assertEquals((state.page as { url: string }).url, "https://www.city.example.lg.jp/");
});

Deno.test("収斂：核心が全部 confirmed → supported（最弱の欄）、どれか contradicted ≥ 門檻 → not_supported、それ以外は棄權", () => {
  const claim = { name: "山田太郎", election: "X", candidacy_status: "Y", district: "北区" };
  let v = aggregateJpFieldVerdicts("candidacy", claim, { "field:name": ans("confirmed", 0.99), "field:election": ans("confirmed", 0.97), "field:candidacy_status": ans("confirmed", 0.98), "field:district": ans("absent", 0.9) });
  assertEquals([v.choice, v.probability], ["supported", 0.97]);
  v = aggregateJpFieldVerdicts("candidacy", claim, { "field:name": ans("confirmed", 0.99), "field:election": ans("confirmed", 0.99), "field:candidacy_status": ans("confirmed", 0.99), "field:district": ans("contradicted", 0.96) });
  assertEquals([v.choice, v.probability, v.contradicted_core], ["not_supported", 0.96, false]);
  v = aggregateJpFieldVerdicts("candidacy", claim, { "field:name": ans("confirmed", 0.99), "field:election": ans("absent", 0.99), "field:candidacy_status": ans("confirmed", 0.99) });
  assertEquals([v.choice, v.probability], ["cannot_tell", 0]);
  // politician：name（主語）が absent でも、補う事実が全部 confirmed なら supported
  v = aggregateJpFieldVerdicts("politician", { name: "山田太郎", birth_year: 1965 }, { "field:name": ans("absent", 0.9), "field:birth_year": ans("confirmed", 0.96) });
  assertEquals(v.choice, "supported");
});

Deno.test("名前の照合：空白・旧字体を寄せる；本文の合成は名前のあるページが先", () => {
  assert(jpNameHit("候補者　髙橋 花子（無所属）", ["高橋花子"]));
  assert(!jpNameHit("候補者 高橋次郎", ["高橋花子"]));
  const out = combineJpSources([{ url: "https://a.example.jp/x", text: "関係のない話" }, { url: "https://b.example.lg.jp/y", text: "立候補者一覧 山田太郎" }], ["山田太郎"]);
  assert(out.indexOf("b.example.lg.jp") < out.indexOf("a.example.jp"));
});

Deno.test("文字コード：Content-Type か meta charset で Shift_JIS／EUC-JP を判定し、正しく読む", async () => {
  assertEquals(detectCharset("text/html; charset=Shift_JIS", new Uint8Array()), "shift_jis");
  assertEquals(detectCharset("text/html", new TextEncoder().encode('<html><head><meta http-equiv="Content-Type" content="text/html; charset=EUC-JP">')), "euc-jp");
  assertEquals(detectCharset("text/html", new TextEncoder().encode("<meta charset='utf-8'>")), "utf-8");
  const sjis = new Uint8Array([142, 82, 147, 99, 145, 190, 152, 89, 32, 151, 167, 140, 243, 149, 226, 142, 210, 136, 234, 151, 151]); // 「山田太郎 立候補者一覧」
  const html = new Uint8Array([...new TextEncoder().encode("<html><head><meta charset=\"shift_jis\"></head><body><p>"), ...sjis, ...new TextEncoder().encode("</p></body></html>")]);
  const fake = (() => Promise.resolve(new Response(html, { headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;
  const r = await jpFetchSource("https://www.city.example.lg.jp/senkyo/", fake);
  assertEquals(r.kind, "html");
  assert(r.text.includes("山田太郎 立候補者一覧"), r.text);
});

Deno.test("PDF：抽字した本文を使う、上限を超えたら読まない；本站の網址は取らない", async () => {
  const pdf = (len: number) => (() => Promise.resolve(new Response(new Uint8Array(len), { headers: { "content-type": "application/pdf" } }))) as unknown as typeof fetch;
  const r = await jpFetchSource("https://www.city.example.lg.jp/a.pdf", pdf(10), () => Promise.resolve("立候補者一覧 山田太郎"));
  assertEquals([r.kind, r.text], ["html", "立候補者一覧 山田太郎"]);
  const big = await jpFetchSource("https://www.city.example.lg.jp/b.pdf", pdf(JP_PDF_MAX_BYTES + 1), () => Promise.resolve("x"));
  assertEquals([big.kind, big.text], ["pdf", ""]);
  const self = await jpFetchSource("https://jp.hustings.net/politician/x", (() => { throw new Error("取ってはいけない"); }) as unknown as typeof fetch);
  assertEquals(self.kind, "error");
});
