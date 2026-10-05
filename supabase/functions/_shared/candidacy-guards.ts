/**
 * 參選紀錄的兩道交件守門（維護者 2026-10-01 核准）。
 *
 * 起因：2026 縣市長官方登記 81 人，我們 83 人，多出的兩位都是交件錯誤、而且都通過了投票：
 *   - 陳見賢：一筆 correction 的 reason 寫「確認陳瑩在台東縣候選人名單上」，target_id 卻填成陳見賢那筆參選紀錄
 *     （編號相近）。驗證者核的是「陳瑩在不在名冊上」，沒人發現改的根本不是陳瑩。
 *   - 陳琬惠：拿政黨 4 月的造勢新聞稿把她改成 confirmed，但 9/4 登記截止時她沒有登記。
 *
 * 兩道都在交件時擋（400、不算被拒），告訴代理怎麼改。
 */

/** 各屆參選登記截止日（台灣日期）。截止之後要把人標成已登記／確定參選，證據要是名冊或截止之後的報導 */
export const REGISTRATION_DEADLINE: Record<number, string> = {
  2026: "2026-09-04",
};

/**
 * 更正參選紀錄時，reason 裡要寫出被改的那個人的名字。
 * 只看「有沒有出現」，不去猜 reason 裡其他名字——reason 本來就可能提到對手；
 * 重點是寫的人得意識到自己改的是誰。名字不到兩個字不檢查（誤中率太高）。
 */
export function reasonNamesTarget(reason: string | null | undefined, targetName: string | null | undefined): boolean {
  const name = (targetName ?? "").trim();
  if (name.length < 2) return true;
  const text = (reason ?? "").replace(/[‧·・．.\s]/g, "");
  return text.includes(name.replace(/[‧·・．.\s]/g, ""));
}

/** 網址看得出的日期（YYYYMMDD、YYYY-MM-DD、YYYY/MM/DD、YYYY/M/D），看不出回 null */
export function dateInUrl(url: string): string | null {
  // 有分隔符的（2026-09-15、2026/9/15）先試；再試連寫的（中央社 aipl/202609045002 前八碼、ETtoday news/20260915）
  const m = url.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/) ?? url.match(/(20\d{2})(\d{2})(\d{2})/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

function isCecUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "cec.gov.tw" || host.endsWith(".cec.gov.tw");
  } catch {
    return false;
  }
}

/**
 * 登記截止後把人標成 registered／qualified／confirmed：附的來源至少要有一個是中選會（cec.gov.tw），
 * 或網址看得出日期、而且是截止日當天或之後的報導。沒有截止日的屆別不檢查。
 */
export function registrationEvidenceOk(urls: readonly string[], electionId: number | null, today: string): boolean {
  if (electionId === null) return true;
  const deadline = REGISTRATION_DEADLINE[electionId];
  if (!deadline || today < deadline) return true;
  return urls.some((u) => isCecUrl(u) || ((dateInUrl(u) ?? "") >= deadline));
}

// qualified（已審定，名單公告後在名單上）同樣要附得出名冊——#345 後續把公告後的 confirmed 收窄成 qualified，這裡一起擋
export const REGISTERED_STATUSES = new Set(["registered", "qualified", "confirmed"]);
