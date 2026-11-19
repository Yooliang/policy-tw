import { ref } from 'vue'

// Global state that persists across page navigation
const globalRegion = ref('All')
// 分類也是全站共用（2026-11-19）：全部政見、政策脈絡、數據分佈三頁的左欄與主區方塊格讀同一份，跨頁保留；'All'＝全部
const globalCategory = ref('All')
const regionSelectorExpanded = ref(false)

export function useGlobalState() {
  const setGlobalCategory = (category: string) => {
    globalCategory.value = category
  }

  const setGlobalRegion = (region: string) => {
    globalRegion.value = region
  }

  const setRegionSelectorExpanded = (expanded: boolean) => {
    regionSelectorExpanded.value = expanded
  }

  const toggleRegionSelectorExpanded = () => {
    regionSelectorExpanded.value = !regionSelectorExpanded.value
  }

  return {
    globalRegion,
    setGlobalRegion,
    globalCategory,
    setGlobalCategory,
    regionSelectorExpanded,
    setRegionSelectorExpanded,
    toggleRegionSelectorExpanded
  }
}
