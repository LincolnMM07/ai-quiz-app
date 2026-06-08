import { useState, useRef, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  uploadPdf, fetchYoutube, fetchUrl, generateQuiz, SourceResponse,
  searchLyrics, fetchLyrics, LyricsResult,
  vagalumeSearch, VagalumeResult,
  aiSearchResources, AiResource,
  getStats, getSessions, Stats, SessionRecord,
  getSessionsHistory, SessionHistory,
  checkHealth,
} from '../api/client'
import { getT, UiLang, UI_LANGS } from '../i18n'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

const LANG_SUBJECTS = [
  { id: 'english',    label: 'English',   emoji: '🇬🇧', studyLang: 'en' },
  { id: 'japanese',   label: '日本語',    emoji: '🇯🇵', studyLang: 'ja' },
  { id: 'spanish',    label: 'Español',   emoji: '🇪🇸', studyLang: 'es' },
  { id: 'french',     label: 'Français',  emoji: '🇫🇷', studyLang: 'fr' },
  { id: 'korean',     label: '한국어',    emoji: '🇰🇷', studyLang: 'ko' },
  { id: 'chinese',    label: '中文',      emoji: '🇨🇳', studyLang: 'zh' },
  { id: 'portuguese', label: 'Português', emoji: '🇧🇷', studyLang: 'pt' },
]

const OTHER_SUBJECTS = [
  { id: 'math',        label: '数学',  emoji: '📐', studyLang: 'en' },
  { id: 'history',     label: '歴史',  emoji: '📜', studyLang: 'en' },
  { id: 'science',     label: '理科',  emoji: '🔬', studyLang: 'en' },
  { id: 'programming', label: 'Code',  emoji: '💻', studyLang: 'en' },
  { id: 'toeic',       label: 'TOEIC', emoji: '📊', studyLang: 'en' },
]

const ALL_SUBJECTS = [...LANG_SUBJECTS, ...OTHER_SUBJECTS]

// Study modes unavailable for each academic subject
const DISABLED_MODES: Record<string, Set<string>> = {
  math:        new Set(['listening', 'vocabulary', 'grammar', 'lyrics']),
  science:     new Set(['listening', 'grammar', 'lyrics']),
  history:     new Set(['listening', 'grammar', 'lyrics']),
  programming: new Set(['listening', 'grammar', 'lyrics']),
  toeic:       new Set(['lyrics']),
}

const DAILY_LIMIT = 500

function localDateStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getDailyCount(): number {
  return parseInt(localStorage.getItem(`gu_${localDateStr()}`) ?? '0', 10)
}

function incDailyCount(): number {
  const key = `gu_${localDateStr()}`
  const n = getDailyCount() + 1
  localStorage.setItem(key, String(n))
  Object.keys(localStorage)
    .filter(k => k.startsWith('gu_') && k !== key)
    .forEach(k => localStorage.removeItem(k))
  return n
}

function getTimeUntilReset(): { hours: number; minutes: number } {
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const diff = midnight.getTime() - now.getTime()
  return {
    hours:   Math.floor(diff / 3_600_000),
    minutes: Math.floor((diff % 3_600_000) / 60_000),
  }
}

const HINT_LANGS = [
  { id: 'ja', label: '日本語' },
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'ko', label: '한국어' },
  { id: 'zh', label: '中文' },
  { id: 'pt', label: 'Português' },
]

type Tab = 'youtube' | 'url' | 'pdf' | 'text' | 'lyrics' | 'ai-search' | 'topic'
type ApiStatus = 'unknown' | 'ok' | 'error' | 'quota' | 'no_key'

function loadPersistedStatus(): ApiStatus {
  const s = localStorage.getItem('apiStatus')
  const d = localStorage.getItem('apiStatusDate')
  if (s && d === localDateStr()) return s as ApiStatus
  return 'unknown'
}

function persistStatus(s: ApiStatus): void {
  localStorage.setItem('apiStatus', s)
  localStorage.setItem('apiStatusDate', localDateStr())
}

function errorToApiStatus(e: any): ApiStatus | null {
  const detail: string = e?.response?.data?.detail ?? e?.message ?? ''
  const status: number = e?.response?.status ?? 0
  if (detail === 'AI_QUOTA' || detail.toLowerCase().includes('quota') || status === 429) return 'quota'
  if (detail === 'AI_UNAVAILABLE' || status === 503) return 'error'
  return null
}

function formatError(e: any, t: (k: string) => string): string {
  const detail: string = e?.response?.data?.detail ?? e?.message ?? ''
  const status: number = e?.response?.status ?? 0
  if (detail === 'AI_UNAVAILABLE' || status === 503)                       return t('errUnavailable')
  if (detail === 'AI_QUOTA' || detail.toLowerCase().includes('quota') || status === 429) return t('errQuota')
  if (detail.includes('Content cannot be empty'))                          return t('errEmpty')
  if (detail.toLowerCase().includes('transcript') || detail.toLowerCase().includes('youtube')) return t('errTranscript')
  if (detail.includes('Failed to generate') || detail.startsWith('AI_ERROR')) return t('errGenerate')
  if (status === 0 || !e?.response)                                        return t('errNetwork')
  if (status >= 500)                                                       return t('errServer')
  if (detail && !detail.startsWith('AI_'))                                 return detail
  return t('errUnknown')
}

