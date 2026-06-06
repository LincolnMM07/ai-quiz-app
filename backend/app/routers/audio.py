from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel

from app.services.tts import synthesize, VOICES

router = APIRouter()


class TTSRequest(BaseModel):
    text: str
    voice: str = "en-US-female"
    slow: bool = False
    lang: str = "en"


@router.post("/synthesize")
async def synthesize_speech(req: TTSRequest):
    """
    Generate speech and return MP3 audio bytes.
    Supports English (US/GB) and Japanese voices.
    """
    voice_id = VOICES.get(req.voice, VOICES["en-US-female"])
    # await the async synthesize function — no asyncio.run() needed
    audio = await synthesize(req.text, voice=voice_id, slow=req.slow, lang=req.lang)

    if not audio:
        return Response(status_code=204)  # No Content

    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/voices")
async def list_voices():
    """Return available TTS voice options."""
    return {
        "voices": [
            {"id": k, "label": k.replace("-", " ").title()}
            for k in VOICES.keys()
        ]
    }
