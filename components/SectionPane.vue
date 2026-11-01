<script setup lang="ts">
import { computed, provide, toRef, type Component } from 'vue'
import { routeLocationKey, useRoute, type RouteLocationNormalizedLoaded } from 'vue-router'
import { PANE_ACTIVE } from '../composables/usePane'

// 分頁容器的單一 pane：把「這個頁籤的路由」提供給底下的頁面（useRoute 讀到的是自己頁籤的網址，
// 目前頁就是真正的路由；背景頁是頁籤預設網址的快照），頁面元件不用知道自己在 pane 裡。
const props = defineProps<{ comp: Component; active: boolean; staticRoute: RouteLocationNormalizedLoaded }>()
const live = useRoute()
const active = toRef(props, 'active')
provide(PANE_ACTIVE, active)
const target = computed(() => (props.active ? live : props.staticRoute))
const proxy = new Proxy({} as RouteLocationNormalizedLoaded, {
  get: (_t, key) => Reflect.get(target.value, key),
  has: (_t, key) => Reflect.has(target.value, key),
  ownKeys: () => Reflect.ownKeys(target.value),
  getOwnPropertyDescriptor: (_t, key) => (Reflect.has(target.value, key) ? { enumerable: true, configurable: true, value: Reflect.get(target.value, key) } : undefined),
})
provide(routeLocationKey, proxy)
</script>

<template>
  <component :is="comp" />
</template>
