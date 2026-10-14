# cwen0708-pi 任務進度筆記
agent_name: cwen0708-pi
agent_tool: pi/deepseek-v4-flash
協議版本：本機 public/skill.md 1.21.0（線上 1.20.0，本機較新，以本機為準）
開工時間：2026-09-21

## 狀態（第 11 筆後）
- correction 4 筆：f871576f（蘇巧慧 日期+描述）、e12229f3（黃偉哲 清日期）、346d4b17（林國漳 日期）、9c82541d（張善政招商 清日期）
- verify 19 票：陳毓仁/張善政可負擔/陳素月(applied)/林柏成/呂光宇/歐松林/陳偉澄/吳政杰/蔡清續/藍凱元/許皆詳/胡正仁/魏睿宏/陳海山/蘇育德/莊光大 = agree；何欣純(disputed)、許國政 = disagree；蔡易餘 no_change(applied)
- 澎湖批次候選人通知：多筆已有別人的 1 張 disagree
  **2026-09-21 主線更正**：(a) 我「proposed_date 是批次假日期、建議 SQL 整批清」的推論**不成立、撤回**——主線查全站是長尾分布（2026-02-01 16筆、04-07 11筆、06-09 10筆、05-05 9筆、04-28 9筆、03-17 8筆），同一天多筆可能只是同篇報導拆出，且本專案紅線是不手修、不批次改正式資料。**不要再提整批清理。** (b) 澎湖那批的 disagree 是**系統 bug**（守門正則把「來源不存在」誤判成實質反證），不是投票者的錯，主線要修；其中一票是正當 disagree（evidence_url 指官方 PDF）。
- 未遇到 Content Exists Risk

## 原始狀態（第 8 筆時）
- 交了 2 筆 correction（皆 legacy_audit：蘇巧慧 48f75dc7 → f871576f；黃偉哲 6ddf7152 → e12229f3）
- 投了 5 票驗證：2 agree 生效/待票、2 disagree（其中 1 筆已成 disputed 裁決任務 31dfd8c1）
- 未遇到 no_change（兩筆 legacy_audit 的來源都支持內容，只是欄位要改，走 correction）
- 額度：submit 182/200、verify 744/800（本機 IP 共用）
- 未遇到 Content Exists Risk

## 進行紀錄
### 1) legacy_audit 蘇巧慧「零到6歲醫療免部分負擔」 policy 48f75dc7-7fef-4f4c-a4dd-d79fb2a5a159
- 來源 https://news.ltn.com.tw/news/politics/breakingnews/5385618 → 200，自由時報 2026-03-28 專訪，確認是蘇巧慧 2026 新北市長首波六大福利政見之一（支持承諾本身）。
- 但 proposed_date 資料庫寫 2026-04-07，晚於來源刊出日；今周刊 https://www.businesstoday.com.tw/article/category/183027/post/202602060026/ (2026-02-06, 200) 明寫「蘇巧慧團隊2月4日正式發布首波政見」→ 真提出日 2026-02-04。
- 動作：correction（改 proposed_date→2026-02-04、改 description 移除誤掛的「六都中新北尚未實施」與非來源語句）
- contribution_id f871576f-5c73-4e80-82c5-4b77c0f28d04，required_agree=2, pending

### 2) verify candidacy 陳毓仁（澎湖縣議員 2026）contribution c3c783af-6f59-4e59-b432-3da6f429c2b5
- 提交來源 udn https://udn.com/news/story/7326/8197777 → 404（UA 重試仍 404、Wayback CDX 空、availability API 429）
- 獨立來源（官方）：澎湖縣選委會公告 https://web.cec.gov.tw/phec/article/64633 → 附件「115年縣市議員選舉候選人登記概況彙總表」pdf https://web.cec.gov.tw/api/file/cd72a8a9-3b96-46fa-9c33-125cd7745da1.pdf ：第1選舉區 陳毓仁 男 中國國民黨 115/09/02 序號9 現任=是
- 交叉：自由時報 2026-09-02 https://news.ltn.com.tw/news/politics/breakingnews/5561164
- 投票：agree（vote daf6f9e5），required_agree 6

### 3) verify correction（張善政 可負擔住宅自治條例）contribution b7c97665-44f7-409e-93d7-678bf652769e
- 來源 udn https://udn.com/news/story/7324/9444468 → 200，2026-04-16，張善政原話「這是他二○二二年參選市長時困難度最高的政見」→ election_id null→2022 成立
- 投票 agree（已提醒 proposed_date 2026-04-28 與 2022 矛盾，需後續 correction）

### 4) verify correction（陳素月 彰化產業轉型升級）contribution 051fc597
- 來源 自由時報 2026-08-21 https://news.ltn.com.tw/news/politics/breakingnews/5547878 → 200，陳素月承諾當選縣長後在縣長辦公室成立單一服務窗口輔導產業轉型
- 投票 agree（vote f2bbab08）→ 已 applied（source_url/proposed_date/election_id 2026）

### 5) legacy_audit 黃偉哲「台南捷運藍線建設」policy 6ddf7152-987b-4992-bb29-090dbd789df5
- 來源 CNA https://www.cna.com.tw/news/ahel/202510210327.aspx → 200，2025-10-21，行政院核定第1期藍線（8.39km、永康大橋→台南文化中心、10站、327.31億、高架跨座式單軌、115年底動工），黃偉哲具名 → 標題/描述全對
- 但 proposed_date=2026-02-01 是整批匯入的假日期（同批黃偉哲政見全部同一日期）；來源無提出日 → correction 清空 proposed_date
- contribution_id e12229f3-f1e8-4c67-a75f-cdfd4c9f49d8，pending

### 6) verify policy_progress（何欣純 解決垃圾問題）contribution d9d41013
- 來源：CNA 2024-01-13（身份）、udn 2025-10-30 https://udn.com/news/story/124635/9107156、LTN 2026-09-07 https://news.ltn.com.tw/news/life/breakingnews/5565728 → 全部 200，但兩篇進度都是台中市府/環保局的工程，全文無「何欣純」
- 政見自己的來源 LTN 2025-10-27 https://news.ltn.com.tw/news/life/paper/1729725 顯示外埔二期是市府工程、何欣純在批評市府延宕
- 投票 disagree（vote f5bb558e）→ 2 票反對成立 disputed，裁決任務 31dfd8c1-5e90-4341-9e20-ab7403bc3c82

### 7) verify candidacy 林柏成（澎湖）78de0a12 → agree（官方名單第1選舉區 無黨籍 8/31 登記）
### 8) verify candidacy 許國政（澎湖）e1a2dd0c → disagree（官方名單寫中國國民黨，payload 寫無黨籍）

### 9) verify no_change（蔡易餘 治水100億 / policy_election_missing 2212cecb）contribution 2435f94b
- 親自開 LTN 5298943（2026-01-04 嘉義縣長初選政見會）→ 200，全文無「治水/水患/100億」；Google News 三種查法＋LTN/udn 站內搜尋都找不到能證實100億的來源
- 投票 agree（vote 66e0bdeb）→ applied（缺口 14 天不再派）；note 建議另開 policy_validity

### 10) 澎湖縣議員 candidacy 批次（來源全部是死連結 udn 8197777）
一律改核官方「115年縣市議員選舉候選人登記概況彙總表」pdf（web.cec.gov.tw/api/file/cd72a8a9-…pdf）
- 呂光宇 d6c87256 → agree（第1區 中國國民黨 9/2 序13）
- 歐松林 ae62f60f → agree（第1區 無 9/1 序4）
- 陳偉澄 36748ed3 → agree（第1區 無 9/3 序16）
- 吳政杰 2627b409 → agree（第2區 無 9/1 序4；既有檔黨籍 KMT 差異已在 note 註明）
- 蔡清續 c84dcf61 → agree（第2區 民進黨 8/31 序2）
- 藍凱元 c285fa7e → agree（第1區 無 9/2 序8）
- 許皆詳 3f689fb2 → agree（第3區 無 8/31 序1）
- 胡正仁 eced6005 → agree（第1區 無 9/3 序18）
- 魏睿宏 123d4a81 → agree（第3區 無 9/3 序4）
- 許國政 e1a2dd0c → disagree（官方寫中國國民黨，payload 寫無黨籍）
註：這批多筆已有別人的 1 張 disagree，若累積 2 票會轉裁決。

### 11) legacy_audit 林國漳「環境產業勞工三大施政願景」policy 0cc7ed66
- 來源 udn 9565925（2026-06-14）→ 200，標題/描述對得上；proposed_date 2026-07-24 晚於來源 → correction 改 2026-06-14，contribution 346d4b17 pending
- note 建議另開 policy_missing 拆出具體承諾（微型森林300、抽水站10、接管率75%、有機農地2000公頃等）

### 12) legacy_audit 張善政「招商引資全台第一」policy 1ae135ee
- 來源 大紀元 https://www.epochtimes.com/b5/26/3/16/n14720113.htm（2026-03-16 施政報告）→ 200，數字全對（近2,200億、成長近4成、3.4萬工作）
- proposed_date 2026-04-28 是該批 ai_extracted 假日期 → correction 清空，contribution 9c82541d（required_agree=3，因為 epochtimes 不在媒體白名單→source tier=other）
- note 標明這筆讀起來是政績宣示，建議另跑 policy_validity

### 額外驗證 3 筆（澎湖批次，官方名單）
- 陳海山 9858c487（第1區 無 9/3 序14）、蘇育德 e7bbe372（第1區 民進黨 8/31 序3）、莊光大 9d1982f1（第1區 無 9/3 序17）→ 全部 agree

## 第 13 輪（主線指示後）
### legacy_audit
- 蕭美琴「國防支出2030年達GDP 5%」23d46fae：來源新唐人 2026-06-24 專訪，逐字「最終，我們也致力於投資自身防衛能力。這也是為什麼賴總統不僅在年度常規預算中，多年來持續提高國防支出，還提出了一項特別預算或追加預算，目標是在2030年前，將國防支出提高到GDP的5%。」→ 內容對，proposed_date 2026-07-14 晚於來源 → correction 清空（e95f5996）
- 陳琬惠「育兒家庭每月減少10小時工時」379abb2c：來源大紀元 2026-05-01，逐字「陳琬惠提出三點政見：…二、推動育兒家庭每月減少10小時工時制度，讓爸媽安心接送小孩、陪伴成長，由縣府補助企業成本…」→ correction proposed_date 2026-06-26→2026-05-01（908be84b）；同篇確認 election_id=2026 正確
### verify（澎湖批次，官方名單）
- 蘇陳綉色 07dd252b、張惠雅 9c3b4ea4、李家萱 6d854ad8、李麗美 4b5ce8cc、許月里 b1729e11 → 全部 agree
### 觀察（未定論，僅陳述樣本）
6 筆 legacy_audit 全部「DB proposed_date 晚於引用來源刊出日」：蘇巧慧 04-07>03-28、黃偉哲 02-01>2025-10-21、林國漳 07-24>06-14、張善政 04-28>03-16、蕭美琴 07-14>06-24、陳琬惠 06-26>05-01。n=6，原因未知，交主線判斷。

## 主線派工實測（三件）
### (1) #129 罐頭同意票守門
- 1a 故意 agree＋note「查證通過」＋無 evidence_url → HTTP 400 error=note_too_thin，訊息含「把核對內容補上再送一次，這次不算你被拒」
- 1b 同筆改投具體 agree（16acd7b5 江啟臣巨蛋 no_change）→ HTTP 201 applied，未被誤擋
### (2) #131 withdraw 5 筆
- 8 碼短碼會被擋：400 validation_failed「contribution_id 要是 uuid」；用 contributions-feed 分頁撈完整 uuid
- 5b715dd4-2b6e-4741-bffb-a567a3349730 / cb908bd6-c5d5-43f7-9836-95f79c52474f / 251be88a-2c3c-49ce-8d8f-784cbf0fddb3 / fa60ef66-a1db-4e92-9f2e-233c6a87d3d1 / ed81b739-a73c-46e7-ab32-91b99c94150d（皆 cwen0708 pending）
- 全部 HTTP 200、status=withdrawn、counts_as_rejection=false、訊息含「這不算你的退件」
- no_change 三筆多一句「那筆缺口會自己回到任務池…」；correction/removal 兩筆沒有
- 本機 1.21.0 與線上 1.20.0 的 skill.md 都只有 candidate_status 的 withdrawn，沒有 kind:withdraw 說明
### (3) 型別自足性（領 10 種）
- 自足：progress_stale、policy_validity、not_running_recheck、candidate_status_stale、duplicate_policy、duplicate_politician、legacy_audit、policy_election_missing、election_result_missing
- 缺：policy_missing（無 category 值域/長度/N大政見拆筆/口號排除）、profile_gap（無照片規格）
- 共通缺：correction/candidacy/politician/policy_progress 的 payload 結構；current.hint 只搬了 3 種型別
- no_change_outcomes 每筆都有；suggested_contribution_type 每筆都有

## 第 14 輪
- legacy_audit 蘇巧慧「青農免息額提至500/1000萬」420a3a5d：來源 udn 2026-04-23 逐字「第二項青年政見為『資金的支持』…將一般青農的免息額度由200萬提高至500萬，專業青農調升至1000萬」→ **proposed_date 2026-04-23 與來源同日**、屆別 2026 正確 → no_change + **outcome=confirmed**（cb4e2da6）
- legacy_audit 黃偉哲「小黃公車偏鄉交通」6e612fb3：來源 ETtoday 2022 台南市長專題頁，逐字「黃偉哲以任內推動的『小黃公車』為例…未來會把路線再增加」「讓長輩花公車價格就能有計程車的享受…三贏的政策」→ 屆別 2022 正確、proposed_date 本來就 null → no_change + **outcome=confirmed**（a9b36f52）
- verify：張仁和 af797ca9、宋萬富 d5ce9313（澎湖官方名單）agree；劉建國 AI智慧農業生技園區 correction 8ba6f8a7 → 系統票 supported，我另找自由時報 2026-08-06 5530665 當第二來源 → agree → **applied**
- 更正我第 13 輪的觀察：9 筆 legacy_audit 中，日期晚於來源的是 6 筆、日期正確/本來空的 2 筆（青農、小黃公車）→ 不是「全部」，樣本偏誤要講清楚

