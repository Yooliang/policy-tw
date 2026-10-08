/**
 * 「這一種任務怎麼做」的單一真相（使用者 2026-09-21：「我們教了太多子代理不該處理的事，
 * 它應該是領任務、回報，而不是自己去管理任務」）。
 *
 * 原本這些說明寫在 `public/skill.md` 的「任務類型：」那一段——5,049 字元、佔整份協議的 10%，
 * 把 20 種型別的做法一次塞給只做一筆的代理。實測發現三件事：
 *   1. 代理需要的是眼前這一筆怎麼做，不是目錄；
 *   2. 伺服器本來就會隨任務送 `current.hint`，但 20 種裡只有 5 種有；
 *   3. 目錄與 hint 是同一份話的兩份拷貝，已經有一支守門測試存在的唯一理由就是防它們走鐘。
 *
 * 所以把做法收進這裡，隨任務送出去，協議只留「代理要做判斷的事」。
 * 新增任務型別時這裡要補一條，`task-guidance.test.ts` 會擋。
 *
 * 寫的時候的準則：
 *   - 只講這一種任務要做什麼判斷、三條路怎麼選、哪裡最容易錯
 *   - 不要講派工怎麼排、冷卻幾天、比例多少、額度多少——那是伺服器的事，代理知道了只會拿去算計
 *   - 直接對著代理講話，它看得到 current 裡的欄位，不必寫 `item.current.` 前綴
 */
import { POLICY_CATEGORIES } from "./category-map.ts";
import { CANDIDATE_STATUSES, POLICY_STATUSES } from "./contribution-schema.ts";
import { NON_OFFICIAL_SOURCES, NOT_FOUND_ELEVATED_MIN_CHECKED_URLS, NOT_FOUND_ELEVATED_MIN_DOMAINS, NOT_FOUND_MIN_CHECKED_URLS, SEARCH_KEYWORDS } from "./not-found-guard.ts";
import { SOLE_SOURCE_TASK_NOTE } from "./sole-source-guard.ts";
import { SEARCH_PAGE_NOT_SOURCE } from "./search-page.ts";
import { POLICY_ELEMENT_TEXT_MAX } from "./policy-elements.ts";

/**
 * 政見／基本資料缺口要用搜尋引擎、看非官方來源（維護者 2026-10-01）：抽 8 筆政見缺漏的「查無」，
 * 多半只看中選會、議會官網、中央社、自由時報，很少用搜尋引擎、沒有人查候選人臉書。
 */
const searchFirst = (taskType: keyof typeof SEARCH_KEYWORDS) =>
  `**一定要用搜尋引擎**，至少搜三組關鍵字：${SEARCH_KEYWORDS[taskType]}；**要看非官方來源**：${NON_OFFICIAL_SOURCES}——只看中選會、議會官網、一兩家媒體首頁不算查過。` +
  `真的查不到才回 no_change＋outcome=not_found：checked_urls 至少 ${NOT_FOUND_MIN_CHECKED_URLS} 個你從搜尋結果點進去、實際打開的不同頁面（${SEARCH_PAGE_NOT_SOURCE}，Google／Bing 這類搜尋結果頁不計入），finding 寫出你搜了哪些關鍵字、各看到什麼（少於 ${NOT_FOUND_MIN_CHECKED_URLS} 個會被當場退回，不算被拒）。查無比例異常高的模型系列要 ${NOT_FOUND_ELEVATED_MIN_CHECKED_URLS} 個網址、且至少 ${NOT_FOUND_ELEVATED_MIN_DOMAINS} 個不同網域（協議 1.44.0；照上面做本來就有這麼多個不同網域）。`;

/**
 * 選舉公報常是圖片版 PDF（維護者 2026-10-04：林碩彥案例——代理把公報上隔壁許育綸的政見看成林碩彥的，
 * 整段內容是看圖看錯欄、不是抽文字漏字）：抽出來的文字可能抽不到，也可能整欄黏到旁邊候選人的欄位去。
 */
const gazetteImageNote =
  "**選舉公報常是圖片版**：抽文字常抽不到，或把相鄰候選人的欄位黏在一起。先依候選人姓名在頁面上的位置，把公報頁面定位、裁切到他自己那一欄再放大核對（例如用 PyMuPDF 依姓名座標裁切），不要只靠抽出來的文字；交件前再次確認這條政見確實印在「這位候選人」自己那一欄，不是相鄰候選人的。";

/** 常見誤判（維護者 2026-10-04：Sonnet 把議員的議會質詢主張當成政見交了上來）。 */
const notPolicyMisjudgmentNote =
  "**常見誤判**：議員在議會質詢、總質詢時提出的建議或要求，是質詢主張，不是他下一屆的競選政見；任內已完成的施政成果、前任留下的建設、超出他職權範圍的表態，也都不是政見，查到這類內容不要交。";

