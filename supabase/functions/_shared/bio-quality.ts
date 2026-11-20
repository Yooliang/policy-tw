/**
 * 人物簡介（bio）品質判定（#975）。簡介只能描述這個人（身分、經歷、參選紀錄），
 * 不能描述「我怎麼查、查到什麼沒查到」。代理把查證過程寫進 bio，Google 會把它當摘要顯示。
 *
 * 啟發式（bioProblems）先判：命中任一條就是壞簡介，不用花 Jev。沒命中才問 Jev（bioJudgePrompt／BIO_QUESTION）。
 * 提示詞與測試共用這份規則。只影響 precheck 對 bio 這一項的系統票，不碰目標分數規則與 400 守門。
 */
import { type JevQuestion, MIN_PROBABILITY } from "./system-one.ts";

export const BIO_QUESTION = "bio_intro";
export const BIO_HEURISTIC_MODEL = "policy-tw/bio-heuristic-00000000";
const SENTENCE_MAX = 100;

interface BioRule { kind: string; re: RegExp }

/** 規則：每條一個類別（給驗證者看的說明）＋一個正規式；英文詞一律不分大小寫 */
export const BIO_RULES: readonly BioRule[] = [
  { kind: "提到工具或指令", re: /pdftotext|bbox|pymupdf|\bcurl\b|\bAPI\b|\bJSON\b|\.pdf\b|[0-9a-f]{16,}/i },
  { kind: "在描述查證過程", re: /我用|核過|核對|查詢結果|回\s*\d+\s*筆|第\s*\d+\s*頁|搜尋了|搜了/ },
  { kind: "在自述查無或留空", re: /查無|未載|留空|不填|尚未發布故/ },
  // 「代理」是職稱的一部分時（代理人、代理鄉長、代理市長、代理主任…）不算
  { kind: "提到 AI／代理／系統", re: /(?<![A-Za-z])(?:AI|agents?|LLM|Claude|GPT|Gemini|Jev)(?![A-Za-z])|人工智慧|代理(?!人|.?長|主任|主席|議員|委員)|本站|系統|自動|模型/i },
  { kind: "出現對讀者無意義的系統詞", re: /任務|交件|驗證者|politician_id/i },
];

/** 切句：句號、分號、換行都算句界；空句丟掉 */
function sentencesOf(bio: string): string[] {
  return bio.split(/[。；;！？!?\n]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 命中的問題清單（中文，給驗證者看）；空陣列＝啟發式沒挑出毛病 */
export function bioProblems(bio: string): string[] {
  const out: string[] = [];
  for (const s of sentencesOf(String(bio ?? ""))) {
    const rule = BIO_RULES.find((r) => r.re.test(s));
    if (rule) out.push(`${rule.kind}：「${s.length > SENTENCE_MAX ? `${s.slice(0, SENTENCE_MAX)}…` : s}」`);
  }
  return out;
}

/** 給 Jev 的判定說明（與啟發式同一份標準） */
export function bioJudgePrompt(): string {
  return "這一題判斷 state.bio 這段文字是不是「人物介紹」。簡介只能描述這個人本身：身分、現任職務、經歷、參選紀錄。" +
    "不能描述「我怎麼查、查到什麼沒查到」：例如用了什麼工具或指令、查了哪個資料庫或網站、查詢回幾筆、第幾頁、某項資料查無或尚未公布所以留空，都不是人物介紹。" +
    "另外，簡介裡提到 AI、人工智慧、代理（agent，不含「代理人」「代理鄉長」這類職稱）、本站、系統、自動、模型、Claude、GPT、Gemini、Jev 之類的字眼，也一律選 not_intro。只要整段或其中一部分是在交代查證過程或資料缺漏，就選 not_intro；整段都在介紹這個人才選 intro。";
}

export function bioQuestion(): JevQuestion {
  return {
    type: "choice",
    instructions: bioJudgePrompt(),
    criteria: {
      intro: "整段都在描述這個人（身分、經歷、參選紀錄）",
      not_intro: "有任何一部分在交代查證過程、工具、來源名稱，或資料查無／留空",
    },
  };
}

/** 這筆貢獻要判的簡介文字：politician 取 payload.bio；correction 取「改 bio」那一項的新值；其他型別不判 */
export function bioOf(contributionType: string, payload: Record<string, unknown>): string | null {
  let v: unknown = null;
  if (contributionType === "politician") v = payload.bio;
  else if (contributionType === "correction") {
    const changes = Array.isArray(payload.changes) ? payload.changes : (payload.field ? [payload] : []);
    const hit = (changes as Array<Record<string, unknown>>).find((ch) => ch?.field === "bio");
    v = hit?.correct_value;
  }
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export interface BioVerdict {
  choice: "not_supported";
  probability: number;
  source: "heuristic" | "jev";
  problems: string[];
}

/**
 * 簡介這一項的判定。啟發式命中 → not_supported（機率 1）；沒命中才看 Jev 的答案，
 * Jev 說 not_intro 且機率過門檻 → not_supported；其他（沒問、intro、機率不夠）＝null，不影響原本的票。
 */
export function bioVerdict(
  bio: string | null,
  jev?: { choice: string; probabilities?: Record<string, number> } | null,
  minProbability = MIN_PROBABILITY,
): BioVerdict | null {
  if (!bio) return null;
  const problems = bioProblems(bio);
  if (problems.length > 0) return { choice: "not_supported", probability: 1, source: "heuristic", problems };
  if (jev && jev.choice === "not_intro") {
    const p = Number((jev.probabilities?.not_intro ?? 0).toFixed(4));
    if (p >= minProbability) return { choice: "not_supported", probability: p, source: "jev", problems: ["Jev 判定這段不是人物介紹"] };
  }
  return null;
}

/** 把簡介判定併進來源核對的票：有判定就整票改 not_supported，沒有就原樣 */
export function applyBioVerdict<T extends { choice: string; probability: number }>(vote: T, verdict: BioVerdict | null): T {
  return verdict ? { ...vote, choice: verdict.choice, probability: Math.max(vote.choice === "not_supported" ? vote.probability : 0, verdict.probability) } : vote;
}
