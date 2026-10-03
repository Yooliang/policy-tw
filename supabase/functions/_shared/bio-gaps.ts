/**
 * 簡介裡有、學歷／經歷欄卻沒列的（2026-10-04 維護者：「jev 可以掃過 bio 看看裡面有沒有學經歷，但陣列裡面沒有的嗎」→「跑」）。
 *
 * 線上量：有實質簡介的 155 人，學歷欄空 100、經歷欄空 106（關鍵字粗篩約 62／102 人簡介裡提到）。
 * 之前的 profile_detail_gap 臂把「整欄空白」直接開缺口，每次派工都掃整張 politicians 表、拖垮 /next，已暫停。
 * 這裡改成：只看有簡介的人、在 Jev 排程裡跑、一人一次；Jev 判「簡介提到、欄位沒列」才開任務。
 * 簡介本身不一定有出處，所以不直接抄進欄位——任務叫代理去官方來源核對後用 politician 型別補，照常投票。
 */
import type { JevQuestion } from "./system-one.ts";
import type { TaskInput } from "./task-admin.ts";

export const BIO_MIN_LENGTH = 20;
/** 開任務的門檻，跟備註追蹤（FOLLOWUP_MIN_PROBABILITY）同一個水準 */
export const BIO_GAP_MIN_PROBABILITY = 0.85;

export interface BioPerson {
  id: string;
  name: string;
  bio: string | null;
  education: string[] | null;
  experience: string[] | null;
}

export const worthScanning = (p: BioPerson): boolean => (p.bio ?? "").trim().length >= BIO_MIN_LENGTH;

const options = (what: string): Record<string, string> => ({
  missing: `簡介裡提到至少一項${what}，而且 listed 裡沒有列出這一項（寫法不同但指同一件事，算已列出）`,
  covered: `簡介裡提到的${what}，listed 裡都已經列出了`,
  absent: `簡介裡沒有提到任何${what}`,
});

export function buildBioGapAsk(p: BioPerson): { state: Record<string, unknown>; questions: Record<string, JevQuestion> } {
  return {
    state: {
      name: p.name,
      bio: String(p.bio ?? "").slice(0, 3000),
      education_listed: p.education ?? [],
      experience_listed: p.experience ?? [],
    },
    questions: {
      bio_education: {
        type: "choice",
        instructions: "`bio` 是這位政治人物的簡介，`education_listed` 是資料庫已列的學歷（下面說的 listed 指它）。簡介裡有沒有提到學歷（學校、學位、科系）是 `education_listed` 沒列出的？",
        criteria: options("學歷（學校、學位、科系）"),
      },
      bio_experience: {
        type: "choice",
        instructions: "`bio` 是這位政治人物的簡介，`experience_listed` 是資料庫已列的經歷（下面說的 listed 指它）。簡介裡有沒有提到經歷（公職、黨職、工作、社團職務）是 `experience_listed` 沒列出的？",
        criteria: options("經歷（公職、黨職、工作、社團職務）"),
      },
    },
  };
}

export interface BioGapVerdict { education: boolean; experience: boolean }

export function bioGapTask(p: BioPerson, v: BioGapVerdict): TaskInput {
  const parts = [v.education ? "學歷" : null, v.experience ? "經歷" : null].filter(Boolean).join("／");
  return {
    title: `從簡介補${parts}：${p.name}`.slice(0, 120),
    description: [
      `${p.name} 的簡介提到${parts}，但資料庫的${parts}欄沒有列出來（系統用 Jev 比對簡介與欄位後判定）。`,
      `簡介原文：「${String(p.bio ?? "").trim().slice(0, 1200)}」`,
      `目前已列——學歷：${(p.education ?? []).join("、") || "（空）"}；經歷：${(p.experience ?? []).join("、") || "（空）"}`,
      "簡介本身不一定有出處：請到官方來源（中選會候選人資料、選舉公報、議會個人頁、政府機關網站）核對後，",
      "用 politician 型別補上 education／experience 陣列（要附 source_urls，陣列要包含原本已列的項目）。查不到可信來源就用 no_change 回報你查了哪裡。",
    ].join("\n"),
    task_type: "other",
    target_politician_id: p.id,
    target_extra: { followup_kind: "bio_gap", bio_education: v.education, bio_experience: v.experience },
  };
}
