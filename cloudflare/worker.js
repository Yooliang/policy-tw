/**
 * 正見.tw（xn--2lw665d.tw）→ Firebase Hosting 的反向代理（Cloudflare Worker，2026-09-23）。
 *
 * 為什麼：Firebase 對這個中文域名的自訂網域驗證一直過不了（DNS 從各角度查都對、超過 24 小時仍「DNS 要求失敗」），
 * 改讓 Cloudflare 自己替 xn--2lw665d.tw 簽邊緣憑證，再由這支 Worker 把每一個請求原路轉打到 policy-tw.web.app。
 * Firebase 那邊不用認得這個域名；網站程式也不用改（canonical／sitemap 另由 #186 換成新域名）。
 *
 * 部署：Cloudflare → Workers & Pages → Create → 貼上這支 → Deploy → Settings → Domains & Routes →
 *       Add route：`xn--2lw665d.tw/*`（zone 正見.tw）；DNS 的 A @ 要是「已代理」（橘色雲）。
 *       有 www 就再加 `www.xn--2lw665d.tw/*` 與 CNAME www → xn--2lw665d.tw（已代理）。
 */

const ORIGIN = "https://policy-tw.web.app";
const ORIGIN_HOST = "policy-tw.web.app";

/** 這些請求標頭是 Cloudflare 加的或跟連線綁定的，不該轉給 Firebase */
const DROP_REQUEST_HEADERS = ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cf-worker", "x-forwarded-proto", "x-real-ip"];

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, ORIGIN);

    const headers = new Headers(request.headers);
    for (const h of DROP_REQUEST_HEADERS) headers.delete(h);
    headers.set("X-Forwarded-Host", incoming.host);
    headers.set("X-Forwarded-Proto", "https");

    const hasBody = !["GET", "HEAD"].includes(request.method);
    const upstream = await fetch(target.toString(), {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual", // 轉址自己處理：Location 若指回 web.app 要改成我們的域名
    });

    const out = new Headers(upstream.headers);
    const location = out.get("Location");
    if (location) {
      try {
        const l = new URL(location, ORIGIN);
        if (l.host === ORIGIN_HOST) {
          l.protocol = "https:";
          l.host = incoming.host;
          out.set("Location", l.toString());
        }
      } catch { /* 相對或怪的 Location 就原樣放行 */ }
    }
    // 讓事後查得出這一趟是走 Worker，不是 Firebase 直出
    out.set("X-Served-Via", "cloudflare-worker");

    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  },
};
