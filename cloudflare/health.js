/**
 * GET /__health：這個網域有沒有接到正見的 Worker（policy-ops#45，2026-10-10）。
 *
 * 站務主控台（policy-console）的網域燈號以前用 no-cors 打首頁，看不到狀態碼——Cloudflare 回 522 也算「連得上」。
 * 這支回 200 JSON 並帶 Access-Control-Allow-Origin，瀏覽器讀得到狀態碼與內容，燈號才能真的以 200 判斷。
 * 不碰資料庫、不打上游，不快取。
 */
export const HEALTH_PATH = '/__health'

/** @param {Request} request */
export function healthResponse(request) {
  const host = new URL(request.url).host
  return new Response(JSON.stringify({ ok: true, host, served_by: 'policy-tw-worker' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Served-Via': 'cloudflare-worker',
    },
  })
}
