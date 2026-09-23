# Find Politician Avatar Skill

Use this skill to find politician avatar URLs from Wikipedia and submit them as `correction` contributions (they go live after peer verification).

## Usage

```
/find-avatar [政治人物姓名]
```

Examples:
- `/find-avatar 柯文哲`
- `/find-avatar 蔡英文 賴清德 侯友宜`
- `/find-avatar --all` (查詢所有缺少頭像的政治人物)

## Instructions

When this skill is invoked, follow these steps:

### Step 1: Parse Input

- If `--all` flag is provided, query Supabase for all politicians with NULL avatar_url
- Otherwise, use the provided politician name(s)

### Step 2: Search Wikipedia for Avatar URLs

For each politician name, use the Wikipedia API to find their image:

```bash
curl -s "https://zh.wikipedia.org/w/api.php?action=query&titles={URL_ENCODED_NAME}&prop=pageimages&format=json&pithumbsize=250&redirects=1" -H "User-Agent: Mozilla/5.0"
```

The response will contain a `thumbnail.source` field with the image URL if available.

**寬度一定用 250／330／500 其中之一**（2026-09-22）：Wikimedia 對外只供這幾種縮圖，220px 整批回 400、頭像空白（那天 24 人中招）。
落庫時會自動把其他寬度換成允許值（`_shared/avatar-url.ts`，在 `apply-contribution.ts` 套用），但這裡就直接要 250。
存進資料庫前把 `?utm_source=…` 這串查詢參數去掉。原檔在 Commons 被刪或改名時（柯文哲、盧秀燕 2026-09-22 那批）要重查，不是改寬度。

### Step 3: Handle Special Cases

Some politicians have disambiguation pages. Common patterns:
- `許淑華 (1975年)` - 南投縣長
- `許淑華 (1973年)` - 台北市議員
- `劉建國 (台灣政治人物)` - 雲林立委

If the initial search returns no image, try searching with disambiguation:

```bash
curl -s "https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch={NAME}%20立法委員&format=json" -H "User-Agent: Mozilla/5.0"
```

Then use the `pageid` from the search results to get the image.

### Step 4: Report Results

Display a table with the results:

| 姓名 | 狀態 | 頭像 URL |
|------|------|----------|
| 柯文哲 | ✅ 找到 | https://upload.wikimedia.org/... |
| 某某某 | ❌ 未找到 | - |

### Step 5: Submit as contributions (Optional)

**2026-09-23 起沒有直接改資料庫的路。** `update-avatar` 端點只要公開金鑰就能改任何人的照片，已下架；照片跟其他資料一樣走貢獻流程：交一筆 `correction`，同儕驗證通過才上線（照片形狀不合格會在落庫時被擋、理由回給提交者）。

Ask the user if they want to submit. If yes, for each politician:

1. 查 `politician_id`（同名可能不只一位，**看縣市與現職挑對人，挑不出來就問使用者，不要猜**）：

```bash
curl -s "https://wiiqoaytpqvegtknlbue.supabase.co/rest/v1/politicians?select=id,name,region,current_position,avatar_url&name=eq.{URL_ENCODED_NAME}" \
  -H "apikey: {ANON_KEY}" -H "Authorization: Bearer {ANON_KEY}"
```

2. 把 JSON 存成 UTF-8 檔（Windows 的 cp950 會把中文打壞），用 `--data-binary` 送：

```json
{
  "kind": "contribute",
  "agent_name": "find-avatar",
  "agent_tool": "claude-code/<模型>",
  "contribution_type": "correction",
  "payload": {
    "target_table": "politicians",
    "target_id": "<politician_id>",
    "changes": [{ "field": "avatar_url", "current_value": "<現值或 null>", "correct_value": "<250px 的 upload.wikimedia.org 網址>" }],
    "reason": "維基百科「<條目名>」資訊框人像，與縣市／現職相符（至少 20 字，寫清楚你怎麼確認是這個人）"
  },
  "source_urls": ["https://zh.wikipedia.org/wiki/<條目名>"]
}
```

```bash
curl -s -X POST "https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/report" \
  -H "Content-Type: application/json" --data-binary @avatar.json
```

回 `201` 帶 `contribution_id` 就是交出去了；`400 no_op_correction` 表示資料庫已經是這張照片。

Get the ANON_KEY from `.env.local`:
```bash
grep VITE_SUPABASE_ANON_KEY .env.local
```

## Wikipedia API Reference

### Get image by title
```
https://zh.wikipedia.org/w/api.php?action=query&titles={TITLE}&prop=pageimages&format=json&pithumbsize=220
```

### Get image by page ID
```
https://zh.wikipedia.org/w/api.php?action=query&pageids={PAGE_ID}&prop=pageimages&format=json&pithumbsize=220
```

### Search for a person
```
https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch={SEARCH_TERM}&format=json
```

### Batch query (up to 50 titles)
```
https://zh.wikipedia.org/w/api.php?action=query&titles={TITLE1}|{TITLE2}|{TITLE3}&prop=pageimages&format=json&pithumbsize=220
```

## Notes

- Wikipedia image URLs use URL encoding for Chinese characters
- The `pithumbsize=220` parameter controls the thumbnail size
- Some politicians may not have Wikipedia pages or images
- For politicians without Wikipedia images, consider searching Facebook or official websites manually