export const TASK_GUIDANCE: Record<string, string> = {
  policy_missing:
    "**current 有 bulletins 的先看公報**：那是系統推得出來的中選會選舉公報與號次（候選人自己登記的政見原文），照公報交那一屆的政見。" +
    "找這個人**有出處的具體政見，最多 5 筆**：每筆一個 policy、各附自己的出處。找到幾筆交幾筆，只找到 1 筆就交 1 筆——**不要為了湊數交口號、願景或個人表態**。先看 queued_policies，別人交了還在等票的不要再交。" +
    "**一則報導裡的「N 大政見」「N 箭」「N 夠力」怎麼記**：以「能不能各自查核」為準。每一項有自己的標的（哪家醫院、哪條路線、多少錢、給誰）就拆成 N 筆，各自獨立追蹤進度，同一個 source_url 重複用沒關係；只是形容詞或無法單獨查核的子項（「行政加速」「專業務實」「整合資源」）併回母筆的 description，不要單獨成筆。拆出來超過 5 筆時先交最具體的 5 筆。" +
    "2026 選舉的政見優先；只找得到現任任期或過去選舉的承諾也可以提交，election_id 填該政見所屬的選舉並在 note 說明。" +
    gazetteImageNote + notPolicyMisjudgmentNote + SOLE_SOURCE_TASK_NOTE +
    searchFirst("policy_missing"),

  // 補任期政見（2026-10-02 維護者同意）：現任者那一屆當選時的競選政見。交成 Campaign Pledge＋該屆 election_id，
  // 之後 progress_stale 才問得出「兌現了沒」（skill.md：競選承諾 status 用 Campaign Pledge、election_id 填那場選舉）。
  term_policy_missing:
    "找這個人**那一屆（target.election_id）當選時的競選政見，最多 5 筆**：每筆一個 policy、各附自己的出處，election_id 填那一屆，status 填 Campaign Pledge。找到幾筆交幾筆——**不要為了湊數交標語、口號、願景或個人表態**，那些不是政見。先看 queued_policies 與 existing_policies（看 election_id，別屆的不算這一屆），別人交了還在等票的不要再交。" +
    "**首選中選會選舉公報**：每位候選人登記的政見原文都印在公報上，hint_sources 第一個就是那一屆的入口，依縣市、選舉別、選舉區點到 PDF；公報 PDF 的網址就是 source_urls。其次本人官網／臉書的競選政見頁、當年的新聞。" +
    // 從公報補政見（2026-10-06）：系統推得出公報就直接給，對象也擴到落選人、村里長、代表
    "**target 有 bulletin_urls 的，系統已經找到那一份公報、cand_no 是他的號次**：直接打開，依姓名與號次找到他自己那一欄，把那一欄的政見逐條交（公報上列幾條交幾條、一次交完，不受上面 5 筆的限制；口號、標語、「為民服務」不交）；那一欄確實空白或只有口號才回查無，checked_urls 要有這份公報。" +
    gazetteImageNote +
    "公報上一段話列了好幾項各自查得了的承諾就拆成幾筆（同一個公報網址重複用沒關係）。**任內才宣布的施政、其他屆別的政見不是這一屆的競選政見**，這個任務不要交。" +
    notPolicyMisjudgmentNote + SOLE_SOURCE_TASK_NOTE +
    searchFirst("term_policy_missing"),

  // 補學經歷條列（2026-10-02 維護者裁示）：人物頁側欄的「學歷」「經歷」讀的是 education[]／experience[]，
  // 不是 bio。先跑 bio 已有值的那 98 筆——bio 裡通常已經寫著學經歷，代理知道要找什麼。
  profile_detail_gap:
    "用一筆 politician 補 **education[]／experience[] 陣列，一條一項**" +
    "（例 education: [\"國立臺灣師範大學企業管理系\", \"國立清華大學科技法律研究所碩士\"]）。" +
    "**寫進 bio 散文裡不算** —— 人物頁側欄那兩塊讀的是陣列，bio 有寫它們照樣顯示「暫無資料」。" +
    "current.politician.bio 可以當線索知道要找什麼，但 **bio 沒有附來源，不能只憑它就交**：" +
    "source_urls 放你實際打開、看得到這些學經歷的網址（所屬機關／議會的個人介紹頁最常有，其次維基百科、本人官網）。" +
    "bio 跟來源不一致以來源為準，並在 note 說明。只補查得到的那一個欄位也可以。" +
    "**已經有值的欄位不要重交**（看 current.present_fields）—— 伺服器只補空欄位，重交那一輪是白做。" +
    // 學經歷補出處（#346，2026-10-06）：同一個型別，target.kind＝career_sources；這種任務反而就是要照原文重交
    "**例外：學經歷補出處**（target.kind 是 career_sources，任務編號 auto:profile_detail_gap:sources:…）：學經歷已經有了、只是沒有出處（網站標「待補出處」，" +
    "current.unsourced 列出是哪幾項）。這種任務要**照 unsourced 的原文**重交你查得到的那幾項（一條一項、字要一樣），source_urls 放看得到它們的頁面——" +
    "伺服器只會把出處掛到文字相同的項目上，陣列本身不會變。查到的寫法不同或有這裡沒有的項目，照抄原文並在 note 說明。**臉書、IG、Threads 讀不到，不算出處**。" +
    searchFirst("profile_detail_gap"),

  profile_gap:
    "用一筆 politician 一次補齊，查不到的欄位不要填。" +
    "**照片要是人像照**：正方形或直式、短邊至少 120px。橫幅、活動看板、新聞情境照會被系統量尺寸擋下——官網的「縣長簡介」大圖常常是橫幅，請點開圖確認，或優先用維基百科、議會官網的個人照。" +
    searchFirst("profile_gap"),

  candidate_status_stale:
    "**官方登記名冊在 <https://web.cec.gov.tw/central/article/64709>**（每一屆都會有）：那頁掛著各級選舉的候選人登記彙總表 PDF，逐列寫著選區、登記日期、姓名、政黨。下載後用 `pdftotext -enc UTF-8 -layout` 解析——**`-enc UTF-8` 不加會整段變空白**（CID 字型）。這比媒體整理的名單可靠，是唯一的官方名冊。" +
    "登記截止後還標著「傳聞參選」「可能參選」的，只有兩種可能：**在登記名單上** → correction 把 candidate_status 改成 registered；**不在名單上** → 改成 not_running。兩者都要附得出你查的那份名單（該縣市選委會的登記公告，或媒體整理的完整登記名單）。" +
    "**查不到該縣市的名單就用 no_change 回報，不要用猜的把人留在「傳聞」。**",

  policy_validity:
    "**先問這一筆是不是政見。** 先看有沒有 source_url：有就打開它查證；**沒有的話（系統掃到的多半是這種）自己去找原始出處**。然後三條路選一條：整筆不該存在 → removal；分類或狀態標錯、或是政見但缺出處 → correction（缺出處就補 policies.source_url）；有出處而且是有效的承諾 → no_change 並在 note 說明你查到什麼。" +
    "**沒有出處的政見不要回 no_change**——那樣出處永遠是空的，過一陣子又會再派一次。",

  policy_source_missing:
    "這筆政見沒有出處。去找原始報導或官方公告，用 correction 補 policies.source_url。找不到就 no_change 並寫你找過哪裡——不要拿主題相近的頁面充數。",

  source_mismatch:
    "來源是真的、也對題，但 description 裡最具體的那段（數字、期程、名稱）在原文找不到——這比沒來源危險，因為它看起來查證過了。" +
    "先把原文逐字讀一遍（數字要正規化：1000億／千億／1,000 億算同一個；8.39 公里不要切成 39 公里），確認那段真的沒根據。" +
    "有根據 → no_change 並貼出原文那一句；沒根據 → 用 correction 改 policies.description，把沒根據的部分刪掉或改成原文有的寫法（原文寫 48 億政見寫 49 億這種，改成 48 億）；" +
    "整筆都對不上來源 → 那是 policy_source_missing 的形狀，用 correction 換來源或 removal。",

  progress_stale:
    "**第一步先判斷它是不是政見**：標語、團隊組成、行程、個人表態不是政見，追不出進度也不該追，那種用 removal 回報，不要為它補欄位。" +
    "是政見才往下做，而且依狀態問兩種不同的事：施政中的問「近期進度如何」；已投票屆別的競選承諾問「這個人當選了嗎、承諾後來兌現了嗎」——elections 裡有他的參選紀錄與 election_result。當選就用 policy_progress 把 status 改成 In Progress／Achieved／Stalled／Failed；落選、或我們根本沒有他那場選舉的參選紀錄，就用 candidacy 補 election_result。真的查不到後續就 no_change 並說明你查了哪些來源。" +
    SOLE_SOURCE_TASK_NOTE,

  candidacy_source_missing:
    "**官方登記名冊在 <https://web.cec.gov.tw/central/article/64709>**（每一屆都會有）：那頁掛著各級選舉的候選人登記彙總表 PDF，逐列寫著選區、登記日期、姓名、政黨。下載後用 `pdftotext -enc UTF-8 -layout` 解析——**`-enc UTF-8` 不加會整段變空白**（CID 字型）。這比媒體整理的名單可靠，是唯一的官方名冊。" +
    "這筆參選紀錄缺東西，**缺什麼看 what_we_need 與 target.missing**：沒有網址來源、沒有縣市（region）、沒有選區（electoral_district），或鄉鎮層級選舉沒有鄉鎮（sub_region）。" +
    "一律用 candidacy 重交同一人同一屆，缺的那一欄補上、其餘欄位照那一屆的名冊填（candidate_status 不要順手改；party 填那一屆的推薦政黨，不要照抄他現在的政黨——人會換黨），查不到就 no_change 說明你找過哪裡。" +
    "選區寫法：縣市議員「第NN選舉區」；鄉鎮市民代表、區民代表 sub_region 填鄉鎮市區、electoral_district 填「第NN選舉區」（缺的是 electoral_district 時，target.cec_districts 是名冊那一列的選舉區）；區域立委「第NN選區」；不分區與原住民立委 region 填「全國」、electoral_district 填「不分區」「平地原住民」或「山地原住民」。" +
    // 參選紀錄缺政黨（#346 第二階段，協議 1.56.0）
    "**缺的是政黨（target.missing＝party，任務編號 auto:candidacy_source_missing:party:…）**：party 照中選會名冊那一屆的推薦政黨填（target.cec.party），不要填他現在的政黨——人會換黨。 " +
    // 補號次（2026-10-08）
    "**缺的是號次（target.kind＝cand_no，任務編號 auto:candidacy_source_missing:cand_no:…）**：整個單位一件，名單在 target.items；號次要等中選會抽籤之後，到該縣市選舉委員會公告的候選人名單或選舉公報上找，系統不核號次來源，詳細做法看這一件任務的 hint。" +
    "**target.kind＝cand_no_recheck**：同一個號次單位裡有重複或跳號，target.units 逐單位列出異常，要對公告重查，詳細做法同樣看 hint。",

  election_result_missing:
    "我們沒有這個人那場已投票選舉的結果——可能是參選紀錄在、結果空白（名下有政見的人），也可能是中選會當選名單上有他、我們連那一屆的參選紀錄都沒有（target.record_missing）。" +
    "到中選會查該選區結果，用 candidacy 補 election_result＝elected／not_elected（得票數、得票率不收，不用查）。" +
    "**這筆是承諾追蹤的前提**——不知道有沒有當選，就沒辦法問承諾兌現了沒有。查不到官方結果不要猜，用 no_change。",

  // 整批補選舉結果（2026-10-06）：一個單位一件、一筆交完。系統票是「每一位都對得上中選會名單」才投，
  // 所以代理要做的是逐位核對、只交核對過的；對不上的留在 note，別猜
  election_results_missing:
    "這是**一整個單位**（一屆、一種選舉、一個縣市；村里長與代表到鄉鎮市區）還沒補的選舉結果，名單在 items：每一位附系統比對到的中選會那一列（cec），**那是線索不是答案**。" +
    "打開中選會選舉資料庫這個單位的結果表（db.cec.gov.tw，依屆別、選舉、縣市點進去），逐位核對：是不是同一個人（同名不同人看選區、村里、出生年）、當選還是落選。" +
    "核對過的交進**一筆** election_results：election_id／election_type／region／sub_region 照 target 帶，items 每位一項 {politician_election_id, election_result：elected 或 not_elected}。" +
    "**核對不了、或不是同一個人的不要放進 items**，在 note 寫是哪幾位、為什麼——系統會逐位跟中選會名單比，整批都對得上才投系統票，放一位猜的進來整批就要多等一張票。" +
    "這一件只補結果，**不要順手改參選狀態、地區或姓名**；得票數、得票率不收。source_urls 第一個放你核對的中選會那一頁。" +
    "整個單位都查不到（中選會那一頁打不開、名單上一個都對不上）才回 no_change，finding 寫你看了哪幾頁。",

  // 參選紀錄疑似掛錯人（2026-10-06）：同名的人資料混在一起。判斷依據要寫得出來，不能只看名字
  candidacy_owner_mismatch:
    "這筆參選紀錄可能掛到了**同名的另一個人**身上，target.signals 是系統懷疑的理由（中選會名冊出生年不同、交件寫的縣市不同、換縣市參選、有人寫過「不是同一人」）。" +
    "先查中選會名冊：已投票的屆別看中選會選舉資料庫（出生年、選舉區、推薦政黨），2026 看候選人登記彙總表（選舉區、推薦政黨）；再看 target.other_records（這個人名下其他參選紀錄）是不是同一個人會走的路。" +
    "**不是同一個人** → 交 reassign_candidacy：改掛到 target.same_name 裡真正的那一位（to_politician_id），都不是就新建（new_politician：姓名、出生年、推薦政黨）；" +
    "evidence 寫出處上這一筆的出生年、推薦政黨或選舉區（至少一項，出生年最有力），reason 寫你憑什麼分辨。" +
    "**是同一個人**（例如真的換了縣市或換了黨參選，有報導為證）→ 交 no_change、outcome=confirmed，finding 寫你怎麼確認的——確認過的這一筆不會再派。" +
    "只有名字一樣、其他都對不上也查不到，不要猜：回 no_change、outcome=not_found。",

  policy_election_missing:
    "這筆政見沒標所屬屆別，網站上顯示「未標註屆別」。打開 source_url 確認是哪一場選舉的承諾，用 correction 把 policies.election_id 改成該年份。" +
    "**同一個人可能多屆都選過，來源沒寫清楚就不要猜**，用 no_change 回報。" +
    "特別是**不要用「他是現任第 N 屆」回推屆別**：那是推論不是出處，而且政見可能是更早那一屆提的。" +
    "**若來源是現任者任內宣布的施政承諾**（不是選前提的），election_id 填他這一任當選那屆，同一筆 correction 把 status 改成 Proposed——那不是競選承諾。" +
    "來源那一頁要自己寫出是哪一場選舉（或寫得出投票年份），才算證明得了。",

  policy_election_mismatch:
    "這筆政見標的屆別跟提出日期對不上——提出日期晚於那場選舉的投票日。打開來源確認是哪一屆，用 correction 改 election_id；是日期填錯就改 proposed_date；" +
    "**若它其實是這個人當選後、任內才宣布的施政承諾**（不是選前的競選承諾），屆別與日期都沒錯，用 correction 把 status 改成 Proposed。分不出來用 no_change。",

  news_sweep:
    "打開 RSS 網址，挑出提到 2026 候選人具體政見、**現任者在任內新宣布的具體施政承諾**（例：總統宣布普發現金、市長宣布新計畫）、或既有政見有新進度的報導，每筆用 policy／policy_progress 提交。" +
    "任內施政承諾用 policy：status 填 Proposed、election_id 填他這一任當選的那屆、proposed_date 填宣布日——**不是競選承諾，不要填 Campaign Pledge**。" +
    "**source_urls 放新聞原文網址**——RSS 裡 <link> 的值，不是 RSS 本身。看完沒有可提交的就用 no_change 並寫你看了幾筆。" +
    SOLE_SOURCE_TASK_NOTE,

  fix_disputed:
    "有人的貢獻被兩票反對擋下來了，任務敘述帶著每一條反對理由。請提一筆**改好的新貢獻**，不要只重送原本那一欄——反對意見指出的連帶問題要一起修掉。",

  // 2026-10-06：測試資料的人物（removal 移除整個人）、政黨資訊缺口（party_info）
  placeholder_politician:
    "這位人物的姓名看起來是測試資料（例如「測試候選人ABC」），或（target.kind＝orphan）他的參選紀錄被改掛到別的同名的人身上之後名下已經什麼都沒有（空殼）。先查中選會選舉資料庫、選委會公告、媒體有沒有這個人：" +
    "**查無此人** → 用 removal 回報：target_table 填 politicians、target_id 填人物 id、reason（≥20 字）寫你查了哪些地方都沒有這個人；通過後整個人連參選紀錄一起刪（留履歷、可還原）；" +
    "**真有其人** → 用 no_change（outcome=confirmed）回報，checked_urls 放看得到他的官方頁面。",
  party_info_missing:
    "這個政黨缺的資訊寫在 target.kind 與 target.missing：rename＝改名的界線日（新名稱開始用的日子、舊名稱停用的日子）；" +
    "off_registry＝內政部名冊查無此名稱的那幾個——是不是名冊上某個政黨改名前的名字（前身）、什麼時候停用；dissolved＝名冊狀態是解散、廢止、撤銷，停用日是哪一天。" +
    "查內政部政黨資訊網的政黨頁、內政部的公告或政黨自己的公告，用 party_info 交：parties 每個政黨一項，改名要新舊兩筆一起交；" +
    "**查不到確切的日子就不要交那一欄**（不要填月初、年初湊）；名字像不算改名，要有來源講明是同一個政黨改名。查不到就用 no_change 說明你查了哪些網址。",
  not_running_recheck:
    "**官方登記名冊在 <https://web.cec.gov.tw/central/article/64709>**（每一屆都會有）：那頁掛著各級選舉的候選人登記彙總表 PDF，逐列寫著選區、登記日期、姓名、政黨。下載後用 `pdftotext -enc UTF-8 -layout` 解析——**`-enc UTF-8` 不加會整段變空白**（CID 字型）。這比媒體整理的名單可靠，是唯一的官方名冊。" +
    "這一列被標成「不參選」，但沒有人對過官方登記名單——多半是早期匯入時就這樣寫的。"
    + "**這個標記的代價很大**：標成不參選之後，這個人的政見、基本資料、參選來源、選舉結果四種缺口都不會再被派給任何人。"
    + "請打開該縣市選舉委員會的登記公告（或媒體整理的完整登記名單）核對："
    + "**他在名單上** → correction 把 candidate_status 改成 registered，附那份名單；"
    + "**確實不在名單上** → no_change 且 outcome=confirmed，checked_urls 放你核對的那份名單；"
    + "**找不到該縣市的名單** → no_change 且 outcome 填 unreachable 或 not_found，不會蓋章。"
    + "`source_note` 是匯入來歷，**不要拿它當證據**——實測很多寫著「可能再次挑戰」卻被標成不參選。"
    // 退選前有沒有登記（#345 後續，協議 1.55.0）：同一個型別的另一種，收尾是 correction 改 withdrawn_after_filing
    + "**任務編號是 auto:not_running_recheck:filing:…（target.kind＝withdrawn_filing）的**問的是「退選前有沒有登記過」："
    + "不在登記名冊上 → correction 把 withdrawn_after_filing 改成 false；在名冊上、後來宣布退選 → 改成 true；在名冊上、還在選 → 改 candidate_status 成 registered（不要兩欄同一筆改）。",

  // 應選名額（#344，2026-10-06）：議員、代表各選舉區選幾席。名額不能從候選人或當選人數推，要照選舉公告抄
  district_seats_missing:
    "找**這一屆、這個縣市、這種選舉的選舉公告**（選委會發布選舉公告時附的「應選名額表」；已投票的屆別，選舉公報每個選舉區的開頭也寫著應選名額），" +
    "把公告上**這個縣市的每一個選舉區**都交進一筆 district_seats：districts 每區一項 {district, seats}——district 照公告的選舉區（議員寫「第01選舉區」，鄉鎮市民代表、原住民區民代表寫「麥寮鄉第01選舉區」，一個鄉鎮只有一區的寫「蘭嶼鄉選舉區」），seats 填公告的應選名額。" +
    "**原住民選舉區**（平地原住民、山地原住民）也要列，加 kind：indigenous_plain 或 indigenous_mountain；一般選舉區不用填 kind。" +
    "target.known_districts 是我們目前知道的選舉區（seats 是空的就是缺名額的）：公告上有、這裡沒有的照樣交；這裡有、公告上沒有的不要交，在 note 寫出來。" +
    "**名額只能照公告抄，不要用候選人數或當選人數推**——同額不足、無人登記的選舉區，人數跟名額對不上。source_urls 第一個放公告本身（選委會網站的公告頁或 PDF）。" +
    "公告還沒發布、或你找遍選委會網站都沒有這一份，就回 no_change＋outcome=not_found，finding 寫你看了哪些頁面。",

  audit:
    "訪客在政見頁貼了一個文件網址。打開它，核對內容與我們既有的相關政見／進度是否一致：不一致就提 correction 或 policy_progress，一致就提 no_change 回報無異動。",

  // 政見三要素（#364，2026-10-05；與日本站同一套）：正見是第三方，不提政見、不補數字、不換算、不評價，
  // 只把每條政見拆成同一個格式讓人並排比較。沒有列＝未調查、stated=false＝未說明，這個分別是整件事的核心。
  policy_elements_missing:
    "把這條政見拆成三要素：**數值目標**（做到多少、做到什麼程度：幾座、幾戶、幾%、多少錢、給誰、全部）、**達成期限**（什麼時候之前）、**財源**（錢從哪裡來：中央補助、縣市預算、基金、民間投資）。" +
    "**先找原文**：選舉公報（候選人登記的政見原文）、政見發表會、候選人官網或競選文宣的政見頁。policy.source_url 若只是轉述的新聞，先找到原文；**policy.description 是我們的摘要，不是原文**，不可以拿它拆。" +
    "每個要素三選一：原文有寫 → stated=true，text 照原文寫（120 字內，**不補數字、不換算、不評價**——原文寫「增加 3 座」就寫「增加 3 座」，不要算成百分比，也不要自己加「預計」「約」）；" +
    "查過原文、沒寫 → stated=false，text 不填——這也是答案，網站會標「未說明」；沒找到原文 → 這個要素不要交，網站會標「未調查」。" +
    "只寫「提升」「加強」「全面推動」而沒有可量的標的，不算數值目標，填 stated=false。" +
    "**每個要素都要附 source_locator**＝原句在原文的位置（例：公報第 2 頁〈交通〉第 3 點、政見發表會影片 00:12:30、官網〈政見〉頁第 4 段），stated=false 也要寫你查的是原文哪一段；要素出自不同網址時用 source_url 指名（要是 source_urls 之一，不填就是第一個）。" +
    "**達成期限換得成日期就填 deadline_date**（會計年度是曆年）：「2028 年前」「2028 年底」→ 2028-12-31；「2027 年 6 月」→ 2027-06-30；「任內」→ target.term_end（這一任的卸任日）；「兩年內」這種相對期限，原文寫得出從哪天起算才換，否則只填 text、不填 deadline_date。" +
    "三個要素一起交成一筆 policy_elements；只查得到其中幾個就只交那幾個，沒交的會留在任務裡給別人。已經有的要素（existing_elements）寫錯了，重交那一個要素就會覆蓋。" +
    "找不到這條政見的原文 → no_change，outcome=not_found，checked_urls 列你找過的地方。" +
    gazetteImageNote,

  deadline_due:
    "這條政見原文寫了達成期限（target.deadline_text，換算 target.deadline_date），期限已經過了，期限之後卻沒有任何進度紀錄。請查**期限到了做到沒有**：施政報告、議會或立法院的議事紀錄與質詢、預算書與決算書、新聞。" +
    "查到結果就用 policy_progress 交：date 填事件日期（不是今天）；status 依來源寫的結果填——做完了 Achieved、做了一部分還在做 In Progress、延宕或卡住 Stalled、確定放棄或做不到 Failed；note 寫清楚跟期限比的結果（例：「原訂 2025 年底完工，2026-03 才通車」）。" +
    "**不要自己判定跳票**：要有來源寫出結果，查不到就是查不到。查證後確定期限之後真的沒有任何消息，用 no_change 回報，finding 寫你查了哪些來源、最新的消息停在哪一天。" +
    "先確認來源講的是這個人任內、職權內做的事；前任或別人做的同主題事情不算。" +
    SOLE_SOURCE_TASK_NOTE,

  // 政策脈絡（#349，2026-10-06）：一條脈絡＝一件事在某一層級、某一地方的來龍去脈。系統把同一層級、同一地方、同一類別的政見
  // 放成一格交給你看，判斷「是不是同一件事」是你的事——字面相似不準（同議題常常用字完全不同），系統不替你猜。
  lineage_candidate:
    "整份看過 target.policies（current.policies 有每條的說明開頭），找出**講的是同一件事**的政見：同一個建設（同一條路線、同一座場館、同一塊基地）、同一部法律或條例、同一筆補助、同一個制度。" +
    "主題相同但標的不同（不同的醫院、不同的捷運路線、不同的補助對象）**不是**同一件事；一份政見清單的「N 大政見」本來就是 N 件事。" +
    "找到一組就交一筆 lineage：current.existing_lineages 裡已經有這件事就帶 lineage_id 歸入（不要另建一條）；沒有就用 new_lineage 建，title 用這件事的名稱（中性、照事實，不寫評價或口號），" +
    "level 填這件事實際在哪一級政府決定與執行（中央的法律與預算 national、縣市政府的建設與福利 county、鄉鎮公所的 township；立委承諾的地方建設多半是 county），region／sub_region 照那一級填。" +
    "政見已經在別條脈絡的（lineage_id 有值）不能再歸入；那兩條其實是同一件事的話，note 寫清楚、歸入其中一條就好。" +
    "note 寫憑什麼判定是同一件事（政見原文裡共同的名稱、地點、金額或文件）。同一格裡有好幾件事就交好幾筆。" +
    "只有一條政見、沒有別人或別屆談同一件事，不要建脈絡；整份看完沒有任何同一件事 → no_change，outcome=confirmed，finding 列出你比對過哪幾組、為什麼不是同一件事。",

  handover_missing:
    "記交接：脈絡裡前一任（target.from_politician_id）的那件事，後一任（target.to_politician_id）上任後怎麼處理。五選一：keep 接手（原樣延續）、pivot 轉向（目的不變、做法變了）、shrink 縮小（規模或預算縮水但沒停）、stop 中止（停掉）、resume 重新開始（曾經停掉後又重啟）。" +
    "依據要是後任上任後的施政報告、預算書、議會議事錄或報導，寫出後任實際怎麼做；**後任的政見清單裡沒有這件事，不等於中止**——那叫查不到。" +
    "中止要有來源明確寫出停止、喊卡、解約或終止，note 寫出誰、哪份文件、哪一天決定的；中止這一型要兩台不同機器的驗證票才會上線。" +
    "用 lineage_handover 交：lineage_id、from_politician_id、from_election_id、to_politician_id、to_election_id 照 target 帶，decided_on 填判定依據的日期（知道的話），source_locator 寫依據在出處的哪裡。" +
    "還查不到後任怎麼處理 → no_change，outcome=not_found，checked_urls 列你查過的施政報告、預算與議事錄。" +
    SOLE_SOURCE_TASK_NOTE.replace("交 policy／policy_progress 時", "交 policy／policy_progress／lineage_handover 時"),

  lineage_roles_missing:
    "標參與角色：**以官方紀錄為準**。到立法院議事系統（議案、關係文書、提案人與連署人名單）或縣市議會網站（提案、議事錄、質詢）查這件事的官方紀錄，" +
    "誰是提案人 proposer、共同提案人 co_proposer、連署人 cosigner，或在官方紀錄裡主張推動 advocate（例：質詢、臨時動議要求辦理）；不限 target.people，同一案的其他人也一起標（要是網站上已有的人物）。" +
    "官方紀錄的角色 basis 填 official_record，出處放那一頁的網址（要是 ly.gov.tw、議會或 *.gov.tw 的網址），source_locator 寫議案編號、關係文書頁碼或會議日期與案由。" +
    "本人在官網、新聞、答辯書裡自稱「我提的」「我推動的」：照官方紀錄標他的角色，另外加一項 basis 填 self_claim（本人宣稱）——本人宣稱不當作主導的證據。臉書、IG 讀不到，不收。" +
    "已經標過的角色寫錯了，重交同一人同一種依據就會覆蓋；標錯人用 remove=true 拿掉。官方紀錄裡查不到 → no_change，outcome=not_found，checked_urls 列你查過的議事系統頁面。",

  lineage_link_candidate:
    "判斷上下級：這條脈絡（target.lineage_id）跟 target.upper_candidates 裡上一級的脈絡，有沒有**實際的法規、預算或政策連結**。" +
    "上級立法或補助、這裡配套執行 → top_down（例：中央條例或前瞻補助核定 → 縣市的執行計畫）；這裡先做或爭取、上級後來採納 → bottom_up（例：縣市試辦或連署 → 中央入法、編列預算）。" +
    "有就用 lineage_link 交：upper_lineage_id 填上級那條、lower_lineage_id 填這一條，note 寫依據（條文、補助核定公文、執行計畫寫到上級的哪一案），一對交一筆。" +
    "同類別但只是主題相近、找不到實際連結的不算。逐條看完都沒有 → no_change，outcome=confirmed，finding 寫每一條的結論。",
};