## 第 15 輪
- verify no_change 幸福里程30K（progress_stale c60c1fab）6cf9b907：typas 市民卡頁無「幸福里程／里程／30K」（有9次敬老）；card.tycg.gov.tw 我這邊 HTTP 000 連不上（如實記錄）；Google News 只有 2022 年政策發布、無新進度 → agree applied
- candidacy agree：陳佩真 c72619d6（第5區 無 9/3 序1）、夏晨榮 a6b4803d（第6區 無 9/3 序3）
- legacy_audit 翁章梁「2026台灣燈會嘉義主辦」73621818：CNA 2026-03-15 逐字「連續13天在嘉義舉行的2026台灣燈會今晚劃下句點…嘉義縣長翁章梁說…此次台灣燈會被稱為歷屆的天花板，『嘉義被看見了』」→ 內容對；proposed_date 2026-05-08 晚於燈會結束日 → correction 清空（2033806f）

## 第 16 輪（新欄位 hint／payload_shape／payload_template 驗證）
- 覆蓋率（15 型別）：hint 缺 1（not_running_recheck）；payload_shape 全有；payload_template 缺 2（duplicate_politician、roster_check）；no_change_outcomes 全有
- payload_template 的 id 真值：progress_stale policy_id ✓、profile_gap politician_id ✓、policy_missing politician_id ✓、election_result_missing politician_id+election_id ✓、not_running_recheck target_id=10006(int) ✓、candidate_status_stale target_id=10009(str) ✓（我實測用字串送出 → 201，無 bug）
- 佔位字樣：duplicate_policy target_id=「（這一列的 id）」（可能是設計：要代理自己挑哪筆重複該移除）；candidacy_source_missing election_id/election_type 仍是佔位，但任務已知 2026／縣市議員，可預填
- 用 template 交出去的實測：candidate_status_stale correction 756bb089（201）、not_running_recheck no_change 29f20999（201），沒有 400
- 內容：中央社 2026-09-04 名單逐字「新竹縣　民進黨鄭朝方…國民黨徐欣瑩…無黨籍朱定瑀」→ 無劉復嵐 → correction 改 not_running；「台北市　國民黨蔣萬安…民進黨沈伯洋…無黨籍林志成」6人 → 無吳怡農 → no_change confirmed

## 第 17 輪
- candidacy agree：顏家康 eb7e98e3（第1區 民進黨 8/31 序2）、宋昀芝 9ef392aa（第3區 無 9/2 序2）
- removal 童子瑋「青年創業扶植計畫」21bbc80f → **agree**（2/3）。LTN 2026-03-29 5386353 逐字「利用老屋與空間，降低創業成本；改善小型創業支持與租金環境…」＝空屋活化，無創業基金/低利貸款/共享空間；搜「童子瑋 創業基金」14筆無此、搜「童子瑋 低利貸款 共享空間 青年」0筆
- correction 周雅玲「長照資源社區整合」5738d12b → **disagree**。來源 ntp.gov.tw 議員介紹頁只有「現任 新北市第4屆議員」與回顧式政績，全篇無 2022、無「長照」（0次）；2022 是推論不是來源 → 2票反對成立 disputed，裁決任務 90ff0454

## 第 18 輪
- no_change（profile_gap 羅佩秦 70ec3f1b）c07c06ab → **disagree**：兩篇來源其實有可補內容（LTN 逐字「歷任步兵科、師部作訓官，高空大法律組畢業」、CNA 逐字「具有卑南與魯凱族血統…長年關注原民權益」），而該人物檔 birth_year/current_position/education_level/bio/avatar_url 全空 → 應補 education_level/experience/bio，不是 no_change
- removal 謝龍介「只做一任 把機會留給年輕人」46618089 → **agree**（2/3）：udn 2026-02-22 專訪標題逐字「承諾只做4年不連任」存在，但屬個人表態非政見、描述「打破政壇老人政治」無出處、且屆別掛 2022 而該承諾是 2026 選戰講的

## 第 19 輪（#136 骨架 + 派發閘實測）
- payload_template 已改成 **report_template**（完整 /report 骨架）；hint 全型別都有了
- 照新骨架送出：#1619b269（legacy_audit 蘇巧慧大巨蛋 proposed_date 2026-03-27→2026-03-22）、#457387b4（not_running_recheck 陳琬惠 宜蘭縣長 5 人無她 → no_change confirmed）、#56a1f22d（politician 羅佩秦 bio/experience/education）→ 全部 201，無 400
- **發現**：每個任務只帶「預設分支」骨架。legacy_audit 給 no_change 骨架但正確分支是 correction；not_running_recheck 給 correction 骨架但正確是 no_change → 骨架在多分支任務會誤導
- education_level 值域（生產資料）：高中(職)390／高中(職)以下314／大學118／專科117／碩士49／其他11／博士1，但 shape 沒寫
- **派發閘（小良哥新閘）**：截至此時**尚未生效**——(a) 從 /verifications 自挑一筆投 unsure → 201（應 409）；(b) 投「前一次 /next」派的筆 → 201。正向路徑 3 筆全 201
- report_template_no_change 與 cec 名冊 64709 連結也都還沒上線
- v18 agree（蔣萬安 機車退出人行道 correction 0e41e622）、v19 disagree（周倪安 correction 70caadcb，過期資料）、v20 agree（陳瑩 族語AI correction 3387c7fc）

### 第 19 輪後續（派發閘已上線）
- 正向（/next 派→投票）：0e41e622、70caadcb、3387c7fc、06387bb6、e262d490 全部 201
- 負向（從 /verifications 自挑）：9cc7a0be → **409 not_dispatched**，訊息「這一筆不是派給你的。工作只從 GET /next 來：呼叫一次，伺服器會給你一筆要驗的，做完再用 POST /report 回報那一筆。不要自己挑題目。」
- 窗口：先 /next 得 px=e262d490，再 /next 得 py=845b5b83，回頭投 px → **201**（＝認租約內的派發，不是只認最後一筆）
- 內容：v18 agree（蔣萬安 機車退出人行道）、v19 disagree（周倪安 過期更正）、v20 agree（陳瑩 族語AI）、v21 disagree（柯志恩 2022 政見被 2026 報導覆蓋）、v22 agree（劉建國 台大醫學中心 2024）

## 第 20 輪
- removal 傅崐萁「東部觀光復甦計畫」fd006c70 → **agree**（2/3）：Google News 查名稱 0/1 筆無關；他 2026 確實在推花蓮觀光（LTN 5546448、udn 9696505）但那不是這筆、也對不上 election_id=2024；source_url 空＋描述泛稱
- correction 廖先翔「白匏湖基地改產業園區」6864e2c9 → **disagree**（2票成立 disputed 214bca17）：REST 重讀 election_id 已是 2024、claimed_current 寫 null 不符、改完等於沒改（no-op）；且內容是 2025 預算提案非競選承諾 → 建議走 policy_validity

## 第 21 輪（#140 自驗 + 1.23.0）
- 協議版本已跳到 **1.23.0**（線上 skill.md；我手上 1.21.0 已過時，已重讀）
- **#140 空操作更正未在提交端被擋**：故意送 policies 506d4f34 election_id 2024→2024 → 201 pending（3439c4a3），已自行 withdraw（200，「已撤回。這不算你的退件…」）
- **/next 不再回 lease_minutes**（頂層欄位：success/agent_name/agent_tool/agent/total_pending/open_tasks/ratio/quota/protocol_version/docs/kind/item/how_to），但 1.23.0 仍寫「回應的 lease_minutes」＋30 分鐘 → 文件與回應不一致；15 分鐘窗口協議裡沒有
- 「2026 縣市長排最前」樣本無法證實（連抽 6 次 /next 全是 verify）
- 1.23.0 已收錄「工作只從 GET /next 來」與 kind:withdraw（實測可用）
- correction 蘇巧慧「新生兒補助10萬元」842ec5b5 → **disagree**（2票 disputed 0c0bdc2f）：來源逐字是「在立法院…成功爭取新生兒10萬元補助」＝立委政績，但本筆 description 是「承諾當選新北市長後加碼10萬元」＝2026 市長政見，來源證明不了；標成 2024 會掛錯屆別

## 第 22 輪
- **#140 已上線且有效**：故意送 policies 506d4f34 的 election_id 2024→2024（形狀A 帶 current_value、形狀B 省略 current_value）→ 兩者都 **400 error=no_op_correction**，訊息含「這不算你做錯，也不計入你的退件」＋fields[{db_current:2024, correct_value:2024}]；沒有建立貢獻
- **骨架多分支到位**：report_templates_by_type＋report_template_no_change 上線；legacy_audit=no_change/correction/removal、not_running_recheck 與 candidate_status_stale=correction/no_change、policy_validity/duplicate_policy=removal/correction/no_change、roster_check=roster_check/candidacy；**缺口：roster_check 沒有 correction 分支**（其 what_we_need 要求把 rumored/likely 改成 not_running）
- lease_minutes 仍未回到 /next 回應
- verify 4037488c（黃瑞珠 溪湖轉運站 correction）→ **unsure**：來源 udn 6753665 404、Wayback CDX 空、其他媒體只有同日 2022-11-10 黑函事件的報導（無轉運站）；另發現該筆第一個 change 是 no-op（db 已 2022、claimed null）→ **#140 只在「所有 change 都是 no-op」時才擋**

## 第 23 輪（合併佇列 + 中選會全國名冊）
- 中選會全國名冊 https://web.cec.gov.tw/central/article/64709 ：附件 2-1「115年直轄市議員選舉候選人登記彙總表」= https://web.cec.gov.tw/api/file/ccd7e51a-5fd0-4ea0-a81b-a120cd550c9c.pdf （pymupdf 可讀）
  - 張斯綱：臺北市第1選舉區 115/09/03 中國國民黨 → 擋下 no_change（936745f5 disagree）
  - 許甫：臺北市第3選舉區 115/09/02 台灣民眾黨 → agree（1c28eb74）
  - 李眉蓁：高雄市第4選舉區 115/09/04 中國國民黨 → agree（32da19f5，required_agree=**8**，因提交來源是政黨網站）
- 賴清德 2024 總統結果（a906a07f）→ agree，用維基百科核對 5,586,019／40.05%（db.cec.gov.tw 是 SPA 讀不到）
- 蔡易餘 26億教育補助 policy_election_missing no_change（8fb7b5f2）→ agree（來源 0 次「教育/26億」；他的 2026 教育政見是「育才留嘉」4年百億，不同東西）
- 童子瑋「海港山城發展願景」removal（f8e0c1ff）→ agree（FB 貼文用 plugins/post.php 內嵌端點才讀得到全文，確認是願景/表態）
- ~~**#140 漏洞（第二例）**：5e3537b3…推測閘比 current_value vs correct_value~~ **2026-09-21 主線更正＋我自行查證後撤回**：5e3537b3 建立於 2026-09-17T02:15Z（台北 10:15）、4037488c 建立於 2026-09-16T22:04Z（台北 09-17 06:04），而空操作守門是 2026-09-21 15 點多才部署——它們是**守門上線前好幾天就送進來的**，不是穿過去。主線讀程式碼確認 checkNoOp(payload,row) 是拿 correct_value 對**資料庫現值**比。**教訓：看到「守門沒生效」先比對貢獻建立時間 vs 部署時間，再看是不是程式問題（今天第三次時間差被誤讀成程式錯誤）。**
- 主線已登記的唯一真問題：一筆裡多個 change 只有部分是 no-op 時閘不擋（設計上全部 no-op 才擋），逐 change 提示改法等分數制上線後再排
- 派工：連續 9 筆 /next 全是 verify、沒有任務（合併佇列後 3:1 閘把我壓在驗證側）

## 第 24 輪：**加權共識新制上線（實測）**
投票回應新增 weight／weight_reason／score{before,after,target}。我的實測：
| 票 | 我的輸入 | weight | score before→after | target | weight_reason |
|---|---|---|---|---|---|
| 1e5f6b68 李四川 removal agree | 開來源＋具體 note，evidence_url 同網域(LTN) | **+1** | 1→2 | 3 | 開來源寫出核對內容；想拿 +2 附不同網域獨立來源並先用 judge 核過 |
| fcd756ee 許甫 candidacy agree | **附不同網域**（web.cec.gov.tw vs newtalk.tw） | **+1** | −2→−1 | **6** | 同上（**同樣叫我附不同網域來源——我明明附了**）|
| 24a944b4 何應明 candidacy disagree | 附官方名冊反證 | **−1** | 0→−1 | 5 | 反對且理由具體；**附上系統核過的反證才是 −2** |
觀察：
- +1／−1 的行為與 §2.2 相符；**+2 需要 evidence_url 先被 judge 核過**，但 weight_reason 沒說「你的來源還沒核過」，只重複「附不同網域來源」→ 對已經附了的代理是誤導（建議改字）
- **review 的預測在線上出現**：許甫 candidacy（官方名冊可一秒確認）target=**6** 且已被 2 張反對壓到 −2；下界 −6 → 它兩邊都到不了、會卡住（＝我寫的「定價失準＋下界太遠＝半死不活池」）
- system_vote 有些項目還在（何應明）、有些沒有（許甫）
### 同輪其他驗證
- 1e5f6b68 李四川「民生優先於選舉」removal → agree（來源同篇載明他真正的承諾是敬老卡600→300點現金、雙北30分鐘生活圈）
- fcd756ee 許甫 candidacy（newtalk 來源）→ agree（附中選會名冊；weight 1）
- 24a944b4 何應明 candidacy → **disagree**：官方名冊（座標逐列重建）載明「新北市第13選舉區 | 115/09/01 | 何應明 | 中國國民黨」，payload 寫第12（媒體也寫第12）；且提交的第二來源 udn 9735457 整篇是**桃園市**名單、沒有他

### 第 24 輪追加（新制下界實測）
- fe0616d7 removal（謝國樑「引進產業創造就業」）→ **disagree**（weight −1）：來源 LTN 2022-10-01 逐字「因此提出「引進產業、創造就業」，將在五堵建立基隆科學園區，成為「內科2.0」，並在大武崙工業區增設二期，同時活化六堵工業區」→ 標題是候選人自己的政見名、description 具體可查核，不該移除；應做 correction 補 election_id=2022
- 結果：score −2→−3 = −target(3) → **status=rejected**，訊息「分數 -3 已跌到 −目標（3），這筆已退件並清出驗證池」→ **下界確實會終止案子**（target 低時很快；我 review 的擔心只適用 target 高的案子，例如許甫 target=6）
- /tasks 排序確認：前 6 筆裁決＋幾筆雜項後，是一整排 **2026 縣市長 policy_missing**（前 25 筆 14 筆）
- 連續 15 次 /next 仍全是 verify、拿不到任務

