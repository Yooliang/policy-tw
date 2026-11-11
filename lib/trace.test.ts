import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  dedupe, eventRoute, strongBreakdown, systemVoteBreakdown, eventText, gapText, indexAtOrBefore, nodeCounts, parseTarget, personOf, taskTypeOfId, timeSlices, toItems, topActive,
  type NodeId, type TraceEvent,
} from './trace.ts'
import { CANVAS_H, CANVAS_W, LINKS, NODE_DEFS, NODE_H, NODE_W, anchorPoint, computeLayout, pathThrough, pointAlong, polylineLength, routeBetween } from './trace-layout.ts'

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
  assertEquals(eventRoute(ev({ kind: 'submitted', detail: { type: 'policy' } })), ['dispatcher', 'submit', 'jevSort', 'queue'])
  assertEquals(eventRoute(ev({ kind: 'submitted', detail: { type: 'task_suggestion' } })), ['dispatcher', 'submit', 'jevSort', 'suggest', 'card'])
  assertEquals(eventRoute(ev({ kind: 'submitted', detail: { type: 'no_change' } })), ['dispatcher', 'submit'])
  assertEquals(eventRoute(ev({ kind: 'check', detail: { outcome: 'not_found' } })), ['submit', 'notfound', 'cooldown'])
  assertEquals(eventRoute(ev({ kind: 'check', detail: { outcome: 'confirmed' } })), ['submit'])
  assertEquals(eventRoute(ev({ kind: 'verify_dispatched' })), ['dispatcher', 'vote'])
  assertEquals(eventRoute(ev({ kind: 'system_vote', agent_name: 'Jev' })), ['jevVote', 'vote'])
  assertEquals(eventRoute(ev({ kind: 'system_check', agent_name: 'Jev' })), ['jevSort'])
  assertEquals(eventRoute(ev({ kind: 'disputed' })), ['vote', 'dispute'])
  assertEquals(eventRoute(ev({ kind: 'strong_claim' })), ['dispute', 'strongLane'])
  assertEquals(eventRoute(ev({ kind: 'strong_finalized', detail: { verdict: 'uphold' } })), ['strongLane', 'applied'])
  assertEquals(eventRoute(ev({ kind: 'strong_finalized', detail: { verdict: 'uphold_with_correction' } })), ['strongLane', 'applied'])
  assertEquals(eventRoute(ev({ kind: 'strong_finalized', detail: { verdict: 'reject' } })), ['strongLane', 'rejected'])
  // 不再用名稱判系統票：投票表裡叫 Jev 的也只是一般投票
  assertEquals(eventRoute(ev({ kind: 'vote', agent_name: 'Jev' })), ['vote'])
  assertEquals(eventRoute(ev({ kind: 'applied' })), ['vote', 'applied'])
  assertEquals(eventRoute(ev({ kind: 'rejected' })), ['vote', 'rejected'])
  assertEquals(eventRoute(ev({ kind: 'gap_opened' })), ['detector', 'card', 'queue'])
  assertEquals(eventRoute(ev({ kind: 'request_merged' })), ['visitor', 'card'])
  assertEquals(eventRoute(ev({ kind: 'lease_issued' })), ['queue', 'dispatcher'])
  assertEquals(eventRoute(ev({ kind: '沒見過的' })), ['queue'])
})