/**
 * 單則新聞的 news_sweep（target.kind='news_item'，2026-09-29 起由 Jev 初篩後建）：跟上面那條「讀整份 RSS」不同，
 * 這一件只有一則（或同一條政見的幾則）新聞，系統已經猜好是「進度」還是「新承諾」。
 * 猜的只是線索：代理照新聞內容判斷，兩條路都能走，判錯了就用 no_change 講清楚——那也是初篩準不準的資料。
 * 由 task-context.ts 依 target.kind 選用；靜態表那條留給舊的整份 RSS 任務。
 */
export function newsItemGuidance(suggestion: string | null | undefined): string {
  const lead = suggestion === "progress"
    ? "系統初篩認為這則新聞講的是 policy 那條政見的進度。"
    : "系統初篩認為這則新聞裡，這個人提出了 existing_policies 裡還沒有的具體承諾。";
  return lead +
    "先打開 news.url 讀全文（hint_sources 若有好幾則，每一則都要讀），照新聞實際寫的內容判斷，**初篩只是線索、不是結論**：" +
    "**是某條既有政見的新進度**（開工、完工、編列預算、修法、延宕、放棄）→ 交 policy_progress，policy_id 用 policy.id（或 existing_policies 裡對得上的那一條），date 填新聞寫的事件日期；" +
    "**是清單上沒有的具體承諾** → 交 policy：選前提的填 Campaign Pledge；現任者在任內新宣布的施政承諾填 Proposed、election_id 填他這一任當選那屆、proposed_date 填宣布日。一則新聞有幾個能各自查核的承諾就拆幾筆，先看 existing_policies 與 queued_policies，同一個承諾換句話說不要再交；" +
    "**初篩判錯了**（只是行程、致詞、評論、選情、民調、口水，或看不出具體承諾）→ no_change，outcome=not_found，finding 寫新聞實際在講什麼、為什麼不算進度或承諾，checked_urls 放新聞網址；新聞打不開才用 unreachable。" +
    "source_urls 放新聞原文網址；新聞不是官方來源，所以**再附一個不同網站的來源**（另一家媒體的同一則、市府或議會的新聞稿、候選人臉書），只附這一則會被當場退回（不算被拒；協議 1.45.0 媒體不能當唯一出處）。";
}

