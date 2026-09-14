<script setup lang="ts">
import { AlertTriangle, RefreshCw } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'

const { error, retry } = useSupabase()
</script>

<template>
  <div class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center px-4">
      <AlertTriangle :size="64" class="mx-auto mb-4 text-amber-400" />
      <h2 class="text-2xl font-bold text-navy-900 mb-2">資料暫時載入不了</h2>
      <p class="text-slate-500 mb-6">{{ error }}。可能是網路不穩或伺服器忙碌，請再試一次。</p>
      <button @click="retry()" class="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all inline-flex items-center gap-2">
        <RefreshCw :size="18" /> 重試
      </button>
    </div>
  </div>
</template>
