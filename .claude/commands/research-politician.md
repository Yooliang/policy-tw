# 研究政治人物並新增政見

此指令會先搜尋網路上的政治人物資訊，確認其身份後將政見資料寫入 Supabase。

## 使用方式

```
/research-politician <政治人物名稱> [地區]
```

例如：
```
/research-politician 蔣萬安 台北市
/research-politician 陳其邁
```

## 執行流程

### 階段一：身份驗證

1. **網路搜尋** - 使用 WebSearch 查找該人物的政治背景：
   - 搜尋關鍵字：`{name} 政治人物 {region} 政見 2024 2025 2026`
   - 確認是否為現任或參選的政治人物
   - 收集基本資料：黨籍、職位、地區

2. **資料庫比對** - 檢查 Supabase 是否已有此人：
   ```sql
   SELECT * FROM politicians WHERE name = '{name}'
   ```

3. **結果處理**：
   - 若已存在：顯示現有資料並詢問是否更新
   - 若不存在：詢問是否新增此政治人物

### 階段二：政見收集

1. **搜尋政見資訊** - WebSearch 查找：
   - `{name} 政見 承諾`
   - `{name} 政策 施政`
   - `{name} 競選 主張`

2. **列出找到的政見**，包含：
   - 政見標題/主題
   - 提出時間（如有）
   - 來源連結

3. **使用者確認** - 詢問要新增哪些政見

### 階段三：資料寫入

#### 新增政治人物（若不存在）

```sql
INSERT INTO politicians (id, name, party, status, election_type, position, region, avatar_url)
VALUES (
  'politician-{uuid}',
  '{name}',
  '{party}',
  'politician',
  '{election_type}',
  '{position}',
  '{region}',
  'https://via.placeholder.com/150'
)
RETURNING *
```

#### 關聯選舉（若適用）

```sql
INSERT INTO politician_elections (politician_id, election_id)
VALUES ('{politician_id}', 'election-2026')
ON CONFLICT DO NOTHING
```

#### 新增政見

對每個確認的政見執行：

```sql
INSERT INTO policies (id, politician_id, title, description, category, status, proposed_date, last_updated, progress, tags)
VALUES (
  'policy-{uuid}',
  '{politician_id}',
  '{title}',
  '{description}',
  '{category}',
  'Campaign Pledge',
  '{proposed_date}',
  CURRENT_DATE,
  0,
  ARRAY['{tag1}', '{tag2}']
)
RETURNING id, title
```

#### 新增追蹤日誌

```sql
INSERT INTO tracking_logs (id, policy_id, date, event, description)
VALUES (
  'log-{uuid}',
  '{policy_id}',
  '{proposed_date}',
  '政見提出',
  '於 {source} 首次提出此政見'
)
```

## 分類對照表

| 關鍵字 | category |
|--------|----------|
| 交通、捷運、公車、道路 | Traffic |
| 社福、長照、托育、補助 | Welfare |
| 經濟、產業、就業、招商 | Economy |
| 教育、學校、課綱 | Education |
| 環保、綠能、減碳、空污 | Environment |
| 居住、房價、社宅 | Justice |
| 行政、效率、數位 | Administration |
| 政治、選舉、民主 | Political |

## 狀態判斷

| 情境 | status |
|------|--------|
| 競選承諾/尚未當選 | Campaign Pledge |
| 已提案/進入審議 | Proposed |
| 開始執行 | In Progress |
| 完成 | Achieved |
| 延宕/卡關 | Stalled |
| 放棄/跳票 | Failed |

## Supabase 設定

- **Project ID**: `wiiqoaytpqvegtknlbue`
- 使用 `mcp__plugin_supabase_supabase__execute_sql` 工具執行 SQL
- 使用 `mcp__plugin_supabase_supabase__list_tables` 確認表結構

## 輸出格式

完成後顯示摘要：

```
✅ 政治人物：{name}
   黨籍：{party}
   地區：{region}

📋 新增政見：
   1. {policy_title_1} ({category})
   2. {policy_title_2} ({category})
   ...

🔗 資料已寫入 Supabase，可在網站查看：
   https://policy-tw.web.app/politician/{politician_id}
```
