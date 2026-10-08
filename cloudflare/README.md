# 正見.tw 的 Cloudflare 設定（2026-09-23）

正式網址 `https://正見.tw`（punycode `xn--2lw665d.tw`）不是直接接在 Firebase Hosting 上，而是 **Cloudflare 簽憑證、Worker 反向代理到 `policy-tw.web.app`**。

## 為什麼不是 Firebase 自訂網域

09-22 在 Firebase 加自訂網域，DNS（A `199.36.158.100`、TXT `hosting-site=policy-tw`）從 Google／Cloudflare 解析器、註冊商 nameserver（UDP／TCP）各角度查都正確，Firebase 仍持續顯示「DNS 要求失敗」、超過 24 小時沒簽憑證，刪掉重加也一樣。官方文件沒提 IDN 支不支援。與其再等，改走 Cloudflare。

## 設定（Cloudflare 主控台）

1. **DNS**：`A @ → 199.36.158.100`，**已代理（橘色雲）**；`TXT @ hosting-site=policy-tw`；`TXT @ google-site-verification=…`（Search Console）。要 `www` 就加 `CNAME www → xn--2lw665d.tw`（已代理）。
2. **SSL/TLS**：加密模式 **Full**；Edge Certificates 會自動發 Universal SSL（含 `xn--2lw665d.tw` 與 `*.xn--2lw665d.tw`）。
3. **Workers & Pages → Create → Start from scratch**：把 `worker.js` 整支貼進去 → Deploy。
4. Worker 的 **Settings → Domains & Routes → Add → Route**：`xn--2lw665d.tw/*`（zone 正見.tw）；有 www 再加 `www.xn--2lw665d.tw/*`。
5. 驗收：`curl -sI https://xn--2lw665d.tw/ | grep -i x-served-via` 要看到 `cloudflare-worker`；`/skill.md`、`/election/2026`、`/sitemap.xml` 都要 200。

## 注意

- Worker 免費額度每天 100,000 次請求；超過再升級。
- Firebase 那邊的自訂網域可以留著或刪掉，都不影響（A 記錄已被代理，Firebase 看到的是 Cloudflare 的 IP，它永遠驗不過，這是預期的）。
- 站內 canonical／og:url／sitemap 改成新域名的 PR：#186。

## 2026-09-23 之後：ssr-worker.js 取代 worker.js

`cloudflare/ssr-worker.js`（wrangler.toml 的 main）：`/politician/:id`、`/policy/:id` 在邊緣 SSR（`entry-server.ts` → `pnpm build:ssr` → `dist-ssr/`），
Cache API 10 分鐘＋過期先回舊的；其餘路由照舊代理到 web.app。`POST /__purge`（`X-Purge-Secret`）清指定頁。
部署：CI 的 `ssr-deploy` job（需 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）或本機 `pnpm deploy:ssr`。
回滾：把 `SSR_ROUTES` 清空重部署＝純代理。
縣市頁（2026-09-30）：`/election/:id/:縣市` 代理時換成 web.app 上的 ASCII 路徑 `/election/:id/_r/<十六進位>`；`/election/:id?region=縣市` 301 到路徑版。規則在 `region-path.js`（postbuild 與 serve-dist 共用）。計畫與後續步驟見 `docs/PLAN-edge-ssr.md`。
鄉鎮頁（2026-10-05）：`/election/:id/:縣市/:鄉鎮` 代理時換成 `/election/:id/_r/<縣市十六進位>/<鄉鎮十六進位>`；舊的 `/election/:id/:縣市?sub=鄉鎮` 與更舊的 `/election/:id?region=縣市&sub=鄉鎮` 一次 301 到鄉鎮頁（村里、頁籤參數照帶；sub 不像鄉鎮名就不轉）。規則與測試：`region-path.js`、`region-path.test.ts`。
選舉那一段（2026-10-07，#344 第二階段 A）：舊三屆是數字 id（`/election/2022`），新增的選舉（補選、罷免投票、重行選舉）是 `election_key`（`/election/2022-12-18_rerun_10020`，縣市頁、鄉鎮頁規則同上）；舊三屆的 key 寫法（`/election/2022-11-26_local[/…]`）由 Worker 301 到年份寫法（`legacyElectionKeyRedirect`，清單 `LEGACY_ELECTION_KEYS` 與前端 `lib/election-route.ts` 一致、有測試盯）；Firebase 那邊 `firebase.json` 的 `redirects` 也轉一份，給直接打 policy-tw.web.app 的。


## 人物頁的 301／404 與網站地圖（2026-10-08，#466）

- `/politician/:id` 不預渲染，**任何 id 都是請求時從資料庫現場渲染**；建置之後才新增的人物不會因此 404。查不到的兩種情況：真的沒有這個人 → 404（`no-store`，不快取）；人物已被軟合併（`merged_into`）→ 沿合併鏈 301 到保留的那位（`lib/ssr/merge-chain.ts`，最多 5 跳）。組回應在 `render-status.js`，測試 `render-status.test.ts`。
- 網站地圖（`scripts/postbuild-ssg.mjs`）是建置時算的，新增的人物要等下一次建置才進去。人物頁只有名下政見 ≥ 6 筆才列；lastmod 取各頁實際的更新時間、沒有可靠時間就不寫；規則與理由在 `lib/sitemap.ts`，XML 組字在 `sitemap-xml.js`。

## Markdown 檢視（2026-10-07，docs/PLAN-markdown-views.md 第 12 節）

`cloudflare/markdown.js`（由 `ssr-worker.js` 在代理之前呼叫；路由 `lib/md/route.ts`、組字 `lib/md/*`，隨 `pnpm build:ssr` 進 `dist-ssr/`）：

- `/politician/<id>.md`：讀時產生＋Cache API（10 分鐘，過期先回舊的背景重算）。
- `/election/<屆>/<縣市>.md`、`/data/<屆>/…`、`/category/<分類>.md`、`/data/<屆>/index.(md|json)`：只讀預產快取表 `data_md_cache`（每小時由 `.github/workflows/data-md.yml` 跑 `scripts/build-data-md.ts` 重產；本機 `pnpm build:md` 再 `node dist-md/build-data-md.js --sql-dir out/sql --out-dir out/md` 可以不寫庫看結果）。找不到回 404 的 Markdown，資料庫壞了回 503＋`Retry-After`，都不退回代理。
- 所有回應 `X-Robots-Tag: noindex`、`Access-Control-Allow-Origin: *`；200 帶 `ETag`／`Last-Modified`／`X-Data-Generated-At`，支援 304。`robots.txt` 不得 Disallow `.md`。
- `POST /__purge` 清某頁時連它的 `.md` 版一起清（只對人物與 Worker 的 Cache API 有效；預產的頁等下一批）。
- policy-tw.web.app 上的 `.md`、`/data/**` 由 `firebase.json` 的 redirects 301 到正見.tw。
