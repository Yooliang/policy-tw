import { assertEquals } from "jsr:@std/assert@1";
import { loginWalledOnly } from "./question-intake.ts";

// 2026-09-20：9/12 那題「https://www.facebook.com/share/p/19cvWoLMi9/ 更新一下」卡了八天
Deno.test("loginWalledOnly：只有需登入的社群連結＋幾個字 → 擋；有公開網址或有內容 → 放行", () => {
  assertEquals(loginWalledOnly("https://www.facebook.com/share/p/19cvWoLMi9/\n更新一下"), true);
  assertEquals(loginWalledOnly("https://www.instagram.com/p/abc/ 這個"), true);
  assertEquals(loginWalledOnly("https://www.facebook.com/share/p/19cvWoLMi9/ 這篇說台北市長宣布敬老金加碼到每年三千元，請問是真的嗎？"), false, "有內容可查");
  assertEquals(loginWalledOnly("https://www.cna.com.tw/news/aipl/202609020279.aspx 更新一下"), false, "公開網址");
  assertEquals(loginWalledOnly("台北市長的敬老金政見進度如何？"), false, "沒網址");
  assertEquals(loginWalledOnly("https://www.facebook.com/x https://udn.com/news/story/1 更新"), false, "混著公開網址");
});
