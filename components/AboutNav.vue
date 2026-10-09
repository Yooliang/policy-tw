<script setup lang="ts">
import { Info, MessagesSquare, FileText, ShieldCheck } from 'lucide-vue-next'
import HeroAction from './HeroAction.vue'

/**
 * 關於正見／聯絡我們／使用條款／隱私權政策四頁互相切換的同一組按鈕（像分頁），放在各頁 Hero 的動作區，
 * 四頁共用、順序與文案跟頁尾「關於」那一欄一致，只有本頁 active（維護者 2026-10-09；工作單 Yooliang/policy-ops#34）。
 * 寫法照 MechanismNav。要改文字或目的地只改這裡，頁尾 Footer.vue 的「關於」欄要一起改。
 */
export type AboutPage = 'vision' | 'contact' | 'terms' | 'privacy'

defineProps<{ current: AboutPage }>()

const ITEMS: Array<{ key: AboutPage; to: string; label: string; icon: typeof Info }> = [
  { key: 'vision', to: '/vision', label: '關於正見', icon: Info },
  { key: 'contact', to: '/contact', label: '聯絡我們', icon: MessagesSquare },
  { key: 'terms', to: '/terms', label: '使用條款', icon: FileText },
  { key: 'privacy', to: '/privacy', label: '隱私權政策', icon: ShieldCheck },
]
</script>

<template>
  <HeroAction v-for="item in ITEMS" :key="item.key" :to="item.key === current ? undefined : item.to" :active="item.key === current">
    <component :is="item.icon" :size="16" /> {{ item.label }}
  </HeroAction>
</template>
