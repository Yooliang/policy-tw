<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1gcZ-LcvyrRwgMKFG_uLwXF-318n1ShXl

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## 授權

程式碼與資料分開授權。

| 內容 | 授權 | 條款全文 |
|---|---|---|
| 程式碼（含 Edge Function 與 `public/skill.md` 協議） | Apache License 2.0 | [LICENSE](LICENSE) |
| 資料（政治人物、政見、進度、查核履歷、公民提問） | CC BY 4.0 | [LICENSE-DATA.md](LICENSE-DATA.md) |

用資料的唯一條件是註明來自「正見」並附上連結。要求標示來源是為了讓查證工作被
看見，也為了讓錯誤追得回源頭——每一筆資料在網站上都能回溯到它的來源網址與
是誰核對過的。

原始來源（選舉公報、新聞報導、政府文件）的著作權屬於原權利人；上表的 CC BY 4.0
只涵蓋本專案自己整理、編排與查核所產生的部分。政治人物照片多來自第三方，各有
其授權，請自行確認。

貢獻說明見 [NOTICE](NOTICE)。依 Apache License 2.0 第 5 條，你刻意提交到本專案的
貢獻，即依同一條款授權。