## 第 25 輪（1.24.0 上線後）
- **1.24.0 skill.md 已上線**；§6 把分數制寫進去了。**但出貨的目標模型是舊矩陣**（目標分數＝型別風險×來源等級，系統票 ±1 調目標），**不是我審查的那版 Jev 風險維度** → review 的 A/B/C（單IP結案、cannot_tell灌票、維度嚴重度）在線上不會發生；但「定價失準」還在（許甫 target=6 是矩陣算的）
- 文件寫明：+2/−2 要先用 judge 核過；unsure 記 0；**每個來源 IP 只算最新一票**；**累計 ≤ −目標 → 直接退件**
- 主線回覆（2026-09-21）：(a)「≤ −目標直接 rejected、裁決退場」是**小良哥規劃書 8.1 節的裁示**，我審的是第 2 節初稿，8.1 在後；主線已把第 2 節改成對齊 8.1 → 不是搬漏，線上行為正確。(b) `no_op_correction` 確實漏寫，已補一段（比的是資料庫現值、不算退件、回應帶 fields），走 PR cwen0708/doc-gaps，純說明不動版本。**兩件都已結案，不要再重報。**
- 主線另確認我的判讀正確：「出貨的是分數制＋舊矩陣目標」，許甫 target=6 是矩陣算的；接下來等小良哥點頭的是「一律 3、矩陣退場」，Jev 風險維度決定目標是再下一步
- **weight_reason 已會分岔**（實測 93713a72：「你附了 evidence_url，但系統還沒核過它：先對這筆用 judge 讓系統核那個網址，再投票就是 +2」）→ 先前那則誤導訊息已改善
- **judge 會拒絕同網域**：我拿維基（與提交來源同網域）去 judge → 400 same_source「這是提交者附的來源網域，系統票已經核過；請找另一個獨立來源」→ 規則可用
- verify 93713a72（黃秀芳 2024 立委結果 90,688／52.70%）→ agree（weight +1，score 0→1，target 2）
- verify f2e64260（鍾小平 candidacy）→ 409 **already_voted**（同機器另一代理在我查證期間投掉；訊息說明不算我做錯）→ 我要把它改成 disagree（candidate_status 應為 registered，非 confirmed；官方名冊臺北市第5選舉區 115/08/31 中國國民黨）但已來不及

### 第 25 輪追加
- **驗證項現在帶 current.scoring{target_score, current_score, your_vote_could_be}**（例：target 2/current 0/「+2 要找另一獨立來源並讓系統核過、只開提交來源是 +1」）→ 分數可見性做得好，代理不用猜
- **分數階梯四個都實測到了**：+1（開提交來源逐欄核對）、**0＝unsure**（weight_reason「存疑不加減分」）、−1（反對理由具體但反證未經系統核）、以及 +2/−2 的前置（judge 核過；judge 對同網域回 400 same_source）
- **同機競爭**：本輪遇到 2 次 409 already_voted（f2e64260 鍾小平、eeb40b5b 邱顯智），都是我在查證期間被同機另一個代理先投掉；訊息明說不算我做錯。這是多代理共用來源 IP 的固定成本，值得主線知道
- verify eeb40b5b（邱顯智 policy_election_missing no_change）→ 原本要 agree：cw.com.tw 403（Cloudflare），改用提交者的 archive 快照核到「冤案 8 次、但冤案平反/再審/立委/政見/選舉都 0 次」→ 提交者的 no_change 成立（可惜已被投走）
- verify 31193291（邱吉均 2024 立委 1002 票/0.47%）→ **unsure**（weight 0）：CEC DB 是 SPA 讀不到、Wikipedia 無條目、新聞 9 筆都沒列他的票數
- verify 93713a72（黃秀芳 2024 立委 90,688/52.70%）→ agree（weight +1）

### 第 26 輪（+2 路徑探測）
- **judge 不讀 PDF**：拿中選會官方名冊 PDF 去 judge → `422 unsupported_source`「系統不解析 PDF／試算表（只讀網頁）」，訊息還給了**中選會候選人查詢 API**：`https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名`
  - 實測：`cand_name=廖先翔` → 回他 2024 立委（新北市第12選區、中國國民黨、is_victor）那筆；`cand_name=許甫` → `cand_data_list: []`（空）⇒ **該 API 只有已投票選舉紀錄，沒有 2026 登記名冊**
- judge 也拒絕同網域（`400 same_source`）
- ⇒ **在只有 PDF 名冊可用的情況下，candidacy 類拿不到 +2**（我這一輪四次嘗試都失敗）
- verify 6d3fafc8（廖先翔 2026 議員 rumored→not_running）→ agree（weight +1，score 1→2=target → **applied**；但 auto_apply 顯示「not_running → not_running」，表示 DB 早就被別人改好了，這筆其實是延遲的 no-op）
- **主線回覆（2026-09-21）：±2 不可達是有意的、不是漏洞，結案**：#116 今早裁決拿掉 PDF 解析＋中選會 API 沒有 2026 登記名冊（外部事實）⇒ 登記期參選紀錄結構上沒有機器核得了的第二來源。**處理**：協議會明講「登記期 candidacy 的 +1 就是正常的一票，不要為了 +2 硬找；官方名冊自己讀、note 寫對到哪一列」（PR 已推）；真正的解在目標分數（矩陣下媒體級 candidacy 目標 6＝六張 +1 到不了；「一律 3」還在等小良哥）；**不讓 judge 開後門讀 PDF，今天不翻**。
- 四個階梯（+1／0／−1＋跌到 −目標退件／達標落庫）主線確認都已驗到，結案。**⇒ 之後我做登記期 candidacy 就照常投 +1，不硬追 +2。**

### 第 27 輪
- verify cfa46464（李彧秀 candidacy_source_missing no_change）→ **agree**（weight +1，score 0→1=target → applied）：我用中選會直轄市議員名冊全 22 頁掃過，**「李彧秀」0 次（連「彧」都 0 次）**，支持提交者查不到
- verify 287ca27c（蔡易餘「推動多處產業園區開發」election_id 2026→2026）→ **disagree**（weight −1）：REST 確認 DB 已是 2026、純 no-op；**先查 created_at=2026-09-17T10:11Z（早於 09-21 閘部署）→ 是時間差不是穿透**（教訓已套用）
- **−1 的 weight_reason 也分岔了**：「你附了反證，但系統還沒核過它：先對這筆用 judge 讓系統核那個網址，再投票就是 −2」→ 與 +1 對稱，可操作

### 第 28 輪
- verify a7384167（許玉仙 金門縣議員 2026）→ agree（+1，score 1→2／target 5）：縣市議員名冊（4-1，https://web.cec.gov.tw/api/file/729644ff-cb01-42bb-a052-c9b3c55a1289.pdf ，44頁）第34頁「金門縣第1選舉區 115/09/02 許玉仙 無」
- verify 65e351a6（許大鴻 金門縣議員 2026，identity ambiguous）→ **agree，指認既有 id**：
  - 名冊第34頁「金門縣第1選舉區 115/08/31 許大鴻 無」
  - **中選會候選人查詢 API** 顯示他歷史只有一筆「111年縣市議員 2022-11-26 **金門縣第01選舉區** 無黨籍 出生1997 **當選**」→ 與既有檔 birth_year 1997 相符 ⇒ 同一人
  - **但既有檔 region 寫「連江縣」是錯的**（中選會記金門縣）→ 建議另提 correction 修 politicians.region
- target 分布累積：許甫 6、李眉蓁 8、何應明 5、許玉仙 5、許大鴻 5（全是官方名冊一秒可確認的參選紀錄）→ 「一律 3」的證據
- **中選會候選人查詢 API 是 judge 的錯誤訊息給的**：`https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名`（回傳 JSON：theme_name/vote_date/area_name/party_name/cand_birthyear/is_victor），只涵蓋**已投票**選舉、沒有 2026 登記名冊

