import { computed, ref, watch } from 'vue'
import { supabase } from '../lib/supabase'
import { useAuth } from './useAuth'

/**
 * 我的追蹤（檢核點）：未登入存瀏覽器，登入後帶著走。
 *
 * 2026-09-17：「沒登入也能用嗎？登入沒記錄這個嗎？」——兩個都成立。
 * 原本四個地方各自 JSON.parse(localStorage)，登入與否毫無差別，換台機器就全沒了。
 *
 * 現在的規則：
 *   未登入 → 只寫 localStorage，行為跟以前一模一樣（不逼人註冊才能追蹤政見）
 *   登入時 → 本機與雲端取聯集，兩邊補齊（在 A 機器加的、在 B 機器看得到）
 *   登入後 → 每次切換兩邊一起寫；雲端寫失敗不影響本機，只在 console 留下原因
 *
 * 合併刻意用聯集而不是「以雲端為準」：使用者在沒登入時加的那幾筆是真的操作，
 * 登入不該把它們洗掉。取消追蹤才是刪除，那是明確的意思表示。
 */

const LS_KEY = 'zhengjian_checkpoints'
/** 舊程式碼監聽這個事件重讀 localStorage，改寫時要一起發，不然那些頁面不會更新 */
const UPDATED_EVENT = 'checkpoints_updated'

const ids = ref<string[]>([])
const syncing = ref(false)
let loaded = false
let syncedFor: string | null = null

function readLocal(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeLocal(next: string[]): void {
  ids.value = next
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next))
    window.dispatchEvent(new Event(UPDATED_EVENT))
  } catch (e) {
    // 無痕視窗或關閉儲存空間時會丟例外；畫面仍然照 ids 顯示，只是重整後會不見
    console.info('[我的追蹤] 寫不進 localStorage：', e)
  }
}

/** 登入時把本機與雲端合併（聯集），兩邊補齊 */
async function syncWithAccount(userId: string): Promise<void> {
  if (syncedFor === userId) return
  syncedFor = userId
  syncing.value = true
  try {
    const { data, error } = await supabase.from('user_checkpoints').select('policy_id').eq('user_id', userId)
    if (error) throw error
    const remote = (data ?? []).map((r) => (r as { policy_id: string }).policy_id)
    const local = readLocal()
    const union = [...new Set([...remote, ...local])]
    const missingRemotely = local.filter((id) => !remote.includes(id))
    if (missingRemotely.length > 0) {
      const { error: insErr } = await supabase.from('user_checkpoints')
        .upsert(missingRemotely.map((policy_id) => ({ user_id: userId, policy_id })), { onConflict: 'user_id,policy_id' })
      if (insErr) throw insErr
    }
    writeLocal(union)
  } catch (e) {
    // 同步失敗不該讓追蹤功能整個壞掉：本機那份仍然可用
    syncedFor = null
    console.info('[我的追蹤] 與帳號同步失敗，這台機器的清單仍可使用：', e)
  } finally {
    syncing.value = false
  }
}

export function useCheckpoints() {
  const { user, isAuthenticated } = useAuth()

  if (!loaded && typeof window !== 'undefined') {
    loaded = true
    ids.value = readLocal()
    // 別的分頁或舊程式碼改了 localStorage 時跟上
    window.addEventListener(UPDATED_EVENT, () => { ids.value = readLocal() })
    window.addEventListener('storage', (e) => { if (e.key === LS_KEY) ids.value = readLocal() })
  }

  watch(() => user.value?.id ?? null, (id) => {
    if (id) syncWithAccount(id)
    else syncedFor = null
  }, { immediate: true })

  function isCheckpointed(policyId: string): boolean {
    return ids.value.includes(policyId)
  }

  async function toggle(policyId: string): Promise<boolean> {
    const has = isCheckpointed(policyId)
    const next = has ? ids.value.filter((id) => id !== policyId) : [...ids.value, policyId]
    writeLocal(next)

    const userId = user.value?.id
    if (!userId) return !has
    try {
      if (has) {
        const { error } = await supabase.from('user_checkpoints').delete().eq('user_id', userId).eq('policy_id', policyId)
        if (error) throw error
      } else {
        const { error } = await supabase.from('user_checkpoints')
          .upsert({ user_id: userId, policy_id: policyId }, { onConflict: 'user_id,policy_id' })
        if (error) throw error
      }
    } catch (e) {
      console.info('[我的追蹤] 這一筆沒存進帳號（本機已記下）：', e)
    }
    return !has
  }

  return {
    checkpoints: computed(() => ids.value),
    count: computed(() => ids.value.length),
    syncing: computed(() => syncing.value),
    /** 登入了才有「帶著走」這件事；沒登入時畫面不必提 */
    synced: computed(() => isAuthenticated.value && syncedFor !== null),
    isCheckpointed,
    toggle,
    reload: () => { ids.value = readLocal() },
  }
}
