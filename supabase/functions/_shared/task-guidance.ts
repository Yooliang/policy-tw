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
import { POLICY_STATUSES } from "./contribution-schema.ts";

export const TASK_GUIDANCE: Record<string, string> = {
  policy_missing:
    "找這個人**有出處的具體政見，最多 5 筆**：每筆一個 policy、各附自己的出處。找到幾筆交幾筆，只找到 1 筆就交 1 筆——**不要為了湊數交口號、願景或個人表態**。先看 queued_policies，別人交了還在等票的不要再交。" +
    "**一則報導裡的「N 大政見」「N 箭」「N 夠力」怎麼記**：以「能不能各自查核」為準。每一項有自己的標的（哪家醫院、哪條路線、多少錢、給誰）就拆成 N 筆，各自獨立追蹤進度，同一個 source_url 重複用沒關係；只是形容詞或無法單獨查核的子項（「行政加速」「專業務實」「整合資源」）併回母筆的 description，不要單獨成筆。拆出來超過 5 筆時先交最具體的 5 筆。" +
    "2026 選舉的政見優先；只找得到現任任期或過去選舉的承諾也可以提交，election_id 填該政見所屬的選舉並在 note 說明。",

  profile_gap:
    "用一筆 politician 一次補齊，查不到的欄位不要填。" +
    "**照片要是人像照**：正方形或直式、短邊至少 120px。橫幅、活動看板、新聞情境照會被系統量尺寸擋下——官網的「縣長簡介」大圖常常是橫幅，請點開圖確認，或優先用維基百科、議會官網的個人照。",

  candidate_status_stale:
    "登記截止後還標著「傳聞參選」「可能參選」的，只有兩種可能：**在登記名單上** → correction 把 candidate_status 改成 registered；**不在名單上** → 改成 not_running。兩者都要附得出你查的那份名單（該縣市選委會的登記公告，或媒體整理的完整登記名單）。" +
    "**查不到該縣市的名單就用 no_change 回報，不要用猜的把人留在「傳聞」。**",

  policy_validity:
    "**先問這一筆是不是政見。** 先看有沒有 source_url：有就打開它查證；**沒有的話（系統掃到的多半是這種）自己去找原始出處**。然後三條路選一條：整筆不該存在 → removal；分類或狀態標錯、或是政見但缺出處 → correction（缺出處就補 policies.source_url）；有出處而且是有效的承諾 → no_change 並在 note 說明你查到什麼。" +
    "**沒有出處的政見不要回 no_change**——那樣出處永遠是空的，過一陣子又會再派一次。",

  policy_source_missing:
    "這筆政見沒有出處。去找原始報導或官方公告，用 correction 補 policies.source_url。找不到就 no_change 並寫你找過哪裡——不要拿主題相近的頁面充數。",

  progress_stale:
    "**第一步先判斷它是不是政見**：標語、團隊組成、行程、個人表態不是政見，追不出進度也不該追，那種用 removal 回報，不要為它補欄位。" +
    "是政見才往下做，而且依狀態問兩種不同的事：施政中的問「近期進度如何」；已投票屆別的競選承諾問「這個人當選了嗎、承諾後來兌現了嗎」——elections 裡有他的參選紀錄與 election_result。當選就用 policy_progress 把 status 改成 In Progress／Achieved／Stalled／Failed；落選、或我們根本沒有他那場選舉的參選紀錄，就用 candidacy 補 election_result。真的查不到後續就 no_change 並說明你查了哪些來源。",

  candidacy_source_missing:
    "這筆參選紀錄沒有網址來源。找該縣市選委會的公告或媒體報導，用 candidacy 補上；查不到就 no_change 說明你找過哪裡。",

  election_result_missing:
    "這個人名下有政見，我們卻沒有他那場已投票選舉的結果。到中選會查該選區結果，用 candidacy 補 election_result＝elected／not_elected，查得到就一起補得票數與得票率。" +
    "**這筆是承諾追蹤的前提**——不知道有沒有當選，就沒辦法問承諾兌現了沒有。查不到官方結果不要猜，用 no_change。",

  policy_election_missing:
    "這筆政見沒標所屬屆別，網站上顯示「未標註屆別」。打開 source_url 確認是哪一場選舉的承諾，用 correction 把 policies.election_id 改成該年份。" +
    "**同一個人可能多屆都選過，來源沒寫清楚就不要猜**，用 no_change 回報。",

  policy_election_mismatch:
    "這筆政見標的屆別跟提出日期對不上——提出日期晚於那場選舉的投票日。打開來源確認是哪一屆，用 correction 改 election_id；是日期填錯就改 proposed_date；分不出來用 no_change。",

  news_sweep:
    "打開 RSS 網址，挑出提到 2026 候選人具體政見、或既有政見有新進度的報導，每筆用 policy／policy_progress 提交。" +
    "**source_urls 放新聞原文網址**——RSS 裡 <link> 的值，不是 RSS 本身。看完沒有可提交的就用 no_change 並寫你看了幾筆。",

  fix_disputed:
    "有人的貢獻被兩票反對擋下來了，任務敘述帶著每一條反對理由。請提一筆**改好的新貢獻**，不要只重送原本那一欄——反對意見指出的連帶問題要一起修掉。",

  audit:
    "訪客在政見頁貼了一個文件網址。打開它，核對內容與我們既有的相關政見／進度是否一致：不一致就提 correction 或 policy_progress，一致就提 no_change 回報無異動。",
};

/** 這些型別的 hint 依當筆資料而變，由 shapeTaskCurrent 自己組（不走這張靜態表）。 */
export const DYNAMIC_GUIDANCE_TYPES = [
  "legacy_audit",
  "duplicate_policy",
  "duplicate_politician",
  "not_running_recheck",
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
  politician:
    "payload：name，加上你查到的 birth_year／current_position／avatar_url（人像照，正方或直式、短邊 ≥120px）／education_level／bio。查不到的欄位不要填。",
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
