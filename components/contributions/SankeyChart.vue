<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { sankey, sankeyLeft } from 'd3-sankey'
import type { FlowGraph, Tone } from '../../lib/model-flow'

/** 桑基圖：寬螢幕橫向、手機直向。點節點只亮經過它的線（上下游全部），再點一次或點空白處取消。 */
const props = defineProps<{ graph: FlowGraph; name: string }>()

const COLOR: Record<Tone, string> = { good: '#16a34a', bad: '#dc2626', neutral: '#94a3b8', group: '#6366f1' }
const NODE_W = 14

const narrow = ref(false)
let mq: MediaQueryList | null = null
const onMq = () => { narrow.value = !!mq?.matches }
onMounted(() => { mq = window.matchMedia('(max-width: 639px)'); onMq(); mq.addEventListener('change', onMq) })
onBeforeUnmount(() => mq?.removeEventListener('change', onMq))

interface LNode { id: string; label: string; tone: Tone; x0: number; x1: number; y0: number; y1: number; value: number; layer: number }
interface LLink { source: LNode; target: LNode; value: number; width: number; y0: number; y1: number; tone: Tone }

const layout = computed(() => {
  const g = props.graph
  if (g.links.length === 0) return null
  const vertical = narrow.value
  // 流向長度固定，並排方向的跨度隨節點數變化
  const flowLen = vertical ? 620 : 700
  const span = Math.max(vertical ? 300 : 240, Math.min(12, g.nodes.length) * (vertical ? 28 : 30))
  // 直向時先照橫向排（流向當 x），最後再把座標對調
  const res = sankey<any, any>()
    .nodeId((d: any) => d.id)
    .nodeAlign(sankeyLeft)
    .nodeWidth(NODE_W)
    .nodePadding(vertical ? 12 : 10)
    .extent([[6, 6], [flowLen - 6, span - 6]])({ nodes: g.nodes.map((n) => ({ ...n })), links: g.links.map((l) => ({ ...l })) }) as { nodes: LNode[]; links: LLink[] }
  const nodes = res.nodes.map((n) => (vertical ? { ...n, x0: n.y0, x1: n.y1, y0: n.x0, y1: n.x1 } : n)) as LNode[]
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const links = res.links.map((l) => {
    const s = byId.get(l.source.id)!
    const t = byId.get(l.target.id)!
    const d = vertical
      ? `M${l.y0},${s.y1} C${l.y0},${(s.y1 + t.y0) / 2} ${l.y1},${(s.y1 + t.y0) / 2} ${l.y1},${t.y0}`
      : `M${s.x1},${l.y0} C${(s.x1 + t.x0) / 2},${l.y0} ${(s.x1 + t.x0) / 2},${l.y1} ${t.x0},${l.y1}`
    return { d, width: Math.max(1, l.width), tone: l.tone, source: s.id, target: t.id, label: `${s.label} → ${t.label}：${l.value.toLocaleString()}` }
  })
  const W = vertical ? span : flowLen
  const H = vertical ? flowLen : span
  const maxLayer = Math.max(...nodes.map((n) => n.layer))
  // 標籤：橫向放節點右側（最後一層放左側）；直向放節點上方，擠到前一個就省略（完整內容看 title）
  const labels: { id: string; x: number; y: number; anchor: string; text: string }[] = []
  const lastRight = new Map<number, number>()
  for (const n of [...nodes].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    const text = `${n.label} ${n.value.toLocaleString()}`
    if (!vertical) {
      const left = n.layer === maxLayer
      labels.push({ id: n.id, x: left ? n.x0 - 5 : n.x1 + 5, y: (n.y0 + n.y1) / 2 + 4, anchor: left ? 'end' : 'start', text })
    } else {
      const w = text.length * 11
      const start = Math.min(Math.max(n.x0, 4), W - w - 4)
      const key = Math.round(n.y0)
      if ((lastRight.get(key) ?? -1) > start) continue
      lastRight.set(key, start + w + 6)
      labels.push({ id: n.id, x: start, y: n.y0 - 4, anchor: 'start', text })
    }
  }
  return { nodes, links, W, H, labels }
})

const selected = ref<string | null>(null)
const lit = computed(() => {
  const L = layout.value
  const sel = selected.value
  if (!L || !sel) return null
  const nodes = new Set<string>([sel])
  const links = new Set<number>()
  for (const dir of ['down', 'up'] as const) {
    const queue = [sel]
    while (queue.length) {
      const cur = queue.pop()!
      L.links.forEach((l, i) => {
        const from = dir === 'down' ? l.source : l.target
        const to = dir === 'down' ? l.target : l.source
        if (from !== cur) return
        links.add(i)
        if (!nodes.has(to)) { nodes.add(to); queue.push(to) }
      })
    }
  }
  return { nodes, links }
})
const pick = (id: string) => { selected.value = selected.value === id ? null : id }
</script>

<template>
  <div v-if="layout" class="w-full">
    <svg :viewBox="`0 0 ${layout.W} ${layout.H}`" class="w-full h-auto select-none" role="img" :aria-label="name" :data-testid="`sankey-${name}`"
      @click="selected = null">
      <g fill="none">
        <path v-for="(l, i) in layout.links" :key="i" :d="l.d" :stroke="COLOR[l.tone]" :stroke-width="l.width"
          :stroke-opacity="lit ? (lit.links.has(i) ? 0.55 : 0.07) : 0.28">
          <title>{{ l.label }}</title>
        </path>
      </g>
      <g>
        <rect v-for="n in layout.nodes" :key="n.id" :x="n.x0" :y="n.y0" :width="Math.max(1, n.x1 - n.x0)" :height="Math.max(1, n.y1 - n.y0)"
          :fill="COLOR[n.tone]" :opacity="lit && !lit.nodes.has(n.id) ? 0.25 : 1" class="cursor-pointer" @click.stop="pick(n.id)">
          <title>{{ n.label }}：{{ n.value.toLocaleString() }}</title>
        </rect>
      </g>
      <g font-size="11" fill="#334155">
        <text v-for="t in layout.labels" :key="t.id" :x="t.x" :y="t.y" :text-anchor="t.anchor" :opacity="lit && !lit.nodes.has(t.id) ? 0.3 : 1"
          class="cursor-pointer" @click.stop="pick(t.id)">{{ t.text }}</text>
      </g>
    </svg>
  </div>
  <p v-else class="text-sm text-slate-400">這段期間沒有資料。</p>
</template>