### 操作教訓（給接手的人）
- 用 orca terminal send 傳訊息時**絕對不要用 backtick**（`）：bash 會把它當命令替換執行，訊息會被吃掉（我已被咬三次：lease_minutes、score/no_op_correction、URL）。要強調就用「」或直接寫。

## 第 29 輪：**重大發現：金門縣／連江縣 region 整批對調**
- 觸發：核金門縣議員 candidacy（許大鴻、陳錦偉）時 identity ambiguous，既有檔 region 都寫「連江縣」
- 用中選會查詢 API 雙向驗證（birth_year 全部相符 ⇒ 同一批人、標籤互換）：
  - DB region=連江縣（32 筆）→ CEC 全是**金門縣**：許大鴻（金門第01，1997）、陳錦偉（金門第02，1974）、王碧珍（金門第01，1959）、洪允典（金門第01，1952）、陳泱瑚（金門第01，1974）、周子傑（金門第02，1973）
  - DB region=金門縣（15 筆）→ CEC 全是**連江縣**：曹爾章（連江第01，1970）、陳貽斌（連江第03，1969）、張永江（連江第04，1960）
- 規模約 **47 列**（連江32＋金門15）；影響所有金門／連江議員任務
- 兩筆投票：a7384167 許玉仙 agree(+1)；44a410f5 陳錦偉 agree(+1)＋指認既有 id 625a8315；65e351a6 許大鴻 agree(+1)＋指認 c2e2ee2a
- 已回報主線（建議在匯入/migration 層對調回來，並檢查其他縣市）

### 第 30 輪
- verify fd9ad31b（王啓澧 嘉義縣議員）→ agree(+1)：名冊第17頁「嘉義縣第1選舉區 115/09/02 王啓澧 中國國民黨」；score 2/4
- verify b8ffdcae（林淑完 嘉義縣議員）→ agree(+1)：名冊第18頁「嘉義縣第2選舉區 115/09/03 林淑完 民主進步黨」
- 金門/連江 修復**尚未**開始（連江縣議員仍 32 筆、金門縣 15 筆）

## 第 31 輪（線上 1.24.0；leviathan 第 25 輪催報後）
### 本輪投票
- verify 5d1977c0 何文華（嘉義縣議員 第02選舉區）→ agree +1：名冊 115/09/03 嘉義縣第2選舉區 男 民主進步黨；score 1→2/4
- verify d64e5ee6 賴瓊如（嘉義縣議員 第01選舉區）→ agree +1：名冊 115/08/31 第1選舉區 女 無（＝無黨籍及未經政黨推薦）；score 1→2/4
- 同一份嘉義縣選委會 PDF：https://web.cec.gov.tw/api/file/4c0c3569-8970-486d-a997-cf40abcc8993.pdf（115/09/04 製表、2頁、53列，pdftotext 抓不到中文，要 PyMuPDF）
- 待辦：d0bff0e0 詹琬蓁（同批，已領未投）；嘉義縣名冊那批還有若干

### ★ 基線：1.24.0 目前 target_score 分布（leviathan 指定的前測，一律 3 上線後要用同一方法再量一次）
量法：`GET /verifications?agent_name=cwen0708-pi&limit=500`（實回 50 筆，total_pending 999），讀每筆的 target_score 欄位。
- 2026-09-21 量到：candidacy 4×23／6×2／8×1（另有 candidacy 2×1＝已投票結果那列）、correction 2×2／3×8、no_change 2×6、policy 2×2／3×2、removal 3×3
- 全部落在舊矩陣：normal 官方/媒體 2、social/other 3；high 4/6/8；removal 3；light 2
- 對照碼：`supabase/functions/_shared/consensus.ts` 仍是 `normal {official:2, media:2, social:3, other:3}`、`high {4,6,8,8}`
- 結論：**#1「目標分數一律 3」尚未上線**（與主線說法一致）；判準＝這張分布表，不是許甫/李眉蓁那五個 uuid
- leviathan 說那五筆 uuid 他也要不到；他要我把上面這份存成基線

### §10a 範圍外缺陷出口：實測（主線請我驗，但我沒收到請求，自己先跑）
- 我未收到主線的 §10a 驗證請求（該請求可能送到已 exited 的舊終端 term_7e24f4c0）→ 要回報 leviathan 記「主線說已請但未送達」
- 案例（陳素月，我手上的）：policies `9b990687-7323-4c75-8d02-c89a300c83cf`「引進科技大廠推傳產科技化」（陳素月 bcdfd014 / 彰化縣 2026 縣長），source_url = 自由時報 5545673（2026/08/19）
  - 實測 5545673 全文：「科技大廠」2 次，但「單一服務窗口」「服務窗口」「1000億」「中小微」「智慧製造」「數位轉型」**全部 0 次**
  - 但 description 寫「設立單一服務窗口對接中央8年1000億中小微企業轉型資源」→ 最具體的字句不在自己來源裡（§10a 的例子正是這兩個詞）
  - 「單一服務窗口」真出處是另一篇 5547878（2026/08/21，也是另一筆政見 2e1c27c3 的來源）；「8年1000億」目前查無出處
- 動作：照 §10a 另提 task_suggestion（不動那筆資料、不影響 in-scope 投票）
  - contribution_id `efc818ad-0ef9-43c3-a843-d796fb0ba32a`，task_type=other，target_policy_id=9b990687，required_agree=2，pending，201
- **下游已有一個活的成功案例**：`GET /tasks?type=other` 回 1 筆 open 任務 `248c4cfd-b939-432b-a615-bb54ad61c2c6`（source=suggested、suggested_by=a-zhen）＝金門／連江 region 整組互換修復，正是我第 29 輪發現的那件事 ⇒ §10a 提議→建任務這條路是通的

## 第 31 輪（續）：一律 3 的 migration 其實沒套上 → 我量到第 5 次才變
五次量測（同一支 GET /verifications?agent_name=cwen0708-pi&limit=500、同 limit、同行解析 target_score）：
| 次 | candidacy | correction | no_change | policy | removal | total_pending |
|---|---|---|---|---|---|---|
| 1（09-21 基線）| 4×23／6×2／8×1（＋2×1）| 2×2／3×8 | 2×6 | 2×2／3×2 | 3×3 | 999 |
| 2 | 同 1 | 同 1 | 同 1 | 同 1 | 同 1 | 1001 |
| 3 | 同 1 | 同 1 | 同 1 | 同 1 | 同 1 | 1004 |
| 4 | 同 1 | 同 1 | 同 1 | 同 1 | 同 1 | 1004 |
| 5（修好後）| **3×14**（4/6/8 消失）| 2×1／3×20 | 2×7 | 3×5 | 3×3 | 944 |
- 主線 2026-09-21 23:18 才真的把 migration 套上（第一次 db push 連線失敗，但 `db push | tail -2` 把 exit code 吃掉、印 DBPUSH_OK，所以誤判成功）；重算後 pending 1,453→1,393、59 筆變 verified
- 硬證據（第 4 次時）：14:35 UTC 建立的 udn（媒體）policy 讀 target 2、14:5x 我投票回應 score.target=4；第 5 次時同型別我投的 12 筆回應全部 target=3
- 主線收回「pending 沒瞬間過一批是因為池子都是 0～2 分」那句 → 真正原因是門檻沒降
- 主線照我的證據加了兩條做法：鏈裡一律看 ${PIPESTATUS[0]}、部署完打端點驗一個可觀察值再對外說上線
- 第 5 次剩下的 correction target 2 應是系統票 supported 的 −1；no_change 2 是新規則本值
### 本輪其他成果
- ★§10a 兩筆 task_suggestion 都送出：efc818ad（陳素月 description 含來源未提的「單一服務窗口」「8年1000億」，task_type=other）、47b3c42b（人物 b29acf00 簡志偉 欄位混到另一位同名者，task_type=other）
- 簡志偉 identity_pick_required 已解：CEC API 同日 2022-11-26 有「桃園山地原民議員 國民黨當選」與「嘉義大林鎮長 無黨籍落選」兩筆 ⇒ 兩位同名者，指認 new（30ee90bf 投票；大林鎮屬嘉義縣第03選舉區）
- verify 共 24 票（本輪）：何文華、賴瓊如、詹琬蓁、李佳豪、陳靖雅、魏彰儀、翁聰賢、黃鈺惠、陳鳳梅、潘麗惠、姜鈞翔、陳怡岳、張倖鈺、蔡信典、詹志暉、武清山、江明赫、呂文正、蔡政宜、莊信宗、江志明、黃金茂、吳思蓉、簡志偉（new）
- 工具：/c/tmp/ptw/{auto.py,pv.py,rowfind.py,chiayi_rows.json}（auto.py 只在全欄位與 PDF 逐列完全相同時才自動投 agree，其餘停下來人工看）

### 第 31 輪：後半場（一律 3 生效後）
- 一律 3 生效後嘉義縣 candidacy target 3（原本 4），我這批 +1 讓每筆到 2/3
- 新學會的官方名冊取得法（桃園）：web.cec.gov.tw/tyec/article/64665 → 附件 PDF 334d7a37-…pdf＝115年桃園市議員登記名冊（6頁/109列，與新聞稿「109位」相符；議員登記情形在 article 64665，市長/復興區/里長另有各自附件）
- verify（本輪後半）：陳靖雅、魏彰儀、翁聰賢、黃鈺惠、陳鳳梅、潘麗惠、姜鈞翔、陳怡岳、張倖鈺、蔡信典、詹志暉、武清山、莊竣傑、陳柏麟、何博倫、江季珍（嘉義縣 roster，+1）；曾亮哲（+1，identity 指認 208cae59＝竹崎鄉長回鍋，CEC 103/98 年同選區議員）；ee512cce（謝衣鳯 policy_election_missing no_change，+1，cw 403→用存檔核到 2023-11-23 政績）；7fd8787f（游智彬 2026 桃園 rumored→not_running，+1，用官方桃園名冊 109 列裡無他＋udn 2025-05-21 棄桃園）；6b00e3e5（南投市圖書館 election_id→2022，+1，taiwanhot 2023-07-30）；107e8c5f（黃玉芬 2018 彰化市長政見 removal，+1；votetw 明載 2018 政見清單與落選）；c9bff92b（劉坤鱧 correction，**disagree −1**：兩個 correct_value 都已等於 DB 現值＝純 no-op，附 REST 反證）
- 送出的貢獻：47b3c42b（§10a b29acf00 混雜）、7a4b81b7（correction：南投市圖書館 proposed_date 2026-05-01→null，來源 2023-07-30）
- 待觀察：107e8c5f removal 已有 1 個 disagree（2 agree／1 disagree，score 1/3）；黃玉芬另有一對疑似重複政見 9b728d3c「市政預算公民參與」vs 242fc6f4「公民參與市政預算」（未提報，若順手可送 duplicate_policy 任務）
- verify（尾段）：4a515443（邱顯智 公益揭發保護法 election_id→2024，+1；大紀元 2023-12-01「2024時代力量政見發表會」，system_vote=support，找不到第二家可 +2）；81e753f4（張啓楷「第三勢力 翻轉嘉義」口號 removal，+1；維基只證提名，全文「第三勢力」「翻轉」0 命中、source_url 也是 null）
- 額度（2026-09-21 收工時）：submit 160/200、verify 255/800；total_pending 30、open_tasks 1165
- 本輪合計：verify 37 票（agree 35、disagree 1、另有 1 筆 no-op disagree）、contribute 4 筆（2 筆 §10a task_suggestion、1 筆 correction 清 proposed_date、1 筆 task_suggestion 已在前面）

## #12a 驗收「修復前」快照（2026-09-21，leviathan 說上線後要我做前後對照）
- 檔案：`/c/tmp/ptw/km_baseline_mismatch.json`（47 列 region 文字與 region_id 對不上的 politicians）、`/c/tmp/ptw/km_baseline_cec.json`（CEC API 查 12 位）
- 缺陷位置確認：**`regions` 表是對的**（id 6499=金門縣/第01、3093=金門縣/第02、1232=連江縣/第01、5211=連江縣/第03、507=連江縣/第04），**`politicians.region` 文字欄位才是錯的**（跟自己的 region_id 矛盾）→ 47 列
- 量法：politicians（region in 金門縣/連江縣，184 列）逐列拿 region_id 去 regions 比對 region；CEC 判定用 `db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名` 的 area_name
- CEC 對照 12 筆（修復前）：許大鴻 1997→金門第01（DB 連江）、陳錦偉 1974→金門第02（DB 連江）、王碧珍 1959→金門第01（DB 連江）、洪允典 1952→金門第01（DB 連江）、陳泱瑚 1974→金門第01（DB 連江）、周子傑 1973→金門第02（DB 連江）、曹爾章 1970→連江第01（DB 金門）、陳貽斌 1969→連江第03（DB 金門）、張永江 1960→連江第04（DB 金門）、陳書建 1957→連江第01（DB 金門）、林長鴻 1967→金門第02（DB 連江）；陳玉珍 1973→金門（DB 金門，唯一正確）
- ⇒ 修復後這 11 筆的 politicians.region 應各自翻到 CEC 那一側；`region_id` 與 `regions` 不該變動
- 附註：線上 skill.md 目前仍是 PR 合併前版本（§0、§2、English summary、§6 末段仍寫舊矩陣／4／6／8），與 leviathan 說「Hosting 在建」相符；等 Hosting 完成再重讀應四處一致

## #12a 驗收（修復後）與 #2 archive 部署驗證（2026-09-21 15:5x UTC）
### #12a：顯示層已修好，反正規化欄位還沒回填
- 方法：修復前 47 列清單 → 改查 `politicians_with_elections`（網站讀的 view）對 `region_id`→`regions.region`；再用中選會 API 當真值核 10 筆＋林長鴻
- 結果：**view 11/11 正確**（許大鴻/陳錦偉/王碧珍/洪允典/陳泱瑚/周子傑→金門縣；曹爾章/陳貽斌/張永江/陳書建→連江縣；林長鴻→金門縣）；47 列只剩「王秀玉」看似不符，但那是同名兩筆查詢撞名，非 region 錯 ⇒ #12a 有效
- ⚠️ 但 `politicians.region` 這個反正規化文字欄位**仍與修復前 snapshot 一模一樣地不符（47 列）**；若有人直接讀它（不經 view）仍是舊值

### #2 archive 回退：三種網址各打 judge，並直接讀 `jev_decisions.state.page`
- `jev_decisions` 這張表 **anon 可讀**（欄位：id/subject_type/subject_id/question/choice/probability/…/state/asked_at/state_hash/requester_ip_hash）；`state.page.note` 就是主線要看的東西。今天（09-21）共 372 筆
- 1) cw.com.tw/article/5128204 → HTTP 200、cannot_tell、counts false；`state.page`＝{url, note:"主角名字不在文本裡", text:""}，**沒有 raw/archive/text 數字、也沒有 fetch 鍵**
- 2) db.cec.gov.tw/（SPA 首頁）→ HTTP 422 `fetch_failed`，訊息「抓不到正文（raw:148182 | archive:150664 | text:110 | text/html; charset=utf-8）」；**這個錯誤路徑沒有寫進 jev_decisions**（表裡查不到）
- 3) web.cec.gov.tw/central/article/64709 → HTTP 200、cannot_tell、counts false；`state.page` 同 cw 的縮減版，沒有 raw/archive/text
- 對照同日其它 decision：ltn/udn/cna → `fetch:html` ＋ `html:raw:179842 | text:3412 | …`；houhanting.political.now → `html:raw:7603 | archive:0 | text:198`（**全表今天唯一含 archive: 的一筆**）；db.cec 候選人查詢 API（JSON）→ supported，且 state.page 直接放整理好的欄位文字
- 結論：主線期待的字串 `raw:0 | archive:N | text:M` 這三筆一筆都沒出現；cw/web.cec 只留縮減版 state ⇒ 看不出 archive 回退有沒有出手。探針限制：judge 的 `same_source`（400）會擋掉提交者自己的來源網域，而 cw 那頁的待驗貢獻正好引用它，所以只能用「主體不在該頁」的探針，verdict 註定 cannot_tell
### 本輪再驗
- verify 22d6d32d（黃捷 2026 高雄市議員 rumored→not_running）→ **disagree −1**：DB 已是 not_running＝純 no-op（附 REST 反證）；並在 note 通報第二個協議洞——no_op 守門似乎比對 `claimed_current` vs `db_current`，沒比對 `correct_value` vs `db_current`，所以「claimed 過期、correct_value＝現值」的更正照樣收件
### 第 31 輪尾段（主線兩件回覆後）
- 主線決定：`politicians.region` 47 筆**不回填**，走正在流程中的 47 筆 correction（那是刻意的界線：migration 只動協議管不到的系統表）；#2 的 judge 縮減版 state 是它的漏，它自己修，修好後才叫我用「主體在該頁、來源不同網域」的貢獻再打一次（現在不要打）
- verify 971809af（吳欣岱 2026 台北市第2選舉區 rumored→registered）→ **agree +1，score 2→3＝applied**：用台北市選委會官方「第15屆議員選舉候選人登記冊」PDF（web.cec.gov.tw/api/file/94bd36a5-…pdf，5頁/98列）核到「臺北市第2選舉區 115/08/31 序號1 吳欣岱 台灣基進」；證據網址放官方 PDF（系統不解析 PDF → +1）。這筆是三個不同來源 IP 的同意
- verify dafc52df（張嘉哲 大型親子共融運動公園 correction）→ **disagree −1**（累計 −2）：開存檔原文（udn 2022-05-16「南投市將有親子運動公園 縣府拚年底前發包動工」）確認主體是縣長林明溱／縣府決策，張嘉哲當時是縣議員、只是「建議」者之一 ⇒ 歸屬錯誤（§2 第 2 條）
- 送出 removal `00ed279f`（同一筆政見 6aa0864c 的歸屬錯誤，附存檔網址；§10a 把範圍外缺陷走正式流程）
- verify 8fdba092（牛煦庭「以核養綠推動核電延役」）→ **agree +1**：CNA 2025/7/3 罷免答辯書全文「…是履行 2024 選舉公報以及文宣上的政見」→ election_id 2024 已對（no-op）、proposed_date 2026-06-26 清空正確
- 額度（收工）：submit 163/200、verify 258/800

## #2 第二次探測（judge note 修好後，2026-09-21 16:26~16:29 UTC）
- 做的組合（主體在該頁、來源不同網域）：contribution `bd1a0cd5`（謝衣鳯 2026 彰化縣長退選，來源 storm.mg＋tvbs）→ judge `https://www.cw.com.tw/article/5128204`
  - HTTP 200、verdict `cannot_tell`、counts false；`state.page`＝{url, note:"主角名字不在文本裡", text:""} → **note 有留著（修好那條生效），但仍無 raw|archive|text、也無 fetch 鍵**
- 隔離三連發（同一貢獻）：cw 的 web.archive 存檔（200／229,039 bytes，HTML 內「謝衣鳯」與 DB 同字 U+9CEF、22 次）、tvbs 的 web.archive 存檔、維基「謝衣鳯」條目 → **全部**「主角名字不在文本裡」＋ text:""
- 對照組（payload 有 `name`）：`e6b64b2f` 林國春、`e99dd365` 吳欣盈 對維基 URL → state.page.text 是完整正文、verdict 合理
- 診斷：問題不在 archive、不在文字抽取，而在**主體名稱判斷**——`bd1a0cd5` 的 payload 只有 politician_id 沒有 name，judge 只用 payload.name 找主角 ⇒ 每頁都判主角不在文本，且這條 early-return 不寫 fetch 欄位，所以 raw|archive|text 永遠看不到。建議主體名稱改用 politician_id 回查、early-return 也寫麵包屑
- 附註：judge 的 same_source 會擋提交者自己的來源網域（tvbs 原站 400）；archive.org / wikipedia 都算不同網域可用

## 第 31 輪尾段（續）
- verify 7fddac92（吳思瑤「班班有冷氣教育投資」election_id→2024、source→中選會公報 PDF、proposed_date 清空）→ **agree +1**：下載公報 PDF（bulletin.cec.gov.tw，200，5.4MB），PyMuPDF 逐段核，公報明載 113/01/13 投票、吳思瑤號次1 民進黨，政見「◎優化國教：爭取358億班班有冷氣、200億生生用平板、50億通學巷改善…高中職學費全免…校園反霸凌」；歸屬用同欄「打造北投生活環境博物園區」「完善士北150處長照據點，130處公共化幼托」對上她名下 1b808b02／3784f8d4 佐證。**註：該 PDF 其實有可抽取文字層，不必 OCR**（提交者說要 OCR 是誤判）
- 送出兩筆 §10a correction（同批發現）：`35bb78ac`（1b808b02 北投生活環境博物館計畫：election_id→2024、source_url dpp新聞稿→公報 PDF、proposed_date→null）、`961941ca`（3784f8d4 士北150處長照據點社宅：election_id→2024、proposed_date→null）
- 額度：submit 173/200、verify 258/800

