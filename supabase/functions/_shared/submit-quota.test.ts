import { assertEquals } from "jsr:@std/assert";
import { VERIFY_DAILY_LIMIT_PER_DITRUST, VERIFY_DAILY_LIMIT_PER_IP, verifyQuotaFor } from "./verify-handler.ts";
import { CONTRIBUTE_DAILY_LIMIT_PER_DITRUST, CONTRIBUTE_DAILY_LIMIT_PER_IP, submitQuotaFor } from "./contribute-handler.ts";

// 2026-10-02：DiTrust 帳號的提交額度按帳號算、比匿名高；投票不受影響（藍圖 §6：帳號多拿額度，不多拿票）
Deno.test("DiTrust 帳號：提交額度按 actor_id 算，用帳號上限", () => {
  const q = submitQuotaFor({ level: "ditrust", actor_id: "ditrust:00000000-0000-4000-8000-000000000001", handle: "測試" }, "iphash");
  assertEquals(q.column, "actor_id");
  assertEquals(q.value, "ditrust:00000000-0000-4000-8000-000000000001");
  assertEquals(q.limit, CONTRIBUTE_DAILY_LIMIT_PER_DITRUST);
});

Deno.test("匿名代理：提交額度照舊按來源 IP 算，上限不變", () => {
  const q = submitQuotaFor({ level: "ip", actor_id: "ip:iphash", handle: "rebecca" }, "iphash");
  assertEquals(q.column, "contributor_ip_hash");
  assertEquals(q.value, "iphash");
  assertEquals(q.limit, CONTRIBUTE_DAILY_LIMIT_PER_IP);
});

Deno.test("帳號上限要比匿名高，不然註冊沒有誘因", () => {
  if (!(CONTRIBUTE_DAILY_LIMIT_PER_DITRUST > CONTRIBUTE_DAILY_LIMIT_PER_IP)) throw new Error("帳號上限沒有高於匿名");
});

Deno.test("驗證額度：DiTrust 帳號按帳號算、上限較高；匿名照舊按 IP", () => {
  const a = verifyQuotaFor({ level: "ditrust", actor_id: "ditrust:00000000-0000-4000-8000-000000000001", handle: "測試" }, "iphash");
  assertEquals([a.column, a.limit], ["actor_id", VERIFY_DAILY_LIMIT_PER_DITRUST]);
  const b = verifyQuotaFor({ level: "ip", actor_id: "ip:iphash", handle: "x" }, "iphash");
  assertEquals([b.column, b.value, b.limit], ["verifier_ip_hash", "iphash", VERIFY_DAILY_LIMIT_PER_IP]);
});
