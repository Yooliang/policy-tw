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

/**
 * 這個投票人在「指定這幾筆貢獻」上投過的票（只回有投過的 id）。
 * /next 只需要回答「候選裡哪幾筆我投過」，所以改成帶 contribution_id 清單去查（走 contribution_id 索引），
 * 不再把這個投票人的全部歷史票翻頁撈回來（ilike 沒有索引，一頁 350ms、投票越多頁數越多）。
 * 身份判斷與 fetchMyVotedRows 完全相同：DiTrust 按 actor_id、匿名按代號（不分大小寫）。
 */
// deno-lint-ignore no-explicit-any
export async function fetchMyVotedAmong(supabase: any, me: MyVoter, contributionIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(contributionIds.filter((v) => typeof v === "string" && v !== ""))];
  if (ids.length === 0) return [];
  const out: string[] = [];
  // 每批 200 個 id：URL 長度與 IN 清單都在安全範圍；一人對一筆貢獻只有一票，每批回傳列數 <= 200
  for (let i = 0; i < ids.length; i += 200) {
    // query-bounds: ok — 限定在這批 <=200 個貢獻 id 上，一個投票人對一筆貢獻最多一票，另有 .limit(1000)
    const q = supabase.from("contribution_votes").select("contribution_id").in("contribution_id", ids.slice(i, i + 200));
    const filtered = typeof me.actorId === "string" && me.actorId.startsWith("ditrust:")
      ? q.eq("actor_id", me.actorId)
      : q.ilike("agent_name", likeEscape(me.agentName));
    const { data, error } = await filtered.limit(1000);
    if (error) throw new Error(`my votes lookup: ${error.message}`);
    for (const r of (data ?? []) as Array<{ contribution_id: string }>) if (typeof r.contribution_id === "string") out.push(r.contribution_id);
  }
  return out;
}
