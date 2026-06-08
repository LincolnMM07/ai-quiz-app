"""
Text-to-speech service — Edge TTS (Microsoft Neural voices).
Returns raw MP3 bytes. Supports mixed-language text by detecting language
segments and synthesizing each with the appropriate voice.
"""
import io
import logging
import re

import edge_tts

logger = logging.getLogger(__name__)

VOICES = {
    "en-US-female": "en-US-JennyNeural",
    "en-US-male":   "en-US-GuyNeural",
    "en-GB-female": "en-GB-SoniaNeural",
    "en-GB-male":   "en-GB-RyanNeural",
    "ja-female":    "ja-JP-NanamiNeural",
    "ja-male":      "ja-JP-KeitaNeural",
    "es-female":    "es-ES-ElviraNeural",
    "es-male":      "es-ES-AlvaroNeural",
    "fr-female":    "fr-FR-DeniseNeural",
    "fr-male":      "fr-FR-HenriNeural",
    "ko-female":    "ko-KR-SunHiNeural",
    "ko-male":      "ko-KR-InJoonNeural",
    "zh-female":    "zh-CN-XiaoxiaoNeural",
    "zh-male":      "zh-CN-YunxiNeural",
    "pt-female":    "pt-BR-FranciscaNeural",
    "pt-male":      "pt-BR-AntonioNeural",
    "de-female":    "de-DE-KatjaNeural",
    "de-male":      "de-DE-ConradNeural",
}

DEFAULT_VOICE = VOICES["en-US-female"]

_LANG_TO_VOICE = {
    "ja": "ja-female",
    "en": "en-US-female",
    "es": "es-female",
    "fr": "fr-female",
    "ko": "ko-female",
    "zh": "zh-female",
    "pt": "pt-female",
    "de": "de-female",
}

_cache: dict[tuple, bytes] = {}

# Japanese character ranges
_JP_RE = re.compile(r'[　-鿿豈-﫿゠-ヿ぀-ゟ一-鿿]+')

def _split_mixed_segments(text: str, primary_lang: str) -> list[tuple[str, str]]:
    """
    Split text into (segment, lang) pairs for mixed-language synthesis.
    Only splits when primary_lang is 'en' and Japanese text is present,
    or primary_lang is 'ja' and significant English is present.
    """
    has_japanese = bool(_JP_RE.search(text))
    has_english  = bool(re.search(r'[a-zA-Z]{2,}', text))

    # Only split if truly mixed
    if not (has_japanese and has_english):
        return [(text, primary_lang)]

    segments: list[tuple[str, str]] = []
    pos = 0

    # Tokenize by Japanese spans
    for m in _JP_RE.finditer(text):
        before = text[pos:m.start()]
        if before.strip():
            segments.append((before, primary_lang if primary_lang != 'ja' else 'en'))
        jp_text = m.group()
        segments.append((jp_text, 'ja'))
        pos = m.end()

    tail = text[pos:]
    if tail.strip():
        segments.append((tail, primary_lang if primary_lang != 'ja' else 'en'))

    return segments if segments else [(text, primary_lang)]


def _clean_for_lang(text: str, lang: str) -> str:
    text = re.sub(r'^[A-D]\)\s*', '', text.strip())
    text = re.sub(r'```[\s\S]*?```', '', text).strip()
    text = re.sub(r'\$\$?([^$]+)\$\$?', r'\1', text)

    if lang == "en":
        text = re.sub(r'（[^）]*）', '', text)
        text = text.strip()
        if not text or not re.search(r'[a-zA-Z0-9]', text):
            return ''
    elif lang == "ja":
        text = re.sub(r'\([^)]*[a-zA-Z]{3,}[^)]*\)', '', text)
        text = text.strip()
        if text and re.match(r'^[一-鿿々〆〇ー・]+$', text):
            return ''
    elif lang == "zh":
        text = re.sub(r'\([a-záéíóú\s]+\)', '', text, flags=re.IGNORECASE)
    elif lang in ("pt", "es", "fr", "de", "it"):
        text = re.sub(r'[가-힣]', '', text)
        text = text.strip()
        if not text or not re.search(r'[a-zA-ZÀ-ÿ]', text):
            return ''
    elif lang == "ko":
        text = re.sub(r'[一-鿿぀-ヿ]', '', text)

    return text.strip()


async def _synthesize_single(text: str, voice: str, rate: str, pitch: str) -> bytes:
    cache_key = (text, voice, rate, pitch)
    if cache_key in _cache:
        return _cache[cache_key]
    try:
        buf = io.BytesIO()
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        audio_bytes = buf.getvalue()
        _cache[cache_key] = audio_bytes
        return audio_bytes
    except Exception as e:
        logger.error("TTS synthesis failed: %s", e)
        return b""


async def synthesize(
    text: str,
    voice: str = DEFAULT_VOICE,
    slow: bool = False,
    lang: str = "en",
) -> bytes:
    """
    Async TTS synthesis. Handles mixed-language text by splitting into
    language segments and synthesizing each with the appropriate voice.
    Returns MP3 bytes, or b"" on failure.
    """
    rate  = "-30%" if slow else "+0%"
    pitch = "-5Hz" if slow else "+0Hz"

    segments = _split_mixed_segments(text, lang)

    if len(segments) == 1:
        # Single language — original path
        clean_text = _clean_for_lang(text, lang)
        if not clean_text:
            return b""
        return await _synthesize_single(clean_text, voice, rate, pitch)

    # Mixed language — synthesize each segment separately and concatenate
    parts: list[bytes] = []
    for seg_text, seg_lang in segments:
        clean = _clean_for_lang(seg_text, seg_lang)
        if not clean:
            continue
        seg_voice_key = _LANG_TO_VOICE.get(seg_lang, "en-US-female")
        seg_voice = VOICES.get(seg_voice_key, DEFAULT_VOICE)
        audio = await _synthesize_single(clean, seg_voice, rate, pitch)
        if audio:
            parts.append(audio)

    return b"".join(parts)
