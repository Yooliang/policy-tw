/**
 * 「這一筆像不是政見」的輕量偵測：只標記，不擋。
 *
 * 2026-09-16 看 /policy/2db8cc91「母雞帶小雞 - 最強新北隊」：
 *   「它看起來不是政見，而是口號…這些資料被放進來的入口是不是也管理一下」
 * 拍板「軟性：標記可疑，交給投票」——真政見不該被擋在門外，但驗證的人要先被問一句。
 *
 * 政見＝當選後要做的具體事情，看得出做什麼、給誰、做到什麼程度。
 * 標語、團隊組成、行程、個人表態不是。
 *
 * 判斷只看得到 title 與 description，所以規則刻意保守：
 *   - 命中選戰用語（母雞帶小雞、最強○○隊、議會過半…）→ 標記
 *   - 既沒有數字量化、也沒有任何「要做什麼」的動詞 → 標記
 * 兩者都不成立就不標。誤標的代價是驗證者多看一眼，漏標的代價是口號悄悄上線。
 */

/** 選戰／團隊用語：出現在標題或內容裡，幾乎都不是在講「要做什麼事」 */
const CAMPAIGN_PHRASES = [
  "母雞帶小雞", "最強", "打贏", "勝選", "過半", "凍蒜", "催票", "輔選",
  "大聯盟", "一起拚", "站台", "造勢", "誓師", "感謝支持", "請支持",
];
// 「團隊」「衝刺」這種字真政見也會用（「成立專職專業的法律扶助團隊」），
// 2026-09-16 拿線上待驗證的 50 筆實跑時誤標，所以不列。

/**
 * 「要做什麼」的動詞：有這些字通常在承諾一件可執行的事。
 *
 * 刻意不收「打造」「翻轉」「邁向」「重現」「凝聚」這類空泛詞——
 * 「打造年輕人的城市願景」「翻轉嘉義」正是該被標記的那一種。
 * 這份清單是 2026-09-16 拿線上 372 筆政見實跑後補出來的（誤標從 16.4% 降下來）。
 */
const ACTION_WORDS = [
  "推動", "興建", "新建", "增建", "改建", "設置", "設立", "成立", "開辦", "辦理",
  "補助", "補貼", "發放", "提供", "減免", "免費", "降低", "提高", "提升", "增加",
  "修法", "立法", "修訂", "編列", "爭取", "延伸", "擴建", "整建", "改善", "普及",
  "導入", "建置", "規劃", "開發", "招商", "培訓", "輔導", "檢討", "納入", "試辦",
  "加強", "強化", "擴大", "充實", "監督", "舉辦", "串聯", "開拓", "投資", "增設",
  "普設", "補足", "落實", "引進", "整合", "加速", "升級", "制定", "實施", "維護",
  "照顧", "保障", "增聘", "興辦", "活化", "促進", "推廣", "減少", "完善", "修復",
  "修繕", "汰換", "清運", "巡查", "增班", "開通", "通車", "翻修", "重建", "增闢",
];

const NUMBER_RE = /[0-9０-９]|[一二三四五六七八九十百千萬億]\s*(?:億|萬|元|年|月|日|%|％|人|戶|座|處|間|所|班|床|天|小時|公里|公頃|坪)/;

export interface PolicyLikeness {
  /** true＝疑似不是政見，請驗證者先判斷 */
  suspect: boolean;
  reasons: string[];
}

export function checkPolicyLikeness(title: unknown, description: unknown): PolicyLikeness {
  const t = typeof title === "string" ? title : "";
  const d = typeof description === "string" ? description : "";
  const text = `${t} ${d}`;
  const reasons: string[] = [];

  const hits = CAMPAIGN_PHRASES.filter((w) => text.includes(w));
  if (hits.length > 0) reasons.push(`出現選戰／團隊用語：${hits.join("、")}`);

  const hasAction = ACTION_WORDS.some((w) => text.includes(w));
  const hasNumber = NUMBER_RE.test(text);
  if (!hasAction && !hasNumber) reasons.push("看不出要做什麼：沒有具體作為的動詞，也沒有數量、金額或期程");

  return { suspect: reasons.length > 0, reasons };
}

/** 給驗證者看的一句話；不可疑就回 null */
export function policyLikenessNotice(title: unknown, description: unknown): string | null {
  const { suspect, reasons } = checkPolicyLikeness(title, description);
  if (!suspect) return null;
  return `⚠️ 這筆疑似不是政見（${reasons.join("；")}）。先判斷它是不是「當選後要做的具體事情」——` +
    `標語、團隊組成、行程、個人表態都不是。不是政見就投 disagree 並在 note 說明，不要因為「來源確實這樣寫」就投同意。`;
}
