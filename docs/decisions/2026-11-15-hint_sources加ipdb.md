- **profile_gap 的 hint_sources 對當屆村里長、鄉鎮市民代表、直轄市山地原住民區民代表多給 ipdb.tw（2026-11-15，team-lead 交辦，不升協議版，`20261115010000`，守門 `profile-gap-hint-ipdb.test.ts`）**：
  - 緣由：Grok 代理（gk01）從 ipdb.tw 的候選人照片庫補了 100 多張照片，找到率約 98%；不知道這個來源的 Haiku 代理找到率在 10% 以下。正式庫近 3 天含 ipdb.tw 的 applied 交件約 440 筆，用的代理十多個，現有人物照片網域中 ipdb.tw 已是第 4 大（288 張，前三為 ws.moi.gov.tw、elections.olc.tw、info.cec.gov.tw）。讓所有代理一開始就知道有這個來源。
  - 做法：新 migration 重貼 `contribution_auto_tasks_raw()`（前一版＝`20261019120000_roster_reconcile.sql`），只在 profile_gap 那一臂的 hint_sources 後面接一段（檔內標 ★）：`election_id = 2026` 且 `election_type` 為村里長、鄉鎮市民代表、直轄市山地原住民區民代表時多一條 `ipdb.tw（政精選，2026 候選人照片／號次）`。只給網域、不給路徑（小良哥 11-13 裁示）。其他職位、其他屆別、其他臂維持原三條。task_id、target、說明、reward、region 一字不動。
  - 不動：網站訪客按鈕建的任務（`request-task.ts`，另一組「所屬機關官網、ly.gov.tw 立委個人頁、cec.gov.tw 選舉公報」）。正式庫有 87 件是這一組，來源已查實，這次不碰。
  - **授權查核結果（2026-11-15，只看公開頁面，各項為事實陳述，不是法律意見）**：
    - 經營者：站名「政精選」，自稱實驗階段的獨立專案，頁面沒寫經營者。資料來源列中選會選舉資料庫與選舉公報、立法院等政府開放資料；政見與學經歷是公報原文 OCR。
    - 照片：由它自己託管（`https://ipdb.tw/candidate-photos/<id>.png`），頁面沒寫出處，推測取自選舉公報，**未證實**。
    - 條款：服務條款、隱私權政策、使用說明都沒有照片授權、CC、轉載或禁止爬取的字句。
    - robots.txt：對一般爬蟲 Allow；Cloudflare 內容訊號 `search=yes、ai-train=no、use=reference`；ClaudeBot、anthropic-ai、Claude-Web、GPTBot 等訓練爬蟲被 Disallow。
  - **灰區（要讓下一個人知道）**：
    1. 站方沒有任何照片授權聲明；它也不是照片的原始權利人（權利在公報與候選人）。這點與 elections.olc.tw 等其他第三方來源同性質。
    2. 我們存的是照片網址、前端直接連它的圖檔（熱連結），不是下載後訓練。用途接近 `search／use=reference`，但站方沒明講允許。ClaudeBot 被 robots Disallow，是針對訓練爬蟲；代理是人為指派去查單頁，不是批次爬站，仍請維持「看單頁、不大量抓」。
    3. 站是個人實驗專案，圖檔可能搬家或下架，存庫的網址會失效。
  - **另案建議（本 PR 不做）**：把已採用的第三方照片轉存到我們自己的 storage，一次解掉熱連結與失效兩個風險；轉存前要先決定授權立場，可先問站方。
  - 範圍外、沒改：協議（`public/skill.md`、`skill-types.md`）對照片來源本來就沒有「只准官方公報」的規定，這次也不加。