Deno.test('eventText：純中文、不帶編號與表名', () => {
  const kinds = ['disputed', 'strong_claim', 'strong_finalized', 'system_vote', 'system_check', 'gap_opened', 'gap_reopened', 'gap_closed', 'lease_issued', 'lease_reported', 'lease_released', 'lease_expired', 'task_created', 'task_closed',
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
  const sys = toItems([ev({ kind: 'system_vote', agent_name: 'Jev', detail: { choice: 'supported', supported_sources: 2 } }), ev({ kind: 'system_vote', agent_name: 'Jev', detail: { choice: 'not_supported' } }), ev({ kind: 'system_vote', detail: { choice: 'cannot_tell' } }), ev({ kind: 'vote', agent_name: 'Jev' }), ev({ kind: 'system_check', detail: { question: 'second_source' } })])
  assertEquals(nodeCounts(sys), { jevVote: 3, vote: 1 })
  const st = toItems([ev({ kind: 'disputed' }), ev({ kind: 'strong_claim', agent_name: '甲' }), ev({ kind: 'strong_claim' }), ev({ kind: 'strong_finalized', detail: { verdict: 'reject' } }), ev({ kind: 'strong_finalized', detail: { verdict: 'uphold' } })])
  assertEquals(nodeCounts(st), { dispute: 1, strongLane: 2 })
  assertEquals(strongBreakdown(st), { claim: 2, finalized: 2, rejected: 1 })
  assertEquals(strongBreakdown(st, 1), { claim: 1, finalized: 0, rejected: 0 })
  assertEquals(systemVoteBreakdown(sys), { supported: 1, notSupported: 1, cannotTell: 1, other: 0 })
  assertEquals(systemVoteBreakdown(sys, 1), { supported: 1, notSupported: 0, cannotTell: 0, other: 0 })
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

// ---- 版面（維護者 2026-11-12 定稿：說明頁第 4 版左到右、17 個節點、23 條線、畫布 1640×504 不縮放） ----

const EXPECTED_NODES: Record<string, [number, number]> = {
  official: [0.05, 0.0974], detector: [0.15, 0.0974], card: [0.25, 0.0974], queue: [0.35, 0.0974], dispatcher: [0.45, 0.0974], vote: [0.55, 0.0974], applied: [0.75, 0.0974],
  visitor: [0.05, 0.3658], suggest: [0.05, 0.6342], jevSort: [0.35, 0.6342], jevVote: [0.55, 0.6342], submit: [0.45, 0.6342], notfound: [0.45, 0.9026], cooldown: [0.25, 0.9026],
  dispute: [0.65, 0.3658], strongLane: [0.65, 0.6342], rejected: [0.65, 0.9026],
}
const EXPECTED_LINKS = [
  'a1b official r2 detector l2', 'bw detector r2 card l2', 'wc card r2 queue l2', 'cd queue r2 dispatcher l2', 'dv dispatcher r2 vote l2', 'vl vote r2 applied l2',
  'a2w visitor r2 card b0', 'a3w suggest r2 card b1', 'ja jevSort b0 suggest b1', 'ep3 submit b2 jevVote b2', 'ep2 submit b0 jevSort b2',
  'de dispatcher b1 submit t1', 'jq jevSort t1 queue b1', 'jv jevVote t1 vote b1', 'vg vote r3 dispute t1', 'gq dispute b1 strongLane t1',
  'ql strongLane r2 applied b1', 'qr strongLane b1 rejected t1', 'vr vote r4 rejected l2', 'en submit b1 notfound t1', 'nk notfound l2 cooldown r2',
  'kr cooldown b1 rejected b1', 'kw cooldown t2 card b2',
]
const EXPECTED_KINDS: Record<string, string> = {
  official: 'system', detector: 'system', card: 'system', queue: 'system', dispatcher: 'system', notfound: 'system', cooldown: 'system', dispute: 'system', strongLane: 'system',
  vote: 'agent', visitor: 'agent', suggest: 'agent', submit: 'agent', jevSort: 'systemone', jevVote: 'systemone', applied: 'end', rejected: 'end',
}

Deno.test('版面：17 個節點、全 126×36、座標與框型照維護者定稿、畫布 1640×504', () => {
  assertEquals([CANVAS_W, CANVAS_H, NODE_W, NODE_H], [1640, 504, 126, 36])
  assertEquals(NODE_DEFS.length, 17)
  const L = computeLayout()
  assertEquals([L.width, L.height], [1640, 504])
  for (const [id, [x, y]] of Object.entries(EXPECTED_NODES)) {
    const n = L.nodes[id as NodeId]
    assertEquals([n.cx, n.cy, n.w, n.h], [x * 1640, 24 + y * 456, 126, 36], id)
    assertEquals(n.kind, EXPECTED_KINDS[id], `${id} 框型`)
  }
  assertEquals(L.nodes.queue.label, '派工佇列')
  assertEquals(L.nodes.jevSort.label, 'SystemOne 整理')
})

Deno.test('版面：23 條線的起訖與連接點（左右 5 個、上下 3 個）照定稿，只有順手提議是虛線', () => {
  assertEquals(LINKS.map((l) => `${l.id} ${l.from} ${l.fromSide}${l.fromIdx} ${l.to} ${l.toSide}${l.toIdx}`), EXPECTED_LINKS)
  assertEquals(LINKS.filter((l) => l.style === 'dashed').map((l) => l.id), ['ja'])
  for (const l of LINKS) {
    for (const [side, idx] of [[l.fromSide, l.fromIdx], [l.toSide, l.toIdx]] as const) {
      assert(idx >= 0 && idx <= (side === 't' || side === 'b' ? 2 : 4), `${l.id} 連接點 ${side}${idx} 超出範圍`)
    }
  }
  const L = computeLayout()
  // 起點、終點真的落在連接點上
  for (const [i, l] of LINKS.entries()) {
    const pts = L.routes[i].pts
    assertEquals(pts[0], anchorPoint(l.from, l.fromSide, l.fromIdx))
    assertEquals(pts[pts.length - 1], anchorPoint(l.to, l.toSide, l.toIdx))
  }
  // 連接點在節點邊上：上下側寬度 4 等分取 3 點、左右側高度 6 等分取 5 點
  const q = L.nodes.queue
  assertEquals(anchorPoint('queue', 't', 0), [q.cx - 63 + 31.5, q.cy - 18])
  assertEquals(anchorPoint('queue', 'b', 2), [q.cx - 63 + 94.5, q.cy + 18])
  assertEquals(anchorPoint('queue', 'l', 0), [q.cx - 63, q.cy - 18 + 6])
  assertEquals(anchorPoint('queue', 'r', 4), [q.cx + 63, q.cy - 18 + 30])
})

Deno.test('版面：每一段線都是水平或垂直（直角），任何寬度都一樣', () => {
  for (const w of [1640]) {
    const L = computeLayout()
    for (const r of L.routes) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [a, b] = [r.pts[i], r.pts[i + 1]]
        assert(a[0] === b[0] || a[1] === b[1], `${w}px ${r.from}>${r.to} 第 ${i} 段不是直角：${a} → ${b}`)
      }
    }
  }
})

Deno.test('版面：節點與連線都在畫布內、節點彼此不重疊、線不穿過別的節點', () => {
  for (const w of [1640]) {
    const L = computeLayout()
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
  const L = computeLayout()
  const pairs: Array<[NodeId, NodeId]> = [
    ['detector', 'card'], ['card', 'queue'], ['queue', 'dispatcher'], ['dispatcher', 'queue'], ['dispatcher', 'submit'], ['submit', 'jevSort'], ['jevSort', 'queue'],
    ['jevSort', 'suggest'], ['suggest', 'card'], ['visitor', 'card'], ['dispatcher', 'vote'], ['vote', 'applied'], ['vote', 'rejected'], ['submit', 'notfound'],
    ['notfound', 'cooldown'], ['jevVote', 'vote'], ['dispute', 'strongLane'], ['strongLane', 'rejected'], ['strongLane', 'applied'],
  ]
  for (const [a, b] of pairs) {
    const direct = L.routes.some((r) => (r.from === a && r.to === b) || (r.from === b && r.to === a))
    assert(direct, `${a}>${b} 沒有對應的線`)
    const pts = routeBetween(L, a, b)
    for (let i = 0; i < pts.length - 1; i++) assert(pts[i][0] === pts[i + 1][0] || pts[i][1] === pts[i + 1][1], `${a}>${b} 不是直角`)
  }
  assertEquals(routeBetween(L, 'dispatcher', 'queue'), [...routeBetween(L, 'queue', 'dispatcher')].reverse())
  // 串接：dispatcher→submit→jevSort 接點不重複
  const p = pathThrough(L, ['dispatcher', 'submit', 'jevSort'])
  assertEquals(p[0], routeBetween(L, 'dispatcher', 'submit')[0])
  assertEquals(p[p.length - 1], routeBetween(L, 'submit', 'jevSort').at(-1))
})

Deno.test('事件對應：每個事件走的相鄰節點都有線（不會憑空飛過去）', () => {
  const L = computeLayout()
  const kinds = ['gap_opened', 'gap_reopened', 'gap_closed', 'lease_issued', 'lease_reported', 'lease_released', 'lease_expired', 'task_created', 'task_closed',
    'request_merged', 'submitted', 'verified', 'verify_dispatched', 'vote', 'applied', 'rejected', 'check', 'system_vote', 'system_check', 'disputed', 'strong_claim', 'strong_finalized']
  for (const kind of kinds) for (const detail of [{}, { type: 'task_suggestion' }, { type: 'no_change' }, { outcome: 'not_found' }, { source: 'web_request' }]) for (const agent of [null, 'Jev']) {
    const r = eventRoute(ev({ kind, detail, agent_name: agent }))
    for (let i = 0; i < r.length - 1; i++) {
      assert(L.routes.some((x) => (x.from === r[i] && x.to === r[i + 1]) || (x.from === r[i + 1] && x.to === r[i])), `${kind} ${JSON.stringify(detail)}：${r[i]}→${r[i + 1]} 沒有線`)
    }
  }
})

Deno.test('pointAlong：起點、終點、中點', () => {
  const pts: Array<[number, number]> = [[0, 0], [10, 0], [10, 10]]
  assertEquals(polylineLength(pts), 20)
  assertEquals(pointAlong(pts, 0), [0, 0])
  assertEquals(pointAlong(pts, 0.5), [10, 0])
  assertEquals(pointAlong(pts, 1), [10, 10])
  assertEquals(pointAlong(pts, 0.75), [10, 5])
})
