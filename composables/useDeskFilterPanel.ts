import { ref } from 'vue'

/**
 * 桌面版政見區的「地區／分類」面板開關（左欄的篩選列與主區的方塊格共用）。
 * 左欄（DeskExtNav）點「地區」「分類」切換；主區（RegionCategoryPicker）依它顯示對應的方塊格，選了就收起。
 * 縣市本身仍是全站共用的 globalRegion（useGlobalState），分類是各頁自己的篩選，這裡只管面板開不開。
 */
export type DeskFilterPanel = 'region' | 'category' | null

const panel = ref<DeskFilterPanel>(null)

export function useDeskFilterPanel() {
  return {
    panel,
    /** 同一列再點一次＝收起 */
    togglePanel: (which: Exclude<DeskFilterPanel, null>) => { panel.value = panel.value === which ? null : which },
    openPanel: (which: Exclude<DeskFilterPanel, null>) => { panel.value = which },
    closePanel: () => { panel.value = null },
  }
}
