import { assert, assertEquals } from "jsr:@std/assert@1";
import { categoryErrorMessage, isCanonicalCategory, normalizeCategory, POLICY_CATEGORIES } from "./category-map.ts";
import { validateContributionRequest } from "./contribution-schema.ts";

const CNA = "https://www.cna.com.tw/news/aipl/202609045002.aspx";
const policy = (category: string) => ({
  agent_name: "tester",
  contribution_type: "policy",
  payload: { name: "陳素月", title: "增設公共托育中心", description: "四年內於彰化縣每一鄉鎮至少設置一處公共托育中心，提供平價托育服務。", category },
  source_urls: [CNA],
});

Deno.test("分類 19 值：正規值原樣、舊寫法對照、未知回 null", () => {
  assertEquals(POLICY_CATEGORIES.length, 19);
  assertEquals(normalizeCategory("交通建設"), "交通建設");
  assertEquals(normalizeCategory("交通"), "交通建設");
  assertEquals(normalizeCategory("經濟發展"), "經濟發展與產業");
  assertEquals(normalizeCategory("經濟補助"), "經濟發展與產業");
  assertEquals(normalizeCategory("行政革新"), "行政革新與數位治理");
  assertEquals(normalizeCategory("能源"), "能源");
  assertEquals(normalizeCategory("其他"), "其他");
  assertEquals(normalizeCategory("育兒"), null);
  assertEquals(normalizeCategory(null), null);
  assertEquals(isCanonicalCategory("經濟發展"), false, "舊名不再是正規值");
});

Deno.test("提交 policy：合法 19 值通過", () => {
  const r = validateContributionRequest(policy("都市發展與住宅"));
  assertEquals(r.errors, []);
  assertEquals(r.ok, true);
});

Deno.test("提交 policy：舊值「交通」→ 400 category_invalid 並提示改為「交通建設」", () => {
  const r = validateContributionRequest(policy("交通"));
  assertEquals(r.ok, false);
  const err = r.errors.find((e) => e.path === "payload.category");
  assertEquals(err?.code, "category_invalid");
  assert(err!.message.includes("「交通」是舊寫法，請改為「交通建設」"));
  assert(err!.message.includes("19 個"));
  assert(categoryErrorMessage("育兒").startsWith("category 只能是這 19 個之一"));
});
