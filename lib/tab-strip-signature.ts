/** 分頁條需要重量底線位置的依據：分頁的 key 與文字任何一個變了（不只數量）寬度就會變。 */
export function tabStripSignature(tabs: { key: string; label: string }[]): string {
  return tabs.map(t => `${t.key}\u0000${t.label}`).join('\u0001')
}
