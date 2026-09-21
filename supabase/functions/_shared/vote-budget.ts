/**
 * 票數預算：每一種貢獻型別的風險維度（使用者 2026-09-21）。
 *
 * 現在的門檻是一張 `型別風險 × 來源等級` 的靜態矩陣（2／3／4／6／8），看得到「型別」與
 * 「網域」，看不到「這一筆到底好不好查證」。結果中選會名單上白紙黑字的參選登記要 6 票，
 * 而全站 1,400+ 筆 pending 塞著。
 *
 * 提案（docs/PROPOSAL-jev-vote-budget.md）：
 *   門檻 = max(型別地板, 2 − 中選會折扣 + 加成)
 *   加成 = 命中的維度數（每維一票，封頂 5）
 *
 * **為什麼是多維度而不是 0～5 多選一**：一把 0～5 的梯子逼 Jev 在互不相干的風險之間硬挑一格。
 * 以 policy 為例，「來源只提到主題」與「跟既有政見疑似重複」不在同一條軸上——一筆可以同時是
 * 這兩種，也可以兩種都不是，而 argmax 只會留下一個。**風險要疊加，不是取最大值。**
 *
 * 另一個好處是有現成的校準資料：is_policy（579 筆）、duplicate_of（459 筆）、
 * source_support（1,709 筆）這些維度 Jev 早就在答，不是從零開始。
 *
 * **判不出來算命中**（往嚴格的方向倒）：Jev 的 source_support 有 56% 回 cannot_tell，
 * 如果那算「沒事」，等於看不懂就放行。
 *
 * 現在是**影子模式**：只記錄、不套用門檻。
 */

/** 命中的閾值。先一律 0.80，影子模式蒐集後再逐維調——一開始每維不同就分不出是閾值不對還是維度不對。 */
export const DIMENSION_THRESHOLD = 0.80;

/** 加成封頂：配合基本 2 票與中選會 −1，門檻落在 1～7 票。 */
export const MAX_EXTRA_VOTES = 5;

/** 基本票數，取代原本的型別 × 來源矩陣。 */
export const BASE_VOTES = 2;

/**
 * 不可逆的操作要求「幾個不同的人看過」，而不是「幾分」。
 *
 * 2026-09-21 審查指出：把地板設在分數上，會讓中選會折扣完全失效
 * （candidacy 地板 3，扣不扣那一票都是 3），跟「中選會查得到就該快」自相矛盾。
 *
 * 分數與人數是兩件事：分數衡量證據夠不夠，人數衡量有沒有人獨立看過。
 * 所以拆開——分數可以低到 1，但這幾種型別仍要求至少 2 個不同來源 IP。
 *
 * 附帶一提，「至少兩個人」在現行制度裡**並不存在**：實查已有 135 筆是 1 票上線的
 * （系統票 supported 把門檻壓到 1）。所以這是新增的保護，不是恢復舊有的。
 */
export const MIN_DISTINCT_VOTERS: Record<string, number> = {
  merge_politician: 2,
  candidacy: 2,
  removal: 2,
};

export interface Dimension {
  /** jev_decisions.probabilities 的 key，也是給 Jev 的選項名 */
  key: string;
  /** 問 Jev 的話 */
  instructions: string;
  /** 命中（＝要加一票）的那個選項叫什麼、是什麼意思 */
  hit: { key: string; means: string };
  /** 沒命中的那個選項 */
  miss: { key: string; means: string };
}

/**
 * 每一型別的風險維度。原則：一維問一件事，而且是「這一型別特有的出錯方式」。
 * 維度之間要能同時成立——不能同時成立的兩件事應該是同一維的兩個選項，不是兩維。
 */
