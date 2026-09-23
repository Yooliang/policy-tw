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
回滾：把 `SSR_ROUTES` 清空重部署＝純代理。計畫與後續步驟見 `docs/PLAN-edge-ssr.md`。

