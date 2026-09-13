import { assert, assertEquals } from "jsr:@std/assert@1";
import { isPolicyStance, POLICY_STANCES, policyStanceName, policyStanceValue } from "./policy-stance.ts";

Deno.test("政見表態：三種立場的 DB 值要跟 migration 的 CHECK 對得上", async () => {
  // migration 寫死 CHECK (stance IN (-1, 1, 2))；這裡逐一比對，
  // 免得日後加第四種時只改了 TS、DB 端直接拒收（那會是一個沒有錯誤訊息的 500）。
  assertEquals(policyStanceValue("support"), 1);
  assertEquals(policyStanceValue("oppose"), -1);
  assertEquals(policyStanceValue("priority"), 2);

  const sql = await Deno.readTextFile(new URL("../../migrations/20260913000001_policy_stances.sql", import.meta.url));
  const m = sql.match(/CHECK \(stance IN \(([^)]+)\)\)/);
  assert(m, "migration 找不到 stance 的 CHECK");
  const allowed = new Set(m![1].split(",").map((x) => Number(x.trim())));
  for (const s of POLICY_STANCES) {
    assert(allowed.has(policyStanceValue(s)), `DB 的 CHECK 不收 ${s}（${policyStanceValue(s)}）`);
  }
  assertEquals(allowed.size, POLICY_STANCES.length, "DB 允許的值數量與 TS 的立場數量不一致");
});

Deno.test("政見表態：值轉名稱要能來回對應，回應才說得出目前立場", () => {
  for (const s of POLICY_STANCES) {
    assertEquals(policyStanceName(policyStanceValue(s)), s);
  }
  assertEquals(policyStanceName(99), null, "不認識的值要回 null，不要硬湊一個立場");
});

Deno.test("政見表態：合法值判斷不能放行任意字串", () => {
  assert(isPolicyStance("support") && isPolicyStance("oppose") && isPolicyStance("priority"));
  assert(!isPolicyStance("up"), "提問用的 up／down 不是政見的立場，不可以混用");
  assert(!isPolicyStance(""), "空字串不是立場");
  assert(!isPolicyStance(1), "數字不是立場");
});

Deno.test("政見表態：計數同步要涵蓋改票與撤回，不是只有新增", () => {
  // 只在 INSERT 上掛 trigger 的話，改立場之後舊的那一票還留在計數裡——
  // 畫面會顯示支持 ＋ 反對加起來比實際表態人數多。
  const sql = Deno.readTextFileSync(new URL("../../migrations/20260913000001_policy_stances.sql", import.meta.url));
  assert(/AFTER INSERT OR UPDATE OR DELETE ON policy_stances/.test(sql), "trigger 要同時涵蓋 INSERT／UPDATE／DELETE");
  assert(sql.includes("UNIQUE (policy_id, voter_ip_hash)"), "一個來源 IP 一條政見只能有一筆表態");
  assert(!/CREATE POLICY "Public read" ON policy_stances/.test(sql), "個別表態帶 IP 雜湊，不可以公開讀");
});