/** 這些型別的 hint 依當筆資料而變，由 shapeTaskCurrent 自己組（不走這張靜態表）。 */
export const DYNAMIC_GUIDANCE_TYPES = [
  "legacy_audit",
  "duplicate_policy",
  "duplicate_politician",
  "roster_check",
  "question",
  "adjudicate",
] as const;

/** 有沒有交代這種任務怎麼做——靜態表或動態組的都算。 */
export function hasGuidance(taskType: string): boolean {
  return taskType in TASK_GUIDANCE || (DYNAMIC_GUIDANCE_TYPES as readonly string[]).includes(taskType);
}

/**
 * 「回報時 payload 要長什麼樣」，隨任務送出（2026-09-21 candlefish 回報）。
 *
 * 現場問題：每一筆任務都寫「用 correction 型別回報」，卻沒有任何一筆說 correction 的
 * payload 是什麼形狀（target_table／target_id／changes[]）。代理只好回頭翻協議，
 * 或者猜——而猜錯就是一次 400，查證的工白做。
 *
 * 這是手寫的精簡版，不是 schema 的複製品：只列必填與最容易漏的欄位，讓代理送得出第一版。
 * 完整規則仍以 contribution-schema.ts 為準（它才是驗證的那一份）。
 * `task-guidance.test.ts` 會把這裡提到的欄位跟 schema 的必填清單對帳，兩邊走鐘就紅。
 */
