/**
 * 地方基本統計（issue #508）：縣市與鄉鎮市區的人口、面積、總預算歲出、65 歲以上比例。
 * 一個地區一個指標一個年度一列，讀 `regional_stats_public` 視圖（migration 20261009240000）。
 *
 * 單位與中文標籤要跟 supabase/functions/_shared/contribution-schema.ts 的
 * REGIONAL_STAT_UNIT／REGIONAL_STAT_LABEL、SQL 的 regional_stat_unit()／regional_stat_label() 三處一致
 * （regional-stats.test.ts 盯著）。沒有列＝未調查，不是 0 或空白（照「讓資料自己說話」，不推估）。
 */

export const REGIONAL_STAT_KEYS = ['population', 'area_km2', 'budget_expenditure', 'aging_rate'] as const
export type RegionalStatKey = (typeof REGIONAL_STAT_KEYS)[number]

export const REGIONAL_STAT_UNIT: Readonly<Record<RegionalStatKey, string>> = {
  population: '人',
  area_km2: '平方公里',
  budget_expenditure: '千元',
  aging_rate: '%',
}

export const REGIONAL_STAT_LABEL: Readonly<Record<RegionalStatKey, string>> = {
  population: '人口',
  area_km2: '面積',
  budget_expenditure: '總預算歲出',
  aging_rate: '65 歲以上人口比例',
}

/** `regional_stats_public` 視圖的一列 */
export interface RegionalStat {
  id: string
  adminCode: string
  level: 'county' | 'town'
  region: string
  subRegion: string | null
  statKey: RegionalStatKey
  year: number
  value: number
  unit: string
  asOf: string | null
  sourceUrl: string
}

export interface RawRegionalStat {
  id: string
  admin_code: string
  level: string
  region: string
  sub_region: string | null
  stat_key: string
  year: number
  value: number | string
  unit: string
  as_of: string | null
  source_url: string
}

export function mapRegionalStat(raw: RawRegionalStat): RegionalStat {
  return {
    id: raw.id,
    adminCode: raw.admin_code,
    level: raw.level === 'town' ? 'town' : 'county',
    region: raw.region,
    subRegion: raw.sub_region ?? null,
    statKey: raw.stat_key as RegionalStatKey,
    year: raw.year,
    value: typeof raw.value === 'string' ? Number(raw.value) : raw.value,
    unit: raw.unit,
    asOf: raw.as_of ?? null,
    sourceUrl: raw.source_url,
  }
}

/**
 * 某個地區（縣市，或縣市＋鄉鎮）、某個指標最新年度的一筆；沒有資料回 null（前端顯示「未調查」）。
 * subRegion 給 undefined／null 時找縣市層級的列（sub_region 是 null）。
 */
export function pickRegionalStat(
  rows: readonly RegionalStat[],
  region: string,
  subRegion: string | null | undefined,
  statKey: RegionalStatKey,
): RegionalStat | null {
  const wantSub = subRegion ?? null
  const matches = rows.filter((r) => r.region === region && r.subRegion === wantSub && r.statKey === statKey)
  if (matches.length === 0) return null
  return matches.reduce((latest, r) => (r.year > latest.year ? r : latest))
}

/** 這個地區（縣市，或縣市＋鄉鎮）四項指標目前有的最新值；缺的那一項不在陣列裡（前端顯示「未調查」） */
export function regionalStatsFor(
  rows: readonly RegionalStat[],
  region: string,
  subRegion: string | null | undefined,
): Array<{ statKey: RegionalStatKey; stat: RegionalStat }> {
  return REGIONAL_STAT_KEYS
    .map((statKey) => ({ statKey, stat: pickRegionalStat(rows, region, subRegion, statKey) }))
    .filter((x): x is { statKey: RegionalStatKey; stat: RegionalStat } => x.stat !== null)
}
