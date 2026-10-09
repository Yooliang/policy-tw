# #345「資料表：參選」瘦身：盤點與分階段計畫

日期：2026-10-09　狀態：只交盤點與計畫，**沒有改程式**，等主線裁決。
正式庫唯讀查詢（`SET default_transaction_read_only = on;`）。

## 1. 盤點（正式庫）

`politician_elections` 現有欄位：id、election_id、politician_id、`position`、`slogan`、`election_type`、region_id、verified、verified_at、verified_by、source_note、cand_no、candidacy_status、withdrawn_after_filing、party_id、party_basis。（`region`／`sub_region`／`village` 文字欄已不在。）

| 項目 | 數字 |
|---|---|
| 總列數 | 17,573 |
| `position` 非空 | 17,573（100%，NOT NULL） |
| `election_type` 非空 | 17,573（100%） |
| `slogan` 非空 | **1 列**（id 1：「壯闊台灣，改變台北」）；`politicians.slogan` 非空 5 位 |
| `region_id` 非空 | 17,406 |
| 各屆列數 | 2022：15,535／2026：1,717／2024：318／election 4：3 |

### position（職稱）：不是乾淨的資料
- 不同寫法 112 種。
- 「…候選人」這種泛稱 16,253 列（92%）；整串是選舉名稱（「111年直轄市長選舉」）945 列；是選區名稱（「宜蘭縣第10選舉區」）251 列；其餘 172 列是現任式寫法（「新竹縣縣長」「台中市市長」，另有「民眾黨主席」「前台北市黨部主委」這類根本不是職稱的）。
- 結論：`position` 能推出的資訊（選舉別、縣市、選區）都已經在 `election_type`＋`region_id`／選區裡；它額外帶的是來源自由填的雜訊。前端早在 `lib/participation-label.ts` 改成「由選舉別＋縣市組顯示名稱，不照抄 position」，position 只剩 fallback。**沒有發現 position 獨有、推不出來的事實**，唯一例外是 2024 總統／副總統兩列用 position 區分（`participationLabel` 與 `pkGroupLabel` 讀它），這要先找新家（見 4）。
- 與 election_districts 對應不起來：`politician_elections` 有 13,785 列在 `election_districts` 找不到同 (election_id, election_type) 的選區列（村里長為主），所以「從選區表推職稱」目前覆蓋不全，不能當唯一來源；職稱要由 `election_type` 推（`縣市長`→縣市長候選人…）。

### election_type：是參選事實，不是 elections 的屬性
- `elections.election_types` 是陣列（一屆含多種選舉別）；`politician_elections.election_type` 17,573 列全部落在所屬屆別的陣列內（違反 0 列）。
- 但 election_id 只能推出「這屆有哪幾種」，推不出這位候選人報的是哪一種（2022 就同時有縣市長、議員、村里長…）。所以 **election_type 不能由 election_id 推，是參選紀錄本身的屬性，建議保留**（日本站參選表也保有同類欄位）。不是瘦身對象。

### slogan（口號）
- 參選紀錄上只剩 1 列有值，等於已死欄位；貢獻者寫的口號走 `politicians.slogan`（`apply-contribution` 只寫 politicians，不寫 pe）。
- **不需要新家**（人物×選舉的競選資料表不必建）。若維護者日後想要「每屆口號」，再另案；這次不建表。

## 2. 讀寫點盤點（repo）

### 讀 `politician_elections.position`／`slogan`
前端（約 14 處）：`composables/useSupabase.ts`（mapPolitician 兩處、currentElection）、`lib/participation-label.ts`、`lib/policy-compare.ts`（總統／副總統判斷）、`lib/party-pages.ts`、`lib/politician-office.ts`、`lib/md/{politician,region,scope}.ts`、`lib/election-breadcrumbs.ts`、`pages/ElectionPage.vue`（位置＋副總統排序）、`pages/PoliticianProfile.vue`（列表顯示 `elec.position`、slogan 兩處）、`pages/AdminDuplicates.vue`、`pages/PolicyDeepAnalysis.vue`、`lib/ssg/server-data.ts`（slogan）、`types.ts`（4 處）。
Edge Function／共用模組（約 12 處）：`task-context.ts`（給代理的任務脈絡，5 處輸出 position，**代理看得見**）、`reassign-candidacy.ts`、`identity-normalize.ts`（身分比對金鑰 `position` 類，會影響去重）、`apply-precheck.ts`、`electoral-district.ts` 與 `council-district-guard.ts`（舊交件的選區從 position 抽）、`contribution-summary.ts`／`history.ts`（欄位中文名）、`contributions-feed`、`candidate-import.ts`。
SQL：`20261007030000_election_read_side.sql` 的視圖與 `politicians_with_elections` 函式（輸出 position、slogan、election_type 並做新舊對照）；`20261007020000_reassign_merge_followups.sql`（merge 時逐欄搬移 `position`、`slogan`…）；另約 20 支 2026-10 migration 的派工臂、activity window 函式引用 `pe.position`／`pe.election_type`（`candidacy_status_stale`、`not_running`、`ballot_numbers`、`cec_registrations`、`rep_district_ballot_unit`、`village_chief_progress_cooling`、`arms_perf`…），多數是 election_type，需逐支確認有沒有真的讀 position。
腳本／同儕：`scripts/arms-parity-*.ts`、`scripts/term-policy-parity.*`、`scripts/dedupe-2026*`、`scripts/2026-registered-dryrun.mjs`、`scripts/import-2026-registered.sql`（一次性，寫 position）。

