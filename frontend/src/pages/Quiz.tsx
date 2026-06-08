import { useState, useEffect, useRef, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { QuizQuestion, GenerateResponse, saveSession, saveQuestionResults, editQuestion, getAnkiExportUrl } from '../api/client'
import FuriganaText from '../components/FuriganaText'
import katex from 'katex'
import 'katex/dist/katex.min.css'

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

interface QuizState extends GenerateResponse {
  youtube_url?: string
  furigana?: boolean
}

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  vocab:       { label: '単語',   color: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  blank:       { label: '空欄',   color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  translation: { label: '翻訳',   color: 'bg-green-500/20 text-green-300 border-green-500/30' },
  order:       { label: '語順',   color: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
  multiple:    { label: '読解',   color: 'bg-pink-500/20 text-pink-300 border-pink-500/30' },
  calculation: { label: '計算',   color: 'bg-orange-500/20 text-orange-300 border-orange-500/30' },
  code:        { label: 'Code',   color: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' },
}

const TIMER_SECS = 60

// ── Helpers ────────────────────────────────────────────────────────────────

function getYouTubeId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/)
  return m ? m[1] : null
}

function normalizeCalc(s: string): string {
  return s.toString().trim().toLowerCase().replace(/\s+/g, '').replace(/^[a-z]=/, '')
}

// Render text with KaTeX: $...$ inline, $$...$$ display
function renderMath(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  const regex = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g
  let last = 0, m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const raw = m[0]
    const isDisplay = raw.startsWith('$$')
    const inner = isDisplay ? raw.slice(2, -2) : raw.slice(1, -1)
    try {
      const html = katex.renderToString(inner, { displayMode: isDisplay, throwOnError: false })
      parts.push(<span key={m.index} dangerouslySetInnerHTML={{ __html: html }} />)
    } catch { parts.push(raw) }
    last = m.index + raw.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

// Render question: handles ```code``` blocks + math
function renderQuestion(text: string, isCode: boolean): React.ReactNode {
  if (isCode) {
    const parts = text.split(/(```[\s\S]*?```)/g)
    return (
      <div className="mb-4 space-y-2">
        {parts.map((part, i) => {
          if (part.startsWith('```')) {
            const code = part.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
            return (
              <pre key={i} className="bg-black/50 border border-white/15 rounded-xl p-4 font-mono text-sm text-green-300 overflow-x-auto whitespace-pre-wrap">
                {code}
              </pre>
            )
          }
          return part ? <p key={i} className="text-base font-medium leading-relaxed">{part}</p> : null
        })}
      </div>
    )
  }
  return <p className="text-lg font-medium leading-relaxed mb-4">{renderMath(text)}</p>
}

function getVoice(lang: string): string {
  const map: Record<string, string> = {
    en: 'en-US-female', ja: 'ja-female', es: 'es-female',
    fr: 'fr-female',    ko: 'ko-female', zh: 'zh-female',
    pt: 'pt-female',    de: 'de-female',
  }
  return map[lang] ?? 'en-US-female'
}

async function playTTS(text: string, lang = 'en', slow = false) {
  try {
    let clean = text.replace(/^[A-D]\)\s*/, '').trim()
    if (lang === 'en') {
      clean = clean.replace(/（[^）]*）/g, '').replace(/[　-鿿＀-￯]/g, '').trim()
      if (!clean || !/[a-zA-Z]/.test(clean)) return
    } else {
      if (!clean) return
    }
    const voice = getVoice(lang)
    const resp = await fetch(`${API}/api/audio/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, voice, slow, lang }),
    })
    if (!resp.ok || resp.status === 204) return
    const blob = await resp.blob()
    const audioUrl = URL.createObjectURL(blob)
    const audio = new Audio(audioUrl)
    audio.play()
    audio.onended = () => URL.revokeObjectURL(audioUrl)
  } catch (e) { console.warn('TTS error:', e) }
}

// Score: MC + calculation count; translation/order/open-code do not
function calcScore(qs: QuizQuestion[], answers: (number | string)[]) {
  let score = 0, total = 0
  qs.forEach((q, i) => {
    if (q.type === 'translation' || q.type === 'order') return
    if (q.type === 'code' && !q.options) return
    total++
    if (q.type === 'calculation') {
      if (normalizeCalc(String(answers[i] ?? '')) === normalizeCalc(String(q.answer))) score++
    } else {
      if (answers[i] === q.answer) score++
    }
  })
  return { score, mcTotal: total, pct: total ? Math.round(score / total * 100) : 0 }
}

// ── Component ──────────────────────────────────────────────────────────────

export default function Quiz() {
  const location = useLocation()
  const navigate = useNavigate()
  const data = location.state as QuizState | null

  const studyLang   = data?.study_language ?? 'en'
  const studyMode   = data?.study_mode ?? 'mixed'
  const isListening = studyMode === 'listening'
  const youtubeId   = data?.youtube_url ? getYouTubeId(data.youtube_url) : null
  const furigana    = !!(data?.furigana && studyLang === 'ja')
  // ttsLang    = language the QUESTION TEXT is written in (for reading questions aloud)
  // answerLang = language being STUDIED (for reading vocabulary / answer options aloud)
  // These differ when e.g. studying Japanese with Portuguese-language questions:
  //   ttsLang='pt' (reads Portuguese question), answerLang='ja' (reads Japanese vocabulary)
  const ttsLang    = (data?.quiz_language || data?.study_language || 'en')
  const answerLang = data?.study_language ?? 'en'

  // Core quiz state
  const [idx,      setIdx]      = useState(0)
  const [answers,  setAnswers]  = useState<(number | string)[]>([])
  const [done,     setDone]     = useState(false)
  const [saved,    setSaved]    = useState(false)
  const [freeText, setFreeText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Feature toggles
  const [shuffleOn,  setShuffleOn]  = useState(false)
  const [shuffledQs, setShuffledQs] = useState<QuizQuestion[]>([])
  const [timerOn,    setTimerOn]    = useState(false)
  const [timeLeft,   setTimeLeft]   = useState(TIMER_SECS)
  const [flashcard,  setFlashcard]  = useState(false)
  const [flipped,    setFlipped]    = useState(false)
  const [showVideo,  setShowVideo]  = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Edit modal
  const [editOpen,      setEditOpen]      = useState(false)
  const [editQuestion_, setEditQuestion_] = useState('')
  const [editOptions,   setEditOptions]   = useState<string[]>([])
  const [editAnswer,    setEditAnswer]    = useState<number | string>(0)
  const [editExplain,   setEditExplain]   = useState('')
  const [editSaving,    setEditSaving]    = useState(false)

  // Local questions (mutable so edits reflect immediately)
  const [localQs, setLocalQs] = useState<QuizQuestion[]>(data?.questions ?? [])

  useEffect(() => { if (!data) navigate('/') }, [data, navigate])
  useEffect(() => { setFreeText(''); setFlipped(false) }, [idx])

  // Auto-play TTS in listening mode
  useEffect(() => {
    if (!data || !isListening) return
    const activeQs = shuffleOn && shuffledQs.length ? shuffledQs : data.questions
    const q = activeQs[idx]
    if (!q) return
    const timer = setTimeout(() => playTTS(q.question, ttsLang, false), 400)
    return () => clearTimeout(timer)
  }, [idx, isListening, ttsLang])

  // Timer countdown
  useEffect(() => {
    if (!timerOn || !data || done || flashcard) return
    const alreadyAnswered = answers.length > idx
    if (alreadyAnswered) return

    setTimeLeft(TIMER_SECS)
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current)
          const activeQs = shuffleOn && shuffledQs.length ? shuffledQs : data!.questions
          const q = activeQs[idx]
          const isFreeQ = q.type === 'translation' || q.type === 'order' ||
                          q.type === 'calculation' || (q.type === 'code' && !q.options)
          const next = [...answers, isFreeQ ? '' : -1]
          setAnswers(next)
          if (next.length >= activeQs.length) {
            doSave(activeQs, next)
            setDone(true)
          }
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [idx, timerOn, answers.length, flashcard, done])

  const doSave = useCallback(async (qs: QuizQuestion[], ans: (number | string)[]) => {
    if (saved) return
    setSaved(true)
    const { score, mcTotal } = calcScore(qs, ans)

    const results = qs
      .map((q, i) => {
        if (!q.id) return null
        if (q.type === 'translation' || q.type === 'order') return null
        if (q.type === 'code' && !q.options) return null
        const correct = q.type === 'calculation'
          ? normalizeCalc(String(ans[i] ?? '')) === normalizeCalc(String(q.answer))
          : ans[i] === q.answer
        // SM-2 quality: 4=correct, 1=wrong, 0=timeout/skip
        const quality = ans[i] === -1 || ans[i] === '' ? 0 : correct ? 4 : 1
        return { id: q.id, correct, quality }
      })
      .filter((r): r is { id: number; correct: boolean; quality: number } => r !== null)

    if (results.length > 0) saveQuestionResults(results).catch(() => {})

    await saveSession({
      subject: data!.subject, source: 'quiz', title: data!.title,
      score, mc_total: mcTotal, total_q: qs.length,
    }).catch(() => {})
  }, [saved, data])

  if (!data) return null

  const allQs   = localQs
  const qs      = shuffleOn && shuffledQs.length ? shuffledQs : allQs
  const q       = qs[idx]
  const already = answers.length > idx
  const isFree  = q.type === 'translation' || q.type === 'order' ||
                  q.type === 'calculation' || (q.type === 'code' && !q.options)
  const isCode  = q.type === 'code'
  const isCalc  = q.type === 'calculation'
  const typeInfo = TYPE_LABELS[q.type] ?? { label: q.type, color: 'bg-white/10 text-white/60 border-white/20' }
  const timerPct = (timeLeft / TIMER_SECS) * 100

  const submitMC = (i: number) => {
    if (timerRef.current) clearInterval(timerRef.current)
    const next = [...answers, i]
    setAnswers(next)
    if (next.length >= qs.length) { doSave(qs, next); setDone(true) }
  }

  const submitFree = (val: string) => {
    if (timerRef.current) clearInterval(timerRef.current)
    const next = [...answers, val]
    setAnswers(next)
    if (next.length >= qs.length) { doSave(qs, next); setDone(true) }
  }

  const next = () => {
    if (idx + 1 >= qs.length) setDone(true)
    else setIdx(i => i + 1)
  }

  const toggleShuffle = () => {
    if (!shuffleOn) {
      setShuffledQs([...allQs].sort(() => Math.random() - 0.5))
    }
    setShuffleOn(!shuffleOn)
    setIdx(0); setAnswers([])
  }

  // ── Edit helpers ────────────────────────────────────────────────────────
  const openEdit = () => {
    setEditQuestion_(q.question)
    setEditOptions(q.options ? [...q.options] : [])
    setEditAnswer(q.answer)
    setEditExplain(q.explanation ?? '')
    setEditOpen(true)
  }

  const saveEdit = async () => {
    if (!q.id) return
    setEditSaving(true)
    try {
      await editQuestion(q.id, {
        question: editQuestion_,
        options: editOptions.length ? editOptions : undefined,
        answer: editAnswer,
        explanation: editExplain || undefined,
      })
      setLocalQs(prev => prev.map(item =>
        item.id === q.id
          ? { ...item, question: editQuestion_, options: editOptions.length ? editOptions : item.options, answer: editAnswer, explanation: editExplain }
          : item
      ))
      setEditOpen(false)
    } catch { /* silently ignore */ }
    finally { setEditSaving(false) }
  }

  // ── Results ──────────────────────────────────────────────────────────────
  if (done) {
    const { score, mcTotal, pct } = calcScore(qs, answers)
    const grade =
      pct >= 90 ? { label: 'S', color: 'text-yellow-300', ring: 'from-yellow-400 to-amber-500' } :
      pct >= 75 ? { label: 'A', color: 'text-emerald-300', ring: 'from-emerald-400 to-cyan-500' } :
      pct >= 55 ? { label: 'B', color: 'text-sky-300',     ring: 'from-sky-400 to-blue-500' } :
      pct >= 35 ? { label: 'C', color: 'text-violet-300',  ring: 'from-violet-400 to-purple-500' } :
                  { label: 'D', color: 'text-white/50',    ring: 'from-slate-400 to-slate-600' }

    const wrongQs = qs.filter((q, i) => {
      if (q.type === 'translation' || q.type === 'order') return false
      if (q.type === 'code' && !q.options) return false
      if (q.type === 'calculation')
        return normalizeCalc(String(answers[i] ?? '')) !== normalizeCalc(String(q.answer))
      return answers[i] !== q.answer
    })

    return (
      <div className="min-h-screen bg-[#08090f] text-white flex flex-col items-center justify-center p-5">
        <div className="w-full max-w-md space-y-5">

          {/* Score ring */}
          <div className="flex flex-col items-center gap-2 py-6">
            <div className="relative w-36 h-36">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="42" fill="none" stroke="white" strokeOpacity="0.05" strokeWidth="8" />
                <circle cx="50" cy="50" r="42" fill="none"
                  stroke="url(#grad)" strokeWidth="8" strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 42}`}
                  strokeDashoffset={`${2 * Math.PI * 42 * (1 - pct / 100)}`}
                  className="transition-all duration-1000" />
                <defs>
                  <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#8b5cf6" />
                    <stop offset="100%" stopColor="#06b6d4" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className={`text-4xl font-black ${grade.color}`}>{grade.label}</span>
                <span className="text-white/40 text-xs">{pct}%</span>
              </div>
            </div>
            <p className="text-white/40 text-sm">{score} / {mcTotal} 正解　全{qs.length}問</p>
            <p className="text-lg font-bold truncate max-w-xs text-center text-white/70">{data!.title}</p>
          </div>

          {/* Wrong questions review */}
          {wrongQs.length > 0 && (
            <div className="bg-white/[0.03] border border-white/[0.07] rounded-2xl p-4 space-y-3">
              <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">復習ポイント</p>
              {wrongQs.slice(0, 3).map((q, i) => (
                <div key={i} className="border-l-2 border-red-500/40 pl-3">
                  <p className="text-xs text-white/60 truncate">{q.question.replace(/```[\s\S]*?```/g, '[コード]')}</p>
                  <p className="text-emerald-400 text-xs mt-0.5 font-medium">
                    {q.options ? q.options[q.answer as number] : String(q.answer)}
                  </p>
                </div>
              ))}
              {wrongQs.length > 3 && (
                <p className="text-[10px] text-white/25 pl-3">…他 {wrongQs.length - 3} 問</p>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => navigate('/')}
              className="py-3.5 rounded-xl bg-white/[0.05] border border-white/[0.08] text-sm font-semibold hover:bg-white/10 transition-colors text-white/70">
              ← ホーム
            </button>
            <button onClick={() => { setIdx(0); setAnswers([]); setDone(false); setSaved(false) }}
              className="py-3.5 rounded-xl bg-violet-500/20 border border-violet-500/30 text-violet-300 text-sm font-semibold hover:bg-violet-500/30 transition-colors">
              もう一度
            </button>
          </div>

          {wrongQs.length > 0 && (
            <button
              onClick={() => {
                setSaved(false); setIdx(0); setAnswers([]); setDone(false)
                setShuffledQs(wrongQs); setShuffleOn(true)
              }}
              className="w-full py-3.5 rounded-xl bg-amber-500/15 border border-amber-500/25 text-amber-300 text-sm font-bold hover:bg-amber-500/25 transition-colors">
              間違えた {wrongQs.length} 問を復習する
            </button>
          )}

          {/* Anki export + share */}
          <div className="flex gap-2 pt-1">
            {data!.pool_size && data!.pool_size > 0 && (() => {
              const sourceKey = encodeURIComponent(`${data!.subject}:${data!.title}`)
              return (
                <a
                  href={getAnkiExportUrl(sourceKey)}
                  download
                  className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl bg-white/[0.05] border border-white/[0.08] text-xs font-semibold text-white/50 hover:bg-white/[0.1] hover:text-white/80 transition-colors">
                  📦 Ankiエクスポート
                </a>
              )
            })()}
            {'share' in navigator && (
              <button
                onClick={() => {
                  navigator.share({
                    title: 'QuizAI 結果',
                    text: `「${data!.title}」 — ${pct}% (${score}/${mcTotal}) 正解！\n#QuizAI`,
                  }).catch(() => {})
                }}
                className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl bg-white/[0.05] border border-white/[0.08] text-xs font-semibold text-white/50 hover:bg-white/[0.1] hover:text-white/80 transition-colors">
                📤 シェア
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Flashcard mode ────────────────────────────────────────────────────────
  if (flashcard) {
    const correctAns = q.options ? q.options[q.answer as number] : String(q.answer)
    const fcPct = (idx / qs.length) * 100
    return (
      <div className="min-h-screen bg-[#08090f] text-white flex flex-col">
        {/* Header */}
        <header className="border-b border-white/[0.06] px-4 py-2.5 flex items-center gap-3">
          <button onClick={() => navigate('/')}
            className="text-white/30 hover:text-white text-sm transition-colors shrink-0">
            ← ホーム
          </button>
          <div className="flex-1 bg-white/[0.06] rounded-full h-1 overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-violet-400 to-cyan-400 transition-all duration-500"
              style={{ width: `${fcPct}%` }} />
          </div>
          <span className="text-xs text-white/30 shrink-0 tabular-nums">{idx + 1} / {qs.length}</span>
          <button onClick={() => setFlashcard(false)}
            className="text-[11px] bg-white/[0.06] border border-white/10 text-white/40 px-3 py-1 rounded-lg hover:bg-white/10 hover:text-white/70 transition-all">
            📝 テスト
          </button>
        </header>

        <div className="flex-1 max-w-xl mx-auto w-full px-4 py-8 flex flex-col gap-5">
          {/* Flip card */}
          <div
            onClick={() => setFlipped(!flipped)}
            className={`flex-1 min-h-52 rounded-2xl p-6 cursor-pointer transition-all duration-200 select-none border
              ${flipped
                ? 'bg-emerald-500/[0.06] border-emerald-500/25'
                : 'bg-white/[0.03] border-white/[0.07] hover:border-white/[0.14] hover:bg-white/[0.05]'}`}>
            <div className="flex items-center justify-between mb-4">
              <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${typeInfo.color}`}>
                {typeInfo.label}
              </span>
              <span className="text-[11px] text-white/25">{flipped ? '答え' : 'タップで答えを表示'}</span>
            </div>
            {flipped ? (
              <div className="flex flex-col items-center justify-center py-6 gap-3">
                <p className="text-2xl font-bold text-emerald-300 text-center">{renderMath(correctAns)}</p>
                {q.hint_ja && <p className="text-sm text-white/40 text-center">{q.hint_ja}</p>}
                {q.explanation && (
                  <p className="text-xs text-white/30 mt-2 leading-relaxed text-center max-w-sm">{q.explanation}</p>
                )}
              </div>
            ) : (
              <div className="pt-2">{renderQuestion(q.question, isCode)}</div>
            )}
          </div>

          {/* Navigation */}
          <div className="flex gap-3">
            <button onClick={() => { setIdx(i => Math.max(0, i - 1)); setFlipped(false) }}
              disabled={idx === 0}
              className="flex-1 py-3 rounded-xl bg-white/[0.04] border border-white/[0.07] text-sm font-semibold disabled:opacity-20 hover:bg-white/[0.08] transition-colors text-white/60">
              ← 前へ
            </button>
            {idx + 1 < qs.length ? (
              <button onClick={() => { setIdx(i => i + 1); setFlipped(false) }}
                className="flex-[2] py-3 rounded-xl bg-violet-500/20 border border-violet-500/30 text-violet-300 text-sm font-bold hover:bg-violet-500/30 transition-colors">
                次へ →
              </button>
            ) : (
              <button onClick={() => { setFlashcard(false); setIdx(0) }}
                className="flex-[2] py-3 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-sm font-bold hover:bg-emerald-500/30 transition-colors">
                テストに挑戦 🎯
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Quiz mode ─────────────────────────────────────────────────────────────
  const progressPct = (idx / qs.length) * 100
  return (
    <div className="min-h-screen bg-[#08090f] text-white flex flex-col">

      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#08090f]/95 backdrop-blur border-b border-white/[0.06]">
        <div className="px-4 py-2.5 flex items-center gap-2">
          <button onClick={() => navigate('/')}
            className="text-white/30 hover:text-white transition-colors text-sm shrink-0">
            ←
          </button>

          <div className="flex-1 bg-white/[0.06] rounded-full h-1.5 overflow-hidden mx-1">
            <div className="h-1.5 bg-gradient-to-r from-violet-400 to-cyan-400 transition-all duration-500"
              style={{ width: `${progressPct}%` }} />
          </div>

          <span className="text-xs text-white/30 shrink-0 tabular-nums font-mono">
            {idx + 1}<span className="text-white/15">/{qs.length}</span>
          </span>

          <div className="flex items-center gap-1 ml-1">
            <button onClick={toggleShuffle} title="シャッフル"
              className={`text-sm px-2 py-1 rounded-lg transition-all
                ${shuffleOn ? 'bg-yellow-500/15 border border-yellow-500/25 text-yellow-300' : 'text-white/20 hover:text-white/50'}`}>
              🔀
            </button>
            <button onClick={() => { setTimerOn(v => !v); setTimeLeft(TIMER_SECS) }} title="タイマー"
              className={`text-sm px-2 py-1 rounded-lg transition-all
                ${timerOn ? 'bg-red-500/15 border border-red-500/25 text-red-300' : 'text-white/20 hover:text-white/50'}`}>
              ⏱
            </button>
            <button onClick={() => setFlashcard(true)} title="フラッシュカード"
              className="text-sm px-2 py-1 rounded-lg text-white/20 hover:text-violet-300 hover:bg-violet-500/10 transition-all">
              🃏
            </button>
            {youtubeId && (
              <button onClick={() => setShowVideo(v => !v)} title="YouTube"
                className={`text-sm px-2 py-1 rounded-lg transition-all
                  ${showVideo ? 'bg-red-500/15 border border-red-500/25 text-red-300' : 'text-white/20 hover:text-red-300'}`}>
                ▶
              </button>
            )}
            {isListening && (
              <span className="text-[11px] bg-violet-500/15 border border-violet-500/25 text-violet-300 px-2 py-0.5 rounded-full">
                🎧
              </span>
            )}
            {data.pool_generating && (
              <span className="text-[10px] bg-cyan-500/10 border border-cyan-500/25 text-cyan-400/80 px-2 py-0.5 rounded-full animate-pulse">
                ⚙️ 生成中
              </span>
            )}
          </div>
        </div>

        {/* Timer bar */}
        {timerOn && !already && (
          <div className="h-0.5 bg-white/[0.04] overflow-hidden">
            <div
              className={`h-0.5 transition-all duration-1000
                ${timeLeft > 20 ? 'bg-emerald-400' : timeLeft > 10 ? 'bg-yellow-400' : 'bg-red-400'}`}
              style={{ width: `${timerPct}%` }}
            />
          </div>
        )}
      </header>

      <div className="flex-1 max-w-xl mx-auto w-full px-4 py-5 space-y-4">

        {/* YouTube embed */}
        {showVideo && youtubeId && (
          <div className="rounded-2xl overflow-hidden border border-white/[0.07] bg-black" style={{ aspectRatio: '16/9' }}>
            <iframe
              src={`https://www.youtube.com/embed/${youtubeId}?rel=0`}
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen title="YouTube"
            />
          </div>
        )}

        {/* Timer badge */}
        {timerOn && !already && (
          <div className="flex justify-end">
            <span className={`text-xs font-mono font-bold px-3 py-1 rounded-full border tabular-nums
              ${timeLeft > 20 ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
              : timeLeft > 10 ? 'bg-yellow-500/10 border-yellow-500/25 text-yellow-300'
              : 'bg-red-500/10 border-red-500/25 text-red-300 animate-pulse'}`}>
              ⏱ {timeLeft}s
            </span>
          </div>
        )}

        {/* Type badge + hint */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${typeInfo.color}`}>
            {typeInfo.label}
          </span>
          {q.hint_ja && (
            <span className="text-xs text-white/35 truncate">💡 {q.hint_ja}</span>
          )}
        </div>

        {/* Question card */}
        <div className="bg-white/[0.03] border border-white/[0.07] rounded-2xl p-5">
          {furigana && !isCode
            ? <FuriganaText text={q.question} enabled={furigana} className="text-lg font-medium leading-relaxed block mb-4" />
            : renderQuestion(q.question, isCode)
          }
          {isCalc && (
            <p className="text-xs text-orange-300/50 mt-1">🧮 計算して答えを入力してください</p>
          )}
          {!isCode && !isCalc && (
            <div className="flex gap-2 mt-1 flex-wrap">
              <button onClick={() => playTTS(q.question, ttsLang, false)}
                className="flex items-center gap-1 text-xs text-white/30 hover:text-violet-400 transition-colors bg-white/[0.04] hover:bg-white/[0.08] px-3 py-1.5 rounded-lg">
                🔊 通常
              </button>
              <button onClick={() => playTTS(q.question, ttsLang, true)}
                className="flex items-center gap-1 text-xs text-white/30 hover:text-violet-400 transition-colors bg-white/[0.04] hover:bg-white/[0.08] px-3 py-1.5 rounded-lg">
                🐢 ゆっくり
              </button>
              {q.id && (
                <button onClick={openEdit}
                  className="flex items-center gap-1 text-xs text-white/20 hover:text-amber-400 transition-colors bg-white/[0.04] hover:bg-white/[0.08] px-3 py-1.5 rounded-lg ml-auto">
                  ✏️ 編集
                </button>
              )}
            </div>
          )}
        </div>

        {/* MC options */}
        {!isFree && q.options && (
          <div className="space-y-2">
            {q.options.map((opt, i) => {
              let cls = ''
              if (!already) {
                cls = 'bg-white/[0.03] border-white/[0.08] text-white/75 hover:bg-white/[0.07] hover:border-violet-400/40 hover:text-white cursor-pointer'
              } else if (i === q.answer) {
                cls = 'bg-emerald-500/[0.12] border-emerald-500/40 text-emerald-300'
              } else if (i === answers[idx]) {
                cls = 'bg-red-500/[0.12] border-red-500/40 text-red-300'
              } else {
                cls = 'bg-transparent border-white/[0.04] text-white/20'
              }
              return (
                <button key={i} disabled={already}
                  onClick={() => { submitMC(i); if (i === q.answer) playTTS(opt, answerLang) }}
                  className={`w-full text-left px-4 py-3.5 rounded-xl border text-sm font-medium transition-all ${cls}`}>
                  <span className="text-white/30 mr-2 font-mono text-xs">
                    {String.fromCharCode(65 + i)})
                  </span>
                  {isCode ? opt : <>{renderMath(opt)}</>}
                </button>
              )
            })}
          </div>
        )}

        {/* Free / calculation input */}
        {isFree && !already && (
          <div className="space-y-3">
            {isCalc ? (
              <input
                value={freeText}
                onChange={e => setFreeText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && freeText.trim() && submitFree(freeText.trim())}
                placeholder="答えを入力（例: 42 / x=5）"
                className="w-full bg-white/[0.05] border border-orange-500/25 rounded-xl px-4 py-3.5 text-lg font-mono placeholder-white/20 focus:outline-none focus:border-orange-400 transition-colors"
                autoFocus
              />
            ) : (
              <textarea ref={inputRef} value={freeText} onChange={e => setFreeText(e.target.value)}
                placeholder="ここに回答を入力..."
                rows={3}
                className="w-full bg-white/[0.05] border border-white/[0.08] rounded-xl px-4 py-3 text-sm placeholder-white/20 focus:outline-none focus:border-violet-400 resize-none transition-colors" />
            )}
            <div className="flex gap-2">
              <button onClick={() => submitFree('')}
                className="flex-1 py-3 rounded-xl bg-white/[0.04] border border-white/[0.07] text-sm font-semibold hover:bg-white/[0.08] transition-colors text-white/40">
                スキップ
              </button>
              <button onClick={() => submitFree(freeText.trim())} disabled={!freeText.trim()}
                className={`flex-[2] py-3 rounded-xl text-sm font-bold disabled:opacity-30 transition-all border
                  ${isCalc
                    ? 'bg-orange-500/20 border-orange-500/30 text-orange-300 hover:bg-orange-500/30'
                    : 'bg-violet-500/20 border-violet-500/30 text-violet-300 hover:bg-violet-500/30'}`}>
                回答する
              </button>
            </div>
          </div>
        )}

        {/* Post-answer feedback */}
        {already && (
          <div className="space-y-3">

            {/* MC result */}
            {!isFree && (
              answers[idx] === q.answer
                ? <div className="bg-emerald-500/[0.08] border border-emerald-500/25 rounded-xl px-4 py-3 flex items-center gap-2">
                    <span className="text-emerald-400 font-bold text-sm">正解</span>
                    <button onClick={() => playTTS(q.options![q.answer as number], answerLang)}
                      className="ml-auto text-xs text-white/25 hover:text-white/60 transition-colors">🔊</button>
                  </div>
                : <div className="bg-red-500/[0.08] border border-red-500/25 rounded-xl px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-red-400 font-bold text-sm">
                        {answers[idx] === -1 ? '時間切れ' : '不正解'}
                      </span>
                      <button onClick={() => playTTS(q.options![q.answer as number], answerLang)}
                        className="ml-auto text-xs text-white/25 hover:text-white/60 transition-colors">🔊</button>
                    </div>
                    <p className="text-xs text-white/40">正解:
                      <span className="text-emerald-300 font-semibold ml-1">{q.options![q.answer as number]}</span>
                    </p>
                  </div>
            )}

            {/* Calculation result */}
            {isFree && isCalc && (() => {
              const got = normalizeCalc(String(answers[idx] ?? ''))
              const expected = normalizeCalc(String(q.answer))
              const correct = !!got && got === expected
              return (
                <div className={`rounded-xl px-4 py-3 border ${correct ? 'bg-emerald-500/[0.08] border-emerald-500/25' : 'bg-red-500/[0.08] border-red-500/25'}`}>
                  {correct
                    ? <p className="text-emerald-300 font-bold text-sm">正解 — <span className="font-mono">{String(q.answer)}</span></p>
                    : <>
                        <p className="text-red-400 text-sm font-semibold">不正解</p>
                        <p className="text-xs text-white/40 mt-1">
                          あなたの回答: <span className="font-mono">{String(answers[idx] || 'スキップ')}</span>
                        </p>
                        <p className="text-xs mt-0.5">
                          正解: <span className="font-mono text-emerald-300 font-semibold">{String(q.answer)}</span>
                        </p>
                      </>}
                </div>
              )
            })()}

            {/* Open text result */}
            {isFree && !isCalc && (
              <div className="bg-violet-500/[0.07] border border-violet-500/20 rounded-xl px-4 py-3">
                <p className="text-[11px] text-white/30 mb-1">
                  あなたの回答: {answers[idx] as string || 'スキップ'}
                </p>
                <p className="text-sm">
                  <span className="text-white/40 text-xs">模範解答: </span>
                  <span className="font-semibold text-violet-200">{String(q.answer)}</span>
                </p>
                <button onClick={() => playTTS(String(q.answer), answerLang)}
                  className="mt-2 text-xs text-white/25 hover:text-violet-400 transition-colors">
                  🔊 発音を聞く
                </button>
              </div>
            )}

            {/* Explanation */}
            {q.explanation && (
              <details className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3">
                <summary className="text-xs text-white/30 cursor-pointer hover:text-white/60 transition-colors select-none">
                  📖 解説
                </summary>
                <p className="mt-2.5 text-sm text-white/60 leading-relaxed">{q.explanation}</p>
              </details>
            )}

            <button onClick={next}
              className="w-full py-4 bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/30 rounded-xl text-sm font-bold text-violet-300 transition-all">
              {idx + 1 < qs.length ? '次の問題 →' : '結果を見る 🏆'}
            </button>
          </div>
        )}
      </div>

      {/* ── Edit modal ────────────────────────────────────────────────────── */}
      {editOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-[#12131f] border border-white/[0.1] rounded-2xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-white/70">問題を編集</p>
              <button onClick={() => setEditOpen(false)} className="text-white/30 hover:text-white/70 text-lg leading-none">✕</button>
            </div>

            <div>
              <p className="text-[10px] text-white/30 mb-1">問題文</p>
              <textarea value={editQuestion_} onChange={e => setEditQuestion_(e.target.value)} rows={3}
                className="w-full bg-white/[0.05] border border-white/[0.1] rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-amber-400/60 resize-none" />
            </div>

            {editOptions.length > 0 && (
              <div>
                <p className="text-[10px] text-white/30 mb-1">選択肢</p>
                {editOptions.map((opt, i) => (
                  <div key={i} className="flex gap-2 mb-1.5">
                    <button
                      onClick={() => setEditAnswer(i)}
                      className={`text-xs px-2 py-2 rounded-lg border shrink-0 font-mono transition-all ${editAnswer === i ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300' : 'bg-white/[0.04] border-white/[0.08] text-white/30 hover:border-white/20'}`}>
                      {String.fromCharCode(65 + i)}
                    </button>
                    <input value={opt} onChange={e => setEditOptions(prev => prev.map((o, j) => j === i ? e.target.value : o))}
                      className="flex-1 bg-white/[0.05] border border-white/[0.1] rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-amber-400/60" />
                  </div>
                ))}
                <p className="text-[10px] text-white/25 mt-1">正解の選択肢ボタンを押して緑にしてください</p>
              </div>
            )}

            <div>
              <p className="text-[10px] text-white/30 mb-1">解説（任意）</p>
              <textarea value={editExplain} onChange={e => setEditExplain(e.target.value)} rows={2}
                className="w-full bg-white/[0.05] border border-white/[0.1] rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-amber-400/60 resize-none" />
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={() => setEditOpen(false)}
                className="flex-1 py-3 rounded-xl bg-white/[0.04] border border-white/[0.07] text-sm font-semibold text-white/40 hover:bg-white/[0.08] transition-colors">
                キャンセル
              </button>
              <button onClick={saveEdit} disabled={editSaving || !editQuestion_.trim()}
                className="flex-[2] py-3 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-300 text-sm font-bold hover:bg-amber-500/30 disabled:opacity-30 transition-colors">
                {editSaving ? '保存中...' : '保存する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
