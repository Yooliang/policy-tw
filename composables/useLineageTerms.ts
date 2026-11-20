import { ref } from 'vue'
import { supabasePublic as supabase } from '../lib/supabase'
import { isMissingRelation, withTimeoutAndRetry } from '../lib/retry'
import { mapTermRows, type RawTermRow } from '../lib/lineage-graph-terms'
import type { GraphTermRow } from '../lib/lineage-graph-types'

/**
 * 完整關係圖的任期原料（視圖 lineage_terms，#675 第一期）：脈絡涉及的人的任期＋單席首長職位的歷任。
 * 只在瀏覽器掛載後撈（關係圖頁不做伺服器端渲染）；失敗由頁面用 <LoadError inline> 顯示重試，不顯示成「沒有任期」。
 * 視圖還不存在（前端比 migration 早上線的那幾分鐘）當成沒有任期、圖只畫標籤。
 */
export function useLineageTerms() {
  const terms = ref<GraphTermRow[]>([])
  const failed = ref(false)
  const loading = ref(false)

  async function loadTerms(lineageId: string): Promise<void> {
    loading.value = true
    failed.value = false
    try {
      // query-bounds: ok — 一條脈絡涉及的人與單席職位歷任，最多幾百列
      const { data } = await withTimeoutAndRetry(`lineage terms ${lineageId}`, (signal) =>
        supabase.from('lineage_terms').select('*').eq('lineage_id', lineageId).order('start_date').limit(2000).abortSignal(signal).throwOnError())
      terms.value = mapTermRows((data ?? []) as RawTermRow[])
    } catch (err) {
      if (isMissingRelation(err)) { terms.value = []; return }
      console.error('[lineage_terms] 載入失敗：', err)
      failed.value = true
    } finally {
      loading.value = false
    }
  }

  return { terms, failed, loading, loadTerms }
}
