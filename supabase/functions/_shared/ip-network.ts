/**
 * 來源網段（#481，2026-10-08 維護者裁示）。
 *
 * 身份、派工綁定、「一個來源一票」的計票去重、每日額度，原本都看「來源 IP」。
 * 雲端代理的對外 IP 每次請求都換（實測 160.79.106.19／.21／.22／.27），
 * GET /next 與 POST /report 被當成兩台機器，回報一律 409 not_dispatched。
 * 改成看網段：IPv4 取前 24 位（/24）、IPv6 取前 64 位（/64）。
 * 代價：同一個 /24 後面的不同人（同一個雲端出口、同一棟辦公室）算一個來源——
 * 跟「同一條網路後面的多位貢獻者算一票」是同一個取捨，只是範圍大一點。
 */

/** IPv4 → `a.b.c.0/24`；IPv6 → 前四組展開成 `xxxx:xxxx:xxxx:xxxx::/64`；認不得的原字回傳（小寫、去空白）。 */
export function networkOf(ip: string): string {
  const s = ip.trim().toLowerCase();
  const v4 = ipv4Network(s);
  if (v4) return v4;
  // IPv4 對應的 IPv6（::ffff:1.2.3.4）照 IPv4 算
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) {
    const m = ipv4Network(mapped[1]);
    if (m) return m;
  }
  const v6 = ipv6Groups(s.replace(/%.*$/, ""));
  if (v6) return `${v6.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}::/64`;
  return s;
}

function ipv4Network(s: string): string | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/** 展開成 8 組十六進位；不是合法 IPv6 回 null。尾端內嵌 IPv4 的寫法（::ffff:1.2.3.4 以外）不收。 */
function ipv6Groups(s: string): string[] | null {
  if (!s.includes(":") || !/^[0-9a-f:]+$/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...head, ...tail].some((g) => g.length === 0 || g.length > 4)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array(fill).fill("0"), ...tail];
}