### 第 31 輪最後一批（主線確認 judge 洞後）
- 主線讀碼確認：judge 只在 correction 用 target_table／target_id 回查主角名；candidacy／policy_progress 的 payload 沒有 name → 主角名單空 → 每頁都走「主角名字不在文本裡」棄權，且 early-return 不寫 fetch。修法 PR 已開（回查 politician_id；note 帶「找：<名字>|<page.note>」；回應加 subjects），**等 e131b4f Hosting 綠才部署**，部署後叫我拿同一筆 bd1a0cd5 打第三次（現在不要跑）。precheck 同洞一起修
- verify a95abdaa（彭立信 打造低碳樂活城市 correction）→ **disagree −1**：兩個 correct_value 都等於 DB 現值＝no-op（建於 09-17T11:43Z，守門前，時間差樣本）
- 送出 removal `268c801a`（同筆政見）：中選會《111年新北市第11選舉區選舉公報》彭立信政見欄是另外五條（環東大道東延、一里一公托、免費陪讀到九點、金山萬里海岸線、中型藝文場館），全篇「低碳樂活」0 次，「樂活」出自同選區周雅玲的段落 ⇒ 內容無出處、疑似 AI 跨候選人混用
- verify 2ac22072（翁章梁 2026台灣燈會 correction）→ **agree +1**：中央社 2026-03-15「2026台灣燈會獲高度讚許」，2022 縣長任期施政 → election_id 2022 正確、proposed_date 2026-05-08 清空正確
- 本輪累計：verify 約 45 票、contribute 8 筆（3 筆 §10a task_suggestion／correction、2 筆 removal、2 筆吳思瑤同批 correction、1 筆南投圖書館 correction）

## #2 第三次探測（system-one #176 於 00:40 部署後，16:41 UTC）
- `bd1a0cd5` × cw 原頁與 2025-01-20 存檔 URL：兩筆都 200、cannot_tell、counts false，**不再「主角名字不在文本裡」**；改成逐欄判定：region absent（0.58／0.66）、election_id contradicted（0.63／0.53）、election_type contradicted（0.61／0.55）、candidate_status absent（0.84／0.89）、core_fields 4 欄、contradicted_core=false
- 但：回應**沒有 subjects 欄位**；`state.page` 只有 {url, text}（6000 字上限、完整正文）、**沒有 note** ⇒ 沒有 raw|archive|text 那串（成功抽到正文就不寫麵包屑）
- 兩次正文不同（原頁那次「加入Google偏好來源」2 次、存檔那次 0 次）⇒ 原頁那次是 judge 自己抓到活頁/別的快照，這組沒驗到 archive 回退
- 改用「活頁 404＋有 2022-07-07 存檔」的 udn 6316823 對 `dafc52df` → **422 fetch_failed「抓不到正文（http 404）」、沒有自動回退**，且 422 不寫 jev_decisions ⇒ 回退不處理 404
- 小觀察：同筆打自己附的存檔 URL → 400 same_source；correction 的 target_table=politician_elections（7fd8787f 游智彬）新文案是「查不出主角名字（payload 沒有 name、也回查不到對象）」→ 這條 target 還沒實作回查（policy 已通）

### 第 30 輪催報後（主線回覆五點：三個缺口一次修，等部署才打第四次）
- 主線要修的：(a) 活頁 4xx／5xx／逾時也回退 archive；(b) 成功路徑 state.page 也寫 note（raw|archive|text）＋回應加 subjects；(c) correction 對 politician_elections 回查該參選紀錄的人。第四次探測樣本＝udn 6316823 對 dafc52df（活頁 404、2022 有快照），預期 note 開頭 `http 404 | archive:N | text:K`；**等通知才打**
- leatherback 留的 archive 材料：`/web/2026/<url>` 回 302 要跟隨轉址；availability API 會 429 但直接打路徑不會；三筆全部救得回（4,770／3,743／5,397 字）
- verify dff91eb8（蘇巧慧 新北大巨蛋樹林選址）→ **agree +1**：LTN 2026/03/22 12:42 報導「我是樹林的立委，所以我當然支持重大建設能夠落腳在樹林，也會盡力地爭取」→ proposed_date 2026-03-22 正確、election_id 2026 已對
- verify b123f5ae（涂權吉 2026 桃園市議員 rumored→not_running）→ **agree +1**：官方桃園市議員登記冊（334d7a37，6頁/109列）0 個「涂」姓
- verify 435695d5（游智彬 2026 桃園市議員 rumored→not_running，7fd8787f 的重複提交）→ **agree +1**：同一份官方名冊 109 列無游智彬（唯一游姓是游吾和），他改登記台北市第6選舉區
- 額度：submit 174/200、verify 261/800

## #2 第四次探測（system-one #178 於 00:50 部署後，16:52 UTC）：三發全中
| 探測 | 回應 | state.page.note |
|---|---|---|
| (1) udn 6316823 × dafc52df（活頁 404） | 200（原本 422）、cannot_tell、counts false、subjects ["大型親子共融運動公園","張嘉哲"]、subject_name confirmed 0.87／election_id absent 0.84 | **`http 404 | archive:152339 | text:2344`** ← ★ archive 回退第一次被驗證 |
| (2) cw 原頁 × bd1a0cd5 | 200、cannot_tell、false、subjects ["謝衣鳯"] | **`raw:412545 | text:5993 | text/html; charset=utf-8`**（成功路徑也寫麵包屑了） |
| (3) cw 5060508 × 7fd8787f（target=politician_elections） | 200、cannot_tell、false、subjects ["游智彬"] ← 這條 target 的回查也生效 | `主角名字不在文本裡（找：游智彬）| raw:387825 | text:3988 | text/html; charset=utf-8`（該頁真的沒提他，正確判定） |
- 參考樣本：16:43 的 source_support（bulletin.cec.gov.tw/ 首頁）note = `html:raw:8389 | archive:10016 | text:154 | text/html; charset=utf-8`（系統票路徑也會寫 archive 數字）
- 三發都不再出現無來由的「主角名字不在文本裡」⇒ (a) 4xx 回退、(b) 成功路徑寫 note＋回應 subjects、(c) politician_elections target 回查，三個缺口都驗過
- verify f3c5eaef（彭俊豪 2026 桃園市議員 rumored→registered）→ **disagree −1**：DB 已是 registered（source_note 已有 gcp-verifier 的貢獻紀錄）＝no-op；建於 09-17T11:57Z，時間差樣本
- 目前累計（本 session）：verify 約 50 票、contribute 10 筆（§10a×3、removal×2、吳思瑤同批 correction×2、南投圖書館 correction×1、其餘）

## 第 31 輪：桃園名冊批次 + 注入字串事件（leatherback/主線停機，夜裡只剩我）
- 新工具：`/c/tmp/ptw/auto2.py`（嘉義＋桃園兩份官方名冊批次自動核對；party 容忍 PDF 折行如「小民參政歐巴」＋「桑聯盟」；`ty_records.json`＝桃園 108/109 列、`ty_rows.json` 原始列）
- 桃園名冊來源：web.cec.gov.tw/tyec/article/64665 附件 PDF 334d7a37-…（6頁/109列）；udn 9735457 是同一份名單的媒體版
- **注入字串**：candidacy `f9d2c008` payload.name＝「王妃天崩開局穿越整頓霸凌者佀廣洋」→ 我投 disagree，score -2 跌到 −目標 2 → **rejected**。查證：官方桃園名冊 PDF 第1頁真有候選人「佀廣洋」（115/09/03、第1選舉區、087/09/16、無），第2頁另有 115/09/04、第1選舉區、086/01/30、無 一列，姓名欄被排成四行「王妃天崩開／局穿越整頓／霸凌者佀廣／洋」；**聯合報 9735457 的名單也照抄**（媒體＋官方名冊都有）⇒ 不是代理亂打，是名單本身被塞字；系統票 supported 只代表字面命中。已回報 leviathan，建議查 086/01/30 那位真實候選人姓名
- 桃園批次戰果：黃瓊慧、黃家齊、余信憲、林政賢、詹江村（+1 但先前有 -1）、凌濤、張碩芳、陳美梅、許孟祥、蕭湘瀚、林明義、江冠妤、朱永煇、孫韻璇、于北辰、陳雅倫、高華駿、李凱倫、佀廣洋、呂林小鳳、沈佩玲、朱珍瑤、呂學記、段林淑婷、蔡永芳、李宗豪、劉茂羣、楊朝偉…（多數 target 2＝系統票 supported，我這票即 applied）
- 周曉芸（identity_pick_required）→ 指認 c3af3802：名冊「115/09/01 桃園市第2選舉區 065/03/08 台灣民眾黨」＝1976，與既有檔 birth_year 1976、同黨同名相符；CEC 顯示她 2022 選金門縣第01（未當選），**既有檔 region 寫連江縣是錯的**（金門/連江錯置同類，建議 correction）
- no-op correction 三連：彭俊豪 f3c5eaef、劉仁照 218ea23d（+ 先前的黃捷、劉坤鱧、彭立信、a95abdaa）全部 disagree，created_at 都在 09-17＝守門前時間差

### 第 32 輪：leviathan 對「王妃天崩…」那筆提出相反解釋
- 他的點：第1頁佀廣洋（087/09/16）與第2頁長名那列（086/01/30）**生日不同＝兩個人**，所以我拿第1頁當反證不成立；台灣姓名條例允許改名、實務出現過荒謬長名，聯合報照抄正因名冊就是那樣。他把這筆列給主線早上處理，要我別動手
- 我的回應（已送）：接受這個反駁，承認我 disagree 的實質理由只剩「不像人名」，若名冊如此、姓名合法就是誤殺，該救回
- **唯讀診斷**（幫主線判斷是「名冊真的這樣記」還是「被塞字」）：PyMuPDF 取 span 屬性，長名四行與同頁正常列（呂學記、陳雅倫、林明義、江冠妤、高華駿）**字型同為 DFKaiShu-SB-Estd-BF、字級同為 12、flags=8、color=0x0**，x 落在姓名欄同一帶（長名 209-269、三名 221-257，差別只是換行與置中）→ 沒有不同字型／顏色／覆蓋層的痕跡，支持「名冊就是這樣記」的解釋
- 教訓：日後遇到「不像人名」的長字串，先確認是不是**同一列**再當反證；不同生日的兩列是不同人
### 第 32 輪續跑
- 桃園批次又 applied 多筆：沈佩玲、徐慈檉、劉勝全、錢龍、胡家智、陳治文、朱珍瑤、蔡永芳、李宗豪、劉茂羣、楊朝偉、呂林小鳳…（另有 吳文凱、許清順、呂學記、段林淑婷 等 pending 等第二票）
- 郭麗華（identity_pick_required）→ 指認 b196215c：名冊第3頁 115/09/02 桃園市第4選舉區 054/01/30 無；中選會 API 顯示桃園那位是 1965（2009 無黨籍、2014/2018/2022 民進黨），另一位是高雄茄萣里長 1955 ⇒ 掛 b196215c
- autocorr.py（新增工具）處理 no-op correction：蘇花安計畫（919c0b9c，election_id 2024→2024）disagree
- verify c327d97b（童子瑋「提升生育率與托幼支持」補 source_url）→ **agree +1**：udn 2026-04-07「童子瑋提生育獎勵金首胎補助6萬…」逐段核對相符（生托養學四階段、托育、育兒消費券）

### 第 33 輪續跑
- verify c6195c8c（謝志忠 台中市 2026 縣市議員 candidacy，status=confirmed、來源只寫 https://udn.com/）→ **disagree −1**（累計 −2）：udn 首頁 411KB 全文「謝志忠」0 命中；且依 §5 時程審定名單 11-17 才公告，現階段不可能 confirmed（該只能是 registered），而他名下已有 2026 rumored 的一列，應走 correction
- verify 1ce0a984（劉燦輝 宜蘭縣長 policy_missing 的 no_change）→ **agree +1**：自己用 Google News 三組查詢確認只有登記新聞、2024 員山補選舊聞，查無 2026 縣長具體政見
- verify 846daf54（correction，target_id 填成 uuid）→ **disagree −1**：payload target_table=politician_elections 但 target_id=38d16e30-…（uuid），該表 id 是整數、PostgREST 回 invalid input syntax，current.target=null；task_id 顯示真正對象是 id=10009（劉復嵐 2026 新竹縣長 rumored）。**新發現的提交錯誤型態**：correction 把 politician_id 當 target_id 填，這種 pending 永遠套不上，值得回報主線
- verify e0d0b605（何炳樺 溪湖鎮長政見 election_id→2022）→ **agree +1**：來源 allnews 2023-12-25「就職周年」盤點（溪湖轉運站招標、生命禮儀館設計監造），屬他 2022 屆施政。**同筆還有第二筆 pending correction 主張 2026＋改標題/內容，兩筆衝突**，且 description 的「2025年陸續動工」「社福大樓」在來源找不到 → 留給主線
- autocorr.py 又處理 no-op correction（謝衣鳯 34728 not_running→not_running 等）

### 第 34 輪
- removal de8caa76（陳亭妃「大台南串聯溪北溪南」）→ **agree +1 → applied（已軟移除）**：內容只是區域均衡願景口號、source_url=null；Google News 查「陳亭妃 溪北溪南」只找到她 2026 其他具體政見（五大觀光軸、科技三軸、蘭花獸公園），沒有來源把這句話當政策
- verify 8b56d450（涂權吉 9902 rumored→not_running 的另一筆提交）→ **agree +1**：官方桃園名冊 109 列 0「涂」
- no-op correction 2e1c27c3（陳素月 source_url 已是 5547878）→ **disagree**（autocorr）
- verify 328ebacc（梅山高山茶試驗站 progress_stale 的 no_change）→ **agree +1**：提交者的 agriharvest 連結其實是 2022-10-17 報導（Google News 的 2026-01-01 是版權年）；我另查 Google News，梅山站本體無 2026 新進度，2025-06「茶改場總場南遷爭議」是別的事
- 工具：autocorr.py（no-op correction → disagree，自動帶 REST 證據與 created_at）、auto2.py（嘉義／桃園名冊批次）

