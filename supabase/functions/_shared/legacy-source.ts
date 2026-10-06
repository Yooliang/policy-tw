/**
 * 舊 AI 管線（ai-action、ai-contribute、ai-update-progress）寫出處與讀出處的共用小工具（#347 第二階段 B-1）。
 *
 * 這幾支函式以前直接把 source_url 寫進 policies／tracking_logs（舊欄位）、把佐證寫進 policy_sources（舊表），
 * 靠資料庫的同步觸發器長出出處表。舊欄位與舊表要刪了，所以改成呼叫資料庫的 source_write()（跟貢獻協議的落庫端同一個函式）
 * 直接寫出處表；讀也改讀出處表。只有 service role 的 client 呼叫得動 source_write。
 * 這些是遺留的管理端點（2026-02 的 Claude-PM 架構，正逐步被貢獻協議取代）：失敗只記 log，不擋它原本的流程。
 */
import { isHttpUrl } from "./source-priority.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export interface LegacySourceItem {
  url: unknown;
  title?: unknown;
  publisher?: unknown;
  /** primary＝這筆資料還沒有主要出處就當主要；supporting＝一律佐證（預設 primary） */
  role?: "primary" | "supporting";
}

/** 把一個或多個網址寫進出處表，掛在 table／id 這筆資料上；回傳送出去的網址數（0＝沒有合格網址或寫失敗） */
export async function writeLegacySources(
  supabase: SupabaseLike, table: "policies" | "tracking_logs", id: string | number | null | undefined, items: readonly LegacySourceItem[], origin: string,
): Promise<number> {
  if (id === null || id === undefined || id === "") return 0;
  const sources = items
    .map((i) => ({
      url: typeof i.url === "string" ? i.url.trim() : "",
      ...(typeof i.title === "string" && i.title.trim() ? { title: i.title.trim().slice(0, 200) } : {}),
      ...(typeof i.publisher === "string" && i.publisher.trim() ? { publisher: i.publisher.trim().slice(0, 100) } : {}),
      role: i.role ?? "primary",
    }))
    .filter((s) => s.url && isHttpUrl(s.url));
  if (sources.length === 0) return 0;
  try {
    const { error } = await supabase.rpc("source_write", { p_target_table: table, p_target_id: String(id), p_sources: sources, p_origin: origin });
    if (error) {
      console.error(`source_write（${origin}，${table}#${id}）失敗：${error.message}`);
      return 0;
    }
    return sources.length;
  } catch (e) {
    console.error(`source_write（${origin}，${table}#${id}）例外：${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/** 一條政見的出處清單（主要在前），欄位名照舊的 policy_sources（url、title、source_name、published_date）加上 role／kind */
export async function listPolicySources(
  supabase: SupabaseLike, policyId: string, limit = 50, offset = 0,
): Promise<{ rows: Array<Record<string, unknown>>; error: string | null }> {
  const { data, error } = await supabase.from("source_refs")
    .select("role, created_at, sources(url, title, publisher, published_date, source_kind, archive_url)")
    .eq("target_table", "policies").eq("target_id", policyId)
    .order("created_at", { ascending: true }).range(offset, offset + Math.max(1, Math.min(limit, 200)) - 1);
  if (error) return { rows: [], error: error.message };
  const rows = ((data ?? []) as Array<{ role: string; sources: Record<string, unknown> | Array<Record<string, unknown>> | null }>)
    .map((r) => {
      const s = (Array.isArray(r.sources) ? r.sources[0] : r.sources) ?? {};
      return {
        policy_id: policyId, url: s.url ?? null, title: s.title ?? null, source_name: s.publisher ?? null,
        published_date: s.published_date ?? null, role: r.role, kind: s.source_kind ?? null, archive_url: s.archive_url ?? null,
      };
    })
    .sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"));
  return { rows, error: null };
}
