import { defineComponent } from 'vue'

/**
 * 邊緣 SSR 用的 apexcharts 替身（vite.ssr.config.ts 把 vue3-apexcharts／apexcharts 指到這裡）。
 * 圖表元件全都包在 ClientOnly 或 defineAsyncComponent 裡、只在瀏覽器渲染；但 Vite 對 webworker 目標的 SSR 建置
 * 會把動態 import 全部 inline，ApexCharts 的模組頂層一載入就碰 window → Worker 起不來。伺服器端根本不需要它，給個空元件。
 */
const Stub = defineComponent({ name: 'ApexChartStub', setup: () => () => null })
export default Stub