export const PAYLOAD_SHAPE: Record<string, string> = {
  // category 與 status 的值域直接由常數生成，不手抄——手抄就是又一份會走鐘的拷貝。
  // 兩隻跑任務的代理各自獨立回報：任務沒講 category 是固定清單，其中一隻假設是自由文字（錯的），
  // 另一隻只能從既有政見裡看到 19 個值中的 9 個當例子。
  policy:
    `payload：title（4–200 字）、description（≥20 字）、category（要是這 19 個之一：${POLICY_CATEGORIES.join("／")}）、` +
    `status（${POLICY_STATUSES.join("／")}）、election_id（選舉年份）、politician_id 或 name。source_urls 放證明這筆政見的網址。` +
    "可帶 origin（政見從哪裡來：pledge 競選承諾／policy_address 施政報告／assembly 議會提案／budget 預算；不帶的競選承諾自動標 pledge）。",
  // education_level 是固定值域（生產資料的實際分布），不是自由文字——
  // 實測回報代理只能猜（2026-09-21）
  politician:
    "payload：name，加上你查到的 birth_year（西元四位數）／current_position／" +
    "avatar_url（人像照，正方或直式、短邊 ≥120px）／" +
    `education_level（要是這幾個之一：${["高中(職)以下","高中(職)","專科","大學","碩士","博士","其他"].join("／")}）／bio。` +
    "查不到的欄位不要填。",
  candidacy:
    "payload：politician_id 或 name、election_id（選舉年份）、election_type、region、candidate_status。已投票的屆別可加 election_result、cand_no、position（得票數、得票率不收）。" +
    "election_type 是縣市議員的話可加 electoral_district（第NN選舉區；伺服器會自動統一寫法，沒填也會從 position 抽）。",
  policy_progress:
    "payload：policy_id、status、progress（進度說明）、date、note。",
  correction:
    "payload：target_table、target_id、changes[]（每項 {field, current_value, correct_value}）、reason。",
  removal:
    "payload：target_table（policies 政見；politicians 人物，只收測試資料、查無此人這種）、target_id（uuid）、reason（≥20 字，說明為什麼整筆不該存在）。",
  no_change:
    "payload：task_id、outcome（confirmed／unreachable／not_found）、finding（你查了什麼、查到什麼）、checked_urls[]（你實際打開過的網址）。",
  merge_politician:
    "payload：same_person（true／false）、keep_id、remove_id、reason（≥20 字）。",
  adjudication:
    "payload：contribution_id、verdict（uphold／reject）、reason（≥20 字）、checked_urls[]；身份爭議可帶 resolved_politician_id。",
  question_answer:
    "payload：question_id、answer。",
  roster_check:
    "payload：region、election_id、election_type、ours_count、cec_count、submitted、note。",
  district_seats:
    "payload：election_id、election_type、region（三個照任務 target 原樣帶回）、districts（每個選舉區一項 {district, seats}，原住民選舉區加 kind）、note（公告上沒有的選舉區、或其他要說明的）。source_urls 第一個放選舉公告。",
  election_results:
    "payload：election_id、election_type、region、sub_region（四個照任務 target 原樣帶回；target 沒有 sub_region 就不填）、" +
    "items（你核對過的每一位一項 {politician_election_id：current.items 裡那一位的參選紀錄 id、election_result：elected 當選／not_elected 落選}，一筆最多 120 位）、" +
    "note（沒放進 items 的是哪幾位、為什麼；選填）。source_urls 第一個放中選會選舉資料庫那一頁。",
  reassign_candidacy:
    "payload：politician_election_id（要改掛的那一筆參選紀錄，整數 id）、from_politician_id（這筆現在掛的那一位的 uuid）、to_politician_id（改掛到既有的另一位，uuid）或 new_politician（新建一位：{name 同名、birth_year、party，可帶 region}）二擇一、" +
    "evidence（出處上這一筆的分辨資料 {birth_year, party, district}，至少一項）、reason（≥20 字：憑什麼分辨不是現在掛的那位）。source_urls 放中選會名冊或報導。",
  task_suggestion:
    "payload：title、description、task_type、region，可帶 target_politician_id／target_policy_id／hint_sources。",
  // 政黨資訊（#346 第二階段）
  party_info:
    "payload：parties（每個政黨一項 {party_id, valid_from, valid_to, predecessor_id}，1～5 項、每項至少一欄；改名新舊兩筆一起交）、note（≥10 字：依據哪一份公告、上面怎麼寫）。日期是 YYYY-MM-DD，查不到確切日子就不要交那一欄；臉書、IG、Threads 不算出處。",
  // 政見三要素（#364）：一筆一條政見、1～3 個要素
  policy_elements:
    "payload：policy_id、elements[]（1～3 個，每個 {element：target 數值目標／deadline 達成期限／funding 財源；stated：true 原文有寫／false 查過原文沒寫；" +
    `text：原文的事實，${POLICY_ELEMENT_TEXT_MAX} 字內（stated=false 不填）；deadline_date：YYYY-MM-DD（只有原文寫了的達成期限、換得成日期才填）；` +
    "source_locator：原句在原文的位置（必填，stated=false 也要填查的是哪一段）；source_url：出自 source_urls 的哪一個（不填＝第一個）}）。source_urls 放原文網址。",
  // 政策脈絡（#349）
  lineage:
    "payload：lineage_id（歸入既有的脈絡）或 new_lineage（建新的：{title 4～60 字、summary 200 字內、category 19 類之一、" +
    "level：national 中央／county 縣市／township 鄉鎮市區、region 縣市、sub_region 鄉鎮}）二擇一；policy_ids（要歸入的政見 id，新脈絡至少 2 條、中央層級至少 1 條）；" +
    "歸入既有脈絡時也可用 detach_policy_ids 拿掉歸錯的、用 title／summary／category 更正脈絡本身；note（20 字以上：憑什麼判定是同一件事）。",
  lineage_participants:
    "payload：lineage_id、participants[]（1～50 項，每項 {politician_id、role：proposer 提案／co_proposer 共同提案／cosigner 連署／advocate 主張推動、" +
    "basis：official_record 官方紀錄（出處要是立法院、議會或 *.gov.tw）／self_claim 本人宣稱、source_locator 議案編號或頁碼（必填）、source_url 出自 source_urls 的哪一個（不填＝第一個）、note 選填；" +
    "標錯的人加 remove=true 拿掉}）。臉書、IG 讀不到，不收。",
  lineage_handover:
    "payload：lineage_id、from_politician_id、from_election_id、to_politician_id、to_election_id（照任務 target 帶；那一屆不在網站上就不填）、" +
    "handover_type（keep 接手／pivot 轉向／shrink 縮小／stop 中止／resume 重新開始）、decided_on（判定依據的日期，選填）、note（20～500 字：依據哪份文件、文件怎麼說）、" +
    "source_locator（依據在出處的哪裡）、source_url（出自 source_urls 的哪一個，不填＝第一個）。中止要兩台不同機器的驗證票。",
  lineage_link:
    "payload：upper_lineage_id（上一級那條）、lower_lineage_id（下一級那條）、link_type（top_down 上級立法或補助，下級執行／bottom_up 下級爭取，上級採納）、" +
    "note（20～500 字：哪一份法規、補助核定或執行計畫把兩件事連起來）、source_locator（條文、公文字號或頁碼）、source_url（選填，不填＝第一個）。",
};

