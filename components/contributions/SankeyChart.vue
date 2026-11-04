<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { sankey, sankeyLeft } from 'd3-sankey'
import { linkText, nodeText, selectionStats, selNodeText, type FlowGraph, type Tone } from '../../lib/model-flow'

/** 桑基圖：寬螢幕橫向、手機直向。點節點只亮經過它的線（上下游全部），再點一次或點空白處取消。 */
const props = defineProps<{
  graph: FlowGraph; name: string; mode?: 'pct' | 'count'
  /** 以下為政黨分流圖用（/ai 都不傳）：照輸入順序排節點、最小跨度、窄螢幕不轉直向而是橫向捲動、自訂標籤 */
  keepOrder?: boolean; minSpan?: number; scroll?: boolean
  nodeLabel?: (label: string, raw: number) => string
  linkLabel?: (from: string, to: string, raw: number) => string
}>()
const emit = defineEmits<{ pick: [id: string] }>()

const COLOR: Record<Tone, string> = { good: '#16a34a', bad: '#dc2626', neutral: '#94a3b8', group: '#6366f1' }
const NODE_W = 14

const narrow = ref(false)
let mq: MediaQueryList | null = null
const onMq = () => { narrow.value = !!mq?.matches }
onMounted(() => { mq = window.matchMedia('(max-width: 639px)'); onMq(); mq.addEventListener('change', onMq) })
onBeforeUnmount(() => mq?.removeEventListener('change', onMq))

interface LNode { id: string; label: string; tone: Tone; x0: number; x1: number; y0: number; y1: number; value: number; layer: number }
interface LLink { source: LNode; target: LNode; value: number; raw: number; width: number; y0: number; y1: number; tone: Tone }

const selected = ref<string | null>(null)

const layout = computed(() => {
  const g = props.graph
  if (g.links.length === 0) return null
  const vertical = narrow.value && !props.scroll
  // 流向長度固定，並排方向的跨度隨節點數變化
  // 節點自帶欄位（col）時照欄位排，捲動模式每欄至少留 170 寬放標籤
  const hasCols = g.nodes.some((n) => n.col !== undefined)
  const nCols = hasCols ? Math.max(...g.nodes.map((n) => n.col ?? 0)) + 1 : 0
  const flowLen = vertical ? 620 : props.scroll && hasCols ? Math.max(700, nCols * 170) : 700
  const span = Math.max(props.minSpan ?? 0, vertical ? 300 : 240, Math.min(12, g.nodes.length) * (vertical ? 28 : 30))
  // 直向時先照橫向排（流向當 x），最後再把座標對調
  const res = sankey<any, any>()
    .nodeId((d: any) => d.id)
    .nodeAlign(hasCols ? ((n: any) => n.col) : sankeyLeft)
    .nodeSort(props.keepOrder ? null : undefined)
    .linkSort(props.keepOrder ? null : undefined)
    .nodeWidth(NODE_W)
    .nodePadding(props.scroll ? 14 : vertical ? 12 : 10)
    .extent([[6, 6], [flowLen - 6, span - 6]])({ nodes: g.nodes.map((n) => ({ ...n })), links: g.links.map((l) => ({ ...l, value: props.mode === 'count' ? l.raw : l.value })) }) as { nodes: LNode[]; links: LLink[] }
  const nodes = res.nodes.map((n) => (vertical ? { ...n, x0: n.y0, x1: n.y1, y0: n.x0, y1: n.x1 } : n)) as LNode[]
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // 原始件數：節點取進出兩側較大者；百分比＝佔所有模型（每個模型等寬）的比例
  const inRaw = new Map<string, number>()
  const outRaw = new Map<string, number>()
  for (const l of g.links) {
    outRaw.set(l.source, (outRaw.get(l.source) ?? 0) + l.raw)
    inRaw.set(l.target, (inRaw.get(l.target) ?? 0) + l.raw)
  }
  const rawOf = (id: string) => Math.max(inRaw.get(id) ?? 0, outRaw.get(id) ?? 0)
  const rootTotal = nodes.filter((n) => n.layer === 0).reduce((a, n) => a + n.value, 0) || 1
  // 比例模式只顯示百分比（不帶件數、不提示樣本少）；數量模式才顯示件數
  const sel = selected.value
  const stats = sel ? selectionStats(g, sel) : null
  const nodeLabel = (n: LNode) => {
    const hideShare = n.layer === 0 && n.id.startsWith('model:') // 模型是各自等寬的 100%，節點不標百分比
    const all = { label: n.label, raw: rawOf(n.id), share: (n.value / rootTotal) * 100, hideShare }
    // 選中時：其餘節點顯示「選中子集合」的值，選中的節點本身維持全體值
    if (props.nodeLabel) return props.nodeLabel(n.label, all.raw)
    if (!stats || n.id === sel) return nodeText(props.mode, all)
    const s = stats.get(n.id)!
    return selNodeText(props.mode, { label: n.label, raw: s.raw, share: s.share, allShare: all.share, hideShare, withAll: !vertical })
  }
  const links = res.links.map((l) => {
    const s = byId.get(l.source.id)!
    const t = byId.get(l.target.id)!
    const d = vertical
      ? `M${l.y0},${s.y1} C${l.y0},${(s.y1 + t.y0) / 2} ${l.y1},${(s.y1 + t.y0) / 2} ${l.y1},${t.y0}`
      : `M${s.x1},${l.y0} C${(s.x1 + t.x0) / 2},${l.y0} ${(s.x1 + t.x0) / 2},${l.y1} ${t.x0},${l.y1}`
    return { d, width: Math.max(1, l.width), tone: l.tone, source: s.id, target: t.id, label: props.linkLabel ? props.linkLabel(s.label, t.label, l.raw) : linkText(props.mode, { from: s.label, to: t.label, raw: l.raw, share: (l.value / (s.value || 1)) * 100 }) }
  })
  const W = vertical ? span : flowLen
  const H = vertical ? flowLen : span
  const maxLayer = Math.max(...nodes.map((n) => n.layer))
  // 標籤：橫向放節點右側（最後一層放左側）；直向放節點上方，擠到前一個就省略（完整內容看 title）
  const labels: { id: string; x: number; y: number; anchor: string; text: string }[] = []
  const lastRight = new Map<number, number>()
  for (const n of [...nodes].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    const text = nodeLabel(n)
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
  const nodeTitle = new Map(nodes.map((n) => [n.id, nodeLabel(n)]))
  return { nodes, links, W, H, labels, nodeTitle }
})

const lit = computed(() => {
  const L = layout.value
  const sel = selected.value
  if (!L || !sel || !L.nodes.some((n) => n.id === sel)) return null
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
const pick = (id: string) => { selected.value = selected.value === id ? null : id; emit('pick', id) }
</script>

<template>
  <div v-if="layout" class="w-full" :class="scroll ? 'overflow-x-auto' : ''">
    <svg :viewBox="`0 0 ${layout.W} ${layout.H}`" class="w-full h-auto select-none" :style="scroll ? { minWidth: `${layout.W}px` } : undefined" role="img" :aria-label="name" :data-testid="`sankey-${name}`"
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
          <title>{{ layout.nodeTitle.get(n.id) }}</title>
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
