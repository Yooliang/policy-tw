<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { supabase } from '../lib/supabase'
import { Loader2 } from 'lucide-vue-next'

const router = useRouter()

onMounted(async () => {
  try {
    // Handle the OAuth callback
    const { error } = await supabase.auth.getSession()

    if (error) {
      console.error('Auth callback error:', error)
    }

    // Redirect to home page after processing
    router.replace('/')
  } catch (err) {
    console.error('Auth callback failed:', err)
    router.replace('/')
  }
})
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-slate-50">
    <div class="text-center">
      <Loader2 :size="48" class="animate-spin text-blue-600 mx-auto mb-4" />
      <p class="text-slate-600 font-medium">登入中...</p>
    </div>
  </div>
</template>