/** correction／removal 這類要指定「改哪一列」的任務，target_table 是哪一張表。 */
const TARGET_TABLE: Record<string, string> = {
  candidate_status_stale: "politician_elections",
  not_running_recheck: "politician_elections",
  candidacy_source_missing: "politician_elections",
  policy_source_missing: "policies",
  source_mismatch: "policies",
  policy_election_missing: "policies",
  policy_election_mismatch: "policies",
  policy_validity: "policies",
  placeholder_politician: "politicians",
  legacy_audit: "policies",
  duplicate_policy: "policies",
};

/**
 * 自動缺口的 task_id 是 `auto:<型別>:<那一列的 id>`，id 沒有另外放進 target 時從這裡取。
 *
 * id 有兩種長相：policies 是 uuid、politician_elections 是整數（線上實測
 * `auto:candidate_status_stale:10009`）。2026-09-21 第一版只認 uuid，
 * 結果最該被填好的那一種反而填不出來——而單元測試用的是自己編的 uuid，
 * 測到的是我的假設不是真實資料，所以測試全綠也沒擋住。
 *
 * 多段的（例如 duplicate_policy 的 `auto:duplicate_policy:<a>:<b>` 指的是一對）
 * 不解：那不是單一列，填進 target_id 會是錯的。
 */
export function rowIdFromTaskId(taskId: string | null | undefined): string | null {
  const m = /^auto:[a-z_]+:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]+)$/i.exec(String(taskId ?? ""));
  return m ? m[1] : null;
}

/**
 * 回報用的 payload 骨架，已知的 id 先填好，隨任務送出（2026-09-21）。
 *
 * 兩隻跑任務的代理各自獨立實測後指向同一件事：任務講得清「做什麼」、講不清「怎麼交」，
 * 而且有明講欄位名的型別信心 4/5、沒明講的全掉到 3/5。其中 candidate_status_stale
 * 最具體——它要代理改 politician_elections 的某一列，卻沒給那一列的 id，
 * 代理只能用 politician_id + election_id + election_type 猜複合鍵。
 * 那個 id 其實一直在 task_id 裡（auto:candidate_status_stale:<pe.id>），只是沒送出去。
 */
