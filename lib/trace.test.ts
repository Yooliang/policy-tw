import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  dedupe, eventRoute, eventText, gapText, indexAtOrBefore, nodeCounts, parseTarget, personOf, taskTypeOfId, timeSlices, toItems, topActive,
  type NodeId, type TraceEvent,
} from './trace.ts'
import { computeLayout, pathThrough, pointAlong, polylineLength, routeBetween } from './trace-layout.ts'

const ev = (over: Partial<TraceEvent>): TraceEvent => ({
  at: '2026-11-11T02:00:00Z', kind: 'vote', task_id: null, work_key: null, contribution_id: null, politician_id: null, agent_name: null, detail: {}, ...over,
})
const PID = '122fa604-de12-4376-9949-299832a1281f'

Deno.test('parseTarget：任務編號、uuid、人名、空白', () => {
  assertEquals(parseTarget('  auto:policy_missing:abc  '), { type: 'task', id: 'auto:policy_missing:abc' })
  assertEquals(parseTarget(PID.toUpperCase()), { type: 'uuid', id: PID })
  assertEquals(parseTarget('王小明'), { type: 'name', text: '王小明' })
  assertEquals(parseTarget('   '), { type: 'none' })
})

Deno.test('toItems：照時間排序、同一毫秒照流程先後、壞時間丟掉', () => {
  const rows = [ev({ kind: 'applied' }), ev({ kind: 'submitted' }), ev({ kind: 'vote' }), ev({ at: 'x', kind: 'vote' }), ev({ at: '2026-11-11T01:00:00Z', kind: 'applied' })]
  const items = toItems(rows)
  assertEquals(items.map((i) => i.kind), ['applied', 'submitted', 'vote', 'applied'])
})

Deno.test('dedupe：交界重複的去掉，不同人的票留著', () => {
  const a = ev({ agent_name: 'a', detail: { verdict: 'agree' } })
  assertEquals(dedupe([a, { ...a }, ev({ agent_name: 'b', detail: { verdict: 'agree' } })]).length, 2)
})

Deno.test('eventRoute：交件依型別、查核依結果', () => {
  assertEquals(eventRoute(ev({ kind: 'submitted', detail: { type: 'policy' } })), ['d', 'e', 'c'])
  assertEquals(eventRoute(ev({ kind: 'submitted', detail: { type: 'task_suggestion' } })), ['d', 'e', 'a3'])
  assertEquals(eventRoute(ev({ kind: 'submitted', detail: { type: 'no_change' } })), ['d', 'e'])
  assertEquals(eventRoute(ev({ kind: 'check', detail: { outcome: 'not_found' } })), ['e', 'n', 'k'])
  assertEquals(eventRoute(ev({ kind: 'check', detail: { outcome: 'confirmed' } })), ['e'])
  assertEquals(eventRoute(ev({ kind: 'applied' })), ['v', 'l'])
  assertEquals(eventRoute(ev({ kind: 'rejected' })), ['v', 'r'])
  assertEquals(eventRoute(ev({ kind: '沒見過的' })), ['c'])
})

Deno.test('eventText：純中文、不帶編號與表名', () => {
  const kinds = ['gap_opened', 'gap_reopened', 'gap_closed', 'lease_issued', 'lease_reported', 'lease_released', 'lease_expired', 'task_created', 'task_closed',
    'request_merged', 'submitted', 'verified', 'verify_dispatched', 'vote', 'applied', 'rejected', 'check']
  for (const kind of kinds) {
    const t = eventText(ev({ kind, task_id: 'auto:x:' + PID, agent_name: '小明', detail: { verdict: 'agree', outcome: 'not_found', type: 'policy' } }))
    assert(t.length > 0 && !/auto:|_|[0-9a-f]{8}-/.test(t), `${kind}：${t}`)
  }
  assertEquals(eventText(ev({ kind: 'vote', agent_name: '小明', detail: { verdict: 'disagree' } })), '「小明」投了「反對」')
})

Deno.test('nodeCounts／indexAtOrBefore', () => {
  const items = toItems([
    ev({ at: '2026-11-11T01:00:00Z', kind: 'lease_issued' }),
    ev({ at: '2026-11-11T02:00:00Z', kind: 'verify_dispatched' }),
    ev({ at: '2026-11-11T03:00:00Z', kind: 'vote' }),
    ev({ at: '2026-11-11T04:00:00Z', kind: 'check', detail: { outcome: 'not_found' } }),
    ev({ at: '2026-11-11T05:00:00Z', kind: 'check', detail: { outcome: 'confirmed' } }),
    ev({ at: '2026-11-11T06:00:00Z', kind: 'applied' }),
  ])
  assertEquals(nodeCounts(items), { d: 2, v: 1, n: 1, l: 1 })
  assertEquals(nodeCounts(items, 1), { d: 2 })
  assertEquals(indexAtOrBefore(items, Date.parse('2026-11-11T03:30:00Z')), 2)
  assertEquals(indexAtOrBefore(items, Date.parse('2026-11-11T00:00:00Z')), -1)
  assertEquals(indexAtOrBefore(items, Date.parse('2027-01-01T00:00:00Z')), 5)
})

