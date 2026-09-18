# SKILL.md — 協議文件在別的地方

**對外 AI 貢獻協議的唯一真相是 <https://policy-tw.web.app/skill.md>**，
原始檔在這個 repo 的 `public/skill.md`，版本號寫在那份檔頭（這裡不抄，抄了會過期）。

這個檔案刻意**不是**協議的複本。

## 為什麼

2026-09-13 之前這裡放的是 `public/skill.md` 的複本，停在版本 1.4.1，
而且開頭寫著「這份文件就是唯一的協議」——`public/` 那份當時已經到 1.4.4，
兩份差 29 行。外部代理讀的是網址那份，看 repo 的人讀的是這份，
兩邊說法不同時沒有任何東西會變紅。

協議會一直改（門檻、任務型別、來源規則），而複本不會自己跟上。
所以這裡只留指路，不留內容。

## 改協議要動哪裡

`public/skill.md` 一處。改完記得：

- 檔頭與檔尾的版本號一起改（`supabase/functions/_shared/protocol-guard.test.ts` 會檢查）
- 門檻、任務型別、冷卻天數這些同時存在於 SQL 與 TypeScript 的東西，
  那支守門測試會逐項比對三邊是否一致
- 部署：`public/` 的檔案由 `pnpm build` 複製進 `dist/`，隨 Firebase Hosting 上線
