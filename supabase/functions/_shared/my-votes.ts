import { fetchAllRows } from "./fetch-all.ts";

/** 投過票的人是誰：DiTrust 帳號按 actor_id、匿名按代號（維護者 2026-11-04：投票不看來源網段） */
export interface MyVoter { agentName: string; actorId?: string | null }

/** ilike 的跳脫：代號只含字母數字 ._-，其中 _ 是萬用字元，要跳脫 */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/**
 * 這個投票人投過票的貢獻 id（給 /next 排掉「對原貢獻投過票的人又被派去裁決同一件爭議」用）。
 * 只是過濾自己投過的，不是新增清單現算——/next 只讀佇列的規則（2026-09-23）不受影響。
 * 這一份只會成長（沒有狀態篩選），所以要翻頁撈。
 */
// deno-lint-ignore no-explicit-any
export function fetchMyVotedRows(supabase: any, me: MyVoter): Promise<Array<{ contribution_id: string }>> {
  return fetchAllRows<{ contribution_id: string }>("my votes", (from, to) => {
    // query-bounds: ok — 篩選接在這條之後，緊接著 .order().range(from, to) 由 fetchAllRows 逐頁翻
    const q = supabase.from("contribution_votes").select("contribution_id");
    const filtered = typeof me.actorId === "string" && me.actorId.startsWith("ditrust:")
      ? q.eq("actor_id", me.actorId)
      : q.ilike("agent_name", likeEscape(me.agentName));
    return filtered.order("created_at", { ascending: true }).range(from, to);
  });
}
