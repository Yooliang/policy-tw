/**
 * /trace 重播頁的資料來源 trace_events()（migration 20261111140000_trace_events.sql，2026-11-11）守門。
 * 只要 --allow-read。
 *
 * 這支函式是 SECURITY DEFINER：匿名讀不到的表（交件、投票、驗證票派出、認領事件）靠它對外。所以守三件事：
 *   A. 不洩漏：函式 SQL 不出現來源網段雜湊、憑證、帳號識別的字樣（只回代理顯示名）
 *   B. 有界：每個 UNION 分支各自有時限與 LIMIT；p_since 有 14 天下限、p_limit 有 5000 上限；
 *            驗證票派出與認領事件的回看期 ≤ 各自的保留天數（驗證票另受清理守門的「派工綁定 7 天」限制）
 *   C. 權限與屬性：SECURITY DEFINER、固定 search_path、STABLE、只授權給 anon／authenticated／service_role
 * 每條守門都做還原驗證：把原始碼精確改壞一處（改不到就失敗），對應的檢查必須紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const TRACE_MIG = "20261111140000_trace_events.sql";
const LEASE_MIG = "20261111120000_lease_events.sql";
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const REAL = norm(await Deno.readTextFile(new URL(TRACE_MIG, MIGRATIONS)));
const LEASE = norm(await Deno.readTextFile(new URL(LEASE_MIG, MIGRATIONS)));

/** 拿掉 -- 註解（避免註解裡的字樣干擾；字串裡沒有 --） */
const stripComments = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

const FORBIDDEN = [/ip_hash/i, /token/i, /actor_id/i, /voter_ips/i, /contributor_ip/i, /verifier_ip/i];
const MAX_DAYS = 14;
/** 驗證票派出：清理守門要求回看期 ≤ 派工綁定 7 天（保留 14 天減邊際）；這裡再釘一次 */
const VERIFY_DISPATCH_MAX_DAYS = 7;

/** 回傳問題清單（空＝全部合格） */
function problemsOf(sql: string, leaseRetentionDays: number): string[] {
  const out: string[] = [];
  const code = stripComments(sql);
  // A. 不洩漏——整支檔（含 COMMENT）都不准出現
  for (const re of FORBIDDEN) if (re.test(sql)) out.push(`含有不准出現的字樣 ${re}`);

  // B. 有界
  const m = /RETURN QUERY([\s\S]*?)\nEND;\n\$\$;/.exec(code);
  if (!m) return [...out, "找不到 RETURN QUERY 本體"];
  const body = m[1];
  const inner = /FROM \(([\s\S]*)\) e\s+WHERE e\.at IS NOT NULL/.exec(body);
  if (!inner) return [...out, "找不到包住各分支的子查詢"];
  const branches = inner[1].split(/\n\s*UNION ALL\n/).map((b) => b.trim());
  if (branches.length < 10) out.push(`UNION 分支只有 ${branches.length} 個，少了來源`);
  for (const b of branches) {
    const label = /FROM\s+([a-z_]+)/i.exec(b)?.[1] ?? b.slice(0, 40);
    const lim = /(?:created_at|\bat|checked_at|requested_at|closed_at|verified_at|applied_at|reviewed_at|dispatched_at)\s*>=\s*GREATEST\(v_since,\s*now\(\)\s*-\s*interval\s*'(\d+) days'\)/.exec(b);
    if (!lim) { out.push(`分支 ${label} 沒有 >= 時限`); continue; }
    const days = Number(lim[1]);
    if (days > MAX_DAYS) out.push(`分支 ${label} 回看 ${days} 天 > ${MAX_DAYS}`);
    if (/FROM\s+verify_dispatches/i.test(b) && days > VERIFY_DISPATCH_MAX_DAYS) out.push(`verify_dispatches 回看 ${days} 天 > ${VERIFY_DISPATCH_MAX_DAYS}`);
    if (/FROM\s+lease_events/i.test(b) && days > leaseRetentionDays) out.push(`lease_events 回看 ${days} 天 > 保留 ${leaseRetentionDays} 天`);
    if (!/ORDER BY[^\n]*DESC LIMIT v_lim\)/.test(b)) out.push(`分支 ${label} 沒有 ORDER BY … DESC LIMIT v_lim`);
  }
  if (!/FROM\s+lease_events/i.test(inner[1])) out.push("少了 lease_events 分支");
  if (!/FROM\s+verify_dispatches/i.test(inner[1])) out.push("少了 verify_dispatches 分支");
  if (!/ORDER BY e\.at DESC\s+LIMIT v_lim;/.test(body)) out.push("最外層沒有 ORDER BY e.at DESC LIMIT v_lim");
  if (!/v_since\s+TIMESTAMPTZ\s*:=\s*GREATEST\(coalesce\(p_since,\s*now\(\)\s*-\s*interval\s*'4 hours'\),\s*now\(\)\s*-\s*interval\s*'14 days'\)/.test(code)) out.push("p_since 沒有 14 天下限");
  if (!/v_lim\s+INT\s*:=\s*LEAST\(GREATEST\(coalesce\(p_limit,\s*5000\),\s*1\),\s*5000\)/.test(code)) out.push("p_limit 沒有 5000 上限");

  // C. 屬性與權限
  if (!/LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public/.test(code)) out.push("不是 STABLE SECURITY DEFINER SET search_path = public");
  if (!/REVOKE ALL ON FUNCTION trace_events\([^)]*\) FROM PUBLIC;/.test(code)) out.push("沒有 REVOKE ALL FROM PUBLIC");
  const grant = /GRANT EXECUTE ON FUNCTION trace_events\([^)]*\) TO ([A-Za-z_, ]+);/.exec(code);
  if (!grant) out.push("沒有 GRANT EXECUTE");
  else if (grant[1].replace(/\s/g, "") !== "anon,authenticated,service_role") out.push(`GRANT 對象不是 anon, authenticated, service_role：${grant[1]}`);
  return out;
}