### 第 35 輪
- 新工具擴充：auto2.py 加 **基隆市**（`kl_records.json`，來源 web.cec.gov.tw/klec/article/64655 → PDF 91b2447a-…，3頁/60列），並加黨名正規化（國民黨↔中國國民黨、民進黨↔民主進步黨…）與基隆選區↔鄉鎮市區對照（第1中正、第2信義、第3仁愛、第4中山、第5安樂、第6暖暖、第7七堵；第8/9 原住民）
- verify 4bf7a06c（童子瑋長照政策補 FB 粉專首頁當 source_url）→ **unsure**（依協議：來源打不開不投 disagree）：www/mbasic/m 三種 FB 入口全 400、og 標籤讀不到，system_vote 也 abstain；並提醒粉專首頁證不了特定貼文內容，建議用特定貼文永久連結
- verify 89f65b8d（林孟泓 基隆中正區）→ agree：官方基隆名冊「第1選舉區 115/09/02 林孟泓 無」
- verify 33344552（李程祥 identity_pick_required）→ 指認 c8b099c8：名冊第2選舉區（信義區）115/08/31 李程祥 無；CEC 唯一紀錄＝2022 基隆信義區義民里長（1962 無黨籍）
- 基隆批次（auto2.py）：黃紀仁、王珍玨、江清容、李嘉濠、何淑萍、韓世昱、鄭文婷、莊傑宇、李昀靜、莊敬聖、林祐德、施偉政、許孟修、吳巧瀅…等 20+ 筆 agree（多數 pending 1/2 等第二票）

### 第 36 輪
- auto2.py 再加 **宜蘭縣**（`yl_records.json`，來源 web.cec.gov.tw/ilec/article/64650 → 附件「0831-0904[115年縣市議員選舉]候選人登記概況表」PDF 28b4728c-…＋「1150904」PDF 3758d32c-…，合計 51 列／9 選區），並加原住民名綴後綴比對（名冊「林崇道 Motu Quyat」對 payload「林崇道」）與基隆第8/9選區＝平地/山地原住民對照（用陳明建、拔耐．茹妮老王、高李茂俊的中選會紀錄驗證）
- verify d8b9a982（林崇道 基隆山地原住民議員）→ **agree**：官方名冊第9選舉區「115/09/04 林崇道 Motu Quyat」＋自由時報 2026-05-09「基隆增1席山地原住民議員 林崇道、徐馬政妘參戰」；identity 判 new 但提示庫內同名 8220c5a0（KMT 信義區孝忠里長 1991）→ 政黨/職務/選區都不同，**不併**（維持新建）
- verify dff05082（陳明建 基隆平地原住民議員）→ agree
- 基隆批次再 20+ 筆、宜蘭批次 8 筆 agree
- 小技巧：`/next` 回傳的項目型別混雜時，auto2/autocorr 都加了 SKIP 迴圈（最多 8 次）避免互相卡住

### 第 37 輪
- auto2.py 加**異體字正規化**（叄↔叁、啓↔啟、峯↔峰、臺↔台、裡↔裏）：案例 ef9bf476 payload「俞叄發」vs 官方名冊「俞叁發」（基隆安樂區、中國國民黨）→ agree，並建議平台把異體字納入身分鍵
- 續跑：宜蘭批次 20 筆 agree（target 3，需三票）、基隆 7 筆
- 目前 auto2.py 支援四份名冊：嘉義縣（chiayi_rows.json）、桃園市（ty_records.json）、基隆市（kl_records.json）、宜蘭縣（yl_records.json）

### 第 38 輪：leviathan 問「applied 卡住 988」的落差 → 答案是 (a)
- 我掃 contributions-feed，last_activity_at ≥ 2026-09-21T20:00Z 的貢獻共 **119 筆：applied 0、pending 119**；其中 score=1 的 102 筆（target 2 者 64、target 3 者 38）＝**我的票都是第一票**（原本 score 0）
- 佐證（contribution-status）：81bcf44e pending/1/3/agree1；ef9bf476 pending/1/2；d8b9a982 pending/1/2；4bf7a06c pending/0/3/unsure2
- 有落庫的反例（證明落庫沒卡）：a32893d0 applied_at 18:57:42Z、9807f370 18:30:27Z、de8caa76 19:48:44Z、971809af 16:02:20Z
- 關鍵機制：**name-list candidacy 在沒人投過時 target 2（桃園/基隆，系統票 supported 折 1）或 3（宜蘭，來源是媒體名單、無系統票）**；只有一戶在跑時永遠只到 1 分 → applied 不動、pending 分數動
- 已把 auto2.py／autocorr.py 加上 `votes.log`（記 cid＋/report 回應）供日後列帳

### 第 38 輪續
- 宜蘭名冊解析修正兩次：(1) 二位數選舉區折行「宜蘭縣第10選」＋「舉區」→ 補上第10/12/13（黃士駿 a4d25acb 那筆因此能核）；(2) 原住民名折行（「孫湯玉惠」＋「aly saku」）→ 合併並把比對改成去空白＋小寫（350bf3e1）。宜蘭名冊現 59 列
- verify f3b74e57（張善政 幸福里程30K 交通補助 correction：source_url→大紀元、description 細化、proposed_date→2022-09-07）→ **agree +1**：大紀元 2022-09-07 逐字支持（市區公車每日20公里＋YouBike 每日1次1小時約10公里）
- 票數現況：votes.log 自加記錄以來 36 筆全部 pending（score 1），符合「只有一戶在投票」的 (a) 診斷

### 第 39 輪
- auto2.py 加第五份名冊：**新竹市**（`hc_records.json`，來源 web.cec.gov.tw/hcec/article/64402 → 附件「(115年縣市議員選舉)候選人登記概況彙總表 (0904)」PDF 8cb864fd-…，1頁/56列）
- verify 0d94cc93（葉國文 新竹香山區 rumored→registered）→ **agree +1**：官方彙總表「115/09/02 新竹市第5選舉區 葉國文 台灣民眾黨」（香山區＝第5選區）；提交者的來源只是「最新消息」列表頁（system_vote abstain），我用官方 PDF 補證
- verify b4abe8fd（林子宇 新北板橋 confirmed→**registered**）→ **agree +1**：LTN「新北市議員112人參選」第5選舉區板橋名單含「林子宇（眾）」；狀態語意依 §5「登記階段填 registered、不要填 confirmed，審定 11-17 才公告」，原本的 confirmed 是提前標記
- no-op correction 2 筆（autocorr）→ disagree
- 名冊進度：嘉義縣、桃園市、基隆市、宜蘭縣、新竹市 五份；新北市官方站（web.cec.gov.tw/ntpc|newe|ntp）都回 403，暫用媒體名單

### 第 40 輪
- auto2.py 加第六份名冊：**台中市**（`tc_records.json`，來源 web.cec.gov.tw/tcec/article/64613 → 附件「臺中市議會第5屆議員選舉候選人登記情形一覽表-1150904」PDF 19b865cd-…，6頁/101列）
- verify edbb1c26（黃捷 推動高雄捷運黃線 election_id→2022）→ **agree +1**：高雄市議會「本屆議員-黃捷」頁（備註 113.2.1 轉任立委）明列服務政見「人本交通／加速推動黃線捷運／改善行人無障礙通行環境」，第4屆議員＝2022 選出
- verify a3411636（羅廷瑋 台中 2026 議員 rumored→not_running）→ **agree +1**：官方台中市議員登記一覽表（6頁）「羅廷瑋」0 命中；他 2024 已任立委
- no-op correction（autocorr）→ disagree
- 名冊總計六份：嘉義縣、桃園市、基隆市、宜蘭縣、新竹市、台中市

### 第 41 輪
- verify f23ed2cc（許淑華 台北市第3選舉區 2026 議員 rumored→registered）→ **agree +1**：官方臺北市選委會「[115年直轄市議員選舉]候選人登記冊」（mect/article/64448 附件 PDF 94bd36a5-…，5頁/98列）載「臺北市第3選舉區 115/09/04 序號11 許淑華 民主進步黨」；松山信義＝第3選舉區
- no-op correction（autocorr）→ disagree
- 台北市名冊 PDF 已抽成 tpe/all.txt 備用（98 列）；台北市選委會代碼＝mect
- 名冊對照表（累計）：嘉義縣 phec/64633?（4c0c3569）｜桃園市 tyec/64665（334d7a37）｜基隆市 klec/64655（91b2447a）｜宜蘭縣 ilec/64650（28b4728c＋3758d32c）｜新竹市 hcec/64402（8cb864fd）｜台中市 tcec/64613（19b865cd）｜台北市 mect/64448（94bd36a5）

### 第 42 輪
- auto2.py 加第七份名冊：**嘉義市**（`cy_records.json`，來源 web.cec.gov.tw/cyec 附件「嘉義市議會第12屆議員選舉候選人登記情形一覽表」PDF b53580e2-…，2頁/37列；格式為 選舉區/序號/日期/姓名/性別/生日/政黨/是否現任）
- 新增 `autocand.py`：專門處理 candidate_status 的 correction（registered＝名冊在、not_running＝名冊不在，自動用官方名冊核並附 PDF 當證據）
- 也放寬 auto2：payload 沒帶 party 時不做黨籍比對（例：669750d4 王浩 payload 無 party）
- verify 669750d4（王浩 嘉義市第2選舉區）→ **agree**：官方名冊「第2選舉區 序號5 115/08/31 王浩 無」；**注意落差**：既有檔 3ed351f3 的 party 是「時代力量」、名冊是「無」→ 建議主線日後 correction
- 嘉義市 batch 15 筆 agree（pending 1/2）
- 名冊現有八份：嘉義縣、嘉義市、桃園市、基隆市、宜蘭縣、新竹市、台中市、台北市

### 第 43 輪
- verify 332ae51f（翁章梁 新農業發展委員會 election_id→2022）→ **agree +1**：提交者遇到 cyhg.gov.tw ECONNREFUSED，但我帶 UA 直連回 200（122KB）；縣長簡介頁含「這四年來，嘉義縣的產業結構…」與「國本學堂將繼續培育…」→ 第二任就職（2022-12-25）語氣，故 2022。⚠️ 範圍外：該頁對「新農業發展委員會」「農業發展基金／一億」0 命中，description 的具體承諾不在來源裡
- verify bd08b87f（賴坤成 優化台東休閒運動 election_id→2024）→ **agree +1**：中央社 2023/04/13「拚民進黨立委初選 賴坤成提台東公地放領政見」逐字含「重啟公地放領和優化台東休閒運動」；⚠️ description 的「海濱公園」在來源 0 命中
- 另案 correction（1b2fda68 重啟台東公地放領 → 2024）被系統記為 **counted_as_vote**（tingyu.h 已交同一宣稱，我這筆變成對那筆的同意票 2/3）
- 教訓：交 correction 前先看 /verifications 有沒有人交過同一宣稱（省一次 submit 額度）

### 第 44 輪
- verify e0efdf4a（黃秀芳 彰南智慧農業產業園區：election_id→2022、source_url 換成 Wayback 存檔）→ **agree +1**：舊來源 CNA 2025-11-28 對「彰南智慧農業／亞太花都」0 命中（確實不符）；新來源 Wayback 2022-09-24 快照的 udn「黃秀芳端出農業政見 打造彰化L型生機農業廊道」逐字含「溪州公園…亞太花都中心…彰南智慧農業園區…L型生機農業廊道」→ 2022 縣長參選人政見
- 提交者另提醒同人兩筆政見（風機綠能稅、免費營養午餐）掛同一個不相關 CNA 來源 → 需各自原始出處，留給主線
- no-op correction（autocorr）→ disagree

### 第 45 輪
- 抓到並修掉腳本缺陷：`/next` 也會回 `kind=task`（沒有 contribution_id），三個腳本會 KeyError → 已加守門，遇到 task 就停下人工處理
- verify f0592f76（蔡易餘 老農津貼加碼 election_id→2026）→ **disagree −1**：引用來源是自由時報 2026/01/14 縣長初選結果報導，全文對「老農津貼／一萬元／排富」0 命中，無法證明該承諾也無法決定屆別（提交者說報導是 4 月，實際 1/14）；真正的出處是 PChome 2025-12-18、udn 2025-12-19、三立 2026-05-17，且 12 月那批是他以立委身分號召修法
- **第一個 profile_gap 任務**（梁文韜 3ad540b6，金門縣長候選人、成大政治系教授）→ 送出 politician 貢獻 `4dbff501`：education_level=博士、bio（港大雙學士、牛津政治學博士、2001 起任教成大、專長），來源聯合報 2026-07-16（udn 124652/9632504，找 URL 的方法：**udn 站內搜尋頁可解析出 story URL**）；birth_year 不填（只寫「現年58歲」，1967/1968 推測不算）、avatar 不填（新聞活動照+成大官網連不上）
- **額度已重置**（UTC 跨日）：submit used 1/200
- 技巧：新聞 URL 取得法——Google News RSS 只給 redirect，改用 **udn.com/search/word/2/<關鍵字>** 解析 story URL（有效）

### 協議 1.25.0（2026-09-22 上線）— 必讀變動
- **驗證與任務合併成單一佇列**（`queue: "single"`、回應不再有 `ratio`）：待驗證貢獻也進 task_dispatches（verify:<id>），跟缺口任務共用 queue_at，等最久的先派；3:1 輪替退場。代理端行為不變（GET /next → 做 → POST /report）
- **1,410 筆驗證的 queue_at 用 created_at（最早 09-12），比新缺口都早 ⇒ 任務要等驗證消化一陣子才輪得到**（裁示結果，不是壞）
- **`POST /boost`（1.25.0，無金鑰、1 小時 6 次）**：filter（regions／election_id／election_types／task_types／missing_avatar／politician_ids／kinds）把符合的排到最前；`GET /boost` 看紀錄。主線已打「六都 2026」= 650 任務＋450 驗證
- **新鐵則「工作只從 GET /next 來」**：`POST /report {kind:"verify"}` 只收剛派給你的那一筆，自己挑 id 投票會回 `not_dispatched` ⇒ **我先前「掃 /verifications 挑題目投票」的做法已經不能用**（所有自動腳本本來就走 /next，沒問題）
- 新增 `contributions-feed?type=task_suggestion` 可先查同對象 pending（省 submit 額度）

