import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:8000',
})

export interface QuizQuestion {
  id?: number             // pool question ID
  type: 'vocab' | 'blank' | 'translation' | 'order' | 'multiple' | 'calculation' | 'code'
  question: string
  options: string[] | null
  answer: number | string
  hint_ja?: string
  explanation?: string
}

export interface GenerateRequest {
  subject: string
  source_type: string
  content: string
  title: string
  num_questions: number
  language: string        // hint/explanation language
  study_language: string  // language being studied (drives TTS)
  quiz_language: string   // language questions are WRITTEN in
  difficulty: string
  study_mode: string
  source_url?: string     // stable URL for pool key (youtube/url sources)
}

export interface GenerateResponse {
  questions: QuizQuestion[]
  title: string
  subject: string
  study_language: string
  study_mode: string
  quiz_language: string   // language questions are written in → drives TTS voice
  youtube_url?: string    // set by frontend when source tab is youtube
  pool_size?: number      // total questions available in pool
  gemini_called?: boolean // true when a new batch was generated from Gemini
}

export interface SourceResponse {
  title: string
  text: string
  length: number
  source_type: string
}

export interface Stats {
  sessions: number
  total_q: number
  avg_accuracy: number
}

export interface SessionRecord {
  id: number
  subject: string
  title: string
  score: number
  mc_total: number
  total_q: number
  accuracy: number
  created_at: string
}

export interface LyricsResult {
  artist: string
  title: string
  album: string
}

export interface VagalumeResult {
  artist: string
  title: string
  url: string   // full Vagalume lyrics-page URL
}

export interface LyricsFetchResponse {
  artist: string
  title: string
  lyrics: string
  length: number
}

export interface AiResource {
  title: string
  url: string
  type: 'website' | 'pdf'
  description: string
}

// ── Quiz API ──────────────────────────────────────────────────
export const generateQuiz = (req: GenerateRequest) =>
  api.post<GenerateResponse>('/api/quiz/generate', req).then(r => r.data)

export const checkHealth = () =>
  api.get<{ status: string; message?: string }>('/api/quiz/health').then(r => r.data)

export const saveQuestionResults = (results: { id: number; correct: boolean }[]) =>
  api.post('/api/quiz/questions/results', { results }).then(r => r.data)

export const saveSession = (data: {
  subject: string; source: string; title: string
  score: number; mc_total: number; total_q: number
}) => api.post('/api/quiz/session', data).then(r => r.data)

export const getStats = () =>
  api.get<Stats>('/api/quiz/stats').then(r => r.data)

export const getSessions = (limit = 5) =>
  api.get<SessionRecord[]>('/api/quiz/sessions', { params: { limit } }).then(r => r.data)

// ── Sources API ───────────────────────────────────────────────
export const uploadPdf = (file: File) => {
  const form = new FormData()
  form.append('file', file)
  return api.post<SourceResponse>('/api/sources/pdf', form).then(r => r.data)
}

export const fetchYoutube = (url: string) =>
  api.post<SourceResponse>('/api/sources/youtube', { url }).then(r => r.data)

export const fetchUrl = (url: string) =>
  api.post<SourceResponse>('/api/sources/url', { url }).then(r => r.data)

export const aiSearchResources = (topic: string, study_language: string, ui_language = 'ja') =>
  api.post<{ results: AiResource[] }>('/api/sources/ai-search', { topic, study_language, ui_language })
    .then(r => r.data.results)

// ── Lyrics API ────────────────────────────────────────────────
export const searchLyrics = (q: string) =>
  api.get<{ results: LyricsResult[] }>('/api/lyrics/search', { params: { q } })
    .then(r => r.data.results)

export const fetchLyrics = (artist: string, title: string) =>
  api.post<LyricsFetchResponse>('/api/lyrics/fetch', { artist, title }).then(r => r.data)

export const vagalumeSearch = (q: string) =>
  api.get<{ results: VagalumeResult[]; type: string }>('/api/lyrics/vagalume', { params: { q } })
    .then(r => r.data)

// ── Audio API ─────────────────────────────────────────────────
export const synthesizeSpeech = async (
  text: string,
  voice = 'en-US-female',
  slow = false,
  lang = 'en',
): Promise<string> => {
  const resp = await api.post('/api/audio/synthesize',
    { text, voice, slow, lang },
    { responseType: 'blob' },
  )
  return URL.createObjectURL(resp.data)
}
