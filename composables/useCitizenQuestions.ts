import { ref } from 'vue'
import { supabasePublic as supabase } from '../lib/supabase'
import { voteStance, type Stance } from '../lib/citizen-questions'
import { fetchAllRows } from './useSupabase'
import type { CitizenQuestion, QuestionAnswer, RawCitizenQuestion, RawQuestionAnswer } from '../types'

/**
 * 公民提問頁的資料讀取：citizen_questions 列表（一次全載，anon 讀不到 hidden 的已由 RLS 擋掉）、
 * question_answers 按需載入（展開一題才查）。寫入（發問／表態）走 lib/citizen-questions.ts。
 *
 * 表態的狀態與流程也放這裡（2026-09-18）：政見頁也要顯示提問與表態，
 * 兩頁各寫一份會漂開。「我投過什麼」存 localStorage，每台瀏覽器自己記。
 */

const LS_STANCE_KEY = 'zhengjian_question_stances'

function mapQuestion(row: RawCitizenQuestion): CitizenQuestion {
  return {
    id: row.id,
    question: row.question,
    policyId: row.policy_id,
    politicianId: row.politician_id,
    region: row.region,
    status: row.status,
    answerCount: row.answer_count,
    stanceUp: row.stance_up,
    stanceDown: row.stance_down,
    createdAt: row.created_at,
  }
}

function mapAnswer(row: RawQuestionAnswer): QuestionAnswer {
  return {
    id: row.id,
    questionId: row.question_id,
    agentName: row.agent_name,
    agentTool: row.agent_tool,
    answer: row.answer,
    sourceUrls: row.source_urls || [],
    createdAt: row.created_at,
  }
}

export type AnswersState = QuestionAnswer[] | 'loading' | 'error'

export function useCitizenQuestions() {
  const questions = ref<CitizenQuestion[]>([])
  const loadingQuestions = ref(false)
  const questionsError = ref<string | null>(null)
  const answersByQuestion = ref<Record<string, AnswersState>>({})
  const votedStances = ref<Record<string, Stance>>({})
  const voteBusyIds = ref<Set<string>>(new Set())
  const voteErrors = ref<Record<string, string>>({})

  /** 讀全部提問（最新在前）。 */
  async function loadQuestions(): Promise<void> {
    loadingQuestions.value = true
    questionsError.value = null
    try {
      const rows = await fetchAllRows<RawCitizenQuestion>('citizen_questions', '*', 'created_at')
      questions.value = rows.map(mapQuestion).reverse()
    } catch (err) {
      console.error('[citizen-questions] 讀取提問列表失敗：', err)
      questionsError.value = '暫時讀不到提問列表，請稍後重新整理'
    } finally {
      loadingQuestions.value = false
    }
  }

  /** 展開一題時載入它的全部答案（重複呼叫不會重查）。 */
  async function loadAnswers(questionId: string): Promise<void> {
    const current = answersByQuestion.value[questionId]
    if (current === 'loading' || Array.isArray(current)) return
    answersByQuestion.value = { ...answersByQuestion.value, [questionId]: 'loading' }
    try {
      const { data, error } = await supabase
        .from('question_answers')
        .select('*')
        .eq('question_id', questionId)
        .order('created_at')
      if (error) throw error
      answersByQuestion.value = { ...answersByQuestion.value, [questionId]: (data || []).map(mapAnswer) }
    } catch (err) {
      console.error(`[citizen-questions] 讀取問題 ${questionId} 的答案失敗：`, err)
      answersByQuestion.value = { ...answersByQuestion.value, [questionId]: 'error' }
    }
  }

  /** 表態成功後，用伺服器回傳的數字覆蓋本地那一題（不猜測、不自己加一）。 */
  function applyStanceResult(questionId: string, stanceUp: number, stanceDown: number): void {
    questions.value = questions.value.map((q) =>
      q.id === questionId ? { ...q, stanceUp, stanceDown } : q
    )
  }

  // ---- 表態（up／down）----
  function readStoredStances(): Record<string, Stance> {
    try {
      const raw = localStorage.getItem(LS_STANCE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  }

  /** 我在這台瀏覽器投過什麼；伺服器端是按 IP 算，這裡只是讓按鈕記得亮哪一顆 */
  function loadMyStances(): void {
    votedStances.value = readStoredStances()
  }

  async function castVote(questionId: string, stance: Stance): Promise<void> {
    // 伺服器端同一題同一個 IP 是覆蓋（upsert）而不是報錯，所以按錯了要能改回來；
    // 只擋「重複送出同一個表態」與送出中的狀態。
    if (voteBusyIds.value.has(questionId) || votedStances.value[questionId] === stance) return
    voteBusyIds.value = new Set(voteBusyIds.value).add(questionId)
    voteErrors.value = { ...voteErrors.value, [questionId]: '' }
    try {
      const result = await voteStance(questionId, stance)
      applyStanceResult(questionId, result.stanceUp, result.stanceDown)
      votedStances.value = { ...votedStances.value, [questionId]: stance }
      try {
        localStorage.setItem(LS_STANCE_KEY, JSON.stringify(votedStances.value))
      } catch (e) {
        console.info('[公民提問] 表態沒能記進這台瀏覽器（伺服器已收下）：', e)
      }
    } catch (err) {
      voteErrors.value = { ...voteErrors.value, [questionId]: err instanceof Error ? err.message : '表態失敗，請稍後再試' }
    } finally {
      const next = new Set(voteBusyIds.value)
      next.delete(questionId)
      voteBusyIds.value = next
    }
  }

  return {
    questions, loadingQuestions, questionsError, loadQuestions, answersByQuestion, loadAnswers, applyStanceResult,
    votedStances, voteBusyIds, voteErrors, loadMyStances, castVote,
  }
}