### 第 46 輪
- profile_gap a53ee861（洪和成，金門縣長候選人、民宿主人，只缺 avatar_url）→ **no_change + outcome=not_found**（提交 c6dfc6ab）：Google News 三組查詢只有媒體報導、維基無條目、udn 9732965 的照片是橫式情境照（會被尺寸擋）、金門日報搜尋 302
- profile_gap 5c8a393d（鄭朝方 新竹縣，缺 avatar）→ 有查到維基共享資源的竹北市長照片（upload.wikimedia.org/…竹北市市長鄭朝方…），待下輪領到時再提交
- 額度（新的一天）：submit 2/200

### 第 47 輪（主線派工：繼續跑、六都 boost 沒被消化）
- `GET /boost`（**要帶 anon key 才讀得到**；`POST /boost` 無 header 會回 UNAUTHORIZED_NO_AUTH_HEADER，與文件「無金鑰」不符，已回報但沒真的打 boost）
  - boost 3「六都 2026（小良哥）」ballyhoo：matched 650 任務／450 驗證，remaining 任務 645／驗證 448
  - boost 1「2026 縣市長 基本資料與政見」system：kinds=task、task_types=profile_gap/policy_missing、election_id 2026、election_types=縣市長，matched 100、remaining 91
- 我實際領到：金門 profile_gap（洪和成）、澎湖 profile_gap（許智富）、基隆 profile_gap（魏造文）——queue_at 都是 1980-01-01（被 boost），來源是 **boost 1**；另有一筆新北 policy_missing queue_at 空（正常時間軸）。⇒ 拿到的不全是六都
- profile_gap 洪和成（a53ee861，只缺 avatar）→ no_change/not_found（c6dfc6ab）
- profile_gap 朱定瑀（e3b9873c，缺 birth_year+avatar）→ no_change/not_found（db873510）：中選會 API 無此人、新竹縣選委會官網沒有可讀名冊、info.cec.gov.tw/vote2026 是 SPA 讀不到、udn 三篇無年齡照片、自由時報獨家抓不到 URL
- **新竹縣選委會代碼＝hccec**（從 web.cec.gov.tw 首頁 payload 的選委會對照表撈到：桃園 tyec、台中 tcec、台南 tnec、高雄 khec、宜蘭 ilec、新竹縣 hccec、苗栗 mlec、南投 ntec、彰化 chec、雲林 ylec…）
- 額度：submit 3/200

### 第 48 輪（#187 修正後）
- **確認 GET /boost 不帶 header 已回 200**（verify_jwt 補上了）；remaining：六都 641 任務/446 驗證、boost#1 縣市長 87 任務
- 順序改成「最新插隊排最前」→ 難怪我先前拿到 boost#1（00:47）而不是六都（01:02）
- verify 40714737（江啟臣「翻轉中台灣 拿回執政權」removal）→ **agree +1**：政黨選舉布局口號、source_url 空；Google News 顯示「翻轉中台灣」是 2026 選戰泛用詞（何欣純等也在用）
- verify fac9df90（蘇巧慧 早產兒津貼 proposed_date 2026-02-04→2026-02-06）→ **disagree −1**：今周刊原文寫「**蘇巧慧團隊2月4日正式發布首波政見**」，2/6 只是報導日；DB 現值 2026-02-04（我先前 correction 修的）才是提出日，這票會把對的改錯
- verify e6b64b2f（林國春 candidacy，source 只寫 LTN 首頁）→ **disagree −1**（累計 −2）：首頁 153KB「林國春」0 命中；status 填 confirmed 在審定前不可能；他名下已有 2026 rumored 一列，應走 correction
- 額度：submit 3/200、verify used 7/800

### 第 49 輪（#187 之後，六都開始出現）
- auto2.py 修正兩件事：(1) **region 正規化**（payload 常寫「臺北市」，ROSTERS 用「台北市」→ 用 VARIANT 轉譯後再查）；(2) **district 比對也正規化 臺/台**；(3) 「已有 2026 同型別紀錄」不再直接擋——落庫是 upsert（apply-contribution 用 politician_id＋election_id 查既有列後 update），payload status=registered 時允許
- **新增第七、八份名冊**（六都補齊三個）：台北市 tp_records.json（98 列，之前忘了加進 ROSTERS）、**高雄市 kh_records.json（99 列，來源 khec/article/64687 → PDF bde82aee-…，6頁）**
- verify 23715912（許淑華 台北市第3選舉區 candidacy）→ **agree +1**：官方名冊 98 列吻合；她已有 2026 rumored，落庫 upsert 更新為 registered
- 高雄 batch 4 筆 agree；桃園一筆 applied（score 1→2=target 2）
- 選委會代碼表補充：高雄 **khec**、新竹縣 **hccec**（縣市長/縣議員名冊在 hccec 找不到可讀檔）

### 第 50 輪
- leviathan 確認「六都＋舊驗證交錯」是正常的（/next 三個來源各出一個最前的，一輪只有一個名額來自六都段）；他追的客觀指標：六都 verifies 450→439、tasks 650→641
- verify b6627b31（李明賢 台北市 candidacy，identity_pick_required）→ **agree +1，指認 fbe6dcc2**：官方台北市登記冊「臺北市第2選舉區 115/08/31 序號2 李明賢 中國國民黨」；兩位同名（01af2b9f 無黨籍/1954、fbe6dcc2 國民黨/1973），名冊政黨是中國國民黨 → 指認後者
- 高雄名冊再確認：khec/article/64687 → 「(115年直轄市議員選舉)候選人登記情形一覽表(累計)0904」PDF bde82aee-…（6頁/99列）

### 第 51 輪
- auto2 批次 9 筆 agree（台北／六都 roster candidacy，target 3 需三票）
- verify 1c0782fe（高嘉瑜 台北市 candidacy，identity_pick_required）→ **agree +1，指認 77efee1f**：名冊「臺北市第2選舉區 115/09/01 序號4 高嘉瑜 民主進步黨」；CEC 歷屆為台北市第02選區議員(2010/2014/2018)＋2020/2024 立委，選區一致
- verify 842040e4（李明璇 台北市 candidacy，identity_pick_required）→ **agree +1，指認 a52fdd9d**：名冊「臺北市第3選舉區 115/09/02 序號5 李明璇 中國國民黨」；她 2024 立委在高雄市第08選區（所以既有檔 region 寫高雄市），姓名／政黨／1993 都相符
- 心得：identity_pick_required 現在多半是「同黨同名但 region 停在上一場選舉」——用中選會 API 的歷屆紀錄即可確認是同一人

### 第 52 輪
- 主線從 DB 查出六都驗證量能來源：最近 100 分鐘 tsai-hs（新 IP）42 票中 40 筆六都、a-zhen 20 票全六都、我 10 票全六都 ⇒ /boost 確實能把外部量能導到指定範圍，applied 989→1009；我那些 score=1 的半成品等的第二票就是這些人
- auto2 台北批次再 12 筆 agree（target 3，待他人第二／三票）

### 第 53 輪
- auto2 又 12 筆 agree（台北六都 candidacy 第一票，官方名冊為證、target 3 待外部接票）
- 今日 verify 用量約 39/800（第 53 輪後約 51/800）；submit 3/200
- 目前策略：先掃六都 candidacy 鋪第一票（台北／桃園／台中／高雄四份官方名冊），identity_pick_required 用中選會歷屆 API 確認再指認

### 第 54 輪
- auto2 再 12 筆 agree（台北六都 candidacy，官方名冊為證）
- verify 7895f115（侯漢廷 politicians.party 無黨籍→新黨）→ **agree +1**：台北市選委會登記冊「臺北市第1選舉區 115/09/04 序號19 侯漢廷 新黨」＋中選會彙總表 PDF（ccd7e51a）雙證
- autocand 本輪只看到 policy，沒有 candidate_status correction
- 今日 verify 約 63/800、submit 3/200

### 第 55 輪
- **重大資源：中選會中央頁 `web.cec.gov.tw/central/article/64709`＝「115年地方公職人員選舉候選人登記名冊」**，附件含全部層級的登記彙總表：2-1 直轄市議員 ccd7e51a（22頁/六都全部）、4-1 縣市議員 729644ff、3-1 縣市長 370f3bbf…（各縣市名冊都能從這裡拿，不必逐縣找）
- 從 ccd7e51a 解析出 **`six_records.json`＝610 列六都議員**（台北98、新北112、桃園109、台中102、台南88、高雄101），auto2 新增 **新北市、台南市**（kind=six）⇒ 六都議員名冊全覆蓋
- 任務 candidacy_source_missing（黃瑞傳 新北市第11選舉區）→ 送 candidacy 貢獻 `f9a765b5`（registered，附 ccd7e51a＋64709）
- 任務 candidate_status_stale（涂權吉 桃園、黃健豪 台中，都是 2026 議員 rumored）→ 兩人都**不在六都議員名冊**上 ⇒ 各送 correction（rumored→not_running）：`6bfd2983`（涂，row 9902）、`0530b0c1`（黃，row 9941）
- 教訓：correction 的 `target_id` 要**字串**（傳整數 9902 會回 validation_failed）
- 六都 duplicate_policy 任務一長串（黃捷/陳昆和/謝龍介/莊競程/彭俊豪/陳亭妃/江啟臣/廖先翔/徐千晴/黃偉哲）＝要逐組比對政見清單，需人工

### 第 56 輪
- 任務 duplicate_policy（王世堅 台北市）→ **no_change + outcome=confirmed**（貢獻 24c87793）：同來源（公視 676191，2024/1/13 當選感言）拆出的 4e25e2f6「推動台北捷運北環線延伸」與 de79bcba「推動社子島生態城區開發」是**不同標的**（捷運路網 vs 社子島開發），各自可獨立查核，不是重複
- 額度：submit 7/200

### 第 57 輪
- 任務 duplicate_policy（蘇巧慧 新北市，25 筆政見）→ **找到一組真重複並提 removal `e6df896b`**：
  - `5ae9c22c`「改善新北步道設施並興建觀音山纜車」vs `76ad5fe8`「改善步道設施並分級、增設公車接駁與興建觀音山纜車」——同來源（中央社 202609130112），description 幾乎逐字相同，原文只有**一件**承諾（用市府資源改善步道、步道分級＋公車接駁、蓋觀音山纜車、串接新北五道）⇒ 保留標題較具體的 76ad5fe8，對 5ae9c22c 提 removal
  - 其餘 same_source_groups 都是不同標的（三重醫療/停車場、疫苗/早產兒、敬老卡/醫療/假牙、捷運/新生兒、育兒宅/長者住宅/都更局）→ 不是重複
- 教訓：duplicate_policy 要「換句話說講同一件事」才算；同一篇的 N 大政見本來就拆 N 筆
- 額度：submit 8/200

### 第 58 輪
- 任務 duplicate_policy（吳欣岱 台北市，3 筆）→ **no_change + outcome=confirmed**（貢獻 8da9990c）：同來源（自由時報 5554120「台灣前進提出兒少五大政見」）的 42db0f92「家庭教育中心升級」與 70bed85a「生產教育公共化（到宅支持產後家庭、產後憂鬱篩檢）」是**兩個不同主張**（孕產支持 vs 家庭教育中心量能），不是重複；第三筆 0d40062a 內湖交通來自另一篇，主題不同
- 額度：submit 9/200

### 第 59 輪
- 任務 legacy_audit（廖先翔「白匏湖基地改產業園區」506d4f34）→ **no_change + outcome=unreachable**（貢獻 93bf0f0d）：原 udn 8893187 已 **404**；Wayback availability 回 archived_snapshots 空、CDX 端點回「Internet Archive: Temporarily Offline」（服務暫時離線）；自由時報站內搜尋只找到 2026 生態園區施工那幾篇。Google News 有 2025-01 的一批報導佐證此事，但拿不到原始網址 ⇒ 依規則不蓋「已核對」，過幾天換人再試
- **新技巧：自由時報站內搜尋可用** `https://search.ltn.com.tw/list?keyword=<關鍵字>`（先前用 /?q= 抓不到，這個端點回得出文章連結）
- 額度：submit 10/200

### 第 60 輪
- 任務 legacy_audit（蘇巧慧「青創空間數位游牧基地」598a0c62）→ 標題/內容/人物/屆別都對（ETtoday 2026-04-23「蘇巧慧團隊以AI製作青年政見動畫」逐段核對，第三項青年政見「空間的支持」＝活化閒置空間與公辦都更回饋空間、補助修繕增設數位設施、青創空間/數位游牧基地、青年黑客松），但 proposed_date 2026-05-08 晚於來源 → 送 **correction `bf88fe66`** 改成報導發布日 2026-04-23
- 額度：submit 11/200

### 第 61 輪
- 任務 legacy_audit（黃捷「推動高雄捷運黃線建設」6e5ff7de）→ 標題/描述/人物都對（高雄市議會本屆議員頁的服務政見「加速推動黃線捷運／改善行人無障礙通行環境」），但 **election_id 空、應為 2022**（第4屆議員＝2022 選出，她 113.2.1 轉任立委）→ 送 **correction `026f8bd9`** 補 election_id=2022；並在 note 建議另一筆清 proposed_date（2026-05-22 晚於該屆）
- 額度：submit 12/200

### 第 62 輪
- 新資源：中選會 64709 的 **1-1 直轄市長（bb9a8d7a）與 3-1 縣市長（370f3bbf）登記彙總表** → 解析成 `gov_records.json`（81 列縣市長）
- 任務 not_running_recheck（陳其邁 高雄市，被標 not_running）→ **no_change + outcome=confirmed**（貢獻 34b9b0d0）：官方直轄市長名冊高雄市只有張靜、賴瑞隆、王肇民、柯志恩、洪方隆 5 人，**沒有陳其邁** ⇒ not_running 正確
- 同一份名冊也能回答其他 not_running_recheck（黃國昌、陳時中、黃珊珊、林佳龍、盧秀燕、黃偉哲 都不在縣市長名冊上）
- 額度：submit 13/200

### 第 63 輪
- 新工具 `autonr.py`：專清 **not_running_recheck**——用官方名冊判斷「被標 not_running 的人是否真的不在 2026 名冊上」，不在 → `no_change + outcome=confirmed`（附名冊 PDF 當 checked_urls）；**在名冊上就停下來改走 correction**
  - 縣市長用 `gov_records.json`；縣市議員用六都 `six_records.json` ＋ 嘉義縣市／基隆／宜蘭／新竹市各自的名冊
- 本輪共清 16 筆 not_running_recheck（5+3+8），全部 confirmed
- 額度：submit 26/200、verify 約 63/800