export default function Home() {
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)

  const [subject,    setSubject]    = useState('english')
  const [studyLang,  setStudyLang]  = useState('en')
  const [quizLang,   setQuizLang]   = useState('ja')
  const [hintLang,   setHintLang]   = useState('ja')
  const [difficulty, setDifficulty] = useState('intermediate')
  const [numQ,       setNumQ]       = useState(10)
  const [studyMode,  setStudyMode]  = useState('mixed')
  const [tab,        setTab]        = useState<Tab>('youtube')
  const [url,        setUrl]        = useState('')
  const [text,       setText]       = useState('')
  const [topicText,  setTopicText]  = useState('')
  const [loading,    setLoading]    = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [error,      setError]      = useState('')

  // UI language (persisted across sessions)
  const [uiLang, setUiLangState] = useState<UiLang>(
    () => (localStorage.getItem('uiLang') as UiLang) ?? 'ja'
  )
  const setUiLang = (lang: UiLang) => {
    localStorage.setItem('uiLang', lang)
    setUiLangState(lang)
  }
  const t = useMemo(() => getT(uiLang), [uiLang])

  // Gemini API status & daily usage
  const [apiStatus,  setApiStatusState] = useState<ApiStatus>(loadPersistedStatus)
  const [dailyUsage, setDailyUsage]     = useState(() => getDailyCount())

  const setApiStatus = (s: ApiStatus) => { persistStatus(s); setApiStatusState(s) }

  // Lyrics tab — shared
  type LyricsProvider = 'western' | 'portuguese' | 'japanese'
  const [lyricsProvider,    setLyricsProvider]    = useState<LyricsProvider>('western')
  const [lyricsQuery,       setLyricsQuery]       = useState('')
  const [lyricsManualText,  setLyricsManualText]  = useState('')
  const [lyricsManualTitle, setLyricsManualTitle] = useState('')
  const [lyricsResults,     setLyricsResults]     = useState<LyricsResult[]>([])
  const [selectedSong,      setSelectedSong]      = useState<LyricsResult | null>(null)
  const [lyricsSearching,   setLyricsSearching]   = useState(false)
  const [lyricsError,       setLyricsError]       = useState('')
  const [lyricsManualMode,  setLyricsManualMode]  = useState(false)

  // Portuguese (Vagalume)
  const [vagaResults,   setVagaResults]   = useState<VagalumeResult[]>([])
  const [vagaSearching, setVagaSearching] = useState(false)
  const [vagaError,     setVagaError]     = useState('')

  // AI search tab
  const [aiTopic,     setAiTopic]     = useState('')
  const [aiResults,   setAiResults]   = useState<AiResource[]>([])
  const [aiSearching, setAiSearching] = useState(false)
  const [aiError,     setAiError]     = useState('')

  // Stats dashboard
  const [stats,       setStats]       = useState<Stats | null>(null)
  const [sessions,    setSessions]    = useState<SessionRecord[]>([])
  const [historyData, setHistoryData] = useState<SessionHistory[]>([])
  const [showChart,   setShowChart]   = useState(false)
  const [streak,      setStreak]      = useState(0)

  // Furigana toggle (Japanese learners only)
  const [furigana, setFurigana] = useState(() => localStorage.getItem('furigana') === 'true')
  const toggleFurigana = (v: boolean) => { localStorage.setItem('furigana', String(v)); setFurigana(v) }

  // Daily goal
  const [dailyGoal, setDailyGoalState] = useState(() => parseInt(localStorage.getItem('dailyGoal') ?? '20', 10))
  const setDailyGoal = (n: number) => { localStorage.setItem('dailyGoal', String(n)); setDailyGoalState(n) }

  // Auto-sync study language + reset incompatible study mode when subject changes
  useEffect(() => {
    const s = ALL_SUBJECTS.find(s => s.id === subject)
    if (s) setStudyLang(s.studyLang)
    const disabled = DISABLED_MODES[subject]
    if (disabled?.has(studyMode)) setStudyMode('mixed')
  }, [subject])

  function calcStreak(recs: SessionRecord[]): number {
    if (!recs.length) return 0
    const dates = [...new Set(recs.map(s => s.created_at.split('T')[0]))].sort().reverse()
    const today = localDateStr()
    let count = 0
    let expected = today
    for (const d of dates) {
      if (d === expected) {
        count++
        const dt = new Date(d); dt.setDate(dt.getDate() - 1)
        expected = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`
      } else { break }
    }
    return count
  }

  // Load stats on mount; lightweight key check (no Gemini call)
  useEffect(() => {
    getStats().then(setStats).catch(() => {})
    getSessions(30).then(recs => {
      setSessions(recs)
      setStreak(calcStreak(recs))
    }).catch(() => {})
    getSessionsHistory(30).then(setHistoryData).catch(() => {})
    checkHealth().then(h => {
      if (h.status === 'no_key') { persistStatus('no_key'); setApiStatusState('no_key') }
    }).catch(() => {})
  }, [])

  const go = async (source: SourceResponse, sourceUrl?: string) => {
    setLoadingMsg('AIが問題を生成中... ⏳')
    try {
      const result = await generateQuiz({
        subject,
        source_type: source.source_type,
        content: source.text,
        title: source.title,
        num_questions: numQ,
        language: hintLang,
        study_language: studyLang,
        quiz_language: quizLang,
        difficulty,
        study_mode: studyMode,
        source_url: sourceUrl,
      })
      if (result.gemini_called) setDailyUsage(incDailyCount())
      setApiStatus('ok')
      const isYoutube = sourceUrl && (sourceUrl.includes('youtube.com') || sourceUrl.includes('youtu.be'))
      const quizState = { ...(isYoutube ? { ...result, youtube_url: sourceUrl } : result), furigana }
      navigate('/quiz', { state: quizState })
    } catch (e: any) {
      const newStatus = errorToApiStatus(e)
      if (newStatus) setApiStatus(newStatus)
      setError(formatError(e, t))
      setLoading(false)
    }
  }

  const handleFile = async (file: File) => {
    setLoading(true); setError(''); setLoadingMsg('PDFを読み込み中...')
    try { await go(await uploadPdf(file)) }
    catch (e: any) { setError(formatError(e, t)); setLoading(false) }
  }

  const handleUrl = async () => {
    if (!url.trim()) return
    setLoading(true); setError('')
    setLoadingMsg(tab === 'youtube' ? 'YouTube字幕を取得中...' : 'ページを読み込み中...')
    try {
      const fn = tab === 'youtube' ? fetchYoutube : fetchUrl
      const source = await fn(url)
      await go(source, url)
    } catch (e: any) { setError(formatError(e, t)); setLoading(false) }
  }

  const handleText = async () => {
    if (!text.trim()) return
    setLoading(true); setError('')
    await go({ title: 'テキスト入力', text, length: text.length, source_type: 'text' })
  }

  const handleLyricsSearch = async () => {
    if (!lyricsQuery.trim()) return
    setLyricsSearching(true); setLyricsError(''); setLyricsResults([]); setSelectedSong(null)
    try {
      const results = await searchLyrics(lyricsQuery.trim())
      setLyricsResults(results)
      if (!results.length) setLyricsError('曲が見つかりませんでした。別のキーワードをお試しください。')
    } catch (e: any) {
      setLyricsError(e.response?.data?.detail ?? '検索エラー')
    } finally {
      setLyricsSearching(false)
    }
  }

  const handleLyricsGenerate = async () => {
    if (!selectedSong) return
    setLoading(true); setError('')
    setLoadingMsg(`「${selectedSong.title}」の歌詞を取得中...`)
    try {
      const data = await fetchLyrics(selectedSong.artist, selectedSong.title)
      setLoadingMsg('AIが問題を生成中... ⏳')
      await go({
        title: `${selectedSong.artist} — ${selectedSong.title}`,
        text: data.lyrics,
        length: data.length,
        source_type: 'lyrics',
      })
    } catch (e: any) {
      setLoading(false)
      const status = e.response?.status
      const detail: string = e.response?.data?.detail ?? ''
      if (status === 404 || detail.toLowerCase().includes('not found')) {
        setLyricsManualMode(true)
        setLyricsManualText('')
      } else {
        setError(detail || '歌詞の取得に失敗しました。')
      }
    }
  }

  const handleLyricsManualGenerate = async () => {
    if (!lyricsManualText.trim()) return
    setLoading(true); setError('')
    setLoadingMsg('AIが問題を生成中... ⏳')
    const title = lyricsManualTitle.trim()
      || (selectedSong ? `${selectedSong.artist} — ${selectedSong.title}` : '歌詞（手動入力）')
    await go({
      title,
      text: lyricsManualText.trim(),
      length: lyricsManualText.trim().length,
      source_type: 'lyrics',
    })
  }

  const handleVagalumeSearch = async () => {
    if (!lyricsQuery.trim()) return
    setVagaSearching(true); setVagaError(''); setVagaResults([])
    try {
      const data = await vagalumeSearch(lyricsQuery.trim())
      setVagaResults(data.results)
      if (!data.results.length) setVagaError('曲が見つかりませんでした。別のキーワードをお試しください。')
    } catch (e: any) {
      setVagaError(e.response?.data?.detail ?? 'Vagalume 検索エラー')
    } finally {
      setVagaSearching(false)
    }
  }

  const resetLyricsProvider = (p: LyricsProvider) => {
    setLyricsProvider(p)
    setLyricsQuery(''); setLyricsManualText(''); setLyricsManualTitle('')
    setLyricsResults([]); setSelectedSong(null); setLyricsError(''); setLyricsManualMode(false)
    setVagaResults([]); setVagaError('')
  }

  const handleTopicGenerate = async () => {
    if (!topicText.trim()) return
    setLoading(true); setError('')
    setLoadingMsg('トピックを調査中... 🔍')
    await go({
      title: topicText.trim(),
      text:  topicText.trim(),
      length: topicText.trim().length,
      source_type: 'topic',
    })
  }

  const handleAiSearch = async () => {
    if (!aiTopic.trim()) return
    setAiSearching(true); setAiError(''); setAiResults([])
    setDailyUsage(incDailyCount())
    try {
      const results = await aiSearchResources(aiTopic.trim(), studyLang, hintLang)
      setApiStatus('ok')
      setAiResults(results)
      if (!results.length) setAiError('リソースが見つかりませんでした。')
    } catch (e: any) {
      const newStatus = errorToApiStatus(e)
      if (newStatus) setApiStatus(newStatus)
      setAiError(e.response?.data?.detail ?? 'AI検索エラー')
    } finally {
      setAiSearching(false)
    }
  }

  const handleAiResultLoad = async (resource: AiResource) => {
    setLoading(true); setError('')
    setLoadingMsg('ページを読み込み中...')
    try {
      const source = await fetchUrl(resource.url)
      if (!source.text?.trim()) throw new Error('empty')
      await go(source)
    } catch {
      // URL inaccessible or empty — fall back to topic generation using resource metadata
      setLoadingMsg(t('urlFallback'))
      const topicStr = `${resource.title}: ${resource.description}`
      await go({
        title: resource.title,
        text:  topicStr,
        length: topicStr.length,
        source_type: 'topic',
      })
    }
  }

  const statusDot: Record<ApiStatus, string> = {
    ok:      'bg-green-400',
    error:   'bg-red-400',
    quota:   'bg-yellow-400',
    no_key:  'bg-red-400',
    unknown: 'bg-white/20',
  }

  const disabledModes = DISABLED_MODES[subject] ?? new Set<string>()
  const studyModes = [
    { id: 'mixed',      label: t('mixed'),      icon: '🔀' },
    { id: 'listening',  label: t('listening'),  icon: '🎧' },
    { id: 'vocabulary', label: t('vocabulary'), icon: '📖' },
    { id: 'grammar',    label: t('grammar'),    icon: '✏️' },
    { id: 'reading',    label: t('reading'),    icon: '📰' },
    { id: 'lyrics',     label: t('lyrics'),     icon: '🎵' },
  ]

  const sourceItems: { id: Tab; icon: string; label: string }[] = [
    { id: 'youtube',   icon: '▶',  label: 'YouTube' },
    { id: 'url',       icon: '🌐', label: 'Web' },
    { id: 'pdf',       icon: '📄', label: 'PDF' },
    { id: 'text',      icon: '✏️', label: t('text') },
    { id: 'lyrics',    icon: '🎵', label: t('lyricsTab') },
    { id: 'ai-search', icon: '🔍', label: 'AI' },
    { id: 'topic',     icon: '💡', label: t('topic') },
  ]

  const accentByTab: Record<Tab, string> = {
    youtube:   'border-red-400/60 text-red-300',
    url:       'border-sky-400/60 text-sky-300',
    pdf:       'border-orange-400/60 text-orange-300',
    text:      'border-emerald-400/60 text-emerald-300',
    lyrics:    'border-purple-400/60 text-purple-300',
    'ai-search': 'border-teal-400/60 text-teal-300',
    topic:     'border-violet-400/60 text-violet-300',
  }
  const inputBorderByTab: Record<Tab, string> = {
    youtube:   'focus:border-red-400',
    url:       'focus:border-sky-400',
    pdf:       'focus:border-orange-400',
    text:      'focus:border-emerald-400',
    lyrics:    'focus:border-purple-400',
    'ai-search': 'focus:border-teal-400',
    topic:     'focus:border-violet-400',
  }
  const btnByTab: Record<Tab, string> = {
    youtube:   'bg-red-600 hover:bg-red-500',
    url:       'bg-sky-600 hover:bg-sky-500',
    pdf:       'bg-orange-600 hover:bg-orange-500',
    text:      'bg-emerald-600 hover:bg-emerald-500',
    lyrics:    'bg-purple-600 hover:bg-purple-500',
    'ai-search': 'bg-teal-700 hover:bg-teal-600',
    topic:     'bg-violet-600 hover:bg-violet-500',
  }

  return (
    <div className="min-h-screen bg-[#08090f] text-white">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 bg-[#08090f]/90 backdrop-blur border-b border-white/[0.06] px-4 py-2.5 flex items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xl">🎓</span>
          <span className="font-black text-sm tracking-tight bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-transparent">
            QuizAI
          </span>
        </div>

        <div className="flex-1" />

        {/* API status */}
        {(() => {
          const statusKey: Record<ApiStatus, string> = { ok: 'apiOk', error: 'apiError', quota: 'apiQuota', no_key: 'apiError', unknown: 'apiUnknown' }
          const left = Math.max(0, DAILY_LIMIT - dailyUsage)
          const pct  = left / DAILY_LIMIT
          const leftColor = pct > 0.2 ? 'text-white/30' : pct > 0.05 ? 'text-yellow-400/70' : 'text-red-400/80'
          return (
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${statusDot[apiStatus]}`} title={t(statusKey[apiStatus])} />
              {apiStatus === 'ok' && (() => {
                const { hours, minutes } = getTimeUntilReset()
                return (
                  <span className={`text-[11px] hidden sm:block ${leftColor}`}>
                    {t('remaining')} {left} · {hours}{t('hr')}{minutes}{t('min')}
                  </span>
                )
              })()}
            </div>
          )
        })()}

        <select
          value={uiLang}
          onChange={e => setUiLang(e.target.value as UiLang)}
          className="bg-white/[0.06] border border-white/10 text-[11px] px-2 py-1 rounded-lg focus:outline-none cursor-pointer text-white/70"
        >
          {UI_LANGS.map(l => (
            <option key={l.id} value={l.id} className="bg-slate-900">{l.label}</option>
          ))}
        </select>
      </header>

      {/* ── AI unavailability banner ────────────────────────────────────── */}
      {(apiStatus === 'error' || apiStatus === 'quota') && (() => {
        const { hours, minutes } = getTimeUntilReset()
        return (
          <div className="bg-amber-500/[0.08] border-b border-amber-500/20 px-4 py-2 flex items-center gap-2 text-xs">
            <span className="text-base">⚠️</span>
            <span className="text-amber-300/90 font-medium">
              {apiStatus === 'quota' ? t('recoveryQuota') : t('recoveryError')}
            </span>
            {apiStatus === 'quota' && (
              <span className="text-amber-400/40 ml-1">
                · {t('resetIn')} {hours}{t('hr')}{minutes}{t('min')}
              </span>
            )}
          </div>
        )
      })()}

      <div className="max-w-xl mx-auto px-4 py-6 space-y-4">

        {/* ── Stats ──────────────────────────────────────────────────────── */}
        {stats && stats.sessions > 0 && (
          <div className="rounded-2xl bg-white/[0.03] border border-white/[0.07] p-4 space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: stats.sessions,           label: t('sessions'),    color: 'text-violet-400' },
                { value: stats.total_q,            label: t('totalQ'),      color: 'text-cyan-400' },
                { value: `${stats.avg_accuracy}%`, label: t('avgAccuracy'), color: 'text-emerald-400' },
              ].map(({ value, label, color }) => (
                <div key={label} className="text-center">
                  <p className={`text-2xl font-black ${color}`}>{value}</p>
                  <p className="text-[10px] text-white/30 mt-0.5">{label}</p>
                </div>
              ))}
            </div>

            {/* Streak + daily goal */}
            <div className="flex items-center gap-3 border-t border-white/[0.06] pt-3">
              <div className="flex items-center gap-1.5">
                <span className="text-lg">🔥</span>
                <span className="text-sm font-bold text-orange-400">{streak}</span>
                <span className="text-[10px] text-white/30">日連続</span>
              </div>
              <div className="flex-1">
                <div className="flex justify-between text-[10px] text-white/30 mb-1">
                  <span>本日の目標</span>
                  <span>{Math.min(dailyUsage, dailyGoal)} / {dailyGoal}</span>
                </div>
                <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-violet-500 to-cyan-500 transition-all duration-500"
                    style={{ width: `${Math.min(100, (dailyUsage / dailyGoal) * 100)}%` }}
                  />
                </div>
              </div>
              {historyData.length > 0 && (
                <button
                  onClick={() => setShowChart(c => !c)}
                  className="text-[10px] text-white/30 hover:text-white/60 transition-colors shrink-0">
                  {showChart ? '▲ グラフ' : '▼ グラフ'}
                </button>
              )}
            </div>

            {/* Progress chart */}
            {showChart && historyData.length > 0 && (
              <div className="border-t border-white/[0.06] pt-3">
                <p className="text-[10px] text-white/30 mb-2">30日間の学習推移</p>
                <ResponsiveContainer width="100%" height={120}>
                  <LineChart data={historyData} margin={{ top: 4, right: 4, bottom: 0, left: -28 }}>
                    <XAxis dataKey="date" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.25)' }} tickFormatter={d => d.slice(5)} />
                    <YAxis tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.25)' }} />
                    <Tooltip
                      contentStyle={{ background: '#12131f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11 }}
                      labelStyle={{ color: 'rgba(255,255,255,0.5)' }}
                    />
                    <Line type="monotone" dataKey="total_q" stroke="#a78bfa" strokeWidth={2} dot={false} name="問題数" />
                    <Line type="monotone" dataKey="avg_accuracy" stroke="#34d399" strokeWidth={2} dot={false} name="正答率%" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {sessions.length > 0 && (
              <div className="border-t border-white/[0.06] pt-3 space-y-1.5">
                {sessions.slice(0, 3).map((s: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 text-xs">
                    <span className="text-white/20 w-3 shrink-0 font-mono">{i + 1}</span>
                    <span className="flex-1 text-white/50 truncate">{s.title}</span>
                    <span className={`font-bold tabular-nums shrink-0 ${
                      (s as SessionRecord).accuracy >= 80 ? 'text-emerald-400' :
                      (s as SessionRecord).accuracy >= 60 ? 'text-yellow-400' : 'text-red-400'}`}>
                      {(s as SessionRecord).accuracy}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Subject grid ───────────────────────────────────────────────── */}
        <div className="rounded-2xl bg-white/[0.03] border border-white/[0.07] p-4">
          <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest mb-3">{t('subject')}</p>
          <div className="flex gap-2 overflow-x-auto pb-1 snap-x scrollbar-none">
            {ALL_SUBJECTS.map(s => (
              <button
                key={s.id}
                onClick={() => setSubject(s.id)}
                className={`snap-start shrink-0 flex flex-col items-center gap-1.5 py-2.5 px-3 rounded-xl text-center transition-all duration-150
                  ${subject === s.id
                    ? 'bg-violet-500/20 border border-violet-500/40 shadow-lg shadow-violet-500/10 scale-[1.04]'
                    : 'bg-white/[0.04] border border-transparent hover:bg-white/[0.08] hover:border-white/10'}`}
              >
                <span className="text-xl leading-none">{s.emoji}</span>
                <span className={`text-[10px] font-semibold whitespace-nowrap ${subject === s.id ? 'text-violet-300' : 'text-white/50'}`}>
                  {s.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* ── Settings row ───────────────────────────────────────────────── */}
        <div className="rounded-2xl bg-white/[0.03] border border-white/[0.07] p-4 space-y-3">
          <div className="flex gap-2 flex-wrap">
            {/* Difficulty */}
            <div className="flex-1 min-w-[90px]">
              <p className="text-[10px] text-white/30 mb-1.5 font-medium">{t('difficulty')}</p>
              <select value={difficulty} onChange={e => setDifficulty(e.target.value)}
                className="w-full bg-white/[0.06] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-violet-400 cursor-pointer">
                <option value="beginner"     className="bg-slate-900">{t('beginner')}</option>
                <option value="intermediate" className="bg-slate-900">{t('intermediate')}</option>
                <option value="advanced"     className="bg-slate-900">{t('advanced')}</option>
              </select>
            </div>
            {/* Quiz lang */}
            <div className="flex-1 min-w-[90px]">
              <p className="text-[10px] text-white/30 mb-1.5 font-medium">{t('quizLang')}</p>
              <select value={quizLang} onChange={e => setQuizLang(e.target.value)}
                className="w-full bg-white/[0.06] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-violet-400 cursor-pointer">
                {HINT_LANGS.map(l => <option key={l.id} value={l.id} className="bg-slate-900">{l.label}</option>)}
              </select>
            </div>
            {/* Hint lang */}
            <div className="flex-1 min-w-[90px]">
              <p className="text-[10px] text-white/30 mb-1.5 font-medium">{t('hintLang')}</p>
              <select value={hintLang} onChange={e => setHintLang(e.target.value)}
                className="w-full bg-white/[0.06] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-violet-400 cursor-pointer">
                {HINT_LANGS.map(l => <option key={l.id} value={l.id} className="bg-slate-900">{l.label}</option>)}
              </select>
            </div>
            {/* Num questions */}
            <div className="flex-[2] min-w-[120px]">
              <p className="text-[10px] text-white/30 mb-1.5 font-medium">
                {t('numQ')}: <span className="text-white font-bold">{numQ}</span>
              </p>
              <input type="range" min={5} max={100} step={5} value={numQ}
                onChange={e => setNumQ(Number(e.target.value))}
                className="w-full accent-violet-400 mt-1" />
              <div className="flex justify-between text-[9px] text-white/20 mt-0.5">
                <span>5</span><span>50</span><span>100</span>
              </div>
            </div>
          </div>

          {/* Study mode */}
          <div>
            <p className="text-[10px] text-white/30 mb-2 font-medium">{t('studyMode')}</p>
            <div className="flex gap-1.5 flex-wrap">
              {studyModes.map(m => {
                const isOff = disabledModes.has(m.id)
                return (
                  <button
                    key={m.id}
                    onClick={() => !isOff && setStudyMode(m.id)}
                    disabled={isOff}
                    title={isOff ? t('disabledMode') : undefined}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-all
                      ${isOff
                        ? 'opacity-20 cursor-not-allowed text-white/30'
                        : studyMode === m.id
                          ? 'bg-violet-500/25 text-violet-300 border border-violet-500/40'
                          : 'bg-white/[0.05] text-white/50 hover:bg-white/10 hover:text-white/80 border border-transparent'}`}>
                    <span className="text-sm">{m.icon}</span>{m.label}
                  </button>
                )
              })}
            </div>
            {studyMode === 'listening' && (
              <p className="text-[10px] text-violet-300/60 mt-2">{t('listeningHint')}</p>
            )}
          </div>

          {/* Furigana toggle — only for Japanese subject */}
          {subject === 'japanese' && (
            <div className="flex items-center justify-between border-t border-white/[0.06] pt-3">
              <div>
                <p className="text-xs text-white/60 font-medium">フリガナ表示</p>
                <p className="text-[10px] text-white/25 mt-0.5">漢字の読み仮名をルビで表示</p>
              </div>
              <button
                onClick={() => toggleFurigana(!furigana)}
                className={`relative w-10 h-5.5 rounded-full transition-colors duration-200 ${furigana ? 'bg-violet-500' : 'bg-white/10'}`}
                style={{ height: 22 }}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${furigana ? 'translate-x-5' : 'translate-x-0.5'}`}
                />
              </button>
            </div>
          )}

          {/* Daily goal */}
          <div className="border-t border-white/[0.06] pt-3">
            <p className="text-[10px] text-white/30 mb-1.5 font-medium">
              1日の目標セッション数: <span className="text-white font-bold">{dailyGoal}</span>
            </p>
            <input type="range" min={5} max={50} step={5} value={dailyGoal}
              onChange={e => setDailyGoal(Number(e.target.value))}
              className="w-full accent-violet-400" />
            <div className="flex justify-between text-[9px] text-white/20 mt-0.5">
              <span>5</span><span>25</span><span>50</span>
            </div>
          </div>
        </div>

        {/* ── Source panel ────────────────────────────────────────────────── */}
        <div className="rounded-2xl bg-white/[0.03] border border-white/[0.07] overflow-hidden">

          {/* Source type grid */}
          <div className="grid grid-cols-7 border-b border-white/[0.06]">
            {sourceItems.map(({ id, icon, label }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex flex-col items-center gap-1 py-3 px-1 text-center transition-all
                  ${tab === id
                    ? `bg-white/[0.06] border-b-2 ${accentByTab[id]}`
                    : 'text-white/30 hover:text-white/60 hover:bg-white/[0.03] border-b-2 border-transparent'}`}
              >
                <span className="text-base leading-none">{icon}</span>
                <span className="text-[9px] font-semibold leading-tight">{label}</span>
              </button>
            ))}
          </div>

          <div className="p-4">

            {/* ── YouTube ── */}
            {tab === 'youtube' && (
              <div className="space-y-3">
                <p className="text-xs text-white/40">YouTube動画のURLを入力 → 字幕から問題を自動生成</p>
                <div className="flex gap-2">
                  <input value={url} onChange={e => setUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleUrl()}
                    placeholder="https://www.youtube.com/watch?v=..."
                    className={`flex-1 bg-white/[0.06] border border-white/10 rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none ${inputBorderByTab[tab]} transition-colors`} />
                  <button onClick={handleUrl} disabled={!url.trim() || loading}
                    className={`${btnByTab[tab]} disabled:opacity-30 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors`}>
                    {t('fetch')}
                  </button>
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] text-white/25">おすすめ（英語学習）</p>
                  {[
                    ['TED Talk — Your body language', 'https://www.youtube.com/watch?v=Ks-_Mh1QhMc'],
                    ['BBC 6 Minute English',          'https://www.youtube.com/watch?v=MNAtUxqOxpQ'],
                  ].map(([label, link]) => (
                    <button key={link} onClick={() => setUrl(link)}
                      className="block w-full text-left text-xs text-red-400/70 hover:text-red-300 truncate transition-colors">
                      ▶ {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── URL ── */}
            {tab === 'url' && (
              <div className="space-y-3">
                <p className="text-xs text-white/40">WebページのURLを入力 → 本文を自動抽出して問題を生成</p>
                <div className="flex gap-2">
                  <input value={url} onChange={e => setUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleUrl()}
                    placeholder="https://example.com/article"
                    className={`flex-1 bg-white/[0.06] border border-white/10 rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none ${inputBorderByTab[tab]} transition-colors`} />
                  <button onClick={handleUrl} disabled={!url.trim() || loading}
                    className={`${btnByTab[tab]} disabled:opacity-30 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors`}>
                    {t('fetch')}
                  </button>
                </div>
              </div>
            )}

            {/* ── PDF ── */}
            {tab === 'pdf' && (
              <div>
                <input ref={fileRef} type="file" accept=".pdf,.txt" className="hidden"
                  onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
                <button onClick={() => fileRef.current?.click()}
                  className="w-full border-2 border-dashed border-white/10 hover:border-orange-400/40 rounded-xl py-10 flex flex-col items-center gap-3 transition-all group">
                  <span className="text-4xl group-hover:scale-110 transition-transform">📄</span>
                  <span className="text-sm text-white/40 group-hover:text-white/70 transition-colors">PDFまたはTXTをクリックして選択</span>
                </button>
              </div>
            )}

            {/* ── Text ── */}
            {tab === 'text' && (
              <div className="space-y-3">
                <p className="text-xs text-white/40">学習したいテキストを直接貼り付け</p>
                <textarea value={text} onChange={e => setText(e.target.value)}
                  placeholder="ここにテキストを貼り付けてください..."
                  rows={5}
                  className={`w-full bg-white/[0.06] border border-white/10 rounded-xl px-3 py-3 text-sm placeholder-white/20 focus:outline-none ${inputBorderByTab[tab]} resize-none transition-colors`} />
                <button onClick={handleText} disabled={!text.trim() || loading}
                  className={`w-full ${btnByTab[tab]} disabled:opacity-30 py-3 rounded-xl text-sm font-bold transition-all`}>
                  {t('generate')}
                </button>
              </div>
            )}

            {/* ── Lyrics ── */}
            {tab === 'lyrics' && (
              <div className="space-y-4">
                <div className="flex gap-1.5">
                  {([
                    ['western',    '🎵 英語・欧米'],
                    ['portuguese', '🇧🇷 Português'],
                    ['japanese',   '🇯🇵 日本語'],
                  ] as [LyricsProvider, string][]).map(([id, label]) => (
                    <button key={id} onClick={() => resetLyricsProvider(id)}
                      className={`flex-1 py-2 text-xs font-semibold rounded-xl transition-all
                        ${lyricsProvider === id ? 'bg-purple-600/70 text-white border border-purple-500/40' : 'bg-white/[0.05] text-white/50 hover:bg-white/10 border border-transparent'}`}>
                      {label}
                    </button>
                  ))}
                </div>

                {lyricsProvider === 'western' && (
                  lyricsManualMode ? (
                    <div className="space-y-3">
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-xs text-amber-300/80">
                        ⚠️ 自動取得できませんでした。歌詞をコピーして貼り付けてください。
                      </div>
                      {selectedSong && <p className="text-xs text-white/40">🎵 {selectedSong.artist} — {selectedSong.title}</p>}
                      <textarea value={lyricsManualText} onChange={e => setLyricsManualText(e.target.value)}
                        placeholder="ここに歌詞を貼り付けてください..." rows={7}
                        className="w-full bg-white/[0.06] border border-white/10 rounded-xl px-3 py-3 text-sm placeholder-white/20 focus:outline-none focus:border-purple-400 resize-none" />
                      <div className="flex gap-2">
                        <button onClick={() => { setLyricsManualMode(false); setSelectedSong(null); setLyricsResults([]) }}
                          className="flex-1 py-2.5 border border-white/10 rounded-xl text-xs font-semibold hover:bg-white/[0.06] text-white/50">
                          ← 検索に戻る
                        </button>
                        <button onClick={handleLyricsManualGenerate} disabled={!lyricsManualText.trim() || loading}
                          className="flex-1 py-2.5 bg-purple-600/70 hover:bg-purple-500/70 border border-purple-500/40 disabled:opacity-30 rounded-xl text-xs font-bold">
                          🎵 {t('generateBtn')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <input value={lyricsQuery} onChange={e => setLyricsQuery(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleLyricsSearch()}
                          placeholder="例: Ed Sheeran, Shape of You, BTS..."
                          className="flex-1 bg-white/[0.06] border border-white/10 rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-purple-400" />
                        <button onClick={handleLyricsSearch} disabled={!lyricsQuery.trim() || lyricsSearching}
                          className="bg-purple-600/70 hover:bg-purple-500/70 border border-purple-500/40 disabled:opacity-30 px-4 py-2.5 rounded-xl text-sm font-bold min-w-[56px]">
                          {lyricsSearching ? '...' : t('search')}
                        </button>
                      </div>
                      <button onClick={() => { setLyricsManualMode(true); setLyricsManualText('') }}
                        className="text-xs text-purple-400/60 hover:text-purple-300 transition-colors">
                        ✏️ 歌詞を直接貼り付ける（日本語・韓国語等）
                      </button>
                      {lyricsError && <p className="text-xs text-red-400/80">{lyricsError}</p>}
                      {lyricsResults.length > 0 && !selectedSong && (
                        <div className="max-h-52 overflow-y-auto rounded-xl border border-white/[0.07] divide-y divide-white/[0.04]">
                          {lyricsResults.map((r, i) => (
                            <button key={i} onClick={() => setSelectedSong(r)}
                              className="w-full text-left px-4 py-2.5 hover:bg-white/[0.06] transition-colors">
                              <span className="text-sm text-white font-medium">{r.title}</span>
                              <span className="text-xs text-white/40 ml-2">{r.artist}</span>
                              {r.album && <span className="text-xs text-white/20 ml-1">/ {r.album}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                      {selectedSong && (
                        <div className="bg-purple-500/10 border border-purple-500/25 rounded-xl p-4">
                          <div className="flex items-start justify-between gap-2 mb-3">
                            <div>
                              <p className="text-sm font-bold">{selectedSong.title}</p>
                              <p className="text-xs text-white/50 mt-0.5">{selectedSong.artist}</p>
                            </div>
                            <button onClick={() => { setSelectedSong(null); setLyricsResults([]) }}
                              className="text-white/25 hover:text-white/60 text-xs shrink-0 pt-0.5">✕</button>
                          </div>
                          <button onClick={handleLyricsGenerate} disabled={loading}
                            className="w-full bg-purple-600/70 hover:bg-purple-500/70 border border-purple-500/40 disabled:opacity-30 py-2.5 rounded-xl text-sm font-bold transition-all">
                            🎵 {t('generateBtn')}
                          </button>
                        </div>
                      )}
                    </>
                  )
                )}

                {lyricsProvider === 'portuguese' && (
                  <div className="space-y-4">
                    <div className="flex gap-2">
                      <input value={lyricsQuery} onChange={e => setLyricsQuery(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleVagalumeSearch()}
                        placeholder="例: Djavan, Marisa Monte, Legião Urbana..."
                        className="flex-1 bg-white/[0.06] border border-white/10 rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-green-400" />
                      <button onClick={handleVagalumeSearch} disabled={!lyricsQuery.trim() || vagaSearching}
                        className="bg-green-700/80 hover:bg-green-600/80 border border-green-600/30 disabled:opacity-30 px-4 py-2.5 rounded-xl text-sm font-bold min-w-[56px]">
                        {vagaSearching ? '...' : t('search')}
                      </button>
                    </div>
                    {vagaError && <p className="text-xs text-red-400/80">{vagaError}</p>}
                    {vagaResults.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-[10px] text-white/30 leading-relaxed">
                          「歌詞を開く」→ 歌詞をコピー（Ctrl+A → Ctrl+C）→ 下に貼り付け
                        </p>
                        <div className="max-h-48 overflow-y-auto space-y-1.5">
                          {vagaResults.map((r, i) => (
                            <div key={i} className="flex items-center gap-3 bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-2.5">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{r.title}</p>
                                <p className="text-xs text-white/40">{r.artist}</p>
                              </div>
                              <a href={r.url} target="_blank" rel="noopener noreferrer"
                                onClick={() => setLyricsManualTitle(`${r.artist} — ${r.title}`)}
                                className="shrink-0 text-xs bg-green-700/70 hover:bg-green-600/80 px-3 py-1.5 rounded-lg font-semibold transition-colors">
                                開く ↗
                              </a>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="space-y-2 border-t border-white/[0.06] pt-3">
                      <input value={lyricsManualTitle} onChange={e => setLyricsManualTitle(e.target.value)}
                        placeholder="曲名・アーティスト（任意）"
                        className="w-full bg-white/[0.06] border border-white/10 rounded-xl px-3 py-2 text-sm placeholder-white/20 focus:outline-none focus:border-green-400" />
                      <textarea value={lyricsManualText} onChange={e => setLyricsManualText(e.target.value)}
                        placeholder="歌詞をここに貼り付けてください..." rows={6}
                        className="w-full bg-white/[0.06] border border-white/10 rounded-xl px-3 py-3 text-sm placeholder-white/20 focus:outline-none focus:border-green-400 resize-none" />
                      <button onClick={handleLyricsManualGenerate} disabled={!lyricsManualText.trim() || loading}
                        className="w-full py-3 bg-green-700/80 hover:bg-green-600/80 border border-green-600/30 disabled:opacity-30 rounded-xl text-sm font-bold">
                        🎵 {t('generate')}
                      </button>
                    </div>
                  </div>
                )}

                {lyricsProvider === 'japanese' && (
                  <div className="space-y-4">
                    <input value={lyricsQuery} onChange={e => setLyricsQuery(e.target.value)}
                      placeholder="例: YOASOBI, 宇多田ヒカル, 君が好きだと叫びたい..."
                      className="w-full bg-white/[0.06] border border-white/10 rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-red-400" />
                    {lyricsQuery.trim() && (
                      <div className="space-y-2">
                        <p className="text-[10px] text-white/30">
                          下のリンクで歌詞を検索 → コピー → 下に貼り付け
                        </p>
                        <div className="flex gap-2 flex-wrap">
                          {[
                            ['Uta-Net',  `https://www.uta-net.com/search/?target=art_title&type=in&key=${encodeURIComponent(lyricsQuery.trim())}`],
                            ['J-Lyric',  `https://j-lyric.net/index.php?ct=A&ka=on&kt=${encodeURIComponent(lyricsQuery.trim())}`],
                            ['Joysound', `https://www.joysound.com/web/search/song?keyword=${encodeURIComponent(lyricsQuery.trim())}`],
                          ].map(([label, href]) => (
                            <a key={label} href={href} target="_blank" rel="noopener noreferrer"
                              className="text-xs bg-red-700/70 hover:bg-red-600/80 px-3 py-2 rounded-xl font-semibold transition-colors">
                              {label} ↗
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="space-y-2 border-t border-white/[0.06] pt-3">
                      <input value={lyricsManualTitle} onChange={e => setLyricsManualTitle(e.target.value)}
                        placeholder="曲名・アーティスト（任意）"
                        className="w-full bg-white/[0.06] border border-white/10 rounded-xl px-3 py-2 text-sm placeholder-white/20 focus:outline-none focus:border-red-400" />
                      <textarea value={lyricsManualText} onChange={e => setLyricsManualText(e.target.value)}
                        placeholder="歌詞をここに貼り付けてください..." rows={6}
                        className="w-full bg-white/[0.06] border border-white/10 rounded-xl px-3 py-3 text-sm placeholder-white/20 focus:outline-none focus:border-red-400 resize-none" />
                      <button onClick={handleLyricsManualGenerate} disabled={!lyricsManualText.trim() || loading}
                        className="w-full py-3 bg-red-700/80 hover:bg-red-600/80 border border-red-600/30 disabled:opacity-30 rounded-xl text-sm font-bold">
                        🎵 {t('generate')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Topic ── */}
            {tab === 'topic' && (
              <div className="space-y-3">
                <p className="text-xs text-white/40">
                  トピックを入力 → AIの知識から問題を生成（歴史・理科・数学・語学・プログラミング何でも可）
                </p>
                <textarea
                  value={topicText}
                  onChange={e => setTopicText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && e.ctrlKey && handleTopicGenerate()}
                  placeholder={'例: 織田信長\n例: 第二次世界大戦\n例: 微分積分の基礎\n例: Python データ型'}
                  rows={4}
                  className={`w-full bg-white/[0.06] border border-white/10 rounded-xl px-3 py-3 text-sm placeholder-white/20 focus:outline-none ${inputBorderByTab[tab]} resize-none transition-colors`}
                />
                <button
                  onClick={handleTopicGenerate}
                  disabled={!topicText.trim() || loading}
                  className={`w-full py-3 ${btnByTab[tab]} disabled:opacity-30 rounded-xl text-sm font-bold transition-all`}>
                  {t('generateTopic')}
                </button>
              </div>
            )}

            {/* ── AI Search ── */}
            {tab === 'ai-search' && (
              <div className="space-y-4">
                <p className="text-xs text-white/40">
                  AIが学習に役立つWebサイト・PDFを提案 → ワンクリックで問題生成
                </p>
                <div className="flex gap-2">
                  <input value={aiTopic} onChange={e => setAiTopic(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAiSearch()}
                    placeholder="例: JLPT N3文法, business English, フランス語動詞..."
                    className={`flex-1 bg-white/[0.06] border border-white/10 rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none ${inputBorderByTab[tab]} transition-colors`} />
                  <button onClick={handleAiSearch} disabled={!aiTopic.trim() || aiSearching}
                    className={`${btnByTab[tab]} disabled:opacity-30 px-4 py-2.5 rounded-xl text-sm font-bold min-w-[72px]`}>
                    {aiSearching ? '...' : t('aiSearchBtn')}
                  </button>
                </div>
                {aiError && <p className="text-xs text-red-400/80">{aiError}</p>}
                {aiResults.length > 0 && (
                  <div className="space-y-2">
                    {aiResults.map((r, i) => (
                      <div key={i} className="bg-white/[0.04] border border-white/[0.07] rounded-xl p-3">
                        <div className="flex items-start gap-2">
                          <span className="text-lg shrink-0 mt-0.5">{r.type === 'pdf' ? '📄' : '🌐'}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold truncate">{r.title}</p>
                            <p className="text-xs text-white/40 mt-0.5 leading-relaxed">{r.description}</p>
                            <p className="text-[10px] text-teal-400/50 truncate mt-0.5">{r.url}</p>
                          </div>
                          <button onClick={() => handleAiResultLoad(r)} disabled={loading}
                            className="shrink-0 text-xs bg-teal-700/70 hover:bg-teal-600/80 disabled:opacity-30 px-3 py-1.5 rounded-lg font-bold transition-colors">
                            {t('generateBtn')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>

        {/* ── Error ── */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3 text-sm text-red-300/90">
            ⚠️ {error}
          </div>
        )}
      </div>

      {/* ── Loading overlay ─────────────────────────────────────────────── */}
      {loading && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50">
          <div className="bg-[#12131f] border border-white/[0.08] rounded-2xl p-8 flex flex-col items-center gap-5 max-w-xs w-full mx-4 shadow-2xl">
            <div className="relative">
              <div className="w-14 h-14 rounded-full border-2 border-white/5" />
              <div className="absolute inset-0 w-14 h-14 rounded-full border-2 border-t-violet-400 border-r-cyan-400 border-transparent animate-spin" />
            </div>
            <div className="text-center">
              <p className="text-white/80 text-sm font-medium">{loadingMsg}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
