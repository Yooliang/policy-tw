/**
 * 統計頁圖例的唯一樣式（2026-09-18）：圓點＋文字、放在圖的下方、置中。
 * 以「缺口走勢」原本的設定為準。ApexCharts 的圖直接用這份；
 * 自己畫的圖例（運作狀態、貢獻榜）用 components/ChartLegend.vue，長相照這份刻。
 */
export const CHART_LEGEND = {
  show: true,
  position: 'bottom' as const,
  horizontalAlign: 'center' as const,
  fontSize: '11px',
  markers: { size: 5 },
  itemMargin: { horizontal: 6, vertical: 2 },
}