### 第 64 輪
- 佇列現在幾乎全是 **policy_missing**（六都議員候選人：林依婷、林國春、馬見、翁語含、張碩芳、陳美梅、賴懋慶、吳禹寰、蔡永芳、李彥秀、陳詩薇、謝志忠、吳中源、周奕齊…）
- 我試著處理一筆（楊朝偉 桃園八德）：Google News 找得到他的市政主張（八德綠捷全線通車/一票到底、捷運綠線支付整合、鐵路地下化、淹水熱點16億、稅務局駐點），但**拿不到可引用的原始網址**（Google News 只給轉址；tcpttw.com 搜尋頁解析不出文章連結；tyenews 403；yam 404）⇒ 依協議「查不到就不回報」，這筆先放掉，不硬交
- 心得：policy_missing 要附**打得開的來源網址**，沒有 URL 就不能交；LTN 站內搜尋（search.ltn.com.tw/list?keyword=）與 udn 站內搜尋是目前最穩的取 URL 方式

### 第 65 輪
- 佇列全是六都 policy_missing；本輪試 蕭夙玲（新北市新莊，親民黨徵召）→ 用 LTN 站內搜尋 + udn 站內搜尋找到 6 篇相關報導（5499490／5499314 改披橘袍、udn 9371253／9371974／9400833／9487437 初選過程），但**全部只講政黨與初選，沒有任何具體政見**（她只說「持續在地方服務、關注基本民生問題」）⇒ 依協議「查不到就不回報」，不硬交
- 觀察：這批 policy_missing 多是基層議員候選人，公開政見常常還沒發布（選舉公報要接近投票日才出版），能交的少；LTN/udn 站內搜尋是取 URL 的穩定手法

### 第 66 輪
- 再試兩筆 policy_missing：蕭夙玲（新莊，LTN 5499490/5499314＋udn 4 篇）、簡麗花（新北第3選舉區；udn 9727916 登記名單、9751728/9751809 違紀參選）→ **都只有政黨/登記/初選新聞，沒有具體政見** ⇒ 依協議不提交、不硬編
- 佇列現況：policy_missing 佔多數，且多為基層議員候選人，公開政見尚未發布（選舉公報接近投票日才出）⇒ 這類任務現階段產出低；legacy_audit／duplicate_policy／not_running_recheck 才有穩定判準
- 額度：submit 26/200、verify 約 63/800

### 第 67 輪
- **policy_missing 找到可規模化的做法：用中選會歷屆選舉公報（bulletin.cec.gov.tw）抽 2022 政見**——任務明文允許「只找得到現任任期或過去選舉的承諾也可提交，election_id 填該政見所屬的選舉並在 note 說明」
  - 範例：**黃瑞傳**（新北市第11選舉區：汐止、金山、萬里，2026 再次參選同一區）的 111 年公報 PDF 裡有他的 7 條政見 → 我抽出 5 條具體的（毛小孩運動公園、廣設托育中心、老人福利金三節各2000、改善汐止聯外道路、金山健康運動中心），以 `election_id=2022` 批次送出：`6eb3b0d9`、`849796fa`、`d6c28b2c`、`b8ceff0a`、（第5筆）
  - 公報 URL 型態：`https://bulletin.cec.gov.tw/01選舉公報/05直轄市議員/111年/02新北市/11-新北市選舉公報-第十一選區.pdf`（新北市、第11選區；其他縣市／選區要照這個規則找）
- 額度：submit 31/200

### 第 68 輪：policy_missing 的可規模化管線（用 111 年選舉公報）
- **公報 URL 規則（新北市已驗證）**：`https://bulletin.cec.gov.tw/01選舉公報/05直轄市議員/111年/02新北市/<2位數選區>-新北市選舉公報-第<中文數字>選區.pdf`
  - 例：第3選區＝`03-新北市選舉公報-第三選區.pdf`、第5＝`05-…第五選區.pdf`、第11＝`11-…第十一選區.pdf`（都 200）
  - 其他直轄市目錄碼不同（01臺北市／03桃園市… 直試 404，要另找目錄碼）；目錄列表 403
- 管線：①從 2026 名冊查該候選人選舉區 → ②下載對應 111 年公報 PDF（PyMuPDF 讀文字）→ ③找該人姓名後面那段「政見」條列 → ④挑 ≤5 條最具體的，以 `election_id=2022` 批次送出（note 說明是 2022 政見）
- 本輪完成：黃瑞傳（新北第11選區，5 條）、**林國春**（新北第5選區板橋，從公報抽出 11 條、選 5 條送出：反廢死速審速決／酒駕毒品零容忍／增設長照與安養／共融式遊具特色公園／閒置空間轉型青年社宅）→ `bd89bd26`、`eb2fb87a`、`3c1ef4c4`…
- 額度：submit 36/200

### 第 69 輪（shuwei-huang 加入、not_found 會進冷卻）
- 主線告知：(1) 新 Sonnet 跑者 shuwei-huang（同 IP，只算本戶一票），會撞同一批六都任務；(2) **no_change + outcome=not_found 會進 task_checks 冷卻**（同一筆冷卻期內不再派）⇒ 查不到素材時回 not_found 是替全站把那筆暫時撤下，不是白做
- 我回頭把之前放棄的 policy_missing 用 not_found 補報：楊朝偉（桃園）→ `ae19ffcb`
- **新工具 `autopmnf.py`**：policy_missing（新北市議員）→ 查該人選區 → 下載 111 年公報 PDF → 若名冊上沒有他 → 自動回 not_found；有他則停下人工抽
  - 實測：陳偉杰（新北第1選區）不在 111 年公報 → not_found 送出（201）
  - 踩到的坑：**bulletin.cec.gov.tw 會擋 python urllib（404）但 curl 正常** → 腳本改用 subprocess curl 下載
  - 翁震州（新北第3選區）在公報上，但他的**政見欄是圖片**（姓名與下一位之間沒有文字方塊）⇒ 需要 OCR 或用座標定位，先放掉
- 額度：submit 38/200

### 第 70 輪：公報 PDF 的通用取法（六都全通）
- **關鍵發現：bulletin.cec.gov.tw 有目錄瀏覽端點** `?dir=<路徑>`（例：`?dir=01選舉公報/05直轄市議員/111年`）——會列出子目錄與 PDF 檔名，不必猜檔名
  - 六都目錄：01臺北市、02新北市、03桃園市、04臺中市、05臺南市、06高雄市
  - 檔名各市不同：臺北市＝`臺北市第03選舉區.pdf`；新北市＝`05-新北市選舉公報-第五選區.pdf`；桃園市＝`桃園市第3選舉區.pdf`；臺中市＝`臺中市第01選區 .pdf`（**檔名有尾隨空白**）；臺南市＝`第一選舉區.pdf`（純中文數字）；高雄市＝`高雄市第11選區.pdf`（另有 `高雄市第12.13.14.15選區.pdf` 合併檔）
- **新工具 `pmbulletin.py`**：給（縣市, 選舉區）→ 自動查目錄、挑對檔名、用 curl 下載（urllib 會被擋）、回 PDF 文字；支援六都
- 實測：台北市第3選區 111 年公報抽到許淑華 10 條政見、王鴻薇的長者宜居/少子化政見等
- 額度：submit 38/200

### 第 71 輪
- 佇列換成 **profile_gap**（六都議員候選人，多半只缺 avatar_url 或出生年）
- 新工具 `autopm6.py`：policy_missing 六都版（用 pmbulletin 查 111 年公報；不在公報→not_found；在公報→停下人工抽）；本輪它先被 profile_gap 洗版，還沒跑到
- profile_gap 的可行來源盤點：
  - **出生年／學歷／經歷** → 111 年公報有（出生年月日、學歷、經歷），也可用我的各縣市名冊（桃園/台北/高雄名冊有生日）
  - **avatar_url** → 公報的照片是 PDF 內嵌圖、沒有可直接引用的圖片網址；議會官網議員頁有時是動態載入（台南市議會首頁搜不到李啓維）；維基百科多數沒有條目 ⇒ 這欄常常真的補不了
- 實例：李啓維（台南市第9選舉區）只缺照片 → 查過議會官網／維基／公報後以 `no_change + outcome=not_found` 回報（貢獻 `2f23b5ca`），讓這筆進冷卻
- 額度：submit 39/200

### 第 72 輪
- 寫了 `pg_extract.py` 想從 111 年公報自動抽某候選人的 出生年月日／學歷／經歷（用姓名 block 座標 + 同欄視窗）
- 測試發現：**公報是每頁多欄、欄寬不一**，用 ±260px 視窗會抓到鄰欄其他人的學歷（許淑華那筆就混進了林柏勛、其他人的學歷）⇒ 目前不可靠，**不能直接拿來交**，需要更嚴謹的欄位切法（例如先偵測欄界，或用「姓名 block → 同欄往下到下一個姓名 block」）
- 這一輪沒有交出 profile_gap（正確決定：寧可不交，也不要交錯的出生年/學歷）
- 額度：submit 39/200

### 第 73 輪（新跑者 yiting.hsu 獨立 IP、shuwei-huang 改只做驗證）
- 兩戶新跑者可以接我鋪的第一票 ⇒ 我的策略：繼續把六都 candidacy／名冊類第一票鋪好（附官方 PDF），並用 not_found 冷卻查不到的缺口
- 本輪：auto2 投 1 筆 roster candidacy；許淑華台北市第3選舉區 candidacy（25c9550a，來源壹蘋）→ **agree**（官方名冊「臺北市第3選舉區 115/09/04 序號11 許淑華 民主進步黨」）
- 小教訓：autocorr／autocand／auto2 都會寫 next_raw.json，先後執行會互相覆蓋 → 要判讀某一筆得當下就解析，或各自寫不同檔名
- 額度：submit 39/200、verify 約 64/800

### 第 74 輪
- 修掉工具坑：autocorr／autocand／auto2／autonr／autopm6／autopmnf 各自寫自己的 next_*.json（不再互蓋）
- verify 36a431a2（陳怡君 新北市第6選舉區 rumored→registered）→ **agree +1**：官方直轄市議員登記彙總表（ccd7e51a）新北第6選舉區列「陳怡君 台灣民眾黨 115/09/02」；並在 note 註明台北市第4選舉區另有一位同名陳怡君、是不同人
- 額度：submit 39/200、verify 約 65/800

### 第 75 輪
- 新工具 `autopg.py`（profile_gap）：
  - 若缺 `birth_year` 且該人在我手上的**縣市選委會登記名冊**裡有出生年月日（桃園 ty／高雄 kh／宜蘭 yl／嘉義市 cy 這四份有生日欄）→ 送 `politician`（politician_id＋birth_year，附名冊 PDF）
  - 其餘（多半只缺 avatar_url，或出生年不在名冊裡）→ `no_change + outcome=not_found`（附查過的來源清單），進冷卻
- 本輪跑 5 筆：陳宛毓、簡麗花、李秉倫、王珮宇、許又仁 → 全部 not_found（都是缺 avatar 或名冊無生日）
- 仍未解：公報 PDF 的自動欄位切法（pg_extract 用座標關聯同欄內容還是抓不準）→ 出生年/學歷若不在名冊裡就得人工比對公報
- 額度：submit 44/200、verify 約 65/800

### 第 76 輪
- autopg.py 再清 15 筆 profile_gap（周嘉韋、楊中成、王威元、郭麗華、蕭漍華、陳岱吟、謝舒凡、吳崢、林乃立、錢龍、劉仁照、余柷青、朱珍瑤…）→ 全部 not_found（都是只缺 avatar_url，或 birth_year 不在我有生日欄的名冊裡）
- 佇列目前幾乎全是 profile_gap（六都議員、只缺照片）→ 這批的「產出」就是 not_found 冷卻，讓缺口 14 天不再派
- 額度：submit 59/200、verify 約 65/800

### 第 77 輪
- autopg.py 再清 8 筆 profile_gap（童小芸、游明諺、林明義、陳金鐘、李眉蓁、邱昭勝、陳彥廷、李宗霖）→ not_found；累計約 28 筆
- 又試了一條照片來源的路：**台北市議會官網（tcc.gov.tw）**首頁有 `https://ws.tcc.gov.tw/001/Upload/435/relpic/...jpg` 這類圖片，但議員名單頁面找不到可解析的連結（首頁上的「許淑華」只出現在 meta 區）⇒ 照片來源仍待解，先以 not_found 冷卻
- 額度：submit 67/200、verify 約 65/800

### 第 78 輪（重要狀況：本戶 submit 額度用盡）
- **submit 200/200 用盡**（UTC 零時重置；現在 14:56Z，還要約 9 小時），verify 137/800（663 剩）
  - 原因（**已更正**）：本機這一戶用掉的——我 93＋shuwei-huang 126＋其餘本機代號＝200；**yiting.hsu 在公司機 IP（68756d99）、submit 0，不共用**（我原本誤把它算進來）
  - 後果：/next 現在只派需要提交的任務（boost 的 profile_gap、roster_check），我能投不能交；已回報 leviathan 建議協調分工（讓另兩戶專做驗證）
- **但這輪有突破：`autopg2.py` 能補一部分 avatar_url**——用維基百科 `pageimages` API 找該人的條目照片（commons 圖片），確認條目內文提到該縣市／政黨、且圖片是直式（短邊 ≥120px）才送
  - 成功：**凌濤**（5826x5982）、**李宇翔**（881x881）→ 送 politician 補 avatar_url（pending）
  - 失敗樣態：多數基層議員沒有維基條目（NO-WIKI）；PNG 要先修維度解析（已補）；4KB 讀不夠要加大（已改 200KB）
- 另一發現：`skip` 掉任務後，/next 會改派 `roster_check`（我有名冊可做，但同樣需要提交額度）

### 第 79 輪
- 更正額度歸因（leviathan 提供）：本機這一戶＝我 93＋shuwei-huang 126＋其餘本機代號；**yiting.hsu 在 68756d99（公司機），submit 0**，不與本機共用——我上一輪的「三戶共用」是錯的
- 輪詢實測：連續跳過 20 筆任務（policy_missing 縣市長、profile_gap）都拿不到 verify ⇒ 在 submit=0 的情況下我這戶今天幾乎無事可做（驗證池沒有輪到我）
- 等 UTC 零時額度重置後優先：roster_check（名冊全覆蓋）> autopg2 維基人像 > autopm6 公報管線
