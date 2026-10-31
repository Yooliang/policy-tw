/**
 * 承諾→政見 ②：單條用詞與人物頁分頁（#672，R3、R8、R9、R10）。
 *   1. 徽章：承諾階段的 Campaign Pledge 印「承諾」；當選者那一屆印「提出」（顯示層映射，status 不動）
 *   2. 單條描述、引用文字、md 一行狀態欄照階段換「承諾」「政見」
 *   3. 接線：卡片、徽章、政見頁、人物頁分頁、追蹤頁都讀同一支階段函式；人物頁不再有「政績」「競選承諾」分頁字
 *   4. 還原驗證靠 policy-stage.test.ts（階段本身）與這裡的原始碼釘子
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { stageBadgeLabel, stageWord, type PolicyStage } from './policy-stage.ts'
import { mdStatusCell, policyBullet } from './md/format.ts'
import { policyDescription } from './seo.ts'
import type { Policy } from '../types.ts'

const STAGES: PolicyStage[] = ['pledge', 'policy', 'lost_pledge', 'pending_result']

Deno.test('階段 → 單條叫什麼：只有政見階段叫政見，其餘（含落選、結果待補）叫承諾', () => {
  assertEquals(STAGES.map(stageWord), ['承諾', '政見', '承諾', '承諾'])
})

Deno.test('徽章：Campaign Pledge 承諾階段印「承諾」、政見階段印「提出」；其他 status 不管階段都不動', () => {
  assertEquals(stageBadgeLabel('Campaign Pledge', 'pledge'), '承諾')
  assertEquals(stageBadgeLabel('Campaign Pledge', 'lost_pledge'), '承諾')
  assertEquals(stageBadgeLabel('Campaign Pledge', 'pending_result'), '承諾')
  assertEquals(stageBadgeLabel('Campaign Pledge', 'policy'), '提出')
  for (const s of ['Proposed', 'In Progress', 'Achieved', 'Stalled', 'Failed', undefined]) {
    for (const stage of STAGES) assertEquals(stageBadgeLabel(s, stage), null, `${s} ${stage}`)
  }
})

Deno.test('md 一行的狀態欄：政見階段的 Campaign Pledge 印「政見」，承諾維持「競選承諾」（來源事實），其他狀態照舊', () => {
  const cp = { status: 'Campaign Pledge' as Policy['status'] }
  assertEquals(mdStatusCell(cp, 'policy'), '政見')
  assertEquals(mdStatusCell(cp, 'pledge'), '競選承諾')
  assertEquals(mdStatusCell(cp, 'lost_pledge'), '競選承諾')
  assertEquals(mdStatusCell(cp), '競選承諾', '呼叫端不知道階段就照舊')
  assertEquals(mdStatusCell({ status: 'In Progress' as Policy['status'] }, 'policy'), '進行中')
  const p = { id: 'p1', title: '托育補助加碼', category: '社會福利', status: 'Campaign Pledge', description: '', progress: 0, lastUpdated: '2026-09-10', proposedDate: '2026-09-02' } as unknown as Policy
  assertStringIncludes(policyBullet(p, { descMax: 0, stage: 'policy' })[0], '〈托育補助加碼〉｜社會福利｜政見｜提出 2026-09-02');
  assertStringIncludes(policyBullet(p, { descMax: 0 })[0], '〈托育補助加碼〉｜社會福利｜競選承諾｜提出 2026-09-02');
})

Deno.test('引用文字與單條描述依階段換字', () => {
  // 政見階段、還沒有進度的當選者那一屆：描述寫「政見「…」」，沒有狀態可寫就不寫（不印 0%）
  assertEquals(policyDescription({ title: 'T', isPledge: false, statusLabel: '', progress: 0, personName: '甲' }), '甲政見「T」。');
  assertEquals(policyDescription({ title: 'T', isPledge: true, statusLabel: '承諾', progress: 0, personName: '甲' }), '甲承諾「T」。');
})

async function source(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../${rel}`, import.meta.url));
}

Deno.test('引用文字依階段換字（usePageHead 載入會要 env，這裡釘原始碼）', async () => {
  const head = await source('composables/usePageHead.ts');
  assertStringIncludes(head, "kind?: '承諾' | '政見'");
  assertStringIncludes(head, '`，${opts.who}的${opts.kind ?? \'政見\'}`');
  assertStringIncludes(await source('pages/PolicyDetail.vue'), 'kind: word.value');
});

Deno.test('接線：卡片、徽章、政見頁、人物頁、追蹤頁都讀階段函式，不再各自比 status', async () => {
  const card = await source('components/PolicyCard.vue');
  assertStringIncludes(card, 'stageOfPolicy(props.policy, props.politician');
  assertStringIncludes(card, ':stage="stage"');
  assertStringIncludes(card, '尚無進度紀錄');
  assert(!card.includes("props.policy.status === PolicyStatus.CAMPAIGN\n") || card.includes('noProgressRecord'), '卡片版型不再只看 status');
  const badge = await source('components/StatusBadge.vue');
  assertStringIncludes(badge, 'stageBadgeLabel(');
  const detail = await source('pages/PolicyDetail.vue');
  assertStringIncludes(detail, 'stageOfPolicy(policy.value, politician.value');
  assertStringIncludes(detail, '尚無進度紀錄');
  assertStringIncludes(detail, '找不到該承諾或政見');
  const profile = await source('pages/PoliticianProfile.vue');
  assertStringIncludes(profile, 'stageOfPolicy(p, politician.value');
  assertStringIncludes(profile, 'landOnHistory');
  assertStringIncludes(profile, '<span class="hidden sm:inline">承諾</span>');
  assertStringIncludes(profile, '<span class="hidden sm:inline">政見</span>');
  assert(!profile.includes('過往政績') && !profile.includes('政績追蹤'), '人物頁分頁不再有「政績」');
  assert(!profile.includes('<span class="hidden sm:inline">競選承諾</span>'), '承諾分頁字是「承諾」');
  const tracking = await source('pages/PolicyTracking.vue');
  assertStringIncludes(tracking, "stageOf(policy) === 'policy'");
});

Deno.test('品牌字不動（R2）：導覽、頁型名、站名描述仍是「政見追蹤」「政見」', async () => {
  const tracking = await source('pages/PolicyTracking.vue');
  // 全部政見的頁面標題仍是「政見追蹤」；「我的關注」（?view=mine）換成自己的標題（2026-10-31）
  assertStringIncludes(tracking, "view.value === 'mine' ? '我的關注' : '政見追蹤'");
  const nav = await source('components/Navbar.vue');
  assertStringIncludes(nav, '政見追蹤');
});
