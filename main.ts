import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import VueApexCharts from 'vue3-apexcharts'
import { loadMonetag } from './lib/ads'

const app = createApp(App)
app.use(router)
app.use(VueApexCharts)
app.mount('#app')

// 廣告容器已隨 App 掛好，這時才載入 Monetag 才會放進容器而不是 footer 下方
loadMonetag()
