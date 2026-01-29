import { ref, computed } from 'vue'
import { supabase } from '../lib/supabase'
import type { User, Session } from '@supabase/supabase-js'

// Global auth state
const user = ref<User | null>(null)
const session = ref<Session | null>(null)
const loading = ref(true)
const initialized = ref(false)

// Initialize auth state
async function initAuth() {
  if (initialized.value) return

  try {
    // Get current session
    const { data: { session: currentSession } } = await supabase.auth.getSession()
    session.value = currentSession
    user.value = currentSession?.user ?? null

    // Listen for auth changes
    supabase.auth.onAuthStateChange((_event, newSession) => {
      session.value = newSession
      user.value = newSession?.user ?? null
    })

    initialized.value = true
  } catch (error) {
    console.error('Failed to initialize auth:', error)
  } finally {
    loading.value = false
  }
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

export function useAuth() {
  // Initialize on first use
  if (!initialized.value) {
    initAuth()
  }

  return {
    user,
    session,
    loading,
    isAuthenticated,
    userDisplayName,
    userAvatarUrl,
    userEmail,
    signInWithGoogle,
    signOut,
    initAuth,
  }
}