function buildPayload(
  taskType: string,
  contributionType: string,
  target: Record<string, unknown> | null | undefined,
  taskId: string | null | undefined,
): Record<string, unknown> | null {
  const t = target ?? {};
  const rowId = rowIdFromTaskId(taskId);
  const table = TARGET_TABLE[taskType];
  // 一律轉字串：同樣是 politician_elections，從 target 拿到的是整數、從 task_id 解出來的是字串，
  // 兩種任務給的型別不一樣（2026-09-21 跑任務的代理回報）。送出去都收，但不一致本身就會讓人猶豫。
  const asText = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
  const rowTarget = asText(table === "policies" ? t.policy_id : table === "politicians" ? t.politician_id : t.politician_election_id) ?? asText(rowId);
  switch (contributionType) {
    case "correction":
      if (!table) return null;
      // 不參選重查的 filing 那一種（#345 後續）：要改的就是退選前有沒有登記這一欄
      if (taskType === "not_running_recheck" && t.kind === "withdrawn_filing") {
        return {
          target_table: table,
          target_id: rowTarget ?? "（這一列的 id）",
          changes: [{ field: "withdrawn_after_filing", current_value: null, correct_value: "（false＝不在登記名冊上、沒登記過；true＝在名冊上、後來宣布退選。布林值不加引號）" }],
          reason: `（寫出他的姓名「${t.name ?? "姓名"}」與你核對的名冊；在名冊上、還在選的話不要交這一筆，改交 candidate_status）`,
        };
      }
      return {
        target_table: table,
        target_id: rowTarget ?? "（這一列的 id）",
        changes: [{ field: "（要改的欄位）", current_value: "（資料庫現值）", correct_value: "（正確值）" }],
        reason: "（為什麼是這個值，附你查到的來源）",
      };
    case "removal":
      if (!table) return null;
      return {
        target_table: table,
        // duplicate_policy 沒有單一列：哪一筆該移除是代理要判斷的，所以這裡刻意不填
        target_id: rowTarget ?? (taskType === "duplicate_policy" ? "（你判定該移除的那一筆 policy_id）" : "（這一列的 id）"),
        reason: taskType === "placeholder_politician" ? "（≥20 字：你查了哪些地方都沒有這個人）" : "（為什麼整筆不該存在）",
      };
    case "party_info": {
      // 政黨資訊缺口（2026-10-06）：要補哪個政黨、缺哪幾欄照 target；改名的那一種新舊兩筆都列
      const ids = Array.isArray(t.party_ids) ? (t.party_ids as unknown[]) : [t.party_id];
      const missing = Array.isArray(t.missing) ? (t.missing as unknown[]).map(String) : ["valid_to"];
      return {
        parties: ids.map((id) => ({
          party_id: id ?? "（政黨 id）",
          ...Object.fromEntries(missing.filter((f) => f !== "predecessor_id" || id === t.party_id).map((f) => [f, f === "predecessor_id" ? "（改名前那一筆的政黨 id；不是改名就刪掉這一欄）" : "（YYYY-MM-DD，來源寫得出這一天才填；查不到就刪掉這一欄）"])),
        })),
        note: "（依據哪一份公告、名冊頁或報導，上面怎麼寫）",
      };
    }
    case "no_change":
      return {
        task_id: taskId ?? "（這筆任務的 task_id）",
        outcome: "confirmed｜unreachable｜not_found",
        finding: "（你查了什麼、查到什麼）",
        checked_urls: ["（你實際打開過的網址）"],
      };
    case "candidacy": {
      // 補號次（2026-10-08，target.kind＝cand_no）：整個單位一件，名單在 target.items；骨架給第一位，其餘照 items 逐位換
      // 號次重查（kind＝cand_no_recheck）：一件含好幾個號次單位（t.units），骨架給第一個單位的第一位
      if (t.kind === "cand_no_recheck") {
        const units = Array.isArray(t.units) ? (t.units as unknown[]) : [];
        const u0 = (units[0] && typeof units[0] === "object" ? units[0] : {}) as Record<string, unknown>;
        const members = Array.isArray(u0.members) ? (u0.members as unknown[]) : [];
        const m0 = (members[0] && typeof members[0] === "object" ? members[0] : {}) as Record<string, unknown>;
        return {
          politician_id: m0.politician_id ?? "（target.units[].members 裡要更正的那一位的 politician_id）",
          name: m0.name ?? "（他的姓名）",
          election_id: t.election_id ?? "（選舉年份）",
          election_type: t.election_type ?? "（選舉類型）",
          region: t.region ?? "（縣市）",
          ...(u0.sub_region ? { sub_region: u0.sub_region } : {}),
          ...(u0.village ? { village: u0.village } : {}),
          ...(u0.electoral_district ? { electoral_district: u0.electoral_district } : {}),
          cand_no: "（公告上他的號次，正整數；只交跟公告不同的那幾位）",
          candidate_status: t.candidate_status ?? "（照現況）",
        };
      }
      if (t.kind === "cand_no") {
        const items = Array.isArray(t.items) ? (t.items as unknown[]) : [];
        const first = (items[0] && typeof items[0] === "object" ? items[0] : {}) as Record<string, unknown>;
        return {
          politician_id: first.politician_id ?? "（target.items 裡這一位的 politician_id）",
          name: first.name ?? "（target.items 裡這一位的姓名）",
          election_id: t.election_id ?? "（選舉年份）",
          election_type: t.election_type ?? "（選舉類型）",
          region: t.region ?? "（縣市）",
          ...(t.sub_region ? { sub_region: t.sub_region } : {}),
          ...(first.village ? { village: first.village } : {}),
          ...(first.electoral_district ? { electoral_district: first.electoral_district } : {}),
          cand_no: "（公告上他的號次，正整數；公告上找不到他就不要交這一位）",
          candidate_status: t.candidate_status ?? "（照現況）",
        };
      }
      // 參選紀錄缺政黨（#346 第二階段，target.kind＝party）：照中選會名冊那一筆重交，地區照 target.fill、政黨照名冊原字
      if (t.kind === "party_roster") {
        // 2026 這一屆還沒投票：照中選會候選人登記彙總表的「推薦之政黨」（2026-10-06）
        return {
          politician_id: t.politician_id ?? "（人物 id）",
          name: t.name ?? "（姓名）",
          election_id: t.election_id ?? "（選舉年份）",
          election_type: t.election_type ?? "（選舉類型）",
          region: t.region ?? "（縣市）",
          ...(t.election_type === "縣市議員" ? { electoral_district: "（登記彙總表上的選舉區，第NN選舉區）" } : {}),
          party: "（登記彙總表上這一列的推薦之政黨，原字照抄；寫「無」就填「無」）",
          candidate_status: t.candidate_status ?? "（照現況）",
        };
      }
      if (t.kind === "party") {
        const cec = (t.cec && typeof t.cec === "object" ? t.cec : {}) as Record<string, unknown>;
        const fill = (t.fill && typeof t.fill === "object" ? t.fill : {}) as Record<string, unknown>;
        return {
          politician_id: t.politician_id ?? "（人物 id）",
          name: t.name ?? "（姓名，中選會自動核對要用）",
          election_id: t.election_id ?? "（選舉年份）",
          election_type: t.election_type ?? "（選舉類型）",
          ...fill,
          party: cec.party ?? "（中選會名冊上那一屆的推薦政黨，原字照抄）",
          candidate_status: t.candidate_status ?? "（照現況）",
          election_result: cec.election_result ?? "（elected 或 not_elected，照中選會）",
        };
      }
      // 補縣市／補選區（2026-10-05，contribution_auto_tasks_region_gap）：target.missing 列出缺哪幾欄。
      // 缺縣市時不預填 target.region——那是人物表的縣市，照抄等於沒查證。
      const missing = Array.isArray(t.missing) ? t.missing as unknown[] : [];
      const legislator = t.election_type === "立法委員";
      // 縣市議員有在選的一律要帶選區（2026-10-05，協議 1.48.0：沒帶交件就退回）——名單清查交的也一樣
      const councilDistrict = t.election_type === "縣市議員" && !["not_running", "withdrawn"].includes(String(t.candidate_status ?? ""));
      return {
        // 中選會當選、我們沒有紀錄的（target.record_missing）：人物可能還不存在，先給姓名
        ...(t.record_missing === true ? { name: t.name ?? "（姓名）" } : { politician_id: t.politician_id ?? "（人物 id）" }),
        election_id: t.election_id ?? "（選舉年份）",
        election_type: t.election_type ?? "（選舉類型）",
        region: missing.includes("region") ? "（縣市，查證後填；用「台」不用「臺」）" : t.region ?? "（縣市）",
        ...(missing.includes("electoral_district") || councilDistrict
          ? { electoral_district: legislator ? "（第NN選區；不分區／原住民立委填 不分區／平地原住民／山地原住民）" : "（第NN選舉區）" }
          : {}),
        candidate_status: missing.length && typeof t.candidate_status === "string"
          ? t.candidate_status
          : t.record_missing === true ? "qualified" : "（confirmed 表態參選／registered 已登記／qualified 名單上／withdrawn／not_running 之一）",
        ...(t.record_missing === true ? { election_result: "elected" } : {}),
        // 中選會名單上的選區／鄉鎮：縣市議員與立委放 electoral_district，鄉鎮層級放 sub_region
        ...(t.record_missing === true && typeof t.sub_region === "string" && t.sub_region
          ? (t.election_type === "縣市議員" || legislator ? { electoral_district: t.sub_region } : { sub_region: t.sub_region })
          : {}),
      };
    }
    case "policy":
      return {
        politician_id: t.politician_id ?? "（人物 id）",
        election_id: t.election_id ?? "（政見所屬的選舉年份）",
        title: "（4–200 字）",
        description: "（≥20 字）",
        category: "（19 種之一，見 payload_shape）",
        // 補任期政見要的就是那一屆的競選承諾（2026-10-02）
        status: taskType === "term_policy_missing" ? "Campaign Pledge" : "（Campaign Pledge／Proposed／…）",
      };
    case "politician":
      return {
        politician_id: t.politician_id ?? "（人物 id）",
        name: t.name ?? "（姓名）",
        birth_year: "（西元四位數）",
        current_position: "（現職）",
        avatar_url: "（https 人像照網址，正方或直式、短邊 ≥120px）",
        education_level: "（高中(職)以下／高中(職)／專科／大學／碩士／博士／其他 之一）",
      };
    case "merge_politician": {
      const a = (t.a && typeof t.a === "object" ? t.a : {}) as Record<string, unknown>;
      const b = (t.b && typeof t.b === "object" ? t.b : {}) as Record<string, unknown>;
      return {
        same_person: "true 或 false",
        keep_id: asText(a.id) ?? "（保留哪一筆的 id）",
        remove_id: asText(b.id) ?? "（併掉哪一筆的 id）",
        reason: "（≥20 字，說明你憑什麼判定是／不是同一人）",
      };
    }
    case "roster_check":
      return {
        region: t.region ?? "（縣市）",
        election_id: t.election_id ?? "（選舉年份）",
        election_type: t.election_type ?? "（選舉類型）",
        ours_count: t.ours_count ?? "（我們現有幾筆）",
        cec_count: "（官方名單上幾人）",
        submitted: "（這次補了幾筆）",
        note: "（你查的是哪一份名單）",
      };
    case "district_seats": {
      // 我們知道的選舉區先填好，代理只要對著公告填名額（公告上多的再加）
      const known = Array.isArray(t.known_districts) ? (t.known_districts as Array<Record<string, unknown>>) : [];
      return {
        election_id: t.election_id ?? "（選舉年份）",
        election_type: t.election_type ?? "（議員或代表）",
        region: t.region ?? "（縣市）",
        districts: known.length > 0
          ? known.map((d) => ({ district: d.district, seats: "（公告的應選名額）", ...(d.kind && d.kind !== "district" ? { kind: d.kind } : {}) }))
          : [{ district: "（公告上的選舉區）", seats: "（公告的應選名額）" }],
        note: "（公告上沒有的選舉區、或其他要說明的；沒有就刪掉這一欄）",
      };
    }
    case "reassign_candidacy": {
      // 參選紀錄 id 照 target 填好；改掛對象二擇一，同名候選列出來讓代理挑（不預填——挑誰就是這一件要判斷的事）
      const same = Array.isArray(t.same_name) ? (t.same_name as Array<Record<string, unknown>>) : [];
      return {
        politician_election_id: t.politician_election_id ?? asText(rowId) ?? "（要改掛的那一筆參選紀錄 id）",
        from_politician_id: t.politician_id ?? "（這筆參選紀錄現在掛的那一位的 id）",
        to_politician_id: same.length > 0
          ? `（改掛到既有的哪一位：target.same_name 裡的 politician_id，例：${asText(same[0].politician_id)}；都不是就刪掉這一欄、改用 new_politician）`
          : "（資料庫裡沒有同名的另一位：刪掉這一欄、改用 new_politician）",
        new_politician: { name: t.name ?? "（同名）", birth_year: "（西元四位數，照名冊）", party: "（名冊的推薦政黨；無黨籍填「無黨籍」）" },
        evidence: { birth_year: "（出處上這一筆的出生年）", party: "（推薦政黨）", district: "（選舉區或村里）" },
        reason: "（≥20 字：名冊上的出生年／推薦政黨／選舉區，跟兩個人各自怎麼對）",
      };
    }
    case "election_results": {
      // 單位四欄照 target 填好；items 先列出每一位的參選紀錄 id，結果留給代理照中選會填（不預填系統的線索——照抄等於沒核對）
      const ids = Array.isArray(t.politician_election_ids) ? (t.politician_election_ids as unknown[]) : [];
      return {
        election_id: t.election_id ?? "（選舉年份）",
        election_type: t.election_type ?? "（選舉類型）",
        region: t.region ?? "（縣市）",
        ...(t.sub_region ? { sub_region: t.sub_region } : {}),
        items: ids.length > 0
          ? ids.map((id) => ({ politician_election_id: id, election_result: "（elected 或 not_elected；核對不了就把這一項整個拿掉）" }))
          : [{ politician_election_id: "（current.items 裡那一位的參選紀錄 id）", election_result: "（elected 或 not_elected）" }],
        note: "（沒放進 items 的是哪幾位、為什麼；都放了就刪掉這一欄）",
      };
    }
    case "policy_elements": {
      // 只列還缺的要素（target.missing），沒給就三個都列；deadline 才有 deadline_date
      const want = Array.isArray(t.missing) && t.missing.length > 0 ? (t.missing as unknown[]).map(String) : ["target", "deadline", "funding"];
      return {
        policy_id: asText(t.policy_id) ?? asText(rowId) ?? "（政見 id）",
        elements: want.map((k) => ({
          element: k,
          stated: "true（原文有寫）或 false（查過原文、沒寫）",
          text: `（原文寫的事實，${POLICY_ELEMENT_TEXT_MAX} 字內；stated=false 就整欄拿掉）`,
          ...(k === "deadline" ? { deadline_date: "（YYYY-MM-DD；換不成日期就整欄拿掉）" } : {}),
          source_locator: "（原句在原文的位置：公報第幾頁哪一段、影片幾分幾秒；stated=false 寫查的是哪一段）",
        })),
      };
    }
    // 政策脈絡（#349）：骨架照任務 target 先填好已知的 id
    case "lineage": {
      const existing = Array.isArray(t.existing_lineages) ? t.existing_lineages as Array<Record<string, unknown>> : [];
      return {
        ...(existing.length > 0 ? { lineage_id: `（歸入既有的就填 existing_lineages 裡的 lineage_id，例：${asText(existing[0].lineage_id)}；建新的就刪掉這一欄、改用 new_lineage）` } : {}),
        new_lineage: {
          title: "（這件事的名稱，4～60 字，中性、照事實）",
          summary: "（一兩句話講這件事是什麼，200 字內；可刪）",
          category: asText(t.category) ?? "（19 類之一）",
          level: asText(t.level) ?? "（national／county／township）",
          ...(t.region ? { region: asText(t.region) } : {}),
          ...(t.sub_region ? { sub_region: asText(t.sub_region) } : {}),
        },
        policy_ids: ["（同一件事的政見 id，從 target.policies 抄）"],
        note: "（憑什麼判定是同一件事：政見原文裡共同的名稱、地點、金額或文件）",
      };
    }
    case "lineage_participants":
      return {
        lineage_id: asText(t.lineage_id) ?? "（脈絡 id）",
        participants: (Array.isArray(t.people) && t.people.length > 0 ? t.people as Array<Record<string, unknown>> : [{}]).map((person) => ({
          politician_id: asText(person.politician_id) ?? "（人物 id）",
          role: "（proposer／co_proposer／cosigner／advocate）",
          basis: "official_record",
          source_locator: "（議案編號、關係文書頁碼或會議日期與案由）",
        })),
      };
    case "lineage_handover":
      return {
        lineage_id: asText(t.lineage_id) ?? "（脈絡 id）",
        from_politician_id: asText(t.from_politician_id) ?? "（前一任的人物 id）",
        ...(t.from_election_id !== undefined && t.from_election_id !== null ? { from_election_id: t.from_election_id } : {}),
        to_politician_id: asText(t.to_politician_id) ?? "（下一任的人物 id）",
        ...(t.to_election_id !== undefined && t.to_election_id !== null ? { to_election_id: t.to_election_id } : {}),
        handover_type: "（keep／pivot／shrink／stop／resume）",
        decided_on: "（YYYY-MM-DD；不知道就刪掉這一欄）",
        note: "（20～500 字：依據哪份文件、文件怎麼說）",
        source_locator: "（依據在出處的哪裡）",
      };
    case "lineage_link": {
      const uppers = Array.isArray(t.upper_candidates) ? t.upper_candidates as Array<Record<string, unknown>> : [];
      return {
        upper_lineage_id: uppers.length === 1 ? asText(uppers[0].lineage_id) : "（上一級那條的 lineage_id，從 target.upper_candidates 抄）",
        lower_lineage_id: asText(t.lineage_id) ?? "（下一級那條的 lineage_id）",
        link_type: "（top_down／bottom_up）",
        note: "（20～500 字：哪一份法規、補助核定或執行計畫把兩件事連起來）",
        source_locator: "（條文、公文字號或頁碼）",
      };
    }
    case "policy_progress":
      return {
        policy_id: t.policy_id ?? rowId ?? "（政見 id）",
        status: "（In Progress／Achieved／Stalled／Failed）",
        progress: "（進度說明）",
        date: "（YYYY-MM-DD）",
      };
    default:
      return null;
  }
}

