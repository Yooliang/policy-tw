/**
 * seed 排程縮短（migration 20261126010000_seed_arms_slim.sql，2026-11-26）守門，文字層。
 *   · 兩個索引都在、謂詞與 legacy／mismatch 臂的查詢條件一致（謂詞不一致規劃器就不會用）
 *   · legacy 臂：政見候選先用便宜條件收窄（MATERIALIZED），policy_primary_url 只在收窄後才呼叫；兩條排除條件一條沒少
 *   · mismatch 臂本體沒被這支遷移重定義（只加索引）
 */
import { assert } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const mig = (await Deno.readTextFile(new URL("20261126010000_seed_arms_slim.sql", MIGRATIONS))).replace(/\r\n/g, "\n");
const sql = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

Deno.test("A1 edit_history 部分索引的謂詞與 legacy 臂的 NOT EXISTS 一致", () => {
  assert(/CREATE INDEX IF NOT EXISTS idx_edit_history_policies_audited\s+ON edit_history \(record_id\)\s+WHERE table_name = 'policies' AND field IN \('audit', '\*'\)/.test(sql));
  assert(/e\.table_name = 'policies' AND e\.record_id = pl\.id::TEXT AND e\.field IN \('audit', '\*'\)/.test(sql));
});

Deno.test("A2 jev_decisions 覆蓋式部分索引的謂詞與 mismatch 臂的 jev CTE 一致", async () => {
  assert(/CREATE INDEX IF NOT EXISTS jev_decisions_policy_election_latest_idx\s+ON jev_decisions \(subject_id, asked_at DESC\) INCLUDE \(choice, probability\)\s+WHERE subject_type = 'policy' AND question = 'election'/.test(sql));
  const src = await Deno.readTextFile(new URL("20261011380000_mismatch_candidacy_sources.sql", MIGRATIONS));
  assert(/j\.subject_type = 'policy' AND j\.question = 'election'/.test(src));
  assert(/ORDER BY j\.subject_id, j\.asked_at DESC/.test(src));
  assert(!/FUNCTION contribution_auto_tasks_mismatch/.test(sql), "這支遷移不重定義 mismatch 臂，只加索引");
});

Deno.test("A3 legacy 臂：先收窄、最後才呼叫 policy_primary_url，兩條排除條件都在", () => {
  const fn = sql.slice(sql.indexOf("FUNCTION contribution_auto_tasks_legacy()"));
  assert(/WITH cand AS MATERIALIZED/.test(fn));
  const candEnd = fn.indexOf("SELECT 'auto:legacy_audit:'");
  const cand = fn.slice(0, candEnd);
  assert(!/policy_primary_url/.test(cand), "收窄那一層不能呼叫 policy_primary_url");
  assert(/e\.field IN \('audit', '\*'\)/.test(cand));
  assert(/c\.applied_policy_id = pl\.id AND c\.contribution_type = 'policy'/.test(cand));
  assert(/p\.merged_into IS NULL[\s\S]*policy_primary_url\(pl\.id\) IS NOT NULL/.test(fn.slice(candEnd)));
  assert(/'auto:legacy_audit:' \|\| pl\.id, 'legacy_audit'/.test(fn));
});
