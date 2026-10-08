import { FEATURED_LOCAL_ELECTION_ID } from './election-regions'

/**
 * 網站地圖的內容規則（2026-10-08，#466）：誰進 sitemap-politicians.xml、各頁的 lastmod 取哪個時間。純函式，建置端
 * （lib/ssg/server-data.ts）算好交給 scripts/postbuild-ssg.mjs 寫檔；XML 本身在 cloudflare/sitemap-xml.js。
 *
 * lastmod 的來源（只用有可靠時間的，沒有就不寫，寧缺勿錯）：
 *   - 政見頁 /policy/:id、/analysis/:id → policies.updated_at。內容欄位（標題、描述、分類、狀態、進度、出處、屆別、移除）
 *     任何 UPDATE 都由觸發器 policies_touch_updated_at 蓋時間（20260921000028），表態計數不算；就是「這頁內容最後一次變動」。
 *   - 脈絡頁 /lineage/:id → lineages.updated_at（觸發器 lineage_touch_updated_at，連參與者、交接、關聯的變動都蓋）。
 *   - 人物頁 /politician/:id → 他名下政見 updated_at 的最大值。politicians 表沒有任何時間欄位，
 *     最近一次已上線貢獻（contributions.applied_at）只有 service_role 讀得到、建置端用的是 anon。
 *     人物頁的主要內容（競選承諾、政績追蹤）就是名下政見，所以這個值跟頁面實質變動同步；
 *     只改了簡介、照片這類人物欄位時不會動（可接受）。名下沒有政見的候選人（候選人一律收）沒有可靠時間，不寫 lastmod，不拿「建置當天」頂替。
 *   - 選舉頁、縣市頁、鄉鎮頁、人物一覽、政黨頁、社群與靜態頁 → 不寫。elections、parties 沒有時間欄位，
 *     頁面內容是「很多筆資料的合計」（候選人名單、政黨歸屬），任何一筆參選紀錄變動都算；拿政見時間頂替會漏報名單變動。
 */

/**
 * 人物頁進 sitemap-politicians.xml 的規則（維護者 2026-10-08，兩條擇一即收）：
 *   1. 有焦點屆別參選紀錄的人，一律收，不看政見數。焦點屆別＝網站現行的 `FEATURED_LOCAL_ELECTION_ID`（lib/election-regions.ts，
 *      頁尾、首頁那排縣市連結指的下一場地方選舉；現在是 2026）。選這個而不是「還沒投票的屆別」：它是網站已經在用的單一常數，
 *      明天換屆（2026 投票後改成 2030）只動那一處，人物頁、頁尾、網站地圖一起跟；「還沒投票」要比日期、
 *      補選與重行選舉也會算進來，會把不是這一輪主戰場的人混進去。只認有參選紀錄，退選的也算（紀錄在、頁面在）；已合併的人物不在建置清單裡。
 *   2. 其餘人物：名下未移除的政見 **≥ SITEMAP_MIN_POLICIES_FOR_PERSON** 才收。
 * 只影響網站地圖——頁面本身不加 noindex，照常可被收錄、可被連結帶進來。
 * 政見數的定義跟人物頁一致：頁面兩個分頁（競選承諾＋過往政績與追蹤）加起來，即全域 state 裡 politicianId 等於他、
 * 且未軟移除（removed_at 空）的政見，不分屆別。
 */
export const SITEMAP_MIN_POLICIES_FOR_PERSON = 3

export interface SitemapPolicy { politicianId: string | number; updatedAt?: string | null }

/** 轉成 sitemap 的 W3C datetime（UTC，秒）；不是合法時間回 null */
export function toLastmod(value: string | number | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (!Number.isFinite(t)) return null
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 一串時間裡最晚的一個；全是空／不合法回 null */
export function latestLastmod(values: Iterable<string | number | Date | null | undefined>): string | null {
  let best: number | null = null
  for (const v of values) {
    const iso = toLastmod(v)
    if (!iso) continue
    const t = new Date(iso).getTime()
    if (best === null || t > best) best = t
  }
  return best === null ? null : toLastmod(best)
}

/** 每位人物名下的政見數與最近變動時間（傳進來的政見已排除軟移除，跟前端全域 state 同一份） */
export function policyStatsByPolitician(policies: ReadonlyArray<SitemapPolicy>): Map<string, { count: number; lastmod: string | null }> {
  const out = new Map<string, { count: number; latest: number | null }>()
  for (const p of policies) {
    const id = String(p.politicianId)
    const cur = out.get(id) ?? { count: 0, latest: null }
    cur.count++
    const iso = toLastmod(p.updatedAt)
    if (iso) {
      const t = new Date(iso).getTime()
      if (cur.latest === null || t > cur.latest) cur.latest = t
    }
    out.set(id, cur)
  }
  return new Map([...out].map(([id, v]) => [id, { count: v.count, lastmod: v.latest === null ? null : toLastmod(v.latest) }]))
}

/** 這位人物該不該列進網站地圖：有焦點屆別的參選紀錄，或政見數到門檻 */
export function isSitemapPerson(policyCount: number, hasFeaturedElection = false): boolean {
  return hasFeaturedElection || policyCount >= SITEMAP_MIN_POLICIES_FOR_PERSON
}

export interface SitemapPerson { id: string | number; elections?: ReadonlyArray<{ electionId: number | string }> | null }

/** 有沒有焦點屆別的參選紀錄（不看參選狀態） */
export function hasElection(person: SitemapPerson, electionId: number | string = FEATURED_LOCAL_ELECTION_ID): boolean {
  return (person.elections ?? []).some((e) => String(e.electionId) === String(electionId))
}

/** 建置端交給 postbuild 的網站地圖補充：各網址的 lastmod、以及不進網站地圖的網址 */
export interface SitemapMeta {
  lastmod: Record<string, string>
  skip: string[]
}

export function buildSitemapMeta(input: {
  politicians: ReadonlyArray<SitemapPerson>
  /** 預設＝網站現行的焦點屆別 */
  featuredElectionId?: number | string
  policies: ReadonlyArray<SitemapPolicy & { id: string | number }>
  lineages: ReadonlyArray<{ id: string | number; updatedAt?: string | null }>
  /** 只有「列進網站地圖的」預渲染分析頁需要；其餘不傳 */
  analysisPolicyIds?: ReadonlyArray<string | number>
}): SitemapMeta {
  const lastmod: Record<string, string> = {}
  const skip: string[] = []
  const stats = policyStatsByPolitician(input.policies)
  for (const person of input.politicians) {
    const s = stats.get(String(person.id))
    const route = `/politician/${person.id}`
    if (!isSitemapPerson(s?.count ?? 0, hasElection(person, input.featuredElectionId))) { skip.push(route); continue }
    if (s?.lastmod) lastmod[route] = s.lastmod
  }
  const policyById = new Map(input.policies.map((p) => [String(p.id), p]))
  for (const p of input.policies) {
    const iso = toLastmod(p.updatedAt)
    if (iso) lastmod[`/policy/${p.id}`] = iso
  }
  for (const id of input.analysisPolicyIds ?? []) {
    const iso = toLastmod(policyById.get(String(id))?.updatedAt)
    if (iso) lastmod[`/analysis/${id}`] = iso
  }
  for (const l of input.lineages) {
    const iso = toLastmod(l.updatedAt)
    if (iso) lastmod[`/lineage/${l.id}`] = iso
  }
  return { lastmod, skip }
}