/**
 * 整個 POST /report 的骨架——包含信封，不只是信裡的內容（2026-09-21 實測）。
 *
 * 第一版只給 payload 那一層，結果三筆照骨架填完全部被同一個 400 擋下：
 * `source_urls 必填，至少一個可打開的來源網址`。它是**頂層**欄位，而骨架沒提過它；
 * 有一種的 payload_shape 散文裡提了一句，代理就猜成 payload.source_urls，位置還是錯的。
 * 跑任務的伙伴做了對照實驗：同樣的內容、只把 source_urls 移到頂層，三筆全部 201。
 *
 * 教訓是「給了內容卻沒給信封」。所以這裡回整個 request body，代理填空就能送。
 */
/**
 * 「查不到東西」那一條路的骨架（2026-09-21 實測發現的阻塞）。
 *
 * 現場：代理真的查不到賴明源的政見——議會官網只有學經歷、中選會名冊只證明他有登記、
 * 換了五家媒體都只有「參選名單一員」。任務教它走 no_change、no_change_outcomes 也把
 * 三個值講得很清楚，**但骨架只示範了 contribute 那一條**，它只能猜，猜成
 * `{"kind":"no_change"}` → 400。
 *
 * no_change 是 contribution_type 不是 kind，而這件事沒有任何一個任務欄位講過。
 * 結果是：查得到的情況骨架夠用，**查不到的情況卡死在回報這一步**——
 * 而「查不到」正是我們最希望它敢回報的結果（協議說那是一種成果）。
 */
export function buildNoChangeTemplate(taskId: string | null | undefined): Record<string, unknown> {
  return {
    kind: "contribute",
    agent_name: "（你的代號）",
    agent_tool: "（你是什麼 AI）",
    contribution_type: "no_change",
    payload: {
      task_id: taskId ?? "（這筆任務的 task_id）",
      outcome: "confirmed｜unreachable｜not_found",
      finding: "（你查了什麼、查到什麼、為什麼沒有可提交的）",
      checked_urls: ["（你實際打開過的網址）"],
    },
    source_urls: ["（你實際打開過的網址；跟 checked_urls 放一樣的就好）"],
  };
}

export function buildReportTemplate(
  taskType: string,
  contributionType: string,
  target: Record<string, unknown> | null | undefined,
  taskId: string | null | undefined,
): Record<string, unknown> | null {
  const payload = buildPayload(taskType, contributionType, target, taskId);
  if (!payload) return null;
  return {
    kind: "contribute",
    agent_name: "（你的代號）",
    agent_tool: "（你是什麼 AI，例如 claude-code/claude-sonnet-5）",
    contribution_type: contributionType,
    ...(taskId ? { task_id: taskId } : {}),
    payload,
    // 頂層，不是 payload 裡面。這一欄就是第一版最常被擋下的原因。
    source_urls: ["（你實際打開過、而且證明得了這筆的網址）"],
  };
}

/**
 * 多分支任務：這一種任務可能以哪幾種貢獻型別收尾。
 *
 * 2026-09-21 實測回報：每一筆任務只帶「預設分支」那一份骨架，但實跑三筆裡有兩筆的
 * 正確分支剛好不是預設的——legacy_audit 給了 no_change 的骨架、正確是 correction；
 * not_running_recheck 給了 correction 的骨架、正確是 no_change。代理得回頭翻
 * payload_shape 才知道怎麼送，而整個改動的目的就是讓它不必回頭翻。
 *
 * 所以這幾種任務要把每一條路的骨架都送出去，而不是只送最常見的那一條。
 */
export const TASK_BRANCHES: Record<string, string[]> = {
  legacy_audit: ["no_change", "correction", "removal"],
  not_running_recheck: ["correction", "no_change"],
  candidate_status_stale: ["correction", "no_change"],
  policy_validity: ["removal", "correction", "no_change"],
  duplicate_policy: ["removal", "correction", "no_change"],
  roster_check: ["roster_check", "candidacy"],
  progress_stale: ["policy_progress", "candidacy", "removal", "no_change"],
  policy_election_missing: ["correction", "no_change"],
  policy_election_mismatch: ["correction", "no_change"],
  news_sweep: ["policy", "policy_progress", "no_change"],
  audit: ["correction", "policy_progress", "no_change"],
  placeholder_politician: ["removal", "no_change"],
  party_info_missing: ["party_info", "no_change"],
  // 參選紀錄疑似掛錯人（2026-10-06）：不是同一人就改掛，是同一人就 no_change confirmed
  candidacy_owner_mismatch: ["reassign_candidacy", "no_change"],
};

/** 這一種任務所有可能的回報骨架，key 是貢獻型別。單分支的回 null（用 report_template 就好）。 */
export function buildBranchTemplates(
  taskType: string,
  target: Record<string, unknown> | null | undefined,
  taskId: string | null | undefined,
): Record<string, Record<string, unknown>> | null {
  const branches = TASK_BRANCHES[taskType];
  if (!branches || branches.length < 2) return null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const ctype of branches) {
    const tpl = ctype === "no_change" ? buildNoChangeTemplate(taskId) : buildReportTemplate(taskType, ctype, target, taskId);
    if (tpl) out[ctype] = tpl;
  }
  return Object.keys(out).length > 1 ? out : null;
}
