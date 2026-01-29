# Find Politician Avatar Skill

Use this skill to find and update politician avatar URLs from Wikipedia.

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
curl -s "https://zh.wikipedia.org/w/api.php?action=query&titles={URL_ENCODED_NAME}&prop=pageimages&format=json&pithumbsize=220" -H "User-Agent: Mozilla/5.0"
```

The response will contain a `thumbnail.source` field with the image URL if available.

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

### Step 5: Update Database (Optional)

Ask the user if they want to update the database. If yes, call the Edge Function:

```bash
curl -X POST 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/update-avatar' \
  -H "Authorization: Bearer {ANON_KEY_FROM_ENV}" \
  -H 'Content-Type: application/json' \
  -d '{
    "updates": [
      {"name": "姓名", "avatarUrl": "URL"}
    ]
  }'
```

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
