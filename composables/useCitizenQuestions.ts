import { ref } from 'vue'
import { supabasePublic as supabase } from '../lib/supabase'
import { fetchAllRows } from './useSupabase'
import type { CitizenQuestion, QuestionAnswer, RawCitizenQuestion, RawQuestionAnswer } from '../types'

/**
 * 公民提問頁的資料讀取：citizen_questions 列表（一次全載，anon 讀不到 hidden 的已由 RLS 擋掉）、
 * question_answers 按需載入（展開一題才查）。寫入（發問／表態）走 lib/citizen-questions.ts。
 */

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

  return { questions, loadingQuestions, questionsError, loadQuestions, answersByQuestion, loadAnswers, applyStanceResult }
}
