/**
 * 新聞初篩（system-one?action=news_screen）的純函式：名字命中、問 Jev 的題目、答案→任務。
 * 流程與理由見 system-one/index.ts 的 news_screen 那一段；這裡只放可測的部分。
 *
 * 兩段式（小良哥 2026-09-29 核准）：
 *   1. 便宜篩：標題＋摘要裡沒有任何「在職或 2026 參選中」的人名 → 直接記 unrelated，不問 Jev。
 *      一小時收進來上百則，大多數（國際、社會、影劇）一個人名都沒有，這一段不花錢。
 *   2. 有人名的才問 Jev：把那些人的現行政見清單連同新聞一起給它，選「哪一條政見的進度／某人的新承諾／無關」。
 */

import { normalizeName, type JevQuestion } from "./system-one.ts";

export interface ScreenPerson {
  id: string;
  name: string;
  region: string | null;
  /** 這個人在池子裡的身份（2022 當選縣市議員、2026 登記縣市長…），給 Jev 當線索、也寫進任務敘述 */
  role?: string | null;
}

export interface NameHit {
  name: string;
  people: ScreenPerson[];
}

/**
 * 兩個字的名字特別容易誤中：「李文」會出現在「李文傑」「李文熙」，「林彥」會出現在「林彥廷」。
 * 中文名字是往右長的（姓＋名），所以兩字名後面緊接著另一個中文字時，多半是別人的三字名——
 * 規則：兩字名後面要是標點、空白、結尾，或「表、說、提、的、與…」這類常接在人名後面的字（TWO_CHAR_FOLLOW）才算。
 * 三字以上的名字照 system-one.ts 的 nameHit 直接比對。
 * 實測（2026-09-29，22 個來源 753 則 × 1,891 人、1,438 個名字、其中兩字名 37 個）：
 * 238 則命中；兩字名中了「張峻提教育平權白皮書」「黃捷用創意…」「一暖舉助白營許甫」「凌濤：以善流對決…」四則，都是本人；
 * 擋掉的「李文傑、李文熙、林彥廷、林麗容、陳宜君」都是別人。
 */
const HAN = /\p{Script=Han}/u;
/** 常接在人名後面的字：這些字跟在兩字名後面時，那兩個字多半就是完整的名字 */
export const TWO_CHAR_FOLLOW = "表說指提稱認強呼坦批回嗆喊也今昨明與和及跟等在的將並已曾就還都要對向為被率出用是有";

function isHan(ch: string | undefined): boolean {
  return !!ch && HAN.test(ch);
}

/** 名單 → 索引（正規化後的名字 → 同名的人）。不到兩個字的名字不收：一個字什麼都會命中 */
export function buildNameIndex(people: readonly ScreenPerson[]): Map<string, ScreenPerson[]> {
  const idx = new Map<string, ScreenPerson[]>();
  for (const p of people) {
    const key = normalizeName(p.name ?? "");
    if ([...key].length < 2) continue;
    const list = idx.get(key) ?? [];
    if (!list.some((x) => x.id === p.id)) list.push(p);
    idx.set(key, list);
  }
  return idx;
}

/** 這個名字在文字裡出現的位置（兩字名後面不能緊接別的中文字，TWO_CHAR_FOLLOW 那些除外） */
function occurrences(text: string, key: string): number[] {
  const out: number[] = [];
  const twoChar = [...key].length === 2;
  let i = text.indexOf(key);
  while (i >= 0) {
    const next = text[i + key.length];
    if (!twoChar || !isHan(next) || TWO_CHAR_FOLLOW.includes(next)) out.push(i);
    i = text.indexOf(key, i + 1);
  }
  return out;
}

/**
 * 比對用的文字：跟 normalizeName 一樣拿掉間隔號、臺→台，但**空白保留成一格**——
 * normalizeName 把空白整個刪掉，「訴求 張峻提」會黏成「訴求張峻提」，兩字名的邊界就看不到了。
 */
function normalizeText(s: string): string {
  return s.replace(/[．·‧・•.]/g, "").replace(/臺/g, "台").replace(/\s+/g, " ");
}

/**
 * 文字裡出現了哪些人名。短名字只出現在長名字裡面的（「陳其」在「陳其邁」裡）不算。
 * 回傳依第一次出現的位置排序：標題裡先出現的通常是主角。
 */
export function findNames(text: string, index: ReadonlyMap<string, ScreenPerson[]>): NameHit[] {
  const t = normalizeText(text);
  if (!t.trim()) return [];
  const hits: Array<{ key: string; at: number[]; people: ScreenPerson[] }> = [];
  for (const [key, people] of index) {
    if (!t.includes(key)) continue;
    const at = occurrences(t, key);
    if (at.length > 0) hits.push({ key, at, people });
  }
  // 被更長的命中名字完全蓋住的短名字拿掉
  const kept = hits.filter((h) => !hits.some((o) => o.key !== h.key && o.key.includes(h.key) &&
    h.at.every((pos) => o.at.some((op) => pos >= op && pos + h.key.length <= op + o.key.length))));
  kept.sort((a, b) => a.at[0] - b.at[0]);
  return kept.map((h) => ({ name: h.key, people: h.people }));
}

