/**
 * 人名排序＝姓名筆畫（維護者 2026-10-20）：不先比字數，直接用 ICU 台灣預設的筆畫序——
 * 先比第一字筆畫、同筆畫再比後面的字。「王小明」因此排在「歐陽」前面（王 4 畫、歐 15 畫）。
 * 先比字數是地名的規則（lib/region-name.ts 的 compareRegionName），人名不用。
 */
export function comparePersonName(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hant-TW')
}

/** 帶 id 的人物比較：姓名筆畫，並列（同名同姓）依 id，輸出才穩定 */
export function comparePerson(a: { name: string; id: string | number }, b: { name: string; id: string | number }): number {
  const byName = comparePersonName(a.name, b.name)
  if (byName !== 0) return byName
  const ai = String(a.id)
  const bi = String(b.id)
  return ai < bi ? -1 : ai > bi ? 1 : 0
}
