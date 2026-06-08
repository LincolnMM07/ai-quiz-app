import { useState, useEffect } from 'react'

interface Props {
  text: string
  enabled: boolean
  className?: string
}

interface Token {
  surface: string
  reading?: string
}

// Lazy-load kuroshiro only when furigana is enabled
let kuroshiroInstance: any = null
let kuroshiroReady = false
let kuroshiroLoading = false
const readyCallbacks: (() => void)[] = []

async function getKuroshiro() {
  if (kuroshiroReady) return kuroshiroInstance
  if (kuroshiroLoading) {
    return new Promise<any>(resolve => readyCallbacks.push(() => resolve(kuroshiroInstance)))
  }
  kuroshiroLoading = true
  try {
    const [Kuroshiro, KuromojiAnalyzer] = await Promise.all([
      import('kuroshiro').then(m => m.default),
      import('kuroshiro-analyzer-kuromoji').then(m => m.default),
    ])
    kuroshiroInstance = new Kuroshiro()
    await kuroshiroInstance.init(new KuromojiAnalyzer())
    kuroshiroReady = true
    readyCallbacks.forEach(cb => cb())
  } catch (e) {
    console.warn('Kuroshiro init failed:', e)
  }
  return kuroshiroInstance
}

function hasKanji(text: string): boolean {
  return /[一-鿿々]/.test(text)
}

export default function FuriganaText({ text, enabled, className }: Props) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !hasKanji(text)) {
      setHtml(null)
      return
    }
    let cancelled = false
    getKuroshiro().then(async k => {
      if (!k || cancelled) return
      try {
        const result = await k.convert(text, { mode: 'furigana', to: 'hiragana' })
        if (!cancelled) setHtml(result)
      } catch {
        if (!cancelled) setHtml(null)
      }
    })
    return () => { cancelled = true }
  }, [text, enabled])

  if (!enabled || !html) {
    return <span className={className}>{text}</span>
  }

  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
      style={{ rubyPosition: 'over' } as React.CSSProperties}
    />
  )
}