### 寫
- `apply-contribution.ts`：新建參選紀錄時 `position: str(p.position) ?? "<選舉別>候選人"`（約 544、613、628、1602 行）；`update`／切換選舉別時一併改 position；correction 白名單 `CORRECTION_FIELDS.politician_elections` 含 `position`、`election_type`（`contribution-schema.ts`）。
- `candidate-import.ts`、`cec-sync.ts`、`fetch-cec-data`（position 預設值產生處）。
- `slogan`：只寫 `politicians.slogan`（`apply-contribution` 207、226 行），不寫 pe。
- **協議交件欄位**：payload 的 `position`、`slogan`（`contribution-schema.ts` 325、343 行）、`public/skill.md`（508、862 行）都對外公開；改了要升協議版號並讓外部代理重學。

### 與派工臂／代理的關係
`task-context.ts` 把 position 放進給代理的脈絡，`electoral-district.ts` 靠 position 字串補選區，`identity-normalize.ts` 拿 position 當身分金鑰。這三條不只是顯示，改了會動到派工輸出、選區統一寫法與去重判斷。

## 3. 為什麼這次不動程式

任務條件「第一階段牽動太廣（超過 15 處讀取、或派工臂要改）就只交計畫」：
- 讀取點合計約 30 處（前端 14、共用模組 12、SQL 視圖／函式 3 組、腳本 8 支），超過 15。
- 派工脈絡（`task-context`）、身分比對金鑰（`identity-normalize`）、選區抽取（`electoral-district`）都吃 position，動它們等於改派工輸出與去重行為，需要連動測試與派工臂對照（`arms-parity`）。
- `politicians.position` 仍是 NOT NULL，`apply-contribution` 1599 行建人物時用 pe.position 當預設；這條與 #346 人物表瘦身互相咬合，先後順序要主線排。
- 協議對外欄位不可動（升版屬維護者裁決）。

## 4. 建議的分階段計畫（供主線裁決）

**範圍結論**：真正要瘦的只有 `position` 與 `slogan`；`election_type` 保留。

**階段 1（只加不刪、不改協議）**，建議拆三個小 PR，各自可獨立還原：
1. 讀取端統一走 `participationLabel`（由 election_type＋region_id 組）；`position` 只留總統／副總統的區分（其餘不讀）。總統／副總統區分建議改由 `cand_no` 或新增明確標記解決（待裁，見下），在那之前保留讀 position 的那兩行。
2. 寫入端：交件仍照收 `position`／`slogan`（協議不動），落庫時 pe.position 改成「由 election_type 推的標準值」（`<選舉別>候選人`，總統副總統特例），不再存來源自由文字；選區仍由 `electoral_district` 欄與抽取邏輯處理。`slogan` 落庫維持只寫 politicians。
3. 資料整理：一次回填把 pe.position 正規化成標準值（這是資料面變動，依「資料走流程」原則應由流程處理或維護者點頭，不在本 PR）；`task-context` 的代理脈絡改輸出標準值並加守門測試。

**階段 2（DROP，另開 PR，隔天以上）** 條件：
- 階段 1 上線後 `grep` 全 repo、正式庫 `pg_depend`／函式本文對 `pe.position`／`pe.slogan` 為 0 筆讀取（含視圖、函式、派工臂、腳本）。
- 協議是否同步移除 `position`／`slogan` 欄位說明由維護者裁決（會升版，外部代理重學）。
- 備份：DROP 前把 `slogan` 那 1 列與 position 原值留一張 archive 表（比照 `politician_election_votes_archive`），確認不需要後再 DROP。
- 順序：先改所有函式／視圖不再引用 → 再 `ALTER TABLE ... DROP COLUMN`（`position` 的 NOT NULL 先放寬）。

## 5. 待裁項
1. 總統／副總統區分：2024 兩種候選人靠 position 字串區分，要不要加明確欄位（例如 `cand_role`）或用 `cand_no`，還是接受唯一保留 position 讀取。
2. 是否把 pe.position 回填成標準值（資料面）以及由誰做（資料走流程原則）。
3. 協議欄位 `position`／`slogan` 要不要移除說明（升版）。
4. 是否要「每屆口號」功能；沒有就讓 `pe.slogan` 那 1 列併進 `politicians.slogan`（該人若尚無口號）後 DROP，不建新表。
5. 與 #346 人物表瘦身（`politicians.position` NOT NULL）的先後。
