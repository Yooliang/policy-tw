/**
 * #1005：歷史頁依 payload 鍵查 contributions 要有表達式索引。
 * 文字層守門：呼叫端用到的鍵（history.ts）與 migration 建的索引鍵一致。
 */
import { assert } from "jsr:@std/assert@1";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const MIG = await read("../../migrations/20261120100000_contributions_payload_target_idx.sql");
const HISTORY = await read("./history.ts");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

Deno.test("history.ts 依 payload 單鍵查 contributions 的鍵都有表達式索引", () => {
  const keys = new Set<string>();
  for (const m of HISTORY.matchAll(/"payload->>([a-z_]+)"/g)) keys.add(m[1]);
  for (const k of ["politician_id", "policy_id", "question_id"]) {
    assert(keys.has(k), `history.ts 不再用 payload->>${k}，索引與測試該一併調整`);
  }
  const mig = code(MIG);
  for (const k of ["politician_id", "policy_id", "question_id"]) {
    const re = new RegExp(String.raw`CREATE INDEX IF NOT EXISTS \w+\s+ON contributions \(\(payload->>'${k}'\)\)\s+WHERE payload->>'${k}' IS NOT NULL;`);
    assert(re.test(mig), `migration 缺 payload->>'${k}' 的部分索引`);
  }
});

Deno.test("索引表達式與 PostgREST 產生的 payload->>'鍵' 寫法一致（無型別轉換）", () => {
  const mig = code(MIG);
  assert(!/::/.test(mig), "索引表達式不可帶型別轉換，否則查詢用不到");
});
