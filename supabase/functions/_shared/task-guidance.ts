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

export const TASK_GUIDANCE: Record<string, string> = {
  policy_missing:
    "找這個人**有出處的具體政見，最多 5 筆**：每筆一個 policy、各附自己的出處。找到幾筆交幾筆，只找到 1 筆就交 1 筆——**不要為了湊數交口號、願景或個人表態**。先看 queued_policies，別人交了還在等票的不要再交。" +
    "**一則報導裡的「N 大政見」「N 箭」「N 夠力」怎麼記**：以「能不能各自查核」為準。每一項有自己的標的（哪家醫院、哪條路線、多少錢、給誰）就拆成 N 筆，各自獨立追蹤進度，同一個 source_url 重複用沒關係；只是形容詞或無法單獨查核的子項（「行政加速」「專業務實」「整合資源」）併回母筆的 description，不要單獨成筆。拆出來超過 5 筆時先交最具體的 5 筆。" +
    "2026 選舉的政見優先；只找得到現任任期或過去選舉的承諾也可以提交，election_id 填該政見所屬的選舉並在 note 說明。",

  profile_gap:
    "用一筆 politician 一次補齊，查不到的欄位不要填。" +
    "**照片要是人像照**：正方形或直式、短邊至少 120px。橫幅、活動看板、新聞情境照會被系統量尺寸擋下——官網的「縣長簡介」大圖常常是橫幅，請點開圖確認，或優先用維基百科、議會官網的個人照。",

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
    "是政見才往下做，而且依狀態問兩種不同的事：施政中的問「近期進度如何」；已投票屆別的競選承諾問「這個人當選了嗎、承諾後來兌現了嗎」——elections 裡有他的參選紀錄與 election_result。當選就用 policy_progress 把 status 改成 In Progress／Achieved／Stalled／Failed；落選、或我們根本沒有他那場選舉的參選紀錄，就用 candidacy 補 election_result。真的查不到後續就 no_change 並說明你查了哪些來源。",

  candidacy_source_missing:
    "**官方登記名冊在 <https://web.cec.gov.tw/central/article/64709>**（每一屆都會有）：那頁掛著各級選舉的候選人登記彙總表 PDF，逐列寫著選區、登記日期、姓名、政黨。下載後用 `pdftotext -enc UTF-8 -layout` 解析——**`-enc UTF-8` 不加會整段變空白**（CID 字型）。這比媒體整理的名單可靠，是唯一的官方名冊。" +
    "這筆參選紀錄沒有網址來源。找該縣市選委會的公告或媒體報導，用 candidacy 補上；查不到就 no_change 說明你找過哪裡。",

  election_result_missing:
    "這個人名下有政見，我們卻沒有他那場已投票選舉的結果。到中選會查該選區結果，用 candidacy 補 election_result＝elected／not_elected，查得到就一起補得票數與得票率。" +
    "**這筆是承諾追蹤的前提**——不知道有沒有當選，就沒辦法問承諾兌現了沒有。查不到官方結果不要猜，用 no_change。",

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
    "**source_urls 放新聞原文網址**——RSS 裡 <link> 的值，不是 RSS 本身。看完沒有可提交的就用 no_change 並寫你看了幾筆。",

  fix_disputed:
    "有人的貢獻被兩票反對擋下來了，任務敘述帶著每一條反對理由。請提一筆**改好的新貢獻**，不要只重送原本那一欄——反對意見指出的連帶問題要一起修掉。",

  not_running_recheck:
    "**官方登記名冊在 <https://web.cec.gov.tw/central/article/64709>**（每一屆都會有）：那頁掛著各級選舉的候選人登記彙總表 PDF，逐列寫著選區、登記日期、姓名、政黨。下載後用 `pdftotext -enc UTF-8 -layout` 解析——**`-enc UTF-8` 不加會整段變空白**（CID 字型）。這比媒體整理的名單可靠，是唯一的官方名冊。" +
    "這一列被標成「不參選」，但沒有人對過官方登記名單——多半是早期匯入時就這樣寫的。"
    + "**這個標記的代價很大**：標成不參選之後，這個人的政見、基本資料、參選來源、選舉結果四種缺口都不會再被派給任何人。"
    + "請打開該縣市選舉委員會的登記公告（或媒體整理的完整登記名單）核對："
    + "**他在名單上** → correction 把 candidate_status 改成 registered，附那份名單；"
    + "**確實不在名單上** → no_change 且 outcome=confirmed，checked_urls 放你核對的那份名單；"
    + "**找不到該縣市的名單** → no_change 且 outcome 填 unreachable 或 not_found，不會蓋章。"
    + "`source_note` 是匯入來歷，**不要拿它當證據**——實測很多寫著「可能再次挑戰」卻被標成不參選。",

  audit:
    "訪客在政見頁貼了一個文件網址。打開它，核對內容與我們既有的相關政見／進度是否一致：不一致就提 correction 或 policy_progress，一致就提 no_change 回報無異動。",
};

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
    `status（${POLICY_STATUSES.join("／")}）、election_id（選舉年份）、politician_id 或 name。source_urls 放證明這筆政見的網址。`,
  // education_level 是固定值域（生產資料的實際分布），不是自由文字——
  // 實測回報代理只能猜（2026-09-21）
  politician:
    "payload：name，加上你查到的 birth_year（西元四位數）／current_position／" +
    "avatar_url（人像照，正方或直式、短邊 ≥120px）／" +
    `education_level（要是這幾個之一：${["高中(職)以下","高中(職)","專科","大學","碩士","博士","其他"].join("／")}）／bio。` +
    "查不到的欄位不要填。",
  candidacy:
    "payload：politician_id 或 name、election_id（選舉年份）、election_type、region、candidate_status。已投票的屆別可加 election_result、votes_received、vote_percentage、cand_no、position。",
  policy_progress:
    "payload：policy_id、status、progress（進度說明）、date、note。",
  correction:
    "payload：target_table、target_id、changes[]（每項 {field, current_value, correct_value}）、reason。",
  removal:
    "payload：target_table、target_id、reason（說明為什麼整筆不該存在）。",
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
  task_suggestion:
    "payload：title、description、task_type、region，可帶 target_politician_id／target_policy_id／hint_sources。",
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
  const rowTarget = asText(table === "policies" ? t.policy_id : t.politician_election_id) ?? asText(rowId);
  switch (contributionType) {
    case "correction":
      if (!table) return null;
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
        reason: "（為什麼整筆不該存在）",
      };
    case "no_change":
      return {
        task_id: taskId ?? "（這筆任務的 task_id）",
        outcome: "confirmed｜unreachable｜not_found",
        finding: "（你查了什麼、查到什麼）",
        checked_urls: ["（你實際打開過的網址）"],
      };
    case "candidacy":
      return {
        politician_id: t.politician_id ?? "（人物 id）",
        election_id: t.election_id ?? "（選舉年份）",
        election_type: t.election_type ?? "（選舉類型）",
        region: t.region ?? "（縣市）",
        candidate_status: "（confirmed／registered／qualified／withdrawn／not_running 之一）",
      };
    case "policy":
      return {
        politician_id: t.politician_id ?? "（人物 id）",
        election_id: t.election_id ?? "（政見所屬的選舉年份）",
        title: "（4–200 字）",
        description: "（≥20 字）",
        category: "（19 種之一，見 payload_shape）",
        status: "（Campaign Pledge／Proposed／…）",
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
