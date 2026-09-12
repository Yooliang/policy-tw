/**
 * 公民提問（citizen_questions）的品質守門：純函式，`ask` 端點與測試都用這裡，不要散在端點程式碼裡。
 *
 * 兩道關卡：
 *   1. isLowEffortQuestion：整句去掉標點空白後太短，或整句都是灌水／情緒字堆出來的 → 擋（不進派工池浪費代理時間）。
 *   2. isDuplicateQuestion：同一個 IP 24 小時內問過幾乎一樣的話（正規化後相同）→ 擋，避免同一題洗出多筆任務。
 */

/** 正規化後少於這個長度，視為沒有實質內容可以查（純問候、單字重複都擋在這） */
export const MIN_MEANINGFUL_CHARS = 8;

/**
 * 常見的問候／測試／情緒灌水詞。只擋「整句幾乎全由這些詞組成」的提問，
 * 不擋「帶了其中一個詞、但還有其他實質內容」的正常問題（例如「你好，請問里長的長照政見是什麼？」
 * 正規化後扣掉「你好」仍有「請問里長的長照政見是什麼」，不會被擋）。
 */
export const BLOCKED_QUESTION_WORDS: readonly string[] = [
  "你好", "哈囉", "hello", "hi", "嗨",
  "測試", "test", "test123", "testing",
  "幹", "靠北", "白痴", "廢物", "垃圾", "笑死",
  "呵呵", "哈哈", "233", "在嗎", "有人嗎",
  "1", "123", "abc", "aaa", "xxx",
];

// \p{P} 標點、\p{S} 符號（含全形），\s 空白：這三類拿掉後剩下的才是「有意義字元」
const STRIP_RE = /[\s\p{P}\p{S}]+/gu;

/** 正規化：去頭尾空白、轉小寫、拿掉標點符號與空白；同時用於「有沒有實質內容」與「是不是同一題」判斷 */
export function normalizeQuestionText(question: string): string {
  return question.trim().toLowerCase().replace(STRIP_RE, "");
}

/**
 * 整句正規化後太短，或把封鎖詞逐一拿掉後整句被拿光（代表全句都是灌水詞堆出來的）→ 判定沒有實質內容。
 * 逐一拿掉而不是整句比對，是為了同時擋「你好你好你好」這種重複堆疊。
 */
export function isLowEffortQuestion(question: string): boolean {
  const normalized = normalizeQuestionText(question);
  if (normalized.length < MIN_MEANINGFUL_CHARS) return true;
  let remainder = normalized;
  for (const word of BLOCKED_QUESTION_WORDS) {
    const normalizedWord = normalizeQuestionText(word);
    if (!normalizedWord) continue;
    remainder = remainder.split(normalizedWord).join("");
  }
  return remainder.length === 0;
}

/** 同一個 IP 近期問過的問題（已由呼叫端限定在 24 小時內）裡，正規化後有沒有跟這次相同的 */
export function isDuplicateQuestion(question: string, recentQuestions: readonly string[]): boolean {
  const normalized = normalizeQuestionText(question);
  return recentQuestions.some((q) => normalizeQuestionText(q) === normalized);
}
