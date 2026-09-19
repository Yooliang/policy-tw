import { assertEquals } from "jsr:@std/assert@1";
import { extractChains, firstLineOf, judge, MARKER, scanFunctions } from "./query-bounds.ts";

/** 把一段程式碼丟進判定器，回傳第一條鏈的結果 */
function verdictOf(src: string) {
  const chains = extractChains("t.ts", src);
  assertEquals(chains.length, 1, `應該只抓到一條鏈，實際 ${chains.length} 條`);
  return judge(chains[0], src);
}

// ── 判定器本身：先確定它抓得到壞的，不然「全綠」什麼都不代表 ──────────────

Deno.test("沒有上限的查詢要被抓出來", () => {
  const v = verdictOf(`const { data } = await supabase.from("contribution_votes").select("contribution_id").eq("agent_name", agentName);`);
  assertEquals(v.ok, false);
  assertEquals(v.ok === false && v.problem, "no-bound");
});

// 這就是 2026-09-19 在 /next 抓到的那支：連 limit 都沒寫，讀起來像「全部」
Deno.test("limit 寫得比伺服器上限大，要當成沒有保護", () => {
  const v = verdictOf(`await supabase.from("contributions").select("*").eq("status", "pending").limit(20000);`);
  assertEquals(v.ok, false);
  assertEquals(v.ok === false && v.problem, "limit-over-max-rows");
});

Deno.test("翻頁沒有 order 要被抓出來（無序翻頁會重複或漏筆）", () => {
  const v = verdictOf(`await supabase.from("contributions").select("task_id").eq("status", "pending").range(from, to);`);
  assertEquals(v.ok, false);
  assertEquals(v.ok === false && v.problem, "unordered-pagination");
});

Deno.test("標了豁免卻不寫理由，不算豁免", () => {
  const v = verdictOf(`// ${MARKER}\nawait supabase.from("contributions").select("id").eq("status", "pending");`);
  assertEquals(v.ok, false);
  assertEquals(v.ok === false && v.problem, "marker-without-reason");
});

Deno.test("寫死的狀態陣列不算有界", () => {
  const v = verdictOf(`await supabase.from("contributions").select("task_id").in("status", ["pending", "verified"]);`);
  assertEquals(v.ok, false);
  assertEquals(v.ok === false && v.problem, "no-bound");
});

// ── 反過來：合法寫法不能被誤報，不然這支測試很快就會被關掉 ──────────────

Deno.test("翻頁＋排序、limit 在範圍內、count、寫入、單列都放行", () => {
  const ok = (src: string) => assertEquals(verdictOf(src).ok, true, src);
  ok(`await supabase.from("contributions").select("task_id").eq("status", "pending").order("created_at", { ascending: true }).range(from, to);`);
  ok(`await supabase.from("contributions").select("id").eq("status", "pending").limit(500);`);
  ok(`await supabase.from("contributions").select("id", { count: "exact", head: true }).eq("agent_name", agentName);`);
  ok(`await supabase.from("contributions").insert({ id });`);
  ok(`await supabase.from("politicians").select("*").eq("id", id).single();`);
  ok(`await supabase.from("politicians").select("id, name").in("id", politicianIds);`);
  ok(`await supabase.from("politicians").select("id, name").in("name", [...names]);`);
  ok(`await supabase.from("contribution_votes").select("verdict").eq("contribution_id", contributionId);`);
  ok(`// ${MARKER} — 同名的人最多個位數\nawait supabase.from("politicians").select("*").eq("name", name);`);
});

Deno.test("鏈中間夾註解不能被切斷（切斷就會看漏後面的 limit）", () => {
  const v = verdictOf(`await supabase.from("contribution_tasks").select("id").eq("status", "open")\n  // 派過的排到後面\n  .order("priority", { ascending: false }).limit(20);`);
  assertEquals(v.ok, true);
  assertEquals(v.ok === true && v.reason, "bounded-limit");
});

Deno.test("建構器寫法：limit 在後面才補上也算數", () => {
  const src = `let query = supabase.from("contributions").select("id").eq("status", "pending");\nif (type) query = query.eq("contribution_type", type);\nconst { data } = await query.limit(limit * 4);`;
  const v = verdictOf(src);
  assertEquals(v.ok, true);
  assertEquals(v.ok === true && v.reason, "deferred-limit");
});

// ── 真正的守門：全部 Edge Function 原始碼 ──────────────────────────────

/**
 * 2026-09-17 貢獻榜卡在 1000、9-18 /next 四支、9-19 又兩支。
 * 每一支都是「寫得像全部、其實只有前 1000 筆」，而且不噴錯、不變慢。
 * 新加的查詢要嘛給上限、要嘛翻頁、要嘛在上面寫一行為什麼有界。
 */
Deno.test("沒有查詢會被 PostgREST 的 1000 列上限靜默截斷", async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const results = await scanFunctions(root);
  const bad = results.filter((r) => !r.verdict.ok);
  const report = bad.map((r) =>
    `  ${r.chain.file}:${r.chain.line}\n    ${r.verdict.ok === false ? r.verdict.detail : ""}\n    ${firstLineOf(r.chain)}`
  ).join("\n");
  assertEquals(
    bad.length,
    0,
    `有 ${bad.length} 支查詢可能被截斷：\n${report}\n\n` +
      `要嘛加 .limit(<=1000)、要嘛用 fetchAllRows 翻頁（記得 .order），` +
      `真的有界就在那一行上面寫「${MARKER} — 為什麼有界」。`,
  );
  // 掃描器自己壞掉（正規表達式改壞、目錄讀不到）會掃出 0 條鏈然後「全綠」
  assertEquals(results.length > 150, true, `只掃到 ${results.length} 條查詢鏈，掃描器八成壞了`);
});
