import { ref } from 'vue'

const globalRegion = ref('All')

export function useGlobalState() {
  const setGlobalRegion = (region: string) => {
    globalRegion.value = region
  }

  return {
    globalRegion,
    setGlobalRegion
  }
}
