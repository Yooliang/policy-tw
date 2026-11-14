/**
 * 參選紀錄的顯示名稱：由「選舉別＋縣市（＋鄉鎮／村里）」組出來，不照抄資料庫存的 position 文字。
 *
 * 2026-09-25 維護者看到兩種錯：
 *   - 苗博雅 2026 那列顯示「111年直轄市議員選舉」——早期匯入照抄 2022 那列建的，職稱從沒被更新（2026 年有 52 列這樣）
 *   - 高嘉瑜被顯示成「台北市長」——人物層的 position 是匯入時的傳聞，實際登記的是市議員
 * position 是匯入時各來源自由填的文字（「111年直轄市長選舉」「宜蘭縣第10選舉區」「立委候選人」…），
 * 代理的交件只改參選狀態、不會回頭改它。顯示改成從結構化欄位組，存的文字寫錯也不會顯示錯；
 * 存錯的資料照流程由代理用 correction 修（見 docs/DECISIONS.md 09-25）。
 * 選舉別本身錯的（例如把議員登記寫成縣市長）這裡救不了，那要靠偵測任務。
 */

export interface ParticipationLike {
  electionType?: string
  position?: string
  region?: string
  subRegion?: string
  village?: string
}

export function participationLabel(e: ParticipationLike): string {
  const region = (e.region || '').trim()
  const sub = (e.subRegion || '').trim()
  switch (e.electionType) {
    case '總統副總統':
      // 正副總統分得出來就留著（存的就是這兩種之一）
      return e.position === '副總統候選人' ? '副總統' : '總統'
    case '立法委員':
      return !region || region === '全國' ? '不分區立委' : `${region}立委`
    case '縣市長':
      return region ? `${region}長` : '縣市長'
    case '縣市議員':
      return region ? `${region}議員` : '縣市議員'
    case '鄉鎮市長':
      return sub ? `${sub}長` : '鄉鎮市長'
    case '鄉鎮市民代表':
      return sub ? `${sub}民代表` : '鄉鎮市民代表'
    case '直轄市山地原住民區長':
      return sub ? `${sub}長` : '原住民區長'
    case '直轄市山地原住民區民代表':
      return sub ? `${sub}民代表` : '原住民區民代表'
    case '村里長':
      return e.village ? `${sub}${e.village}長` : '村里長'
    default:
      // 沒有選舉別的舊資料：只能用存的文字
      return e.position || ''
  }
}

/** 參選描述：候選人、參選、擬參選、登記參選、爭取連任（代理常把參選身分填進現職欄） */
const CANDIDACY_RE = /候選人|參選|爭取連任|尋求連任|競選連任/

export function isCandidacyText(v: string): boolean {
  return CANDIDACY_RE.test(v)
}

/** 依「、，,；;」切段，括號（全形半形）裡的分隔符不切 */
function splitSegments(v: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of v) {
    if (ch === '（' || ch === '(') depth++
    else if ((ch === '）' || ch === ')') && depth > 0) depth--
    if (depth === 0 && '、，,；;'.includes(ch)) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * 現職欄存的是選舉名稱（「111年直轄市議員選舉」）就不當職稱顯示：879 位是早期匯入填錯的，
 * 補基本資料任務會把它當缺派出去，代理補上真的現職後自然就顯示了。
 * 存的是參選描述（「里長候選人（2026 年…）」，全庫約 17,000 筆）也不顯示；多段時只拿掉參選那幾段。
 */
export function displayCurrentPosition(v?: string | null): string | undefined {
  if (!v || /選舉\s*$/.test(v)) return undefined
  const kept = splitSegments(v).filter((seg) => !isCandidacyText(seg))
  return kept.length ? kept.join('、') : undefined
}
