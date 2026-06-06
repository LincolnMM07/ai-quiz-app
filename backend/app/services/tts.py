"""
Text-to-speech service — Edge TTS (Microsoft Neural voices).
Returns raw MP3 bytes; the router serves them as audio/mpeg.
Supports English, Japanese, Spanish, French, Korean, Chinese, Portuguese.
"""
import io
import logging
import re

import edge_tts

logger = logging.getLogger(__name__)

VOICES = {
    # English
    "en-US-female": "en-US-JennyNeural",
    "en-US-male":   "en-US-GuyNeural",
    "en-GB-female": "en-GB-SoniaNeural",
    "en-GB-male":   "en-GB-RyanNeural",
    # Japanese
    "ja-female":    "ja-JP-NanamiNeural",
    "ja-male":      "ja-JP-KeitaNeural",
    # Spanish
    "es-female":    "es-ES-ElviraNeural",
    "es-male":      "es-ES-AlvaroNeural",
    # French
    "fr-female":    "fr-FR-DeniseNeural",
    "fr-male":      "fr-FR-HenriNeural",
    # Korean
    "ko-female":    "ko-KR-SunHiNeural",
    "ko-male":      "ko-KR-InJoonNeural",
    # Chinese (Mandarin)
    "zh-female":    "zh-CN-XiaoxiaoNeural",
    "zh-male":      "zh-CN-YunxiNeural",
    # Portuguese (Brazilian)
    "pt-female":    "pt-BR-FranciscaNeural",
    "pt-male":      "pt-BR-AntonioNeural",
    # German
    "de-female":    "de-DE-KatjaNeural",
    "de-male":      "de-DE-ConradNeural",
}

DEFAULT_VOICE = VOICES["en-US-female"]

# Simple in-process audio cache keyed on (text, voice, rate, pitch)
_cache: dict[tuple, bytes] = {}


def _clean_for_lang(text: str, lang: str) -> str:
    """Remove text artifacts that shouldn't be spoken, based on target language."""
    # Always remove option prefixes like "A) " or "B) "
    text = re.sub(r'^[A-D]\)\s*', '', text.strip())
    # Remove markdown-style code fences
    text = re.sub(r'```[\s\S]*?```', '', text).strip()
    # Remove KaTeX dollar signs (plain math expression left)
    text = re.sub(r'\$\$?([^$]+)\$\$?', r'\1', text)

    if lang == "en":
        # For English TTS: strip CJK / Japanese / Korean characters and hints
        text = re.sub(r'（[^）]*）', '', text)
        text = re.sub(r'[　-鿿豈-﫿＀-￯]', '', text)
        text = re.sub(r'[가-힣]', '', text)  # Korean
        text = text.strip()
        # Only speak if there is meaningful ASCII content
        if not text or not re.search(r'[a-zA-Z0-9]', text):
            return ''
    elif lang == "ja":
        # Remove English-only parenthetical hints
        text = re.sub(r'\([^)]*[a-zA-Z]{3,}[^)]*\)', '', text)
        text = text.strip()
        # Skip TTS for isolated kanji strings (no hiragana/katakana context).
        # Without sentence context, Edge TTS may pick on-yomi (e.g. "うん" for 雲)
        # rather than the correct kun-yomi ("くも"). Kanji quiz answers are meant
        # to be read visually, so silence is better than a wrong pronunciation.
        if text and re.match(r'^[一-鿿々〆〇ー・]+$', text):
            return ''
    elif lang == "zh":
        # For Chinese TTS: remove pinyin in parentheses
        text = re.sub(r'\([a-záéíóú\s]+\)', '', text, flags=re.IGNORECASE)
    elif lang in ("pt", "es", "fr", "de", "it"):
        # Romance/Germanic: strip CJK characters that don't belong
        text = re.sub(r'[　-鿿豈-﫿＀-￯]', '', text)
        text = re.sub(r'[가-힣]', '', text)  # Korean
        text = text.strip()
        # Require at least some alphabetic content
        if not text or not re.search(r'[a-zA-ZÀ-ÿ]', text):
            return ''
    elif lang == "ko":
        # Korean TTS: strip CJK/Latin noise
        text = re.sub(r'[一-鿿぀-ヿ]', '', text)

    return text.strip()


async def synthesize(
    text: str,
    voice: str = DEFAULT_VOICE,
    slow: bool = False,
    lang: str = "en",
) -> bytes:
    """
    Async TTS synthesis. Must be awaited from an async context.
    Returns MP3 bytes, or b"" on failure.
    """
    clean_text = _clean_for_lang(text, lang)
    if not clean_text:
        return b""

    rate  = "-30%" if slow else "+0%"
    pitch = "-5Hz" if slow else "+0Hz"

    cache_key = (clean_text, voice, rate, pitch)
    if cache_key in _cache:
        return _cache[cache_key]

    try:
        buf = io.BytesIO()
        communicate = edge_tts.Communicate(clean_text, voice, rate=rate, pitch=pitch)
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        audio_bytes = buf.getvalue()
        _cache[cache_key] = audio_bytes
        return audio_bytes
    except Exception as e:
        logger.error("TTS synthesis failed: %s", e)
        return b""
