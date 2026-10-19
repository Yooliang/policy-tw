/**
 * 參選地圖的連續色階（純函式）。端點是固定 hex，中間在 OKLab 裡內插（感知均勻，紅到黃到綠的中段不會發灰發髒）。
 */

export type Rgb = [number, number, number]
export type Lab = [number, number, number]

/** 收錄率色階：0% 紅 → 50% 黃 → 100%（含以上）綠 */
export const COVERAGE_STOPS: ReadonlyArray<readonly [number, string]> = [
  [0, '#dc2626'],
  [0.5, '#facc15'],
  [1, '#16a34a'],
]
/** 沒有登記資料（或登記 0）：中性淺灰，不算紅 */
export const NO_DATA_COLOR = '#e5e7eb'
/** 人數色階：沿用最早那套藍（淺藍 → 深藍）做成連續漸層；0 人用原本最淺的灰藍，跟有人的藍分得開 */
export const COUNT_STOPS: ReadonlyArray<readonly [number, string]> = [
  [0, '#dbeafe'],
  [1 / 3, '#93c5fd'],
  [2 / 3, '#3b82f6'],
  [1, '#1e40af'],
]
export const COUNT_ZERO_COLOR = '#e2e8f0'
/** 圖例刻度（收錄率，百分比） */
export const COVERAGE_TICKS = [0, 50, 90, 100] as const

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`
}

const toLinear = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const toGamma = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

export function toOklab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map(toLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
export function fromOklab(lab: Lab): Rgb {
  const l = (lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]) ** 3
  const m = (lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]) ** 3
  const s = (lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2]) ** 3
  return [
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

/** 兩個色碼在 OKLab 裡按 t（0～1）內插 */
export function mixHex(a: string, b: string, t: number): string {
  const la = toOklab(hexToRgb(a))
  const lb = toOklab(hexToRgb(b))
  return rgbToHex(fromOklab([0, 1, 2].map((i) => la[i] + (lb[i] - la[i]) * t) as Lab))
}

/** 分段色階在 t（0～1，超出就夾住）的顏色；端點與中間停靠點回傳的就是原本的 hex */
export function gradientAt(stops: ReadonlyArray<readonly [number, string]>, t: number): string {
  const x = Math.min(1, Math.max(0, t))
  for (let i = 1; i < stops.length; i += 1) {
    if (x <= stops[i][0]) {
      const [p0, c0] = stops[i - 1]
      const [p1, c1] = stops[i]
      if (x === p0) return c0
      if (x === p1) return c1
      return mixHex(c0, c1, (x - p0) / (p1 - p0))
    }
  }
  return stops[stops.length - 1][1]
}

/** 收錄率（0～無限大的比值，例如 0.9＝90%）的顏色；超過 100% 同綠；沒有可比的分母（null）是中性灰 */
export function coverageColor(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return NO_DATA_COLOR
  return gradientAt(COVERAGE_STOPS, ratio)
}

/**
 * 人數 → 色階位置（0～1）。取捨：線性會讓一個大縣（幾百人）把幾十個個位數的格子全壓成同樣的淺藍；
 * 平方根好一點但小數目仍擠在一起；這裡用 log(1+人數) 對 log(1+最大值)，個位數之間還分得出深淺，
 * 代價是大縣之間的差距看起來被壓縮（要比大縣之間的差距看提示卡的數字）。0 人另用 COUNT_ZERO_COLOR。
 */
export function countT(value: number, max: number): number {
  if (!(value > 0)) return 0
  if (!(max > 0)) return 1
  return Math.log1p(Math.min(value, max)) / Math.log1p(max)
}
export function countColor(value: number, max: number): string {
  return value > 0 ? gradientAt(COUNT_STOPS, countT(value, max)) : COUNT_ZERO_COLOR
}
/** CSS 漸層（to right）：在 OKLab 取樣 n+1 個點，瀏覽器自己只做很短的 sRGB 線性補間 */
export function cssGradient(colorAt: (t: number) => string, n = 12): string {
  const parts = Array.from({ length: n + 1 }, (_, i) => `${colorAt(i / n)} ${((i / n) * 100).toFixed(1)}%`)
  return `linear-gradient(to right, ${parts.join(', ')})`
}
