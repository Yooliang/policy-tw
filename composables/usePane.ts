import { inject, ref, watch, type InjectionKey, type Ref } from 'vue'

/**
 * 手機版頁籤分頁容器（components/SectionPager.vue）裡，每個頁籤是一個 pane：相鄰頁籤的頁面同時掛載、各畫各的。
 * 「目前這個 pane 是不是使用者正在看的那一頁」用這個注入告訴頁面：
 * - 不是目前頁的 pane 不能動網址、不能改文件標題／canonical（usePageHead）、不能做只在進頁才做的事（清搜尋框、整頁重載…）
 * - 即時資料頁（貢獻統計、公民提問）在 pane 重新變成目前頁時背景重抓（onPaneShown），畫面先顯示舊資料
 * 不在 pane 裡（一般頁面、桌面詳情頁）注入不到，視為永遠是目前頁。
 */
export const PANE_ACTIVE: InjectionKey<Ref<boolean>> = Symbol('pane-active')
const ALWAYS = ref(true)

export function usePaneActive(): Ref<boolean> {
  return inject(PANE_ACTIVE, ALWAYS)
}

/** 這個 pane 從「背景」變回「目前頁」時呼叫（第一次掛載不算，那由 onMounted 負責） */
export function onPaneShown(fn: () => void): void {
  const active = usePaneActive()
  watch(active, (now, was) => { if (now && !was) fn() })
}

/** 手勢放開、路由還沒落定的這段時間，分頁容器先顯示這個頁籤（網址改完後清掉），點頁籤／滑過去立刻換畫面 */
export const pagerPendingKey = ref<string | null>(null)