export const VOTE_DIMENSIONS: Record<string, Dimension[]> = {
  policy: [
    {
      key: "not_this_person",
      instructions: "來源正文證明得了這條政見是 target 這個人說的嗎？同名的別人、或前任／對手的政績都不算。",
      hit: { key: "cannot_attribute", means: "證明不了是這個人說的" },
      miss: { key: "attributed", means: "來源明確寫出是這個人說的" },
    },
    {
      key: "claim_not_stated",
      instructions: "來源正文有寫出這條政見的具體內容嗎？只提到主題、或只有標題式的一句話都不算。",
      hit: { key: "not_stated", means: "來源只提到主題，沒寫出這個承諾" },
      miss: { key: "stated", means: "來源寫出了這個承諾的內容" },
    },
    {
      key: "not_concrete",
      instructions: "target 是一條具體政見，還是口號／願景／包裹式標題？政見＝當選後要做的具體事情，看得出做什麼、給誰、做到什麼程度。",
      hit: { key: "not_policy", means: "口號、願景、或把好幾條包起來的標題，本身沒有具體內容" },
      miss: { key: "policy", means: "具體政見：看得出做什麼、給誰、做到什麼程度" },
    },
    {
      key: "duplicate_risk",
      instructions: "target 跟這個人既有的政見裡，有沒有哪一筆是同一個承諾換句話說？只是主題相近、對象不同不算重複。",
      hit: { key: "duplicate", means: "跟既有的某一筆是同一個承諾" },
      miss: { key: "distinct", means: "跟既有每一筆都是不同的承諾" },
    },
    {
      key: "weak_source",
      instructions: "來源是哪一種？官方網站與主流媒體的自有報導算可查證；社群貼文、內容農場、轉載型網站不算。",
      hit: { key: "weak", means: "社群貼文、內容農場或轉載" },
      miss: { key: "checkable", means: "官方或主流媒體的自有報導" },
    },
  ],

  candidacy: [
    {
      key: "no_official_list",
      instructions: "有沒有官方或完整的登記名單可以核對這筆參選紀錄？單篇報導提到某人要參選，不算名單。",
      hit: { key: "no_list", means: "只有單篇報導，沒有名單可以交叉核對" },
      miss: { key: "has_list", means: "有選委會公告或媒體整理的完整登記名單" },
    },
    {
      key: "ambiguous_identity",
      instructions: "這個姓名在既有資料裡有沒有可能指到不只一個人？看政黨、縣市／選區、出生年、歷屆參選。",
      hit: { key: "ambiguous", means: "同名的可能不只一位，要先確定是哪一個" },
      miss: { key: "unique", means: "對得上唯一一個人" },
    },
    {
      key: "rewrites_existing",
      instructions: "這筆是新增一段參選紀錄，還是改寫既有的那一段（例如登記改成不參選）？",
      hit: { key: "rewrites", means: "改寫既有紀錄——標成不參選會讓這個人的資料整批不再被派" },
      miss: { key: "adds", means: "補上原本沒有的紀錄" },
    },
    {
      key: "weak_source",
      instructions: "來源是哪一種？中選會與選委會公告最強，主流媒體次之，社群貼文與傳聞最弱。",
      hit: { key: "weak", means: "社群貼文、傳聞或轉載" },
      miss: { key: "checkable", means: "官方公告或主流媒體" },
    },
  ],

  correction: [
    {
      key: "value_not_in_source",
      instructions: "來源那一頁有直接寫出要改成的新值嗎（日期、數字、名稱）？還是要從別的事實推論出來？",
      hit: { key: "inferred", means: "來源沒寫出新值，是推論出來的" },
      miss: { key: "stated", means: "來源直接寫出了新值" },
    },
    {
      key: "overturns_sourced_value",
      instructions: "現在的值本來就有出處嗎？這次的更正是在推翻一個有依據的值，還是在補一個空白？",
      hit: { key: "overturns", means: "推翻一個原本有出處的值" },
      miss: { key: "fills_blank", means: "補空白或修正明顯錯誤" },
    },
    {
      key: "cascading_field",
      instructions: "要改的欄位會不會牽動其他資料？candidate_status 與 election_id 會改變這個人被派出哪些任務、以及資料會不會被藏起來。",
      hit: { key: "cascading", means: "會牽動其他資料的欄位" },
      miss: { key: "local", means: "只影響這一欄" },
    },
    {
      key: "no_op",
      instructions: "改完之後值會不一樣嗎？新值跟資料庫現值相同的話，這筆改了等於沒改。",
      hit: { key: "no_change", means: "新值與現值相同，等於空操作" },
      miss: { key: "changes", means: "確實會改變值" },
    },
  ],

  no_change: [
    {
      key: "stamps_without_source",
      instructions: "這筆宣告 outcome=confirmed（會把資料標成已核對、之後不再派）嗎？如果是，checked_urls 裡有沒有實際的來源？",
      hit: { key: "no_urls", means: "confirmed 卻沒有列出核對過的網址" },
      miss: { key: "has_urls", means: "不是 confirmed，或有列出網址" },
    },
    {
      key: "finding_too_thin",
      instructions: "finding 有沒有講出實際比對了什麼？「核對無誤」「查證通過」這類套語不算。",
      hit: { key: "thin", means: "只有套語，看不出比對了什麼" },
      miss: { key: "substantive", means: "講得出比對了哪幾項" },
    },
    {
      key: "source_unrelated",
      instructions: "checked_urls 裡的來源，內容跟這筆資料有關嗎？",
      hit: { key: "unrelated", means: "來源內容與這筆資料無關，或打不開" },
      miss: { key: "related", means: "來源確實講到這筆資料" },
    },
  ],

  politician: [
    {
      key: "not_this_person",
      instructions: "來源證明得了這些欄位是 target 這個人的嗎？同名的別人不算。",
      hit: { key: "cannot_attribute", means: "證明不了是這個人" },
      miss: { key: "attributed", means: "來源明確對到這個人" },
    },
    {
      key: "value_not_in_source",
      instructions: "提交的每一欄（出生年、現職、學歷、簡介）都在來源正文裡找得到嗎？",
      hit: { key: "not_found", means: "有欄位在來源裡找不到" },
      miss: { key: "found", means: "每一欄都找得到" },
    },
    {
      key: "weak_source",
      instructions: "來源是哪一種？官方網站、議會官網、維基百科算可查證；社群貼文與內容農場不算。",
      hit: { key: "weak", means: "社群貼文或內容農場" },
      miss: { key: "checkable", means: "官方或可查證的來源" },
    },
  ],

  policy_progress: [
    {
      key: "not_this_policy",
      instructions: "來源講的進度，是 target 這一條政見的進度嗎？同主題但不同標的的事情不算。",
      hit: { key: "different_thing", means: "講的是同主題的別件事" },
      miss: { key: "same_thing", means: "確實是這一條的進度" },
    },
    {
      key: "not_in_office_scope",
      instructions: "這個進度是在這個人的任期內、職權範圍內完成的嗎？前任或別人做的同主題事情不算。",
      hit: { key: "out_of_scope", means: "不在這個人的任期或職權內" },
      miss: { key: "in_scope", means: "在任期與職權內" },
    },
    {
      key: "status_overreach",
      instructions: "提交的 status 跟來源講的程度相符嗎？來源只說「規劃中」卻標成 Achieved 就是過頭。",
      hit: { key: "overreach", means: "狀態比來源講的程度更進一步" },
      miss: { key: "matches", means: "狀態與來源相符" },
    },
  ],

  removal: [
    {
      key: "reason_not_evidenced",
      instructions: "移除的理由有來源支持嗎？「查不到出處」本身不是證據，要說得出為什麼這一筆不該存在。",
      hit: { key: "unevidenced", means: "移除的理由沒有任何來源支持" },
      miss: { key: "evidenced", means: "移除的理由附得出具體依據" },
    },
    {
      key: "could_be_corrected",
      instructions: "這一筆是整筆不該存在，還是只是某幾欄錯了？欄位錯應該用 correction 而不是移除。",
      hit: { key: "correctable", means: "看起來只是某幾欄錯了，應該用 correction 更正而不是整筆移除" },
      miss: { key: "should_remove", means: "整筆確實不該存在，不是欄位錯而已" },
    },
  ],

  merge_politician: [
    {
      key: "weak_identity_evidence",
      instructions: "有沒有足以判定是不是同一人的證據？姓名相同不算，要看政黨、縣市／選區、出生年、歷屆參選。",
      hit: { key: "weak", means: "只有姓名相同，沒有其他欄位可以佐證是不是同一人" },
      miss: { key: "strong", means: "多個欄位對得上或明顯對不上，判得出是不是同一人" },
    },
    {
      key: "conflicting_fields",
      instructions: "兩筆之間有沒有互相矛盾的欄位（不同政黨、不同出生年、同一場選舉不同選區）？",
      hit: { key: "conflicts", means: "有互相矛盾的欄位（不同政黨、不同出生年、或同一場選舉不同選區）" },
      miss: { key: "consistent", means: "各欄位之間沒有互相矛盾的地方" },
    },
    {
      key: "both_have_content",
      instructions: "要被併掉的那一筆底下有沒有政見或參選紀錄？有的話誤併的代價更大。",
      hit: { key: "has_content", means: "被併掉的那一筆底下有政見或參選紀錄，誤併的代價更大" },
      miss: { key: "empty", means: "被併掉的那一筆底下沒有資料" },
    },
  ],

  question_answer: [
    {
      key: "not_answering",
      instructions: "這個回答有回答到訪客問的那個問題嗎？還是只講了相關但不對題的內容？",
      hit: { key: "off_topic", means: "沒有回答到訪客問的那個問題" },
      miss: { key: "on_topic", means: "確實回答到訪客問的那個問題" },
    },
    {
      key: "unsourced_claim",
      instructions: "回答裡的事實宣稱，來源都支持嗎？",
      hit: { key: "unsourced", means: "回答裡有事實宣稱找不到來源支持" },
      miss: { key: "sourced", means: "回答裡的事實宣稱都有來源支持" },
    },
  ],

  adjudication: [
    {
      key: "ignores_counter_evidence",
      instructions: "這份裁決有沒有處理反方提出的反證？只重複正方的說法、不回應反證的不算。",
      hit: { key: "ignores", means: "沒有正面回應反方提出的反證" },
      miss: { key: "addresses", means: "有逐條處理反方提出的反證" },
    },
    {
      key: "no_independent_check",
      instructions: "裁決者有沒有自己打開來源核對，還是只依據雙方已經寫下的東西判斷？",
      hit: { key: "no_check", means: "沒有自己打開來源，只依雙方已寫下的東西判斷" },
      miss: { key: "checked", means: "自己打開來源核對過" },
    },
  ],

  roster_check: [
    {
      key: "list_not_official",
      instructions: "這次清查用的是官方名單，還是媒體整理或部分名單？",
      hit: { key: "unofficial", means: "用的不是官方完整名單（媒體整理或只有部分）" },
      miss: { key: "official", means: "用的是選委會或中選會的完整名單" },
    },
    {
      key: "count_mismatch",
      instructions: "回報的 ours_count 與 cec_count 差距合理嗎？差很多而沒有說明，表示這次清查可能沒看完。",
      hit: { key: "unexplained_gap", means: "我們的筆數與官方筆數差距大，而且沒有說明原因" },
      miss: { key: "consistent", means: "筆數對得上，或差距有說明" },
    },
  ],

  task_suggestion: [
    {
      key: "not_actionable",
      instructions: "這個提議說得出「要查什麼、查到算完成」嗎？還是只是一個方向？",
      hit: { key: "vague", means: "只給了方向，說不出要查什麼、什麼算完成" },
      miss: { key: "actionable", means: "說得出具體要查什麼、查到什麼算完成" },
    },
    {
      key: "already_covered",
      instructions: "這個提議是不是既有任務型別已經在處理的事情？",
      hit: { key: "duplicate", means: "既有的任務型別已經在處理這件事" },
      miss: { key: "new", means: "既有的任務型別沒有涵蓋這件事" },
    },
  ],
};

