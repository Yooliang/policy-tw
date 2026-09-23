import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { sameSiteAsSubmitted } from "./consensus.ts";
import { scoringHint } from "./task-context.ts";
import { correctionValue } from "./apply-contribution.ts";

// 2026-09-23 小良哥：驗票儘量要求第二來源（協議 1.27.0）

Deno.test("evidence_url 跟提交者同網站 → 不算第二來源（www. 與大小寫不影響）", () => {
  const src = ["https://www.cna.com.tw/news/aipl/1.aspx", "https://udn.com/news/story/1"];
  assertEquals(sameSiteAsSubmitted("https://cna.com.tw/news/aipl/2.aspx", src), true);
  assertEquals(sameSiteAsSubmitted("https://UDN.com/news/story/9", src), true);
  assertEquals(sameSiteAsSubmitted("https://news.ltn.com.tw/news/1", src), false);
  assertEquals(sameSiteAsSubmitted(null, src), false);
  assertEquals(sameSiteAsSubmitted("not a url", src), false);
});

Deno.test("scoring 提示：差 2 分要講「附第二來源這一票就能上線」", () => {
  assertEquals(scoringHint(3, 3).points_short, 0);
  assertEquals(scoringHint(2, 3).points_short, 1);
  const two = scoringHint(1, 3);
  assertEquals(two.points_short, 2);
  assertStringIncludes(two.hint, "第二來源");
  assertStringIncludes(two.hint, "這一票就能讓它上線");
  // 系統票把目標降到 2、還沒人投：一張 +2 就夠
  assertStringIncludes(scoringHint(0, 2).hint, "這一票就能讓它上線");
  assertEquals(scoringHint(-1, 3).points_short, 4);
});

Deno.test("照片走貢獻：落庫時把 Wikimedia 縮圖寬度換成允許值（原本只有 update-avatar 做）", () => {
  const out = correctionValue("politicians", "avatar_url", "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/220px-X.jpg") as string;
  assert(!out.includes("/220px-"), `220px 要被換掉：${out}`);
  assertEquals(correctionValue("policies", "category", "交通建設"), "交通建設");
});

Deno.test("協議 1.27.0：同意票預設找第二來源、不再教代理打 judge、退件門檻不寫 −目標", async () => {
  const md = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assertStringIncludes(md, "同意票預設要找第二來源");
  assertStringIncludes(md, "evidence_warning");
  assert(!md.includes("action=judge"), "judge 1.26.0 就退出代理文件了，第 9 條不能再教");
  assert(!md.includes("−目標"), "退件門檻 1.26.1 起固定，不能再寫「跌到 −目標」");
});

Deno.test("公開金鑰寫入的兩支端點已下架，前端也沒有人再打它們", async () => {
  for (const fn of ["add-politician", "update-avatar"]) {
    let exists = true;
    try { await Deno.stat(new URL(`../${fn}/index.ts`, import.meta.url)); } catch { exists = false; }
    assertEquals(exists, false, `${fn} 已下架（2026-09-23），不要加回來；要寫人物或照片走 correction／politician 貢獻`);
  }
  const router = await Deno.readTextFile(new URL("../../../router/index.ts", import.meta.url));
  assert(!router.includes("AdminScraper"), "資料抓取頁隨 add-politician 下架");
});