Deno.test('topActive：任務與人物各自排行；缺口編號裡的人物也算', () => {
  const items = toItems([
    ev({ kind: 'gap_opened', task_id: `auto:policy_missing:${PID}:2024` }),
    ev({ kind: 'lease_issued', task_id: `auto:policy_missing:${PID}:2024` }),
    ev({ kind: 'submitted', task_id: 'manual-task', politician_id: PID }),
  ])
  const top = topActive(items, 5)
  assertEquals(top.filter((t) => t.kind === 'person'), [{ kind: 'person', id: PID, count: 3 }])
  assertEquals(top.find((t) => t.kind === 'task')?.count, 2)
  assertEquals(personOf(ev({ task_id: 'manual-task' })), null)
  assertEquals(taskTypeOfId(`auto:policy_missing:${PID}`), 'policy_missing')
  assertEquals(taskTypeOfId('abc'), null)
})

Deno.test('gapText／timeSlices', () => {
  assertEquals(gapText(400), '同時')
  assertEquals(gapText(45_000), '45 秒')
  assertEquals(gapText(12 * 60_000), '12 分')
  assertEquals(gapText((3 * 60 + 10) * 60_000), '3 小時 10 分')
  assertEquals(gapText((2 * 24 + 4) * 3_600_000), '2 天 4 小時')
  assertEquals(timeSlices(0, 10, 4), [[0, 4], [4, 8], [8, 10]])
})

// ---- 版面 ----

const WIDTHS = [320, 360, 390, 768, 1024, 1440]

Deno.test('版面：每一段線都是水平或垂直（直角）', () => {
  for (const w of WIDTHS) {
    const L = computeLayout(w)
    for (const r of L.routes) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [a, b] = [r.pts[i], r.pts[i + 1]]
        assert(a[0] === b[0] || a[1] === b[1], `${w}px ${r.from}>${r.to} 第 ${i} 段不是直角：${a} → ${b}`)
      }
    }
  }
})

Deno.test('版面：節點都在畫布內、彼此不重疊；連線都在畫布內', () => {
  for (const w of WIDTHS) {
    const L = computeLayout(w)
    const ns = Object.values(L.nodes)
    for (const n of ns) assert(n.cx - n.w / 2 >= 0 && n.cx + n.w / 2 <= L.width && n.cy - n.h / 2 >= 0 && n.cy + n.h / 2 <= L.height, `${w}px 節點 ${n.id} 超出畫布`)
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i]
      const b = ns[j]
      const overlap = Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 && Math.abs(a.cy - b.cy) < (a.h + b.h) / 2
      assert(!overlap, `${w}px 節點 ${a.id} 與 ${b.id} 重疊`)
    }
    for (const r of L.routes) for (const [x, y] of r.pts) assert(x >= 0 && x <= L.width && y >= 0 && y <= L.height, `${w}px ${r.from}>${r.to} 出畫布 (${x}, ${y})`)
  }
})

Deno.test('版面：每個事件會用到的相鄰節點都找得到直角連線', () => {
  const L = computeLayout(390)
  const pairs: Array<[NodeId, NodeId]> = [['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'c'], ['d', 'v'], ['v', 'l'], ['v', 'r'], ['e', 'n'], ['n', 'k'], ['a2', 'c'], ['e', 'a3'], ['d', 'c']]
  for (const [a, b] of pairs) {
    const pts = routeBetween(L, a, b)
    assert(pts.length >= 2, `${a}>${b}`)
    for (let i = 0; i < pts.length - 1; i++) assert(pts[i][0] === pts[i + 1][0] || pts[i][1] === pts[i + 1][1], `${a}>${b} 不是直角`)
  }
  // 反向：d>c 是 c>d 倒過來
  assertEquals(routeBetween(L, 'd', 'c'), [...routeBetween(L, 'c', 'd')].reverse())
  // 串接：d→e→c 起點在 d 底、終點在 c 右側，沒有重複接點
  const p = pathThrough(L, ['d', 'e', 'c'])
  assertEquals(p[0], routeBetween(L, 'd', 'e')[0])
  assertEquals(p[p.length - 1], routeBetween(L, 'e', 'c').at(-1))
})

Deno.test('pointAlong：起點、終點、中點', () => {
  const pts: Array<[number, number]> = [[0, 0], [10, 0], [10, 10]]
  assertEquals(polylineLength(pts), 20)
  assertEquals(pointAlong(pts, 0), [0, 0])
  assertEquals(pointAlong(pts, 0.5), [10, 0])
  assertEquals(pointAlong(pts, 1), [10, 10])
  assertEquals(pointAlong(pts, 0.75), [10, 5])
})