/**
 * 同名的人不只一位時，用縣市收斂：來源是縣市政府就用那個縣市；否則看新聞裡有沒有寫到某位的縣市。
 * 收斂不了就全留（最多 MAX_SAME_NAME 位），讓 Jev 從政見清單判斷是哪一位。
 */
export const MAX_SAME_NAME = 3;
export function narrowByRegion(people: readonly ScreenPerson[], text: string, sourceRegion: string | null): ScreenPerson[] {
  if (people.length <= 1) return [...people];
  const norm = (s: string) => s.replace(/臺/g, "台");
  const t = norm(text);
  const byRegion = (r: string | null | undefined) => !!r && (sourceRegion ? norm(r) === norm(sourceRegion) : t.includes(norm(r)) || t.includes(norm(r).replace(/[縣市]$/, "")));
  const matched = people.filter((p) => byRegion(p.region));
  return (matched.length > 0 ? matched : [...people]).slice(0, MAX_SAME_NAME);
}

/** 命中的名字 → 要問 Jev 的人（依出現順序、同名用縣市收斂、去重），最多 MAX_PEOPLE_PER_ITEM 位 */
export function pickPeople(hits: readonly NameHit[], text: string, sourceRegion: string | null): ScreenPerson[] {
  const out: ScreenPerson[] = [];
  for (const h of hits) {
    for (const p of narrowByRegion(h.people, text, sourceRegion)) {
      if (out.some((x) => x.id === p.id)) continue;
      out.push(p);
      if (out.length >= MAX_PEOPLE_PER_ITEM) return out;
    }
  }
  return out;
}

// ---- 問 Jev ----

export interface PolicyBrief { id: string; title: string; status?: string | null }
export interface Candidate { person: ScreenPerson; policies: PolicyBrief[] }

/** 一則最多帶幾位人物問 Jev（一則新聞點到十個名字的多半是名單型報導，前三位是主角） */
export const MAX_PEOPLE_PER_ITEM = 3;
/** 每人最多帶幾條政見 */
export const MAX_POLICIES_PER_PERSON = 30;
/**
 * 低於這個機率一律當無關，但機率照記。
 * 2026-09-29 首輪 240 則：0.95 把明擺著的新承諾全丟了（李四川深坑輕軌延伸 0.69、徐欣瑩臨托 0.84、吳旭智棒壘球場 0.81），
 * 選項多（每人 30 條政見＋新承諾＋無關）機率本來就分散。這裡只決定「要不要派人看」，後面還有代理查證與投票，
 * 放寬的代價是多派幾件、代理交 no_change；比照 followup 用 0.8。
 */
export const NEWS_MIN_PROBABILITY = 0.8;

export const NEWS_QUESTION = "news_relevance";

/**
 * 選項的 key：
 *   p:<政見 id 前 8 碼>  這則新聞講的是這條既有政見的進度
 *   n:<人物 id 前 8 碼>  這個人提出了清單上沒有的具體承諾（新政見，含現任者任內宣布的施政承諾）
 *   unrelated            跟這些人的政見都無關（行程、評論、選情、民調、人事、花絮…）
 * 一律用前 8 碼：Jev 的 criteria key 放整串 uuid 太長，而同一則最多幾十條，8 碼不會撞（撞了就不給那條，見下面）。
 */
