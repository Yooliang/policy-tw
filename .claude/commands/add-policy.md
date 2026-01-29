# 新增政治人物政見

此指令用於查找政治人物並將其政見資料寫入 Supabase 資料庫。

## 使用方式

```
/add-policy <政治人物名稱>
```

## 執行流程

### 1. 查找政治人物

首先在 Supabase `politicians` 表中查找該人物：

```bash
# 使用 MCP Supabase 工具查詢
mcp__plugin_supabase_supabase__execute_sql({
  project_id: "wiiqoaytpqvegtknlbue",
  query: "SELECT * FROM politicians WHERE name LIKE '%{name}%'"
})
```

如果找不到，詢問使用者是否要新增該政治人物。

### 2. 查詢現有政見

找到政治人物後，列出其現有政見：

```bash
mcp__plugin_supabase_supabase__execute_sql({
  project_id: "wiiqoaytpqvegtknlbue",
  query: "SELECT id, title, status, proposed_date, category FROM policies WHERE politician_id = '{politician_id}' ORDER BY proposed_date DESC"
})
```

### 3. 收集新政見資料

向使用者詢問以下資訊：
- **政見標題** (title)
- **政見描述** (description)
- **分類** (category): Traffic, Welfare, Economy, Education, Environment, Justice, Administration, Political
- **狀態** (status): Campaign Pledge, Proposed, In Progress, Achieved, Stalled, Failed
- **提出日期** (proposed_date): YYYY-MM-DD 格式
- **標籤** (tags): 用逗號分隔的關鍵字

### 4. 寫入 Supabase

生成唯一 ID 並插入資料：

```bash
mcp__plugin_supabase_supabase__execute_sql({
  project_id: "wiiqoaytpqvegtknlbue",
  query: `
    INSERT INTO policies (id, politician_id, title, description, category, status, proposed_date, last_updated, progress, tags)
    VALUES (
      'policy-{uuid}',
      '{politician_id}',
      '{title}',
      '{description}',
      '{category}',
      '{status}',
      '{proposed_date}',
      CURRENT_DATE,
      0,
      ARRAY[{tags}]
    )
    RETURNING *
  `
})
```

### 5. 新增追蹤日誌（可選）

如果有重要事件，新增 tracking_logs：

```bash
mcp__plugin_supabase_supabase__execute_sql({
  project_id: "wiiqoaytpqvegtknlbue",
  query: `
    INSERT INTO tracking_logs (id, policy_id, date, event, description)
    VALUES (
      'log-{uuid}',
      '{policy_id}',
      '{date}',
      '{event}',
      '{description}'
    )
  `
})
```

## 資料庫結構參考

### politicians 表
| 欄位 | 類型 | 說明 |
|------|------|------|
| id | TEXT | 主鍵 (格式: politician-xxx) |
| name | TEXT | 姓名 |
| party | ENUM | 國民黨/民進黨/民眾黨/無黨籍 |
| region | TEXT | 地區 (如: 台北市) |
| election_type | ENUM | 縣市長/縣市議員/... |

### policies 表
| 欄位 | 類型 | 說明 |
|------|------|------|
| id | TEXT | 主鍵 (格式: policy-xxx) |
| politician_id | TEXT | 外鍵關聯 politicians |
| title | TEXT | 政見標題 |
| description | TEXT | 詳細描述 |
| category | TEXT | 分類 |
| status | ENUM | 狀態 |
| proposed_date | DATE | 提出日期 |
| tags | TEXT[] | 標籤陣列 |

### tracking_logs 表
| 欄位 | 類型 | 說明 |
|------|------|------|
| id | TEXT | 主鍵 (格式: log-xxx) |
| policy_id | TEXT | 外鍵關聯 policies |
| date | DATE | 事件日期 |
| event | TEXT | 事件標題 |
| description | TEXT | 事件描述 |

## 注意事項

- Supabase project_id: `wiiqoaytpqvegtknlbue`
- 所有 ID 使用 `{type}-{uuid}` 格式
- 日期格式: `YYYY-MM-DD`
- status 必須是有效的 policy_status ENUM 值
- category 建議使用現有分類以保持一致性