/** 把一種型別的維度組成 Jev 吃的 questions。 */
export function dimensionQuestions(contributionType: string): Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> {
  const dims = VOTE_DIMENSIONS[contributionType] ?? [];
  return Object.fromEntries(dims.map((d) => [
    d.key,
    { type: "choice" as const, instructions: d.instructions, criteria: { [d.hit.key]: d.hit.means, [d.miss.key]: d.miss.means } },
  ]));
}

export interface DimensionOutcome {
  key: string;
  choice: string;
  probability: number;
  hit: boolean;
  /** 為什麼算命中——就是那一維 hit 選項的說明，寫進紀錄才看得懂當初為什麼加票 */
  reason: string;
}

export interface VoteBudget {
  contribution_type: string;
  base: number;
  cec_discount: 0 | 1;
  extra: number;
  /** 這一型別至少要幾個不同來源 IP 投過（與分數是兩件事） */
  min_distinct_voters: number;
  threshold: number;
  dimensions: DimensionOutcome[];
}

/**
 * 算票數預算。
 *
 * **判不出來不算命中**（2026-09-21 修正）。第一版寫成「判不出來算命中」，理由是
 * 「看不懂就放行」不可接受。但審查算了期望值：Jev 的 source_support 有 56% 回
 * cannot_tell，5 個維度下期望加成 +2.8，policy 的目標會落在 5——**比現行矩陣的
 * 2～3 還高**，跟整份規劃「解開積壓」的目的正好相反。
 *
 * 正確的做法是分開兩件事：**基本票數 2 才是保底**，維度只在 Jev 有信心說
 * 「這一筆真的有這個風險」時才加。看不懂不會放行——看不懂就是 2 票，跟現行一般資料同級。
 */
