import { ref } from 'vue'

// Global state that persists across page navigation
const globalRegion = ref('All')
const regionSelectorExpanded = ref(false)

export function useGlobalState() {
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
    regionSelectorExpanded,
    setRegionSelectorExpanded,
    toggleRegionSelectorExpanded
  }
}