export function buildNewsAsk(item: { title: string; summary: string | null; source: string; url: string }, candidates: readonly Candidate[]): {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  keys: Record<string, { kind: "progress"; policy_id: string; politician_id: string } | { kind: "new_pledge"; politician_id: string }>;
} {
  const keys: ReturnType<typeof buildNewsAsk>["keys"] = {};
  const criteria: Record<string, string> = {};
  const people: Record<string, unknown> = {};
  for (const c of candidates.slice(0, MAX_PEOPLE_PER_ITEM)) {
    const pk = `n:${c.person.id.slice(0, 8)}`;
    if (keys[pk]) continue;
    const policies = c.policies.slice(0, MAX_POLICIES_PER_PERSON);
    people[c.person.name + (c.person.region ? `（${c.person.region}）` : "")] = {
      role: c.person.role ?? null,
      policies: policies.map((p) => p.title),
    };
    for (const p of policies) {
      const k = `p:${p.id.slice(0, 8)}`;
      if (keys[k]) continue;
      keys[k] = { kind: "progress", policy_id: p.id, politician_id: c.person.id };
      criteria[k] = `${c.person.name}的政見「${p.title}」有新進度（動工、完工、編列預算、延宕、跳票、實際推動的具體行動）`;
    }
    keys[pk] = { kind: "new_pledge", politician_id: c.person.id };
    criteria[pk] = `${c.person.name}提出了上面清單沒有的具體承諾（當選後要做的具體事情，或現任者新宣布的施政計畫；要看得出做什麼、給誰）`;
  }
  criteria.unrelated = "跟這些人的政見都無關：行程、致詞、評論、選情、民調、人事、爭議、花絮，或只是提到名字";
  const state = {
    news: { title: item.title, summary: item.summary ?? "", source: item.source, url: item.url },
    people,
  };
  const questions: Record<string, JevQuestion> = {
    [NEWS_QUESTION]: {
      type: "choice",
      instructions: "news 是一則台灣新聞的標題與摘要，people 是新聞裡提到的政治人物與他們已登記的政見清單。" +
        "這則新聞跟哪一件事最有關？只看新聞實際寫到的內容：" +
        "某條政見有具體進展（開工、完工、編預算、修法、延宕、放棄）選那條政見；" +
        "某人提出清單上沒有的具體承諾選他的「新承諾」；" +
        "只是出席活動、發表評論、談選情或民調、人事異動、口水戰，或看不出具體承諾，選 unrelated。拿不準就選 unrelated。",
      criteria,
    },
  };
  return { state, questions, keys };
}

export type ScreenResult = "no_name" | "progress" | "new_pledge" | "unrelated" | "low_confidence";

export interface ScreenVerdict {
  result: ScreenResult;
  choice: string | null;
  probability: number;
  politician_id: string | null;
  policy_id: string | null;
}

/** Jev 的答案 → 判定。不在 keys 裡的選項（或 unrelated）當無關；機率不到門檻記 low_confidence（也算無關，不派工） */
export function verdictOf(
  answer: { choice?: string; probabilities?: Record<string, number> } | undefined,
  keys: ReturnType<typeof buildNewsAsk>["keys"],
  minProbability: number,
): ScreenVerdict {
  const choice = answer?.choice ?? null;
  const probability = Math.round((choice ? answer?.probabilities?.[choice] ?? 0 : 0) * 10000) / 10000;
  const k = choice ? keys[choice] : undefined;
  if (!choice || !k) return { result: "unrelated", choice, probability, politician_id: null, policy_id: null };
  if (probability < minProbability) {
    return { result: "low_confidence", choice, probability, politician_id: k.politician_id, policy_id: k.kind === "progress" ? k.policy_id : null };
  }
  return k.kind === "progress"
    ? { result: "progress", choice, probability, politician_id: k.politician_id, policy_id: k.policy_id }
    : { result: "new_pledge", choice, probability, politician_id: k.politician_id, policy_id: null };
}

// ---- 判定 → 任務 ----

export interface NewsTaskInput {
  news_item_id: number;
  url: string;
  title: string;
  source_label: string;
  published_at: string | null;
  person: ScreenPerson;
  policy: PolicyBrief | null;
  verdict: ScreenVerdict;
}

/**
 * 有關的新聞 → 一件 news_sweep 任務（沿用既有任務型別，不新增：新增要同步 DB CHECK／TASK_TYPES／skill.md／task-labels 四處）。
 * target.kind='news_item' 讓 /next 的 current 與 hint 走「單則新聞」那一套（task-context.ts）。
 * 回傳的形狀就是 task-admin.ts 的 createTask 吃的 TaskInput。
 */
export function newsTaskOf(t: NewsTaskInput) {
  const suggestion = t.verdict.result === "progress" ? "progress" : "new_pledge";
  const who = `${t.person.name}${t.person.region ? `（${t.person.region}）` : ""}`;
  const title = suggestion === "progress" && t.policy
    ? `新聞：${who}「${clip(t.policy.title, 40)}」的進度`
    : `新聞：${who}的新承諾`;
  const description = suggestion === "progress" && t.policy
    ? `系統初篩認為這則新聞跟${who}的政見「${t.policy.title}」的進度有關。讀這則新聞：${t.title}（${t.source_label}）${t.url}`
    : `系統初篩認為這則新聞裡${who}提出了還沒收錄的具體承諾。讀這則新聞：${t.title}（${t.source_label}）${t.url}`;
  return {
    title: clip(title, 120),
    description: clip(description, 2000),
    task_type: "news_sweep",
    target_politician_id: t.person.id,
    target_policy_id: suggestion === "progress" && t.policy ? t.policy.id : null,
    region: t.person.region,
    hint_sources: [t.url],
    target_extra: {
      kind: "news_item",
      news_item_id: t.news_item_id,
      url: t.url,
      title: t.title,
      source_label: t.source_label,
      published_at: t.published_at,
      suggestion,
      screen_probability: t.verdict.probability,
      ...(t.policy ? { policy_title: t.policy.title } : {}),
    },
  };
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
