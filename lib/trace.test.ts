import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  dedupe, eventRoute, eventText, gapText, indexAtOrBefore, nodeCounts, parseTarget, personOf, taskTypeOfId, timeSlices, toItems, topActive,
  type NodeId, type TraceEvent,
} from './trace.ts'
import { BASE_H, BASE_W, LINKS, NODE_DEFS, NODE_H, NODE_W, anchorPoint, computeLayout, pathThrough, pointAlong, polylineLength, routeBetween } from './trace-layout.ts'

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

Deno.test('eventRoute：交件依型別、查核依結果、系統票走 Jev', () => {
  assertEquals(eventRoute(ev({ kind: 'submitted', detail: { type: 'policy' } })), ['dispatcher', 'submit', 'jev', 'queue'])
  assertEquals(eventRoute(ev({ kind: 'submitted', detail: { type: 'task_suggestion' } })), ['dispatcher', 'submit', 'jev', 'suggest', 'card'])
  assertEquals(eventRoute(ev({ kind: 'submitted', detail: { type: 'no_change' } })), ['dispatcher', 'submit'])
  assertEquals(eventRoute(ev({ kind: 'check', detail: { outcome: 'not_found' } })), ['submit', 'notfound', 'cooldown'])
  assertEquals(eventRoute(ev({ kind: 'check', detail: { outcome: 'confirmed' } })), ['submit'])
  assertEquals(eventRoute(ev({ kind: 'verify_dispatched' })), ['dispatcher', 'vote'])
  assertEquals(eventRoute(ev({ kind: 'vote', agent_name: 'Jev' })), ['jev', 'vote'])
  assertEquals(eventRoute(ev({ kind: 'vote', agent_name: '小明' })), ['vote'])
  assertEquals(eventRoute(ev({ kind: 'applied' })), ['vote', 'applied'])
  assertEquals(eventRoute(ev({ kind: 'rejected' })), ['vote', 'rejected'])
  assertEquals(eventRoute(ev({ kind: 'gap_opened' })), ['detector', 'card', 'queue'])
  assertEquals(eventRoute(ev({ kind: 'request_merged' })), ['visitor', 'card'])
  assertEquals(eventRoute(ev({ kind: 'lease_issued' })), ['queue', 'dispatcher'])
  assertEquals(eventRoute(ev({ kind: '沒見過的' })), ['queue'])
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
  assertEquals(nodeCounts(items), { dispatcher: 2, vote: 1, notfound: 1, applied: 1 })
  assertEquals(nodeCounts(items, 1), { dispatcher: 2 })
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

// ---- 版面（維護者 2026-11-11 定案：16 個節點、22 條線、基準畫布 697×820） ----

const WIDTHS = [520, 697, 768, 1024, 1440]
const EXPECTED_NODES: Record<string, [number, number]> = {
  official: [87, 41], detector: [87, 123], card: [87, 205], queue: [87, 287], dispatcher: [87, 369], vote: [87, 451], applied: [87, 697],
  visitor: [261, 41], suggest: [436, 41], jev: [261, 287], submit: [436, 451], notfound: [610, 533], cooldown: [610, 615],
  dispute: [261, 451], strongLane: [261, 533], rejected: [436, 615],
}
const EXPECTED_LINKS = [
  'official b2 detector r1', 'detector b2 card t2', 'card b2 queue t2', 'queue b2 dispatcher t2', 'dispatcher b2 vote t2', 'vote b2 applied t2',
  'visitor b2 card r0', 'suggest b1 card r1', 'jev r0 suggest b3', 'submit t3 jev r2', 'dispatcher r1 submit t1', 'jev t2 queue t4',
  'jev l2 vote r0', 'vote b4 dispute l2', 'dispute b2 strongLane t2', 'strongLane b1 applied r1', 'strongLane b3 rejected t2',
  'vote b3 rejected l1', 'submit r1 notfound t2', 'notfound b2 cooldown t2', 'cooldown l1 rejected r1', 'cooldown r1 card r2',
]

Deno.test('版面：16 個節點、全 126×36、中心座標照維護者定案、基準畫布 697×820', () => {
  assertEquals([BASE_W, BASE_H, NODE_W, NODE_H], [697, 820, 126, 36])
  assertEquals(NODE_DEFS.length, 16)
  const L = computeLayout(BASE_W)
  assertEquals(L.width, 697)
  assertEquals(L.height, 820)
  for (const [id, [cx, cy]] of Object.entries(EXPECTED_NODES)) {
    const n = L.nodes[id as NodeId]
    assertEquals([n.cx, n.cy, n.w, n.h], [cx, cy, 126, 36], id)
  }
})

Deno.test('版面：22 條線的起訖與連接點（左右 3 個、上下 5 個）照定案', () => {
  assertEquals(LINKS.map((l) => `${l.from} ${l.fromSide}${l.fromIdx} ${l.to} ${l.toSide}${l.toIdx}`), EXPECTED_LINKS)
  for (const l of LINKS) {
    for (const [side, idx] of [[l.fromSide, l.fromIdx], [l.toSide, l.toIdx]] as const) {
      assert(idx >= 0 && idx <= (side === 't' || side === 'b' ? 4 : 2), `${l.from}>${l.to} 連接點 ${side}${idx} 超出範圍`)
    }
  }
  const L = computeLayout(BASE_W)
  // 起點、終點真的落在連接點上
  for (const [i, l] of LINKS.entries()) {
    const pts = L.routes[i].pts
    assertEquals(pts[0], anchorPoint(l.from, l.fromSide, l.fromIdx))
    assertEquals(pts[pts.length - 1], anchorPoint(l.to, l.toSide, l.toIdx))
  }
  // 連接點在節點邊上：上下側 x 差 24 一格、左右側 y 差 10 一格
  assertEquals(anchorPoint('queue', 't', 0), [39, 269])
  assertEquals(anchorPoint('queue', 'b', 4), [135, 305])
  assertEquals(anchorPoint('queue', 'l', 1), [24, 287])
  assertEquals(anchorPoint('queue', 'r', 2), [150, 297])
})

Deno.test('版面：每一段線都是水平或垂直（直角），任何寬度都一樣', () => {
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

Deno.test('版面：節點與連線都在畫布內、節點彼此不重疊、線不穿過別的節點', () => {
  for (const w of WIDTHS) {
    const L = computeLayout(w)
    const ns = Object.values(L.nodes)
    for (const n of ns) assert(n.cx - n.w / 2 >= 0 && n.cx + n.w / 2 <= L.width && n.cy - n.h / 2 >= 0 && n.cy + n.h / 2 <= L.height, `${w}px 節點 ${n.id} 超出畫布`)
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i]
      const b = ns[j]
      assert(!(Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 && Math.abs(a.cy - b.cy) < (a.h + b.h) / 2), `${w}px 節點 ${a.id} 與 ${b.id} 重疊`)
    }
    for (const r of L.routes) {
      for (const [x, y] of r.pts) assert(x >= 0 && x <= L.width && y >= 0 && y <= L.height, `${w}px ${r.from}>${r.to} 出畫布 (${x}, ${y})`)
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [x1, y1] = r.pts[i]
        const [x2, y2] = r.pts[i + 1]
        for (const n of ns) {
          if (n.id === r.from || n.id === r.to) continue
          const eps = 0.01
          const inX = Math.max(x1, x2) > n.cx - n.w / 2 + eps && Math.min(x1, x2) < n.cx + n.w / 2 - eps
          const inY = Math.max(y1, y2) > n.cy - n.h / 2 + eps && Math.min(y1, y2) < n.cy + n.h / 2 - eps
          assert(!(inX && inY), `${w}px ${r.from}>${r.to} 穿過節點 ${n.id}`)
        }
      }
    }
  }
})

Deno.test('版面：所有事件會用到的相鄰節點都找得到直角連線', () => {
  const L = computeLayout(697)
  const pairs: Array<[NodeId, NodeId]> = [
    ['detector', 'card'], ['card', 'queue'], ['queue', 'dispatcher'], ['dispatcher', 'queue'], ['dispatcher', 'submit'], ['submit', 'jev'], ['jev', 'queue'],
    ['jev', 'suggest'], ['suggest', 'card'], ['visitor', 'card'], ['dispatcher', 'vote'], ['vote', 'applied'], ['vote', 'rejected'], ['submit', 'notfound'],
    ['notfound', 'cooldown'], ['jev', 'vote'], ['dispute', 'strongLane'], ['strongLane', 'rejected'],
  ]
  for (const [a, b] of pairs) {
    const pts = routeBetween(L, a, b)
    assert(pts.length >= 2, `${a}>${b}`)
    for (let i = 0; i < pts.length - 1; i++) assert(pts[i][0] === pts[i + 1][0] || pts[i][1] === pts[i + 1][1], `${a}>${b} 不是直角`)
  }
  assertEquals(routeBetween(L, 'dispatcher', 'queue'), [...routeBetween(L, 'queue', 'dispatcher')].reverse())
  // 串接：dispatcher→submit→jev 接點不重複
  const p = pathThrough(L, ['dispatcher', 'submit', 'jev'])
  assertEquals(p[0], routeBetween(L, 'dispatcher', 'submit')[0])
  assertEquals(p[p.length - 1], routeBetween(L, 'submit', 'jev').at(-1))
})

Deno.test('等比縮放：寬度加倍，座標與尺寸都加倍', () => {
  const a = computeLayout(697)
  const b = computeLayout(1394)
  assertEquals(b.scale, 2)
  assertEquals(b.nodes.queue.w, a.nodes.queue.w * 2)
  assertEquals(b.routes[0].pts[1], [a.routes[0].pts[1][0] * 2, a.routes[0].pts[1][1] * 2])
})

Deno.test('pointAlong：起點、終點、中點', () => {
  const pts: Array<[number, number]> = [[0, 0], [10, 0], [10, 10]]
  assertEquals(polylineLength(pts), 20)
  assertEquals(pointAlong(pts, 0), [0, 0])
  assertEquals(pointAlong(pts, 0.5), [10, 0])
  assertEquals(pointAlong(pts, 1), [10, 10])
  assertEquals(pointAlong(pts, 0.75), [10, 5])
})