const leaseDays = Number(/lease_events_days INTEGER NOT NULL DEFAULT (\d+)/.exec(LEASE)?.[1] ?? NaN);

function mutate(sql: string, from: string | RegExp, to: string): string {
  const next = typeof from === "string" ? sql.split(from).join(to) : sql.replace(from, to);
  assert(next !== sql, `還原驗證：改不到 ${from}`);
  return next;
}

Deno.test("A/B/C trace_events 的原始 migration 沒有任何問題", () => {
  assert(Number.isFinite(leaseDays), "抽不出 lease_events_days 預設值");
  assertEquals(problemsOf(REAL, leaseDays), []);
});

Deno.test("回看期不超過保留期：lease_events 保留天數 ≥ 14", () => {
  assert(leaseDays >= MAX_DAYS, `lease_events 保留 ${leaseDays} 天，trace_events 回看 ${MAX_DAYS} 天`);
});

Deno.test("還原驗證：洩漏字樣 → 紅", () => {
  for (const bad of ["l.ip_hash", "c.actor_id", "v.verifier_ip_hash", "dispatch_token"]) {
    const sql = mutate(REAL, "SELECT e.at, e.kind,", `SELECT ${bad} AS leak, e.at, e.kind,`);
    assert(problemsOf(sql, leaseDays).some((p) => p.includes("不准出現")), `${bad} 應該被抓到`);
  }
});

Deno.test("還原驗證：分支拿掉時限、LIMIT、或回看期放大 → 紅", () => {
  const noTime = mutate(REAL, "WHERE t.created_at >= GREATEST(v_since, now() - interval '14 days') AND t.created_at < v_until AND (v_all OR t.id::text = ANY(v_tasks))", "WHERE t.created_at < v_until AND (v_all OR t.id::text = ANY(v_tasks))");
  assert(problemsOf(noTime, leaseDays).some((p) => p.includes("沒有 >= 時限")));
  const noLimit = mutate(REAL, "ORDER BY k.checked_at DESC LIMIT v_lim)", "ORDER BY k.checked_at DESC)");
  assert(problemsOf(noLimit, leaseDays).some((p) => p.includes("沒有 ORDER BY")));
  const big = mutate(REAL, "g.at >= GREATEST(v_since, now() - interval '14 days')", "g.at >= GREATEST(v_since, now() - interval '30 days')");
  assert(problemsOf(big, leaseDays).some((p) => p.includes("> 14")));
  const vd = mutate(REAL, "vd.dispatched_at >= GREATEST(v_since, now() - interval '7 days')", "vd.dispatched_at >= GREATEST(v_since, now() - interval '14 days')");
  assert(problemsOf(vd, leaseDays).some((p) => p.includes("verify_dispatches 回看")));
  assertEquals(problemsOf(REAL, 7).some((p) => p.includes("lease_events 回看")), true, "保留天數比回看期短要紅");
});

Deno.test("還原驗證：p_since 下限、p_limit 上限被拿掉 → 紅", () => {
  const since = mutate(REAL, "GREATEST(coalesce(p_since, now() - interval '4 hours'), now() - interval '14 days')", "coalesce(p_since, now() - interval '4 hours')");
  assert(problemsOf(since, leaseDays).some((p) => p.includes("14 天下限")));
  const lim = mutate(REAL, "LEAST(GREATEST(coalesce(p_limit, 5000), 1), 5000)", "coalesce(p_limit, 5000)");
  assert(problemsOf(lim, leaseDays).some((p) => p.includes("5000 上限")));
  const outer = mutate(REAL, "ORDER BY e.at DESC\n  LIMIT v_lim;", "ORDER BY e.at DESC;");
  assert(problemsOf(outer, leaseDays).some((p) => p.includes("最外層")));
});

Deno.test("還原驗證：不是 SECURITY DEFINER、授權給 PUBLIC 或其他角色 → 紅", () => {
  const def = mutate(REAL, "STABLE SECURITY DEFINER SET search_path = public", "STABLE SET search_path = public");
  assert(problemsOf(def, leaseDays).some((p) => p.includes("SECURITY DEFINER")));
  const rev = mutate(REAL, "REVOKE ALL ON FUNCTION", "-- REVOKE ALL ON FUNCTION");
  assert(problemsOf(rev, leaseDays).some((p) => p.includes("REVOKE")));
  const grant = mutate(REAL, "TO anon, authenticated, service_role;", "TO PUBLIC;");
  assert(problemsOf(grant, leaseDays).some((p) => p.includes("GRANT 對象")));
});
