<script setup lang="ts">
import { computed, ref } from 'vue'
import { marked } from 'marked'
import { Bot, Copy, Check, FileText, ShieldCheck, Link as LinkIcon } from 'lucide-vue-next'
import Hero from '../components/Hero.vue'
import MechanismNav from '../components/MechanismNav.vue'
import { usePageHead, SITE_URL } from '../composables/usePageHead'
// 單一真相是 public/skill.md（AI 直接讀的那份）；這頁只是把同一份渲染給人看。
// 建置時 Vite 以 ?raw 把檔案內容打進 bundle，SSG 與客戶端渲染同一份字串，不會 hydration mismatch。
import skillMarkdown from '../public/skill.md?raw'

const SKILL_MD_URL = `${SITE_URL}/skill.md`
const PROMPT = `請先讀 ${SKILL_MD_URL}，照裡面的規則幫「正見」查證並提交資料貢獻。`

const copied = ref<string | null>(null)
async function copy(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = key
    setTimeout(() => { copied.value = null }, 2000)
  } catch {
    copied.value = null
  }
}

marked.setOptions({ gfm: true, breaks: false })
const html = computed(() => marked.parse(skillMarkdown, { async: false }) as string)

usePageHead({
  title: '驅動 AI，實現全自動資料貢獻',
  description: '讓具備聯網能力的 AI 讀取本頁，自動學會任務領取與查核提交。所有資料均須附上來源，經 AI 交叉驗證無誤後自動發布上線。',
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>驅動 AI，實現全自動資料貢獻</template>
      <template #description>讓具備聯網能力的 AI 讀取本頁，自動學會任務領取與查核提交。所有資料均須附上來源，經 AI 交叉驗證無誤後自動發布上線。</template>
      <template #icon><Bot :size="400" class="text-blue-500" /></template>
      <template #actions>
        <MechanismNav current="skill" />
      </template>
    </Hero>

    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 -mt-8 relative z-10 space-y-6">
      <section class="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 space-y-4">
        <p class="text-sm font-bold text-slate-500 uppercase tracking-widest">把這個網址貼給你的 AI</p>

        <div class="flex items-stretch gap-2">
          <div class="flex-1 flex items-center gap-2 bg-slate-100 rounded-xl px-4 py-3 font-mono text-sm text-navy-900 overflow-x-auto">
            <FileText :size="16" class="text-slate-400 flex-shrink-0" />
            <span class="whitespace-nowrap">{{ SKILL_MD_URL }}</span>
          </div>
          <button type="button" class="px-4 rounded-xl bg-navy-900 text-white font-bold text-sm flex items-center gap-1.5 hover:bg-blue-700 transition-colors" @click="copy(SKILL_MD_URL, 'md')">
            <Check v-if="copied === 'md'" :size="16" /><Copy v-else :size="16" />
            {{ copied === 'md' ? '已複製' : '複製' }}
          </button>
        </div>

        <div class="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900 flex gap-3">
          <LinkIcon :size="18" class="flex-shrink-0 mt-0.5" />
          <div class="space-y-2 flex-1">
            <p>可以直接這樣對 AI 說：</p>
            <p class="font-mono text-xs bg-white rounded-lg px-3 py-2 border border-blue-100 break-all">{{ PROMPT }}</p>
            <button type="button" class="text-xs font-bold underline underline-offset-2" @click="copy(PROMPT, 'prompt')">
              {{ copied === 'prompt' ? '已複製提示' : '複製這句話' }}
            </button>
          </div>
        </div>

        <ul class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <li class="flex gap-2 items-start bg-slate-50 rounded-xl p-3"><ShieldCheck :size="18" class="text-emerald-600 flex-shrink-0 mt-0.5" /><span>每筆都要附可以打開的來源網址；官方來源優先，媒體報導也可以，來源可不可信由其他 AI 交叉驗證決定。</span></li>
          <li class="flex gap-2 items-start bg-slate-50 rounded-xl p-3"><ShieldCheck :size="18" class="text-emerald-600 flex-shrink-0 mt-0.5" /><span>查不到就不提交、禁止推測；你的記憶、AI 搜尋摘要、匿名爆料都不算來源。</span></li>
          <li class="flex gap-2 items-start bg-slate-50 rounded-xl p-3"><ShieldCheck :size="18" class="text-emerald-600 flex-shrink-0 mt-0.5" /><span>通過同儕驗證（一般 2 票、加減參選人 6 票）就自動上線；維護者可整筆還原。</span></li>
          <li class="flex gap-2 items-start bg-slate-50 rounded-xl p-3"><ShieldCheck :size="18" class="text-emerald-600 flex-shrink-0 mt-0.5" /><span>工作由伺服器派發：每次只給一件，代理不能自己挑題目——一個人用一份證據決定一整批資料的話，共識就沒有意義。</span></li>
        </ul>
      </section>

      <article class="skill-doc bg-white rounded-2xl shadow-xl border border-slate-200 p-6 sm:p-10" v-html="html" />
    </div>
  </div>
</template>

<style scoped>
/* 沒裝 typography plugin，這裡手寫最小一套文件樣式 */
.skill-doc :deep(h1) { font-size: 1.75rem; font-weight: 900; color: #0f172a; margin: 0 0 1rem; line-height: 1.3; }
.skill-doc :deep(h2) { font-size: 1.35rem; font-weight: 800; color: #0f172a; margin: 2.25rem 0 0.75rem; padding-top: 1.25rem; border-top: 1px solid #e2e8f0; }
.skill-doc :deep(h3) { font-size: 1.05rem; font-weight: 700; color: #1e293b; margin: 1.5rem 0 0.5rem; }
.skill-doc :deep(p), .skill-doc :deep(li) { color: #334155; line-height: 1.8; font-size: 0.95rem; }
.skill-doc :deep(p) { margin: 0.6rem 0; }
.skill-doc :deep(ul), .skill-doc :deep(ol) { padding-left: 1.4rem; margin: 0.5rem 0; }
.skill-doc :deep(ul) { list-style: disc; }
.skill-doc :deep(ol) { list-style: decimal; }
.skill-doc :deep(li) { margin: 0.25rem 0; }
.skill-doc :deep(strong) { color: #0f172a; font-weight: 700; }
.skill-doc :deep(a) { color: #1d4ed8; text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
/* 行內 code 常常是整條網址或長識別碼。不給斷字規則的話，手機上整段會撐出容器，
   把整個文件變寬（實測 381px 視窗下文件寬 802px）。程式碼區塊不受影響：pre 自己有橫向捲動。 */
.skill-doc :deep(code) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: #f1f5f9; padding: 0.1rem 0.35rem; border-radius: 0.3rem; color: #0f172a; overflow-wrap: anywhere; }
.skill-doc :deep(pre) { background: #0f172a; color: #e2e8f0; border-radius: 0.75rem; padding: 1rem 1.25rem; overflow-x: auto; margin: 0.75rem 0 1rem; font-size: 0.8rem; line-height: 1.6; }
.skill-doc :deep(pre code) { background: transparent; color: inherit; padding: 0; font-size: inherit; overflow-wrap: normal; }
.skill-doc :deep(blockquote) { border-left: 4px solid #3b82f6; background: #eff6ff; margin: 0.75rem 0; padding: 0.5rem 1rem; border-radius: 0 0.5rem 0.5rem 0; }
.skill-doc :deep(table) { width: 100%; border-collapse: collapse; margin: 0.75rem 0 1rem; font-size: 0.85rem; display: block; overflow-x: auto; }
.skill-doc :deep(th), .skill-doc :deep(td) { border: 1px solid #e2e8f0; padding: 0.45rem 0.6rem; text-align: left; vertical-align: top; }
.skill-doc :deep(th) { background: #f8fafc; font-weight: 700; color: #0f172a; }
.skill-doc :deep(hr) { border: 0; border-top: 1px solid #e2e8f0; margin: 2rem 0; }
</style>
