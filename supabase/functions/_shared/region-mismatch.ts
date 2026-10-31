/**
 * 參選紀錄縣市對不上（region_mismatch，2026-10-31）。
 *
 * 起因：吳炳輝 2026 縣市長的參選紀錄掛在台南市（region_id 4175），代理交件 candidacy 明講是雲林縣、號次 1。
 * 落庫對「既有紀錄已經有縣市層級的地區」一律保留原本的 region_id，只寫了號次——號次記進了台南市、
 * 雲林縣少一號，台南市多一個 1 號，而且沒有任何人被通知。
 *
 * 做法：號次照舊落庫，但交件的縣市跟現有的不同時不默默丟掉，開一件手動任務（region_mismatch），
 * 讓代理查中選會／選委會公告後裁決：現有的錯 → correction 把 politician_elections.region_id 改成 target 裡的正確縣市那一列
 * （經驗證票，落庫端守門只收「縣市長、縣市層級改縣市層級」，見 regionIdCorrectionProblem）；現有的對 → no_change confirmed。
 * 同一筆參選紀錄、同一個提議縣市只開一次（不論任務開著或關了）。
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export const REGION_MISMATCH_TASK_TYPE = "region_mismatch";

export interface RegionMismatchTarget {
  politician_election_id: number | string;
  politician_id: string;
  name: string | null;
  election_id: number;
  election_type: string;
  cand_no: number | null;
  current_region_id: number;
  current_region: string;
  proposed_region_id: number;
  proposed_region: string;
  contribution_id: string | null;
}

export function buildRegionMismatchTask(t: RegionMismatchTarget): Obj {
  const who = t.name ?? "這位";
  return {
    title: `「${who}」的${t.election_type}縣市：${t.current_region} 還是 ${t.proposed_region}`,
    description: `「${who}」這一屆${t.election_type}的參選紀錄現在記在「${t.current_region}」，但有交件寫的是「${t.proposed_region}」（號次已照交件記下）。` +
      `請查中選會或選委會的候選人名單／抽籤公告，確認他實際在哪個縣市登記參選。`,
    task_type: REGION_MISMATCH_TASK_TYPE,
    target: { ...t },
    region: t.proposed_region,
    priority: 0,
    reward: 1,
    status: "open",
    source: "auto_dispute",
    created_by: "region-mismatch",
    hint_sources: [],
  };
}

/** 交件的縣市跟參選紀錄現有的不同時開任務。回覆給代理的那半句 */
export async function openRegionMismatch(supabase: SupabaseLike, t: RegionMismatchTarget): Promise<string> {
  const { data: existing, error } = await supabase.from("contribution_tasks").select("id")
    .eq("task_type", REGION_MISMATCH_TASK_TYPE)
    .eq("target->>politician_election_id", t.politician_election_id)
    .eq("target->>proposed_region_id", t.proposed_region_id).limit(1);
  if (error) throw new Error(`contribution_tasks region_mismatch lookup: ${error.message}`);
  const warn = `；注意：這筆參選紀錄現在記在「${t.current_region}」，你交件的縣市是「${t.proposed_region}」，地區沒有改（號次已記下）。` +
    `號次缺口任務的 task_id 是照現在記的縣市（${t.current_region}）編的，修正前請不要拿它當作${t.proposed_region}的缺口。`;
  if ((existing ?? []).length > 0) return `${warn}這個差異已經開過「縣市對不上」任務。`;
  const { error: insertError } = await supabase.from("contribution_tasks").insert(buildRegionMismatchTask(t));
  if (insertError) throw new Error(`contribution_tasks region_mismatch insert: ${insertError.message}`);
  return `${warn}已開「縣市對不上」任務，讓其他代理查公告後用 correction 改正。`;
}

/**
 * correction 改 politician_elections.region_id 的守門（落庫端）：
 * 只收縣市長、現值與新值都是縣市層級（sub_region、village 皆空）的 regions 列、而且確實不同。
 * 回傳 null＝可以；否則是講給代理聽的理由。
 */
export async function regionIdCorrectionProblem(
  supabase: SupabaseLike,
  electionType: string | null | undefined,
  currentRegionId: unknown,
  newValue: unknown,
): Promise<string | null> {
  if (electionType !== "縣市長") return "region_id 的更正目前只收縣市長（縣市層級改縣市層級）；議員、立委的選區請用 candidacy 交 electoral_district";
  const id = typeof newValue === "number" ? newValue : /^\d+$/.test(String(newValue ?? "")) ? Number(newValue) : NaN;
  if (!Number.isInteger(id)) return "region_id 的 correct_value 要是 regions 表的整數 id（任務 target.proposed_region_id）";
  const levelOf = async (rid: unknown) => {
    // query-bounds: ok — 按主鍵取一列
    const { data } = await supabase.from("regions").select("id, region, sub_region, village").eq("id", rid).maybeSingle();
    return data as { region?: string | null; sub_region?: string | null; village?: string | null } | null;
  };
  const next = await levelOf(id);
  if (!next) return `regions 表沒有 id=${id} 這一列`;
  if (next.sub_region || next.village || !next.region) return `regions id=${id} 不是縣市層級（縣市長的地區要指到縣市那一列）`;
  if (currentRegionId != null) {
    const cur = await levelOf(currentRegionId);
    if (!cur || cur.sub_region || cur.village) return "這筆參選紀錄現在的地區不是縣市層級，不走這條更正";
  }
  return null;
}
