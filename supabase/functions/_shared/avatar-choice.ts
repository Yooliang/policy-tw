/**
 * 照片二選一（avatar_choice，維護者 2026-10-11，policy-ops#89）。
 *
 * 起因：politician 交件「對到既有人物只補空欄位」。人物已經有照片時，後來通過驗證的另一張照片
 * 會被默默丟掉、狀態照樣 applied（回覆只寫「無空欄位可補」）。蕭燐洪的照片被公報整頁截圖佔住，
 * 10-05 交的本人人像 10-11 通過驗證卻沒套用；全站同樣情況 88 筆、69 位。
 *
 * 做法：照片不同時不覆蓋、也不丟掉，開一件手動任務讓代理在「現有」與「新交」兩張裡挑一張比較合適的。
 * 挑新的 → correction 改 politicians.avatar_url（照片形狀守門照舊）；留現有的 → no_change。
 * 同一位、同一張新照片只開一次（不論那件任務開著或關了），免得同一張照片被反覆交、反覆開任務。
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export const AVATAR_CHOICE_TASK_TYPE = "avatar_choice";

/** 挑照片的標準（維護者 2026-10-11 原話：PDF 裡的黑白照、側臉之類的，兩張挑一張比較合適的，缺點能避免就盡量避免） */
export const AVATAR_CHOICE_CRITERIA =
  "這些都不算合格，盡量避開：背影、側臉、黑白照（選舉公報或 PDF 裡的常是）、從截圖裡裁出來的照片或整頁公報與文件截圖、有多個人物的照片（合照、活動現場照）、海報或旁邊夾著文字的圖、太小或模糊的圖。" +
  "優先：彩色、正面、只有本人、臉清楚的人像照。兩張都有缺點時挑缺點少的。";

export interface AvatarChoiceTarget {
  politician_id: string;
  name: string | null;
  current_avatar_url: string;
  new_avatar_url: string;
  contribution_id: string | null;
}

/** 純函式：任務標題、說明、target */
export function buildAvatarChoiceTask(t: AvatarChoiceTarget, region: string | null): Obj {
  const who = t.name ?? "這位";
  return {
    title: `「${who}」的照片二選一`,
    description: `「${who}」已經有照片，又有人交了另一張。兩張都打開看，挑一張比較合適的本人人像照。${AVATAR_CHOICE_CRITERIA}`,
    task_type: AVATAR_CHOICE_TASK_TYPE,
    target: {
      politician_id: t.politician_id,
      name: t.name,
      current_avatar_url: t.current_avatar_url,
      new_avatar_url: t.new_avatar_url,
      ...(t.contribution_id ? { contribution_id: t.contribution_id } : {}),
    },
    region,
    priority: 0,
    reward: 1,
    status: "open",
    source: "auto_dispute",
    created_by: "avatar-choice",
    hint_sources: [],
  };
}

/**
 * 交件的照片跟現有的不同時開一件二選一任務。回覆給代理的那半句。
 * 同一位、同一張新照片開過就不再開（任何狀態都算）；新照片是佔位圖不開（存進去也會被觸發器清成空值）。
 */
export async function openAvatarChoice(
  supabase: SupabaseLike,
  t: AvatarChoiceTarget,
  region: string | null,
): Promise<string> {
  const { data: placeholder } = await supabase.rpc("is_placeholder_avatar", { p_url: t.new_avatar_url });
  if (placeholder === true) return "；照片沒套用：是佔位圖，不算照片";
  const { data: existing, error } = await supabase.from("contribution_tasks").select("id, status")
    .eq("task_type", AVATAR_CHOICE_TASK_TYPE).eq("target->>politician_id", t.politician_id).eq("target->>new_avatar_url", t.new_avatar_url).limit(1);
  if (error) throw new Error(`contribution_tasks avatar_choice lookup: ${error.message}`);
  if ((existing ?? []).length > 0) return "；照片沒套用：這位已經有照片，同一張照片已經開過「照片二選一」任務";
  const { error: insertError } = await supabase.from("contribution_tasks").insert(buildAvatarChoiceTask(t, region));
  if (insertError) throw new Error(`contribution_tasks avatar_choice insert: ${insertError.message}`);
  return "；照片沒套用：這位已經有照片，已開「照片二選一」任務，讓其他代理在兩張裡挑一張比較合適的";
}

/** 純函式：二選一任務給代理看的現況。現有照片讀人物表的現值（任務開了之後可能被別的交件換過） */
export function shapeAvatarChoiceCurrent(target: Obj | null, politician: Obj | null): Obj {
  const t = target ?? {};
  const live = typeof politician?.avatar_url === "string" && politician.avatar_url ? politician.avatar_url : null;
  const proposed = typeof t.new_avatar_url === "string" ? t.new_avatar_url : null;
  const note = !live ? "這位現在沒有照片：新交的那張合適就用 correction 補上（current_value 填 null）。"
    : live === proposed ? "現有照片已經就是新交的那張了，用 no_change（outcome=confirmed）回報即可。"
    : live !== t.current_avatar_url ? "任務開了之後現有照片已經換過，以 candidates 裡的現有照片為準。"
    : null;
  return {
    politician: politician ? { id: politician.id, name: politician.name, party: politician.party, region: politician.region, election_type: politician.election_type } : null,
    candidates: [
      { which: "current", label: "現有照片", url: live },
      { which: "new", label: "新交的照片", url: proposed, contribution_id: t.contribution_id ?? null },
    ],
    criteria: AVATAR_CHOICE_CRITERIA,
    ...(note ? { candidates_note: note } : {}),
  };
}