export function computeVoteBudget(
  contributionType: string,
  answers: Record<string, { choice: string; probabilities: Record<string, number> }>,
  cecConfirmed: boolean,
): VoteBudget {
  const dims = VOTE_DIMENSIONS[contributionType] ?? [];
  const outcomes: DimensionOutcome[] = dims.map((d) => {
    const a = answers[d.key];
    const p = a ? (a.probabilities?.[a.choice] ?? 0) : 0;
    // 沒答、答的不是我們給的兩個選項、或信心不足 → 當成判不出來 → 算命中
    // 只有「Jev 有信心說命中的那一邊」才加票。沒答、答別的、信心不足都算判不出來。
    const hit = !!a && a.choice === d.hit.key && p >= DIMENSION_THRESHOLD;
    const undecided = !a || (a.choice !== d.hit.key && a.choice !== d.miss.key) || p < DIMENSION_THRESHOLD;
    return {
      key: d.key,
      choice: a?.choice ?? "unanswered",
      probability: Number(p.toFixed(4)),
      hit,
      reason: hit ? d.hit.means : undecided ? `判不出來（${a?.choice ?? "沒有回答"}，機率 ${p.toFixed(2)}）——不加票，保底的 2 票仍在` : d.miss.means,
    };
  });
  const extra = Math.min(outcomes.filter((o) => o.hit).length, MAX_EXTRA_VOTES);
  const cec_discount = cecConfirmed ? 1 : 0;
  return {
    contribution_type: contributionType,
    base: BASE_VOTES,
    cec_discount,
    extra,
    min_distinct_voters: MIN_DISTINCT_VOTERS[contributionType] ?? 1,
    threshold: Math.max(1, BASE_VOTES - cec_discount + extra),
    dimensions: outcomes,
  };
}
