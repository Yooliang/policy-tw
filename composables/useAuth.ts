import { ref, computed } from 'vue'
import { supabase } from '../lib/supabase'
import type { User, Session } from '@supabase/supabase-js'

// Global auth state
const user = ref<User | null>(null)
const session = ref<Session | null>(null)
const loading = ref(true)
const initialized = ref(false)
const isAdminRef = ref(false)
const authReady = ref(false)

// Check admin status from DB
async function checkAdminStatus(userId: string) {
  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('is_admin')
      .eq('id', userId)
      .single()
    isAdminRef.value = data?.is_admin === true
  } catch {
    isAdminRef.value = false
  }
}

// Initialize auth state
let initPromise: Promise<void> | null = null

async function initAuth() {
  if (initialized.value) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    try {
      // Get current session
      const { data: { session: currentSession } } = await supabase.auth.getSession()
      session.value = currentSession
      user.value = currentSession?.user ?? null

      if (currentSession?.user) {
        await checkAdminStatus(currentSession.user.id)
      }

      // Listen for auth changes
      supabase.auth.onAuthStateChange(async (_event, newSession) => {
        session.value = newSession
        user.value = newSession?.user ?? null
        if (newSession?.user) {
          await checkAdminStatus(newSession.user.id)
        } else {
          isAdminRef.value = false
        }
      })

      initialized.value = true
    } catch (error) {
      // 常見的是瀏覽器裡留著過期的 refresh token：換發回 400，然後每次進站都再試一次。
      // 把壞掉的 session 清乾淨，下一次載入就沒有東西可以重試了。
      // （2026-09-14 線上事故：這個狀態會讓整站資料載不出來，見 lib/supabase.ts 的說明。
      //   資料層已經改用不碰 auth 的 client，所以現在最壞情況只是「沒有登入」。）
      console.error('Failed to initialize auth:', error)
      try {
        await supabase.auth.signOut({ scope: 'local' })
      } catch {
        // 清不掉就算了：資料層不靠它，畫面照樣是完整的
      }
      initialized.value = true
    } finally {
      loading.value = false
      authReady.value = true
    }
  })()

  return initPromise
}

// Sign in with Google
async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    },
  })

  if (error) {
    console.error('Google sign in error:', error)
    throw error
  }
}

// Sign out
async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) {
    console.error('Sign out error:', error)
    throw error
  }
  user.value = null
  session.value = null
  isAdminRef.value = false
}

// Computed properties
const isAuthenticated = computed(() => !!user.value)
const userDisplayName = computed(() => {
  if (!user.value) return ''
  return user.value.user_metadata?.full_name || user.value.email?.split('@')[0] || '用戶'
})
const userAvatarUrl = computed(() => {
  if (!user.value) return ''
  return user.value.user_metadata?.avatar_url || user.value.user_metadata?.picture || ''
})
const userEmail = computed(() => user.value?.email || '')
const isAdmin = computed(() => isAdminRef.value)

export function useAuth() {
  // Initialize on first use（建置預渲染時沒有瀏覽器 session，跳過；客戶端 hydrate 後才初始化）
  if (!initialized.value && !import.meta.env.SSR) {
    initAuth()
  }

  return {
    user,
    session,
    loading,
    authReady,
    isAuthenticated,
    isAdmin,
    userDisplayName,
    userAvatarUrl,
    userEmail,
    signInWithGoogle,
    signOut,
    initAuth,
  }
}
